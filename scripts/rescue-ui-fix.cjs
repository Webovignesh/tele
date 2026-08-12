'use strict'

const fs = require('node:fs')

function read(file) { return fs.readFileSync(file, 'utf8') }
function write(file, content) { fs.writeFileSync(file, content) }
function replace(file, needle, replacement, label) {
  const src = read(file)
  if (!src.includes(needle)) throw new Error(`${label}: anchor not found`)
  write(file, src.replace(needle, replacement))
}
function append(file, content) {
  const src = read(file)
  if (!src.includes(content.trim())) write(file, src.replace(/\s*$/, '') + '\n\n' + content.trim() + '\n')
}

// ---------- server: richer chat metadata + realtime removals ----------
replace(
  'server.js',
  `function serializeChat (chat) {\n  const title = chat.title || 'Unknown'\n  const info = {\n    id: chat.id,\n    title,\n    order: chat.order,\n    unread: chat.unread_count || 0,\n    lastMessage: chat.last_message ? chat.last_message.content : null\n  }\n  const t = chat.type\n  if (t) {\n    if (t._ === 'chatTypePrivate') info.kind = 'private'\n    else if (t._ === 'chatTypeBasicGroup') info.kind = 'group'\n    else if (t._ === 'chatTypeSupergroup') info.kind = t.is_channel ? 'channel' : 'supergroup'\n    else info.kind = 'other'\n  }\n  return info\n}`,
  `function serializeChat (chat) {\n  const title = chat.title || 'Unknown'\n  const info = {\n    id: chat.id,\n    title,\n    order: chat.order,\n    unread: chat.unread_count || 0,\n    lastMessage: chat.last_message ? chat.last_message.content : null,\n    username: null\n  }\n  const t = chat.type\n  if (t) {\n    if (t._ === 'chatTypePrivate') info.kind = 'private'\n    else if (t._ === 'chatTypeBasicGroup') info.kind = 'group'\n    else if (t._ === 'chatTypeSupergroup') info.kind = t.is_channel ? 'channel' : 'supergroup'\n    else info.kind = 'other'\n  }\n  return info\n}\n\nasync function serializeChatDetailed (chat) {\n  const info = serializeChat(chat)\n  try {\n    if (chat.type && chat.type._ === 'chatTypePrivate') {\n      const user = await client.invoke({ _: 'getUser', user_id: chat.type.user_id })\n      info.username = user && user.username ? user.username : null\n    } else if (chat.type && chat.type._ === 'chatTypeSupergroup') {\n      const group = await client.invoke({ _: 'getSupergroup', supergroup_id: chat.type.supergroup_id })\n      const names = group && group.usernames && group.usernames.active_usernames\n      info.username = names && names.length ? names[0] : null\n    }\n  } catch {}\n  return info\n}`,
  'serialize chat detailed'
)

replace(
  'server.js',
  `      out.push(serializeChat(chat))`,
  `      out.push(await serializeChatDetailed(chat))`,
  'load chats detail'
)

replace(
  'server.js',
  `    } else if (u._ === 'updateNewChat') {\n      sendAll({ type: 'event', event: { name: 'chat-upsert', chat: serializeChat(u.chat) } })\n    } else if (u._ === 'updateChatTitle') {\n      client.invoke({ _: 'getChat', chat_id: u.chat_id }).then(chat => {\n        sendAll({ type: 'event', event: { name: 'chat-upsert', chat: serializeChat(chat) } })\n      }).catch(() => {})\n    } else if (u._ === 'updateChatPhoto' || u._ === 'updateChatPosition' || u._ === 'updateChatLastMessage') {\n      client.invoke({ _: 'getChat', chat_id: u.chat_id }).then(chat => {\n        sendAll({ type: 'event', event: { name: 'chat-upsert', chat: serializeChat(chat) } })\n      }).catch(() => {})\n    }`,
  `    } else if (u._ === 'updateNewChat') {\n      serializeChatDetailed(u.chat).then(chat => {\n        sendAll({ type: 'event', event: { name: 'chat-upsert', chat } })\n      }).catch(() => {})\n    } else if (u._ === 'updateChatTitle' || u._ === 'updateChatPhoto' || u._ === 'updateChatLastMessage') {\n      client.invoke({ _: 'getChat', chat_id: u.chat_id }).then(serializeChatDetailed).then(chat => {\n        sendAll({ type: 'event', event: { name: 'chat-upsert', chat } })\n      }).catch(() => {})\n    } else if (u._ === 'updateChatPosition') {\n      const pos = u.position || {}\n      const isMain = !pos.chat_list || pos.chat_list._ === 'chatListMain'\n      if (isMain && String(pos.order || '0') === '0') {\n        sendAll({ type: 'event', event: { name: 'chat-remove', chatId: u.chat_id } })\n      } else {\n        client.invoke({ _: 'getChat', chat_id: u.chat_id }).then(serializeChatDetailed).then(chat => {\n          sendAll({ type: 'event', event: { name: 'chat-upsert', chat } })\n        }).catch(() => {})\n      }\n    }`,
  'realtime chat lifecycle'
)

