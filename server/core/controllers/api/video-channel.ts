import {
  ActorImageType,
  HttpStatusCode,
  VideoChannelCreate,
  VideoChannelUpdate,
  VideoPlaylistReorder,
  VideoPlaylistsListQuery,
  VideosImportInChannelCreate
} from '@peertube/peertube-models'
import { pickCommonVideoQuery } from '@server/helpers/query.js'
import { Hooks } from '@server/lib/plugins/hooks.js'
import { reorderPlaylistOrElementsPosition, sendPlaylistPositionUpdateOfChannel } from '@server/lib/video-playlist.js'
import { ActorFollowModel } from '@server/models/actor/actor-follow.js'
import { getServerActor } from '@server/models/application/application.js'
import { MChannelBannerAccountDefault } from '@server/types/models/index.js'
import express from 'express'
import { auditLoggerFactory, getAuditIdFromRes, VideoChannelAuditView } from '../../helpers/audit-logger.js'
import { resetSequelizeInstance } from '../../helpers/database-utils.js'
import { buildNSFWFilters, createReqFiles, getCountVideos, isUserAbleToSearchRemoteURI } from '../../helpers/express-utils.js'
import { logger } from '../../helpers/logger.js'
import { getFormattedObjects } from '../../helpers/utils.js'
import { MIMETYPES } from '../../initializers/constants.js'
import { sequelizeTypescript } from '../../initializers/database.js'
import { sendUpdateActor } from '../../lib/activitypub/send/index.js'
import { JobQueue } from '../../lib/job-queue/index.js'
import { deleteLocalActorImageFile, updateLocalActorImageFiles } from '../../lib/local-actor.js'
import { createLocalVideoChannelWithoutKeys, federateAllVideosOfChannel } from '../../lib/video-channel.js'
import {
  apiRateLimiter,
  asyncMiddleware,
  asyncRetryTransactionMiddleware,
  authenticate,
  commonVideosFiltersValidator,
  optionalAuthenticate,
  paginationValidator,
  setDefaultPagination,
  setDefaultSort,
  setDefaultVideosSort,
  videoChannelsAddValidator,
  videoChannelsRemoveValidator,
  videoChannelsSortValidator,
  videoChannelsUpdateValidator,
  videoPlaylistsSortValidator
} from '../../middlewares/index.js'
import { updateAvatarValidator, updateBannerValidator } from '../../middlewares/validators/actor-image.js'
import {
  ensureChannelOwnerCanUpload,
  videoChannelImportVideosValidator,
  videoChannelsFollowersSortValidator,
  videoChannelsHandleValidatorFactory,
  videoChannelsListValidator,
  videosSortValidator
} from '../../middlewares/validators/index.js'
import {
  commonVideoPlaylistFiltersValidator,
  videoPlaylistsReorderInChannelValidator
} from '../../middlewares/validators/videos/video-playlists.js'
import { AccountModel } from '../../models/account/account.js'
import { guessAdditionalAttributesFromQuery } from '../../models/video/formatter/index.js'
import { VideoChannelModel } from '../../models/video/video-channel.js'
import { VideoPlaylistModel } from '../../models/video/video-playlist.js'
import { VideoModel } from '../../models/video/video.js'

const auditLogger = auditLoggerFactory('channels')
const reqAvatarFile = createReqFiles([ 'avatarfile' ], MIMETYPES.IMAGE.MIMETYPE_EXT)
const reqBannerFile = createReqFiles([ 'bannerfile' ], MIMETYPES.IMAGE.MIMETYPE_EXT)

const videoChannelRouter = express.Router()

videoChannelRouter.use(apiRateLimiter)

videoChannelRouter.get(
  '/',
  paginationValidator,
  videoChannelsSortValidator,
  setDefaultSort,
  setDefaultPagination,
  videoChannelsListValidator,
  asyncMiddleware(listVideoChannels)
)

