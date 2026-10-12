# Live-data architecture (no synthetic data)

Owner requirement (2026-10-12): the program runs **only on live data**. Where live or official data is not
available, the value/tab is **blank** with the reason shown. The simulator, the demo clock and every
synthetic value are removed. Paper trading stays paper (no real orders are sent to the broker).

Research this design is based on: `docs/live-data/research/` (Kotak REST/auth, Kotak SFeed websocket,
NSE/BSE public files, the app dependency map, and a critic's reconciliation of all four).

## 1. Principles

1. **Source or blank.** A service either returns a value derived from a live/official source or throws
   `NoLiveData(reason)` (HTTP 503, `{ error, code: 'NO_LIVE_DATA' }`) / returns `null` for that field.
   No defaults that look like data (no 50/50 splits, no zero OI, no model IV, no synthetic bid/ask).
2. **Derived ≠ synthetic.** Computations on real inputs are allowed and labelled: IV and Greeks solved
   from market premiums, PCR, max pain, build-up, margin estimate (SPAN-style formula, labelled
   "estimate"), tick-rule buy/sell classification of real trades (labelled "estimated from live ticks").
3. **History only from real records.** Intraday history comes from the app's own recorder (from the
   day it starts recording) and from Kotak historical candles for **active** contracts. Multi-day history
   comes from official NSE/BSE end-of-day files. Before data exists the screen says so.
4. **Credentials** come from `.env` (`NEO_CONSUMER_KEY`, `NEO_MOBILE_NUMBER`, `NEO_UCC`, `NEO_MPIN`,
   `NEO_TOTP_SECRET`). They are never logged, returned by an API or written to disk elsewhere.
5. **Rate-limit safety first.** One global token bucket for Kotak REST (≤10 req/s, ≤300/min, ≤5000/h);
   historical + option-chain + expiries ≤ 1 call / 1.5 s; honour `Retry-After`; never retry-loop logins.

## 2. Components

```
apps/server/src/live/
  types.ts                 shared contracts (MarketDataProvider, LiveQuote, NoLiveData, …)
  env.ts                   reads/validates NEO_* env (never logs secrets)
  kotak/
    totp.ts                RFC 6238 (SHA1, 30 s, 6 digits, base32)
    session.ts             tradeApiLogin → tradeApiValidate, baseUrl/feedUrl, re-login on 401/403/1003
    ratelimit.ts           global token bucket + slow lane for historical/option-chain/expiries
    rest.ts                quotes (≤50/call), option-chain, expiries, historical, scrip-master paths
    scripmaster.ts         daily CSV download + parse (trimmed headers, `dStrikePrice;`/100, NSE epoch)
    sfeed/protocol.ts      SFeed native_batch: JSON control frames + little-endian binary decoding
    sfeed/client.ts        ws client: auth, subscribe/unsubscribe (≤2,700 tokens), reconnect, ping
  nse/
    http.ts                browser-like headers, cookie warm-up, timeouts, zip (fflate)
    bhavcopy.ts            NSE FO/CM UDiFF bhavcopy, BSE FO bhavcopy → DailyOption/DailyFuture/DailyBar
    indices.ts             ind_close_all (index daily closes)
    participants.ts        fao_participant_oi / vol (contracts → units via lot size where needed)
    fiidii.ts              fiidiiTradeReact (unofficial JSON; blank when blocked)
    holidays.ts            holiday-master (unofficial JSON) + HOLIDAYS env
  store/
    intraday.ts            per-date minute records on disk (DATA_DIR/market/YYYY-MM-DD/…)
    history.ts             EOD store on disk (DATA_DIR/eod/…)
  recorder.ts              ticks → minute records (+ chain aggregates), session open/close jobs
  calendar.ts              real exchange calendar (weekends + holidays)
  clock.ts                 real IST clock only (pre-open / open / closed)
  pricing.ts               forward (future / parity / spot), IV solver, Greeks, ATM IV
  provider.ts              assembles everything into MarketDataProvider; start/stop; health
```

