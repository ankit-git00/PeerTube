import { FileStorage, isMoveCaptionPayload, isMoveVideoStoragePayload, MoveStoragePayload, VideoStateType } from '@peertube/peertube-models'
import { logger, loggerTagsFactory } from '@server/helpers/logger.js'
import { updateTorrentMetadata } from '@server/helpers/webtorrent.js'
import { P2P_MEDIA_LOADER_PEER_VERSION } from '@server/initializers/constants.js'
import { buildCaptionM3U8Content } from '@server/lib/hls.js'
import {
  storeHLSFileFromContent,
  storeHLSFileFromFilename,
  storeOriginalVideoFile,
  storeVideoCaption,
  storeWebVideoFile
} from '@server/lib/object-storage/index.js'
import { getHLSDirectory, getHLSResolutionPlaylistFilename } from '@server/lib/paths.js'
import { updateHLSMasterOnCaptionChange } from '@server/lib/video-captions.js'
import { VideoPathManager } from '@server/lib/video-path-manager.js'
import { moveToFailedMoveToObjectStorageState, moveToNextState } from '@server/lib/video-state.js'
import { MStreamingPlaylistVideo, MVideo, MVideoCaption, MVideoFile, MVideoWithAllFiles } from '@server/types/models/index.js'
import { MVideoSource } from '@server/types/models/video/video-source.js'
import { Job } from 'bullmq'
import { remove } from 'fs-extra/esm'
import { join } from 'path'
import { moveCaptionToStorageJob } from './shared/move-caption.js'
import { moveVideoToStorageJob, onMoveVideoToStorageFailure } from './shared/move-video.js'
import { VideoCaptionModel } from '@server/models/video/video-caption.js'

const lTagsBase = loggerTagsFactory('move-object-storage')

export async function processMoveToObjectStorage (job: Job) {
  const payload = job.data as MoveStoragePayload

  if (isMoveVideoStoragePayload(payload)) { // Move all video related files
    logger.info(`Moving video ${payload.videoUUID} to object storage in job ${job.id}`, lTagsBase(payload.videoUUID))

    await moveVideoToStorageJob({
      jobId: job.id,
      videoUUID: payload.videoUUID,
      loggerTags: lTagsBase().tags,

      moveWebVideoFiles,
      moveHLSFiles,
      moveVideoSourceFile,
      moveCaptionFiles,

      doAfterLastMove: video => {
        return doAfterLastVideoMove({ video, previousVideoState: payload.previousVideoState, isNewVideo: payload.isNewVideo })
      }
    })
  } else if (isMoveCaptionPayload(payload)) { // Only caption file
    logger.info(`Moving video caption ${payload.captionId} to object storage in job ${job.id}.`, lTagsBase(payload.captionId))

    await moveCaptionToStorageJob({
      jobId: job.id,
      captionId: payload.captionId,
      loggerTags: lTagsBase().tags,
      moveCaptionFiles
    })
  } else {
    throw new Error('Unknown payload type')
  }
}

export async function onMoveToObjectStorageFailure (job: Job, err: any) {
  const payload = job.data as MoveStoragePayload

  if (!isMoveVideoStoragePayload(payload)) return

  await onMoveVideoToStorageFailure({
    videoUUID: payload.videoUUID,
    err,
    lTags: lTagsBase(),
    moveToFailedState: moveToFailedMoveToObjectStorageState
  })
}

// ---------------------------------------------------------------------------

async function moveVideoSourceFile (source: MVideoSource) {
  if (source.storage !== FileStorage.FILE_SYSTEM) return

  const sourcePath = VideoPathManager.Instance.getFSOriginalVideoFilePath(source.keptOriginalFilename)
  const fileUrl = await storeOriginalVideoFile(sourcePath, source.keptOriginalFilename)

  source.storage = FileStorage.OBJECT_STORAGE
  source.fileUrl = fileUrl
  await source.save()

  logger.debug('Removing original video file ' + sourcePath + ' because it\'s now on object storage', lTagsBase())

  await remove(sourcePath)
}

// ---------------------------------------------------------------------------

