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


def append_once(path, marker, text):
    src = read(path)
    if marker not in src:
        write(path, src.rstrip() + "\n\n" + text.strip() + "\n")


# ---------------------------------------------------------------------------
# SERVER: stable chat ordering, username validation, realtime message/update bus,
# and JPEG/PNG chat-photo uploads.
# ---------------------------------------------------------------------------
replace_once(
    'server.js',
    "function serializeChat (chat) {\n  const title = chat.title || 'Unknown'",
    "function mainChatOrder (chat) {\n  const positions = Array.isArray(chat && chat.positions) ? chat.positions : []\n  const main = positions.find(p => {\n    const list = p && (p.list || p.chat_list)\n    return !list || list._ === 'chatListMain'\n  })\n  return String((main && main.order) || chat.order || '0')\n}\n\nfunction compareChatOrderDesc (a, b) {\n  const aa = BigInt(String((a && a.order) || '0'))\n  const bb = BigInt(String((b && b.order) || '0'))\n  return aa === bb ? 0 : (aa < bb ? 1 : -1)\n}\n\nfunction serializeChat (chat) {\n  const title = chat.title || 'Unknown'",
    'chat order helpers',
)
replace_once(
    'server.js',
    "    order: chat.order,",
    "    order: mainChatOrder(chat),",
    'serialized main order',
)
replace_once(
    'server.js',
    "  out.sort((a, b) => (a.order < b.order ? 1 : -1))",
    "  out.sort(compareChatOrderDesc)",
    'numeric chat order sort',
)

# Realtime message serializer shared by TDLib update events.
replace_once(
    'server.js',
    "async function loadMessages (chatId, fromMessageId, limit) {",
    r"""async function serializeRealtimeMessage (m) {
  if (!m) return null
  const item = {
    id: m.id,
    date: m.date,
    text: m.content && m.content._ === 'messageText' ? (m.content.text?.text || '') : null,
    sender: await resolveSenderName(m),
    outgoing: !!m.is_outgoing,
    media: extractMedia(m)
  }
  if (item.media && item.media.file) {
    const f = item.media.file
    item.media.fileSize = f.size || f.expected_size || 0
    item.media.fileId = f.id
    if (item.media.thumb && item.media.thumb.photo && item.media.thumb.photo.id) {
      item.media.thumbUrl = null
      item.media.thumbFileId = item.media.thumb.photo.id
    }
  } else {
    item.media = null
  }
  return item
}

async function emitRealtimeMessage (message) {
  if (!message || message.chat_id == null) return
  const serialized = await serializeRealtimeMessage(message)
  if (!serialized) return
  sendAll({ type: 'event', event: { name: 'message-upsert', chatId: message.chat_id, message: serialized } })
}

async function emitChatUpsert (chatId) {
  if (chatId == null || !client) return
  const chat = await client.invoke({ _: 'getChat', chat_id: chatId }).catch(() => null)
  if (!chat) return
  sendAll({ type: 'event', event: { name: 'chat-upsert', chat: await serializeChatDetailed(chat) } })
}

function emitManagementRefresh (chatId = null) {
  sendAll({ type: 'event', event: { name: 'management-refresh', chatId } })
}

async function loadMessages (chatId, fromMessageId, limit) {""",
    'realtime message serializer',
)

