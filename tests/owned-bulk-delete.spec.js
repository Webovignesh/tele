// @ts-check
'use strict'

const path = require('node:path')
const { test, expect } = require('@playwright/test')

const OWNED_DELETE = path.join(__dirname, '..', 'public', 'owned-bulk-delete.js')

async function fixture (page) {
  const deleteRequests = []
  await page.route('http://filegram.test/**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/filegram/owned-bulk-delete/')) {
      const body = request.postDataJSON()
      deleteRequests.push({ path: url.pathname, body })
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          chatId: Number(url.pathname.split('/').pop()),
          deleted: body.messageIds.length,
          messageIds: body.messageIds
        })
      })
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><html><body>
        <div id="selection-bar" class="selection-dock">
          <span id="selection-count">0 selected</span>
          <div class="selection-dock-actions">
            <button id="forward-selected">Forward</button>
            <button id="download-selected">Download selected</button>
            <button id="mark-completed">Mark completed</button>
            <button id="unmark-completed">Unmark</button>
            <button id="clear-selection">Clear</button>
          </div>
        </div>
        <div id="media-grid"><input type="checkbox" data-key="777:101" checked><input type="checkbox" data-key="777:102" checked></div>
        <div id="messages"></div>
      </body></html>`
    })
  })

  await page.goto('http://filegram.test/')
  await page.evaluate(() => {
    window.state = {
      activeChatId: 777,
      view: 'files',
      chats: [
        { id: 777, title: 'MY CHANNEL', kind: 'channel' },
        { id: 888, title: 'OTHER CHANNEL', kind: 'channel' },
        { id: 999, title: 'MY GROUP', kind: 'supergroup' }
      ],
      selection: new Map([
        ['777:101', { chatId: 777, messageId: 101, name: 'one.txt' }],
        ['777:102', { chatId: 777, messageId: 102, name: 'two.txt' }]
      ]),
      selectedMessages: new Map()
    }
    window.completed = new Set()
    window.__events = []
    window.__toasts = []
    window.handleEvent = event => window.__events.push(event)
    window.toast = (message, kind) => window.__toasts.push({ message, kind })
    window.toastOk = message => window.__toasts.push({ message, kind: 'ok' })
    window.saveCompleted = () => {}
    window.updateSelectionBar = function () {
      const count = window.state.selection.size
      document.querySelector('#selection-count').textContent = `${count} selected`
      return count
    }
    window.request = async (type, payload) => {
      if (type !== 'get-chat-management') throw new Error(`Unexpected request ${type}`)
      const chatId = Number(payload.chatId)
      if (chatId === 777) return { chat: { id: 777, title: 'MY CHANNEL', kind: 'channel' }, permissions: { isOwner: true } }
      if (chatId === 999) return { chat: { id: 999, title: 'MY GROUP', kind: 'supergroup' }, permissions: { isOwner: true } }
      return { chat: { id: chatId, title: 'OTHER CHANNEL', kind: 'channel' }, permissions: { isOwner: false, isAdministrator: true } }
    }
  })
  await page.addScriptTag({ path: OWNED_DELETE })
  await page.evaluate(() => window.updateSelectionBar())
  return { deleteRequests }
}

test('Delete selected is shown only for channels and groups owned by this account', async ({ page }) => {
  await fixture(page)

  const button = page.locator('#fg-delete-selected-owned')
  await expect(button).toBeVisible()
  await expect(button).toHaveText('Delete selected (2)')

  await page.evaluate(() => {
    window.state.activeChatId = 888
    window.state.selection = new Map([['888:201', { chatId: 888, messageId: 201 }]])
    window.updateSelectionBar()
  })
  await expect(button).toBeHidden()
  await page.waitForTimeout(100)
  await expect(button).toBeHidden()

  await page.evaluate(() => {
    window.state.activeChatId = 999
    window.state.selection = new Map([['999:301', { chatId: 999, messageId: 301 }]])
    window.updateSelectionBar()
  })
  await expect(button).toBeVisible()
  await expect(button).toHaveText('Delete selected (1)')
})

test('owned bulk delete confirms, deletes for everyone, and clears selection through the permanent delete path', async ({ page }) => {
  const { deleteRequests } = await fixture(page)

  const button = page.locator('#fg-delete-selected-owned')
  await expect(button).toBeVisible()
  await button.click()

  const modal = page.locator('#fg-owned-delete-modal')
  await expect(modal).toBeVisible()
  await expect(page.locator('#fg-owned-delete-copy')).toContainText('MY CHANNEL')
  await expect(page.locator('#fg-owned-delete-copy')).toContainText('2 selected files')
  await page.locator('#fg-owned-delete-confirm').click()

  await expect.poll(() => deleteRequests.length).toBe(1)
  expect(deleteRequests[0].path).toBe('/api/filegram/owned-bulk-delete/777')
  expect(deleteRequests[0].body).toEqual({ messageIds: [101, 102] })

  await expect.poll(async () => page.evaluate(() => window.state.selection.size)).toBe(0)
  const event = await page.evaluate(() => window.__events.find(item => item && item.name === 'message-delete'))
  expect(event).toMatchObject({
    name: 'message-delete',
    chatId: 777,
    messageIds: [101, 102],
    isPermanent: true,
    fromCache: false
  })
  await expect(button).toBeHidden()
  expect(await page.evaluate(() => window.__toasts.some(item => item.kind === 'ok' && /Deleted 2 files from MY CHANNEL/.test(item.message)))).toBe(true)
})
