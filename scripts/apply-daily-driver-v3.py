from pathlib import Path
import re


def read(path):
    return Path(path).read_text()


def write(path, text):
    Path(path).write_text(text)


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label}: expected exactly 1 match, got {count}")
    return text.replace(old, new, 1)


def replace_regex_once(text, pattern, replacement, label):
    compiled = re.compile(pattern, re.S)
    matches = list(compiled.finditer(text))
    if len(matches) != 1:
        raise SystemExit(f"{label}: expected exactly 1 match, got {len(matches)}")
    return compiled.sub(replacement, text, count=1)


server = read('server.js')

old_prepare = r"""async function managedPrepareInputFile (absolutePath, kind) {
  const uploaded = await client.invoke({
    _: 'preliminaryUploadFile',
    file: managedLocalInputFile(absolutePath),
    file_type: managedUploadFileType(kind),
    priority: 32
  })
  const completed = await managedWaitForPreliminaryUpload(uploaded)
  return { _: 'inputFileId', id: completed.id }
}
"""
new_prepare = r"""async function managedPrepareInputFile (absolutePath, kind) {
  const uploaded = await client.invoke({
    _: 'preliminaryUploadFile',
    file: managedLocalInputFile(absolutePath),
    file_type: managedUploadFileType(kind),
    priority: 32
  })
  if (!uploaded || !uploaded.id) throw new Error('Telegram did not return a prepared file id')
  // preliminaryUploadFile intentionally remains incomplete until the file is
  // attached to a message. Use the returned id immediately; waiting for
  // remote.is_uploading_completed here deadlocks the send pipeline.
  return { _: 'inputFileId', id: uploaded.id }
}
"""
server = replace_once(server, old_prepare, new_prepare, 'prepared upload deadlock fix')

scan_v3 = r"""

/* ------------------------------ Chat-scoped media index v3 ------------------------------ */

const mediaIndexScanJobs = new Map()
let mediaIndexScanSerial = 0

function cloneMediaIndexSnapshot (snapshot, extra = {}) {
  return {
    found: Number(snapshot && snapshot.found || 0),
    scanned: Number(snapshot && snapshot.scanned || 0),
    typeCounts: { ...((snapshot && snapshot.typeCounts) || {}) },
    items: Array.isArray(snapshot && snapshot.items) ? snapshot.items.map(item => ({ ...item })) : [],
    cancelled: !!(snapshot && snapshot.cancelled),
    done: !!(snapshot && snapshot.done),
    ...extra
  }
}

function emitMediaIndexProgress (job, items, done) {
  sendAll({
    type: 'event',
    event: {
      name: 'media-index-progress',
      payload: {
        scanId: job.scanId,
        chatId: job.chatId,
        scanned: job.scanned,
        found: job.found,
        typeCounts: { ...job.typeCounts },
        items: Array.isArray(items) ? items : [],
        cancelled: !!job.cancelled,
        done: !!done
      }
    }
  })
}

function cancelMediaIndexScanV3 (chatId) {
  const job = mediaIndexScanJobs.get(String(chatId))
  if (!job) return false
  job.cancelled = true
  return true
}

async function scanMediaIndexV3 (chatId, force = false) {
  const key = String(chatId)
  if (!force) {
    const cached = mediaIndexCache.get(key)
    if (cached && Array.isArray(cached.items)) {
      return cloneMediaIndexSnapshot(cached, { done: true, fromCache: true })
    }
  }

  const existing = mediaIndexScanJobs.get(key)
  if (existing) return existing.promise

  const job = {
    scanId: ++mediaIndexScanSerial,
    chatId,
    cancelled: false,
    scanned: 0,
    found: 0,
    typeCounts: { document: 0, photo: 0, video: 0, gif: 0, audio: 0, voice: 0, video_note: 0, sticker: 0 },
    items: [],
    promise: null
  }

  job.promise = (async () => {
    const seenMessages = new Set()
    let cursor = 0
    emitMediaIndexProgress(job, [], false)

    try {
      for (let iteration = 0; iteration < 100000 && !job.cancelled; iteration++) {
        const history = await client.invoke({
          _: 'getChatHistory',
          chat_id: chatId,
          from_message_id: cursor,
          offset: 0,
          limit: 100,
          only_local: false
        })
        const messages = (history.messages || []).filter(message => message.sending_state === undefined)
        if (!messages.length) break

        const batchItems = []
        let newMessages = 0
        for (const message of messages) {
          const messageKey = String(message.id)
          if (seenMessages.has(messageKey)) continue
          seenMessages.add(messageKey)
          newMessages++
          const media = extractMedia(message)
          if (!media || !media.file) continue
          const file = media.file
          const item = {
            key: `${chatId}:${message.id}`,
            messageId: message.id,
            chatId,
            date: message.date,
            fileId: file.id,
            name: media.name,
            fileSize: file.size || file.expected_size || 0,
            type: media.type,
            mime: media.mime || 'application/octet-stream',
            caption: media.caption || null,
            thumbFileId: mediaThumbFileId(media.thumb),
            thumbUrl: null
          }
          job.items.push(item)
          batchItems.push(item)
          job.found++
          job.typeCounts[media.type] = (job.typeCounts[media.type] || 0) + 1
        }

        job.scanned += newMessages
        const oldest = messages[messages.length - 1]
        const nextCursor = oldest && oldest.id
        emitMediaIndexProgress(job, batchItems, false)
        if (!nextCursor || String(nextCursor) === String(cursor) || newMessages === 0) break
        cursor = nextCursor
        await new Promise(resolve => setImmediate(resolve))
      }

      const snapshot = {
        found: job.found,
        scanned: job.scanned,
        typeCounts: { ...job.typeCounts },
        items: job.items.map(item => ({ ...item })),
        cancelled: !!job.cancelled,
        done: !job.cancelled,
        savedAt: Date.now()
      }
      if (!job.cancelled) mediaIndexCache.set(key, snapshot)
      emitMediaIndexProgress(job, [], true)
      return cloneMediaIndexSnapshot(snapshot)
    } finally {
      if (mediaIndexScanJobs.get(key) === job) mediaIndexScanJobs.delete(key)
    }
  })()

  mediaIndexScanJobs.set(key, job)
  return job.promise
}
"""
marker = '/* ------------------------------ Thumbnails ------------------------------ */'
if 'scanMediaIndexV3' not in server:
    server = replace_once(server, marker, scan_v3 + '\n\n' + marker, 'chat-scoped media index insertion')