# Expand TDLib update handling so visible Telegram state changes are event-driven.
sub_once(
    'server.js',
    r"  client\.on\('update', \(u\) => \{.*?\n  \}\)\n\}\n\n/\* ------------------------------ Data helpers",
    r"""  client.on('update', (u) => {
    if (u._ === 'updateAuthorizationState') {
      handleAuthState(u.authorization_state)
      return
    }
    if (u._ === 'updateFile') {
      dm.onFileUpdate(u.file)
      return
    }

    if (u._ === 'updateNewMessage') {
      emitRealtimeMessage(u.message).catch(() => {})
      emitChatUpsert(u.message && u.message.chat_id).catch(() => {})
      return
    }
    if (u._ === 'updateMessageContent' || u._ === 'updateMessageEdited') {
      client.invoke({ _: 'getMessage', chat_id: u.chat_id, message_id: u.message_id })
        .then(emitRealtimeMessage)
        .catch(() => {})
      return
    }
    if (u._ === 'updateMessageSendSucceeded') {
      if (u.old_message_id && u.message && String(u.old_message_id) !== String(u.message.id)) {
        sendAll({ type: 'event', event: { name: 'message-delete', chatId: u.message.chat_id, messageIds: [u.old_message_id] } })
      }
      emitRealtimeMessage(u.message).catch(() => {})
      emitChatUpsert(u.message && u.message.chat_id).catch(() => {})
      return
    }
    if (u._ === 'updateDeleteMessages') {
      sendAll({
        type: 'event',
        event: {
          name: 'message-delete',
          chatId: u.chat_id,
          messageIds: u.message_ids || [],
          isPermanent: !!u.is_permanent,
          fromCache: !!u.from_cache
        }
      })
      emitChatUpsert(u.chat_id).catch(() => {})
      return
    }

    if (u._ === 'updateNewChat') {
      serializeChatDetailed(u.chat).then(chat => {
        sendAll({ type: 'event', event: { name: 'chat-upsert', chat } })
      }).catch(() => {})
      return
    }

    if ([
      'updateChatTitle',
      'updateChatPhoto',
      'updateChatLastMessage',
      'updateChatReadInbox',
      'updateChatReadOutbox',
      'updateChatUnreadMentionCount',
      'updateChatUnreadReactionCount',
      'updateChatNotificationSettings',
      'updateChatDraftMessage',
      'updateChatMessageAutoDeleteTime',
      'updateChatAvailableReactions'
    ].includes(u._)) {
      emitChatUpsert(u.chat_id).catch(() => {})
      if (u._ === 'updateChatNotificationSettings' || u._ === 'updateChatMessageAutoDeleteTime') emitManagementRefresh(u.chat_id)
      return
    }

    if (u._ === 'updateChatPosition') {
      const pos = u.position || {}
      const list = pos.list || pos.chat_list
      const isMain = !list || list._ === 'chatListMain'
      if (isMain && String(pos.order || '0') === '0') {
        sendAll({ type: 'event', event: { name: 'chat-remove', chatId: u.chat_id } })
      } else {
        emitChatUpsert(u.chat_id).catch(() => {})
      }
      return
    }

    if (u._ === 'updateChatMember') {
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
    }
  })
}

/* ------------------------------ Data helpers""",
    'expanded TDLib update handler',
)

# Username availability is checked by TDLib itself, including public-chat limits.
replace_once(
    'server.js',
    "function managedStatusLabel (status) {",
    r"""async function checkManagedUsername (chatId, value) {
  ensureManagementReady()
  const username = normalizeManagedUsername(value)
  if (!username) return { username, available: false, state: 'invalid', message: 'Enter a username' }
  const result = await client.invoke({
    _: 'checkChatUsername',
    chat_id: chatId == null ? 0 : chatId,
    username
  })
  const type = result && result._
  const messages = {
    checkChatUsernameResultOk: 'Available',
    checkChatUsernameResultUsernameInvalid: 'Username format is invalid',
    checkChatUsernameResultUsernameOccupied: 'Already taken',
    checkChatUsernameResultPublicChatsTooMany: 'Your account has reached the public chat limit',
    checkChatUsernameResultPublicGroupsUnavailable: 'Public groups are unavailable for this account',
    checkChatUsernameResultUsernamePurchasable: 'This username is purchasable on Fragment'
  }
  return {
    username,
    available: type === 'checkChatUsernameResultOk',
    state: type || 'unknown',
    message: messages[type] || 'Telegram rejected this username'
  }
}

function managedStatusLabel (status) {""",
    'username availability helper',
)

replace_once(
    'server.js',
    "  const warnings = []\n  if (username) {",
    "  const warnings = []\n  if (username) {\n    const availability = await checkManagedUsername(0, username)\n    if (!availability.available) throw new Error(availability.message)\n",
    'validate creation username',
)

replace_once(
    'server.js',
    "    const username = normalizeManagedUsername(payload.username)\n    await client.invoke({ _: 'setSupergroupUsername', supergroup_id: info.internal.supergroupId, username })",
    "    const username = normalizeManagedUsername(payload.username)\n    if (username && username !== (info.chat.username || '')) {\n      const availability = await checkManagedUsername(chatId, username)\n      if (!availability.available) throw new Error(availability.message)\n    }\n    await client.invoke({ _: 'setSupergroupUsername', supergroup_id: info.internal.supergroupId, username })",
    'validate edited username',
)

