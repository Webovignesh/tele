'use strict'

/* Daily-driver acceptance hotfix.
 * Keeps the stable v2 UI runtime, but switches whole-chat file indexing to the
 * chat-scoped v3 engine, hardens media preview rehydration, and keeps persisted
 * file badges consistent with operator actions.
 */

function teleHotfixChatKey (chatId) { return String(chatId) }

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

const teleHotfixBaseOpenChat = openChat
openChat = async function teleHotfixOpenChat (chatId) {
  teleHotfixDropContaminatedSnapshot(chatId)
  return teleHotfixBaseOpenChat(chatId)
}

function teleHotfixSortFileItems (items) {
  return items.sort((a, b) => {
    const aa = BigInt(String(a && a.messageId || 0))
    const bb = BigInt(String(b && b.messageId || 0))
    return aa === bb ? 0 : (aa < bb ? 1 : -1)
  })
}

function teleHotfixApplyProgress (payload) {
  if (!payload || payload.chatId == null) return
  const key = teleHotfixChatKey(payload.chatId)
  const current = rescueFileCache.get(key)
  const snapshot = current && teleHotfixSnapshotBelongsToChat(payload.chatId, current)
    ? current
    : { chatId: payload.chatId, items: [], found: 0, scanned: 0, typeCounts: {}, savedAt: Date.now() }

  const byKey = new Map((snapshot.items || []).map(item => [String(item.key || `${item.chatId}:${item.messageId}`), item]))
  for (const item of payload.items || []) {
    if (!item || teleHotfixChatKey(item.chatId) !== key) continue
    byKey.set(String(item.key || `${item.chatId}:${item.messageId}`), item)
  }
  snapshot.chatId = payload.chatId
  snapshot.items = teleHotfixSortFileItems([...byKey.values()])
  snapshot.found = Number(payload.found == null ? snapshot.items.length : payload.found)
  snapshot.scanned = Number(payload.scanned || snapshot.scanned || 0)
  snapshot.typeCounts = payload.typeCounts || snapshot.typeCounts || {}
  snapshot.savedAt = Date.now()
  snapshot.done = !!payload.done
  rescueFileCache.set(key, snapshot)

  if (state.activeChatId == null || teleHotfixChatKey(state.activeChatId) !== key || state.view !== 'files') return
  rescueApplyCompleteFiles(payload.chatId, snapshot)
  rescueUpdateMediaLabel()
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
  if (cached && cached.done !== false) {
    if (state.activeChatId != null && teleHotfixChatKey(state.activeChatId) === key && state.view === 'files') {
      rescueApplyCompleteFiles(chatId, cached)
      renderFiles()
      rescueUpdateMediaLabel()
      setLoadState(`Loaded all ${cached.items.length.toLocaleString()} files`)
    }
    return cached
  }
  if (rescueFileInflight.has(key)) return rescueFileInflight.get(key)

  const generation = rescueOpenGeneration
  const work = (async () => {
    try {
      const data = await request('scan-media-v3', { chatId, force: false })
      const snapshot = {
        chatId,
        items: teleHotfixSortFileItems(((data && data.items) || []).filter(item => item && teleHotfixChatKey(item.chatId) === key)),
        found: Number(data && data.found || 0),
        scanned: Number(data && data.scanned || 0),
        typeCounts: (data && data.typeCounts) || {},
        savedAt: Date.now(),
        done: data ? data.done !== false : true
      }
      rescueFileCache.set(key, snapshot)
      if (state.activeChatId == null || teleHotfixChatKey(state.activeChatId) !== key || generation !== rescueOpenGeneration || state.view !== 'files') return snapshot
      rescueApplyCompleteFiles(chatId, snapshot)
      renderFiles()
      rescueUpdateMediaLabel()
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
  params.set('name', String(item && item.name || 'file'))
  if (item && item.mime) params.set('mime', String(item.mime))
  if (item && item.chatId != null) params.set('chatId', String(item.chatId))
  if (item && item.messageId != null) params.set('messageId', String(item.messageId))
  if (retryToken) params.set('retry', String(retryToken))
  return `/api/media-preview/${encodeURIComponent(item && item.fileId != null ? item.fileId : 0)}?${params.toString()}`
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
    body.querySelectorAll('video,audio').forEach(media => { try { media.pause() } catch {}; media.removeAttribute('src') })
    body.innerHTML = ''
  }
  modal.querySelector('#tele-hotfix-preview-close').onclick = close
  modal.addEventListener('mousedown', event => { if (event.target === modal) close() })
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !modal.classList.contains('hidden')) close() })
  return modal
}