videoChannelRouter.post('/', authenticate, asyncMiddleware(videoChannelsAddValidator), asyncRetryTransactionMiddleware(createVideoChannel))

videoChannelRouter.post(
  '/:handle/avatar/pick',
  authenticate,
  reqAvatarFile,
  asyncMiddleware(videoChannelsHandleValidatorFactory({ checkIsLocal: true, checkManage: true })),
  updateAvatarValidator,
  asyncMiddleware(updateVideoChannelAvatar)
)

videoChannelRouter.post(
  '/:handle/banner/pick',
  authenticate,
  reqBannerFile,
  asyncMiddleware(videoChannelsHandleValidatorFactory({ checkIsLocal: true, checkManage: true })),
  updateBannerValidator,
  asyncMiddleware(updateVideoChannelBanner)
)

videoChannelRouter.delete(
  '/:handle/avatar',
  authenticate,
  asyncMiddleware(videoChannelsHandleValidatorFactory({ checkIsLocal: true, checkManage: true })),
  asyncMiddleware(deleteVideoChannelAvatar)
)

videoChannelRouter.delete(
  '/:handle/banner',
  authenticate,
  asyncMiddleware(videoChannelsHandleValidatorFactory({ checkIsLocal: true, checkManage: true })),
  asyncMiddleware(deleteVideoChannelBanner)
)

videoChannelRouter.put(
  '/:handle',
  authenticate,
  asyncMiddleware(videoChannelsHandleValidatorFactory({ checkIsLocal: true, checkManage: true })),
  videoChannelsUpdateValidator,
  asyncRetryTransactionMiddleware(updateVideoChannel)
)

videoChannelRouter.delete(
  '/:handle',
  authenticate,
  asyncMiddleware(videoChannelsHandleValidatorFactory({ checkIsLocal: true, checkManage: true })),
  asyncMiddleware(videoChannelsRemoveValidator),
  asyncRetryTransactionMiddleware(removeVideoChannel)
)

videoChannelRouter.get(
  '/:handle',
  asyncMiddleware(videoChannelsHandleValidatorFactory({ checkIsLocal: false, checkManage: false })),
  asyncMiddleware(getVideoChannel)
)

// ---------------------------------------------------------------------------

videoChannelRouter.get(
  '/:handle/video-playlists',
  optionalAuthenticate,
  asyncMiddleware(videoChannelsHandleValidatorFactory({ checkIsLocal: false, checkManage: false })),
  paginationValidator,
  videoPlaylistsSortValidator,
  setDefaultSort,
  setDefaultPagination,
  commonVideoPlaylistFiltersValidator,
  asyncMiddleware(listVideoChannelPlaylists)
)

videoChannelRouter.post(
  '/:handle/video-playlists/reorder',
  authenticate,
  asyncMiddleware(videoChannelsHandleValidatorFactory({ checkIsLocal: true, checkManage: true })),
  asyncMiddleware(videoPlaylistsReorderInChannelValidator),
  asyncRetryTransactionMiddleware(reorderPlaylistsInChannel)
)

// ---------------------------------------------------------------------------

videoChannelRouter.get(
  '/:handle/videos',
  asyncMiddleware(videoChannelsHandleValidatorFactory({ checkIsLocal: false, checkManage: false })),
  paginationValidator,
  videosSortValidator,
  setDefaultVideosSort,
  setDefaultPagination,
  optionalAuthenticate,
  commonVideosFiltersValidator,
  asyncMiddleware(listVideoChannelVideos)
)

videoChannelRouter.get(
  '/:handle/followers',
  authenticate,
  asyncMiddleware(videoChannelsHandleValidatorFactory({ checkIsLocal: false, checkManage: true })),
  paginationValidator,
  videoChannelsFollowersSortValidator,
  setDefaultSort,
  setDefaultPagination,
  asyncMiddleware(listVideoChannelFollowers)
)

