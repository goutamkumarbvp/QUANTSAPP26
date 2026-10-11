# Quantsapp feature audit & parity map

This document audits the **Quantsapp** options-analytics app (Google Play `com.quantsapp.qapp`, iOS, and
web.quantsapp.com) and maps every module to its implementation in **Q26 Options**.

## Method

The sandbox this project was built in cannot reach Google Play, the App Store or quantsapp.com directly,
so the audit is compiled from public descriptions of the product:

- Google Play / App Store listings (feature text: option chain, OI suite, IV tools, build-up, optimizer,
  Trade Recap simulator, unusual option activity, F&O scanners, synopsis heat-map, 33 full-depth order-book
  analytics, multi-broker execution, free vs Pro/Pro+ tiers).
- quantsapp.com and web.quantsapp.com pages (navigation: Option Chain, OI analysis, Multi-Strike OI,
  PCR & Modified PCR, Max Pain, Futures OI, OI build-up, Built-Up Breadth, Synopsis, Participant data,
  FII/DII, Straddle index, Strategy Builder, Strategy Optimizer, Backtesting, Strategy Repair, Strategy
  Chart, O&T watch list, Scan, Unusual Option Activity, classroom/video library).
- Third-party reviews (Strike.money, AlgoTest, Fintrakk, Medium) describing how the tools behave.

Q26 Options re-implements the **functionality and workflows** with original code, design and branding.
It does not copy Quantsapp's name, logo, text or assets.

Legend: ✅ implemented · ◐ implemented differently / partially · ✗ not implemented (reason given)

## Module map

| # | Reference module | What it does | Q26 Options | Status |
|---|---|---|---|---|
| 1 | Live option chain | Strike-wise LTP, change, OI, change in OI, volume, IV, Greeks, ITM shading, ATM marker | `/option-chain` — CE/PE mirrored table, OI bars, ITM shading, spot line, Greeks toggle, qty/lots, strike range, per-strike PCR, build-up tags, B/S → builder, click premium → order | ✅ |
| 2 | Chain summary | Spot, futures, PCR, max pain, ATM IV, DTE | Stat strip on option chain + Home derivatives snapshot | ✅ |
| 3 | Open interest analysis | Strike-wise OI & change in OI, support/resistance | `/oi/strikes` — OI / change / both, change window (prev close, since open, 60/30/15 min), max call/put writing | ✅ |
| 4 | Multi-strike OI | Intraday OI of selected strikes | `/oi/multi-strike` — up to 6 strikes, CE/PE, OI/premium/IV, any past session, 1–30 min | ✅ |
| 5 | OI trend / cumulative OI | Call vs put OI through the day | `/oi/trend` — total OI and change in OI vs spot | ✅ |
| 6 | PCR & Modified PCR | Put-call ratio intraday and daily | `/oi/pcr` — intraday PCR vs spot + 60-session EOD PCR; modified PCR in core (`modifiedPcr`) | ✅ |
| 7 | Max pain / option pain | Pain by strike, max pain drift | `/oi/max-pain` — stacked writer payout by expiry price + intraday max pain vs spot | ✅ |
| 8 | Futures OI | Price & OI change of all F&O futures | `/oi/futures` — sortable table, build-up filters, index/stock filter | ✅ |
| 9 | Build-up (LB/SB/SC/LU) | Quadrant classification by scrip & sector | Futures OI, option chain (per contract), scanners, synopsis | ✅ |
| 10 | Built-Up Breadth | Count of build-up types by sector | `/oi/breadth` — overall, by sector, 20-session history, constituents | ✅ |
| 11 | Participant-wise OI | Client / DII / FII / Pro long & short | `/participants` — 6 categories, net & 1-day change, trend vs NIFTY | ✅ |
| 12 | FII / DII data | Institutional cash flows | `/fii-dii` — daily buy/sell/net, cumulative, vs NIFTY | ✅ |
| 13 | IV chart | ATM IV intraday and history | `/vol/iv-chart` — intraday ATM/CE/PE IV vs spot, IV vs HV (3M/6M/1Y), IVR, IVP | ✅ |
| 14 | IV Rank / IV Percentile | Rich/cheap screen across F&O | `/vol/ivp` — IV, IV chg, IVR, IVP bars, HV20, IV−HV | ✅ |
| 15 | Volatility skew | IV across strikes | `/vol/skew` — up to 5 expiries, strike/moneyness axis, CE vs PE, vs previous close | ✅ |
| 16 | Volatility surface | IV by strike × expiry | `/vol/surface` — moneyness × expiry heat-map | ✅ |
| 17 | Historical volatility / cone | Realised vol context | `/vol/cone` — HV percentiles by window vs current HV & IV | ✅ |
| 18 | Straddle / strangle chart (Straddle index) | Combined premium intraday | `/straddle` — rolling (forward-ATM) or fixed strike, strangle widths, implied move, past sessions | ✅ |
| 19 | Strategy chart | Chart a strategy like one instrument | `/strategy-chart` — net premium, P&L and Greeks of builder legs intraday | ✅ |
| 20 | Strategy builder | Multi-leg payoff, Greeks, POP, margin | `/builder` — editable legs, payoff at expiry + target date, IV what-if, ±1σ/2σ bands, breakevens, max P/L, POP, R:R, expected P&L, SPAN-style margin with hedge benefit, scenario grid, share link, save virtual, execute paper basket | ✅ |
| 21 | Strategy wizard / ready-made strategies | Strategies by market view | `/templates` — 49 templates (bullish/bearish/neutral/volatile) with live payoff, max P/L, POP | ✅ |
| 22 | Optimizer | Best reward-to-risk strategy for a view | `/optimizer` — target, date, stop-loss, max legs, capital cap, unlimited-risk toggle, rank by R:R / profit / POP; scans ~460k combinations in < 1 s | ✅ |
| 23 | Trade Recap / options simulator | Replay the market at any past date & time | `/recap` — historical chain as of any minute, build position, replay P&L to expiry | ✅ (on simulated history) |
| 24 | Strategy manager / virtual trading | Paper strategies, MTM, MTM alerts | `/strategies` — live MTM, leg-wise exit, payoff, target/stop-loss MTM notifications | ✅ |
| 25 | Order & position management | Orders, positions, funds | `/positions` — paper broker: market/limit/SL/SL-M, NRML/MIS, margin checks, positions, order & trade book, funds, expiry settlement | ◐ paper only (see gaps) |
| 26 | Scanners | F&O scans on OI, price, IV | `/scanners` — 20 scans (build-up, OI, price, IV, IVP, most active, call/put writing, highest OI, volume/OI spikes, premium gainers) | ✅ |
| 27 | Unusual option activity | Abnormal option flow | `/unusual` — z-score of volume/OI, OI change, IV change, weighted by premium turnover, with interpreted signal | ✅ |
| 28 | Synopsis | F&O market heat-map | `/synopsis` — sector treemap sized by turnover, coloured by price / OI / IV change; table view | ✅ |
| 29 | Order-book analytics (33 metrics, 1-second) | Full-depth analytics | `/order-book` — 5-level depth for futures/options, 18 order-flow metrics, refresh every second, intraday depth chart | ◐ 18 metrics on 5-level simulated depth |
| 30 | Watchlist (O&T watch list) | Track instruments | `/watchlist` — multiple lists, spot/futures/options, live quotes, trade from list | ✅ |
| 31 | Alerts | Price / MTM alerts | `/alerts` — underlying price, option premium, ATM IV, PCR, option OI change %, strategy MTM; live in-app notifications | ✅ |
| 32 | Calculators | Option pricing tools | `/calculators` — BS price & Greeks, IV from premium, F&O charges | ✅ |
| 33 | Classroom / learning | Educational content | `/learn` — 8 original lessons linked to the tools | ◐ text lessons, no videos |
| 34 | Market dashboard | Indices, movers | `/` — index cards with sparklines, derivatives snapshot, build-up counts, gainers/losers/OI gainers, FII/DII | ✅ |
| 35 | Light / dark theme, mobile app | — | Dark & light themes, responsive layout with bottom tab bar, installable PWA with offline shell | ◐ PWA (see gaps) |
| 41 | 15-min opening range breakout (user request) | First 15-min candle high/low; break = trending | `/orb` — live/past sessions, 5/15/30-min ranges, close or touch rule, break markers, whipsaw & failed-breakout flags, all-F&O scanner, 20-session record, `orb-up/down/inside` scanners, dashboard column, ORB_BREAK alert | ✅ |
| 42 | 1-minute order flow (user request) | Buyer vs seller volume in the last minute | `/order-flow` — futures/options, last completed minute, current minute, last 5 min, session, delta & cumulative delta, per-minute chart/table; panel in Order Book; dashboard column; ORDER_FLOW alert | ✅ (on simulated trades) |
| 36 | Login | Mobile OTP | Email + password accounts, frictionless guest mode, guest → account upgrade keeps data | ◐ |
| 37 | Strategy Repair | Adjust losing strategies | — | ✗ not built |
| 38 | Live exchange data | NSE/BSE real-time feed | Deterministic simulated market (see README) | ✗ needs licensed feed |
| 39 | Broker execution (20+ brokers) | Route real orders | — | ✗ needs broker API credentials |
| 40 | Free / Pro / Pro+ plans | Paywall | All tools unlocked | ✗ not built |

