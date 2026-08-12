'use strict'

/* Daily-driver acceptance hotfix v2.
 * Stable v2 UI, chat-scoped file indexes, non-destructive message state,
 * fast thumbnail-first preview, and consistent persisted file markings.
 */

function teleHotfixChatKey (chatId) { return String(chatId) }
const teleHotfixValidatedChats = new Set()

function teleHotfixSnapshotBelongsToChat (chatId, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items)) return false
  const wanted = teleHotfixChatKey(chatId)
  return snapshot.items.every(item => item && teleHotfixChatKey(item.chatId) === wanted)
}

function teleHotfixDropContaminatedSnapshot (chatId) {
  const key = teleHotfixChatKey(chatId)
  const snapshot = rescueFileCache.get(key)
  if (snapshot && !teleHotfixSnapshotBelongsToChat(chatId, snapshot)) rescueFileCache.delete(key)
}

function teleHotfixSortFileItems (items) {
  return items.sort((a, b) => {
    const aa = BigInt(String((a && a.messageId) || 0))
    const bb = BigInt(String((b && b.messageId) || 0))
    return aa === bb ? 0 : (aa < bb ? 1 : -1)
  })
}

/* Critical isolation: the old rescueApplyCompleteFiles copied an entire file
 * index into state.messages. That made a previous 20k-file channel appear as
 * the next chat's file count and also polluted message history. File indexes
 * now stay in rescueFileCache only. */
rescueApplyCompleteFiles = function teleHotfixApplyFileSnapshot (chatId, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items)) return
  if (!teleHotfixSnapshotBelongsToChat(chatId, snapshot)) return
  state.mediaCount = snapshot.items.length
  state.typeCounts = snapshot.typeCounts || null
}

/* Files view now reads only the active chat's scoped index. Message history is
 * never used as the canonical whole-chat file source. */
filesItems = function teleHotfixFilesItems () {
  let list
  if (state.files.mode === 'search') {
    list = state.files.results.slice()
  } else {
    const key = state.activeChatId == null ? null : teleHotfixChatKey(state.activeChatId)
    const snapshot = key ? rescueFileCache.get(key) : null
    list = snapshot && teleHotfixSnapshotBelongsToChat(state.activeChatId, snapshot)
      ? snapshot.items.slice()
      : []
  }

  const q = String(state.files.query || '').trim().toLowerCase()
  if (q) list = list.filter(it => (it.name || '').toLowerCase().includes(q) || (it.caption || '').toLowerCase().includes(q))
  if (state.files.filter !== 'all') list = list.filter(it => it.type === state.files.filter)

  const compareIds = (a, b) => {
    const aa = BigInt(String((a && a.messageId) || 0))
    const bb = BigInt(String((b && b.messageId) || 0))
    return aa === bb ? 0 : (aa < bb ? -1 : 1)
  }
  switch (state.files.sort) {
    case 'oldest': list.sort(compareIds); break
    case 'name': list.sort((a, b) => (a.name || '').localeCompare(b.name || '')); break
    case 'size': list.sort((a, b) => (b.fileSize || 0) - (a.fileSize || 0)); break
    default: list.sort((a, b) => compareIds(b, a))
  }
  return list
}

function teleHotfixUpdateScopedMediaLabel () {
  const key = state.activeChatId == null ? null : teleHotfixChatKey(state.activeChatId)
  const snapshot = key ? rescueFileCache.get(key) : null
  const valid = snapshot && teleHotfixSnapshotBelongsToChat(state.activeChatId, snapshot)
  const count = valid ? snapshot.items.length : 0
  const label = document.querySelector('#chat-media-count')
  if (label) {
    if (state.activeChatId == null) label.textContent = ''
    else if (!valid && state.view === 'files') label.textContent = 'Loading files…'
    else if (valid) label.textContent = `${count.toLocaleString()} file${count === 1 ? '' : 's'}`
    else label.textContent = ''
  }
  const downloadAll = document.querySelector('#download-all-media')
  if (downloadAll) {
    downloadAll.textContent = valid ? `Download all media (${count.toLocaleString()})` : 'Download all media'
    downloadAll.disabled = !valid || count === 0
  }
  const selectAll = document.querySelector('#select-all-media')
  if (selectAll) {
    selectAll.textContent = valid ? `Select all (${count.toLocaleString()})` : 'Select all'
    selectAll.disabled = !valid || count === 0
  }
}
rescueUpdateMediaLabel = teleHotfixUpdateScopedMediaLabel
updateMediaCountLabel = teleHotfixUpdateScopedMediaLabel

