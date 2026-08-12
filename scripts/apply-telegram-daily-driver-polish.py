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


def replace_all(path, old, new, label, minimum=1):
    src = read(path)
    count = src.count(old)
    if count < minimum:
        raise SystemExit(f"{label}: expected at least {minimum}, got {count}")
    write(path, src.replace(old, new))


def sub_once(path, pattern, replacement, label):
    src = read(path)
    out, count = re.subn(pattern, replacement, src, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"{label}: expected one replacement, got {count}")
    write(path, out)


# ---------------------------------------------------------------------------
# SERVER: correct Telegram InputFile handling, richer thumbnails/previews,
# server-side media-index memory, and truthful public/private chat overview.
# ---------------------------------------------------------------------------

replace_once(
    'server.js',
    "const scanCache = new Map() // chatId -> { found, scanned, typeCounts }",
    "const scanCache = new Map() // chatId -> { found, scanned, typeCounts }\nconst mediaIndexCache = new Map() // chatId -> full media snapshot for instant revisits",
    'media index cache'
)

replace_once(
    'server.js',
    "    case 'messageVideoNote':\n      return { ...base, type: 'video_note', file: c.video_note.video, name: `video_note_${msg.id}.mp4`, mime: 'video/mp4', thumb: c.video_note.thumb }",
    "    case 'messageVideoNote':\n      return { ...base, type: 'video_note', file: c.video_note.video, name: `video_note_${msg.id}.mp4`, mime: 'video/mp4', thumb: c.video_note.thumbnail || c.video_note.thumb || null }",
    'video-note thumbnail field'
)

replace_once(
    'server.js',
    "\nfunction mainChatOrder (chat) {",
    r'''
function mediaThumbFileId (thumb) {
  if (!thumb) return null
  if (thumb.file && thumb.file.id) return thumb.file.id
  if (thumb.photo && thumb.photo.id) return thumb.photo.id
  return null
}

function mediaIndexItemFromSerialized (chatId, message) {
  if (!message || !message.media) return null
  const media = message.media
  const file = media.file || null
  const fileId = media.fileId || (file && file.id)
  if (!fileId) return null
  return {
    key: `${chatId}:${message.id}`,
    messageId: message.id,
    chatId,
    date: message.date || media.date || 0,
    fileId,
    name: media.name,
    fileSize: media.fileSize || (file && (file.size || file.expected_size)) || 0,
    type: media.type,
    mime: media.mime || 'application/octet-stream',
    caption: media.caption || null,
    thumbFileId: media.thumbFileId || mediaThumbFileId(media.thumb),
    thumbUrl: media.thumbUrl || null
  }
}

function patchMediaIndexMessage (chatId, message) {
  const key = String(chatId)
  const cached = mediaIndexCache.get(key)
  if (!cached || !Array.isArray(cached.items) || !message) return
  const id = String(message.id)
  const index = cached.items.findIndex(item => String(item.messageId) === id)
  const next = mediaIndexItemFromSerialized(chatId, message)
  if (next) {
    if (index >= 0) cached.items[index] = next
    else cached.items.unshift(next)
  } else if (index >= 0) {
    cached.items.splice(index, 1)
  }
  cached.items.sort((a, b) => {
    const aa = BigInt(String(a.messageId || 0))
    const bb = BigInt(String(b.messageId || 0))
    return aa === bb ? 0 : (aa < bb ? 1 : -1)
  })
  cached.found = cached.items.length
  cached.typeCounts = cached.items.reduce((counts, item) => {
    counts[item.type] = (counts[item.type] || 0) + 1
    return counts
  }, { document: 0, photo: 0, video: 0, gif: 0, audio: 0, voice: 0, video_note: 0, sticker: 0 })
  cached.savedAt = Date.now()
}

function deleteMediaIndexMessages (chatId, messageIds) {
  const key = String(chatId)
  const cached = mediaIndexCache.get(key)
  if (!cached || !Array.isArray(cached.items)) return
  const ids = new Set((messageIds || []).map(String))
  cached.items = cached.items.filter(item => !ids.has(String(item.messageId)))
  cached.found = cached.items.length
  cached.typeCounts = cached.items.reduce((counts, item) => {
    counts[item.type] = (counts[item.type] || 0) + 1
    return counts
  }, { document: 0, photo: 0, video: 0, gif: 0, audio: 0, voice: 0, video_note: 0, sticker: 0 })
  cached.savedAt = Date.now()
}

function mainChatOrder (chat) {''',
    'thumbnail/index helpers'
)

replace_all(
    'server.js',
    "      if (item.media.thumb && item.media.thumb.photo && item.media.thumb.photo.id) {\n        item.media.thumbUrl = null\n        item.media.thumbFileId = item.media.thumb.photo.id\n      }",
    "      const thumbFileId = mediaThumbFileId(item.media.thumb)\n      if (thumbFileId) {\n        item.media.thumbUrl = null\n        item.media.thumbFileId = thumbFileId\n      }",
    'message thumbnail serialization',
    minimum=2
)

