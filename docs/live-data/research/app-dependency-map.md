# QUANTSAPP26 — dependency map for the live-data re-architecture

Scope: read-only analysis of `/home/user/QUANTSAPP26` at commit `b3bd4cb` ("Fix Strategy 3 verification findings").
Primary source for everything below is the repository source code (file:line references are to that commit).
Statements about what Kotak Neo / NSE can supply are **not** verified here (that is other research topics) and are marked **UNCONFIRMED**.

Data categories used throughout:

| Cat | Meaning |
|---|---|
| **A** | Live snapshot: quotes, chain LTP / OI / volume / bid-ask / depth "now" (plus previous-session close values such as prevClose / prevOi that come with a snapshot) |
| **B** | Intraday time series since 09:15 today (or for a past session): minute series of spot / futures / option prices, OI, volume, depth, order flow |
| **C** | Multi-day history: daily closes, daily IV history, EOD OI, participant OI, FII/DII, past sessions' minute data |
| **D** | Pure computation or user data (no market data) |

Abbreviations: `E.` = `MarketEngine` (`apps/server/src/market/engine.ts`), `F.` = `FlowsModel` (`market/flows.ts`), `C.` = `MarketClock` (`market/clock.ts`), `An.` = `Analytics` (`services/analytics.ts`), `T.` = `MarketTools` (`services/market-tools.ts`), `Px.` = `Pricer` (`services/pricer.ts`).

---

## 0. Key findings (summary)

