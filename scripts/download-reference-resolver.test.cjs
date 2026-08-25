'use strict'

const assert = require('node:assert/strict')
const { DIRECT_LOOKUP_LIMIT, resolveDownloadItems } = require('../download-reference-resolver')

function videoMessage (chatId, messageId, fileId, size = 1000) {
  return {
    id: messageId,
    chat_id: chatId,
    date: 1,
    content: {
      _: 'messageVideo',
      video: {
        file_name: `video_${messageId}.mp4`,
        mime_type: 'video/mp4',
        video: { id: fileId, size, expected_size: size }
      }
    }
  }
}

async function smallSelectionUsesDurableMessageIdentity () {
  const chatId = -1001
  const messages = new Map([
    ['11', videoMessage(chatId, 11, 90011, 1111)],
    ['12', videoMessage(chatId, 12, 90012, 2222)]
  ])
  let getMessageCalls = 0
  const client = {
    async invoke (query) {
      if (query._ !== 'getMessage') throw new Error(`unexpected ${query._}`)
      getMessageCalls++
      return messages.get(String(query.message_id)) || null
    }
  }
  const report = await resolveDownloadItems({
    client,
    chatId,
    items: [
      { messageId: 11, fileId: 1, fileName: 'a.mp4', fileSize: 1 },
      { messageId: 12, fileId: 2, fileName: 'b.mp4', fileSize: 2 }
    ]
  })
  assert.equal(report.items.length, 2)
  assert.equal(report.refreshed, 2)
  assert.deepEqual(report.items.map(row => row.fileId), [90011, 90012])
  assert.deepEqual(report.items.map(row => row.fileSize), [1111, 2222])
  assert.equal(getMessageCalls, 2)
  assert.equal(report.source, 'messages')
}

async function largeSelectionWalksHistoryOnce () {
  const chatId = -2002
  const total = DIRECT_LOOKUP_LIMIT + 204
  const messages = []
  for (let id = total; id >= 1; id--) messages.push(videoMessage(chatId, id, 100000 + id, 1000 + id))
  const items = messages.map(message => ({
    messageId: message.id,
    fileId: message.id,
    fileName: `video_${message.id}.mp4`,
    fileSize: 1
  }))

  let historyCalls = 0
  let getMessageCalls = 0
  const client = {
    async invoke (query) {
      if (query._ === 'getMessage') {
        getMessageCalls++
        return null
      }
      assert.equal(query._, 'getChatHistory')
      historyCalls++
      let start = 0
      if (query.from_message_id) {
        const index = messages.findIndex(message => String(message.id) === String(query.from_message_id))
        start = index < 0 ? messages.length : index + 1
      }
      return { messages: messages.slice(start, start + 100) }
    }
  }

  const report = await resolveDownloadItems({ client, chatId, items })
  assert.equal(report.items.length, total)
  assert.equal(report.missing.length, 0)
  assert.equal(report.refreshed, total)
  assert.equal(getMessageCalls, 0, 'large selection must not fan out one getMessage RPC per row')
  assert.ok(historyCalls <= Math.ceil(total / 100) + 1, `unexpected history calls: ${historyCalls}`)
  assert.equal(report.items[0].fileId, 100000 + messages[0].id)
  assert.equal(report.source, 'history')
}

async function twentyThousandSelectionStaysLinear () {
  const chatId = -22002
  const total = 20000
  const messages = Array.from({ length: total }, (_, index) => {
    const id = total - index
    return videoMessage(chatId, id, 500000 + id, 1000000 + id)
  })
  const position = new Map(messages.map((message, index) => [String(message.id), index]))
  const items = messages.map(message => ({
    messageId: message.id,
    fileId: message.id,
    fileName: `video_${message.id}.mp4`,
    fileSize: 1
  }))
  let historyCalls = 0
  let getMessageCalls = 0
  const client = {
    async invoke (query) {
      if (query._ === 'getMessage') {
        getMessageCalls++
        return null
      }
      assert.equal(query._, 'getChatHistory')
      historyCalls++
      const start = query.from_message_id
        ? ((position.get(String(query.from_message_id)) ?? messages.length) + 1)
        : 0
      return { messages: messages.slice(start, start + 100) }
    }
  }

  const started = Date.now()
  const report = await resolveDownloadItems({ client, chatId, items })
  const elapsed = Date.now() - started
  assert.equal(report.items.length, total)
  assert.equal(report.refreshed, total)
  assert.equal(report.missing.length, 0)
  assert.equal(getMessageCalls, 0)
  assert.ok(historyCalls <= 201, `20k refresh used ${historyCalls} history calls`)
  // This is a local in-memory fake; the bound catches accidental O(n^2) post-passes
  // without pretending to benchmark Telegram/network latency in CI.
  assert.ok(elapsed < 5000, `20k in-memory refresh took ${elapsed}ms`)
}

async function unusableHistoryRowsAreReported () {
  const chatId = -23003
  const totalVideos = DIRECT_LOOKUP_LIMIT + 4
  const unusableId = totalVideos + 1
  const messages = [
    { id: unusableId, chat_id: chatId, content: { _: 'messageText', text: { text: 'media was removed' } } },
    ...Array.from({ length: totalVideos }, (_, index) => {
      const id = totalVideos - index
      return videoMessage(chatId, id, 600000 + id, 2000 + id)
    })
  ]
  const position = new Map(messages.map((message, index) => [String(message.id), index]))
  const items = messages.map(message => ({
    messageId: message.id,
    fileId: message.id,
    fileName: `old_${message.id}.mp4`,
    fileSize: 1
  }))
  const client = {
    async invoke (query) {
      if (query._ === 'getMessage') {
        return messages.find(message => String(message.id) === String(query.message_id)) || null
      }
      assert.equal(query._, 'getChatHistory')
      const start = query.from_message_id
        ? ((position.get(String(query.from_message_id)) ?? messages.length) + 1)
        : 0
      return { messages: messages.slice(start, start + 100) }
    }
  }
  const report = await resolveDownloadItems({ client, chatId, items })
  assert.equal(report.items.length, totalVideos)
  assert.deepEqual(report.missing, [unusableId])
}

async function deletedRowsAreNotQueued () {
  const chatId = -3003
  const message = videoMessage(chatId, 21, 90021, 2121)
  const client = {
    async invoke (query) {
      if (query._ === 'getMessage') return String(query.message_id) === '21' ? message : null
      throw new Error(`unexpected ${query._}`)
    }
  }
  const report = await resolveDownloadItems({
    client,
    chatId,
    items: [
      { messageId: 21, fileId: 1, fileName: 'live.mp4', fileSize: 1 },
      { messageId: 22, fileId: 2, fileName: 'deleted.mp4', fileSize: 1 },
      // Duplicate selection of the same Telegram message is collapsed before queueing.
      { messageId: 21, fileId: 1, fileName: 'live.mp4', fileSize: 1 }
    ]
  })
  assert.equal(report.selected, 2)
  assert.equal(report.items.length, 1)
  assert.deepEqual(report.missing, [22])
  assert.equal(report.items[0].messageId, 21)
}

Promise.resolve()
  .then(smallSelectionUsesDurableMessageIdentity)
  .then(largeSelectionWalksHistoryOnce)
  .then(twentyThousandSelectionStaysLinear)
  .then(unusableHistoryRowsAreReported)
  .then(deletedRowsAreNotQueued)
  .then(() => console.log('download reference resolver checks passed'))
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
