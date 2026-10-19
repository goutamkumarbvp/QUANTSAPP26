# Q26 Options — Feature Preservation Matrix (baseline `ea1be96`)

## How to read this matrix

**Verification status** comes only from the baseline runs recorded in
[Q26_BASELINE_TEST_REPORT.md](Q26_BASELINE_TEST_REPORT.md): typecheck, 867 unit tests and 96 Playwright tests,
all passing. Every test runs against fakes: a FakeProvider, fake fetch/WebSocket, and sample CSV/JSON fixtures.
The status values are:

- **Works per tests (fakes)**: tests pass on fake or fixture data. Behaviour on real Kotak/NSE data is still
  **NOT VERIFIED**.
- **Cannot verify without live broker**: correctness depends on real Kotak responses or feed semantics that no
  test can prove.
- **Incomplete**: a documented functional gap at baseline.
- **Defective**: a failing test or a reproduced bug. **None was found at baseline.**

**Dependencies:**

- **K**: live Kotak (session, REST, SFeed)
- **E**: NSE/BSE official EOD files, or the unofficial NSE JSON
- **R**: sessions recorded by this app's recorder (DATA_DIR/market)
- **none**: pure computation

**Change required** says whether the baseline audit found a reason to change the feature. "No" means preserve
it as is.

**Test abbreviations.** Server tests are in `apps/server/test/`, with live-provider tests under `live/`. Web
unit tests are in `apps/web/test/`. e2e specs are in `apps/web/tests/`. `LE` is `live-empty.spec.ts`, which
renders every route on desktop and mobile with no credentials and no network. `FX` is `fixture.spec.ts`
(FakeProvider data). `LM` is `live-master.spec.ts`.

## A. Web screens (router: `apps/web/src/App.tsx:77–115`, 38 paths + `*` NotFound)