replace_all(
    'server.js',
    "            caption: media.caption || null,\n            thumbFileId: media.thumb && media.thumb.photo ? media.thumb.photo.id : null,",
    "            mime: media.mime || 'application/octet-stream',\n            caption: media.caption || null,\n            thumbFileId: mediaThumbFileId(media.thumb),",
    'scanner thumbnail serialization',
    minimum=2
)

replace_once(
    'server.js',
    "  const serialized = await serializeRealtimeMessage(message)\n  if (!serialized) return\n  sendAll({ type: 'event', event: { name: 'message-upsert', chatId: message.chat_id, message: serialized } })",
    "  const serialized = await serializeRealtimeMessage(message)\n  if (!serialized) return\n  patchMediaIndexMessage(message.chat_id, serialized)\n  sendAll({ type: 'event', event: { name: 'message-upsert', chatId: message.chat_id, message: serialized } })",
    'realtime media-index patch'
)

replace_once(
    'server.js',
    "    if (u._ === 'updateDeleteMessages') {\n      sendAll({",
    "    if (u._ === 'updateDeleteMessages') {\n      deleteMediaIndexMessages(u.chat_id, u.message_ids || [])\n      sendAll({",
    'realtime media-index delete'
)

replace_once(
    'server.js',
    "async function scanChat (chatId, { queue = false, mode, returnItems = false } = {}) {\n  if (scanState && scanState.active) throw new Error('A scan is already running')",
    r'''async function scanChat (chatId, { queue = false, mode, returnItems = false } = {}) {
  const mediaKey = String(chatId)
  if (!queue && returnItems) {
    const cachedIndex = mediaIndexCache.get(mediaKey)
    if (cachedIndex && Array.isArray(cachedIndex.items)) {
      return {
        found: cachedIndex.found,
        scanned: cachedIndex.scanned,
        typeCounts: { ...cachedIndex.typeCounts },
        items: cachedIndex.items.map(item => ({ ...item }))
      }
    }
  }
  if (scanState && scanState.active) throw new Error('A scan is already running')''',
    'server media-index fast path'
)

replace_once(
    'server.js',
    "    const result = { found: scanState.found, scanned: scanState.scanned, typeCounts: scanState.typeCounts, items }\n    scanCache.set(chatId, { found: result.found, scanned: result.scanned, typeCounts: result.typeCounts })\n    emitScan({ done: true })",
    "    const result = { found: scanState.found, scanned: scanState.scanned, typeCounts: scanState.typeCounts, items }\n    scanCache.set(chatId, { found: result.found, scanned: result.scanned, typeCounts: result.typeCounts })\n    if (!queue && returnItems && !scanState.cancelled) {\n      mediaIndexCache.set(String(chatId), {\n        found: result.found,\n        scanned: result.scanned,\n        typeCounts: { ...result.typeCounts },\n        items: result.items.map(item => ({ ...item })),\n        savedAt: Date.now()\n      })\n    }\n    emitScan({ done: true })",
    'server media-index save'
)

replace_once(
    'server.js',
    "  const permissions = managedPermissions(status, chat, serialized.kind, isSavedMessages, canGetMembers)\n\n  return {",
    "  const permissions = managedPermissions(status, chat, serialized.kind, isSavedMessages, canGetMembers)\n  const activePublicUsernames = groupInfo && groupInfo.usernames && Array.isArray(groupInfo.usernames.active_usernames)\n    ? groupInfo.usernames.active_usernames\n    : []\n  const accessType = type._ === 'chatTypePrivate'\n    ? 'Private chat'\n    : (type._ === 'chatTypeSupergroup' && activePublicUsernames.length ? 'Public' : 'Private')\n\n  return {",
    'chat access type'
)

replace_once(
    'server.js',
    "    details: {\n      description: (fullInfo && fullInfo.description) || '',",
    "    details: {\n      description: (fullInfo && fullInfo.description) || '',\n      accessType,",
    'chat access detail'
)

