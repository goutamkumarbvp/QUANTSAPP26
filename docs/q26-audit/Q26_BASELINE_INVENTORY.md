# Q26 Options — Baseline Inventory (commit `ea1be96`)

Audit type: independent zero-trust baseline discovery. Prepared 2026-10-19 (UTC). Read-only with respect to the
source tree; every fact below comes from `git` objects at `ea1be96` or from a detached git worktree of that
commit (`git worktree add --detach <scratch>/wt ea1be96`). The worktree has since been removed.

## 1. Baseline identity and source integrity

| Item | Value | How obtained |
|---|---|---|
| Baseline commit | `ea1be961aa2da5ccd45a89171436c38e861001ce` | `git rev-parse HEAD` |
| Tree | `5e6cc25601271a23bfecd02419f116f4fa4b4f70` | `git cat-file -p ea1be96` |
| Parent | `0a2ae167b7d1ddb0c6a28fbe3b47a8871cf1a38d` | same |
| Branch | `claude/quantsapp-trading-audit-noqax6` | `git branch --show-current` |
| Commit date | 2026-10-19T11:54:51Z; subject "Breadth: show the reason when no live stock futures are available" | `git log -1` |
| Commits in history | 23 | `git rev-list --count ea1be96` |
| Signed commit | No signature header in the commit object | `git cat-file -p` |
| Repository integrity | `git fsck --no-dangling` exit 0, no errors | run 2026-10-19 |
| Tracked files | 222 files, 3,245,200 bytes | `git ls-tree -r -l ea1be96` |
| SHA-256 manifest | [`baseline-sha256-manifest.txt`](baseline-sha256-manifest.txt): 222 lines, `<sha256>  <path>`, hashed from `git cat-file blob` bytes | script over `git ls-tree -r -z ea1be96` |
| Manifest cross-check | `sha256sum -c --quiet` in the clean worktree: all 222 OK | run 2026-10-19 |
| Manifest file's own SHA-256 | `8621abd057f71f1d6a5cb556635ef598f2c4ced0864895913f5829f72ffd4079` | `sha256sum` |

**Archive note.** No ZIP or other archive was uploaded in this session. The baseline is the git repository at
`ea1be96`. Earlier ZIPs were made from this repository, but none was available to compare against, so ZIP-to-git
equivalence is **NOT VERIFIED**.

**Working-tree drift at audit time.** This is not part of the baseline, and none of it was made by this audit.
Another engineer was editing the main working tree at the same time. At the end of the audit (~16:05Z),
`git status --short` showed these modified files:

- `Dockerfile`, `package.json`
- `apps/server/src/{app.ts, index.ts}`
- `apps/server/src/live/{eod.ts, kotak/session.ts, live-market.ts, nse/http.ts, provider.ts, store/history.ts}`
- `apps/server/test/{live/kotak-session.test.ts, routes-smoke.test.ts}`
- `packages/core/src/api.ts`

It also showed these untracked files and folders:

- `apps/server/src/log.ts`, `apps/server/src/ops/`, `apps/server/src/safety.ts`
- `apps/server/test/ops.test.ts`
- `scripts/`

The audit's own output is `docs/q26-audit/`, also untracked. The drift files were not read and are not covered
by this baseline. All test runs used the clean `ea1be96` worktree.

## 2. Tracked-file inventory (222 files)

