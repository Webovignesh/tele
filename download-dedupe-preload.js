'use strict'

/*
 * Download dedupe preflight.
 *
 * This module is preloaded before server.js and intercepts one private
 * WebSocket request used by the browser UI: `download-dedupe-preview`.
 * It never exposes arbitrary filesystem browsing. The scan root is always the
 * configured Tele downloads directory from settings.json (or ./downloads).
 *
 * A duplicate is considered valid only when BOTH the sanitized filename and
 * the exact byte size match. The same rule is also applied inside the current
 * selection so repeated Telegram items do not get queued twice.
 */

const fs = require('node:fs')
const path = require('node:path')
const { WebSocket } = require('ws')

const ROOT = __dirname
const SETTINGS_PATH = path.join(ROOT, 'settings.json')
const DEFAULT_DOWNLOADS_DIR = path.join(ROOT, 'downloads')
const REQUEST_TYPE = 'download-dedupe-preview'

function sanitize (name) {
  return String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\.+$/g, '')
    .trim()
    .slice(0, 120) || 'file'
}

function configuredDownloadsDir () {
  try {
    const parsed = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
    if (parsed && parsed.downloadsDir) return path.resolve(String(parsed.downloadsDir))
  } catch {}
  return DEFAULT_DOWNLOADS_DIR
}

function signatureFor (name, size) {
  const normalizedName = sanitize(name).toLocaleLowerCase('en-US')
  const bytes = Number(size || 0)
  if (!normalizedName || !Number.isFinite(bytes) || bytes <= 0) return null
  return `${normalizedName}\u0000${bytes}`
}

/* Strips the " (N)" that server.js uniquePath() appends when a name is already
 * taken, so a file saved as "photo (1).jpg" is still recognised as "photo.jpg"
 * being on disk.
 *
 * Without this every collision-renamed copy was invisible to the duplicate check
 * and got downloaded again, which is a real undercount of "already there". The
 * byte size still has to match exactly, so this cannot turn genuinely different
 * files into duplicates - and a file that really is named "photo (1).jpg" with the
 * identical size as "photo.jpg" is the same content anyway. */
function withoutCopySuffix (name) {
  return name.replace(/ \((\d+)\)(\.[^.]*)?$/, '$2')
}

async function walkMatchingFiles (rootDir, wantedSignatures) {
  const matches = new Map()
  let scannedFiles = 0
  let scannedDirs = 0

  /* Names are indexed up front. The previous version tested every file against
   * EVERY wanted signature with startsWith, i.e. files x signatures string
   * comparisons - about 60 million for a 6,000-file folder and a 9,500-file
   * selection. A set lookup makes it O(1) per file. */
  const wantedNames = new Set()
  for (const signature of wantedSignatures) {
    const cut = signature.indexOf('\u0000')
    if (cut > 0) wantedNames.add(signature.slice(0, cut))
  }

  async function walk (dir) {
    let entries
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    scannedDirs++

    for (const entry of entries) {
      if (entry.name === '.thumbs') continue
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      scannedFiles++

      const lowerName = entry.name.toLocaleLowerCase('en-US')
      const baseName = withoutCopySuffix(lowerName)
      const candidateNames = baseName !== lowerName ? [lowerName, baseName] : [lowerName]
      if (!candidateNames.some(name => wantedNames.has(name))) continue

      let stat
      try { stat = await fs.promises.stat(fullPath) } catch { continue }
      if (!stat.isFile()) continue

      for (const name of candidateNames) {
        const signature = `${name}\u0000${stat.size}`
        if (!wantedSignatures.has(signature)) continue
        if (!matches.has(signature)) matches.set(signature, [])
        matches.get(signature).push(fullPath)
        break
      }
    }
  }

  try {
    const rootStat = await fs.promises.stat(rootDir)
    if (rootStat.isDirectory()) await walk(rootDir)
  } catch {
    // A missing downloads folder is equivalent to an empty folder for dedupe.
  }

  return { matches, scannedFiles, scannedDirs }
}

/* rootOverride lets a caller that already knows the destination pass it in, which
 * keeps the tests from having to rewrite settings.json to point the scan somewhere
 * safe. Production callers omit it and the configured downloads dir is used. */
