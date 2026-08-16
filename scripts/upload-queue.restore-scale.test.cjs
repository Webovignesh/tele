'use strict'

const assert = require('node:assert/strict')
const { UploadQueue } = require('../public/upload-queue-core.js')

function record (index, status = 'queued') {
  return {
    id: `restore-${index}`,
    sequence: index + 1,
    chatId: 777,
    chatTitle: 'TEST',
    name: `file-${index}.bin`,
    size: 1,
    type: 'application/octet-stream',
    status,
    _source: { size: 1, name: `file-${index}.bin`, lastModified: 1 }
  }
}

;(async () => {
  let starts = 0
  const queue = new UploadQueue({
    concurrency: 4,
    maxConcurrency: 8,
    resolveSource: async job => job._source,
    transport: async () => {
      starts++
      await new Promise(resolve => setTimeout(resolve, 1000))
      return { ok: true }
    }
  })

  const records = Array.from({ length: 20000 }, (_, index) => record(index, index < 4 ? 'uploading' : 'queued'))
  const before = Date.now()
  queue.restore(records)
  const elapsed = Date.now() - before

  assert.equal(queue.stats().total, 20000)
  assert.equal(queue.list().length, 20000)
  assert.ok(queue.stats().uploading <= 4)
  assert.ok(elapsed < 5000, `20k restore took ${elapsed}ms`)

  queue.cancelAll()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(queue.stats().remaining, 0)
  assert.equal(queue.stats().cancelled, 20000)
  assert.ok(starts <= 4, `cancel-all started ${starts} jobs instead of only active workers`)
  queue.destroy()

  console.log('upload restore scale checks passed')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
