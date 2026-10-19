# Q26 Options — Architecture Map (baseline `ea1be96`)

All paths are relative to the repository root. `file:line` references are to the baseline commit. Everything
here was read from the source; none of it was observed against live Kotak/NSE/BSE endpoints.

## 1. Runtime overview

```
 Browser (React 18 SPA, PWA)                                 apps/web/src
 ├─ lib/api.ts  REST  fetch('/api/...')  Authorization: Bearer <app token>   (token in localStorage)
 ├─ lib/ws.ts   WS    '/ws'  -> {type:'auth',token} / {type:'subscribe',symbols}
 └─ sw.js       caches app shell only; /api and /ws never cached
        │  HTTP :8787 (no TLS in-app; HOST default 0.0.0.0)
        ▼
 ┌──────────────────────── Node 22 single process: apps/server/dist/server.mjs ───────────────────────┐
 │ Fastify 5 (app.ts)  cors{origin:true}  @fastify/websocket  @fastify/static(web/dist)  bodyLimit 1MB │
 │  onRequest: Bearer -> Auth.verify (HMAC-SHA256, 30-day TTL)       errors: Zod->400, NoLiveData->503 │
 │  77 HTTP routes + /ws  ──────────────────────────────────────────────────────────────────────────┐ │
 │                                                                                                   │ │
 │ services/ (createServices)                                                                        │ │
 │  Analytics · MarketTools · Pricer · Dashboard      PaperBroker · StrategyManager (trading.ts)     │ │
 │  AlertService · Notifier · Watchlists (alerts.ts)  AlgoService (algo.ts -> @q26/core/algo)        │ │
 │  UserWatches (ad-hoc depth views)                  timers: broker 1s, alerts 3s, algos 2s         │ │
 │        │ read-only market data via MarketDataProvider          │ user state                       │ │
 │        ▼                                                       ▼                                  │ │
 │ live/provider.ts  LiveProvider (the ONLY market-data source)   store/db.ts  Db -> DATA_DIR/db.json│ │
 │  ├ kotak/session.ts   TOTP login + MPIN validate, re-login, 403/429 holds                         │ │
 │  ├ kotak/ratelimit.ts 10/s, 300/min, 5000/h; 'slow' lane 1 call/1.5 s                             │ │
 │  ├ kotak/rest.ts      quotes, option-chain, expiries, historical, scrip-master file-paths (GET)   │ │
 │  ├ kotak/scripmaster.ts  daily CSV download -> DATA_DIR/refdata/<date>/                           │ │
 │  ├ kotak/sfeed/*      WebSocket feed (binary protocol), budget <= 2700 subscriptions              │ │
 │  ├ live-market.ts     quote cache, watch tiers, stock-option sweep                                │ │
 │  ├ universe.ts        index > user > underlying > chain > ad-hoc                                  │ │
 │  ├ recorder.ts        ticks -> minute bars & chain minutes -> store/intraday.ts (DATA_DIR/market) │ │
 │  ├ eod.ts + nse/*     official NSE/BSE files -> store/history.ts (DATA_DIR/eod)                   │ │
 │  ├ calendar.ts clock.ts  IST calendar (weekends + holidays), wall clock                           │ │
 │  └ pricing.ts         IV/Greeks (Black-76 on the expiry forward)                                  │ │
 └─────────┬───────────────────────────────┬──────────────────────────────────────────────────────────┘
           │ HTTPS/WSS                     │ HTTPS
           ▼                               ▼
 mis.kotaksecurities.com (login, REST)     nsearchives/archives.nseindia.com, www.nseindia.com,
 <baseUrl from validate> (REST)            www.bseindia.com   (EOD files; unofficial JSON for FII/DII, holidays)
 sfeed.kotaksecurities.com (WSS feed)      NOT exercised in this audit; no network calls were made
```

## 2. HTTP routes (`apps/server/src/app.ts`)

Authentication: the global `onRequest` hook (app.ts:147–150) decodes `Authorization: Bearer <token>` into
`req.user`. Only routes that call `requireUser(req)` (app.ts:136–139) reject anonymous callers with 401.
"public" below means **no authentication at all**. A preHandler (app.ts:176–181) refuses a past `?at=` on
every GET `/api/*` route outside `AS_OF_ROUTES` (app.ts:48).