sub_once(
    'server.js',
    r"async function sendManagedAttachmentMessage \(chatId, filePath, caption, replyToMessageId\) \{.*?\n\}\n\n/\* ------------------------------ File search ------------------------------ \*/",
    r'''function managedAttachmentKind (fileName, mimeType) {
  const name = String(fileName || '').toLowerCase()
  const mime = String(mimeType || '').toLowerCase()
  if (/^image\/(jpeg|png)$/.test(mime) || /\.(jpe?g|png)$/.test(name)) return 'photo'
  if (/^video\//.test(mime) || /\.(mp4|mov|m4v|webm|mkv)$/.test(name)) return 'video'
  if (/^audio\//.test(mime) || /\.(mp3|m4a|aac|ogg|wav|flac)$/.test(name)) return 'audio'
  return 'document'
}

function managedAttachmentContent (kind, absolutePath, caption, oneTime) {
  const file = { _: 'inputFileLocal', path: absolutePath }
  const formattedCaption = { _: 'formattedText', text: String(caption || '').slice(0, 1024), entities: [] }
  const selfDestruct = oneTime ? { _: 'messageSelfDestructTypeImmediately' } : null
  if (kind === 'photo') {
    return {
      _: 'inputMessagePhoto',
      photo: file,
      thumbnail: null,
      added_sticker_file_ids: [],
      width: 0,
      height: 0,
      caption: formattedCaption,
      show_caption_above_media: false,
      self_destruct_type: selfDestruct,
      has_spoiler: false
    }
  }
  if (kind === 'video') {
    return {
      _: 'inputMessageVideo',
      video: file,
      thumbnail: null,
      cover: null,
      start_timestamp: 0,
      added_sticker_file_ids: [],
      duration: 0,
      width: 0,
      height: 0,
      supports_streaming: true,
      caption: formattedCaption,
      show_caption_above_media: false,
      self_destruct_type: selfDestruct,
      has_spoiler: false
    }
  }
  if (kind === 'audio') {
    return {
      _: 'inputMessageAudio',
      audio: file,
      album_cover_thumbnail: null,
      duration: 0,
      title: '',
      performer: '',
      caption: formattedCaption
    }
  }
  return {
    _: 'inputMessageDocument',
    document: file,
    thumbnail: null,
    disable_content_type_detection: false,
    caption: formattedCaption
  }
}

async function sendManagedAttachmentMessage (chatId, filePath, caption, replyToMessageId, mimeType, fileName, oneTime) {
  ensureManagementReady()
  const absolutePath = path.resolve(String(filePath || ''))
  const stat = await fs.promises.stat(absolutePath).catch(() => null)
  if (!stat || !stat.isFile() || stat.size <= 0) throw new Error('The attachment could not be staged for Telegram')

  let replyTo = null
  if (replyToMessageId) {
    const actions = await getManagedMessageActions(chatId, replyToMessageId)
    if (!actions.canReply) throw new Error('Telegram does not allow replying to this message')
    replyTo = { _: 'inputMessageReplyToMessage', message_id: replyToMessageId, quote: null, checklist_task_id: 0 }
  }

  const kind = managedAttachmentKind(fileName || absolutePath, mimeType)
  if (oneTime) {
    const chat = await client.invoke({ _: 'getChat', chat_id: chatId })
    if (!chat || !chat.type || chat.type._ !== 'chatTypePrivate') {
      throw new Error('View once is available only in private chats')
    }
    if (kind !== 'photo' && kind !== 'video') {
      throw new Error('View once is available only for photos and videos')
    }
  }

  // Normal Telegram media should be sent directly as inputFileLocal. TDLib
  // owns the upload after sendMessage accepts the content; no preliminary
  // upload/file-id handoff is needed for ordinary attachments.
  const message = await client.invoke({
    _: 'sendMessage',
    chat_id: chatId,
    topic_id: null,
    reply_to: replyTo,
    options: null,
    reply_markup: null,
    input_message_content: managedAttachmentContent(kind, absolutePath, caption, !!oneTime)
  })
  emitRealtimeMessage(message).catch(() => {})
  emitChatUpsert(chatId).catch(() => {})
  return serializeRealtimeMessage(message)
}

/* ------------------------------ File search ------------------------------ */''',
    'direct multi-format attachment sender'
)

replace_once(
    'server.js',
    "    const message = await sendManagedAttachmentMessage(chatId, tempPath, caption, Number.isSafeInteger(replyToMessageId) ? replyToMessageId : null)\n    res.json({ ok: true, message })",
    "    let mimeType = String(req.headers['x-mime-type'] || 'application/octet-stream')\n    try { mimeType = decodeURIComponent(mimeType) } catch {}\n    const oneTime = String(req.headers['x-one-time'] || '') === '1'\n    const message = await sendManagedAttachmentMessage(\n      chatId,\n      tempPath,\n      caption,\n      Number.isSafeInteger(replyToMessageId) ? replyToMessageId : null,\n      mimeType,\n      fileName,\n      oneTime\n    )\n    res.json({ ok: true, message })",
    'attachment endpoint metadata'
)

replace_once(
    'server.js',
    "\napp.use('/dl', (req, res, next) => {",
    r'''
async function ensurePreviewFile (fileId) {
  const id = Number(fileId)
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid file id')
  const existing = await client.invoke({ _: 'getFile', file_id: id }).catch(() => null)
  if (existing && existing.local && existing.local.is_downloading_completed && existing.local.path) return existing.local.path
  const downloaded = await client.invoke({
    _: 'downloadFile',
    file_id: id,
    priority: 16,
    offset: 0,
    limit: 0,
    synchronous: true
  })
  const local = downloaded && downloaded.local
  if (!local || !local.is_downloading_completed || !local.path) throw new Error('Telegram could not prepare this file for preview')
  return local.path
}

app.get('/api/media-preview/:fileId', async (req, res) => {
  try {
    ensureManagementReady()
    const localPath = await ensurePreviewFile(req.params.fileId)
    const mime = String(req.query.mime || '')
    const name = sanitize(String(req.query.name || path.basename(localPath)))
    if (/^[\w.+-]+\/[\w.+-]+$/.test(mime)) res.setHeader('Content-Type', mime)
    else res.type(name)
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`)
    res.sendFile(path.resolve(localPath))
  } catch (e) {
    res.status(404).json({ error: String(e.message || e) })
  }
})

app.use('/dl', (req, res, next) => {''',
    'media preview endpoint'
)

