# Quantsapp feature audit & parity map

This document audits the **Quantsapp** options-analytics app (Google Play `com.quantsapp.qapp`, iOS, and
web.quantsapp.com) and maps every module to its implementation in **Q26 Options**, with the live or official
source each one uses and when it is blank.

Q26 Options runs on **live data only**: the Kotak Neo Trade API (login, scrip master, REST quotes / option chain /
historical candles, SFeed websocket) and the official NSE/BSE end-of-day files. Nothing is synthesised; a value
the sources do not provide is shown as — with the reason. Trading is **paper only**. Architecture:
[live-data/DESIGN.md](live-data/DESIGN.md).

## Method

The sandbox this project was built in cannot reach Google Play, the App Store or quantsapp.com directly,
so the audit is compiled from public descriptions of the product:

- Google Play / App Store listings (feature text: option chain, OI suite, IV tools, build-up, optimizer,
  Trade Recap, unusual option activity, F&O scanners, synopsis heat-map, 33 full-depth order-book
  analytics, multi-broker execution, free vs Pro/Pro+ tiers).
- quantsapp.com and web.quantsapp.com pages (navigation: Option Chain, OI analysis, Multi-Strike OI,
  PCR & Modified PCR, Max Pain, Futures OI, OI build-up, Built-Up Breadth, Synopsis, Participant data,
  FII/DII, Straddle index, Strategy Builder, Strategy Optimizer, Backtesting, Strategy Repair, Strategy
  Chart, O&T watch list, Scan, Unusual Option Activity, classroom/video library).
- Third-party reviews (Strike.money, AlgoTest, Fintrakk, Medium) describing how the tools behave.

Q26 Options re-implements the **functionality and workflows** with original code, design and branding.
It does not copy Quantsapp's name, logo, text or assets.

Legend: ✅ implemented · ◐ implemented differently / partially · ✗ not implemented (reason given)

Source shorthand: **feed** = Kotak SFeed websocket ticks; **REST** = Kotak REST (quotes, option chain, 1-minute
historical for listed contracts); **recorder** = minutes the app itself recorded from the feed (history starts
with the first recorded session); **EOD** = official NSE/BSE files (bhavcopy, index closes, participant OI,
FII/DII, holidays). **IV** is always solved from live (or bhavcopy) premiums.

## Module map

