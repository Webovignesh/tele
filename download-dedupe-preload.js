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

async function walkMatchingFiles (rootDir, wantedSignatures) {
  const matches = new Map()
  let scannedFiles = 0
  let scannedDirs = 0

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
      let relevant = false
      for (const signature of wantedSignatures) {
        if (signature.startsWith(lowerName + '\u0000')) {
          relevant = true
          break
        }
      }
      if (!relevant) continue

      let stat
      try { stat = await fs.promises.stat(fullPath) } catch { continue }
      if (!stat.isFile()) continue
      const signature = `${lowerName}\u0000${stat.size}`
      if (!wantedSignatures.has(signature)) continue

      if (!matches.has(signature)) matches.set(signature, [])
      matches.get(signature).push(fullPath)
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

async function buildDedupeReport (rawItems) {
  const startedAt = Date.now()
  const rootDir = configuredDownloadsDir()
  const items = []
  const wanted = new Set()

  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    const messageId = String(raw && raw.messageId != null ? raw.messageId : '')
    const fileName = sanitize(raw && raw.fileName)
    const fileSize = Number(raw && raw.fileSize || 0)
    const signature = signatureFor(fileName, fileSize)
    const item = { messageId, fileName, fileSize, signature }
    items.push(item)
    if (signature) wanted.add(signature)
  }

  const { matches, scannedFiles, scannedDirs } = await walkMatchingFiles(rootDir, wanted)
  const duplicates = []
  const uniqueMessageIds = []
  const unknownSizeMessageIds = []
  const keptSelectionSignatures = new Set()
  let duplicateBytes = 0

  for (const item of items) {
    if (!item.signature) {
      uniqueMessageIds.push(item.messageId)
      unknownSizeMessageIds.push(item.messageId)
      continue
    }

    const diskMatches = matches.get(item.signature) || []
    if (diskMatches.length) {
      const existingPath = diskMatches[0]
      duplicates.push({
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
    uniqueMessageIds.push(item.messageId)
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
