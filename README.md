# Q26 Options

An options-analytics and paper-trading platform for Indian F&O (NSE / BSE), modelled on the feature set of
Quantsapp — option chain, open-interest suite, implied-volatility suite, strategy builder, strategy wizard,
optimizer, straddle & strategy charts, trade recap, scanners, unusual option activity, synopsis heat-map,
order-book analytics, FII/DII & participant data, watchlists, alerts and a paper broker.

> **Market data is simulated.** A deterministic market engine generates realistic prices, IV smiles, OI and
> volumes for 6 indices and 58 F&O stocks. Nothing here is live exchange data or investment advice.
> See [docs/AUDIT.md](docs/AUDIT.md) for the module-by-module parity map and known gaps.

## Quick start

Requires Node.js ≥ 20.11.

```bash
npm install
npm run dev          # API on :8787 + web on :5173 (proxied) → open http://localhost:5173
```

Production (single process serving API, WebSocket and the built web app):

```bash
npm run build
npm start            # http://localhost:8787
```

Docker:

```bash
docker build -t q26-options .
docker run -p 8787:8787 -v q26-data:/app/apps/server/data q26-options
```

## Features (38 screens)

| Area | Screens |
|---|---|
| Market | Home dashboard, Watchlist, Option Chain, Synopsis heat-map, FII/DII, Participant-wise OI |
| Trend & flow | 15-min opening range breakout (trend detector), 1-minute order flow (buyer vs seller volume) |
| Open interest | OI analysis (strike-wise OI & change), Multi-strike OI, OI trend, PCR, Max pain, Futures OI & build-up, Build-up breadth |
| Volatility | IV chart (intraday + IV vs HV), IV Rank & Percentile, Skew, Surface, Volatility cone |
| Strategy | Strategy builder, Strategy wizard (49 templates), Optimizer, Straddle chart, Strategy chart, Trade recap |
| Trade | Positions & orders (paper broker), Strategy manager (virtual strategies), Alerts |
| Algo | Algo Strategies panel — backtest (one day / many days) and deploy rule-based algos on the paper account; first algo: Strategy 2 (₹20 premium ladder) |
| Scanners | 20 F&O scanners, Unusual option activity, Order-book analytics |
| More | Calculators (BS price/Greeks, IV, charges), Learn, Settings |

Highlights:

- **Strategy builder** — editable legs, payoff at expiry and on any target date, IV what-if, ±1σ/±2σ bands,
  breakevens, max profit/loss (with unlimited detection), probability of profit, expected P&L, net Greeks,
  SPAN-style margin with hedge benefit, scenario grid, shareable links, save as virtual strategy, execute as a
  paper basket order.
- **Optimizer** — scans ~460,000 1–4 leg combinations on the live chain and ranks them by reward-to-risk,
  profit at target or POP, honouring stop-loss, max legs and capital limits.
- **Trade recap** — load the option chain as it was at any past minute, build a position at those prices and
  replay its P&L to expiry.
- **15-minute opening range breakout** — the high and low of the first 15-minute candle (09:15–09:30) are
  recorded every session; a 1-minute close beyond either level marks the market as trending up or down
  (sideways while inside), with whipsaw / failed-breakout detection, an all-F&O scanner, a 20-session record,
  trend scanners, a dashboard column and break alerts. 5- and 30-minute ranges and a "any touch" rule are
  selectable.
- **1-minute order flow** — each minute's traded volume of a future or option is split into aggressive buy vs
  sell volume (delta, buy %, cumulative delta) with the last completed minute, the minute in progress,
  last-5-minute and session totals; also shown in Order Book Analytics, on the dashboard and as an alert.
- **Algo Strategies** — a separate panel for automated strategies, built so new algos plug in (each algo is a
  pure state machine in `packages/core/src/algo`, registered in `ALGOS`). The first one is **Strategy 2 · starting
  premium ₹20**: at 09:20 sell an OTM CE and PE nearest ₹20 (NIFTY strikes in multiples of 100); each time either
  leg's premium climbs another 50% (₹20 → ₹30 → ₹45 → ₹67.5 …, no limit) buy back the opposite leg and sell the OTM
  strike nearest the new level; if no eligible OTM strike exists, square off and stop for the day; square off
  everything at 15:25. Backtest any past session minute by minute (charts, trade log, charges) or the last 20–250
  sessions (win rate, drawdown, equity curve), then deploy it on the paper account: it trades through the paper
  broker every 2 seconds (MIS orders tagged `algo:<id>`), sends notifications, and runs every trading day until
  stopped.
- **Live updates** — WebSocket ticker and notifications; analytics views poll every few seconds.
- **Installable PWA** — mobile-first layout with bottom tabs, dark/light themes, offline app shell.

