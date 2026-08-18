'use strict'

/* Cache-first rescue runtime.
 * Keeps the proven legacy downloader/forwarder intact while making chat browsing
 * resilient to rapid switching, stale requests and long media scans.
 */

const rescueChatCache = new Map()
const rescueFileCache = new Map()
const rescueAvatarCache = new Map()
const rescueFileInflight = new Map()
const rescueInflight = new Map()
const rescueDownloadedMarks = rescueLoadMarkSet('tele-downloaded-files-v1')
const rescueForwardedMarks = rescueLoadMarkSet('tele-forwarded-files-v1')
let rescueMessageRenderLimit = 120
const rescueCacheLimit = 24
const rescueMessageLimit = 400
let rescueOpenGeneration = 0
let rescueSyncTimer = null
let rescueRestoredLastChat = false

function rescueSavedChatId () {
  try { return localStorage.getItem('tele-active-chat') } catch { return null }
}

function rescueRememberChat (chatId) {
  try {
    if (chatId == null) localStorage.removeItem('tele-active-chat')
    else localStorage.setItem('tele-active-chat', String(chatId))
  } catch {}
}

function rescuePreferredView () {
  try {
    const saved = localStorage.getItem('tele-active-tab')
    return saved === 'files' ? 'files' : 'messages'
  } catch {
    return 'messages'
  }
}

function rescueRememberView (view) {
  try { localStorage.setItem('tele-active-tab', view) } catch {}
}

function rescueChatKey (chatId) { return String(chatId) }

function rescueLoadMarkSet (storageKey) {
  try {
    const raw = localStorage.getItem(storageKey)
    return new Set(raw ? JSON.parse(raw).map(String) : [])
  } catch { return new Set() }
}

function rescueSaveMarkSet (storageKey, set) {
  try { localStorage.setItem(storageKey, JSON.stringify([...set])) } catch {}
}

function rescueMarkDownloaded (chatId, messageId) {
  if (chatId == null || messageId == null) return
  rescueDownloadedMarks.add(`${chatId}:${messageId}`)
  rescueSaveMarkSet('tele-downloaded-files-v1', rescueDownloadedMarks)
}

function rescueMarkForwarded (chatId, messageId) {
  if (chatId == null || messageId == null) return
  rescueForwardedMarks.add(`${chatId}:${messageId}`)
  rescueSaveMarkSet('tele-forwarded-files-v1', rescueForwardedMarks)
}

function rescueMessageSignature (messages) {
  return (messages || []).slice(0, 120).map(m => [
    String(m.id || ''),
    String(m.date || ''),
    String(m.text || ''),
    String(m.media && (m.media.fileId || (m.media.file && m.media.file.id)) || '')
  ].join(':')).join('|')
}

const rescueLegacyRenderMessagesList = renderMessagesList
renderMessagesList = function rescueWindowedMessageRender () {
  const all = state.messages
  if (!Array.isArray(all) || all.length <= rescueMessageRenderLimit) return rescueLegacyRenderMessagesList()
  state.messages = all.slice(0, rescueMessageRenderLimit)
  try { return rescueLegacyRenderMessagesList() } finally { state.messages = all }
}

const rescueMessagesPanelForWindow = $('#messages')
if (rescueMessagesPanelForWindow) {
  rescueMessagesPanelForWindow.addEventListener('scroll', () => {
    if (rescueMessagesPanelForWindow.scrollTop > 80 || rescueMessageRenderLimit >= state.messages.length) return
    const beforeHeight = rescueMessagesPanelForWindow.scrollHeight
    rescueMessageRenderLimit = Math.min(state.messages.length, rescueMessageRenderLimit + 120)
    renderMessagesList()
    rescueMessagesPanelForWindow.scrollTop = Math.max(1, rescueMessagesPanelForWindow.scrollHeight - beforeHeight)
  }, true)
}

function rescueMarkActiveChat (chatId) {
  const wanted = rescueChatKey(chatId)
  document.querySelectorAll('#chat-list .chat-item.active').forEach(node => node.classList.remove('active'))
  const next = [...document.querySelectorAll('#chat-list .chat-item')]
    .find(node => rescueChatKey(node.dataset.chatId) === wanted)
  if (next) next.classList.add('active')
}

function rescueTrimCache () {
  while (rescueChatCache.size > rescueCacheLimit) {
    rescueChatCache.delete(rescueChatCache.keys().next().value)
  }
}

function rescueSaveActiveChat () {
  if (state.activeChatId == null) return
  const key = rescueChatKey(state.activeChatId)
  const messages = state.messages.slice(0, rescueMessageLimit)
  rescueChatCache.delete(key)
  rescueChatCache.set(key, {
    messages,
    hasMore: !!state.hasMore,
    savedAt: Date.now()
  })
  rescueTrimCache()
}

function rescueLoadedMediaCount () {
  return state.messages.reduce((n, m) => n + (m && m.media ? 1 : 0), 0)
}

function rescueUpdateMediaLabel () {
  const key = state.activeChatId == null ? null : rescueChatKey(state.activeChatId)
  const snapshot = key ? rescueFileCache.get(key) : null
  const recentCount = rescueLoadedMediaCount()
  const count = snapshot && Array.isArray(snapshot.items) ? snapshot.items.length : recentCount
  const label = $('#chat-media-count')
  if (label) {
    if (state.activeChatId == null) label.textContent = ''
    else if (snapshot) label.textContent = `${count} file${count === 1 ? '' : 's'}`
    else if (state.view === 'files') label.textContent = 'Loading files…'
    else label.textContent = count ? `${count} recent file${count === 1 ? '' : 's'}` : ''
  }
  const downloadAll = $('#download-all-media')
  if (downloadAll) {
    downloadAll.textContent = snapshot ? `Download all media (${count})` : 'Download all media'
    downloadAll.disabled = state.activeChatId == null
  }
  const selectAll = $('#select-all-media')
  if (selectAll && (!snapshot || state.view !== 'files')) {
    selectAll.textContent = 'Select all'
    selectAll.disabled = true
  }
}