replace_once(
    'server.js',
    "        case 'get-chat-management':\n          return respond(ws, id, true, await getManagedChatInfo(payload.chatId))",
    "        case 'get-chat-management':\n          return respond(ws, id, true, await getManagedChatInfo(payload.chatId))\n        case 'check-managed-username':\n          return respond(ws, id, true, await checkManagedUsername(payload.chatId == null ? 0 : payload.chatId, payload.username))",
    'username websocket command',
)

# JPEG and PNG upload support with basic signature validation.
sub_once(
    'server.js',
    r"    const name = String\(req\.headers\['x-file-name'\] \|\| 'photo\.jpg'\).*?    tempPath = path\.join\(MANAGEMENT_UPLOAD_DIR, `\$\{crypto\.randomUUID\(\)\}\.jpg`\)",
    r"""    const name = String(req.headers['x-file-name'] || 'photo.jpg')
    const lower = name.toLowerCase()
    const extension = lower.endsWith('.png') ? '.png' : (/\.jpe?g$/.test(lower) ? '.jpg' : null)
    if (!extension) return res.status(400).json({ error: 'Chat photos must be PNG or JPEG' })
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'No image uploaded' })
    const isPng = req.body.length >= 8 && req.body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const isJpeg = req.body.length >= 3 && req.body[0] === 0xff && req.body[1] === 0xd8 && req.body[2] === 0xff
    if ((extension === '.png' && !isPng) || (extension === '.jpg' && !isJpeg)) {
      return res.status(400).json({ error: 'The uploaded file does not match its PNG/JPEG format' })
    }
    tempPath = path.join(MANAGEMENT_UPLOAD_DIR, `${crypto.randomUUID()}${extension}`)""",
    'PNG/JPEG photo upload',
)

# ---------------------------------------------------------------------------
# RESCUE RUNTIME: realtime message cache/file updates + recent-first chat order.
# ---------------------------------------------------------------------------
replace_once(
    'public/rescue-runtime.js',
    "renderChats = function rescueRenderChats () {\n  const list = $('#chat-list')",
    r"""function rescueSortChatsRecentFirst () {
  state.chats.sort((a, b) => {
    const aa = BigInt(String((a && a.order) || '0'))
    const bb = BigInt(String((b && b.order) || '0'))
    if (aa !== bb) return aa < bb ? 1 : -1
    return String(a && a.title || '').localeCompare(String(b && b.title || ''))
  })
}

renderChats = function rescueRenderChats () {
  rescueSortChatsRecentFirst()
  const list = $('#chat-list')""",
    'recent-first chat render',
)
replace_once(
    'public/rescue-runtime.js',
    "    state.chats = (data.chats || []).map(c => ({ ...previousById.get(rescueChatKey(c.id)), ...c }))\n    state.chats.forEach(c => {",
    "    state.chats = (data.chats || []).map(c => ({ ...previousById.get(rescueChatKey(c.id)), ...c }))\n    rescueSortChatsRecentFirst()\n    state.chats.forEach(c => {",
    'recent-first loaded chats',
)

append_once(
    'public/rescue-runtime.js',
    'function rescueRealtimeMessageUpsert',
    r"""
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
""",
)

# ---------------------------------------------------------------------------
# MANAGEMENT UI: live username availability, channel-link semantics, polished
# PNG/JPEG image picker, and realtime info refresh.
# ---------------------------------------------------------------------------
replace_once(
    'public/management.js',
    "    memberLoading: false\n  }",
    "    memberLoading: false,\n    usernameCheckSeq: 0,\n    usernameCheck: null,\n    photoPreviewUrl: null\n  }",
    'management UI state',
)

