'use strict'

const fs = require('node:fs')

function replaceOnce(file, needle, replacement, label) {
  const source = fs.readFileSync(file, 'utf8')
  if (!source.includes(needle)) {
    throw new Error(`${label || file}: expected patch anchor not found`)
  }
  const next = source.replace(needle, replacement)
  if (next === source) throw new Error(`${label || file}: patch produced no change`)
  fs.writeFileSync(file, next)
}

// 1) Keep the proven TDLib downloader untouched; add a native forwarding service
// beside it so forwarding never depends on local file resolution.
replaceOnce(
  'server.js',
  "const dm = new DownloadManager()\n\n/* ------------------------------ Media packer ------------------------------ */",
  `const dm = new DownloadManager()\n\n/* ------------------------------ Native forward manager ------------------------------ */\n\nconst forwardHistory = new Set()\n\nfunction normalizeMessageIds (ids) {\n  const out = []\n  const seen = new Set()\n  for (const raw of ids || []) {\n    const id = String(raw || '').trim()\n    if (!/^\\d+$/.test(id) || id === '0' || seen.has(id)) continue\n    seen.add(id)\n    out.push(id)\n  }\n  return out\n}\n\nasync function resolveDestinationChat (destination) {\n  if (!client || !ready) throw new Error('Telegram session is not ready')\n\n  if (destination && destination.chatId != null) {\n    const chatId = destination.chatId\n    const chat = await client.invoke({ _: 'getChat', chat_id: chatId })\n    return { id: chat.id, title: chat.title || 'Destination' }\n  }\n\n  const query = String(destination && (destination.username || destination.query) || '').trim()\n  if (!query) throw new Error('Choose a destination chat')\n\n  const username = query.replace(/^@/, '')\n  if (username) {\n    const publicChat = await client.invoke({ _: 'searchPublicChat', username }).catch(() => null)\n    if (publicChat && publicChat.id) return { id: publicChat.id, title: publicChat.title || '@' + username }\n  }\n\n  const local = await client.invoke({ _: 'searchChats', query, limit: 50 }).catch(() => null)\n  for (const chatId of (local && local.chat_ids) || []) {\n    const chat = await client.invoke({ _: 'getChat', chat_id: chatId }).catch(() => null)\n    if (!chat) continue\n    const title = String(chat.title || '')\n    const usernames = chat.usernames && chat.usernames.active_usernames ? chat.usernames.active_usernames : []\n    if (title.toLowerCase() === query.toLowerCase() || usernames.some(u => String(u).toLowerCase() === username.toLowerCase())) {\n      return { id: chat.id, title: title || query }\n    }\n  }\n\n  throw new Error('Destination chat not found')\n}\n\nasync function forwardMessagesNative (sourceChatId, messageIds, destination) {\n  if (!client || !ready) throw new Error('Telegram session is not ready')\n  if (sourceChatId == null) throw new Error('Source chat is required')\n\n  const ids = normalizeMessageIds(messageIds)\n  if (!ids.length) throw new Error('Select at least one message to forward')\n  const dest = await resolveDestinationChat(destination)\n  if (String(dest.id) === String(sourceChatId)) throw new Error('Choose a different destination chat')\n\n  const fresh = []\n  const skipped = []\n  for (const messageId of ids) {\n    const dedupeKey = String(sourceChatId) + ':' + messageId + ':' + String(dest.id)\n    if (forwardHistory.has(dedupeKey)) skipped.push(messageId)\n    else fresh.push(messageId)\n  }\n\n  if (!fresh.length) {\n    return { destination: dest, forwarded: [], skipped, messages: [] }\n  }\n\n  // TDLib's native forwardMessages preserves Telegram-native forwarding semantics\n  // for both text and media. No download/re-upload path is involved.\n  const result = await client.invoke({\n    _: 'forwardMessages',\n    chat_id: dest.id,\n    from_chat_id: sourceChatId,\n    message_ids: fresh,\n    options: { _: 'messageSendOptions', disable_notification: false, from_background: false, protect_content: false },\n    send_copy: false,\n    remove_caption: false\n  })\n\n  const forwardedMessages = (result && result.messages) || []\n  for (const messageId of fresh) {\n    forwardHistory.add(String(sourceChatId) + ':' + messageId + ':' + String(dest.id))\n  }\n\n  sendAll({\n    type: 'event',\n    event: {\n      name: 'forward-done',\n      payload: {\n        sourceChatId,\n        destination: dest,\n        forwarded: fresh,\n        skipped,\n        destinationMessageIds: forwardedMessages.map(m => m && m.id).filter(Boolean)\n      }\n    }\n  })\n\n  return { destination: dest, forwarded: fresh, skipped, messages: forwardedMessages }\n}\n\n/* ------------------------------ Media packer ------------------------------ */`,
  'server forward manager'
)

