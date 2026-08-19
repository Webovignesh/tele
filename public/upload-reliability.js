'use strict'

/* FileGram bulk-upload reliability boundary.
 *
 * The upload POST first copies bytes from the browser to the local FileGram
 * process, then TDLib sends the staged file to Telegram. XHR upload progress only
 * measures the first (loopback) phase, so it must not be presented as Telegram
 * network speed. This layer also reconnects restored queue rows to the durable
 * server-side upload ledger before asking the user to locate a source again.
 */
;(function fileGramUploadReliability () {
  if (window.__fileGramUploadReliabilityInstalled) return
  window.__fileGramUploadReliabilityInstalled = true

  const POLL_MS = 1000
  const MAX_RECOVERY_MS = 35 * 60 * 1000
  const SPEED_SAMPLE_MS = 500
  const recoveries = new Map()
  const speedSamples = new Map()

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const activeServerStates = new Set(['receiving', 'staged', 'sending', 'uncertain'])

  async function readServerStatus (job) {
    const response = await fetch(`/api/filegram/bulk-upload-status/${encodeURIComponent(String(job.id))}`, {
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    })
    let payload = null
    try { payload = await response.json() } catch { payload = null }
    if (!response.ok || !payload || payload.ok === false) {
      const error = new Error(String(payload && payload.error || `Upload status failed with HTTP ${response.status}`))
      error.status = response.status
      throw error
    }
    return payload
  }

  function changed (queue, type, job) {
    try { queue.changed(type, job) } catch {}
  }

  function completeRecovered (queue, job, status) {
    if (!job || !queue.jobs.has(String(job.id))) return
    job.status = 'completed'
    job.progress = 1
    job.uploadedBytes = Math.max(Number(job.uploadedBytes || 0), Number(job.totalBytes || 0), Number(job.size || 0))
    job.totalBytes = Math.max(Number(job.totalBytes || 0), Number(job.size || 0))
    job.speed = 0
    job.retryAt = 0
    job.error = null
    job.recovered = true
    job.completedAt = Math.max(Number(status && status.completedAt || 0), Date.now())
    job.updatedAt = Date.now()
    if (status && status.messageId != null) job.telegramMessageId = status.messageId
    job.result = { ok: true, messageId: job.telegramMessageId || null }
    changed(queue, 'recovered', job)
    try { queue.pump() } catch {}
  }

  function setVerifying (queue, job) {
    if (!job || ['completed', 'cancelled', 'failed'].includes(job.status)) return
    job.status = 'verifying'
    job.speed = 0
    job.error = null
    job.updatedAt = Date.now()
    changed(queue, 'verifying', job)
  }

  function stopRecovery (jobId) {
    recoveries.delete(String(jobId))
  }

  async function recoverJob (queue, job, fallbackStatus) {
    const id = String(job.id)
    if (recoveries.has(id)) return recoveries.get(id)

    const work = (async () => {
      const started = Date.now()
      let consecutiveStatusErrors = 0
      setVerifying(queue, job)

      while (Date.now() - started < MAX_RECOVERY_MS) {
        const current = queue.jobs.get(id)
        if (!current || ['completed', 'cancelled'].includes(current.status)) return
        if (current.status === 'paused') return

        let status
        try {
          status = await readServerStatus(current)
          consecutiveStatusErrors = 0
        } catch {
          consecutiveStatusErrors++
          if (consecutiveStatusErrors < 8) {
            await sleep(POLL_MS)
            continue
          }
          status = null
        }

        if (status && status.exists && status.status === 'completed') {
          completeRecovered(queue, current, status)
          return
        }

        if (status && status.exists && activeServerStates.has(String(status.status || ''))) {
          /* An uncertain ledger record may already have reached Telegram even if
           * the original response disappeared. Reuse the existing exact
           * filename/size verification before asking for source access. */
          if (status.status === 'uncertain' && typeof queue.verifyDelivery === 'function') {
            let delivered = false
            try { delivered = !!(await queue.verifyDelivery(current)) } catch {}
            if (delivered) {
              completeRecovered(queue, current, status)
              return
            }
          }
          setVerifying(queue, current)
          await sleep(POLL_MS)
          continue
        }

        /* The server has no recoverable staged/send state. Fall back to the
         * browser source contract. If the persisted handle still has permission,
         * normal resume proceeds automatically; otherwise the existing Locate UI
         * is the truthful final state. */
        current.status = fallbackStatus === 'queued' ? 'queued' : 'needs_access'
        current.speed = 0
        current.error = current.status === 'needs_access'
          ? 'Source access is required because the browser refreshed before FileGram finished staging this file'
          : null
        current.updatedAt = Date.now()
        changed(queue, current.status === 'queued' ? 'resume' : 'needs-access', current)
        if (current.status === 'queued') queue.pump()
        return
      }

      const current = queue.jobs.get(id)
      if (current && current.status === 'verifying') {
        current.status = 'needs_access'
        current.speed = 0
        current.error = 'Could not confirm the interrupted upload. Locate the source file to resume safely.'
        current.updatedAt = Date.now()
        changed(queue, 'needs-access', current)
      }
    })().finally(() => stopRecovery(id))

    recoveries.set(id, work)
    return work
  }

  function shouldRecover (job) {
    if (!job || !job.id) return false
    if (['completed', 'cancelled', 'failed', 'paused'].includes(job.status)) return false
    if (Number(job.attempts || 0) <= 0 && Number(job.progress || 0) <= 0 && Number(job.uploadedBytes || 0) <= 0) return false
    return ['needs_access', 'queued', 'retrying', 'verifying', 'uploading'].includes(job.status)
  }

  function install (queue) {
    if (!queue || queue.__fileGramUploadReliability) return false
    queue.__fileGramUploadReliability = true

    const baseProgress = queue.progress.bind(queue)
    queue.progress = function fileGramStableUploadProgress (job, loaded, total) {
      const now = Date.now()
      const id = String(job && job.id || '')
      let sample = speedSamples.get(id)
      if (!sample) {
        sample = { at: now, bytes: Math.max(0, Number(loaded || 0)) }
        speedSamples.set(id, sample)
      }

      baseProgress(job, loaded, total)
      if (!job) return

      const bytes = Math.max(0, Number(loaded || 0))
      const max = Math.max(bytes, Number(total || 0), Number(job.size || 0))
      if (max > 0 && bytes >= max) {
        /* The browser -> FileGram copy is finished. TDLib may still be uploading
         * for seconds/minutes, so never leave the last loopback sample displayed
         * as if Telegram were receiving at hundreds of MB/s. */
        job.progress = 1
        job.uploadedBytes = max
        job.totalBytes = max
        job.speed = 0
        speedSamples.delete(id)
        changed(this, 'staged', job)
        return
      }

      const elapsed = now - sample.at
      if (elapsed < SPEED_SAMPLE_MS) {
        job.speed = 0
        return
      }
      const delta = Math.max(0, bytes - sample.bytes)
      job.speed = elapsed > 0 ? delta * 1000 / elapsed : 0
      speedSamples.set(id, { at: now, bytes })
    }

    const baseCancel = queue.cancel.bind(queue)
    queue.cancel = function fileGramReliableCancel (id) {
      stopRecovery(id)
      return baseCancel(id)
    }

    const baseClearAll = queue.clearAll.bind(queue)
    queue.clearAll = function fileGramReliableClearAll () {
      recoveries.clear()
      speedSamples.clear()
      return baseClearAll()
    }

    /* Hardening loads just after bulk-uploads.js. A restored row may already have
     * tried its persisted handle and reached needs_access in that small window;
     * reconnect it to server truth immediately instead of showing a false error. */
    for (const job of queue.jobs.values()) {
      if (shouldRecover(job)) recoverJob(queue, job, job.handle ? 'queued' : 'needs_access').catch(() => {})
    }

    const baseChanged = queue.changed.bind(queue)
    queue.changed = function fileGramReliableChanged (type, payload) {
      const result = baseChanged(type, payload)
      const jobs = Array.isArray(payload) ? payload : (payload && payload.id ? [payload] : [])
      for (const job of jobs) {
        if (type === 'restored' || type === 'needs-access') {
          const live = this.jobs.get(String(job.id))
          if (shouldRecover(live)) recoverJob(this, live, live.handle ? 'queued' : 'needs_access').catch(() => {})
        }
      }
      return result
    }

    window.__fileGramUploadRecovery = {
      recover: id => {
        const job = queue.jobs.get(String(id))
        return job ? recoverJob(queue, job, job.handle ? 'queued' : 'needs_access') : Promise.resolve()
      },
      status: readServerStatus
    }
    return true
  }

  let tries = 0
  const timer = setInterval(() => {
    const queue = window.FileGramUploads && window.FileGramUploads.queue
    if (install(queue) || ++tries > 400) clearInterval(timer)
  }, 25)
})()
