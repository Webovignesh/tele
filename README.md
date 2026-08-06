# Tele Scraper

A web app that connects to your personal Telegram account via [TDlib](https://core.telegram.org/tdlib)
and lets you browse chats and download media files **fast**, with **multiple parallel downloads**.

Built on:
- [tdl](https://github.com/eilvelia/tdl) + [prebuilt-tdlib](https://github.com/tdlib/td/tree/master/example/node) (official TDLib native library, no compilation needed)
- Node.js (Express + WebSocket)

## How it works

- TDLib downloads each file using many simultaneous connections to Telegram's servers (already very fast per file).
- The app runs **multiple files at once** (default 5, configurable) so the aggregate speed scales further.
- Progress, per-file speed, and total speed are streamed live to the browser.
- Finished files are moved to `downloads/<chat title>/<file name>` and are also downloadable from the browser.

## Setup

1. Install Node.js v16+ (already required).
2. `npm install`
3. Get Telegram API credentials (free, 2 minutes):
   - Open https://my.telegram.org and log in with your Telegram account.
   - Click **API development tools**.
   - Fill in the app title and short name (anything works, e.g. "TeleScraper").
   - Copy the `api_id` (number) and `api_hash` (hex string).
4. Either:
   - run `npm start`, open **http://localhost:3000** and paste your `api_id` / `api_hash` in the web UI (saved to `config.json`), **or**
   - copy `.env.example` to `.env` and fill in `API_ID` and `API_HASH`.
5. In the web UI, log in with your phone number and the code you receive.
   If the account has 2-step verification, enter that password too.
6. Browse a chat, tick the files you want (or **Download all media**), and watch them fly into `downloads/`.

## Options (in `.env`)

| Variable      | Default | Description                                        |
| ------------- | ------- | -------------------------------------------------- |
| `API_ID`      | —       | Your Telegram api_id                               |
| `API_HASH`    | —       | Your Telegram api_hash                             |
| `PORT`        | `3000`  | Web UI port                                        |
| `CONCURRENCY` | `5`     | Number of files downloading simultaneously         |

## Notes

- Your session is saved locally (`.td_database`), so you only log in once.
- Cached/partial downloads are kept by TDLib in `.td_files`, so a cancelled download resumes instantly next time.
- Secret chats are hidden (TDLib doesn't allow downloading media from them via this API path).
- This uses **your own account** — you can only browse what your account can see.

## Troubleshooting

- **`Dynamic Loading Error: Win32 error 126`** — the prebuilt `tdjson.dll` failed to load; make sure `node_modules/prebuilt-tdlib` is intact and you ran `npm install` in this folder.
- **Login code never arrives** — double-check your `api_id`/`api_hash` are correct, and that you entered the phone number in international format.
- **Slow aggregate speed** — raise `CONCURRENCY` (e.g. 10–20). Each extra file adds more parallel connections.
