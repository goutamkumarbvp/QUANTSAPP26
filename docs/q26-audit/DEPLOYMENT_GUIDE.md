# Q26 Options — Deployment Guide

Q26 is a **paper-trading** options-analytics program. It reads live market data from Kotak Neo and official
end-of-day files from NSE/BSE. It never sends an order to a broker, and no setting can change that
(`apps/server/src/safety.ts`).

## 1. Requirements

| Item | Requirement |
|---|---|
| Runtime | Node.js ≥ 20.12 (Node 22 LTS recommended; the Docker image uses `node:22-alpine`) |
| Memory / disk | 1 GB RAM; disk for `DATA_DIR`. Recorded sessions grow every trading day; the watchdog warns below 1 GB free |
| Outbound network | HTTPS/WSS to `*.kotaksecurities.com` (login, REST, scrip master, SFeed). HTTPS to `nsearchives.nseindia.com`, `archives.nseindia.com`, `www.nseindia.com` and `www.bseindia.com` (EOD files, FII/DII, holidays) |
| Clock | NTP-synchronised. TOTP codes are generated from the host clock |
| Kotak Neo | A Neo Trade API v2 consumer key, plus the registered mobile number, UCC, MPIN and TOTP setup key |

## 2. Configuration (`.env` at the repository root)

Copy `.env.example` to `.env` and fill it in. The file is excluded from git and Docker builds (`.gitignore`,
`.dockerignore`). Restrict it to the service user: `chmod 600 .env`.

| Variable | Required | Notes |
|---|---|---|
| `NEO_CONSUMER_KEY`, `NEO_MOBILE_NUMBER`, `NEO_UCC`, `NEO_MPIN`, `NEO_TOTP_SECRET` | for live data | All five. Without them the app runs in DATA UNAVAILABLE mode, serving official EOD files and recorded history only |
| `AUTH_SECRET` | yes, in production | A random value of at least 16 characters, e.g. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. A placeholder or short value is ignored with a warning |
| `HOST` / `PORT` | — | Default `0.0.0.0:8787`. Use `127.0.0.1` behind a reverse proxy |
| `DATA_DIR` | — | Default `apps/server/data`. Holds `db.json`, recorded sessions (`market/`), EOD files (`eod/`), the instrument master (`refdata/`) and operations data (`ops/`) |
| `PERSIST` | — | `true` (default). `false` keeps users and paper trades in memory only |
| `LOG_LEVEL`, `LOG_FORMAT`, `NO_COLOR` | — | Terminal output: see the README |
| `EOD_BACKFILL_DAYS`, `SFEED_TOKEN_BUDGET`, `RISK_FREE_RATE`, `HOLIDAYS` | — | See the README |

The server never prints, returns or stores credential values. Errors name the variable only.

## 3. Build and verify

```bash
npm ci
npm run typecheck && npm test && npm run build
npm run test:e2e          # optional: browser tests (Chromium required)
npm audit --omit=dev      # runtime dependency advisories
```

## 4. Run

### 4.1 Supervised (recommended for 24×7)

```bash
npm run start:supervised
```

`scripts/supervise.mjs` starts `apps/server/dist/server.mjs`. It starts the server again after:

- a crash (back-off 1 s doubling to 60 s);
- a watchdog restart request (exit code 75);
- a hang: `GET /api/health` failing 3 times in a row, checked every 30 s after a 90 s start-up grace (SIGTERM, then SIGKILL after 15 s).

To run it as a system service, use systemd (`Restart=always`, `User=q26`, `WorkingDirectory=<repo>`,
`ExecStart=/usr/bin/npm run start:supervised`), or Docker as shown below.

### 4.2 Docker

```bash
docker build -t q26-options .
docker run -d --restart unless-stopped -p 127.0.0.1:8787:8787 --env-file .env \
  -v q26-data:/app/apps/server/data --name q26 q26-options
```

The image runs as the unprivileged `node` user, starts the supervisor and has a `HEALTHCHECK` on `/api/health`.
*Not verified in this audit:* Docker is not available in the audit environment, so the image was not built
here (see TEST_EXECUTION_REPORT.md).

### 4.3 Exposure

The app has no TLS of its own, and CORS accepts any origin. Do not expose port 8787 to the internet directly.
Put it behind a reverse proxy with TLS (nginx or Caddy) and restrict access by firewall or VPN. Sign-in and
operations actions are rate-limited per client address. Running operations needs a registered account, not a
guest.

## 5. After start: what the terminal shows

```
HH:MM:SS INFO  Q26 Options on :8787 — open http://localhost:8787 — live data only, paper trading only; IST …
HH:MM:SS INFO  Kotak credentials: found (.env); logging in…
HH:MM:SS INFO  login monitor every 5 s, watchdog every 30 s (supervised), weekly audit Saturdays 10:00 IST
HH:MM:SS INFO  Kotak Neo logged in (data centre …, baseUrl …, token expires …)
HH:MM:SS INFO  live data: Kotak logged in; feed connected (N subscribed); instrument master …; EOD F&O …
```

A warning appears only when something needs attention: a login failure, an unreachable feed, NSE/BSE down, a
watchdog finding or a weak `AUTH_SECRET`. Each warning carries its reason and the time of the next attempt.

## 6. Operations checklist

- **Home → Operations panel:**
  - **Broker** must be `CONNECTED`.
  - **Market data** reads `LIVE` during market hours. `FEED STALE` / `DATA UNAVAILABLE` / `MARKET CLOSED` explain the other states.
  - **Live trading** always reads `NOT READY`, because this program places paper orders only.
- **Login monitor `PAUSED`** means Kotak refused 5 logins in a row. Fix the NEO_* values in `.env`, restart, or press **Re-login now** once.
- **Weekly audit:** read the Saturday report (`DATA_DIR/ops/audits/`). FAIL items need a person.
- **Backups:** see ROLLBACK_AND_RECOVERY.md.
