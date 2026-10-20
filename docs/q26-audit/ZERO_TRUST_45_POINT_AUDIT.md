# Q26 Options — Zero-Trust 45-Point Audit

| Item | Value |
|---|---|
| Scope | Branch `claude/quantsapp-trading-audit-noqax6` at the release commit (baseline `ea1be96`) |
| Assessor | The implementing engineer (Claude) |
| Independence | Two independent multi-agent adversarial reviews ran: 42 findings, all fixed with regression tests (Q26_CHANGELOG.md C-18 … C-21). An independent re-run of this 45-point table could not complete before delivery (usage limits); treat this table as **self-assessed with evidence**. |
| Evidence | `docs/q26-audit/evidence/final/` (typecheck, unit tests, build, e2e, npm audit, Docker, terminal runs) and the baseline `evidence/` |
| Statuses | PASS = verified with the cited evidence. FAIL = requirement not met. BLOCKED = needs something this environment lacks (live Kotak/NSE access). NOT TESTED = not exercised; for many controls this is because the feature (live order placement) does not exist by design. |

## Summary

| Result | Count |
|---|---|
| PASS | 29 |
| FAIL | 3 |
| BLOCKED | 4 |
| NOT TESTED | 9 |

**Production readiness for live trading: NOT READY** (control 45). Q26 is a paper-trading program: no live-order path exists, and live broker connectivity could not be verified here.

## Controls