preview_replacement = r"""const previewFileInflight = new Map()

async function resolvePreviewFileId (fileId, chatId, messageId) {
  let id = Number(fileId)
  if (!Number.isSafeInteger(id) || id <= 0) id = 0
  let file = id ? await client.invoke({ _: 'getFile', file_id: id }).catch(() => null) : null
  const usable = file && file.local && (file.local.is_downloading_completed || file.local.can_be_downloaded !== false)
  if (usable) return id

  const numericChatId = Number(chatId)
  const numericMessageId = Number(messageId)
  if (Number.isSafeInteger(numericChatId) && Number.isSafeInteger(numericMessageId)) {
    const message = await client.invoke({ _: 'getMessage', chat_id: numericChatId, message_id: numericMessageId }).catch(() => null)
    const media = extractMedia(message)
    if (media && media.file && media.file.id) return media.file.id
  }
  if (id) return id
  throw new Error('Telegram file reference is unavailable')
}

async function ensurePreviewFile (fileId, chatId, messageId) {
  const resolvedId = await resolvePreviewFileId(fileId, chatId, messageId)
  const key = String(resolvedId)
  if (previewFileInflight.has(key)) return previewFileInflight.get(key)

  const work = (async () => {
    const existing = await client.invoke({ _: 'getFile', file_id: resolvedId }).catch(() => null)
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
        if (!file || String(file.id) !== key) return
        const local = file.local || {}
        if (local.is_downloading_completed && local.path) finish(null, local.path)
        else if (local.can_be_downloaded === false && !local.is_downloading_active) finish(new Error('Telegram file is not downloadable'))
      }
      const onUpdate = update => {
        if (!update || update._ !== 'updateFile') return
        inspect(update.file)
      }
      const timer = setTimeout(() => finish(new Error('Telegram could not prepare this media in time')), 120000)
      client.on('update', onUpdate)
      client.invoke({
        _: 'downloadFile',
        file_id: resolvedId,
        priority: 32,
        offset: 0,
        limit: 0,
        synchronous: false
      }).then(inspect).catch(error => finish(error))
    })
  })().finally(() => previewFileInflight.delete(key))

  previewFileInflight.set(key, work)
  return work
}

function previewMimeType (requested, name) {
  const explicit = String(requested || '').trim().toLowerCase()
  if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(explicit)) return explicit
  const extension = path.extname(String(name || '')).toLowerCase()
  return ({
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mov': 'video/quicktime',
    '.m4v': 'video/x-m4v',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.pdf': 'application/pdf'
  })[extension] || 'application/octet-stream'
}

function parsePreviewRange (header, size) {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(header).trim())
  if (!match) return false
  let start = match[1] ? Number(match[1]) : null
  let end = match[2] ? Number(match[2]) : null
  if (start == null && end == null) return false
  if (start == null) {
    const suffix = Math.max(0, end || 0)
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    if (end == null || end >= size) end = size - 1
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return false
  return { start, end }
}

app.get('/api/media-preview/:fileId', async (req, res) => {
  try {
    ensureManagementReady()
    const localPath = await ensurePreviewFile(req.params.fileId, req.query.chatId, req.query.messageId)
    const stat = await fs.promises.stat(localPath)
    if (!stat.isFile() || stat.size <= 0) throw new Error('Prepared media file is empty')

    const name = sanitize(String(req.query.name || path.basename(localPath)))
    const mime = previewMimeType(req.query.mime, name)
    const range = parsePreviewRange(req.headers.range, stat.size)
    res.setHeader('Content-Type', mime)
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.setHeader('Content-Disposition', "inline; filename*=UTF-8''" + encodeURIComponent(name))

    if (range === false) {
      res.status(416)
      res.setHeader('Content-Range', `bytes */${stat.size}`)
      return res.end()
    }

    let stream
    if (range) {
      const length = range.end - range.start + 1
      res.status(206)
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`)
      res.setHeader('Content-Length', String(length))
      if (req.method === 'HEAD') return res.end()
      stream = fs.createReadStream(localPath, { start: range.start, end: range.end })
    } else {
      res.status(200)
      res.setHeader('Content-Length', String(stat.size))
      if (req.method === 'HEAD') return res.end()
      stream = fs.createReadStream(localPath)
    }

    stream.on('error', error => {
      if (!res.headersSent) res.status(500).json({ error: String(error.message || error) })
      else res.destroy(error)
    })
    res.on('close', () => stream.destroy())
    stream.pipe(res)
  } catch (error) {
    res.status(404).json({ error: String(error.message || error) })
  }
})
"""
server = replace_regex_once(
    server,
    r"async function ensurePreviewFile \(fileId\) \{.*?\n\}\n\napp\.get\('/api/media-preview/:fileId',.*?\n\}\)\n",
    preview_replacement,
    'robust preview endpoint'
)

