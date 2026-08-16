'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { ScalableUploadLedger } = require('../bulk-upload-ledger')

;(async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'filegram-upload-ledger-'))
  try {
    const ledger = new ScalableUploadLedger(root, { compactBytes: 16 * 1024 * 1024 })
    const jobs = 1500
    for (let index = 0; index < jobs; index++) {
      await ledger.set(`job-${index}`, {
        chatId: 777,
        fileName: `file-${index}.bin`,
        size: 1024 + index,
        mode: 'document',
        status: 'completed',
        messageId: 100000 + index,
        createdAt: Date.now()
      })
    }
    await ledger.flush()

    const file = path.join(root, '.filegram_state', 'bulk-upload-ledger.ndjson')
    const stat = await fs.promises.stat(file)
    assert.ok(stat.size < 2 * 1024 * 1024, `1500 records unexpectedly consumed ${stat.size} bytes`)

    const text = await fs.promises.readFile(file, 'utf8')
    const lines = text.trim().split('\n')
    assert.equal(lines.length, jobs, 'one terminal transition should append one ledger record')

    const restarted = new ScalableUploadLedger(root)
    const recovered = await restarted.get('job-1499')
    assert.equal(recovered.status, 'completed')
    assert.equal(recovered.messageId, 101499)

    // Multiple state transitions append linearly and the latest value wins after
    // a fresh process instance. No full ever-growing JSON object is rewritten.
    await restarted.set('job-1499', { ...recovered, status: 'uncertain' })
    await restarted.set('job-1499', { ...recovered, status: 'completed', messageId: 222222 })
    await restarted.flush()
    const after = await fs.promises.readFile(file, 'utf8')
    assert.equal(after.trim().split('\n').length, jobs + 2)

    const third = new ScalableUploadLedger(root)
    const final = await third.get('job-1499')
    assert.equal(final.status, 'completed')
    assert.equal(final.messageId, 222222)

    console.log('bulk upload ledger checks passed')
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