| Directory | Files | Purpose | Files |
|---|---|---|---|
| `(root)/` | 9 | Workspace manifest, lockfile, TS base config, Docker, ignore files, env template, README | .dockerignore, .editorconfig, .env.example, .gitignore, Dockerfile, README.md, package-lock.json, package.json, tsconfig.base.json |
| `.github/workflows/` | 1 | CI (GitHub Actions) | ci.yml |
| `apps/server/` | 3 | Server package, esbuild bundler script, TS config | build.mjs, package.json, tsconfig.json |
| `apps/server/src/` | 4 | Entry point, Fastify app and routes, user auth, config | app.ts, auth.ts, config.ts, index.ts |
| `apps/server/src/live/` | 10 | Live market-data provider: calendar, clock, credentials, EOD jobs, live market, pricing (IV/Greeks), recorder, types, streaming universe | calendar.ts, clock.ts, env.ts, eod.ts, live-market.ts, pricing.ts, provider.ts, recorder.ts, types.ts, universe.ts |
| `apps/server/src/live/kotak/` | 5 | Kotak Neo client: rate limiter, market-data REST, scrip master, TOTP+MPIN session, TOTP | ratelimit.ts, rest.ts, scripmaster.ts, session.ts, totp.ts |
| `apps/server/src/live/kotak/sfeed/` | 2 | Kotak SFeed websocket client and binary protocol | client.ts, protocol.ts |
| `apps/server/src/live/nse/` | 6 | NSE/BSE public files: bhavcopy, FII/DII, holidays, HTTP, index closes, participant OI | bhavcopy.ts, fiidii.ts, holidays.ts, http.ts, indices.ts, participants.ts |
| `apps/server/src/live/store/` | 2 | On-disk EOD store and intraday (recorded minutes) store | history.ts, intraday.ts |
| `apps/server/src/services/` | 9 | Business services: alerts/notifier/watchlists, algos, analytics, dashboard, wiring, live helpers, market tools, pricer, paper broker and strategies | alerts.ts, algo.ts, analytics.ts, dashboard.ts, index.ts, live.ts, market-tools.ts, pricer.ts, trading.ts |
| `apps/server/src/store/` | 1 | JSON document DB (`db.json`) | db.ts |
| `apps/server/test/` | 13 | Server unit/integration tests (vitest) | alerts.test.ts, algo-live.test.ts, analytics.test.ts, foundation.test.ts, market-routes.test.ts, orb.test.ts, paper-trading.test.ts, review-no-synthetic.test.ts, routes-smoke.test.ts, routes.test.ts, tools.test.ts, valuation-time.test.ts, verify-adversarial.test.ts |
| `apps/server/test/live/` | 28 | Tests of the live provider and its clients, all against injected fakes, plus fake helpers | calendar.test.ts, clock.test.ts, config-env.test.ts, eod.test.ts, kotak-env-totp.test.ts, kotak-fixtures.ts, kotak-ratelimit.test.ts, kotak-rest.test.ts, kotak-scripmaster.test.ts, kotak-session.test.ts, kotak-universe.ts, live-market.test.ts, nse-bhavcopy.test.ts, nse-fake.ts, nse-fiidii-holidays.test.ts, nse-http.test.ts, nse-indices.test.ts, nse-participants.test.ts, pricing.test.ts, provider-robustness.test.ts, provider.test.ts, recorder-gaps-adversarial.test.ts, recorder.test.ts, sfeed-client.test.ts, sfeed-protocol.test.ts, store-history.test.ts, store-intraday.test.ts, universe.test.ts |
| `apps/server/test/live/fixtures/` | 1 | SFeed packet fixtures | sfeed.ts |
| `apps/server/test/live/fixtures/nse/` | 5 | Sample NSE/BSE CSV files (test data) | bse-fo-20260430.csv, fao_participant_oi_22072026.csv, ind_close_all_14102025.csv, nse-fo-20260101.csv, nse-fo-20260915.csv |
| `apps/server/test/support/` | 6 | TEST-ONLY FakeProvider, fake SFeed, timers, e2e fixture server and refdata seeder | e2e-refdata.ts, e2e-server.ts, fake-provider.test.ts, fake-provider.ts, fake-sfeed.ts, manual-timers.ts |
| `apps/web/` | 8 | Web package: Vite, Vitest, Playwright, Tailwind/PostCSS configs, HTML shell | index.html, package.json, playwright.config.ts, postcss.config.js, tailwind.config.js, tsconfig.json, vite.config.ts, vitest.config.ts |
| `apps/web/public/` | 6 | PWA icons, manifest, service worker (app-shell cache only; `/api` and `/ws` are never cached) | icon-192.png, icon-512.png, icon-maskable-512.png, icon.svg, manifest.webmanifest, sw.js |
| `apps/web/scripts/` | 1 | Icon generator (dev utility) | gen-icons.mjs |
| `apps/web/src/` | 3 | React entry, router, CSS | App.tsx, index.css, main.tsx |
| `apps/web/src/components/` | 10 | Shared UI: charts, tables, error boundary, feed chip, layout, order ticket, payoff | Chart.tsx, DataTable.tsx, ErrorBoundary.tsx, FeedStatus.tsx, Layout.tsx, OrderTicket.tsx, Payoff.tsx, pickers.tsx, trend.tsx, ui.tsx |
| `apps/web/src/lib/` | 8 | API client (bearer token in localStorage), feed state, formatting, hooks, nav, query client, store, websocket | api.ts, feed.ts, format.ts, hooks.ts, nav.ts, query.ts, store.ts, ws.ts |
| `apps/web/src/pages/` | 26 | Screens | Alerts.tsx, Algo.tsx, Builder.tsx, Calculators.tsx, FiiDii.tsx, Home.tsx, Learn.tsx, NotFound.tsx, Optimizer.tsx, OptionChain.tsx, Orb.tsx, OrderBook.tsx, OrderFlow.tsx, Participants.tsx, Positions.tsx, Recap.tsx, Scanners.tsx, Settings.tsx, Straddle.tsx, Strategies.tsx, StrategyChart.tsx, Synopsis.tsx, Templates.tsx, Tools.tsx, Unusual.tsx, Watchlist.tsx |
| `apps/web/src/pages/oi/` | 7 | Open-interest screens | Breadth.tsx, FuturesOI.tsx, MaxPain.tsx, MultiStrike.tsx, OiTrend.tsx, Pcr.tsx, StrikeOI.tsx |
| `apps/web/src/pages/vol/` | 5 | Volatility screens | Cone.tsx, IvChart.tsx, IvTable.tsx, Skew.tsx, Surface.tsx |
| `apps/web/test/` | 7 | Web unit tests (static render, vitest) | analysis-pages.test.tsx, home.test.tsx, layout.test.tsx, lib.test.ts, order-ticket.test.tsx, trading-pages.test.tsx, ui.test.tsx |
| `apps/web/tests/` | 3 | Playwright e2e specs | fixture.spec.ts, live-empty.spec.ts, live-master.spec.ts |
| `apps/web/tests/support/` | 3 | e2e helpers, a fetch blocker (`no-network.mjs`), teardown | helpers.ts, no-network.mjs, teardown.ts |
| `docs/` | 1 | Feature parity map and known gaps | AUDIT.md |
| `docs/live-data/` | 1 | Live-data design and status | DESIGN.md |
| `docs/live-data/research/` | 5 | Research notes: Kotak REST/auth, SFeed, NSE/BSE data, dependency map, critic | app-dependency-map.md, critic.md, kotak-rest-auth.md, kotak-sfeed-websocket.md, nse-bse-public-data.md |
| `packages/core/` | 2 | Shared core package manifest and TS config | package.json, tsconfig.json |
| `packages/core/src/` | 13 | Pure domain logic: API types, Black-Scholes, dates, format, margin, math, OI, optimizer, ORB, payoff, strategy templates, vol | api.ts, bs.ts, dates.ts, format.ts, index.ts, margin.ts, math.ts, oi.ts, optimizer.ts, orb.ts, payoff.ts, strategies.ts, vol.ts |
| `packages/core/src/algo/` | 4 | Algo definitions (premium ladder), charges, types | charges.ts, index.ts, premium-ladder.ts, types.ts |
| `packages/core/test/` | 4 | Core unit tests | algo.test.ts, core.test.ts, orb.test.ts, payoff-margin.test.ts |

