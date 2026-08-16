'use strict'

/* FileGram media presentation policy.
 *
 * File/media thumbnails in the Files workspace are intentionally disabled.
 * They added TDLib cache churn without providing a usable preview experience.
 * Chat/account avatars remain enabled, but their browser cache key is scoped to
 * the owning chat so a recycled/stale TDLib file id can never paint another
 * chat's profile photo.
 */
;(function fileGramMediaPolicy () {
  if (window.__fileGramMediaPolicyInstalled) return
  window.__fileGramMediaPolicyInstalled = true

  const THUMB_SELECTOR = '#media-grid .gthumb img, #messages .media img.thumb'

  function disableThumbRuntime () {
    try {
      if (window.__fileGramThumbObserver) {
        window.__fileGramThumbObserver.disconnect()
        window.__fileGramThumbObserver = null
      }
    } catch {}

    // `loadThumb` is a classic-script global used by both legacy rows and the
    // paged Files renderer. Replacing it here keeps the stable row/index owners
    // untouched while preventing any new thumbnail download request.
    try {
      loadThumb = function fileGramNoThumbs () {}
    } catch {}
  }

  function stripThumbs (root = document) {
    for (const img of root.querySelectorAll ? root.querySelectorAll(THUMB_SELECTOR) : []) {
      const icon = img.previousElementSibling
      if (icon && icon.classList.contains('icon')) icon.classList.remove('hidden')
      img.removeAttribute('src')
      img.removeAttribute('srcset')
      img.remove()
    }
  }

  function scopeAvatar (img) {
    if (!img || !img.classList || !img.classList.contains('tele-final-avatar-image')) return
    let chatId = ''
    const row = img.closest('.chat-item[data-chat-id]')
    if (row) chatId = String(row.dataset.chatId || '')
    else if (img.closest('#fg-chat-avatar')) {
      try { chatId = state && state.activeChatId != null ? String(state.activeChatId) : '' } catch {}
    }
    if (!chatId) return

    const raw = img.getAttribute('src') || ''
    if (!raw || !raw.includes('/api/media-preview/')) return
    try {
      const url = new URL(raw, location.href)
      if (url.searchParams.get('chatId') === chatId) return
      url.searchParams.set('chatId', chatId)
      // A chat-scoped URL prevents an old browser response for a recycled TDLib
      // file id from being reused for a different row.
      img.src = url.pathname + url.search
    } catch {}
  }

  function scopeAvatars (root = document) {
    if (!root.querySelectorAll) return
    for (const img of root.querySelectorAll('.tele-final-avatar-image')) scopeAvatar(img)
  }

  function installObserver () {
    if (!document.documentElement || window.__fileGramMediaPolicyObserver) return
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes' && record.target instanceof HTMLImageElement) {
          scopeAvatar(record.target)
          continue
        }
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue
          if (node.matches && node.matches(THUMB_SELECTOR)) {
            const icon = node.previousElementSibling
            if (icon && icon.classList.contains('icon')) icon.classList.remove('hidden')
            node.remove()
            continue
          }
          stripThumbs(node)
          scopeAvatars(node)
        }
      }
    })
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src']
    })
    window.__fileGramMediaPolicyObserver = observer
  }

  function install () {
    disableThumbRuntime()
    stripThumbs()
    scopeAvatars()
    installObserver()
  }

  install()
  // Later legacy layers may assign loadThumb during startup. Reassert ownership
  // after the current script turn and once after the window finishes loading.
  queueMicrotask(install)
  window.addEventListener('load', install, { once: true })
})()
