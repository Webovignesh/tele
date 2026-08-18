'use strict'

/* Compatibility entrypoint kept because index.html and older cached shells load
 * uploads.js. The production implementation lives in bulk-uploads.js. */
;(function loadFileGramBulkUploads () {
  if (window.__fileGramBulkUploadsLoaderInstalled) return
  window.__fileGramBulkUploadsLoaderInstalled = true

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
