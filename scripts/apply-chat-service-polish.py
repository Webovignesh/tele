from pathlib import Path


def read(path):
    return Path(path).read_text()


def write(path, text):
    Path(path).write_text(text)


def replace_once(path, old, new, label):
    src = read(path)
    if old not in src:
        raise SystemExit(f"{label}: anchor not found")
    write(path, src.replace(old, new, 1))


def append_once(path, marker, text):
    src = read(path)
    if marker not in src:
        write(path, src.rstrip() + "\n\n" + text.strip() + "\n")


# ------------------------------ server.js ------------------------------
replace_once(
    'server.js',
    "/* ------------------------------ Client init ------------------------------ */\n\nfunction initClient (config) {",
    """/* Realtime entity/full-info caches. TDLib full-info getters may return cached
 * data for a short period, so update*FullInfo events are treated as authoritative. */
const managedSupergroupFullInfoCache = new Map()
const managedBasicGroupFullInfoCache = new Map()
const supergroupChatIds = new Map()
const basicGroupChatIds = new Map()
const privateUserChatIds = new Map()

/* ------------------------------ Client init ------------------------------ */

function initClient (config) {""",
    'server realtime maps',
)

replace_once(
    'server.js',
    """    if (u._ === 'updateChatMember') {
      emitChatUpsert(u.chat_id).catch(() => {})
      emitManagementRefresh(u.chat_id)
      return
    }

    if ([
      'updateSupergroup',
      'updateSupergroupFullInfo',
      'updateBasicGroup',
      'updateBasicGroupFullInfo',
      'updateUser',
      'updateUserFullInfo'
    ].includes(u._)) {
      emitManagementRefresh(null)
    }""",
    """    if (u._ === 'updateChatMember') {
      emitChatUpsert(u.chat_id).catch(() => {})
      emitManagementRefresh(u.chat_id)
      return
    }

    if (u._ === 'updateSupergroupFullInfo') {
      managedSupergroupFullInfoCache.set(String(u.supergroup_id), u.supergroup_full_info)
      const chatId = supergroupChatIds.get(String(u.supergroup_id))
      if (chatId != null) emitChatUpsert(chatId).catch(() => {})
      sendAll({ type: 'event', event: { name: 'management-refresh', chatId: chatId == null ? null : chatId, supergroupId: u.supergroup_id } })
      return
    }
    if (u._ === 'updateBasicGroupFullInfo') {
      managedBasicGroupFullInfoCache.set(String(u.basic_group_id), u.basic_group_full_info)
      const chatId = basicGroupChatIds.get(String(u.basic_group_id))
      if (chatId != null) emitChatUpsert(chatId).catch(() => {})
      sendAll({ type: 'event', event: { name: 'management-refresh', chatId: chatId == null ? null : chatId, basicGroupId: u.basic_group_id } })
      return
    }
    if (u._ === 'updateSupergroup') {
      const chatId = supergroupChatIds.get(String(u.supergroup && u.supergroup.id))
      if (chatId != null) emitChatUpsert(chatId).catch(() => {})
      sendAll({ type: 'event', event: { name: 'management-refresh', chatId: chatId == null ? null : chatId, supergroupId: u.supergroup && u.supergroup.id } })
      return
    }
    if (u._ === 'updateBasicGroup') {
      const chatId = basicGroupChatIds.get(String(u.basic_group && u.basic_group.id))
      if (chatId != null) emitChatUpsert(chatId).catch(() => {})
      sendAll({ type: 'event', event: { name: 'management-refresh', chatId: chatId == null ? null : chatId, basicGroupId: u.basic_group && u.basic_group.id } })
      return
    }
    if (u._ === 'updateUser' || u._ === 'updateUserFullInfo') {
      const userId = u.user ? u.user.id : u.user_id
      const chatId = privateUserChatIds.get(String(userId))
      if (chatId != null) emitChatUpsert(chatId).catch(() => {})
      emitManagementRefresh(chatId == null ? null : chatId)
    }""",
    'server realtime entity updates',
)