replace_once(
    'server.js',
    "          await client.invoke({ _: 'deleteChatHistory', chat_id: payload.chatId, remove_from_chat_list: false, revoke })\n          sendAll({ type: 'event', event: { name: 'history-cleared', chatId: payload.chatId, revoke } })",
    "          await client.invoke({ _: 'deleteChatHistory', chat_id: payload.chatId, remove_from_chat_list: false, revoke })\n          mediaIndexCache.delete(String(payload.chatId))\n          sendAll({ type: 'event', event: { name: 'history-cleared', chatId: payload.chatId, revoke } })",
    'clear server media index with history'
)


# ---------------------------------------------------------------------------
# APP: whole-chat search is no longer a separate mode from the already-complete
# file index. Enter simply leaves filtering to the current in-memory snapshot.
# ---------------------------------------------------------------------------

sub_once(
    'public/app.js',
    r"\n\$\('#file-search'\)\.addEventListener\('keydown', e => \{\n  if \(e\.key === 'Enter'\) searchWholeChat\(\)\n\}\)\n\$\('#search-whole'\)\.onclick = searchWholeChat",
    "",
    'remove whole-chat search trigger'
)


# ---------------------------------------------------------------------------
# RESCUE RUNTIME: no-jitter cache refreshes, bounded DOM rendering, persistent
# download/forward marks, file range selection, previews, modern SVG icons,
# multi-file composer, and private-chat view-once.
# ---------------------------------------------------------------------------

replace_once(
    'public/rescue-runtime.js',
    "const rescueInflight = new Map()\nconst rescueCacheLimit = 24",
    r'''const rescueInflight = new Map()
const rescueDownloadedMarks = rescueLoadMarkSet('tele-downloaded-files-v1')
const rescueForwardedMarks = rescueLoadMarkSet('tele-forwarded-files-v1')
let rescueMessageRenderLimit = 120
let rescueFileRenderLimit = 600
const rescueCacheLimit = 24''',
    'runtime mark/window state'
)

replace_once(
    'public/rescue-runtime.js',
    "function rescueChatKey (chatId) { return String(chatId) }\n",
    r'''function rescueChatKey (chatId) { return String(chatId) }

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
''',
    'runtime helpers/windowed messages'
)

sub_once(
    'public/rescue-runtime.js',
    r"function rescueUpdateMediaLabel \(\) \{.*?\n\}",
    r'''function rescueUpdateMediaLabel () {
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
}''',
    'active-chat media label'
)

replace_once(
    'public/rescue-runtime.js',
    "  state.activeChatId = chatId\n  rescueRememberChat(chatId)",
    "  state.activeChatId = chatId\n  rescueRememberChat(chatId)\n  rescueMessageRenderLimit = 120\n  rescueFileRenderLimit = 600",
    'reset render windows on chat switch'
)

replace_once(
    'public/rescue-runtime.js',
    "  $('#chat-title').textContent = chat ? chat.title : 'Chat'\n  $('#media-grid').innerHTML = ''",
    "  $('#chat-title').textContent = chat ? chat.title : 'Chat'\n  $('#media-grid').innerHTML = ''\n  const resetSelectAll = $('#select-all-media')\n  if (resetSelectAll) { resetSelectAll.textContent = 'Select all'; resetSelectAll.disabled = true }\n  const resetMediaLabel = $('#chat-media-count')\n  if (resetMediaLabel) resetMediaLabel.textContent = preferredView === 'files' ? 'Loading files…' : ''",
    'reset stale per-chat file header'
)

# The prior replacement references preferredView before declaration; correct the
# label expression to a declaration-free value so switching cannot throw.
replace_once(
    'public/rescue-runtime.js',
    "  if (resetMediaLabel) resetMediaLabel.textContent = preferredView === 'files' ? 'Loading files…' : ''",
    "  if (resetMediaLabel) resetMediaLabel.textContent = ''",
    'safe stale media label reset'
)

replace_once(
    'public/rescue-runtime.js',
    "      const data = await request('get-messages', { chatId, fromMessageId: 0, limit: 100 })\n      if (rescueChatKey(state.activeChatId) !== rescueChatKey(chatId) || generation !== rescueOpenGeneration) return\n      rescueMergeMessages(chatId, data.messages || [])\n      state.hasMore = !!data.hasMore\n      rescueSaveActiveChat()\n      rescueRenderCurrent()\n      setLoadState(state.hasMore ? '' : 'End of history')",
    "      const data = await request('get-messages', { chatId, fromMessageId: 0, limit: 100 })\n      if (rescueChatKey(state.activeChatId) !== rescueChatKey(chatId) || generation !== rescueOpenGeneration) return\n      const beforeSignature = rescueMessageSignature(state.messages)\n      rescueMergeMessages(chatId, data.messages || [])\n      state.hasMore = !!data.hasMore\n      rescueSaveActiveChat()\n      if (rescueMessageSignature(state.messages) !== beforeSignature) rescueRenderCurrent()\n      else rescueUpdateMediaLabel()\n      setLoadState(state.hasMore ? '' : 'End of history')",
    'skip identical newest-page rerender'
)