Removed: `market/engine.ts`, `market/flows.ts`, `market/clock.ts` (demo), the synthetic parts of
`market/universe.ts` (lot sizes/strike steps/prices; the symbol list + sector labels stay as reference
metadata), `CLOCK_MODE`/`SIM_*`/`MARKET_SEED` config, every "simulated" text in the UI and docs.

## 3. Capacity plan

| Channel | Use |
|---|---|
| SFeed websocket (≤2,700 of 3,000 tokens) | 6 index spots + INDIA VIX, near futures of all underlyings, index option chains (2 nearest expiries, ±8 % strikes, re-centred), every user contract (orders, positions, strategy legs, alerts, watchlists, running algos), depth for open Order Book views |
| REST option-chain sweep | Stock options: one call per stock per sweep at ≥1.5 s spacing (≈90 s refresh for ~58 stocks). Also gives prev OI / prev close. |
| REST quotes | On demand only (≤50 instruments per call) for instruments not streamed |
| Kotak historical | On demand, ≤1 call / 1.5 s, cached; active contracts only |
| NSE/BSE files | Once per day after publication (≈18:00–23:30 IST) with retries; backfill on start |

## 4. Per-tab behaviour

| Tab | Live source | Blank when |
|---|---|---|
| Ticker / clock | SFeed index packets; status from IST time + holiday calendar | not logged in / no ticks |
| Home | index quotes, futures movers (live), 3 chains, ORB (recorder), flow (tick-classified), FII/DII (EOD) | each card independently |
| Option Chain | SFeed/REST chain + local IV/Greeks; prev OI from option-chain or bhavcopy | chain not available |
| Watchlist | live quotes | instrument not streamed and REST fails |
| Synopsis / Scanners / Unusual | live futures + stock option sweep; prev IV/OI from bhavcopy | before first sweep |
| FII/DII, Participants | NSE files (EOD) | file not published/blocked |
| ORB | recorder 1-min bars; Kotak 1-min for history (active instruments) | before 09:30 / no bars |
| Order Flow | tick-rule classification of live trades (estimate, labelled) | feed not per-trade / not subscribed |
| OI tools (strikes, multi-strike, trend, PCR, max pain) | live chain; intraday series from recorder; daily PCR from bhavcopy | no recording yet for that window |
| Futures OI, Breadth | live futures; history from bhavcopy | — |
| IV chart / IVP / Skew / Surface / Cone | IV solved from live premiums; daily IV from bhavcopy premiums; closes from EOD files | not enough history |
| Builder / Templates / Optimizer | live chain + local IV | chain not available |
| Straddle / Strategy chart | recorder or Kotak 1-min (active contracts) | expired, unrecorded |
| Trade Recap | recorder only | date before recording started |
| Positions / Strategies / Alerts / Watchlists | paper broker fills at live bid/ask; settlement from bhavcopy | no live bid/ask → order rejected |
| Algo | live paper runs on live chain; backtests on recorded sessions only | no recorded sessions |
| Order Book | SFeed depth (5 levels) | not subscribed / no depth |
| Calculators / Learn / Settings | — | — |

## 5. Phases

A. Clients and stores (independent): Kotak (auth, REST, scrip master, SFeed), NSE/BSE EOD, stores +
   recorder + calendar + clock + pricing. Unit-tested against documented samples and SDK test vectors.
B. Provider facade + config/env; server boots without the simulator and reports health.
C. Services rewired to the provider (analytics, market tools, pricer, broker, strategies, alerts,
   watchlists, algo, routes, websocket); engine deleted; tests use a test-only provider fed with
   documented sample payloads (tests are not a program mode).
D. Web: connection status, blank states with reasons, removal of simulated wording.
E. Adversarial review: "no synthetic value anywhere", protocol correctness, rate limits, secrets.

## 6. Network allowlist (deployment)

`*.kotaksecurities.com` (HTTPS + WSS), `nsearchives.nseindia.com`, `archives.nseindia.com`,
`www.nseindia.com` (FII/DII + holidays, unofficial JSON), `www.bseindia.com` (SENSEX/BANKEX EOD).
