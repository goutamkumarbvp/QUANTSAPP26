# Q26 Options — Production Readiness Report

**Verdict: READY to run as a paper-trading and analytics program on live market data, on a host that can reach
Kotak Neo and NSE/BSE. NOT READY for live trading.** No live-order path exists, and live broker connectivity
was not verified, because the audit environment blocks the Kotak and NSE/BSE hosts.

## Readiness gates

| Gate | Status | Evidence |
|---|---|---|
| A. Build verified | **PASS** | `npm run typecheck` and `npm run build` exit 0 (`evidence/final/typecheck.log`, `build.log`). The Docker image builds (`evidence/final/docker.log`) |
| B. Test verified | **PASS** | 944 unit tests: core 82, server 691, web 171. Browser e2e results are in TEST_EXECUTION_REPORT.md. Broker and exchange tests use fakes and are not live proof |
| C. Broker connectivity verified | **BLOCKED** | Kotak hosts are denied by this environment (`fetch failed`). Run BROKER_INTEGRATION_STATUS.md §4 on your own machine |
| D. Live data verified | **BLOCKED** | Same reason. Stale, missing and disconnected states are verified with fakes (FEED STALE, DATA UNAVAILABLE, DISCONNECTED) |
| E. Manual order path verified | **NOT APPLICABLE / NOT READY** | Paper trading only, by design (`safety.ts`, runtime check SAFE-1). There is no broker order code |
| F. Production deployment verified | **PARTIAL** | Verified: the Docker image (non-root, supervisor, healthcheck, clean stop); the supervisor's crash and hang restarts; a backup restore drill; operator alerts (in-app, plus an optional webhook). Not yet done: a TLS reverse proxy on your host |
| G. Decision | **Paper / analytics: GO once C and D pass on your machine. Live trading: NO-GO** | ZERO_TRUST_45_POINT_AUDIT.md: 29 PASS, 3 FAIL, 4 BLOCKED, 9 NOT TESTED |

## What was done

- **Model F engines** (one button each on the Home dashboard):
  - **Login Monitor:** 5 s checks and immediate re-login. Transient failures are retried within seconds. Credential refusals back off, and after 5 refusals in a row automatic login **pauses**, so the Kotak account cannot be locked out. The pause survives restarts.
  - **24×7 Watchdog plus supervisor:** memory, responsiveness, errors, login, feed, instrument master, jobs, EOD, disk and db writes. The server is restarted after a crash, a hang or a critical state, with a restart-loop cap.
  - **Weekly Saturday→Saturday audit:** 19 checks. Safe automatic fixes: re-download missing or corrupt EOD files, refresh the instrument master, rebuild the email index, redact leaked secrets, housekeeping. JSON and Markdown reports.
- **Hardening:**
  - operator-only actions (owner or OPS_ADMIN_EMAILS);
  - rate limits (IPv6 /64, TRUST_PROXY);
  - AUTH_SECRET placeholders rejected, with a stored secret instead;
  - runtime npm advisories cleared to 0;
  - non-root Docker image with healthcheck and volume-ownership fix;
  - readable IST terminal logs, about 20 lines at start-up against 2,073 lines in the baseline run.
- **Reviews:** two adversarial multi-agent reviews found 42 defects. All are fixed, each with a regression test (Q26_CHANGELOG.md).

## Before going further

| Before | Do |
|---|---|
| Using live data | On a machine that can reach the hosts: set `.env` (NEO_*, AUTH_SECRET, OPS_ADMIN_EMAILS), `npm run start:supervised`, and run the BROKER_INTEGRATION_STATUS.md §4 checklist during market hours |
| Exposing it beyond your PC | TLS reverse proxy plus TRUST_PROXY (and WS_ALLOWED_ORIGINS if the site name differs); firewall |
| Any live order placement | Risk engine, daily-loss limit, idempotency, order state machine, reconciliation, kill switch (audit controls 23–27, 32–34, 37). These are not built, and are deliberately out of scope |

No claim is made that trading with this program is profitable or free of risk.
