'use strict'

/* Compatibility entrypoint kept because index.html and older cached shells load
 * uploads.js. The production implementation lives in bulk-uploads.js. */
;(function loadFileGramBulkUploads () {
  if (window.__fileGramBulkUploadsLoaderInstalled) return
  window.__fileGramBulkUploadsLoaderInstalled = true

  /* uploads.css is intentionally loaded after the main design system. Keep the
   * upload-stat geometry from that layer, but make the download drawer contract
   * explicit here. The design system has a high-specificity
   * `.dl-controls .conc:has(#concurrency)` rule, so this selector must target the
   * same element (with the drawer id) rather than relying on source order alone. */
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
        display:grid!important;
        gap:10px!important;
        margin:24px 0 0!important;
        padding:20px 0 0!important;
        border-top:1px solid var(--fg-border,#203147)!important;
      }
      #mg-downloads-pane .dl-controls .conc:has(#concurrency)>.row,
      .downloads .dl-controls .conc:has(#concurrency)>.row {
        margin:0!important;
        min-height:24px!important;
        align-items:center!important;
      }
    `
    document.head.appendChild(style)
  }

  /* The chain used to end with a third link, `file-consistency-v2.js?v=3`, appended
   * on this script's load event. That file is deleted: it duplicated Files
   * reconciliation, the folder-picker handler and the Save-to paint, and being last
   * in the chain it won `#set-dir` by accident of load order. Its concerns belong to
   * `files-stability.js`, `app.js` and `index.html` + `filegram-ui.css` now. The
   * chain keeps its shape - bulk-uploads, then hardening on its load event - so
   * nothing about the upload path changes. */
  function loadHardening () {
    if (document.querySelector('script[data-filegram-upload-hardening]')) return
    const hardening = document.createElement('script')
    hardening.src = 'uploads-hardening.js?v=3'
    hardening.dataset.filegramUploadHardening = '3'
    hardening.async = false
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
