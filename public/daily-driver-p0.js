'use strict'

/* Daily-driver P0 stabilization.
 * This layer intentionally stays small and loads after the proven rescue runtime.
 * It fixes browser-refresh file caching, stale search rendering, media preview
 * behavior, attachment progress UI, and a few high-friction daily-driver details
 * without re-enabling the isolated v3 runtime.
 */

const teleP0DbName = 'tele-daily-driver-cache-v1'
const teleP0StoreName = 'file-indexes'
const teleP0PersistTimers = new Map()
const teleP0SyncingChats = new Map()
const teleP0UploadState = new WeakMap()

function teleP0Key (value) { return String(value) }

function teleP0SnapshotValid (chatId, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items) || snapshot.done === false) return false
  const wanted = teleP0Key(chatId)
  return snapshot.items.every(item => item && teleP0Key(item.chatId) === wanted)
}

function teleP0OpenDb () {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return resolve(null)
    const request = indexedDB.open(teleP0DbName, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(teleP0StoreName)) db.createObjectStore(teleP0StoreName, { keyPath: 'chatId' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('IndexedDB unavailable'))
  })
}

async function teleP0CacheGet (chatId) {
  const db = await teleP0OpenDb().catch(() => null)
  if (!db) return null
  return new Promise(resolve => {
    const tx = db.transaction(teleP0StoreName, 'readonly')
    const req = tx.objectStore(teleP0StoreName).get(teleP0Key(chatId))
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => resolve(null)
    tx.oncomplete = () => db.close()
    tx.onerror = () => { try { db.close() } catch {} }
  })
}

async function teleP0CachePut (chatId, snapshot) {
  if (!teleP0SnapshotValid(chatId, snapshot)) return
  const db = await teleP0OpenDb().catch(() => null)
  if (!db) return
  const record = {
    chatId: teleP0Key(chatId),
    found: snapshot.items.length,
    scanned: Number(snapshot.scanned || 0),
    typeCounts: snapshot.typeCounts || {},
    items: snapshot.items,
    savedAt: Date.now(),
    done: true
  }
  await new Promise(resolve => {
    const tx = db.transaction(teleP0StoreName, 'readwrite')
    tx.objectStore(teleP0StoreName).put(record)
    tx.oncomplete = resolve
    tx.onerror = resolve
    tx.onabort = resolve
  })
  db.close()
}

function teleP0SchedulePersist (chatId, delay = 700) {
  const key = teleP0Key(chatId)
  clearTimeout(teleP0PersistTimers.get(key))
  teleP0PersistTimers.set(key, setTimeout(() => {
    teleP0PersistTimers.delete(key)
    const snapshot = rescueFileCache.get(key)
    if (teleP0SnapshotValid(chatId, snapshot)) teleP0CachePut(chatId, snapshot).catch(() => {})
  }, delay))
}

function teleP0ApplyFileSnapshot (chatId, snapshot, labelPrefix) {
  if (!teleP0SnapshotValid(chatId, snapshot)) return false
  const key = teleP0Key(chatId)
  rescueFileCache.set(key, snapshot)
  try { teleHotfixValidatedChats.add(key) } catch {}
  if (state.activeChatId != null && teleP0Key(state.activeChatId) === key && state.view === 'files') {
    rescueApplyCompleteFiles(chatId, snapshot)
    renderFiles()
    rescueUpdateMediaLabel()
    setLoadState(`${labelPrefix || 'Loaded'} ${snapshot.items.length.toLocaleString()} files`)
  }
  return true
}

/* A browser refresh must not throw away a completed 22k-file index. Hydrate the
 * completed index from IndexedDB immediately, then reconcile with the server's
 * chat-scoped cache in the background. The server request is never forced. */