// Replace the old eager whole-history counter. Whole-chat work is now only
// initiated by explicit user actions (Download all / Search whole chat).
updateMediaCountLabel = rescueUpdateMediaLabel

const rescueBaseSetView = setView
setView = function rescueSetView (view) {
  rescueRememberView(view)
  rescueBaseSetView(view)
  if (typeof rescueUpdateComposerVisibility === 'function') rescueUpdateComposerVisibility()
  if (view === 'files' && state.activeChatId != null) {
    rescueEnsureAllFiles(state.activeChatId)
  }
}

function rescueMergeMessages (chatId, incoming) {
  const byKey = new Map()
  for (const m of state.messages) {
    const key = `${chatId}:${m.id}`
    byKey.set(key, { ...m, key })
  }
  for (const m of incoming || []) {
    const key = `${chatId}:${m.id}`
    byKey.set(key, { ...m, key })
  }
  state.messages = [...byKey.values()]
    .sort((a, b) => {
      const aa = BigInt(String(a.id || 0))
      const bb = BigInt(String(b.id || 0))
      return aa === bb ? 0 : (aa < bb ? 1 : -1)
    })
    .slice(0, rescueMessageLimit)
}

function rescueRenderCurrent () {
  if (state.view === 'messages') {
    renderMessagesList()
  } else {
    const key = state.activeChatId == null ? null : rescueChatKey(state.activeChatId)
    if (!key || !rescueFileInflight.has(key)) renderFiles()
  }
  rescueUpdateMediaLabel()
}

function rescueApplyCompleteFiles (chatId, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.items)) return
  const keep = state.messages.filter(m => !m.media)
  const mediaMessages = snapshot.items.map(it => ({
    ...it,
    id: it.messageId,
    key: `${chatId}:${it.messageId}`,
    media: it
  }))
  state.messages = [...keep, ...mediaMessages].sort((a, b) => {
    const aa = BigInt(String(a.id || 0))
    const bb = BigInt(String(b.id || 0))
    return aa === bb ? 0 : (aa < bb ? 1 : -1)
  })
  // state.mediaCount = snapshot.found == null ? snapshot.items.length : snapshot.found // REMOVED: owner is files-stability.js
  state.typeCounts = snapshot.typeCounts || null
  state.hasMore = false
}

/* A thin delegate to the Files index owner, with no cache write of its own.
 *
 * This was the original whole-chat file loader: it called the legacy `scan-media`
 * request, polled it while it answered `busy`, and wrote the result straight into
 * `rescueFileCache`. Five later layers each replaced this global with their own
 * version, so which implementation ran depended on load order, and every one of them
 * wrote the shared cache.
 *
 * `public/files-stability.js` assigns `rescueEnsureAllFiles = ensure` when it loads, so
 * in the running application this body is superseded within a tick. It is kept as a
 * delegate rather than deleted because `rescue-runtime.js` declares the symbol that
 * `setView` and several layers call, and because a delegate cannot resurrect anything:
 * it holds no state, writes no cache and issues no scan.
 *
 * `rescueFileCache` stays declared in this file. Many layers still READ it, and the
 * owner writes it on every commit so those readers see the committed index. */
async function rescueEnsureAllFiles (chatId) {
  if (chatId == null) return null
  try {
    if (window.teleFilesIndex && typeof window.teleFilesIndex.ensure === 'function') {
      return await window.teleFilesIndex.ensure(chatId)
    }
  } catch {}
  return rescueFileCache.get(rescueChatKey(chatId)) || null
}

loadMessages = async function rescueLoadMessages (chatId, fromMessageId) {
  if (chatId == null) return
  const chatKey = rescueChatKey(chatId)
  const oldest = state.messages[state.messages.length - 1]
  const cursor = fromMessageId || (oldest ? oldest.id : 0)
  const requestKey = `${chatKey}:${String(cursor || 0)}`
  if (rescueInflight.has(requestKey)) return rescueInflight.get(requestKey)

  const generation = rescueOpenGeneration
  const messagePanel = $('#messages')
  const preserveMessageViewport = state.view === 'messages' && messagePanel
  const beforeHeight = preserveMessageViewport ? messagePanel.scrollHeight : 0
  const beforeTop = preserveMessageViewport ? messagePanel.scrollTop : 0
  if (rescueChatKey(state.activeChatId) === chatKey) {
    state.loadingMore = true
    setLoadState(state.messages.length ? 'Refreshing…' : 'loading')
  }

  const work = (async () => {
    try {
      const data = await request('get-messages', { chatId, fromMessageId: cursor || 0, limit: 100 })
      if (rescueChatKey(state.activeChatId) !== chatKey || generation !== rescueOpenGeneration) return
      rescueMergeMessages(chatId, data.messages || [])
      state.hasMore = !!data.hasMore
      rescueSaveActiveChat()
      rescueRenderCurrent()
      if (preserveMessageViewport) {
        requestAnimationFrame(() => {
          const delta = messagePanel.scrollHeight - beforeHeight
          messagePanel.scrollTop = Math.max(0, beforeTop + delta)
        })
      }
      setLoadState(state.hasMore ? '' : 'End of history')
    } catch (e) {
      if (rescueChatKey(state.activeChatId) !== chatKey) return
      const msg = String(e && e.message ? e.message : e)
      if (/can.?t access|not accessible|chat not found|have no access/i.test(msg)) {
        rescueChatCache.delete(chatKey)
        rescueFileCache.delete(chatKey)
        removeChat(chatId)
        toast('Chat is no longer accessible and was removed from the list', 'error')
      } else {
        toast(msg, 'error')
        setLoadState('Failed to load. Scroll to retry.')
      }
    } finally {
      rescueInflight.delete(requestKey)
      if (rescueChatKey(state.activeChatId) === chatKey) {
        state.loadingMore = [...rescueInflight.keys()].some(k => k.startsWith(chatKey + ':'))
      }
    }
  })()

  rescueInflight.set(requestKey, work)
  return work
}

