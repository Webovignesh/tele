'use strict'

// Tele thumbnails belong to Telegram's own cache, not the user's selected
// download folder. Older builds created <downloads>/.thumbs and copied every
// preview there. The browser now streams thumbnail file ids through the normal
// media endpoint, so block and remove that legacy cache directory.

const fs = require('node:fs')
const path = require('node:path')

function isLegacyThumbDir (target) {
  try { return path.basename(path.resolve(String(target))) === '.thumbs' } catch { return false }
}

function removeLegacyThumbDir (target) {
  try { fs.rmSync(target, { recursive: true, force: true }) } catch {}
}

const originalMkdirSync = fs.mkdirSync.bind(fs)
fs.mkdirSync = function teleNoDownloadThumbDir (target, options) {
  if (isLegacyThumbDir(target)) {
    removeLegacyThumbDir(target)
    return String(target)
  }
  return originalMkdirSync(target, options)
}

const originalMkdir = fs.promises.mkdir.bind(fs.promises)
fs.promises.mkdir = async function teleNoDownloadThumbDirAsync (target, options) {
  if (isLegacyThumbDir(target)) {
    removeLegacyThumbDir(target)
    return String(target)
  }
  return originalMkdir(target, options)
}

// Clean the path saved by the previous build immediately on startup.
try {
  const settingsPath = path.join(__dirname, 'settings.json')
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  if (settings && settings.downloadsDir) {
    removeLegacyThumbDir(path.join(path.resolve(String(settings.downloadsDir)), '.thumbs'))
  }
} catch {}
