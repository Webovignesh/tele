'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')
const pkg = JSON.parse(read('package.json'))
const start = String(pkg.scripts && pkg.scripts.start || '')
const preload = read('download-reliability-preload.js')
const resolver = read('download-reference-resolver.js')
const uploads = read('public/uploads.js')
const css = read('public/download-reliability.css')
const updateBoundary = read('bulk-upload-preload.js')

const dedupeAt = start.indexOf('-r ./download-dedupe-preload.js')
const reliabilityAt = start.indexOf('-r ./download-reliability-preload.js')
const serverAt = start.lastIndexOf('server.js')
assert.ok(dedupeAt >= 0, 'download dedupe preload must remain installed')
assert.ok(reliabilityAt > dedupeAt, 'download reliability must wrap start-download after dedupe is installed')
assert.ok(serverAt > reliabilityAt, 'download reliability must run before server.js')

assert.match(preload, /request\.type !== REQUEST_TYPE/)
assert.match(preload, /resolveDownloadItems/)
assert.match(preload, /fileGramTdlibSafeRename/)
assert.match(preload, /inside\(from, TD_FILES_DIR\)/)
assert.match(resolver, /chat_id: chatId/)
assert.match(resolver, /getChatHistory/)
assert.match(resolver, /getMessage/)
assert.match(resolver, /DIRECT_LOOKUP_LIMIT/)

assert.match(uploads, /download-reliability\.css\?v=1/)
assert.match(uploads, /download-reliability\.js\?v=1/)
assert.match(css, /content-visibility:\s*visible\s*!important/)
assert.match(css, /contain:\s*none\s*!important/)
assert.match(css, /min-height:\s*58px\s*!important/)

assert.match(updateBoundary, /UPDATE_FILE_PROGRESS_INTERVAL_MS = 200/)
assert.match(updateBoundary, /client\.off = function fileGramBoundaryOff/)
assert.match(updateBoundary, /client\.removeListener = function fileGramBoundaryRemoveListener/)
assert.match(updateBoundary, /updateWrappers\.delete\(listener\)/)

console.log('download reliability wiring checks passed')
