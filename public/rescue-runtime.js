'use strict'

/* Cache-first rescue runtime.
 * Keeps the proven legacy downloader/forwarder intact while making chat browsing
 * resilient to rapid switching, stale requests and long media scans.
 */

const rescueChatCache = new Map()
const rescueInflight = new Map()
const rescueCacheLimit = 24
const rescueMessageLimit = 400
let rescueOpenGeneration = 0
let rescueSyncTimer = null

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
  if (state.view === 'messages') renderMessagesList()
  else renderFiles()
  rescueUpdateMediaLabel()
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

  // Messages are the daily-driver default. Files are derived from the same cache.
  setView('messages')
  renderMessagesList()
  renderFiles()
  rescueUpdateMediaLabel()
  setLoadState(cached ? `Cached ${state.messages.length} messages · refreshing…` : 'loading')

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
  if (chat._avatarUrl) {
    holder.textContent = ''
    const img = h('img', 'chat-avatar-img')
    img.src = '/dl' + chat._avatarUrl
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
  }, 7000)
}
rescueStartChatSync()

// Reorder tabs without waiting for a larger HTML redesign.
const rescueTabs = $('.tabs')
if (rescueTabs && $('#tab-messages') && $('#tab-files')) rescueTabs.insertBefore($('#tab-messages'), $('#tab-files'))
state.view = 'messages'
$('#tab-messages').classList.add('active')
$('#tab-files').classList.remove('active')
$('#messages').classList.remove('hidden')
$('#media-grid').classList.add('hidden')
$('#files-toolbar').classList.add('hidden')
