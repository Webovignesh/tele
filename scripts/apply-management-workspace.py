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


# ---------------------------------------------------------------------------
# Runtime paths for temporary chat-photo uploads.
# ---------------------------------------------------------------------------
replace_once(
    'server.js',
    "const FILES_DIR = path.join(ROOT, '.td_files')\n",
    "const FILES_DIR = path.join(ROOT, '.td_files')\nconst MANAGEMENT_UPLOAD_DIR = path.join(ROOT, '.management_uploads')\n",
    'management upload dir constant',
)
replace_once(
    'server.js',
    "fs.mkdirSync(thumbsDir, { recursive: true })\n",
    "fs.mkdirSync(thumbsDir, { recursive: true })\nfs.mkdirSync(MANAGEMENT_UPLOAD_DIR, { recursive: true })\n",
    'management upload dir mkdir',
)

# ---------------------------------------------------------------------------
# Telegram management helpers.
# ---------------------------------------------------------------------------
management_helpers = r'''

/* ------------------------------ Telegram management ------------------------------ */

function ensureManagementReady () {
  if (!client || !ready) throw new Error('Telegram session is not ready')
}

function normalizeManagedUsername (value) {
  return String(value || '').trim().replace(/^@/, '')
}

function managedStatusLabel (status) {
  if (!status || !status._) return 'Member'
  return ({
    chatMemberStatusCreator: 'Owner',
    chatMemberStatusAdministrator: 'Administrator',
    chatMemberStatusMember: 'Member',
    chatMemberStatusRestricted: 'Restricted',
    chatMemberStatusLeft: 'Left',
    chatMemberStatusBanned: 'Banned'
  })[status._] || 'Member'
}

function managedPermissions (status, chat, kind, isSavedMessages, canGetMembers) {
  const owner = status && status._ === 'chatMemberStatusCreator'
  const administrator = status && status._ === 'chatMemberStatusAdministrator'
  const rights = (status && status.rights) || {}
  const adminFallback = administrator && Object.keys(rights).length === 0
  return {
    isOwner: !!owner,
    isAdministrator: !!(owner || administrator),
    canChangeInfo: !!(owner || rights.can_change_info || adminFallback),
    canInviteUsers: !!(owner || rights.can_invite_users || adminFallback),
    canRestrictMembers: !!(owner || rights.can_restrict_members || adminFallback),
    canDeleteForAll: !!chat.can_be_deleted_for_all_users,
    canClearHistory: !!(chat.can_be_deleted_only_for_self || chat.can_be_deleted_for_all_users),
    canLeave: kind !== 'private' && kind !== 'secret',
    canEditUsername: !!(owner && (kind === 'channel' || kind === 'supergroup')),
    canGetMembers: !!canGetMembers,
    canSetPhoto: !!((owner || rights.can_change_info || adminFallback) && kind !== 'private'),
    canMute: !isSavedMessages
  }
}

async function getManagedChatInfo (chatId) {
  ensureManagementReady()
  const chat = await client.invoke({ _: 'getChat', chat_id: chatId })
  const serialized = await serializeChatDetailed(chat)
  const type = chat.type || {}
  let status = null
  let fullInfo = null
  let groupInfo = null
  let canGetMembers = false

  if (type._ === 'chatTypeSupergroup') {
    groupInfo = await client.invoke({ _: 'getSupergroup', supergroup_id: type.supergroup_id }).catch(() => null)
    status = groupInfo && groupInfo.status
    fullInfo = await client.invoke({ _: 'getSupergroupFullInfo', supergroup_id: type.supergroup_id }).catch(() => null)
    canGetMembers = !!(fullInfo && fullInfo.can_get_members)
    if (!serialized.username && groupInfo && groupInfo.usernames && groupInfo.usernames.active_usernames && groupInfo.usernames.active_usernames.length) {
      serialized.username = groupInfo.usernames.active_usernames[0]
    }
  } else if (type._ === 'chatTypeBasicGroup') {
    groupInfo = await client.invoke({ _: 'getBasicGroup', basic_group_id: type.basic_group_id }).catch(() => null)
    status = groupInfo && groupInfo.status
    fullInfo = await client.invoke({ _: 'getBasicGroupFullInfo', basic_group_id: type.basic_group_id }).catch(() => null)
    canGetMembers = !!fullInfo
  }

  const me = await client.invoke({ _: 'getMe' }).catch(() => null)
  const isSavedMessages = !!(me && type._ === 'chatTypePrivate' && String(type.user_id) === String(me.id))
  const memberCount = type._ === 'chatTypeBasicGroup'
    ? (fullInfo && Array.isArray(fullInfo.members) ? fullInfo.members.length : (groupInfo && groupInfo.member_count) || null)
    : (fullInfo && fullInfo.member_count) || (groupInfo && groupInfo.member_count) || (type._ === 'chatTypePrivate' ? 2 : null)
  const inviteLink = fullInfo && fullInfo.invite_link && fullInfo.invite_link.invite_link
  const notification = chat.notification_settings || {}
  const muted = notification.use_default_mute_for === false && Number(notification.mute_for || 0) > 0
  const permissions = managedPermissions(status, chat, serialized.kind, isSavedMessages, canGetMembers)

  return {
    chat: {
      ...serialized,
      messageAutoDeleteTime: Number(chat.message_auto_delete_time || 0)
    },
    details: {
      description: (fullInfo && fullInfo.description) || '',
      memberCount,
      administratorCount: (fullInfo && fullInfo.administrator_count) || null,
      inviteLink: inviteLink || null,
      statusLabel: managedStatusLabel(status),
      muted,
      autoDeleteTime: Number(chat.message_auto_delete_time || 0)
    },
    permissions,
    internal: {
      supergroupId: type._ === 'chatTypeSupergroup' ? type.supergroup_id : null,
      basicGroupId: type._ === 'chatTypeBasicGroup' ? type.basic_group_id : null
    }
  }
}

async function resolveManagedUserByUsername (value) {
  ensureManagementReady()
  const username = normalizeManagedUsername(value)
  if (!username) throw new Error('Username is required')
  const chat = await client.invoke({ _: 'searchPublicChat', username }).catch(() => null)
  if (!chat || !chat.type || chat.type._ !== 'chatTypePrivate' || !chat.type.user_id) {
    throw new Error(`@${username} is not a public user account`)
  }
  return { username, userId: chat.type.user_id }
}

async function createManagedChat (payload) {
  ensureManagementReady()
  const type = payload.type === 'group' ? 'group' : 'channel'
  const title = String(payload.title || '').trim()
  const description = String(payload.description || '').trim()
  const username = normalizeManagedUsername(payload.username)
  const autoDeleteTime = Number(payload.autoDeleteTime || 0)
  if (!title || title.length > 128) throw new Error('Title must be 1-128 characters')
  if (description.length > 255) throw new Error('Description must be at most 255 characters')
  if (autoDeleteTime < 0 || autoDeleteTime > 365 * 86400 || autoDeleteTime % 86400 !== 0) throw new Error('Invalid auto-delete value')

  const chat = await client.invoke({
    _: 'createNewSupergroupChat',
    title,
    is_forum: type === 'group' && !!payload.forum,
    is_channel: type === 'channel',
    description,
    location: null,
    message_auto_delete_time: autoDeleteTime,
    for_import: false
  })

  const warnings = []
  if (username) {
    try {
      await client.invoke({ _: 'setSupergroupUsername', supergroup_id: chat.type.supergroup_id, username })
    } catch (e) {
      warnings.push(`Created chat, but @${username} could not be set: ${String(e.message || e)}`)
    }
  }

  const memberUsernames = [...new Set((payload.memberUsernames || []).map(normalizeManagedUsername).filter(Boolean))].slice(0, 20)
  if (memberUsernames.length) {
    const userIds = []
    for (const memberUsername of memberUsernames) {
      try {
        const member = await resolveManagedUserByUsername(memberUsername)
        userIds.push(member.userId)
      } catch (e) {
        warnings.push(String(e.message || e))
      }
    }
    if (userIds.length) {
      try {
        const added = await client.invoke({ _: 'addChatMembers', chat_id: chat.id, user_ids: userIds })
        const failed = added && added.failed_to_add_members
        if (Array.isArray(failed) && failed.length) warnings.push(`${failed.length} member(s) could not be added`)
      } catch (e) {
        warnings.push(`Some members could not be added: ${String(e.message || e)}`)
      }
    }
  }

  const fresh = await client.invoke({ _: 'getChat', chat_id: chat.id }).catch(() => chat)
  const serialized = await serializeChatDetailed(fresh)
  sendAll({ type: 'event', event: { name: 'chat-upsert', chat: serialized } })
  return { chat: serialized, warnings }
}

async function updateManagedChat (payload) {
  const info = await getManagedChatInfo(payload.chatId)
  const chatId = payload.chatId
  const title = payload.title == null ? null : String(payload.title).trim()
  const description = payload.description == null ? null : String(payload.description).trim()

  if ((title != null || description != null || payload.autoDeleteTime != null) && !info.permissions.canChangeInfo) {
    throw new Error('Telegram does not allow you to change this chat information')
  }
  if (title != null) {
    if (!title || title.length > 128) throw new Error('Title must be 1-128 characters')
    if (title !== info.chat.title) await client.invoke({ _: 'setChatTitle', chat_id: chatId, title })
  }
  if (description != null) {
    if (description.length > 255) throw new Error('Description must be at most 255 characters')
    if (description !== info.details.description) await client.invoke({ _: 'setChatDescription', chat_id: chatId, description })
  }
  if (payload.autoDeleteTime != null) {
    const autoDeleteTime = Number(payload.autoDeleteTime || 0)
    if (autoDeleteTime < 0 || autoDeleteTime > 365 * 86400 || autoDeleteTime % 86400 !== 0) throw new Error('Invalid auto-delete value')
    if (autoDeleteTime !== info.details.autoDeleteTime) {
      await client.invoke({ _: 'setChatMessageAutoDeleteTime', chat_id: chatId, message_auto_delete_time: autoDeleteTime })
    }
  }
  if (payload.username !== undefined) {
    if (!info.permissions.canEditUsername || !info.internal.supergroupId) throw new Error('Only the owner can change the public username')
    const username = normalizeManagedUsername(payload.username)
    await client.invoke({ _: 'setSupergroupUsername', supergroup_id: info.internal.supergroupId, username })
  }

  const fresh = await client.invoke({ _: 'getChat', chat_id: chatId })
  const serialized = await serializeChatDetailed(fresh)
  sendAll({ type: 'event', event: { name: 'chat-upsert', chat: serialized } })
  return getManagedChatInfo(chatId)
}

async function managedMembers (chatId, limit) {
  const info = await getManagedChatInfo(chatId)
  if (!info.permissions.canGetMembers) throw new Error('Telegram does not allow the member list to be viewed')
  const max = Math.max(1, Math.min(100, Number(limit) || 100))
  let members = []
  let totalCount = 0

  if (info.internal.supergroupId) {
    const result = await client.invoke({
      _: 'getSupergroupMembers',
      supergroup_id: info.internal.supergroupId,
      filter: null,
      offset: 0,
      limit: max
    })
    members = result.members || []
    totalCount = result.total_count || members.length
  } else if (info.internal.basicGroupId) {
    const full = await client.invoke({ _: 'getBasicGroupFullInfo', basic_group_id: info.internal.basicGroupId })
    members = (full.members || []).slice(0, max)
    totalCount = (full.members || []).length
  }

  const me = await client.invoke({ _: 'getMe' }).catch(() => null)
  const out = []
  for (const member of members) {
    const sender = member.member_id || {}
    if (sender._ === 'messageSenderUser' && sender.user_id) {
      const user = await client.invoke({ _: 'getUser', user_id: sender.user_id }).catch(() => null)
      const usernames = user && user.usernames && user.usernames.active_usernames
      out.push({
        userId: sender.user_id,
        name: user ? ([user.first_name, user.last_name].filter(Boolean).join(' ') || 'User') : 'User',
        username: user ? ((usernames && usernames[0]) || user.username || null) : null,
        statusLabel: managedStatusLabel(member.status),
        isSelf: !!(me && String(me.id) === String(sender.user_id))
      })
    } else if (sender._ === 'messageSenderChat' && sender.chat_id) {
      const senderChat = await client.invoke({ _: 'getChat', chat_id: sender.chat_id }).catch(() => null)
      out.push({
        userId: null,
        name: senderChat ? senderChat.title : 'Chat',
        username: null,
        statusLabel: managedStatusLabel(member.status),
        isSelf: false
      })
    }
  }
  return { members: out, totalCount }
}

async function addManagedMember (chatId, username) {
  const info = await getManagedChatInfo(chatId)
  if (!info.permissions.canInviteUsers) throw new Error('You do not have permission to add members')
  const user = await resolveManagedUserByUsername(username)
  const result = await client.invoke({ _: 'addChatMember', chat_id: chatId, user_id: user.userId, forward_limit: 0 })
  return { userId: user.userId, username: user.username, result }
}

async function removeManagedMember (chatId, userId) {
  const info = await getManagedChatInfo(chatId)
  if (!info.permissions.canRestrictMembers) throw new Error('You do not have permission to remove members')
  const me = await client.invoke({ _: 'getMe' })
  if (String(me.id) === String(userId)) throw new Error('Use Leave chat to remove yourself')
  await client.invoke({
    _: 'setChatMemberStatus',
    chat_id: chatId,
    member_id: { _: 'messageSenderUser', user_id: userId },
    status: { _: 'chatMemberStatusLeft' }
  })
  return { ok: true }
}

function managedNotificationSettings (current, muted) {
  const n = current || {}
  return {
    _: 'chatNotificationSettings',
    use_default_mute_for: false,
    mute_for: muted ? 2147483647 : 0,
    use_default_sound: n.use_default_sound !== undefined ? n.use_default_sound : true,
    sound_id: Number(n.sound_id || 0),
    use_default_show_preview: n.use_default_show_preview !== undefined ? n.use_default_show_preview : true,
    show_preview: n.show_preview !== undefined ? n.show_preview : true,
    use_default_mute_stories: n.use_default_mute_stories !== undefined ? n.use_default_mute_stories : true,
    mute_stories: !!n.mute_stories,
    use_default_story_sound: n.use_default_story_sound !== undefined ? n.use_default_story_sound : true,
    story_sound_id: Number(n.story_sound_id || 0),
    use_default_show_story_poster: n.use_default_show_story_poster !== undefined ? n.use_default_show_story_poster : true,
    show_story_poster: n.show_story_poster !== undefined ? n.show_story_poster : true,
    use_default_disable_pinned_message_notifications: n.use_default_disable_pinned_message_notifications !== undefined ? n.use_default_disable_pinned_message_notifications : true,
    disable_pinned_message_notifications: !!n.disable_pinned_message_notifications,
    use_default_disable_mention_notifications: n.use_default_disable_mention_notifications !== undefined ? n.use_default_disable_mention_notifications : true,
    disable_mention_notifications: !!n.disable_mention_notifications
  }
}
'''

