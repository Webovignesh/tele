'use strict'

;(function exposeUploadQueueCore (root, factory) {
  const api = factory()
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (root) root.FileGramUploadQueueCore = api
})(typeof globalThis !== 'undefined' ? globalThis : this, function buildUploadQueueCore () {
  const ACTIVE = new Set(['queued', 'uploading', 'retrying', 'verifying', 'paused', 'needs_access'])
  const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

  function clamp (value, min, max) {
    return Math.max(min, Math.min(max, Math.floor(Number(value) || min)))
  }

  function cloneJob (job) {
    const out = { ...job }
    delete out._source
    delete out._progressAt
    delete out._progressBytes
    delete out._abortIntent
    return out
  }

  function normalizeError (error) {
    if (!error) return { message: 'Upload failed', transient: false, uncertain: false }
    return {
      message: String(error.message || error),
      transient: !!error.transient,
      uncertain: !!error.uncertain,
      code: error.code || null,
      status: Number(error.status || 0) || 0
    }
  }

  class UploadQueue {
    constructor (options = {}) {
      if (typeof options.transport !== 'function') throw new Error('UploadQueue requires a transport(job, source, context) function')
      if (typeof options.resolveSource !== 'function') throw new Error('UploadQueue requires a resolveSource(job) function')
      this.transport = options.transport
      this.resolveSource = options.resolveSource
      this.verifyDelivery = typeof options.verifyDelivery === 'function' ? options.verifyDelivery : async () => false
      this.onChange = typeof options.onChange === 'function' ? options.onChange : () => {}
      this.now = typeof options.now === 'function' ? options.now : () => Date.now()
      // Browser timer functions are Web-IDL methods and must not be invoked with
      // an UploadQueue instance as their receiver. Wrapping them also keeps the
      // queue deterministic in Node tests where custom timer functions are used.
      this.setTimer = typeof options.setTimer === 'function' ? options.setTimer : ((fn, ms) => setTimeout(fn, ms))
      this.clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : (id => clearTimeout(id))
      this.concurrency = clamp(options.concurrency || 3, 1, options.maxConcurrency || 8)
      this.maxConcurrency = Math.max(this.concurrency, Number(options.maxConcurrency || 8))
      this.retryBaseMs = Math.max(250, Number(options.retryBaseMs || 2000))
      this.retryMaxMs = Math.max(this.retryBaseMs, Number(options.retryMaxMs || 30000))
      this.jobs = new Map()
      this.order = []
      this.active = new Map()
      this.sequence = 0
      this.globalPaused = false
      this.wakeTimer = null
      this.destroyed = false
    }

    add (descriptors = []) {
      const added = []
      for (const descriptor of descriptors) {
        if (!descriptor || !descriptor.id) continue
        const id = String(descriptor.id)
        if (this.jobs.has(id)) continue
        const now = this.now()
        const job = {
          id,
          sequence: Number.isFinite(descriptor.sequence) ? Number(descriptor.sequence) : ++this.sequence,
          chatId: descriptor.chatId,
          chatTitle: descriptor.chatTitle || '',
          name: String(descriptor.name || 'file'),
          relativePath: descriptor.relativePath || '',
          size: Math.max(0, Number(descriptor.size || 0)),
          type: String(descriptor.type || 'application/octet-stream'),
          lastModified: Math.max(0, Number(descriptor.lastModified || 0)),
          caption: String(descriptor.caption || ''),
          allowDuplicate: !!descriptor.allowDuplicate,
          handle: descriptor.handle || null,
          ephemeral: !!descriptor.ephemeral,
          status: descriptor.status || 'queued',
          progress: Math.max(0, Number(descriptor.progress || 0)),
          uploadedBytes: Math.max(0, Number(descriptor.uploadedBytes || 0)),
          totalBytes: Math.max(0, Number(descriptor.totalBytes || descriptor.size || 0)),
          speed: 0,
          attempts: Math.max(0, Number(descriptor.attempts || 0)),
          retryAt: 0,
          error: null,
          createdAt: Number(descriptor.createdAt || now),
          updatedAt: now,
          startedAt: Number(descriptor.startedAt || 0),
          attemptStartedAt: 0,
          completedAt: Number(descriptor.completedAt || 0),
          telegramMessageId: descriptor.telegramMessageId || null,
          recovered: !!descriptor.recovered,
          _source: descriptor._source || null,
          _progressAt: 0,
          _progressBytes: 0,
          _abortIntent: null
        }
        this.jobs.set(id, job)
        this.order.push(id)
        this.sequence = Math.max(this.sequence, job.sequence)
        added.push(job)
      }
      this.order.sort((a, b) => (this.jobs.get(a)?.sequence || 0) - (this.jobs.get(b)?.sequence || 0))
      if (added.length) this.changed('added', added)
      this.pump()
      return added.map(cloneJob)
    }

    restore (records = []) {
      const restored = []
      for (const record of records) {
        if (!record || !record.id) continue
        let status = String(record.status || 'queued')
        if (status === 'uploading' || status === 'retrying' || status === 'verifying') status = 'queued'
        const added = this.add([{ ...record, status }])
        if (added.length) restored.push(added[0])
      }
      this.changed('restored', restored)
      this.pump()
      return restored
    }

    setConcurrency (value) {
      const next = clamp(value, 1, this.maxConcurrency)
      if (next === this.concurrency) return next
      this.concurrency = next
      this.changed('concurrency')
      this.pump()
      return next
    }

    get (id) {
      const job = this.jobs.get(String(id))
      return job ? cloneJob(job) : null
    }

    list () {
      return this.order.map(id => this.jobs.get(id)).filter(Boolean).map(cloneJob)
    }

    serializable () {
      return this.order.map(id => this.jobs.get(id)).filter(Boolean).map(job => cloneJob(job))
    }

    stats () {
      const stats = {
        total: 0, queued: 0, uploading: 0, retrying: 0, verifying: 0,
        paused: 0, needsAccess: 0, completed: 0, failed: 0, cancelled: 0,
        remaining: 0, speed: 0, uploadedBytes: 0, totalBytes: 0,
        concurrency: this.concurrency
      }
      for (const job of this.jobs.values()) {
        stats.total++
        if (job.status === 'queued') stats.queued++
        else if (job.status === 'uploading') { stats.uploading++; stats.speed += Math.max(0, Number(job.speed || 0)) }
        else if (job.status === 'retrying') stats.retrying++
        else if (job.status === 'verifying') stats.verifying++
        else if (job.status === 'paused') stats.paused++
        else if (job.status === 'needs_access') stats.needsAccess++
        else if (job.status === 'completed') stats.completed++
        else if (job.status === 'failed') stats.failed++
        else if (job.status === 'cancelled') stats.cancelled++
        if (ACTIVE.has(job.status)) stats.remaining++
        stats.uploadedBytes += Math.max(0, Number(job.uploadedBytes || 0))
        stats.totalBytes += Math.max(0, Number(job.totalBytes || job.size || 0))
      }
      return stats
    }

    pauseAll () {
      this.globalPaused = true
      for (const job of this.jobs.values()) {
        if (job.status === 'uploading') {
          job._abortIntent = 'pause'
          job.status = 'paused'
          job.speed = 0
          job.updatedAt = this.now()
          this.active.get(job.id)?.abort()
        } else if (job.status === 'queued' || job.status === 'retrying' || job.status === 'verifying') {
          job.status = 'paused'
          job.retryAt = 0
          job.speed = 0
          job.updatedAt = this.now()
        }
      }
      this.cancelWake()
      this.changed('pause-all')
    }

    resumeAll () {
      this.globalPaused = false
      for (const job of this.jobs.values()) {
        if (job.status === 'paused') {
          job.status = 'queued'
          job.error = null
          job.retryAt = 0
          job.updatedAt = this.now()
        }
      }
      this.changed('resume-all')
      this.pump()
    }

    cancelAll () {
      this.globalPaused = false
      for (const job of this.jobs.values()) {
        if (!ACTIVE.has(job.status)) continue
        job._abortIntent = 'cancel'
        job.status = 'cancelled'
        job.retryAt = 0
        job.speed = 0
        job.updatedAt = this.now()
        this.active.get(job.id)?.abort()
      }
      this.cancelWake()
      this.changed('cancel-all')
    }

    clearDone () {
      this.removeWhere(job => job.status === 'completed' || job.status === 'cancelled')
      this.changed('clear-done')
    }

    clearAll () {
      this.cancelAll()
      this.jobs.clear()
      this.order = []
      this.changed('clear-all')
    }

    cancel (id) {
      const job = this.jobs.get(String(id))
      if (!job || !ACTIVE.has(job.status)) return false
      job._abortIntent = 'cancel'
      job.status = 'cancelled'
      job.retryAt = 0
      job.speed = 0
      job.updatedAt = this.now()
      this.active.get(job.id)?.abort()
      this.changed('cancel', job)
      this.pump()
      return true
    }

    pause (id) {
      const job = this.jobs.get(String(id))
      if (!job || !ACTIVE.has(job.status)) return false
      job._abortIntent = 'pause'
      job.status = 'paused'
      job.retryAt = 0
      job.speed = 0
      job.updatedAt = this.now()
      this.active.get(job.id)?.abort()
      this.changed('pause', job)
      return true
    }

    resume (id) {
      const job = this.jobs.get(String(id))
      if (!job || (job.status !== 'paused' && job.status !== 'failed' && job.status !== 'needs_access')) return false
      job.status = 'queued'
      job.retryAt = 0
      job.error = null
      job.updatedAt = this.now()
      this.changed('resume', job)
      this.pump()
      return true
    }

    retry (id) {
      const job = this.jobs.get(String(id))
      if (!job || !TERMINAL.has(job.status) || job.status === 'completed') return false
      job.status = 'queued'
      job.retryAt = 0
      job.error = null
      job.progress = 0
      job.uploadedBytes = 0
      job.updatedAt = this.now()
      this.changed('retry', job)
      this.pump()
      return true
    }

    attachSource (id, source, handle = null) {
      const job = this.jobs.get(String(id))
      if (!job) return false
      job._source = source || null
      if (handle) job.handle = handle
      job.ephemeral = !handle
      if (job.status === 'needs_access' || job.status === 'failed') {
        job.status = 'queued'
        job.error = null
      }
      job.updatedAt = this.now()
      this.changed('source', job)
      this.pump()
      return true
    }

    removeWhere (predicate) {
      const remove = new Set()
      for (const [id, job] of this.jobs) if (predicate(job)) remove.add(id)
      if (!remove.size) return 0
      for (const id of remove) {
        this.active.get(id)?.abort()
        this.jobs.delete(id)
      }
      this.order = this.order.filter(id => !remove.has(id))
      return remove.size
    }

    destroy () {
      this.destroyed = true
      this.cancelWake()
      for (const controller of this.active.values()) controller.abort()
      this.active.clear()
    }

    changed (type, payload = null) {
      try { this.onChange(type, payload, this) } catch {}
    }

    cancelWake () {
      if (this.wakeTimer == null) return
      this.clearTimer(this.wakeTimer)
      this.wakeTimer = null
    }

    scheduleWake () {
      if (this.destroyed || this.globalPaused) return
      this.cancelWake()
      let at = Infinity
      const now = this.now()
      for (const job of this.jobs.values()) {
        if (job.status === 'retrying' && job.retryAt > now) at = Math.min(at, job.retryAt)
      }
      if (!Number.isFinite(at)) return
      this.wakeTimer = this.setTimer(() => {
        this.wakeTimer = null
        this.pump()
      }, Math.max(0, at - now))
      if (this.wakeTimer && typeof this.wakeTimer.unref === 'function') this.wakeTimer.unref()
    }

    runnable (job, now) {
      if (!job) return false
      if (job.status === 'queued') return true
      return job.status === 'retrying' && Number(job.retryAt || 0) <= now
    }

    pump () {
      if (this.destroyed || this.globalPaused) return
      const now = this.now()
      while (this.active.size < this.concurrency) {
        let next = null
        for (const id of this.order) {
          const job = this.jobs.get(id)
          if (this.active.has(id) || !this.runnable(job, now)) continue
          next = job
          break
        }
        if (!next) break
        this.start(next).catch(() => {})
      }
      this.scheduleWake()
    }

    async start (job) {
      if (!job || this.active.has(job.id) || !this.runnable(job, this.now()) || this.globalPaused) return
      const controller = new AbortController()
      this.active.set(job.id, controller)
      job._abortIntent = null
      job.status = 'uploading'
      job.attempts = Math.max(0, Number(job.attempts || 0)) + 1
      job.attemptStartedAt = this.now()
      if (!job.startedAt) job.startedAt = job.attemptStartedAt
      job.updatedAt = job.attemptStartedAt
      job.error = null
      job.speed = 0
      job._progressAt = job.attemptStartedAt
      job._progressBytes = Math.max(0, Number(job.uploadedBytes || 0))
      this.changed('start', job)

      try {
        const source = await this.resolveSource(job, { signal: controller.signal, prompt: false })
        if (controller.signal.aborted) return
        if (!source) {
          const error = new Error('Source file access is required')
          error.code = 'NEEDS_FILE_ACCESS'
          throw error
        }
        job.totalBytes = Math.max(0, Number(source.size || job.size || job.totalBytes || 0))
        const result = await this.transport(job, source, {
          signal: controller.signal,
          onProgress: (loaded, total) => this.progress(job, loaded, total)
        })
        if (controller.signal.aborted || job._abortIntent) return
        job.status = 'completed'
        job.progress = 1
        job.uploadedBytes = Math.max(job.totalBytes, job.size, job.uploadedBytes)
        job.speed = 0
        job.completedAt = this.now()
        job.updatedAt = job.completedAt
        job.error = null
        const messageId = result && result.message && result.message.id != null ? result.message.id : (result && result.messageId)
        if (messageId != null) job.telegramMessageId = messageId
        job.result = result && typeof result === 'object' ? { ok: result.ok !== false, messageId: job.telegramMessageId || null } : { ok: true }
        this.changed('completed', job)
      } catch (rawError) {
        if (job._abortIntent === 'pause') return
        if (job._abortIntent === 'cancel') return
        if (controller.signal.aborted) return
        const error = normalizeError(rawError)
        if (error.code === 'NEEDS_FILE_ACCESS') {
          job.status = 'needs_access'
          job.speed = 0
          job.error = error.message
          job.updatedAt = this.now()
          this.changed('needs-access', job)
          return
        }
        if (error.transient) {
          if (error.uncertain) {
            job.status = 'verifying'
            job.speed = 0
            job.error = 'Connection was interrupted; checking Telegram before retrying…'
            job.updatedAt = this.now()
            this.changed('verifying', job)
            let delivered = false
            try { delivered = !!(await this.verifyDelivery(job, error)) } catch {}
            if (delivered) {
              job.status = 'completed'
              job.progress = 1
              job.uploadedBytes = Math.max(job.totalBytes, job.size, job.uploadedBytes)
              job.speed = 0
              job.completedAt = this.now()
              job.updatedAt = job.completedAt
              job.error = null
              job.recovered = true
              this.changed('recovered', job)
              return
            }
          }
          this.retryLater(job, error)
          return
        }
        job.status = 'failed'
        job.speed = 0
        job.error = error.message
        job.updatedAt = this.now()
        this.changed('failed', job)
      } finally {
        this.active.delete(job.id)
        job._abortIntent = null
        job.speed = 0
        this.changed('settled', job)
        this.pump()
      }
    }

    progress (job, loaded, total) {
      if (!job || job.status !== 'uploading') return
      const now = this.now()
      const bytes = Math.max(0, Number(loaded || 0))
      const max = Math.max(bytes, Number(total || 0), Number(job.size || 0))
      const deltaBytes = Math.max(0, bytes - Number(job._progressBytes || 0))
      const deltaMs = Math.max(1, now - Number(job._progressAt || now))
      const instant = deltaBytes * 1000 / deltaMs
      job.speed = Number.isFinite(instant) ? (job.speed ? job.speed * 0.55 + instant * 0.45 : instant) : 0
      job.uploadedBytes = bytes
      job.totalBytes = max
      job.progress = max > 0 ? Math.max(0, Math.min(1, bytes / max)) : 0
      job._progressBytes = bytes
      job._progressAt = now
      job.updatedAt = now
      this.changed('progress', job)
    }

    retryLater (job, error) {
      const exponent = Math.max(0, Math.min(8, Number(job.attempts || 1) - 1))
      const delay = Math.min(this.retryMaxMs, this.retryBaseMs * Math.pow(2, exponent))
      job.status = 'retrying'
      job.retryAt = this.now() + delay
      job.speed = 0
      job.error = `${error.message} · retrying automatically`
      job.updatedAt = this.now()
      this.changed('retrying', job)
      this.scheduleWake()
    }
  }

  return {
    UploadQueue,
    ACTIVE_STATUSES: [...ACTIVE],
    TERMINAL_STATUSES: [...TERMINAL]
  }
})