## Architecture

```
packages/core   Pure TypeScript analytics shared by server and browser
                Black-Scholes & Greeks, IV solver, IST expiry calendar, payoff/breakeven/POP,
                max pain, PCR, build-up, HV/IVR/IVP/cone, SPAN-style margin, templates, optimizer
apps/server     Fastify REST + WebSocket API
                market/   deterministic market engine, clock, instrument universe, FII/DII & participant flows
                services/ analytics per tool, scanners/UOA/synopsis/order book, pricer, paper broker,
                          strategy manager, alerts, watchlists
                store/    JSON document store (atomic writes)
apps/web        React 18 + Vite + Tailwind + ECharts PWA (React Query, Zustand)
```

### How the simulated market works

Every observable is a **pure function of (instrument, contract, timestamp)**:

- Daily closes come from a GARCH-clustered market factor plus sector and idiosyncratic factors with mild mean
  reversion; ATM IV mean-reverts and jumps when prices fall (leverage effect).
- Intraday prices are Brownian bridges between each day's open and close with a U-shaped volatility profile;
  stocks are correlated with the index path.
- Option IV follows a skew/smile in standardised moneyness with a term structure; premiums are Black-Scholes
  on the forward implied by futures carry. Chains are tested to be free of static arbitrage.
- OI is a closed-form function of moneyness, sessions-to-expiry, round-number strikes and slowly varying
  per-contract factors (with occasional heavy-writing events), interpolated through each session so OI is
  continuous across days.

Because nothing is stored, any past minute can be recomputed exactly — that is what powers Trade Recap,
multi-strike OI history, IV percentiles and "as-of" option chains (`GET /api/chain/NIFTY?at=<epoch ms>`).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8787` / `0.0.0.0` | API listen address |
| `CLOCK_MODE` | `demo` | `demo` = always-open simulated session; `live` = follow the real IST clock (closed outside 09:15–15:30) |
| `SIM_SPEED` | `1` | Demo clock speed multiplier |
| `SIM_START` | now / 10:30 | Demo start, e.g. `2026-10-09T11:30` (IST) |
| `MARKET_SEED` | `q26` | Seed for the market generator |
| `RISK_FREE_RATE` | `0.065` | Used for pricing and Greeks |
| `HOLIDAYS` | — | Comma-separated `YYYY-MM-DD` exchange holidays |
| `AUTH_SECRET` | random per boot | HMAC secret for session tokens — **set it in production** so sessions survive restarts |
| `DATA_DIR` | `apps/server/data` | Where user data (`db.json`) is stored |
| `PERSIST` | `true` | `false` keeps user data in memory only |

## Testing

```bash
npm test             # core unit tests (pricing, Greeks, calendar, payoff, margin, optimizer) + API integration tests
npm run typecheck
npm run build && npm run test:e2e   # Playwright: every screen on desktop & mobile + key user flows
```

If Playwright browsers aren't installed, run `npx playwright install chromium` or point
`CHROMIUM_PATH` at an existing Chromium binary.

## Publishing to Google Play

The web app is a standards-compliant PWA (manifest, 192/512/maskable icons, service worker). To ship it as an
Android app, wrap the deployed HTTPS URL in a Trusted Web Activity with
[Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) (`bubblewrap init --manifest https://your-host/manifest.webmanifest`)
and add the generated Digital Asset Links file at `/.well-known/assetlinks.json`.

## API overview

All endpoints are under `/api`. Market data: `meta`, `quotes`, `indices`, `expiries/:symbol`, `chain/:symbol`,
`futures/:symbol`, `candles/:symbol`, `dashboard`, `oi/{strikes,multi-strike,trend,pcr,max-pain}/:symbol`,
`oi/futures`, `oi/breadth`, `participants`, `fii-dii`, `vol/{iv-chart,skew,surface,cone}/:symbol`, `vol/table`,
`straddle/:symbol`, `orb`, `orb/:symbol`, `orb/:symbol/history`, `order-flow/:symbol`, `algos`, `algos/:id/defaults`,
`algos/:id/backtest` (POST), `algos/:id/backtest-range` (POST), `strategy-chart` (POST), `optimizer` (POST), `recap` (POST), `scanners[/:id]`, `unusual`,
`synopsis`, `order-book/:symbol`. User data (Bearer token): `auth/*`, `settings`, `strategies`, `broker/*`,
`alerts`, `notifications`, `watchlists`, `algo-runs` (list/deploy, `:id/stop`, delete). WebSocket: `/ws` (ticks, notifications, order updates).

## Disclaimer

Educational and analytical software. Simulated data; paper trading only; not investment advice.
"Quantsapp" is a trademark of its owner; this project is independent and not affiliated with it.