replace_once(
    'public/management.js',
    "  function parseMemberUsernames (value) {",
    r"""  function usernamePresentation (kind) {
    return kind === 'channel'
      ? { label: 'Public link', prefix: 't.me/', placeholder: 'channelname' }
      : { label: 'Public username', prefix: '@', placeholder: 'groupname' }
  }

  function setUsernameStatus (node, state, message) {
    if (!node) return
    node.className = `mg-username-status ${state || 'idle'}`
    node.textContent = message || ''
  }

  async function checkUsernameAvailability (username, chatId, statusNode) {
    const value = normalizeUsername(username)
    const seq = ++ui.usernameCheckSeq
    if (!value) {
      ui.usernameCheck = { username: value, available: false, state: 'idle', message: 'Enter a username to check availability.' }
      setUsernameStatus(statusNode, 'idle', ui.usernameCheck.message)
      return ui.usernameCheck
    }
    if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(value)) {
      ui.usernameCheck = { username: value, available: false, state: 'invalid', message: 'Use 4–32 letters, numbers or underscores; start with a letter.' }
      setUsernameStatus(statusNode, 'invalid', ui.usernameCheck.message)
      return ui.usernameCheck
    }
    setUsernameStatus(statusNode, 'checking', 'Checking with Telegram…')
    try {
      const result = await request('check-managed-username', { username: value, chatId: chatId == null ? 0 : chatId })
      if (seq !== ui.usernameCheckSeq) return result
      ui.usernameCheck = result
      setUsernameStatus(statusNode, result.available ? 'available' : 'unavailable', result.message)
      return result
    } catch (e) {
      if (seq !== ui.usernameCheckSeq) return { available: false, message: e.message }
      ui.usernameCheck = { username: value, available: false, state: 'error', message: e.message }
      setUsernameStatus(statusNode, 'unavailable', e.message)
      return ui.usernameCheck
    }
  }

  function parseMemberUsernames (value) {""",
    'username UI helpers',
)

sub_once(
    'public/management.js',
    r"  function validateCreateStep \(\) \{.*?\n  \}\n\n  async function onCreateNext \(\) \{.*?\n  \}",
    r"""  async function validateCreateStep () {
    captureCreateStep()
    const draft = ui.createDraft
    if (ui.createStep === 2) {
      if (!draft.title || draft.title.length > 128) {
        toast('Title must be 1–128 characters', 'error')
        return false
      }
      if (draft.description.length > 255) {
        toast('Description must be at most 255 characters', 'error')
        return false
      }
    }
    if (ui.createStep === 3 && draft.visibility === 'public') {
      if (!draft.username || !/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(draft.username)) {
        toast('Enter a valid public username/link', 'error')
        return false
      }
      const check = ui.usernameCheck && ui.usernameCheck.username === draft.username
        ? ui.usernameCheck
        : await checkUsernameAvailability(draft.username, 0, document.querySelector('#mg-create-username-status'))
      if (!check || !check.available) {
        toast((check && check.message) || 'That username is not available', 'error')
        return false
      }
    }
    return true
  }

  async function onCreateNext () {
    const next = document.querySelector('#mg-create-next')
    if (next) next.disabled = true
    try {
      if (!await validateCreateStep()) return
      if (ui.createStep < 4) {
        ui.createStep++
        renderCreateWizard()
        return
      }
      await createManagedChat()
    } finally {
      if (next && ui.createStep !== 4) next.disabled = false
    }
  }""",
    'async creation validation',
)

sub_once(
    'public/management.js',
    r"  function renderCreateAccess \(body\) \{.*?\n  \}\n\n  function renderCreateReview",
    r"""  function renderCreateAccess (body) {
    const presentation = usernamePresentation(ui.createDraft.type)
    body.appendChild(elem('p', 'mg-step-copy', ui.createDraft.type === 'channel'
      ? 'Private channels use an invite link. Public channels get a shareable t.me link.'
      : 'Private groups use invite links. Public groups expose a Telegram @username.'))
    const visibility = elem('div', 'mg-segmented')
    for (const [value, label] of [['private', 'Private'], ['public', 'Public']]) {
      const b = button(label, ui.createDraft.visibility === value ? 'active' : '', () => {
        captureCreateStep()
        ui.createDraft.visibility = value
        ui.usernameCheck = null
        if (value === 'private') ui.createDraft.username = ''
        renderCreateWizard()
      })
      visibility.appendChild(b)
    }
    body.appendChild(labelled('Visibility', visibility))

    if (ui.createDraft.visibility === 'public') {
      const username = textInput(ui.createDraft.username, presentation.placeholder)
      username.id = 'mg-create-username'
      const prefix = elem('div', 'mg-username-field')
      prefix.append(elem('span', 'mg-username-prefix', presentation.prefix), username)
      const field = labelled(presentation.label, prefix)
      const status = elem('div', 'mg-username-status idle', 'Enter a username to check availability.')
      status.id = 'mg-create-username-status'
      field.appendChild(status)
      body.appendChild(field)

      let timer = null
      username.addEventListener('input', () => {
        ui.createDraft.username = normalizeUsername(username.value)
        ui.usernameCheck = null
        clearTimeout(timer)
        setUsernameStatus(status, 'checking', ui.createDraft.username ? 'Waiting to check…' : 'Enter a username to check availability.')
        timer = setTimeout(() => checkUsernameAvailability(ui.createDraft.username, 0, status), 320)
      })
      if (ui.createDraft.username) setTimeout(() => checkUsernameAvailability(ui.createDraft.username, 0, status), 0)
    }

    const members = textarea(ui.createDraft.members, '@alice, @bob (optional)')
    members.id = 'mg-create-members'
    members.rows = 3
    body.appendChild(labelled('Initial members by @username', members))
    body.appendChild(elem('span', 'mg-help', 'Up to 20 usernames. Telegram privacy restrictions may prevent some users from being added.'))
  }

  function renderCreateReview""",
    'channel link/group username creation UI',
)