replace(
  'server.js',
  `            chats.push(serializeChat(chat))`,
  `            chats.push(await serializeChatDetailed(chat))`,
  'destination detail'
)

// Include outbound state to support cleaner message presentation.
replace(
  'server.js',
  `      sender: await resolveSenderName(m),\n      media: extractMedia(m)`,
  `      sender: await resolveSenderName(m),\n      outgoing: !!m.is_outgoing,\n      media: extractMedia(m)`,
  'message outgoing state'
)

// ---------- client: chat lifecycle + usernames ----------
replace(
  'public/app.js',
  `    case 'chat-upsert':\n      upsertChat(ev.chat)\n      break`,
  `    case 'chat-upsert':\n      upsertChat(ev.chat)\n      break\n    case 'chat-remove':\n      removeChat(ev.chatId)\n      break`,
  'client chat remove event'
)

replace(
  'public/app.js',
  `function upsertChat (chat) {\n  if (!chat || chat.id == null) return`,
  `function removeChat (chatId) {\n  const wasActive = String(state.activeChatId) === String(chatId)\n  state.chats = state.chats.filter(c => String(c.id) !== String(chatId))\n  if (wasActive) {\n    state.activeChatId = null\n    state.messages = []\n    state.selection.clear()\n    state.selectedMessages.clear()\n    $('#chat-title').textContent = 'Select a chat'\n    $('#messages').innerHTML = ''\n    $('#media-grid').innerHTML = ''\n  }\n  renderChats()\n  updateSelectionBar()\n}\n\nfunction upsertChat (chat) {\n  if (!chat || chat.id == null) return`,
  'client remove chat helper'
)

replace(
  'public/app.js',
  `    col.appendChild(h('div', 't', chat.title))\n    if (chat.lastText) col.appendChild(h('div', 'preview', chat.lastText))`,
  `    col.appendChild(h('div', 't', chat.title))\n    const identity = chat.username ? '@' + chat.username : (chat.lastText || '')\n    if (identity) {\n      const preview = h('div', 'preview', identity)\n      preview.title = identity\n      col.appendChild(preview)\n    }`,
  'sidebar username exposure'
)

// ---------- client: single message selection control ----------
replace(
  'public/app.js',
  `function buildMediaRow (m) {`,
  `function buildMediaRow (m, includeSelection = true) {`,
  'media row selection parameter'
)
replace(
  'public/app.js',
  `  row.appendChild(makeCheckbox(media))\n  loadThumb(img, media)`,
  `  if (includeSelection) row.appendChild(makeCheckbox(media))\n  loadThumb(img, media)`,
  'media row optional checkbox'
)
replace(
  'public/app.js',
  `    if (m.media) msgEl.appendChild(buildMediaRow(m))\n    const select = h('label', 'msg-select')`,
  `    if (m.media) msgEl.appendChild(buildMediaRow(m, false))\n    const select = h('label', 'msg-select')`,
  'message media single checkbox'
)
replace(
  'public/app.js',
  `    cb.onchange = () => {\n      if (cb.checked) state.selectedMessages.set(key, m)\n      else state.selectedMessages.delete(key)\n      updateSelectionBar()\n    }`,
  `    cb.onchange = () => {\n      if (cb.checked) {\n        state.selectedMessages.set(key, m)\n        if (m.media) state.selection.set(key, m.media)\n      } else {\n        state.selectedMessages.delete(key)\n        if (m.media) state.selection.delete(key)\n      }\n      updateSelectionBar()\n    }`,
  'message checkbox sync'
)
replace(
  'public/app.js',
  `    const msgEl = h('div', 'msg')`,
  `    const msgEl = h('div', 'msg' + (m.outgoing ? ' outgoing' : ' incoming'))`,
  'message direction class'
)

