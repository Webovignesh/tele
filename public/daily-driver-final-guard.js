'use strict'

/* Final media-index presentation guard.
 * scan-media-v3 may emit thousands of 100-message progress batches. Those
 * batches are transport progress, not authoritative UI state. Keep the last
 * complete per-chat index visible and replace it only when the request returns
 * its complete snapshot. For an uncached chat, show an indexing state until the
 * complete result arrives instead of flashing 100/200/300... as fake totals.
 */

const teleFinalGuardBaseHandleEvent = handleEvent
handleEvent = function teleFinalGuardHandleEvent (event) {
  if (event && event.name === 'media-index-progress') {
    const payload = event.payload || {}
    if (state.activeChatId != null && String(payload.chatId) === String(state.activeChatId) && state.view === 'files') {
      const cached = rescueFileCache.get(String(state.activeChatId))
      if (cached && cached.done !== false && Array.isArray(cached.items)) {
        setLoadState(`Cached ${cached.items.length.toLocaleString()} files · syncing in background`)
      } else {
        setLoadState('Indexing files…')
      }
      updateMediaCountLabel()
    }
    return
  }
  return teleFinalGuardBaseHandleEvent(event)
}
