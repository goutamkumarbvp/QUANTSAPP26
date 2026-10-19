# Q26 Options — Baseline Test Report (commit `ea1be96`)

## Environment

| Item | Value |
|---|---|
| Source | Detached git worktree of `ea1be961aa2d…` at `/tmp/claude-0/-home-user-QUANTSAPP26/80c41c5a-cad1-533f-98d3-972cbc52ade6/scratchpad/baseline-audit/wt`. It was clean (`git status --porcelain --untracked-files=no` → 0 lines) and matched the SHA-256 manifest (`sha256sum -c` all OK). It was removed after the runs. |
| Runtime | Node v22.22.0, npm 10.9.4, Linux 6.18 |
| `.env` | None in the worktree (`ls` → "No such file or directory" for `<wt>/.env` and `<wt>/apps/server/.env`). No credentials were present during any run. |
| Env vars set by the auditor | `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` on every run. `CHROMIUM_PATH=/opt/pw-browsers/chromium` for e2e only. `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers` was already in the environment. |
| Network | No call was made to Kotak, NSE or BSE. `npm ci` and `npm audit` used the npm registry (allowed). |
| Raw logs | [evidence/](evidence/): `run-summary.txt`, `npm-ci.log`, `typecheck.log`, `test.log`, `build.log`, `test-e2e.log`, `npm-audit-omit-dev.json`, `npm-audit-all.json` |

## Results

| # | Command (run in the worktree root) | Start (UTC) | End (UTC) | Exit | Result |
|---|---|---|---|---|---|
| 0 | `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --prefer-offline --no-audit --no-fund` | 15:48:59 | 15:49:11 | 0 | "added 307 packages in 11s". One npm deprecation warning (`glob@11.1.0`). |
| 1 | `npm run typecheck` | 15:49:31 | 15:50:03 | 0 | `tsc -p` for @q26/core, @q26/server (src+test) and @q26/web: **0 errors** |
| 2 | `npm test` | 15:50:03 | 15:50:50 | 0 | **50 test files, 867 tests passed, 0 failed, 0 skipped** (breakdown below) |
| 3 | `npm run build` | 15:50:50 | 15:51:13 | 0 | Web: `tsc` + `vite build` (710 modules, 0 warnings, largest chunk `echarts` 651.34 kB / 215.44 kB gz). Server: esbuild produced `dist/server.mjs` 638.2 kB and its map 1.5 MB. |
| 4 | `CHROMIUM_PATH=/opt/pw-browsers/chromium PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 timeout 900 npm run test:e2e` | 15:51:40 | 15:54:12 | 0 | **96 tests passed, 0 failed, 0 skipped, 0 flaky** (2.5 min, 1 worker) |
| 5 | `npm audit --omit=dev --json` | 15:54:22 | 15:54:25 | 1 (vulnerabilities found) | 4 production vulnerabilities: 1 high (`@fastify/static`), 3 moderate (`echarts`, `react-router`, `react-router-dom`), 0 critical. See [Q26_RISK_REGISTER.md](Q26_RISK_REGISTER.md) R-15. |
| 6 | `npm audit --json` (including dev) | ~15:54 | ~15:54 | 1 | 17 in total: 2 critical (`vitest`, `tinypool`, dev only), 7 high, 8 moderate |

### `npm test` breakdown (vitest 2.1.9)

| Workspace | Test files | Tests passed | Failed | Skipped | Duration |
|---|---|---|---|---|---|
| @q26/core | 4 | 82 | 0 | 0 | 1.43 s |
| @q26/server | 39 | 645 | 0 | 0 | 36.93 s |
| @q26/web | 7 | 140 | 0 | 0 | 5.49 s |
| **Total** | **50** | **867** | **0** | **0** | |

Slowest server files: `routes-smoke.test.ts` (16 tests, 19.7 s), `analytics.test.ts` (8.1 s),
`market-routes.test.ts` (7.2 s), `algo-live.test.ts` (7.0 s).

### `npm run test:e2e` breakdown (Playwright 1.64.0)

**Chromium.** The project config (`apps/web/playwright.config.ts`, `chromiumPath()`) uses `CHROMIUM_PATH`
when it is set. Otherwise it scans `PLAYWRIGHT_BROWSERS_PATH` for `chromium-*`. `/opt/pw-browsers/chromium` is
a symlink to `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. No browser was downloaded, and
`playwright install` was **not** run. Chromium revision 1194 is older than Playwright 1.64's bundled revision,
but every test ran.

| Project | Server under test | Tests | Passed |
|---|---|---|---|
| live-desktop | production bundle `dist/server.mjs`, with `--import tests/support/no-network.mjs` (fetch disabled), no credentials, empty temp DATA_DIR, EOD backfill 0 | 42 (40 page renders: every router path, with 3 `/learn/:slug` instances; plus feed chip and home checks) | 42 |
| live-mobile (Pixel 7) | same | 42 | 42 |
| live-master-desktop | same, plus a TEST-ONLY seeded same-day instrument master | 2 | 2 |
| fixture-desktop | TEST-ONLY `test/support/e2e-server.ts` (FakeProvider + sample book) | 10 | 10 |
| **Total** | | **96** | **96** |

### Failures (verbatim)

None. No command reported a failing, skipped, todo or flaky test. The only warnings were the npm deprecation
notice for `glob@11.1.0` during `npm ci`, and the `npm audit` findings above.

## What these results do and do NOT prove

- **The tests are mocked.** Every Kotak and NSE/BSE test injects fakes:
  - `kotakFetch`, `nseFetch` and `wsFactory` in `test/live/provider.test.ts:76–82` and
    `provider-robustness.test.ts`
  - `fetch: ff.fn` in `kotak-session.test.ts:51–52`
  - `fakeFetch` in `nse-fake.ts:55–56`
  - FakeSFeed sockets
  - sample CSV fixtures under `test/live/fixtures/nse/`

  Real hostnames appear in tests only as URL strings matched by the fakes.
- Route, service and web tests run on the **TEST-ONLY FakeProvider** with sample data. The e2e LIVE-EMPTY
  servers run with network calls disabled. The e2e FIXTURE server serves fake data.
- So the results show internal consistency only. That covers the parsers against documented sample payloads,
  the blank-state behaviour, routing, validation, user isolation and paper-broker logic. **They are NOT proof
  of live connectivity, of real Kotak/SFeed message semantics, or of NSE/BSE availability.** Those remain
  **NOT VERIFIED** (see risk R-01).
- Crash and recovery behaviour of `db.json`, disk-full handling, long-run memory and recorder disk growth were
  not exercised by any test run here (**NOT TESTED**).

## Cleanup

The worktree was removed with `git worktree remove --force <wt>` after the runs. `git worktree list` then
showed only the main tree. No existing file was modified, staged or committed.