replace_once(
    'server.js',
    """  const t = chat.type
  if (t) {
    if (t._ === 'chatTypePrivate') info.kind = 'private'
    else if (t._ === 'chatTypeBasicGroup') info.kind = 'group'
    else if (t._ === 'chatTypeSupergroup') info.kind = t.is_channel ? 'channel' : 'supergroup'
    else info.kind = 'other'
  }
  return info""",
    """  const t = chat.type
  if (t) {
    if (t._ === 'chatTypePrivate') {
      info.kind = 'private'
      privateUserChatIds.set(String(t.user_id), chat.id)
    } else if (t._ === 'chatTypeBasicGroup') {
      info.kind = 'group'
      basicGroupChatIds.set(String(t.basic_group_id), chat.id)
    } else if (t._ === 'chatTypeSupergroup') {
      info.kind = t.is_channel ? 'channel' : 'supergroup'
      supergroupChatIds.set(String(t.supergroup_id), chat.id)
    } else info.kind = 'other'
  }
  return info""",
    'server entity id mapping',
)

replace_once(
    'server.js',
    """    canDeleteForAll: !!chat.can_be_deleted_for_all_users,
    canClearHistory: !!(chat.can_be_deleted_only_for_self || chat.can_be_deleted_for_all_users),""",
    """    canDeleteForAll: !!chat.can_be_deleted_for_all_users,
    canClearHistoryForSelf: !!chat.can_be_deleted_only_for_self,
    canClearHistoryForAll: !!chat.can_be_deleted_for_all_users,
    canClearHistory: !!(chat.can_be_deleted_only_for_self || chat.can_be_deleted_for_all_users),""",
    'server clear-history permissions',
)

replace_once(
    'server.js',
    """    fullInfo = await client.invoke({ _: 'getSupergroupFullInfo', supergroup_id: type.supergroup_id }).catch(() => null)
    canGetMembers = !!(fullInfo && fullInfo.can_get_members)""",
    """    fullInfo = managedSupergroupFullInfoCache.get(String(type.supergroup_id)) ||
      await client.invoke({ _: 'getSupergroupFullInfo', supergroup_id: type.supergroup_id }).catch(() => null)
    if (fullInfo) managedSupergroupFullInfoCache.set(String(type.supergroup_id), fullInfo)
    canGetMembers = !!(fullInfo && fullInfo.can_get_members)""",
    'server supergroup full info cache',
)

replace_once(
    'server.js',
    """    fullInfo = await client.invoke({ _: 'getBasicGroupFullInfo', basic_group_id: type.basic_group_id }).catch(() => null)
    canGetMembers = !!fullInfo""",
    """    fullInfo = managedBasicGroupFullInfoCache.get(String(type.basic_group_id)) ||
      await client.invoke({ _: 'getBasicGroupFullInfo', basic_group_id: type.basic_group_id }).catch(() => null)
    if (fullInfo) managedBasicGroupFullInfoCache.set(String(type.basic_group_id), fullInfo)
    canGetMembers = !!fullInfo""",
    'server basic group full info cache',
)