**Size by area (lines, `wc -l`):** core/src 3,962; core/test 1,024; server/src 19,067; server/test 15,311;
web/src 9,214; web test and e2e 2,260; docs 3,074. The rest (lockfile, configs, fixtures) is 7,340.

## 3. Languages and file types

Source: `git ls-tree -r --name-only ea1be96`, counted by extension.

| Extension | Count | Extension | Count |
|---|---|---|---|
| .ts | 125 | .tsx | 56 |
| .json | 9 | .md | 8 |
| .csv (test fixtures) | 5 | .png | 3 |
| .mjs | 3 (build.mjs, gen-icons.mjs, no-network.mjs) | .js | 3 (postcss/tailwind config, sw.js) |
| .yml | 1 | .html, .css, .svg, .webmanifest | 1 each |
| Dockerfile, .gitignore, .dockerignore, .editorconfig, .env.example | 1 each | | |

**Other languages: none.** Each of the following was searched and returned **0** tracked files: Python (`.py`),
SQL (`.sql`), shell (`.sh`, `.bash`), PowerShell (`.ps1`, `.psm1`), batch (`.bat`, `.cmd`), Java, Go, Ruby and
PHP. No tracked file starts with a shebang. Every file has mode 100644: there are no executables, no
symlinks and no submodules. The code is TypeScript/JavaScript only (ESM, `"type": "module"`).

