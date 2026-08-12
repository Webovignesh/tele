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


def regex_once(path, pattern, repl, label, flags=re.S):
    src = read(path)
    out, n = re.subn(pattern, repl, src, count=1, flags=flags)
    if n != 1:
        raise SystemExit(f"{label}: expected 1 match, got {n}")
    write(path, out)


# ---------------------------------------------------------------------------
# Bottom action dock: keep only the five requested actions.
# ---------------------------------------------------------------------------
replace_once(
    "public/index.html",
    '<div id="selection-bar" class="hidden">      <span id="selection-count">0 selected</span>      <button id="forward-selected" class="secondary" disabled>Forward</button>\n            <button id="download-selected">Download selected</button>      <button id="save-unique" class="ghost">Save to PC (dedupe)</button>      <button id="idl-links" class="ghost">Download via IDM</button>      <button id="mark-completed" class="ghost">Mark as completed</button>      <button id="unmark-completed" class="ghost">Unmark</button>      <button id="clear-selection" class="ghost">Clear</button>    </div>',
    '<div id="selection-bar" class="hidden selection-dock">      <span id="selection-count">0 selected</span>      <div class="selection-dock-actions">        <button id="forward-selected" class="secondary" disabled>Forward</button>        <button id="download-selected">Download selected</button>        <button id="mark-completed" class="ghost">Mark completed</button>        <button id="unmark-completed" class="ghost">Unmark</button>        <button id="clear-selection" class="ghost">Clear</button>      </div>    </div>',
    "selection dock buttons",
)

# Remove the obsolete IDM modal entirely.
regex_once(
    "public/index.html",
    r'\s*<div id="links-modal" class="hidden">.*?</div>\s*<div id="toast">',
    '  <div id="toast">',
    "remove IDM modal",
)

# Remove obsolete client functions for Save-to-PC direct/dedupe and IDM link export.
regex_once(
    "public/app.js",
    r'\nasync function saveUniqueSelected \(\) \{.*?\n\}\n\nfunction fmtBytes \(n\) \{.*?\n\}\n\nfunction renderLinksModal \(links\) \{.*?\n\}\n\nasync function downloadViaIDM \(\) \{.*?\n\}\n\nfunction closeLinksModal \(\) \{.*?\n\}\n\nfunction downloadLinksTxt \(\) \{.*?\n\}\n',
    '\n',
    "remove obsolete direct/IDM client code",
)

# Remove obsolete event wiring.
for line in [
    "$('#save-unique').onclick = saveUniqueSelected\n",
    "$('#idl-links').onclick = downloadViaIDM\n",
    "$('#links-close').onclick = closeLinksModal\n",
    "$('#links-txt').onclick = downloadLinksTxt\n",
]:
    src = read("public/app.js")
    if line in src:
        write("public/app.js", src.replace(line, "", 1))

regex_once(
    "public/app.js",
    r"\$\('#links-copy'\)\.onclick = \(\) => \{.*?\n\}\n",
    "",
    "remove links copy wiring",
)

# ---------------------------------------------------------------------------
# Server cleanup: remove the now-unused direct-save/IDM helpers and endpoint.
# The normal Download selected path remains untouched.
# ---------------------------------------------------------------------------
regex_once(
    "server.js",
    r'\nfunction computeSelectedSave \(items, chatTitle\) \{.*?\n\}\n\nfunction saveSelectedDirect \(items, chatTitle, chatId\) \{.*?\n\}\n\nfunction saveSelectedLinks \(items, chatTitle\) \{.*?\n\}\n',
    '\n',
    "remove direct save server helpers",
)

regex_once(
    "server.js",
    r'\n// Stream a Telegram file to the client \(for IDM / direct download\)\..*?\napp\.use\(\'/dl\',',
    "\napp.use('/dl',",
    "remove IDM HTTP fetch endpoint",
)

for case_pattern in [
    r"\n        case 'save-selected-preview': \{.*?\n        \}",
    r"\n        case 'save-selected-links': \{.*?\n        \}",
    r"\n        case 'save-selected-direct': \{.*?\n        \}",
]:
    src = read("server.js")
    out, n = re.subn(case_pattern, "", src, count=1, flags=re.S)
    if n != 1:
        raise SystemExit(f"remove obsolete WS route {case_pattern}: expected 1 match, got {n}")
    write("server.js", out)