scan_case = r"""        case 'scan-media-v3': {
          const result = await scanMediaIndexV3(payload.chatId, !!payload.force)
          return respond(ws, id, true, result)
        }
        case 'cancel-media-scan-v3':
          return respond(ws, id, true, { cancelled: cancelMediaIndexScanV3(payload.chatId) })
        case 'scan-media': {"""
server = replace_once(server, "        case 'scan-media': {", scan_case, 'v3 media index websocket cases')
write('server.js', server)

index = read('public/index.html')
if 'telegram-daily-driver-v3.css' not in index:
    index = replace_once(
        index,
        '<link rel="stylesheet" href="telegram-daily-driver.css?v=1">',
        '<link rel="stylesheet" href="telegram-daily-driver.css?v=1"><link rel="stylesheet" href="telegram-daily-driver-v3.css?v=1">',
        'v3 stylesheet wiring'
    )
if 'telegram-daily-driver-v3.js' not in index:
    index = replace_once(
        index,
        '<script src="telegram-daily-driver.js?v=1"></script>',
        '<script src="telegram-daily-driver.js?v=1"></script><script src="telegram-daily-driver-v3.js?v=1"></script>',
        'v3 runtime wiring'
    )
write('public/index.html', index)

package = read('package.json')
old_check = '"check": "node --check server.js && node --check public/app.js && node --check public/rescue-runtime.js && node --check public/management.js"'
new_check = '"check": "node --check server.js && node --check public/app.js && node --check public/rescue-runtime.js && node --check public/management.js && node --check public/telegram-daily-driver.js && node --check public/telegram-daily-driver-v3.js"'
if old_check in package:
    package = package.replace(old_check, new_check, 1)
elif 'telegram-daily-driver-v3.js' not in package:
    raise SystemExit('package check script shape changed unexpectedly')
write('package.json', package)

smoke = read('scripts/rescue-smoke.test.cjs')
if "public/telegram-daily-driver-v3.js" not in smoke:
    smoke += r"""

const dailyDriverV3 = fs.readFileSync('public/telegram-daily-driver-v3.js', 'utf8')
const dailyDriverV3Css = fs.readFileSync('public/telegram-daily-driver-v3.css', 'utf8')
assert.match(server, /scanMediaIndexV3/, 'file indexing must be chat scoped')
assert.match(server, /media-index-progress/, 'file indexing must stream progressive batches')
assert.match(server, /previewFileInflight/, 'media preparation requests must be deduplicated')
assert.match(server, /Content-Range/, 'media playback must implement HTTP ranges')
assert.match(server, /return \{ _:\s*'inputFileId', id: uploaded\.id \}/, 'prepared attachment ids must be used without deadlocking on upload completion')
assert.match(dailyDriverV3, /IntersectionObserver/, 'media thumbnails must be lazy loaded')
assert.match(dailyDriverV3, /XMLHttpRequest/, 'attachment upload must expose transfer progress')
assert.match(dailyDriverV3, /teleV3OpenPreview/, 'thumbnail clicks must open the resilient preview viewer')
assert.match(dailyDriverV3, /teleV3UnionSelectionKeys/, 'selection dock count must include message and file selections')
assert.match(dailyDriverV3, /scan-media-v3/, 'client must use chat-scoped file indexing')
assert.match(dailyDriverV3Css, /position:\s*relative\s*!important/, 'selection dock must participate in chat layout')
assert.match(html, /telegram-daily-driver-v3\.js/, 'v3 daily-driver runtime must be loaded')
assert.match(html, /telegram-daily-driver-v3\.css/, 'v3 daily-driver stylesheet must be loaded')
"""
write('scripts/rescue-smoke.test.cjs', smoke)

print('daily-driver v3 patch applied')
