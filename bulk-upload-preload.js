'use strict'

/*
 * Bulk upload bootstrap.
 *
 * The ordinary composer already owns /api/chat-attachment/:chatId. Bulk uploads
 * deliberately reuse that URL so cached clients stay compatible, but tag every
 * request with x-filegram-upload-id. This preload registers first and intercepts
 * only tagged requests; all ordinary attachment requests fall through to the
 * original server.js route untouched.
 */

if (!global.__fileGramBulkUploadPreloadInstalled) {
  global.__fileGramBulkUploadPreloadInstalled = true

  const path = require('node:path')
  const tdl = require('tdl')
  const { createBulkUploadHandler } = require('./bulk-upload-server')
  const { ScalableUploadLedger } = require('./bulk-upload-ledger')

  let activeClient = null
  const priorCreateClient = tdl.createClient.bind(tdl)

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

  /* Telegram media truth used to live here, in two endpoints:
   *
   *   GET  /api/filegram/live-media-ids/:chatId
   *   POST /api/filegram/reconcile-message-ids/:chatId
   *
   * Both are gone. `media-truth-v1` in server.js is now the only source, because
   * it reports completeness and accessibility explicitly instead of inferring them
   * from a row count.
   *
   * The live-media endpoint never worked on this host at all: its filter list used
   * the TDLib class names `messageFilterDocument`, `messageFilterPhoto`,
   * `messageFilterVideo`, `messageFilterAudio`, `messageFilterVoiceNote`,
   * `messageFilterAnimation`, `messageFilterVideoNote`, and TDLib has no such
   * classes (it expects the `searchMessagesFilter*` family), so every call threw on
   * the first filter and the route answered HTTP 500 for every chat. Deleting it
   * removes nothing that ever succeeded.
   *
   * `reconcile-message-ids` did work, but it answered a different question - "do
   * these specific ids still exist" - one getMessage per id, which cannot tell an
   * incomplete answer from an empty chat and cannot see files the client never
   * indexed. The history walk in `media-truth-v1` answers the whole question in one
   * pass, so keeping a second, weaker source would only re-create the ambiguity
   * this fix removes.
   *
   * `readJsonBody`, `missingMessageError` and `mapLimit` went with them: they had no
   * other caller in this preload. Bulk upload, the ledger, temporary-message
   * retirement and the health route are untouched. */

  /* The download folder picker used to live here too, as
   * `POST /api/filegram/pick-download-folder` plus `pickWindowsFolder`. It is gone,
   * and `server.js` owns the route now.
   *
   * Two reasons. Reachability: a route registered from a preload only answers if
   * `npm start` happens to wrap express with that preload, which is what let a
   * second copy in `native-folder-picker-preload.js` sit dormant answering 404 for
   * its whole life while nobody noticed there were two. And correctness: this
   * implementation ran `OpenFileDialog` with the synthetic file name
   * `Select this folder` and returned `Split-Path -Parent $d.FileName`, so the
   * answer was derived from whatever the dialog left in the file-name box rather
   * than from the folder the user picked. The server endpoint calls the Windows
   * common item dialog in folder-pick mode and reads the result through
   * `GetDisplayName(SIGDN_FILESYSPATH)`, so there is nothing to derive.
   *
   * `spawn` went with it: nothing else in this preload spawns a process. Bulk
   * upload, the ledger, temporary-message retirement and the health route are
   * untouched. */

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
