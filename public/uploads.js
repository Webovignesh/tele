'use strict'

/* Compatibility entrypoint kept because index.html and older cached shells load
 * uploads.js. The production implementation lives in bulk-uploads.js; keeping
 * this tiny loader avoids a second queue owner and makes old browser caches safe.
 */
;(function loadFileGramBulkUploads () {
  if (window.__fileGramBulkUploadsLoaderInstalled) return
  window.__fileGramBulkUploadsLoaderInstalled = true
  if (document.querySelector('script[data-filegram-bulk-uploads]')) return
  const script = document.createElement('script')
  script.src = 'bulk-uploads.js?v=1'
  script.dataset.filegramBulkUploads = '1'
  script.async = false
  document.body.appendChild(script)
})()
