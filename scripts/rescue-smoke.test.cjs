'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const server = fs.readFileSync('server.js', 'utf8')
const app = fs.readFileSync('public/app.js', 'utf8')
const html = fs.readFileSync('public/index.html', 'utf8')

assert.match(server, /_:\s*'forwardMessages'/, 'native TDLib forwardMessages must be present')
assert.match(server, /send_copy:\s*false/, 'forwarding must preserve native forwarded-message semantics')
assert.match(server, /case 'forward-messages'/, 'websocket forwarding command must be present')
assert.match(server, /case 'search-destinations'/, 'destination search command must be present')
assert.match(server, /updateNewChat/, 'new chats must be published to the UI')
assert.match(server, /chat-upsert/, 'chat upsert realtime event must be present')
assert.match(server, /server\.listen\(PORT, '127\.0\.0\.1'/, 'runtime must bind only to loopback')

assert.match(app, /selectedMessages:\s*new Map\(\)/, 'text-message selection state must exist')
assert.match(app, /forwardSelectedMessages/, 'forward UI action must exist')
assert.match(app, /case 'chat-upsert'/, 'UI must reconcile realtime chat updates')
assert.match(app, /searchForwardDestinations/, 'UI must resolve destinations through the backend')
assert.match(html, /id="forward-selected"/, 'selection bar must expose Forward')

console.log('rescue smoke checks passed')
