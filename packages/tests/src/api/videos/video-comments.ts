/* eslint-disable @typescript-eslint/no-unused-expressions,@typescript-eslint/require-await */

import {
  CommentsCommand,
  PeerTubeServer,
  cleanupTests,
  createSingleServer,
  doubleFollow,
  setAccessTokensToServers,
  setDefaultAccountAvatar,
  setDefaultChannelAvatar,
  waitJobs
} from '@peertube/peertube-server-commands'
import { dateIsValid, testImage } from '@tests/shared/checks.js'
import { expect } from 'chai'
import { VideoCreateResult } from '../../../../models/src/videos/video-create-result.model.js'

describe('Test video comments', function () {
  let server: PeerTubeServer
  let videoId: number
  let videoUUID: string
  let threadId: number
  let replyToDeleteId: number

  let userAccessTokenServer1: string

  let command: CommentsCommand

  before(async function () {
    this.timeout(120000)

    server = await createSingleServer(1)

    await setAccessTokensToServers([ server ])

    const { id, uuid } = await server.videos.upload()
    videoUUID = uuid
    videoId = id

    await setDefaultChannelAvatar(server)
    await setDefaultAccountAvatar(server)

    userAccessTokenServer1 = await server.users.generateUserAndToken('user1')
    await setDefaultChannelAvatar(server, 'user1_channel')
    await setDefaultAccountAvatar(server, userAccessTokenServer1)

    command = server.comments
  })

  describe('User comments', function () {
    it('Should not have threads on this video', async function () {
      const body = await command.listThreads({ videoId: videoUUID })

      expect(body.total).to.equal(0)
      expect(body.totalNotDeletedComments).to.equal(0)
      expect(body.data).to.be.an('array')
      expect(body.data).to.have.lengthOf(0)
    })

    it('Should create a thread in this video', async function () {
      const text = 'my super first comment'

      const comment = await command.createThread({ videoId: videoUUID, text })

      expect(comment.inReplyToCommentId).to.be.null
      expect(comment.text).equal('my super first comment')
      expect(comment.videoId).to.equal(videoId)
      expect(comment.id).to.equal(comment.threadId)
      expect(comment.account.name).to.equal('root')
      expect(comment.account.host).to.equal(server.host)
      expect(comment.account.url).to.equal(server.url + '/accounts/root')
      expect(comment.totalReplies).to.equal(0)
      expect(comment.totalRepliesFromVideoAuthor).to.equal(0)
      expect(dateIsValid(comment.createdAt as string)).to.be.true
      expect(dateIsValid(comment.updatedAt as string)).to.be.true
    })

    it('Should list threads of this video', async function () {
      const body = await command.listThreads({ videoId: videoUUID })

      expect(body.total).to.equal(1)
      expect(body.totalNotDeletedComments).to.equal(1)
      expect(body.data).to.be.an('array')
      expect(body.data).to.have.lengthOf(1)

      const comment = body.data[0]
      expect(comment.inReplyToCommentId).to.be.null
      expect(comment.text).equal('my super first comment')
      expect(comment.videoId).to.equal(videoId)
      expect(comment.id).to.equal(comment.threadId)
      expect(comment.account.name).to.equal('root')
      expect(comment.account.host).to.equal(server.host)

      for (const avatar of comment.account.avatars) {
        await testImage({ url: server.url + avatar.path, name: `avatar-resized-${avatar.width}x${avatar.width}.png` })
      }

      expect(comment.totalReplies).to.equal(0)
      expect(comment.totalRepliesFromVideoAuthor).to.equal(0)
      expect(dateIsValid(comment.createdAt as string)).to.be.true
      expect(dateIsValid(comment.updatedAt as string)).to.be.true

      threadId = comment.threadId
    })

    it('Should get all the thread created', async function () {
      const body = await command.getThread({ videoId: videoUUID, threadId })

      const rootComment = body.comment
      expect(rootComment.inReplyToCommentId).to.be.null
      expect(rootComment.text).equal('my super first comment')
      expect(rootComment.videoId).to.equal(videoId)
      expect(dateIsValid(rootComment.createdAt as string)).to.be.true
      expect(dateIsValid(rootComment.updatedAt as string)).to.be.true
    })

    it('Should create multiple replies in this thread', async function () {
      const text1 = 'my super answer to thread 1'
      const created = await command.addReply({ videoId, toCommentId: threadId, text: text1 })
      const childCommentId = created.id

      const text2 = 'my super answer to answer of thread 1'
      await command.addReply({ videoId, toCommentId: childCommentId, text: text2 })

      const text3 = 'my second answer to thread 1'
      await command.addReply({ videoId, toCommentId: threadId, text: text3 })
    })

    it('Should get correctly the replies', async function () {
      const tree = await command.getThread({ videoId: videoUUID, threadId })

      expect(tree.comment.text).equal('my super first comment')
      expect(tree.children).to.have.lengthOf(2)

      const firstChild = tree.children[0]
      expect(firstChild.comment.text).to.equal('my super answer to thread 1')
      expect(firstChild.children).to.have.lengthOf(1)

      const childOfFirstChild = firstChild.children[0]
      expect(childOfFirstChild.comment.text).to.equal('my super answer to answer of thread 1')
      expect(childOfFirstChild.children).to.have.lengthOf(0)

      const secondChild = tree.children[1]
      expect(secondChild.comment.text).to.equal('my second answer to thread 1')
      expect(secondChild.children).to.have.lengthOf(0)

      replyToDeleteId = secondChild.comment.id
    })

    it('Should create other threads', async function () {
      const text1 = 'super thread 2'
      await command.createThread({ videoId: videoUUID, text: text1 })

      const text2 = 'super thread 3'
      await command.createThread({ videoId: videoUUID, text: text2 })
    })

    it('Should list the threads', async function () {
      const body = await command.listThreads({ videoId: videoUUID, sort: 'createdAt' })

      expect(body.total).to.equal(3)
      expect(body.totalNotDeletedComments).to.equal(6)
      expect(body.data).to.be.an('array')
      expect(body.data).to.have.lengthOf(3)

      expect(body.data[0].text).to.equal('my super first comment')
      expect(body.data[0].totalReplies).to.equal(3)
      expect(body.data[1].text).to.equal('super thread 2')
      expect(body.data[1].totalReplies).to.equal(0)
      expect(body.data[2].text).to.equal('super thread 3')
      expect(body.data[2].totalReplies).to.equal(0)
    })

    it('Should list the and sort them by total replies', async function () {
      const body = await command.listThreads({ videoId: videoUUID, sort: 'totalReplies' })

      expect(body.data[2].text).to.equal('my super first comment')
      expect(body.data[2].totalReplies).to.equal(3)
    })

    it('Should delete a reply', async function () {
      await command.delete({ videoId, commentId: replyToDeleteId })

      {
        const body = await command.listThreads({ videoId: videoUUID, sort: 'createdAt' })

        expect(body.total).to.equal(3)
        expect(body.totalNotDeletedComments).to.equal(5)
      }

      {
        const tree = await command.getThread({ videoId: videoUUID, threadId })

        expect(tree.comment.text).equal('my super first comment')
        expect(tree.children).to.have.lengthOf(2)

        const firstChild = tree.children[0]
        expect(firstChild.comment.text).to.equal('my super answer to thread 1')
        expect(firstChild.children).to.have.lengthOf(1)

        const childOfFirstChild = firstChild.children[0]
        expect(childOfFirstChild.comment.text).to.equal('my super answer to answer of thread 1')
        expect(childOfFirstChild.children).to.have.lengthOf(0)

        const deletedChildOfFirstChild = tree.children[1]
        expect(deletedChildOfFirstChild.comment.text).to.equal('')
        expect(deletedChildOfFirstChild.comment.isDeleted).to.be.true
        expect(deletedChildOfFirstChild.comment.deletedAt).to.not.be.null
        expect(deletedChildOfFirstChild.comment.account).to.be.null
        expect(deletedChildOfFirstChild.children).to.have.lengthOf(0)
      }
    })

    it('Should delete a complete thread', async function () {
      await command.delete({ videoId, commentId: threadId })

      const body = await command.listThreads({ videoId: videoUUID, sort: 'createdAt' })
      expect(body.total).to.equal(3)
      expect(body.data).to.be.an('array')
      expect(body.data).to.have.lengthOf(3)

      expect(body.data[0].text).to.equal('')
      expect(body.data[0].isDeleted).to.be.true
      expect(body.data[0].deletedAt).to.not.be.null
      expect(body.data[0].account).to.be.null
      expect(body.data[0].totalReplies).to.equal(2)
      expect(body.data[1].text).to.equal('super thread 2')
      expect(body.data[1].totalReplies).to.equal(0)
      expect(body.data[2].text).to.equal('super thread 3')
      expect(body.data[2].totalReplies).to.equal(0)
    })

    it('Should count replies from the video author correctly', async function () {
      await command.createThread({ videoId: videoUUID, text: 'my super first comment' })

      const { data } = await command.listThreads({ videoId: videoUUID })
      const threadId2 = data[0].threadId

      const text2 = 'a first answer to thread 4 by a third party'
      await command.addReply({ token: userAccessTokenServer1, videoId, toCommentId: threadId2, text: text2 })

      const text3 = 'my second answer to thread 4'
      await command.addReply({ videoId, toCommentId: threadId2, token: userAccessTokenServer1, text: text3 })
      await command.addReplyToLastReply({ text: 'third answer' })

      const tree = await command.getThread({ videoId: videoUUID, threadId: threadId2 })
      expect(tree.comment.totalRepliesFromVideoAuthor).to.equal(1)
      expect(tree.comment.totalReplies).to.equal(3)

      const reply1 = tree.children.find(c => c.comment.text === text2)
      expect(reply1.comment.totalReplies).to.equal(0)
      expect(reply1.comment.totalRepliesFromVideoAuthor).to.equal(0)

      const reply2 = tree.children.find(c => c.comment.text === text3)
      expect(reply2.comment.totalReplies).to.equal(1)
      expect(reply2.comment.totalRepliesFromVideoAuthor).to.equal(1)
    })
  })

  describe('Listing comments on my videos and in admin', function () {
    const listFunctions = () => [
      command.listForAdmin.bind(command),
      command.listCommentsOnMyVideos.bind(command)
    ]

    it('Should list comments', async function () {
      for (const fn of listFunctions()) {
        const { data, total } = await fn({ start: 0, count: 1 })

        expect(total).to.equal(8)
        expect(data).to.have.lengthOf(1)
        expect(data[0].text).to.equal('third answer')
        expect(data[0].account.name).to.equal('root')
        expect(data[0].account.displayName).to.equal('root')
        expect(data[0].account.avatars).to.have.lengthOf(4)
      }

      for (const fn of listFunctions()) {
        const { data, total } = await fn({ start: 1, count: 2 })

        expect(total).to.equal(8)
        expect(data).to.have.lengthOf(2)

        expect(data[0].account.avatars).to.have.lengthOf(4)
        expect(data[1].account.avatars).to.have.lengthOf(4)
      }

      const { data, total } = await command.listCommentsOnMyVideos({ token: userAccessTokenServer1 })
      expect(data).to.have.lengthOf(0)
      expect(total).to.equal(0)
    })

    it('Should filter instance comments by isLocal', async function () {
      const { total, data } = await command.listForAdmin({ isLocal: false })

      expect(data).to.have.lengthOf(0)
      expect(total).to.equal(0)
    })

    it('Should filter instance comments by onLocalVideo', async function () {
      {
        const { total, data } = await command.listForAdmin({ onLocalVideo: false })

        expect(data).to.have.lengthOf(0)
        expect(total).to.equal(0)
      }

      {
        const { total, data } = await command.listForAdmin({ onLocalVideo: true })

        expect(data).to.not.have.lengthOf(0)
        expect(total).to.not.equal(0)
      }
    })

    it('Should search comments by account', async function () {
      for (const fn of listFunctions()) {
        const { total, data } = await fn({ searchAccount: 'user' })

        expect(data).to.have.lengthOf(2)
        expect(total).to.equal(2)

        expect(data[0].text).to.equal('my second answer to thread 4')
        expect(data[1].text).to.equal('a first answer to thread 4 by a third party')
      }

      const { data, total } = await command.listCommentsOnMyVideos({ token: userAccessTokenServer1, searchAccount: 'user' })
      expect(data).to.have.lengthOf(0)
      expect(total).to.equal(0)
    })

    it('Should search comments by video', async function () {
      for (const fn of listFunctions()) {
        const { total, data } = await fn({ searchVideo: 'video' })

        expect(data).to.have.lengthOf(8)
        expect(total).to.equal(8)
      }

      for (const fn of listFunctions()) {
        const { total, data } = await fn({ searchVideo: 'hello' })

        expect(data).to.have.lengthOf(0)
        expect(total).to.equal(0)
      }

      const { data, total } = await command.listCommentsOnMyVideos({ token: userAccessTokenServer1, searchVideo: 'video' })
      expect(data).to.have.lengthOf(0)
      expect(total).to.equal(0)
    })

    it('Should search comments', async function () {
      for (const fn of listFunctions()) {
        const { total, data } = await fn({ search: 'super thread 3' })

        expect(total).to.equal(1)

        expect(data).to.have.lengthOf(1)
        expect(data[0].text).to.equal('super thread 3')
      }

      const { data, total } = await command.listCommentsOnMyVideos({ token: userAccessTokenServer1, search: 'super thread 3' })
      expect(data).to.have.lengthOf(0)
      expect(total).to.equal(0)
    })

    it('Should filter by videoId', async function () {
      const { uuid: otherVideo } = await server.videos.upload()

      {
        const { total, data } = await command.listForAdmin({ videoId: videoUUID })
        expect(data).to.have.lengthOf(8)
        expect(total).to.equal(8)
      }

      {
        const { total, data } = await command.listForAdmin({ videoId: otherVideo })
        expect(data).to.have.lengthOf(0)
        expect(total).to.equal(0)
      }
    })

    it('Should filter by channelId', async function () {
      const { id: videoChannelId } = await server.channels.create({ attributes: { name: 'other_channel' } })
      const { videoChannels: rootChannels } = await server.users.getMyInfo()

      await server.videos.upload({ attributes: { channelId: videoChannelId } })

      {
        const { total, data } = await command.listForAdmin({ videoChannelId: rootChannels[0].id })
        expect(data).to.have.lengthOf(8)
        expect(total).to.equal(8)
      }

      {
        const { total, data } = await command.listForAdmin({ videoChannelId })
        expect(data).to.have.lengthOf(0)
        expect(total).to.equal(0)
      }
    })

    // Auto tags filter is checked auto tags test file
  })

  describe('Video comment count', function () {
    let testVideoUUID: string

    before(async function () {
      const { uuid } = await server.videos.upload()
      testVideoUUID = uuid
    })

    it('Should start with 0 comments', async function () {
      const video = await server.videos.get({ id: testVideoUUID })
      expect(video.commentsEnabled).to.be.true
      expect(video.comments).to.equal(0)
    })

    it('Should increment comment count when adding comment', async function () {
      await command.createThread({ videoId: testVideoUUID, text: 'test comment' })

      const video = await server.videos.get({ id: testVideoUUID })
      expect(video.comments).to.equal(1)
    })

    it('Should decrement count when deleting comment', async function () {
      const { data } = await command.listThreads({ videoId: testVideoUUID })
      const commentToDelete = data[0]

      await command.delete({ videoId: testVideoUUID, commentId: commentToDelete.id })

      const video = await server.videos.get({ id: testVideoUUID })
      expect(video.comments).to.equal(0)
    })
  })

  describe('Disabling remote comments', function () {
    let server2: PeerTubeServer
    let server3: PeerTubeServer

    let video1: VideoCreateResult
    let video2: VideoCreateResult

    before(async function () {
      this.timeout(120000)

      server2 = await createSingleServer(2)
      server3 = await createSingleServer(3)

      await setAccessTokensToServers([ server2, server3 ])
      await doubleFollow(server, server2)
    })

    it('Should federate comments', async function () {
      video1 = await server.videos.quickUpload({ name: 'video on server 1' })
      video2 = await server2.videos.quickUpload({ name: 'video on server 2' })

      await server2.comments.createThread({ videoId: video1.uuid, text: 'comment on server 2' })
      await server2.comments.createThread({ videoId: video2.uuid, text: 'comment on server 2' })

      await waitJobs([ server, server2 ])

      for (const s of [ server, server2 ]) {
        const threads = await s.comments.listThreads({ videoId: video1.uuid })
        expect(threads.total).to.equal(1)
        expect(threads.data[0].text).to.equal('comment on server 2')

        const threads2 = await s.comments.listThreads({ videoId: video2.uuid })
        expect(threads2.total).to.equal(1)
        expect(threads2.data[0].text).to.equal('comment on server 2')
      }
    })

    it('Should not accept remote comments anymore', async function () {
      await server.config.updateExistingConfig({
        newConfig: {
          videoComments: {
            acceptRemoteComments: false
          }
        }
      })

      await server2.comments.createThread({ videoId: video1.uuid, text: 'comment on server 2 - 2' })
      await server2.comments.createThread({ videoId: video2.uuid, text: 'comment on server 2 - 2' })

      await waitJobs([ server, server2 ])

      // Server 1
      {
        const threads = await server.comments.listThreads({ videoId: video1.uuid })
        expect(threads.total).to.equal(1)

        const threads2 = await server.comments.listThreads({ videoId: video2.uuid })
        expect(threads2.total).to.equal(1)
      }

      // Server 2
      {
        const threads = await server2.comments.listThreads({ videoId: video1.uuid })
        expect(threads.total).to.equal(2)

        const threads2 = await server2.comments.listThreads({ videoId: video2.uuid })
        expect(threads2.total).to.equal(2)
      }
    })

    it('Should not fetch remote comments on new follow', async function () {
      const video3 = await server3.videos.quickUpload({ name: 'video on server 2' })
      await server3.comments.createThread({ videoId: video3.uuid, text: 'comment on server 3' })

      await waitJobs([ server3 ])
      await doubleFollow(server, server3)

      {
        const threads = await server3.comments.listThreads({ videoId: video3.uuid })
        expect(threads.total).to.equal(1)
      }

      {
        const threads = await server.comments.listThreads({ videoId: video3.uuid })
        expect(threads.total).to.equal(0)
      }
    })
  })

  after(async function () {
    await cleanupTests([ server ])
  })
})
