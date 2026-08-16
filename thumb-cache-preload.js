'use strict'

// FileGram does not persist file/media thumbnails. Older builds created
// <downloads>/.thumbs and copied Telegram preview files there. Keep those paths
// impossible to recreate and remove any leftovers on startup.

const fs = require('node:fs')
const path = require('node:path')

function isLegacyThumbDir (target) {
  try { return path.basename(path.resolve(String(target))) === '.thumbs' } catch { return false }
}

function removeLegacyThumbDir (target) {
  try { fs.rmSync(target, { recursive: true, force: true }) } catch {}
}

const originalMkdirSync = fs.mkdirSync.bind(fs)
fs.mkdirSync = function fileGramNoThumbDir (target, options) {
  if (isLegacyThumbDir(target)) {
    removeLegacyThumbDir(target)
    return String(target)
  }
  return originalMkdirSync(target, options)
}

const originalMkdir = fs.promises.mkdir.bind(fs.promises)
fs.promises.mkdir = async function fileGramNoThumbDirAsync (target, options) {
  if (isLegacyThumbDir(target)) {
    removeLegacyThumbDir(target)
    return String(target)
  }
  return originalMkdir(target, options)
}

// Repo-local leftovers from old builds.
removeLegacyThumbDir(path.join(__dirname, '.thumbs'))
removeLegacyThumbDir(path.join(__dirname, 'downloads', '.thumbs'))

// Saved download destination from the previous/current installation.
try {
  const settingsPath = path.join(__dirname, 'settings.json')
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  if (settings && settings.downloadsDir) {
    removeLegacyThumbDir(path.join(path.resolve(String(settings.downloadsDir)), '.thumbs'))
  }
} catch {}