replace_once(
    'public/rescue-runtime.js',
    "function rescueSortChatsRecentFirst () {",
    r'''function rescueChatTypeSvg (kind) {
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

function rescueSortChatsRecentFirst () {''',
    'modern SVG icon helpers'
)

replace_once(
    'public/rescue-runtime.js',
    "    const u = h('div', 'u', typeIcon[chat.kind] || '💬')\n    if (chat.unread > 0) u.textContent += ` · ${chat.unread}`\n    li.appendChild(u)",
    "    const u = h('div', 'u chat-kind')\n    u.innerHTML = rescueChatTypeSvg(chat.kind)\n    if (chat.unread > 0) u.appendChild(h('span', 'chat-unread', String(chat.unread)))\n    li.appendChild(u)",
    'sidebar SVG icons'
)

# Add file marks, range selection and previews before the selection dock is moved.
replace_once(
    'public/rescue-runtime.js',
    "// Keep selection actions physically inside the center workspace.\nconst rescueSelectionDock = $('#selection-bar')",
    r'''/* File workspace: exact-count range selection, persistent marks and previews. */
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

const rescueLegacyRenderFiles = renderFiles
renderFiles = function rescueFastFileRender () {
  const grid = $('#media-grid')
  if (!grid) return
  const items = filesItems()
  const visible = items.length > 1200 ? items.slice(0, rescueFileRenderLimit) : items
  grid.innerHTML = ''
  for (const item of visible) grid.appendChild(buildGridCard(item))
  const selectAll = $('#select-all-media')
  if (selectAll) {
    selectAll.textContent = items.length ? `Select all (${items.length})` : 'Select all'
    selectAll.disabled = items.length === 0
  }
  rescueUpdateRangeControls(items.length)
  if (items.length > visible.length) {
    const more = h('div', 'file-render-more', `Showing ${visible.length.toLocaleString()} of ${items.length.toLocaleString()} · scroll for more`)
    grid.appendChild(more)
  }
}

const rescueFileGridForWindow = $('#media-grid')
if (rescueFileGridForWindow) {
  rescueFileGridForWindow.addEventListener('scroll', () => {
    if (rescueFileGridForWindow.scrollTop + rescueFileGridForWindow.clientHeight < rescueFileGridForWindow.scrollHeight - 240) return
    const total = filesItems().length
    if (total <= 1200 || rescueFileRenderLimit >= total || dragSel) return
    rescueFileRenderLimit = Math.min(total, rescueFileRenderLimit + 600)
    const top = rescueFileGridForWindow.scrollTop
    renderFiles()
    rescueFileGridForWindow.scrollTop = top
  }, true)
}

// Keep old controls wired internally but remove them from the daily-driver UI.
for (const selector of ['#file-sort', '#search-whole', '#pack-media', '#cancel-pack', '#pack-banner', '#zip-results']) {
  const node = document.querySelector(selector)
  if (node) node.classList.add('legacy-control-hidden')
}

// Keep selection actions physically inside the center workspace.
const rescueSelectionDock = $('#selection-bar')''',
    'file daily-driver tools'
)

replace_once(
    'public/rescue-runtime.js',
    "handleEvent = function rescueRealtimeHandleEvent (ev) {\n  if (ev && ev.name === 'message-upsert') {",
    r'''handleEvent = function rescueRealtimeHandleEvent (ev) {
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
  if (ev && ev.name === 'message-upsert') {''',
    'persistent file status events'
)

# Replace single-file composer state and UI with multi-file attachments + view once.
replace_once(
    'public/rescue-runtime.js',
    "const rescueCompose = { replyTo: null, editMessageId: null, editOriginal: '', attachment: null }",
    "const rescueCompose = { replyTo: null, editMessageId: null, editOriginal: '', attachments: [], oneTime: false }",
    'multi attachment state'
)

replace_once(
    'public/rescue-runtime.js',
    "      <input id=\"tele-compose-file\" type=\"file\" class=\"hidden\" />\n      <button id=\"tele-compose-attach\" class=\"ghost tele-compose-attach\" type=\"button\" title=\"Attach file\" aria-label=\"Attach file\">📎</button>",
    "      <input id=\"tele-compose-file\" type=\"file\" class=\"hidden\" multiple />\n      <button id=\"tele-compose-attach\" class=\"ghost tele-compose-attach\" type=\"button\" title=\"Attach files\" aria-label=\"Attach files\"></button>",
    'multi file input and icon'
)

replace_once(
    'public/rescue-runtime.js',
    "    <div id=\"tele-attachment-preview\" class=\"tele-attachment-preview hidden\">\n      <div><strong id=\"tele-attachment-name\"></strong><span id=\"tele-attachment-meta\"></span></div>\n      <button id=\"tele-attachment-clear\" class=\"ghost small\" type=\"button\">Remove</button>\n    </div>",
    "    <div id=\"tele-attachment-preview\" class=\"tele-attachment-preview hidden\">\n      <div id=\"tele-attachment-list\" class=\"tele-attachment-list\"></div>\n      <div class=\"tele-attachment-footer\"><label id=\"tele-one-time-wrap\" class=\"tele-one-time hidden\"><input id=\"tele-one-time\" type=\"checkbox\"><span>View once</span></label><button id=\"tele-attachment-clear\" class=\"ghost small\" type=\"button\">Clear</button></div>\n    </div>",
    'multi attachment preview'
)

