from pathlib import Path


def replace_once(path, old, new, label):
    p = Path(path)
    src = p.read_text()
    if old not in src:
        raise SystemExit(f"{label}: anchor not found")
    p.write_text(src.replace(old, new, 1))

# Render message history in normal chronological order (oldest at top, newest at bottom).
replace_once(
    'public/app.js',
    '  for (const m of state.messages) {\n    const msgEl = h(\'div\', \'msg\' + (m.outgoing ? \' outgoing\' : \' incoming\'))',
    '  for (const m of [...state.messages].reverse()) {\n    const msgEl = h(\'div\', \'msg\' + (m.outgoing ? \' outgoing\' : \' incoming\'))',
    'chronological message render',
)

# Older history should be requested when the user reaches the top of Messages.
replace_once(
    'public/app.js',
    "$('#messages').addEventListener('scroll', e => {\n  if (e.target.scrollTop + e.target.clientHeight >= e.target.scrollHeight - 250) {\n    if (state.activeChatId && state.hasMore && !state.loadingMore) loadMessages(state.activeChatId)\n  }\n})",
    "$('#messages').addEventListener('scroll', e => {\n  if (e.target.scrollTop <= 250) {\n    if (state.activeChatId && state.hasMore && !state.loadingMore) loadMessages(state.activeChatId)\n  }\n})",
    'load older messages at top',
)

# Preserve viewport while prepending older history in the rescue loader.
replace_once(
    'public/rescue-runtime.js',
    "  const generation = rescueOpenGeneration\n  if (rescueChatKey(state.activeChatId) === chatKey) {\n    state.loadingMore = true",
    "  const generation = rescueOpenGeneration\n  const messagePanel = $('#messages')\n  const preserveMessageViewport = state.view === 'messages' && messagePanel\n  const beforeHeight = preserveMessageViewport ? messagePanel.scrollHeight : 0\n  const beforeTop = preserveMessageViewport ? messagePanel.scrollTop : 0\n  if (rescueChatKey(state.activeChatId) === chatKey) {\n    state.loadingMore = true",
    'capture message viewport',
)

replace_once(
    'public/rescue-runtime.js',
    "      rescueSaveActiveChat()\n      rescueRenderCurrent()\n      setLoadState(state.hasMore ? '' : 'End of history')",
    "      rescueSaveActiveChat()\n      rescueRenderCurrent()\n      if (preserveMessageViewport) {\n        requestAnimationFrame(() => {\n          const delta = messagePanel.scrollHeight - beforeHeight\n          messagePanel.scrollTop = Math.max(0, beforeTop + delta)\n        })\n      }\n      setLoadState(state.hasMore ? '' : 'End of history')",
    'restore message viewport',
)

# Opening a chat should land on the latest messages (bottom), like Telegram.
replace_once(
    'public/rescue-runtime.js',
    "  setView(preferredView)\n  renderMessagesList()\n  if (preferredView === 'files') {",
    "  setView(preferredView)\n  renderMessagesList()\n  if (preferredView === 'messages') {\n    requestAnimationFrame(() => {\n      const panel = $('#messages')\n      if (panel) panel.scrollTop = panel.scrollHeight\n    })\n  }\n  if (preferredView === 'files') {",
    'scroll opened messages to latest',
)

# Move the selection dock into the center chat workspace so it never spans the sidebar/downloads.
append = """

// Keep selection actions physically inside the center workspace.
const rescueSelectionDock = $('#selection-bar')
const rescueChatPane = $('.chat')
if (rescueSelectionDock && rescueChatPane && rescueSelectionDock.parentElement !== rescueChatPane) {
  rescueChatPane.appendChild(rescueSelectionDock)
}
"""
p = Path('public/rescue-runtime.js')
src = p.read_text()
if 'Keep selection actions physically inside the center workspace.' not in src:
    p.write_text(src.rstrip() + append + '\n')

# Replace old viewport-spanning dock geometry with chat-local positioning.
p = Path('public/rescue-runtime.css')
css = p.read_text()
start = css.find('/* Contextual selection dock */')
if start < 0:
    raise SystemExit('dock css anchor not found')
css = css[:start].rstrip() + r'''

/* Contextual selection dock: center chat workspace only */
.chat { position: relative; }
#selection-bar.selection-dock {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 90;
  min-height: 58px;
  padding: 9px 14px;
  border-radius: 0;
  border: 1px solid var(--border);
  border-left: 0;
  border-right: 0;
  border-bottom: 0;
  background: color-mix(in srgb, var(--panel) 97%, transparent);
  box-shadow: 0 -10px 30px rgba(0, 0, 0, .24);
  backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
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

@media (max-width: 900px) {
  #selection-bar.selection-dock { padding-inline: 8px; gap: 8px; }
  .selection-dock-actions { gap: 5px; }
  .selection-dock-actions button { padding-inline: 8px; }
}
'''
p.write_text(css + '\n')

print('message order and center dock patch applied')