rescueEnsureAllFiles = async function teleP0EnsureAllFiles (chatId) {
  if (chatId == null) return null
  const key = teleP0Key(chatId)

  const memory = rescueFileCache.get(key)
  if (teleP0SnapshotValid(chatId, memory)) {
    teleP0ApplyFileSnapshot(chatId, memory, 'Loaded')
    teleP0SchedulePersist(chatId)
    return memory
  }

  const disk = await teleP0CacheGet(chatId)
  if (teleP0SnapshotValid(chatId, disk)) {
    teleP0ApplyFileSnapshot(chatId, disk, 'Cached')
  }

  if (teleP0SyncingChats.has(key)) return disk || teleP0SyncingChats.get(key)

  const generation = rescueOpenGeneration
  const sync = (async () => {
    try {
      const data = await request('scan-media-v3', { chatId, force: false })
      const items = ((data && data.items) || []).filter(item => item && teleP0Key(item.chatId) === key)
      const snapshot = {
        chatId,
        items: typeof teleHotfixSortFileItems === 'function' ? teleHotfixSortFileItems(items) : items,
        found: items.length,
        scanned: Number((data && data.scanned) || 0),
        typeCounts: (data && data.typeCounts) || {},
        savedAt: Date.now(),
        done: data ? data.done !== false : true
      }
      if (snapshot.done) {
        teleP0ApplyFileSnapshot(chatId, snapshot, 'Loaded')
        teleP0CachePut(chatId, snapshot).catch(() => {})
      }
      return snapshot
    } catch (error) {
      if (!disk && state.activeChatId != null && teleP0Key(state.activeChatId) === key && state.view === 'files') {
        setLoadState('Could not sync files. Reopen Files to retry.')
        toast(String(error && error.message ? error.message : error), 'error')
      }
      return disk || null
    } finally {
      teleP0SyncingChats.delete(key)
      if (state.activeChatId != null && teleP0Key(state.activeChatId) === key && generation === rescueOpenGeneration) rescueUpdateMediaLabel()
    }
  })()
  teleP0SyncingChats.set(key, sync)

  /* If cache already painted, don't make the tab wait for a full server scan. */
  return disk || sync
}

/* The old app.js input listener captured the legacy renderChats function before
 * rescue-runtime replaced it. Clone the input once to drop that stale listener,
 * then bind search to the current renderer. This keeps photos and modern rows
 * intact for every keystroke instead of briefly flashing the old UI. */
function teleP0RebindChatSearch () {
  const oldInput = document.querySelector('#chat-search')
  if (!oldInput || oldInput.dataset.teleP0Bound === '1') return
  const next = oldInput.cloneNode(true)
  next.dataset.teleP0Bound = '1'
  next.value = oldInput.value
  oldInput.replaceWith(next)
  next.addEventListener('input', () => renderChats())
  next.addEventListener('search', () => renderChats())
}
teleP0RebindChatSearch()

/* Persist a completed progressive index. We intentionally call the previous
 * event handler first so its merge logic remains the source of truth. */
const teleP0BaseHandleEvent = handleEvent
handleEvent = function teleP0HandleEvent (event) {
  const result = teleP0BaseHandleEvent(event)
  if (event && event.name === 'media-index-progress') {
    const payload = event.payload || {}
    if (payload.chatId != null) {
      if (payload.done) teleP0SchedulePersist(payload.chatId, 20)
      else if (Number(payload.found || 0) % 1000 < 100) teleP0SchedulePersist(payload.chatId, 1000)
    }
  }
  return result
}

/* ---------- Media popup ---------- */

function teleP0PreviewError (body, item, text) {
  body.innerHTML = ''
  const panel = h('div', 'tele-p0-preview-error')
  panel.appendChild(h('strong', '', 'Could not play this media'))
  panel.appendChild(h('span', 'muted', text || 'Telegram could not prepare the file.'))
  const actions = h('div', 'tele-p0-preview-actions')
  const retry = h('button', 'ghost', 'Retry')
  retry.type = 'button'
  retry.onclick = () => rescuePreviewFile(item)
  const download = h('button', 'ghost', 'Download original')
  download.type = 'button'
  download.onclick = () => startDownloads([item])
  actions.append(retry, download)
  panel.appendChild(actions)
  body.appendChild(panel)
}