openChat = async function rescueOpenChat (chatId) {
  if (state.activeChatId != null && rescueChatKey(state.activeChatId) !== rescueChatKey(chatId)) rescueSaveActiveChat()
  rescueOpenGeneration++
  state.activeChatId = chatId
  rescueRememberChat(chatId)
  rescueMessageRenderLimit = 120
  state.selection.clear()
  state.selectedMessages.clear()
  state.loadingMore = false
  // state.mediaCount = null // REMOVED: owner is files-stability.js
  state.typeCounts = null
  state.counting = false
  state.files = { query: '', filter: 'all', sort: 'newest', mode: 'browse', results: [], totalCount: 0, hasMore: false, fromMessageId: 0, searching: false, loadingAll: false }

  $('#file-search').value = ''
  $('#file-filter').value = 'all'
  $('#file-sort').value = 'newest'
  updateSelectionBar()
  rescueMarkActiveChat(chatId)

  const chat = state.chats.find(c => rescueChatKey(c.id) === rescueChatKey(chatId))
  $('#chat-title').textContent = chat ? chat.title : 'Chat'
  $('#media-grid').innerHTML = ''
  const resetSelectAll = $('#select-all-media')
  if (resetSelectAll) { resetSelectAll.textContent = 'Select all'; resetSelectAll.disabled = true }
  const resetMediaLabel = $('#chat-media-count')
  if (resetMediaLabel) resetMediaLabel.textContent = ''

  const cached = rescueChatCache.get(rescueChatKey(chatId))
  if (cached) {
    state.messages = cached.messages.slice()
    state.hasMore = cached.hasMore
    // LRU touch.
    rescueChatCache.delete(rescueChatKey(chatId))
    rescueChatCache.set(rescueChatKey(chatId), cached)
  } else {
    state.messages = []
    state.hasMore = true
    $('#messages').innerHTML = ''
  }

  const preferredView = rescuePreferredView()
  setView(preferredView)
  renderMessagesList()
  if (preferredView === 'messages') {
    requestAnimationFrame(() => {
      const panel = $('#messages')
      if (panel) panel.scrollTop = panel.scrollHeight
    })
  }
  if (preferredView === 'files') {
    const fileSnapshot = rescueFileCache.get(rescueChatKey(chatId))
    if (fileSnapshot) {
      rescueApplyCompleteFiles(chatId, fileSnapshot)
      renderFiles()
      setLoadState(`Loaded all ${fileSnapshot.items.length} files`)
    } else {
      $('#media-grid').innerHTML = ''
      setLoadState('Loading all files…')
    }
  } else {
    setLoadState(cached ? `Cached ${state.messages.length} messages · refreshing…` : 'loading')
  }
  rescueUpdateMediaLabel()

  // Always refresh the newest page, but never blank already-cached rows while waiting.
  const generation = rescueOpenGeneration
  const requestKey = `${rescueChatKey(chatId)}:latest:${generation}`
  await new Promise(resolve => requestAnimationFrame(() => resolve()))
  const work = (async () => {
    try {
      const data = await request('get-messages', { chatId, fromMessageId: 0, limit: 100 })
      if (rescueChatKey(state.activeChatId) !== rescueChatKey(chatId) || generation !== rescueOpenGeneration) return
      const beforeSignature = rescueMessageSignature(state.messages)
      rescueMergeMessages(chatId, data.messages || [])
      state.hasMore = !!data.hasMore
      rescueSaveActiveChat()
      if (rescueMessageSignature(state.messages) !== beforeSignature) rescueRenderCurrent()
      else rescueUpdateMediaLabel()
      setLoadState(state.hasMore ? '' : 'End of history')
    } catch (e) {
      if (rescueChatKey(state.activeChatId) !== rescueChatKey(chatId)) return
      const msg = String(e && e.message ? e.message : e)
      if (/can.?t access|not accessible|chat not found|have no access/i.test(msg)) {
        rescueChatCache.delete(rescueChatKey(chatId))
        rescueFileCache.delete(rescueChatKey(chatId))
        removeChat(chatId)
        toast('Chat is no longer accessible and was removed from the list', 'error')
      } else {
        setLoadState(cached ? 'Showing cached messages' : 'Failed to load. Scroll to retry.')
        toast(msg, 'error')
      }
    } finally {
      rescueInflight.delete(requestKey)
      if (rescueChatKey(state.activeChatId) === rescueChatKey(chatId)) state.loadingMore = false
    }
  })()
  rescueInflight.set(requestKey, work)
}

// Render real Telegram chat photos when TDLib exposes one, falling back to initials.
function rescueLoadAvatar (chat, holder) {
  if (!chat || !chat.photoFileId || !holder) return
  const key = rescueChatKey(chat.id)
  const cachedUrl = rescueAvatarCache.get(key) || chat._avatarUrl
  if (cachedUrl) {
    rescueAvatarCache.set(key, cachedUrl)
    chat._avatarUrl = cachedUrl
    holder.textContent = ''
    const img = h('img', 'chat-avatar-img')
    img.src = '/dl' + cachedUrl
    img.alt = ''
    holder.appendChild(img)
    return
  }
  if (chat._avatarPending) return
  chat._avatarPending = true
  request('get-thumb', { fileId: chat.photoFileId }).then(data => {
    chat._avatarPending = false
    if (!data || !data.path) return
    chat._avatarUrl = data.path
    rescueAvatarCache.set(key, data.path)
    const live = document.querySelector(`.chat-item[data-chat-id="${CSS.escape(String(chat.id))}"] .chat-avatar`)
    if (!live) return
    live.textContent = ''
    const img = h('img', 'chat-avatar-img')
    img.src = '/dl' + data.path
    img.alt = ''
    live.appendChild(img)
  }).catch(() => { chat._avatarPending = false })
}