const teleHotfixBaseOpenChat = openChat
openChat = async function teleHotfixOpenChat (chatId) {
  const key = teleHotfixChatKey(chatId)
  teleHotfixDropContaminatedSnapshot(chatId)
  /* Do not show an unvalidated whole-chat count on first entry in this page
   * session. Force one scoped scan, then revisits are instant. */
  if (!teleHotfixValidatedChats.has(key)) rescueFileCache.delete(key)
  const result = await teleHotfixBaseOpenChat(chatId)
  teleHotfixUpdateScopedMediaLabel()
  return result
}

function teleHotfixApplyProgress (payload) {
  if (!payload || payload.chatId == null) return
  const key = teleHotfixChatKey(payload.chatId)
  const current = rescueFileCache.get(key)
  const snapshot = current && teleHotfixSnapshotBelongsToChat(payload.chatId, current)
    ? current
    : { chatId: payload.chatId, items: [], found: 0, scanned: 0, typeCounts: {}, savedAt: Date.now(), done: false }

  const byKey = new Map((snapshot.items || []).map(item => [String(item.key || `${item.chatId}:${item.messageId}`), item]))
  for (const item of payload.items || []) {
    if (!item || teleHotfixChatKey(item.chatId) !== key) continue
    byKey.set(String(item.key || `${item.chatId}:${item.messageId}`), item)
  }
  snapshot.chatId = payload.chatId
  snapshot.items = teleHotfixSortFileItems([...byKey.values()])
  /* item count is authoritative; never trust a transient/global found count */
  snapshot.found = snapshot.items.length
  snapshot.scanned = Number(payload.scanned || snapshot.scanned || 0)
  snapshot.typeCounts = payload.typeCounts || snapshot.typeCounts || {}
  snapshot.savedAt = Date.now()
  snapshot.done = !!payload.done
  rescueFileCache.set(key, snapshot)
  if (payload.done) teleHotfixValidatedChats.add(key)

  if (state.activeChatId == null || teleHotfixChatKey(state.activeChatId) !== key || state.view !== 'files') return
  rescueApplyCompleteFiles(payload.chatId, snapshot)
  teleHotfixUpdateScopedMediaLabel()
  setLoadState(payload.done
    ? `Loaded all ${snapshot.items.length.toLocaleString()} files`
    : `Loading files… ${snapshot.items.length.toLocaleString()} found`)
  renderFiles()
}

const teleHotfixBaseHandleEvent = handleEvent
handleEvent = function teleHotfixHandleEvent (ev) {
  if (ev && ev.name === 'media-index-progress') {
    teleHotfixApplyProgress(ev.payload || {})
    return
  }
  return teleHotfixBaseHandleEvent(ev)
}

