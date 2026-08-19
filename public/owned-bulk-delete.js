'use strict'

/* Bulk deletion for Telegram media in chats owned by the signed-in account.
 *
 * The action is deliberately absent for member/admin-only chats. Eligibility is
 * checked through get-chat-management for UI visibility and checked again by the
 * server immediately before deleteMessages. Files/index mutation remains owned by
 * files-stability.js through the existing permanent message-delete event path.
 */
;(function installOwnedBulkDelete () {
  if (window.__fileGramOwnedBulkDeleteInstalled) return
  window.__fileGramOwnedBulkDeleteInstalled = true

  const ELIGIBLE_KINDS = new Set(['channel', 'supergroup', 'group'])
  const permissionCache = new Map()
  const permissionFlights = new Map()
  let permissionToken = 0
  let deleting = false
  let confirmResolver = null

  function currentState () {
    try { return typeof state !== 'undefined' ? state : null } catch { return null }
  }

  function currentChatId () {
    const s = currentState()
    return s && s.activeChatId != null ? s.activeChatId : null
  }

  function selectedItems () {
    const s = currentState()
    if (!s || !(s.selection instanceof Map)) return []
    const chatId = currentChatId()
    const wanted = String(chatId == null ? '' : chatId)
    return [...s.selection.values()].filter(item => item && item.messageId != null && String(item.chatId) === wanted)
  }

  function currentChatTitle () {
    const s = currentState()
    const id = currentChatId()
    const chat = s && Array.isArray(s.chats) ? s.chats.find(item => item && String(item.id) === String(id)) : null
    return chat && chat.title ? String(chat.title) : 'this chat'
  }

  function eligibleInfo (info) {
    return !!(info && info.permissions && info.permissions.isOwner === true && info.chat && ELIGIBLE_KINDS.has(String(info.chat.kind || '')))
  }

  function ensureButton () {
    let button = document.querySelector('#fg-delete-selected-owned')
    if (button) return button
    const actions = document.querySelector('#selection-bar .selection-dock-actions')
    if (!actions) return null
    button = document.createElement('button')
    button.id = 'fg-delete-selected-owned'
    button.type = 'button'
    button.className = 'danger'
    button.textContent = 'Delete selected'
    button.title = 'Permanently delete selected files from your Telegram channel or group'
    button.hidden = true
    button.onclick = deleteSelected
    const download = actions.querySelector('#download-selected')
    if (download && download.parentElement === actions) download.insertAdjacentElement('afterend', button)
    else actions.appendChild(button)
    return button
  }

  function ensureConfirmModal () {
    let modal = document.querySelector('#fg-owned-delete-modal')
    if (modal) return modal
    modal = document.createElement('div')
    modal.id = 'fg-owned-delete-modal'
    modal.className = 'fg-modal hidden'
    modal.hidden = true
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.setAttribute('aria-labelledby', 'fg-owned-delete-title')
    modal.innerHTML = `
      <div class="fg-modal-dialog">
        <h3 class="fg-modal-title" id="fg-owned-delete-title">Delete selected files?</h3>
        <p class="fg-modal-copy" id="fg-owned-delete-copy"></p>
        <div class="fg-modal-actions">
          <button class="fg-modal-cancel" id="fg-owned-delete-cancel" type="button">Cancel</button>
          <button class="danger" id="fg-owned-delete-confirm" type="button">Delete for everyone</button>
        </div>
      </div>`
    document.body.appendChild(modal)

    const settle = value => {
      if (!confirmResolver) return
      const resolve = confirmResolver
      confirmResolver = null
      modal.hidden = true
      modal.classList.add('hidden')
      resolve(value)
    }
    modal.querySelector('#fg-owned-delete-cancel').onclick = () => settle(false)
    modal.querySelector('#fg-owned-delete-confirm').onclick = () => settle(true)
    modal.addEventListener('mousedown', event => { if (event.target === modal) settle(false) })
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !modal.hidden) settle(false)
    })
    return modal
  }

  function confirmDelete (count, title) {
    const modal = ensureConfirmModal()
    if (confirmResolver) confirmResolver(false)
    modal.querySelector('#fg-owned-delete-copy').textContent = `Permanently delete ${count.toLocaleString()} selected file${count === 1 ? '' : 's'} from ${title} for everyone? This cannot be undone.`
    modal.hidden = false
    modal.classList.remove('hidden')
    return new Promise(resolve => { confirmResolver = resolve })
  }

  async function loadPermission (chatId, force = false) {
    const key = String(chatId == null ? '' : chatId)
    if (!key) return null
    const cached = permissionCache.get(key)
    if (!force && cached && Date.now() - cached.at < 30000) return cached.info
    if (!force && permissionFlights.has(key)) return permissionFlights.get(key)
    if (typeof request !== 'function') return null

    const flight = Promise.resolve()
      .then(() => request('get-chat-management', { chatId: Number(chatId) }))
      .then(info => {
        permissionCache.set(key, { at: Date.now(), info })
        return info
      })
      .catch(() => {
        permissionCache.set(key, { at: Date.now(), info: null })
        return null
      })
      .finally(() => permissionFlights.delete(key))
    permissionFlights.set(key, flight)
    return flight
  }

  function paintButton () {
    const button = ensureButton()
    if (!button) return
    const chatId = currentChatId()
    const count = selectedItems().length
    const cached = permissionCache.get(String(chatId == null ? '' : chatId))
    const eligible = count > 0 && cached && eligibleInfo(cached.info)
    button.hidden = !eligible
    button.disabled = deleting || !eligible
    button.textContent = deleting ? `Deleting ${count.toLocaleString()}…` : (count ? `Delete selected (${count.toLocaleString()})` : 'Delete selected')
  }

  function refreshButtonPermission () {
    const chatId = currentChatId()
    const count = selectedItems().length
    paintButton()
    if (chatId == null || !count) return
    const token = ++permissionToken
    loadPermission(chatId).then(() => {
      if (token !== permissionToken || String(currentChatId()) !== String(chatId)) return
      paintButton()
    })
  }

  function syntheticPermanentDelete (chatId, messageIds) {
    try {
      if (typeof handleEvent === 'function') {
        handleEvent({
          name: 'message-delete',
          chatId,
          messageIds: [...messageIds],
          isPermanent: true,
          fromCache: false,
          source: 'owned-bulk-delete'
        })
      }
    } catch {}
  }

  function clearDeletedSelection (chatId, messageIds) {
    const s = currentState()
    if (!s) return
    const ids = new Set(messageIds.map(String))
    let completedChanged = false
    for (const id of ids) {
      const key = `${chatId}:${id}`
      if (s.selection instanceof Map) s.selection.delete(key)
      if (s.selectedMessages instanceof Map) s.selectedMessages.delete(key)
      try {
        if (typeof completed !== 'undefined' && completed instanceof Set && completed.delete(key)) completedChanged = true
      } catch {}
    }
    if (completedChanged) {
      try { if (typeof saveCompleted === 'function') saveCompleted() } catch {}
    }
    for (const checkbox of document.querySelectorAll('#media-grid input[type=checkbox], #messages input[type=checkbox]')) {
      if (checkbox.dataset && ids.has(String((checkbox.dataset.key || '').split(':').pop()))) checkbox.checked = false
    }
    try { if (typeof updateSelectionBar === 'function') updateSelectionBar() } catch {}
  }

  async function deleteSelected () {
    if (deleting) return
    const chatId = currentChatId()
    const items = selectedItems()
    const messageIds = [...new Set(items.map(item => Number(item.messageId)).filter(Number.isSafeInteger))]
    if (chatId == null || !messageIds.length) return

    const freshInfo = await loadPermission(chatId, true)
    if (!eligibleInfo(freshInfo)) {
      paintButton()
      try { if (typeof toast === 'function') toast('Bulk delete is available only for channels and groups you own', 'error') } catch {}
      return
    }

    const title = freshInfo.chat && freshInfo.chat.title ? String(freshInfo.chat.title) : currentChatTitle()
    if (!await confirmDelete(messageIds.length, title)) return

    deleting = true
    paintButton()
    try {
      const response = await fetch(`/api/filegram/owned-bulk-delete/${encodeURIComponent(String(chatId))}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageIds })
      })
      let payload = null
      try { payload = await response.json() } catch { payload = {} }
      if (!response.ok || !payload || payload.ok !== true) throw new Error(String(payload && payload.error || `Delete failed with HTTP ${response.status}`))
      const deletedIds = Array.isArray(payload.messageIds) && payload.messageIds.length ? payload.messageIds : messageIds
      syntheticPermanentDelete(chatId, deletedIds)
      clearDeletedSelection(chatId, deletedIds)
      try { if (typeof toastOk === 'function') toastOk(`Deleted ${deletedIds.length.toLocaleString()} file${deletedIds.length === 1 ? '' : 's'} from ${title}`); else if (typeof toast === 'function') toast(`Deleted ${deletedIds.length.toLocaleString()} files`, 'ok') } catch {}
    } catch (error) {
      try { if (typeof toast === 'function') toast(String(error && error.message ? error.message : error), 'error') } catch {}
    } finally {
      deleting = false
      paintButton()
    }
  }

  function wrapSelectionBar () {
    try {
      if (typeof updateSelectionBar !== 'function' || updateSelectionBar.__fileGramOwnedDeleteWrapped) return false
      const base = updateSelectionBar
      const wrapped = function fileGramOwnedDeleteSelectionBar (...args) {
        const result = base.apply(this, args)
        refreshButtonPermission()
        return result
      }
      wrapped.__fileGramOwnedDeleteWrapped = true
      updateSelectionBar = wrapped
      return true
    } catch { return false }
  }

  ensureButton()
  ensureConfirmModal()
  wrapSelectionBar()
  refreshButtonPermission()

  let tries = 0
  const timer = setInterval(() => {
    ensureButton()
    if (wrapSelectionBar()) refreshButtonPermission()
    if (++tries >= 120) clearInterval(timer)
  }, 50)

  window.FileGramOwnedBulkDelete = {
    refresh: refreshButtonPermission,
    deleteSelected,
    canDeleteActive: async () => eligibleInfo(await loadPermission(currentChatId(), true))
  }
})()
