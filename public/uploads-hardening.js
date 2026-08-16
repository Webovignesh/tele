'use strict'

/* Small runtime hardening layer for the bulk upload workspace.
 * It owns no UI and no queue state. It only upgrades the queue's transport with
 * server idempotency/retry headers and verifies persisted source handles still
 * point at the file the user originally queued.
 */
;(function hardenFileGramUploads () {
  if (window.__fileGramUploadsHardeningInstalled) return
  window.__fileGramUploadsHardeningInstalled = true

  const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504])

  function retryAfterMs (xhr) {
    const raw = String(xhr.getResponseHeader('Retry-After') || '').trim()
    if (!raw) return 0
    if (/^\d+$/.test(raw)) return Math.max(0, Number(raw) * 1000)
    const at = Date.parse(raw)
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0
  }

  function classify (xhr, payload) {
    const status = Number(xhr && xhr.status || 0)
    const error = new Error(String(payload && payload.error || `Upload failed with HTTP ${status || 0}`))
    error.status = status
    error.transient = !status || TRANSIENT_HTTP.has(status)
    error.uncertain = !status || status >= 500
    error.retryAfterMs = retryAfterMs(xhr)
    return error
  }

  function transport (job, file, context) {
    if (typeof window.__FILEGRAM_UPLOAD_TRANSPORT__ === 'function') {
      return window.__FILEGRAM_UPLOAD_TRANSPORT__(job, file, context)
    }
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        context.signal.removeEventListener('abort', abort)
        fn(value)
      }
      const abort = () => { try { xhr.abort() } catch {} }
      context.signal.addEventListener('abort', abort, { once: true })
      xhr.open('POST', `/api/chat-attachment/${encodeURIComponent(String(job.chatId))}`)
      xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name || job.name || 'file'))
      xhr.setRequestHeader('x-mime-type', encodeURIComponent(file.type || job.type || 'application/octet-stream'))
      xhr.setRequestHeader('x-filegram-upload-id', String(job.id))
      // Bulk uploads default to Telegram documents. That preserves the exact
      // filename/bytes and makes uncertain-delivery recovery deterministic.
      xhr.setRequestHeader('x-upload-mode', 'document')
      if (job.caption) xhr.setRequestHeader('x-caption', encodeURIComponent(job.caption))
      xhr.upload.onprogress = event => {
        context.onProgress(event.loaded, event.lengthComputable ? event.total : (file.size || job.size || 0))
      }
      xhr.onload = () => {
        let payload = null
        try { payload = JSON.parse(xhr.responseText || '{}') } catch { payload = {} }
        if (xhr.status >= 200 && xhr.status < 300) finish(resolve, payload)
        else finish(reject, classify(xhr, payload))
      }
      xhr.onerror = () => finish(reject, classify(xhr, null))
      xhr.ontimeout = () => finish(reject, classify(xhr, { error: 'Upload request timed out' }))
      xhr.onabort = () => {
        const error = new Error('Upload aborted')
        error.code = 'ABORTED'
        finish(reject, error)
      }
      xhr.timeout = 0
      xhr.send(file)
    })
  }

  function install () {
    const api = window.FileGramUploads
    const queue = api && api.queue
    if (!queue) return false
    if (queue.__fileGramHardened) return true
    queue.__fileGramHardened = true

    const baseResolve = queue.resolveSource.bind(queue)
    queue.resolveSource = async function verifiedSource (job, context) {
      const file = await baseResolve(job, context)
      if (!file) return file
      if (job.name && file.name && String(file.name) !== String(job.name)) {
        const error = new Error('Source file name changed since it was queued')
        error.code = 'SOURCE_CHANGED'
        throw error
      }
      if (Number(job.size || 0) && Number(file.size || 0) !== Number(job.size)) {
        const error = new Error('Source file size changed since it was queued')
        error.code = 'SOURCE_CHANGED'
        throw error
      }
      if (Number(job.lastModified || 0) && Number(file.lastModified || 0) && Number(file.lastModified) !== Number(job.lastModified)) {
        const error = new Error('Source file was modified since it was queued')
        error.code = 'SOURCE_CHANGED'
        throw error
      }
      return file
    }
    queue.transport = transport
    api.transportVersion = 2
    return true
  }

  let tries = 0
  const timer = setInterval(() => {
    if (install() || ++tries > 240) clearInterval(timer)
  }, 25)
})()
