'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const { createBulkUploadHandler } = require('../bulk-upload-server')
const { ScalableUploadLedger } = require('../bulk-upload-ledger')

class FakeClient extends EventEmitter {
  constructor (options = {}) {
    super()
    this.owner = options.owner !== false
    this.flood = !!options.flood
    this.sendCount = 0
    this.messages = new Map()
  }

  async invoke (query) {
    switch (query._) {
      case 'getAuthorizationState':
        return { _: 'authorizationStateReady' }
      case 'getChat':
        if (query.message_id != null) return this.messages.get(String(query.message_id)) || null
        return { id: query.chat_id, type: { _: 'chatTypeSupergroup', supergroup_id: 42, is_channel: true } }
      case 'getSupergroup':
        return { id: query.supergroup_id, is_channel: true, status: { _: this.owner ? 'chatMemberStatusCreator' : 'chatMemberStatusMember' } }
      case 'sendMessage': {
        if (this.flood) throw new Error('FLOOD_WAIT_2')
        this.sendCount++
        const pendingId = -this.sendCount
        const file = query.input_message_content && query.input_message_content.document
        const filePath = file && file.path
        const stat = filePath ? fs.statSync(filePath) : { size: 0 }
        const pending = {
          id: pendingId,
          chat_id: query.chat_id,
          date: Math.floor(Date.now() / 1000),
          sending_state: { _: 'messageSendingStatePending' }
        }
        const final = {
          id: 1000 + this.sendCount,
          chat_id: query.chat_id,
          date: Math.floor(Date.now() / 1000),
          content: {
            _: 'messageDocument',
            document: {
              file_name: filePath ? path.basename(filePath) : 'file',
              document: { size: stat.size, expected_size: stat.size }
            }
          }
        }
        this.messages.set(String(final.id), final)
        setTimeout(() => this.emit('update', {
          _: 'updateMessageSendSucceeded',
          old_message_id: pendingId,
          message: final
        }), 5)
        return pending
      }
      case 'searchChatMessages':
        return { messages: [...this.messages.values()].reverse().slice(0, query.limit || 50), total_count: this.messages.size }
      case 'getMessage':
        return this.messages.get(String(query.message_id)) || null
      case 'deleteMessages':
        return { _: 'ok' }
      default:
        throw new Error(`Unexpected TDLib call ${query._}`)
    }
  }
}

function fakeResponse () {
  const res = new EventEmitter()
  res.statusCode = 200
  res.headers = {}
  res.writableEnded = false
  res.destroyed = false
  res.status = code => { res.statusCode = code; return res }
  res.setHeader = (name, value) => { res.headers[String(name).toLowerCase()] = String(value) }
  res.json = payload => {
    res.body = payload
    res.writableEnded = true
    if (res._resolve) res._resolve(res)
    return res
  }
  res.done = new Promise(resolve => { res._resolve = resolve })
  return res
}

async function runRequest (handler, options = {}) {
  const body = Buffer.from(options.body == null ? 'hello upload' : options.body)
  const req = new PassThrough()
  req.params = { chatId: String(options.chatId == null ? 777 : options.chatId) }
  req.headers = {
    'x-upload-id': options.uploadId || 'job-1',
    'x-file-name': encodeURIComponent(options.fileName || 'alpha.txt'),
    'x-mime-type': encodeURIComponent(options.mimeType || 'text/plain'),
    'x-upload-mode': options.mode || 'document',
    'content-length': String(body.length)
  }
  if (options.caption) req.headers['x-caption'] = encodeURIComponent(options.caption)
  const res = fakeResponse()
  const task = Promise.resolve(handler(req, res))
  req.end(body)
  await Promise.race([
    res.done,
    task.then(() => res),
    new Promise((_, reject) => setTimeout(() => reject(new Error('handler timed out')), 3000))
  ])
  await task
  return res
}

async function withHarness (client, fn) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'filegram-bulk-upload-'))
  try {
    const ledger = new ScalableUploadLedger(root)
    const handler = createBulkUploadHandler({ root, getClient: () => client, ledger, active: new Set() })
    await fn({ root, ledger, handler })
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
}

