'use strict'

// Stable TDLib session bridge. server.js keeps one client reference for the
// lifetime of the process, while TDLib closes a client after logOut(). This
// wrapper keeps the server reference stable and swaps the underlying TDLib
// client after logout so the same process can immediately show a fresh login.

const { EventEmitter } = require('node:events')
const tdl = require('tdl')
const wsModule = require('ws')

const originalCreateClient = tdl.createClient.bind(tdl)
let stableClient = null
let activeClient = null
let createOptions = null
let restarting = null

function waitForAuthorizationClosed (client, timeoutMs = 15000) {
  return new Promise(resolve => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      try { client.off('update', onUpdate) } catch {}
      resolve()
    }
    const onUpdate = update => {
      if (update && update._ === 'updateAuthorizationState' && update.authorization_state && update.authorization_state._ === 'authorizationStateClosed') finish()
    }
    const timer = setTimeout(finish, timeoutMs)
    try { client.on('update', onUpdate) } catch { finish() }
  })
}

function attachRealClient (real) {
  activeClient = real
  real.on('update', update => stableClient.emit('update', update))
  real.on('error', error => stableClient.emit('error', error))
}

function createRealClient () {
  if (!createOptions) throw new Error('TDLib client options are unavailable')
  const real = originalCreateClient(createOptions)
  attachRealClient(real)
  return real
}

class StableTdClient extends EventEmitter {
  invoke (query) {
    if (!activeClient) return Promise.reject(new Error('Telegram client is restarting'))
    return activeClient.invoke(query)
  }

  close () {
    if (!activeClient) return Promise.resolve()
    const current = activeClient
    activeClient = null
    return current.close()
  }

  async restartAfterLogout () {
    if (restarting) return restarting
    restarting = (async () => {
      const old = activeClient
      if (!old) throw new Error('Telegram session is not ready')

      // logOut destroys the authorization key and eventually closes this TDLib
      // client. Do not let server.js reuse that closed instance.
      await old.invoke({ _: 'logOut' })
      await waitForAuthorizationClosed(old)
      try { await old.close() } catch {}
      if (activeClient === old) activeClient = null

      // Create a brand-new TDLib client with the same persistent database/files
      // paths. Its authorization state will naturally become WaitPhoneNumber.
      createRealClient()
      return true
    })().finally(() => { restarting = null })
    return restarting
  }
}

tdl.createClient = function fileGramCreateStableClient (options) {
  if (stableClient) return stableClient
  createOptions = { ...options }
  stableClient = new StableTdClient()
  createRealClient()
  return stableClient
}

// Handle logout before server.js' websocket router. The response is sent only
// after a replacement TDLib client has been created, so subsequent requests
// cannot hit the closed client that logOut() just invalidated.
const OriginalWebSocketServer = wsModule.WebSocketServer
class FileGramSessionWebSocketServer extends OriginalWebSocketServer {
  constructor (options, callback) {
    super(options, callback)
    this.on('connection', socket => {
      const originalOn = socket.on.bind(socket)
      socket.on = function fileGramSocketOn (eventName, listener) {
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
          if (!stableClient) throw new Error('Telegram session is not ready')
          await stableClient.restartAfterLogout()
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: 'response', id, ok: true, data: { ok: true, restarted: true }, error: null }))
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

wsModule.WebSocketServer = FileGramSessionWebSocketServer