// 2) Publish chat updates to the browser so a newly created/joined Telegram chat
// can appear without a manual refresh/restart.
replaceOnce(
  'server.js',
  "    } else if (u._ === 'updateFile') {\n      dm.onFileUpdate(u.file)\n    }\n  })",
  `    } else if (u._ === 'updateFile') {\n      dm.onFileUpdate(u.file)\n    } else if (u._ === 'updateNewChat') {\n      sendAll({ type: 'event', event: { name: 'chat-upsert', chat: serializeChat(u.chat) } })\n    } else if (u._ === 'updateChatTitle') {\n      client.invoke({ _: 'getChat', chat_id: u.chat_id }).then(chat => {\n        sendAll({ type: 'event', event: { name: 'chat-upsert', chat: serializeChat(chat) } })\n      }).catch(() => {})\n    } else if (u._ === 'updateChatPhoto' || u._ === 'updateChatPosition' || u._ === 'updateChatLastMessage') {\n      client.invoke({ _: 'getChat', chat_id: u.chat_id }).then(chat => {\n        sendAll({ type: 'event', event: { name: 'chat-upsert', chat: serializeChat(chat) } })\n      }).catch(() => {})\n    }\n  })`,
  'server chat realtime'
)

// 3) Add websocket commands for destination lookup and native forwarding.
replaceOnce(
  'server.js',
  "        case 'start-download': {\n          const chat = await client.invoke({ _: 'getChat', chat_id: payload.chatId }).catch(() => ({ title: 'Chat' }))",
  `        case 'search-destinations': {\n          const query = String(payload.query || '').trim()\n          const ids = query\n            ? ((await client.invoke({ _: 'searchChats', query, limit: 50 }).catch(() => ({ chat_ids: [] }))).chat_ids || [])\n            : ((await client.invoke({ _: 'getChats', chat_list: { _: 'chatListMain' }, offset_order: '9223372036854775807', offset_chat_id: 0, limit: 50 })).chat_ids || [])\n          const chats = []\n          for (const chatId of ids) {\n            if (payload.excludeChatId != null && String(chatId) === String(payload.excludeChatId)) continue\n            const chat = await client.invoke({ _: 'getChat', chat_id: chatId }).catch(() => null)\n            if (!chat || (chat.type && chat.type._ === 'chatTypeSecret')) continue\n            chats.push(serializeChat(chat))\n          }\n          return respond(ws, id, true, { chats })\n        }\n        case 'forward-messages': {\n          const result = await forwardMessagesNative(payload.sourceChatId, payload.messageIds, payload.destination || {})\n          return respond(ws, id, true, {\n            destination: result.destination,\n            forwarded: result.forwarded,\n            skipped: result.skipped,\n            destinationMessageIds: result.messages.map(m => m && m.id).filter(Boolean)\n          })\n        }\n        case 'start-download': {\n          const chat = await client.invoke({ _: 'getChat', chat_id: payload.chatId }).catch(() => ({ title: 'Chat' }))`,
  'server websocket forward commands'
)

// 4) Local-only server binding avoids Windows Firewall prompts and unnecessary LAN exposure.
replaceOnce(
  'server.js',
  "server.listen(PORT, () => {\n  console.log(`Tele Scraper running at http://localhost:${PORT}`)\n})",
  "server.listen(PORT, '127.0.0.1', () => {\n  console.log(`Tele running at http://127.0.0.1:${PORT}`)\n})",
  'server loopback binding'
)

// 5) UI state + realtime chat reconciliation.
replaceOnce(
  'public/app.js',
  "  selection: new Map(), // key `${chatId}:${messageId}` -> item\n  downloads: new Map(),",
  "  selection: new Map(), // key `${chatId}:${messageId}` -> item\n  selectedMessages: new Map(), // key `${chatId}:${messageId}` -> full message for Forward\n  downloads: new Map(),",
  'app selected messages state'
)

replaceOnce(
  'public/app.js',
  "    case 'settings-changed':\n      setDirLabel(ev.downloadsDir)\n      break",
  `    case 'settings-changed':\n      setDirLabel(ev.downloadsDir)\n      break\n    case 'chat-upsert':\n      upsertChat(ev.chat)\n      break\n    case 'forward-done':\n      toastOk(\`Forwarded \${(ev.payload.forwarded || []).length} message(s) to \${ev.payload.destination && ev.payload.destination.title ? ev.payload.destination.title : 'destination'}\`)\n      break`,
  'app realtime cases'
)

replaceOnce(
  'public/app.js',
  "async function loadChats () {",
  `function upsertChat (chat) {\n  if (!chat || chat.id == null) return\n  if (chat.lastMessage && chat.lastMessage._ === 'messageText') chat.lastText = chat.lastMessage.text?.text || ''\n  const index = state.chats.findIndex(c => String(c.id) === String(chat.id))\n  if (index >= 0) state.chats[index] = { ...state.chats[index], ...chat }\n  else state.chats.unshift(chat)\n  state.chats.sort((a, b) => String(a.order || '0') < String(b.order || '0') ? 1 : -1)\n  renderChats()\n}\n\nasync function loadChats () {`,
  'app upsert chat helper'
)

