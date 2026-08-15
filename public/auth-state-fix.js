'use strict'

/* Keep the login screen synchronized with TDLib even when the authorization
 * transition happened before the browser websocket connected. get-status
 * already exposes authState; convert that state into the same explicit prompt
 * used by realtime login-prompt events.
 */
;(function teleAuthStateFix () {
  const promptForAuthState = (authState) => {
    switch (String(authState || '')) {
      case 'authorizationStateWaitPhoneNumber': return 'phone'
      case 'authorizationStateWaitCode': return 'code'
      case 'authorizationStateWaitPassword': return 'password'
      case 'authorizationStateWaitOtherDeviceConfirmation': return 'other-device'
      case 'authorizationStateWaitRegistration': return 'registration'
      default: return null
    }
  }

  const originalShowLoginPrompt = showLoginPrompt
  showLoginPrompt = function teleShowLoginPrompt (kind, info) {
    originalShowLoginPrompt(kind, info)
    const button = document.querySelector('#login-submit')
    if (button) button.disabled = false
  }

  const originalApplyStatus = applyStatus
  applyStatus = function teleApplyStatus (data) {
    originalApplyStatus(data)
    if (!data || data.status !== 'waiting-input') return
    const kind = promptForAuthState(data.authState)
    if (kind) showLoginPrompt(kind, null)
  }

  // If app.js opened the websocket before this last-mile patch loaded, replay
  // current status once so the generic "Logging in…" placeholder cannot stick.
  queueMicrotask(() => {
    if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
      request('get-status').then(applyStatus).catch(() => {})
    }
  })
})()