| # | Reference module | Q26 Options | Live source · blank when | Status |
|---|---|---|---|---|
| 1 | Live option chain | `/option-chain` — CE/PE mirrored table, OI bars, ITM shading, spot line, Greeks toggle, qty/lots, strike range, per-strike PCR, build-up tags, B/S → builder, click premium → order | feed (index chains) / REST sweep (stock chains); IV & Greeks solved locally; previous OI from REST or bhavcopy · blank when not logged in or the chain is not streamed yet; a strike without a live premium has no IV | ✅ |
| 2 | Chain summary | Stat strip on option chain + Home derivatives snapshot | feed/REST; PCR & max pain from live OI · per field | ✅ |
| 3 | Open interest analysis | `/oi/strikes` — OI / change, change window (prev close, since open, 60/30/15 min), max call/put writing | live chain; intraday windows from recorder · window not recorded | ✅ |
| 4 | Multi-strike OI | `/oi/multi-strike` — up to 6 strikes, CE/PE, OI/premium/IV, 1–30 min | recorder · session or strike not recorded | ✅ |
| 5 | OI trend / cumulative OI | `/oi/trend` — total OI and change in OI vs spot | recorder · no recorded chain minutes | ✅ |
| 6 | PCR & Modified PCR | `/oi/pcr` — intraday PCR vs spot + daily PCR; modified PCR in core (`modifiedPcr`) | intraday from recorder; daily from bhavcopy · not recorded / files not loaded | ✅ |
| 7 | Max pain / option pain | `/oi/max-pain` — writer payout by expiry price + intraday max pain vs spot | live OI; intraday from recorder · no OI in the chain | ✅ |
| 8 | Futures OI | `/oi/futures` — sortable table, build-up filters, index/stock filter | feed (near futures); previous values from quotes or bhavcopy · no live futures quotes | ✅ |
| 9 | Build-up (LB/SB/SC/LU) | Futures OI, option chain (per contract), scanners, synopsis | live price & OI vs previous close/OI · previous values unavailable | ✅ |
| 10 | Built-Up Breadth | `/oi/breadth` — overall, by sector, history, constituents | live futures; history from bhavcopy · no live futures and no F&O files | ✅ |
| 11 | Participant-wise OI | `/participants` — client / DII / FII / pro, net & 1-day change, trend vs NIFTY | NSE `fao_participant_oi` / `_vol` · file not published or blocked | ✅ |
| 12 | FII / DII data | `/fii-dii` — daily buy/sell/net, cumulative, vs NIFTY | NSE FII/DII JSON (unofficial endpoint) · not loaded / blocked | ✅ |
| 13 | IV chart | `/vol/iv-chart` — intraday ATM/CE/PE IV vs spot, IV vs HV, IVR, IVP | intraday IV from recorded premiums; daily IV from bhavcopy premiums; HV from EOD closes · not enough history | ✅ |
| 14 | IV Rank / IV Percentile | `/vol/ivp` — IV, IV chg, IVR, IVP, HV20, IV−HV | live IV + daily IV history from bhavcopy · not enough history | ✅ |
| 15 | Volatility skew | `/vol/skew` — up to 5 expiries, strike/moneyness axis, CE vs PE, vs previous close | IV from live premiums · no premium to solve | ✅ |
| 16 | Volatility surface | `/vol/surface` — moneyness × expiry heat-map | IV from live premiums · no premium to solve | ✅ |
| 17 | Historical volatility / cone | `/vol/cone` — HV percentiles by window vs current HV & IV | EOD daily closes · closes not loaded | ✅ |
| 18 | Straddle chart (Straddle index) | `/straddle` — rolling or fixed strike, strangle widths, implied move, past sessions | recorder, or Kotak 1-minute history for listed contracts · expired or unrecorded | ✅ |
| 19 | Strategy chart | `/strategy-chart` — net premium, P&L and Greeks of builder legs intraday | recorder / Kotak 1-minute (listed contracts) · a leg has no traded minute | ✅ |
| 20 | Strategy builder | `/builder` — legs, payoff at expiry + target date, IV what-if, ±1σ/2σ, breakevens, max P/L, POP, R:R, SPAN-style margin **estimate**, scenario grid, share link, save virtual, execute paper basket | live chain + local IV · chain not available | ✅ |
| 21 | Strategy wizard | `/templates` — 49 templates (bullish/bearish/neutral/volatile) with payoff, max P/L, POP | live chain · chain not available | ✅ |
| 22 | Optimizer | `/optimizer` — target, date, stop-loss, max legs, capital cap, rank by R:R / profit / POP | live chain + local IV · chain not available | ✅ |
| 23 | Trade Recap | `/recap` — chain as of any recorded minute, build position, replay P&L | recorder only · date before recording started | ✅ (recorded sessions only) |
| 24 | Strategy manager / virtual trading | `/strategies` — MTM, leg-wise exit, payoff, target/stop-loss MTM notifications | live quotes · leg not priced | ✅ |
| 25 | Order & position management | `/positions` — paper broker: market/limit/SL/SL-M, NRML/MIS, margin checks, positions, order & trade book, funds, expiry settlement | fills at live bid/ask; settlement from the official settlement price · market order rejected without a live bid/ask | ◐ paper only |
| 26 | Scanners | `/scanners` — 23 scans (build-up, OI, price, IV, IVP, most active, call/put writing, highest OI, volume/OI spikes, premium gainers, opening range up/down/inside) | live futures + stock-option sweep; previous IV/OI from bhavcopy; ORB scans from recorder · before the first sweep | ✅ |
| 27 | Unusual option activity | `/unusual` — z-score of volume/OI, OI change, IV change, weighted by turnover | live option snapshot · before the first sweep | ✅ |
| 28 | Synopsis | `/synopsis` — sector treemap coloured by price / OI / IV change; table view | live futures + options · before the first sweep | ✅ |
| 29 | Order-book analytics (33 metrics, 1-second) | `/order-book` — 5-level depth for futures/options, order-flow metrics, intraday depth chart | SFeed depth (5 levels), requested when the page opens; history from recorder · no depth packet yet | ◐ 5-level depth only |
| 30 | Watchlist | `/watchlist` — multiple lists, spot/futures/options, live quotes, trade from list | feed, else REST quotes · not streamed and REST fails | ✅ |
| 31 | Alerts | `/alerts` — underlying price, option premium, ATM IV, PCR, option OI change %, strategy MTM, ORB break, order flow | live values; ORB / order flow from recorder · condition not evaluated while its input is blank | ✅ |
| 32 | Calculators | `/calculators` — BS price & Greeks, IV from premium, F&O charges | user input (no market data) | ✅ |
| 33 | Classroom / learning | `/learn` — original text lessons linked to the tools | — | ◐ text lessons, no videos |
| 34 | Market dashboard | `/` — index cards, derivatives snapshot, build-up counts, gainers/losers/OI gainers, ORB, order flow, FII/DII | feed / REST / recorder / EOD · each card blank independently | ✅ |
| 35 | Light / dark theme, mobile app | Dark & light themes, responsive layout with bottom tab bar, installable PWA with offline shell | — | ◐ PWA (see gaps) |
| 36 | Login | Email + password accounts, guest mode, guest → account upgrade keeps data | — | ◐ |
| 37 | Strategy Repair | — | — | ✗ not built |
| 38 | Live exchange data | Kotak Neo SFeed + REST, NSE/BSE EOD files; feed chip and `/api/health` show the state | requires the user's Kotak Neo credentials in `.env` | ✅ (needs credentials) |
| 39 | Broker execution | — | — | ✗ paper only by design |
| 40 | Free / Pro / Pro+ plans | All tools unlocked | — | ✗ not built |
| 41 | Opening range breakout (user request) | `/orb` — 5/15/30-min ranges, close or touch rule, whipsaw & failed-breakout flags, scanner, session record, ORB alerts | recorder 1-minute bars; Kotak 1-minute history for listed instruments (recent sessions) · before the range ends / range not recorded | ✅ |
| 42 | 1-minute order flow (user request) | `/order-flow` — last completed minute, current minute, last 5 min, session, delta & cumulative delta, unclassified share | quote-rule classification of live ticks by the recorder (**estimate**, labelled) · not subscribed / no ticks; only meaningful if the feed is per trade | ✅ (estimate) |
| 43 | Algo strategies (user request) | `/algo` — algo registry, parameters, one-day and multi-session backtests, live paper deployment; Strategy 2 (₹20 ladder), Strategy 3 (₹50 ladder) | live runs on the live chain through the paper broker; **backtests replay recorded sessions only** · no recorded session | ✅ (paper only) |