# ---------------------------------------------------------------------------
# Private/contact history reliability: TDLib may return a short first batch even
# when older history exists. Fill one response internally before returning it.
# ---------------------------------------------------------------------------
regex_once(
    "server.js",
    r"async function loadMessages \(chatId, fromMessageId, limit\) \{.*?\n\}\n\n/\* ------------------------------ File search",
    r'''async function loadMessages (chatId, fromMessageId, limit) {
  if (!client || !ready) throw new Error('Not logged in')
  const target = Math.max(1, Math.min(100, Number(limit) || 100))
  const raw = []
  const seen = new Set()
  let cursor = fromMessageId || 0
  let exhausted = false

  // TDLib can return a very short batch for private/contact histories while it
  // hydrates older messages. Keep paging inside this request so the UI receives
  // one useful snapshot rather than appearing to contain only one message.
  for (let attempt = 0; attempt < 8 && raw.length < target; attempt++) {
    const history = await client.invoke({
      _: 'getChatHistory',
      chat_id: chatId,
      from_message_id: cursor,
      offset: 0,
      limit: Math.min(100, target - raw.length),
      only_local: false
    })
    const batch = (history.messages || []).filter(m => m.sending_state === undefined)
    if (!batch.length) { exhausted = true; break }

    let added = 0
    for (const message of batch) {
      const key = String(message.id)
      if (seen.has(key)) continue
      seen.add(key)
      raw.push(message)
      added++
      if (raw.length >= target) break
    }

    const oldest = batch[batch.length - 1]
    const nextCursor = oldest && oldest.id
    if (!nextCursor || String(nextCursor) === String(cursor) || added === 0) {
      exhausted = true
      break
    }
    cursor = nextCursor
  }

  const out = await Promise.all(raw.map(async (m) => {
    const item = {
      id: m.id,
      date: m.date,
      text: m.content && m.content._ === 'messageText' ? (m.content.text?.text || '') : null,
      sender: await resolveSenderName(m),
      outgoing: !!m.is_outgoing,
      media: extractMedia(m)
    }
    if (item.media && item.media.file) {
      const f = item.media.file
      item.media.fileSize = f.size || f.expected_size || 0
      item.media.fileId = f.id
      if (item.media.thumb && item.media.thumb.photo && item.media.thumb.photo.id) {
        item.media.thumbUrl = null
        item.media.thumbFileId = item.media.thumb.photo.id
      }
    } else {
      item.media = null
    }
    return item
  }))

  out.sort((a, b) => (String(a.id) < String(b.id) ? 1 : -1))
  return { messages: out, hasMore: !exhausted && raw.length >= target }
}

/* ------------------------------ File search''',
    "robust private chat history",
)

# ---------------------------------------------------------------------------
# Rescue runtime persistence and avatar stability.
# ---------------------------------------------------------------------------
replace_once(
    "public/rescue-runtime.js",
    "const rescueChatCache = new Map()\nconst rescueFileCache = new Map()",
    "const rescueChatCache = new Map()\nconst rescueFileCache = new Map()\nconst rescueAvatarCache = new Map()",
    "avatar cache",
)

replace_once(
    "public/rescue-runtime.js",
    "let rescueSyncTimer = null\n\nfunction rescuePreferredView () {",
    """let rescueSyncTimer = null
let rescueRestoredLastChat = false

function rescueSavedChatId () {
  try { return localStorage.getItem('tele-active-chat') } catch { return null }
}

function rescueRememberChat (chatId) {
  try {
    if (chatId == null) localStorage.removeItem('tele-active-chat')
    else localStorage.setItem('tele-active-chat', String(chatId))
  } catch {}
}

function rescuePreferredView () {""",
    "last chat persistence helpers",
)

replace_once(
    "public/rescue-runtime.js",
    "  state.activeChatId = chatId\n  state.selection.clear()",
    "  state.activeChatId = chatId\n  rescueRememberChat(chatId)\n  state.selection.clear()",
    "remember active chat",
)