videoChannelRouter.post(
  '/:handle/import-videos',
  authenticate,
  asyncMiddleware(videoChannelsHandleValidatorFactory({ checkIsLocal: true, checkManage: true })),
  asyncMiddleware(videoChannelImportVideosValidator),
  asyncMiddleware(ensureChannelOwnerCanUpload),
  asyncMiddleware(importVideosInChannel)
)

// ---------------------------------------------------------------------------

export {
  videoChannelRouter
}

// ---------------------------------------------------------------------------

async function listVideoChannels (req: express.Request, res: express.Response) {
  const serverActor = await getServerActor()

  const apiOptions = await Hooks.wrapObject({
    actorId: serverActor.id,
    start: req.query.start,
    count: req.query.count,
    sort: req.query.sort
  }, 'filter:api.video-channels.list.params')

  const resultList = await Hooks.wrapPromiseFun(
    VideoChannelModel.listForApi.bind(VideoChannelModel),
    apiOptions,
    'filter:api.video-channels.list.result'
  )

  return res.json(getFormattedObjects(resultList.data, resultList.total))
}

async function updateVideoChannelBanner (req: express.Request, res: express.Response) {
  const bannerPhysicalFile = req.files['bannerfile'][0]
  const videoChannel = res.locals.videoChannel
  const oldVideoChannelAuditKeys = new VideoChannelAuditView(videoChannel.toFormattedJSON())

  const banners = await updateLocalActorImageFiles({
    accountOrChannel: videoChannel,
    imagePhysicalFile: bannerPhysicalFile,
    type: ActorImageType.BANNER,
    sendActorUpdate: true
  })

  auditLogger.update(getAuditIdFromRes(res), new VideoChannelAuditView(videoChannel.toFormattedJSON()), oldVideoChannelAuditKeys)

  return res.json({
    banners: banners.map(b => b.toFormattedJSON())
  })
}

async function updateVideoChannelAvatar (req: express.Request, res: express.Response) {
  const avatarPhysicalFile = req.files['avatarfile'][0]
  const videoChannel = res.locals.videoChannel
  const oldVideoChannelAuditKeys = new VideoChannelAuditView(videoChannel.toFormattedJSON())

  const avatars = await updateLocalActorImageFiles({
    accountOrChannel: videoChannel,
    imagePhysicalFile: avatarPhysicalFile,
    type: ActorImageType.AVATAR,
    sendActorUpdate: true
  })

  auditLogger.update(getAuditIdFromRes(res), new VideoChannelAuditView(videoChannel.toFormattedJSON()), oldVideoChannelAuditKeys)

  return res.json({
    avatars: avatars.map(a => a.toFormattedJSON())
  })
}

async function deleteVideoChannelAvatar (req: express.Request, res: express.Response) {
  const videoChannel = res.locals.videoChannel

  await deleteLocalActorImageFile(videoChannel, ActorImageType.AVATAR)

  return res.status(HttpStatusCode.NO_CONTENT_204).end()
}

async function deleteVideoChannelBanner (req: express.Request, res: express.Response) {
  const videoChannel = res.locals.videoChannel

  await deleteLocalActorImageFile(videoChannel, ActorImageType.BANNER)

  return res.status(HttpStatusCode.NO_CONTENT_204).end()
}

async function createVideoChannel (req: express.Request, res: express.Response) {
  const videoChannelInfo: VideoChannelCreate = req.body

  const videoChannelCreated = await sequelizeTypescript.transaction(async t => {
    const account = await AccountModel.load(res.locals.oauth.token.User.Account.id, t)

    return createLocalVideoChannelWithoutKeys(videoChannelInfo, account, t)
  })

  await JobQueue.Instance.createJob({
    type: 'actor-keys',
    payload: { actorId: videoChannelCreated.actorId }
  })

  auditLogger.create(getAuditIdFromRes(res), new VideoChannelAuditView(videoChannelCreated.toFormattedJSON()))
  logger.info('Video channel %s created.', videoChannelCreated.Actor.url)

  Hooks.runAction('action:api.video-channel.created', { videoChannel: videoChannelCreated, req, res })

  return res.json({
    videoChannel: {
      id: videoChannelCreated.id
    }
  })
}

