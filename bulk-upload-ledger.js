'use strict'

const fs = require('node:fs')
const path = require('node:path')

const LEDGER_TTL_MS = 30 * 24 * 60 * 60 * 1000
const LEDGER_MAX_RECORDS = 100000
const COMPACT_BYTES = 64 * 1024 * 1024

/*
 * Crash-safe idempotency ledger for bulk Telegram uploads.
 *
 * The first implementation rewrote one ever-growing JSON object for every state
 * transition (receiving -> staged -> sending -> completed). That is effectively
 * O(n^2) disk traffic for a 20k+ batch. This ledger is append-only: one small
 * NDJSON record is written per transition, serialized through writeChain. A
 * truncated final line after power loss is ignored on the next load. Compaction
 * is rare and performed only on startup / large logs.
 */
class ScalableUploadLedger {
  constructor (root, options = {}) {
    this.dir = path.join(root, '.filegram_state')
    this.file = path.join(this.dir, 'bulk-upload-ledger.ndjson')
    this.legacyFile = path.join(this.dir, 'bulk-upload-ledger.json')
    this.records = new Map()
    this.loaded = false
    this.writeChain = Promise.resolve()
    this.ttlMs = Math.max(60_000, Number(options.ttlMs || LEDGER_TTL_MS))
    this.maxRecords = Math.max(1000, Number(options.maxRecords || LEDGER_MAX_RECORDS))
    this.compactBytes = Math.max(1024 * 1024, Number(options.compactBytes || COMPACT_BYTES))
    this.lineCount = 0
  }

  async load () {
    if (this.loaded) return
    this.loaded = true
    await fs.promises.mkdir(this.dir, { recursive: true })

    let source = ''
    try { source = await fs.promises.readFile(this.file, 'utf8') } catch {}
    if (source) {
      for (const line of source.split('\n')) {
        if (!line.trim()) continue
        this.lineCount++
        try {
          const event = JSON.parse(line)
          if (!event || !event.id || !event.record) continue
          this.records.set(String(event.id), event.record)
        } catch {
          // A process/power cut can leave one partial tail record. Every earlier
          // complete line is still authoritative, so ignore malformed tails.
        }
      }
    } else {
      // One-time migration path from the prototype ledger.
      try {
        const legacy = JSON.parse(await fs.promises.readFile(this.legacyFile, 'utf8'))
        for (const [id, record] of Object.entries(legacy && legacy.records || {})) {
          if (record) this.records.set(String(id), record)
        }
      } catch {}
    }

    const now = Date.now()
    for (const [id, record] of this.records) {
      if (!record || now - Number(record.updatedAt || 0) > this.ttlMs) this.records.delete(id)
    }
    this.trimToMax()

    let bytes = 0
    try { bytes = (await fs.promises.stat(this.file)).size } catch {}
    const excessiveHistory = this.lineCount > Math.max(5000, this.records.size * 6)
    if (!source || bytes > this.compactBytes || excessiveHistory) await this.compact()
  }

  trimToMax () {
    if (this.records.size <= this.maxRecords) return
    const keep = [...this.records.entries()]
      .sort((a, b) => Number(b[1] && b[1].updatedAt || 0) - Number(a[1] && a[1].updatedAt || 0))
      .slice(0, this.maxRecords)
    this.records = new Map(keep)
  }

  async get (id) {
    await this.load()
    return this.records.get(String(id)) || null
  }

  async set (id, value) {
    await this.load()
    const key = String(id)
    const record = { ...value, updatedAt: Date.now() }
    this.records.set(key, record)
    this.trimToMax()
    const line = JSON.stringify({ id: key, record }) + '\n'
    this.writeChain = this.writeChain.then(async () => {
      await fs.promises.mkdir(this.dir, { recursive: true })
      await fs.promises.appendFile(this.file, line, 'utf8')
      this.lineCount++
    })
    await this.writeChain
    return record
  }

  async compact () {
    await this.writeChain
    const now = Date.now()
    for (const [id, record] of this.records) {
      if (!record || now - Number(record.updatedAt || 0) > this.ttlMs) this.records.delete(id)
    }
    this.trimToMax()
    const temp = this.file + '.tmp'
    const payload = [...this.records.entries()]
      .map(([id, record]) => JSON.stringify({ id, record }))
      .join('\n') + (this.records.size ? '\n' : '')
    await fs.promises.mkdir(this.dir, { recursive: true })
    await fs.promises.writeFile(temp, payload, 'utf8')
    await fs.promises.rename(temp, this.file)
    this.lineCount = this.records.size
    fs.promises.rm(this.legacyFile, { force: true }).catch(() => {})
  }

  async flush () {
    await this.writeChain
  }
}

module.exports = {
  ScalableUploadLedger,
  LEDGER_TTL_MS,
  LEDGER_MAX_RECORDS,
  COMPACT_BYTES
}
