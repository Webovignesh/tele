'use strict'

const fs = require('node:fs')

function read (file) { return fs.readFileSync(file, 'utf8') }
function write (file, value) { fs.writeFileSync(file, value) }

function replaceRequired (source, search, replacement, label) {
  if (typeof search === 'string') {
    if (!source.includes(search)) throw new Error(`P1 source fix could not find ${label}`)
    return source.replace(search, replacement)
  }
  if (!search.test(source)) throw new Error(`P1 source fix could not find ${label}`)
  return source.replace(search, replacement)
}

let server = read('server.js')

const attachmentBlock = `function managedAttachmentContent (kind, inputFile, caption, oneTime) {
  const formattedCaption = { _: 'formattedText', text: String(caption || '').slice(0, 1024), entities: [] }
  const selfDestruct = oneTime ? { _: 'messageSelfDestructTypeImmediately' } : null

  if (kind === 'photo') {
    return {
      _: 'inputMessagePhoto',
      photo: inputFile,
      thumbnail: null,
      added_sticker_file_ids: [],
      width: 0,
      height: 0,
      caption: formattedCaption,
      show_caption_above_media: false,
      self_destruct_type: selfDestruct,
      has_spoiler: false
    }
  }

  if (kind === 'video') {
    return {
      _: 'inputMessageVideo',
      video: inputFile,
      thumbnail: null,
      cover: null,
      start_timestamp: 0,
      added_sticker_file_ids: [],
      duration: 0,
      width: 0,
      height: 0,
      supports_streaming: true,
      caption: formattedCaption,
      show_caption_above_media: false,
      self_destruct_type: selfDestruct,
      has_spoiler: false
    }
  }

  if (kind === 'audio') {
    return {
      _: 'inputMessageAudio',
      audio: inputFile,
      album_cover_thumbnail: null,
      duration: 0,
      title: '',
      performer: '',
      caption: formattedCaption
    }
  }

  return {
    _: 'inputMessageDocument',
    document: inputFile,
    thumbnail: null,
    disable_content_type_detection: false,
    caption: formattedCaption
  }
}

function managedLocalInputFile (absolutePath) {
  return { '@type': 'inputFileLocal', path: absolutePath }
}

function managedUploadFileType`

server = replaceRequired(
  server,
  /function managedAttachmentContent \(kind, inputFile, caption, oneTime\) \{[\s\S]*?\nfunction managedUploadFileType/,
  attachmentBlock,
  'managed attachment content block'
)
server = replaceRequired(
  server,
  "  return { _: 'inputFileId', id: uploaded.id }",
  "  return { '@type': 'inputFileId', id: uploaded.id }",
  'prepared InputFile return'
)
server = server.replace("    canMute: !isSavedMessages\n", '')
server = server.replace("  const notification = chat.notification_settings || {}\n", '')
server = server.replace("  const muted = notification.use_default_mute_for === false && Number(notification.mute_for || 0) > 0\n", '')
server = server.replace("      muted,\n", '')
server = replaceRequired(
  server,
  /\nfunction managedNotificationSettings \(current, muted\) \{[\s\S]*?\n\}\n\n\n\/\* ------------------------------ Interactive chat service ------------------------------ \*\//,
  '\n\n/* ------------------------------ Interactive chat service ------------------------------ */',
  'server notification settings helper'
)
server = replaceRequired(
  server,
  /\n        case 'set-managed-muted': \{[\s\S]*?\n        \}\n        case 'remove-managed-photo': \{/,
  "\n        case 'remove-managed-photo': {",
  'notification websocket command'
)
write('server.js', server)

let rescue = read('public/rescue-runtime.js')
rescue = rescue.replace('/* ------------------------------ Chat composer + desktop notifications ------------------------------ */', '/* ------------------------------ Chat composer ------------------------------ */')
rescue = rescue.replace('  rescueMaybeNotifyMessage(chatId, message)\n', '')
rescue = replaceRequired(
  rescue,
  /const rescueNotificationPrefKey = 'tele-desktop-notifications'[\s\S]*?\nfunction rescueMountComposer \(\) \{/,
  "const rescueCompose = { replyTo: null, editMessageId: null, editOriginal: '', attachments: [], oneTime: false }\n\nfunction rescueMountComposer () {",
  'desktop notification runtime block'
)
rescue = rescue.replace('window.teleDesktopNotificationsEnabled = rescueDesktopNotificationsEnabled\n', '')
rescue = rescue.replace('window.teleEnableDesktopNotifications = rescueEnableDesktopNotifications\n', '')
rescue = rescue.replace('window.teleDisableDesktopNotifications = rescueDisableDesktopNotifications\n', '')
rescue = rescue.replace('window.teleTestDesktopNotification = rescueTestDesktopNotification\n', '')
rescue = replaceRequired(
  rescue,
  /\nif \('serviceWorker' in navigator\) \{[\s\S]*?\n\}\n\nrescueMountComposer\(\)/,
  '\nrescueMountComposer()',
  'service worker registration block'
)
write('public/rescue-runtime.js', rescue)

let management = read('public/management.js')
management = management.replace(
  "      infoRow('Auto-delete', formatAutoDelete(details.autoDeleteTime)),\n      infoRow('Notifications', details.muted ? 'Muted' : 'On')",
  "      infoRow('Auto-delete', formatAutoDelete(details.autoDeleteTime))"
)
management = management.replace("    panel.appendChild(renderNotificationSection(data))\n", '')
management = replaceRequired(
  management,
  /\n  function renderNotificationSection \(data\) \{[\s\S]*?\n  \}\n\n  function renderDangerSection/,
  '\n  function renderDangerSection',
  'management notification section'
)
write('public/management.js', management)

console.log('P1 source cleanup applied')