| ID | Requirement | Procedure / command | Evidence | Expected | Actual | Status | Severity / remediation |
|---|---|---|---|---|---|---|---|
| 1 | Archive and source integrity | SHA-256 of every baseline file; git history from `ea1be96`; SHA-256 of the final zip | `baseline-sha256-manifest.txt` (222 files); `.sha256` file next to the zip | Traceable baseline and package | Manifest matches a clean `ea1be96` worktree; the zip has a published checksum | PASS | — |
| 2 | Preservation of existing functionality | Full regression suite; diff review (`git diff ea1be96..HEAD`) | `final/unit-tests.log`, `final/e2e.log`, Q26_CHANGELOG.md "Explicitly not changed" | No screen, route, strategy or calculation removed or altered | All baseline tests still pass. Additive changes only, plus the documented UI fixes (grey disabled Buy/Sell; Order Flow axis labels every 5 min after the echarts 6 upgrade) | PASS | — |
| 3 | Dependency and build integrity | `npm ci`, `npm run build`, lockfile committed | `final/build.log`, `package-lock.json` | Reproducible build | Build exit 0 | PASS | — |
| 4 | Configuration validation | NEO_* validation (names only); AUTH_SECRET placeholder/short handling; OPS_ADMIN_EMAILS; TRUST_PROXY | `test/live/config-env.test.ts`, `test/ops.test.ts` (AUTH_SECRET, TRUST_PROXY) | Invalid configuration is reported and never used unsafely | Weak or unset AUTH_SECRET is replaced by a stored random secret, with a warning | PASS | — |
| 5 | Secret scanning | Credential-value scan (values compared in memory, never printed) of every committed file and log; runtime check SEC-1 | scan outputs "clean" for all files; SEC-1 tests (whole-token matching, JSON-safe redaction) | No credential value in source, logs or archives | None found; `.env` excluded by `.gitignore` and `.dockerignore` and not in the zip | PASS | — |
| 6 | Authentication | scrypt password hashing, HMAC bearer tokens, rate-limited sign-in | `apps/server/src/auth.ts`; `test/ops.test.ts` (429 after 30 sign-in attempts) | Credentials stored hashed; brute force throttled | As expected | PASS | Low: guest accounts are open by design (paper app) |
| 7 | Backend authorization | Per-user ownership on every user route; operator check on operations | `test/routes-smoke.test.ts` "one user cannot reach another user's items"; `test/ops.test.ts` operator tests | No cross-user access; actions need an operator | As expected | PASS | — |
| 8 | Privilege separation | Guest / registered / operator roles; container runs as `node` | `test/ops.test.ts`; `final/docker.log` | Least privilege | As expected | PASS | — |
| 9 | API input validation | zod schemas on every body and query | routes-smoke "bad input is a 400/404 with the reason" | Invalid input → 4xx, never 5xx | As expected | PASS | — |
| 10 | WebSocket authorization | Origin check before the upgrade (same host name, or WS_ALLOWED_ORIGINS); open sockets capped per client address (20, IPv6 by /64) and in total (1,000) | `test/ops.test.ts` "/ws guard" (another site's origin refused; 21st socket refused) | Cross-site sockets refused; connection flooding capped | As expected. Sockets carry public market data and the caller's own notifications only after an auth message | PASS | — |
| 11 | Rate limiting | Per-address limits (sign-in, guest, heavy calculations); per-operator limits for operations; IPv6 /64; bounded store; TRUST_PROXY | `test/ops.test.ts` rate-limit tests | Abuse throttled | As expected (WebSocket: see 10) | PASS | — |
| 12 | TLS and secure communication | grep for TLS bypasses; outbound calls are `https://` / `wss://` | no `rejectUnauthorized` / `NODE_TLS_REJECT_UNAUTHORIZED` in `apps/server/src` | Certificate checks never disabled | Outbound TLS verified by Node defaults. Inbound TLS is a deployment step (reverse proxy) and was not exercised | NOT TESTED | Medium: terminate TLS at the proxy (DEPLOYMENT_GUIDE.md §4.3) |
| 13 | Broker authentication | TOTP → MPIN login against Kotak | BROKER_INTEGRATION_STATUS.md; terminal runs show `fetch failed` (host blocked) | Real login | Mocked tests pass; live login impossible from this environment | BLOCKED | Run the checklist in BROKER_INTEGRATION_STATUS.md §4 |
| 14 | Exchange and instrument mapping | Scrip-master parsing for NIFTY, SENSEX, BANKEX and others | `kotak-scripmaster.test.ts` (fixtures) | Verified against real files | Fixture-verified only. MCX is not supported | BLOCKED | Same checklist |
| 15 | Subscription acknowledgements | SFeed protocol client | `sfeed-protocol.test.ts`, `sfeed-client.test.ts` (mocked) | Real acks observed | Mocked only | BLOCKED | Same checklist |
| 16 | Live-tick provenance | Quotes only from SFeed/REST; no synthesis | `review-no-synthetic.test.ts`; routes-smoke "no live field filled" in stale/empty states | No fabricated values | No synthetic value in any state; live provenance not observable without Kotak | BLOCKED | Same checklist |
| 17 | Tick freshness | FEED_STALE_MS 60 s (one threshold for header, panel and watchdog); paper fills need a book ≤ 10 s old | `ops.test.ts` watchdog feed tests; `services/live.ts` `BOOK_MAX_AGE_MS` | Old ticks never shown or traded as live | As expected | PASS | — |
| 18 | Timestamp and sequence validation | Quote timestamps per session; SFeed protocol has no sequence numbers | `live-market.test.ts` | Out-of-order and duplicate ticks detected | Session/date validation exists; sequence validation impossible with this protocol and not verified live | NOT TESTED | Low |
| 19 | Missing and malformed data | 503 NO_LIVE_DATA with reasons; blanks in the UI | routes-smoke in 5 data states; e2e live-empty | Blank with reason, never a value | As expected | PASS | — |
| 20 | Stale-feed blocking | Paper fills refused without a fresh bid/ask; FEED STALE shown; watchdog restarts the socket after 90 s | routes-smoke "never filling without a live bid/ask"; ops watchdog tests | Blocks and is visible | As expected | PASS | — |
| 21 | Broker-disconnection blocking | No session → no quotes → no fills; DISCONNECTED chip | e2e live-empty; ops status tests | Blocks and is visible | As expected | PASS | — |
| 22 | Strategy regression integrity | Strategy, algo, ORB and paper-trading suites unchanged | `algo-live.test.ts`, `orb.test.ts`, `paper-trading.test.ts` in `final/unit-tests.log` | Identical behaviour | All pass; no strategy code changed | PASS | — |
| 23 | Risk-limit enforcement | — | — | Enforced limits for live orders | No live-order path. Paper broker estimates margin from live data | NOT TESTED | Required before any live trading |
| 24 | Margin and exposure validation | Paper margin estimate | `trading.ts` `marginFor` | Live margin check | Paper estimate only; fails closed (NoLiveData) without live IV | NOT TESTED | Required before any live trading |
| 25 | Daily-loss protection | — | — | Daily-loss limit | Not implemented (paper only) | FAIL | High, but only for live trading: implement before any live-order path |
| 26 | Order quantity and price validation | zod `orderSchema` (lots integer, expiry format, side, type) | routes-smoke bad-input tests | Invalid orders rejected | As expected (paper) | PASS | — |
| 27 | Duplicate-order prevention | — | — | Idempotency keys | Paper broker has no idempotency key | NOT TESTED | Required before any live trading |
| 28 | Idempotency and retry safety | Login retries are bounded and classified; forced login retried as normal | `kotak-session.test.ts`, `provider-robustness.test.ts` | Retries never repeat unsafe actions | No order submission exists to retry; login retries are safe and bounded | PASS | — |
| 29 | Manual authorization enforcement | Orders need a signed-in user; no broker order path | routes-smoke auth tests | Every order authorised | As expected (paper) | PASS | — |
| 30 | Automatic-execution prohibition | `SAFETY` constants plus runtime SAFE-1 (Kotak client has no order methods) | `ops.test.ts` SAFE-1 PASS, and FAIL when an order method is added | No automatic execution to a broker | As expected. Algos place PAPER orders only (preserved feature) | PASS | — |
| 31 | Backend order firewall | No route or client method can reach a broker order API | `grep` of `apps/server/src/live/kotak`; SAFE-1 | No path | None exists | PASS | — |
| 32 | Broker rejection and timeout handling | Login rejections and timeouts classified | `kotak-session.test.ts` failure-class tests | Explicit handling | Login: PASS. Orders: no live orders exist | NOT TESTED | Required before any live trading |
| 33 | Partial fill and order state | — | — | State machine | Paper fills are whole at the live bid/ask | NOT TESTED | Required before any live trading |
| 34 | Position and order reconciliation | — | — | Broker reconciliation | No broker positions (paper) | NOT TESTED | Required before any live trading |
| 35 | Database transaction integrity | JSON document store with atomic file writes | `store/db.ts` | Transactions | Atomic whole-file writes, no multi-record transactions. Write failures are reported (watchdog) and retried | FAIL | Medium: move to SQLite before multi-user or live use |
| 36 | Restart recovery | Supervisor crash/hang tests; login pause, sign-in secret and owner persist across restarts | `final/terminal-run3-crash-hang.log`; session persistence tests | Clean recovery without unsafe resets | kill -9 → restarted in 1 s; SIGSTOP hang → SIGKILL and restart; the lock-out protection survives restarts | PASS | — |
| 37 | Emergency order blocking | — | — | Kill switch | No live orders. Paper algos can be stopped per run | NOT TESTED | Required before any live trading |
| 38 | Audit-log integrity | Journal lines are hash-chained (`prev` = SHA-256 of the line before); `verify()`; weekly check OPS-5; authorised redaction rebuilds the chain | `test/ops.test.ts` "journal hash chain" (edited and removed lines detected; OPS-5 FAIL) | Tamper-evident log | Edits and deletions inside a file are detected. Truncating the last lines of a file is not detectable (no outside anchor), as documented | PASS | Low: ship the journal to an outside store for full non-repudiation |
| 39 | Dependency and vulnerability assessment | `npm audit --omit=dev` and `npm audit` | `final/npm-audit-prod.log`, `final/npm-audit-all.log` | No runtime advisories | Runtime: 0 vulnerabilities (after @fastify/static 10, react-router 7, echarts 6). Dev-only toolchain advisories remain (vitest, vite, tailwind 3); not shipped in the image | PASS | Low: upgrade the dev toolchain |
| 40 | Resource limits and failure handling | bodyLimit, rate limits, watchdog (memory, event loop, disk), bounded caches | `ops.test.ts` watchdog tests | Graceful degradation | As expected | PASS | — |
| 41 | Regression and integration test coverage | Full suite | `final/unit-tests.log` (938 tests), `final/e2e.log` | All pass | See TEST_EXECUTION_REPORT.md | PASS | Mocked broker tests are not live proof (13–16) |
| 42 | Deployment and configuration security | Docker non-root, healthcheck, `.env` never in images; entrypoint fixes old root-owned volumes | `final/docker.log` | Secure defaults | Verified on the earlier image; the entrypoint rebuild result is in TEST_EXECUTION_REPORT.md §5 | PASS | — |
| 43 | Monitoring and alerting | Error-level events (watchdog CRITICAL, login PAUSED, audit FAIL, restart loop) → in-app notification to the operator accounts, plus optional ALERT_WEBHOOK_URL (Slack/Discord/ntfy JSON); de-duplicated per 15 min, at most 30 per hour | `test/ops.test.ts` "alerts" | Problems reach a person | As expected. The webhook was tested with a fake endpoint (no outbound network here) | PASS | — |
| 44 | Backup and recovery verification | Restore drill: create user + watchlist → stop → back up (`db.json`, `.auth-secret`) → wipe DATA_DIR → restore → start | `evidence/final/restore-drill.log` | Data and sign-ins restored | Login works, the watchlist is back, and a token issued before the backup is still valid (HTTP 200) | PASS | — |
| 45 | Independent production-readiness decision | Gates A–G in PRODUCTION_READINESS_REPORT.md | — | Every mandatory gate passes | Gates C/D BLOCKED; gate E not applicable (no live orders) | FAIL | **NOT READY for live trading** |