function rescueChatTypeSvg (kind) {
  const common = 'width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
  if (kind === 'channel') return `<svg ${common}><path d="M4 13h3l9 5V6l-9 5H4z"/><path d="M7 13v5"/><path d="M19 9a4 4 0 0 1 0 6"/></svg>`
  if (kind === 'group' || kind === 'supergroup') return `<svg ${common}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`
  return `<svg ${common}><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>`
}

function rescueMediaTypeSvg (kind) {
  const common = 'width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
  if (kind === 'video' || kind === 'video_note') return `<svg ${common}><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3z"/></svg>`
  if (kind === 'photo' || kind === 'sticker') return `<svg ${common}><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 20"/></svg>`
  if (kind === 'audio' || kind === 'voice') return `<svg ${common}><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>`
  return `<svg ${common}><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5"/></svg>`
}

function rescueSortChatsRecentFirst () {
  state.chats.sort((a, b) => {
    const aa = BigInt(String((a && a.order) || '0'))
    const bb = BigInt(String((b && b.order) || '0'))
    if (aa !== bb) return aa < bb ? 1 : -1
    return String(a && a.title || '').localeCompare(String(b && b.title || ''))
  })
}

renderChats = function rescueRenderChats () {
  rescueSortChatsRecentFirst()
  const list = $('#chat-list')
  list.innerHTML = ''
  const q = $('#chat-search').value.toLowerCase()
  const channelsOnly = $('#channels-only').checked
  let shown = 0
  for (const chat of state.chats) {
    const searchable = `${chat.title || ''} ${chat.username || ''}`.toLowerCase()
    if (q && !searchable.includes(q)) continue
    if (channelsOnly && chat.kind !== 'channel') continue
    shown++
    const li = h('li', 'chat-item' + (rescueChatKey(chat.id) === rescueChatKey(state.activeChatId) ? ' active' : ''))
    li.dataset.chatId = String(chat.id)
    const av = h('div', 'chat-avatar')
    av.style.background = avatarColor(chat.title)
    av.textContent = initials(chat.title)
    li.appendChild(av)
    rescueLoadAvatar(chat, av)

    const col = h('div', 'col')
    col.appendChild(h('div', 't', chat.title))
    const identity = chat.username ? '@' + chat.username : (chat.lastText || '')
    if (identity) {
      const preview = h('div', 'preview', identity)
      preview.title = identity
      col.appendChild(preview)
    }
    li.appendChild(col)
    const u = h('div', 'u chat-kind')
    u.innerHTML = rescueChatTypeSvg(chat.kind)
    if (chat.unread > 0) u.appendChild(h('span', 'chat-unread', String(chat.unread)))
    li.appendChild(u)
    li.onclick = () => openChat(chat.id)
    list.appendChild(li)
  }
  $('#chat-count').textContent = channelsOnly ? `${shown} channels` : `${state.chats.length} chats`
}

const rescueBaseLoadChats = loadChats
loadChats = async function rescueLoadChats () {
  try {
    const data = await request('get-chats')
    const previousById = new Map(state.chats.map(c => [rescueChatKey(c.id), c]))
    state.chats = (data.chats || []).map(c => ({ ...previousById.get(rescueChatKey(c.id)), ...c }))
    rescueSortChatsRecentFirst()
    state.chats.forEach(c => {
      if (c.lastMessage && c.lastMessage._ === 'messageText') c.lastText = c.lastMessage.text?.text || ''
    })

    if (state.activeChatId != null && !state.chats.some(c => rescueChatKey(c.id) === rescueChatKey(state.activeChatId))) {
      rescueChatCache.delete(rescueChatKey(state.activeChatId))
      removeChat(state.activeChatId)
    } else {
      renderChats()
      if (!rescueRestoredLastChat && state.activeChatId == null) {
        const saved = rescueSavedChatId()
        const match = saved && state.chats.find(c => rescueChatKey(c.id) === saved)
        rescueRestoredLastChat = true
        if (match) openChat(match.id)
      }
    }
  } catch (e) {
    // Keep already-rendered chats during transient sync failures.
    if (!state.chats.length) toast(e.message, 'error')
  }
}

// Background reconciliation fixes create/rename/delete/leave even when TDLib emits
// an update shape the legacy event handler does not understand.
function rescueStartChatSync () {
  if (rescueSyncTimer) clearInterval(rescueSyncTimer)
  rescueSyncTimer = setInterval(() => {
    if (state.status === 'ready' && ws && ws.readyState === WebSocket.OPEN) loadChats()
  }, 15000)
}
rescueStartChatSync()

// Reorder tabs without waiting for a larger HTML redesign.
const rescueTabs = $('.tabs')
if (rescueTabs && $('#tab-messages') && $('#tab-files')) rescueTabs.insertBefore($('#tab-messages'), $('#tab-files'))
const rescueInitialView = rescuePreferredView()
state.view = rescueInitialView
$('#tab-messages').classList.toggle('active', rescueInitialView === 'messages')
$('#tab-files').classList.toggle('active', rescueInitialView === 'files')
$('#messages').classList.toggle('hidden', rescueInitialView !== 'messages')
$('#media-grid').classList.toggle('hidden', rescueInitialView !== 'files')
$('#files-toolbar').classList.toggle('hidden', rescueInitialView !== 'files')

// Preference restoration is explicit here as well as in the legacy handler so
// it survives future UI refactors.
try {
  const channelsOnly = localStorage.getItem('tele-channels-only') === '1'
  if ($('#channels-only')) $('#channels-only').checked = channelsOnly
} catch {}

const rescueBaseRemoveChat = removeChat
removeChat = function rescueRemoveChatPersistent (chatId) {
  if (state.activeChatId != null && rescueChatKey(state.activeChatId) === rescueChatKey(chatId)) {
    rescueRememberChat(null)
  }
  rescueChatCache.delete(rescueChatKey(chatId))
  rescueFileCache.delete(rescueChatKey(chatId))
  rescueAvatarCache.delete(rescueChatKey(chatId))
  return rescueBaseRemoveChat(chatId)
}

