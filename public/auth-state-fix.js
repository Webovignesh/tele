'use strict'

/* Keep the login screen synchronized with TDLib even when the authorization
 * transition happened before the browser websocket connected. Also owns the
 * small session UX: India-first phone input, explicit logout, FileGram branding,
 * persisted download destination display, and early loading of the final Files
 * stability/page owners.
 */
;(function fileGramAuthStateFix () {
  const DOWNLOAD_DIR_STORAGE_KEY = 'filegram-download-dir-v1'

  function applyBrand () {
    document.title = 'FileGram'
    // Only the name text is rewritten. Setting textContent on the heading would
    // wipe the Telegram mark that ships as static markup inside it.
    document.querySelectorAll('#login-screen h1, #config-screen h1').forEach(el => {
      const name = el.querySelector('.fg-auth-name')
      if (name) name.textContent = 'FileGram'
      else el.textContent = 'FileGram'
    })
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

  function ensureLoginStyles () {
    if (document.querySelector('#filegram-login-polish')) return
    const style = document.createElement('style')
    style.id = 'filegram-login-polish'
    style.textContent = `
      #login-screen .filegram-phone-row{display:flex;width:100%;gap:10px;align-items:stretch}
      #login-screen .filegram-country-code{display:flex;align-items:center;justify-content:center;min-width:82px;padding:0 16px;border:1px solid #53a8ff;border-radius:10px;background:#172332;color:#eef6ff;font:600 17px/1 system-ui,-apple-system,"Segoe UI",sans-serif;box-sizing:border-box;user-select:none}
      #login-screen .filegram-phone-row #login-input{flex:1;min-width:0;margin:0}
      #login-screen .filegram-phone-row + #login-submit{margin-top:16px}
    `
    document.head.appendChild(style)
  }

  function unwrapPhoneInput () {
    const input = document.querySelector('#login-input')
    if (!input) return
    const row = input.closest('.filegram-phone-row')
    if (!row) return
    row.replaceWith(input)
  }

  function installPhoneRow () {
    ensureLoginStyles()
    const input = document.querySelector('#login-input')
    if (!input) return
    let row = input.closest('.filegram-phone-row')
    if (!row) {
      row = document.createElement('div')
      row.className = 'filegram-phone-row'
      const prefix = document.createElement('div')
      prefix.className = 'filegram-country-code'
      prefix.textContent = '+91'
      input.replaceWith(row)
      row.append(prefix, input)
    }
    input.type = 'tel'
    input.inputMode = 'numeric'
    input.autocomplete = 'tel-national'
    input.placeholder = '10-digit phone number'
    input.maxLength = 10
    input.value = normalizeIndianLocalNumber(input.value)
    try { input.focus(); input.setSelectionRange(input.value.length, input.value.length) } catch {}
  }

  function normalizeIndianLocalNumber (value) {
    let digits = String(value || '').replace(/\D/g, '')
    if (digits.startsWith('91') && digits.length > 10) digits = digits.slice(2)
    if (digits.startsWith('0') && digits.length > 10) digits = digits.slice(1)
    return digits.slice(0, 10)
  }

  function codeDeliveryLabel (info) {
    const raw = info && (info.type || info.next_type || info.code_type)
    const type = raw && typeof raw === 'object' ? (raw._ || raw['@type'] || '') : String(raw || '')
    if (/TelegramMessage/i.test(type)) return 'Telegram message'
    if (/Sms/i.test(type)) return 'SMS'
    if (/MissedCall/i.test(type)) return 'missed call'
    if (/Call/i.test(type)) return 'phone call'
    if (/Fragment/i.test(type)) return 'Fragment'
    return ''
  }

  function rememberDownloadDir (dir) {
    const value = String(dir || '').trim()
    if (!value) return
    try { localStorage.setItem(DOWNLOAD_DIR_STORAGE_KEY, value) } catch {}
  }

  function restoreDownloadDirHint () {
    let value = ''
    try { value = localStorage.getItem(DOWNLOAD_DIR_STORAGE_KEY) || '' } catch {}
    if (!value) return
    const input = document.querySelector('#dl-dir')
    const current = document.querySelector('#dl-dir-current')
    if (input && !input.value) input.value = value
    if (current && !current.textContent) {
      current.textContent = `Saving to: ${value}`
      current.title = value
    }
  }

  const originalSetDirLabel = setDirLabel
  setDirLabel = function fileGramSetDirLabel (dir) {
    originalSetDirLabel(dir)
    rememberDownloadDir(dir)
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
      // The shell presents an in-app confirmation dialog and sets this flag
      // before invoking the button, so the native prompt is skipped. Any other
      // caller still gets the confirmation. The logout pipeline below is
      // unchanged.
      const preconfirmed = button.dataset.fgPreconfirmed === '1'
      delete button.dataset.fgPreconfirmed
      if (!preconfirmed && !confirm('Log out of Telegram on this FileGram installation?')) return
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

  function installMessageTabRefreshGuard () {
    if (window.__fileGramMessageTabRefreshGuard || typeof setView !== 'function') return
    window.__fileGramMessageTabRefreshGuard = true
    const baseSetView = setView
    setView = function fileGramMessageFreshSetView (view) {
      const result = baseSetView(view)
      if (view === 'messages') {
        requestAnimationFrame(() => {
          if (state.view === 'messages' && typeof renderMessagesList === 'function') renderMessagesList()
        })
      }
      return result
    }
  }

  function loadFinalStabilityLayer () {
    if (!document.querySelector('link[data-tele-stability]')) {
      const link = document.createElement('link')
      link.rel = 'stylesheet'
      link.href = 'stability.css?v=2'
      link.dataset.teleStability = '1'
      document.head.appendChild(link)
    }
    if (!document.querySelector('script[data-tele-files-stability]')) {
      const script = document.createElement('script')
      script.src = 'files-stability.js?v=2'
      script.dataset.teleFilesStability = '1'
      document.body.appendChild(script)
    }
    if (!document.querySelector('script[data-filegram-files-view]')) {
      const view = document.createElement('script')
      view.src = 'files-view.js?v=2'
      view.dataset.filegramFilesView = '1'
      view.addEventListener('load', () => setTimeout(installMessageTabRefreshGuard, 0), { once: true })
      document.body.appendChild(view)
    }
  }

  function scheduleFinalStabilityLayer () {
    let tries = 0
    const attempt = () => {
      tries++
      const ready = typeof window.rescueFileCache !== 'undefined' || (typeof rescueFileCache !== 'undefined' && rescueFileCache)
      const indexReady = typeof teleP0v2ReadIndex === 'function' && typeof teleP0v2WriteIndex === 'function'
      if (ready && indexReady && typeof rescueEnsureAllFiles === 'function') {
        loadFinalStabilityLayer()
        return
      }
      if (tries < 500) setTimeout(attempt, 0)
      else loadFinalStabilityLayer()
    }
    setTimeout(attempt, 0)
  }

  const originalShowLoginPrompt = showLoginPrompt
  showLoginPrompt = function fileGramShowLoginPrompt (kind, info) {
    applyBrand()
    if (kind !== 'phone') unwrapPhoneInput()
    originalShowLoginPrompt(kind, info)
    const button = document.querySelector('#login-submit')
    if (button) button.disabled = false
    const hint = document.querySelector('#login-hint')
    if (kind === 'phone') {
      if (hint) hint.textContent = 'Enter your Telegram phone number:'
      installPhoneRow()
    } else if (kind === 'code') {
      const delivery = codeDeliveryLabel(info)
      if (hint) hint.textContent = delivery ? `Enter the login code sent via ${delivery}:` : 'Enter your Telegram login code:'
      const input = document.querySelector('#login-input')
      if (input) {
        input.inputMode = 'numeric'
        input.autocomplete = 'one-time-code'
        input.maxLength = 12
        input.placeholder = 'Login code'
      }
    }
  }

  const originalSubmitLoginInput = submitLoginInput
  submitLoginInput = function fileGramSubmitLoginInput () {
    const kind = document.querySelector('#login-hint')?.dataset.kind
    const input = document.querySelector('#login-input')
    if (kind !== 'phone') return originalSubmitLoginInput()

    const localNumber = normalizeIndianLocalNumber(input && input.value)
    const error = document.querySelector('#login-error')
    const button = document.querySelector('#login-submit')
    if (input) input.value = localNumber
    if (error) error.textContent = ''

    if (!/^[6-9]\d{9}$/.test(localNumber)) {
      if (error) error.textContent = 'Enter a valid 10-digit Indian mobile number.'
      if (input) input.focus()
      return
    }

    if (button) button.disabled = true
    request('login-input', { kind: 'phone', value: `+91${localNumber}` })
      .catch(e => {
        if (error) error.textContent = String(e && e.message ? e.message : e)
        if (button) button.disabled = false
      })
  }

  function rebindLoginSubmit () {
    const button = document.querySelector('#login-submit')
    const input = document.querySelector('#login-input')
    if (button) button.onclick = () => submitLoginInput()
    if (input && input.dataset.filegramAuthKey !== '1') {
      input.dataset.filegramAuthKey = '1'
      input.addEventListener('keydown', e => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        submitLoginInput()
      }, true)
    }
  }

  const originalApplyStatus = applyStatus
  applyStatus = function fileGramApplyStatus (data) {
    applyBrand()
    originalApplyStatus(data)
    if (data && data.downloadsDir) rememberDownloadDir(data.downloadsDir)
    if (data && data.status === 'ready') installLogout()
    if (!data || data.status !== 'waiting-input') return
    const kind = promptForAuthState(data.authState)
    if (kind) showLoginPrompt(kind, null)
  }

  const originalHandleEvent = handleEvent
  handleEvent = function fileGramAuthHandleEvent (event) {
    const result = originalHandleEvent(event)
    if (event && event.name === 'auth') queueMicrotask(installLogout)
    return result
  }

  applyBrand()
  restoreDownloadDirHint()
  rebindLoginSubmit()
  scheduleFinalStabilityLayer()
  queueMicrotask(() => {
    installLogout()
    restoreDownloadDirHint()
    rebindLoginSubmit()
    if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) request('get-status').then(applyStatus).catch(() => {})
  })
})()
