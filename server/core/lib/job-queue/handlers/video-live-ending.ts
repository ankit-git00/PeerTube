import { ffprobePromise, getAudioStream, getVideoStreamDimensionsInfo, getVideoStreamFPS } from '@peertube/peertube-ffmpeg'
import { ThumbnailType, VideoFileStream, VideoLiveEndingPayload, VideoState } from '@peertube/peertube-models'
import { peertubeTruncate } from '@server/helpers/core-utils.js'
import { CONSTRAINTS_FIELDS } from '@server/initializers/constants.js'
import { getLocalVideoActivityPubUrl } from '@server/lib/activitypub/url.js'
import { federateVideoIfNeeded } from '@server/lib/activitypub/videos/index.js'
import { cleanupAndDestroyPermanentLive, cleanupTMPLiveFiles, cleanupUnsavedNormalLive } from '@server/lib/live/index.js'
import {
  generateHLSMasterPlaylistFilename,
  generateHlsSha256SegmentsFilename,
  getHLSDirectory,
  getLiveReplayBaseDirectory
} from '@server/lib/paths.js'
import { generateLocalVideoMiniature, regenerateMiniaturesIfNeeded, updateLocalVideoMiniatureFromExisting } from '@server/lib/thumbnail.js'
import { generateHlsPlaylistResolutionFromTS } from '@server/lib/transcoding/hls-transcoding.js'
import { createTranscriptionTaskIfNeeded } from '@server/lib/video-captions.js'
import { buildStoryboardJobIfNeeded } from '@server/lib/video-jobs.js'
import { VideoPathManager } from '@server/lib/video-path-manager.js'
import { isVideoInPublicDirectory } from '@server/lib/video-privacy.js'
import { moveToNextState } from '@server/lib/video-state.js'
import { setVideoTags } from '@server/lib/video.js'
import { VideoBlacklistModel } from '@server/models/video/video-blacklist.js'
import { VideoFileModel } from '@server/models/video/video-file.js'
import { VideoLiveReplaySettingModel } from '@server/models/video/video-live-replay-setting.js'
import { VideoLiveSessionModel } from '@server/models/video/video-live-session.js'
import { VideoLiveModel } from '@server/models/video/video-live.js'
import { VideoStreamingPlaylistModel } from '@server/models/video/video-streaming-playlist.js'
import { VideoModel } from '@server/models/video/video.js'
import {
  MThumbnail,
  MVideo,
  MVideoLive,
  MVideoLiveSession,
  MVideoTag,
  MVideoThumbnail,
  MVideoWithAllFiles,
  MVideoWithFileThumbnail
} from '@server/types/models/index.js'
import { Job } from 'bullmq'
import { pathExists, remove } from 'fs-extra/esm'
import { readdir } from 'fs/promises'
import { isAbsolute, join } from 'path'
import { logger, loggerTagsFactory } from '../../../helpers/logger.js'
import { JobQueue } from '../job-queue.js'

const lTags = loggerTagsFactory('live', 'job')

export async function processVideoLiveEnding (job: Job) {
  const payload = job.data as VideoLiveEndingPayload

  logger.info('Processing video live ending for %s.', payload.videoId, { payload, ...lTags() })

  function logError () {
    logger.warn('Video live %d does not exist anymore. Cannot process live ending.', payload.videoId, lTags())
  }

  const video = await VideoModel.load(payload.videoId)
  const live = await VideoLiveModel.loadByVideoId(payload.videoId)
  const liveSession = await VideoLiveSessionModel.load(payload.liveSessionId)

  if (!video || !live || !liveSession) {
    logError()
    return
  }

  const permanentLive = live.permanentLive

  liveSession.endingProcessed = true
  await liveSession.save()

  if (liveSession.saveReplay !== true) {
    return cleanupLiveAndFederate({ permanentLive, video, streamingPlaylistId: payload.streamingPlaylistId })
  }

  let replayDirectory = payload.replayDirectory

  // Introduced in PeerTube 7.2, allow to use the appropriate base directory even if the live privacy changed
  if (!isAbsolute(replayDirectory)) {
    replayDirectory = join(getLiveReplayBaseDirectory(video), replayDirectory)
  }

  const inputFileMutexReleaser = await VideoPathManager.Instance.lockFiles(video.uuid)

  try {
    await video.reload()

    if (await hasReplayFiles(replayDirectory) !== true) {
      logger.info(`No replay files found for live ${video.uuid}, skipping video replay creation.`, { ...lTags(video.uuid) })

      await cleanupLiveAndFederate({ permanentLive, video, streamingPlaylistId: payload.streamingPlaylistId })
    } else if (permanentLive) {
      await saveReplayToExternalVideo({
        liveVideo: video,
        liveSession,
        publishedAt: payload.publishedAt,
        replayDirectory
      })

      await cleanupLiveAndFederate({ permanentLive, video, streamingPlaylistId: payload.streamingPlaylistId })
    } else {
      await replaceLiveByReplay({
        video,
        liveSession,
        live,
        permanentLive,
        replayDirectory
      })
    }
  } finally {
    inputFileMutexReleaser()
  }
}

