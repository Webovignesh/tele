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
    // Reuse existing image if same photo
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

  // Hook into openChat via a PostToolUse-like pattern: watch #chat-title for changes
  const titleEl = document.querySelector('#chat-title')
  if (titleEl) {
    new MutationObserver(updateHeaderAvatar).observe(titleEl, { childList: true, characterData: true, subtree: true })
  }
  // Also fire on initial load
  setTimeout(updateHeaderAvatar, 100)
})()
