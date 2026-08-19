'use strict'

/*
 * Storage cleanup that runs before server.js creates the TDLib client.
 *
 * TDLib owns .td_files and requires its temp directory while the client is
 * running. The temp contents are not durable application data, though, and can
 * survive an unclean shutdown or interrupted transfer.
 *
 * FileGram's /api/chat-attachment route also stages browser uploads inside
 * .management_uploads. A server crash can strand a partial staging directory.
 * The browser upload queue is authoritative and will retry from the original
 * File/FileSystemHandle, so those stranded staging copies are disposable too.
 *
 * Startup is the one safe point to purge both locations: no TDLib file operation
 * or attachment request can be using them yet.
 */

const fs = require('node:fs')
const path = require('node:path')

const root = __dirname
const tempDir = path.join(root, '.td_files', 'temp')
const managementUploadDir = path.join(root, '.management_uploads')

function purgeDisposableDir (dir, label) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    // Startup must never fail because antivirus or another process still has a
    // stale file open. The next launch will try again.
    if (process.env.FILEGRAM_STORAGE_DEBUG === '1') {
      console.warn(`[storage] could not purge ${label}:`, error && error.message ? error.message : error)
    }
  }
}

purgeDisposableDir(tempDir, 'TDLib temp')
purgeDisposableDir(managementUploadDir, 'stale attachment staging')