rescuePreviewFile = function teleHotfixPreviewFile (item) {
  if (!item || !item.fileId) return toast('This Telegram file is not available yet', 'error')
  const modal = teleHotfixPreviewModal()
  const body = modal.querySelector('#tele-hotfix-preview-body')
  const title = modal.querySelector('#tele-hotfix-preview-title')
  const meta = modal.querySelector('#tele-hotfix-preview-meta')
  title.textContent = item.name || 'Media'
  meta.textContent = `${String(item.type || 'file').replace('_', ' ')} · ${fmtSize(item.fileSize || 0)}`
  body.innerHTML = '<div class="tele-hotfix-preview-state">Preparing media…</div>'
  modal.classList.remove('hidden')
  const url = teleHotfixMediaUrl(item)

  let node
  if (item.type === 'photo' || item.type === 'gif' || item.type === 'sticker') {
    node = document.createElement('img')
    node.alt = item.name || ''
    node.onload = () => { body.innerHTML = ''; body.appendChild(node) }
  } else if (item.type === 'video' || item.type === 'video_note') {
    node = document.createElement('video')
    node.controls = true
    node.autoplay = true
    node.playsInline = true
    node.preload = 'metadata'
    node.onloadedmetadata = () => { body.innerHTML = ''; body.appendChild(node); node.play().catch(() => {}) }
  } else if (item.type === 'audio' || item.type === 'voice') {
    node = document.createElement('audio')
    node.controls = true
    node.autoplay = true
    node.preload = 'metadata'
    body.innerHTML = ''
    body.appendChild(node)
  } else {
    body.innerHTML = '<div class="tele-hotfix-preview-state">This file type has no browser preview. Use Download selected.</div>'
    return
  }

  node.onerror = () => {
    body.innerHTML = ''
    const box = document.createElement('div')
    box.className = 'tele-hotfix-preview-state'
    box.textContent = 'Could not prepare this media. '
    const retry = document.createElement('button')
    retry.type = 'button'
    retry.textContent = 'Retry'
    retry.onclick = () => { node.src = teleHotfixMediaUrl(item, Date.now()) }
    box.appendChild(retry)
    body.appendChild(box)
  }
  node.src = url
}

const teleHotfixBaseBuildGridCard = buildGridCard
buildGridCard = function teleHotfixBuildGridCard (item) {
  const card = teleHotfixBaseBuildGridCard(item)
  const thumb = card.querySelector('.gthumb')
  if (thumb) {
    thumb.style.cursor = 'pointer'
    thumb.onclick = event => { event.stopPropagation(); rescuePreviewFile(item) }
  }
  return card
}

const teleHotfixBaseBuildMediaRow = buildMediaRow
buildMediaRow = function teleHotfixBuildMediaRow (message, includeSelection = true) {
  const row = teleHotfixBaseBuildMediaRow(message, includeSelection)
  if (message && message.media) {
    const mediaHost = row.querySelector('.tele-message-media, .thumb, img, video')
    if (mediaHost) {
      mediaHost.style.cursor = 'pointer'
      mediaHost.onclick = event => { event.stopPropagation(); rescuePreviewFile(message.media) }
    }
  }
  return row
}

const teleHotfixUnmark = document.querySelector('#unmark-completed')
if (teleHotfixUnmark) {
  teleHotfixUnmark.addEventListener('click', () => {
    const keys = new Set([...state.selection.keys(), ...state.selectedMessages.keys()])
    queueMicrotask(() => {
      for (const key of keys) rescueDownloadedMarks.delete(String(key))
      rescueSaveMarkSet('tele-downloaded-files-v1', rescueDownloadedMarks)
      if (state.view === 'files') renderFiles()
    })
  })
}
