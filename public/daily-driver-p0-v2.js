'use strict'

/* P0 v2: safe browser-refresh cache + search + preview + attachment progress.
 * Loaded after the stable rescue/hotfix layers. The experimental v3 runtime
 * remains isolated.
 */

const teleP0v2DbName = 'tele-daily-driver-cache-v1'
const teleP0v2Store = 'file-indexes'
const teleP0v2Sync = new Map()
const teleP0v2PersistTimers = new Map()
const teleP0v2Upload = new WeakMap()

function teleP0v2Key (value) { return String(value) }
function teleP0v2ValidSnapshot (chatId, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items) || snapshot.done === false) return false
  const wanted = teleP0v2Key(chatId)
  return snapshot.items.every(item => item && teleP0v2Key(item.chatId) === wanted)
}

function teleP0v2Db () {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) return resolve(null)
    const req = indexedDB.open(teleP0v2DbName, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(teleP0v2Store)) req.result.createObjectStore(teleP0v2Store, { keyPath: 'chatId' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('IndexedDB unavailable'))
  })
}

async function teleP0v2ReadIndex (chatId) {
  const db = await teleP0v2Db().catch(() => null)
  if (!db) return null
  return new Promise(resolve => {
    const tx = db.transaction(teleP0v2Store, 'readonly')
    const req = tx.objectStore(teleP0v2Store).get(teleP0v2Key(chatId))
    req.onsuccess = () => resolve(req.result || null)
    req.onerror = () => resolve(null)
    tx.oncomplete = () => db.close()
    tx.onerror = () => { try { db.close() } catch {} }
  })
}

/* The persistent index is monotonic. A snapshot may only replace a stored record
 * that is the same size or smaller.
 *
 * teleP0v2ValidSnapshot only checks the done flag and chat ownership, so a short
 * scan stamped done:true used to overwrite a larger committed index on disk. The
 * next reload then restored the short version and the header shrank until a full
 * rescan grew it back. Shrinking requires an explicit hard refresh, which passes
 * allowShrink. */
async function teleP0v2WriteIndex (chatId, snapshot, options = {}) {
  if (!teleP0v2ValidSnapshot(chatId, snapshot)) return
  if (!options.allowShrink) {
    const existing = await teleP0v2ReadIndex(chatId).catch(() => null)
    const storedCount = existing && Array.isArray(existing.items) ? existing.items.length : 0
    if (storedCount > snapshot.items.length) return
  }
  const db = await teleP0v2Db().catch(() => null)
  if (!db) return
  const record = {
    chatId: teleP0v2Key(chatId),
    found: snapshot.items.length,
    scanned: Number(snapshot.scanned || 0),
    typeCounts: snapshot.typeCounts || {},
    items: snapshot.items,
    savedAt: Date.now(),
    done: true
  }
  await new Promise(resolve => {
    const tx = db.transaction(teleP0v2Store, 'readwrite')
    tx.objectStore(teleP0v2Store).put(record)
    tx.oncomplete = resolve
    tx.onerror = resolve
    tx.onabort = resolve
  })
  db.close()
}

function teleP0v2PersistSoon (chatId, delay = 600) {
  const key = teleP0v2Key(chatId)
  clearTimeout(teleP0v2PersistTimers.get(key))
  teleP0v2PersistTimers.set(key, setTimeout(() => {
    teleP0v2PersistTimers.delete(key)
    const snapshot = rescueFileCache.get(key)
    if (teleP0v2ValidSnapshot(chatId, snapshot)) teleP0v2WriteIndex(chatId, snapshot).catch(() => {})
  }, delay))
}

function teleP0v2PaintIndex (chatId, snapshot, cached) {
  if (!teleP0v2ValidSnapshot(chatId, snapshot)) return false
  const key = teleP0v2Key(chatId)
  rescueFileCache.set(key, snapshot)
  try { teleHotfixValidatedChats.add(key) } catch {}
  if (state.activeChatId != null && teleP0v2Key(state.activeChatId) === key && state.view === 'files') {
    rescueApplyCompleteFiles(chatId, snapshot)
    renderFiles()
    rescueUpdateMediaLabel()
    setLoadState(`${cached ? 'Cached' : 'Loaded'} ${snapshot.items.length.toLocaleString()} files${cached ? ' · syncing…' : ''}`)
  }
  return true
}

/* Never force a 22k-file rescan just because Chrome refreshed. A finished index
 * is restored from IndexedDB in one shot and server reconciliation uses the
 * chat-scoped memory cache with force:false. */