replace_once(
    'public/rescue-runtime.js',
    "  const fileInput = document.querySelector('#tele-compose-file')\n  document.querySelector('#tele-compose-send').onclick = rescueSendComposer",
    "  const fileInput = document.querySelector('#tele-compose-file')\n  const attachButton = document.querySelector('#tele-compose-attach')\n  if (attachButton) attachButton.innerHTML = '<svg width=\"19\" height=\"19\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"1.8\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><path d=\"m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48\"/></svg>'\n  document.querySelector('#tele-compose-send').onclick = rescueSendComposer",
    'attach SVG icon'
)

replace_once(
    'public/rescue-runtime.js',
    "  fileInput.addEventListener('change', () => rescueSetAttachment(fileInput.files && fileInput.files[0]))",
    "  fileInput.addEventListener('change', () => rescueSetAttachments([...(fileInput.files || [])]))\n  const oneTime = document.querySelector('#tele-one-time')\n  if (oneTime) oneTime.addEventListener('change', () => { rescueCompose.oneTime = !!oneTime.checked })",
    'multi attachment input wiring'
)

replace_once(
    'public/rescue-runtime.js',
    "    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]\n    if (!file) return\n    e.preventDefault()\n    rescueSetAttachment(file)",
    "    const files = e.dataTransfer && e.dataTransfer.files ? [...e.dataTransfer.files] : []\n    if (!files.length) return\n    e.preventDefault()\n    rescueSetAttachments(files)",
    'multi attachment drop'
)

sub_once(
    'public/rescue-runtime.js',
    r"function rescueClearAttachment \(\) \{.*?\n\}\n\nfunction rescueSetAttachment \(file\) \{.*?\n\}",
    r'''function rescueClearAttachment () {
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
}''',
    'multi attachment helpers'
)

replace_once(
    'public/rescue-runtime.js',
    "    rescueClearAttachment()\n    rescueCompose.editMessageId = message.id",
    "    rescueClearAttachment()\n    rescueCompose.editMessageId = message.id",
    'edit attachment reset no-op'
)

sub_once(
    'public/rescue-runtime.js',
    r"async function rescueSendComposer \(\) \{.*?\n\}\n\nasync function rescueDeleteMessage",
    r'''async function rescueSendComposer () {
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

async function rescueDeleteMessage''',
    'multi-format composer sender'
)

# ---------------------------------------------------------------------------
# MANAGEMENT: Overview now states Public/Private truthfully from TDLib data.
# ---------------------------------------------------------------------------

replace_once(
    'public/management.js',
    "      infoRow('Access', chat.kind === 'private' ? 'Private chat' : (details.inviteLink ? 'Invite link' : 'Private')),
",
    "      infoRow('Access', details.accessType || (chat.kind === 'private' ? 'Private chat' : 'Private')),
",
    'public/private overview'
)


# ---------------------------------------------------------------------------
# INDEX: cache-bust new runtime/css. Legacy controls stay in DOM long enough for
# old listeners to initialize, then the rescue runtime hides them safely.
# ---------------------------------------------------------------------------

idx = read('public/index.html')
idx = re.sub(r'modern\.css\?v=\d+', 'modern.css?v=2', idx)
if 'telegram-polish.css' not in idx:
    idx = idx.replace('</head>', '<link rel="stylesheet" href="telegram-polish.css?v=1"></head>')
idx = re.sub(r'rescue-runtime\.js\?v=\d+', 'rescue-runtime.js?v=7', idx)
idx = re.sub(r'management\.js\?v=\d+', 'management.js?v=4', idx)
write('public/index.html', idx)


# ---------------------------------------------------------------------------
# CSS: Telegram-like message flow, compact channel filter, range/file statuses,
# media preview, and a calmer download/control surface.
# ---------------------------------------------------------------------------

