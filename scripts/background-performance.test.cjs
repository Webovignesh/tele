'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const preload = fs.readFileSync(path.join(root, 'background-performance-preload.js'), 'utf8')
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8')

const start = String(pkg.scripts && pkg.scripts.start || '')
assert.ok(start.startsWith('node -r ./background-performance-preload.js '), 'background performance preload must run before TDLib/server startup')

assert.match(preload, /process\.platform === 'win32'/)
assert.match(preload, /PriorityClass = 'AboveNormal'/)
assert.match(preload, /ProcessPowerThrottling = 4/)
assert.match(preload, /PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 0x1/)
assert.match(preload, /StateMask = 0/)
assert.match(preload, /SetProcessInformation/)

/* Downloads must remain server-owned. A hidden browser is allowed to render less
 * often, but it must never be the thing that pumps TDLib transfers. */
assert.match(app, /case 'download-stats':/)
assert.doesNotMatch(app, /visibilitychange[\s\S]{0,400}(?:start-download|resume-all|downloadFile)/i)

console.log('background performance checks passed')