chat_helpers = r'''

/* ------------------------------ Interactive chat service ------------------------------ */

function managedTextContent (text) {
  return {
    _: 'inputMessageText',
    text: { _: 'formattedText', text, entities: [] },
    link_preview_options: null,
    clear_draft: true
  }
}

async function getManagedMessageActions (chatId, messageId) {
  ensureManagementReady()
  const properties = await client.invoke({ _: 'getMessageProperties', chat_id: chatId, message_id: messageId })
  return {
    canReply: !!properties.can_be_replied,
    canEdit: !!properties.can_be_edited,
    canDeleteSelf: !!properties.can_be_deleted_only_for_self,
    canDeleteAll: !!properties.can_be_deleted_for_all_users
  }
}

async function sendManagedTextMessage (chatId, text, replyToMessageId) {
  ensureManagementReady()
  const body = String(text || '').trim()
  if (!body) throw new Error('Message is empty')
  if (body.length > 4096) throw new Error('Message is too long')
  let replyTo = null
  if (replyToMessageId) {
    const actions = await getManagedMessageActions(chatId, replyToMessageId)
    if (!actions.canReply) throw new Error('Telegram does not allow replying to this message')
    replyTo = { _: 'inputMessageReplyToMessage', message_id: replyToMessageId, quote: null, checklist_task_id: 0 }
  }
  const message = await client.invoke({
    _: 'sendMessage',
    chat_id: chatId,
    topic_id: null,
    reply_to: replyTo,
    options: null,
    reply_markup: null,
    input_message_content: managedTextContent(body)
  })
  emitRealtimeMessage(message).catch(() => {})
  emitChatUpsert(chatId).catch(() => {})
  return serializeRealtimeMessage(message)
}

async function editManagedTextMessage (chatId, messageId, text) {
  ensureManagementReady()
  const body = String(text || '').trim()
  if (!body) throw new Error('Message is empty')
  const actions = await getManagedMessageActions(chatId, messageId)
  if (!actions.canEdit) throw new Error('Telegram does not allow editing this message')
  const message = await client.invoke({
    _: 'editMessageText',
    chat_id: chatId,
    message_id: messageId,
    reply_markup: null,
    input_message_content: managedTextContent(body)
  })
  emitRealtimeMessage(message).catch(() => {})
  return serializeRealtimeMessage(message)
}

async function deleteManagedMessage (chatId, messageId, revoke) {
  ensureManagementReady()
  const actions = await getManagedMessageActions(chatId, messageId)
  const useRevoke = revoke === true
  if (useRevoke && !actions.canDeleteAll) throw new Error('Telegram does not allow deleting this message for everyone')
  if (!useRevoke && !actions.canDeleteSelf) throw new Error('Telegram does not allow deleting this message only for you')
  await client.invoke({ _: 'deleteMessages', chat_id: chatId, message_ids: [messageId], revoke: useRevoke })
  sendAll({ type: 'event', event: { name: 'message-delete', chatId, messageIds: [messageId], isPermanent: useRevoke } })
  emitChatUpsert(chatId).catch(() => {})
  return { ok: true, revoke: useRevoke }
}
'''
replace_once(
    'server.js',
    "\n\n/* ------------------------------ File search ------------------------------ */",
    chat_helpers + "\n\n/* ------------------------------ File search ------------------------------ */",
    'server chat helpers',
)

replace_once(
    'server.js',
    """        case 'get-chat-management':
          return respond(ws, id, true, await getManagedChatInfo(payload.chatId))""",
    """        case 'get-message-actions':
          return respond(ws, id, true, await getManagedMessageActions(payload.chatId, payload.messageId))
        case 'send-chat-message':
          return respond(ws, id, true, await sendManagedTextMessage(payload.chatId, payload.text, payload.replyToMessageId))
        case 'edit-chat-message':
          return respond(ws, id, true, await editManagedTextMessage(payload.chatId, payload.messageId, payload.text))
        case 'delete-chat-message':
          return respond(ws, id, true, await deleteManagedMessage(payload.chatId, payload.messageId, payload.revoke))
        case 'get-chat-management':
          return respond(ws, id, true, await getManagedChatInfo(payload.chatId))""",
    'server chat service commands',
)

replace_once(
    'server.js',
    """          if (revoke && !info.permissions.canDeleteForAll) throw new Error('Telegram does not allow deleting this history for everyone')
          if (!revoke && !info.permissions.canClearHistory) throw new Error('Telegram does not allow clearing this history')""",
    """          if (revoke && !info.permissions.canClearHistoryForAll) throw new Error('Telegram does not allow deleting this history for everyone')
          if (!revoke && !info.permissions.canClearHistoryForSelf) throw new Error('Telegram does not allow deleting this history only for you')""",
    'server clear-history mode validation',
)