write('public/telegram-polish.css', r'''/* Tele daily-driver polish ------------------------------------------------ */
:root {
  --tele-surface-0: #091019;
  --tele-surface-1: #0f1823;
  --tele-surface-2: #152131;
  --tele-surface-3: #1a293a;
  --tele-line: rgba(126, 157, 190, .16);
  --tele-blue: #58aaff;
  --tele-green: #4bc477;
}

/* Sidebar: compact, readable, no emoji chrome. */
.sidebar { padding-inline: 8px; }
.channels-filter {
  margin: 1px 4px 8px;
  min-height: 36px;
  padding: 6px 9px;
  border: 1px solid var(--tele-line);
  border-radius: 11px;
  background: rgba(255,255,255,.018);
  color: #a7b7c8;
  gap: 8px;
}
.channels-filter input {
  appearance: none;
  width: 30px;
  height: 17px;
  border: 0;
  border-radius: 999px;
  padding: 2px;
  background: #2a3949;
  position: relative;
  cursor: pointer;
  transition: background .15s ease;
}
.channels-filter input::after {
  content: '';
  position: absolute;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  background: #dce7f1;
  left: 2px;
  top: 2px;
  transition: transform .15s ease;
}
.channels-filter input:checked { background: var(--tele-blue); }
.channels-filter input:checked::after { transform: translateX(13px); background: #06121e; }
#chat-count { margin-left: auto; }
.chat-item .u.chat-kind {
  width: auto;
  min-width: 20px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  color: #6f849a;
}
.chat-item.active .u.chat-kind { color: #b9dcff; }
.chat-unread {
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--tele-blue);
  color: #07121e;
  font-size: 9px;
  font-weight: 800;
}

/* Messages: compact Telegram-like bubbles rather than stretched cards. */
.messages {
  align-items: stretch;
  gap: 3px;
  padding: 16px clamp(16px, 4vw, 64px) 18px;
}
.msg {
  position: relative;
  width: fit-content;
  max-width: min(72%, 680px);
  min-width: 92px;
  padding: 7px 10px 6px;
  border: 0;
  box-shadow: 0 1px 1px rgba(0,0,0,.22);
}
.msg.incoming {
  align-self: flex-start;
  background: #172231;
  border-radius: 14px 14px 14px 4px;
}
.msg.outgoing {
  align-self: flex-end;
  background: #1c4967;
  border-radius: 14px 14px 4px 14px;
}
.msg-head { min-height: 14px; margin-bottom: 2px; align-items: center; }
.msg.outgoing .msg-sender { display: none; }
.msg-sender { font-size: 11px; font-weight: 650; }
.msg-date { font-size: 9px; opacity: .78; white-space: nowrap; }
.msg-text { font-size: 13.5px; line-height: 1.38; }
.msg-actions {
  position: absolute;
  right: 6px;
  bottom: -29px;
  z-index: 12;
  display: flex;
  gap: 4px;
  height: auto;
  margin: 0;
  padding: 3px;
  opacity: 0;
  pointer-events: none;
  border: 1px solid var(--tele-line);
  border-radius: 10px;
  background: #111c28;
  box-shadow: 0 8px 24px rgba(0,0,0,.3);
}
.msg:hover .msg-actions, .msg:focus-within .msg-actions { opacity: 1; pointer-events: auto; height: auto; }
.msg-actions button { padding: 4px 7px; font-size: 10px; }
.msg-select { top: 6px; right: 7px; }
.msg .media {
  min-width: min(420px, 55vw);
  padding: 6px;
  margin-top: 4px;
  border-radius: 10px;
  background: rgba(4,10,16,.22);
}
.media-preview-action { flex: 0 0 auto; }

/* File toolbar: newest-first is the invariant; give space to useful controls. */
.legacy-control-hidden { display: none !important; }
.files-toolbar {
  flex-wrap: wrap;
  gap: 7px;
  padding: 10px 14px;
  background: #0d151f;
}
.files-toolbar .search-box { min-width: 230px; }
.file-range-tools {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 39px;
  padding: 4px 5px 4px 9px;
  border: 1px solid #253649;
  border-radius: 11px;
  background: #141f2b;
}
.file-range-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .55px; color: #7f94aa; }
.file-range-tools input {
  width: 66px;
  height: 29px;
  padding: 4px 7px;
  border-radius: 7px;
  background: #0c141e;
  font-size: 11px;
  text-align: center;
}
.file-range-separator { color: #6d8195; }
#file-range-summary { padding: 0 5px; font-size: 10px; white-space: nowrap; }
.gcard { min-height: 64px; height: auto; padding: 7px 10px; gap: 9px; }
.gcard .gthumb { width: 48px; height: 48px; background: #101b27; }
.gcard .gthumb .icon { display: flex; align-items: center; justify-content: center; color: #7790a8; opacity: 1; }
.gcard .gthumb img { background: #07101a; }
.gcard .gbody { gap: 2px; }
.gcard .gtype { background: rgba(88,170,255,.12); color: #76baff; border: 1px solid rgba(88,170,255,.22); }
.file-preview-action { padding: 5px 8px !important; color: #a8bad0 !important; }
.file-statuses { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.file-status {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  padding: 1px 6px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: .1px;
}
.file-status.downloaded { color: #69d98e; background: rgba(75,196,119,.12); border: 1px solid rgba(75,196,119,.2); }
.file-status.forwarded { color: #73baff; background: rgba(88,170,255,.12); border: 1px solid rgba(88,170,255,.2); }
.file-render-more {
  min-height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #71879c;
  font-size: 10px;
}

/* Preview lightbox. */
.tele-preview-modal {
  position: fixed;
  inset: 0;
  z-index: 1900;
  display: grid;
  place-items: center;
  padding: 26px;
  background: rgba(3,8,13,.78);
  backdrop-filter: blur(10px);
}
.tele-preview-shell {
  width: min(1040px, 92vw);
  height: min(760px, 88vh);
  display: grid;
  grid-template-rows: auto 1fr;
  overflow: hidden;
  border: 1px solid #293b4f;
  border-radius: 17px;
  background: #0d151f;
  box-shadow: 0 28px 90px rgba(0,0,0,.6);
}
.tele-preview-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px 10px 15px; border-bottom: 1px solid var(--tele-line); }
.tele-preview-head > div { min-width: 0; display: flex; flex-direction: column; }
.tele-preview-head strong, .tele-preview-head span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tele-preview-head span { font-size: 10px; color: #8396aa; }
.tele-preview-body { min-height: 0; display: grid; place-items: center; padding: 12px; background: #070d14; }
.tele-preview-body img, .tele-preview-body video { max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 9px; }
.tele-preview-body audio { width: min(620px, 90%); }
.tele-preview-loading { color: #8296aa; font-size: 12px; }

/* Composer: multi-file queue and one-time control. */
.tele-attachment-preview { display: flex; flex-direction: column; align-items: stretch; gap: 7px; }
.tele-attachment-list { display: grid; gap: 5px; max-height: 142px; overflow: auto; }
.tele-attachment-item { display: flex; align-items: center; gap: 8px; padding: 6px 7px 6px 9px; border-radius: 9px; background: rgba(0,0,0,.14); }
.tele-attachment-item-info { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.tele-attachment-item-info strong, .tele-attachment-item-info span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tele-attachment-item-info strong { font-size: 11px; }
.tele-attachment-item-info span { font-size: 9px; }
.tele-attachment-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.tele-one-time { flex-direction: row; align-items: center; gap: 6px; color: #9fb1c4; font-size: 10px; cursor: pointer; }
.tele-one-time input { width: 15px; height: 15px; padding: 0; accent-color: var(--tele-blue); }

/* Downloads: calmer controls, clearer hierarchy, less dead chrome. */
#mg-downloads-pane .downloads-head { padding: 11px 12px; }
#mg-downloads-pane .dl-controls {
  margin: 8px;
  padding: 10px;
  display: grid;
  gap: 9px;
  border: 1px solid var(--tele-line);
  border-radius: 13px;
  background: #131e2a;
}
#mg-downloads-pane .conc { gap: 5px; }
#mg-downloads-pane #dl-dir { background: #0c151f; }
#mg-downloads-pane .dir-current { padding: 0 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#mg-downloads-pane .dl-controls > .row { gap: 5px !important; }
#mg-downloads-pane .dl-controls button { border-radius: 9px; }
#download-list { padding: 0 8px 12px; }
.djob { margin-top: 7px; border-radius: 12px !important; border-color: var(--tele-line) !important; background: #131e2a !important; box-shadow: none !important; }
.djob .bar { height: 3px !important; background: #263547 !important; }

/* Chat info uses quieter cards and explicit access value. */
.mg-section { box-shadow: none; }
.mg-info-row { min-height: 31px; }

@media (max-width: 1250px) {
  .app { grid-template-columns: 280px minmax(0, 1fr) 310px; }
  .msg { max-width: 82%; }
  .file-range-tools { width: 100%; }
}
''')


