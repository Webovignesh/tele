'use strict'

const assert = require('node:assert/strict')
const {
  ACTIVE_STALL_MS,
  REASSERT_MIN_MS,
  WARM_PRIORITY,
  normalizeFileShape,
  isTransientDownloadError,
  invokeDownloadWithRetry,
  createActiveDownloadKeeper,
  createWarmDownloadBacklog
} = require('../download-client-reliability-preload')

function availabilityIsNormalized () {
  const file = { id: 7, local: { can_be_downloaded: false, is_downloading_completed: false } }
  const normalized = normalizeFileShape(file)
  assert.equal(normalized.can_be_downloaded, false)
  assert.equal(normalized.local.can_be_downloaded, false)
}

function errorClassificationIsConservative () {
  assert.equal(isTransientDownloadError({ code: 429, message: 'Too Many Requests: retry after 1' }), true)
  assert.equal(isTransientDownloadError({ code: 503, message: 'Service unavailable' }), true)
  assert.equal(isTransientDownloadError(new Error('network request failed')), true)
  assert.equal(isTransientDownloadError({ code: 400, message: 'FILE_ID_INVALID' }), false)
  assert.equal(isTransientDownloadError({ code: 400, message: 'FILE_REFERENCE_EXPIRED' }), false)
}

async function transientInvokeGetsAnotherChance () {
  let calls = 0
  const invoke = async query => {
    calls++
    assert.equal(query._, 'downloadFile')
    if (calls === 1) {
      const error = new Error('temporary network request failed')
      error.code = 503
      throw error
    }
    return { id: 11, local: { can_be_downloaded: true } }
  }
  const result = await invokeDownloadWithRetry(invoke, { _: 'downloadFile', file_id: 11, synchronous: false })
  assert.equal(calls, 2)
  assert.equal(result.id, 11)
  assert.equal(result.can_be_downloaded, true)
}

async function quietAcceptedTransferIsReassertedWithoutCancellation () {
  let clock = 1000
  const calls = []
  const emitted = []
  const invoke = async query => {
    calls.push({ ...query })
    if (query._ === 'getFile') {
      return { id: query.file_id, size: 1000, local: { can_be_downloaded: true, downloaded_size: 100, is_downloading_completed: false } }
    }
    if (query._ === 'downloadFile') {
      return { id: query.file_id, size: 1000, local: { can_be_downloaded: true, downloaded_size: 100, is_downloading_completed: false } }
    }
    throw new Error(`unexpected ${query._}`)
  }
  const keeper = createActiveDownloadKeeper({
    invoke,
    emitUpdate: file => emitted.push(file),
    now: () => clock,
    setIntervalFn: () => ({ unref () {} }),
    clearIntervalFn: () => {}
  })

  keeper.track({ _: 'downloadFile', file_id: 77, priority: 32, offset: 0, limit: 0, synchronous: false })
  keeper.observe({ id: 77, local: { downloaded_size: 100, is_downloading_completed: false } })

  clock += ACTIVE_STALL_MS - 1
  await keeper.sweep()
  assert.equal(calls.length, 0, 'healthy/too-young quiet window must not be touched')

  clock += Math.max(2, REASSERT_MIN_MS)
  await keeper.sweep()
  assert.deepEqual(calls.map(call => call._), ['getFile', 'downloadFile'])
  assert.equal(calls.some(call => call._ === 'cancelDownloadFile'), false, 'stall recovery must never discard partial bytes')
  assert.equal(keeper.size(), 1, 'accepted transfer stays tracked until completion/cancel')
  assert.equal(emitted.length, 0)
  keeper.stop()
}