## Known gaps and why

1. **Live market data.** Real-time NSE/BSE data requires a licensed data vendor or a broker market-data API;
   it cannot be bundled in an open-source repository. All data comes from the simulator in
   `apps/server/src/market/engine.ts`. To go live, re-implement the `MarketEngine` methods the services call
   (`quote`, `chain`, `optionAt`, `oiAt`, `volumeAt`, `futurePrice`, `futureOi`, `atmIvAt`, …) on top of the
   vendor feed plus a time-series store for intraday history.
2. **Real order execution.** Only the paper broker exists. A broker adapter (Kite Connect, Upstox, Dhan,
   etc.) needs per-user OAuth and static-IP compliance; the `PaperBroker` API surface (`place`, `cancel`,
   `positions`, `funds`) is the integration point.
3. **Native store app.** The web app is an installable PWA (manifest, icons incl. maskable, service worker).
   Publishing to Google Play can be done with a Trusted Web Activity (Bubblewrap) or Capacitor wrapper — see
   README. No signed APK is produced by this repository.
4. **Order-book depth.** Exchanges publish 5-level depth to most retail feeds; 20-level/full-depth
   analytics need a premium feed. The 18 implemented metrics work on any depth.
5. **Strategy Repair, subscriptions, OTP login, video classroom** are not implemented.

## Calibration notes (simulator)

- Index lot sizes follow the Jan-2026 NSE revision (NIFTY 65, BANKNIFTY 30, FINNIFTY 60, MIDCPNIFTY 120;
  SENSEX 20, BANKEX 30). Stock lot sizes target ≈₹7.5 lakh notional; strike steps follow price bands.
- Expiries: NIFTY weekly Tuesday, SENSEX weekly Thursday, monthly on the last Tuesday (NSE) / Thursday (BSE),
  quarterly NIFTY contracts; holiday shifts supported via `HOLIDAYS`.
- Option chains are checked in tests for monotonic premiums and non-negative butterflies (no static
  arbitrage); OI is continuous across sessions so change-in-OI starts at zero each morning.