// 6) Keep a full-message selection path in Messages view so text messages can be forwarded.
replaceOnce(
  'public/app.js',
  "    if (m.text) msgEl.appendChild(h('div', 'msg-text', escapeHtml(m.text)))\n    if (m.media) msgEl.appendChild(buildMediaRow(m))\n    list.appendChild(msgEl)",
  `    if (m.text) msgEl.appendChild(h('div', 'msg-text', m.text))\n    if (m.media) msgEl.appendChild(buildMediaRow(m))\n    const select = h('label', 'msg-select')\n    const cb = h('input', '')\n    cb.type = 'checkbox'\n    const key = \`\${state.activeChatId}:\${m.id}\`\n    cb.checked = state.selectedMessages.has(key)\n    cb.onchange = () => {\n      if (cb.checked) state.selectedMessages.set(key, m)\n      else state.selectedMessages.delete(key)\n      updateSelectionBar()\n    }\n    select.appendChild(cb)\n    select.appendChild(document.createTextNode(' Select'))\n    msgEl.appendChild(select)\n    list.appendChild(msgEl)`,
  'app message selection'
)

// 7) Clear both selection kinds when changing chat.
replaceOnce(
  'public/app.js',
  "  state.selection.clear()\n  state.hasMore = true",
  "  state.selection.clear()\n  state.selectedMessages.clear()\n  state.hasMore = true",
  'app clear message selection'
)

// 8) Add forward helpers before download actions.
replaceOnce(
  'public/app.js',
  "async function startDownloads (items) {",
  `function selectedForwardIds () {\n  const ids = []\n  const seen = new Set()\n  for (const item of state.selectedMessages.values()) {\n    const id = String(item.id || item.messageId || '')\n    if (id && !seen.has(id)) { seen.add(id); ids.push(id) }\n  }\n  for (const item of state.selection.values()) {\n    const id = String(item.messageId || item.id || '')\n    if (id && !seen.has(id)) { seen.add(id); ids.push(id) }\n  }\n  return ids\n}\n\nasync function searchForwardDestinations (query = '') {\n  return request('search-destinations', { query, excludeChatId: state.activeChatId })\n}\n\nasync function forwardSelectedMessages () {\n  if (!state.activeChatId) return\n  const messageIds = selectedForwardIds()\n  if (!messageIds.length) return toast('Select one or more messages first', 'error')\n\n  const typed = prompt('Forward to chat title or @username:')\n  if (!typed) return\n\n  try {\n    const candidates = await searchForwardDestinations(typed)\n    let destination = null\n    if (typed.startsWith('@')) destination = { username: typed }\n    else if (candidates.chats && candidates.chats.length) destination = { chatId: candidates.chats[0].id }\n    else destination = { query: typed }\n\n    const result = await request('forward-messages', {\n      sourceChatId: state.activeChatId,\n      messageIds,\n      destination\n    })\n    const forwarded = (result.forwarded || []).length\n    const skipped = (result.skipped || []).length\n    state.selectedMessages.clear()\n    state.selection.clear()\n    updateSelectionBar()\n    renderMessagesList()\n    renderFiles()\n    toastOk(\`Forwarded \${forwarded} message(s)\${skipped ? \` · \${skipped} already sent this session\` : ''}\`)\n  } catch (e) {\n    toast(e.message, 'error')\n  }\n}\n\nasync function startDownloads (items) {`,
  'app forward helpers'
)

// 9) Selection bar should understand both downloadable file selection and generic message forwarding.
replaceOnce(
  'public/app.js',
  "function updateSelectionBar () {",
  `function updateSelectionBar () {\n  const messageForwardCount = selectedForwardIds().length`,
  'app selection bar prelude'
)

replaceOnce(
  'public/app.js',
  "  $('#selection-bar').classList.toggle('hidden', count === 0)",
  "  $('#selection-bar').classList.toggle('hidden', count === 0 && messageForwardCount === 0)\n  const forwardBtn = $('#forward-selected')\n  if (forwardBtn) {\n    forwardBtn.disabled = messageForwardCount === 0\n    forwardBtn.textContent = messageForwardCount ? `Forward (${messageForwardCount})` : 'Forward'\n  }",
  'app selection bar forward state'
)

// 10) Wire the new Forward control.
replaceOnce(
  'public/app.js',
  "  $('#download-selected').onclick = () => startDownloads([...state.selection.values()])",
  "  $('#download-selected').onclick = () => startDownloads([...state.selection.values()])\n  $('#forward-selected').onclick = forwardSelectedMessages",
  'app forward click'
)

// 11) Add a Forward button beside the existing selected-file actions.
replaceOnce(
  'public/index.html',
  "<button id=\"download-selected\" class=\"primary\">Download selected</button>",
  "<button id=\"forward-selected\" class=\"secondary\" disabled>Forward</button>\n            <button id=\"download-selected\" class=\"primary\">Download selected</button>",
  'index forward button'
)

console.log('Legacy rescue patch applied successfully')
