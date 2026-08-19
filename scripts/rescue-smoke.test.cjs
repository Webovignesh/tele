'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')

const server = fs.readFileSync('server.js', 'utf8')
const app = fs.readFileSync('public/app.js', 'utf8')
const html = fs.readFileSync('public/index.html', 'utf8')
const rescueRuntime = fs.readFileSync('public/rescue-runtime.js', 'utf8')
const management = fs.readFileSync('public/management.js', 'utf8')
const managementCss = fs.readFileSync('public/management.css', 'utf8')
const modernCss = fs.readFileSync('public/modern.css', 'utf8')
const polishCss = fs.readFileSync('public/telegram-polish.css', 'utf8')
const dailyDriver = fs.readFileSync('public/telegram-daily-driver.js', 'utf8')
const dailyDriverCss = fs.readFileSync('public/telegram-daily-driver.css', 'utf8')
const dailyHotfix = fs.readFileSync('public/daily-driver-hotfix.js', 'utf8')

/* Comments must not satisfy or break an assertion. The deletions this fix makes leave
 * comments explaining what was removed and why, and those comments necessarily name the
 * removed code, so every check by ABSENCE reads comment-stripped source. Line-based
 * rather than character-based: a character scanner has to tell a regex literal from a
 * division operator to know whether a quote inside `/[&<>"']/` opens a string, and
 * getting that wrong desynchronises the rest of the file silently. */