rescueEnsureAllFiles = async function teleP0v2EnsureAllFiles (chatId) {
  if (chatId == null) return null
  const key = teleP0v2Key(chatId)
  const memory = rescueFileCache.get(key)
  if (teleP0v2ValidSnapshot(chatId, memory)) {
    teleP0v2PaintIndex(chatId, memory, false)
    teleP0v2PersistSoon(chatId)
    return memory
  }

  const disk = await teleP0v2ReadIndex(chatId)
  if (teleP0v2ValidSnapshot(chatId, disk)) teleP0v2PaintIndex(chatId, disk, true)
  if (teleP0v2Sync.has(key)) return disk || teleP0v2Sync.get(key)

  const generation = rescueOpenGeneration
  const promise = (async () => {
    try {
      const data = await request('scan-media-v3', { chatId, force: false })
      const items = ((data && data.items) || []).filter(item => item && teleP0v2Key(item.chatId) === key)
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
        teleP0v2PaintIndex(chatId, snapshot, false)
        teleP0v2WriteIndex(chatId, snapshot).catch(() => {})
      }
      return snapshot
    } catch (error) {
      if (!disk && state.activeChatId != null && teleP0v2Key(state.activeChatId) === key && state.view === 'files') {
        setLoadState('Could not sync files. Reopen Files to retry.')
        toast(String(error && error.message ? error.message : error), 'error')
      }
      return disk || null
    } finally {
      teleP0v2Sync.delete(key)
      if (state.activeChatId != null && teleP0v2Key(state.activeChatId) === key && generation === rescueOpenGeneration) rescueUpdateMediaLabel()
    }
  })()
  teleP0v2Sync.set(key, promise)
  return disk || promise
}

/* app.js captured its original renderChats function when it registered the
 * search listener. Replace only the input DOM node to drop that obsolete
 * listener, then bind the live rescue renderer. */
function teleP0v2BindSearch () {
  const old = document.querySelector('#chat-search')
  if (!old || old.dataset.teleP0v2 === '1') return
  const next = old.cloneNode(true)
  next.value = old.value
  next.dataset.teleP0v2 = '1'
  old.replaceWith(next)
  next.addEventListener('input', () => renderChats())
  next.addEventListener('search', () => renderChats())
}
teleP0v2BindSearch()

const teleP0v2BaseHandleEvent = handleEvent
handleEvent = function teleP0v2HandleEvent (event) {
  const result = teleP0v2BaseHandleEvent(event)
  if (event && event.name === 'media-index-progress') {
    const payload = event.payload || {}
    if (payload.chatId != null) {
      if (payload.done) teleP0v2PersistSoon(payload.chatId, 30)
      else if (Number(payload.found || 0) % 1000 < 100) teleP0v2PersistSoon(payload.chatId, 1000)
    }
  }
  return result
}

/* ---------- Unified media viewer ---------- */
function teleP0v2PreviewFailure (body, item, message) {
  body.innerHTML = ''
  const box = h('div', 'tele-p0-preview-error')
  box.append(h('strong', '', 'Could not play this media'), h('span', 'muted', message || 'Telegram could not prepare the file.'))
  const actions = h('div', 'tele-p0-preview-actions')
  const retry = h('button', 'ghost', 'Retry')
  retry.type = 'button'
  retry.onclick = () => rescuePreviewFile(item)
  const download = h('button', 'ghost', 'Download original')
  download.type = 'button'
  download.onclick = () => startDownloads([item])
  actions.append(retry, download)
  box.appendChild(actions)
  body.appendChild(box)
}