rescuePreviewFile = async function teleP0PreviewFile (item) {
  if (!item || !item.fileId) return toast('This Telegram file is not available yet', 'error')
  const modal = teleHotfixPreviewModal()
  const body = modal.querySelector('#tele-hotfix-preview-body')
  modal.querySelector('#tele-hotfix-preview-title').textContent = item.name || 'Media'
  modal.querySelector('#tele-hotfix-preview-meta').textContent = `${String(item.type || 'file').replace('_', ' ')} · ${fmtSize(item.fileSize || 0)}`
  body.innerHTML = '<div class="tele-hotfix-preview-state">Opening…</div>'
  modal.classList.remove('hidden')

  const thumb = await teleHotfixThumbUrl(item)
  const url = teleHotfixMediaUrl(item, Date.now())

  if (item.type === 'photo' || item.type === 'gif' || item.type === 'sticker') {
    if (thumb) {
      const placeholder = new Image()
      placeholder.className = 'tele-p0-preview-image is-thumb'
      placeholder.alt = item.name || ''
      placeholder.src = thumb
      body.innerHTML = ''
      body.appendChild(placeholder)
    }
    const full = new Image()
    full.className = 'tele-p0-preview-image'
    full.alt = item.name || ''
    full.onload = () => {
      if (modal.classList.contains('hidden')) return
      body.innerHTML = ''
      body.appendChild(full)
    }
    full.onerror = () => { if (!thumb) teleP0PreviewError(body, item, 'Image preview failed.') }
    full.src = url
    return
  }

  if (item.type === 'video' || item.type === 'video_note') {
    const shell = h('div', 'tele-p0-video-shell')
    const video = document.createElement('video')
    video.className = 'tele-p0-preview-video'
    video.controls = true
    video.playsInline = true
    video.preload = 'auto'
    if (thumb) video.poster = thumb
    const status = h('div', 'tele-p0-video-status', 'Preparing video…')
    shell.append(video, status)
    body.innerHTML = ''
    body.appendChild(shell)
    video.addEventListener('loadedmetadata', () => { status.textContent = 'Ready'; setTimeout(() => status.remove(), 700) }, { once: true })
    video.addEventListener('canplay', () => { status.remove(); video.play().catch(() => {}) }, { once: true })
    video.addEventListener('error', () => teleP0PreviewError(body, item, 'The file could not be streamed. Its codec may not be supported by Chrome.'))
    video.src = url
    video.load()
    return
  }

  if (item.type === 'audio' || item.type === 'voice') {
    const audio = document.createElement('audio')
    audio.className = 'tele-p0-preview-audio'
    audio.controls = true
    audio.autoplay = true
    audio.preload = 'auto'
    audio.onerror = () => teleP0PreviewError(body, item, 'Audio preview failed.')
    body.innerHTML = ''
    body.appendChild(audio)
    audio.src = url
    return
  }

  teleP0PreviewError(body, item, 'This file type has no browser preview.')
}

/* The hotfix card wrapper already installs a thumbnail click handler, but late
 * rerenders can come from older wrappers. Reassert preview on every final card. */
const teleP0BaseBuildGridCard = buildGridCard
buildGridCard = function teleP0BuildGridCard (item) {
  const card = teleP0BaseBuildGridCard(item)
  const thumb = card.querySelector('.gthumb')
  if (thumb) {
    thumb.setAttribute('role', 'button')
    thumb.tabIndex = 0
    thumb.onclick = event => { event.stopPropagation(); rescuePreviewFile(item) }
    thumb.onkeydown = event => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        event.stopPropagation()
        rescuePreviewFile(item)
      }
    }
  }
  return card
}

/* ---------- Telegram-style attachment queue + upload progress ---------- */

function teleP0AttachmentState (file) {
  let state = teleP0UploadState.get(file)
  if (!state) {
    state = { phase: 'ready', percent: 0, error: '' }
    teleP0UploadState.set(file, state)
  }
  return state
}