replace_once(
    'public/management.js',
    "      ['Visibility', d.visibility === 'public' ? `Public · @${d.username}` : 'Private'],",
    "      ['Visibility', d.visibility === 'public' ? (d.type === 'channel' ? `Public · t.me/${d.username}` : `Public · @${d.username}`) : 'Private'],",
    'review link presentation',
)

replace_once(
    'public/management.js',
    "    titleBox.append(elem('h3', '', chat.title), elem('span', 'muted', chat.username ? `@${chat.username}` : formatKind(chat.kind)))",
    "    titleBox.append(elem('h3', '', chat.title), elem('span', 'muted', chat.username ? (chat.kind === 'channel' ? `t.me/${chat.username}` : `@${chat.username}`) : formatKind(chat.kind)))",
    'chat info public identity',
)

# Public link/username edit field with live availability state.
replace_once(
    'public/management.js',
    "    let username = null\n    if (permissions.canEditUsername) {\n      username = textInput(chat.username || '', 'username or blank for private')\n      const prefix = elem('div', 'mg-username-field')\n      prefix.append(elem('span', '', '@'), username)\n      box.appendChild(labelled('Public username', prefix))\n    }",
    r"""    let username = null
    let usernameStatus = null
    if (permissions.canEditUsername) {
      const presentation = usernamePresentation(chat.kind)
      username = textInput(chat.username || '', presentation.placeholder)
      const prefix = elem('div', 'mg-username-field')
      prefix.append(elem('span', 'mg-username-prefix', presentation.prefix), username)
      const field = labelled(presentation.label, prefix)
      usernameStatus = elem('div', 'mg-username-status idle', chat.username ? 'Current public address' : 'Leave blank to keep this chat private.')
      field.appendChild(usernameStatus)
      box.appendChild(field)
      let usernameTimer = null
      username.addEventListener('input', () => {
        clearTimeout(usernameTimer)
        const nextValue = normalizeUsername(username.value)
        if (!nextValue) {
          ui.usernameCheck = null
          setUsernameStatus(usernameStatus, 'idle', 'Blank makes the chat private when Telegram permits it.')
          return
        }
        if (nextValue === (chat.username || '')) {
          ui.usernameCheck = { username: nextValue, available: true, state: 'current', message: 'Current public address' }
          setUsernameStatus(usernameStatus, 'available', 'Current public address')
          return
        }
        ui.usernameCheck = null
        usernameTimer = setTimeout(() => checkUsernameAvailability(nextValue, chat.id, usernameStatus), 320)
      })
    }""",
    'editable link availability UI',
)

replace_once(
    'public/management.js',
    "      try {\n        await request('update-managed-chat', {",
    r"""      try {
        if (username) {
          const nextUsername = normalizeUsername(username.value)
          if (nextUsername && nextUsername !== (chat.username || '')) {
            const check = ui.usernameCheck && ui.usernameCheck.username === nextUsername
              ? ui.usernameCheck
              : await checkUsernameAvailability(nextUsername, chat.id, usernameStatus)
            if (!check || !check.available) throw new Error((check && check.message) || 'That public address is not available')
          }
        }
        await request('update-managed-chat', {""",
    'validate before saving public address',
)

