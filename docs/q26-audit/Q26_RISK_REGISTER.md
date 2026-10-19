# Q26 Options — Baseline Risk Register (commit `ea1be96`)

**Scales.** Severity: Critical / High / Medium / Low (impact if the risk happens). Likelihood: Certain / Likely
/ Possible / Unlikely (in a realistic single-operator deployment). Ranking orders by severity, then
likelihood.

**Evidence.** `file:line` refers to the baseline commit. "Verified" means a command was run in this audit; the
command is named.

## Summary (ranked)

| Rank | ID | Risk | Severity | Likelihood |
|---|---|---|---|---|
| 1 | R-01 | Broker and exchange connectivity unverified; tests use fakes only | High | Certain |
| 2 | R-04 | Kotak account lockout from unbounded automatic re-login attempts | High | Possible |
| 3 | R-06 | `AUTH_SECRET`: example value `change-me` (forgeable tokens) or random per boot | High | Possible |
| 4 | R-15 | Known-vulnerable runtime dependencies (`@fastify/static` high) | High | Possible |
| 5 | R-02 | Live market-data staleness and provenance (LTP age unbounded within a session; unconfirmed field semantics) | High | Possible |
| 6 | R-05 | No rate limiting or lockout on app login and registration; weak password policy | Medium | Likely |
| 7 | R-09 | Unauthenticated CPU-heavy endpoints and WebSocket with no caps (DoS) | Medium | Likely |
| 8 | R-07 | Unbounded guest-account creation inflates `db.json` | Medium | Likely |
| 9 | R-12 | Unbounded disk growth of recorded intraday data | Medium | Certain (over time) |
| 10 | R-10 | JSON-file persistence: no transactions, sync whole-file writes, silent reset on corruption | Medium | Possible |
| 11 | R-11 | Single-process availability: no supervisor, healthcheck or global error handlers; container runs as root | Medium | Possible |
| 12 | R-08 | Network exposure: binds 0.0.0.0, no TLS in app, CORS reflects any origin | Medium | Possible |
| 13 | R-13 | TOTP depends on the host clock (no skew detection) | Medium | Possible |
| 14 | R-03 | Paper-vs-live confusion; trade-capable broker session held in memory | Medium | Unlikely |
| 15 | R-16 | Secret-handling edge cases (scrubbing limits, `.env` on disk, `--env-file`) | Low | Possible |
| 16 | R-14 | Public `/api/health` discloses operational detail | Low | Likely |
| 17 | R-17 | Reliance on unofficial NSE JSON endpoints and site terms | Low | Likely |
| 18 | R-18 | CI and supply-chain hygiene (tag-pinned actions, unpinned base image, no audit step) | Low | Possible |

## Detail

### R-01 Broker and exchange connectivity cannot be verified here
- **Severity / likelihood:** High / Certain.
- **Description:** Login, REST, scrip master, SFeed and the NSE/BSE downloads have never run against the real
  services. All 867 unit tests and 96 e2e tests inject fakes. Passing tests do **not** prove that live
  connectivity works.
- **Evidence:**
  - docs/live-data/DESIGN.md:20–35: "Not yet run against the real endpoints … sandbox could not reach Kotak,
    NSE or BSE", plus a list of unconfirmed protocol facts.
  - docs/AUDIT.md:86.
  - Tests inject fakes: test/live/provider.test.ts:76–82 (`kotakFetch`, `nseFetch`, `wsFactory`),
    test/live/kotak-session.test.ts:51–52 (`fetch: ff.fn`), test/live/nse-fake.ts:55–56.
  - The e2e LIVE-EMPTY servers preload `apps/web/tests/support/no-network.mjs`, which replaces `fetch` with a
    thrower.
  - In this audit, connectivity was **deliberately not attempted**: the audit rules forbid calls to Kotak, NSE
    and BSE. The agent proxy status (`$HTTPS_PROXY/__agentproxy/status`) shows a policy-enforcing gateway that
    returns `403` to CONNECT for non-allowlisted hosts. It recorded no attempts to Kotak, NSE or BSE hosts.
    Whether those hosts would be blocked is **NOT VERIFIED**.
- **Current mitigation:** Defensive parsing (blank rather than guessed). `/api/health` reports
  login/feed/refdata/EOD state. A documented allowlist (README "Network allowlist").
- **Recommendation:** Run a supervised first live session from an allowed network, watching `/api/health`.
  Record real response samples (redacted) as new fixtures. Gate any "live-ready" claim on that evidence.