## 4. Dependency manifests and versions

The workspace is `npm` workspaces (`packages/*`, `apps/*`) with `package-lock.json` lockfileVersion 3
(406 package entries). Root `engines.node` is `>=20.12` (the server uses `process.loadEnvFile`). Docker and CI
use Node 22. The audit ran on Node v22.22.0 and npm 10.9.4.

| Package | Version | Runtime dependencies (declared → resolved in lockfile) | Dev dependencies (resolved) |
|---|---|---|---|
| `q26-options` (root) | 1.0.0 | — | concurrently 9.2.5, typescript 5.9.3 |
| `@q26/core` | 1.0.0 | none (source-only, `main: ./src/index.ts`) | vitest 2.1.9 |
| `@q26/server` | 1.0.0 | fastify ^5.1.0 → 5.12.5; @fastify/cors ^10.0.1 → 10.1.0; @fastify/static ^8.0.3 → 8.3.0; @fastify/websocket ^11.0.1 → 11.3.4; ws ^8.22.0 → 8.22.0; zod ^3.23.8 → 3.25.76; fflate ^0.8.3 → 0.8.3; @q26/core | esbuild 0.24.2, tsx 4.23.15, vitest 2.1.9, @types/node 22.20.5, @types/ws |
| `@q26/web` | 1.0.0 | react/react-dom 18.3.1; react-router-dom 6.30.6; @tanstack/react-query 5.104.1; echarts 5.6.0; zustand 5.0.15; @q26/core | vite 5.4.21, @vitejs/plugin-react 4.7.0, @playwright/test 1.64.0, tailwindcss 3.4.19, postcss 8.5.29, autoprefixer 10.6.1 |

**Original app version:** 1.0.0 in all four `package.json` files. `/api/meta` reports `appName: 'Q26 Options'`
(app.ts:232). It does not report a version.

**Database and cache drivers:** none. There is no Redis, SQLite, Postgres, MySQL or MongoDB package in any
manifest or in the lockfile. A grep for these names over `apps/` and `packages/` matched only a comment in
`store/db.ts:2`.

## 5. Build, entry points and generated artifacts

| Item | Detail |
|---|---|
| Server entry (dev) | `apps/server/src/index.ts` via `tsx watch` (`npm run dev -w @q26/server`) |
| Server build | `apps/server/build.mjs`: esbuild bundles `src/index.ts` and the `@q26/core` sources into **`apps/server/dist/server.mjs`** (ESM, node20 target, sourcemap). Third-party dependencies stay external. |
| Server start | `npm start` → `node dist/server.mjs` (in Docker: `node apps/server/dist/server.mjs`) |
| Web entry | `apps/web/index.html` → `src/main.tsx` (React root, `BrowserRouter`, React Query; registers `/sw.js` in production) → `src/App.tsx` (router) |
| Web build | `tsc -p tsconfig.json && vite build` → `apps/web/dist/`. The server serves it via `@fastify/static` when `WEB_DIST/index.html` exists. |
| Dev proxy | Vite on :5173 proxies `/api` and `/ws` to `API_URL`, default `http://localhost:8787` (vite.config.ts) |
| Generated artifacts | `apps/server/dist/`, `apps/web/dist/`, `node_modules/`, `apps/web/test-results/`, `playwright-report/`, `*.tsbuildinfo`. **None is tracked** (`.gitignore` lines 1–12; `git check-ignore -v` confirms `dist/` and `apps/server/data/`). |
| Runtime data | `DATA_DIR`, default `apps/server/data`. **Not tracked** (ignored by `.gitignore:9`, excluded by `.dockerignore`). It is absent from the main working tree at audit time. |