# Replace avatar loader with a stable cache independent of transient chat objects.
regex_once(
    "public/rescue-runtime.js",
    r"function rescueLoadAvatar \(chat, holder\) \{.*?\n\}\n\nrenderChats = function rescueRenderChats",
    r'''function rescueLoadAvatar (chat, holder) {
  if (!chat || !chat.photoFileId || !holder) return
  const key = rescueChatKey(chat.id)
  const cachedUrl = rescueAvatarCache.get(key) || chat._avatarUrl
  if (cachedUrl) {
    rescueAvatarCache.set(key, cachedUrl)
    chat._avatarUrl = cachedUrl
    holder.textContent = ''
    const img = h('img', 'chat-avatar-img')
    img.src = '/dl' + cachedUrl
    img.alt = ''
    holder.appendChild(img)
    return
  }
  if (chat._avatarPending) return
  chat._avatarPending = true
  request('get-thumb', { fileId: chat.photoFileId }).then(data => {
    chat._avatarPending = false
    if (!data || !data.path) return
    chat._avatarUrl = data.path
    rescueAvatarCache.set(key, data.path)
    const live = document.querySelector(`.chat-item[data-chat-id="${CSS.escape(String(chat.id))}"] .chat-avatar`)
    if (!live) return
    live.textContent = ''
    const img = h('img', 'chat-avatar-img')
    img.src = '/dl' + data.path
    img.alt = ''
    live.appendChild(img)
  }).catch(() => { chat._avatarPending = false })
}

renderChats = function rescueRenderChats''',
    "stable avatar cache",
)

# Restore the previously selected chat once chat metadata is available.
replace_once(
    "public/rescue-runtime.js",
    """    } else {
      renderChats()
    }
  } catch (e) {""",
    """    } else {
      renderChats()
      if (!rescueRestoredLastChat && state.activeChatId == null) {
        const saved = rescueSavedChatId()
        const match = saved && state.chats.find(c => rescueChatKey(c.id) === saved)
        rescueRestoredLastChat = true
        if (match) openChat(match.id)
      }
    }
  } catch (e) {""",
    "restore selected chat",
)

# Strengthen Channels-only restoration explicitly in the rescue runtime.
append = """

// Preference restoration is explicit here as well as in the legacy handler so
// it survives future UI refactors.
try {
  const channelsOnly = localStorage.getItem('tele-channels-only') === '1'
  if ($('#channels-only')) $('#channels-only').checked = channelsOnly
} catch {}
"""
src = read("public/rescue-runtime.js")
if "Preference restoration is explicit here" not in src:
    write("public/rescue-runtime.js", src.rstrip() + append + "\n")

# When the active chat disappears, forget it so the next launch does not reopen
# an inaccessible/deleted chat.
append2 = """
const rescueBaseRemoveChat = removeChat
removeChat = function rescueRemoveChatPersistent (chatId) {
  if (state.activeChatId != null && rescueChatKey(state.activeChatId) === rescueChatKey(chatId)) {
    rescueRememberChat(null)
  }
  rescueChatCache.delete(rescueChatKey(chatId))
  rescueFileCache.delete(rescueChatKey(chatId))
  rescueAvatarCache.delete(rescueChatKey(chatId))
  return rescueBaseRemoveChat(chatId)
}
"""
src = read("public/rescue-runtime.js")
if "rescueRemoveChatPersistent" not in src:
    write("public/rescue-runtime.js", src.rstrip() + "\n\n" + append2.strip() + "\n")

# ---------------------------------------------------------------------------
# Dock styling.
# ---------------------------------------------------------------------------
css = read("public/rescue-runtime.css")
styles = r'''

/* Contextual selection dock */
#selection-bar.selection-dock {
  position: fixed;
  left: clamp(250px, 20vw, 320px);
  right: clamp(300px, 24vw, 390px);
  bottom: 0;
  z-index: 90;
  min-height: 58px;
  padding: 9px 16px;
  border-radius: 0;
  border: 1px solid var(--border);
  border-bottom: 0;
  background: color-mix(in srgb, var(--panel) 96%, transparent);
  box-shadow: 0 -10px 34px rgba(0, 0, 0, .28);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
#selection-bar.selection-dock.hidden { display: none; }
#selection-bar.selection-dock #selection-count {
  flex: 0 0 auto;
  font-weight: 700;
  white-space: nowrap;
}
.selection-dock-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
.selection-dock-actions button { min-height: 38px; }

@media (max-width: 1100px) {
  #selection-bar.selection-dock { left: 250px; right: 300px; padding-inline: 10px; }
  .selection-dock-actions { gap: 5px; }
  .selection-dock-actions button { padding-inline: 9px; }
}
'''
if "Contextual selection dock" not in css:
    write("public/rescue-runtime.css", css.rstrip() + styles + "\n")

print("selection/persistence cleanup applied")
