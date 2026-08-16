'use strict'

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
  const TRANSIENT_HTTP = new Set([408, 425, 429, 500, 502, 503, 504])

  const $ = selector => document.querySelector(selector)
  const fmtNumber = value => Math.max(0, Number(value || 0)).toLocaleString()
  const fmtSize = bytes => {
    let n = Math.max(0, Number(bytes || 0))
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let unit = 0
    while (n >= 1024 && unit < units.length - 1) { n /= 1024; unit++ }
    return `${unit ? n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2) : Math.round(n)} ${units[unit]}`
  }
  const fmtSpeed = bytes => `${fmtSize(bytes)}/s`
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `up-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  function safeToast (message, kind) {
    try {
      if (typeof toast === 'function') toast(message, kind)
      else console[kind === 'error' ? 'error' : 'log'](message)
    } catch {}
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
      const clean = { ...job }
      delete clean._source
      delete clean._progressAt
      delete clean._progressBytes
      delete clean._abortIntent
      const write = value => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_JOBS, 'readwrite')
        tx.objectStore(STORE_JOBS).put(value)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error || new Error('Upload database write aborted'))
      })
      try {
        await write(clean)
      } catch (error) {
        if (!clean.handle) throw error
        clean.handle = null
        clean.ephemeral = true
        await write(clean)
      }
    }

    async putMany (jobs) {
      for (let index = 0; index < jobs.length; index += 200) {
        await Promise.all(jobs.slice(index, index + 200).map(job => this.putJob(job)))
        await sleep(0)
      }
    }

    async deleteJobs (ids) {
      if (!ids.length) return
      const db = await this.open()
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_JOBS, 'readwrite')
        const store = tx.objectStore(STORE_JOBS)
        for (const id of ids) store.delete(String(id))
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
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
  let renderFrame = 0
  let currentPage = 1
  let reviewCandidates = []
  let reviewAnalysis = null
  let channelRefreshToken = 0
  let channelSignature = ''
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
    error.status = status || 0
    error.transient = !status || TRANSIENT_HTTP.has(status)
    error.uncertain = !status || status >= 500
    return error
  }

  function xhrUpload (job, file, context) {
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
      const abort = () => {
        try { xhr.abort() } catch {}
      }
      context.signal.addEventListener('abort', abort, { once: true })
      xhr.open('POST', `/api/chat-attachment/${encodeURIComponent(String(job.chatId))}`)
      xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name || job.name || 'file'))
      xhr.setRequestHeader('x-mime-type', encodeURIComponent(file.type || job.type || 'application/octet-stream'))
      if (job.caption) xhr.setRequestHeader('x-caption', encodeURIComponent(job.caption))
      xhr.upload.onprogress = event => {
        const total = event.lengthComputable ? event.total : (file.size || job.size || 0)
        context.onProgress(event.loaded, total)
      }
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
    if (typeof window.__FILEGRAM_UPLOAD_VERIFY__ === 'function') {
      return !!(await window.__FILEGRAM_UPLOAD_VERIFY__(job))
    }
    if (typeof request !== 'function') return false
    try {
      const result = await request('search-media', {
        chatId: job.chatId,
        query: job.name,
        fromMessageId: 0,
        limit: 50,
        filter: 'all'
      })
      const floor = Math.floor(Number(job.attemptStartedAt || job.startedAt || job.createdAt || Date.now()) / 1000) - 8
      const match = (result && result.items || []).find(item => {
        if (!item) return false
        if (String(item.name || '') !== String(job.name || '')) return false
        if (Number(job.size || 0) && Number(item.fileSize || 0) !== Number(job.size)) return false
        return Number(item.date || 0) >= floor
      })
      if (!match) return false
      if (match.messageId != null) job.telegramMessageId = match.messageId
      return true
    } catch {
      return false
    }
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

  function onQueueChange (type, payload) {
    scheduleRender()
    if (type === 'clear-all') {
      store.clearJobs().catch(() => {})
      return
    }
    if (type === 'clear-done') {
      syncStoreWithQueue().catch(() => {})
      return
    }
    const jobs = Array.isArray(payload) ? payload : (payload && payload.id ? [payload] : [])
    if (!jobs.length || type === 'concurrency') return
    for (const job of jobs) schedulePersist(job, type === 'progress' ? 1200 : 0)
  }

  function schedulePersist (job, delay) {
    if (!job || !job.id) return
    const id = String(job.id)
    if (persistTimers.has(id)) clearTimeout(persistTimers.get(id))
    persistTimers.set(id, setTimeout(() => {
      persistTimers.delete(id)
      const latest = queue.jobs.get(id)
      if (latest) store.putJob(latest).catch(() => {})
      else store.deleteJobs([id]).catch(() => {})
    }, Math.max(0, delay || 0)))
  }

  async function syncStoreWithQueue () {
    const existing = await store.getAllJobs().catch(() => [])
    const live = new Set(queue.order)
    const deleted = existing.filter(job => !live.has(String(job.id))).map(job => job.id)
    if (deleted.length) await store.deleteJobs(deleted)
    await store.putMany(queue.order.map(id => queue.jobs.get(id)).filter(Boolean))
  }

  function scheduleRender () {
    if (renderFrame) return
    renderFrame = requestAnimationFrame(() => {
      renderFrame = 0
      render()
    })
  }

  function mediaIndexSnapshot (chatId) {
    try {
      return window.teleFilesIndex && typeof window.teleFilesIndex.snapshot === 'function'
        ? window.teleFilesIndex.snapshot(chatId)
        : null
    } catch { return null }
  }

  async function ensureIndexForDedupe (chatId) {
    try {
      if (window.teleFilesIndex && typeof window.teleFilesIndex.ensure === 'function') {
        await window.teleFilesIndex.ensure(chatId)
      }
    } catch {}
    return mediaIndexSnapshot(chatId)
  }

  function duplicateKey (name, size) {
    return `${String(name || '').trim().toLowerCase()}\u0000${Math.max(0, Number(size || 0))}`
  }

  function localFingerprint (candidate) {
    return duplicateKey(candidate.name, candidate.size)
  }

  async function analyzeDuplicates (candidates, chatId) {
    const snapshot = await ensureIndexForDedupe(chatId)
    const remote = new Map()
    for (const item of (snapshot && snapshot.items) || []) {
      const key = duplicateKey(item.name, item.fileSize)
      if (!remote.has(key)) remote.set(key, item)
    }
    const queued = new Map()
    for (const job of queue.jobs.values()) {
      if (String(job.chatId) !== String(chatId) || job.status === 'cancelled') continue
      const key = duplicateKey(job.name, job.size)
      if (!queued.has(key)) queued.set(key, job)
    }
    const batchSeen = new Map()
    let batchDuplicateFiles = 0
    let queueDuplicateFiles = 0
    let remoteDuplicateFiles = 0
    for (const candidate of candidates) {
      candidate.duplicateReasons = []
      const fingerprint = localFingerprint(candidate)
      if (batchSeen.has(fingerprint)) {
        candidate.duplicateReasons.push('same file already selected in this batch')
        batchDuplicateFiles++
      } else batchSeen.set(fingerprint, candidate)
      const key = duplicateKey(candidate.name, candidate.size)
      if (queued.has(key)) {
        candidate.duplicateReasons.push('same name and size already exists in the upload queue')
        queueDuplicateFiles++
      }
      if (remote.has(key)) {
        candidate.duplicateReasons.push('same name and size already exists in the channel index')
        remoteDuplicateFiles++
      }
    }
    return {
      total: candidates.length,
      totalBytes: candidates.reduce((sum, file) => sum + Number(file.size || 0), 0),
      duplicates: candidates.filter(file => file.duplicateReasons.length).length,
      batchDuplicateFiles,
      queueDuplicateFiles,
      remoteDuplicateFiles,
      remoteIndexed: snapshot && Array.isArray(snapshot.items) ? snapshot.items.length : 0,
      remoteComplete: !!(snapshot && snapshot.done !== false)
    }
  }

  async function validateDestination (chatId, quiet = false) {
    const id = String(chatId || '')
    if (!id) throw new Error('Choose a destination channel')
    if (ownedChannels.has(id)) return ownedChannels.get(id)
    if (typeof request !== 'function') throw new Error('Telegram connection is not ready')
    const info = await request('get-chat-management', { chatId: Number(chatId) })
    if (!info || !info.permissions || !info.permissions.isOwner || !info.chat || info.chat.kind !== 'channel') {
      throw new Error('Bulk uploads are limited to channels owned by this Telegram account')
    }
    ownedChannels.set(id, info)
    if (!quiet) updateDestinationNote(info)
    return info
  }

  function selectedChannelId () {
    return $('#fg-upload-channel')?.value || ''
  }

  function updateDestinationNote (info) {
    const note = $('#fg-upload-destination-note')
    if (!note) return
    if (!info) {
      note.textContent = 'Select a channel you own.'
      return
    }
    note.textContent = `Owner · ${info.chat && info.chat.title ? info.chat.title : 'Channel'}`
  }

  async function refreshOwnedChannels () {
    const select = $('#fg-upload-channel')
    if (!select || typeof state === 'undefined') return
    const channels = (state.chats || []).filter(chat => chat && chat.kind === 'channel')
    const signature = channels.map(chat => `${chat.id}:${chat.title}`).join('|')
    if (signature === channelSignature && select.options.length > 1) return
    channelSignature = signature
    const token = ++channelRefreshToken
    const previous = select.value
    select.innerHTML = '<option value="">Checking owned channels…</option>'
    select.disabled = true

    const results = []
    let cursor = 0
    const workers = Array.from({ length: Math.min(4, channels.length || 1) }, async () => {
      while (cursor < channels.length) {
        const chat = channels[cursor++]
        try {
          const info = await validateDestination(chat.id, true)
          if (info) results.push({ chat, info })
        } catch {}
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
    if (select.value) updateDestinationNote(ownedChannels.get(select.value))
    else updateDestinationNote(null)
  }

  async function chooseFiles () {
    try {
      if (window.showOpenFilePicker) {
        const handles = await window.showOpenFilePicker({ multiple: true })
        const candidates = []
        for (const handle of handles.slice(0, MAX_PICKED_FILES)) {
          const file = await handle.getFile()
          candidates.push(candidateFromFile(file, handle, file.name))
        }
        if (handles.length > MAX_PICKED_FILES) safeToast(`Only the first ${fmtNumber(MAX_PICKED_FILES)} files were added`, 'error')
        await reviewFiles(candidates)
        return
      }
      const input = $('#fg-upload-file-input')
      if (input) {
        input.value = ''
        input.click()
      }
    } catch (error) {
      if (error && error.name === 'AbortError') return
      safeToast(error.message || String(error), 'error')
    }
  }

  async function chooseFolder () {
    if (!window.showDirectoryPicker) {
      safeToast('Folder selection requires a Chromium browser with the File System Access API', 'error')
      return
    }
    try {
      const root = await window.showDirectoryPicker()
      setPaneStatus('Scanning folder…')
      const candidates = []
      await walkDirectory(root, '', candidates)
      setPaneStatus('Auto-resume ready')
      await reviewFiles(candidates)
    } catch (error) {
      setPaneStatus('Auto-resume ready')
      if (error && error.name === 'AbortError') return
      safeToast(error.message || String(error), 'error')
    }
  }

  async function walkDirectory (directoryHandle, relative, out) {
    for await (const entry of directoryHandle.values()) {
      if (out.length >= MAX_PICKED_FILES) break
      if (entry.kind === 'directory') {
        const next = relative ? `${relative}/${entry.name}` : entry.name
        await walkDirectory(entry, next, out)
      } else if (entry.kind === 'file') {
        const file = await entry.getFile()
        const relativePath = relative ? `${relative}/${file.name}` : file.name
        out.push(candidateFromFile(file, entry, relativePath))
      }
      if (out.length && out.length % 500 === 0) {
        setPaneStatus(`Scanning folder… ${fmtNumber(out.length)} files`)
        await sleep(0)
      }
    }
  }

  function candidateFromFile (file, handle, relativePath) {
    return {
      id: uid(),
      name: file.name,
      relativePath: relativePath || file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      lastModified: file.lastModified || 0,
      handle: handle || null,
      ephemeral: !handle,
      _source: file,
      duplicateReasons: []
    }
  }

  async function reviewFiles (candidates) {
    if (!candidates || !candidates.length) return
    const chatId = selectedChannelId()
    if (!chatId) {
      safeToast('Choose an owned destination channel first', 'error')
      return
    }
    let info
    try {
      setPaneStatus('Checking destination and duplicates…')
      info = await validateDestination(chatId)
      reviewAnalysis = await analyzeDuplicates(candidates, chatId)
    } catch (error) {
      safeToast(error.message || String(error), 'error')
      setPaneStatus('Auto-resume ready')
      return
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
      <div><span>Channel index</span><strong>${fmtNumber(reviewAnalysis.remoteIndexed)}</strong></div>`
    list.replaceChildren()
    const duplicateFiles = candidates.filter(file => file.duplicateReasons.length)
    if (!duplicateFiles.length) {
      const empty = document.createElement('div')
      empty.className = 'fg-up-review-clean'
      empty.textContent = 'No duplicates detected. These files are ready to queue.'
      list.appendChild(empty)
    } else {
      const summary = document.createElement('div')
      summary.className = 'fg-up-review-duplicate-summary'
      summary.textContent = `${fmtNumber(reviewAnalysis.batchDuplicateFiles)} repeated in this selection · ${fmtNumber(reviewAnalysis.queueDuplicateFiles)} already queued · ${fmtNumber(reviewAnalysis.remoteDuplicateFiles)} found in the channel index`
      list.appendChild(summary)
      for (const file of duplicateFiles.slice(0, 40)) {
        const row = document.createElement('div')
        row.className = 'fg-up-review-row'
        row.innerHTML = `<strong></strong><span></span>`
        row.querySelector('strong').textContent = file.relativePath || file.name
        row.querySelector('span').textContent = file.duplicateReasons.join(' · ')
        list.appendChild(row)
      }
      if (duplicateFiles.length > 40) {
        const more = document.createElement('div')
        more.className = 'fg-up-review-more'
        more.textContent = `+ ${fmtNumber(duplicateFiles.length - 40)} more duplicate candidates`
        list.appendChild(more)
      }
    }
    uniqueButton.textContent = reviewAnalysis.duplicates ? `Queue unique (${fmtNumber(reviewAnalysis.total - reviewAnalysis.duplicates)})` : `Queue uploads (${fmtNumber(reviewAnalysis.total)})`
    allButton.hidden = reviewAnalysis.duplicates === 0
    modal.classList.remove('hidden')
  }

  async function queueReviewed (keepDuplicates) {
    const chatId = selectedChannelId()
    if (!chatId || !reviewCandidates.length) return
    let info
    try { info = await validateDestination(chatId) } catch (error) {
      safeToast(error.message || String(error), 'error')
      return
    }
    const caption = String($('#fg-upload-caption')?.value || '').trim().slice(0, 1024)
    const chosen = keepDuplicates ? reviewCandidates : reviewCandidates.filter(file => !file.duplicateReasons.length)
    if (!chosen.length) {
      closeReview()
      safeToast('Every selected file was a duplicate; nothing was queued')
      return
    }
    const descriptors = chosen.map(file => ({
      ...file,
      chatId: Number(chatId),
      chatTitle: info.chat.title || 'Channel',
      caption,
      allowDuplicate: keepDuplicates && file.duplicateReasons.length > 0,
      status: 'queued',
      createdAt: Date.now()
    }))
    const added = queue.add(descriptors)
    await store.putMany(queue.order.map(id => queue.jobs.get(id)).filter(job => added.some(a => a.id === job.id))).catch(() => {})
    closeReview()
    safeToast(`${fmtNumber(added.length)} file${added.length === 1 ? '' : 's'} queued for ${info.chat.title}`)
  }

  function closeReview () {
    reviewCandidates = []
    reviewAnalysis = null
    $('#fg-upload-review-modal')?.classList.add('hidden')
  }

  async function grantAndResume () {
    const jobs = [...queue.jobs.values()].filter(job => job.status === 'needs_access')
    for (const job of jobs) {
      if (!job.handle || typeof job.handle.requestPermission !== 'function') continue
      try {
        const permission = await job.handle.requestPermission({ mode: 'read' })
        if (permission === 'granted') queue.resume(job.id)
      } catch {}
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

  function handleFallbackFiles (files) {
    const candidates = [...files].slice(0, MAX_PICKED_FILES).map(file => candidateFromFile(file, null, file.webkitRelativePath || file.name))
    reviewFiles(candidates).catch(error => safeToast(error.message || String(error), 'error'))
  }

  function setPaneStatus (text) {
    const el = $('#fg-upload-status')
    if (el) el.textContent = text
  }

  function statusLabel (job) {
    if (job.status === 'queued') return 'Queued'
    if (job.status === 'uploading') return `${Math.round((job.progress || 0) * 100)}%`
    if (job.status === 'retrying') {
      const seconds = Math.max(1, Math.ceil((Number(job.retryAt || 0) - Date.now()) / 1000))
      return `Retrying in ${seconds}s`
    }
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
      '#fg-upload-speed': fmtSpeed(stats.speed),
      '#fg-upload-completed': fmtNumber(stats.completed),
      '#fg-upload-remaining': fmtNumber(stats.remaining),
      '#fg-upload-total': `${fmtNumber(stats.total)} files`
    }
    for (const [selector, text] of Object.entries(values)) {
      const node = $(selector)
      if (node && node.textContent !== text) node.textContent = text
    }
    const concurrency = $('#fg-upload-concurrency')
    const concurrencyValue = $('#fg-upload-concurrency-value')
    if (concurrency) concurrency.value = String(stats.concurrency)
    if (concurrencyValue) concurrencyValue.textContent = String(stats.concurrency)

    const list = queue.list()
    const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE))
    currentPage = Math.min(Math.max(1, currentPage), pages)
    const start = (currentPage - 1) * PAGE_SIZE
    const visible = list.slice(start, start + PAGE_SIZE)
    const host = $('#fg-upload-list')
    if (host) {
      const fragment = document.createDocumentFragment()
      for (const job of visible) fragment.appendChild(renderJob(job))
      host.replaceChildren(fragment)
    }
    const summary = $('#fg-upload-page-summary')
    if (summary) {
      const first = list.length ? start + 1 : 0
      const last = Math.min(list.length, start + PAGE_SIZE)
      summary.textContent = `${fmtNumber(first)}–${fmtNumber(last)} of ${fmtNumber(list.length)}`
    }
    const pageLabel = $('#fg-upload-page-label')
    if (pageLabel) pageLabel.textContent = `Page ${fmtNumber(currentPage)} of ${fmtNumber(pages)}`
    const prev = $('#fg-upload-prev')
    const next = $('#fg-upload-next')
    if (prev) prev.disabled = currentPage <= 1
    if (next) next.disabled = currentPage >= pages

    const pause = $('#fg-upload-pause-all')
    const resume = $('#fg-upload-resume-all')
    const cancel = $('#fg-upload-cancel-all')
    const clearDone = $('#fg-upload-clear-done')
    const clearAll = $('#fg-upload-clear-all')
    if (pause) pause.disabled = stats.remaining === 0 || queue.globalPaused
    if (resume) resume.disabled = stats.paused === 0 && stats.needsAccess === 0 && !queue.globalPaused
    if (cancel) cancel.disabled = stats.remaining === 0
    if (clearDone) clearDone.disabled = stats.completed === 0 && stats.cancelled === 0
    if (clearAll) clearAll.disabled = stats.total === 0
  }

  function renderJob (job) {
    const row = document.createElement('div')
    row.className = `fg-up-job is-${job.status}`
    row.dataset.jobId = job.id
    const progress = Math.round((job.progress || 0) * 100)
    const metaParts = [fmtSize(job.size)]
    if (job.chatTitle) metaParts.push(job.chatTitle)
    if (job.status === 'uploading' && job.speed) metaParts.push(fmtSpeed(job.speed))
    const error = job.error ? `<div class="fg-up-job-error"></div>` : ''
    row.innerHTML = `
      <div class="fg-up-job-main">
        <div class="fg-up-job-name"></div>
        <div class="fg-up-job-meta"></div>
        <div class="fg-up-progress"><span style="width:${progress}%"></span></div>
        ${error}
      </div>
      <div class="fg-up-job-status"></div>
      <div class="fg-up-job-actions"></div>`
    row.querySelector('.fg-up-job-name').textContent = job.relativePath || job.name
    row.querySelector('.fg-up-job-meta').textContent = metaParts.join(' · ')
    row.querySelector('.fg-up-job-status').textContent = statusLabel(job)
    const errorNode = row.querySelector('.fg-up-job-error')
    if (errorNode) errorNode.textContent = job.error
    const actions = row.querySelector('.fg-up-job-actions')
    const add = (label, action, cls = '') => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `ghost small ${cls}`.trim()
      button.textContent = label
      button.addEventListener('click', event => { event.stopPropagation(); action() })
      actions.appendChild(button)
    }
    if (job.status === 'uploading' || job.status === 'queued' || job.status === 'retrying' || job.status === 'verifying') add('Pause', () => queue.pause(job.id))
    if (job.status === 'paused') add('Resume', () => queue.resume(job.id))
    if (job.status === 'failed') add('Retry', () => queue.retry(job.id))
    if (job.status === 'needs_access') add('Locate', () => relinkJob(job.id))
    if (['queued', 'uploading', 'retrying', 'verifying', 'paused', 'needs_access'].includes(job.status)) add('Cancel', () => queue.cancel(job.id), 'danger')
    return row
  }

  function showUploads () {
    const pane = $('#mg-uploads-pane')
    const downloads = $('#mg-downloads-pane')
    const info = $('#mg-info-pane')
    if (!pane || !downloads || !info) return
    downloads.classList.add('hidden')
    info.classList.add('hidden')
    pane.classList.remove('hidden')
    $('#mg-tab-downloads')?.classList.remove('active')
    $('#mg-tab-info')?.classList.remove('active')
    $('#mg-tab-uploads')?.classList.add('active')
    try { localStorage.setItem('filegram-right-panel-v2', 'uploads') } catch {}
    refreshOwnedChannels().catch(() => {})
    render()
  }

  function hideUploads () {
    $('#mg-uploads-pane')?.classList.add('hidden')
    $('#mg-tab-uploads')?.classList.remove('active')
    try { localStorage.setItem('filegram-right-panel-v2', 'other') } catch {}
  }

  function createUi () {
    const tabs = $('.mg-drawer-tabs')
    const drawer = $('.downloads')
    if (!tabs || !drawer || $('#mg-tab-uploads')) return false

    const tab = document.createElement('button')
    tab.id = 'mg-tab-uploads'
    tab.type = 'button'
    tab.className = 'mg-drawer-tab fg-up-tab'
    tab.innerHTML = '<span class="fg-up-tab-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 19V5m0 0-5 5m5-5 5 5"/><path d="M5 19h14"/></svg></span><span>Uploads</span>'
    tab.addEventListener('click', showUploads)
    const infoTab = $('#mg-tab-info')
    if (infoTab) tabs.insertBefore(tab, infoTab)
    else tabs.appendChild(tab)

    const pane = document.createElement('div')
    pane.id = 'mg-uploads-pane'
    pane.className = 'mg-drawer-pane fg-up-pane hidden'
    pane.innerHTML = `
      <section class="fg-up-section fg-up-destination">
        <div class="fg-up-section-head"><span>Destination</span><small id="fg-upload-status">Auto-resume ready</small></div>
        <select id="fg-upload-channel" class="mg-select"><option value="">Select owned channel…</option></select>
        <div id="fg-upload-destination-note" class="fg-up-note">Select a channel you own.</div>
        <label class="fg-up-caption"><span>Common caption <small>optional</small></span><input id="fg-upload-caption" maxlength="1024" placeholder="Applied to every queued file"></label>
        <div class="fg-up-add-row"><button id="fg-upload-add-files" type="button">Add files</button><button id="fg-upload-add-folder" type="button" class="ghost">Add folder</button></div>
      </section>
      <section class="fg-up-stats">
        <div class="fg-up-stat"><span>Speed</span><strong id="fg-upload-speed">0 B/s</strong></div>
        <div class="fg-up-stat"><span>Uploaded</span><strong id="fg-upload-completed">0</strong></div>
        <div class="fg-up-stat"><span>Remaining</span><strong id="fg-upload-remaining">0</strong></div>
        <div class="fg-up-stat fg-up-total"><span>Total</span><strong id="fg-upload-total">0 files</strong></div>
      </section>
      <section class="fg-up-section">
        <div class="fg-up-section-head"><span>Parallel files</span><strong id="fg-upload-concurrency-value">${queue.concurrency}</strong></div>
        <input id="fg-upload-concurrency" class="fg-up-range" type="range" min="1" max="${MAX_CONCURRENCY}" step="1" value="${queue.concurrency}">
      </section>
      <section class="fg-up-actions">
        <button id="fg-upload-pause-all" type="button" class="ghost">Pause all</button>
        <button id="fg-upload-resume-all" type="button" class="ghost">Resume all</button>
        <button id="fg-upload-cancel-all" type="button" class="ghost danger">Cancel all</button>
        <button id="fg-upload-clear-done" type="button" class="ghost">Clear done</button>
        <button id="fg-upload-clear-all" type="button" class="danger fg-up-clear-all">Clear all</button>
      </section>
      <section class="fg-up-queue">
        <div class="fg-up-queue-head"><span id="fg-upload-page-summary">0–0 of 0</span><span>100 / page</span></div>
        <div id="fg-upload-list" class="fg-up-list"></div>
        <div class="fg-up-pager"><button id="fg-upload-prev" class="ghost small" type="button">‹ Previous</button><span id="fg-upload-page-label">Page 1 of 1</span><button id="fg-upload-next" class="ghost small" type="button">Next ›</button></div>
      </section>`

    const infoPane = $('#mg-info-pane')
    if (infoPane) drawer.insertBefore(pane, infoPane)
    else drawer.appendChild(pane)

    const input = document.createElement('input')
    input.id = 'fg-upload-file-input'
    input.type = 'file'
    input.multiple = true
    input.hidden = true
    input.addEventListener('change', () => handleFallbackFiles(input.files || []))
    document.body.appendChild(input)

    const relink = document.createElement('input')
    relink.id = 'fg-upload-relink-input'
    relink.type = 'file'
    relink.hidden = true
    relink.addEventListener('change', () => {
      const jobId = relink.dataset.jobId
      const file = relink.files && relink.files[0]
      const job = jobId && queue.jobs.get(jobId)
      if (!job || !file) return
      if (file.name !== job.name || file.size !== job.size) {
        safeToast('Choose the same source file (matching name and size)', 'error')
        return
      }
      queue.attachSource(job.id, file, null)
    })
    document.body.appendChild(relink)

    ensureReviewModal()
    bindUi()
    mounted = true
    return true
  }

  function ensureReviewModal () {
    if ($('#fg-upload-review-modal')) return
    const modal = document.createElement('div')
    modal.id = 'fg-upload-review-modal'
    modal.className = 'fg-up-modal hidden'
    modal.innerHTML = `
      <div class="fg-up-review" role="dialog" aria-modal="true" aria-labelledby="fg-upload-review-title">
        <div class="fg-up-review-head"><div><span class="fg-up-kicker">Bulk upload review</span><h3 id="fg-upload-review-title">Queue files to <span id="fg-upload-review-destination">channel</span></h3></div><button id="fg-upload-review-close" class="ghost small" type="button">✕</button></div>
        <div id="fg-upload-review-stats" class="fg-up-review-stats"></div>
        <div id="fg-upload-review-duplicates" class="fg-up-review-duplicates"></div>
        <div class="fg-up-review-note">Duplicate detection compares this selection, the current upload queue, and the destination channel's committed FileGram index using exact filename + size evidence. Nothing is silently removed.</div>
        <div class="fg-up-review-actions"><button id="fg-upload-review-cancel" class="ghost" type="button">Cancel</button><button id="fg-upload-review-all" class="ghost" type="button">Upload all anyway</button><button id="fg-upload-review-unique" type="button">Queue uploads</button></div>
      </div>`
    document.body.appendChild(modal)
    modal.addEventListener('mousedown', event => { if (event.target === modal) closeReview() })
    $('#fg-upload-review-close').onclick = closeReview
    $('#fg-upload-review-cancel').onclick = closeReview
    $('#fg-upload-review-unique').onclick = () => queueReviewed(false)
    $('#fg-upload-review-all').onclick = () => queueReviewed(true)
  }

  function bindUi () {
    $('#fg-upload-add-files').onclick = chooseFiles
    $('#fg-upload-add-folder').onclick = chooseFolder
    $('#fg-upload-channel').addEventListener('change', () => {
      const id = selectedChannelId()
      updateDestinationNote(id ? ownedChannels.get(id) : null)
      if (id) store.setMeta('lastChatId', id).catch(() => {})
    })
    $('#fg-upload-concurrency').addEventListener('input', event => {
      const value = queue.setConcurrency(event.target.value)
      localStorage.setItem('filegram-upload-concurrency', String(value))
      store.setMeta('concurrency', value).catch(() => {})
    })
    $('#fg-upload-pause-all').onclick = () => queue.pauseAll()
    $('#fg-upload-resume-all').onclick = grantAndResume
    $('#fg-upload-cancel-all').onclick = () => {
      if (!queue.stats().remaining) return
      if (confirm('Cancel every queued and active upload?')) queue.cancelAll()
    }
    $('#fg-upload-clear-done').onclick = () => queue.clearDone()
    $('#fg-upload-clear-all').onclick = () => {
      if (!queue.stats().total) return
      if (confirm('Cancel active uploads and clear the entire upload queue?')) queue.clearAll()
    }
    $('#fg-upload-prev').onclick = () => { currentPage = Math.max(1, currentPage - 1); render() }
    $('#fg-upload-next').onclick = () => { currentPage++; render() }
    $('#mg-tab-downloads')?.addEventListener('click', hideUploads)
    $('#mg-tab-info')?.addEventListener('click', hideUploads)
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !$('#fg-upload-review-modal')?.classList.contains('hidden')) closeReview()
    })
  }

  async function restoreQueue () {
    const records = await store.getAllJobs().catch(() => [])
    if (records.length) queue.restore(records)
    const concurrency = Number(await store.getMeta('concurrency').catch(() => 0))
    if (concurrency) queue.setConcurrency(concurrency)
    const select = $('#fg-upload-channel')
    const lastChatId = await store.getMeta('lastChatId').catch(() => null)
    if (select && lastChatId) select.dataset.restoreChatId = String(lastChatId)
    render()
  }

  async function applyRestoredChannel () {
    const select = $('#fg-upload-channel')
    if (!select) return
    const wanted = select.dataset.restoreChatId
    if (wanted && [...select.options].some(option => option.value === wanted)) {
      select.value = wanted
      updateDestinationNote(ownedChannels.get(wanted))
      delete select.dataset.restoreChatId
    }
  }

  function watchChats () {
    setInterval(() => {
      if (!mounted || typeof state === 'undefined') return
      const next = (state.chats || []).filter(chat => chat && chat.kind === 'channel').map(chat => `${chat.id}:${chat.title}`).join('|')
      if (next !== channelSignature) {
        refreshOwnedChannels().then(applyRestoredChannel).catch(() => {})
      }
    }, 4000)
  }

  async function install () {
    if (!createUi()) return false
    await Promise.all([restoreQueue(), refreshOwnedChannels()])
    await applyRestoredChannel()
    let saved = ''
    try { saved = localStorage.getItem('filegram-right-panel-v2') || '' } catch {}
    if (saved === 'uploads') showUploads()
    render()
    watchChats()
    return true
  }

  window.FileGramUploads = {
    open: showUploads,
    snapshot: () => ({ stats: queue.stats(), jobs: queue.list(), selectedChatId: selectedChannelId() }),
    refreshChannels: () => refreshOwnedChannels(),
    queue
  }

  let attempts = 0
  let installing = false
  const timer = setInterval(() => {
    if (mounted || installing) {
      if (mounted) clearInterval(timer)
      return
    }
    attempts++
    installing = true
    install()
      .then(ok => { if (ok) clearInterval(timer) })
      .catch(() => {})
      .finally(() => { installing = false })
    if (attempts > 200) clearInterval(timer)
  }, 50)
})()
