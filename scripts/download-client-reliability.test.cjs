'use strict'

const assert = require('node:assert/strict')
const {
  normalizeFileShape,
  isTransientDownloadError,
  invokeDownloadWithRetry
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

Promise.resolve()
  .then(availabilityIsNormalized)
  .then(errorClassificationIsConservative)
  .then(transientInvokeGetsAnotherChance)
  .then(() => console.log('download client reliability checks passed'))
  .catch(error => {
    console.error(error)
    process.exitCode = 1
  })