### R-04 Kotak account lockout from repeated failed logins
- **Severity / likelihood:** High / Possible.
- **Description:** A failed TOTP login or MPIN validate is retried for ever. The hold doubles from 1 min to a
  30 min cap (≈48 attempts/day at steady state). Credential-class failures (wrong MPIN, wrong TOTP secret) are
  not distinguished from transient ones. Kotak's own lockout threshold is unknown (**NOT VERIFIED**). Repeated
  wrong-MPIN attempts may lock the real trading account.
- **Evidence:**
  - live/kotak/session.ts:366–369 (`hold = min(30 min, 1 min·2^(failures−1))`).
  - live/provider.ts:225 (`LOGIN_BACKOFF {1 min, 30 min}`), :467, :523 (the retry loop has no attempt cap).
  - Feed re-logins are capped at 6/h (provider.ts:229). Session-rejection holds: session.ts:424, 507, 525.
- **Current mitigation:** Exponential back-off. 429 Retry-After honoured. The re-login cooldown and hold stop
  login storms. The env format is validated before any login (env.ts:36–60).
- **Recommendation:** Stop automatic logins after N consecutive credential-class failures (e.g. 3) until an
  operator acts. Surface this in `/api/health`. Confirm Kotak's lockout policy.

### R-06 AUTH_SECRET handling
- **Severity / likelihood:** High / Possible.
- **Description:**
  - (a) `.env.example` ships `AUTH_SECRET=change-me`. An operator who copies it unchanged gets a publicly
    known HMAC key, so anyone who learns a user id can mint a valid 30-day bearer token for it.
  - (b) If the variable is unset, a random secret is generated per boot. Every token is invalidated on
    restart, and the web then silently creates a **new guest** and loses access to the previous paper account
    (an apparent data loss).
  - The real `.env` value was **not inspected** (forbidden), so whether (a) applies is **NOT VERIFIED**.
- **Evidence:** .env.example (`AUTH_SECRET=change-me`); config.ts:54; auth.ts:5, 19–43; web/src/lib/api.ts:76–87.
- **Current mitigation:** README says to set it in production. UUID user ids are not enumerable via the API.
- **Recommendation:** Refuse to start in production when `AUTH_SECRET` is missing, shorter than 32 bytes or
  equal to `change-me`. Add token revocation or rotation.

### R-15 Dependency vulnerabilities
- **Severity / likelihood:** High / Possible.
- **Description:** Run `npm audit --omit=dev --json` in the baseline worktree (2026-10-19T15:54Z, exit 1). It
  reported **4 production vulnerabilities: 1 high, 3 moderate, 0 critical**:
  - `@fastify/static` 8.3.0 (high): GHSA-pr96-94w5-mx2h, GHSA-x428-ghpx-8j92, GHSA-8pvw-jcv7-9cmj and
    GHSA-83w8-p2f5-377r (path traversal in directory listing; route-guard bypass via encoded separators or
    non-canonical paths). Fix in 10.1.6 (semver-major).
  - `echarts` 5.6.0 (moderate): GHSA-fgmj-fm8m-jvvx, XSS. Fix in 6.1.0 (major).
  - `react-router` / `react-router-dom` 6.30.6 (moderate): GHSA-wrjc-x8rr-h8h6 (open redirect) and
    GHSA-337j-9hxr-rhxg (SSR-only). Fix in 7.18.x (major).

  The full audit including dev dependencies found 17 (2 critical, 7 high, 8 moderate). The critical ones are
  `vitest` ≤4.1.10 and `tinypool`, dev only. The others include vite, esbuild, tailwindcss, braces and
  micromatch.
- **Evidence:** [evidence/npm-audit-omit-dev.json](evidence/npm-audit-omit-dev.json) and
  [evidence/npm-audit-all.json](evidence/npm-audit-all.json). Resolved versions are in `package-lock.json`. Static serving: app.ts:682–687 (`list` not enabled; there are no route guards on static
  paths, which limits practical impact).
- **Current mitigation:** No directory listing. API auth is per-route bearer, not path guards.
- **Recommendation:** Upgrade `@fastify/static` (≥10.1.6) and retest. Plan the echarts and react-router major
  upgrades. Add `npm audit --omit=dev` to CI.

### R-02 Live market-data provenance and staleness
- **Severity / likelihood:** High / Possible.
- **Description:** A quote's LTP counts as "live" if it is dated today's session. There is **no age bound
  within the session** (pricing.ts:238–245). If the feed stalls at 11:00, positions MTM, alerts, strategy MTM
  and IVs keep using the 11:00 LTPs until the close. Bid/ask expire after 10 s, so MARKET paper fills stop.
  Several feed-field semantics are unconfirmed: per-trade granularity, OI/volume units, `last_volume`, and the
  BSE volume unit.