| Line | Method | Path | Auth | Notes |
|---|---|---|---|---|
| 208 | GET | /api/health | public | feed status and provider `healthReport()` (no secrets by design) |
| 214 | GET | /api/meta | public | symbols from the instrument master |
| 235 | GET | /api/clock | public | |
| 238 | GET | /api/quotes | public | as-of capable, up to 80 symbols |
| 260 | GET | /api/indices | public | as-of capable |
| 262 | GET | /api/expiries/:symbol | public | as-of capable |
| 270 | GET | /api/chain/:symbol | public | as-of capable |
| 272 | GET | /api/futures/:symbol | public | as-of capable |
| 278 | GET | /api/candles/:symbol | public | as-of capable |
| 292 | GET | /api/dashboard | public | |
| 315 | GET | /api/orb | public | |
| 319 | GET | /api/orb/:symbol | public | |
| 323 | GET | /api/orb/:symbol/history | public | |
| 327 | GET | /api/order-flow/:symbol | public | adds a 'user'-tier feed watch (app.ts:184) |
| 334 | GET | /api/oi/strikes/:symbol | public | as-of capable |
| 341 | GET | /api/oi/multi-strike/:symbol | public | |
| 347 | GET | /api/oi/trend/:symbol | public | |
| 352 | GET | /api/oi/pcr/:symbol | public | |
| 357 | GET | /api/oi/max-pain/:symbol | public | |
| 359 | GET | /api/oi/futures | public | |
| 361 | GET | /api/oi/breadth | public | |
| 364 | GET | /api/participants | public | |
| 369 | GET | /api/fii-dii | public | |
| 376 | GET | /api/vol/iv-chart/:symbol | public | |
| 380 | GET | /api/vol/table | public | |
| 381 | GET | /api/vol/skew/:symbol | public | |
| 385 | GET | /api/vol/surface/:symbol | public | |
| 386 | GET | /api/vol/cone/:symbol | public | |
| 391 | GET | /api/straddle/:symbol | public | |
| 406 | POST | /api/strategy-chart | public | |
| 411 | POST | /api/optimizer | public | CPU-heavy |
| 428 | POST | /api/recap | public | |
| 435 | GET | /api/scanners | public | |
| 436 | GET | /api/scanners/:id | public | |
| 437 | GET | /api/unusual | public | |
| 438 | GET | /api/synopsis | public | |
| 439 | GET | /api/order-book/:symbol | public | adds a 'user'-tier depth watch |
| 447 | POST | /api/auth/register | public (optional bearer) | with a guest bearer token, upgrades that guest in place |
| 452 | POST | /api/auth/login | public | |
| 457 | POST | /api/auth/guest | public | creates and persists a new guest user on every call |
| 461 | GET | /api/auth/me | requireUser | |
| 462 | PUT | /api/settings | requireUser | |
| 470 | GET | /api/strategies | requireUser | |
| 471 | POST | /api/strategies | requireUser | |
| 472 | GET | /api/strategies/:id | requireUser | |
| 473 | PUT | /api/strategies/:id | requireUser | |
| 474 | POST | /api/strategies/:id/exit | requireUser | |
| 478 | DELETE | /api/strategies/:id | requireUser | |
| 484 | GET | /api/broker/funds | requireUser | paper |
| 485 | GET | /api/broker/orders | requireUser | paper |
| 486 | GET | /api/broker/trades | requireUser | paper |
| 487 | GET | /api/broker/positions | requireUser | paper |
| 488 | POST | /api/broker/orders | requireUser | paper order |
| 489 | POST | /api/broker/basket | requireUser | 1–12 paper orders |
| 500 | DELETE | /api/broker/orders/:id | requireUser | paper cancel |
| 501 | POST | /api/broker/positions/exit | requireUser | paper exit |
| 505 | POST | /api/broker/reset | requireUser | resets the paper account |
| 511 | GET | /api/alerts | requireUser | |
| 512 | POST | /api/alerts | requireUser | |
| 513 | PATCH | /api/alerts/:id | requireUser | |
| 517 | DELETE | /api/alerts/:id | requireUser | |
| 521 | GET | /api/notifications | requireUser | |
| 522 | POST | /api/notifications/read | requireUser | |
| 528 | GET | /api/watchlists | requireUser | |
| 529 | POST | /api/watchlists | requireUser | |
| 530 | PUT | /api/watchlists/:id | requireUser | |
| 531 | DELETE | /api/watchlists/:id | requireUser | |
| 535 | GET | /api/watchlists/:id/quotes | requireUser | |
| 540 | GET | /api/algos | public | catalogue |
| 541 | GET | /api/algos/:id/defaults | public | |
| 542 | POST | /api/algos/:id/backtest | public | replays a recorded day |
| 546 | POST | /api/algos/:id/backtest-range | public | up to 250 recorded days; CPU/IO-heavy |
| 550 | GET | /api/algo-runs | requireUser | |
| 551 | POST | /api/algo-runs | requireUser | starts a live paper algo run |
| 555 | GET | /api/algo-runs/:id | requireUser | |
| 556 | POST | /api/algo-runs/:id/stop | requireUser | |
| 557 | DELETE | /api/algo-runs/:id | requireUser | |
| 622 | GET (WS) | /ws | none to connect | index quotes by default; `subscribe` up to 40 symbols (app.ts:42); an optional `auth` message enables the user's own order and notification pushes |
| 682–690 | GET | `/*` (static) | public | SPA fallback to `index.html` for non-`/api` and non-`/ws` GETs |