replace_once(
    'server.js',
    '/* ------------------------------ File search ------------------------------ */',
    management_helpers + '\n\n/* ------------------------------ File search ------------------------------ */',
    'management helper insertion',
)

# ---------------------------------------------------------------------------
# Photo upload HTTP endpoint. JPEG only; the file is temporary and is removed
# after TDLib accepts the setChatPhoto request.
# ---------------------------------------------------------------------------
photo_route = r'''

app.post('/api/chat-photo/:chatId', express.raw({ type: 'application/octet-stream', limit: '10mb' }), async (req, res) => {
  let tempPath = null
  try {
    ensureManagementReady()
    const chatId = Number(req.params.chatId)
    if (!Number.isSafeInteger(chatId)) return res.status(400).json({ error: 'Invalid chat id' })
    const info = await getManagedChatInfo(chatId)
    if (!info.permissions.canSetPhoto) return res.status(403).json({ error: 'You do not have permission to change this chat photo' })
    const name = String(req.headers['x-file-name'] || 'photo.jpg')
    if (!/\.jpe?g$/i.test(name)) return res.status(400).json({ error: 'Chat photos must be JPEG (.jpg/.jpeg)' })
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'No image uploaded' })
    tempPath = path.join(MANAGEMENT_UPLOAD_DIR, `${crypto.randomUUID()}.jpg`)
    await fs.promises.writeFile(tempPath, req.body)
    await client.invoke({
      _: 'setChatPhoto',
      chat_id: chatId,
      photo: { _: 'inputChatPhotoStatic', photo: { _: 'inputFileLocal', path: tempPath } }
    })
    const fresh = await client.invoke({ _: 'getChat', chat_id: chatId })
    sendAll({ type: 'event', event: { name: 'chat-upsert', chat: await serializeChatDetailed(fresh) } })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  } finally {
    if (tempPath) fs.promises.unlink(tempPath).catch(() => {})
  }
})
'''
replace_once(
    'server.js',
    'app.use(express.json())\n',
    'app.use(express.json())\n' + photo_route + '\n',
    'photo route insertion',
)

