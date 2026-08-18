'use strict'

/* Compatibility entrypoint kept because index.html and older cached shells load
 * uploads.js. The production implementation lives in bulk-uploads.js. */
;(function loadFileGramBulkUploads () {
  if (window.__fileGramBulkUploadsLoaderInstalled) return
  window.__fileGramBulkUploadsLoaderInstalled = true

  /* Keep the upload stats fix from uploads.css, but neutralize the download-drawer
   * regression introduced by the last spacing patch. The core FileGram stylesheet
   * already defines Save-to as a horizontal flex row; forcing it to grid stacks the
   * icon/label/path and clips the path. This late style restores the intended flex
   * layout and adds spacing only between Save-to and Parallel files. */
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
      .downloads .conc,
      #mg-downloads-pane .conc {
        display:grid!important;
        gap:10px!important;
        margin:18px 0 0!important;
        padding:18px 0 0!important;
        border-top:1px solid var(--fg-border,#203147)!important;
      }
      .downloads .conc>.row,
      #mg-downloads-pane .conc>.row {
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