/* File workspace: exact-count range selection, persistent marks and previews. */
function rescueFileMarkKey (item) { return `${item.chatId}:${item.messageId}` }

function rescueIsPreviewable (item) {
  return !!item && ['photo', 'video', 'video_note', 'audio', 'voice', 'gif'].includes(item.type)
}

function rescueEnsurePreviewModal () {
  let modal = document.querySelector('#tele-preview-modal')
  if (modal) return modal
  modal = document.createElement('div')
  modal.id = 'tele-preview-modal'
  modal.className = 'tele-preview-modal hidden'
  modal.innerHTML = `<div class="tele-preview-shell"><div class="tele-preview-head"><div><strong id="tele-preview-title">Preview</strong><span id="tele-preview-meta"></span></div><button id="tele-preview-close" class="ghost small" type="button" aria-label="Close preview">×</button></div><div id="tele-preview-body" class="tele-preview-body"></div></div>`
  document.body.appendChild(modal)
  modal.addEventListener('mousedown', e => { if (e.target === modal) modal.classList.add('hidden') })
  modal.querySelector('#tele-preview-close').onclick = () => modal.classList.add('hidden')
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.classList.contains('hidden')) modal.classList.add('hidden') })
  return modal
}

function rescuePreviewFile (item) {
  if (!item || !item.fileId) return toast('This file is not available for preview yet', 'error')
  if (!rescueIsPreviewable(item)) {
    window.open(`/api/media-preview/${encodeURIComponent(item.fileId)}?name=${encodeURIComponent(item.name || 'file')}&mime=${encodeURIComponent(item.mime || '')}`, '_blank', 'noopener')
    return
  }
  const modal = rescueEnsurePreviewModal()
  const body = modal.querySelector('#tele-preview-body')
  const title = modal.querySelector('#tele-preview-title')
  const meta = modal.querySelector('#tele-preview-meta')
  const url = `/api/media-preview/${encodeURIComponent(item.fileId)}?name=${encodeURIComponent(item.name || 'file')}&mime=${encodeURIComponent(item.mime || '')}`
  title.textContent = item.name || 'Preview'
  meta.textContent = `${String(item.type || '').replace('_', ' ')} · ${fmtSize(item.fileSize || 0)}`
  body.innerHTML = '<div class="tele-preview-loading">Preparing preview…</div>'
  let node
  if (item.type === 'photo' || item.type === 'gif') {
    node = document.createElement('img')
    node.alt = item.name || ''
  } else if (item.type === 'video' || item.type === 'video_note') {
    node = document.createElement('video')
    node.controls = true
    node.autoplay = true
    node.playsInline = true
  } else {
    node = document.createElement('audio')
    node.controls = true
    node.autoplay = true
  }
  node.onload = node.onloadedmetadata = () => { body.innerHTML = ''; body.appendChild(node) }
  node.onerror = () => { body.innerHTML = '<div class="tele-preview-loading">Preview unavailable. Try Download selected.</div>' }
  node.src = url
  if (node.tagName === 'AUDIO') { body.innerHTML = ''; body.appendChild(node) }
  modal.classList.remove('hidden')
}

const rescueLegacyBuildGridCard = buildGridCard
buildGridCard = function rescuePolishedGridCard (item) {
  const card = rescueLegacyBuildGridCard(item)
  const key = rescueFileMarkKey(item)
  const icon = card.querySelector('.gthumb .icon')
  if (icon) icon.innerHTML = rescueMediaTypeSvg(item.type)
  const statuses = h('div', 'file-statuses')
  if (rescueDownloadedMarks.has(key)) statuses.appendChild(h('span', 'file-status downloaded', 'Downloaded'))
  if (rescueForwardedMarks.has(key)) statuses.appendChild(h('span', 'file-status forwarded', 'Forwarded'))
  if (statuses.children.length) card.querySelector('.gbody')?.appendChild(statuses)
  const preview = h('button', 'ghost small file-preview-action', rescueIsPreviewable(item) ? 'Preview' : 'Open')
  preview.type = 'button'
  preview.onclick = e => { e.stopPropagation(); rescuePreviewFile(item) }
  card.insertBefore(preview, card.querySelector('input[type=checkbox]'))
  return card
}

const rescueLegacyBuildMediaRow = buildMediaRow
buildMediaRow = function rescuePolishedMediaRow (message, includeSelection = true) {
  const row = rescueLegacyBuildMediaRow(message, includeSelection)
  const item = message && message.media
  const icon = row.querySelector('.icon')
  if (icon && item) icon.innerHTML = rescueMediaTypeSvg(item.type)
  if (item && item.fileId) {
    const preview = h('button', 'ghost small media-preview-action', rescueIsPreviewable(item) ? 'Preview' : 'Open')
    preview.type = 'button'
    preview.onclick = e => { e.stopPropagation(); rescuePreviewFile(item) }
    row.appendChild(preview)
  }
  return row
}

function rescueUpdateRangeControls (total) {
  const from = $('#file-range-from')
  const to = $('#file-range-to')
  const summary = $('#file-range-summary')
  if (from) from.max = String(Math.max(1, total))
  if (to) {
    to.max = String(Math.max(1, total))
    if (!to.value || Number(to.value) > total) to.value = String(Math.min(100, Math.max(1, total)))
  }
  if (summary) summary.textContent = total ? `${total.toLocaleString()} files` : 'No files'
}

function rescueSelectFileRange () {
  const items = filesItems()
  if (!items.length) return
  const fromNode = $('#file-range-from')
  const toNode = $('#file-range-to')
  let from = Math.max(1, Math.min(items.length, Number(fromNode && fromNode.value) || 1))
  let to = Math.max(1, Math.min(items.length, Number(toNode && toNode.value) || Math.min(100, items.length)))
  if (from > to) [from, to] = [to, from]
  state.selection.clear()
  state.selectedMessages.clear()
  for (const item of items.slice(from - 1, to)) state.selection.set(rescueFileMarkKey(item), item)
  renderFiles()
  updateSelectionBar()
}