# ---------------------------------------------------------------------------
# WebSocket commands.
# ---------------------------------------------------------------------------
management_cases = r'''
        case 'get-chat-management':
          return respond(ws, id, true, await getManagedChatInfo(payload.chatId))
        case 'create-managed-chat':
          return respond(ws, id, true, await createManagedChat(payload || {}))
        case 'update-managed-chat':
          return respond(ws, id, true, await updateManagedChat(payload || {}))
        case 'get-managed-members':
          return respond(ws, id, true, await managedMembers(payload.chatId, payload.limit))
        case 'add-managed-member':
          return respond(ws, id, true, await addManagedMember(payload.chatId, payload.username))
        case 'remove-managed-member':
          return respond(ws, id, true, await removeManagedMember(payload.chatId, payload.userId))
        case 'create-managed-invite': {
          const info = await getManagedChatInfo(payload.chatId)
          if (!info.permissions.canInviteUsers) throw new Error('You do not have permission to create invite links')
          if (info.details.inviteLink) return respond(ws, id, true, { inviteLink: info.details.inviteLink })
          const link = await client.invoke({
            _: 'createChatInviteLink',
            chat_id: payload.chatId,
            name: 'Tele',
            expiration_date: 0,
            member_limit: 0,
            creates_join_request: false
          })
          return respond(ws, id, true, { inviteLink: link && link.invite_link })
        }
        case 'set-managed-muted': {
          const info = await getManagedChatInfo(payload.chatId)
          if (!info.permissions.canMute) throw new Error('Notifications cannot be changed for this chat')
          const chat = await client.invoke({ _: 'getChat', chat_id: payload.chatId })
          await client.invoke({
            _: 'setChatNotificationSettings',
            chat_id: payload.chatId,
            notification_settings: managedNotificationSettings(chat.notification_settings, !!payload.muted)
          })
          return respond(ws, id, true, { ok: true })
        }
        case 'remove-managed-photo': {
          const info = await getManagedChatInfo(payload.chatId)
          if (!info.permissions.canSetPhoto) throw new Error('You do not have permission to change this chat photo')
          await client.invoke({ _: 'setChatPhoto', chat_id: payload.chatId, photo: null })
          const fresh = await client.invoke({ _: 'getChat', chat_id: payload.chatId })
          sendAll({ type: 'event', event: { name: 'chat-upsert', chat: await serializeChatDetailed(fresh) } })
          return respond(ws, id, true, { ok: true })
        }
        case 'clear-managed-history': {
          const info = await getManagedChatInfo(payload.chatId)
          const revoke = !!payload.revoke
          if (revoke && !info.permissions.canDeleteForAll) throw new Error('Telegram does not allow deleting this history for everyone')
          if (!revoke && !info.permissions.canClearHistory) throw new Error('Telegram does not allow clearing this history')
          await client.invoke({ _: 'deleteChatHistory', chat_id: payload.chatId, remove_from_chat_list: false, revoke })
          return respond(ws, id, true, { ok: true })
        }
        case 'leave-managed-chat': {
          const info = await getManagedChatInfo(payload.chatId)
          if (!info.permissions.canLeave) throw new Error('This chat cannot be left')
          await client.invoke({ _: 'leaveChat', chat_id: payload.chatId })
          sendAll({ type: 'event', event: { name: 'chat-remove', chatId: payload.chatId } })
          return respond(ws, id, true, { ok: true })
        }
        case 'delete-managed-chat': {
          const info = await getManagedChatInfo(payload.chatId)
          if (!info.permissions.canDeleteForAll) throw new Error('Telegram does not allow you to delete this chat for everyone')
          await client.invoke({ _: 'deleteChat', chat_id: payload.chatId })
          sendAll({ type: 'event', event: { name: 'chat-remove', chatId: payload.chatId } })
          return respond(ws, id, true, { ok: true })
        }
'''
replace_once(
    'server.js',
    "        case 'start-download': {",
    management_cases + "        case 'start-download': {",
    'management websocket cases',
)

