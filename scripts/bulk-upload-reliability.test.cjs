'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

require('../bulk-upload-reliability-preload')
const { wrapRequestLifetime } = global.__fileGramBulkUploadReliability || {}
assert.equal(typeof wrapRequestLifetime, 'function')

function fakeRequest (chunks) {
  const req = new EventEmitter()
  req[Symbol.asyncIterator] = async function * () {
    for (const chunk of chunks) yield Buffer.from(chunk)
  }
  return req
}

async function testDisconnectBeforeBodyEofStillAborts () {
  const req = fakeRequest(['abc'])
  const res = new EventEmitter()
  let aborted = 0
  const wrapped = wrapRequestLifetime(async (innerReq) => {
    innerReq.once('aborted', () => { aborted++ })
    innerReq.emit('aborted')
  })
  await wrapped(req, res)
  assert.equal(aborted, 1, 'mid-body browser disconnect must still abort the upload')
}

async function testDisconnectAfterBodyEofDoesNotAbortTelegramPhase () {
  const req = fakeRequest(['abc', 'def'])
  const res = new EventEmitter()
  let aborted = 0
  let closed = 0
  let bytes = 0
  const originalIterator = req[Symbol.asyncIterator]
  const originalReqOnce = req.once
  const originalResOnce = res.once

  const wrapped = wrapRequestLifetime(async (innerReq, innerRes) => {
    innerReq.once('aborted', () => { aborted++ })
    innerRes.once('close', () => { closed++ })
    for await (const chunk of innerReq) bytes += chunk.length

    // This models refreshing the tab after FileGram has received every byte but
    // while TDLib is still sending the staged file to Telegram.
    innerReq.emit('aborted')
    innerRes.emit('close')
  })

  await wrapped(req, res)
  assert.equal(bytes, 6)
  assert.equal(aborted, 0, 'a fully staged upload must survive request abort')
  assert.equal(closed, 0, 'a fully staged upload must survive response close')
  assert.equal(req[Symbol.asyncIterator], originalIterator, 'request iterator must be restored')
  assert.equal(req.once, originalReqOnce, 'request event method must be restored')
  assert.equal(res.once, originalResOnce, 'response event method must be restored')
}

Promise.resolve()
  .then(testDisconnectBeforeBodyEofStillAborts)
  .then(testDisconnectAfterBodyEofDoesNotAbortTelegramPhase)
  .then(() => console.log('bulk upload reliability checks passed'))
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