// ---------------------------------------------------------------------------
// Private
// ---------------------------------------------------------------------------

async function saveReplayToExternalVideo (options: {
  liveVideo: MVideoThumbnail
  liveSession: MVideoLiveSession
  publishedAt: string
  replayDirectory: string
}) {
  const { liveSession, publishedAt, replayDirectory } = options

  const liveVideo = await VideoModel.loadFull(options.liveVideo.id)
  const replaySettings = await VideoLiveReplaySettingModel.load(liveSession.replaySettingId)

  const videoNameSuffix = ` - ${new Date(publishedAt).toLocaleString()}`
  const truncatedVideoName = peertubeTruncate(liveVideo.name, {
    length: CONSTRAINTS_FIELDS.VIDEOS.NAME.max - videoNameSuffix.length
  })

  const replayVideo = new VideoModel({
    name: truncatedVideoName + videoNameSuffix,
    isLive: false,
    state: VideoState.TO_TRANSCODE,
    duration: 0,

    remote: liveVideo.remote,
    category: liveVideo.category,
    licence: liveVideo.licence,
    language: liveVideo.language,
    commentsPolicy: liveVideo.commentsPolicy,
    downloadEnabled: liveVideo.downloadEnabled,
    waitTranscoding: true,
    nsfw: liveVideo.nsfw,
    description: liveVideo.description,
    aspectRatio: liveVideo.aspectRatio,
    support: liveVideo.support,
    privacy: replaySettings.privacy,
    channelId: liveVideo.channelId
  }) as MVideoWithAllFiles & MVideoTag

  replayVideo.Thumbnails = []
  replayVideo.VideoFiles = []
  replayVideo.VideoStreamingPlaylists = []

  replayVideo.url = getLocalVideoActivityPubUrl(replayVideo)

  await replayVideo.save()

  await setVideoTags({ video: replayVideo, tags: liveVideo.Tags.map(t => t.name) })

  liveSession.replayVideoId = replayVideo.id
  await liveSession.save()

  // If live is blacklisted, also blacklist the replay
  const blacklist = await VideoBlacklistModel.loadByVideoId(liveVideo.id)
  if (blacklist) {
    await VideoBlacklistModel.create({
      videoId: replayVideo.id,
      unfederated: blacklist.unfederated,
      reason: blacklist.reason,
      type: blacklist.type
    })
  }

  await assignReplayFilesToVideo({ video: replayVideo, replayDirectory })

  logger.info(`Removing replay directory ${replayDirectory}`, lTags(liveVideo.uuid))
  await remove(replayDirectory)

  try {
    await copyOrRegenerateThumbnails({ liveVideo, replayVideo })
  } catch (err) {
    logger.error(
      `Cannot copy/regenerate thumbnails of ended live ${liveVideo.uuid} to external video ${replayVideo.uuid}`,
      lTags(liveVideo.uuid, replayVideo.uuid)
    )
  }

  await createStoryboardJob(replayVideo)
  await createTranscriptionTaskIfNeeded(replayVideo)

  await moveToNextState({ video: replayVideo, isNewVideo: true })
}

async function copyOrRegenerateThumbnails (options: {
  liveVideo: MVideoThumbnail
  replayVideo: MVideoWithFileThumbnail
}) {
  const { liveVideo, replayVideo } = options

  let thumbnails: MThumbnail[] = []
  const preview = liveVideo.getPreview()

  if (preview?.automaticallyGenerated === false) {
    thumbnails = await Promise.all(
      [ ThumbnailType.MINIATURE, ThumbnailType.PREVIEW ].map(type => {
        return updateLocalVideoMiniatureFromExisting({
          inputPath: preview.getPath(),
          video: replayVideo,
          type,
          automaticallyGenerated: false,
          keepOriginal: true
        })
      })
    )
  } else {
    thumbnails = await generateLocalVideoMiniature({
      video: replayVideo,
      videoFile: replayVideo.getMaxQualityFile(VideoFileStream.VIDEO) || replayVideo.getMaxQualityFile(VideoFileStream.AUDIO),
      types: [ ThumbnailType.MINIATURE, ThumbnailType.PREVIEW ],
      ffprobe: undefined
    })
  }

  for (const thumbnail of thumbnails) {
    await replayVideo.addAndSaveThumbnail(thumbnail)
  }
}