That is 77 HTTP routes plus `/ws`. 33 call `requireUser` (verified: `grep -c "requireUser(req)" app.ts` → 33).
The other 44 are reachable without authentication, including the 3 auth endpoints, 37 market/analytics
routes and 4 algo catalogue/backtest routes.

## 3. Services (`apps/server/src/services/`)

| Service | File | Role |
|---|---|---|
| wiring | index.ts | `createServices()`; `collectUserContracts()` streams contracts users hold or watch (at most 250, `MAX_USER_CONTRACTS`); starts the timers |
| Analytics | analytics.ts (1,963 lines) | OI suite, PCR, max pain, build-up, breadth, IV chart/table/skew/surface/cone, straddle, strategy chart, recap, optimizer, ORB, participants and FII/DII |
| MarketTools | market-tools.ts | 23 scanners (`SCANNERS`), unusual activity, synopsis, order book (5-level depth), order flow (quote-rule estimate) |
| Pricer | pricer.ts | prices spot, futures and options from live quotes; contract validation; settlement for expired contracts |
| live helpers | live.ts | `buildOptionChain`, quotes, candles, gaps, `BOOK_MAX_AGE_MS = 10_000` (live.ts:51) |
| Dashboard | dashboard.ts | home cards, each filled independently |
| PaperBroker, StrategyManager | trading.ts | paper orders, trades, positions and funds (SPAN-style margin estimate); saved strategies with MTM. The header says "PAPER ONLY: nothing here ever sends an order to the broker" (trading.ts:4). It has no network imports. |
| AlertService, Notifier, Watchlists | alerts.ts | 8 alert kinds evaluated every 3 s against live values; notifications pushed over WS |
| AlgoService | algo.ts | live **paper** runs through PaperBroker; backtests replay only recorded sessions |

## 4. Live provider (`apps/server/src/live/`)