| # | Route | Screen (nav label) | Page source | Server APIs used | Deps | Tests | Verification | Change? |
|---|---|---|---|---|---|---|---|---|
| 1 | `/` | Home | pages/Home.tsx | /dashboard, /candles, /oi/strikes … | K, E, R | routes.test (dashboard), web home.test, LE (×2), FX home | Works per tests (fakes) | No |
| 2 | `/tools` | Tools hub | pages/Tools.tsx | none (links) | none | LE | Works per tests | No |
| 3 | `/option-chain` | Option Chain | pages/OptionChain.tsx, lib/hooks.ts | /chain, /expiries, /meta, /oi/multi-strike | K (R for `?at=`) | foundation.test (option chain), valuation-time, verify-adversarial, web trading-pages (Option chain), FX, LM, LE | Works per tests (fakes); live chain NOT VERIFIED | No |
| 4 | `/watchlist` | Watchlist | pages/Watchlist.tsx | /watchlists, /watchlists/:id/quotes | K | alerts.test (watchlist quotes), web trading-pages (Watchlist), LE | Works per tests (fakes) | No |
| 5 | `/synopsis` | Synopsis | pages/Synopsis.tsx | /synopsis | K, E | tools.test (unusual activity and synopsis), web analysis-pages, LE | Works per tests (fakes) | No |
| 6 | `/fii-dii` | FII / DII | pages/FiiDii.tsx | /fii-dii | E (unofficial NSE JSON) | analytics.test (official FII/DII…), live/nse-fiidii-holidays, live/eod, web analysis-pages, LE | Works per tests (fixtures); real NSE endpoint NOT VERIFIED | No |
| 7 | `/participants` | Participant OI | pages/Participants.tsx | /participants | E | analytics.test, live/nse-participants, web analysis-pages, LE | Works per tests (fixtures) | No |
| 8 | `/oi/strikes` | OI Analysis (strike OI, change in OI) | pages/oi/StrikeOI.tsx | /oi/strikes | K, E (prev OI), R (`?at=`) | analytics.test (strike-wise OI), web analysis-pages, LE | Works per tests (fakes) | No |
| 9 | `/oi/multi-strike` | Multi-Strike OI | pages/oi/MultiStrike.tsx | /oi/multi-strike | R | analytics.test (multi-strike series), web analysis-pages, LE | Works per tests (fakes) | No |
| 10 | `/oi/trend` | OI Trend | pages/oi/OiTrend.tsx | /oi/trend | R | analytics.test, review-no-synthetic (recorded OI trend), web, LE | Works per tests (fakes) | No |
| 11 | `/oi/pcr` | PCR | pages/oi/Pcr.tsx | /oi/pcr | K, R, E (daily) | analytics.test (OI trend, PCR and max pain), core.test (OI analytics), web, LE | Works per tests (fakes) | No |
| 12 | `/oi/max-pain` | Max Pain | pages/oi/MaxPain.tsx | /oi/max-pain | K | analytics.test, core.test, web, LE | Works per tests (fakes) | No |
| 13 | `/oi/futures` | Futures OI & build-up | pages/oi/FuturesOI.tsx | /oi/futures | K, E | analytics.test (futures build-up and breadth), web, LE | Works per tests (fakes) | No |
| 14 | `/oi/breadth` | Build-up Breadth | pages/oi/Breadth.tsx | /oi/breadth | K, E | analytics.test, review-no-synthetic (build-up breadth), web, LE | Works per tests (fakes) | No |
| 15 | `/vol/iv-chart` | IV Chart | pages/vol/IvChart.tsx | /vol/iv-chart | K, R, E | analytics.test (volatility), web, FX (IV chart), LE | Works per tests (fakes) | No |
| 16 | `/vol/ivp` | IV Rank & Percentile | pages/vol/IvTable.tsx | /vol/table, /vol/iv-chart | K, E | analytics.test (volatility), web, LE | Works per tests (fakes) | No |
| 17 | `/vol/skew` | Volatility Skew | pages/vol/Skew.tsx | /vol/skew | K, E (prev) | analytics.test (skew), web, LE | Works per tests (fakes) | No |
| 18 | `/vol/surface` | Volatility Surface | pages/vol/Surface.tsx | /vol/surface | K | analytics.test, valuation-time, web, LE | Works per tests (fakes) | No |
| 19 | `/vol/cone` | Volatility Cone | pages/vol/Cone.tsx | /vol/cone | E | analytics.test (realised-vol cone), core.test (volatility), web, LE | Works per tests (fixtures) | No |
| 20 | `/builder` | Strategy Builder (payoff, Greeks) | pages/Builder.tsx, components/Payoff.tsx | /strategy-chart, /strategies, /broker/basket | K | core payoff-margin.test, web trading-pages (Strategy Builder and payoff), FX (wizard → builder → paper execute), LE | Works per tests (fakes) | No |
| 21 | `/templates` | Strategy Wizard | pages/Templates.tsx | via the builder | K | core.test (templates & naming), web trading-pages (Strategy Wizard), FX, LE | Works per tests (fakes) | No |
| 22 | `/optimizer` | Optimizer | pages/Optimizer.tsx | POST /optimizer | K | core.test (optimizer), analytics.test (optimizer…), valuation-time, web, FX, LE | Works per tests (fakes) | Yes (minor): public CPU-heavy endpoint with no rate limit (risk R-09) |
| 23 | `/straddle` | Straddle Chart | pages/Straddle.tsx | /straddle | R, K (1-min candles) | analytics.test (straddle…), routes.test (straddle route), web, LE | Works per tests (fakes) | No |
| 24 | `/strategy-chart` | Strategy Chart | pages/StrategyChart.tsx | POST /strategy-chart | R, K | analytics.test, web, LE | Works per tests (fakes) | No |
| 25 | `/recap` | Trade Recap (backtest of a leg set) | pages/Recap.tsx | POST /recap | R | analytics.test, web (Trade Recap), LE | Works per tests (fakes) | No |
| 26 | `/positions` | Positions & Orders (paper) | pages/Positions.tsx, components/OrderTicket.tsx | /broker/*, /futures | K (live book to fill) | paper-trading.test, routes.test (paper trading over HTTP), verify-adversarial (day orders), review-no-synthetic, web order-ticket + trading-pages (Positions), FX (paper fill), LM (no live bid/ask → rejected), LE | Works per tests (fakes) | No |
| 27 | `/strategies` | Strategy Manager | pages/Strategies.tsx | /strategies | K | paper-trading.test (strategy manager), web trading-pages, LE | Works per tests (fakes) | No |
| 28 | `/alerts` | Alerts & notifications | pages/Alerts.tsx, components/Layout.tsx | /alerts, /notifications | K, R | alerts.test (alerts on live values), web trading-pages (Alerts), LE | Works per tests (fakes) | No |
| 29 | `/scanners` | F&O Scanners (23) | pages/Scanners.tsx | /scanners, /scanners/:id | K, E, R | tools.test (scanners), web, FX (scanners), LE | Works per tests (fakes) | No |
| 30 | `/unusual` | Unusual Options | pages/Unusual.tsx | /unusual | K, E | tools.test, web, LE | Works per tests (fakes) | No |
| 31 | `/order-book` | Order Book (5-level depth) | pages/OrderBook.tsx | /order-book, /order-flow | K (depth packets) | tools.test (order book), web trading-pages (Order book), LE | Works per tests (fakes); depth semantics NOT VERIFIED live. Incomplete by design: 5 levels only (docs/AUDIT.md §Known gaps 5) | No |
| 32 | `/orb` | 15-min Range Breakout | pages/Orb.tsx | /orb, /orb/:symbol, /orb/:symbol/history | R, K (1-min candles) | orb.test (server), core orb.test, web, FX (ORB), LE | Works per tests (fakes) | No |
| 33 | `/order-flow` | Order Flow (1-min) | pages/OrderFlow.tsx | /order-flow/:symbol | K, R | tools.test (order flow), web analysis-pages, FX (order flow), LE | Works per tests. **Cannot verify without live broker:** the quote-rule estimate needs per-trade SFeed granularity (DESIGN.md Status) | No (keep the "estimate" label) |
| 34 | `/algo` | Algo Strategies | pages/Algo.tsx | /algos, /algo-runs | K (live paper), R (backtests) | algo-live.test, core algo.test, web trading-pages (Algo), FX (one-day backtest), LE | Works per tests (fakes) | No |
| 35 | `/calculators` | Calculators | pages/Calculators.tsx | none (core BS, margin) | none | web trading-pages (Calculators), core.test, LE | Works per tests | No |
| 36 | `/learn` | Learn (index) | pages/Learn.tsx | none (static content) | none | LE | Works per tests (renders) | No |
| 37 | `/learn/:slug` | Learn articles | pages/Learn.tsx | none | none | LE (3 slugs) | Works per tests (renders) | No |
| 38 | `/settings` | Settings & account | pages/Settings.tsx | /auth/*, /settings | none | routes.test (settings, register/login), LE | Works per tests | Yes: account security hardening (risks R-05/R-06) |
| — | `*` | Not found | pages/NotFound.tsx | — | none | — (no dedicated test) | Not verified by a test | No |

Global UI parts:

- **Feed chip and banner** (components/FeedStatus.tsx, Layout.tsx, lib/feed.ts). Tests: web layout.test,
  ui.test (FeedDetails), lib.test (feed state), and LE "feed chip: OFFLINE with the reason". Works per tests.
- **Ticker over WebSocket** (lib/ws.ts). Tests: market-routes.test (websocket) and routes-smoke (websocket
  fan-out). Works per tests (fakes).

## B. Server capabilities

| Capability | Source files | Status (implementation) | Deps | Tests | Verification | Change? |
|---|---|---|---|---|---|---|
| Option chain (LTP, bid/ask, OI, change in OI, IV, Greeks, as-of) | services/live.ts (`buildOptionChain`), live/pricing.ts | Implemented | K, E, R | foundation, valuation-time, verify-adversarial, review-no-synthetic, routes-smoke | Works per tests (fakes) | No |
| OI / change in OI, multi-strike, OI trend | services/analytics.ts | Implemented | K, E, R | analytics, review-no-synthetic | Works per tests (fakes) | No |
| PCR, max pain | analytics.ts, core/oi.ts | Implemented | K, R, E | analytics, core.test | Works per tests | No |
| IV / IV chart / skew / surface / cone / IVP | analytics.ts, live/pricing.ts, core/vol.ts, core/bs.ts | Implemented. Black-76 on the forward; HV and cone from EOD | K, E | analytics, pricing, valuation-time, core.test | Works per tests | No |
| Greeks and pricing | core/bs.ts, core/payoff.ts, live/pricing.ts, services/pricer.ts | Implemented | K | core.test, payoff-margin, pricing, foundation (pricer) | Works per tests | No |
| Margin estimate (SPAN-style) | core/margin.ts, trading.ts | Implemented. Labelled an estimate | K | core.test (margin), payoff-margin, paper-trading (positions, funds and margin) | Works per tests. Real broker margin is NOT comparable | No |
| Strategy builder / chart | core/payoff.ts, core/strategies.ts, analytics.ts | Implemented | K, R | payoff-margin, analytics | Works per tests | No |
| Optimizer | core/optimizer.ts, analytics.ts | Implemented | K | core.test, analytics, valuation-time | Works per tests | Yes (minor): unauthenticated with no rate limit |
| Recap / backtest | analytics.ts (`recap`), algo.ts (`backtestDay/Range`) | Implemented. Replays recorded sessions only | R | analytics, algo-live | Works per tests (fakes) | Yes (minor): public backtest-range endpoint (up to 250 days) with no throttling |
| Scanners (23), unusual activity, synopsis | services/market-tools.ts | Implemented | K, E, R | tools.test | Works per tests | No |
| Order book (depth) | market-tools.ts, live-market.ts | Implemented (5 levels) | K | tools.test | Cannot verify without live broker (depth packets) | No |
| ORB | core/orb.ts, analytics.ts | Implemented | R, K | orb.test, core orb.test | Works per tests | No |
| Order flow | recorder.ts, market-tools.ts | Implemented, labelled an estimate | K, R | tools.test, recorder | Cannot verify without live broker (trade granularity) | No |
| FII/DII, participants | live/nse/fiidii.ts, participants.ts, eod.ts | Implemented. FII/DII is best-effort (unofficial endpoint) | E | nse-fiidii-holidays, nse-participants, eod, analytics | Works per tests (fixtures); live NSE NOT VERIFIED | No |
| Paper broker: orders, positions, basket, funds, reset | services/trading.ts (PaperBroker) | Implemented. **Paper only; no broker order path** (verified by grep) | K (live book) | paper-trading, routes, verify-adversarial, review-no-synthetic, LM, FX | Works per tests (fakes) | No |
| Strategies (virtual portfolio) | trading.ts (StrategyManager) | Implemented | K | paper-trading | Works per tests | No |
| Alerts and notifications | services/alerts.ts | Implemented (8 kinds) | K, R | alerts.test | Works per tests | No |
| Watchlists | services/alerts.ts (Watchlists) | Implemented | K | alerts.test | Works per tests | No |
| Algo strategies (premium ladder; Strategy 2 ₹20 and Strategy 3 ₹50 presets) | core/algo/*, services/algo.ts | Implemented. Paper only | K, R | core algo.test, algo-live | Works per tests (fakes) | No |
| Auth (guest + registered, bearer tokens) | auth.ts, app.ts | Implemented | none | routes (accounts…), routes-smoke (validation, auth and ownership) | Works per tests | **Yes**: no rate limit or lockout, unbounded guest creation, random-per-boot or weak example secret, no revocation (R-05, R-06, R-07) |
| Settings | app.ts (`PUT /api/settings`) | Implemented | none | routes.test | Works per tests | No |
| Dashboard | services/dashboard.ts | Implemented | K, E, R | routes.test (dashboard) | Works per tests | No |
| WebSocket ticks, notifications, order pushes | app.ts:562–677 | Implemented | K | market-routes, routes-smoke | Works per tests | Yes (minor): no connection cap or origin check (R-09) |
| Health report | app.ts:208, provider.ts:759–785 | Implemented | none | market-routes (health: no credentials) | Works per tests | Yes (minor): public detail disclosure (R-14) |
| Live data provider (Kotak session/TOTP, REST, scrip master, SFeed, universe, live market) | live/provider.ts, live/kotak/*, live/live-market.ts, live/universe.ts | Implemented against the documentation. DESIGN.md states it was never run against the real endpoints. | K | provider, provider-robustness, kotak-session, kotak-rest, kotak-scripmaster, kotak-ratelimit, kotak-env-totp, sfeed-client, sfeed-protocol, live-market, universe, config-env | **Cannot verify without live broker** (connectivity not attempted in this audit) | Undetermined until a supervised live session. Do not change it blindly. |
| Recorder (minutes, chain minutes) | live/recorder.ts, live/store/intraday.ts | Implemented. **No retention configured** | K | recorder, recorder-gaps-adversarial, store-intraday | Works per tests (fakes) | Yes: make retention configurable (R-12) |
| EOD jobs (NSE/BSE bhavcopy, index closes, participants, FII/DII, holidays) | live/eod.ts, live/nse/*, live/store/history.ts | Implemented | E | eod, nse-bhavcopy, nse-http, nse-indices, nse-participants, nse-fiidii-holidays, store-history | Works per tests (fixtures); real downloads NOT VERIFIED | No |
| Calendar and clock | live/calendar.ts, live/clock.ts | Implemented. Muhurat and special sessions are not modelled | E (holidays) | calendar, clock, verify-adversarial | Works per tests | No |
| Persistence (user DB) | store/db.ts | Implemented as a single JSON file | none | indirectly via the routes and paper-trading tests | Works per tests. Crash and corruption behaviour is not tested | Yes: log or alert on corrupt-file reset; fsync (R-10) |

## C. Documented functional gaps (Incomplete, from `docs/AUDIT.md` §Known gaps)

These are excluded by design and need no preservation work:

- real order execution (paper only by design)
- native store app (PWA only)
- order-book depth beyond 5 levels
- Strategy Repair, subscriptions, OTP login and video classroom
- intraday history that starts only from the first recorded session
