'use strict'

// Small runtime bridge for session-level commands that need access to the
// TDLib client before server.js closes over it. This keeps logout explicit and
// prevents the normal server message router from also treating it as unknown.

const tdl = require('tdl')
const wsModule = require('ws')

let activeClient = null

const originalCreateClient = tdl.createClient.bind(tdl)
tdl.createClient = function teleSessionCreateClient (options) {
  const client = originalCreateClient(options)
  activeClient = client
  return client
}

const OriginalWebSocketServer = wsModule.WebSocketServer
class TeleSessionWebSocketServer extends OriginalWebSocketServer {
  constructor (options, callback) {
    super(options, callback)
    this.on('connection', socket => {
      const originalOn = socket.on.bind(socket)
      socket.on = function teleSessionSocketOn (eventName, listener) {
        if (eventName !== 'message') return originalOn(eventName, listener)
        return originalOn('message', async raw => {
          let message = null
          try { message = JSON.parse(String(raw)) } catch {}
          if (message && message.type === 'logout') return
          return listener(raw)
        })
      }

      socket.prependListener('message', async raw => {
        let message
        try { message = JSON.parse(String(raw)) } catch { return }
        if (!message || message.type !== 'logout') return
        const id = message.id
        try {
          if (!activeClient) throw new Error('Telegram session is not ready')
          await activeClient.invoke({ _: 'logOut' })
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: 'response', id, ok: true, data: { ok: true }, error: null }))
          }
        } catch (error) {
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: 'response', id, ok: false, data: null, error: String(error && error.message ? error.message : error) }))
          }
        }
      })
    })
  }
}

wsModule.WebSocketServer = TeleSessionWebSocketServer
