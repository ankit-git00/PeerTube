import { Job } from 'bullmq'
import { copy } from 'fs-extra/esm'
import { stat } from 'fs/promises'
import { VideoFileImportPayload, FileStorage } from '@peertube/peertube-models'
import { createTorrentAndSetInfoHash } from '@server/helpers/webtorrent.js'
import { CONFIG } from '@server/initializers/config.js'
import { federateVideoIfNeeded } from '@server/lib/activitypub/videos/index.js'
import { generateWebVideoFilename } from '@server/lib/paths.js'
import { VideoPathManager } from '@server/lib/video-path-manager.js'
import { VideoFileModel } from '@server/models/video/video-file.js'
import { VideoModel } from '@server/models/video/video.js'
import { MVideoFullLight } from '@server/types/models/index.js'
import { getLowercaseExtension } from '@peertube/peertube-node-utils'
import { getVideoStreamDimensionsInfo, getVideoStreamFPS } from '@peertube/peertube-ffmpeg'
import { logger } from '../../../helpers/logger.js'
import { JobQueue } from '../job-queue.js'
import { buildMoveJob } from '@server/lib/video-jobs.js'

async function processVideoFileImport (job: Job) {
  const payload = job.data as VideoFileImportPayload
  logger.info('Processing video file import in job %s.', job.id)

  const video = await VideoModel.loadFull(payload.videoUUID)
  // No video, maybe deleted?
  if (!video) {
    logger.info('Do not process job %d, video does not exist.', job.id)
    return undefined
  }

  await updateVideoFile(video, payload.filePath)

  if (CONFIG.OBJECT_STORAGE.ENABLED) {
    await JobQueue.Instance.createJob(await buildMoveJob({ video, previousVideoState: video.state, type: 'move-to-object-storage' }))
  } else {
    await federateVideoIfNeeded(video, false)
  }

  return video
}

// ---------------------------------------------------------------------------

export {
  processVideoFileImport
}

// ---------------------------------------------------------------------------

async function updateVideoFile (video: MVideoFullLight, inputFilePath: string) {
  const { resolution } = await getVideoStreamDimensionsInfo(inputFilePath)
  const { size } = await stat(inputFilePath)
  const fps = await getVideoStreamFPS(inputFilePath)

  const fileExt = getLowercaseExtension(inputFilePath)

  const currentVideoFile = video.VideoFiles.find(videoFile => videoFile.resolution === resolution)

  if (currentVideoFile) {
    // Remove old file and old torrent
    await video.removeWebVideoFile(currentVideoFile)
    // Remove the old video file from the array
    video.VideoFiles = video.VideoFiles.filter(f => f !== currentVideoFile)

    await currentVideoFile.destroy()
  }

  const newVideoFile = new VideoFileModel({
    resolution,
    extname: fileExt,
    filename: generateWebVideoFilename(resolution, fileExt),
    storage: FileStorage.FILE_SYSTEM,
    size,
    fps,
    videoId: video.id
  })

  const outputPath = VideoPathManager.Instance.getFSVideoFileOutputPath(video, newVideoFile)
  await copy(inputFilePath, outputPath)

  video.VideoFiles.push(newVideoFile)
  await createTorrentAndSetInfoHash(video, newVideoFile)

  await newVideoFile.save()
}
