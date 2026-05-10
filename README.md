# WhatsApp Scheduler

Personal WhatsApp scheduled-message sender, built on Node.js, [whatsapp-web.js](https://wwebjs.dev/), Express, SQLite (better-sqlite3) and node-cron. Runs locally or on a small VPS, with a minimal web dashboard.

> **WARNING — Terms of Service**
> Automating WhatsApp Web (including via whatsapp-web.js) may violate WhatsApp's Terms of Service. Your account can be flagged, throttled, or banned at any time. **Use this only for your own personal, consented messaging.** Do not send unsolicited, commercial, or bulk messages. You accept all risk for how you use this tool.

---

## Features

- WhatsApp Web auth via QR (LocalAuth — session persists across restarts)
- Schedule one-time or recurring messages (daily / weekly / monthly / custom cron)
- Three message kinds: **text**, **voice note** (PTT), and **audio file** (with optional caption)
- Browser audio recording — record a voice note straight from the dashboard, no upload step
- Send to individual numbers (`@c.us`) or groups (`@g.us`)
- Web dashboard at `http://localhost:3000` with live status, QR display, table + history
- REST API: `GET/POST/PUT/DELETE /api/messages`, `GET /api/status`, `GET /api/messages/:id/media`
- SQLite store with per-message status, errors, sent timestamps
- Rate limit between sends (default 4s)
- Daily-rotated logs in `logs/`
- PM2-ready (`ecosystem.config.js`)
- Configurable behavior for missed sends during downtime

## Requirements

- Node.js LTS (>=18.17)
- Chromium dependencies for Puppeteer
  - On Debian/Ubuntu: `sudo apt-get install -y chromium libnss3 libatk-bridge2.0-0 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 libasound2`
  - On Windows: works out of the box.

## Installation

```bash
git clone <your-repo> whatsapp-scheduler
cd whatsapp-scheduler
cp .env.example .env
npm install
```

Edit `.env` to your liking:

```
PORT=3000
TIMEZONE=Asia/Amman
SEND_MISSED_ON_STARTUP=false
RATE_LIMIT_MS=4000
```

- `TIMEZONE` is informational only (used by the dashboard label). All datetimes are stored in UTC.
- `SEND_MISSED_ON_STARTUP=true` will send messages whose `send_at` was missed during downtime. `false` (default) marks missed messages as failed and skips them, but still rolls over their recurrence.
- `RATE_LIMIT_MS` is the gap between consecutive sends inside a scheduler tick. WhatsApp recommends spacing messages out — keep this between 3000 and 8000 for safety.

## First-time authentication

1. Start the app: `npm start`
2. Open `http://localhost:3000`. A QR code appears at the top of the page.
3. On your phone: **WhatsApp → Settings → Linked Devices → Link a Device** and scan the QR.
4. Once paired, the status indicator turns green ("connected"). The session is saved to `./.wwebjs_auth/`, so you don't need to re-scan after restart.

## Scheduling a message

From the dashboard:
- Pick **Individual** for a phone number; enter it with country code, no spaces or dashes (e.g. `962790000000`).
- Pick **Group** for a group; enter the group ID like `1234567890-1234567890` (or paste the full `...@g.us` JID).
- Enter the message, pick a local datetime, and optionally a recurrence:
  - `daily`, `weekly`, `monthly`
  - or any 5-field cron, e.g. `0 9 * * 1-5` for weekdays at 09:00 UTC

> Cron expressions are evaluated in **UTC**. Account for the offset between your local time and UTC when writing them.

## Voice & audio messages

Pick **Voice note** or **Audio file** under "Message kind" in the dashboard.

- **Voice note** — sent as a WhatsApp PTT (push-to-talk). Shows as a voice bubble with waveform on the recipient's side. WhatsApp does not display captions on voice notes.
- **Audio file** — sent as a regular audio attachment. The "Message" field, if filled, is sent as the caption.

You can either:
1. Pick a file from disk (`audio/*` accepted), or
2. Click **Record** to capture from your browser's microphone, **Stop** when done, and preview before scheduling.

**Voice notes are transcoded server-side** to `audio/ogg; codecs=opus` (16 kHz mono, 32 kbps) — the exact format WhatsApp's own voice messages use — so it doesn't matter what format your browser records in. The transcoder is bundled (`@ffmpeg-installer/ffmpeg`), so no system-wide ffmpeg install is required. This adds ~30 MB to `node_modules/`.

Audio-file uploads are *not* transcoded — the file you upload is sent as-is, with the message text used as its caption.

Constraints:
- Max upload size: **25 MB**.
- Accepted MIME types: `audio/ogg`, `audio/opus`, `audio/mpeg` (mp3), `audio/mp4` / `audio/x-m4a`, `audio/aac`, `audio/wav`, `audio/webm`.

Recurring voice/audio messages reuse the same file on disk for every roll-over — no per-fire copies.

The `POST /api/messages` and `PUT /api/messages/:id` endpoints accept the message as `multipart/form-data` with field name **`audio`** for the file (also `message_type=voice` or `message_type=audio`). Plain `application/json` still works for text messages.

```bash
curl -X POST http://localhost:3000/api/messages \
  -F recipient=962790000000 \
  -F message_type=voice \
  -F send_at=2026-05-08T18:30:00Z \
  -F audio=@./hello.ogg
```

Stored files live in `./uploads/`. The folder is gitignored. When you delete a scheduled message that no other (recurring) row references, the underlying file is removed; otherwise it stays until the last reference is gone.

## How to find a group ID

After authentication, in a Node REPL or a one-off script:

```js
const { Client, LocalAuth } = require('whatsapp-web.js');
const c = new Client({ authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }) });
c.on('ready', async () => {
  const chats = await c.getChats();
  for (const chat of chats.filter(c => c.isGroup)) {
    console.log(chat.name, chat.id._serialized);
  }
});
c.initialize();
```

The dashed `1234567890-1234567890` portion is the group ID.

## Running with PM2

```bash
npm install -g pm2
pm2 start ecosystem.config.js
pm2 logs whatsapp-scheduler   # or: npm run pm2:logs
pm2 save                       # persist process list
pm2 startup                    # generate boot-time hook
```

Stop / restart:

```bash
pm2 stop whatsapp-scheduler
pm2 restart whatsapp-scheduler
```

PM2 logs are written to `logs/pm2-out.log` and `logs/pm2-error.log`. Application logs are also written to `logs/app-YYYY-MM-DD.log` with daily rotation.

## REST API

| Method | Path                         | Body / params                                                                 |
|--------|------------------------------|-------------------------------------------------------------------------------|
| GET    | `/api/status`                | —                                                                              |
| GET    | `/api/qr`                    | — (returns `{ qr: <data-url> }` when a QR is pending)                          |
| GET    | `/api/messages`              | —                                                                              |
| GET    | `/api/messages/history`      | —                                                                              |
| GET    | `/api/messages/:id`          | —                                                                              |
| POST   | `/api/messages`              | `{ recipient, chat_type?, message_text, send_at, recurrence? }`                |
| PUT    | `/api/messages/:id`          | same as POST (only allowed while status is `pending`)                          |
| DELETE | `/api/messages/:id`          | —                                                                              |

`send_at` accepts any value `new Date(...)` understands (ISO strings recommended). `recurrence` accepts `daily`, `weekly`, `monthly`, or a 5-field cron expression.

Example:

```bash
curl -X POST http://localhost:3000/api/messages \
  -H 'Content-Type: application/json' \
  -d '{
    "recipient": "962790000000",
    "message_text": "Hello from the scheduler",
    "send_at": "2026-05-08T18:30:00Z",
    "recurrence": "daily"
  }'
```

## Backups

Three things matter:

1. **Session** — `./.wwebjs_auth/`. Copying this folder lets you avoid re-scanning the QR on a new machine. Keep it private; it is effectively your WhatsApp credentials.
2. **Database** — `./data/scheduler.db` (plus `-wal` and `-shm` files when using WAL mode). To take a safe online backup:
   ```bash
   sqlite3 data/scheduler.db ".backup data/scheduler.backup.db"
   ```
3. **Uploads** — `./uploads/` holds audio files referenced by scheduled voice/audio messages. Without these, recurring voice messages will fail.

A simple full backup is:

```bash
tar czf whatsapp-scheduler-backup-$(date +%F).tgz data uploads .wwebjs_auth
```

Restore is the reverse — extract the tarball into a fresh checkout, then `npm install && npm start`.

## How the scheduler behaves

- A cron job runs every minute. It fetches all messages where `status='pending' AND send_at <= now`, sends them sequentially, and waits `RATE_LIMIT_MS` between sends.
- Sends are deferred while the WhatsApp client is not `ready` (e.g. during reconnect). When the client becomes ready, the scheduler runs an immediate catch-up tick.
- For recurring messages: when a send completes (or fails), a new pending row is created with the next computed `send_at`. The original row keeps its terminal status (`sent` or `failed`) for history.
- Missed during downtime: if `SEND_MISSED_ON_STARTUP=false`, any pending message older than 5 minutes past its `send_at` is marked failed with reason "Skipped: missed during downtime". Its recurrence still rolls over.

## Project structure

```
whatsapp-scheduler/
├── src/
│   ├── index.js
│   ├── whatsapp-client.js
│   ├── scheduler.js
│   ├── db.js
│   ├── server.js
│   ├── logger.js
│   ├── routes/messages.js
│   └── utils/
│       ├── phone.js
│       └── recurrence.js
├── public/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── data/                   # SQLite (gitignored)
├── uploads/                # voice / audio files (gitignored)
├── logs/                   # rotated logs (gitignored)
├── .wwebjs_auth/           # WhatsApp session (gitignored)
├── .env.example
├── package.json
├── ecosystem.config.js
└── README.md
```

## Scripts

| Command               | What it does                                                |
|-----------------------|-------------------------------------------------------------|
| `npm start`           | Start the app                                               |
| `npm run dev`         | Start with nodemon (auto-restart)                           |
| `npm run pm2:start`   | `pm2 start ecosystem.config.js`                             |
| `npm run pm2:logs`    | Tail PM2 logs                                               |
| `npm run pm2:stop`    | Stop the PM2 process                                        |
| `npm run pm2:restart` | Restart                                                     |
| `npm run reset:cache` | Delete `.wwebjs_cache/` (safe — keeps your session)         |
| `npm run reset:auth`  | Delete `.wwebjs_auth/` (forces a new QR scan)               |
| `npm run reset:all`   | Delete both                                                 |

## Troubleshooting

### `Runtime.callFunctionOn timed out` / `protocolTimeout`

Symptom: app starts, never shows a QR, eventually logs:
```
WhatsApp initialize failed { error: "Runtime.callFunctionOn timed out..." }
```

This is the bundled Chromium failing to inject WhatsApp Web's scripts. Almost always one of:
- Stale `.wwebjs_cache/` from a previous half-finished run
- A leftover `chrome.exe` / `node.exe` holding file locks
- A genuinely slow first-run (Chromium first launch on Windows can take 60-90 s)

**Fix sequence (Windows PowerShell):**
```powershell
# 1. Stop the app (Ctrl+C in its console)
# 2. Kill any leftover chromium / node from a previous run
Get-Process chrome, chromium, node -ErrorAction SilentlyContinue | Stop-Process -Force
# 3. Wipe the browser cache (keeps your session)
npm run reset:cache
# 4. Try again
npm start
```

If it still times out after that, your session may be wedged — wipe it too and re-scan the QR:
```powershell
npm run reset:auth
npm start
```

### Stuck on "loading 99%"

WhatsApp Web sometimes hangs at 99%. Wait a full 2 minutes — the dashboard will say `connected` once the `ready` event fires. If it doesn't, `npm run reset:cache` and restart.

### Can't reach `web.whatsapp.com`

If the host is behind a corporate proxy or VPN, Puppeteer's bundled Chromium may not pick it up. You can pass it via env:
```powershell
$env:HTTPS_PROXY = "http://proxy.example.com:8080"
npm start
```
(I haven't wired this directly into the launch args — open an issue if you need it.)

## End-to-end test

1. `npm start` and scan the QR.
2. In the dashboard, schedule a message to your own number for ~1 minute from now.
3. Watch the table — the row's status flips from `pending` → `sent`, and the message arrives in WhatsApp. The row also appears in the **History** section.
