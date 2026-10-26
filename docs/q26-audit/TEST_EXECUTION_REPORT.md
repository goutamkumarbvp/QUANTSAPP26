# Q26 Options — Test Execution Report (release)

Run in the audit environment (Node 22.22.0, npm 10.9.4) on the release tree. Logs are in `evidence/final/`. The
baseline (`ea1be96`) results are in Q26_BASELINE_TEST_REPORT.md.

## 1. Results

| # | Command | Result | Log |
|---|---|---|---|
| 1 | `npm run typecheck` (core, server, web) | exit 0 | `typecheck.log` |
| 2 | `npm test` | **974 passed, 0 failed**: core 87 (5 files), server 710 (41 files), web 177 (10 files) | `unit-tests.log` |
| 3 | `npm run build` | exit 0 | `build.log` |
| 4 | `npm run test:e2e` (Playwright, preinstalled Chromium; live-empty desktop and mobile, live-master, fixture) | **99 passed** (1.9 min) | `e2e.log` |
| 5 | `npm audit --omit=dev` (runtime) | **0 vulnerabilities** | `npm-audit-prod.log` |
| 6 | `npm audit` (including dev tools) | 13 (5 moderate, 6 high, 2 critical), all in the dev toolchain: vitest, vite, tailwind 3. Not in the runtime image | `npm-audit-all.log` |
| 7 | Docker build + run (q26-options:final) | Builds. Runs as `node` (supervisor PID 1), health 200, an old root-owned volume is handed to `node`, clean stop with exit 0 | `docker.log` |
| 8 | Supervised terminal runs: crash (`kill -9`) and hang (`SIGSTOP`) | Crash → restarted in 1 s. Hang → 3 failed health checks → SIGKILL → restarted | `terminal-run3-crash-hang.log`, `terminal-run3-steps.log` |
| 10 | Backup / restore drill: back up `db.json` + `.auth-secret`, wipe DATA_DIR, restore, start | Login works, data back, a token issued before the backup still valid | `restore-drill.log` |
| 9 | Terminal output before and after | Baseline 2,073 lines (68 % per-request JSON); release about 20 readable IST lines at start-up | `terminal-run1-baseline-summary.log`, `terminal-run2.log` |

Baseline → release: 867 → 974 unit tests and 96 → 99 e2e tests. No existing test was removed or weakened.

## 2. What the tests do NOT prove

- **Kotak and NSE/BSE:** every broker and exchange test uses a fake `fetch` or fake websocket (mocked). They are **not proof of live connectivity**. Live runs here end in `fetch failed`, because the environment's network policy blocks the hosts.
- **Live orders:** none exist (paper only), so no order-placement test exists or was run.
- **Inbound TLS:** the reverse-proxy TLS setup was not exercised.

## 3. New tests in this release (highlights)

| Area | Tests |
|---|---|
| Login classes and back-off, pause after 5 refusals, persistence across restarts, forced-retry chain (shown failing on the old code: 53 logins in 24 h; 6 with the fix) | `kotak-session.test.ts`, `provider-robustness.test.ts`, `ops.test.ts` |
| Watchdog: feed stale, restart and cooldown; memory; login; disk; restart suppression | `ops.test.ts` |
| Weekly audit: schedule, safe fixes, quarantine re-download verification, 404 handling, JSON-safe secret redaction, PAUSED handling | `ops.test.ts` |
| Operator authorization, restricted status, guest-upgrade takeover blocked, per-operator and per-/64 rate limits | `ops.test.ts`, `routes-smoke.test.ts` |
| EOD offline stop (participants "waiting" and the FII/DII network flag) | `eod.test.ts` |
| Operations panel (buttons, reasons, restricted view, STATUS UNKNOWN), gap labels, Positions loading state | `apps/web/test/*.test.tsx`, e2e `live-empty.spec.ts` |
