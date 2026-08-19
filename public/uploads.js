'use strict'

/* Compatibility entrypoint kept because index.html and older cached shells load
 * uploads.js. The production implementation lives in bulk-uploads.js. */
;(function loadFileGramBulkUploads () {
  if (window.__fileGramBulkUploadsLoaderInstalled) return
  window.__fileGramBulkUploadsLoaderInstalled = true

  /* uploads.css is intentionally loaded after the main design system. Keep the
   * upload-stat geometry from that layer, but make the download drawer contract
   * explicit here. The concurrency control is intentionally FLEX, not grid: the
   * generic `.dl-controls .row` rule is a two-column grid and can otherwise give
   * the range only half of the drawer. */
  if (!document.getElementById('fg-drawer-layout-fix')) {
    const style = document.createElement('style')
    style.id = 'fg-drawer-layout-fix'
    style.textContent = `
      .downloads #set-dir.fg-save-to,
      #mg-downloads-pane #set-dir.fg-save-to {
        display:flex!important;
        align-items:center!important;
        gap:12px!important;
        width:100%!important;
        min-width:0!important;
        min-height:58px!important;
        margin:0!important;
        padding:10px 12px!important;
        overflow:hidden!important;
      }
      .downloads #set-dir.fg-save-to .fg-save-to-copy,
      #mg-downloads-pane #set-dir.fg-save-to .fg-save-to-copy {
        display:flex!important;
        flex:1 1 auto!important;
        min-width:0!important;
        flex-direction:column!important;
        gap:2px!important;
      }
      #mg-downloads-pane .dl-controls .conc:has(#concurrency),
      .downloads .dl-controls .conc:has(#concurrency) {
        display:flex!important;
        flex-direction:column!important;
        width:100%!important;
        min-width:0!important;
        align-self:stretch!important;
        gap:10px!important;
        margin:24px 0 0!important;
        padding:20px 0 0!important;
        border-top:1px solid var(--fg-border,#203147)!important;
        box-sizing:border-box!important;
      }
      #mg-downloads-pane .dl-controls .conc:has(#concurrency)>.row,
      .downloads .dl-controls .conc:has(#concurrency)>.row {
        display:flex!important;
        flex-direction:row!important;
        width:100%!important;
        min-width:0!important;
        max-width:none!important;
        margin:0!important;
        min-height:24px!important;
        align-items:center!important;
        gap:12px!important;
      }
      #mg-downloads-pane #concurrency,
      .downloads #concurrency {
        display:block!important;
        flex:1 1 0!important;
        width:auto!important;
        min-width:0!important;
        max-width:none!important;
        margin:0!important;
      }
      #mg-downloads-pane #concurrency-val,
      .downloads #concurrency-val {
        display:block!important;
        flex:0 0 auto!important;
        width:auto!important;
        min-width:2ch!important;
        margin:0!important;
        text-align:right!important;
      }
    `
    document.head.appendChild(style)
  }

  function loadOwnedBulkDelete () {
    if (window.__fileGramOwnedBulkDeleteInstalled || document.querySelector('script[data-filegram-owned-bulk-delete]')) return
    const ownedDelete = document.createElement('script')
    ownedDelete.src = 'owned-bulk-delete.js?v=1'
    ownedDelete.dataset.filegramOwnedBulkDelete = '1'
    ownedDelete.async = false
    document.body.appendChild(ownedDelete)
  }

  function loadMediaPreview () {
    if (window.__fileGramMediaPreviewInstalled || document.querySelector('script[data-filegram-media-preview]')) return
    const preview = document.createElement('script')
    preview.src = 'filegram-media-preview.js?v=1'
    preview.dataset.filegramMediaPreview = '1'
    preview.async = false
    document.body.appendChild(preview)
  }

  function loadUploadReliability () {
    if (window.__fileGramUploadReliabilityInstalled || document.querySelector('script[data-filegram-upload-reliability]')) return
    const reliability = document.createElement('script')
    reliability.src = 'upload-reliability.js?v=1'
    reliability.dataset.filegramUploadReliability = '1'
    reliability.async = false
    document.body.appendChild(reliability)
  }

  function loadPostHardening () {
    loadUploadReliability()
  }

  /* These two features are independent of the upload transport. Preview must
   * remain available even if the upload workspace takes longer to bootstrap. */
  loadOwnedBulkDelete()
  loadMediaPreview()

  /* The upload chain is intentionally ordered. bulk-uploads owns the UI/queue,
   * uploads-hardening installs the transport/integrity boundary, and only then
   * does refresh recovery patch that hardened queue. */
  function loadHardening () {
    const existingHardening = document.querySelector('script[data-filegram-upload-hardening]')
    if (existingHardening) {
      if (window.__fileGramUploadsHardeningInstalled) loadPostHardening()
      else existingHardening.addEventListener('load', loadPostHardening, { once: true })
      return
    }
    const hardening = document.createElement('script')
    hardening.src = 'uploads-hardening.js?v=3'
    hardening.dataset.filegramUploadHardening = '3'
    hardening.async = false
    hardening.addEventListener('load', loadPostHardening, { once: true })
    document.body.appendChild(hardening)
  }

  if (window.__fileGramBulkUploadsInstalled) {
    loadHardening()
    return
  }

  const existing = document.querySelector('script[data-filegram-bulk-uploads]')
  if (existing) {
    existing.addEventListener('load', loadHardening, { once: true })
    setTimeout(loadHardening, 0)
    return
  }

  const script = document.createElement('script')
  script.src = 'bulk-uploads.js?v=3'
  script.dataset.filegramBulkUploads = '3'
  script.async = false
  script.addEventListener('load', loadHardening, { once: true })
  document.body.appendChild(script)
})()