## 6. Docker, CI and ignore handling

| File | Findings |
|---|---|
| `Dockerfile` | Two stages, both `node:22-alpine` (tag only, no digest pin). The build stage runs `npm ci` with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, `COPY . .`, `npm run build`, then `npm prune --omit=dev`. The runtime stage copies `node_modules`, `apps/server/dist`, `apps/server/package.json` and `apps/web/dist`, and sets `ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0`, `EXPOSE 8787`, `VOLUME /app/apps/server/data`, `CMD node apps/server/dist/server.mjs`. There is **no `USER`** (it runs as root), **no `HEALTHCHECK`** and no `.env` in the image. |
| `.dockerignore` | `node_modules`, `**/node_modules`, `**/dist`, `apps/server/data`, `apps/web/test-results`, `.git`, `.env`, `.env.*`, `!.env.example`. So `.env` cannot enter the build context through `COPY . .`. |
| `.gitignore` | `node_modules/`, `dist/`, `coverage/`, `*.log`, `.DS_Store`, `.env`, `.env.*`, `!.env.example`, `apps/server/data/`, `test-results/`, `playwright-report/`, `*.tsbuildinfo` |
| `.github/workflows/ci.yml` | Triggers: push to `main`, `master` and `claude/**`, and pull requests. Ubuntu, Node 22 with npm cache. Steps: `npm ci` → `npm run typecheck` → `npm test` → `npm run build` → `npx playwright install --with-deps chromium` → `npm run test:e2e`. Uploads `test-results` on failure. There is no `npm audit`, lint, secret scanning or CodeQL step. Actions are pinned by major tag (`@v4`), not by SHA. CI results on GitHub were **NOT VERIFIED** (no GitHub access used). |
| `.env` handling | `.env` is **ignored and has never been committed** (`git log --all -- .env` is empty; the only tracked env-like file is `.env.example`). A `.env` file **exists** in the main working tree (mode 600, owner root). **Its contents were not opened.** The worktree used for testing had no `.env`. |

## 7. Configuration (names and defaults only)

Sources: `apps/server/src/config.ts` (lines 47–62) and `.env.example`. No value from any real `.env` was read.

| Variable | Default in code | `.env.example` | Notes |
|---|---|---|---|
| `NEO_CONSUMER_KEY`, `NEO_MOBILE_NUMBER`, `NEO_UCC`, `NEO_MPIN`, `NEO_TOTP_SECRET` | none. All five are needed; otherwise `neo = null` and `neoError` names the missing ones (config.ts:36–45) | empty | Validated in `live/env.ts:36–60` (mobile normalised to +91, MPIN 4–8 digits, base32 TOTP key of at least 10 bytes) |
| `PORT` | 8787 (config.ts:49) | 8787 | |
| `HOST` | `0.0.0.0` (config.ts:50) | 0.0.0.0 | Binds on all interfaces by default |
| `RISK_FREE_RATE` | 0.065 (config.ts:53) | 0.065 | |
| `HOLIDAYS` | empty (config.ts:55) | commented | Merged with NSE's holiday master |
| `AUTH_SECRET` | `randomBytes(32)` per boot if unset or empty (config.ts:54) | **`change-me`** | A deployment that copies the example unchanged gets a publicly known HMAC secret |
| `DATA_DIR` | `apps/server/data` (config.ts:51, resolved from the bundle location) | commented | |
| `PERSIST` | true unless `'false'` (config.ts:56) | true | |
| `EOD_BACKFILL_DAYS` | 30 (config.ts:58) | commented | |
| `SFEED_TOKEN_BUDGET` | 2700, clamped to 1..2700 (config.ts:59) | commented | |
| `WEB_DIST` | `apps/web/dist` (config.ts:52) | commented | |
| `API_URL` | `http://localhost:8787` (web/vite.config.ts, dev only) | — | |
| e2e only | `E2E_PORT`, `E2E_FIXTURE_PORT`, `E2E_MASTER_PORT`, `E2E_LIVE_DATA_DIR`, `E2E_MASTER_DATA_DIR`, `CHROMIUM_PATH`, `PLAYWRIGHT_BROWSERS_PATH` | — | playwright.config.ts |