rescuePreviewFile = async function teleP0v2PreviewFile (item) {
  if (!item || !item.fileId) return toast('This Telegram file is not available yet', 'error')
  const modal = teleHotfixPreviewModal()
  const body = modal.querySelector('#tele-hotfix-preview-body')
  modal.querySelector('#tele-hotfix-preview-title').textContent = item.name || 'Media'
  modal.querySelector('#tele-hotfix-preview-meta').textContent = `${String(item.type || 'file').replace('_', ' ')} · ${fmtSize(item.fileSize || 0)}`
  body.innerHTML = '<div class="tele-hotfix-preview-state">Opening…</div>'
  modal.classList.remove('hidden')

  const thumb = await teleHotfixThumbUrl(item)
  const mediaUrl = teleHotfixMediaUrl(item, Date.now())

  if (['photo', 'gif', 'sticker'].includes(item.type)) {
    if (thumb) {
      const low = new Image()
      low.className = 'tele-p0-preview-image is-thumb'
      low.alt = item.name || ''
      low.src = thumb
      body.innerHTML = ''
      body.appendChild(low)
    }
    const image = new Image()
    image.className = 'tele-p0-preview-image'
    image.alt = item.name || ''
    image.onload = () => { if (!modal.classList.contains('hidden')) { body.innerHTML = ''; body.appendChild(image) } }
    image.onerror = () => { if (!thumb) teleP0v2PreviewFailure(body, item, 'Image preview failed.') }
    image.src = mediaUrl
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
    video.addEventListener('loadedmetadata', () => { status.textContent = 'Ready' }, { once: true })
    video.addEventListener('canplay', () => { status.remove(); video.play().catch(() => {}) }, { once: true })
    video.addEventListener('error', () => teleP0v2PreviewFailure(body, item, 'The file could not be streamed or Chrome does not support its codec.'))
    video.src = mediaUrl
    video.load()
    return
  }

  if (item.type === 'audio' || item.type === 'voice') {
    const audio = document.createElement('audio')
    audio.className = 'tele-p0-preview-audio'
    audio.controls = true
    audio.autoplay = true
    audio.preload = 'auto'
    audio.onerror = () => teleP0v2PreviewFailure(body, item, 'Audio preview failed.')
    body.innerHTML = ''
    body.appendChild(audio)
    audio.src = mediaUrl
    return
  }

  teleP0v2PreviewFailure(body, item, 'This file type has no browser preview.')
}

const teleP0v2BaseBuildGridCard = buildGridCard
buildGridCard = function teleP0v2BuildGridCard (item) {
  const card = teleP0v2BaseBuildGridCard(item)
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

/* ---------- Attachment queue ---------- */
function teleP0v2UploadState (file) {
  let value = teleP0v2Upload.get(file)
  if (!value) { value = { phase: 'ready', percent: 0, error: '' }; teleP0v2Upload.set(file, value) }
  return value
}
function teleP0v2FileKind (file) {
  const type = String(file && file.type || '')
  if (type.startsWith('image/')) return 'Image'
  if (type.startsWith('video/')) return 'Video'
  if (type.startsWith('audio/')) return 'Audio'
  return 'File'
}

rescueRenderAttachments = function teleP0v2RenderAttachments () {
  const preview = document.querySelector('#tele-attachment-preview')
  const list = document.querySelector('#tele-attachment-list')
  const oneTimeWrap = document.querySelector('#tele-one-time-wrap')
  if (!preview || !list) return
  list.innerHTML = ''
  rescueCompose.attachments.forEach((file, index) => {
    const upload = teleP0v2UploadState(file)
    const row = h('div', `tele-p0-attachment ${upload.phase === 'error' ? 'is-error' : ''}`)
    row.appendChild(h('div', 'tele-p0-attachment-icon', teleP0v2FileKind(file)))
    const body = h('div', 'tele-p0-attachment-body')
    const top = h('div', 'tele-p0-attachment-top')
    top.append(h('strong', 'tele-p0-attachment-name', file.name), h('span', 'tele-p0-attachment-size', fmtSize(file.size)))
    const status = h('div', `tele-p0-attachment-status ${upload.phase}`)
    status.textContent = upload.phase === 'uploading' ? `Uploading ${Math.round(upload.percent)}%`
      : upload.phase === 'telegram' ? 'Sending to Telegram…'
        : upload.phase === 'sent' ? 'Sent'
          : upload.phase === 'error' ? (upload.error || 'Failed') : 'Ready to send'
    const track = h('div', 'tele-p0-upload-track')
    const fill = h('div', 'tele-p0-upload-fill')
    fill.style.width = `${Math.max(0, Math.min(100, upload.percent || 0))}%`
    track.appendChild(fill)
    body.append(top, status, track)
    const remove = h('button', 'ghost small tele-p0-attachment-remove', '×')
    remove.type = 'button'
    remove.disabled = upload.phase === 'uploading' || upload.phase === 'telegram'
    remove.onclick = () => { rescueCompose.attachments.splice(index, 1); rescueCompose.oneTime = false; rescueRenderAttachments() }
    row.append(body, remove)
    list.appendChild(row)
  })
  preview.classList.toggle('hidden', rescueCompose.attachments.length === 0)
  const activeChat = state.chats.find(chat => String(chat.id) === String(state.activeChatId))
  const canViewOnce = rescueCompose.attachments.length === 1 && activeChat && activeChat.kind === 'private' && rescueAttachmentCanViewOnce(rescueCompose.attachments[0])
  if (oneTimeWrap) oneTimeWrap.classList.toggle('hidden', !canViewOnce)
  if (!canViewOnce) {
    rescueCompose.oneTime = false
    const checkbox = document.querySelector('#tele-one-time')
    if (checkbox) checkbox.checked = false
  }
}

function teleP0v2UploadFile (file, headers, progress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', `/api/chat-attachment/${encodeURIComponent(state.activeChatId)}`)
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value)
    xhr.upload.onprogress = event => { if (event.lengthComputable) progress(Math.min(100, event.loaded / event.total * 100), false) }
    xhr.upload.onload = () => progress(100, true)
    xhr.onerror = () => reject(new Error(`${file.name}: browser upload failed`))
    xhr.onabort = () => reject(new Error(`${file.name}: upload cancelled`))
    xhr.onload = () => {
      let data = {}
      try { data = JSON.parse(xhr.responseText || '{}') } catch {}
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(`${file.name}: ${data.error || `upload failed (${xhr.status})`}`))
      resolve(data)
    }
    xhr.send(file)
  })
}