async function replaceLiveByReplay (options: {
  video: MVideo
  liveSession: MVideoLiveSession
  live: MVideoLive
  permanentLive: boolean
  replayDirectory: string
}) {
  const { video: liveVideo, liveSession, live, permanentLive, replayDirectory } = options

  const replaySettings = await VideoLiveReplaySettingModel.load(liveSession.replaySettingId)
  const videoWithFiles = await VideoModel.loadFull(liveVideo.id)
  const hlsPlaylist = videoWithFiles.getHLSPlaylist()
  const replayInAnotherDirectory = isVideoInPublicDirectory(liveVideo.privacy) !== isVideoInPublicDirectory(replaySettings.privacy)

  logger.info(`Replacing live ${liveVideo.uuid} by replay ${replayDirectory}.`, { replayInAnotherDirectory, ...lTags(liveVideo.uuid) })

  await cleanupTMPLiveFiles(videoWithFiles, hlsPlaylist)

  await live.destroy()

  videoWithFiles.isLive = false
  videoWithFiles.privacy = replaySettings.privacy
  videoWithFiles.waitTranscoding = true
  videoWithFiles.state = VideoState.TO_TRANSCODE

  await videoWithFiles.save()

  liveSession.replayVideoId = videoWithFiles.id
  await liveSession.save()

  await VideoFileModel.removeHLSFilesOfStreamingPlaylistId(hlsPlaylist.id)

  // Reset playlist
  hlsPlaylist.VideoFiles = []
  hlsPlaylist.playlistFilename = generateHLSMasterPlaylistFilename()
  hlsPlaylist.segmentsSha256Filename = generateHlsSha256SegmentsFilename()
  await hlsPlaylist.save()

  await assignReplayFilesToVideo({ video: videoWithFiles, replayDirectory })

  // Should not happen in this function, but we keep the code if in the future we can replace the permanent live by a replay
  if (permanentLive) { // Remove session replay
    await remove(replayDirectory)
  } else {
    // We won't stream again in this live, we can delete the base replay directory
    await remove(getLiveReplayBaseDirectory(liveVideo))

    // If the live was in another base directory, also delete it
    if (replayInAnotherDirectory) {
      await remove(getHLSDirectory(liveVideo))
    }
  }

  // Regenerate the thumbnail & preview?
  try {
    await regenerateMiniaturesIfNeeded(videoWithFiles, undefined)
  } catch (err) {
    logger.error(`Cannot regenerate thumbnails of ended live ${videoWithFiles.uuid}`, lTags(liveVideo.uuid))
  }

  // We consider this is a new video
  await moveToNextState({ video: videoWithFiles, isNewVideo: true })

  await createStoryboardJob(videoWithFiles)
  await createTranscriptionTaskIfNeeded(videoWithFiles)
}

async function assignReplayFilesToVideo (options: {
  video: MVideo
  replayDirectory: string
}) {
  const { video, replayDirectory } = options

  const concatenatedTsFiles = await readdir(replayDirectory)

  logger.info(`Assigning replays ${replayDirectory} to video ${video.uuid}.`, { concatenatedTsFiles, ...lTags(video.uuid) })

  for (const concatenatedTsFile of concatenatedTsFiles) {
    // Generating hls playlist can be long, reload the video in this case
    await video.reload()

    const concatenatedTsFilePath = join(replayDirectory, concatenatedTsFile)

    const probe = await ffprobePromise(concatenatedTsFilePath)
    const { audioStream } = await getAudioStream(concatenatedTsFilePath, probe)
    const { resolution } = await getVideoStreamDimensionsInfo(concatenatedTsFilePath, probe)
    const fps = await getVideoStreamFPS(concatenatedTsFilePath, probe)

    try {
      await generateHlsPlaylistResolutionFromTS({
        video,
        inputFileMutexReleaser: null, // Already locked in parent
        concatenatedTsFilePath,
        resolution,
        fps,
        isAAC: audioStream?.codec_name === 'aac'
      })
    } catch (err) {
      logger.error('Cannot generate HLS playlist resolution from TS files.', { err })
    }
  }

  return video
}

async function cleanupLiveAndFederate (options: {
  video: MVideo
  permanentLive: boolean
  streamingPlaylistId: number
}) {
  const { permanentLive, video, streamingPlaylistId } = options

  const streamingPlaylist = await VideoStreamingPlaylistModel.loadWithVideo(streamingPlaylistId)

  if (streamingPlaylist) {
    if (permanentLive) {
      await cleanupAndDestroyPermanentLive(video, streamingPlaylist)
    } else {
      await cleanupUnsavedNormalLive(video, streamingPlaylist)
    }
  }

  try {
    const fullVideo = await VideoModel.loadFull(video.id)
    return federateVideoIfNeeded(fullVideo, false, undefined)
  } catch (err) {
    logger.warn('Cannot federate live after cleanup', { videoId: video.id, err })
  }
}

function createStoryboardJob (video: MVideo) {
  return JobQueue.Instance.createJob(buildStoryboardJobIfNeeded({ video, federate: true }))
}

async function hasReplayFiles (replayDirectory: string) {
  return await pathExists(replayDirectory) && (await readdir(replayDirectory)).length !== 0
}
