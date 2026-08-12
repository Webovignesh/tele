from pathlib import Path
import re


def read(path):
    return Path(path).read_text()


def write(path, text):
    Path(path).write_text(text)


def replace_once(path, old, new, label):
    src = read(path)
    if old not in src:
        raise SystemExit(f"{label}: anchor not found")
    write(path, src.replace(old, new, 1))


def sub_once(path, pattern, replacement, label):
    src = read(path)
    out, count = re.subn(pattern, replacement, src, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{label}: expected 1 replacement, got {count}")
    write(path, out)


# ---------------------------------------------------------------------------
# MANAGEMENT UI: fix create wizard, simplify channel/group access to invite
# links, make invite info fresher, and make desktop notifications diagnosable.
# ---------------------------------------------------------------------------

replace_once(
    'public/management.js',
    "    memberLoading: false,\n    usernameCheckSeq: 0,\n    usernameCheck: null,\n    photoPreviewUrl: null",
    "    memberLoading: false,\n    photoPreviewUrl: null",
    'remove username state'
)

replace_once(
    'public/management.js',
    "      visibility: 'private',\n      username: '',\n      members: '',",
    "      members: '',",
    'simplify create draft'
)

sub_once(
    'public/management.js',
    r"\n  function usernamePresentation \(kind\) \{.*?\n  function parseMemberUsernames \(value\) \{",
    "\n  function parseMemberUsernames (value) {",
    'remove channel/group username UI helpers'
)

replace_once(
    'public/management.js',
    "    } else if (ui.createStep === 3) {\n      const username = document.querySelector('#mg-create-username')\n      const members = document.querySelector('#mg-create-members')\n      if (username) draft.username = normalizeUsername(username.value)\n      if (members) draft.members = members.value.trim()\n    }",
    "    } else if (ui.createStep === 3) {\n      const members = document.querySelector('#mg-create-members')\n      if (members) draft.members = members.value.trim()\n    }",
    'capture members only'
)

sub_once(
    'public/management.js',
    r"\n    if \(ui\.createStep === 3 && draft\.visibility === 'public'\) \{.*?\n    \}\n    return true",
    "\n    return true",
    'remove username validation from create wizard'
)

replace_once(
    'public/management.js',
    "      if (next && ui.createStep !== 4) next.disabled = false",
    "      if (next) next.disabled = false",
    'fix disabled Create button'
)

replace_once(
    'public/management.js',
    "    const labels = ['Type', 'Details', 'Access', 'Review']",
    "    const labels = ['Type', 'Details', 'Members', 'Review']",
    'rename create step'
)

replace_once(
    'public/management.js',
    "    body.appendChild(elem('p', 'mg-step-copy', 'Choose what you want to create. Groups use Telegram supergroups so public usernames and modern management features are available.'))",
    "    body.appendChild(elem('p', 'mg-step-copy', 'Choose what you want to create. Tele creates a private Telegram channel or modern supergroup and manages access through invite links.'))",
    'create type copy'
)

sub_once(
    'public/management.js',
    r"  function renderCreateAccess \(body\) \{.*?\n  \}\n\n  function renderCreateReview \(body\) \{",
    """  function renderCreateAccess (body) {
    body.appendChild(elem('p', 'mg-step-copy', 'Access is invite-link based. After creation, Chat Info shows the current Telegram invite link and lets you copy or rotate it.'))
    const members = textarea(ui.createDraft.members, '@alice, @bob (optional)')
    members.id = 'mg-create-members'
    members.rows = 3
    body.appendChild(labelled('Initial members by @username', members))
    body.appendChild(elem('span', 'mg-help', 'Up to 20 user usernames can be resolved for initial membership. Telegram privacy restrictions may prevent some users from being added.'))
  }

  function renderCreateReview (body) {""",
    'replace create access step'
)

replace_once(
    'public/management.js',
    "      ['Visibility', d.visibility === 'public' ? (d.type === 'channel' ? `Public · t.me/${d.username}` : `Public · @${d.username}`) : 'Private'],",
    "      ['Access', 'Private · invite link'],",
    'review access row'
)

replace_once(
    'public/management.js',
    "    body.appendChild(elem('p', 'mg-step-copy', 'Tele will create the chat through TDLib, apply the requested username, add eligible members, then open the new chat automatically.'))",
    "    body.appendChild(elem('p', 'mg-step-copy', 'Tele will create the chat through TDLib, add eligible members, then open it automatically. Invite-link management is available in Chat Info.'))",
    'review copy'
)

replace_once(
    'public/management.js',
    "        visibility: d.visibility,\n        username: d.visibility === 'public' ? d.username : '',\n        forum: d.type === 'group' && d.forum,",
    "        forum: d.type === 'group' && d.forum,",
    'remove username create payload'
)

replace_once(
    'public/management.js',
    "    titleBox.append(elem('h3', '', chat.title), elem('span', 'muted', chat.username ? (chat.kind === 'channel' ? `t.me/${chat.username}` : `@${chat.username}`) : formatKind(chat.kind)))",
    "    const identity = chat.kind === 'private' && chat.username ? `@${chat.username}` : formatKind(chat.kind)\n    titleBox.append(elem('h3', '', chat.title), elem('span', 'muted', identity))",
    'show usernames only for private contacts'
)

replace_once(
    'public/management.js',
    "      infoRow('Access', chat.username ? 'Public' : (chat.kind === 'private' ? 'Private chat' : 'Private')),
",
    "      infoRow('Access', chat.kind === 'private' ? 'Private chat' : (details.inviteLink ? 'Invite link' : 'Private')),
",
    'overview access label'
)

sub_once(
    'public/management.js',
    r"\n    let username = null\n    let usernameStatus = null\n    if \(permissions\.canEditUsername\) \{.*?\n    \}\n\n    const actions = elem\('div', 'mg-row'\)",
    "\n    const actions = elem('div', 'mg-row')",
    'remove username edit controls'
)

sub_once(
    'public/management.js',
    r"\n        if \(username\) \{.*?\n        \}\n        await request\('update-managed-chat', \{",
    "\n        await request('update-managed-chat', {",
    'remove username save validation'
)

replace_once(
    'public/management.js',
    "          username: username ? normalizeUsername(username.value) : undefined,\n",
    "",
    'remove username update payload'
)

sub_once(
    'public/management.js',
    r"  function renderInviteSection \(data\) \{.*?\n  \}\n\n  function renderMembersSection \(data\) \{",
    """  function renderInviteSection (data) {
    const { chat, details, permissions } = data
    const box = section('Invite link')
    const linkRow = elem('div', 'mg-invite-row')
    const value = elem('div', 'mg-invite-value', details.inviteLink || 'No invite link available yet')
    value.title = details.inviteLink || ''
    linkRow.appendChild(value)
    if (details.inviteLink) linkRow.appendChild(button('Copy', 'ghost small', () => copyText(details.inviteLink, 'Invite link copied')))
    linkRow.appendChild(button('Refresh', 'ghost small', async e => {
      e.currentTarget.disabled = true
      try { await refreshChatInfo() } finally { e.currentTarget.disabled = false }
    }))
    if (permissions.canInviteUsers) {
      const rotate = button(details.inviteLink ? 'New link' : 'Create link', 'ghost small', async () => {
        if (details.inviteLink && !await confirmAction('Replace invite link?', 'The current primary invite link will stop working and Telegram will create a new one.', 'Replace link')) return
        rotate.disabled = true
        try {
          const r = await request('replace-managed-invite', { chatId: chat.id })
          if (r.inviteLink) copyText(r.inviteLink, details.inviteLink ? 'New invite link copied' : 'Invite link created and copied')
          await refreshChatInfo()
        } catch (err) { toast(err.message, 'error') } finally { rotate.disabled = false }
      })
      linkRow.appendChild(rotate)
    }
    box.appendChild(linkRow)
    box.appendChild(elem('span', 'mg-help', 'Tele follows Telegram invite-link updates. Refresh forces a fresh TDLib full-info read if an external client changed the link.'))
    return box
  }

  function renderMembersSection (data) {""",
    'replace invite section'
)

sub_once(
    'public/management.js',
    r"  function renderNotificationSection \(data\) \{.*?\n  \}\n\n  function renderDangerSection \(data\) \{",
    """  function renderNotificationSection (data) {
    const { chat, details, permissions } = data
    const box = section('Notifications')
    const row = elem('div', 'mg-setting-row')
    const text = elem('div', '')
    text.append(elem('strong', '', details.muted ? 'Muted' : 'Telegram notifications on'), elem('span', 'muted', details.muted ? 'Unmute this Telegram chat.' : 'Mute this Telegram chat until you turn notifications back on.'))
    row.appendChild(text)
    const toggle = button(details.muted ? 'Unmute' : 'Mute', 'ghost', async () => {
      if (!permissions.canMute) return
      toggle.disabled = true
      try {
        await request('set-managed-muted', { chatId: chat.id, muted: !details.muted })
        await refreshChatInfo()
      } catch (e) { toast(e.message, 'error') } finally { toggle.disabled = false }
    })
    toggle.disabled = !permissions.canMute
    row.appendChild(toggle)
    box.appendChild(row)

    if (window.teleEnableDesktopNotifications) {
      const desktop = elem('div', 'mg-setting-row')
      const copy = elem('div', '')
      const supported = 'Notification' in window
      const permission = supported ? Notification.permission : 'unsupported'
      const enabled = !!(window.teleDesktopNotificationsEnabled && window.teleDesktopNotificationsEnabled())
      copy.append(
        elem('strong', '', enabled ? 'Desktop notifications enabled' : 'Desktop notifications'),
        elem('span', 'muted', supported ? `Browser permission: ${permission}. Notifications are delivered while Tele is running.` : 'This browser does not support desktop notifications.')
      )
      const controls = elem('div', 'mg-row')
      const desktopToggle = button(enabled ? 'Disable' : 'Enable', 'ghost small', async () => {
        desktopToggle.disabled = true
        try {
          if (enabled) {
            window.teleDisableDesktopNotifications()
            toastOk('Desktop notifications disabled')
          } else {
            await window.teleEnableDesktopNotifications()
            toastOk('Desktop notifications enabled — test notification sent')
          }
          refreshChatInfo()
        } catch (e) { toast(e.message, 'error') } finally { desktopToggle.disabled = false }
      })
      desktopToggle.disabled = !supported
      controls.appendChild(desktopToggle)
      if (supported && permission === 'granted' && window.teleTestDesktopNotification) {
        controls.appendChild(button('Test', 'ghost small', async () => {
          try { await window.teleTestDesktopNotification(); toastOk('Test notification sent') } catch (e) { toast(e.message, 'error') }
        }))
      }
      desktop.append(copy, controls)
      box.appendChild(desktop)
    }
    return box
  }

  function renderDangerSection (data) {""",
    'replace notification section'
)

# ---------------------------------------------------------------------------
# SERVER: keep private-user usernames, make invite reads fresh, harden clear/
# delete fallbacks, add primary invite rotation and streaming chat attachments.
# ---------------------------------------------------------------------------

sub_once(
    'server.js',
    r"    \} else if \(chat\.type && chat\.type\._ === 'chatTypeSupergroup'\) \{\n      const group = await client\.invoke\(\{ _: 'getSupergroup', supergroup_id: chat\.type\.supergroup_id \}\)\n      const names = group && group\.usernames && group\.usernames\.active_usernames\n      info\.username = names && names\.length \? names\[0\] : null\n    \}",
    "    }",
    'hide supergroup/channel usernames'
)

sub_once(
    'server.js',
    r"\nasync function checkManagedUsername \(chatId, value\) \{.*?\n\}\n\nfunction managedStatusLabel",
    "\nfunction managedStatusLabel",
    'remove unused chat username checker'
)

replace_once(
    'server.js',
    "    fullInfo = managedSupergroupFullInfoCache.get(String(type.supergroup_id)) ||\n      await client.invoke({ _: 'getSupergroupFullInfo', supergroup_id: type.supergroup_id }).catch(() => null)\n    if (fullInfo) managedSupergroupFullInfoCache.set(String(type.supergroup_id), fullInfo)",
    "    const freshFullInfo = await client.invoke({ _: 'getSupergroupFullInfo', supergroup_id: type.supergroup_id }).catch(() => null)\n    fullInfo = freshFullInfo || managedSupergroupFullInfoCache.get(String(type.supergroup_id)) || null\n    if (freshFullInfo) managedSupergroupFullInfoCache.set(String(type.supergroup_id), freshFullInfo)",
    'fresh supergroup full info'
)

replace_once(
    'server.js',
    "    fullInfo = managedBasicGroupFullInfoCache.get(String(type.basic_group_id)) ||\n      await client.invoke({ _: 'getBasicGroupFullInfo', basic_group_id: type.basic_group_id }).catch(() => null)\n    if (fullInfo) managedBasicGroupFullInfoCache.set(String(type.basic_group_id), fullInfo)",
    "    const freshFullInfo = await client.invoke({ _: 'getBasicGroupFullInfo', basic_group_id: type.basic_group_id }).catch(() => null)\n    fullInfo = freshFullInfo || managedBasicGroupFullInfoCache.get(String(type.basic_group_id)) || null\n    if (freshFullInfo) managedBasicGroupFullInfoCache.set(String(type.basic_group_id), freshFullInfo)",
    'fresh basic group full info'
)

replace_once(
    'server.js',
    "  const username = normalizeManagedUsername(payload.username)\n",
    "",
    'remove create username variable'
)

sub_once(
    'server.js',
    r"\n  const warnings = \[\]\n  if \(username\) \{.*?\n  \}\n\n  const memberUsernames",
    "\n  const warnings = []\n\n  const memberUsernames",
    'remove username application during create'
)

sub_once(
    'server.js',
    r"\n  if \(payload\.username !== undefined\) \{.*?\n  \}\n\n  const fresh = await client\.invoke",
    "\n\n  const fresh = await client.invoke",
    'remove username editing backend'
)

replace_once(
    'server.js',
    "async function deleteManagedMessage (chatId, messageId, revoke) {\n  ensureManagementReady()\n  const actions = await getManagedMessageActions(chatId, messageId)\n  const useRevoke = revoke === true\n  if (useRevoke && !actions.canDeleteAll) throw new Error('Telegram does not allow deleting this message for everyone')\n  if (!useRevoke && !actions.canDeleteSelf) throw new Error('Telegram does not allow deleting this message only for you')\n  await client.invoke({ _: 'deleteMessages', chat_id: chatId, message_ids: [messageId], revoke: useRevoke })\n  sendAll({ type: 'event', event: { name: 'message-delete', chatId, messageIds: [messageId], isPermanent: useRevoke } })\n  emitChatUpsert(chatId).catch(() => {})\n  return { ok: true, revoke: useRevoke }\n}\n",
    "async function deleteManagedMessage (chatId, messageId, revoke) {\n  ensureManagementReady()\n  const actions = await getManagedMessageActions(chatId, messageId)\n  let useRevoke = revoke === true\n  if (useRevoke && !actions.canDeleteAll && actions.canDeleteSelf) useRevoke = false\n  if (!useRevoke && !actions.canDeleteSelf && actions.canDeleteAll) useRevoke = true\n  if (useRevoke && !actions.canDeleteAll) throw new Error('Telegram does not allow deleting this message for everyone')\n  if (!useRevoke && !actions.canDeleteSelf) throw new Error('Telegram does not allow deleting this message only for you')\n  await client.invoke({ _: 'deleteMessages', chat_id: chatId, message_ids: [messageId], revoke: useRevoke })\n  sendAll({ type: 'event', event: { name: 'message-delete', chatId, messageIds: [messageId], isPermanent: useRevoke } })\n  emitChatUpsert(chatId).catch(() => {})\n  return { ok: true, revoke: useRevoke }\n}\n",
    'harden message delete mode'
)

replace_once(
    'server.js',
    "\n\n/* ------------------------------ File search ------------------------------ */",
    """

async function sendManagedAttachmentMessage (chatId, filePath, caption, replyToMessageId) {
  ensureManagementReady()
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
    input_message_content: {
      _: 'inputMessageDocument',
      document: { _: 'inputFileLocal', path: filePath },
      thumbnail: null,
      disable_content_type_detection: false,
      caption: { _: 'formattedText', text: String(caption || '').slice(0, 1024), entities: [] }
    }
  })
  emitRealtimeMessage(message).catch(() => {})
  emitChatUpsert(chatId).catch(() => {})
  return serializeRealtimeMessage(message)
}

/* ------------------------------ File search ------------------------------ */""",
    'add attachment sender'
)

replace_once(
    'server.js',
    "\n\napp.use('/dl', (req, res, next) => {",
    """

app.post('/api/chat-attachment/:chatId', async (req, res) => {
  let uploadDir = null
  try {
    ensureManagementReady()
    const chatId = Number(req.params.chatId)
    if (!Number.isSafeInteger(chatId)) return res.status(400).json({ error: 'Invalid chat id' })
    const rawName = String(req.headers['x-file-name'] || 'attachment.bin')
    let decodedName = rawName
    try { decodedName = decodeURIComponent(rawName) } catch {}
    const fileName = sanitize(decodedName) || 'attachment.bin'
    const contentLength = Number(req.headers['content-length'] || 0)
    const maxBytes = 4 * 1024 * 1024 * 1024
    if (contentLength > maxBytes) return res.status(413).json({ error: 'Attachment is larger than 4 GB' })

    uploadDir = path.join(MANAGEMENT_UPLOAD_DIR, crypto.randomUUID())
    await fs.promises.mkdir(uploadDir, { recursive: true })
    const tempPath = path.join(uploadDir, fileName)
    const handle = await fs.promises.open(tempPath, 'wx')
    let total = 0
    try {
      for await (const chunk of req) {
        total += chunk.length
        if (total > maxBytes) throw new Error('Attachment is larger than 4 GB')
        await handle.write(chunk)
      }
    } finally {
      await handle.close()
    }
    if (!total) return res.status(400).json({ error: 'Attachment is empty' })

    let caption = String(req.headers['x-caption'] || '')
    try { caption = decodeURIComponent(caption) } catch {}
    const replyHeader = req.headers['x-reply-to']
    const replyToMessageId = replyHeader ? Number(replyHeader) : null
    const message = await sendManagedAttachmentMessage(chatId, tempPath, caption, Number.isSafeInteger(replyToMessageId) ? replyToMessageId : null)
    res.json({ ok: true, message })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  } finally {
    if (uploadDir) {
      const timer = setTimeout(() => fs.promises.rm(uploadDir, { recursive: true, force: true }).catch(() => {}), 6 * 60 * 60 * 1000)
      if (timer.unref) timer.unref()
    }
  }
})

app.use('/dl', (req, res, next) => {""",
    'add streaming attachment endpoint'
)

replace_once(
    'server.js',
    "        case 'check-managed-username':\n          return respond(ws, id, true, await checkManagedUsername(payload.chatId == null ? 0 : payload.chatId, payload.username))\n",
    "",
    'remove username websocket command'
)

sub_once(
    'server.js',
    r"        case 'create-managed-invite': \{.*?\n        \}\n        case 'set-managed-muted':",
    """        case 'replace-managed-invite': {
          const info = await getManagedChatInfo(payload.chatId)
          if (!info.permissions.canInviteUsers) throw new Error('You do not have permission to manage invite links')
          const link = await client.invoke({ _: 'replacePrimaryChatInviteLink', chat_id: payload.chatId })
          if (info.internal.supergroupId) managedSupergroupFullInfoCache.delete(String(info.internal.supergroupId))
          if (info.internal.basicGroupId) managedBasicGroupFullInfoCache.delete(String(info.internal.basicGroupId))
          emitManagementRefresh(payload.chatId)
          return respond(ws, id, true, { inviteLink: link && link.invite_link })
        }
        case 'set-managed-muted':""",
    'replace invite websocket command'
)

replace_once(
    'server.js',
    "          const revoke = !!payload.revoke\n          if (revoke && !info.permissions.canClearHistoryForAll) throw new Error('Telegram does not allow deleting this history for everyone')\n          if (!revoke && !info.permissions.canClearHistoryForSelf) throw new Error('Telegram does not allow deleting this history only for you')\n          await client.invoke({ _: 'deleteChatHistory', chat_id: payload.chatId, remove_from_chat_list: false, revoke })\n          return respond(ws, id, true, { ok: true })",
    "          let revoke = !!payload.revoke\n          if (revoke && !info.permissions.canClearHistoryForAll && info.permissions.canClearHistoryForSelf) revoke = false\n          if (!revoke && !info.permissions.canClearHistoryForSelf && info.permissions.canClearHistoryForAll) revoke = true\n          if (revoke && !info.permissions.canClearHistoryForAll) throw new Error('Telegram does not allow deleting this history for everyone')\n          if (!revoke && !info.permissions.canClearHistoryForSelf) throw new Error('Telegram does not allow deleting this history only for you')\n          await client.invoke({ _: 'deleteChatHistory', chat_id: payload.chatId, remove_from_chat_list: false, revoke })\n          sendAll({ type: 'event', event: { name: 'history-cleared', chatId: payload.chatId, revoke } })\n          return respond(ws, id, true, { ok: true, revoke })",
    'harden history clear mode'
)

# ---------------------------------------------------------------------------
# RESCUE RUNTIME: attachment picker, reliable service-worker notifications,
# history-clear cache reconciliation, and composer visibility on tab changes.
# ---------------------------------------------------------------------------

replace_once(
    'public/rescue-runtime.js',
    "  rescueBaseSetView(view)\n  if (view === 'files' && state.activeChatId != null) {",
    "  rescueBaseSetView(view)\n  if (typeof rescueUpdateComposerVisibility === 'function') rescueUpdateComposerVisibility()\n  if (view === 'files' && state.activeChatId != null) {",
    'sync composer visibility'
)

replace_once(
    'public/rescue-runtime.js',
    "  if (ev && ev.name === 'message-delete') {\n    rescueRealtimeMessageDelete(ev.chatId, ev.messageIds)\n    return\n  }\n  return rescueBaseHandleEvent(ev)",
    "  if (ev && ev.name === 'message-delete') {\n    rescueRealtimeMessageDelete(ev.chatId, ev.messageIds)\n    return\n  }\n  if (ev && ev.name === 'history-cleared') {\n    const key = rescueChatKey(ev.chatId)\n    rescueChatCache.delete(key)\n    rescueFileCache.delete(key)\n    if (state.activeChatId != null && rescueChatKey(state.activeChatId) === key) {\n      state.messages = []\n      state.selection.clear()\n      state.selectedMessages.clear()\n      updateSelectionBar()\n      rescueRenderCurrent()\n      setLoadState('End of history')\n    }\n    return\n  }\n  return rescueBaseHandleEvent(ev)",
    'reconcile history clear event'
)

replace_once(
    'public/rescue-runtime.js',
    "const rescueCompose = { replyTo: null, editMessageId: null, editOriginal: '' }",
    "const rescueCompose = { replyTo: null, editMessageId: null, editOriginal: '', attachment: null }\nlet rescueNotificationRegistration = null",
    'extend compose state'
)

sub_once(
    'public/rescue-runtime.js',
    r"async function rescueEnableDesktopNotifications \(\) \{.*?\nfunction rescueDisableDesktopNotifications \(\) \{.*?\n\}\n\nfunction rescueMaybeNotifyMessage \(chatId, message\) \{.*?\n\}",
    """async function rescueNotificationServiceRegistration () {
  if (!('serviceWorker' in navigator)) return null
  if (rescueNotificationRegistration) return rescueNotificationRegistration
  const registered = await navigator.serviceWorker.register('/sw.js?v=1', { scope: '/' })
  rescueNotificationRegistration = await navigator.serviceWorker.ready.catch(() => registered)
  return rescueNotificationRegistration
}

async function rescueShowDesktopNotification (title, options = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted') throw new Error('Desktop notification permission is not granted')
  const registration = await rescueNotificationServiceRegistration().catch(() => null)
  if (registration && registration.showNotification) {
    await registration.showNotification(title, options)
    return true
  }
  const n = new Notification(title, options)
  if (options.data && options.data.chatId != null) {
    n.onclick = () => {
      window.focus()
      openChat(options.data.chatId)
      n.close()
    }
  }
  return true
}

async function rescueEnableDesktopNotifications () {
  if (!('Notification' in window)) throw new Error('Desktop notifications are not supported by this browser')
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Desktop notification permission was not granted. Allow notifications for 127.0.0.1 in the browser site settings.')
  try { localStorage.setItem(rescueNotificationPrefKey, '1') } catch {}
  await rescueNotificationServiceRegistration().catch(() => null)
  await rescueTestDesktopNotification()
  return true
}

function rescueDisableDesktopNotifications () {
  try { localStorage.setItem(rescueNotificationPrefKey, '0') } catch {}
  return true
}

async function rescueTestDesktopNotification () {
  if (!rescueDesktopNotificationsEnabled()) throw new Error('Enable desktop notifications first')
  return rescueShowDesktopNotification('Tele', {
    body: 'Notifications are working.',
    tag: `tele-test-${Date.now()}`,
    data: { test: true }
  })
}

function rescueMaybeNotifyMessage (chatId, message) {
  if (!message || message.outgoing || !rescueDesktopNotificationsEnabled()) return
  const chat = state.chats.find(c => rescueChatKey(c.id) === rescueChatKey(chatId))
  const title = chat ? chat.title : 'Telegram'
  let body = message.text || ''
  if (!body && message.media) body = `${message.sender ? message.sender + ': ' : ''}${message.media.type || 'Media'}`
  else if (message.sender && body) body = `${message.sender}: ${body}`
  body = String(body || 'New message').slice(0, 180)
  rescueShowDesktopNotification(title, {
    body,
    tag: `tele-chat-${chatId}-${message.id}`,
    data: { chatId }
  }).catch(() => {})
}""",
    'replace notification runtime'
)

sub_once(
    'public/rescue-runtime.js',
    r"  composer\.innerHTML = `\n    <div id=\"tele-compose-context\".*?</div>`\n  chat\.insertBefore\(composer, foot\)",
    """  composer.innerHTML = `
    <div id="tele-compose-context" class="tele-compose-context hidden">
      <div><strong id="tele-compose-mode"></strong><span id="tele-compose-preview"></span></div>
      <button id="tele-compose-cancel" class="ghost small" type="button">Cancel</button>
    </div>
    <div id="tele-attachment-preview" class="tele-attachment-preview hidden">
      <div><strong id="tele-attachment-name"></strong><span id="tele-attachment-meta"></span></div>
      <button id="tele-attachment-clear" class="ghost small" type="button">Remove</button>
    </div>
    <div class="tele-compose-row">
      <input id="tele-compose-file" type="file" class="hidden" />
      <button id="tele-compose-attach" class="ghost tele-compose-attach" type="button" title="Attach file" aria-label="Attach file">📎</button>
      <textarea id="tele-compose-input" rows="1" placeholder="Message" aria-label="Message"></textarea>
      <button id="tele-compose-send" type="button">Send</button>
    </div>`
  chat.insertBefore(composer, foot)""",
    'add attachment composer UI'
)

replace_once(
    'public/rescue-runtime.js',
    "  const input = document.querySelector('#tele-compose-input')\n  document.querySelector('#tele-compose-send').onclick = rescueSendComposer\n  document.querySelector('#tele-compose-cancel').onclick = rescueClearComposeContext",
    "  const input = document.querySelector('#tele-compose-input')\n  const fileInput = document.querySelector('#tele-compose-file')\n  document.querySelector('#tele-compose-send').onclick = rescueSendComposer\n  document.querySelector('#tele-compose-cancel').onclick = rescueClearComposeContext\n  document.querySelector('#tele-compose-attach').onclick = () => { if (!rescueCompose.editMessageId) fileInput.click() }\n  document.querySelector('#tele-attachment-clear').onclick = rescueClearAttachment\n  fileInput.addEventListener('change', () => rescueSetAttachment(fileInput.files && fileInput.files[0]))\n  composer.addEventListener('dragover', e => { if (state.view === 'messages' && state.activeChatId != null) e.preventDefault() })\n  composer.addEventListener('drop', e => {\n    if (state.view !== 'messages' || state.activeChatId == null || rescueCompose.editMessageId) return\n    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]\n    if (!file) return\n    e.preventDefault()\n    rescueSetAttachment(file)\n  })",
    'wire attachment picker'
)

replace_once(
    'public/rescue-runtime.js',
    "function rescueClearComposeContext () {\n  rescueCompose.replyTo = null",
    "function rescueClearAttachment () {\n  rescueCompose.attachment = null\n  const input = document.querySelector('#tele-compose-file')\n  if (input) input.value = ''\n  const preview = document.querySelector('#tele-attachment-preview')\n  if (preview) preview.classList.add('hidden')\n  const name = document.querySelector('#tele-attachment-name')\n  const meta = document.querySelector('#tele-attachment-meta')\n  if (name) name.textContent = ''\n  if (meta) meta.textContent = ''\n}\n\nfunction rescueSetAttachment (file) {\n  if (!file) return\n  if (file.size > 4 * 1024 * 1024 * 1024) { toast('Attachments larger than 4 GB are not supported', 'error'); return }\n  rescueCompose.attachment = file\n  const preview = document.querySelector('#tele-attachment-preview')\n  const name = document.querySelector('#tele-attachment-name')\n  const meta = document.querySelector('#tele-attachment-meta')\n  if (name) name.textContent = file.name\n  if (meta) meta.textContent = `${fmtSize(file.size)}${file.type ? ' · ' + file.type : ''}`\n  if (preview) preview.classList.remove('hidden')\n}\n\nfunction rescueClearComposeContext () {\n  rescueCompose.replyTo = null",
    'add attachment state helpers'
)

replace_once(
    'public/rescue-runtime.js',
    "  if (mode === 'edit') {\n    rescueCompose.editMessageId = message.id",
    "  if (mode === 'edit') {\n    rescueClearAttachment()\n    rescueCompose.editMessageId = message.id",
    'disable attachment while editing'
)

sub_once(
    'public/rescue-runtime.js',
    r"async function rescueSendComposer \(\) \{.*?\n\}\n\nasync function rescueDeleteMessage",
    """async function rescueSendComposer () {
  const input = document.querySelector('#tele-compose-input')
  const send = document.querySelector('#tele-compose-send')
  if (!input || !send || state.activeChatId == null) return
  const text = input.value.trim()
  const attachment = rescueCompose.attachment
  if (!text && !attachment) return
  if (attachment && rescueCompose.editMessageId) return toast('Finish editing before attaching a file', 'error')
  send.disabled = true
  const oldLabel = send.textContent
  send.textContent = attachment ? 'Uploading…' : 'Sending…'
  try {
    if (rescueCompose.editMessageId) {
      await request('edit-chat-message', { chatId: state.activeChatId, messageId: rescueCompose.editMessageId, text })
      toastOk('Message edited')
    } else if (attachment) {
      const headers = {
        'Content-Type': 'application/octet-stream',
        'X-File-Name': encodeURIComponent(attachment.name),
        'X-Caption': encodeURIComponent(text.slice(0, 1024))
      }
      if (rescueCompose.replyTo && rescueCompose.replyTo.id != null) headers['X-Reply-To'] = String(rescueCompose.replyTo.id)
      const response = await fetch(`/api/chat-attachment/${encodeURIComponent(state.activeChatId)}`, {
        method: 'POST',
        headers,
        body: attachment
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || `Attachment upload failed (${response.status})`)
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

async function rescueDeleteMessage""",
    'replace composer send logic'
)

replace_once(
    'public/rescue-runtime.js',
    "window.teleDisableDesktopNotifications = rescueDisableDesktopNotifications\n\nrescueMountComposer()",
    "window.teleDisableDesktopNotifications = rescueDisableDesktopNotifications\nwindow.teleTestDesktopNotification = rescueTestDesktopNotification\n\nif ('serviceWorker' in navigator) {\n  navigator.serviceWorker.addEventListener('message', event => {\n    const data = event.data || {}\n    if (data.type === 'open-chat' && data.chatId != null) openChat(data.chatId)\n  })\n  rescueNotificationServiceRegistration().catch(() => {})\n}\n\nrescueMountComposer()",
    'expose notification test and service worker messages'
)

# ---------------------------------------------------------------------------
# CSS: attachment composer surface and notification control layout.
# ---------------------------------------------------------------------------

replace_once(
    'public/management.css',
    ".tele-compose-row { display: grid; grid-template-columns: 1fr auto; align-items: end; gap: 8px; }",
    ".tele-compose-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: end; gap: 8px; }",
    'composer grid for attach button'
)

append_css = r'''

/* Chat attachment + notification service polish */
.tele-compose-attach {
  width: 40px;
  height: 40px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  border-radius: 12px;
}
.tele-attachment-preview {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: rgba(61,155,250,.08);
}
.tele-attachment-preview > div {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tele-attachment-preview strong,
.tele-attachment-preview span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tele-attachment-preview strong { font-size: 11.5px; }
.tele-attachment-preview span { color: var(--muted); font-size: 10.5px; }
.mg-setting-row > .mg-row { justify-content: flex-end; flex: 0 0 auto; }
'''
css = read('public/management.css')
if 'Chat attachment + notification service polish' not in css:
    write('public/management.css', css.rstrip() + append_css + '\n')

# ---------------------------------------------------------------------------
# Service worker: reliable desktop notification display/click handling.
# ---------------------------------------------------------------------------
write('public/sw.js', r'''self.addEventListener('install', event => { self.skipWaiting() })
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()) })
self.addEventListener('notificationclick', event => {
  const data = event.notification && event.notification.data ? event.notification.data : {}
  event.notification.close()
  if (data.test) return
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (windows.length) {
      const client = windows[0]
      if (client.focus) await client.focus()
      client.postMessage({ type: 'open-chat', chatId: data.chatId })
      return
    }
    if (self.clients.openWindow) await self.clients.openWindow('/')
  })())
})
''')

# Cache-bust the browser assets.
idx = read('public/index.html')
idx = re.sub(r'rescue-runtime\.css\?v=\d+', 'rescue-runtime.css?v=4', idx)
idx = re.sub(r'management\.css\?v=\d+', 'management.css?v=4', idx)
idx = re.sub(r'rescue-runtime\.js\?v=\d+', 'rescue-runtime.js?v=5', idx)
idx = re.sub(r'management\.js\?v=\d+', 'management.js?v=3', idx)
write('public/index.html', idx)

# Update smoke checks to match the intentionally invite-link based management UI.
smoke = read('scripts/rescue-smoke.test.cjs')
smoke = smoke.replace("assert.match(server, /checkChatUsername/, 'username availability must use TDLib')\n", "")
smoke = smoke.replace("assert.match(management, /t\\.me\\//, 'channel public addresses must use t.me link presentation')\n", "")
smoke = smoke.replace("assert.match(management, /check-managed-username/, 'creation/edit UI must validate username availability')\n", "")
extra = """
assert.match(server, /replacePrimaryChatInviteLink/, 'invite links must use primary Telegram invite-link management')
assert.match(server, /inputMessageDocument/, 'chat attachments must send through TDLib')
assert.match(server, /api\\/chat-attachment/, 'chat attachment streaming endpoint must exist')
assert.match(rescueRuntime, /tele-compose-attach/, 'chat composer must expose file attachment')
assert.match(rescueRuntime, /serviceWorker/, 'desktop notifications must use service-worker delivery when available')
assert.match(management, /Test/, 'notification settings must expose a test action')
assert.doesNotMatch(management, /check-managed-username/, 'channel/group username management must be removed from the UI')
"""
if 'chat attachments must send through TDLib' not in smoke:
    smoke = smoke.rstrip() + '\n' + extra
write('scripts/rescue-smoke.test.cjs', smoke)

print('chat/create/attachment/notification fix applied')
