'use strict'

/* Compatibility entrypoint kept because index.html and older cached shells load
 * uploads.js. The production implementation lives in bulk-uploads.js. */
;(function loadFileGramBulkUploads () {
  if (window.__fileGramBulkUploadsLoaderInstalled) return
  window.__fileGramBulkUploadsLoaderInstalled = true

  function loadConsistency () {
    if (document.querySelector('script[data-filegram-file-consistency-v2]')) return
    const script = document.createElement('script')
    script.src = 'file-consistency-v2.js?v=3'
    script.dataset.filegramFileConsistencyV2 = '3'
    script.async = false
    document.body.appendChild(script)
  }

  function loadHardening () {
    const existing = document.querySelector('script[data-filegram-upload-hardening]')
    if (existing) {
      if (window.__fileGramUploadsHardeningInstalled) loadConsistency()
      else existing.addEventListener('load', loadConsistency, { once: true })
      return
    }
    const hardening = document.createElement('script')
    hardening.src = 'uploads-hardening.js?v=3'
    hardening.dataset.filegramUploadHardening = '3'
    hardening.async = false
    hardening.addEventListener('load', loadConsistency, { once: true })
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
