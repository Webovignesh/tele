'use strict'

/*
 * TDLib owns .td_files and requires its temp directory while the client is
 * running. The temp contents are not durable application data, though, and can
 * survive an unclean shutdown or an interrupted download.
 *
 * This preload runs before server.js creates the TDLib client, which is the one
 * safe point where FileGram can remove stale temp contents without racing an
 * active TDLib file operation. TDLib may recreate .td_files/temp during the
 * session; those live files must be left alone until the next startup.
 */

const fs = require('node:fs')
const path = require('node:path')

const root = __dirname
const filesDir = path.join(root, '.td_files')
const tempDir = path.join(filesDir, 'temp')

function purgeTdlibTemp () {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true })
  } catch (error) {
    // Startup must never fail because a stale cache file is locked. TDLib can
    // reuse/recreate the directory and the next launch will try again.
    if (process.env.FILEGRAM_STORAGE_DEBUG === '1') {
      console.warn('[storage] could not purge TDLib temp:', error && error.message ? error.message : error)
    }
  }
}

purgeTdlibTemp()
