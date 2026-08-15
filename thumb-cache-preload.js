'use strict'

// Keep Telegram preview/avatar cache out of the repository and out of the
// user's selected download folder. TDLib requires a filesystem-backed files
// directory, so use a disposable OS-temp directory and purge it between runs.
// Final user downloads are moved by server.js into the configured downloadsDir.

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const tdl = require('tdl')

const TEMP_TDL_FILES = path.join(os.tmpdir(), 'tele-scraper-td-files')

function removeDir (target) {
  try { fs.rmSync(target, { recursive: true, force: true }) } catch {}
}

function isLegacyThumbDir (target) {
  try { return path.basename(path.resolve(String(target))) === '.thumbs' } catch { return false }
}

// Remove stale transient Telegram files from previous runs before TDLib starts.
removeDir(TEMP_TDL_FILES)
try { fs.mkdirSync(TEMP_TDL_FILES, { recursive: true }) } catch {}

// Older builds created <downloads>/.thumbs. Block that path permanently.
const originalMkdirSync = fs.mkdirSync.bind(fs)
fs.mkdirSync = function teleNoDownloadThumbDir (target, options) {
  if (isLegacyThumbDir(target)) {
    removeDir(target)
    return String(target)
  }
  return originalMkdirSync(target, options)
}

const originalMkdir = fs.promises.mkdir.bind(fs.promises)
fs.promises.mkdir = async function teleNoDownloadThumbDirAsync (target, options) {
  if (isLegacyThumbDir(target)) {
    removeDir(target)
    return String(target)
  }
  return originalMkdir(target, options)
}

// server.js still passes its historical .td_files path. Override only TDLib's
// filesDirectory so media needed for thumbnails, avatars and in-progress file
// transfers lives in OS temp storage rather than inside the repo.
const originalCreateClient = tdl.createClient.bind(tdl)
tdl.createClient = function teleCreateClientWithEphemeralFiles (options) {
  return originalCreateClient({ ...options, filesDirectory: TEMP_TDL_FILES })
}

// Clean the legacy download-folder thumbnail cache immediately on startup.
try {
  const settingsPath = path.join(__dirname, 'settings.json')
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  if (settings && settings.downloadsDir) {
    removeDir(path.join(path.resolve(String(settings.downloadsDir)), '.thumbs'))
  }
} catch {}

// Also remove the old repo-local TDLib cache. It is not used by this build.
removeDir(path.join(__dirname, '.td_files'))

function cleanupTempFiles () {
  removeDir(TEMP_TDL_FILES)
}

process.once('exit', cleanupTempFiles)
process.once('SIGINT', () => {
  cleanupTempFiles()
  process.exit(130)
})
process.once('SIGTERM', () => {
  cleanupTempFiles()
  process.exit(143)
})