# ------------------------------ app.js message action affordances ------------------------------
replace_once(
    'public/app.js',
    """    if (m.text) msgEl.appendChild(h('div', 'msg-text', m.text))
    if (m.media) msgEl.appendChild(buildMediaRow(m, false))
    const select = h('label', 'msg-select')""",
    """    if (m.text) msgEl.appendChild(h('div', 'msg-text', m.text))
    if (m.media) msgEl.appendChild(buildMediaRow(m, false))
    const actions = h('div', 'msg-actions')
    const reply = h('button', 'ghost small', 'Reply')
    reply.type = 'button'
    reply.onclick = (e) => { e.stopPropagation(); if (window.teleReplyToMessage) window.teleReplyToMessage(m) }
    actions.appendChild(reply)
    if (m.outgoing && m.text) {
      const edit = h('button', 'ghost small', 'Edit')
      edit.type = 'button'
      edit.onclick = (e) => { e.stopPropagation(); if (window.teleEditMessage) window.teleEditMessage(m) }
      actions.appendChild(edit)
    }
    const del = h('button', 'ghost small danger-outline', 'Delete')
    del.type = 'button'
    del.onclick = (e) => { e.stopPropagation(); if (window.teleDeleteMessage) window.teleDeleteMessage(m) }
    actions.appendChild(del)
    msgEl.appendChild(actions)
    const select = h('label', 'msg-select')""",
    'message inline actions',
)

# ------------------------------ rescue-runtime.js ------------------------------
replace_once(
    'public/rescue-runtime.js',
    """  rescueUpsertCachedMessage(chatKey, message)
  rescuePatchCompleteFileCache(chatKey, message)
  if (state.activeChatId == null || rescueChatKey(state.activeChatId) !== chatKey) return""",
    """  rescueUpsertCachedMessage(chatKey, message)
  rescuePatchCompleteFileCache(chatKey, message)
  rescueMaybeNotifyMessage(chatId, message)
  if (state.activeChatId == null || rescueChatKey(state.activeChatId) !== chatKey) return""",
    'desktop notification hook',
)

replace_once(
    'public/rescue-runtime.js',
    """  rescueRememberView(view)
  rescueBaseSetView(view)
  if (view === 'files' && state.activeChatId != null) {""",
    """  rescueRememberView(view)
  rescueBaseSetView(view)
  if (typeof rescueUpdateComposerVisibility === 'function') rescueUpdateComposerVisibility()
  if (view === 'files' && state.activeChatId != null) {""",
    'composer view visibility hook',
)

chat_runtime = r'''

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
'''
append_once('public/rescue-runtime.js', 'Chat composer + desktop notifications', chat_runtime)

# ------------------------------ management.js ------------------------------
replace_once(
    'public/management.js',
    """    box.appendChild(row)
    return box
  }

  function renderDangerSection""",
    """    box.appendChild(row)

    if (window.teleEnableDesktopNotifications) {
      const desktop = elem('div', 'mg-setting-row')
      const copy = elem('div', '')
      const enabled = window.teleDesktopNotificationsEnabled && window.teleDesktopNotificationsEnabled()
      copy.append(
        elem('strong', '', enabled ? 'Desktop notifications enabled' : 'Desktop notifications'),
        elem('span', 'muted', enabled ? 'Tele can alert you about incoming messages while the browser is open.' : 'Allow Tele to show Windows/browser notifications for incoming messages.')
      )
      const desktopToggle = button(enabled ? 'Disable' : 'Enable', 'ghost', async () => {
        desktopToggle.disabled = true
        try {
          if (enabled) {
            window.teleDisableDesktopNotifications()
            toastOk('Desktop notifications disabled')
          } else {
            await window.teleEnableDesktopNotifications()
            toastOk('Desktop notifications enabled')
          }
          refreshChatInfo()
        } catch (e) { toast(e.message, 'error') } finally { desktopToggle.disabled = false }
      })
      desktop.append(copy, desktopToggle)
      box.appendChild(desktop)
    }
    return box
  }

  function renderDangerSection""",
    'desktop notification settings UI',
)

