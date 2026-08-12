from pathlib import Path
import re


def read(path):
    return Path(path).read_text()


def write(path, text):
    Path(path).write_text(text)


def replace_once(path, old, new, label):
    src = read(path)
    if old not in src:
        raise SystemExit(f"{label}: anchor not found")
    write(path, src.replace(old, new, 1))


# ---------------------------------------------------------------------------
# Attachment sending: preflight the staged file, ask TDLib to register it,
# then send by inputFileId. This avoids the nested local InputFile handoff that
# produced "InputFile is not specified" on Windows.
# ---------------------------------------------------------------------------
old_attachment = """async function sendManagedAttachmentMessage (chatId, filePath, caption, replyToMessageId) {
  ensureManagementReady()
  let replyTo = null
  if (replyToMessageId) {
    const actions = await getManagedMessageActions(chatId, replyToMessageId)
    if (!actions.canReply) throw new Error('Telegram does not allow replying to this message')
    replyTo = { _: 'inputMessageReplyToMessage', message_id: replyToMessageId, quote: null, checklist_task_id: 0 }
  }
  const message = await client.invoke({
    _: 'sendMessage',
    chat_id: chatId,
    topic_id: null,
    reply_to: replyTo,
    options: null,
    reply_markup: null,
    input_message_content: {
      _: 'inputMessageDocument',
      document: { _: 'inputFileLocal', path: filePath },
      thumbnail: null,
      disable_content_type_detection: false,
      caption: { _: 'formattedText', text: String(caption || '').slice(0, 1024), entities: [] }
    }
  })
  emitRealtimeMessage(message).catch(() => {})
  emitChatUpsert(chatId).catch(() => {})
  return serializeRealtimeMessage(message)
}
"""
new_attachment = """async function sendManagedAttachmentMessage (chatId, filePath, caption, replyToMessageId) {
  ensureManagementReady()
  const absolutePath = path.resolve(String(filePath || ''))
  const stat = await fs.promises.stat(absolutePath).catch(() => null)
  if (!stat || !stat.isFile() || stat.size <= 0) throw new Error('The attachment could not be staged for Telegram')

  let replyTo = null
  if (replyToMessageId) {
    const actions = await getManagedMessageActions(chatId, replyToMessageId)
    if (!actions.canReply) throw new Error('Telegram does not allow replying to this message')
    replyTo = { _: 'inputMessageReplyToMessage', message_id: replyToMessageId, quote: null, checklist_task_id: 0 }
  }

  // Register the local file with TDLib first. Sending by inputFileId is more
  // reliable on Windows than passing the local InputFile through nested message
  // content in one call, and gives us a concrete file id to validate.
  const uploaded = await client.invoke({
    _: 'preliminaryUploadFile',
    file: { _: 'inputFileLocal', path: absolutePath },
    file_type: { _: 'fileTypeDocument' },
    priority: 32
  })
  if (!uploaded || !uploaded.id) throw new Error('Telegram did not accept the staged attachment')

  const message = await client.invoke({
    _: 'sendMessage',
    chat_id: chatId,
    topic_id: null,
    reply_to: replyTo,
    options: null,
    reply_markup: null,
    input_message_content: {
      _: 'inputMessageDocument',
      document: { _: 'inputFileId', id: uploaded.id },
      thumbnail: null,
      disable_content_type_detection: false,
      caption: { _: 'formattedText', text: String(caption || '').slice(0, 1024), entities: [] }
    }
  })
  emitRealtimeMessage(message).catch(() => {})
  emitChatUpsert(chatId).catch(() => {})
  return serializeRealtimeMessage(message)
}
"""
replace_once('server.js', old_attachment, new_attachment, 'attachment sender')

# ---------------------------------------------------------------------------
# Chat switching performance: do not rebuild the whole sidebar just to move the
# active highlight, and do not render the hidden Files tree on every Messages
# switch. Cached content stays visible immediately while the newest page refreshes.
# ---------------------------------------------------------------------------
replace_once(
    'public/rescue-runtime.js',
    "function rescueChatKey (chatId) { return String(chatId) }\n",
    """function rescueChatKey (chatId) { return String(chatId) }

function rescueMarkActiveChat (chatId) {
  const wanted = rescueChatKey(chatId)
  document.querySelectorAll('#chat-list .chat-item.active').forEach(node => node.classList.remove('active'))
  const next = [...document.querySelectorAll('#chat-list .chat-item')]
    .find(node => rescueChatKey(node.dataset.chatId) === wanted)
  if (next) next.classList.add('active')
}
""",
    'active chat marker'
)

