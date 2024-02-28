import { move } from 'fs-extra/esm'
import { dirname, join } from 'path'
import { logger } from '@server/helpers/logger.js'
import { renameVideoFileInPlaylist } from '@server/lib/hls.js'
import { getHlsResolutionPlaylistFilename } from '@server/lib/paths.js'
import { onTranscodingEnded } from '@server/lib/transcoding/ended-transcoding.js'
import { onHLSVideoFileTranscoding } from '@server/lib/transcoding/hls-transcoding.js'
import { buildNewFile, removeAllWebVideoFiles } from '@server/lib/video-file.js'
import { VideoJobInfoModel } from '@server/models/video/video-job-info.js'
import { MVideo, MVideoFile } from '@server/types/models/index.js'
import { MRunnerJob } from '@server/types/models/runners/index.js'
import { pick } from '@peertube/peertube-core-utils'
import { buildUUID } from '@peertube/peertube-node-utils'
import {
  RunnerJobUpdatePayload,
  RunnerJobVODHLSTranscodingPayload,
  RunnerJobVODHLSTranscodingPrivatePayload,
  VODHLSTranscodingSuccess
} from '@peertube/peertube-models'
import { generateRunnerTranscodingVideoInputFileUrl } from '../runner-urls.js'
import { AbstractVODTranscodingJobHandler } from './abstract-vod-transcoding-job-handler.js'
import { loadTranscodingRunnerVideo } from './shared/index.js'


import { addExt } from '@peertube/peertube-core-utils'
import { promises as fsPromises } from 'fs';
import  path from 'path';

type CreateOptions = {
  video: MVideo
  isNewVideo: boolean
  deleteWebVideoFiles: boolean
  resolution: number
  fps: number
  priority: number
  dependsOnRunnerJob?: MRunnerJob
}

// eslint-disable-next-line max-len
export class VODHLSTranscodingJobHandler extends AbstractVODTranscodingJobHandler<CreateOptions, RunnerJobUpdatePayload, VODHLSTranscodingSuccess> {

  async create (options: CreateOptions) {
    const { video, resolution, fps, dependsOnRunnerJob, priority } = options

    const jobUUID = buildUUID()

    const payload: RunnerJobVODHLSTranscodingPayload = {
      input: {
        videoFileUrl: generateRunnerTranscodingVideoInputFileUrl(jobUUID, video.uuid)
      },
      output: {
        resolution,
        fps
      }
    }

    const privatePayload: RunnerJobVODHLSTranscodingPrivatePayload = {
      ...pick(options, [ 'isNewVideo', 'deleteWebVideoFiles' ]),

      videoUUID: video.uuid
    }

    const job = await this.createRunnerJob({
      type: 'vod-hls-transcoding',
      jobUUID,
      payload,
      privatePayload,
      priority,
      dependsOnRunnerJob
    })

    await VideoJobInfoModel.increaseOrCreate(video.uuid, 'pendingTranscode')

    return job
  }

  // ---------------------------------------------------------------------------

  protected async specificComplete (options: {
    runnerJob: MRunnerJob
    resultPayload: VODHLSTranscodingSuccess
  }) {

    const { runnerJob, resultPayload } = options
    const privatePayload = runnerJob.privatePayload as RunnerJobVODHLSTranscodingPrivatePayload

    const video = await loadTranscodingRunnerVideo(runnerJob, this.lTags)
    if (!video) return

    const videoFilePath = resultPayload.videoFile[0] as string
    const videoFile = await buildNewFile({ path: videoFilePath, mode: 'hls' })
    const newVideoFilePath = join(dirname(videoFilePath), videoFile.filename)
    const resolutionPlaylistFilePath = resultPayload.resolutionPlaylistFile as string

    let videoFile1: MVideoFile, newVideoFilePath1, newResolutionPlaylistFilePath;
    let i=0;
    for(let file of resultPayload.videoFile as string){
         if(!videoFile1){
            videoFile1 = videoFile
            newVideoFilePath1 = newVideoFilePath

             const resolutionPlaylistFilename = getHlsResolutionPlaylistFilename(videoFile1.filename)
             newResolutionPlaylistFilePath = join(dirname(resolutionPlaylistFilePath), resolutionPlaylistFilename)
             await move(resolutionPlaylistFilePath, newResolutionPlaylistFilePath)
            }


          let newPath = addExt(newVideoFilePath, i);
          moveFiles(file, newPath);
          await renameVideoFileInPlaylist(newResolutionPlaylistFilePath, addExt(videoFile.filename, i) )
          i++;
    }

    await onHLSVideoFileTranscoding({
      video,
      videoFile,
      m3u8OutputPath: newResolutionPlaylistFilePath,
      videoOutputPath: newVideoFilePath1
    })

    await onTranscodingEnded({ isNewVideo: privatePayload.isNewVideo, moveVideoToNextState: true, video })

    if (privatePayload.deleteWebVideoFiles === true) {
      logger.info('Removing web video files of %s now we have a HLS version of it.', video.uuid, this.lTags(video.uuid))

      await removeAllWebVideoFiles(video)
    }


    logger.info('Runner VOD HLS job %s for %s ended.', runnerJob.uuid, video.uuid, this.lTags(runnerJob.uuid, video.uuid))
  }
}




async function moveFiles(outputPath: string , filePath: string){
  let i = 0;
  let filesMoved = 0;

  // Iterate over the range of file names
  while (true) {


      const sourceFilePath =  addExt(outputPath, i);
      const desinationFielPath = addExt(filePath, i);
      try {
          await fsPromises.access(sourceFilePath);

          await move(sourceFilePath, desinationFielPath);
          filesMoved++;

          i++;
      } catch (error) {
          break;
      }
  }

  return filesMoved;

}