const stripComments = source => source
  .split('\n')
  .filter(line => {
    const trimmed = line.trim()
    return !(trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*/') || trimmed.startsWith('*'))
  })
  .join('\n')

const dailyDriverCode = stripComments(dailyDriver)
const dailyHotfixCode = stripComments(dailyHotfix)

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

assert.match(server, /createNewSupergroupChat/, 'channel and group creation must use TDLib')
assert.match(server, /case 'get-chat-management'/, 'permission-aware chat management command must exist')
assert.match(server, /deleteChatHistory/, 'clear-history support must exist')
assert.match(server, /leaveChat/, 'leave-chat support must exist')
assert.match(server, /deleteChat/, 'permission-aware delete support must exist')
assert.match(management, /Create link/, 'chat info drawer must expose invite management')
assert.match(management, /Load members/, 'chat info drawer must expose member management')
assert.match(html, /management\.js/, 'management runtime must be loaded')

assert.match(server, /updateNewMessage/, 'new Telegram messages must be pushed in realtime')
assert.match(server, /updateDeleteMessages/, 'message deletions must be pushed in realtime')
assert.match(server, /message-upsert/, 'server must publish realtime message upserts')
assert.match(server, /message-delete/, 'server must publish realtime message deletions')
assert.match(server, /\.png/, 'chat photo endpoint must support PNG')
assert.match(rescueRuntime, /rescueRealtimeMessageUpsert/, 'client must merge realtime messages into cache')
assert.match(rescueRuntime, /rescueSortChatsRecentFirst/, 'chat list must enforce recent-first order')
assert.match(management, /image\/png/, 'chat photo UI must accept PNG')
assert.match(managementCss, /mg-photo-drop/, 'chat photo UI must use the polished upload surface')

assert.match(server, /getMessageProperties/, 'message actions must be permission-aware')
assert.match(server, /sendMessage/, 'chat composer must send through TDLib')
assert.match(server, /editMessageText/, 'text editing must use TDLib')
assert.match(server, /deleteMessages/, 'message deletion must use TDLib')
assert.match(server, /canClearHistoryForSelf/, 'clear history must distinguish self/all permissions')
assert.match(server, /managedSupergroupFullInfoCache/, 'invite-link/full-info updates must use authoritative realtime cache')
assert.match(management, /Clear history for everyone/, 'history UI must expose valid revoke mode')

assert.match(server, /replacePrimaryChatInviteLink/, 'invite links must use primary Telegram invite-link management')
assert.match(server, /inputMessageDocument/, 'chat attachments must send through TDLib')
assert.match(server, /api\/chat-attachment/, 'chat attachment streaming endpoint must exist')
assert.match(rescueRuntime, /tele-compose-attach/, 'chat composer must expose file attachment')
assert.doesNotMatch(management, /check-managed-username/, 'channel/group username management must be removed from the UI')

assert.match(rescueRuntime, /rescueMarkActiveChat/, 'chat switching must update active state without rebuilding the sidebar')
assert.match(html, /modern\.css/, 'modern desktop skin must be loaded')
assert.match(modernCss, /Tele modern desktop skin/, 'modern UI skin must exist')

assert.match(server, /inputFileLocal/, 'attachments must send directly as local files')
assert.match(server, /managedPrepareInputFile/, 'attachments must have a prepared-upload fallback')
assert.match(server, /inputMessagePhoto/, 'photo attachments must use Telegram photo content')
assert.match(server, /inputMessageVideo/, 'video attachments must use Telegram video content')
assert.match(server, /inputMessageAudio/, 'audio attachments must use Telegram audio content')
assert.match(server, /messageSelfDestructTypeImmediately/, 'private photo/video view-once must be supported')
assert.match(server, /mediaThumbFileId/, 'video/document thumbnails must resolve TDLib thumbnail file ids')
assert.match(server, /api\/media-preview/, 'preview endpoint must exist')
assert.match(server, /mediaIndexCache/, 'whole-chat media index must be cached in memory')
assert.match(rescueRuntime, /file-range-tools/, 'file range selection must exist')
assert.match(rescueRuntime, /tele-downloaded-files-v1/, 'downloaded file marks must persist')
assert.match(rescueRuntime, /tele-forwarded-files-v1/, 'forwarded file marks must persist')
assert.match(rescueRuntime, /multiple/, 'composer must support multiple attachments')
assert.match(rescueRuntime, /View once/, 'composer must expose private-media view once')
assert.match(management, /details\.accessType/, 'chat overview must display Telegram public/private access')
assert.match(polishCss, /Tele daily-driver polish/, 'daily-driver UI polish stylesheet must exist')

assert.match(server, /batchItems/, 'file scans must stream progressive item batches')
assert.match(server, /Accept-Ranges/, 'inline media endpoint must support byte ranges')
assert.match(dailyDriver, /teleDailyFilesItems/, 'files must use a separate per-chat index')
assert.match(dailyDriver, /hour12:\s*true/, 'message time must use 12-hour display')
/* INVERTED, deliberately. This used to require `teleDailyMergeScanBatch` to exist -
 * "file UI must merge scan batches" - which made a second writer of the shared Files
 * index a passing requirement. It merged the item batches on `download-all-progress`
 * into `rescueFileCache` and repainted from there. `public/files-stability.js` is the
 * single owner of the index and of the scan stream now, so this layer must NOT merge
 * batches. Called out in the task 7/8/9 evidence so a reviewer does not read it as a
 * weakened test. */
assert.doesNotMatch(dailyDriverCode, /teleDailyMergeScanBatch/, 'this layer must not merge scan batches into the shared Files index')
assert.doesNotMatch(dailyDriverCode, /rescueFileCache\.set/, 'the Files index owner must be the only writer of the shared cache')
assert.match(dailyDriver, /teleDailyBuildGridCard/, 'file selection/media hotfix must be active')
assert.match(dailyDriverCss, /#toggle-drawer\s*\{\s*display:\s*none/, 'download Hide control must be removed from the UI')
assert.match(html, /telegram-daily-driver\.js/, 'daily-driver runtime must be loaded')
assert.match(html, /telegram-daily-driver\.css/, 'daily-driver stylesheet must be loaded')

assert.match(server, /scanMediaIndexV3/, 'file indexing must be chat scoped')
assert.match(server, /media-index-progress/, 'file indexing must stream progressive batches')
assert.match(server, /previewFileInflight/, 'media preparation requests must be deduplicated')
assert.match(server, /Content-Range/, 'media playback must implement HTTP ranges')
assert.match(server, /return \{ '@type':\s*'inputFileId', id: uploaded\.id \}/, 'prepared attachment ids must be passed as explicit TDLib InputFile objects')
assert.doesNotMatch(html, /telegram-daily-driver-v3\.js/, 'removed v3 experiment must not be loaded')
assert.doesNotMatch(html, /telegram-daily-driver-v3\.css/, 'removed v3 experiment stylesheet must not be loaded')
assert.match(html, /id="boot-status"/, 'bootstrap must expose a visible connecting state instead of a blank page')

/* INVERTED. This required the hotfix layer to issue `scan-media-v3` itself. Five layers
 * did, each with its own force policy, retry count and cache write, and which one ran
 * was decided by load order. `public/files-stability.js` owns discovery; the hotfix
 * keeps the count label, the preview modal and the thumbnail helpers. */
assert.doesNotMatch(dailyHotfixCode, /scan-media-v3/, 'only the Files index owner may run the chat-scoped media scan')
assert.doesNotMatch(dailyHotfixCode, /rescueFileCache\.set/, 'the Files index owner must be the only writer of the shared cache')
assert.match(dailyHotfix, /teleHotfixSnapshotBelongsToChat/, 'stale cross-chat file snapshots must be rejected')
assert.match(dailyHotfix, /messageId/, 'preview requests must carry message identity for Telegram file rehydration')
assert.match(dailyHotfix, /rescueDownloadedMarks\.delete/, 'unmark must clear persisted Downloaded labels')
assert.match(html, /daily-driver-hotfix\.js/, 'acceptance hotfix runtime must be loaded')
assert.match(html, /daily-driver-hotfix\.css/, 'acceptance hotfix stylesheet must be loaded')

/* Notifications were intentionally removed from the product, not merely hidden. */
assert.doesNotMatch(rescueRuntime, /Notification\.requestPermission|rescueNotificationServiceRegistration|showNotification/, 'desktop notification runtime must be absent')
assert.doesNotMatch(management, /renderNotificationSection|Desktop notifications/, 'notification controls must be absent from Chat Info')
assert.doesNotMatch(server, /set-managed-muted|managedNotificationSettings/, 'notification management API must be absent')

console.log('rescue smoke checks passed')