- **Evidence:**
  - pricing.ts:238–245; services/live.ts:51 (`BOOK_MAX_AGE_MS = 10_000`); live-market.ts:358.
  - The web stale flag after 60 s: web/src/lib/feed.ts:9 and components/Layout.tsx:27.
  - DESIGN.md:23–35.
- **Current mitigation:** The feed chip turns amber or offline with the reason. Book freshness gates fills.
  Values carry timestamps. Nothing is synthesised (review-no-synthetic tests).
- **Recommendation:** Add a server-side max LTP age (or a "stale" flag) for alerts, MTM and algos while the
  session is open. Pause algo runs and alerts when the feed is stale. Label stale values in the API.

### R-05 App authentication: no rate limiting or lockout
- **Severity / likelihood:** Medium / Likely.
- **Description:**
  - `/api/auth/login` and `/api/auth/register` have no rate limit or lockout, so passwords can be brute-forced.
    The minimum password length is 6 (auth.ts:52, 100; app.ts:448).
  - scrypt runs synchronously (`scryptSync`, auth.ts:46), so login floods block the event loop.
  - There is no logout or revocation, and tokens last 30 days (auth.ts:5).
  - Tokens are kept in `localStorage`, readable by any XSS (see the echarts advisory in R-15).
- **Evidence:** app.ts:447–461. Verified by `grep -niE "rate.?limit|helmet|@fastify/rate" app.ts package.json`,
  which found no rate-limit or helmet plugin.
- **Current mitigation:** scrypt with a random salt. `timingSafeEqual`. A generic "Invalid email or password".
- **Recommendation:** Add `@fastify/rate-limit` (per IP and per account), async scrypt, a stronger password
  policy, and token revocation.

### R-09 Unauthenticated heavy endpoints and WebSocket without caps
- **Severity / likelihood:** Medium / Likely (if exposed).
- **Description:** 44 of 77 HTTP routes need no authentication. They include the CPU-heavy
  `POST /api/optimizer`, `POST /api/recap`, `POST /api/algos/:id/backtest-range` (up to 250 recorded days),
  `GET /api/oi/pcr` and the scanners. `/api/order-book` and `/api/order-flow` add 'user'-tier feed watches, so
  anonymous callers can spend the SFeed subscription budget, bounded by `MAX_USER_CONTRACTS = 250` and a
  2-min ad-hoc TTL. `/ws` accepts unlimited anonymous sockets (40 symbols each, a 1 s timer each) with no origin
  check.
- **Evidence:** the route table in [Q26_ARCHITECTURE_MAP.md](Q26_ARCHITECTURE_MAP.md) §2; app.ts:184, 329,
  411, 442, 546, 621–677; services/index.ts:51; live-market.ts:353.
- **Current mitigation:** Zod input bounds (e.g. `days ≤ 250`, `maxLegs ≤ 4`, `legs ≤ 12`). bodyLimit 1 MB
  (app.ts:142). The SFeed budget cap is 2,700 (config.ts:59).
- **Recommendation:** Rate-limit or authenticate the heavy routes. Cap WS connections per IP. Check `Origin`
  on `/ws`.

### R-07 Unbounded guest accounts
- **Severity / likelihood:** Medium / Likely.
- **Description:** Every browser without a valid token calls `POST /api/auth/guest`, which persists a new user
  (auth.ts:81–94; web/src/lib/api.ts:84). The endpoint is anonymous and unthrottled. Guests are never pruned
  (verified: `grep -rn guest apps/server/src` shows no cleanup). Each restart without a fixed `AUTH_SECRET`
  creates one more guest per returning browser. `db.json` grows without bound and is rewritten whole on every
  save (R-10).
- **Current mitigation:** None.
- **Recommendation:** Throttle guest creation and expire idle guests (e.g. after N days with no activity).

### R-12 Disk growth of recorded data
- **Severity / likelihood:** Medium / Certain over time.
- **Description:** The recorder writes ~3,000 instrument files per session under `market/<date>/`. Retention
  exists (`IntradayFiles.prune`, `retentionDays`), but production never sets it: `intradayRetentionDays` is
  absent from `index.ts` and has no env variable. EOD files also accumulate. Refdata keeps 5 days. A full disk
  breaks `db.json` saves and recording.