function teleP0AttachmentIcon (file) {
  const type = String(file && file.type || '')
  if (type.startsWith('image/')) return 'Image'
  if (type.startsWith('video/')) return 'Video'
  if (type.startsWith('audio/')) return 'Audio'
  return 'File'
}

rescueRenderAttachments = function teleP0RenderAttachments () {
  const preview = document.querySelector('#tele-attachment-preview')
  const list = document.querySelector('#tele-attachment-list')
  const oneTimeWrap = document.querySelector('#tele-one-time-wrap')
  if (!preview || !list) return
  list.innerHTML = ''

  rescueCompose.attachments.forEach((file, index) => {
    const upload = teleP0AttachmentState(file)
    const row = h('div', `tele-p0-attachment ${upload.phase === 'error' ? 'is-error' : ''}`)
    const icon = h('div', 'tele-p0-attachment-icon', teleP0AttachmentIcon(file))
    const body = h('div', 'tele-p0-attachment-body')
    const top = h('div', 'tele-p0-attachment-top')
    top.append(h('strong', 'tele-p0-attachment-name', file.name), h('span', 'tele-p0-attachment-size', fmtSize(file.size)))
    const status = h('div', `tele-p0-attachment-status ${upload.phase}`)
    const statusText = upload.phase === 'uploading'
      ? `Uploading ${Math.round(upload.percent)}%`
      : upload.phase === 'telegram'
        ? 'Sending to Telegram…'
        : upload.phase === 'sent'
          ? 'Sent'
          : upload.phase === 'error'
            ? (upload.error || 'Failed')
            : 'Ready to send'
    status.textContent = statusText
    const track = h('div', 'tele-p0-upload-track')
    const fill = h('div', 'tele-p0-upload-fill')
    fill.style.width = `${Math.max(0, Math.min(100, upload.percent || 0))}%`
    track.appendChild(fill)
    body.append(top, status, track)
    const remove = h('button', 'ghost small tele-p0-attachment-remove', '×')
    remove.type = 'button'
    remove.disabled = upload.phase === 'uploading' || upload.phase === 'telegram'
    remove.setAttribute('aria-label', `Remove ${file.name}`)
    remove.onclick = () => {
      rescueCompose.attachments.splice(index, 1)
      rescueCompose.oneTime = false
      rescueRenderAttachments()
    }
    row.append(icon, body, remove)
    list.appendChild(row)
  })

  preview.classList.toggle('hidden', rescueCompose.attachments.length === 0)
  const activeChat = state.chats.find(chat => String(chat.id) === String(state.activeChatId))
  const canViewOnce = rescueCompose.attachments.length === 1 && activeChat && activeChat.kind === 'private' && rescueAttachmentCanViewOnce(rescueCompose.attachments[0])
  if (oneTimeWrap) oneTimeWrap.classList.toggle('hidden', !canViewOnce)
  if (!canViewOnce) {
    rescueCompose.oneTime = false
    const oneTime = document.querySelector('#tele-one-time')
    if (oneTime) oneTime.checked = false
  }
}

