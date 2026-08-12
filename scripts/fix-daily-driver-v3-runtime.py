from pathlib import Path

path = Path('public/telegram-daily-driver-v3.js')
text = path.read_text()

old = """function teleV3RenderFilesNow () {
  const grid = $('#media-grid')
"""
new = """function teleV3RenderFilesNow () {
  if (typeof dragSel !== 'undefined' && dragSel) {
    setTimeout(() => renderFiles(), 90)
    return
  }
  const grid = $('#media-grid')
"""
if text.count(old) != 1:
    raise SystemExit(f'render guard target count: {text.count(old)}')
text = text.replace(old, new, 1)

old = """  if (composer) chat.insertBefore(dock, composer)
  else {
    const foot = $('.chat-foot')
    if (foot) chat.insertBefore(dock, foot)
  }
  updateSelectionBar()
}
teleV3MountSelectionDock()
"""
new = """  if (composer) {
    if (dock.nextElementSibling !== composer) chat.insertBefore(dock, composer)
  } else {
    const foot = $('.chat-foot')
    if (foot && dock.nextElementSibling !== foot) chat.insertBefore(dock, foot)
  }
  updateSelectionBar()
}
teleV3MountSelectionDock()

let teleV3BlankPointer = null
const teleV3SelectionGrid = $('#media-grid')
if (teleV3SelectionGrid) {
  teleV3SelectionGrid.addEventListener('mousedown', event => {
    if (event.button !== 0 || event.target.closest('.gcard,input,button,a,select')) return
    teleV3BlankPointer = {
      x: event.clientX,
      y: event.clientY,
      files: new Map(state.selection),
      messages: new Map(state.selectedMessages)
    }
  }, true)
  document.addEventListener('mouseup', event => {
    const snapshot = teleV3BlankPointer
    teleV3BlankPointer = null
    if (!snapshot) return
    if (Math.abs(event.clientX - snapshot.x) >= 6 || Math.abs(event.clientY - snapshot.y) >= 6) return
    setTimeout(() => {
      if (!snapshot.files.size && !snapshot.messages.size) return
      state.selection = new Map(snapshot.files)
      state.selectedMessages = new Map(snapshot.messages)
      renderFiles()
      updateSelectionBar()
    }, 0)
  })
}
"""
if text.count(old) != 1:
    raise SystemExit(f'dock target count: {text.count(old)}')
text = text.replace(old, new, 1)

path.write_text(text)
print('v3 runtime selection/layout hardening applied')
