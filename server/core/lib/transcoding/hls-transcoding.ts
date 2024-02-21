import { MutexInterface } from 'async-mutex'
import { Job } from 'bullmq'
import { ensureDir, move } from 'fs-extra/esm'
import { stat } from 'fs/promises'
import { basename, extname as extnameUtil, join } from 'path'
import { addExt2, addExt3, pick } from '@peertube/peertube-core-utils'
import { retryTransactionWrapper } from '@server/helpers/database-utils.js'
import { createTorrentAndSetInfoHash } from '@server/helpers/webtorrent.js'
import { sequelizeTypescript } from '@server/initializers/database.js'
import { MVideo, MVideoFile } from '@server/types/models/index.js'
import { getVideoStreamDuration, getVideoStreamFPS } from '@peertube/peertube-ffmpeg'
import { CONFIG } from '../../initializers/config.js'
import { VideoFileModel } from '../../models/video/video-file.js'
import { VideoStreamingPlaylistModel } from '../../models/video/video-streaming-playlist.js'
import { updatePlaylistAfterFileChange } from '../hls.js'
import { generateHLSVideoFilename, getHlsResolutionPlaylistFilename } from '../paths.js'
import { buildFileMetadata } from '../video-file.js'
import { VideoPathManager } from '../video-path-manager.js'
import { buildFFmpegVOD } from './shared/index.js'

import { addExt } from '@peertube/peertube-core-utils'

import { promises as fsPromises } from 'fs';
import  path from 'path';

// Concat TS segments from a live video to a fragmented mp4 HLS playlist
export async function generateHlsPlaylistResolutionFromTS (options: {
  video: MVideo
  concatenatedTsFilePath: string
  resolution: number
  fps: number
  isAAC: boolean
  inputFileMutexReleaser: MutexInterface.Releaser
}) {
  return generateHlsPlaylistCommon({
    type: 'hls-from-ts' as 'hls-from-ts',
    inputPath: options.concatenatedTsFilePath,

    ...pick(options, [ 'video', 'resolution', 'fps', 'inputFileMutexReleaser', 'isAAC' ])
  })
}

// Generate an HLS playlist from an input file, and update the master playlist
export function generateHlsPlaylistResolution (options: {
  video: MVideo
  videoInputPath: string
  resolution: number
  fps: number
  copyCodecs: boolean
  inputFileMutexReleaser: MutexInterface.Releaser
  job?: Job
}) {
  return generateHlsPlaylistCommon({
    type: 'hls' as 'hls',
    inputPath: options.videoInputPath,

    ...pick(options, [ 'video', 'resolution', 'fps', 'copyCodecs', 'inputFileMutexReleaser', 'job' ])
  })
}