async function buildDedupeReport (rawItems, rootOverride) {
  const startedAt = Date.now()
  const rootDir = rootOverride ? path.resolve(String(rootOverride)) : configuredDownloadsDir()
  const items = []
  const wanted = new Set()

  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    const messageId = String(raw && raw.messageId != null ? raw.messageId : '')
    /* Opaque per-item identity supplied by the caller (chatId:messageId). Results
     * used to be correlated by messageId alone, which two different chats can
     * share. */
    const uid = String(raw && raw.uid != null ? raw.uid : messageId)
    const fileName = sanitize(raw && raw.fileName)
    const fileSize = Number(raw && raw.fileSize || 0)
    const signature = signatureFor(fileName, fileSize)
    const item = { uid, messageId, fileName, fileSize, signature }
    items.push(item)
    if (signature) wanted.add(signature)
  }

  const { matches, scannedFiles, scannedDirs } = await walkMatchingFiles(rootDir, wanted)
  const duplicates = []
  const uniqueMessageIds = []
  const uniqueUids = []
  const unknownSizeMessageIds = []
  const keptSelectionSignatures = new Set()
  let duplicateBytes = 0

  const keep = item => {
    uniqueMessageIds.push(item.messageId)
    uniqueUids.push(item.uid)
  }

  for (const item of items) {
    if (!item.signature) {
      keep(item)
      unknownSizeMessageIds.push(item.messageId)
      continue
    }

    const diskMatches = matches.get(item.signature) || []
    if (diskMatches.length) {
      const existingPath = diskMatches[0]
      duplicates.push({
        uid: item.uid,
        messageId: item.messageId,
        fileName: item.fileName,
        fileSize: item.fileSize,
        reason: 'existing',
        existingPath,
        relativePath: path.relative(rootDir, existingPath) || path.basename(existingPath),
        matchCount: diskMatches.length
      })
      duplicateBytes += item.fileSize
      continue
    }

    if (keptSelectionSignatures.has(item.signature)) {
      duplicates.push({
        uid: item.uid,
        messageId: item.messageId,
        fileName: item.fileName,
        fileSize: item.fileSize,
        reason: 'selection',
        existingPath: null,
        relativePath: null,
        matchCount: 1
      })
      duplicateBytes += item.fileSize
      continue
    }

    keptSelectionSignatures.add(item.signature)
    keep(item)
  }

  return {
    rootPath: rootDir,
    validation: 'filename+size',
    selectedCount: items.length,
    duplicateCount: duplicates.length,
    uniqueCount: uniqueMessageIds.length,
    duplicateBytes,
    scannedFiles,
    scannedDirs,
    scanMs: Date.now() - startedAt,
    unknownSizeCount: unknownSizeMessageIds.length,
    unknownSizeMessageIds,
    uniqueMessageIds,
    uniqueUids,
    duplicates
  }
}

function sendResponse (socket, id, ok, data, error) {
  if (!socket || socket.readyState !== 1) return
  try {
    socket.send(JSON.stringify({
      type: 'response',
      id,
      ok,
      data: ok ? data : null,
      error: ok ? null : String(error || 'Download dedupe scan failed')
    }))
  } catch {}
}

const originalEmit = WebSocket.prototype.emit
WebSocket.prototype.emit = function teleDedupeEmit (eventName, ...args) {
  if (eventName === 'message' && args.length) {
    let request
    try {
      const raw = Buffer.isBuffer(args[0]) ? args[0].toString('utf8') : String(args[0])
      request = JSON.parse(raw)
    } catch {}

    if (request && request.type === REQUEST_TYPE) {
      const socket = this
      Promise.resolve()
        .then(() => buildDedupeReport(request.payload && request.payload.items))
        .then(report => sendResponse(socket, request.id, true, report, null))
        .catch(error => sendResponse(socket, request.id, false, null, error && error.message ? error.message : error))
      // Swallow this private request so server.js doesn't answer "Unknown request".
      return true
    }
  }
  return originalEmit.call(this, eventName, ...args)
}

module.exports = {
  buildDedupeReport,
  configuredDownloadsDir,
  sanitize,
  signatureFor
}