rescueSendComposer = async function teleP0v2SendComposer () {
  const input = document.querySelector('#tele-compose-input')
  const send = document.querySelector('#tele-compose-send')
  if (!input || !send || state.activeChatId == null) return
  const text = input.value.trim()
  const attachments = rescueCompose.attachments.slice()
  if (!text && !attachments.length) return
  if (attachments.length && rescueCompose.editMessageId) return toast('Finish editing before attaching files', 'error')
  if (rescueCompose.oneTime && attachments.length !== 1) return toast('View once supports one photo or video at a time', 'error')

  send.disabled = true
  try {
    if (rescueCompose.editMessageId) {
      send.textContent = 'Saving…'
      await request('edit-chat-message', { chatId: state.activeChatId, messageId: rescueCompose.editMessageId, text })
    } else if (attachments.length) {
      for (let index = 0; index < attachments.length; index++) {
        const file = attachments[index]
        const upload = teleP0v2UploadState(file)
        upload.phase = 'uploading'; upload.percent = 0; upload.error = ''
        rescueRenderAttachments()
        const headers = {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name),
          'X-Mime-Type': encodeURIComponent(file.type || 'application/octet-stream'),
          'X-Caption': encodeURIComponent(index === 0 ? text.slice(0, 1024) : ''),
          'X-One-Time': rescueCompose.oneTime && index === 0 ? '1' : '0'
        }
        if (rescueCompose.replyTo && rescueCompose.replyTo.id != null && index === 0) headers['X-Reply-To'] = String(rescueCompose.replyTo.id)
        try {
          await teleP0v2UploadFile(file, headers, (percent, bodyDone) => {
            upload.percent = percent
            upload.phase = bodyDone ? 'telegram' : 'uploading'
            send.textContent = bodyDone ? `Telegram ${index + 1}/${attachments.length}` : `Uploading ${Math.round(percent)}%`
            rescueRenderAttachments()
          })
          upload.percent = 100; upload.phase = 'sent'; rescueRenderAttachments()
        } catch (error) {
          upload.phase = 'error'; upload.error = String(error && error.message ? error.message : error); rescueRenderAttachments(); throw error
        }
      }
    } else {
      send.textContent = 'Sending…'
      await request('send-chat-message', { chatId: state.activeChatId, text, replyToMessageId: rescueCompose.replyTo ? rescueCompose.replyTo.id : null })
    }
    input.value = ''
    input.style.height = 'auto'
    if (attachments.length) await new Promise(resolve => setTimeout(resolve, 300))
    rescueClearAttachment()
    rescueClearComposeContext()
  } catch (error) {
    toast(String(error && error.message ? error.message : error), 'error')
  } finally {
    send.disabled = false
    send.textContent = 'Send'
    input.focus()
  }
}
const teleP0v2SendButton = document.querySelector('#tele-compose-send')
if (teleP0v2SendButton) teleP0v2SendButton.onclick = () => rescueSendComposer()

/* Full path remains readable even if older download rendering rewrites the
 * helper label. This intentionally avoids a MutationObserver feedback loop. */
function teleP0v2RefreshPath () {
  const input = document.querySelector('#dl-dir')
  const current = document.querySelector('#dl-dir-current')
  if (!input || !current) return
  const helper = current.textContent.replace(/^Saving to:\s*/i, '').trim()
  const value = input.value || helper
  const display = value || 'Default download folder'
  input.title = value
  current.title = value
  if (current.textContent !== display) current.textContent = display
}
document.querySelector('#dl-dir')?.addEventListener('input', teleP0v2RefreshPath)
document.querySelector('#set-dir')?.addEventListener('click', () => setTimeout(teleP0v2RefreshPath, 80))
setInterval(teleP0v2RefreshPath, 1500)
teleP0v2RefreshPath()
