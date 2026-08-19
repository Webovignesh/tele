'use strict'

const assert = require('node:assert/strict')
const { UploadQueue } = require('../public/upload-queue-core.js')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function descriptor (index, extra = {}) {
  return {
    id: `job-${index}`,
    chatId: 1,
    chatTitle: 'TEST',
    name: `file-${index}.bin`,
    size: 1024,
    type: 'application/octet-stream',
    lastModified: 1,
    _source: { size: 1024 },
    ...extra
  }
}

async function eventually (predicate, timeout = 2000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (predicate()) return
    await wait(10)
  }
  throw new Error('condition was not reached before timeout')
}

async function concurrencyIsBounded () {
  let active = 0
  let peak = 0
  const queue = new UploadQueue({
    concurrency: 4,
    maxConcurrency: 8,
    resolveSource: async job => job._source,
    transport: async (job, source, { onProgress }) => {
      active++
      peak = Math.max(peak, active)
      onProgress(512, source.size)
      await wait(6)
      onProgress(source.size, source.size)
      active--
      return { ok: true, message: { id: job.id } }
    }
  })
  queue.add(Array.from({ length: 120 }, (_, i) => descriptor(i)))
  await eventually(() => queue.stats().completed === 120, 5000)
  assert.equal(queue.stats().remaining, 0)
  assert.equal(queue.stats().total, 120)
  assert.ok(peak <= 4, `peak concurrency ${peak} exceeded 4`)
  queue.destroy()
}

async function cancelAllCoversFullQueue () {
  let started = 0
  const queue = new UploadQueue({
    concurrency: 3,
    resolveSource: async job => job._source,
    transport: (job, source, { signal }) => new Promise((resolve, reject) => {
      started++
      const timer = setTimeout(() => resolve({ ok: true }), 1000)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }))
      }, { once: true })
    })
  })
  queue.add(Array.from({ length: 100 }, (_, i) => descriptor(i)))
  await eventually(() => queue.stats().uploading === 3)
  queue.cancelAll()
  await wait(30)
  const stats = queue.stats()
  assert.equal(stats.remaining, 0)
  assert.equal(stats.cancelled, 100)
  assert.equal(started, 3, 'cancel-all must not start queued jobs while aborting the active set')
  queue.destroy()
}

async function pauseResumeIsDeterministic () {
  const queue = new UploadQueue({
    concurrency: 2,
    resolveSource: async job => job._source,
    transport: (job, source, { signal }) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ ok: true }), 50)
      signal.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }))
      }, { once: true })
    })
  })
  queue.add(Array.from({ length: 10 }, (_, i) => descriptor(i)))
  await eventually(() => queue.stats().uploading === 2)
  queue.pauseAll()
  await wait(15)
  assert.equal(queue.stats().paused, 10)
  assert.equal(queue.stats().uploading, 0)
  queue.resumeAll()
  await eventually(() => queue.stats().completed === 10)
  assert.equal(queue.stats().remaining, 0)
  queue.destroy()
}

async function transientFailureAutoRetries () {
  let attempts = 0
  const queue = new UploadQueue({
    concurrency: 1,
    retryBaseMs: 10,
    retryMaxMs: 20,
    resolveSource: async job => job._source,
    verifyDelivery: async () => false,
    transport: async () => {
      attempts++
      if (attempts === 1) {
        const error = new Error('server unavailable')
        error.transient = true
        error.uncertain = true
        throw error
      }
      return { ok: true, message: { id: 55 } }
    }
  })
  queue.add([descriptor(1)])
  await eventually(() => queue.stats().completed === 1, 1000)
  assert.equal(attempts, 2)
  assert.equal(queue.get('job-1').telegramMessageId, 55)
  queue.destroy()
}

async function uncertainDeliveryDoesNotDuplicate () {
  let uploads = 0
  let verifies = 0
  const queue = new UploadQueue({
    concurrency: 1,
    retryBaseMs: 10,
    resolveSource: async job => job._source,
    verifyDelivery: async () => { verifies++; return true },
    transport: async () => {
      uploads++
      const error = new Error('connection dropped after send')
      error.transient = true
      error.uncertain = true
      throw error
    }
  })
  queue.add([descriptor(1)])
  await eventually(() => queue.stats().completed === 1, 1000)
  assert.equal(uploads, 1, 'verified delivery must not be uploaded a second time')
  assert.equal(verifies, 1)
  assert.equal(queue.get('job-1').recovered, true)
  queue.destroy()
}

async function restoreRecoversInterruptedState () {
  const queue = new UploadQueue({
    concurrency: 1,
    resolveSource: async job => job._source,
    transport: async () => ({ ok: true })
  })
  queue.globalPaused = true
  queue.restore([
    descriptor(1, { status: 'uploading' }),
    descriptor(2, { status: 'retrying', retryAt: Date.now() + 10000 }),
    descriptor(3, { status: 'completed' }),
    descriptor(4, { status: 'paused' })
  ])
  assert.equal(queue.get('job-1').status, 'queued')
  assert.equal(queue.get('job-2').status, 'queued')
  assert.equal(queue.get('job-3').status, 'completed')
  assert.equal(queue.get('job-4').status, 'paused')
  queue.destroy()
}

async function clearAllActuallyEmptiesEverything () {
  const queue = new UploadQueue({
    concurrency: 2,
    resolveSource: async job => job._source,
    transport: async () => { await wait(100); return { ok: true } }
  })
  queue.add(Array.from({ length: 25 }, (_, i) => descriptor(i)))
  await eventually(() => queue.stats().uploading === 2)
  queue.clearAll()
  await wait(20)
  assert.equal(queue.stats().total, 0)
  assert.equal(queue.stats().remaining, 0)
  assert.equal(queue.list().length, 0)
  queue.destroy()
}

async function largeQueueStateHandlesTwentyThousandFiles () {
  const queue = new UploadQueue({
    concurrency: 8,
    resolveSource: async job => job._source,
    transport: async () => ({ ok: true })
  })
  // Hold the scheduler so this test measures queue state and bulk actions without
  // trying to create 20k asynchronous transports. Large batches still retain all
  // records while the UI is responsible for mounting only a 100-row page.
  queue.globalPaused = true
  queue.add(Array.from({ length: 20000 }, (_, i) => descriptor(i)))
  let stats = queue.stats()
  assert.equal(stats.total, 20000)
  assert.equal(stats.remaining, 20000)
  assert.equal(stats.queued, 20000)
  assert.equal(queue.order.length, 20000)

  queue.cancelAll()
  stats = queue.stats()
  assert.equal(stats.total, 20000)
  assert.equal(stats.remaining, 0)
  assert.equal(stats.cancelled, 20000)

  queue.clearAll()
  assert.equal(queue.stats().total, 0)
  assert.equal(queue.order.length, 0)
  queue.destroy()
}

;(async () => {
  await concurrencyIsBounded()
  await cancelAllCoversFullQueue()
  await pauseResumeIsDeterministic()
  await transientFailureAutoRetries()
  await uncertainDeliveryDoesNotDuplicate()
  await restoreRecoversInterruptedState()
  await clearAllActuallyEmptiesEverything()
  await largeQueueStateHandlesTwentyThousandFiles()
  console.log('upload queue checks passed')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