async function moveCaptionFiles (captions: MVideoCaption[], hls: MStreamingPlaylistVideo) {
  let hlsUpdated = false

  for (const caption of captions) {
    if (caption.storage === FileStorage.FILE_SYSTEM) {
      const captionPath = caption.getFSFilePath()

      // Assign new values before building the m3u8 file
      caption.fileUrl = await storeVideoCaption(captionPath, caption.filename)
      caption.storage = FileStorage.OBJECT_STORAGE

      await caption.save()

      logger.debug(`Removing video caption file ${captionPath} because it's now on object storage`, lTagsBase())
      await remove(captionPath)
    }

    if (hls && (!caption.m3u8Filename || !caption.m3u8Url)) {
      hlsUpdated = true

      const m3u8PathToRemove = caption.getFSM3U8Path(hls.Video)

      // Caption link has been updated, so we must also update the HLS caption playlist
      const content = buildCaptionM3U8Content({ video: hls.Video, caption })

      caption.m3u8Filename = VideoCaptionModel.generateM3U8Filename(caption.filename)
      caption.m3u8Url = await storeHLSFileFromContent({
        playlist: hls,
        pathOrFilename: caption.m3u8Filename,
        content
      })

      await caption.save()

      if (m3u8PathToRemove) {
        logger.debug(`Removing video caption playlist file ${m3u8PathToRemove} because it's now on object storage`, lTagsBase())
        await remove(m3u8PathToRemove)
      }
    }
  }

  if (hlsUpdated) {
    await updateHLSMasterOnCaptionChange(hls.Video, hls)
  }
}

// ---------------------------------------------------------------------------

async function moveWebVideoFiles (video: MVideoWithAllFiles) {
  for (const file of video.VideoFiles) {
    if (file.storage !== FileStorage.FILE_SYSTEM) continue

    const fileUrl = await storeWebVideoFile(video, file)

    const oldPath = VideoPathManager.Instance.getFSVideoFileOutputPath(video, file)
    await onVideoFileMoved({ videoOrPlaylist: video, file, fileUrl, oldPath })
  }
}

async function moveHLSFiles (video: MVideoWithAllFiles) {
  for (const playlist of video.VideoStreamingPlaylists) {
    const playlistWithVideo = playlist.withVideo(video)

    for (const file of playlist.VideoFiles) {
      if (file.storage !== FileStorage.FILE_SYSTEM) continue

      // Resolution playlist
      const playlistFilename = getHLSResolutionPlaylistFilename(file.filename)
      await storeHLSFileFromFilename(playlistWithVideo, playlistFilename)

      // Resolution fragmented file
      const fileUrl = await storeHLSFileFromFilename(playlistWithVideo, file.filename)

      const oldPath = join(getHLSDirectory(video), file.filename)

      await onVideoFileMoved({ videoOrPlaylist: Object.assign(playlist, { Video: video }), file, fileUrl, oldPath })
    }
  }
}

async function onVideoFileMoved (options: {
  videoOrPlaylist: MVideo | MStreamingPlaylistVideo
  file: MVideoFile
  fileUrl: string
  oldPath: string
}) {
  const { videoOrPlaylist, file, fileUrl, oldPath } = options

  file.fileUrl = fileUrl
  file.storage = FileStorage.OBJECT_STORAGE

  await updateTorrentMetadata(videoOrPlaylist, file)
  await file.save()

  logger.debug('Removing %s because it\'s now on object storage', oldPath, lTagsBase())
  await remove(oldPath)
}

// ---------------------------------------------------------------------------

async function doAfterLastVideoMove (options: {
  video: MVideoWithAllFiles
  previousVideoState: VideoStateType
  isNewVideo: boolean
}) {
  const { video, previousVideoState, isNewVideo } = options

  for (const playlist of video.VideoStreamingPlaylists) {
    if (playlist.storage === FileStorage.OBJECT_STORAGE) continue

    const playlistWithVideo = playlist.withVideo(video)

    playlist.playlistUrl = await storeHLSFileFromFilename(playlistWithVideo, playlist.playlistFilename)
    playlist.segmentsSha256Url = await storeHLSFileFromFilename(playlistWithVideo, playlist.segmentsSha256Filename)
    playlist.storage = FileStorage.OBJECT_STORAGE

    playlist.assignP2PMediaLoaderInfoHashes(video, playlist.VideoFiles)
    playlist.p2pMediaLoaderPeerVersion = P2P_MEDIA_LOADER_PEER_VERSION

    await playlist.save()
  }

  await remove(getHLSDirectory(video))
  await moveToNextState({ video, previousVideoState, isNewVideo })
}
