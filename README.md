# FileGram

FileGram is a local desktop-style Telegram media/file manager for browsing chats, maintaining persistent media indexes, forwarding messages, high-volume downloads, resilient uploads to owned channels, and bulk deletion in channels/groups you own.

## Local Windows release

FileGram v1.0.0 is intended to run only on your own Windows machine. The HTTP/WebSocket server binds to `127.0.0.1:3000`; it is not exposed to the LAN or Internet.

### One-time installation

1. Keep the repository in its permanent location. Do not move it after creating the shortcuts.
2. Double-click **`Install FileGram.cmd`** once.
3. The installer runs `npm ci`, creates a **FileGram** desktop shortcut and Start Menu entry, then starts FileGram.

After that, use the **FileGram** desktop shortcut. You do not need to open Command Prompt or type `npm start` again. The shortcut silently starts the local server when needed, waits for the FileGram health endpoint, and opens `http://127.0.0.1:3000` in the default browser. If the server is already running, it simply opens FileGram.

A **Stop FileGram** entry is also installed in the FileGram Start Menu folder.

### Uninstall shortcuts

Double-click **`Uninstall FileGram.cmd`** to stop the local server and remove the FileGram shortcuts. This intentionally preserves Telegram login/session data, `.td_database/`, `.td_files/`, `.filegram_state/`, downloads, `config.json`, and `settings.json`.

### Post-release repository cleanup

After the v1.0.0 squash merge is on `main`, double-click **`Clean Repo After Release.cmd`** once. It refuses to run on a dirty working tree, fast-forwards local `main`, removes the known disposable release/development branches (including the retired `agent/saas-foundation` experiment), prunes Git refs, and clears test-report directories.

The cleanup script never deletes `.td_database/`, `.td_files/`, `.filegram_state/`, downloads, `config.json`, or `settings.json`.

## Stack

- Node.js 22+
- Express 5
- WebSocket (`ws`)
- `tdl` + `prebuilt-tdlib`
- Vanilla browser JavaScript and CSS

## Development

```bash
npm ci
npm run verify
npm start
```

The development server binds to `127.0.0.1` and serves the UI at `http://localhost:3000` by default.

## Telegram setup

1. Get an `api_id` and `api_hash` from `https://my.telegram.org` under **API development tools**.
2. Start FileGram using the installed desktop shortcut (or `npm start` while developing).
3. Enter the Telegram API credentials in the UI and complete Telegram login.

Local credentials and machine state are intentionally not committed. `config.json`, `settings.json`, `.env`, TDLib databases, downloads, management uploads, logs, caches, build output, and editor files are ignored by Git.

## Verification

`npm run verify` runs syntax checks followed by the current smoke/invariant suites. The GitHub Actions workflow additionally runs Chromium user-behavior tests and runtime-wiring checks.

## Runtime data

FileGram keeps runtime-only data outside source control:

- `.td_database/` — TDLib session/database state; required for stable login/session behavior
- `.td_files/` — TDLib file cache; required runtime state
- `.filegram_state/` — FileGram ledgers and local launcher state
- `.management_uploads/` — temporary management uploads
- `downloads/` — downloaded media
- `config.json` — local Telegram API configuration
- `settings.json` — machine-local app settings

Do not commit or casually delete these paths.

## Project layout

- `server.js` — TDLib, HTTP/WebSocket API, indexing, downloads, forwarding, and management backend
- `public/` — browser application and UI runtime
- `scripts/` — verification tests plus local install/launch/cleanup tooling
- `FileGram.vbs` — silent desktop launcher target
- `Install FileGram.cmd` — one-time Windows installer
- `Clean Repo After Release.cmd` — guarded post-release Git cleanup
- `download-dedupe-preload.js` — download dedupe preload
- `tdl-upload-compat.js` — TDLib upload compatibility preload
- `thumb-cache-preload.js` — thumbnail cache/runtime preload
- `session-preload.js` — stable TDLib session/logout bridge
- `packMedia.js` / `packSelected.js` — ZIP packaging helpers used by the server

## Git workflow

`main` is the canonical local-product branch. Keep the working tree clean and run `npm run verify` before changing it. Release feature work should be squash-merged so `main` remains readable and easy to roll back.