function rescueMountFileRange () {
  const toolbar = $('#files-toolbar')
  if (!toolbar || $('#file-range-tools')) return
  const range = h('div', 'file-range-tools')
  range.id = 'file-range-tools'
  range.innerHTML = `<span class="file-range-label">Range</span><input id="file-range-from" type="number" min="1" value="1" aria-label="Range start"><span class="file-range-separator">–</span><input id="file-range-to" type="number" min="1" value="100" aria-label="Range end"><button id="file-range-select" class="ghost small" type="button">Select</button><span id="file-range-summary" class="muted"></span>`
  toolbar.appendChild(range)
  $('#file-range-select').onclick = rescueSelectFileRange
}
rescueMountFileRange()

/* The 600-row grow-on-scroll files renderer that used to live here is gone.
 * files-view.js owns renderFiles with real 100-per-page pagination, so a second
 * windowed renderer plus its own scroll-growth listener could only fight it. */

// Keep old controls wired internally but remove them from the daily-driver UI.
for (const selector of ['#file-sort', '#search-whole', '#pack-media', '#cancel-pack', '#pack-banner', '#zip-results']) {
  const node = document.querySelector(selector)
  if (node) node.classList.add('legacy-control-hidden')
}

// Keep selection actions physically inside the center workspace.
const rescueSelectionDock = $('#selection-bar')
const rescueChatPane = $('.chat')
if (rescueSelectionDock && rescueChatPane && rescueSelectionDock.parentElement !== rescueChatPane) {
  rescueChatPane.appendChild(rescueSelectionDock)
}

/* Realtime message/cache reconciliation. */
function rescueRecountFileTypes (items) {
  const counts = { document: 0, photo: 0, video: 0, gif: 0, audio: 0, voice: 0, video_note: 0, sticker: 0 }
  for (const item of items || []) if (item && item.type && Object.prototype.hasOwnProperty.call(counts, item.type)) counts[item.type]++
  return counts
}

function rescuePatchCompleteFileCache (chatKey, message) {
  const snapshot = rescueFileCache.get(chatKey)
  if (!snapshot || !Array.isArray(snapshot.items)) return
  const id = String(message.id)
  const index = snapshot.items.findIndex(item => String(item.messageId) === id)
  if (message.media) {
    const next = { ...message.media, messageId: message.id, chatId: message.media.chatId || Number(chatKey) || chatKey }
    if (index >= 0) snapshot.items[index] = next
    else snapshot.items.unshift(next)
  } else if (index >= 0) {
    snapshot.items.splice(index, 1)
  }
  snapshot.items.sort((a, b) => {
    const aa = BigInt(String(a.messageId || 0))
    const bb = BigInt(String(b.messageId || 0))
    return aa === bb ? 0 : (aa < bb ? 1 : -1)
  })
  snapshot.found = snapshot.items.length
  snapshot.typeCounts = rescueRecountFileTypes(snapshot.items)
  snapshot.savedAt = Date.now()
}

function rescueDeleteFromCompleteFileCache (chatKey, messageIds) {
  const snapshot = rescueFileCache.get(chatKey)
  if (!snapshot || !Array.isArray(snapshot.items)) return
  const ids = new Set((messageIds || []).map(String))
  snapshot.items = snapshot.items.filter(item => !ids.has(String(item.messageId)))
  snapshot.found = snapshot.items.length
  snapshot.typeCounts = rescueRecountFileTypes(snapshot.items)
  snapshot.savedAt = Date.now()
}

function rescueUpsertCachedMessage (chatKey, message) {
  const cached = rescueChatCache.get(chatKey)
  if (!cached) return
  const byId = new Map((cached.messages || []).map(m => [String(m.id), m]))
  byId.set(String(message.id), { ...message, key: `${chatKey}:${message.id}` })
  cached.messages = [...byId.values()]
    .sort((a, b) => {
      const aa = BigInt(String(a.id || 0))
      const bb = BigInt(String(b.id || 0))
      return aa === bb ? 0 : (aa < bb ? 1 : -1)
    })
    .slice(0, rescueMessageLimit)
  cached.savedAt = Date.now()
}

function rescueRealtimeMessageUpsert (chatId, message) {
  if (chatId == null || !message || message.id == null) return
  const chatKey = rescueChatKey(chatId)
  rescueUpsertCachedMessage(chatKey, message)
  rescuePatchCompleteFileCache(chatKey, message)
  if (state.activeChatId == null || rescueChatKey(state.activeChatId) !== chatKey) return

  const panel = $('#messages')
  const distanceFromBottom = panel ? panel.scrollHeight - panel.scrollTop - panel.clientHeight : Infinity
  const followNewest = state.view === 'messages' && distanceFromBottom < 140
  rescueMergeMessages(chatId, [message])
  rescueSaveActiveChat()
  rescueRenderCurrent()
  if (followNewest && panel) requestAnimationFrame(() => { panel.scrollTop = panel.scrollHeight })
}

function rescueRealtimeMessageDelete (chatId, messageIds) {
  if (chatId == null) return
  const chatKey = rescueChatKey(chatId)
  const ids = new Set((messageIds || []).map(String))
  const cached = rescueChatCache.get(chatKey)
  if (cached) {
    cached.messages = (cached.messages || []).filter(m => !ids.has(String(m.id)))
    cached.savedAt = Date.now()
  }
  rescueDeleteFromCompleteFileCache(chatKey, messageIds)
  if (state.activeChatId == null || rescueChatKey(state.activeChatId) !== chatKey) return

  state.messages = state.messages.filter(m => !ids.has(String(m.id)))
  for (const id of ids) {
    const key = `${chatKey}:${id}`
    state.selection.delete(key)
    state.selectedMessages.delete(key)
  }
  rescueSaveActiveChat()
  updateSelectionBar()
  rescueRenderCurrent()
}