async function updateVideoChannel (req: express.Request, res: express.Response) {
  const videoChannelInstance = res.locals.videoChannel
  const oldVideoChannelAuditKeys = new VideoChannelAuditView(videoChannelInstance.toFormattedJSON())
  const videoChannelInfoToUpdate = req.body as VideoChannelUpdate
  let doBulkVideoUpdate = false

  try {
    await sequelizeTypescript.transaction(async t => {
      if (videoChannelInfoToUpdate.displayName !== undefined) videoChannelInstance.name = videoChannelInfoToUpdate.displayName
      if (videoChannelInfoToUpdate.description !== undefined) videoChannelInstance.description = videoChannelInfoToUpdate.description

      if (videoChannelInfoToUpdate.support !== undefined) {
        const oldSupportField = videoChannelInstance.support
        videoChannelInstance.support = videoChannelInfoToUpdate.support

        if (videoChannelInfoToUpdate.bulkVideosSupportUpdate === true && oldSupportField !== videoChannelInfoToUpdate.support) {
          doBulkVideoUpdate = true
          await VideoModel.bulkUpdateSupportField(videoChannelInstance, t)
        }
      }

      const videoChannelInstanceUpdated = await videoChannelInstance.save({ transaction: t }) as MChannelBannerAccountDefault
      await sendUpdateActor(videoChannelInstanceUpdated, t)

      auditLogger.update(
        getAuditIdFromRes(res),
        new VideoChannelAuditView(videoChannelInstanceUpdated.toFormattedJSON()),
        oldVideoChannelAuditKeys
      )

      Hooks.runAction('action:api.video-channel.updated', { videoChannel: videoChannelInstanceUpdated, req, res })

      logger.info('Video channel %s updated.', videoChannelInstance.Actor.url)
    })
  } catch (err) {
    logger.debug('Cannot update the video channel.', { err })

    // If the transaction is retried, sequelize will think the object has not changed
    // So we need to restore the previous fields
    await resetSequelizeInstance(videoChannelInstance)

    throw err
  }

  res.type('json').status(HttpStatusCode.NO_CONTENT_204).end()

  // Don't process in a transaction, and after the response because it could be long
  if (doBulkVideoUpdate) {
    await federateAllVideosOfChannel(videoChannelInstance)
  }
}

async function removeVideoChannel (req: express.Request, res: express.Response) {
  const videoChannelInstance = res.locals.videoChannel

  await sequelizeTypescript.transaction(async t => {
    await VideoPlaylistModel.resetPlaylistsOfChannel(videoChannelInstance.id, t)

    await videoChannelInstance.destroy({ transaction: t })

    Hooks.runAction('action:api.video-channel.deleted', { videoChannel: videoChannelInstance, req, res })

    auditLogger.delete(getAuditIdFromRes(res), new VideoChannelAuditView(videoChannelInstance.toFormattedJSON()))
    logger.info('Video channel %s deleted.', videoChannelInstance.Actor.url)
  })

  return res.type('json').status(HttpStatusCode.NO_CONTENT_204).end()
}

