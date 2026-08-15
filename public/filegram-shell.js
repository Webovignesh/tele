'use strict'

/* FileGram UI shell — lightweight visual enhancements that do not touch
 * any core logic (indexing, downloads, auth, file counts, pagination).
 * Loaded last, after all stability layers.
 */
;(function fileGramShell () {
  /* ---- Header avatar sync ---- */
  function updateHeaderAvatar () {
    const container = document.querySelector('#fg-chat-avatar')
    if (!container) return
    const chatId = state && state.activeChatId
    if (chatId == null) {
      container.innerHTML = ''
      container.style.background = 'var(--fg-surface-3)'
      return
    }
    const chat = (state.chats || []).find(c => String(c.id) === String(chatId))
    if (!chat) return
    container.style.background = avatarColor(chat.title || '')
    const photoFileId = Number(chat.photoFileId || 0)
    const existing = container.querySelector('img')
    if (existing && existing.dataset.photoId === String(photoFileId)) return
    container.innerHTML = ''
    const fallback = document.createElement('span')
    fallback.textContent = initials(chat.title || 'C')
    container.appendChild(fallback)
    if (!photoFileId) return
    const img = new Image()
    img.dataset.photoId = String(photoFileId)
    img.alt = ''
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;position:absolute;inset:0'
    img.onload = () => { fallback.style.display = 'none'; container.style.position = 'relative' }
    img.onerror = () => img.remove()
    img.src = `/api/media-preview/${encodeURIComponent(String(photoFileId))}?name=avatar.jpg&mime=image%2Fjpeg`
    container.appendChild(img)
  }

  const titleEl = document.querySelector('#chat-title')
  if (titleEl) {
    new MutationObserver(updateHeaderAvatar).observe(titleEl, { childList: true, characterData: true, subtree: true })
  }
  setTimeout(updateHeaderAvatar, 100)

  /* ---- Account name sync ---- */
  function syncAccountName () {
    const userEl = document.querySelector('#user-name')
    const accountEl = document.querySelector('#fg-account-name')
    if (userEl && accountEl) {
      const name = userEl.textContent || ''
      if (name && name !== 'you') accountEl.textContent = name
    }
  }
  const userEl = document.querySelector('#user-name')
  if (userEl) {
    new MutationObserver(syncAccountName).observe(userEl, { childList: true, characterData: true, subtree: true })
  }
  setTimeout(syncAccountName, 500)

  /* ---- Account menu (⋮) triggers logout ---- */
  const menuBtn = document.querySelector('.fg-account-menu')
  if (menuBtn) {
    menuBtn.addEventListener('click', () => {
      const logout = document.querySelector('#tele-logout')
      if (logout) logout.click()
    })
  }
})()