Not configurable: intraday recording retention. `LiveProviderConfig.intradayRetentionDays` exists
(provider.ts:57) but `index.ts` never passes it, so every recorded session is kept. The refdata cache keeps
5 days (scripmaster.ts:335).

## 8. Startup and shutdown (apps/server/src/index.ts)

1. Loads `.env` with `process.loadEnvFile`, first from the repo root (`<bundle>/../../../.env`), then
   `apps/server/.env` (index.ts:12–20). Variables already in the environment win. A read error is logged by
   file name and message only.
2. `loadConfig()` (index.ts:22).
3. Builds `LiveProvider` from dataDir, riskFreeRate, holidays, neo, neoError, eodBackfillDays and
   sfeedTokenBudget (index.ts:26–44).
4. `createServices()` (index.ts:46) wires the Pricer, Analytics, MarketTools, Db, Auth, Notifier, PaperBroker,
   StrategyManager, AlertService, Watchlists, AlgoService and UserWatches.
5. `buildApp(services, { logger: true })` (index.ts:50), then `services.start()` (index.ts:52). This starts
   three timers: broker tick every 1 s, alerts every 3 s, algos every 2 s (services/index.ts:159–164).
6. `void provider.start()` (index.ts:55). It never blocks: the recorder starts, then a session tick every 30 s,
   a minute tick every 60 s, the EOD jobs, and the Kotak boot (login → scrip master → universe → SFeed).
7. `app.listen({ port, host })` (index.ts:68). It then logs the clock and `provider.healthLine()`.

Shutdown is `SIGINT`/`SIGTERM` → `shutdown()` (index.ts:58–66):
- `provider.stop()`: clears timers, stops EOD jobs and the sweep, aborts the limiter, flushes the recorder, and
  closes live sockets.
- `services.stop()`: clears timers, unsets user contracts, and `db.close()` flushes `db.json`.
- `app.close()`, then `process.exit(0)`.

There are no `uncaughtException` or `unhandledRejection` handlers anywhere in `apps/server/src` (grep).
`shutdown` has no re-entry guard.

## 9. Persistence layout (`DATA_DIR`)

| Path | Writer | Format and integrity |
|---|---|---|
| `db.json` | `store/db.ts` | The whole DB (users, emailIndex, strategies, orders, trades, alerts, notifications, watchlists, algoRuns) in one JSON document. Writes are debounced by 300 ms (db.ts:68–74), use `writeFileSync` to `.tmp` then `renameSync` (db.ts:76–82), and have no fsync. A parse failure renames the file to `db.json.corrupt-<ts>` and starts empty, without logging (db.ts:57–63). |
| `eod/` | `live/store/history.ts` | `fo/<date>/futures.json`, `fo/<date>/options/<SYM>.json`, `cm/<date>.json`, `index/<date>.json`, `fiidii/<date>.json`, `participants/<date>.json`, `settle/<expiry>.json`, `derived/atmiv/<SYM>.json`. Atomic tmp+rename (history.ts:163–167). |
| `market/<date>/` | `live/recorder.ts` → `live/store/intraday.ts` | `bars/<SYM>/{SPOT,FUT_<exp>,CE_<exp>_<k>,PE_…}.jsonl` and `chains/<SYM>/<exp>.jsonl`. Append-only JSONL (intraday.ts:316–319). A torn last line is skipped. **No retention by default.** |
| `refdata/<date>/` | `live/kotak/scripmaster.ts` | `nse_cm.csv`, `bse_cm.csv`, `nse_fo.csv`, `bse_fo.csv` and `manifest.json`. Written atomically, manifest last. Keeps 5 days. |

There is no SQL database and no Redis or other external cache. All state lives in a single process plus these
files.