- **Evidence:** live/provider.ts:57, 318; live/store/intraday.ts:43–46, 194; index.ts:26–35;
  scripmaster.ts:335; recorder.ts:208.
- **Current mitigation:** None in the default configuration.
- **Recommendation:** Add an `INTRADAY_RETENTION_DAYS` setting. Monitor disk use and report it in
  `/api/health`.

### R-10 JSON-file persistence
- **Severity / likelihood:** Medium / Possible.
- **Description:**
  - The whole user DB is one file. Writes are debounced 300 ms (up to 300 ms of changes is lost on a crash).
  - Writes are synchronous `writeFileSync` of the whole document (they block the event loop and grow with
    size), with no fsync before the rename.
  - There are no transactions: multi-step updates such as a basket or an exit in slices are not atomic.
  - On a parse error the file is renamed to `db.json.corrupt-<ts>` and the app starts with an **empty DB,
    without logging**, so every account, order and position silently disappears.
  - It cannot run as more than one process.
- **Evidence:** store/db.ts:57–63, 68–74, 76–82; header comment db.ts:1–4.
- **Current mitigation:** tmp+rename (atomic replace). The corrupt file is kept.
- **Recommendation:** Log the corruption loudly and refuse to start, or alert. fsync the file and directory.
  Back up periodically. Consider SQLite when concurrency or size grows.

### R-11 Single-process availability
- **Severity / likelihood:** Medium / Possible.
- **Description:**
  - One Node process serves the API, WS, recorder, EOD and timers, with no supervisor in the repo.
  - The Dockerfile has no `HEALTHCHECK`, no `USER` (it runs as root), and the base image is tag-pinned only.
    README's `docker run` has no `--restart`.
  - There are no `uncaughtException` or `unhandledRejection` handlers (verified by grep, 0 matches). An
    unexpected rejection terminates Node 22, losing in-flight recorder minutes and unflushed DB changes.
  - `shutdown()` has no re-entry guard.
- **Evidence:** Dockerfile; index.ts:58–68; services/index.ts:129–139 (timer errors are caught, which helps).
- **Current mitigation:** Background ticks are wrapped in `safe()`. The provider never throws from `start()`.
  SIGTERM flushes the DB and recorder.
- **Recommendation:** Run under a supervisor (`--restart unless-stopped` or systemd). Add a `HEALTHCHECK` on
  `/api/health`, a non-root `USER`, global error handlers that flush then exit, and an idempotent shutdown.

### R-08 Network exposure
- **Severity / likelihood:** Medium / Possible.
- **Description:**
  - `HOST` defaults to `0.0.0.0` (config.ts:50; Dockerfile `ENV HOST=0.0.0.0`), so the API is reachable on
    every interface.
  - There is no TLS in the app, so bearer tokens and passwords travel in clear text unless a TLS proxy is put
    in front.
  - `cors({ origin: true })` (app.ts:143) reflects any Origin. Auth uses a bearer header, not cookies, so CSRF
    exposure is low, but any site can drive the public endpoints from visitors' browsers.
  - There are no security headers (CSP and so on).
- **Current mitigation:** Bearer tokens are not sent automatically by browsers.
- **Recommendation:** Default to `127.0.0.1` outside Docker. Document a TLS reverse proxy. Restrict the CORS
  origins. Add security headers.

### R-13 TOTP clock dependency
- **Severity / likelihood:** Medium / Possible.
- **Description:** TOTP codes are computed from the host wall clock (`Date.now`). There is no NTP or skew
  check. Skew beyond about ±30 s makes every login fail, which then feeds R-04. The IST session calendar, the
  recorder minutes and day-order expiry also use the same clock.
- **Evidence:** live/kotak/totp.ts:9, 58–66, 73–88; session.ts:262 (`now = Date.now`); live/clock.ts.
- **Current mitigation:** Never reuses a TOTP window. Requires ≥3 s left in the window.
- **Recommendation:** Check clock sync at start (for example compare with the HTTP `Date` header of a trusted
  host) and report the skew in health. Pause logins when the skew is above 10 s.

