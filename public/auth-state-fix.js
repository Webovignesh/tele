'use strict'

/* Keep the login screen synchronized with TDLib even when the authorization
 * transition happened before the browser websocket connected. Also owns the
 * small session UX: India-first phone input, explicit logout, FileGram branding,
 * and the final stability layer loader.
 */
;(function fileGramAuthStateFix () {
  function applyBrand () {
    document.title = 'FileGram'
    document.querySelectorAll('#login-screen h1, #config-screen h1').forEach(el => { el.textContent = 'FileGram' })
    const boot = document.querySelector('#boot-status')
    if (boot && /Tele/i.test(boot.textContent || '')) boot.textContent = 'Connecting to FileGram…'
  }

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

  function defaultIndiaPhone (input) {
    if (!input) return
    if (!String(input.value || '').trim()) input.value = '+91'
    try {
      const end = input.value.length
      input.setSelectionRange(end, end)
    } catch {}
  }

  function installLogout () {
    if (document.querySelector('#tele-logout')) return
    const head = document.querySelector('.sidebar-head')
    if (!head) return
    const account = document.createElement('div')
    account.className = 'tele-account-actions'
    const button = document.createElement('button')
    button.id = 'tele-logout'
    button.type = 'button'
    button.className = 'ghost small tele-logout'
    button.textContent = 'Log out'
    button.title = 'Log out of Telegram on this FileGram installation'
    button.addEventListener('click', async () => {
      if (button.disabled) return
      if (!confirm('Log out of Telegram on this FileGram installation?')) return
      button.disabled = true
      button.textContent = 'Logging out…'
      try {
        await request('logout', {})
        state.status = 'waiting-input'
        state.chats = []
        state.activeChatId = null
        state.messages = []
        state.selection.clear()
        state.selectedMessages.clear()
        const list = document.querySelector('#chat-list')
        if (list) list.innerHTML = ''
        const count = document.querySelector('#chat-count')
        if (count) count.textContent = '0 channels'
        showLoginPrompt('phone', null)
      } catch (error) {
        button.disabled = false
        button.textContent = 'Log out'
        toast(error && error.message ? error.message : 'Logout failed', 'error')
      }
    })
    account.appendChild(button)
    head.appendChild(account)
  }

  function loadFinalStabilityLayer () {
    if (!document.querySelector('link[data-tele-stability]')) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = 'stability.css?v=1'
      link.dataset.teleStability = '1'
      document.head.appendChild(link)
    }
    if (!document.querySelector('script[data-tele-files-stability]')) {
      const script = document.createElement('script')
      script.src = 'files-stability.js?v=1'
      script.dataset.teleFilesStability = '1'
      document.body.appendChild(script)
    }
  }

  const originalShowLoginPrompt = showLoginPrompt
  showLoginPrompt = function fileGramShowLoginPrompt (kind, info) {
    applyBrand()
    originalShowLoginPrompt(kind, info)
    const button = document.querySelector('#login-submit')
    if (button) button.disabled = false
    if (kind === 'phone') {
      const input = document.querySelector('#login-input')
      defaultIndiaPhone(input)
      const hint = document.querySelector('#login-hint')
      if (hint) hint.textContent = 'Enter your Telegram phone number. India (+91) is prefilled; replace it if needed:'
    }
  }

  const originalApplyStatus = applyStatus
  applyStatus = function fileGramApplyStatus (data) {
    applyBrand()
    originalApplyStatus(data)
    if (data && data.status === 'ready') installLogout()
    if (!data || data.status !== 'waiting-input') return
    const kind = promptForAuthState(data.authState)
    if (kind) showLoginPrompt(kind, null)
  }

  const originalHandleEvent = handleEvent
  handleEvent = function fileGramAuthHandleEvent (event) {
    const result = originalHandleEvent(event)
    if (event && event.name === 'auth') queueMicrotask(installLogout)
    if (event && event.name === 'login-prompt' && event.kind === 'phone') {
      queueMicrotask(() => defaultIndiaPhone(document.querySelector('#login-input')))
    }
    return result
  }

  applyBrand()
  queueMicrotask(() => {
    installLogout()
    if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
      request('get-status').then(applyStatus).catch(() => {})
    }
  })

  if (document.readyState === 'complete') loadFinalStabilityLayer()
  else window.addEventListener('load', loadFinalStabilityLayer, { once: true })
})()
