'use strict'

/* On-demand FileGram media viewer.
 *
 * Background thumbnails remain disabled for large-chat stability. A preview is
 * fetched only after the user explicitly clicks the file's icon/name, using the
 * existing range-capable /api/media-preview endpoint. Card/background clicks keep
 * their existing selection semantics.
 */
;(function fileGramMediaPreview () {
  if (window.__fileGramMediaPreviewInstalled) return
  window.__fileGramMediaPreviewInstalled = true

  const $ = selector => document.querySelector(selector)

  function keyParts (key) {
    const raw = String(key || '')
    const at = raw.lastIndexOf(':')
    return at > 0 ? { chatId: raw.slice(0, at), messageId: raw.slice(at + 1) } : null
  }

  function activeIndexItem (parts) {
    if (!parts) return null
    try {
      const index = window.teleFilesIndex
      const snapshot = index && typeof index.snapshot === 'function' ? index.snapshot(parts.chatId) : null
      if (snapshot && Array.isArray(snapshot.items)) {
        const match = snapshot.items.find(item => String(item && item.messageId) === String(parts.messageId))
        if (match) return match
      }
    } catch {}
    try {
      const messages = window.state && Array.isArray(window.state.messages) ? window.state.messages : []
      const message = messages.find(entry => String(entry && (entry.id != null ? entry.id : entry.messageId)) === String(parts.messageId))
      if (message && message.media) return message.media
    } catch {}
    return null
  }

  function itemFromTarget (target) {
    if (!(target instanceof Element)) return null
    const card = target.closest('.gcard[data-key]')
    if (card) return card._item || activeIndexItem(keyParts(card.dataset.key))

    const row = target.closest('#messages .media')
    if (!row) return null
    const checkbox = row.querySelector('input[type="checkbox"][data-key]')
    return checkbox ? activeIndexItem(keyParts(checkbox.dataset.key)) : null
  }

  function previewKind (item) {
    const mime = String(item && item.mime || '').toLowerCase()
    const name = String(item && item.name || '').toLowerCase()
    const type = String(item && item.type || '').toLowerCase()
    if (type === 'photo' || type === 'gif' || type === 'sticker' || mime.startsWith('image/')) return 'image'
    if (type === 'video' || type === 'video_note' || mime.startsWith('video/')) return 'video'
    if (type === 'audio' || type === 'voice' || mime.startsWith('audio/')) return 'audio'
    if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
    return 'other'
  }

  function mediaUrl (item) {
    const fileId = Number(item && item.fileId || 0)
    const params = new URLSearchParams()
    if (item && item.chatId != null) params.set('chatId', String(item.chatId))
    if (item && item.messageId != null) params.set('messageId', String(item.messageId))
    params.set('name', String(item && item.name || 'file'))
    params.set('mime', String(item && item.mime || 'application/octet-stream'))
    return `/api/media-preview/${Number.isSafeInteger(fileId) && fileId > 0 ? fileId : 0}?${params.toString()}`
  }

  function fmtSize (bytes) {
    let value = Math.max(0, Number(bytes || 0))
    const units = ['B', 'KB', 'MB', 'GB', 'TB']
    let unit = 0
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
    return `${unit ? value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2) : Math.round(value)} ${units[unit]}`
  }

  function installStyles () {
    if ($('#fg-media-preview-style')) return
    const style = document.createElement('style')
    style.id = 'fg-media-preview-style'
    style.textContent = `
      .gcard .gthumb,.gcard .gname,#messages .media>.icon,#messages .media .name{cursor:zoom-in}
      .fg-preview-modal{position:fixed;inset:0;z-index:10050;display:flex;align-items:center;justify-content:center;padding:28px;background:rgba(2,7,13,.84);backdrop-filter:blur(8px)}
      .fg-preview-modal.hidden{display:none!important}
      .fg-preview-dialog{width:min(1100px,94vw);height:min(820px,90vh);display:flex;flex-direction:column;overflow:hidden;border:1px solid #25384c;border-radius:16px;background:#0b141f;box-shadow:0 24px 80px rgba(0,0,0,.55)}
      .fg-preview-head{display:flex;align-items:center;gap:12px;min-height:64px;padding:10px 14px 10px 18px;border-bottom:1px solid #1d2b3b}
      .fg-preview-title-wrap{min-width:0;flex:1}.fg-preview-title{font-size:14px;font-weight:700;color:#e7f0fa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fg-preview-meta{margin-top:3px;color:#7890a8;font-size:11px}
      .fg-preview-close{width:38px;height:38px;flex:0 0 auto;border:0;border-radius:10px;background:#142131;color:#a9bdd1;font-size:20px;cursor:pointer}
      .fg-preview-stage{position:relative;min-height:0;flex:1;display:flex;align-items:center;justify-content:center;overflow:auto;background:#050b12}
      .fg-preview-stage img{display:block;max-width:100%;max-height:100%;object-fit:contain}
      .fg-preview-stage video{display:block;width:100%;height:100%;max-height:100%;background:#000;object-fit:contain}
      .fg-preview-stage audio{width:min(720px,82%)}
      .fg-preview-stage iframe{width:100%;height:100%;border:0;background:#fff}
      .fg-preview-state{padding:24px;color:#8fa6bc;text-align:center;font-size:13px}.fg-preview-state.is-error{color:#ff7380}
      .fg-preview-foot{display:flex;align-items:center;justify-content:flex-end;gap:10px;min-height:54px;padding:9px 14px;border-top:1px solid #1d2b3b}
      .fg-preview-open{display:inline-flex;align-items:center;justify-content:center;min-height:34px;padding:0 13px;border:1px solid #2b4158;border-radius:9px;color:#9fc9f5;text-decoration:none;background:#101c29}
      @media(max-width:700px){.fg-preview-modal{padding:8px}.fg-preview-dialog{width:100%;height:96vh;border-radius:12px}}
    `
    document.head.appendChild(style)
  }

  function ensureModal () {
    let modal = $('#fg-media-preview-modal')
    if (modal) return modal
    modal = document.createElement('div')
    modal.id = 'fg-media-preview-modal'
    modal.className = 'fg-preview-modal hidden'
    modal.setAttribute('role', 'dialog')
    modal.setAttribute('aria-modal', 'true')
    modal.innerHTML = `
      <div class="fg-preview-dialog">
        <div class="fg-preview-head"><div class="fg-preview-title-wrap"><div class="fg-preview-title"></div><div class="fg-preview-meta"></div></div><button type="button" class="fg-preview-close" aria-label="Close preview">×</button></div>
        <div class="fg-preview-stage"></div>
        <div class="fg-preview-foot"><a class="fg-preview-open" target="_blank" rel="noopener">Open in browser</a></div>
      </div>`
    document.body.appendChild(modal)
    modal.querySelector('.fg-preview-close').onclick = closePreview
    modal.addEventListener('mousedown', event => { if (event.target === modal) closePreview() })
    return modal
  }

  function closePreview () {
    const modal = $('#fg-media-preview-modal')
    if (!modal) return
    const stage = modal.querySelector('.fg-preview-stage')
    const media = stage && stage.querySelector('video,audio')
    try { if (media) { media.pause(); media.removeAttribute('src'); media.load() } } catch {}
    if (stage) stage.replaceChildren()
    modal.classList.add('hidden')
  }

  function errorState (stage, message) {
    const state = document.createElement('div')
    state.className = 'fg-preview-state is-error'
    state.textContent = message || 'Preview could not be loaded.'
    stage.replaceChildren(state)
  }

  function openPreview (item) {
    if (!item) return
    installStyles()
    const modal = ensureModal()
    const stage = modal.querySelector('.fg-preview-stage')
    const title = modal.querySelector('.fg-preview-title')
    const meta = modal.querySelector('.fg-preview-meta')
    const open = modal.querySelector('.fg-preview-open')
    const url = mediaUrl(item)
    const kind = previewKind(item)

    title.textContent = String(item.name || 'Media preview')
    meta.textContent = [String(item.type || '').replace('_', ' '), fmtSize(item.fileSize || 0)].filter(Boolean).join(' · ')
    open.href = url
    stage.innerHTML = '<div class="fg-preview-state">Preparing preview from Telegram…</div>'
    modal.classList.remove('hidden')

    let media
    if (kind === 'image') {
      media = new Image()
      media.alt = String(item.name || '')
      media.onload = () => stage.replaceChildren(media)
      media.onerror = () => errorState(stage, 'Image preview could not be loaded.')
      media.src = url
      return
    }
    if (kind === 'video') {
      media = document.createElement('video')
      media.controls = true
      media.autoplay = true
      media.playsInline = true
      media.preload = 'metadata'
      media.onloadedmetadata = () => stage.replaceChildren(media)
      media.onerror = () => errorState(stage, 'Video preview could not be loaded or this codec is not supported by the browser.')
      media.src = url
      return
    }
    if (kind === 'audio') {
      media = document.createElement('audio')
      media.controls = true
      media.autoplay = true
      media.preload = 'metadata'
      media.onloadedmetadata = () => stage.replaceChildren(media)
      media.onerror = () => errorState(stage, 'Audio preview could not be loaded.')
      media.src = url
      return
    }
    if (kind === 'pdf') {
      media = document.createElement('iframe')
      media.title = String(item.name || 'PDF preview')
      media.onload = () => stage.replaceChildren(media)
      media.src = url
      return
    }

    errorState(stage, 'This file type has no inline preview. Use Open in browser.')
  }

  /* Capture phase is deliberate: buildGridCard/files-view own card clicks for
   * selection. Preview targets stop before those handlers, while clicking the
   * rest of a card still selects exactly as before. */
  document.addEventListener('click', event => {
    if (!(event.target instanceof Element)) return
    const previewTarget = event.target.closest('.gcard .gthumb,.gcard .gname,#messages .media>.icon,#messages .media .name,#messages .media img.thumb')
    if (!previewTarget) return
    const item = itemFromTarget(previewTarget)
    if (!item) return
    event.preventDefault()
    event.stopPropagation()
    openPreview(item)
  }, true)

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !$('#fg-media-preview-modal')?.classList.contains('hidden')) closePreview()
  })

  installStyles()
  window.FileGramMediaPreview = { open: openPreview, close: closePreview, urlFor: mediaUrl }
})()
