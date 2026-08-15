# FileGram

FileGram is a local desktop-style web app for browsing Telegram chats, indexing chat media, forwarding messages, and managing high-volume downloads through TDLib.

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

The server binds to `127.0.0.1` and serves the UI at `http://localhost:3000` by default.

## Telegram setup

1. Get an `api_id` and `api_hash` from `https://my.telegram.org` under **API development tools**.
2. Start FileGram with `npm start`.
3. Open `http://localhost:3000`.
4. Enter the Telegram API credentials in the UI and complete Telegram login.

Local credentials and machine state are intentionally not committed. `config.json`, `settings.json`, `.env`, TDLib databases, downloads, management uploads, logs, caches, build output, and editor files are ignored by Git.

## Verification

`npm run verify` runs syntax checks followed by the current smoke suites. Run it before committing changes to `main`.

## Runtime data

FileGram keeps runtime-only data outside source control:

- `.td_database/` — TDLib session/database state
- `.td_files/` — TDLib file cache
- `.management_uploads/` — temporary management uploads
- `downloads/` — downloaded media
- `config.json` — local Telegram API configuration
- `settings.json` — machine-local app settings

Do not commit these paths.

## Project layout

- `server.js` — TDLib, HTTP/WebSocket API, indexing, downloads, forwarding, and management backend
- `public/` — browser application and UI runtime
- `scripts/` — verification/smoke tests
- `download-dedupe-preload.js` — download dedupe preload
- `tdl-upload-compat.js` — TDLib upload compatibility preload
- `thumb-cache-preload.js` — thumbnail cache/runtime preload
- `session-preload.js` — stable TDLib session/logout bridge
- `packMedia.js` / `packSelected.js` — ZIP packaging helpers used by the server

## Git workflow

`main` is the canonical development branch. Keep the working tree clean, run `npm run verify`, and commit only source/configuration changes that belong in the repository.