# Replace the native file-input row with a preview/drop area; preserve permission gating.
sub_once(
    'public/management.js',
    r"    if \(permissions\.canSetPhoto\) \{\n      const photoTools = elem\('div', 'mg-photo-tools'\).*?\n      box\.appendChild\(labelled\('Chat photo', photoTools\)\)\n    \}",
    r"""    if (permissions.canSetPhoto) {
      const photoCard = elem('div', 'mg-photo-card')
      const drop = elem('div', 'mg-photo-drop')
      const preview = elem('div', 'mg-photo-preview', '🖼')
      const copy = elem('div', 'mg-photo-copy')
      const photoTitle = elem('strong', '', 'PNG or JPEG')
      const photoHint = elem('span', 'muted', 'Drop an image here or choose a file. Max 10 MB.')
      copy.append(photoTitle, photoHint)
      drop.append(preview, copy)

      const file = elem('input', 'mg-file-input-hidden')
      file.type = 'file'
      file.accept = '.jpg,.jpeg,.png,image/jpeg,image/png'
      const controls = elem('div', 'mg-photo-actions')
      const choose = button('Choose image', 'ghost', () => file.click())
      const upload = button('Upload photo', '', async () => {
        const selected = file.files && file.files[0]
        if (!selected) return toast('Choose a PNG or JPEG image first', 'error')
        if (selected.size > 10 * 1024 * 1024) return toast('Image must be 10 MB or smaller', 'error')
        upload.disabled = true
        upload.textContent = 'Uploading…'
        try {
          const res = await fetch(`/api/chat-photo/${encodeURIComponent(chat.id)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': selected.name },
            body: selected
          })
          const json = await res.json()
          if (!res.ok) throw new Error(json.error || 'Photo update failed')
          toastOk('Chat photo updated')
          await loadChats().catch(() => {})
          await refreshChatInfo()
        } catch (e) { toast(e.message, 'error') } finally {
          upload.disabled = false
          upload.textContent = 'Upload photo'
        }
      })
      const remove = button('Remove', 'ghost danger-outline', async () => {
        if (!await confirmAction('Remove chat photo?', 'The current chat photo will be removed.', 'Remove')) return
        try {
          await request('remove-managed-photo', { chatId: chat.id })
          toastOk('Chat photo removed')
          await loadChats().catch(() => {})
          await refreshChatInfo()
        } catch (e) { toast(e.message, 'error') }
      })
      controls.append(choose, upload, remove)
      photoCard.append(drop, file, controls)

      const applyFile = selected => {
        if (!selected) return
        const valid = /\.(png|jpe?g)$/i.test(selected.name) || /^image\/(png|jpeg)$/i.test(selected.type || '')
        if (!valid) {
          toast('Choose a PNG or JPEG image', 'error')
          file.value = ''
          return
        }
        const dt = new DataTransfer()
        dt.items.add(selected)
        file.files = dt.files
        if (ui.photoPreviewUrl) URL.revokeObjectURL(ui.photoPreviewUrl)
        ui.photoPreviewUrl = URL.createObjectURL(selected)
        preview.textContent = ''
        const image = elem('img', '')
        image.src = ui.photoPreviewUrl
        image.alt = ''
        preview.appendChild(image)
        photoTitle.textContent = selected.name
        photoHint.textContent = `${Math.max(1, Math.round(selected.size / 1024))} KB · ready to upload`
      }
      file.addEventListener('change', () => applyFile(file.files && file.files[0]))
      drop.addEventListener('click', () => file.click())
      drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragging') })
      drop.addEventListener('dragleave', () => drop.classList.remove('dragging'))
      drop.addEventListener('drop', e => {
        e.preventDefault()
        drop.classList.remove('dragging')
        applyFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0])
      })
      box.appendChild(labelled('Chat photo', photoCard))
    }""",
    'polished PNG/JPEG photo picker',
)

# Realtime management detail refresh when TDLib reports member/profile/settings changes.
replace_once(
    'public/management.js',
    "  mountDrawer()\n  mountEntryPoints()\n  wrapExistingRuntime()",
    r"""  const managementBaseHandleEvent = handleEvent
  handleEvent = function managementRealtimeHandleEvent (ev) {
    if (ev && ev.name === 'management-refresh') {
      if (ui.drawerMode === 'info' && state.activeChatId != null && (ev.chatId == null || String(ev.chatId) === String(state.activeChatId))) {
        setTimeout(refreshChatInfo, 80)
      }
      return
    }
    return managementBaseHandleEvent(ev)
  }

  mountDrawer()
  mountEntryPoints()
  wrapExistingRuntime()""",
    'realtime chat info refresh',
)

