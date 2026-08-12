'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const server = fs.readFileSync('server.js', 'utf8')
const app = fs.readFileSync('public/app.js', 'utf8')
const html = fs.readFileSync('public/index.html', 'utf8')
const management = fs.readFileSync('public/management.js', 'utf8')

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

assert.match(server, /createNewSupergroupChat/, 'channel and group creation must use TDLib')
assert.match(server, /case 'get-chat-management'/, 'permission-aware chat management command must exist')
assert.match(server, /deleteChatHistory/, 'clear-history support must exist')
assert.match(server, /leaveChat/, 'leave-chat support must exist')
assert.match(server, /deleteChat/, 'permission-aware delete support must exist')
assert.match(management, /Create link/, 'chat info drawer must expose invite management')
assert.match(management, /Load members/, 'chat info drawer must expose member management')
assert.match(html, /management\.js/, 'management runtime must be loaded')