// ---------- client: real destination picker instead of browser prompt ----------
replace(
  'public/app.js',
  `async function forwardSelectedMessages () {\n  if (!state.activeChatId) return\n  const messageIds = selectedForwardIds()\n  if (!messageIds.length) return toast('Select one or more messages first', 'error')\n\n  const typed = prompt('Forward to chat title or @username:')\n  if (!typed) return\n\n  try {\n    const candidates = await searchForwardDestinations(typed)\n    let destination = null\n    if (typed.startsWith('@')) destination = { username: typed }\n    else if (candidates.chats && candidates.chats.length) destination = { chatId: candidates.chats[0].id }\n    else destination = { query: typed }\n\n    const result = await request('forward-messages', {\n      sourceChatId: state.activeChatId,\n      messageIds,\n      destination\n    })\n    const forwarded = (result.forwarded || []).length\n    const skipped = (result.skipped || []).length\n    state.selectedMessages.clear()\n    state.selection.clear()\n    updateSelectionBar()\n    renderMessagesList()\n    renderFiles()\n    toastOk(\`Forwarded \${forwarded} message(s)\${skipped ? \` · \${skipped} already sent this session\` : ''}\`)\n  } catch (e) {\n    toast(e.message, 'error')\n  }\n}`,
  `function ensureForwardModal () {\n  let modal = $('#forward-modal')\n  if (modal) return modal\n  modal = h('div', 'forward-modal hidden')\n  modal.id = 'forward-modal'\n  modal.innerHTML = \`<div class="forward-dialog">\n    <div class="forward-head"><div><strong>Forward messages</strong><div id="forward-summary" class="small muted"></div></div><button id="forward-close" class="ghost small">✕</button></div>\n    <input id="forward-search" type="search" placeholder="Search chats or @username…" autocomplete="off">\n    <div id="forward-results" class="forward-results"></div>\n  </div>\`\n  document.body.appendChild(modal)\n  $('#forward-close').onclick = closeForwardModal\n  modal.addEventListener('mousedown', e => { if (e.target === modal) closeForwardModal() })\n  $('#forward-search').addEventListener('input', debounce(() => loadForwardDestinations($('#forward-search').value), 180))\n  return modal\n}\n\nfunction closeForwardModal () {\n  const modal = $('#forward-modal')\n  if (modal) modal.classList.add('hidden')\n}\n\nasync function sendForwardTo (chat) {\n  const messageIds = selectedForwardIds()\n  try {\n    const result = await request('forward-messages', {\n      sourceChatId: state.activeChatId,\n      messageIds,\n      destination: { chatId: chat.id }\n    })\n    const forwarded = (result.forwarded || []).length\n    const skipped = (result.skipped || []).length\n    state.selectedMessages.clear()\n    state.selection.clear()\n    closeForwardModal()\n    updateSelectionBar()\n    renderMessagesList()\n    renderFiles()\n    toastOk(\`Forwarded \${forwarded} message(s) to \${chat.title}\${skipped ? \` · \${skipped} skipped\` : ''}\`)\n  } catch (e) { toast(e.message, 'error') }\n}\n\nasync function loadForwardDestinations (query = '') {\n  const results = $('#forward-results')\n  if (!results) return\n  results.innerHTML = '<div class="forward-loading">Loading chats…</div>'\n  try {\n    const data = await searchForwardDestinations(query)\n    results.innerHTML = ''\n    for (const chat of data.chats || []) {\n      const row = h('button', 'forward-chat')\n      row.type = 'button'\n      const av = h('span', 'forward-avatar', initials(chat.title))\n      av.style.background = avatarColor(chat.title)\n      const body = h('span', 'forward-chat-body')\n      body.appendChild(h('span', 'forward-chat-title', chat.title))\n      const meta = chat.username ? '@' + chat.username : (chat.kind || 'chat')\n      body.appendChild(h('span', 'forward-chat-meta', meta))\n      row.append(av, body)\n      row.onclick = () => sendForwardTo(chat)\n      results.appendChild(row)\n    }\n    if (!results.children.length) results.appendChild(h('div', 'forward-loading', 'No matching chats'))\n  } catch (e) {\n    results.innerHTML = ''\n    results.appendChild(h('div', 'forward-loading', e.message))\n  }\n}\n\nasync function forwardSelectedMessages () {\n  if (!state.activeChatId) return\n  const messageIds = selectedForwardIds()\n  if (!messageIds.length) return toast('Select one or more messages first', 'error')\n  const modal = ensureForwardModal()\n  $('#forward-summary').textContent = \`${messageIds.length} selected message\${messageIds.length === 1 ? '' : 's'}\`\n  $('#forward-search').value = ''\n  modal.classList.remove('hidden')\n  $('#forward-search').focus()\n  await loadForwardDestinations('')\n}`,
  'forward destination modal'
)

