'use strict'

/* Transitional neutral runtime entrypoint.
 * The implementation still lives in the legacy cache-first runtime while the
 * frontend is being consolidated. Keep this shim tiny so references can move
 * off the rescue-named asset without duplicating production logic.
 */

;(function loadRuntime () {
  const script = document.createElement('script')
  script.src = 'rescue-runtime.js?v=7'
  script.async = false
  document.head.appendChild(script)
})()
