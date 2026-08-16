'use strict'

/*
 * Bulk upload bootstrap.
 *
 * The ordinary composer already owns /api/chat-attachment/:chatId. Bulk uploads
 * deliberately reuse that URL so cached clients stay compatible, but tag every
 * request with x-filegram-upload-id. This preload registers first and intercepts
 * only tagged requests; all ordinary attachment requests fall through to the
 * original server.js route untouched.
 *
 * It is loaded after tdl-upload-compat.js, so bulk sendMessage calls use the same
 * proven TDLib InputFile compatibility layer as the rest of FileGram.
 */

if (!global.__fileGramBulkUploadPreloadInstalled) {
  global.__fileGramBulkUploadPreloadInstalled = true

  const path = require('node:path')
  const { spawn } = require('node:child_process')
  const tdl = require('tdl')
  const { createBulkUploadHandler } = require('./bulk-upload-server')
  const { ScalableUploadLedger } = require('./bulk-upload-ledger')

  let activeClient = null
  const priorCreateClient = tdl.createClient.bind(tdl)

  /* TDLib gives an outgoing message a temporary (normally negative) id and then
   * replaces it with the final Telegram id through updateMessageSendSucceeded.
   * server.js already knows how to remove media-index rows when it receives an
   * updateDeleteMessages event, but TDLib does not emit that event for this id
   * replacement. The result was one stale temporary media row plus one final row
   * for every successful upload: 11 real files became 22 in FileGram.
   *
   * `tdl` clients expose `on()` but are not Node EventEmitters, so methods such as
   * prependListener()/emit() are not available. Intercept update subscriptions
   * instead. Any consumer subscribing after this preload receives the synthetic
   * delete immediately before the real send-succeeded update. session-preload.js
   * is one such consumer and forwards both updates through its stable EventEmitter
   * facade to server.js in the correct order.
   */
  function installTemporaryMessageRetirement (client) {
    if (!client || client.__fileGramTemporaryMessageRetirement) return
    if (typeof client.on !== 'function') return
    client.__fileGramTemporaryMessageRetirement = true

    const priorOn = client.on.bind(client)
    client.on = function fileGramRetiringOn (eventName, listener) {
      if (eventName !== 'update' || typeof listener !== 'function') return priorOn(eventName, listener)
      return priorOn('update', update => {
        if (update && !update.__fileGramSyntheticDelete && update._ === 'updateMessageSendSucceeded' &&
            update.message && update.message.chat_id != null && update.old_message_id != null &&
            String(update.old_message_id) !== String(update.message.id)) {
          listener({
            _: 'updateDeleteMessages',
            chat_id: update.message.chat_id,
            message_ids: [update.old_message_id],
            is_permanent: true,
            from_cache: false,
            __fileGramSyntheticDelete: true
          })
        }
        return listener(update)
      })
    }
  }

  tdl.createClient = function createBulkUploadAwareClient (options) {
    const client = priorCreateClient(options)
    activeClient = client
    installTemporaryMessageRetirement(client)
    return client
  }

  function readJsonBody (req, limit = 256 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', chunk => {
        size += chunk.length
        if (size > limit) {
          const error = new Error('Request body is too large')
          error.status = 413
          reject(error)
          try { req.destroy() } catch {}
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (!chunks.length) return resolve({})
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch {
          const error = new Error('Invalid JSON body')
          error.status = 400
          reject(error)
        }
      })
      req.on('error', reject)
    })
  }

  function missingMessageError (error) {
    const code = Number(error && (error.code || error.error_code) || 0)
    const text = String(error && (error.message || error.error_message) || error || '')
    return code === 404 || /message\s+(?:not\s+found|identifier\s+is\s+invalid)|not\s+found/i.test(text)
  }

  async function mapLimit (values, limit, worker) {
    let cursor = 0
    const results = new Array(values.length)
    const runners = Array.from({ length: Math.min(limit, values.length) }, async () => {
      while (cursor < values.length) {
        const index = cursor++
        results[index] = await worker(values[index], index)
      }
    })
    await Promise.all(runners)
    return results
  }

  /* A persistent Files index is intentionally append-friendly so a partial scan
   * can never shrink a 20k-channel to a 100-item page. That same rule means a
   * deletion must be handled explicitly rather than by unioning snapshots.
   *
   * This endpoint verifies ONLY message ids already present in the local index.
   * It never scans history and never downloads media. It lets the browser repair
   * indexes created before deletion-aware reconciliation existed, and is also a
   * safe recovery path when FileGram was offline while Telegram messages were
   * deleted elsewhere. */
  async function reconcileMessageIds (req, res) {
    try {
      if (!activeClient) return res.status(503).json({ ok: false, error: 'Telegram client is not ready' })
      const chatId = Number(req.params.chatId)
      if (!Number.isFinite(chatId)) return res.status(400).json({ ok: false, error: 'Invalid chat id' })
      const body = await readJsonBody(req)
      const rawIds = Array.isArray(body.messageIds) ? body.messageIds : []
      if (!rawIds.length) return res.json({ ok: true, existing: [], missing: [], unknown: [] })
      if (rawIds.length > 1000) return res.status(400).json({ ok: false, error: 'At most 1000 message ids may be reconciled per request' })

      const ids = [...new Set(rawIds.map(value => String(value)).filter(value => /^-?\d+$/.test(value)))]
      const states = await mapLimit(ids, 24, async id => {
        try {
          const message = await activeClient.invoke({ _: 'getMessage', chat_id: chatId, message_id: Number(id) })
          return message && message.id != null ? 'existing' : 'unknown'
        } catch (error) {
          return missingMessageError(error) ? 'missing' : 'unknown'
        }
      })
      const existing = []
      const missing = []
      const unknown = []
      states.forEach((state, index) => {
        if (state === 'existing') existing.push(ids[index])
        else if (state === 'missing') missing.push(ids[index])
        else unknown.push(ids[index])
      })
      return res.json({ ok: true, existing, missing, unknown })
    } catch (error) {
      return res.status(Number(error && error.status || 500)).json({ ok: false, error: String(error && error.message ? error.message : error) })
    }
  }

  function pickWindowsFolder () {
    return new Promise((resolve, reject) => {
      if (process.platform !== 'win32') {
        const error = new Error('Native folder selection is currently available on Windows only')
        error.status = 501
        reject(error)
        return
      }
      const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
        '$dialog.Description = "Select FileGram download folder"',
        '$dialog.ShowNewFolderButton = $true',
        'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath) }'
      ].join('; ')
      const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        try { child.kill() } catch {}
        reject(new Error('Folder picker timed out'))
      }, 5 * 60 * 1000)
      if (timer.unref) timer.unref()
      child.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
      child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })
      child.on('error', error => { clearTimeout(timer); reject(error) })
      child.on('close', code => {
        clearTimeout(timer)
        if (code !== 0) return reject(new Error(stderr.trim() || `Folder picker exited with code ${code}`))
        const selected = stdout.trim()
        resolve(selected || null)
      })
    })
  }

  const expressPath = require.resolve('express')
  const originalExpress = require(expressPath)

  function wrappedExpress (...args) {
    const app = originalExpress(...args)
    const root = __dirname
    const ledger = new ScalableUploadLedger(root)
    const active = new Set()
    const handler = createBulkUploadHandler({ root, getClient: () => activeClient, ledger, active })

    app.post('/api/chat-attachment/:chatId', (req, res, next) => {
      const tagged = req.headers['x-filegram-upload-id']
      if (!tagged) return next()
      req.headers['x-upload-id'] = tagged
      return handler(req, res)
    })

    app.post('/api/filegram/reconcile-message-ids/:chatId', reconcileMessageIds)

    app.post('/api/filegram/pick-download-folder', async (req, res) => {
      try {
        const selectedPath = await pickWindowsFolder()
        res.json({ ok: true, cancelled: !selectedPath, path: selectedPath })
      } catch (error) {
        res.status(Number(error && error.status || 500)).json({ ok: false, error: String(error && error.message ? error.message : error) })
      }
    })

    app.get('/api/bulk-upload-health', async (req, res) => {
      try {
        const auth = activeClient ? await activeClient.invoke({ _: 'getAuthorizationState' }).catch(() => null) : null
        res.json({ ok: true, telegramReady: !!(auth && auth._ === 'authorizationStateReady'), active: active.size })
      } catch (error) {
        res.status(500).json({ ok: false, error: String(error && error.message ? error.message : error) })
      }
    })
    return app
  }

  Object.setPrototypeOf(wrappedExpress, originalExpress)
  for (const key of Object.keys(originalExpress)) wrappedExpress[key] = originalExpress[key]
  require.cache[expressPath].exports = wrappedExpress

  global.__fileGramBulkUpload = {
    getClient: () => activeClient,
    root: path.resolve(__dirname)
  }
}