// clear both selection maps via Clear.
replace(
  'public/app.js',
  `$('#clear-selection').onclick = () => {\n  state.selection.clear()`,
  `$('#clear-selection').onclick = () => {\n  state.selection.clear()\n  state.selectedMessages.clear()`,
  'clear both selections'
)

// ---------- CSS: fill viewport + cleaner messages + destination modal ----------
append('public/style.css', `
/* ---------- Rescue UI refinement ---------- */
#main-screen { width: 100vw; max-width: none; align-items: stretch; justify-content: stretch; }
.app { width: 100vw; max-width: none; grid-template-columns: minmax(250px, 310px) minmax(0, 1fr) minmax(300px, 370px); }
.chat, .sidebar, .downloads { height: 100vh; }

.msg { position: relative; width: min(760px, 82%); max-width: 82%; padding: 12px 46px 12px 14px; }
.msg.incoming { align-self: flex-start; }
.msg.outgoing { align-self: flex-end; background: #183247; border-color: #245277; }
.msg-select { position: absolute; top: 12px; right: 12px; flex-direction: row; align-items: center; font-size: 11px; }
.msg-select input { width: 17px; height: 17px; padding: 0; accent-color: var(--accent); }
.msg .media { margin-top: 9px; }

.forward-modal { position: fixed; inset: 0; z-index: 1000; background: rgba(3,7,12,.72); display: flex; align-items: center; justify-content: center; padding: 24px; backdrop-filter: blur(5px); }
.forward-dialog { width: min(560px, 94vw); max-height: min(720px, 86vh); display: flex; flex-direction: column; gap: 12px; padding: 16px; border-radius: 16px; border: 1px solid var(--border); background: var(--panel); box-shadow: 0 24px 80px rgba(0,0,0,.6); }
.forward-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.forward-head strong { font-size: 17px; }
#forward-search { width: 100%; }
.forward-results { overflow: auto; min-height: 180px; display: flex; flex-direction: column; gap: 4px; }
.forward-chat { width: 100%; display: flex; align-items: center; gap: 11px; padding: 9px 10px; text-align: left; background: transparent; border: 1px solid transparent; color: var(--text); }
.forward-chat:hover { background: var(--panel2); border-color: var(--border); filter: none; }
.forward-avatar { width: 38px; height: 38px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; flex: 0 0 38px; color: #fff; font-weight: 700; }
.forward-chat-body { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.forward-chat-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 600; }
.forward-chat-meta { color: var(--muted); font-size: 11px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.forward-loading { color: var(--muted); padding: 18px 10px; text-align: center; }

@media (max-width: 1100px) {
  .app { grid-template-columns: 250px minmax(0,1fr) 300px; }
}
`)

console.log('rescue UI/realtime patch applied')