async function getVideoChannel (req: express.Request, res: express.Response) {
  const id = res.locals.videoChannel.id
  const videoChannel = await Hooks.wrapObject(res.locals.videoChannel, 'filter:api.video-channel.get.result', { id })

  if (videoChannel.isOutdated()) {
    JobQueue.Instance.createJobAsync({ type: 'activitypub-refresher', payload: { type: 'actor', url: videoChannel.Actor.url } })
  }

  return res.json(videoChannel.toFormattedJSON())
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

async function listVideoChannelPlaylists (req: express.Request, res: express.Response) {
  const serverActor = await getServerActor()
  const { count, playlistType, sort, start, search } = req.query as VideoPlaylistsListQuery
  const videoChannel = res.locals.videoChannel

  // Allow users to see their private/unlisted video playlists
  const listMyPlaylists = !!res.locals.oauth && res.locals.oauth.token.User.Account.id === videoChannel.accountId

  const resultList = await VideoPlaylistModel.listForApi({
    followerActorId: isUserAbleToSearchRemoteURI(res)
      ? null
      : serverActor.id,

    videoChannelId: videoChannel.id,
    listMyPlaylists,

    start,
    count,
    sort,
    search,
    type: playlistType
  })

  return res.json(getFormattedObjects(resultList.data, resultList.total))
}

async function reorderPlaylistsInChannel (req: express.Request, res: express.Response) {
  const body: VideoPlaylistReorder = req.body
  const videoChannel = res.locals.videoChannel

  const start: number = body.startPosition
  const insertAfter: number = body.insertAfterPosition
  const reorderLength: number = body.reorderLength || 1

  if (start === insertAfter) {
    return res.status(HttpStatusCode.NO_CONTENT_204).end()
  }

  await sequelizeTypescript.transaction(async t => {
    await reorderPlaylistOrElementsPosition({
      model: VideoPlaylistModel,
      instance: videoChannel,
      start,
      insertAfter,
      reorderLength,
      transaction: t
    })

    videoChannel.changed('updatedAt', true)
    await videoChannel.save({ transaction: t })

    await sendUpdateActor(videoChannel, t)
    await sendPlaylistPositionUpdateOfChannel(videoChannel.id, t)
  })

  logger.info(
    `Reordered playlist of channel ${videoChannel.name} (inserted after position ${insertAfter} elements ${start} - ${
      start + reorderLength - 1
    }).`
  )

  return res.sendStatus(HttpStatusCode.NO_CONTENT_204)
}

// ---------------------------------------------------------------------------

async function listVideoChannelVideos (req: express.Request, res: express.Response) {
  const serverActor = await getServerActor()

  const videoChannelInstance = res.locals.videoChannel

  const displayOnlyForFollower = isUserAbleToSearchRemoteURI(res)
    ? null
    : {
      actorId: serverActor.id,
      orLocalVideos: true
    }

  const countVideos = getCountVideos(req)
  const query = pickCommonVideoQuery(req.query)

  const apiOptions = await Hooks.wrapObject({
    ...query,
    ...buildNSFWFilters({ req, res }),

    displayOnlyForFollower,
    videoChannelId: videoChannelInstance.id,
    user: res.locals.oauth ? res.locals.oauth.token.User : undefined,
    countVideos
  }, 'filter:api.video-channels.videos.list.params')

  const resultList = await Hooks.wrapPromiseFun(
    VideoModel.listForApi.bind(VideoModel),
    apiOptions,
    'filter:api.video-channels.videos.list.result'
  )

  return res.json(getFormattedObjects(resultList.data, resultList.total, guessAdditionalAttributesFromQuery(query)))
}

async function listVideoChannelFollowers (req: express.Request, res: express.Response) {
  const channel = res.locals.videoChannel

  const resultList = await ActorFollowModel.listFollowersForApi({
    actorIds: [ channel.actorId ],
    start: req.query.start,
    count: req.query.count,
    sort: req.query.sort,
    search: req.query.search,
    state: 'accepted'
  })

  return res.json(getFormattedObjects(resultList.data, resultList.total))
}

async function importVideosInChannel (req: express.Request, res: express.Response) {
  const { externalChannelUrl } = req.body as VideosImportInChannelCreate

  await JobQueue.Instance.createJob({
    type: 'video-channel-import',
    payload: {
      externalChannelUrl,
      videoChannelId: res.locals.videoChannel.id,
      partOfChannelSyncId: res.locals.videoChannelSync?.id
    }
  })

  logger.info('Video import job for channel "%s" with url "%s" created.', res.locals.videoChannel.name, externalChannelUrl)

  return res.type('json').status(HttpStatusCode.NO_CONTENT_204).end()
}
