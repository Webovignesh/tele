self.addEventListener('install', event => { self.skipWaiting() })
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()) })
self.addEventListener('notificationclick', event => {
  const data = event.notification && event.notification.data ? event.notification.data : {}
  event.notification.close()
  if (data.test) return
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    if (windows.length) {
      const client = windows[0]
      if (client.focus) await client.focus()
      client.postMessage({ type: 'open-chat', chatId: data.chatId })
      return
    }
    if (self.clients.openWindow) await self.clients.openWindow('/')
  })())
})
