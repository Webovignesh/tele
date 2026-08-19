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
  const recoveries = new Map()

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

  function paintTransferPhase (queue) {
    const value = document.querySelector('#fg-upload-speed')
    if (!value || !queue) return
    const label = value.closest('.fg-up-stat')?.querySelector('span')
    if (label) label.textContent = 'Status'

    const jobs = [...queue.jobs.values()]
    const staging = jobs.filter(job => job.status === 'uploading' && Number(job.progress || 0) < 1)
    const telegram = jobs.filter(job => job.status === 'uploading' && Number(job.progress || 0) >= 1)
    const verifying = jobs.filter(job => job.status === 'verifying')
    const retrying = jobs.filter(job => job.status === 'retrying')

    if (staging.length) {
      const percent = Math.round(staging.reduce((sum, job) => sum + Math.max(0, Math.min(1, Number(job.progress || 0))), 0) / staging.length * 100)
      value.textContent = `Staging ${percent}%`
      return
    }
    if (telegram.length) {
      const oldest = Math.min(...telegram.map(job => Number(job.attemptStartedAt || job.startedAt || Date.now())))
      const seconds = Math.max(0, Math.floor((Date.now() - oldest) / 1000))
      value.textContent = `Telegram ${seconds}s`
      return
    }
    if (verifying.length) { value.textContent = 'Verifying…'; return }
    if (retrying.length) { value.textContent = 'Retrying…'; return }
    value.textContent = 'Idle'
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

  async function verifyExistingDelivery (queue, current, status) {
    if (typeof queue.verifyDelivery !== 'function') return false
    let delivered = false
    try { delivered = !!(await queue.verifyDelivery(current)) } catch {}
    if (delivered) completeRecovered(queue, current, status)
    return delivered
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
          /* If the process that owned the send disappeared, a stale 'sending'
           * ledger record must not strand the browser in Verifying for 35 minutes.
           * First look for the exact filename+size on Telegram; if it is not there,
           * fall back to the browser source so the normal retry path can continue. */
          if (status.status === 'uncertain' || status.active === false) {
            if (await verifyExistingDelivery(queue, current, status)) return
            if (status.active === false && status.status !== 'uncertain') break
          }
          setVerifying(queue, current)
          await sleep(POLL_MS)
          continue
        }

        break
      }

      const current = queue.jobs.get(id)
      if (!current || ['completed', 'cancelled', 'paused'].includes(current.status)) return

      /* The server has no recoverable staged/send state. Fall back to the browser
       * source contract. If the persisted handle still has permission, normal
       * resume proceeds automatically; otherwise Locate is the truthful final
       * state because FileGram never retained a complete source copy. */
      current.status = fallbackStatus === 'queued' ? 'queued' : 'needs_access'
      current.speed = 0
      current.error = current.status === 'needs_access'
        ? 'Source access is required because the browser refreshed before FileGram finished staging this file'
        : null
      current.updatedAt = Date.now()
      changed(queue, current.status === 'queued' ? 'resume' : 'needs-access', current)
      if (current.status === 'queued') queue.pump()
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
      baseProgress(job, loaded, total)
      if (!job) return

      /* Never surface browser -> localhost throughput as Telegram network speed.
       * Loopback routinely reports hundreds of MB/s, then freezes at that number
       * while TDLib performs the real upload. The status tile instead shows the
       * truthful phase (Staging / Telegram / Verifying) below. */
      job.speed = 0
      const bytes = Math.max(0, Number(loaded || 0))
      const max = Math.max(bytes, Number(total || 0), Number(job.size || 0))
      if (max > 0 && bytes >= max) {
        job.progress = 1
        job.uploadedBytes = max
        job.totalBytes = max
        changed(this, 'staged', job)
      }
      queueMicrotask(() => paintTransferPhase(this))
    }

    const baseCancel = queue.cancel.bind(queue)
    queue.cancel = function fileGramReliableCancel (id) {
      stopRecovery(id)
      return baseCancel(id)
    }

    const baseClearAll = queue.clearAll.bind(queue)
    queue.clearAll = function fileGramReliableClearAll () {
      recoveries.clear()
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
      queueMicrotask(() => paintTransferPhase(this))
      return result
    }

    /* Keep the second phase visibly alive even when TDLib is sending and no XHR
     * upload progress events remain. This replaces the misleading frozen MB/s
     * value with an elapsed Telegram phase timer. */
    const phaseTimer = setInterval(() => {
      if (!document.documentElement.isConnected) return clearInterval(phaseTimer)
      paintTransferPhase(queue)
    }, 1000)

    window.__fileGramUploadRecovery = {
      recover: id => {
        const job = queue.jobs.get(String(id))
        return job ? recoverJob(queue, job, job.handle ? 'queued' : 'needs_access') : Promise.resolve()
      },
      status: readServerStatus
    }
    queueMicrotask(() => paintTransferPhase(queue))
    return true
  }

  let tries = 0
  const timer = setInterval(() => {
    const queue = window.FileGramUploads && window.FileGramUploads.queue
    if (install(queue) || ++tries > 400) clearInterval(timer)
  }, 25)
})()
