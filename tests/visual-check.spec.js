// @ts-check
const { test, expect } = require('@playwright/test');

test('FileGram loads and shows login or main screen', async ({ page }) => {
  await page.goto('http://127.0.0.1:3000', { waitUntil: 'networkidle', timeout: 15000 });
  
  // Wait for boot status to disappear
  await page.waitForFunction(() => {
    return !document.getElementById('boot-status');
  }, { timeout: 10000 }).catch(() => {});
  
  // Wait a bit for UI to settle
  await page.waitForTimeout(2000);
  
  // Take full page screenshot
  await page.screenshot({ path: 'tests/screenshot-full.png', fullPage: false });
  
  // Check that at least one screen is visible
  const visible = await page.evaluate(() => {
    const main = document.querySelector('#main-screen:not(.hidden)');
    const login = document.querySelector('#login-screen:not(.hidden)');
    const config = document.querySelector('#config-screen:not(.hidden)');
    return !!(main || login || config);
  });
  
  expect(visible).toBeTruthy();
});

test('Three-column layout renders correctly when authenticated', async ({ page }) => {
  await page.goto('http://127.0.0.1:3000', { waitUntil: 'networkidle', timeout: 15000 });
  
  await page.waitForFunction(() => {
    return !document.getElementById('boot-status');
  }, { timeout: 10000 }).catch(() => {});
  
  await page.waitForTimeout(2000);
  
  // Check if we're on the main screen (authenticated)
  const isMain = await page.evaluate(() => {
    const main = document.querySelector('#main-screen:not(.hidden)');
    return !!main;
  });
  
  if (!isMain) {
    console.log('Not authenticated - skipping layout test');
    return;
  }
  
  // Verify three-column grid
  const layout = await page.evaluate(() => {
    const app = document.querySelector('.app');
    if (!app) return null;
    const style = window.getComputedStyle(app);
    return {
      display: style.display,
      gridTemplateColumns: style.gridTemplateColumns,
    };
  });
  
  expect(layout).not.toBeNull();
  expect(layout.display).toBe('grid');
  
  // Take screenshot of main app
  await page.screenshot({ path: 'tests/screenshot-main.png', fullPage: false });
  
  // Verify sidebar, chat, downloads panels exist and are visible
  const panels = await page.evaluate(() => {
    const sidebar = document.querySelector('.sidebar');
    const chat = document.querySelector('.chat');
    const downloads = document.querySelector('.downloads');
    return {
      sidebar: sidebar ? sidebar.offsetWidth > 0 : false,
      chat: chat ? chat.offsetWidth > 0 : false,
      downloads: downloads ? downloads.offsetWidth > 0 : false,
    };
  });
  
  expect(panels.sidebar).toBeTruthy();
  expect(panels.chat).toBeTruthy();
  expect(panels.downloads).toBeTruthy();
});