async function missedCompletionIsReturnedToExistingQueue () {
  let clock = 1000
  const emitted = []
  const calls = []
  const invoke = async query => {
    calls.push({ ...query })
    if (query._ === 'getFile') {
      return {
        id: query.file_id,
        size: 500,
        local: {
          can_be_downloaded: true,
          downloaded_size: 500,
          is_downloading_completed: true,
          path: 'C:/tdlib/file.bin'
        }
      }
    }
    throw new Error(`unexpected ${query._}`)
  }
  const keeper = createActiveDownloadKeeper({
    invoke,
    emitUpdate: file => emitted.push(file),
    now: () => clock,
    setIntervalFn: () => ({ unref () {} }),
    clearIntervalFn: () => {}
  })

  keeper.track({ _: 'downloadFile', file_id: 88, priority: 32, offset: 0, limit: 0, synchronous: false })
  clock += ACTIVE_STALL_MS + REASSERT_MIN_MS + 5
  await keeper.sweep()

  assert.deepEqual(calls.map(call => call._), ['getFile'])
  assert.equal(emitted.length, 1, 'a completion missed by the normal update stream must be emitted back to the queue')
  assert.equal(emitted[0].id, 88)
  assert.equal(keeper.size(), 0)
  keeper.stop()
}

async function byteProgressResetsTheQuietWindow () {
  let clock = 1000
  const calls = []
  const invoke = async query => { calls.push(query); return { id: query.file_id, local: { can_be_downloaded: true } } }
  const keeper = createActiveDownloadKeeper({
    invoke,
    emitUpdate: () => {},
    now: () => clock,
    setIntervalFn: () => ({ unref () {} }),
    clearIntervalFn: () => {}
  })

  keeper.track({ _: 'downloadFile', file_id: 99, priority: 32, synchronous: false })
  clock += ACTIVE_STALL_MS - 100
  keeper.observe({ id: 99, local: { downloaded_size: 4096, is_downloading_completed: false } })
  clock += 200
  await keeper.sweep()
  assert.equal(calls.length, 0, 'new bytes must postpone stall recovery even if the request itself is old')
  keeper.stop()
}

async function warmBacklogIsBoundedAndRolling () {
  const calls = []
  const invoke = async query => {
    calls.push({ ...query })
    if (query._ === 'downloadFile') return { id: query.file_id, local: { can_be_downloaded: true, downloaded_size: 0, is_downloading_completed: false } }
    if (query._ === 'cancelDownloadFile') return { _: 'ok' }
    throw new Error(`unexpected ${query._}`)
  }
  const warm = createWarmDownloadBacklog({ invoke, warmAhead: 4, warmPriority: WARM_PRIORITY })
  warm.prime(Array.from({ length: 10 }, (_, index) => ({ fileId: index + 1 })))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls.slice(0, 4).map(call => call.file_id), [1, 2, 3, 4])
  assert.ok(calls.slice(0, 4).every(call => call.priority === WARM_PRIORITY), 'warm requests must stay below active priority')
  assert.equal(warm.stats().warmed, 4)

  warm.promote(1)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.filter(call => call._ === 'downloadFile').length, 5, 'promoting one worker must immediately warm one successor')
  assert.equal(calls.filter(call => call._ === 'downloadFile').at(-1).file_id, 5)

  warm.observe({ id: 2, local: { is_downloading_completed: true, path: 'C:/tdlib/2.bin' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.filter(call => call._ === 'downloadFile').length, 6, 'a warm completion must also replenish the cushion')
  assert.equal(calls.filter(call => call._ === 'downloadFile').at(-1).file_id, 6)

  await warm.drop()
  const cancelIds = calls.filter(call => call._ === 'cancelDownloadFile').map(call => call.file_id).sort((a, b) => a - b)
  assert.deepEqual(cancelIds, [3, 4, 5, 6], 'manual queue intervention must cancel every invisible warm request')
  assert.equal(warm.stats().warmed, 0)
  assert.equal(warm.stats().pending, 0)
}

Promise.resolve()
  .then(availabilityIsNormalized)
  .then(errorClassificationIsConservative)
  .then(transientInvokeGetsAnotherChance)
  .then(quietAcceptedTransferIsReassertedWithoutCancellation)
  .then(missedCompletionIsReturnedToExistingQueue)
  .then(byteProgressResetsTheQuietWindow)
  .then(warmBacklogIsBoundedAndRolling)
  .then(() => console.log('download client reliability checks passed'))
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