# ---------------------------------------------------------------------------
# Load the management UI after the rescue runtime and bust browser caches.
# ---------------------------------------------------------------------------
replace_once(
    'public/index.html',
    '<link rel="stylesheet" href="style.css?v=41"><link rel="stylesheet" href="rescue-runtime.css?v=1">',
    '<link rel="stylesheet" href="style.css?v=42"><link rel="stylesheet" href="rescue-runtime.css?v=2"><link rel="stylesheet" href="management.css?v=1">',
    'management css import',
)
replace_once(
    'public/index.html',
    '<script src="app.js?v=41"></script><script src="rescue-runtime.js?v=1"></script>',
    '<script src="app.js?v=42"></script><script src="rescue-runtime.js?v=2"></script><script src="management.js?v=1"></script>',
    'management js import',
)

# ---------------------------------------------------------------------------
# Validation knows about all runtime files.
# ---------------------------------------------------------------------------
replace_once(
    'package.json',
    '"check": "node --check server.js && node --check public/app.js",',
    '"check": "node --check server.js && node --check public/app.js && node --check public/rescue-runtime.js && node --check public/management.js",',
    'package syntax check',
)

smoke = read('scripts/rescue-smoke.test.cjs')
if "const management = fs.readFileSync('public/management.js'" not in smoke:
    smoke = smoke.replace(
        "const html = fs.readFileSync('public/index.html', 'utf8')\n",
        "const html = fs.readFileSync('public/index.html', 'utf8')\nconst management = fs.readFileSync('public/management.js', 'utf8')\n",
        1,
    )
    smoke += "\nassert.match(server, /createNewSupergroupChat/, 'channel and group creation must use TDLib')\n"
    smoke += "assert.match(server, /case 'get-chat-management'/, 'permission-aware chat management command must exist')\n"
    smoke += "assert.match(server, /deleteChatHistory/, 'clear-history support must exist')\n"
    smoke += "assert.match(server, /leaveChat/, 'leave-chat support must exist')\n"
    smoke += "assert.match(server, /deleteChat/, 'permission-aware delete support must exist')\n"
    smoke += "assert.match(management, /Create link/, 'chat info drawer must expose invite management')\n"
    smoke += "assert.match(management, /Load members/, 'chat info drawer must expose member management')\n"
    smoke += "assert.match(html, /management\.js/, 'management runtime must be loaded')\n"
    write('scripts/rescue-smoke.test.cjs', smoke)

print('Telegram management backend integration applied')
