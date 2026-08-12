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

renderChats = function rescueRenderChats () {
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