# ---------------------------------------------------------------------------
# SMOKE CONTRACT: protect the regression fixes we actually want now.
# ---------------------------------------------------------------------------

smoke = read('scripts/rescue-smoke.test.cjs')
smoke = smoke.replace("assert.match(server, /preliminaryUploadFile/, 'attachments must be registered with TDLib before send')\n", "")
smoke = smoke.replace("assert.match(server, /inputFileId/, 'attachments must send using a validated TDLib file id')\n", "")
if "attachments must send directly as local files" not in smoke:
    smoke += r'''

const polishCss = fs.readFileSync('public/telegram-polish.css', 'utf8')
assert.match(server, /inputFileLocal/, 'attachments must send directly as local files')
assert.doesNotMatch(server, /preliminaryUploadFile/, 'ordinary attachments must not use preliminary upload handoff')
assert.match(server, /inputMessagePhoto/, 'photo attachments must use Telegram photo content')
assert.match(server, /inputMessageVideo/, 'video attachments must use Telegram video content')
assert.match(server, /inputMessageAudio/, 'audio attachments must use Telegram audio content')
assert.match(server, /messageSelfDestructTypeImmediately/, 'private photo/video view-once must be supported')
assert.match(server, /mediaThumbFileId/, 'video/document thumbnails must resolve TDLib thumbnail file ids')
assert.match(server, /api\/media-preview/, 'preview endpoint must exist')
assert.match(server, /mediaIndexCache/, 'whole-chat media index must be cached in memory')
assert.match(rescueRuntime, /file-range-tools/, 'file range selection must exist')
assert.match(rescueRuntime, /tele-downloaded-files-v1/, 'downloaded file marks must persist')
assert.match(rescueRuntime, /tele-forwarded-files-v1/, 'forwarded file marks must persist')
assert.match(rescueRuntime, /multiple/, 'composer must support multiple attachments')
assert.match(rescueRuntime, /View once/, 'composer must expose private-media view once')
assert.match(management, /details\.accessType/, 'chat overview must display Telegram public/private access')
assert.match(polishCss, /Tele daily-driver polish/, 'daily-driver UI polish stylesheet must exist')
'''
write('scripts/rescue-smoke.test.cjs', smoke)

print('daily-driver polish patch applied')