1. **Every market observable is produced by `MarketEngine`**: 39 public members, 1 synthetic flows model (`FlowsModel`), 1 clock with a `demo` mode. No service talks to any external source. Services address time as `(dayIdx, m)` = (index into a simulated 2024-01-01…2029-12-31 weekday calendar, fractional session minute 0…375); this coupling is pervasive (`E.parts`/`E.tsOf`/`E.days`/`E.dayIndex` appear at ~70 call sites) and must be replaced by `(date, minute)` / timestamps on a real exchange calendar.
2. **"History" is free in the simulator** because any past minute is recomputed (`E.path`, `E.oiAt`, `E.optionAt(minute)`). On live data, *every* B and C feature needs a **recorder** (tick → minute bars → EOD) plus public backfill (NSE bhavcopy / participant OI / FII-DII — UNCONFIRMED availability/format). Features that can only exist from the day recording starts: intraday OI history of strikes, minute option premiums for backtests/recap, order-flow buy/sell split, depth history.
3. **IV is an input in the simulator and an output in reality.** 20+ server sites read model IV (`E.atmIvAt`, `E.optionAt().iv`, `E.quotedIv`, `DailyBar.iv/ivPrev`) or compute Greeks from it; the browser then re-uses chain `iv` for client-side Greeks/POP/margin. A live build needs an IV solver on market premiums (core already has `impliedVol()` in `packages/core/src/bs.ts:84`, only used by the Calculators page) plus a forward/carry estimate (core has the unused `impliedCarryYield()` `bs.ts:113`; the engine instead uses a constant `inst.divYield`).
4. **Pure simulator concepts with no live equivalent**: order-flow buy/sell split (`E.minuteFlow`/`buyShare`/`bookTilt`), synthetic 5-level depth and its history, synthetic bid/ask/qty on every option quote, synthetic candle volume profile, synthetic synopsis turnover, deterministic `?at=` replay for arbitrary past timestamps, demo clock (`SIM_SPEED`, `SIM_START`, always-open session), `MARKET_SEED`, the 64-instrument universe with heuristic stock lot sizes/strike steps, and all FII/DII + participant data.
5. **Scale of live subscriptions implied by today's screens** (measured by running the current engine at 2026-10-09 11:30, script `/tmp/claude-0/-home-user-QUANTSAPP26/80c41c5a-cad1-533f-98d3-972cbc52ade6/scratchpad/live-research/app-dependency-map/scripts/count.ts`, run with the repo's `tsx`, no repo files written): 64 underlyings; `An.optionSnapshot` (scanners, unusual, synopsis) touches **2,938 option contracts** every 5 s; near-expiry full chains for all 64 = **4,048** contracts; all listed expiries = **14,968** contracts (simulated strike grids — real NSE grids will differ). Plus 64 spot + 64–192 futures tokens.
6. `packages/core` is almost entirely pure analytics and can be kept; the only simulation code in core is the seeded RNG/hash family in `math.ts` and rule-generated expiries in `dates.ts` (fine as a fallback, but listings must come from the broker's instrument master).

---

## 1. Current architecture and data flow

```
MarketClock (demo|live)  ──now()──►  all services, WS, routes
MarketEngine (procedural: daily GARCH bars, Brownian-bridge minutes, closed-form OI/volume, smile IV → BS premium)
FlowsModel(engine, seed) (synthetic FII/DII + participant OI, derived from simulated NIFTY returns)
   │
   ├─ Analytics(engine)                 one method per tool screen; caches: optionSnapshot (5 s bucket), orbScan (5 s), barsCache
   ├─ MarketTools(engine, analytics)    scanners, unusual, synopsis, order book, order flow (flowCache)
   ├─ Pricer(engine)                    price/validate any EQ/FUT/CE/PE incl. expiry settlement
   ├─ PaperBroker(engine, db, pricer)   orders/trades/positions/funds; tick() every 1 s
   ├─ StrategyManager(engine, db, pricer)
   ├─ AlertService(engine, db, pricer, strategies, notifier, now, analytics, tools); evaluate() every 3 s
   ├─ Watchlists(db, pricer, now)
   └─ AlgoService(engine, db, broker, notifier, clock, pricer); tick() every 2 s
Fastify routes (app.ts) + WS /ws (per-socket 1 s ticks of E.quote for 6 indices + ≤40 subscribed symbols)
Web (React Query polling 1–60 s, one WebSocket for ticker/clock/notifications/order events)
```

Wiring: `apps/server/src/services/index.ts:37-67`. Timers: `broker.tick` 1000 ms, `alerts.evaluate` 3000 ms, `algos.tick` 2000 ms (`index.ts:58-60`). Entrypoint `index.ts` logs `clock ${mode} … (speed ${speed}x)`.

Config (`config.ts`): `CLOCK_MODE` (default **`demo`**), `SIM_SPEED`, `SIM_START`, `MARKET_SEED`, `RISK_FREE_RATE` (0.065), `HOLIDAYS` (env list only), `AUTH_SECRET`, `DATA_DIR`, `PERSIST`, `PORT`, `HOST`, `WEB_DIST`.

Clock (`clock.ts`): `demo` = always `status:'open'`, advances at `speed`×, rolls to next trading day at 15:30 (`L66-83`). `live` = real IST wall clock; outside hours `ts` = last session close (15:30) and status `closed`/`pre-open` (09:00–09:15) (`L85-102`). Holidays only from `HOLIDAYS` env.

---

## 2. Server endpoint inventory (all routes in `apps/server/src/app.ts`)

`at(req)` (`app.ts:125-129`) = optional `?at=<epoch ms>` "as-of" timestamp (clamped to ≤ now). It is accepted by `/quotes`, `/indices`, `/expiries/:s`, `/chain/:s`, `/futures/:s`, `/candles/:s`, `/oi/strikes/:s` — this is the **deterministic replay** feature (simulator-only unless a recorder holds that minute).

| Method & path | Handler → service | Engine / flows / clock dependencies | Cat | Used by (web) |
|---|---|---|---|---|
| GET `/api/health` | `C.info()` | clock | D | Playwright readiness |
| GET `/api/meta` | inline | `E.instruments` (universe.ts), `config.riskFreeRate`, `C.info()`, **`dataSource:'simulated'`** (L139) | D/ref | all pickers (`useMeta`, staleTime 60 s) |
| GET `/api/clock` | `C.info()` | clock | D | unused |
| GET `/api/quotes?symbols&at` | `E.quote` ×≤80 | [Q] | A | unused by web |
| GET `/api/indices?at` | `E.quote` ×6 | [Q] | A | unused by web |
| GET `/api/expiries/:symbol?at` | inline | `E.expiries`, `E.futureExpiries` (rule-generated) | A/ref | `useExpiries` (staleTime 30 s) |
| GET `/api/chain/:symbol?expiry&at` | `E.chain` | [CH] | A (B/C with `at`) | `useChain`, `useStrategyView` |
| GET `/api/futures/:symbol?at` | `An.futures` | `E.futureExpiries`, `E.futurePrice` now/prev-close, `E.futureOi` now/prev, `E.futureVolume`, `E.spot` | A | unused by web |
| GET `/api/candles/:symbol?interval&days&at` | `An.candles` | `E.path`, `E.minuteWicks`, `E.bar().volume` (synthetic volume profile), `E.dayStats`, `E.spot`, `E.tsOf` | B (`D` interval → C) | Home sparkline (interval=5) |
| GET `/api/dashboard` | inline (L169-200) | [Q]×6 + per stock, [FB], `E.chain`×3, `An.orb`×3, `T.lastMinuteFlow`×3 ([MF]), `F.fiiDii`, `E.parts` | A+B+C | Home |
| GET `/api/orb?minutes&rule` | `An.orbScan` | [MB] for all 64 symbols, `E.bar` | B | ORB scan |
| GET `/api/orb/:symbol?minutes&rule&date` | `An.orb` | [ORB] | B (past date → C) | ORB, Alerts |
| GET `/api/orb/:symbol/history?days&minutes&rule` | `An.orbHistory` | [MB] for each of last N sessions (`M`=375) | C | ORB |
| GET `/api/order-flow/:symbol?type&strike&expiry&date&limit` | `T.orderFlow` | [MF], `E.futureExpiries`/`E.expiries`, `E.contract`, `E.strikes`, `E.spot`/`E.spotAt`, `E.dayIndex` | B (sim-only split) | Order Flow, Order Book, Alerts |
| GET `/api/oi/strikes/:symbol?expiry&from&at` | `An.strikeOi` | `E.expiries`, `E.contract`, `E.strikes`, `E.oiAt` now & at `from` (default prev close), `E.volumeAt`, `E.spot`; core `maxPain`, `pcr` | A (+B for `from`) | OI Analysis |
| GET `/api/oi/multi-strike/:symbol?expiry&strikes&date&interval` | `An.multiStrike` | [RD], `E.minuteMarks`, `E.strikes`, `E.bar().prevClose`, `E.oiAt(m)`, `E.optionAt(minute)` (ltp, **model iv**), `E.spotAt` | B | Multi-Strike |
| GET `/api/oi/trend/:symbol?expiry&date&interval` | `An.oiTrend` | [RD], `E.strikes`, `E.oiAt` for **every strike at every minute mark** + prev close, `E.spotAt`, `E.atmIvAt` (model), core `maxPain` | B | OI Trend |
| GET `/api/oi/pcr/:symbol?expiry&date&interval&days` | `An.oiTrend` + `An.dailyPcr` | above + for each of ≤120 past days: `E.expiries`, `E.strikes`, `E.oiAt(close)` for all strikes, `E.bar().close` | B + C | PCR |
| GET `/api/oi/max-pain/:symbol?expiry` | `An.maxPainDetail` | `An.strikeOi` + `An.oiTrend(interval 15)` | A + B | Max Pain |
| GET `/api/oi/futures` | `An.futuresBuildUp` | [FB] | A | Futures OI |
| GET `/api/oi/breadth` | `An.breadth` | [FB] + 20 days of `E.bar` (close/prevClose, **`futOi/futOiPrev`**) per stock | A + C | Breadth |
| GET `/api/participants?days` | inline | `F.participants`, `E.parts` (today's row only after 15:30, L270-276) | C (synthetic) | Participants |
| GET `/api/fii-dii?days` | inline | `F.fiiDii`, `E.parts` | C (synthetic) | FII/DII |
| GET `/api/vol/iv-chart/:symbol?expiry&date&interval&days` | `An.ivChart` | intraday: `E.spotAt`, `E.strikes`, `E.optionAt` ATM CE/PE per minute (model iv); daily: `An.ivHistory` → `E.bars()` (`DailyBar.iv`, close), `E.atmIvAt`; core `rollingHV`, `ivRank`, `ivPercentile` | B + C | IV Chart |
| GET `/api/vol/table` | `An.ivTable` | [IVT] | A + C | IV Rank & Percentile, scanners, synopsis |
| GET `/api/vol/skew/:symbol?expiries&compare` | `An.skew` | `E.expiries`, `E.spot`, `E.spotAt`, `E.contract`, `E.strikes`, `E.optionAt` CE+PE every strike now and at prev close | A (+C prev close) | Skew |
| GET `/api/vol/surface/:symbol` | `An.surface` | `E.spot`, `E.expiries` (≤8), **`E.quotedIv` at synthetic strikes K = S·(1+m%)** (17 points, not listed strikes) | A | Surface |
| GET `/api/vol/cone/:symbol` | `An.cone` | `E.bars()` 504 daily closes, `E.spot`, `E.atmIvAt`; core `volatilityCone` | C + A | Cone |
| GET `/api/straddle/:symbol?expiry&strike&mode&date&interval&width` | `An.straddle` | [RD], `E.strikes`, `E.spotAt`, forward with `E.r` & **`inst.divYield`**, `E.optionAt(minute)` CE/PE | B | Straddle |
| POST `/api/strategy-chart` `{symbol, legs, date?, interval?}` | `An.strategyChart` | [RD], `E.minuteMarks`, `E.optionAt(minute)`/`E.futurePrice(minute)`, `E.spotAt`, `bsGreeks` with **model iv** & `inst.divYield` | B | Strategy Chart |
| POST `/api/optimizer` `{symbol, expiry, targetPrice, targetDate, stopLoss?, maxLegs?, allowUnlimitedRisk?, maxCapital?, sortBy?}` | `An.optimize` | `E.chain` ([CH]), `E.inst`, `E.r`, `inst.divYield`; core `optimizeStrategies` | A + D | Optimizer |
| POST `/api/recap` `{symbol, legs, fromTs, toTs?, intervalMin?}` | `An.recap` | `E.parts`, `E.tsOf`, legPriceAt → `E.optionAt(minute)`/`E.futurePrice(minute)`/`E.spotAt` for every minute over **multiple days** until first expiry | B/C | Trade Recap |
| GET `/api/scanners` | `SCANNERS` const | — | D | Scanners |
| GET `/api/scanners/:id?limit` | `T.scanner` | per id: [FB], [Q], [IVT], [SNAP], `An.orbScan` | A/B/C | Scanners |
| GET `/api/unusual?symbol` | `T.unusual` | [SNAP] | A (+C prev IV) | Unusual |
| GET `/api/synopsis` | `T.synopsis` | [FB], [IVT], [SNAP], [Q], **`E.bar().volume × session fraction`** (turnover) | A + C | Synopsis |
| GET `/api/order-book/:symbol?type&strike&expiry` | `T.orderBook` | `E.futureExpiries`/`E.expiries`, `E.contract`, `E.strikes`, `E.futurePrice`/`E.optionAt` now + every 5-min mark, `E.futureOi`/`E.oiAt`, `E.futureVolume`/`E.volumeAt`, **`E.bookTilt`**, **`hashU` synthetic depth**, `E.symId`, `inst.liquidity` | A (+B history) | Order Book |
| POST `/api/auth/register|login|guest`, GET `/api/auth/me`, PUT `/api/settings` | `Auth`, `Db` | — | D | App boot, Settings |
| GET/POST/PUT/DELETE `/api/strategies[/:id]`, POST `/:id/exit` | `StrategyManager` | `Px.price`, `Px.validate`, `E.inst`, `E.spot` | A + D | Builder, Strategies, Alerts |
| GET `/api/broker/{funds,orders,trades,positions}`, POST `/orders`, `/basket`, `/positions/exit`, `/reset`, DELETE `/orders/:id` | `PaperBroker` | `Px.price`, `Px.validate`, `E.inst`, `E.spot`, **`E.atmIv`**, `E.r`, `inst.divYield` | A + D | Positions, OrderTicket, Builder |
| GET/POST/PATCH/DELETE `/api/alerts[/:id]`, GET `/api/notifications`, POST `/notifications/read` | `AlertService`, `Notifier` | evaluation: `E.spot`, `E.atmIv`, `E.chain().pcr`, `Px.price`, `T.lastMinuteFlow`, `An.orbConfirmed` | A + B + D | Alerts, Bell |
| GET/POST/PUT/DELETE `/api/watchlists[/:id]`, GET `/:id/quotes` | `Watchlists` | `Px.price`, `Px.validate` | A + D | Watchlist |
| GET `/api/algos`, `/api/algos/:id/defaults?symbol` | `AlgoService.catalog/defaults` | `E.instruments`, `E.inst` (lotSize, strikeStep, kind) | D/ref | Algo |
| POST `/api/algos/:id/backtest` `{params, date?}` | `AlgoService.backtestDay` | snapshot per minute 0…375: `E.contract`, `E.strikes`, `E.spotAt`, `E.optionAt(minute)` (lazy per strike), `E.expiries`, `E.days`, `E.dayIndex`, `E.parts` | B (past → C) | Algo |
| POST `/api/algos/:id/backtest-range` `{params, days≤250}` | `AlgoService.backtestRange` | `runDay` for each of ≤250 completed sessions | C | Algo |
| GET/POST `/api/algo-runs`, GET `/:id`, POST `/:id/stop`, DELETE `/:id` | `AlgoService` live | `C.info()`, `C.now()`, `E.parts`, live snapshot (`E.spot`, `E.optionAt(ts)`), `PaperBroker.place`, `Px.price` (expired) | A + D | Algo |
| WS `/ws` | inline (L468-508) | `C.info()` + `E.quote` per symbol every 1 s; notifier push; order events | A | Layout ticker/clock, toasts |

Composite dependency bundles used in the tables:

- **[Q]** `E.quote(sym, ts)` (engine.ts:778-801): `E.parts`, `E.bar().prevClose`, `E.spot` (LTP with per-second micro-noise), `E.dayStats` (path + minuteWicks + partialWick), `E.futureExpiries()[0]`, `E.futurePrice` now and at previous close, **`E.atmIvAt` (model ATM IV)** → fields `ltp, change, changePct, open, high, low, prevClose, future, futureChange, atmIv, ts`.
- **[CH]** `E.chain(sym, expiry, ts)` (L849-902): `E.expiries` (rule-generated), `E.contract`, `E.strikes` (band ±45/55 index, ±8–20 stock strikes around **previous close**), `E.spot`, `E.bar`, and per strike × {CE,PE} `E.optionQuote` (L803-847) = `E.optionAt` now + previous close (premium from **model IV**), `E.oiAt` now + previous close, `E.volumeAt`, `bsGreeks` on **model IV**, **synthetic bid/ask (spread from `inst.liquidity`) and bidQty/askQty (`hashU` per second)**, `classifyBuildUp`; then core `pcr`, `oiSupportResistance`, `maxPain`; `E.futurePrice` of near future; `carry = inst.divYield` (constant); `ivChange` = avg(CE,PE) IV now − **CE-only** IV at prev close (L870-890).
- **[FB]** `An.futuresBuildUp(ts)` (analytics.ts:461-479) → `An.futures` for all 64 underlyings: `E.futureExpiries`, `E.futurePrice` now/prev close, `E.futureOi` now/prev close, `E.futureVolume`, `E.spot` → `ltp, changePct, oi, oiChangePct, volume, buildUp, lotSize`.
- **[SNAP]** `An.optionSnapshot(ts)` (L768-812, cached per 5 s): for all 64 underlyings, nearest option expiry, strikes within ±5 % (index) / ±12 % (stock) of spot: `E.optionAt` now and prev close (ltp, **iv**), `E.oiAt` now/prev close, `E.volumeAt` → 2,938 rows.
- **[IVT]** `An.ivTable(ts)` (L548-574): for all 64: 252 days of **`DailyBar.iv`**, `E.atmIvAt` (model), **`DailyBar.ivPrev`**, 30 daily closes + `E.spot` (HV20), [Q].
- **[MB]** `An.minuteBars(sym, dayIdx, upto, liveTs)` (L180-205): `E.path` (minute closes), `E.minuteWicks` (intra-minute hi/lo), `E.partialWick` + `E.spot` (minute in progress), `E.tsOf`.
- **[ORB]** `An.orb` (L221-247): [MB] + core `evaluateOpeningRange`/`describeOrb`, `E.bar` (prevClose/open), `E.days`.
- **[MF]** `E.minuteFlow` (L739-772): volume = Δ`E.futureVolume`/Δ`E.volumeAt`, close = `E.futurePrice(minute)`/`E.optionAt(minute)`, buy share = logistic of (price move z-score, **`E.bookTilt`**, hash noise) — **fully synthetic**.
- **[PX]** `Px.price(spec, ts)` (pricer.ts:61-93): EQ → [Q] with bid/ask = ltp ± 0.05 (synthetic); FUT → `E.futurePrice` now/prev, `E.futureOi` now/prev, bid/ask = ltp ± 0.05 (synthetic); CE/PE → `E.optionQuote` (synthetic bid/ask); expired → settlement at **`E.spot(symbol, expiryTs)`**.
- **[PV]** `Px.validate(spec, ts)` (pricer.ts:45-59): `E.inst`, `E.futureExpiries`/`E.expiries`, `E.contract`, `E.strikes`, `E.parts`, `expiryTs`.
- **[RD]** `An.resolveDay(date, now)` (L94-100): `E.parts`, `E.dayIndex` (any weekday 2024-01-01…2029-12-31 is a valid past session).
- **[VIEW]** web `useStrategyView` (`apps/web/src/components/Payoff.tsx:60-141`): `GET /api/chain/:s?expiry` per distinct leg expiry (refetch 3 s, or once with `at`), `useMeta` (`riskFreeRate`, lot size); client-side core `bsGreeks` on chain `iv` (model), `analyzeStrategy(sigma = chain.atmIv)`, `payoffCurve`, `estimateMargin`, `scenarioGrid`; `ctx.carry = chain.carry` (= simulator `divYield`); **FUT leg LTP = `legTheoPrice` (theoretical S·e^{(r−q)T}), not the traded future**.

---

## 3. Per-screen dependency table (38 routes + global shell)

Routes from `apps/web/src/App.tsx:76-115`, nav from `lib/nav.ts`. Polling intervals from `useLive(…, ms)`, `useChain` (default 3000 ms, `lib/hooks.ts:17-24`), `useQuery({refetchInterval})`.

| # | Route (page file) | API calls (poll) | Server service methods | Engine / Flows / Clock deps & simulator-only concepts | Data fields needed | Cat |
|---|---|---|---|---|---|---|
| 0 | **Global shell** (`Layout.tsx`, `App.tsx`, `lib/ws.ts`) | WS `/ws` ticks every 1 s (6 indices + `useSubscribe` symbols ≤40); `GET /api/notifications` (30 s, Bell); boot: `GET /api/auth/me` or `POST /api/auth/guest`; `GET /api/meta` (staleTime 60 s) | WS handler, `Notifier.list`, `Auth` | [Q] per symbol per socket per second; `C.info()` (`mode`, `speed`, `status`); **ClockChip shows `SIM`/`LIVE` and "Simulated market" tooltip (L65-67); banner "Simulated market data…" (L224)**; universe from `buildUniverse()` | Quote `{symbol, ltp, change, changePct}` for ticker; `MarketClockInfo {ts, date, time, status, sessionMinute, mode, speed}`; `SymbolInfo {symbol, name, kind, exchange, sector, lotSize, strikeStep, expiryRule}` | A + D |
| 1 | `/` Home (`Home.tsx`) | `GET /api/dashboard` (5 s); `GET /api/candles/:idx?interval=5` ×6 (30 s); WS quotes for index cards | dashboard handler: [Q], [FB], `E.chain`×3 (NIFTY, BANKNIFTY, SENSEX), `An.orb`×3, `T.lastMinuteFlow`×3, `F.fiiDii.slice(dayIdx−5, dayIdx)`; `An.candles(sym,'5',1)` | [Q], [FB], [CH], [ORB]/[MB], **[MF] buy/sell split**, **synthetic candle volume**, **FlowsModel FII/DII**, model `atmIv` | indices Quote `{ltp, change, changePct, open, high, low, prevClose, future, futureChange, atmIv}`; movers `{symbol, ltp (spot), changePct (spot), oiChangePct (near fut), buildUp (fut price Δ vs fut OI Δ)}` top/bottom 6; `buildUpCounts` (58 stocks); chains `{expiry, spot, pcr, maxPain, atmIv, ivChange, support, resistance, daysToExpiry, orb{high, low, trend, whipsaw, reentered, summary}, flow{buyPct, delta, sentiment, ts}}`; `fiiDii[5] {date, fiiBuy, fiiSell, fiiNet, diiBuy, diiSell, diiNet, niftyClose, niftyChangePct}`; candles `{ts, open, high, low, close, volume}` 5-min since 09:15 | A + B + C |
| 2 | `/tools` (`Tools.tsx`) | none | — | — | static NAV | D |
| 3 | `/option-chain` (`OptionChain.tsx`) | `GET /api/chain/:s?expiry` (3 s); `GET /api/expiries/:s` (staleTime 30 s); `GET /api/meta`; WS subscribe [symbol]; OrderTicket `POST /api/broker/orders` | `E.chain`; `PaperBroker.place` | [CH] incl. **model IV & Greeks**, **synthetic bid/ask/bidQty/askQty**, carry = `divYield`, rule-generated expiries, strike band around prev close | header `{spot, spotChange, spotChangePct, future, futureExpiry, carry, lotSize, strikeStep, daysToExpiry, atm, atmIv, ivChange, pcr, pcrVolume, maxPain, totalCeOi, totalPeOi, totalCeOiChange, totalPeOiChange, support, resistance}`; per strike CE & PE `{ltp, change, changePct, prevClose, oi, prevOi, oiChange, oiChangePct, volume, iv, delta, gamma, theta, vega, bid, ask, bidQty, askQty, buildUp, intrinsic, timeValue}`; legs added to builder carry `iv = q.iv/100` | A |
| 4 | `/watchlist` (`Watchlist.tsx`) | `GET /api/watchlists`; `GET /api/watchlists/:id/quotes` (2 s); `PUT/POST/DELETE /api/watchlists…`; AddItem: `/api/expiries`, `/api/chain` (no refetch); OrderTicket | `Watchlists.list/create/update/remove/quotes` → [PX], [PV] | [PX] (EQ bid/ask ±0.05, option synthetic spread, expiry settlement = `E.spot` at expiry close), [PV] (strike band) | WatchQuote `{symbol, type, strike?, expiry?, label, ltp, change, changePct, oi?, oiChangePct?, iv?}` | A + D |
| 5 | `/synopsis` (`Synopsis.tsx`) | `GET /api/synopsis` (10 s) | `T.synopsis` → [FB], [IVT], [SNAP], [Q] | **turnover = `bar.volume × session fraction × ltp`** (synthetic), `DailyBar.ivPrev`, model IV, `E.bar` | SynopsisRow `{symbol, name, sector, ltp, changePct, oiChangePct (near fut), iv (ATM), ivChange (vs prev close), turnover, buildUp, pcr (snapshot strikes only)}` for 58 stocks | A + C |
| 6 | `/fii-dii` (`FiiDii.tsx`) | `GET /api/fii-dii?days=10|30|60|120` (60 s) | inline → `F.fiiDii` | **FlowsModel (AR noise on simulated NIFTY returns)**; `E.parts` "published after close" emulation | FiiDiiDay `{date, fiiBuy, fiiSell, fiiNet, diiBuy, diiSell, diiNet (₹ cr), niftyClose, niftyChangePct}` | C |
| 7 | `/participants` (`Participants.tsx`) | `GET /api/participants?days=10|30|60` (60 s) | inline → `F.participants` | **FlowsModel participant AR processes (Client = balancing item)** | ParticipantDay `{date, niftyClose, rows[4]{participant: Client|DII|FII|Pro, futIndexLong/Short, futStockLong/Short, optIndexCallLong/Short, optIndexPutLong/Short, optStockCallLong/Short, optStockPutLong/Short}}` | C |
| 8 | `/orb` (`Orb.tsx`) | `GET /api/orb/:s?date&minutes&rule` (5 s; none for past date); `GET /api/orb?minutes&rule` (10 s); `GET /api/orb/:s/history?days=20` (60 s) | `An.orb`, `An.orbScan` (all 64), `An.orbHistory` | [MB]: **`E.path` Brownian bridge, `E.minuteWicks`/`E.partialWick` micro-noise wicks**, `E.spot`, `E.bar`, `E.days`, [RD] | OrbResponse `{date, rangeStartTs, rangeEndTs, live, ltp, changePct, dayHigh, dayLow, evaluation{high, low, width, widthPct, complete, trend, whipsaw, position, reentered, pending, breaks[], crossings[], toHighPct, toLowPct}, summary, bars[{ts, open, high, low, close}] (1-min since 09:15, last may be partial)}`; scan rows for 64 symbols; history 20 sessions | B (+C) |
| 9 | `/order-flow` (`OrderFlow.tsx`) | `GET /api/order-flow/:s?type&expiry&strike&date&limit` (2 s; none past); `GET /api/chain` (30 s) | `T.orderFlow` → `completedFlow` → `E.minuteFlow` | **[MF] entirely simulator-only (bookTilt, buyShare, hash noise)**; volume deltas from closed-form `volumeAt`/`futureVolume`; **footnote "Simulated data." (L194)** | OrderFlowResponse `{instrument, type, expiry, strike, date, live, lotSize, lastMinute{buyVolume, sellVolume, volume, delta, buyPct, sentiment, ts, close}, currentMinute{…, elapsedSec}, last5, session, minutes[{ts, volume, buyVolume, sellVolume, delta, cumDelta, buyPct, close}], signal, expiries, strikes}` | B |
| 10 | `/oi/strikes` (`oi/StrikeOI.tsx`) | `GET /api/oi/strikes/:s?expiry&from` (5 s); `/expiries`, `/meta` | `An.strikeOi` | `E.oiAt` now & at `from` (prev close / since open / 60/30/15 min ago), `E.volumeAt`, `E.strikes`, `E.spot` | `{expiry, spot, fromTs, toTs, rows[{strike, ceOi, peOi, ceChange, peChange, ceVolume, peVolume}], maxPain, pcr}` | A (vs prev close) + B (since open / N min) |
| 11 | `/oi/multi-strike` (`oi/MultiStrike.tsx`) | `GET /api/oi/multi-strike/:s?expiry&strikes&interval&date` (15 s; none past); `GET /api/chain` (30 s) | `An.multiStrike` | `E.oiAt(minute)`, `E.optionAt(minute)` ltp & **model iv**, `E.spotAt`, [RD] | `{times[], spot[], series[{strike, type, oi[], ltp[], iv[]}]}` per 1/3/5/15/30-min mark since 09:15 | B |
| 12 | `/oi/trend` (`oi/OiTrend.tsx`) | `GET /api/oi/trend/:s?expiry&interval&date` (10 s; none past) | `An.oiTrend` | `E.oiAt` for **all strikes × every mark** (+ prev close), `E.spotAt`, `E.atmIvAt`, [RD] | OiTrendPoint `{ts, spot, ceOi, peOi, ceChange, peChange, pcr, maxPain, atmIv}` | B |
| 13 | `/oi/pcr` (`oi/Pcr.tsx`) | `GET /api/oi/pcr/:s?expiry&interval&date&days=60` (10 s; none past) | `An.oiTrend` + `An.dailyPcr(60)` | as #12 + EOD full-chain `E.oiAt(close)` for each of 60 past sessions (nearest expiry as of that day), `E.bar().close` | intraday `{ts, pcr, spot, ceOi, peOi}`; daily `{date, pcr, close}` | B + C |
| 14 | `/oi/max-pain` (`oi/MaxPain.tsx`) | `GET /api/oi/max-pain/:s?expiry` (15 s) | `An.maxPainDetail` → `An.strikeOi`, `An.oiTrend(15)` | as #10 + #12 | `{spot, maxPain, pain[{strike, callPain, putPain, total}], history[{ts, maxPain, spot}]}` | A + B |
| 15 | `/oi/futures` (`oi/FuturesOI.tsx`) | `GET /api/oi/futures` (10 s) | `An.futuresBuildUp` | [FB] | FuturesBuildUpRow `{symbol, name, sector, kind, ltp, changePct, oi, oiChangePct, volume, buildUp, lotSize}` ×64 | A |
| 16 | `/oi/breadth` (`oi/Breadth.tsx`) | `GET /api/oi/breadth` (15 s) | `An.breadth` | [FB] + **`DailyBar.close/prevClose/futOi/futOiPrev`** for 20 days × 58 stocks | `{overall: BuildUpCounts, sectors[{sector, counts, symbols: FuturesBuildUpRow[]}], history[{date, counts}]}` | A + C |
| 17 | `/vol/iv-chart` (`vol/IvChart.tsx`) | `GET /api/vol/iv-chart/:s?expiry&interval&date&days=60|120|250` (10 s; none past) | `An.ivChart` → `An.ivHistory` | intraday ATM CE/PE **model IV** per minute; **`DailyBar.iv`** history (≥252 + 21 days), `E.atmIvAt` | intraday `{ts, spot, ceIv, peIv, atmIv}`; daily `{date, iv, hv(20D), close}`; `ivr`, `ivp` (1Y) | B + C |
| 18 | `/vol/ivp` (`vol/IvTable.tsx`) | `GET /api/vol/table` (15 s) | `An.ivTable` | [IVT] | IvTableRow `{symbol, kind, sector, ltp, changePct, iv, ivChange, ivr, ivp, hv, ivHvSpread}` ×64 | A + C |
| 19 | `/vol/skew` (`vol/Skew.tsx`) | `GET /api/vol/skew/:s?expiries&compare=prev` (15 s); `/expiries` | `An.skew` | `E.optionAt` CE+PE every strike for ≤5 expiries now and **at previous close** (model IV) | `{spot, curves[{expiry, label, atmIv, points[{strike, moneyness, ceIv, peIv, iv(OTM side)}]}]}` | A (+C) |
| 20 | `/vol/surface` (`vol/Surface.tsx`) | `GET /api/vol/surface/:s` (20 s) | `An.surface` | **`E.quotedIv` at non-listed strikes** for ≤8 expiries | `{spot, expiries[], daysToExpiry[], moneyness[17], iv[exp][mny]}` | A |
| 21 | `/vol/cone` (`vol/Cone.tsx`) | `GET /api/vol/cone/:s` (60 s) | `An.cone` | 504 `DailyBar.close` + `E.spot`, `E.atmIvAt` | `{atmIv, rows[{window(10..120), min, p25, median, p75, max, current}]}` | C + A |
| 22 | `/builder` (`Builder.tsx`) | [VIEW] chains per leg expiry (3 s); `/expiries`; `/meta`; `POST /api/strategies`; `POST /api/broker/basket` | `E.chain`; `StrategyManager.create`; `PaperBroker.place` ×legs | [CH]; client Greeks/POP/margin on chain **model IV**; carry = `divYield`; FUT leg LTP theoretical | per leg: chain row `{ltp, iv}`, chain `{spot, ts, atmIv, carry, lotSize, future}`; user legs | A + D |
| 23 | `/templates` (`Templates.tsx`) | `GET /api/chain` for expiry e0 and e1 (10 s each); `/expiries`; `/meta` | `E.chain` | [CH]; client `buildFromTemplate`(quote = chain ltp/iv), `analyzeStrategy(sigma = atmIv)`, `payoffCurve` | chain rows `{strike, ce/pe.ltp, ce/pe.iv}`, `{spot, ts, atmIv, carry, strikeStep, lotSize, future, futureExpiry}` | A + D |
| 24 | `/optimizer` (`Optimizer.tsx`) | `GET /api/chain` (15 s); `POST /api/optimizer` (on click); Detail [VIEW] (3 s) | `An.optimize` | [CH] (per-strike price & **model iv**), `inst.divYield`, `E.r` | request fields; response `{scanned, results[OptimizerCandidate{name, legs, targetPnl, stopPnl, maxProfit, maxLoss, rewardRisk, pop, margin, netPremium}], expiry, spot, tookMs, targetTs}` | A + D |
| 25 | `/straddle` (`Straddle.tsx`) | `GET /api/straddle/:s?expiry&mode&strike&width&interval&date` (5 s; none past); `GET /api/chain` (30 s) | `An.straddle` | `E.optionAt(minute)` for the **rolling ATM strike at each minute** (strike changes), forward via `divYield`, model IV | StraddlePoint `{ts, spot, strike, ce, pe, straddle, iv}` | B |
| 26 | `/strategy-chart` (`StrategyChart.tsx`) | `POST /api/strategy-chart` (10 s for today; none past) | `An.strategyChart` | `E.optionAt(minute)`/`E.futurePrice(minute)`, `E.spotAt`, `bsGreeks` on **model IV**, `divYield` | StrategyChartPoint `{ts, spot, premium, pnl, delta, gamma, theta, vega}` | B |
| 27 | `/recap` (`Recap.tsx`) | `GET /api/chain/:s?expiry&at=<past ts>` (no refetch); [VIEW] with `at`; `POST /api/recap` | `E.chain(ts past)`, `An.recap` | **deterministic as-of chain at any past minute**; multi-day minute replay until first expiry; model IV | as-of OptionChain (as #3); RecapResponse `{points[{ts, spot, pnl, legLtp[]}], maxPnl, minPnl, finalPnl, endTs, expired}` | B + C |
| 28 | `/positions` (`Positions.tsx`) | `GET /api/broker/positions` (3 s), `/orders` (5 s), `/trades` (10 s), `/funds` (5 s); `POST /orders`, `/positions/exit`, `/reset`, `DELETE /orders/:id`; NewOrder: `/expiries`, `/chain` (10 s) | `PaperBroker.*`, `E.chain` | [PX] (synthetic bid/ask fills, settlement), [PV], `E.spot`, **`E.atmIv` margin**, `divYield`; subtitle "real-time simulated fills" (L76) | Position `{key, instrument, symbol, type, strike, expiry, product, netQty, lotSize, avgPrice, buyQty, sellQty, buyValue, sellValue, ltp, realized, unrealized, pnl, status}`; Order; Trade; Funds `{openingBalance, available, usedMargin, realizedPnl, unrealizedPnl, premiumPaid, premiumReceived}` | A + D |
| 29 | `/strategies` (`Strategies.tsx`) | `GET /api/strategies` (3 s); `PUT /strategies/:id`, `POST /:id/exit`, `DELETE`; Detail [VIEW] (3 s) | `StrategyManager.list/get/update/exit/remove` | [PX] per leg (ltp, expired settlement), `E.spot`, [CH] client-side | SavedStrategy + `live{mtm, realized, spot, legsLtp[], ts}` | A + D |
| 30 | `/alerts` (`Alerts.tsx`) | `GET /api/alerts` (5 s), `/notifications` (10 s), `/strategies` (once); `POST/PATCH/DELETE /alerts`; `/expiries`; `/chain` (10 s); `/orb/:s?minutes` (10 s, ORB kind); `/order-flow/:s?type=FUT&limit=1` (5 s, ORDER_FLOW kind) | `AlertService.create/list/setStatus/remove/evaluate` (3 s timer) | PRICE → `E.spot`; IV → **`E.atmIv` (model)**; PCR → `E.chain().pcr` (full chain each eval); OPTION_PRICE/OI_CHANGE → [PX]; MTM → `StrategyManager.get`; **ORDER_FLOW → `T.lastMinuteFlow` ([MF], sim-only)**; ORB_BREAK → `An.orbConfirmed` ([MB]) | AlertDef `{kind, symbol, condition, value, optionType?, strike?, expiry?, strategyId?, note?, status, createdAt, armedAt, triggeredAt?, triggeredValue?}`; current value preview from chain/orb/flow | A + B + D |
| 31 | `/algo` (`Algo.tsx`) | `GET /api/algos` (staleTime 300 s); `GET /api/algos/:id/defaults?symbol`; `POST /api/algos/:id/backtest` (15 s for today; none past); `POST /backtest-range` (staleTime 60 s); `GET /api/algo-runs` (3 s); `POST /algo-runs`, `/:id/stop`, `DELETE /:id` | `AlgoService.catalog/defaults/backtestDay/backtestRange/create/stop/remove/list/tick` | snapshot `premium(type, strike)` for **any listed strike at any past minute** (`E.optionAt(minute)`), `E.spotAt`, `E.strikes`, `E.expiries`, `E.days`; live: `C.info().status==='open'`, `E.parts`, `PaperBroker.place` MARKET MIS; texts "replay on the simulated history" (L308), "Simulated data" (L527) | AlgoBacktestDay `{date, expiry, entered, pnl, charges, net, adjustments, maxLevel, orders, maxProfit, maxLoss, exitKind, exitReason, exitTs, partial, series[{ts, spot, mtm, level, ceStrike, ce, peStrike, pe}], events[]}`; AlgoBacktestRange `{days[], equity[], stats{…}}`; AlgoRunView `{status, today{phase, status[], legs[{…, ltp, pnl}], realized, unrealized, charges, mtm, series, events}, history[], totalNet}` | A (live) + B/C (backtests) + D |
| 32 | `/scanners` (`Scanners.tsx`) | `GET /api/scanners` (once); `GET /api/scanners/:id?limit=40` (10 s) | `T.scanner` | build-up/OI ids → [FB]; price ids → [FB]+[Q]; IV ids → [IVT] (`DailyBar.iv`); option ids → [SNAP] (model iv, prev iv); `orb-*` → `An.orbScan` ([MB] ×64) | ScannerRow `{symbol, instrument, type, strike?, expiry?, ltp, changePct, oi, oiChangePct, volume, iv?, ivChange?, ivp?, buildUp?, metric, metricLabel}` | A + B + C |
| 33 | `/unusual` (`Unusual.tsx`) | `GET /api/unusual?symbol` (10 s) | `T.unusual` | [SNAP] (prev close LTP, OI, **model IV now/prev**) | UnusualActivityRow `{symbol, type, strike, expiry, ltp, changePct, oi, oiChange, oiChangePct, volume, volumeOiRatio, iv, ivChange, premiumTurnover, score, signal, buildUp}` | A |
| 34 | `/order-book` (`OrderBook.tsx`) | `GET /api/order-book/:s?type&expiry&strike` (**1 s**); `GET /api/order-flow/…&limit=5` (2 s); `GET /api/chain` (30 s); OrderTicket | `T.orderBook`, `T.orderFlow` | **synthetic 5-level depth (`hashU`, `inst.liquidity`, `E.bookTilt`), synthetic totalBid/AskQty (×8–12 of top-5), synthetic lastTradeQty, circuits = prevClose ±10 % (FUT) / ±40 % (opt), VWAP from 5-min marks with U-weights, depth history from `bookTilt`** | OrderBookResponse `{instrument, ltp, change, changePct, open, high, low, prevClose, vwap, volume, oi, bids[5]{price, qty, orders}, asks[5], totalBidQty, totalAskQty, spread, spreadPct, imbalance, lastTradeQty, upperCircuit, lowerCircuit, history[{ts, ltp, bidQty, askQty, ratio, spread, vwap}], analytics[18]{label, value, tone?, hint?}}` | A (+B history) |
| 35 | `/calculators` (`Calculators.tsx`) | none | — | none (core `bsGreeks`, `impliedVol`, `probAbove`, charges) | user inputs | D |
| 36 | `/learn`, `/learn/:slug` (`Learn.tsx`) | none | — | none (text; L122 recommends replaying past sessions in Trade Recap) | static | D |
| 37 | `/settings` (`Settings.tsx`) | `POST /api/auth/register|login`, `PUT /api/settings`; WS clock | `Auth`, `Db` | **"About the data" text (L117) describes the deterministic simulator; clock text "simulated session (N× speed)" (L119); "Paper trades use simulated fills" (L120)** | UserProfile/UserSettings `{theme, defaultSymbol, strikesAround, showGreeks, oiUnit, riskFreeRate}` | D |
| 38 | `*` NotFound (`NotFound.tsx`) | none | — | — | — | D |

Totals: 38 route rows (+1 global shell). D-only routes: 5 (`/tools`, `/calculators`, `/learn`, `/settings`, `*`). A is needed by 31 routes (all except the 5 D-only routes and the two C-only routes `/fii-dii`, `/participants`); B by 16 routes; C by 14 routes.

---

## 4. MarketEngine / FlowsModel / MarketClock API → callers → live replacement

| Engine member (engine.ts line) | What it simulates | Callers (file:line) | Live replacement |
|---|---|---|---|
| `instruments`, `inst(sym)` (L141, L261) | 64-instrument universe from `universe.ts` with sim params | alerts:81, algo:101,121,246,515,518, analytics:294,663,738, market-tools:207,376, pricer:47,63, trading:85,153,185,308, app:142,309,333,496 | `ReferenceData.underlyings()/underlying()` built from broker instrument master (lot size, tick, strikes, expiries) + static sector map |
| `days`, `dayIndex` (L139-140), `parts(ts)` (L280), `tsOf(dayIdx,m)` (L304) | Weekday calendar 2024–2029; ts → (dayIdx, minute) with outside-hours → previous close | ~60 sites in algo, analytics, market-tools, pricer, app, tests | `TradingCalendar` (real holiday list) + `SessionClock.sessionOf(ts) → {date, minute, status}`; replace dayIdx with ISO date |
| `bars(sym)`, `bar(sym, dayIdx)` (L267-273) → `DailyBar{open, close, prevClose, iv, ivPrev, gap, futOi, futOiPrev, volume, h}` | GARCH daily series | analytics:117,128,229,262,383,449,499,518,552,621; market-tools:197,458; flows:46 | `HistoryStore.dailyBars` (spot OHLC), `dailyFutures` (aggregate fut OI), `dailyAtmIv` (solver on EOD option closes); prevClose from live quote |
| `path`, `spotAt` (L322-357) | Brownian-bridge minute path | analytics:126,182; spotAt: algo:158, analytics:401,421,536,585,635,637,654, market-tools:404 | `IntradayStore.bars(spotKey, date)` minute closes (recorder) |
| `spot(sym, ts)` (L370) | LTP with per-second micro-noise | alerts:156, algo:158, analytics:118,152,198,230,366,449,557,581,605,622,778, market-tools:229,404, pricer:73, trading:155,361 | `LiveMarket.quote(spotKey).ltp` (now); `IntradayStore.valueAt` (past) |
| `minuteWicks`, `partialWick`, `dayStats` (L409-448) | intra-minute hi/lo from noise | analytics:116,127,186,199 | recorder minute high/low from ticks; live day OHLC from quote |
| `atmIvAt`, `atmIv` (L455-471) | model ATM IV (regime + leverage + wiggle) | alerts:159, trading:156, analytics:428,524,554,623, market-tools:459, engine quote L798 | `Pricing.atmIv(sym, expiry, ts)` = solver on ATM CE/PE market premiums (live) / recorder minute ATM IV (past) |
| `expiries`, `futureExpiries` (L477-495) | rule-generated weekly/monthly/quarterly | algo:137, analytics:103,153,441,578,606,776, market-tools:217,225,360,393,397, pricer:51,54, app:157 | `ReferenceData.expiries(sym, 'OPT'|'FUT', date?)` from instrument master (and recorded/bhavcopy listings for past dates) |
| `contract(sym, exp)` → `ContractCtx` (L497) | expiry index etc. | algo:146, analytics:345,378,407,442,533,584,609,631,656,777, market-tools:227,400, pricer:55,90 | `ReferenceData.listing(key)` (token, segment, trading symbol, lot) |
| `strikes(ctx, dayIdx)` (L512) | band around prev close | algo:147, analytics:348,383,409,445,537,586,633,779, market-tools:228,401, pricer:56 | `ReferenceData.strikes(sym, expiry, date?)` (all listed strikes) |
| `contractId`, `symId` (L275, L532) | hashing ids | market-tools:248 (`symId` for synthetic depth) | delete (use instrument token) |
| `oiAt(ctx, type, K, dayIdx, m)` (L574) | closed-form OI | analytics:350-357,393,411-416,446-447,785-786, market-tools:234 | live `quote.oi`; previous close `quote.prevOi` or EOD store; intraday `IntradayStore` minute `oi` |
| `volumeAt` (L593) | cumulative volume | analytics:358-359,802, market-tools:235 | live `quote.volume` (cumulative); recorder Δvolume per minute |
| `optionIv`, `tradingYears`, `quotedIv` (L613-647) | smile/term model, trading-time variance | analytics:612 (`quotedIv` for surface) | `Pricing.iv(...)` per listed strike + `Pricing.smile()` interpolation for the surface |
| `optionAt(ctx, type, K, ts, {minute})` (L650) → `{ltp, iv, spot, T}` | BS premium from model IV | algo:167, analytics:394,538-539,587-588,643-644,657,783-784, market-tools:232-233, engine:765,805,807,870 | live `quote.ltp` / recorder minute close; iv via solver |
| `futurePrice` (L664), `futureOi` (L674), `futureVolume` (L690) | carry × hash basis; OI share model; volume model | analytics:154-157,167,654, market-tools:219-222, pricer:81-84 | live futures quote `{ltp, prevClose, oi, prevOi, volume}`; recorder minutes |
| `bookTilt` (L711), `buyShare`/`minuteSigma` (private), `minuteFlow` (L739) | order-book pressure & aggressive buy/sell split | market-tools:246,269,346,361,415 | **no equivalent**; replace with recorder tick classification (trade vs prevailing bid/ask) and/or `totalBuyQty/totalSellQty` imbalance — feasibility depends on feed granularity (UNCONFIRMED) |
| `quote(sym, ts)` (L778) | composite underlying quote | analytics:559, market-tools:97,193, pricer:66, app:150,153,171,173,479 | composite of live spot quote + near future quote + `Pricing.atmIv` |
| `optionQuote` (L803) | composite option quote w/ synthetic bid/ask/qty | pricer:91, engine chain | live option quote (`bid, ask, bidQty, askQty` from depth level 1) + solver IV/Greeks |
| `chain` (L849) | full chain + aggregates | alerts:162, analytics:739, app:160,178 | `LiveMarket.chain()` + core `pcr/maxPain/oiSupportResistance` + solver |
| `minuteMarks` (L905) | helper | analytics:380,415,535,636,664, market-tools:261 | keep (pure helper; move to core or analytics) |
| `r` (L142) | risk-free rate | analytics:639,680,756, trading:157 | keep (`config.riskFreeRate`) |
| `inst.divYield` (universe.ts) | constant carry | analytics:639,680,756, trading:157, engine:615,656,671,812,884 | `Pricing.forward(sym, expiry)` → implied carry from same-expiry future or put-call parity |
| `inst.liquidity` | spread/qty scale | market-tools:242,245, engine:814,821 | delete (use real depth) |
| `FlowsModel.fiiDii`, `.participants` | synthetic institutional flows | app:188,275,282 | `HistoryStore.fiiDii()`, `participantOi()` (NSE public data — UNCONFIRMED source/format) |
| `MarketClock.info/now/mode/holidays` | demo/live clock | services/index.ts:46, app.ts:123,135,141,145,191,206,475,479, algo:357,374,381,447,508 | `SessionClock` (live only), holidays from exchange calendar |

`MarketTools.ivp()` (market-tools.ts:455-460) is dead code (no callers).

---

## 5. Every place IV / Greeks come from model IV instead of market premiums

Server (model IV is an *input*; premium is derived from it):

| Location | What it does | Feeds |
|---|---|---|
| engine.ts:455-471 `atmIvAt` / `atmIv` | model ATM IV (regime, leverage, wiggle) | everything below |
| engine.ts:613-628 `optionIv` (smile `1 + skew·x + smile·x²` + hash wave/jitter) and 641-647 `quotedIv` (trading-time → calendar IV) | per-strike model IV | `optionAt`, surface |
| engine.ts:650-658 `optionAt` | premium = BS(model IV); returns `iv` | all series below |
| engine.ts:798 `quote().atmIv` | model ATM IV on every Quote | WS ticker, Home index cards ("IV x"), `/quotes`, `/indices`, `Px.price` EQ `iv` (Watchlist) |
| engine.ts:812-838 `optionQuote` | `iv`, `delta`, `gamma`, `theta`, `vega` from `bsGreeks(model IV)` | Option Chain, Watchlist, Pricer, Optimizer |
| engine.ts:870-890 `chain().atmIv/ivChange` | avg CE/PE model IV; change vs CE prev-close model IV | Option Chain header, Home derivatives snapshot, Alerts preview, client `defaultIv`/`sigma` |
| engine.ts:884 `chain().carry = inst.divYield` | constant carry | client [VIEW], Templates |
| analytics.ts:394-396 `multiStrike` iv series | model | Multi-Strike IV metric |
| analytics.ts:428 `oiTrend` `atmIv` | model | OiTrendPoint (not rendered) |
| analytics.ts:515-528 `ivHistory` | `DailyBar.iv` history + `atmIvAt` today | IV Chart daily, IVR/IVP |
| analytics.ts:536-545 `ivChart` intraday ce/pe/atm IV | model | IV Chart intraday |
| analytics.ts:548-574 `ivTable` | `DailyBar.iv` 252-day history, `atmIvAt`, `ivPrev` | IV table, IV scanners, Synopsis |
| analytics.ts:585-593 `skew` | model ceIv/peIv now & prev close | Skew |
| analytics.ts:612 `surface` | `quotedIv` at synthetic strikes | Surface |
| analytics.ts:623 `cone` `atmIv` | model | Cone |
| analytics.ts:639-645 `straddle` | forward via `divYield`; `iv` model | Straddle "Avg IV" |
| analytics.ts:680 `strategyChart` | `bsGreeks(q.iv model, divYield)` | Strategy Chart Greeks |
| analytics.ts:748-756 `optimize` | per-strike `iv` from chain (model), `defaultIv = atmIv`, `carry = divYield` | Optimizer valuation, POP, margin |
| analytics.ts:803-804 `optionSnapshot` `iv`, `prevIv` | model now / prev close | Scanners (IV, IV chg), Unusual (IV chg score), Synopsis PCR rows |
| market-tools.ts:458-459 `ivp` | `DailyBar.iv` | dead code |
| alerts.ts:159 IV alert | `atmIv` model | Alerts |
| trading.ts:156-157 `fundsFor` margin | `atmIv` model as every leg's IV, `divYield` carry | Funds, order margin checks (rejections) |

Client (re-uses server model IV):

| Location | Use |
|---|---|
| `components/Payoff.tsx:84-106` | `atmIv = chain.atmIv`; `marketIv = chain row iv`; `bsGreeks(…, marketIv + shift, chain.carry)`; `ctx.defaultIv = atmIv` |
| `Payoff.tsx:92` | FUT leg LTP = `legTheoPrice` (theoretical future) |
| `Payoff.tsx:127,134,148` | `analyzeStrategy(sigma=atmIv)`, `estimateMargin(ctx)`, ±1σ band from atmIv |
| `pages/OptionChain.tsx:64,189` | builder legs store `iv: quote.iv/100` |
| `pages/Builder.tsx:69-80,241` | new legs `iv` from chain; table shows `marketIv` |
| `pages/Templates.tsx:56,85,99` | template legs `iv`, `defaultIv`, `sigma` from chain |
| `pages/Recap.tsx:55,71,117` | legs `iv` from as-of chain |
| `pages/Alerts.tsx:61` | IV alert preview = `chain.atmIv` |
| `pages/Home.tsx:66,183`, `Synopsis.tsx`, `Scanners.tsx:58`, `Watchlist.tsx:101`, `Straddle.tsx:91`, `vol/*` | display of server IV |

What a live build needs: `impliedVol(type, premium, S_or_F, K, T, r, q)` (`packages/core/src/bs.ts:84`, returns NaN outside no-arbitrage bounds) applied to a chosen premium (mid when bid/ask valid and spread tight, else LTP — policy decision), with S·e^{(r−q)T} = forward from the same-expiry future (`impliedCarryYield`, `bs.ts:113`) or ATM put-call parity (weekly index expiries have no same-expiry future — in the current universe futures are monthly). Greeks then from `bsGreeks` on solved IV; illiquid strikes need a fitted smile (for surface and Greeks), and the UI must tolerate NaN IV ("—").

---

## 6. Simulator-only features (must be removed or re-founded on real data)

### 6.1 Server code
| Item | Location | Notes |
|---|---|---|
| Whole procedural engine | `apps/server/src/market/engine.ts` (912 lines) | constants `SIM_START_DATE='2024-01-01'`, `SIM_END_DATE='2029-12-31'`, `ANCHOR_DATE` (L44-46); GARCH daily series (L178-255); `U_PROFILE` (L89-99); Brownian-bridge paths (L322-348); per-second micro-noise LTP (L363-376); wicks (L379-448); model IV (L455-471, L613-647); rule expiries (L477-495); strike band (L512-530); closed-form OI with "heavy writing events" (L540-590); volume model (L593-607); futures basis noise/OI share/volume (L664-701); **`bookTilt`** (L711-713); **`buyShare`/`minuteFlow` order-flow split** (L729-772); **synthetic bid/ask/bidQty/askQty** (L814-821, L841-842) |
| Universe with sim parameters | `market/universe.ts` | `basePrice, vol, baseIv, beta, sectorLoad, divYield, peakOi, futOi, skew, smile, liquidity`; **stock lot sizes from `lotSizeFor(price)` (₹7.5 L notional heuristic) and strike steps from `strikeStepFor(price)` — not exchange values**; index lot sizes/expiry rules hard-coded; only 58 stocks |
| Institutional flows | `market/flows.ts` | FII/DII cash flows = 120 000·r + noise; participant OI = AR(1) with Client balancing |
| Hash RNG | `market/hash.ts` `hashInts/hashU/hashN` | `Lru` is generic and reusable |
| Demo clock | `market/clock.ts:66-83`; `ClockOptions.speed/start` | always open, `speed`×, rolls over at 15:30 |
| Config | `config.ts`: `clockMode` default `'demo'`, `SIM_SPEED`, `SIM_START`, `MARKET_SEED`; `.env.example` lines `CLOCK_MODE=demo`, `SIM_SPEED=1`, `# SIM_START`, `MARKET_SEED=q26` | |
| Meta flag | `app.ts:139` `dataSource: 'simulated'`; type `MetaResponse.dataSource: 'simulated'|'live'` (`core/api.ts:35`); `MarketClockInfo.mode: 'demo'|'live'`, `speed` (`api.ts:18-19`) | |
| Deterministic "as-of" replay | `app.ts:125-129` `?at=` on 7 routes; `An.resolveDay` any sim weekday; `An.recap`; `An.dailyPcr`; `An.orbHistory`; `An.breadth` history; `AlgoService.backtestDay/backtestRange`; past `date` on ORB / order-flow / multi-strike / OI trend / PCR / IV chart / straddle / strategy-chart | only possible for recorded sessions on live data |
| "Published after close" emulation | `app.ts:270-283` | live: show what the source has published |
| Synthetic volume shapes | `analytics.ts:118` (daily candle volume = `bar.volume × f`), `analytics.ts:141` (intraday candle volume = `bar.volume × U-weights`) | |
| Breadth history from `DailyBar.futOi` | `analytics.ts:495-503` | |
| IV history from `DailyBar.iv/ivPrev` | `analytics.ts:515-574`, `market-tools.ts:458` | |
| Surface at non-listed strikes | `analytics.ts:602-616` | |
| Synopsis turnover | `market-tools.ts:200` `bar.volume × p.f × ltp` | |
| Synthetic order book | `market-tools.ts:238-308` (spread via `liquidity`, `baseQty`, `hashU` level qty/orders, `bookTilt`, totals ×8–12, VWAP from 5-min marks, `lastTradeQty`, circuits ±10 %/±40 %), depth history (L261-273) | |
| Order flow | `market-tools.ts:340-452` (`completedFlow`, `lastMinuteFlow`, `orderFlow`) on `E.minuteFlow` | |
| Pricer synthetic spreads & settlement | `pricer.ts:67` EQ bid/ask ±0.05; `pricer.ts:86` FUT bid/ask ±0.05; `pricer.ts:71-77` settlement = simulated spot at 15:30 on expiry | real settlement price differs (UNCONFIRMED source); NSE stock F&O is physically settled (UNCONFIRMED here) |
| Algo doc | `algo.ts:2` "backtests on the simulated history" | |
| Server log | `index.ts:20` `clock ${mode} … (speed ${speed}x)` | |

### 6.2 `packages/core`
- `math.ts`: `hash32`, `mulberry32`, `Rng` (incl. `fatNormal`), `hashUniform`, `hashNormal` — used only by `engine.ts`, `flows.ts` and one test fixture (`core/test/core.test.ts:240` `new Rng(7)` random walk for the HV test). Normal CDF/PDF/percentile/stats are pure and stay.
- `dates.ts`: `generateExpiries`, `isMonthlyExpiry`, `monthlyExpiry` — rule-based expiry calendar (weekly Tue NIFTY / Thu SENSEX, monthly last Tue/Thu). Keep only as a fallback/validator; live listings must come from the instrument master.
- `api.ts`: `MetaResponse.dataSource`, `MarketClockInfo.mode/speed`; `OptionChain.carry` documented as "implied by this expiry's synthetic forward" but filled with a constant.

### 6.3 UI text / docs that state or assume simulation
| File:line | Text |
|---|---|
| `apps/web/src/components/Layout.tsx:65` | tooltip `'Simulated market'` when `clock.mode === 'demo'` |
| `Layout.tsx:67` | chip `SIM` / `LIVE` |
| `Layout.tsx:224` | banner "Simulated market data for analysis & paper trading — not live exchange prices and not investment advice." |
| `components/OrderTicket.tsx:120` | "Paper trading on simulated prices. No real money is involved." |
| `pages/OrderFlow.tsx:194` | "… Indices are measured on their futures. Simulated data." |
| `pages/Algo.tsx:308` | "Minute-by-minute replay on the simulated history; fills at the minute's last price." |
| `pages/Algo.tsx:527` | "… Simulated data; not investment advice." |
| `pages/Positions.tsx:76` | subtitle "… virtual ₹10 lakh capital, real-time simulated fills, SPAN-style margin" |
| `pages/Settings.tsx:117` | "Market data is produced by a deterministic simulator … not live exchange data …" |
| `pages/Settings.tsx:119` | "simulated session (N× speed)" vs "real IST clock" |
| `pages/Settings.tsx:120` | "Paper trades use simulated fills at the bid/ask." |
| `pages/Recap.tsx` subtitle, `pages/Learn.tsx:122` | promise replay of "any past date & time" |
| `README.md:8-9` | "Market data is simulated …" |
| `README.md:87` | "deterministic market engine, clock, …" |
| `README.md:94-118` | "How the simulated market works" section |
| `README.md:124-127` | config rows `CLOCK_MODE`, `SIM_SPEED`, `SIM_START`, `MARKET_SEED` |
| `README.md:134-136` | "Upgrading: simulator calibration changes …" |
| `README.md:168` | "Simulated data; paper trading only" |
| `docs/AUDIT.md:12, 51, 57, 65, 69, 75-79, 90-97` | rows "#23 on simulated history", "#29 simulated depth", "#42 simulated trades", "#38 Live exchange data ✗", gap 1 (live data), "Calibration notes (simulator)" |
| `apps/web/playwright.config.ts` | `env: { …, SIM_START: '2026-10-09T11:30' }` |

---

## 7. Paper broker (`services/trading.ts`) dependencies on engine prices

`PaperBroker(engine, db, pricer, now, notify, emitOrder)`; `StrategyManager(engine, db, pricer, now)`.

| Function | Market data used | Live requirement |
|---|---|---|
| `place()` L177-202 | `Px.validate` → `E.inst`, `E.futureExpiries`/`E.expiries`, `E.contract`, `E.strikes(ctx, dayIdx)` (sim band), `E.parts`, `expiryTs`; `E.inst().lotSize` | instrument master listing check; real lot size |
| `process()` L205-239 (on place + every 1 s via `tick()` for **all users' OPEN/TRIGGER_PENDING orders**) | `Px.price` → `ltp`, `bid`, `ask`, `expired`. MARKET/SL-M fill at `ask` (BUY) / `bid` (SELL); LIMIT fills when market price crosses; SL triggers on `ltp`; `fundsFor()` before/after → margin check | real best bid/ask (depth level 1) for every contract with a working order, refreshed ≤1 s → subscription with depth/quote mode for those tokens |
| `toPositions()` L83-122 (every positions/funds request) | `E.inst().lotSize`; `Px.price().ltp` for MTM; `px.expired` → settle at `E.spot(symbol, expiryTs)` (underlying 15:30 price) | live LTP per open position; real final settlement price (UNCONFIRMED source; NSE publishes it — see NSE research) |
| `fundsFor()` L128-170 | `E.inst()` kind; **`E.spot`**; **`E.atmIv` (model) as IV of every leg**; `E.r`; **`inst.divYield`**; core `estimateMargin` (SPAN-like estimate, `INDEX_MARGIN`/`STOCK_MARGIN`) | spot + solved ATM IV + implied carry; optionally broker margin API (UNCONFIRMED) |
| `exitPosition()` | `positions()` then `place()` MARKET | as above |
| `StrategyManager.normaliseLegs()` L307-336 | `Px.validate`, `Px.price().ltp` when no entry price | live LTP |
| `StrategyManager.withLive()` L338-362 | `Px.price` per leg (ltp, expired → auto-exit at settlement), `E.spot` | live LTP per leg, settlement |
| `StrategyManager.exit()` L410-423 | `Px.price().ltp` as exit price | live LTP (or bid/ask) |

Consumers: `/api/broker/*`, Builder basket, OrderTicket (chain, watchlist, order book, positions), AlgoService live fills, AlertService MTM.

---

## 8. Algo service (`services/algo.ts`) dependencies

`AlgoService(engine, db, broker, notifier, clock, pricer)`; the algos themselves (`packages/core/src/algo/premium-ladder.ts`) are pure state machines over `AlgoSnapshot {ts, minuteOfDay, date, symbol, spot, expiry, lotSize, strikes[], premium(type, strike) → number|null}`. `selectStrike` (premium-ladder.ts:102-129) scans **every listed strike** (multiples of `strikeMultiple`, OTM) and calls `premium()` on each → the snapshot must price the whole chain of the run's expiry.

| Function | Engine/clock deps | Live data need |
|---|---|---|
| `catalog()` L97-106 | `E.instruments`, `E.inst()` lotSize/strikeStep/kind for 6 indices | reference data |
| `params()` L119-134 | `E.inst()` strikeStep, kind for defaults | reference data |
| `pickExpiry()` L136-141 | `E.expiries(symbol, ts)[0|1]` | listings (as of the session date for backtests) |
| `snapshot()` L144-173 | `E.contract`, `E.strikes(ctx, dayIdx)`, `E.tsOf`, `E.parts`, `E.days`, `E.spotAt`/`E.spot`, `E.optionAt(ctx, type, K, ts, {minute})` lazily per strike | live: chain quotes for the expiry (A). backtest: **minute close of every strike of that expiry for every minute 09:15–15:30** (B/C) |
| `runDay()` L217-249 | loop m = 0…`last` (≤375) calling `snapshot`; `E.tsOf`, `E.inst`, `E.days` | recorder data for that date |
| `backtestDay()` L251-266 | `E.parts`, `E.dayIndex` (any past sim day); today → partial up to now | recorded sessions only; today requires recording since 09:15 |
| `backtestRange()` L268-315 | up to 250 completed sessions × 376 snapshots | will be limited to recorded sessions (or a historical option minute source — UNCONFIRMED whether Kotak offers historical intraday option candles) |
| `tick()` / `tickRun()` L396-500 (every 2 s) | `C.info()` (`status === 'open'`, `ts`), `E.parts` (date, minute), live snapshot, `algo.step` with `liveFill` → `PaperBroker.place` MARKET MIS (fills at Pricer ask/bid); day roll-over squares off missed exits (expired → `Px.price` settlement) | live chain quotes ≤2 s old for the expiry; real session status (holidays); settlement |
| `stop()` L368-384, `view()` L502-551 (every 3 s per GET) | `C.now()`, `E.parts`, live snapshot for open legs, `E.inst` lot size | live quotes for open legs |

---

## 9. Tests that rely on deterministic simulated values

All three server suites build services with `loadConfig({ persist:false, simStart, clockMode:'demo' })` and a frozen or movable wall clock (`createServices(…, { now })`), i.e. they depend on the demo clock + engine.

**`apps/server/test/server.test.ts`** (`simStart '2026-10-09T11:30'`, frozen):
- `reports clock and meta` — clock date `2026-10-09`, time `11:30`; NIFTY lot 65; >50 symbols.
- `builds a consistent option chain` — nearest expiry `'2026-10-13'`; >60 rows; |atm−spot| ≤ 25; PCR ∈ (0.3, 3); atmIv > 5; every ltp ≥ 0.05; delta signs; monotonic premiums and non-negative butterflies (model is arbitrage-free; real quotes can violate within a tick).
- `is deterministic for a given seed` — two engines produce identical `E.chain('BANKNIFTY', …, sessionTs('2026-10-08', 200))`.
- `keeps OI continuous across the overnight boundary` — `E.oiAt` internals (`E.dayIndex`, `E.contract`).
- `serves every analytics endpoint` — 30 URLs + every scanner return 200 (needs data for all of them).
- `participant longs and shorts balance` — FlowsModel property.
- `optimizer ranks …` — `chain.expiries[2]`, `scanned > 10 000`, ≥6 results.
- `replays a strategy through history (trade recap)` — as-of chain at `sessionTs('2026-10-05', 30)` with expiry `'2026-10-06'`, recap expired, >100 points.
- `charts a strategy premium through the day` — >20 points, first pnl 0.
- `fills, rejects and exits paper orders with margin checks`, `manages virtual strategies`, `triggers alerts and notifies`, `serves watchlist quotes` — depend on engine prices/margin.

**`apps/server/test/trend.test.ts`** (`simStart '2026-10-09T09:20'`, movable `wall`):
- ORB: 5 bars at exactly 09:20, 6 at 09:20:30 with partial close = ltp; complete after 09:30; range = first 15 candles; breaks consistent; other ranges/touch/past dates; scan over all 64 symbols (`svc.engine.instruments.size`); 30-session history.
- Order flow: 135 minutes at 11:30; buy+sell = volume, lot multiples; `session.volume === svc.engine.futureVolume(...)`; **"leans with price" (>60 % agreement — a property of `buyShare`)**; options flow.
- Alerts: ORB alert after advancing to 11:30 (`simStart '2026-10-09T09:25'`); ORDER_FLOW alert.
- Dashboard includes ORB/flow.
- Review regressions: `s3.engine.spot` within ORB levels (`simStart '2026-10-09T11:00'`, real `Date.now()` wall clock); `s3.analytics.minuteBars` partial wick; **`E.minuteFlow` monotonic within a minute**; live-mode Saturday (`clockMode:'live'`, `Date.UTC(2026,9,10,5,30)`) uses engine history; validation errors.

**`apps/server/test/algo.test.ts`** (`simStart '2026-10-09T09:18'`, movable `wall`; `advance()` calls `broker.tick()`/`algos.tick()`):
- backtest `'2026-10-08'` → 376 series points, entry at 09:20, OTM/multiple-of-100 checks vs series spot, ladder steps, exit 15:25, buys = sells, net = pnl − charges; `'2026-10-07'` with `maxGapPct: 1` → STOP; 20-day range (to < `'2026-10-09'`); invalid params (date `'2026-10-04'` Sunday → 400).
- live paper deployment: waits for 09:20, sells 2 legs, positions sync through ~13:20, stop/delete, exit 15:25 and next session (demo clock rolls days), and `missed exit across an expiry` with `simStart '2026-10-06T09:18'` (expiry `'2026-10-06'`, settlement).

**`apps/web/tests/smoke.spec.ts`** (Playwright; `playwright.config.ts` webServer env `SIM_START='2026-10-09T11:30'`, `PERSIST=false`): every route must render its h1 with **no API response ≥400** and no console errors (would fail with no market data / market closed); flows: Templates → Builder "4/4 legs executed" → Positions(4); optimizer "Scanned N combinations"; algo backtest "Trade log", "Daily net P&L and equity curve", deploy "● Running", stop/delete; Strategy 3 backtest.

**`packages/core/test/*`**: pure — `algo.test.ts` uses a toy `market()` premium function; `orb.test.ts` synthetic bars; `core.test.ts` textbook BS values, calendars, OI, payoff, margin, optimizer on a synthetic chain, `Rng(7)` random walk for HV. These do not depend on the simulator and can stay (move `Rng` into a test helper if `math.ts` RNG is deleted).

Recommendation for tests on live architecture: keep the provider interface injectable and run server tests against a **replay provider that reads a recorded real session** (fixture files produced by the recorder) — this keeps "no synthetic data" while staying deterministic. Expected values (dates, expiries, counts) must then be re-derived from the fixture.

---

## 10. `packages/core` — pure analytics vs simulation

| Module | Status |
|---|---|
| `bs.ts` — `bsPrice`, `bsGreeks`, `impliedVol` (Newton + bisection, NaN on bound violation), `impliedCarryYield`, `probAbove`, `expectedMove`, `intrinsic` | pure; **`impliedVol` and `impliedCarryYield` are the needed live building blocks** (currently only Calculators uses `impliedVol`; `impliedCarryYield` unused) |
| `vol.ts` — `logReturns`, `historicalVol`, `rollingHV`, `parkinsonVol`, `ivRank`, `ivPercentile`, `volatilityCone` | pure (needs daily closes / IV history as input) |
| `oi.ts` — `maxPain`, `pcr`, `modifiedPcr`, `classifyBuildUp`, `BUILDUP_SENTIMENT`, `oiSupportResistance`, `atmStrike`, `pcrSentiment` | pure |
| `payoff.ts` — legs, `legTheoPrice`, `strategyPnl`, `payoffCurve`, `findBreakevens`, `strategyGreeks`, `probabilityOfProfit`, `analyzeStrategy`, `scenarioGrid` | pure (uses `leg.iv` / `ctx.defaultIv` / `ctx.carry` → must be fed solved IV & implied carry) |
| `margin.ts` — SPAN-style estimate | pure estimate (not exchange SPAN) |
| `strategies.ts` — 49 templates, `buildFromTemplate`, `describeStrategy` | pure |
| `optimizer.ts` | pure (needs per-strike `{price, iv}`) |
| `orb.ts` — `evaluateOpeningRange`, `describeOrb`, `summariseFlow` | pure; `summariseFlow` inputs (buy/sell volume) are simulator-only today |
| `algo/*` — `premiumLadder`, `ALGOS`, `ALGO_PRESETS`, `totalCharges` | pure state machines |
| `dates.ts` — IST helpers (`istTs`, `sessionTs`, `istParts`, `expiryTs`, `yearsBetween`, trading-day helpers) | pure; `generateExpiries`/`isMonthlyExpiry` are rule-based listings (simulation-adjacent) |
| `math.ts` — normal CDF/PDF/inverse, stats | pure; **`hash32`, `mulberry32`, `Rng`, `hashUniform`, `hashNormal` = simulation only** |
| `format.ts` | pure |
| `api.ts` | wire types; sim-specific fields listed in §6.2 |

---

## 11. Live data volume implied by current screens (sizing)

Measured on the current engine (sim strike grids; real grids differ — use only as order of magnitude):

| Need | Contracts |
|---|---|
| Underlyings (spot/index quotes) | 64 (6 indices + 58 stocks) |
| Near-month futures (Home, Futures OI, Breadth, Synopsis, scanners) | 64 (+128 for next/far months shown by `/futures/:s` & order book) |
| ATM CE+PE nearest expiry for every underlying (ATM IV for IV table, IV scanners, synopsis, ticker IV) | 128 |
| `An.optionSnapshot` (scanners, unusual, synopsis), refreshed every 5 s | **2,938** (NIFTY 104, BANKNIFTY 116, FINNIFTY 114, MIDCPNIFTY 110, SENSEX 168, BANKEX 128, stocks ≈2,198) |
| Full chains, nearest expiry, all 64 underlyings | 4,048 (91 strikes × 2 per index in sim) |
| Full chains, all listed expiries (sim: NIFTY/SENSEX 9 expiries, others 3) | 14,968 |
| Live algo run (NIFTY weekly) | full chain of one expiry (≈182) |
| Per-user extra | open orders, positions, saved strategy legs, alert contracts, watchlist items |

Server-side refresh drivers today: WS ticks 1 s × sockets × (6 + ≤40) quotes; `broker.tick` 1 s; `alerts.evaluate` 3 s (PCR alerts recompute a whole chain); `algos.tick` 2 s; Order Book polls every 1 s per viewer. With a live provider these become cache reads; the subscription set (and any broker limit on subscribed tokens — **UNCONFIRMED**, see Kotak research) determines what the recorder can capture.

Rough recorder storage estimate (assumption, not measured): ~3,300 contracts × 375 minutes ≈ 1.24 M minute rows/day; at ~100 B/row (SQLite, ~14 numeric columns) ≈ 120 MB/day uncompressed.

---

## 12. Recommended provider interface (live source + recorder)

Design goals: (1) services never compute market values, they read them; (2) time is `(date, minute)` / epoch ms on a real exchange calendar, not `dayIdx`; (3) anything historical is served from stores that the recorder fills, with explicit "no data recorded for …" errors instead of fabricated values; (4) IV/Greeks are derived from market premiums in one place.

```ts
// ---------- identity ----------
export type OptKind = 'CE' | 'PE';
export interface InstrumentKey { symbol: string; kind: 'SPOT' | 'FUT' | OptKind; expiry?: string; strike?: number }
export const keyId = (k: InstrumentKey) => `${k.symbol}|${k.kind}|${k.expiry ?? ''}|${k.strike ?? ''}`;

export interface Listing extends InstrumentKey {
  exchange: 'NSE' | 'BSE';
  segment: string;          // broker exchange-segment code from the instrument master (Kotak naming UNCONFIRMED here)
  token: string;            // broker instrument token
  tradingSymbol: string;
  lotSize: number;
  tickSize: number;
}
export interface UnderlyingInfo extends SymbolInfo {  // SymbolInfo from core/api.ts (expiryRule becomes informational)
  spot: Listing;            // index or cash-equity listing
}

// ---------- reference data (refreshed daily before 09:15) ----------
export interface ReferenceData {
  refresh(date: string): Promise<void>;
  underlyings(): UnderlyingInfo[];                                   // ← E.instruments, buildUniverse()
  underlying(symbol: string): UnderlyingInfo;                        // ← E.inst (throws 404)
  expiries(symbol: string, kind: 'OPT' | 'FUT', onDate?: string): string[]; // ← E.expiries / E.futureExpiries
  strikes(symbol: string, expiry: string, onDate?: string): number[];       // ← E.strikes
  listing(key: InstrumentKey): Listing | undefined;                  // ← E.contract / contractId / symId
}
export interface TradingCalendar {                                    // ← E.days, E.dayIndex, HOLIDAYS env, generateExpiries holiday shifts
  isTradingDay(date: string): boolean;
  prev(date: string): string; next(date: string): string;
  sessions(from: string, to: string): string[];
  session(ts: number): { date: string; minute: number; status: 'pre-open' | 'open' | 'closed' }; // ← E.parts, C.info
  ts(date: string, minute: number): number;                          // ← E.tsOf
}

// ---------- live snapshot (A) ----------
export interface DepthLevel { price: number; qty: number; orders: number }
export interface LiveQuote {
  key: InstrumentKey; ts: number;            // feed/exchange timestamp
  ltp: number; ltq?: number; ltt?: number;   // last trade price / qty / time
  open: number; high: number; low: number; prevClose: number;
  volume: number;                            // cumulative session volume (units must be normalised to quantity — UNCONFIRMED for the feed)
  atp?: number;                              // average traded price (VWAP)
  oi?: number; prevOi?: number;              // prevOi = OI at previous session close (from feed or EOD store)
  bid?: number; ask?: number; bidQty?: number; askQty?: number;
  totalBuyQty?: number; totalSellQty?: number;
  depth?: { bids: DepthLevel[]; asks: DepthLevel[] };  // 5 levels
  upperCircuit?: number; lowerCircuit?: number;
}
export interface RawChain { symbol: string; expiry: string; ts: number; spot: LiveQuote; future?: LiveQuote; rows: { strike: number; ce?: LiveQuote; pe?: LiveQuote }[] }

export interface LiveMarket {
  watch(keys: InstrumentKey[], level: 'ltp' | 'quote' | 'depth', ttlMs?: number): void; // demand-driven subscriptions
  quote(key: InstrumentKey): LiveQuote | undefined;                  // ← E.spot(now), E.futurePrice(now), E.optionAt(now).ltp, E.oiAt(now), E.volumeAt(now)
  quotes(keys: InstrumentKey[]): Map<string, LiveQuote>;
  chain(symbol: string, expiry: string): RawChain;                   // ← E.chain raw inputs
  onTick(listener: (q: LiveQuote) => void): () => void;              // recorder, WS fan-out
  health(): { connected: boolean; lastTickTs: number | null; subscribed: number; error?: string };
}

// ---------- intraday store (B), written by the Recorder ----------
export interface MinuteRecord {
  ts: number; open: number; high: number; low: number; close: number;
  volume: number;                 // traded in the minute (Δ cumulative)
  oi?: number;                    // at minute close
  bid?: number; ask?: number; bidQty?: number; askQty?: number;
  totalBuyQty?: number; totalSellQty?: number;
  buyVolume?: number; sellVolume?: number; unclassified?: number;   // tick-rule / quote-rule classification (only if feed granularity allows)
  atp?: number;
}
export interface ChainMinute { ts: number; spot: number; ceOi: number; peOi: number; pcr: number; maxPain: number; atmStrike: number; atmIv: number }
export interface IntradayStore {
  bars(key: InstrumentKey, date: string, from?: number, to?: number): MinuteRecord[];  // ← E.path/spotAt/minuteWicks, An.minuteBars, optionAt(minute), oiAt(m), futurePrice(minute)
  liveBar(key: InstrumentKey): MinuteRecord | null;                                  // ← E.partialWick, current minute
  at(key: InstrumentKey, ts: number): MinuteRecord | undefined;                       // last completed minute ≤ ts (as-of)
  chainAt(symbol: string, expiry: string, ts: number): RawChain | undefined;          // ← E.chain(pastTs) for Recap / ?at=
  chainSeries(symbol: string, expiry: string, date: string): ChainMinute[];           // ← An.oiTrend / dailyPcr intraday / maxPain history
  sessions(): string[];                                                                 // recorded dates (bounds every B/C feature)
}

// ---------- multi-day history (C) ----------
export interface HistoryStore {
  dailyBars(symbol: string, from: string, to: string): { date: string; open: number; high: number; low: number; close: number; volume?: number; turnover?: number }[]; // ← DailyBar close/open/prevClose, An.cone, HV
  dailyFutures(symbol: string, from: string, to: string): { date: string; expiry: string; close: number; settle?: number; oi: number; volume: number }[]; // ← DailyBar.futOi/futOiPrev (breadth history)
  dailyOptions(symbol: string, date: string, expiry?: string): { expiry: string; strike: number; type: OptKind; close: number; settle?: number; oi: number; oiChange?: number; volume: number }[]; // ← dailyPcr, prev-close skew/IV
  dailyAtmIv(symbol: string, from: string, to: string): { date: string; iv: number; expiry: string }[];  // ← DailyBar.iv/ivPrev (derived by solver, cached)
  fiiDii(from: string, to: string): FiiDiiDay[];                     // ← F.fiiDii
  participantOi(from: string, to: string): ParticipantDay[];         // ← F.participants
  settlement(symbol: string, expiry: string): number | undefined;    // ← Pricer expired settlement
}

// ---------- pricing (derived; one place for IV/Greeks) ----------
export interface Pricing {
  r: number;                                                         // ← E.r
  forward(symbol: string, expiry: string, ts?: number): { forward: number; carry: number; source: 'future' | 'parity' | 'spot' }; // ← inst.divYield, chain.carry
  iv(input: { symbol: string; expiry: string; type: OptKind; strike: number; premium: number; ts: number }): number; // ← optionAt().iv, quotedIv (impliedVol on market premium; NaN allowed)
  greeks(input: { symbol: string; expiry: string; type: OptKind; strike: number; iv: number; ts: number }): Greeks;     // ← bsGreeks(model IV)
  atmIv(symbol: string, expiry?: string, ts?: number): number;       // ← E.atmIvAt / E.atmIv / Quote.atmIv
  smile(symbol: string, expiry: string, ts?: number): (strike: number) => number; // ← E.quotedIv for surface / illiquid strikes
}

// ---------- clock (live only) ----------
export interface SessionClock { now(): number; info(): MarketClockInfo }   // ← MarketClock (drop demo/speed)

// ---------- facade the services depend on ----------
export interface MarketDataProvider {
  ref: ReferenceData; calendar: TradingCalendar; live: LiveMarket;
  intraday: IntradayStore; history: HistoryStore; pricing: Pricing; clock: SessionClock;
}
```

### Recorder (fills IntradayStore + HistoryStore)

```ts
export interface UniversePolicy {
  indices: { expiries: number; strikePct: number };   // e.g. nearest 2–4 option expiries, ±5–8 % of spot, re-centred intraday
  stocks: { expiries: number; strikePct: number };    // e.g. nearest expiry, ±12 %
  futures: 'near' | 'all';
  includeUserContracts: true;                          // open orders, positions, saved-strategy legs, alerts, watchlists, running algos
}
export class Recorder {
  constructor(p: MarketDataProvider, writer: { intraday: IntradayWriter; history: HistoryWriter }, policy: UniversePolicy);
  startSession(date: string): Promise<void>;  // ~09:00 IST: ref.refresh(), compute universe, live.watch(), subscribe onTick
  onTick(q: LiveQuote): void;                 // per key: minute OHLC from ltp; volume = Δcumulative; last oi/bid/ask/totals; classify Δvolume (≥ask → buy, ≤bid → sell, else tick rule → unclassified)
  onMinuteClose(minute: number): void;        // flush MinuteRecords; per (symbol, expiry): ΣCE/PE OI, PCR, maxPain, ATM strike, ATM IV (pricing.atmIv) → ChainMinute
  onSessionClose(date: string): Promise<void>;// 15:30+: daily bar, futures close/OI, option close/OI for the universe, dailyAtmIv
  backfill(from: string, to: string): Promise<void>; // public EOD sources (bhavcopy, participant OI, FII/DII, index history) — sources/formats UNCONFIRMED
}
```

### Mapping of current engine members to provider methods

| Current | Provider method |
|---|---|
| `buildUniverse()`, `E.instruments`, `E.inst` | `ref.underlyings()`, `ref.underlying()` |
| `E.expiries`, `E.futureExpiries`, `generateExpiries` | `ref.expiries(sym, 'OPT'|'FUT', date?)` |
| `E.contract`, `E.contractId`, `E.symId` | `ref.listing(key)` |
| `E.strikes` | `ref.strikes(sym, expiry, date?)` |
| `E.days`, `E.dayIndex`, `E.parts`, `E.tsOf`, `config.holidays` | `calendar.*` |
| `C.now`, `C.info`, demo mode | `clock.now/info` (live only) |
| `E.spot(ts=now)`, `E.quote` LTP/OHLC/prevClose | `live.quote({sym,'SPOT'})` |
| `E.spot(ts past)`, `E.spotAt`, `E.path`, `E.minuteWicks`, `E.partialWick`, `E.dayStats` (past) | `intraday.bars/at/liveBar` |
| `E.futurePrice/futureOi/futureVolume` (now) | `live.quote({sym,'FUT',expiry})` |
| same (minute / past) | `intraday.bars/at` |
| `E.optionAt(now).ltp`, `E.oiAt(now)`, `E.volumeAt(now)`, `E.optionQuote` | `live.quote({sym, CE|PE, expiry, strike})` + `pricing.iv/greeks` |
| `E.optionAt(minute)`, `E.oiAt(past minute)`, `E.volumeAt(past)` | `intraday.bars/at` (+ `pricing.iv` on recorded premium) |
| `E.oiAt(prev close)`, `optionAt(prev close)` | `LiveQuote.prevOi/prevClose` or `history.dailyOptions(prevDate)` |
| `E.chain(now)` | `live.chain()` + core `pcr/maxPain/oiSupportResistance` + `pricing` |
| `E.chain(past ts)` (`?at=`, Recap) | `intraday.chainAt()` |
| `E.atmIvAt`, `E.atmIv`, `Quote.atmIv` | `pricing.atmIv()` (live) / `intraday.chainSeries().atmIv` (past) |
| `E.quotedIv`, `E.optionIv`, `E.tradingYears` | `pricing.iv()` + `pricing.smile()` |
| `E.bars()/E.bar()` close/open/prevClose | `history.dailyBars()` |
| `DailyBar.iv/ivPrev` | `history.dailyAtmIv()` |
| `DailyBar.futOi/futOiPrev` | `history.dailyFutures()` |
| `DailyBar.volume` (candle/turnover synthesis) | real `LiveQuote.volume` / minute `volume`; turnover = volume × atp |
| `E.r`, `inst.divYield` | `pricing.r`, `pricing.forward()` |
| `E.bookTilt`, `E.minuteFlow`, synthetic depth (`T.orderBook`), synthetic bid/ask | `live.quote(..).depth/bid/ask/totalBuyQty/totalSellQty`, `intraday.bars().buyVolume/sellVolume` (if feed supports it), depth history from recorder |
| `F.fiiDii`, `F.participants` | `history.fiiDii()`, `history.participantOi()` |
| `E.minuteMarks` | keep as a pure helper |

### Service-by-service rewiring notes

- **Analytics**: replace `(dayIdx, m)` with `(date, minute)`; `resolveDay` must check `intraday.sessions()` and return 404/409 "no recorded data for <date>" for unrecorded dates; `oiTrend`/`dailyPcr`/`maxPainDetail` should read `intraday.chainSeries` instead of recomputing every strike per mark; `surface` must interpolate a fitted smile over listed strikes; `ivHistory`/`ivTable`/`cone` read `history`.
- **MarketTools**: `optionSnapshot` = one pass over cached live quotes of the universe + `pricing.iv` (cache per 5 s as today); `orderBook` = real depth + recorder depth history; `orderFlow` = recorder classification or remove/relabel if the feed cannot support it; `synopsis` turnover from real volume × ATP/LTP.
- **Pricer**: bid/ask from live quote; EQ/FUT ±0.05 spreads removed; expiry settlement from `history.settlement()`.
- **PaperBroker/StrategyManager**: unchanged logic; margin from `pricing.atmIv` + `pricing.forward` (or broker margin API — UNCONFIRMED).
- **AlertService**: `IV` → `pricing.atmIv`; `PCR` → cached chain aggregate; `ORDER_FLOW` depends on flow availability; `ORB_BREAK` → minute bars from `intraday`.
- **AlgoService**: `snapshot` reads `live.chain()` (live) or `intraday.chainAt()`/`bars()` per minute (backtest); `backtestRange` limited to recorded sessions; `tick` gated by `calendar.session(ts).status === 'open'`.
- **WS**: fan out `live.onTick` (throttled) instead of recomputing `E.quote` per socket per second.
- **Meta/clock/UI**: `dataSource: 'live'`, drop `mode/speed`, add provider `health()` (connected, last tick) to the clock chip; remove simulated banners/texts listed in §6.3; add "data available from <first recorded session>" notes on B/C screens.

---

## 13. Observations that matter for the migration (from code)

1. `chain().ivChange` compares avg(CE, PE) IV now with **CE-only** IV at the previous close (engine.ts:870-890).
2. Breadth: today's classification uses near-month **futures** price change vs futures OI change, history uses **spot** close change vs aggregate futures OI (analytics.ts:461-503).
3. Strike lists are a band around the previous close (engine.ts:512-530); several pages assume `chain.rows` contains the ATM strike and `strikeStep` spacing (MultiStrike default strikes `atm ± 2·strikeStep`, OptionChain `±around` slicing). Real chains can have uneven strike spacing (UNCONFIRMED per symbol) — `strikeStep` should be derived from listings.
4. `An.oiTrend` recomputes OI for every strike at every mark on every poll (10 s); with live data this should come from per-minute chain aggregates written once by the recorder.
5. `alerts.evaluate` calls `E.chain()` for each PCR alert symbol every 3 s (cache per eval cycle only).
6. Weekly index options have no same-expiry future; carry must come from put-call parity for those expiries.
7. `/api/quotes`, `/api/indices`, `/api/futures/:s`, `/api/clock`, `/api/candles?interval=D` have no web consumer (tests only).
8. `MarketTools.ivp()` is dead code.

---

## 14. UNCONFIRMED items (outside this topic's primary source)

- Which `LiveQuote` fields (prev OI, ATP, total buy/sell qty, circuit limits, LTQ/LTT, 5-level depth with order counts) the Kotak Neo feed/quotes API actually provides, their names, units (lots vs quantity), and update granularity (every trade vs snapshots) — determines whether order-flow classification is possible.
- Kotak Neo subscription limits per WebSocket/session and REST quote rate limits — determines whether the ~3,000-contract snapshot universe is feasible.
- Whether Kotak Neo offers historical intraday candles for index/stock/option instruments (would allow backfilling B/C beyond the recorder start).
- Exact NSE public sources/URLs/formats for F&O bhavcopy (option close/settle/OI), participant-wise OI, FII/DII cash data, final settlement prices, index historical closes, and the exchange holiday list.
- NSE settlement mechanics used for paper settlement (cash-settled index options vs physically-settled stock F&O).