rescueEnsureAllFiles = async function teleHotfixEnsureAllFiles (chatId) {
  if (chatId == null) return
  const key = teleHotfixChatKey(chatId)
  teleHotfixDropContaminatedSnapshot(chatId)
  const cached = rescueFileCache.get(key)
  if (cached && cached.done && teleHotfixValidatedChats.has(key)) {
    if (state.activeChatId != null && teleHotfixChatKey(state.activeChatId) === key && state.view === 'files') {
      rescueApplyCompleteFiles(chatId, cached)
      renderFiles()
      teleHotfixUpdateScopedMediaLabel()
      setLoadState(`Loaded all ${cached.items.length.toLocaleString()} files`)
    }
    return cached
  }
  if (rescueFileInflight.has(key)) return rescueFileInflight.get(key)

  const generation = rescueOpenGeneration
  const work = (async () => {
    try {
      const force = !teleHotfixValidatedChats.has(key)
      const data = await request('scan-media-v3', { chatId, force })
      const snapshot = {
        chatId,
        items: teleHotfixSortFileItems(((data && data.items) || []).filter(item => item && teleHotfixChatKey(item.chatId) === key)),
        found: 0,
        scanned: Number((data && data.scanned) || 0),
        typeCounts: (data && data.typeCounts) || {},
        savedAt: Date.now(),
        done: data ? data.done !== false : true
      }
      snapshot.found = snapshot.items.length
      rescueFileCache.set(key, snapshot)
      if (snapshot.done) teleHotfixValidatedChats.add(key)
      if (state.activeChatId == null || teleHotfixChatKey(state.activeChatId) !== key || generation !== rescueOpenGeneration || state.view !== 'files') return snapshot
      rescueApplyCompleteFiles(chatId, snapshot)
      renderFiles()
      teleHotfixUpdateScopedMediaLabel()
      setLoadState(`Loaded all ${snapshot.items.length.toLocaleString()} files`)
      return snapshot
    } catch (error) {
      if (state.activeChatId != null && teleHotfixChatKey(state.activeChatId) === key && state.view === 'files') {
        setLoadState('Failed to load files. Reopen Files to retry.')
        toast(String(error && error.message ? error.message : error), 'error')
      }
      throw error
    } finally {
      rescueFileInflight.delete(key)
    }
  })()
  rescueFileInflight.set(key, work)
  return work
}

function teleHotfixMediaUrl (item, retryToken) {
  const params = new URLSearchParams()
  params.set('name', String((item && item.name) || 'file'))
  if (item && item.mime) params.set('mime', String(item.mime))
  if (item && item.chatId != null) params.set('chatId', String(item.chatId))
  if (item && item.messageId != null) params.set('messageId', String(item.messageId))
  if (retryToken) params.set('retry', String(retryToken))
  return `/api/media-preview/${encodeURIComponent(item && item.fileId != null ? item.fileId : 0)}?${params.toString()}`
}

async function teleHotfixThumbUrl (item) {
  if (!item) return null
  if (item.thumbUrl) return '/dl' + item.thumbUrl
  if (!item.thumbFileId) return null
  try {
    const data = await request('get-thumb', { fileId: item.thumbFileId })
    if (!data || !data.path) return null
    item.thumbUrl = data.path
    return '/dl' + data.path
  } catch { return null }
}

function teleHotfixPreviewModal () {
  let modal = document.querySelector('#tele-hotfix-preview')
  if (modal) return modal
  modal = document.createElement('div')
  modal.id = 'tele-hotfix-preview'
  modal.className = 'tele-hotfix-preview hidden'
  modal.innerHTML = `
    <div class="tele-hotfix-preview-shell" role="dialog" aria-modal="true">
      <header><div><strong id="tele-hotfix-preview-title">Media</strong><span id="tele-hotfix-preview-meta"></span></div><button id="tele-hotfix-preview-close" class="ghost small" type="button" aria-label="Close">×</button></header>
      <main id="tele-hotfix-preview-body"></main>
    </div>`
  document.body.appendChild(modal)
  const close = () => {
    modal.classList.add('hidden')
    const body = modal.querySelector('#tele-hotfix-preview-body')
    body.querySelectorAll('video,audio').forEach(media => { try { media.pause() } catch {}; media.removeAttribute('src'); try { media.load() } catch {} })
    body.innerHTML = ''
  }
  modal.querySelector('#tele-hotfix-preview-close').onclick = close
  modal.addEventListener('mousedown', event => { if (event.target === modal) close() })
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !modal.classList.contains('hidden')) close() })
  return modal
}

