'use strict'

/* FileGram bulk upload workspace.
 *
 * Ownership boundaries:
 * - upload-queue-core.js owns scheduling/state transitions;
 * - this file owns browser file access, persistence, duplicate review and UI;
 * - the existing /api/chat-attachment/:chatId route owns server staging + TDLib send;
 * - files-stability.js remains the sole owner of the Telegram Files index.
 *
 * No file bytes are copied into IndexedDB. Chromium FileSystemFileHandles are
 * persisted when supported; fallback <input type=file> sources remain recoverable
 * queue records but require re-selection after a browser restart.
 */
;(function fileGramBulkUploads () {
  if (window.__fileGramBulkUploadsInstalled) return
  window.__fileGramBulkUploadsInstalled = true

  const Core = window.FileGramUploadQueueCore
  if (!Core || !Core.UploadQueue) {
    console.error('[uploads] upload queue core is missing')
    return
  }

  const DB_NAME = 'filegram-uploads-v1'
  const DB_VERSION = 1
  const STORE_JOBS = 'jobs'
  const STORE_META = 'meta'
  const PAGE_SIZE = 100
  const MAX_CONCURRENCY = 8
  const DEFAULT_CONCURRENCY = 3
  const MAX_PICKED_FILES = 50000
  const MAX_FILE_BYTES = 4 * 1024 * 1024 * 1024
  const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504])

  const $ = selector => document.querySelector(selector)
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `up-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const fmtNumber = value => Math.max(0, Number(value || 0)).toLocaleString()
  const fmtSize = bytes => {
    let n = Math.max(0, Number(bytes || 0))
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let unit = 0
    while (n >= 1024 && unit < units.length - 1) { n /= 1024; unit++ }
    return `${unit ? n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2) : Math.round(n)} ${units[unit]}`
  }
  const fmtSpeed = bytes => `${fmtSize(bytes)}/s`

  function safeToast (message, kind) {
    try {
      if (typeof toast === 'function') toast(message, kind)
      else console[kind === 'error' ? 'error' : 'log'](message)
    } catch {}
  }

  function cleanJob (job) {
    const clean = { ...job }
    delete clean._source
    delete clean._progressAt
    delete clean._progressBytes
    delete clean._abortIntent
    return clean
  }

  class UploadStore {
    constructor () { this.dbPromise = null }

    open () {
      if (this.dbPromise) return this.dbPromise
      this.dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION)
        req.onupgradeneeded = () => {
          const db = req.result
          if (!db.objectStoreNames.contains(STORE_JOBS)) db.createObjectStore(STORE_JOBS, { keyPath: 'id' })
          if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' })
        }
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error || new Error('Could not open upload database'))
      })
      return this.dbPromise
    }

    async getAllJobs () {
      const db = await this.open()
      return new Promise((resolve, reject) => {
        const req = db.transaction(STORE_JOBS, 'readonly').objectStore(STORE_JOBS).getAll()
        req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : [])
        req.onerror = () => reject(req.error)
      })
    }

    async putJob (job) {
      const db = await this.open()
      let clean = cleanJob(job)
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_JOBS, 'readwrite')
        const store = tx.objectStore(STORE_JOBS)
        try {
          store.put(clean)
        } catch (error) {
          if (!clean.handle) return reject(error)
          clean = { ...clean, handle: null, ephemeral: true }
          try { store.put(clean) } catch (fallbackError) { return reject(fallbackError) }
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error || new Error('Upload database write aborted'))
      })
    }

    /* One transaction per chunk, rather than one transaction per file. This is
     * what keeps 10k–50k queues practical. If a browser refuses to structured-
     * clone a FileSystemHandle, only that record drops the handle; file bytes are
     * never copied into IndexedDB. */
    async putMany (jobs) {
      const source = (jobs || []).filter(Boolean)
      if (!source.length) return
      const db = await this.open()
      for (let offset = 0; offset < source.length; offset += 400) {
        const chunk = source.slice(offset, offset + 400)
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_JOBS, 'readwrite')
          const objectStore = tx.objectStore(STORE_JOBS)
          try {
            for (const job of chunk) {
              let clean = cleanJob(job)
              try {
                objectStore.put(clean)
              } catch (error) {
                if (!clean.handle) throw error
                clean = { ...clean, handle: null, ephemeral: true }
                objectStore.put(clean)
              }
            }
          } catch (error) {
            try { tx.abort() } catch {}
            reject(error)
            return
          }
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
          tx.onabort = () => reject(tx.error || new Error('Upload database batch write aborted'))
        })
        await sleep(0)
      }
    }

    async deleteJobs (ids) {
      const values = [...new Set((ids || []).map(String))]
      if (!values.length) return
      const db = await this.open()
      for (let offset = 0; offset < values.length; offset += 1000) {
        const chunk = values.slice(offset, offset + 1000)
        await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_JOBS, 'readwrite')
          const objectStore = tx.objectStore(STORE_JOBS)
          for (const id of chunk) objectStore.delete(id)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        })
      }
    }

    async clearJobs () {
      const db = await this.open()
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_JOBS, 'readwrite')
        tx.objectStore(STORE_JOBS).clear()
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    }

    async getMeta (key) {
      const db = await this.open()
      return new Promise((resolve, reject) => {
        const req = db.transaction(STORE_META, 'readonly').objectStore(STORE_META).get(String(key))
        req.onsuccess = () => resolve(req.result ? req.result.value : null)
        req.onerror = () => reject(req.error)
      })
    }

    async setMeta (key, value) {
      const db = await this.open()
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_META, 'readwrite')
        tx.objectStore(STORE_META).put({ key: String(key), value })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    }
  }

  const store = new UploadStore()
  const ownedChannels = new Map()
  const persistTimers = new Map()
  let renderTimer = null
  let currentPage = 1
  let reviewCandidates = []
  let reviewAnalysis = null
  let channelRefreshToken = 0
  let channelSignature = ''
  let channelObserver = null
  let mounted = false

  async function resolveSource (job) {
    if (job._source && typeof job._source.size === 'number') return job._source
    const handle = job.handle
    if (!handle || typeof handle.getFile !== 'function') {
      const error = new Error('Re-select this source file to resume the upload')
      error.code = 'NEEDS_FILE_ACCESS'
      throw error
    }
    let permission = 'granted'
    if (typeof handle.queryPermission === 'function') {
      try { permission = await handle.queryPermission({ mode: 'read' }) } catch { permission = 'prompt' }
    }
    if (permission !== 'granted') {
      const error = new Error('File access must be granted before this upload can resume')
      error.code = 'NEEDS_FILE_ACCESS'
      throw error
    }
    const file = await handle.getFile()
    if (Number(job.size || 0) && file.size !== Number(job.size)) {
      const error = new Error('Source file changed size since it was queued')
      error.code = 'SOURCE_CHANGED'
      throw error
    }
    return file
  }

  function classifyHttpError (status, payload) {
    const message = String((payload && payload.error) || `Upload failed with HTTP ${status || 0}`)
    const error = new Error(message)
    error.status = Number(status || 0)
    error.transient = !status || TRANSIENT_HTTP.has(Number(status))
    error.uncertain = !status || Number(status) >= 500
    return error
  }

  function xhrUpload (job, file, context) {
    if (typeof window.__FILEGRAM_UPLOAD_TRANSPORT__ === 'function') return window.__FILEGRAM_UPLOAD_TRANSPORT__(job, file, context)
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
      xhr.setRequestHeader('x-filegram-upload-id', encodeURIComponent(job.id))
      if (job.caption) xhr.setRequestHeader('x-caption', encodeURIComponent(job.caption))
      xhr.upload.onprogress = event => context.onProgress(event.loaded, event.lengthComputable ? event.total : (file.size || job.size || 0))
      xhr.onload = () => {
        let payload = null
        try { payload = JSON.parse(xhr.responseText || '{}') } catch { payload = {} }
        if (xhr.status >= 200 && xhr.status < 300) finish(resolve, payload)
        else finish(reject, classifyHttpError(xhr.status, payload))
      }
      xhr.onerror = () => finish(reject, classifyHttpError(0, null))
      xhr.ontimeout = () => finish(reject, classifyHttpError(0, { error: 'Upload request timed out' }))
      xhr.onabort = () => {
        const error = new Error('Upload aborted')
        error.code = 'ABORTED'
        finish(reject, error)
      }
      xhr.timeout = 0
      xhr.send(file)
    })
  }

  async function verifyDelivery (job) {
    if (typeof window.__FILEGRAM_UPLOAD_VERIFY__ === 'function') return !!(await window.__FILEGRAM_UPLOAD_VERIFY__(job))
    if (typeof request !== 'function') return false
    try {
      const result = await request('search-media', { chatId: job.chatId, query: job.name, fromMessageId: 0, limit: 50, filter: 'all' })
      const floor = Math.floor(Number(job.attemptStartedAt || job.startedAt || job.createdAt || Date.now()) / 1000) - 8
      const match = (result && result.items || []).find(item => item &&
        String(item.name || '') === String(job.name || '') &&
        (!Number(job.size || 0) || Number(item.fileSize || 0) === Number(job.size)) &&
        Number(item.date || 0) >= floor)
      if (!match) return false
      if (match.messageId != null) job.telegramMessageId = match.messageId
      return true
    } catch { return false }
  }

  function savedConcurrency () {
    const raw = Number(localStorage.getItem('filegram-upload-concurrency') || DEFAULT_CONCURRENCY)
    return Math.max(1, Math.min(MAX_CONCURRENCY, raw || DEFAULT_CONCURRENCY))
  }

  const queue = new Core.UploadQueue({
    concurrency: savedConcurrency(),
    maxConcurrency: MAX_CONCURRENCY,
    retryBaseMs: 2000,
    retryMaxMs: 30000,
    resolveSource,
    verifyDelivery,
    transport: xhrUpload,
    onChange: onQueueChange
  })

  function scheduleRender (immediate = false) {
    if (!mounted) return
    if (renderTimer != null) {
      if (!immediate) return
      clearTimeout(renderTimer)
      renderTimer = null
    }
    if (immediate) return render()
    // Progress can fire hundreds of times/second. Four UI paints per second is
    // plenty for a queue panel and keeps 50k-job stats cheap.
    renderTimer = setTimeout(() => {
      renderTimer = null
      render()
    }, 250)
  }

  function schedulePersist (job, delay = 0) {
    if (!job || !job.id) return
    const id = String(job.id)
    if (persistTimers.has(id)) clearTimeout(persistTimers.get(id))
    persistTimers.set(id, setTimeout(() => {
      persistTimers.delete(id)
      const latest = queue.jobs.get(id)
      if (latest) store.putJob(latest).catch(() => {})
      else store.deleteJobs([id]).catch(() => {})
    }, Math.max(0, delay)))
  }

  async function syncStoreWithQueue () {
    const existing = await store.getAllJobs().catch(() => [])
    const live = new Set(queue.order)
    const removed = existing.filter(job => !live.has(String(job.id))).map(job => job.id)
    if (removed.length) await store.deleteJobs(removed)
    await store.putMany(queue.order.map(id => queue.jobs.get(id)).filter(Boolean))
  }

  function onQueueChange (type, payload) {
    scheduleRender(type === 'clear-all' || type === 'clear-done' || type === 'cancel-all')
    if (type === 'clear-all') return void store.clearJobs().catch(() => {})
    if (type === 'clear-done') return void syncStoreWithQueue().catch(() => {})
    if (type === 'pause-all' || type === 'resume-all' || type === 'cancel-all') {
      return void store.putMany(queue.order.map(id => queue.jobs.get(id)).filter(Boolean)).catch(() => {})
    }
    // queueReviewed persists additions as one batch; restored records are already
    // on disk. Avoid creating tens of thousands of per-job timers here.
    if (type === 'added' || type === 'restored' || type === 'concurrency') return
    const jobs = Array.isArray(payload) ? payload : (payload && payload.id ? [payload] : [])
    for (const job of jobs) schedulePersist(job, type === 'progress' ? 1200 : 0)
  }

  function mediaIndexSnapshot (chatId) {
    try { return window.teleFilesIndex && typeof window.teleFilesIndex.snapshot === 'function' ? window.teleFilesIndex.snapshot(chatId) : null } catch { return null }
  }

  async function ensureIndexForDedupe (chatId) {
    try {
      if (window.teleFilesIndex && typeof window.teleFilesIndex.ensure === 'function') await window.teleFilesIndex.ensure(chatId)
    } catch {}
    return mediaIndexSnapshot(chatId)
  }

  function duplicateKey (name, size) {
    return `${String(name || '').trim().toLowerCase()}\u0000${Math.max(0, Number(size || 0))}`
  }

  async function analyzeCandidates (candidates, chatId) {
    const snapshot = await ensureIndexForDedupe(chatId)
    const remote = new Set()
    for (const item of (snapshot && snapshot.items) || []) remote.add(duplicateKey(item.name, item.fileSize))
    const queued = new Set()
    for (const job of queue.jobs.values()) {
      if (String(job.chatId) === String(chatId) && job.status !== 'cancelled') queued.add(duplicateKey(job.name, job.size))
    }
    const batchSeen = new Set()
    let batchDuplicateFiles = 0
    let queueDuplicateFiles = 0
    let remoteDuplicateFiles = 0
    let blocked = 0
    for (const candidate of candidates) {
      candidate.duplicateReasons = []
      candidate.validationError = ''
      if (!Number(candidate.size || 0)) candidate.validationError = 'Empty files cannot be uploaded'
      else if (Number(candidate.size) > MAX_FILE_BYTES) candidate.validationError = 'File exceeds FileGram’s 4 GB upload limit'
      if (candidate.validationError) blocked++
      const key = duplicateKey(candidate.name, candidate.size)
      if (batchSeen.has(key)) { candidate.duplicateReasons.push('same file already selected in this batch'); batchDuplicateFiles++ } else batchSeen.add(key)
      if (queued.has(key)) { candidate.duplicateReasons.push('same name and size already exists in the upload queue'); queueDuplicateFiles++ }
      if (remote.has(key)) { candidate.duplicateReasons.push('same name and size already exists in the channel index'); remoteDuplicateFiles++ }
    }
    return {
      total: candidates.length,
      totalBytes: candidates.reduce((sum, file) => sum + Number(file.size || 0), 0),
      duplicates: candidates.filter(file => file.duplicateReasons.length).length,
      blocked,
      batchDuplicateFiles,
      queueDuplicateFiles,
      remoteDuplicateFiles,
      remoteIndexed: snapshot && Array.isArray(snapshot.items) ? snapshot.items.length : 0,
      remoteComplete: !!(snapshot && snapshot.done !== false)
    }
  }

  async function validateDestination (chatId, fresh = false) {
    const id = String(chatId || '')
    if (!id) throw new Error('Choose a destination channel')
    if (!fresh && ownedChannels.has(id)) return ownedChannels.get(id)
    if (typeof request !== 'function') throw new Error('Telegram connection is not ready')
    const info = await request('get-chat-management', { chatId: Number(chatId) })
    if (!info || !info.permissions || !info.permissions.isOwner || !info.chat || info.chat.kind !== 'channel') {
      ownedChannels.delete(id)
      throw new Error('Bulk uploads are limited to channels owned by this Telegram account')
    }
    ownedChannels.set(id, info)
    return info
  }

  function selectedChannelId () { return $('#fg-upload-channel')?.value || '' }

  function updateDestinationNote (info) {
    const note = $('#fg-upload-destination-note')
    if (!note) return
    note.textContent = info ? `Owner · ${info.chat && info.chat.title ? info.chat.title : 'Channel'}` : 'Select a channel you own.'
  }

  async function refreshOwnedChannels () {
    const select = $('#fg-upload-channel')
    if (!select || typeof state === 'undefined') return
    const channels = (state.chats || []).filter(chat => chat && chat.kind === 'channel')
    const signature = channels.map(chat => `${chat.id}:${chat.title}`).join('|')
    if (signature === channelSignature && select.options.length > 1) return
    channelSignature = signature
    const token = ++channelRefreshToken
    const previous = select.value || select.dataset.restoreChatId || ''
    select.innerHTML = '<option value="">Checking owned channels…</option>'
    select.disabled = true
    const results = []
    let cursor = 0
    const workers = Array.from({ length: Math.min(4, channels.length || 1) }, async () => {
      while (cursor < channels.length) {
        const chat = channels[cursor++]
        try { results.push({ chat, info: await validateDestination(chat.id) }) } catch {}
      }
    })
    await Promise.all(workers)
    if (token !== channelRefreshToken) return
    results.sort((a, b) => String(a.chat.title || '').localeCompare(String(b.chat.title || '')))
    select.innerHTML = '<option value="">Select owned channel…</option>'
    for (const { chat } of results) {
      const option = document.createElement('option')
      option.value = String(chat.id)
      option.textContent = chat.title || 'Untitled channel'
      select.appendChild(option)
    }
    select.disabled = false
    const active = state.activeChatId != null ? String(state.activeChatId) : ''
    const wanted = [previous, active].find(value => value && [...select.options].some(option => option.value === value))
    if (wanted) select.value = wanted
    delete select.dataset.restoreChatId
    updateDestinationNote(select.value ? ownedChannels.get(select.value) : null)
  }

  function candidateFromFile (file, handle, relativePath) {
    return {
      id: uid(), name: file.name, relativePath: relativePath || file.name,
      size: file.size, type: file.type || 'application/octet-stream', lastModified: file.lastModified || 0,
      handle: handle || null, ephemeral: !handle, _source: file, duplicateReasons: [], validationError: ''
    }
  }

  async function chooseFiles () {
    try {
      if (window.showOpenFilePicker) {
        const handles = await window.showOpenFilePicker({ multiple: true })
        const candidates = []
        for (const handle of handles.slice(0, MAX_PICKED_FILES)) candidates.push(candidateFromFile(await handle.getFile(), handle, handle.name))
        if (handles.length > MAX_PICKED_FILES) safeToast(`Only the first ${fmtNumber(MAX_PICKED_FILES)} files were added`, 'error')
        await reviewFiles(candidates)
      } else {
        const input = $('#fg-upload-file-input')
        if (input) { input.value = ''; input.click() }
      }
    } catch (error) {
      if (error && error.name !== 'AbortError') safeToast(error.message || String(error), 'error')
    }
  }

  async function chooseFolder () {
    if (!window.showDirectoryPicker) return safeToast('Folder selection requires Chrome/Edge File System Access support', 'error')
    try {
      const root = await window.showDirectoryPicker()
      setPaneStatus('Scanning folder…')
      const candidates = []
      await walkDirectory(root, '', candidates)
      setPaneStatus('Auto-resume ready')
      if (candidates.length >= MAX_PICKED_FILES) safeToast(`Folder scan capped at ${fmtNumber(MAX_PICKED_FILES)} files`, 'error')
      await reviewFiles(candidates)
    } catch (error) {
      setPaneStatus('Auto-resume ready')
      if (error && error.name !== 'AbortError') safeToast(error.message || String(error), 'error')
    }
  }

  async function walkDirectory (handle, relative, out) {
    for await (const entry of handle.values()) {
      if (out.length >= MAX_PICKED_FILES) return
      if (entry.kind === 'directory') await walkDirectory(entry, relative ? `${relative}/${entry.name}` : entry.name, out)
      else if (entry.kind === 'file') {
        const file = await entry.getFile()
        out.push(candidateFromFile(file, entry, relative ? `${relative}/${file.name}` : file.name))
      }
      if (out.length && out.length % 500 === 0) { setPaneStatus(`Scanning folder… ${fmtNumber(out.length)} files`); await sleep(0) }
    }
  }

  function handleFallbackFiles (files) {
    const candidates = [...files].slice(0, MAX_PICKED_FILES).map(file => candidateFromFile(file, null, file.webkitRelativePath || file.name))
    reviewFiles(candidates).catch(error => safeToast(error.message || String(error), 'error'))
  }

  async function reviewFiles (candidates) {
    if (!candidates || !candidates.length) return
    const chatId = selectedChannelId()
    if (!chatId) return safeToast('Choose an owned destination channel first', 'error')
    let info
    try {
      setPaneStatus('Checking destination and duplicates…')
      info = await validateDestination(chatId, true)
      reviewAnalysis = await analyzeCandidates(candidates, chatId)
    } catch (error) {
      setPaneStatus('Auto-resume ready')
      return safeToast(error.message || String(error), 'error')
    }
    setPaneStatus('Auto-resume ready')
    reviewCandidates = candidates
    const modal = $('#fg-upload-review-modal')
    const destination = $('#fg-upload-review-destination')
    const stats = $('#fg-upload-review-stats')
    const list = $('#fg-upload-review-duplicates')
    const uniqueButton = $('#fg-upload-review-unique')
    const allButton = $('#fg-upload-review-all')
    if (!modal || !stats || !list) return
    destination.textContent = info.chat.title || 'Channel'
    stats.innerHTML = `
      <div><span>Files</span><strong>${fmtNumber(reviewAnalysis.total)}</strong></div>
      <div><span>Total size</span><strong>${fmtSize(reviewAnalysis.totalBytes)}</strong></div>
      <div><span>Duplicates</span><strong>${fmtNumber(reviewAnalysis.duplicates)}</strong></div>
      <div><span>Blocked</span><strong>${fmtNumber(reviewAnalysis.blocked)}</strong></div>`
    list.replaceChildren()
    const issues = candidates.filter(file => file.validationError || file.duplicateReasons.length)
    if (!issues.length) {
      const empty = document.createElement('div')
      empty.className = 'fg-up-review-clean'
      empty.textContent = `No duplicates detected · ${fmtNumber(reviewAnalysis.remoteIndexed)} channel files indexed`
      list.appendChild(empty)
    } else {
      const summary = document.createElement('div')
      summary.className = 'fg-up-review-duplicate-summary'
      summary.textContent = `${fmtNumber(reviewAnalysis.batchDuplicateFiles)} repeated in this selection · ${fmtNumber(reviewAnalysis.queueDuplicateFiles)} already queued · ${fmtNumber(reviewAnalysis.remoteDuplicateFiles)} found in channel · ${fmtNumber(reviewAnalysis.blocked)} blocked`
      list.appendChild(summary)
      for (const file of issues.slice(0, 40)) {
        const row = document.createElement('div')
        row.className = 'fg-up-review-row'
        row.innerHTML = '<strong></strong><span></span>'
        row.querySelector('strong').textContent = file.relativePath || file.name
        row.querySelector('span').textContent = [file.validationError, ...file.duplicateReasons].filter(Boolean).join(' · ')
        list.appendChild(row)
      }
      if (issues.length > 40) {
        const more = document.createElement('div')
        more.className = 'fg-up-review-more'
        more.textContent = `+ ${fmtNumber(issues.length - 40)} more files with warnings`
        list.appendChild(more)
      }
    }
    const uniqueCount = candidates.filter(file => !file.validationError && !file.duplicateReasons.length).length
    uniqueButton.textContent = reviewAnalysis.duplicates || reviewAnalysis.blocked ? `Queue unique (${fmtNumber(uniqueCount)})` : `Queue uploads (${fmtNumber(uniqueCount)})`
    allButton.hidden = reviewAnalysis.duplicates === 0
    modal.classList.remove('hidden')
  }

  async function queueReviewed (keepDuplicates) {
    const chatId = selectedChannelId()
    if (!chatId || !reviewCandidates.length) return
    let info
    try { info = await validateDestination(chatId, true) } catch (error) { return safeToast(error.message || String(error), 'error') }
    const caption = String($('#fg-upload-caption')?.value || '').trim().slice(0, 1024)
    const chosen = reviewCandidates.filter(file => !file.validationError && (keepDuplicates || !file.duplicateReasons.length))
    if (!chosen.length) { closeReview(); return safeToast('Nothing eligible was queued') }
    const now = Date.now()
    const descriptors = chosen.map(file => ({
      ...file, chatId: Number(chatId), chatTitle: info.chat.title || 'Channel', caption,
      allowDuplicate: keepDuplicates && file.duplicateReasons.length > 0, status: 'queued', createdAt: now
    }))
    const added = queue.add(descriptors)
    const persisted = added.map(job => queue.jobs.get(String(job.id))).filter(Boolean)
    await store.putMany(persisted).catch(error => safeToast(`Queue persistence warning: ${error.message || error}`, 'error'))
    closeReview()
    scheduleRender(true)
    safeToast(`${fmtNumber(added.length)} file${added.length === 1 ? '' : 's'} queued for ${info.chat.title}`)
  }

  function closeReview () {
    reviewCandidates = []
    reviewAnalysis = null
    $('#fg-upload-review-modal')?.classList.add('hidden')
  }

  async function grantAndResume () {
    for (const job of [...queue.jobs.values()].filter(job => job.status === 'needs_access')) {
      if (!job.handle || typeof job.handle.requestPermission !== 'function') continue
      try { if (await job.handle.requestPermission({ mode: 'read' }) === 'granted') queue.resume(job.id) } catch {}
    }
    queue.resumeAll()
  }

  async function relinkJob (jobId) {
    const job = queue.jobs.get(String(jobId))
    if (!job) return
    try {
      let file = null
      let handle = null
      if (window.showOpenFilePicker) {
        const handles = await window.showOpenFilePicker({ multiple: false })
        handle = handles[0]
        file = handle && await handle.getFile()
      } else {
        const input = $('#fg-upload-relink-input')
        if (!input) return
        input.dataset.jobId = String(job.id)
        input.value = ''
        input.click()
        return
      }
      if (!file) return
      if (file.name !== job.name || file.size !== job.size) throw new Error('Choose the same source file (matching name and size)')
      queue.attachSource(job.id, file, handle)
    } catch (error) {
      if (error && error.name !== 'AbortError') safeToast(error.message || String(error), 'error')
    }
  }

  function setPaneStatus (text) { const el = $('#fg-upload-status'); if (el) el.textContent = text }

  function statusLabel (job) {
    if (job.status === 'queued') return 'Queued'
    if (job.status === 'uploading') return job.progress >= 1 ? 'Sending to Telegram…' : `${Math.round((job.progress || 0) * 100)}%`
    if (job.status === 'retrying') return `Retrying in ${Math.max(1, Math.ceil((Number(job.retryAt || 0) - Date.now()) / 1000))}s`
    if (job.status === 'verifying') return 'Verifying delivery'
    if (job.status === 'paused') return 'Paused'
    if (job.status === 'needs_access') return 'Needs file access'
    if (job.status === 'completed') return job.recovered ? 'Completed · recovered' : 'Completed'
    if (job.status === 'failed') return 'Failed'
    if (job.status === 'cancelled') return 'Cancelled'
    return job.status
  }

  function render () {
    if (!mounted) return
    const stats = queue.stats()
    const values = {
      '#fg-upload-speed': fmtSpeed(stats.speed), '#fg-upload-completed': fmtNumber(stats.completed),
      '#fg-upload-remaining': fmtNumber(stats.remaining), '#fg-upload-total': `${fmtNumber(stats.total)} files`
    }
    for (const [selector, text] of Object.entries(values)) { const node = $(selector); if (node && node.textContent !== text) node.textContent = text }
    const concurrency = $('#fg-upload-concurrency')
    if (concurrency && concurrency.value !== String(stats.concurrency)) concurrency.value = String(stats.concurrency)
    const concurrencyValue = $('#fg-upload-concurrency-value')
    if (concurrencyValue) concurrencyValue.textContent = String(stats.concurrency)

    const total = queue.order.length
    const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
    currentPage = Math.min(Math.max(1, currentPage), pages)
    const start = (currentPage - 1) * PAGE_SIZE
    const ids = queue.order.slice(start, start + PAGE_SIZE)
    const host = $('#fg-upload-list')
    if (host) {
      const fragment = document.createDocumentFragment()
      for (const id of ids) {
        const job = queue.get(id)
        if (job) fragment.appendChild(renderJob(job))
      }
      host.replaceChildren(fragment)
    }
    const summary = $('#fg-upload-page-summary')
    if (summary) summary.textContent = `${fmtNumber(total ? start + 1 : 0)}–${fmtNumber(Math.min(total, start + PAGE_SIZE))} of ${fmtNumber(total)}`
    const pageLabel = $('#fg-upload-page-label')
    if (pageLabel) pageLabel.textContent = `Page ${fmtNumber(currentPage)} of ${fmtNumber(pages)}`
    if ($('#fg-upload-prev')) $('#fg-upload-prev').disabled = currentPage <= 1
    if ($('#fg-upload-next')) $('#fg-upload-next').disabled = currentPage >= pages
    if ($('#fg-upload-pause-all')) $('#fg-upload-pause-all').disabled = stats.remaining === 0 || queue.globalPaused
    if ($('#fg-upload-resume-all')) $('#fg-upload-resume-all').disabled = stats.paused === 0 && stats.needsAccess === 0 && !queue.globalPaused
    if ($('#fg-upload-cancel-all')) $('#fg-upload-cancel-all').disabled = stats.remaining === 0
    if ($('#fg-upload-clear-done')) $('#fg-upload-clear-done').disabled = stats.completed === 0 && stats.cancelled === 0
    if ($('#fg-upload-clear-all')) $('#fg-upload-clear-all').disabled = stats.total === 0
  }

  function renderJob (job) {
    const row = document.createElement('div')
    row.className = `fg-up-job is-${job.status}`
    row.dataset.jobId = job.id
    const progress = Math.round((job.progress || 0) * 100)
    const meta = [fmtSize(job.size), job.chatTitle]
    if (job.status === 'uploading' && job.progress < 1 && job.speed) meta.push(fmtSpeed(job.speed))
    row.innerHTML = `
      <div class="fg-up-job-main"><div class="fg-up-job-name"></div><div class="fg-up-job-meta"></div><div class="fg-up-progress"><span style="width:${progress}%"></span></div>${job.error ? '<div class="fg-up-job-error"></div>' : ''}</div>
      <div class="fg-up-job-status"></div><div class="fg-up-job-actions"></div>`
    row.querySelector('.fg-up-job-name').textContent = job.relativePath || job.name
    row.querySelector('.fg-up-job-meta').textContent = meta.filter(Boolean).join(' · ')
    row.querySelector('.fg-up-job-status').textContent = statusLabel(job)
    const error = row.querySelector('.fg-up-job-error'); if (error) error.textContent = job.error
    const actions = row.querySelector('.fg-up-job-actions')
    const add = (label, fn, cls = '') => {
      const button = document.createElement('button')
      button.type = 'button'; button.className = `ghost small ${cls}`.trim(); button.textContent = label
      button.onclick = event => { event.stopPropagation(); fn() }
      actions.appendChild(button)
    }
    if (['uploading', 'queued', 'retrying', 'verifying'].includes(job.status)) add('Pause', () => queue.pause(job.id))
    if (job.status === 'paused') add('Resume', () => queue.resume(job.id))
    if (job.status === 'failed') add('Retry', () => queue.retry(job.id))
    if (job.status === 'needs_access') add('Locate', () => relinkJob(job.id))
    if (['queued', 'uploading', 'retrying', 'verifying', 'paused', 'needs_access'].includes(job.status)) add('Cancel', () => queue.cancel(job.id), 'danger')
    return row
  }

  function showUploads () {
    const pane = $('#mg-uploads-pane'); const downloads = $('#mg-downloads-pane'); const info = $('#mg-info-pane')
    if (!pane || !downloads || !info) return
    downloads.classList.add('hidden'); info.classList.add('hidden'); pane.classList.remove('hidden')
    $('#mg-tab-downloads')?.classList.remove('active'); $('#mg-tab-info')?.classList.remove('active'); $('#mg-tab-uploads')?.classList.add('active')
    try { localStorage.setItem('filegram-right-panel-v2', 'uploads') } catch {}
    refreshOwnedChannels().catch(() => {})
    scheduleRender(true)
  }

  function hideUploads () {
    $('#mg-uploads-pane')?.classList.add('hidden')
    $('#mg-tab-uploads')?.classList.remove('active')
    try { if (localStorage.getItem('filegram-right-panel-v2') === 'uploads') localStorage.setItem('filegram-right-panel-v2', 'other') } catch {}
  }

  function ensureReviewModal () {
    if ($('#fg-upload-review-modal')) return
    const modal = document.createElement('div')
    modal.id = 'fg-upload-review-modal'; modal.className = 'fg-up-modal hidden'
    modal.innerHTML = `
      <div class="fg-up-review" role="dialog" aria-modal="true" aria-labelledby="fg-upload-review-title">
        <div class="fg-up-review-head"><div><span class="fg-up-kicker">Bulk upload review</span><h3 id="fg-upload-review-title">Queue files to <span id="fg-upload-review-destination">channel</span></h3></div><button id="fg-upload-review-close" class="ghost small" type="button">✕</button></div>
        <div id="fg-upload-review-stats" class="fg-up-review-stats"></div>
        <div id="fg-upload-review-duplicates" class="fg-up-review-duplicates"></div>
        <div class="fg-up-review-note">Duplicate evidence uses exact filename + size against this batch, the current queue, and the destination channel’s committed FileGram index. Nothing is silently removed. Blocked files are never queued.</div>
        <div class="fg-up-review-actions"><button id="fg-upload-review-cancel" class="ghost" type="button">Cancel</button><button id="fg-upload-review-all" class="ghost" type="button">Upload duplicates anyway</button><button id="fg-upload-review-unique" type="button">Queue uploads</button></div>
      </div>`
    document.body.appendChild(modal)
    modal.onmousedown = event => { if (event.target === modal) closeReview() }
    $('#fg-upload-review-close').onclick = closeReview
    $('#fg-upload-review-cancel').onclick = closeReview
    $('#fg-upload-review-unique').onclick = () => queueReviewed(false)
    $('#fg-upload-review-all').onclick = () => queueReviewed(true)
  }

  function createUi () {
    const tabs = $('.mg-drawer-tabs'); const drawer = $('.downloads')
    if (!tabs || !drawer) return false
    if ($('#mg-tab-uploads')) { mounted = true; return true }
    const tab = document.createElement('button')
    tab.id = 'mg-tab-uploads'; tab.type = 'button'; tab.className = 'mg-drawer-tab fg-up-tab'
    tab.innerHTML = '<span class="fg-up-tab-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 19V5m0 0-5 5m5-5 5 5"/><path d="M5 19h14"/></svg></span><span>Uploads</span>'
    tab.onclick = showUploads
    const infoTab = $('#mg-tab-info'); if (infoTab) tabs.insertBefore(tab, infoTab); else tabs.appendChild(tab)

    const pane = document.createElement('div')
    pane.id = 'mg-uploads-pane'; pane.className = 'mg-drawer-pane fg-up-pane hidden'
    pane.innerHTML = `
      <section class="fg-up-section fg-up-destination"><div class="fg-up-section-head"><span>Destination</span><small id="fg-upload-status">Auto-resume ready</small></div><select id="fg-upload-channel" class="mg-select"><option value="">Select owned channel…</option></select><div id="fg-upload-destination-note" class="fg-up-note">Select a channel you own.</div><label class="fg-up-caption"><span>Common caption <small>optional</small></span><input id="fg-upload-caption" maxlength="1024" placeholder="Applied to every queued file"></label><div class="fg-up-add-row"><button id="fg-upload-add-files" type="button">Add files</button><button id="fg-upload-add-folder" type="button" class="ghost">Add folder</button></div></section>
      <section class="fg-up-stats"><div class="fg-up-stat"><span>Speed</span><strong id="fg-upload-speed">0 B/s</strong></div><div class="fg-up-stat"><span>Uploaded</span><strong id="fg-upload-completed">0</strong></div><div class="fg-up-stat"><span>Remaining</span><strong id="fg-upload-remaining">0</strong></div><div class="fg-up-stat fg-up-total"><span>Total</span><strong id="fg-upload-total">0 files</strong></div></section>
      <section class="fg-up-section"><div class="fg-up-section-head"><span>Parallel files</span><strong id="fg-upload-concurrency-value">${queue.concurrency}</strong></div><input id="fg-upload-concurrency" class="fg-up-range" type="range" min="1" max="${MAX_CONCURRENCY}" step="1" value="${queue.concurrency}"></section>
      <section class="fg-up-actions"><button id="fg-upload-pause-all" type="button" class="ghost">Pause all</button><button id="fg-upload-resume-all" type="button" class="ghost">Resume all</button><button id="fg-upload-cancel-all" type="button" class="ghost danger">Cancel all</button><button id="fg-upload-clear-done" type="button" class="ghost">Clear done</button><button id="fg-upload-clear-all" type="button" class="danger fg-up-clear-all">Clear all</button></section>
      <section class="fg-up-queue"><div class="fg-up-queue-head"><span id="fg-upload-page-summary">0–0 of 0</span><span>100 / page</span></div><div id="fg-upload-list" class="fg-up-list"></div><div class="fg-up-pager"><button id="fg-upload-prev" class="ghost small" type="button">‹ Previous</button><span id="fg-upload-page-label">Page 1 of 1</span><button id="fg-upload-next" class="ghost small" type="button">Next ›</button></div></section>`
    const infoPane = $('#mg-info-pane'); if (infoPane) drawer.insertBefore(pane, infoPane); else drawer.appendChild(pane)

    const input = document.createElement('input')
    input.id = 'fg-upload-file-input'; input.type = 'file'; input.multiple = true; input.hidden = true
    input.onchange = () => handleFallbackFiles(input.files || [])
    document.body.appendChild(input)
    const relink = document.createElement('input')
    relink.id = 'fg-upload-relink-input'; relink.type = 'file'; relink.hidden = true
    relink.onchange = () => {
      const job = queue.jobs.get(String(relink.dataset.jobId || '')); const file = relink.files && relink.files[0]
      if (!job || !file) return
      if (file.name !== job.name || file.size !== job.size) return safeToast('Choose the same source file (matching name and size)', 'error')
      queue.attachSource(job.id, file, null)
    }
    document.body.appendChild(relink)
    ensureReviewModal(); bindUi(); mounted = true
    return true
  }

  function bindUi () {
    $('#fg-upload-add-files').onclick = chooseFiles
    $('#fg-upload-add-folder').onclick = chooseFolder
    $('#fg-upload-channel').onchange = () => {
      const id = selectedChannelId(); updateDestinationNote(id ? ownedChannels.get(id) : null)
      if (id) store.setMeta('lastChatId', id).catch(() => {})
    }
    $('#fg-upload-concurrency').oninput = event => {
      const value = queue.setConcurrency(event.target.value)
      localStorage.setItem('filegram-upload-concurrency', String(value)); store.setMeta('concurrency', value).catch(() => {})
    }
    $('#fg-upload-pause-all').onclick = () => queue.pauseAll()
    $('#fg-upload-resume-all').onclick = grantAndResume
    $('#fg-upload-cancel-all').onclick = () => { if (queue.stats().remaining && confirm('Cancel every queued and active upload?')) queue.cancelAll() }
    $('#fg-upload-clear-done').onclick = () => queue.clearDone()
    $('#fg-upload-clear-all').onclick = () => { if (queue.stats().total && confirm('Cancel active uploads and clear the entire upload queue?')) queue.clearAll() }
    $('#fg-upload-prev').onclick = () => { currentPage = Math.max(1, currentPage - 1); render() }
    $('#fg-upload-next').onclick = () => { currentPage++; render() }
    $('#mg-tab-downloads')?.addEventListener('click', hideUploads)
    $('#mg-tab-info')?.addEventListener('click', hideUploads)
    $('#mg-open-info')?.addEventListener('click', hideUploads)
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('#fg-upload-review-modal')?.classList.contains('hidden')) closeReview() })

    const chatList = $('#chat-list')
    if (chatList && !channelObserver) {
      let timer = null
      channelObserver = new MutationObserver(() => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => refreshOwnedChannels().catch(() => {}), 250)
      })
      channelObserver.observe(chatList, { childList: true, subtree: true, characterData: true })
    }
  }

  async function restoreQueue () {
    const records = await store.getAllJobs().catch(() => [])
    if (records.length) queue.restore(records)
    const concurrency = Number(await store.getMeta('concurrency').catch(() => 0)); if (concurrency) queue.setConcurrency(concurrency)
    const select = $('#fg-upload-channel'); const lastChatId = await store.getMeta('lastChatId').catch(() => null)
    if (select && lastChatId) select.dataset.restoreChatId = String(lastChatId)
  }

  async function install () {
    if (!createUi()) return false
    await Promise.all([restoreQueue(), refreshOwnedChannels()])
    let saved = ''; try { saved = localStorage.getItem('filegram-right-panel-v2') || '' } catch {}
    if (saved === 'uploads') showUploads()
    scheduleRender(true)
    return true
  }

  window.FileGramUploads = {
    open: showUploads,
    refreshChannels: refreshOwnedChannels,
    snapshot: () => ({ stats: queue.stats(), jobs: queue.list(), selectedChatId: selectedChannelId() }),
    queue
  }

  let tries = 0
  let installing = false
  const installTimer = setInterval(() => {
    if (mounted) return clearInterval(installTimer)
    if (installing) return
    if (++tries > 200) return clearInterval(installTimer)
    installing = true
    install().then(ok => { if (ok) clearInterval(installTimer) }).catch(() => {}).finally(() => { installing = false })
  }, 50)
})()