const rescueBaseHandleEvent = handleEvent
handleEvent = function rescueRealtimeHandleEvent (ev) {
  if (ev && ev.name === 'download-done') {
    const job = ev.job || {}
    rescueMarkDownloaded(job.chatId, job.messageId)
    const result = rescueBaseHandleEvent(ev)
    if (state.view === 'files' && String(job.chatId) === String(state.activeChatId)) renderFiles()
    return result
  }
  if (ev && ev.name === 'forward-done') {
    const payload = ev.payload || {}
    for (const id of payload.forwarded || []) rescueMarkForwarded(payload.sourceChatId, id)
    const result = rescueBaseHandleEvent(ev)
    if (state.view === 'files' && String(payload.sourceChatId) === String(state.activeChatId)) renderFiles()
    return result
  }
  if (ev && ev.name === 'message-upsert') {
    rescueRealtimeMessageUpsert(ev.chatId, ev.message)
    return
  }
  if (ev && ev.name === 'message-delete') {
    rescueRealtimeMessageDelete(ev.chatId, ev.messageIds)
    return
  }
  if (ev && ev.name === 'history-cleared') {
    const key = rescueChatKey(ev.chatId)
    rescueChatCache.delete(key)
    rescueFileCache.delete(key)
    if (state.activeChatId != null && rescueChatKey(state.activeChatId) === key) {
      state.messages = []
      state.selection.clear()
      state.selectedMessages.clear()
      updateSelectionBar()
      rescueRenderCurrent()
      setLoadState('End of history')
    }
    return
  }
  return rescueBaseHandleEvent(ev)
}

/* ------------------------------ Chat composer ------------------------------ */
const rescueCompose = { replyTo: null, editMessageId: null, editOriginal: '', attachments: [], oneTime: false }

function rescueMountComposer () {
  if (document.querySelector('#tele-composer')) return
  const chat = document.querySelector('.chat')
  const foot = document.querySelector('.chat-foot')
  if (!chat || !foot) return
  const composer = document.createElement('div')
  composer.id = 'tele-composer'
  composer.className = 'tele-composer hidden'
  composer.innerHTML = `
    <div id="tele-compose-context" class="tele-compose-context hidden">
      <div><strong id="tele-compose-mode"></strong><span id="tele-compose-preview"></span></div>
      <button id="tele-compose-cancel" class="ghost small" type="button">Cancel</button>
    </div>
    <div id="tele-attachment-preview" class="tele-attachment-preview hidden">
      <div id="tele-attachment-list" class="tele-attachment-list"></div>
      <div class="tele-attachment-footer"><label id="tele-one-time-wrap" class="tele-one-time hidden"><input id="tele-one-time" type="checkbox"><span>View once</span></label><button id="tele-attachment-clear" class="ghost small" type="button">Clear</button></div>
    </div>
    <div class="tele-compose-row">
      <input id="tele-compose-file" type="file" class="hidden" multiple />
      <button id="tele-compose-attach" class="ghost tele-compose-attach" type="button" title="Attach files" aria-label="Attach files"></button>
      <textarea id="tele-compose-input" rows="1" placeholder="Message" aria-label="Message"></textarea>
      <button id="tele-compose-send" type="button">Send</button>
    </div>`
  chat.insertBefore(composer, foot)
  const input = document.querySelector('#tele-compose-input')
  const fileInput = document.querySelector('#tele-compose-file')
  const attachButton = document.querySelector('#tele-compose-attach')
  if (attachButton) attachButton.innerHTML = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>'
  document.querySelector('#tele-compose-send').onclick = rescueSendComposer
  document.querySelector('#tele-compose-cancel').onclick = rescueClearComposeContext
  document.querySelector('#tele-compose-attach').onclick = () => { if (!rescueCompose.editMessageId) fileInput.click() }
  document.querySelector('#tele-attachment-clear').onclick = rescueClearAttachment
  fileInput.addEventListener('change', () => rescueSetAttachments([...(fileInput.files || [])]))
  const oneTime = document.querySelector('#tele-one-time')
  if (oneTime) oneTime.addEventListener('change', () => { rescueCompose.oneTime = !!oneTime.checked })
  composer.addEventListener('dragover', e => { if (state.view === 'messages' && state.activeChatId != null) e.preventDefault() })
  composer.addEventListener('drop', e => {
    if (state.view !== 'messages' || state.activeChatId == null || rescueCompose.editMessageId) return
    const files = e.dataTransfer && e.dataTransfer.files ? [...e.dataTransfer.files] : []
    if (!files.length) return
    e.preventDefault()
    rescueSetAttachments(files)
  })
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      rescueSendComposer()
    } else if (e.key === 'Escape') {
      rescueClearComposeContext()
    }
  })
  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = Math.min(140, input.scrollHeight) + 'px'
  })
  rescueUpdateComposerVisibility()
}

function rescueUpdateComposerVisibility () {
  rescueMountComposer()
  const composer = document.querySelector('#tele-composer')
  if (!composer) return
  composer.classList.toggle('hidden', state.view !== 'messages' || state.activeChatId == null)
}

function rescueClearAttachment () {
  rescueCompose.attachments = []
  rescueCompose.oneTime = false
  const input = document.querySelector('#tele-compose-file')
  if (input) input.value = ''
  const preview = document.querySelector('#tele-attachment-preview')
  if (preview) preview.classList.add('hidden')
  const list = document.querySelector('#tele-attachment-list')
  if (list) list.innerHTML = ''
  const oneTime = document.querySelector('#tele-one-time')
  if (oneTime) oneTime.checked = false
}

function rescueAttachmentCanViewOnce (file) {
  if (!file) return false
  const name = String(file.name || '').toLowerCase()
  const mime = String(file.type || '').toLowerCase()
  return /^image\/(jpeg|png)$/.test(mime) || /^video\//.test(mime) || /\.(jpe?g|png|mp4|mov|m4v|webm)$/.test(name)
}