export async function onHLSVideoFileTranscoding (options: {
  video: MVideo
  videoFile: MVideoFile
  videoOutputPath: string
  m3u8OutputPath: string
  filesLockedInParent?: boolean // default false
}) {
  const { video, videoFile, videoOutputPath, m3u8OutputPath, filesLockedInParent = false } = options

  // console.log("videoe",video);
  // Create or update the playlist
  const playlist = await retryTransactionWrapper(() => {
    return sequelizeTypescript.transaction(async transaction => {
      return VideoStreamingPlaylistModel.loadOrGenerate(video, transaction)
    })
  })
  videoFile.videoStreamingPlaylistId = playlist.id

  const mutexReleaser = !filesLockedInParent
    ? await VideoPathManager.Instance.lockFiles(video.uuid)
    : null

  try {
    await video.reload()

  let videoFilePath = VideoPathManager.Instance.getFSVideoFileOutputPath(playlist, videoFile)
    await ensureDir(VideoPathManager.Instance.getFSHLSOutputPath(video))

    // Move playlist file
    const resolutionPlaylistPath = VideoPathManager.Instance.getFSHLSOutputPath(video, basename(m3u8OutputPath))
    await move(m3u8OutputPath, resolutionPlaylistPath, { overwrite: true })
    // Move video file

        console.log("😂😂😂😂😂😂😂😂😂😂😂😂😂😂😂",  videoOutputPath, videoFilePath);
      let numberOfFiles : number;
      await moveFiles(videoOutputPath, videoFilePath).then((filesMoved) => numberOfFiles = filesMoved); // added code
      console.log("🍸🍸🍸🍸🍸🍸🍸", numberOfFiles);
      videoFilePath = addExt(videoFilePath, 0);
      // console.log(addExt(videoFilePath));


      // const outputPath = addExt(videoOutputPath, 0);
  // await move(outputPath, videoFilePath, { overwrite: true })


    // Update video duration if it was not set (in case of a live for example)
    if (!video.duration) {
      video.duration = await getVideoStreamDuration(videoFilePath)
      await video.save()
    }


    console.log("🍸🍸🍸🍸🍸", videoFilePath);
    const stats = await stat(videoFilePath)
    console.log("🍸🍸🍸🍸🍸🍸", stats);
    videoFile.size = stats.size
    videoFile.fps = await getVideoStreamFPS(videoFilePath)
    videoFile.metadata = await buildFileMetadata(videoFilePath)

    videoFile.filename = addExt(videoFile.filename, 0); // changed

    // videofile will be an arry and we will have to create torrent for each segment.
    // let i=0;
    // let tempVideoFile = videoFile
    // let base = videoFile.filename;
    // while(i<numberOfFiles){

    //   tempVideoFile.filename = addExt3(base, i)
    //   console.log("🍯🍯🍯🍯🍯",tempVideoFile.filename, videoFile.filename);
    //   await createTorrentAndSetInfoHash(playlist, tempVideoFile);
    //   i++;

    // }

         await createTorrentAndSetInfoHash(playlist, videoFile);


    const oldFile = await VideoFileModel.loadHLSFile({
      playlistId: playlist.id,
      fps: videoFile.fps,
      resolution: videoFile.resolution
    })

    if (oldFile) {
      await video.removeStreamingPlaylistVideoFile(playlist, oldFile)
      await oldFile.destroy()
    }

    const savedVideoFile = await VideoFileModel.customUpsert(videoFile, 'streaming-playlist', undefined)
    // console.log(savedVideoFile);

    // console.log("😂😂😂😂😂😂😂😂😂😂😂😂😂😂😂", video);
    // console.log("😂😂😂😂😂😂😂😂😂😂😂😂😂😂😂", playlist);


    await updatePlaylistAfterFileChange(video, playlist)



    return { resolutionPlaylistPath, videoFile: savedVideoFile }
  } finally {
    if (mutexReleaser) mutexReleaser()
  }
}

// ---------------------------------------------------------------------------

async function generateHlsPlaylistCommon (options: {
  type: 'hls' | 'hls-from-ts'
  video: MVideo
  inputPath: string

  resolution: number
  fps: number

  inputFileMutexReleaser: MutexInterface.Releaser

  copyCodecs?: boolean
  isAAC?: boolean

  job?: Job
}) {
  const { type, video, inputPath, resolution, fps, copyCodecs, isAAC, job, inputFileMutexReleaser } = options
  const transcodeDirectory = CONFIG.STORAGE.TMP_DIR

  // console.log("job", job);
  const videoTranscodedBasePath = join(transcodeDirectory, type)
  await ensureDir(videoTranscodedBasePath)

  const videoFilename = generateHLSVideoFilename(resolution)


  const videoOutputPath = join(videoTranscodedBasePath, videoFilename)

  const resolutionPlaylistFilename = getHlsResolutionPlaylistFilename(videoFilename)
  console.log(" 🍕🍕🍕🍕🍕🍕🍕",videoFilename, resolutionPlaylistFilename);
  const m3u8OutputPath = join(videoTranscodedBasePath, resolutionPlaylistFilename)

  const transcodeOptions = {
    type,

    inputPath,
    outputPath: m3u8OutputPath,

    resolution,
    fps,
    copyCodecs,

    isAAC,

    inputFileMutexReleaser,

    hlsPlaylist: {
      videoFilename
    }
  }




  await buildFFmpegVOD(job).transcode(transcodeOptions)

  const newVideoFile = new VideoFileModel({
    resolution,
    extname: extnameUtil(videoFilename),
    size: 0,
    filename: videoFilename,
    fps: -1
  })

  await onHLSVideoFileTranscoding({
    video,
    videoFile: newVideoFile,
    videoOutputPath,
    m3u8OutputPath,
    filesLockedInParent: !inputFileMutexReleaser
  })
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


// function forEachSegment(numberOfFiles: number, cb:any, ){

//   while(numberOfFiles--){
//    await cb()
//   }
// }
