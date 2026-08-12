'use strict'

const fs = require('node:fs')

function read (path) { return fs.readFileSync(path, 'utf8') }
function write (path, value) { fs.writeFileSync(path, value) }
function replaceOne (text, pattern, replacement, label) {
  const matches = typeof pattern === 'string' ? text.split(pattern).length - 1 : (text.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')) || []).length
  if (matches !== 1) throw new Error(`${label}: expected exactly 1 match, got ${matches}`)
  return text.replace(pattern, replacement)
}

let server = read('server.js')

const attachmentRegion = /function managedAttachmentContent \(kind, absolutePath, caption, oneTime\) \{[\s\S]*?async function sendManagedAttachmentMessage \(chatId, filePath, caption, replyToMessageId, mimeType, fileName, oneTime\) \{[\s\S]*?\n\}\n\n(?=\/\* ------------------------------ File search ------------------------------ \*\/)/
const attachmentReplacement = `function managedAttachmentContent (kind, inputFile, caption, oneTime) {
  const formattedCaption = { _: 'formattedText', text: String(caption || '').slice(0, 1024), entities: [] }
  const selfDestruct = oneTime ? { _: 'messageSelfDestructTypeImmediately' } : null

  if (kind === 'photo') {
    const content = {
      _: 'inputMessagePhoto',
      photo: inputFile,
      added_sticker_file_ids: [],
      width: 0,
      height: 0,
      caption: formattedCaption,
      show_caption_above_media: false,
      has_spoiler: false
    }
    if (selfDestruct) content.self_destruct_type = selfDestruct
    return content
  }

  if (kind === 'video') {
    const content = {
      _: 'inputMessageVideo',
      video: inputFile,
      start_timestamp: 0,
      added_sticker_file_ids: [],
      duration: 0,
      width: 0,
      height: 0,
      supports_streaming: true,
      caption: formattedCaption,
      show_caption_above_media: false,
      has_spoiler: false
    }
    if (selfDestruct) content.self_destruct_type = selfDestruct
    return content
  }

  if (kind === 'audio') {
    return {
      _: 'inputMessageAudio',
      audio: inputFile,
      duration: 0,
      title: '',
      performer: '',
      caption: formattedCaption
    }
  }

  return {
    _: 'inputMessageDocument',
    document: inputFile,
    disable_content_type_detection: false,
    caption: formattedCaption
  }
}

function managedLocalInputFile (absolutePath) {
  return { _: 'inputFileLocal', path: absolutePath }
}

function managedUploadFileType (kind) {
  if (kind === 'photo') return { _: 'fileTypePhoto' }
  if (kind === 'video') return { _: 'fileTypeVideo' }
  if (kind === 'audio') return { _: 'fileTypeAudio' }
  return { _: 'fileTypeDocument' }
}

async function managedWaitForPreliminaryUpload (file, timeoutMs = 180000) {
  if (!file || !file.id) throw new Error('Telegram did not return a file id for the upload')
  if (file.remote && file.remote.is_uploading_completed) return file

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.off('update', onUpdate)
      if (error) reject(error)
      else resolve(value)
    }
    const onUpdate = update => {
      if (!update || update._ !== 'updateFile' || !update.file || String(update.file.id) !== String(file.id)) return
      if (update.file.remote && update.file.remote.is_uploading_completed) finish(null, update.file)
    }
    const timer = setTimeout(() => finish(new Error('Telegram upload preparation timed out')), timeoutMs)
    client.on('update', onUpdate)
    client.invoke({ _: 'getFile', file_id: file.id }).then(current => {
      if (current && current.remote && current.remote.is_uploading_completed) finish(null, current)
    }).catch(() => {})
  })
}

async function managedPrepareInputFile (absolutePath, kind) {
  const uploaded = await client.invoke({
    _: 'preliminaryUploadFile',
    file: managedLocalInputFile(absolutePath),
    file_type: managedUploadFileType(kind),
    priority: 32
  })
  const completed = await managedWaitForPreliminaryUpload(uploaded)
  return { _: 'inputFileId', id: completed.id }
}

function managedSendAttachmentQuery (chatId, replyTo, content) {
  const query = {
    _: 'sendMessage',
    chat_id: chatId,
    input_message_content: content
  }
  if (replyTo) query.reply_to = replyTo
  return query
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
      throw new Error('Telegram supports View once only in private chats')
    }
    if (kind !== 'photo' && kind !== 'video') {
      throw new Error('View once is available only for photos and videos')
    }
  }

  let message
  let directError = null
  try {
    const content = managedAttachmentContent(kind, managedLocalInputFile(absolutePath), caption, !!oneTime)
    message = await client.invoke(managedSendAttachmentQuery(chatId, replyTo, content))
  } catch (error) {
    directError = error
    const text = String(error && error.message ? error.message : error)
    if (!/inputfile|input file|local file|file is not specified/i.test(text)) throw error
  }

  if (!message) {
    try {
      const prepared = await managedPrepareInputFile(absolutePath, kind)
      const content = managedAttachmentContent(kind, prepared, caption, !!oneTime)
      message = await client.invoke(managedSendAttachmentQuery(chatId, replyTo, content))
    } catch (fallbackError) {
      const first = directError ? String(directError.message || directError) : 'direct local-file send failed'
      const second = String(fallbackError && fallbackError.message ? fallbackError.message : fallbackError)
      throw new Error(`Telegram attachment send failed. Direct: ${first}. Prepared upload: ${second}`)
    }
  }

  emitRealtimeMessage(message).catch(() => {})
  emitChatUpsert(chatId).catch(() => {})
  return serializeRealtimeMessage(message)
}

`
server = replaceOne(server, attachmentRegion, attachmentReplacement, 'attachment sender region')

const previewRegion = /async function ensurePreviewFile \(fileId\) \{[\s\S]*?\n\}\n\napp\.get\('\/api\/media-preview\/:fileId',[\s\S]*?\n\}\)\n/
const previewReplacement = `async function ensurePreviewFile (fileId) {
  const id = Number(fileId)
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid file id')
  const existing = await client.invoke({ _: 'getFile', file_id: id }).catch(() => null)
  if (existing && existing.local && existing.local.is_downloading_completed && existing.local.path) return existing.local.path
  if (existing && existing.local && existing.local.can_be_downloaded === false) throw new Error('Telegram reports that this file cannot be downloaded')

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      client.off('update', onUpdate)
      if (error) reject(error)
      else resolve(value)
    }
    const inspect = file => {
      const local = file && file.local
      if (local && local.is_downloading_completed && local.path) finish(null, local.path)
    }
    const onUpdate = update => {
      if (!update || update._ !== 'updateFile' || !update.file || String(update.file.id) !== String(id)) return
      inspect(update.file)
    }
    const timer = setTimeout(() => finish(new Error('Telegram could not prepare this file for inline playback')), 90000)
    client.on('update', onUpdate)
    client.invoke({ _: 'downloadFile', file_id: id, priority: 32, offset: 0, limit: 0, synchronous: false })
      .then(inspect)
      .catch(error => finish(error))
  })
}

app.get('/api/media-preview/:fileId', async (req, res) => {
  try {
    ensureManagementReady()
    const localPath = await ensurePreviewFile(req.params.fileId)
    const mime = String(req.query.mime || '')
    const name = sanitize(String(req.query.name || path.basename(localPath)))
    if (/^[\\w.+-]+\\/[\\w.+-]+$/.test(mime)) res.setHeader('Content-Type', mime)
    else res.type(name)
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`)
    res.sendFile(path.resolve(localPath), { acceptRanges: true })
  } catch (e) {
    res.status(404).json({ error: String(e.message || e) })
  }
})
`
server = replaceOne(server, previewRegion, previewReplacement, 'media preview endpoint')

server = replaceOne(
  server,
  "      const msgs = (history.messages || []).filter(m => m.sending_state === undefined)\n      if (!msgs.length) break\n      for (const m of msgs) {",
  "      const msgs = (history.messages || []).filter(m => m.sending_state === undefined)\n      if (!msgs.length) break\n      const batchItems = []\n      for (const m of msgs) {",
  'scan batch initialization'
)

server = replaceOne(
  server,
  "          if (returnItems) items.push(item)",
  "          if (returnItems) {\n            items.push(item)\n            batchItems.push(item)\n          }",
  'scan progressive items'
)

server = replaceOne(
  server,
  "      emitScan()\n    }\n  } finally {",
  "      emitScan(returnItems ? { items: batchItems } : {})\n    }\n  } finally {",
  'scan progressive event'
)

server = replaceOne(
  server,
  "        case 'scan-media': {\n          if (scanState && scanState.active) return respond(ws, id, true, { busy: true })\n          const r = await scanChat(payload.chatId, { queue: false, mode: 'count', returnItems: payload.includeItems })",
  "        case 'scan-media': {\n          if (scanState && scanState.active) {\n            if (scanState.mode === 'count' && String(scanState.chatId) !== String(payload.chatId)) scanState.cancelled = true\n            return respond(ws, id, true, { busy: true })\n          }\n          const r = await scanChat(payload.chatId, { queue: false, mode: 'count', returnItems: payload.includeItems })",
  'scan active-chat preemption'
)

write('server.js', server)

let index = read('public/index.html')
if (!index.includes('telegram-daily-driver.css')) {
  index = replaceOne(index, '<link rel="stylesheet" href="telegram-polish.css?v=1">', '<link rel="stylesheet" href="telegram-polish.css?v=1"><link rel="stylesheet" href="telegram-daily-driver.css?v=1">', 'daily-driver css include')
}
if (!index.includes('telegram-daily-driver.js')) {
  index = replaceOne(index, '<script src="management.js?v=4"></script>', '<script src="management.js?v=4"></script><script src="telegram-daily-driver.js?v=1"></script>', 'daily-driver js include')
}
write('public/index.html', index)

let smoke = read('scripts/rescue-smoke.test.cjs')
if (!smoke.includes('telegram-daily-driver.js')) {
  smoke += `\nconst dailyDriver = fs.readFileSync('public/telegram-daily-driver.js', 'utf8')\nconst dailyDriverCss = fs.readFileSync('public/telegram-daily-driver.css', 'utf8')\nassert.match(server, /batchItems/, 'file scans must stream progressive item batches')\nassert.match(server, /managedPrepareInputFile/, 'attachment sends must have a prepared-upload fallback')\nassert.match(server, /Accept-Ranges/, 'inline media endpoint must support byte ranges')\nassert.match(dailyDriver, /teleDailyFilesItems/, 'files must use a separate per-chat index')\nassert.match(dailyDriver, /hour12:\\s*true/, 'message time must use 12-hour display')\nassert.match(dailyDriver, /teleDailyMergeScanBatch/, 'file UI must merge scan batches without scroll nudges')\nassert.match(dailyDriver, /teleDailyBuildGridCard/, 'file selection/media hotfix must be active')\nassert.match(dailyDriverCss, /#toggle-drawer\\s*\\{\\s*display:\\s*none/, 'download Hide control must be removed from the UI')\nassert.match(html, /telegram-daily-driver\\.js/, 'daily-driver runtime must be loaded')\nassert.match(html, /telegram-daily-driver\\.css/, 'daily-driver stylesheet must be loaded')\n`
}
write('scripts/rescue-smoke.test.cjs', smoke)

console.log('daily-driver v2 patch applied')