function rescueRenderAttachments () {
  const preview = document.querySelector('#tele-attachment-preview')
  const list = document.querySelector('#tele-attachment-list')
  const oneTimeWrap = document.querySelector('#tele-one-time-wrap')
  if (!preview || !list) return
  list.innerHTML = ''
  for (const [index, file] of rescueCompose.attachments.entries()) {
    const row = h('div', 'tele-attachment-item')
    const info = h('div', 'tele-attachment-item-info')
    info.append(h('strong', '', file.name), h('span', 'muted', `${fmtSize(file.size)}${file.type ? ' · ' + file.type : ''}`))
    const remove = h('button', 'ghost small', '×')
    remove.type = 'button'
    remove.setAttribute('aria-label', `Remove ${file.name}`)
    remove.onclick = () => {
      rescueCompose.attachments.splice(index, 1)
      rescueCompose.oneTime = false
      rescueRenderAttachments()
    }
    row.append(info, remove)
    list.appendChild(row)
  }
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

function rescueSetAttachments (files) {
  const valid = (files || []).filter(Boolean)
  for (const file of valid) {
    if (file.size > 4 * 1024 * 1024 * 1024) {
      toast(`${file.name}: files larger than 4 GB are not supported`, 'error')
      continue
    }
    rescueCompose.attachments.push(file)
  }
  rescueCompose.oneTime = false
  rescueRenderAttachments()
}

function rescueClearComposeContext () {
  rescueCompose.replyTo = null
  rescueCompose.editMessageId = null
  rescueCompose.editOriginal = ''
  const context = document.querySelector('#tele-compose-context')
  if (context) context.classList.add('hidden')
  const mode = document.querySelector('#tele-compose-mode')
  const preview = document.querySelector('#tele-compose-preview')
  if (mode) mode.textContent = ''
  if (preview) preview.textContent = ''
}

function rescueSetComposeContext (mode, message) {
  rescueMountComposer()
  rescueClearComposeContext()
  const input = document.querySelector('#tele-compose-input')
  const context = document.querySelector('#tele-compose-context')
  const modeNode = document.querySelector('#tele-compose-mode')
  const preview = document.querySelector('#tele-compose-preview')
  if (!input || !context) return
  context.classList.remove('hidden')
  if (mode === 'edit') {
    rescueClearAttachment()
    rescueCompose.editMessageId = message.id
    rescueCompose.editOriginal = message.text || ''
    input.value = message.text || ''
    modeNode.textContent = 'Editing message'
  } else {
    rescueCompose.replyTo = message
    modeNode.textContent = `Replying to ${message.sender || 'message'}`
  }
  preview.textContent = String(message.text || (message.media && message.media.name) || '').slice(0, 120)
  input.focus()
  input.dispatchEvent(new Event('input'))
}

async function rescueSendComposer () {
  const input = document.querySelector('#tele-compose-input')
  const send = document.querySelector('#tele-compose-send')
  if (!input || !send || state.activeChatId == null) return
  const text = input.value.trim()
  const attachments = rescueCompose.attachments.slice()
  if (!text && !attachments.length) return
  if (attachments.length && rescueCompose.editMessageId) return toast('Finish editing before attaching files', 'error')
  if (rescueCompose.oneTime && attachments.length !== 1) return toast('View once supports one photo or video at a time', 'error')
  send.disabled = true
  const oldLabel = send.textContent
  send.textContent = attachments.length ? (attachments.length > 1 ? `Sending 0/${attachments.length}` : 'Uploading…') : 'Sending…'
  try {
    if (rescueCompose.editMessageId) {
      await request('edit-chat-message', { chatId: state.activeChatId, messageId: rescueCompose.editMessageId, text })
      toastOk('Message edited')
    } else if (attachments.length) {
      for (let i = 0; i < attachments.length; i++) {
        const attachment = attachments[i]
        if (attachments.length > 1) send.textContent = `Sending ${i + 1}/${attachments.length}`
        const headers = {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': encodeURIComponent(attachment.name),
          'X-Mime-Type': encodeURIComponent(attachment.type || 'application/octet-stream'),
          'X-Caption': encodeURIComponent(i === 0 ? text.slice(0, 1024) : ''),
          'X-One-Time': rescueCompose.oneTime && i === 0 ? '1' : '0'
        }
        if (rescueCompose.replyTo && rescueCompose.replyTo.id != null && i === 0) headers['X-Reply-To'] = String(rescueCompose.replyTo.id)
        const response = await fetch(`/api/chat-attachment/${encodeURIComponent(state.activeChatId)}`, {
          method: 'POST',
          headers,
          body: attachment
        })
        const result = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(`${attachment.name}: ${result.error || `upload failed (${response.status})`}`)
      }
    } else {
      await request('send-chat-message', {
        chatId: state.activeChatId,
        text,
        replyToMessageId: rescueCompose.replyTo ? rescueCompose.replyTo.id : null
      })
    }
    input.value = ''
    input.style.height = 'auto'
    rescueClearAttachment()
    rescueClearComposeContext()
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    send.disabled = false
    send.textContent = oldLabel
    input.focus()
  }
}

async function rescueDeleteMessage (message) {
  if (!message || state.activeChatId == null) return
  try {
    const actions = await request('get-message-actions', { chatId: state.activeChatId, messageId: message.id })
    if (!actions.canDeleteAll && !actions.canDeleteSelf) throw new Error('Telegram does not allow deleting this message')
    const revoke = !!actions.canDeleteAll
    const scope = revoke ? 'for everyone' : 'only for you'
    const confirmFn = window.teleConfirmAction
    const ok = confirmFn
      ? await confirmFn('Delete message?', `This message will be deleted ${scope}.`, 'Delete')
      : window.confirm(`Delete this message ${scope}?`)
    if (!ok) return
    await request('delete-chat-message', { chatId: state.activeChatId, messageId: message.id, revoke })
  } catch (e) { toast(e.message, 'error') }
}

window.teleReplyToMessage = message => rescueSetComposeContext('reply', message)
window.teleEditMessage = message => rescueSetComposeContext('edit', message)
window.teleDeleteMessage = rescueDeleteMessage

rescueMountComposer()
