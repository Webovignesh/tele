'use strict'

/* Download reliability boundary.
 *
 * Selected Files rows can come from FileGram's persistent per-chat index. Their
 * chatId/messageId is durable Telegram identity; their numeric TDLib fileId is not
 * treated as durable. Intercept start-download before server.js sees it, resolve
 * every selected message against current Telegram state, register each available
 * File.remote.id with TDLib, then forward only the resulting current numeric file
 * references to the existing DownloadManager.
 *
 * This is global for every chat. It is deliberately not a channel-specific patch.
 */

if (!global.__fileGramDownloadReliabilityPreloadInstalled) {
  global.__fileGramDownloadReliabilityPreloadInstalled = true

  const fs = require('node:fs')
  const path = require('node:path')
  const { WebSocket } = require('ws')
  const { resolveDownloadItems } = require('./download-reference-resolver')

  const REQUEST_TYPE = 'start-download'
  const TD_FILES_DIR = path.resolve(__dirname, '.td_files')

  function activeClient () {
    try {
      const bridge = global.__fileGramBulkUpload
      return bridge && typeof bridge.getClient === 'function' ? bridge.getClient() : null
    } catch {
      return null
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
        error: ok ? null : String(error || 'Could not prepare the selected downloads')
      }))
    } catch {}
  }

  function sendEvent (socket, name, payload) {
    if (!socket || socket.readyState !== 1) return
    try { socket.send(JSON.stringify({ type: 'event', event: { name, payload } })) } catch {}
  }

  function decodeMessageRequest (value) {
    try {
      const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value)
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  function encodeRequest (request, original) {
    const text = JSON.stringify(request)
    return Buffer.isBuffer(original) ? Buffer.from(text) : text
  }

  function inside (child, parent) {
    const relative = path.relative(parent, child)
    return relative === '' || (!!relative && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
  }

  /* TDLib owns everything under .td_files. server.js historically attempts a
   * rename first when the selected destination happens to be on the same volume,
   * which removes the cache path behind TDLib's back before deleteFile runs.
   *
   * The previous safety shim changed that rename into copyFile(). Correct, but a
   * large completed video then kept one of FileGram's download slots occupied for
   * the entire disk copy. If several parallel videos completed together all slots
   * could become disk-finalization work at once, making network throughput fall to
   * zero until those copies finished: fast -> pause -> fast.
   *
   * On the same filesystem a hard link gives us the safe semantics we actually
   * need: the destination gets its own directory entry to the already-downloaded
   * bytes almost instantly, then server.js calls TDLib deleteFile(), which removes
   * TDLib's cache name without affecting the destination link. No byte-for-byte
   * copy and no cache ownership violation. If hard-linking is unavailable (most
   * importantly cross-volume destinations, but also filesystems/policies that do
   * not support links), fall back to the proven copy path. */
  const originalRename = fs.promises.rename.bind(fs.promises)
  fs.promises.rename = async function fileGramTdlibSafeRename (source, destination) {
    const from = path.resolve(String(source))
    const to = path.resolve(String(destination))
    if (inside(from, TD_FILES_DIR) && !inside(to, TD_FILES_DIR)) {
      try {
        await fs.promises.link(from, to)
        return
      } catch (error) {
        // EXDEV is the normal cross-volume case. EPERM/ENOTSUP/EACCES can occur on
        // filesystems or corporate policies that disallow hard links. Copy is the
        // safe universal fallback for all of them.
        await fs.promises.copyFile(from, to)
        return
      }
    }
    return originalRename(source, destination)
  }

  const previousEmit = WebSocket.prototype.emit
  WebSocket.prototype.emit = function fileGramDownloadReliabilityEmit (eventName, ...args) {
    if (eventName !== 'message' || !args.length) return previousEmit.call(this, eventName, ...args)

    const request = decodeMessageRequest(args[0])
    if (!request || request.type !== REQUEST_TYPE) return previousEmit.call(this, eventName, ...args)

    const socket = this
    const payload = request.payload || {}
    const selected = Array.isArray(payload.items) ? payload.items : []
    if (!selected.length) return previousEmit.call(this, eventName, ...args)

    Promise.resolve()
      .then(async () => {
        const client = activeClient()
        if (!client) throw new Error('Telegram session is not ready')
        const report = await resolveDownloadItems({
          client,
          chatId: payload.chatId,
          items: selected,
          onProgress: progress => {
            if (selected.length < 500) return
            sendEvent(socket, 'download-reference-progress', {
              selected: selected.length,
              scanned: progress.scanned,
              resolved: progress.resolved,
              remaining: progress.remaining,
              registered: Math.max(0, Number(progress.registered || 0))
            })
          }
        })

        console.log(`[downloads] reference preflight selected=${report.selected} registered=${report.registered} numeric_refreshed=${report.refreshed} unavailable=${report.missing.length} queued=${report.items.length}`)

        sendEvent(socket, 'download-reference-repair', {
          selected: report.selected,
          refreshed: report.refreshed,
          registered: report.registered,
          missing: report.missing.length,
          queued: report.items.length,
          source: report.source
        })

        if (!report.items.length) {
          throw new Error('None of the selected files are still available in this Telegram chat')
        }

        const forwarded = {
          ...request,
          payload: {
            ...payload,
            items: report.items
          }
        }
        const forwardedArgs = [encodeRequest(forwarded, args[0]), ...args.slice(1)]
        previousEmit.call(socket, eventName, ...forwardedArgs)
      })
      .catch(error => sendResponse(socket, request.id, false, null, error && error.message ? error.message : error))

    return true
  }

  module.exports = { TD_FILES_DIR, inside }
}