function teleP0UploadAttachment (file, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/chat-attachment/${encodeURIComponent(state.activeChatId)}`)
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value)
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.min(100, (event.loaded / event.total) * 100), false)
    }
    xhr.upload.onload = () => onProgress(100, true)
    xhr.onerror = () => reject(new Error(`${file.name}: browser upload failed`))
    xhr.onabort = () => reject(new Error(`${file.name}: upload cancelled`))
    xhr.onload = () => {
      let result = {}
      try { result = JSON.parse(xhr.responseText || '{}') } catch {}
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(`${file.name}: ${result.error || `upload failed (${xhr.status})`}`))
      resolve(result)
    }
    xhr.send(file)
  })
}

rescueSendComposer = async function teleP0SendComposer () {
  const input = document.querySelector('#tele-compose-input')
  const send = document.querySelector('#tele-compose-send')
  if (!input || !send || state.activeChatId == null) return
  const text = input.value.trim()
  const attachments = rescueCompose.attachments.slice()
  if (!text && !attachments.length) return
  if (attachments.length && rescueCompose.editMessageId) return toast('Finish editing before attaching files', 'error')
  if (rescueCompose.oneTime && attachments.length !== 1) return toast('View once supports one photo or video at a time', 'error')

  send.disabled = true
  const originalLabel = send.textContent
  try {
    if (rescueCompose.editMessageId) {
      send.textContent = 'Saving…'
      await request('edit-chat-message', { chatId: state.activeChatId, messageId: rescueCompose.editMessageId, text })
      toastOk('Message edited')
    } else if (attachments.length) {
      for (let index = 0; index < attachments.length; index++) {
        const file = attachments[index]
        const upload = teleP0AttachmentState(file)
        upload.phase = 'uploading'
        upload.percent = 0
        upload.error = ''
        rescueRenderAttachments()
        send.textContent = attachments.length > 1 ? `Sending ${index + 1}/${attachments.length}` : 'Uploading 0%'
        const headers = {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name),
          'X-Mime-Type': encodeURIComponent(file.type || 'application/octet-stream'),
          'X-Caption': encodeURIComponent(index === 0 ? text.slice(0, 1024) : ''),
          'X-One-Time': rescueCompose.oneTime && index === 0 ? '1' : '0'
        }
        if (rescueCompose.replyTo && rescueCompose.replyTo.id != null && index === 0) headers['X-Reply-To'] = String(rescueCompose.replyTo.id)
        try {
          await teleP0UploadAttachment(file, headers, (percent, bodyDone) => {
            upload.percent = percent
            upload.phase = bodyDone ? 'telegram' : 'uploading'
            send.textContent = bodyDone
              ? (attachments.length > 1 ? `Telegram ${index + 1}/${attachments.length}` : 'Sending…')
              : `Uploading ${Math.round(percent)}%`
            rescueRenderAttachments()
          })
          upload.percent = 100
          upload.phase = 'sent'
          rescueRenderAttachments()
        } catch (error) {
          upload.phase = 'error'
          upload.error = String(error && error.message ? error.message : error)
          rescueRenderAttachments()
          throw error
        }
      }
    } else {
      send.textContent = 'Sending…'
      await request('send-chat-message', {
        chatId: state.activeChatId,
        text,
        replyToMessageId: rescueCompose.replyTo ? rescueCompose.replyTo.id : null
      })
    }

    input.value = ''
    input.style.height = 'auto'
    if (attachments.length) await new Promise(resolve => setTimeout(resolve, 350))
    rescueClearAttachment()
    rescueClearComposeContext()
  } catch (error) {
    toast(String(error && error.message ? error.message : error), 'error')
  } finally {
    send.disabled = false
    send.textContent = originalLabel || 'Send'
    input.focus()
  }
}

const teleP0SendButton = document.querySelector('#tele-compose-send')
if (teleP0SendButton) teleP0SendButton.onclick = () => rescueSendComposer()

/* Keep the full download path visible without needing to focus a clipped input. */
function teleP0RefreshDownloadPath () {
  const input = document.querySelector('#dl-dir')
  const current = document.querySelector('#dl-dir-current')
  if (!input || !current) return
  const value = input.value || current.textContent.replace(/^Saving to:\s*/i, '').trim()
  input.title = value
  current.textContent = value || 'Default download folder'
  current.title = value
}
const teleP0PathObserver = new MutationObserver(teleP0RefreshDownloadPath)
if (document.querySelector('#dl-dir-current')) teleP0PathObserver.observe(document.querySelector('#dl-dir-current'), { childList: true, subtree: true, characterData: true })
document.querySelector('#dl-dir')?.addEventListener('input', teleP0RefreshDownloadPath)
document.querySelector('#set-dir')?.addEventListener('click', () => setTimeout(teleP0RefreshDownloadPath, 50))
teleP0RefreshDownloadPath()