## Known gaps and why

1. **Not yet exercised against the real endpoints.** The Kotak and NSE/BSE clients are built and tested from
   the published documentation, SDK test vectors and sample files; the development sandbox could not reach them.
   See the Status section of [live-data/DESIGN.md](live-data/DESIGN.md) for the unconfirmed items.
2. **History starts with recording.** Intraday history exists only for sessions the server recorded while
   running (and Kotak 1-minute history for still-listed contracts); multi-day history only for the official
   files loaded (`EOD_BACKFILL_DAYS`).
3. **Real order execution.** Only the paper broker exists, by design; no order is sent to Kotak.
4. **Native store app.** The web app is an installable PWA; publishing to Google Play can be done with a
   Trusted Web Activity (Bubblewrap) — see README. No signed APK is produced by this repository.
5. **Order-book depth.** Kotak's feed provides 5-level depth; 20-level/full-depth analytics are not available.
6. **Strategy Repair, subscriptions, OTP login, video classroom** are not implemented.

## Reference notes

- Lot sizes, strike steps and expiries come from the Kotak instrument master (and, for expired contracts, the
  official F&O file of their last day); nothing is hard-coded per contract. The reference stock list and sector
  labels in `apps/server/src/live/kotak/scripmaster.ts` are metadata only.
- Exchange holidays come from NSE's holiday master plus the `HOLIDAYS` env list.