### R-03 Paper-vs-live confusion
- **Severity / likelihood:** Medium / Unlikely.
- **Description:**
  - **No live-order code path exists (verified).** `grep -rniE "placeorder|place_order|/orders?\b|cancelorder|modifyorder|quick/order|/order"`
    over `apps/server/src/live/kotak` found no order endpoint.
  - The only Kotak calls are the two login POSTs and market-data GETs: rest.ts:111, 604, 616, 627, 647, 660.
  - `grep "kind: 'session'"` returns 0 uses.
  - `services/trading.ts` and `algo.ts` have no network imports.

  Residual risk: the session comes from Kotak's **Trade API** login (`tradeApiLogin`/`tradeApiValidate`) and
  holds a token and sid that *could* place orders if code were added. `KotakSession.request` is a generic,
  path-agnostic method, and `kind: 'session'` (which adds Sid/neo-fin-key for "orders/reports/portfolio") is
  already defined (session.ts:76–77, 464–482).
- **Current mitigation:**
  - The UI labels paper trading on the order ticket, footer, Positions, Builder and Algo screens
    (OrderTicket.tsx:123, 192; Layout.tsx:270).
  - docs/README state "Paper trading only".
  - The paper broker fills only against a live book.
- **Recommendation:** Add an allowlist in `KotakSession.request` that refuses any path outside the five
  market-data endpoints. Add a test that fails if an order path appears. Remove the unused `'session'` kind.

### R-16 Secret handling
- **Severity / likelihood:** Low / Possible.
- **Description:**
  - `scrubSecrets` skips secrets shorter than 4 characters (env.ts:75). In practice MPIN is 4–8 digits, so it
    is covered.
  - It replaces exact substrings only, so an encoded or partially echoed secret is missed.
  - The SFeed client redacts only the sid and UCC (sfeed/client.ts:925–929).
  - `.env` sits in plain text on disk (exists in the main tree, mode 600; **contents not opened**).
  - `docker run --env-file` exposes the values through `docker inspect` to anyone with Docker access.
  - `.env` is correctly git-ignored, has never been committed (`git log --all -- .env` is empty), and is
    excluded from the Docker build context (`.dockerignore`).
- **Evidence:** env.ts:66–79; session.ts:700–705; index.ts:12–20; .gitignore:6–8; .dockerignore.
- **Current mitigation:** Values are validated but never logged or returned. Health carries no credentials,
  tested in market-routes.test "health: … no credentials".
- **Recommendation:** Use a secret store or Docker secrets in production. Extend redaction to the JWT and the
  URL-encoded forms. Keep `.env` at mode 600.

### R-14 Public health detail
- **Severity / likelihood:** Low / Likely.
- **Description:** `GET /api/health` is anonymous. It returns the Kotak `baseUrl`, data centre, rate-limit
  headers, endpoints on hold, scrubbed error texts, job schedules and recorder statistics.
- **Evidence:** app.ts:208–212; provider.ts:759–785; session.ts:652.
- **Recommendation:** Serve a minimal public health response. Put the detailed report behind authentication.

### R-17 Unofficial NSE endpoints
- **Severity / likelihood:** Low / Likely.
- **Description:** FII/DII (`/api/fiidiiTradeReact`) and the holiday master come from undocumented
  `www.nseindia.com` JSON behind Akamai, with cookie warm-up and browser-like headers. They can break or be
  blocked, and use may conflict with the site's terms.
- **Evidence:** live/nse/fiidii.ts:1–8; live/nse/holidays.ts:1–9; live/nse/http.ts:1–15; DESIGN.md:33–35.
- **Current mitigation:** Best-effort, blank with the reason, per-host throttling (www ≥3 s).
- **Recommendation:** Keep `HOLIDAYS` as an authoritative override. Review the terms of use. Monitor the
  failure rate in health.

### R-18 CI and supply chain
- **Severity / likelihood:** Low / Possible.
- **Description:**
  - GitHub Actions are pinned by major tag (`@v4`), not by SHA.
  - CI has no `npm audit`, secret scanning or lint.
  - `node:22-alpine` is unpinned by digest.
  - CI downloads Playwright browsers.
  - GitHub CI run results were **NOT VERIFIED**.
- **Evidence:** .github/workflows/ci.yml; Dockerfile.
- **Recommendation:** Pin actions and the base image by digest. Add audit and secret-scan steps.

## Items not verifiable in this audit

| Item | Reason |
|---|---|
| Real Kotak login/REST/SFeed, NSE/BSE downloads | No network calls to these hosts were allowed (audit rule) |
| Kotak account lockout threshold, rate quotas, session lifetime | Needs the broker's documentation or a live account |
| Contents of the deployed `.env` (whether `AUTH_SECRET=change-me`) | Reading `.env` was forbidden |
| ZIP-to-git equivalence | No ZIP was provided in this session |
| GitHub Actions results for `ea1be96` | Not queried |
