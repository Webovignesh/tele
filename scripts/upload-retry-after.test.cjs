'use strict'

const assert = require('node:assert/strict')
const { UploadQueue } = require('../public/upload-queue-core.js')

;(async () => {
  let attempts = 0
  const started = Date.now()
  const queue = new UploadQueue({
    concurrency: 1,
    retryBaseMs: 10,
    retryMaxMs: 20,
    resolveSource: async job => job._source,
    transport: async () => {
      attempts++
      if (attempts === 1) {
        const error = new Error('FLOOD_WAIT_1')
        error.transient = true
        error.retryAfterMs = 120
        throw error
      }
      return { ok: true, messageId: 55 }
    }
  })
  queue.add([{ id: 'retry-after', chatId: 777, name: 'a.bin', size: 1, _source: { size: 1 } }])

  while (queue.stats().completed !== 1 && Date.now() - started < 2000) {
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.equal(queue.stats().completed, 1)
  assert.equal(attempts, 2)
  assert.ok(Date.now() - started >= 100, 'retry started before the server Retry-After window')
  queue.destroy()
  console.log('upload retry-after checks passed')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