async function sendsAndPersistsFinalMessage () {
  const client = new FakeClient()
  await withHarness(client, async ({ ledger, handler }) => {
    const res = await runRequest(handler, { uploadId: 'job-success', fileName: 'alpha.txt', body: 'alpha' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body.ok, true)
    assert.equal(res.body.messageId, 1001)
    assert.equal(client.sendCount, 1)
    const record = await ledger.get('job-success')
    assert.equal(record.status, 'completed')
    assert.equal(record.messageId, 1001)
    assert.equal(record.fileName, 'alpha.txt')
    assert.equal(record.size, 5)
  })
}

async function retryIsIdempotentAfterResponseLoss () {
  const client = new FakeClient()
  await withHarness(client, async ({ handler }) => {
    const first = await runRequest(handler, { uploadId: 'job-idempotent', fileName: 'same.bin', body: 'payload' })
    assert.equal(first.statusCode, 200)
    const second = await runRequest(handler, { uploadId: 'job-idempotent', fileName: 'same.bin', body: 'payload' })
    assert.equal(second.statusCode, 200)
    assert.equal(second.body.recovered, true)
    assert.equal(second.body.messageId, first.body.messageId)
    assert.equal(client.sendCount, 1, 'same job id must never create a second Telegram message')
  })
}

async function reusedIdWithDifferentFileIsRejected () {
  const client = new FakeClient()
  await withHarness(client, async ({ handler }) => {
    const first = await runRequest(handler, { uploadId: 'job-bound', fileName: 'one.txt', body: '111' })
    assert.equal(first.statusCode, 200)
    const second = await runRequest(handler, { uploadId: 'job-bound', fileName: 'two.txt', body: '222' })
    assert.equal(second.statusCode, 409)
    assert.match(second.body.error, /different file or destination/i)
    assert.equal(client.sendCount, 1)
  })
}

async function nonOwnerCannotUpload () {
  const client = new FakeClient({ owner: false })
  await withHarness(client, async ({ handler }) => {
    const res = await runRequest(handler, { uploadId: 'job-denied' })
    assert.equal(res.statusCode, 403)
    assert.match(res.body.error, /owned/i)
    assert.equal(client.sendCount, 0)
  })
}

async function floodWaitReturnsRetryAfter () {
  const client = new FakeClient({ flood: true })
  await withHarness(client, async ({ handler }) => {
    const res = await runRequest(handler, { uploadId: 'job-flood' })
    assert.equal(res.statusCode, 429)
    assert.equal(res.headers['retry-after'], '2')
    assert.match(res.body.error, /FLOOD_WAIT_2/)
  })
}

async function completedLedgerSurvivesNewProcessInstance () {
  const client = new FakeClient()
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'filegram-bulk-restart-'))
  try {
    const firstLedger = new ScalableUploadLedger(root)
    const firstHandler = createBulkUploadHandler({ root, getClient: () => client, ledger: firstLedger, active: new Set() })
    const first = await runRequest(firstHandler, { uploadId: 'restart-ledger', fileName: 'persist.txt', body: 'persist' })
    assert.equal(first.statusCode, 200)
    assert.equal(client.sendCount, 1)
    await firstLedger.flush()

    const secondLedger = new ScalableUploadLedger(root)
    const secondHandler = createBulkUploadHandler({ root, getClient: () => client, ledger: secondLedger, active: new Set() })
    const second = await runRequest(secondHandler, { uploadId: 'restart-ledger', fileName: 'persist.txt', body: 'persist' })
    assert.equal(second.statusCode, 200)
    assert.equal(second.body.recovered, true)
    assert.equal(second.body.messageId, first.body.messageId)
    assert.equal(client.sendCount, 1, 'restart recovery must not send the Telegram message twice')
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
}

;(async () => {
  await sendsAndPersistsFinalMessage()
  await retryIsIdempotentAfterResponseLoss()
  await reusedIdWithDifferentFileIsRejected()
  await nonOwnerCannotUpload()
  await floodWaitReturnsRetryAfter()
  await completedLedgerSurvivesNewProcessInstance()
  console.log('bulk upload server checks passed')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
