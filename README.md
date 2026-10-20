# Q26 Options

An options-analytics and paper-trading platform for Indian F&O (NSE / BSE), modelled on the feature set of
Quantsapp — option chain, open-interest suite, implied-volatility suite, strategy builder, strategy wizard,
optimizer, straddle & strategy charts, trade recap, scanners, unusual option activity, synopsis heat-map,
order-book analytics, FII/DII & participant data, watchlists, alerts, rule-based algos and a paper broker.

> **Live data only.** Market data comes from the Kotak Neo Trade API (your own account) and from the official
> NSE/BSE end-of-day files. Nothing is synthesised: a value the sources do not provide is shown as **—** with
> the reason. **Paper trading only** — no order is ever sent to the broker. Not investment advice.
> See [docs/AUDIT.md](docs/AUDIT.md) for the feature map and [docs/live-data/DESIGN.md](docs/live-data/DESIGN.md)
> for the data architecture.

## Data sources

| Source | What it provides |
|---|---|
| **Kotak Neo Trade API v2** — TOTP + MPIN login | Session for everything below |
| Kotak scrip master (daily CSV) | Instrument list: underlyings, expiries, strikes, lot sizes, tokens |
| Kotak SFeed websocket | Live ticks for index spots (incl. INDIA VIX), near futures, index option chains (2 nearest expiries, ±8 % strikes, re-centred), every contract you use (orders, positions, strategies, alerts, watchlists, running algos), and 5-level depth for open Order Book views |
| Kotak REST | Quotes on demand, option-chain sweep for stock options (one stock per ≥1.5 s), 1-minute historical candles for **active** contracts |
| NSE / BSE official EOD files | F&O and cash bhavcopy (NSE UDiFF, BSE F&O), index closes, participant-wise OI / volume, FII/DII cash flows, holiday master |

**Derived on the server from those inputs** (labelled where they are estimates):

- **IV and Greeks** — solved from live option premiums (Black-Scholes on the forward from the future, put-call
  parity or spot); daily IV history is solved from bhavcopy premiums. `RISK_FREE_RATE` is a config input.
- **PCR, max pain, build-up** (long/short build-up, short covering, long unwinding) — from live OI and price.
- **Margin** — a SPAN-style *estimate* on live spot, IV and forward; broker margins differ.
- **Order flow** — an *estimate*: each traded volume increment is classified buyer- or seller-initiated with the
  quote rule (last price at/above the prior ask = buy, at/below the prior bid = sell, otherwise unclassified).
  Only meaningful if the feed reports each trade.
- **HV, IV rank / percentile, volatility cone** — from official daily closes and daily IV.

**When a value is blank:** without Kotak credentials or before login, nothing live is shown; before the
instrument master loads, no contract is known; before the first stock-option sweep, stock scanners are empty;
an official file that is not published yet (or is blocked) leaves its screen blank; an illiquid contract with
no live bid/ask cannot be paper-traded at market. Each blank shows its reason.

### History

There is no back-catalogue of synthetic history. History comes from:

- **The recorder** — while the server runs it writes every streamed instrument's minutes and chain aggregates to
  `DATA_DIR/market/YYYY-MM-DD/`. Intraday history (OI trend, multi-strike OI, intraday PCR / max pain,
  straddle, strategy chart, ORB, order flow, Trade Recap, as-of chains `GET /api/chain/NIFTY?at=<epoch ms>`,
  algo backtests) exists **from the first recorded session onward** and only for what was streamed.
- **Kotak 1-minute historical candles** — fill some intraday charts for contracts that are still listed (recent
  sessions only; expired contracts are not served).
- **Official EOD backfill** — at start and daily (≈18:30–23:30 IST) the server fetches missing NSE/BSE files for
  the last `EOD_BACKFILL_DAYS` sessions into `DATA_DIR/eod/`. Daily PCR, IV rank / percentile, HV, cone,
  participant and FII/DII history come from these.

## Quick start

Requires Node.js ≥ 20.12 (the server loads `.env` with `process.loadEnvFile`).

```bash
npm install
cp .env.example .env     # then fill in the NEO_* values (see below)
npm run dev              # API on :8787 + web on :5173 (proxied) → open http://localhost:5173
```

Production (single process serving API, WebSocket and the built web app):

```bash
npm run build
npm start                # http://localhost:8787
npm run start:supervised # the same, restarted after a crash, a hang or a watchdog restart request (24×7)
```

Docker (the image does not contain `.env`; pass it at run time):

```bash
docker build -t q26-options .
docker run -p 8787:8787 --env-file .env -v q26-data:/app/apps/server/data q26-options
```

## Configuration

