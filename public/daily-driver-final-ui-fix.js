'use strict'

/* Last-mile UI normalization. This file intentionally loads after the final
 * stability guard so old rescue layers cannot reintroduce stale emoji icons or
 * malformed dedupe validation markup. */
;(function teleFinalUiFix () {
  const iconSvg = {
    channel: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11v2a2 2 0 0 0 2 2h2l4 3V6L8 9H6a2 2 0 0 0-2 2Z"/><path d="M16 9a4 4 0 0 1 0 6"/></svg>',
    group: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M2.5 21a6.5 6.5 0 0 1 13 0"/><path d="M17 11a3 3 0 1 0 0-6"/><path d="M18 14a5 5 0 0 1 3.5 4.8"/></svg>',
    supergroup: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"/><path d="M2.5 21a6.5 6.5 0 0 1 13 0"/><path d="M17 11a3 3 0 1 0 0-6"/><path d="M18 14a5 5 0 0 1 3.5 4.8"/></svg>',
    private: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/></svg>',
    other: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-5 4v-4.8A2.5 2.5 0 0 1 4 13.5v-8Z"/></svg>'
  }

  function chatById (id) {
    return (state.chats || []).find(chat => String(chat && chat.id) === String(id)) || null
  }

  function normalizeChatMeta () {
    const list = document.querySelector('#chat-list')
    if (!list) return
    for (const row of list.querySelectorAll('.chat-item[data-chat-id]')) {
      const chat = chatById(row.dataset.chatId)
      if (!chat) continue
      const unread = Math.max(0, Number(chat.unread || 0))
      const kind = iconSvg[chat.kind] ? chat.kind : 'other'
      const signature = `${kind}:${unread}`
      const meta = row.querySelector('.u')
      if (!meta || meta.dataset.teleUiSignature === signature) continue
      meta.dataset.teleUiSignature = signature
      meta.classList.add('tele-ui-chat-meta')
      meta.innerHTML = `<span class="tele-ui-kind-icon tele-ui-kind-${kind}" title="${kind === 'channel' ? 'Channel' : kind === 'private' ? 'Private chat' : kind === 'group' || kind === 'supergroup' ? 'Group' : 'Chat'}">${iconSvg[kind]}</span>${unread ? `<span class="tele-ui-unread">${unread.toLocaleString()}</span>` : ''}`
    }
  }

  function normalizeSearchIcon () {
    const icon = document.querySelector('#files-toolbar .search-icon')
    if (!icon || icon.dataset.teleUiFixed === '1') return
    icon.dataset.teleUiFixed = '1'
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>'
  }

  function normalizeDedupeValidation () {
    const validation = document.querySelector('#tele-dedupe-body .tele-dedupe-validation')
    if (!validation || validation.dataset.teleUiFixed === '1') return

    const strong = validation.querySelector('strong')
    const detail = validation.querySelector('div span')
    const labelText = strong && strong.textContent ? strong.textContent.trim() : 'Exact filename + exact byte size'
    const detailText = detail && detail.textContent ? detail.textContent.trim() : ''

    const check = document.createElement('span')
    check.className = 'tele-dedupe-check tele-ui-dedupe-check'
    check.setAttribute('aria-hidden', 'true')
    check.textContent = '✓'

    const copy = document.createElement('div')
    copy.className = 'tele-ui-dedupe-copy'
    const label = document.createElement('strong')
    label.textContent = labelText
    const sub = document.createElement('span')
    sub.className = 'tele-ui-dedupe-detail'
    sub.textContent = detailText
    copy.append(label, sub)

    validation.replaceChildren(check, copy)
    validation.dataset.teleUiFixed = '1'
  }

  const baseDedupeRender = typeof teleP1RenderDedupeReport === 'function' ? teleP1RenderDedupeReport : null
  if (baseDedupeRender) {
    teleP1RenderDedupeReport = function teleUiRenderDedupeReport (report) {
      const result = baseDedupeRender(report)
      queueMicrotask(normalizeDedupeValidation)
      return result
    }
  }

  const list = document.querySelector('#chat-list')
  if (list) {
    let scheduled = false
    const schedule = () => {
      if (scheduled) return
      scheduled = true
      requestAnimationFrame(() => {
        scheduled = false
        normalizeChatMeta()
      })
    }
    new MutationObserver(schedule).observe(list, { childList: true, subtree: true, characterData: true })
  }

  const body = document.querySelector('#tele-dedupe-body')
  if (body) new MutationObserver(normalizeDedupeValidation).observe(body, { childList: true, subtree: true })

  normalizeSearchIcon()
  normalizeChatMeta()
  normalizeDedupeValidation()
})()