replace_once(
    'public/rescue-runtime.js',
    "  updateSelectionBar()\n  renderChats()\n\n  const chat = state.chats.find(c => rescueChatKey(c.id) === rescueChatKey(chatId))",
    "  updateSelectionBar()\n  rescueMarkActiveChat(chatId)\n\n  const chat = state.chats.find(c => rescueChatKey(c.id) === rescueChatKey(chatId))",
    'avoid sidebar rebuild on open'
)

replace_once(
    'public/rescue-runtime.js',
    "  $('#chat-title').textContent = chat ? chat.title : 'Chat'\n  $('#messages').innerHTML = ''\n  $('#media-grid').innerHTML = ''\n\n  const cached = rescueChatCache.get(rescueChatKey(chatId))",
    "  $('#chat-title').textContent = chat ? chat.title : 'Chat'\n  $('#media-grid').innerHTML = ''\n\n  const cached = rescueChatCache.get(rescueChatKey(chatId))",
    'preserve message pane until cache swap'
)

replace_once(
    'public/rescue-runtime.js',
    "  } else {\n    state.messages = []\n    state.hasMore = true\n  }\n\n  const preferredView = rescuePreferredView()",
    "  } else {\n    state.messages = []\n    state.hasMore = true\n    $('#messages').innerHTML = ''\n  }\n\n  const preferredView = rescuePreferredView()",
    'clear messages only for cold chats'
)

replace_once(
    'public/rescue-runtime.js',
    "  } else {\n    renderFiles()\n    setLoadState(cached ? `Cached ${state.messages.length} messages · refreshing…` : 'loading')\n  }",
    "  } else {\n    setLoadState(cached ? `Cached ${state.messages.length} messages · refreshing…` : 'loading')\n  }",
    'skip hidden files render'
)

# Let the cached frame paint before requesting the network refresh.
replace_once(
    'public/rescue-runtime.js',
    "  const generation = rescueOpenGeneration\n  const requestKey = `${rescueChatKey(chatId)}:latest:${generation}`\n  const work = (async () => {",
    "  const generation = rescueOpenGeneration\n  const requestKey = `${rescueChatKey(chatId)}:latest:${generation}`\n  await new Promise(resolve => requestAnimationFrame(() => resolve()))\n  const work = (async () => {",
    'paint cache before refresh'
)