# ---------------------------------------------------------------------------
# CSS: image upload card and username availability feedback.
# ---------------------------------------------------------------------------
append_once(
    'public/management.css',
    '.mg-username-status.available',
    r"""
/* Realtime management polish */
.mg-username-prefix {
  flex: 0 0 auto;
  color: var(--muted);
  padding-left: 10px;
  font-size: 12px;
  white-space: nowrap;
}
.mg-username-status {
  min-height: 16px;
  font-size: 10.5px;
  line-height: 1.35;
  padding-inline: 2px;
}
.mg-username-status.idle { color: var(--muted); }
.mg-username-status.checking { color: var(--accent); }
.mg-username-status.available { color: var(--ok); }
.mg-username-status.unavailable,
.mg-username-status.invalid { color: #ff8389; }

.mg-photo-card {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.mg-photo-drop {
  min-height: 104px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px dashed #49617e;
  border-radius: 12px;
  background: linear-gradient(135deg, rgba(61,155,250,.08), rgba(255,255,255,.018));
  cursor: pointer;
  transition: border-color .15s, background .15s, transform .15s;
}
.mg-photo-drop:hover,
.mg-photo-drop.dragging {
  border-color: var(--accent);
  background: rgba(61,155,250,.12);
}
.mg-photo-drop.dragging { transform: scale(.995); }
.mg-photo-preview {
  width: 70px;
  height: 70px;
  flex: 0 0 70px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  overflow: hidden;
  background: var(--panel3);
  border: 1px solid var(--border);
  font-size: 24px;
}
.mg-photo-preview img { width: 100%; height: 100%; object-fit: cover; display: block; }
.mg-photo-copy { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.mg-photo-copy strong,
.mg-photo-copy span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mg-photo-copy strong { font-size: 12px; }
.mg-photo-copy span { font-size: 10.5px; }
.mg-photo-actions { display: grid; grid-template-columns: 1fr 1fr auto; gap: 7px; }
.mg-file-input-hidden { display: none; }

@media (max-width: 1100px) {
  .mg-photo-actions { grid-template-columns: 1fr 1fr; }
  .mg-photo-actions .danger-outline { grid-column: 1 / -1; }
}
""",
)

# Cache-bust the changed browser assets.
replace_once('public/index.html', 'rescue-runtime.css?v=2', 'rescue-runtime.css?v=3', 'rescue css cache bust')
replace_once('public/index.html', 'management.css?v=1', 'management.css?v=2', 'management css cache bust')
replace_once('public/index.html', 'rescue-runtime.js?v=2', 'rescue-runtime.js?v=3', 'rescue js cache bust')
replace_once('public/index.html', 'management.js?v=1', 'management.js?v=2', 'management js cache bust')

# Strengthen smoke coverage around the new behavior.
append_once(
    'scripts/rescue-smoke.test.cjs',
    'username availability must use TDLib',
    r"""
const rescueRuntime = fs.readFileSync('public/rescue-runtime.js', 'utf8')
const managementCss = fs.readFileSync('public/management.css', 'utf8')
assert.match(server, /checkChatUsername/, 'username availability must use TDLib')
assert.match(server, /updateNewMessage/, 'new Telegram messages must be pushed in realtime')
assert.match(server, /updateDeleteMessages/, 'message deletions must be pushed in realtime')
assert.match(server, /message-upsert/, 'server must publish realtime message upserts')
assert.match(server, /message-delete/, 'server must publish realtime message deletions')
assert.match(server, /\.png/, 'chat photo endpoint must support PNG')
assert.match(rescueRuntime, /rescueRealtimeMessageUpsert/, 'client must merge realtime messages into cache')
assert.match(rescueRuntime, /rescueSortChatsRecentFirst/, 'chat list must enforce recent-first order')
assert.match(management, /t\.me\//, 'channel public addresses must use t.me link presentation')
assert.match(management, /check-managed-username/, 'creation/edit UI must validate username availability')
assert.match(management, /image\/png/, 'chat photo UI must accept PNG')
assert.match(managementCss, /mg-photo-drop/, 'chat photo UI must use the polished upload surface')
""",
)

print('Realtime and management polish applied')