The server reads `.env` from the repository root (and then `apps/server/.env`); variables already set in the
environment win. Credential values are never logged, returned by an API or written anywhere else; errors name
the variable only.

**Kotak Neo credentials** (all five required for live data; without them the app starts, shows why it is not
logged in, and serves only official EOD files and already-recorded history):

| Variable | Meaning |
|---|---|
| `NEO_CONSUMER_KEY` | API access token from the Neo dashboard |
| `NEO_MOBILE_NUMBER` | Registered mobile number (10 digits, optionally +91) |
| `NEO_UCC` | Client code (UCC) |
| `NEO_MPIN` | MPIN (digits) |
| `NEO_TOTP_SECRET` | Base32 TOTP setup key (the server generates the 6-digit codes) |

**Other settings** (`apps/server/src/config.ts`):

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | API listen address |
| `RISK_FREE_RATE` | `0.065` | Used for IV, Greeks and margin estimates |
| `HOLIDAYS` | — | Comma-separated `YYYY-MM-DD` exchange holidays, merged with NSE's holiday master |
| `AUTH_SECRET` | random per boot | HMAC secret for app session tokens — **set a long random value (≥ 16 characters) in production** so sessions survive restarts; a placeholder such as `change-me` or a shorter value is ignored with a warning |
| `DATA_DIR` | `apps/server/data` | User data (`db.json`), recorded sessions and EOD files |
| `PERSIST` | `true` | `false` keeps user data in memory only |
| `EOD_BACKFILL_DAYS` | `30` | Sessions checked for missing NSE/BSE files at start and daily (`0` = none) |
| `SFEED_TOKEN_BUDGET` | `2700` | Cap on streamed SFeed subscriptions (max 2,700 of Kotak's 3,000) |
| `WEB_DIST` | `apps/web/dist` | Built web app served by the API |
| `OPS_ADMIN_EMAILS` | — | Comma-separated e-mails of the registered accounts allowed to run the operations buttons. Empty: only the first account registered on the server (its owner) |
| `LOG_LEVEL` | `info` | Terminal detail: `trace`, `debug` (adds one line per HTTP request and per retry), `info`, `warn`, `error` |
| `LOG_FORMAT` | readable | `json` writes pino JSON lines (for log collectors) instead of `HH:MM:SS LEVEL message` in IST |
| `NO_COLOR` | — | Set to turn off colours in the terminal |
| `ALERT_WEBHOOK_URL` | — | Optional webhook (Slack / Discord / ntfy) that receives the operations alerts (watchdog CRITICAL, login PAUSED, audit FAIL). Operators always get them as in-app notifications too |
| `TRUST_PROXY` | — | Address(es) of your reverse proxy (or `true`), so rate limits apply per real client |
| `WS_ALLOWED_ORIGINS` | — | Extra browser origins allowed to open the market-data socket (default: this server's own host name) |

### Network allowlist

The server needs outbound HTTPS (and WSS for the feed) to:

- `*.kotaksecurities.com` — login, REST, scrip master, SFeed websocket
- `nsearchives.nseindia.com`, `archives.nseindia.com` — NSE bhavcopy, index closes, participant files
- `www.nseindia.com` — FII/DII and holiday master (unofficial JSON; blank when blocked)
- `www.bseindia.com` — SENSEX / BANKEX F&O bhavcopy

## Operations: login monitor, 24×7 watchdog, weekly audit

Three engines run inside the server; the **Operations** panel on the Home dashboard shows them, with one button
each. The buttons need an operator account: one listed in `OPS_ADMIN_EMAILS`, or — when that is empty — the first
account registered on the server; guests and other accounts see the status only. Everything they see and do is written to
`DATA_DIR/ops/journal/<date>.jsonl` (credential values redacted) and printed in the terminal.

| Engine | What it does | Button |
|---|---|---|
| **Login monitor** (`apps/server/src/ops/login-monitor.ts`) | Checks the Kotak session every 5 s and logs in again as soon as it is lost or a login failed. Transient failures (no answer, 5xx, 429, maintenance page): retried after 5 s, doubling to 1 min (a 429 waits for Retry-After). Refused by Kotak (wrong TOTP/MPIN): 60 s doubling to 30 min, and after 5 refusals in a row automatic logins **pause** — repeated wrong credentials can lock the trading account. Failed proactive re-logins and token expiry are journaled too. | **Re-login now** (one forced attempt — its retries are normal ones; 20 s between presses, 2 min after 3 refusals, 15 min while paused) |
| **Watchdog** (`apps/server/src/ops/watchdog.ts`) + **supervisor** (`scripts/supervise.mjs`) | Every 30 s: memory (drops cached answers, restart if still critical), responsiveness (event-loop delay), unhandled errors, broker login, market feed (FEED STALE during market hours → new socket), instrument master (re-download), background jobs, EOD files, disk/DATA_DIR (old journals removed when space is low). Under `npm run start:supervised` the supervisor restarts the server after a crash, a hang (`/api/health` silent 3× in a row) or a watchdog restart request. Code defects are recorded, not patched at run time. | **Run health check** |
| **Weekly audit** (`apps/server/src/ops/weekly-audit.ts`) | Saturdays 10:00 IST (a missed Saturday runs a few minutes after the next start), covering Saturday to Saturday: paper-only safety boundary, credential leaks in stored files (redacted in the ops files), configuration, EOD files of every session (missing ones downloaded again, corrupt ones quarantined and downloaded again), recorded sessions, instrument master, paper-trading ledger (email index rebuilt), login and watchdog history, restarts, runtime, housekeeping. Reports: `DATA_DIR/ops/audits/<id>.json` and `.md`. Never edits user orders, configuration or code; unrecorded market minutes stay blank. | **Run audit now** |

API: `GET /api/ops` (status, public like `/api/health`), `POST /api/ops/login/relogin`, `POST /api/ops/watchdog/run`,
`POST /api/ops/audit/run`, `GET /api/ops/audit/reports/:id`.

## Health

- **`GET /api/health`** — clock, feed status and the provider's report (no secrets): Kotak login state, feed
  connection and subscriptions, instrument master, recorder (`firstRecordedSession`, number of sessions), EOD
  files loaded per source, stock-option sweep, background jobs with their last error and next retry. The same
  summary is logged at start (`live data: …`).
- **Feed chip** (top bar of the web app) — `LIVE` / `CONNECTING` / `OFFLINE` with an amber dot when the feed is
  connected but quiet; click it for the reason, login / feed / instrument-master state, last tick, recording
  start and the date of each official file loaded. A banner under the header explains blanks while the feed is
  not live.

## Features (38 screens)

| Area | Screens |
|---|---|
| Market | Home dashboard, Watchlist, Option Chain, Synopsis heat-map, FII/DII, Participant-wise OI |
| Trend & flow | Opening range breakout (trend detector), 1-minute order flow (buyer vs seller volume estimate) |
| Open interest | OI analysis, Multi-strike OI, OI trend, PCR, Max pain, Futures OI & build-up, Build-up breadth |
| Volatility | IV chart (intraday + IV vs HV), IV Rank & Percentile, Skew, Surface, Volatility cone |
| Strategy | Strategy builder, Strategy wizard (49 templates), Optimizer, Straddle chart, Strategy chart, Trade recap |
| Trade | Positions & orders (paper broker), Strategy manager (virtual strategies), Alerts |
| Algo | Algo Strategies — Strategy 2 (₹20 premium ladder) and Strategy 3 (₹50 premium ladder) |
| Scanners | 23 F&O scanners (incl. 3 opening-range scans), Unusual option activity, Order-book analytics |
| More | Calculators (BS price/Greeks, IV, charges), Learn, Settings |

Highlights:

- **Strategy builder** — editable legs on the live chain, payoff at expiry and on any target date, IV what-if,
  ±1σ/±2σ bands, breakevens, max profit/loss, probability of profit, net Greeks, SPAN-style margin estimate,
  scenario grid, shareable links, save as virtual strategy, execute as a paper basket order.
- **Optimizer** — scans hundreds of thousands of 1–4 leg combinations on the live chain and ranks them by
  reward-to-risk, profit at target or POP, honouring stop-loss, max legs and capital limits.
- **Trade recap** — load the option chain as recorded at any past minute, build a position at those prices
  and replay its P&L. Only dates the recorder captured are available.
- **Opening range breakout** — the high and low of the first 5/15/30 minutes from recorded (or Kotak) 1-minute
  bars; a close beyond either level marks the market trending, with whipsaw detection, scanners and alerts.
- **Order flow** — each minute's traded volume split into estimated buyer vs seller volume (plus an
  unclassified share) from live ticks; shown with the method and unclassified %.
- **Paper broker** — market / limit / SL / SL-M, NRML / MIS; fills at the live bid/ask (a market order with no
  live bid/ask is rejected); expiry settlement from the official settlement price.
- **Algo Strategies** — each algo is a pure state machine in `packages/core/src/algo`, registered in `ALGOS`.
  **Strategy 2**: at 09:20 sell an OTM CE and PE nearest ₹20 (NIFTY strikes in multiples of 100); each time
  either leg's premium climbs another 50 % buy back the opposite leg and sell the OTM strike nearest the new
  level; square off at 15:25 or when no eligible strike exists. **Strategy 3** uses the same rules from ₹50.
  Deployed runs trade **on the live chain through the paper broker** (MIS orders tagged `algo:<id>`).
  **Backtests replay only sessions the recorder captured**, minute by minute at recorded prices; with no
  recorded session the backtest is blank.
- **Live updates** — WebSocket ticker, feed status and notifications; analytics views poll every few seconds.
- **Installable PWA** — mobile-first layout with bottom tabs, dark/light themes, offline app shell.

## Architecture

```
packages/core   Pure TypeScript analytics shared by server and browser
                Black-Scholes & Greeks, IV solver, IST expiry calendar, payoff/breakeven/POP,
                max pain, PCR, build-up, HV/IVR/IVP/cone, SPAN-style margin estimate, templates,
                optimizer, algos
apps/server     Fastify REST + WebSocket API
                live/     Kotak session/REST/scrip master/SFeed, NSE/BSE EOD files, recorder, stores,
                          exchange calendar, IST clock, pricing, provider (health)
                services/ analytics, market tools, pricer, paper broker, strategies, alerts,
                          watchlists, algos
                store/    JSON document store for user data (atomic writes)
apps/web        React 18 + Vite + Tailwind + ECharts PWA (React Query, Zustand)
```

Services read market data only through the `MarketDataProvider` (`apps/server/src/live/provider.ts`). A missing
value throws `NoLiveData(reason)` (HTTP 503, `code: 'NO_LIVE_DATA'`) or is returned as `null` with the reason in
`gaps`.

## Testing

```bash
npm run typecheck    # core, server, web
npm test             # core, server and web unit/integration tests (test-only fake provider + sample payloads)
npm run build        # required before e2e: both e2e servers serve apps/web/dist
npm run test:e2e     # Playwright
```

The e2e suite (`apps/web/playwright.config.ts`) starts its own servers in two modes:

- **Live-empty** (`live-desktop`, `live-mobile`, `live-master-desktop`) — the production bundle with empty
  `NEO_*`, an empty temporary data dir and network blocked: every page must show its blank states with reasons.
  `live-master-desktop` adds a same-day cached instrument master (test rows), so contracts are known but
  nothing is priced and a paper market order is rejected with "No live bid/ask".
- **Fixture** (`fixture-desktop`) — a test-only server (`apps/server/test/support/e2e-server.ts`, fake provider
  with sample data) where real values must render. It is never part of `npm start`.

Ports: `E2E_PORT` (8790), `E2E_MASTER_PORT` (8792), `E2E_FIXTURE_PORT` (8791). If Playwright browsers are not
installed, run `npx playwright install chromium` or point `CHROMIUM_PATH` at a Chromium binary.

Tests never call Kotak, NSE or BSE; the code has not yet been run against the real endpoints from the
development sandbox (see the Status section of the design doc).

## Publishing to Google Play

The web app is a standards-compliant PWA (manifest, 192/512/maskable icons, service worker). To ship it as an
Android app, wrap the deployed HTTPS URL in a Trusted Web Activity with
[Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) (`bubblewrap init --manifest https://your-host/manifest.webmanifest`)
and add the generated Digital Asset Links file at `/.well-known/assetlinks.json`.

## API overview

All endpoints are under `/api`. Status: `health`, `meta`, `clock`. Market data: `quotes`, `indices`,
`expiries/:symbol`, `chain/:symbol` (`?at=` for a recorded minute), `futures/:symbol`, `candles/:symbol`,
`dashboard`, `oi/{strikes,multi-strike,trend,pcr,max-pain}/:symbol`, `oi/futures`, `oi/breadth`, `participants`,
`fii-dii`, `vol/{iv-chart,skew,surface,cone}/:symbol`, `vol/table`, `straddle/:symbol`, `orb`, `orb/:symbol`,
`orb/:symbol/history`, `order-flow/:symbol`, `algos`, `algos/:id/defaults`, `algos/:id/backtest` (POST),
`algos/:id/backtest-range` (POST), `strategy-chart` (POST), `optimizer` (POST), `recap` (POST),
`scanners[/:id]`, `unusual`, `synopsis`, `order-book/:symbol`. User data (Bearer token): `auth/*`, `settings`,
`strategies`, `broker/*`, `alerts`, `notifications`, `watchlists`, `algo-runs` (list/deploy, `:id/stop`,
delete). WebSocket: `/ws` (ticks, feed status, notifications, order updates).

## Disclaimer

Educational and analytical software. Live data from your own Kotak Neo account and public NSE/BSE files —
respect their terms of use. Paper trading only; not investment advice.
"Quantsapp" is a trademark of its owner; this project is independent and not affiliated with it.
