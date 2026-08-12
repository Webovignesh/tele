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
  const count = rescueLoadedMediaCount()
  const label = $('#chat-media-count')
  if (label) label.textContent = state.activeChatId == null ? '' : `${count} loaded file${count === 1 ? '' : 's'}`
  const downloadAll = $('#download-all-media')
  if (downloadAll) {
    downloadAll.textContent = 'Download all media'
    downloadAll.disabled = state.activeChatId == null
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
  state.mediaCount = snapshot.found == null ? snapshot.items.length : snapshot.found
  state.typeCounts = snapshot.typeCounts || null
  state.hasMore = false
}

async function rescueEnsureAllFiles (chatId) {
  if (chatId == null) return
  const key = rescueChatKey(chatId)
  const cached = rescueFileCache.get(key)
  if (cached) {
    if (rescueChatKey(state.activeChatId) !== key) return
    rescueApplyCompleteFiles(chatId, cached)
    renderFiles()
    rescueUpdateMediaLabel()
    setLoadState(`Loaded all ${cached.items.length} files`)
    return
  }
  if (rescueFileInflight.has(key)) return rescueFileInflight.get(key)

  if (rescueChatKey(state.activeChatId) === key) {
    $('#media-grid').innerHTML = ''
    setLoadState('Loading all files…')
  }

  const generation = rescueOpenGeneration
  const work = (async () => {
    try {
      let data = await request('scan-media', { chatId, includeItems: true })
      while (data && data.busy) {
        await new Promise(resolve => setTimeout(resolve, 750))
        if (rescueChatKey(state.activeChatId) !== key || generation !== rescueOpenGeneration) return
        data = await request('scan-media', { chatId, includeItems: true })
      }
      const snapshot = {
        items: (data && data.items) || [],
        found: data && data.found,
        typeCounts: data && data.typeCounts,
        savedAt: Date.now()
      }
      rescueFileCache.set(key, snapshot)
      if (rescueChatKey(state.activeChatId) !== key || generation !== rescueOpenGeneration || state.view !== 'files') return
      rescueApplyCompleteFiles(chatId, snapshot)
      renderFiles()
      rescueUpdateMediaLabel()
      setLoadState(`Loaded all ${snapshot.items.length} files`)
    } catch (e) {
      if (rescueChatKey(state.activeChatId) === key && state.view === 'files') {
        setLoadState('Failed to load all files. Try Files again.')
        toast(String(e && e.message ? e.message : e), 'error')
      }
    } finally {
      rescueFileInflight.delete(key)
    }
  })()
  rescueFileInflight.set(key, work)
  return work
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
  state.selection.clear()
  state.selectedMessages.clear()
  state.loadingMore = false
  state.mediaCount = null
  state.typeCounts = null
  state.counting = false
  state.files = { query: '', filter: 'all', sort: 'newest', mode: 'browse', results: [], totalCount: 0, hasMore: false, fromMessageId: 0, searching: false, loadingAll: false }

  $('#file-search').value = ''
  $('#file-filter').value = 'all'
  $('#file-sort').value = 'newest'
  updateSelectionBar()
  renderChats()

  const chat = state.chats.find(c => rescueChatKey(c.id) === rescueChatKey(chatId))
  $('#chat-title').textContent = chat ? chat.title : 'Chat'
  $('#messages').innerHTML = ''
  $('#media-grid').innerHTML = ''

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
    renderFiles()
    setLoadState(cached ? `Cached ${state.messages.length} messages · refreshing…` : 'loading')
  }
  rescueUpdateMediaLabel()

  // Always refresh the newest page, but never blank already-cached rows while waiting.
  const generation = rescueOpenGeneration
  const requestKey = `${rescueChatKey(chatId)}:latest:${generation}`
  const work = (async () => {
    try {
      const data = await request('get-messages', { chatId, fromMessageId: 0, limit: 100 })
      if (rescueChatKey(state.activeChatId) !== rescueChatKey(chatId) || generation !== rescueOpenGeneration) return
      rescueMergeMessages(chatId, data.messages || [])
      state.hasMore = !!data.hasMore
      rescueSaveActiveChat()
      rescueRenderCurrent()
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
    const u = h('div', 'u', typeIcon[chat.kind] || '💬')
    if (chat.unread > 0) u.textContent += ` · ${chat.unread}`
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
  rescueMaybeNotifyMessage(chatId, message)
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
  if (ev && ev.name === 'message-upsert') {
    rescueRealtimeMessageUpsert(ev.chatId, ev.message)
    return
  }
  if (ev && ev.name === 'message-delete') {
    rescueRealtimeMessageDelete(ev.chatId, ev.messageIds)
    return
  }
  return rescueBaseHandleEvent(ev)
}

/* ------------------------------ Chat composer + desktop notifications ------------------------------ */
const rescueNotificationPrefKey = 'tele-desktop-notifications'
const rescueCompose = { replyTo: null, editMessageId: null, editOriginal: '' }

function rescueDesktopNotificationsEnabled () {
  try { return localStorage.getItem(rescueNotificationPrefKey) === '1' && 'Notification' in window && Notification.permission === 'granted' } catch { return false }
}

async function rescueEnableDesktopNotifications () {
  if (!('Notification' in window)) throw new Error('Desktop notifications are not supported by this browser')
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Desktop notification permission was not granted')
  try { localStorage.setItem(rescueNotificationPrefKey, '1') } catch {}
  return true
}

function rescueDisableDesktopNotifications () {
  try { localStorage.setItem(rescueNotificationPrefKey, '0') } catch {}
  return true
}

function rescueMaybeNotifyMessage (chatId, message) {
  if (!message || message.outgoing || !rescueDesktopNotificationsEnabled()) return
  const active = state.activeChatId != null && rescueChatKey(state.activeChatId) === rescueChatKey(chatId)
  if (active && document.visibilityState === 'visible' && document.hasFocus()) return
  const chat = state.chats.find(c => rescueChatKey(c.id) === rescueChatKey(chatId))
  const title = chat ? chat.title : 'Telegram'
  let body = message.text || ''
  if (!body && message.media) body = `${message.sender ? message.sender + ': ' : ''}${message.media.type || 'Media'}`
  else if (message.sender && body) body = `${message.sender}: ${body}`
  body = String(body || 'New message').slice(0, 180)
  try {
    const n = new Notification(title, { body, tag: `tele-chat-${chatId}`, renotify: true })
    n.onclick = () => {
      window.focus()
      if (chatId != null) openChat(chatId)
      n.close()
    }
  } catch {}
}

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
    <div class="tele-compose-row">
      <textarea id="tele-compose-input" rows="1" placeholder="Message" aria-label="Message"></textarea>
      <button id="tele-compose-send" type="button">Send</button>
    </div>`
  chat.insertBefore(composer, foot)
  const input = document.querySelector('#tele-compose-input')
  document.querySelector('#tele-compose-send').onclick = rescueSendComposer
  document.querySelector('#tele-compose-cancel').onclick = rescueClearComposeContext
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
  if (!text) return
  send.disabled = true
  try {
    if (rescueCompose.editMessageId) {
      await request('edit-chat-message', { chatId: state.activeChatId, messageId: rescueCompose.editMessageId, text })
      toastOk('Message edited')
    } else {
      await request('send-chat-message', {
        chatId: state.activeChatId,
        text,
        replyToMessageId: rescueCompose.replyTo ? rescueCompose.replyTo.id : null
      })
    }
    input.value = ''
    input.style.height = 'auto'
    rescueClearComposeContext()
  } catch (e) {
    toast(e.message, 'error')
  } finally {
    send.disabled = false
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
window.teleDesktopNotificationsEnabled = rescueDesktopNotificationsEnabled
window.teleEnableDesktopNotifications = rescueEnableDesktopNotifications
window.teleDisableDesktopNotifications = rescueDisableDesktopNotifications

rescueMountComposer()