rescuePreviewFile = async function teleHotfixPreviewFile (item) {
  if (!item || !item.fileId) return toast('This Telegram file is not available yet', 'error')
  const modal = teleHotfixPreviewModal()
  const body = modal.querySelector('#tele-hotfix-preview-body')
  modal.querySelector('#tele-hotfix-preview-title').textContent = item.name || 'Media'
  modal.querySelector('#tele-hotfix-preview-meta').textContent = `${String(item.type || 'file').replace('_', ' ')} · ${fmtSize(item.fileSize || 0)}`
  body.innerHTML = '<div class="tele-hotfix-preview-state">Opening media…</div>'
  modal.classList.remove('hidden')

  const url = teleHotfixMediaUrl(item)
  const thumb = await teleHotfixThumbUrl(item)
  let node
  if (item.type === 'photo' || item.type === 'gif' || item.type === 'sticker') {
    node = document.createElement('img')
    node.alt = item.name || ''
    if (thumb) {
      node.src = thumb
      body.innerHTML = ''
      body.appendChild(node)
    }
    const full = new Image()
    full.alt = node.alt
    full.onload = () => { if (!modal.classList.contains('hidden')) { body.innerHTML = ''; body.appendChild(full) } }
    full.onerror = () => {
      if (thumb) return
      body.innerHTML = '<div class="tele-hotfix-preview-state">Could not open this image. Try again or download the original.</div>'
    }
    full.src = url
    return
  }

  if (item.type === 'video' || item.type === 'video_note') {
    node = document.createElement('video')
    node.controls = true
    node.autoplay = false
    node.playsInline = true
    node.preload = 'metadata'
    if (thumb) node.poster = thumb
    body.innerHTML = ''
    body.appendChild(node)
    node.src = url
    node.load()
    node.onerror = () => {
      body.innerHTML = '<div class="tele-hotfix-preview-state">This video could not be streamed in the browser. Download the original if its codec is unsupported.</div>'
    }
    return
  }

  if (item.type === 'audio' || item.type === 'voice') {
    node = document.createElement('audio')
    node.controls = true
    node.preload = 'metadata'
    body.innerHTML = ''
    body.appendChild(node)
    node.src = url
    return
  }

  body.innerHTML = '<div class="tele-hotfix-preview-state">This file type has no browser preview. Use Download selected.</div>'
}

const teleHotfixBaseBuildGridCard = buildGridCard
buildGridCard = function teleHotfixBuildGridCard (item) {
  const card = teleHotfixBaseBuildGridCard(item)
  const thumb = card.querySelector('.gthumb')
  if (thumb) {
    thumb.style.cursor = 'pointer'
    thumb.title = item.type === 'video' || item.type === 'video_note' ? 'Play video' : 'Open preview'
    thumb.onclick = event => { event.stopPropagation(); rescuePreviewFile(item) }
  }
  return card
}

const teleHotfixBaseBuildMediaRow = buildMediaRow
buildMediaRow = function teleHotfixBuildMediaRow (message, includeSelection = true) {
  const row = teleHotfixBaseBuildMediaRow(message, includeSelection)
  if (message && message.media) {
    const mediaHost = row.querySelector('.thumb, img, video, .icon')
    if (mediaHost) {
      mediaHost.style.cursor = 'pointer'
      mediaHost.onclick = event => { event.stopPropagation(); rescuePreviewFile(message.media) }
    }
  }
  return row
}

/* Capture selected keys before the legacy Unmark handler clears selection. */
let teleHotfixUnmarkKeys = []
const teleHotfixUnmark = document.querySelector('#unmark-completed')
if (teleHotfixUnmark) {
  teleHotfixUnmark.addEventListener('click', () => {
    teleHotfixUnmarkKeys = [...new Set([...state.selection.keys(), ...state.selectedMessages.keys()].map(String))]
  }, true)
  teleHotfixUnmark.addEventListener('click', () => {
    queueMicrotask(() => {
      for (const key of teleHotfixUnmarkKeys) rescueDownloadedMarks.delete(key)
      rescueSaveMarkSet('tele-downloaded-files-v1', rescueDownloadedMarks)
      teleHotfixUnmarkKeys = []
      if (state.view === 'files') renderFiles()
    })
  })
}