# ---------------------------------------------------------------------------
# Modern UI layer. This is deliberately CSS-first so it can revamp the product
# without destabilizing the downloader/forwarder/selection logic underneath.
# ---------------------------------------------------------------------------
modern_css = r"""
/* Tele modern desktop skin -------------------------------------------------- */
:root {
  --bg: #0a0f16;
  --panel: #101720;
  --panel2: #17212d;
  --panel3: #1e2b3a;
  --border: #243244;
  --text: #edf4fb;
  --muted: #8294a8;
  --accent: #55a9ff;
  --accent2: #173f66;
  --danger: #f05a63;
  --ok: #42c26b;
  --warn: #e5ad45;
  --radius-xl: 18px;
  --radius-lg: 14px;
  --radius-md: 11px;
}

body {
  font-size: 13px;
  background:
    radial-gradient(circle at 50% -20%, rgba(47,111,170,.12), transparent 36%),
    var(--bg);
}

.app { grid-template-columns: 316px minmax(0, 1fr) 342px; background: var(--bg); }
.sidebar, .downloads { background: rgba(16,23,32,.98); }
.sidebar { padding: 8px 8px 0; border-right: 1px solid #202d3d; }
.downloads { border-left: 1px solid #202d3d; }

.sidebar-head { min-height: 56px; padding: 8px 8px 7px; }
.sidebar-head h2 { font-size: 18px; letter-spacing: -.35px; }
#mg-create-chat { border-radius: 10px; }
#chat-search {
  margin: 3px 4px 8px;
  min-height: 40px;
  border: 0;
  background: #182330;
  border-radius: 12px;
  box-shadow: inset 0 0 0 1px transparent;
}
#chat-search:focus { box-shadow: inset 0 0 0 1px var(--accent); }
.channels-filter { margin: 0 7px 8px; min-height: 25px; }
#chat-list { padding: 0 0 8px; scrollbar-width: thin; }
.chat-item {
  min-height: 58px;
  margin: 2px 0;
  padding: 8px 9px;
  border: 0;
  border-radius: 12px;
  gap: 10px;
  transition: background .12s ease, transform .12s ease;
}
.chat-item:hover { background: #172332; transform: translateX(1px); }
.chat-item.active { background: linear-gradient(135deg, #1d4f7b, #193d62); }
.chat-avatar { width: 42px; height: 42px; font-size: 14px; box-shadow: 0 0 0 1px rgba(255,255,255,.05); }
.chat-item .t { font-size: 13.5px; font-weight: 650; letter-spacing: -.1px; }
.chat-item .preview { margin-top: 2px; font-size: 11px; }
.chat-item .u { opacity: .8; }

.chat { background: #0c131c; overflow: hidden; }
.chat-head {
  min-height: 62px;
  padding: 10px 18px;
  background: rgba(14,21,30,.94);
  backdrop-filter: blur(14px);
  border-bottom: 1px solid #202d3d;
}
.chat-title-box h3 { font-size: 16px; font-weight: 700; }
.chat-title-box #chat-media-count {
  background: transparent;
  padding: 0;
  margin-top: 2px;
  font-size: 10.5px;
  font-weight: 500;
  color: var(--muted);
}
.chat-actions button { border-radius: 10px; min-height: 34px; }
.chat-actions #download-all-media { background: #2fa85a; color: white; }

.tabs {
  gap: 4px;
  padding: 8px 14px 0;
  background: #0e151e;
  border-bottom: 1px solid #202d3d;
}
.tab {
  padding: 9px 14px 10px;
  border-radius: 10px 10px 0 0;
  font-size: 12px;
}
.tab.active { background: rgba(85,169,255,.08); }

.messages {
  padding: 20px clamp(18px, 4vw, 56px) 26px;
  gap: 5px;
  background:
    radial-gradient(circle at 80% 15%, rgba(47,91,130,.08), transparent 25%),
    #0b121a;
}
.msg {
  max-width: min(76%, 720px);
  min-width: 150px;
  padding: 8px 10px 7px;
  border: 1px solid rgba(70,92,117,.34);
  border-radius: 15px;
  box-shadow: 0 2px 10px rgba(0,0,0,.14);
}
.msg.incoming { background: #151f2b; border-bottom-left-radius: 5px; }
.msg.outgoing { background: #173a51; border-color: rgba(85,169,255,.18); border-bottom-right-radius: 5px; }
.msg-head { margin-bottom: 3px; gap: 7px; }
.msg-sender { font-size: 11.5px; color: #71b9ff; }
.msg-date { font-size: 9.5px; margin-left: auto; }
.msg-text { font-size: 13.5px; line-height: 1.42; }
.msg-select {
  position: absolute;
  top: 8px;
  right: 8px;
  opacity: 0;
  transition: opacity .12s;
  flex-direction: row;
  align-items: center;
  font-size: 0;
}
.msg:hover .msg-select, .msg:focus-within .msg-select, .msg-select:has(input:checked) { opacity: 1; }
.msg-select input { width: 16px; height: 16px; padding: 0; }
.msg-actions { margin-top: 4px; opacity: 0; height: 0; overflow: hidden; transition: opacity .12s ease, height .12s ease; }
.msg:hover .msg-actions, .msg:focus-within .msg-actions { opacity: 1; height: 26px; }
.msg-actions button { border-radius: 8px; background: rgba(255,255,255,.025); }
.media { margin-top: 5px; border: 0; border-radius: 11px; background: rgba(5,10,16,.22); }
.media img.thumb, .media .icon { width: 62px; height: 62px; border-radius: 10px; }

.files-toolbar { padding: 12px 14px 10px; gap: 7px; border-bottom: 1px solid #1c2938; }
.search-box input, .files-toolbar select { background: #15202c; border-color: #243548; border-radius: 11px; }
.media-grid { padding: 14px; gap: 7px; background: #0b121a; }
.gcard {
  min-height: 66px;
  padding: 8px 11px;
  border-radius: 12px;
  background: #172331;
  border-color: #223245;
  box-shadow: none;
}
.gcard:hover { transform: none; background: #1a2837; box-shadow: none; }
.gcard.selected { background: #194064; box-shadow: inset 0 0 0 1px var(--accent); }
.gcard .gthumb { width: 48px; height: 48px; border-radius: 10px; }
.gcard .gtype { border-radius: 999px; padding: 2px 7px; font-size: 9px; }

.tele-composer {
  padding: 9px 12px 11px;
  border-top: 1px solid #202d3d;
  background: rgba(14,21,30,.97);
  box-shadow: 0 -12px 28px rgba(0,0,0,.16);
}
.tele-compose-row { gap: 7px; }
#tele-compose-input {
  min-height: 44px;
  padding: 11px 13px;
  border: 1px solid #27384b;
  border-radius: 15px;
  background: #141f2a;
}
#tele-compose-input:focus { border-color: #3c83be; box-shadow: 0 0 0 3px rgba(85,169,255,.08); }
.tele-compose-attach { width: 44px; height: 44px; border-radius: 13px; background: #172331 !important; }
#tele-compose-send { height: 44px; min-width: 74px; border-radius: 13px; color: #07111a; }
.tele-attachment-preview { border-radius: 12px; background: #152b3d; border-color: #244a67; }

.chat-foot {
  min-height: 24px;
  padding: 2px 8px;
  border-top: 0;
  background: #0d141d;
}

.downloads-head { min-height: 56px; padding: 10px 12px; border-bottom: 1px solid #202d3d; }
.dl-controls { padding: 10px 12px; }
#download-list { padding: 0 10px 12px; }
.mg-drawer-tabs { padding: 6px 8px 0; background: #0f1721; }
.mg-drawer-tab { border-radius: 9px 9px 0 0; }
.mg-info-pane { background: #101720; }
.mg-section { margin: 8px; border-radius: 13px; background: #151f2b; border: 1px solid #213044; }
.mg-info-hero { padding: 16px 14px; }
.mg-info-avatar { width: 58px; height: 58px; }
.mg-photo-drop { border-radius: 14px; background: #111d28; }

#selection-bar.selection-dock {
  left: 14px;
  right: 14px;
  bottom: 12px;
  min-height: 52px;
  padding: 7px 9px 7px 12px;
  border: 1px solid #2a4056;
  border-radius: 15px;
  background: rgba(18,28,39,.96);
  box-shadow: 0 14px 45px rgba(0,0,0,.36);
}
.selection-dock-actions { flex-wrap: nowrap; }
.selection-dock-actions button { min-height: 36px; border-radius: 10px; white-space: nowrap; }

#toast {
  border-radius: 12px;
  box-shadow: 0 16px 45px rgba(0,0,0,.38);
}

* { scrollbar-color: #30445a transparent; scrollbar-width: thin; }

@media (min-width: 1600px) {
  .app { grid-template-columns: 330px minmax(0, 1fr) 360px; }
  .messages { padding-inline: clamp(34px, 6vw, 90px); }
}

@media (max-width: 1180px) {
  .app { grid-template-columns: 286px minmax(0, 1fr) 320px; }
  .msg { max-width: 84%; }
}
"""
write('public/modern.css', modern_css.strip() + '\n')