replace_once(
    'public/management.js',
    """    if (permissions.canClearHistory) {
      const clearSelf = button('Clear history', 'ghost danger-outline', async () => {
        if (!await confirmAction('Clear chat history?', 'Messages will be removed from your history. This cannot be undone.', 'Clear history')) return
        try {
          await request('clear-managed-history', { chatId: chat.id, revoke: false })
          state.messages = []
          renderMessagesList()
          renderFiles()
          toastOk('Chat history cleared')
        } catch (e) { toast(e.message, 'error') }
      })
      box.appendChild(clearSelf)
    }""",
    """    if (permissions.canClearHistoryForSelf) {
      const clearSelf = button('Clear history for me', 'ghost danger-outline', async () => {
        if (!await confirmAction('Clear history for you?', 'Messages will be removed only from your history.', 'Clear for me')) return
        try {
          await request('clear-managed-history', { chatId: chat.id, revoke: false })
          state.messages = []
          renderMessagesList()
          renderFiles()
          toastOk('Chat history cleared for you')
        } catch (e) { toast(e.message, 'error') }
      })
      box.appendChild(clearSelf)
    }
    if (permissions.canClearHistoryForAll) {
      const clearAll = button('Clear history for everyone', 'ghost danger-outline', async () => {
        if (!await confirmAction('Clear history for everyone?', 'Telegram will permanently delete the chat history for all members where your permissions allow it.', 'Clear for everyone')) return
        try {
          await request('clear-managed-history', { chatId: chat.id, revoke: true })
          state.messages = []
          renderMessagesList()
          renderFiles()
          toastOk('Chat history cleared for everyone')
        } catch (e) { toast(e.message, 'error') }
      })
      box.appendChild(clearAll)
    }""",
    'clear history UI modes',
)

replace_once(
    'public/management.js',
    """  mountDrawer()
  mountEntryPoints()
  wrapExistingRuntime()""",
    """  window.teleConfirmAction = confirmAction

  mountDrawer()
  mountEntryPoints()
  wrapExistingRuntime()""",
    'expose in-app confirmation',
)

# ------------------------------ management.css ------------------------------
append_once(
    'public/management.css',
    'Tele chat composer and message actions',
    r'''
/* Tele chat composer and message actions */
.msg { position: relative; }
.msg-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
  align-items: center;
  margin-top: 7px;
  opacity: .35;
  transition: opacity .15s ease;
}
.msg:hover .msg-actions,
.msg:focus-within .msg-actions { opacity: 1; }
.msg-actions button { font-size: 10.5px; padding: 4px 7px; }

.tele-composer {
  flex: 0 0 auto;
  border-top: 1px solid var(--border);
  background: var(--panel);
  padding: 10px 14px 11px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.tele-compose-row { display: grid; grid-template-columns: 1fr auto; align-items: end; gap: 8px; }
#tele-compose-input {
  width: 100%;
  min-height: 40px;
  max-height: 140px;
  resize: none;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--bg);
  color: var(--text);
  padding: 10px 12px;
  font: inherit;
  line-height: 1.4;
  outline: none;
}
#tele-compose-input:focus { border-color: var(--accent); }
#tele-compose-send { min-width: 72px; height: 40px; }
.tele-compose-context {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 9px;
  border-left: 3px solid var(--accent);
  border-radius: 7px;
  background: rgba(61,155,250,.08);
}
.tele-compose-context > div { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.tele-compose-context strong { font-size: 11px; color: var(--accent); }
.tele-compose-context span { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
'''
)

# ------------------------------ index cache bust ------------------------------
index = read('public/index.html')
index = index.replace('rescue-runtime.js?v=3', 'rescue-runtime.js?v=4')
index = index.replace('management.css?v=2', 'management.css?v=3')
index = index.replace('management.js?v=1', 'management.js?v=2')
write('public/index.html', index)

# ------------------------------ smoke guards ------------------------------
smoke = read('scripts/rescue-smoke.test.cjs')
extra = r'''
assert.match(server, /getMessageProperties/, 'message actions must be permission-aware')
assert.match(server, /sendMessage/, 'chat composer must send through TDLib')
assert.match(server, /editMessageText/, 'text editing must use TDLib')
assert.match(server, /deleteMessages/, 'message deletion must use TDLib')
assert.match(server, /canClearHistoryForSelf/, 'clear history must distinguish self/all permissions')
assert.match(server, /managedSupergroupFullInfoCache/, 'invite-link/full-info updates must use authoritative realtime cache')
assert.match(management, /Desktop notifications/, 'desktop notification controls must exist')
assert.match(management, /Clear history for everyone/, 'history UI must expose valid revoke mode')
'''
if 'message actions must be permission-aware' not in smoke:
    smoke = smoke.rstrip() + '\n' + extra
write('scripts/rescue-smoke.test.cjs', smoke)

print('chat service and realtime polish applied')
