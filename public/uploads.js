'use strict'

/* Compatibility entrypoint kept because index.html and older cached shells load
 * uploads.js. The production implementation lives in bulk-uploads.js; keeping
 * this loader avoids a second queue owner and lets us attach small hardening
 * layers without making the main application shell depend on load order.
 */
;(function loadFileGramBulkUploads () {
  if (window.__fileGramBulkUploadsLoaderInstalled) return
  window.__fileGramBulkUploadsLoaderInstalled = true

  function loadHardening () {
    if (document.querySelector('script[data-filegram-upload-hardening]')) return
    const hardening = document.createElement('script')
    hardening.src = 'uploads-hardening.js?v=1'
    hardening.dataset.filegramUploadHardening = '1'
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
  script.src = 'bulk-uploads.js?v=1'
  script.dataset.filegramBulkUploads = '1'
  script.async = false
  script.addEventListener('load', loadHardening, { once: true })
  document.body.appendChild(script)
})()