idx = read('public/index.html')
if 'modern.css' not in idx:
    idx = idx.replace('<link rel="stylesheet" href="management.css?v=4">', '<link rel="stylesheet" href="management.css?v=4"><link rel="stylesheet" href="modern.css?v=1">')
idx = re.sub(r'rescue-runtime\.js\?v=\d+', 'rescue-runtime.js?v=6', idx)
write('public/index.html', idx)

smoke = read('scripts/rescue-smoke.test.cjs')
if "const modernCss" not in smoke:
    smoke = smoke.replace("const managementCss = fs.readFileSync('public/management.css', 'utf8')", "const managementCss = fs.readFileSync('public/management.css', 'utf8')\nconst modernCss = fs.readFileSync('public/modern.css', 'utf8')")
extra = """
assert.match(server, /preliminaryUploadFile/, 'attachments must be registered with TDLib before send')
assert.match(server, /inputFileId/, 'attachments must send using a validated TDLib file id')
assert.match(rescueRuntime, /rescueMarkActiveChat/, 'chat switching must update active state without rebuilding the sidebar')
assert.match(html, /modern\\.css/, 'modern desktop skin must be loaded')
assert.match(modernCss, /Tele modern desktop skin/, 'modern UI skin must exist')
"""
if 'attachments must be registered with TDLib before send' not in smoke:
    smoke = smoke.rstrip() + '\n' + extra
write('scripts/rescue-smoke.test.cjs', smoke)

print('modern performance and attachment pass applied')