| Component | File | Behaviour (from source) |
|---|---|---|
| Credentials | env.ts | `NEO_ENV_VARS` (env.ts:18); `loadNeoEnv` validates and returns `NeoEnv` (env.ts:36); `redact` and `scrubSecrets` (env.ts:66–79) |
| Session | kotak/session.ts | POST `https://mis.kotaksecurities.com/login/1.0/tradeApiLogin` (TOTP), then `tradeApiValidate` (MPIN) (session.ts:27, 314–319, 384). Uses `baseUrl` from validate, falling back to `https://mis.kotaksecurities.com`. A failed login is held 1, 2, 4 … 30 min (session.ts:366). 429 honours Retry-After. On 401 it re-logins once with a new TOTP window. 403 holds the endpoint. Proactive re-login at min(token exp − 5 min, 08:30 IST). Error text is scrubbed (session.ts:700–705). |
| TOTP | kotak/totp.ts | RFC 6238, SHA-1, 30 s, 6 digits, from the **system clock** (`Date.now`). It never reuses a counter and needs at least 3 s left in the window (totp.ts:9). |
| REST | kotak/rest.ts | All calls are `kind: 'market'` GETs: quotes `script-details/1.0/quotes/neosymbol/...` (rest.ts:111), `market-data/1.0/watchlist/option-chain` (604, 616), `.../watchlist/expiries` (627), `market-data/1.0/historical/details` (647), `script-details/1.0/masterscrip/file-paths` (660) |
| Order endpoints | — | **None.** A grep of `apps/server/src/live/kotak` for order, place, modify or cancel paths found nothing. `kind: 'session'` (orders/reports/portfolio) is declared in `KotakRequestOptions` (session.ts:76–77) but **never used**. The only POSTs are the two login steps. |
| Rate limiter | kotak/ratelimit.ts | 'general' lane: ≤10/s, ≤300/min, ≤5000/h. 'slow' lane: ≥1.5 s spacing. A 429 pauses the lane. |
| Scrip master | kotak/scripmaster.ts | Daily at 08:45 IST (provider.ts:228). Downloads 4 CSVs with unauthenticated GET, validates them, caches under `refdata/<date>/`, keeps 5 days. |
| SFeed | kotak/sfeed/client.ts, protocol.ts | `wss://sfeed.kotaksecurities.com/apifeed` by default (protocol.ts:15) or the URL from validate. Auth uses the sid. Subscription sync is diff-based. Reconnects with backoff and jitter. Hard cap is 3000 (client.ts:202) and config caps it at 2700. Feed re-logins are capped at 6 per hour (provider.ts:229). |
| Live market | live-market.ts | Quote cache merged from SFeed and REST. Watch tiers. Book dropped after 10 s (`bookMaxAgeMs`). Stock-option REST sweep. |
| Universe | universe.ts | Priority index > user > underlying > chain (2 nearest expiries, ±8 % strikes) > ad-hoc |
| Recorder | recorder.ts → store/intraday.ts | Per-minute OHLC, volume, OI and buy/sell estimate. Append-only JSONL under `market/<date>/`. Retention is unset in production (provider.ts:57, 318). |
| EOD jobs | eod.ts + nse/* | NSE F&O and CM UDiFF bhavcopy, BSE F&O, `ind_close_all`, participant OI, FII/DII (unofficial JSON), holiday master (unofficial JSON). First attempt 18:30 IST, then hourly to 23:30 IST. Backfills the last `EOD_BACKFILL_DAYS` sessions. Per-host serial queues (archives ≥0.5 s, www ≥3 s apart). |
| Calendar and clock | calendar.ts, clock.ts | IST, weekends plus holidays (NSE master merged with `HOLIDAYS`). Pre-open 09:00–09:15, session 09:15–15:30. Clock is the real wall clock. |
| Pricing | pricing.ts | Black-76 on the forward: same-expiry future, else put-call parity, else spot·e^{rT}. `isLivePrice` (pricing.ts:238–245) accepts a quote dated today's session. **Within the session it does not bound age.** |

Lifecycle: `start()` (provider.ts:411–425) and `stop()` (provider.ts:432–449). See the inventory §8.

## 5. Persistence

- **User data:** `store/db.ts`, a single JSON document `DATA_DIR/db.json` with atomic tmp+rename, a 300 ms
  debounce, synchronous writes, no fsync and no transactions. A corrupt file is renamed to `.corrupt-<ts>` and
  the DB restarts empty (db.ts:57–63). `PERSIST=false` keeps everything in memory.
- **Market history:** `DATA_DIR/eod/` (atomic JSON), `DATA_DIR/market/` (append-only JSONL) and
  `DATA_DIR/refdata/` (CSV + manifest).
- **No SQL database and no Redis.** There is no DB or cache driver in any `package.json` or in
  `package-lock.json`. Grepping `redis|sqlite|postgres|mysql|mongodb|knex|prisma|typeorm` over `apps/` and
  `packages/` matched only a comment in db.ts:2.

## 6. Paper broker and order flow

```
Web OrderTicket / Builder basket / Positions exit / Algo run
   └─ POST /api/broker/orders | /basket | /positions/exit      (requireUser)
        └─ PaperBroker.place (trading.ts:289) -> validate lots 1..max, strike, price, trigger, tick size
             ├─ MARKET: fill at the live ask (BUY) or bid (SELL) if the book is ≤10 s old and the session is open,
             │          else rejected "No live bid/ask"
             └─ LIMIT/SL/SL-M: working DAY orders; PaperBroker.tick() every 1 s fills them against a live book,
                       cancels them at the session close
        -> orders/trades in db.json -> orderListeners -> WS {type:'order'} to that user's sockets
```

No code path sends an order to Kotak. Kotak is used only for login, market-data GETs and the SFeed websocket
(see §4). Algo runs (algo.ts) place orders only through `PaperBroker`.

## 7. Alerts and algos

- Alerts (alerts.ts): PRICE, OPTION_PRICE, IV, PCR, OI_CHANGE, MTM, ORB_BREAK and ORDER_FLOW are evaluated
  every 3 s against live values. An input that is not live is skipped with a `statusNote`. A fired alert goes
  to `Notifier.push` (persisted in db.json and pushed over WS).
- Algos: the catalogue is `ALGOS = [premiumLadder]` (core/src/algo/index.ts) with presets
  `strategy-2-rs20` and `strategy-3-rs50`. Live runs tick every 2 s while the session is open. Backtests replay
  only recorded `market/` sessions.

## 8. Authentication

- Users are guests (`POST /api/auth/guest`, called automatically by the web `ensureSession()` when no valid
  token exists, web/src/lib/api.ts:76–87) or registered (email + password ≥6 chars, scrypt with a 16-byte salt,
  auth.ts:45–69). A guest can be upgraded in place (auth.ts:97–109).
- Token: `base64url({uid,exp}).HMAC-SHA256(AUTH_SECRET)`, TTL 30 days (auth.ts:5, 23–43). The signature is
  compared with `timingSafeEqual`. There is no revocation or logout endpoint. The web stores the token in
  `localStorage` (web/src/lib/api.ts:7,15).
- `AUTH_SECRET`: if unset, a random secret is generated per boot (config.ts:54), so all tokens die on restart.
  `.env.example` ships `AUTH_SECRET=change-me`.
- There is no rate limiting or lockout on `/api/auth/*`. No rate-limit plugin is registered; grep for
  `rate-limit`/`helmet` in app.ts and package.json found nothing.
- Ownership: per-user buckets in `Db.list(key, userId)`. The test "one user cannot reach another user's items"
  passes (routes-smoke.test.ts).

## 9. Where credentials and environment are read

Command: `grep -rn "process\.env" apps/server/src apps/web/src packages/core/src`

| Location | Reads |
|---|---|
| `apps/server/src/index.ts:12–20` | `process.loadEnvFile()` of `<root>/.env` and `apps/server/.env` (loads them into `process.env`; values are not logged) |
| `apps/server/src/config.ts:8–9, 50–56` | non-secret settings: PORT, HOST, DATA_DIR, WEB_DIST, RISK_FREE_RATE, **AUTH_SECRET**, HOLIDAYS, PERSIST, EOD_BACKFILL_DAYS, SFEED_TOKEN_BUDGET |
| `apps/server/src/config.ts:36` | `neoFromEnv(env = process.env)`: checks the NEO_* names for emptiness and delegates to `loadNeoEnv` |
| `apps/server/src/live/env.ts:36` | `loadNeoEnv(env = process.env)`: **the only place NEO_* credential values are parsed into a `NeoEnv` object** |
| web, core | **no `process.env`** (the web uses only `import.meta.env.PROD`). vite.config.ts reads `API_URL` at dev time. |

So the claim "credentials are read only in `live/env.ts`" is **accurate for the Kotak NEO_* values**, with
two qualifications. `config.ts:36–45` also inspects them, for presence only. `AUTH_SECRET`, an application
secret, is read in `config.ts:54`. After loading, `NeoEnv` is passed to `KotakSession`, which holds the values
in memory and scrubs them from error text (session.ts:700–705).
