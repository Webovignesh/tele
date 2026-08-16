'use strict'

/*
 * File consistency server bridge.
 *
 * TDLib getMessage() can still return a locally cached object after a message was
 * deleted while FileGram was offline. That makes it unsuitable as the sole
 * authority for repairing a stale persistent Files index. For small indexes we
 * can do something stronger: walk the actual chat history from newest to oldest.
 * Only when the walk reaches the real end of history do we treat absence as proof
 * that an indexed message no longer exists.
 *
 * This preload is intentionally separate from server.js so the stable server
 * remains untouched. It composes with the existing bulk-upload preload.
 */

if (!global.__fileGramConsistencyServerPreloadInstalled) {
  global.__fileGramConsistencyServerPreloadInstalled = true

  const tdl = require('tdl')
  let activeClient = null
  const priorCreateClient = tdl.createClient.bind(tdl)

  tdl.createClient = function fileGramConsistencyAwareClient (options) {
    const client = priorCreateClient(options)
    activeClient = client
    return client
  }

  const expressPath = require.resolve('express')
  const priorExpress = require(expressPath)

  async function walkHistory (chatId, cap = 5000) {
    const seen = new Set()
    let fromMessageId = 0
    let scanned = 0
    let complete = false

    while (scanned < cap) {
      const response = await activeClient.invoke({
        _: 'getChatHistory',
        chat_id: chatId,
        from_message_id: fromMessageId,
        offset: 0,
        limit: 100,
        only_local: false
      })
      const messages = Array.isArray(response && response.messages) ? response.messages : []
      if (!messages.length) {
        complete = true
        break
      }

      for (const message of messages) {
        if (message && message.id != null) seen.add(String(message.id))
      }
      scanned += messages.length

      if (messages.length < 100) {
        complete = true
        break
      }

      const last = messages[messages.length - 1]
      if (!last || last.id == null || String(last.id) === String(fromMessageId)) break
      fromMessageId = last.id

      // Yield between pages so a repair cannot monopolize TDLib on startup.
      await new Promise(resolve => setImmediate(resolve))
    }

    return { seen, scanned, complete }
  }

  function wrappedExpress (...args) {
    const app = priorExpress(...args)

    app.post('/api/filegram/reconcile-small-chat-history/:chatId', async (req, res) => {
      try {
        if (!activeClient) return res.status(503).json({ ok: false, error: 'Telegram client is not ready' })
        const chatId = Number(req.params.chatId)
        if (!Number.isSafeInteger(chatId)) return res.status(400).json({ ok: false, error: 'Invalid chat id' })

        const ids = [...new Set((Array.isArray(req.body && req.body.messageIds) ? req.body.messageIds : [])
          .map(value => String(value))
          .filter(value => /^\d+$/.test(value)))]

        // This endpoint is a repair path, not the normal 20k-channel indexer.
        if (ids.length > 1000) {
          return res.json({ ok: true, complete: false, reason: 'index-too-large', existing: [], missing: [] })
        }

        const history = await walkHistory(chatId, 5000)
        if (!history.complete) {
          return res.json({
            ok: true,
            complete: false,
            reason: 'history-cap-reached',
            scanned: history.scanned,
            existing: ids.filter(id => history.seen.has(id)),
            missing: []
          })
        }

        const existing = ids.filter(id => history.seen.has(id))
        const missing = ids.filter(id => !history.seen.has(id))
        return res.json({ ok: true, complete: true, scanned: history.scanned, existing, missing })
      } catch (error) {
        return res.status(500).json({ ok: false, error: String(error && error.message ? error.message : error) })
      }
    })

    return app
  }

  Object.setPrototypeOf(wrappedExpress, priorExpress)
  for (const name of Object.keys(priorExpress)) wrappedExpress[name] = priorExpress[name]
  require.cache[expressPath].exports = wrappedExpress
}
