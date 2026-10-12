# Completeness critic: running QUANTSAPP26 on live Kotak Neo data plus public NSE/BSE data only

Date: 2026-10-12. This report reviews the four research reports in `live-research/`:

| Short name | File |
|---|---|
| **REST** | `kotak-auth-rest.md` |
| **WS** | `hsm-websocket.md` |
| **NSE** | `nse-bse-public-data.md` |
| **MAP** | `app-dependency-map.md` |

No Kotak or NSE endpoint was called, and `.env` was not read. Kotak, NSE, niftyindices and kotakneo hosts fail DNS from both Bash and WebFetch in this sandbox.

New primary evidence gathered for this review:

- **Official Kotak docs repo `Kotak-Neo/Kotak-Neo` at `65a67e5` (2026-10-08).** WS cloned it but used only `websocket.md` and `authentication.md`. REST did not use it at all. I read every file in it: `troubleshooting.md`, `static-ip-whitelisting.md`, `market-data-apis/{quotes,instruments,expiries,option-chain,historical-data,websocket}.md`, `portfolio-and-funds-apis/*`, `order-report-apis.md`. Path: `live-research/hsm-websocket/repos/Kotak-Neo/docs/`.
- **`pip download kotakneoapi`.** The latest release on PyPI is still **3.0.7** (`pip index versions` lists 3.0.7, 3.0.6, 3.0.1, 3.0.0). I diffed it against GitHub `main` 3.0.9. The wheel is at `live-research/critic/dl/pip/`.
- **A 2026 Kotak scrip-master sample from GitHub.** `raw.githubusercontent.com/LRC24/Kotak-Neo-Hybrid-Algorithmic-Trading-Platform/main/data/nse_fo.csv` contains a FEDERALBNK 30-Jun-2026 contract. Saved to `live-research/critic/dl/scrip/`.
- **Re-reads of the NSE library sources and the openalgo Kotak streaming code** already in the scratchpad.

---

## 1. Contradictions between reports, and how each was resolved

| # | Topic | What the reports say | Resolution (primary source) | Status |
|---|---|---|---|---|
| C1 | `feedUrl` / `rtUrl` in the `tradeApiValidate` response | **REST §1.3**: present but "**UNCONFIRMED**", not in the documented sample. **WS §2.2**: "the official doc says `data` contains `feedUrl` and `rtUrl`". | Official `market-data-apis/websocket.md` §2 (lines 50–70) shows `data.{sid, baseUrl, feedUrl, rtUrl}` and says to use `feedUrl` with `https→wss`. Official `authentication.md` leaves both out of its field table. SDK 3.0.7 `services/totp.py:67-68` reads `data.get("feedUrl")` and `data.get("rtUrl")`. Treat both as **documented but optional**. URL precedence in the SDK is config service → `feedUrl` → `wss://sfeed.kotaksecurities.com/apifeed`. | **RESOLVED** (documented). Whether they are present on a live account is still to be checked on day 1. |
| C2 | REST rate limit | **REST §4**: quotes allow **25 req/s** and ≤50 instruments per call (SDK doc). For historical, option-chain and expiries, budget about 1 req/s (community). | The official `troubleshooting.md` Q24 (line 148) says "**10 requests/second** across APIs". The SDK doc `docs/functions/market_data/quotes.md:36-51` says 50 instruments per call and 25 req/s. The SDK's optional client-side limiter (`rate_limiter.py:153-160`) defaults to **10/s, 300/min, 5000/h**; its docstring cites "account suspension due to excessive requests". | **CONFLICT between two official sources.** Design to the stricter limits: one global token bucket of 10/s, 300/min and 5000/h; historical, option-chain and expiries together ≤1 call per 1.5 s; honour `Retry-After`. The real backend quotas are UNCONFIRMED. |
| C3 | Meaning of quote fields `total_buy`, `total_sell` and `last_volume` | **REST §4**: total buy qty, total sell qty, day volume (from the SDK doc). | Official `quotes.md:110-112` says "Top bid quantity", "Top offer quantity" and "Most recent trade volume". The SDK doc (`quotes.md:177-179`) says "Total buy quantity" and "Total volume traded". The sample numbers support the SDK: `total_buy 907335` against `depth.buy[0].quantity 1733`, and `last_volume 30043533` against `last_traded_quantity 550`. | **CONFLICT inside official docs.** Use the SDK reading, but prefer the WS fields `total_buy_qty`, `total_sell_qty` and `volume_traded_today`. Verify on day 1. |
| C4 | Quote filter names | **REST**: `market_depth`, `52w` (SDK). | Official `quotes.md` gives `depth` and `52W`. | **CONFLICT.** Only call `/all`, which both sources accept. |
| C5 | Index names for MIDCPNIFTY and BANKEX | **REST §3.3**: **UNCONFIRMED**. **WS §4.3**: lists `NIFTY MID SELECT` from the legacy doc. | Official `quotes.md` §7 glossary (lines 162–299): nse_cm `Nifty 50`, `Nifty Bank`, `Nifty Fin Service`, **`NIFTY MID SELECT`**, `Nifty Next 50`, `INDIA VIX`; bse_cm `SENSEX`, **`BANKEX`**, **`SNSX50`** (Sensex 50). Line 20 says names are "**exact case-sensitive**". | **RESOLVED** for REST quotes. For WS, names are accepted ("token may be … an index/instrument name", websocket.md §4); the doc example also uses numeric `nse_cm\|26000`. |
| C6 | Expiry epoch decoding in the scrip master | **REST §3.2**: `unix = v + 315513000`; bse_fo/mcx_fo as plain Unix is **UNCONFIRMED**. | Official `instruments.md:83-84`: "nse_fo and cde_fo: Add **315511200** … convert it to IST. mcx_fo and bse_fo: Epoch can be directly converted". On the 2026 sample, `1467297000` gives 2026-06-30 14:00 IST with Kotak's constant and 14:30 IST with REST's; both are the same date (a Tuesday, the June monthly expiry). | **RESOLVED.** Take only the **date**, and use the official constant. bse_fo plain-Unix is now **CONFIRMED**. |
| C7 | Index tokens: name or numeric | **REST**: use names; whether `nse_cm\|26000` works on REST is UNCONFIRMED. **WS**: the official example uses `subscribeIndices nse_cm\|26000`, and packets carry the numeric token. | REST quotes: names (official, line 20). WS: either works per the official doc. Numeric tokens for BSE indices are not documented anywhere. | **Partly resolved.** Subscribe to indices **by name**. Map the returned numeric token to the name with the 1109 ack, or with the known NSE codes 26000, 26009, 26037 and 26074 from the legacy `nse_cm.csv`. BSE numeric codes: UNCONFIRMED. |
| C8 | How the 3000-token WS budget is counted | **WS §4.5**: the SDK counts `(token, intent)`, so one token under two intents counts twice. | Official `websocket.md` "Subscription limit": "running total across every subscribe request … Re-subscribing an already-subscribed token does not count twice". It is silent on the same token under a *different* intent. | **AMBIGUOUS.** Count conservatively per `(token, intent)`. |
| C9 | Auth success code 1117 or 1119 | Internal to WS: the doc says 1119 "does not by itself indicate success"; the SDK treats 1119 as success. | Both are official. | **Open.** Store dividers on either code. Mark the connection authenticated on 1117, or on 1119 if no 1120 or close arrives within about 3 s. 15 s auth timeout. |
| C10 | Headers on session (portfolio/report) APIs | **REST §2**: `Sid` + `Auth` (+accept), and the SDK sends no `neo-fin-key`. | Official `positions.md`, `order-report-apis.md` and troubleshooting Q8: `Auth` + `sid` + **`neo-fin-key: neotradeapi`** (+ `accept`, form content type). Quotes and scrip master take `Authorization` only, with **no** `neo-fin-key` (Q3, Q8). | **RESOLVED**: send `neo-fin-key` on session APIs. The app does not need these APIs for paper trading anyway. |
| C11 | Positions path | **REST §7**: `portfolio/v2/positions` (SDK 3.0.9) and older `quick/user/positions`. | PyPI 3.0.7 `settings.py:12` and the official `positions.md` both use `GET quick/user/positions`. Only unreleased 3.0.9 uses `portfolio/v2/positions`. | **RESOLVED**: `quick/user/positions` (low priority). |
| C12 | `baseUrl` shape | **REST/WS**: treat it as a host such as `https://eXX.kotaksecurities.com`. | Official examples: `"baseUrl":"https://cis.kotaksecurities.com"` (authentication.md) and **`https://neo-gw.kotaksecurities.com/xyz`** (troubleshooting Q7: "Final URL … `/xyz/quick/order/cancel`"). baseUrl "is **stable for the day**" (Q5). | **RESOLVED.** `baseUrl` may carry a **path prefix**. Join it with string concatenation and trim `/`. Do **not** use `new URL('/path', base)`, which drops the prefix. |
| C13 | OI and volume units across sources | **WS**: units UNCONFIRMED. **NSE**: bhavcopy OI in units, volume in contracts; NSE option-chain JSON OI in contracts; participant files in contracts; BSE volume in units. **MAP**: `LiveQuote.volume` units UNCONFIRMED. | Official Kotak `option-chain.md` sample: ATM NIFTY CE `openInterest.current 10715645` with `mktLot 65` (164,856 lots) and `volume 225431505`; NIFTY fut `oi.cur 13930930` (214,322 lots). Read as contracts, those numbers would be absurd. | **Strong inference: Kotak OI and volume are in quantity (units).** Store everything in units together with the lot size, and convert NSE contract-based files on ingest. |
| C14 | MAP sizing vs the WS cap | **MAP §11**: the recorder would watch about 3,300 contracts (2,938 snapshot + 64 spot + 64–192 futures + user contracts). **WS**: 3000 tokens. | Arithmetic (§4 below). | **Infeasible on one socket.** A hybrid WS + REST plan is required (§4). |
| C15 | Historical candles for past sessions | **MAP §8/§14**: "UNCONFIRMED whether Kotak offers historical intraday option candles". **REST §5**: yes, nse_fo works (community). | Official `historical-data.md:21,120`: "Only **active contracts with a valid neo symbol** return historical data — **expired or delisted instruments will not**." Segments are nse_cm, nse_fo, bse_cm, bse_fo only. The `oi` column is "Phase 1: not yet populated". | **RESOLVED, with a major limit.** No Kotak data exists for expired weekly or monthly options. Every backtest, recap or OI history on expired contracts must come from the app's own recorder (or EOD bhavcopy). |
| C16 | Market-data calls before 2FA | **REST §2**: "docs say no 2FA needed; the e2e test says call after validate". | Official expiries.md:96 and option-chain.md:233: "Authorization header alone … a completed 2FA (TOTP) session is not required". Troubleshooting Q6: Quotes and Scripmaster use `baseUrl`, which only comes from validate. | **RESOLVED**: call them after validate, on `baseUrl`, with `Authorization` only. |
| C17 | Config-service request headers | **REST**: no auth headers. **WS**: `Content-Type: application/json`. | SDK `neo_utility.py:191-201` sends no auth headers, and the transport adds the JSON content type. | **Consistent.** Not a real conflict. |
| C18 | Live India VIX | **NSE §7**: live VIX "from Kotak (out of scope)". **REST**: lists `INDIA VIX`. | Official glossary: `nse_cm \| INDIA VIX`. | **RESOLVED.** |

---

## 2. UNCONFIRMED items that matter for implementation

### 2a. Resolved in this review (with evidence)

| # | Item (which report left it open) | Finding | Evidence |
|---|---|---|---|
| R1 | `feedUrl` / `rtUrl` (REST) | Documented; read them if present | C1 |
| R2 | Index names for MIDCPNIFTY, BANKEX, SENSEX 50 (REST) | `NIFTY MID SELECT`, `BANKEX`, `SNSX50`, case-sensitive | C5 |
| R3 | REST quote shape for indices (REST §4) | Same keys as equities. `exchange_token` = index name. `display_symbol` like `SENSEX-IN`. `ohlc.close` = previous close. `total_buy`, `total_sell`, `last_volume`, `year_high`, `year_low` and the depth arrays come back as `"0"`. | Official quotes.md sample (lines 66–97) |
| R4 | bse_fo expiry epoch (REST) | Plain Unix seconds | instruments.md:84 |
| R5 | Historical coverage and limits (MAP, REST) | Active contracts only. 1/3/5 min ≤30 days, 10/15 min ≤60, 30/60 min ≤90, D and W ≤180. OI not populated. Pipe may be literal or `%7C`. | historical-data.md |
| R6 | Session coexistence (REST §1.6: "whether a new login invalidates older sessions") | "You can create **multiple sessions**" (static-ip FAQ, line 330). Resetting the access token "**immediately invalidates** all sessions" (troubleshooting Q1/Q2). | Official |
| R7 | Static-IP requirement | IP validation applies to place/modify/cancel orders **only**. "Data APIs" and "Websocket streams … continue to work normally regardless of IP" (static-ip-whitelisting.md:60-69). **The app places no real orders, so it needs no static IP.** | Official |
| R8 | 2026 scrip-master header (REST §3.2) | A real 2026 `nse_fo.csv` sample (FEDERALBNK, expiry 30-Jun-2026) has the **identical 78-column header**: trailing spaces, `dStrikePrice;`. `dStrikePrice; 23000` = ₹230.00 (×100 confirmed). `pScripRefKey` looks like `FEDERALBNK30JUN26230.00CE`. **Caution:** that sample's single data row has **80 fields** against 78 header fields (the 2023 official samples are 78/78 for all 58,741 rows). It is probably a hand-edited file. Still, validate row width and sanity-check values (`pExchSeg` in the known set, numeric `pSymbol`), and reject the file if they fail. | `critic/dl/scrip/lrc_nse_fo_full.csv` (third-party copy of a Kotak file) |
| R9 | Kotak OI and volume units (WS, MAP) | Units (strong inference) | C13 |
| R10 | NSE CM (stock) daily bhavcopy URL (missing from NSE; needed for stock OHLC history, HV, cone, breadth) | `GET https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_{YYYYMMDD}_F_0000.csv.zip` (UDiFF, from 2024-07-08). Legacy: `…/content/historical/EQUITIES/{YYYY}/{MMM}/cm{DD}{MMM}{YYYY}bhav.csv.zip`. Also `…/products/content/sec_bhavdata_full_{DDMMYYYY}.csv`. | `nse` 5.1.0 `NSE.py:345-355`; `nselib` `capital_market_data.py:364,387`; `jugaad_data/nse/archives.py:204` |
| R11 | Holiday source | Kotak has **no** holiday API (grep of SDK and official docs). The official source is the yearly NSE circular PDF on `nsearchives.nseindia.com/content/circulars/` plus ad-hoc circulars. `www.nseindia.com/api/holiday-master?type=trading` is the unofficial JSON. For live open/close status, SFeed `subscribeExchange` (code 105) is a genuine real-time source. | Grep; NSE circular search result (`CD71962.pdf` is the 2026 currency-derivatives list; the equity circular PDF was not retrieved) |
| R12 | Alternate feed host (WS §2.4 "ks") | `cdtstream.kotaksecurities.com/mfeed` speaks the same little-endian native_batch protocol (third-party openalgo, `kotak_websocket.py:45-51`). It is covered by `*.kotaksecurities.com`. | Third-party, so still **UNCONFIRMED** |
| R13 | SDK version | PyPI latest = 3.0.7. GitHub `main` = 3.0.9. `utils/urls.py`, `services/totp.py` and `websocket/feed/protocol.py` are byte-identical between them. | `pip index versions`, diff |
| R14 | Error codes to handle | Quotes, expiries and option-chain errors: `{"stat":"Not_Ok","emsg":"Invalid instrument/code","stCode":1009}`. Session invalid: `stCode 1003 "Invalid session"` (margins.md). Login errors: `{"status":"error","message":…,"errorCode":"401"}`; 424 means dependency error, retry. Historical: `{"status":"ERROR","fault":{code,message}}`. | Official docs |

### 2b. Still UNCONFIRMED and critical. Each needs a day-1 live check (the probe is in the last column)

| # | Item | Why it matters | Day-1 probe (with the owner's credentials, on the production host) |
|---|---|---|---|
| U1 | Session and JWT lifetime. No official statement; baseUrl "stable for the day". | Re-login scheduling | Decode the trade-token payload and log `exp` and `iat`. Watch for 401 / `stCode 1003`. |
| U2 | Real backend quotas (10/s vs 25/s; any per-minute or per-hour quota; the multi-hour historical lockouts reported in community issue #35) | REST polling design (§4) | Read the `X-RateLimit-*` and `Retry-After` headers on the first responses and log them. |
| U3 | Does the WS 3000-token cap apply per connection or per user? Are several feed connections allowed? | Whether the stock snapshot universe can go over WS | Open a second connection and subscribe disjoint sets. Log close codes and 1120. |
| U4 | Feed granularity: does a packet arrive per trade or conflated? | Whether order flow can even be estimated | Compare Δ`volume_traded_today` against `last_trade_qty` across consecutive L4 packets of a liquid future. |
| U5 | 1117 vs 1119; 1109 ack shape; failed-auth behaviour | Connection state machine | Log raw text frames. |
| U6 | Depth rows at L8 (expected 5+5) and at L16 | Order Book tab | Log `buy_depth_count` and `sell_depth_count`. |
| U7 | WS timestamps (epoch seconds expected) | Recorder minute bucketing | Compare LTT with wall clock. |
| U8 | Kotak historical for indices: `nse_cm\|26000`, or the name? BSE indices? | Index candles, ORB history, cone on day 1 | One call each, 1 s apart. |
| U9 | Maximum `count` on option-chain | Snapshot sweep coverage | Try `count=100`, `200`. |
| U10 | `bse_fo` `pInstType` values and `pSymbolName` for SENSEX, BANKEX and SENSEX 50 | SENSEX/BANKEX chains | Inspect the live `bse_fo.csv`. |
| U11 | Whether NSE archives are reachable from the deployment IP (Akamai; 403s from datacenter IPs reported), and whether `www.nseindia.com/api` accepts Node's TLS fingerprint | Every EOD backfill; FII/DII; holiday JSON | `curl` with browser headers from the production host. |
| U12 | `fiidiiTradeReact` still live in Oct 2026 (both `nselib` 2.5.1 and `nsepython` 2.101 still call it; a third-party report says it 404s) | FII/DII tab | One GET after cookie warm-up. |
| U13 | Expiry-day `SttlmPric` = final settlement price (NSE §2 inference). Final settlement for index options (exchange specs say the closing index value on expiry day; not verified here). Stock F&O is physically settled. | Paper settlement of expired legs | Compare the bhavcopy row against the NSE final-settlement circular for one expiry. |
| U14 | NSE/BSE publication times; BSE bhavcopy units and path case | Scheduler | Log the first-200 time per file for a week. |

---

## 3. Remaining gaps that block or degrade specific tabs

Severity scale:

- **BLOCKED**: no genuine source exists; the feature must be removed, or rebuilt on clearly labelled estimates.
- **HISTORY-LIMITED**: works live; history exists only from the recorder's start date (plus EOD backfill where noted).
- **OK**: every input has a genuine source.

| Tab (route) | Live source | History source | Gap | Severity |
|---|---|---|---|---|
| Shell ticker and clock | WS `subscribeIndices` (names). Status from SFeed market-status (105) plus the holiday calendar. | n/a | Holiday calendar needs the NSE circular (manual or PDF parse) or the unofficial `holiday-master`. Ad-hoc holidays (e.g. election days) arrive by circular. | OK (calendar is an ops task) |
| Home `/` | Index quotes, futures movers, 3 chains (WS) | 5-min candles: recorder, or Kotak 5min for stocks/futures | (a) **flow** card (buy/sell split): no genuine source; see Order Flow. (b) FII/DII last 5 days: unofficial API, history only from recording start. (c) Index candles depend on U8. | Flow **BLOCKED**; FII/DII HISTORY-LIMITED |
| Option Chain | WS L4: LTP, OI, volume, bid/ask/qty, prevClose. prevOi from the previous day's NSE FO bhavcopy `OpnIntrst` (full chain) or Kotak option-chain `openInterest.previous` (±count strikes). IV and Greeks computed locally. Carry from the same-expiry future or put-call parity. | — | Full-chain coverage competes for the token budget (§4). Weekly expiries have no future, so use parity. | OK |
| Watchlist | WS / REST quotes | — | none | OK |
| Synopsis | Stock futures and ATM options (WS/REST). Turnover from the WS `total_traded_value` field (real; replaces the synthetic `bar.volume×f×ltp`). | prev IV from bhavcopy | Budget (§4) | OK |
| FII/DII | `www.nseindia.com/api/fiidiiTradeReact` (unofficial JSON, latest day only, Akamai, NSE ToU forbids automated collection) | **No official archive found.** NSDL FPI archive covers FPI only (different numbers). DII has none. | 10/30/60/120-day views cannot be filled on day 1, and the only source breaches the NSE ToU and may be blocked from a server. | **HISTORY-LIMITED, with a policy risk.** Owner must accept the unofficial API or drop or relabel the tab. |
| Participants | NSCCL `fao_participant_oi_{DDMMYYYY}.csv` / `_vol_` (official) | Backfill years | Publication about 19:00–23:30 IST. Map columns by header. | OK |
| ORB | Recorder 1-min bars from WS ticks (all 64 symbols) | Stocks: Kotak `1min` (≤30 days, active) gives the 20-session history. Indices: U8. | Live ORB scan cannot poll the historical API (rate limits), so a recorder is mandatory. | OK for stocks; indices HISTORY-LIMITED unless U8 passes |
| Order Flow | **Neither Kotak nor NSE publishes an aggressor buy/sell split.** The only genuine inputs are the L4 packets (LTP, LTQ, Δvolume, best bid/ask). | Recorder | A tick/quote-rule classification is an *estimate*, and only if U4 shows per-trade granularity. The simulator's version is pure synthesis. | **BLOCKED** as currently specified. Rebuild as an "estimated from ticks" view, or remove. |
| Strike OI | WS OI + prevOi baseline | "since open / N min ago" needs recorder minutes | none after the recorder runs from 09:15 | OK (HISTORY-LIMITED intraday on day 1) |
| Multi-Strike | OI series only from the recorder (Kotak candle `oi` not populated). Premium/IV series can come from Kotak 1-min for active contracts. | Recorder | Past dates before recording: no OI | HISTORY-LIMITED |
| OI Trend | Recorder chain aggregates per minute | Recorder | same | HISTORY-LIMITED |
| PCR | Intraday: recorder | Daily 60 days: NSE FO bhavcopy (full-chain OI per expiry), backfillable | none | OK |
| Max Pain | Live chain OI | Recorder | same as OI Trend | OK live, HISTORY-LIMITED history |
| Futures OI | WS L4 OI; prevOi from option-chain `instrument_type=fut` `oi.prev` or bhavcopy | — | none | OK |
| Breadth | Live futures | Bhavcopy IDF/STF OI + CM bhavcopy closes (R10) | none | OK |
| IV Chart | Intraday: recorder, or Kotak 1-min of ATM CE/PE (active contracts) + spot | Daily: IV solved on bhavcopy `ClsPric`/`SttlmPric` with `UndrlygPric`, forward from same-day futures | Index spot 1-min depends on U8 | OK (daily); intraday HISTORY-LIMITED |
| IV Rank / IVP table | Live ATM IV (solver) | 252 days from FO bhavcopy archives (about 252 zips, about 1 MB each) | none | OK |
| Skew | Live chain | prev-close from option-chain `prevClose` or bhavcopy | none | OK |
| Surface | Live chain, smile fitted over **listed** strikes | — | The current code samples non-listed strikes (`E.quotedIv`). Must interpolate a fit and say so in the UI. | OK (computed) |
| Cone | — | 504 daily closes: `ind_close_all` (NSE indices), CM bhavcopy (stocks), BSE FO bhavcopy `UndrlygPric` (SENSEX/BANKEX, close only), or Kotak `D` (180 days/request; indices U8) | none | OK |
| Builder / Templates / Optimizer | Live chain + solver | — | FUT leg must use the traded future LTP, not `legTheoPrice`. `riskFreeRate` is a user/config parameter (no market source researched). | OK |
| Straddle | Today: recorder, or Kotak 1-min per strike traversed (active) | Past days of an unexpired expiry: Kotak 1-min (≤30 days). Expired: recorder only. | expired expiries | HISTORY-LIMITED |
| Strategy Chart | Kotak 1-min for active legs + spot | same | expired legs | HISTORY-LIMITED |
| Trade Recap (`?at=` replay) | — | As-of chain at any past minute: **recorder only**. Expired legs: not in Kotak historical (C15). | Dates before recording cannot be replayed. | **BLOCKED before recording start**, OK afterwards |
| Positions (paper) | Fills at real L4 best bid/ask; reject when no bid/ask | Expiry settlement from bhavcopy (U13) | Margin: the core SPAN-style estimate is a model. Kotak `check-margin` is real but single-order only, needs a session, and gives no hedge benefit. NSE SPAN files were not researched. | OK (margin labelled as an estimate) |
| Strategies | Live leg LTPs | Settlement (U13) | none | OK |
| Alerts | PRICE, IV, PCR, OPTION_PRICE, OI_CHANGE, MTM, ORB: live or recorder | — | `ORDER_FLOW` kind inherits the Order Flow gap | Partly **BLOCKED** (one alert kind) |
| Algo | Live paper run: chain of one expiry (WS) | `backtestDay` for past dates and `backtestRange` (≤250 days): the chosen expiry has nearly always expired, and Kotak does not serve expired contracts. **Recorder only.** | Backtests are empty until sessions are recorded. A 250-day range needs about a year of recording. | **BLOCKED for past dates on day 1**, then HISTORY-LIMITED |
| Scanners | [FB], [Q], [IVT], [SNAP] universe (§4) | IV ids from bhavcopy; `orb-*` from recorder | Budget | OK with the §4 plan |
| Unusual | [SNAP] + prev OI/IV from bhavcopy | — | Budget | OK |
| Order Book | WS `subscribeDepth` (L8) for the viewed instrument only, or REST `/all` `depth` (5 levels). Circuits, ATP, total buy/sell qty, LTQ all real. | Depth history: recorder (only for instruments under depth subscription) | U6 | OK |
| Calculators, Learn, Settings, Tools, 404 | — | — | Text that mentions simulation must change (MAP §6.3) | OK |

### Cross-cutting gaps not covered by any report

1. **Universe reference data.**
   - The simulator's stock lot sizes (`lotSizeFor(price)`) and strike steps (`strikeStepFor`) are **synthetic heuristics**. Replace them with scrip-master `lLotSize` and steps derived from listed strikes.
   - The 58-stock list should come from the `OPTSTK` `pSymbolName` values in the scrip master. The full NSE F&O list is several times larger, which multiplies the §4 budget.
   - **Sector labels** are hand-coded. A genuine source is the NSE Indices constituent file (`ind_nifty500list.csv`, column "Industry") on `www.niftyindices.com/IndexConstituent/`. That host and path are **UNCONFIRMED**: DNS was blocked here.
2. **Risk-free rate** is a constant model input (`RISK_FREE_RATE=0.065`). Keep it as an explicit user parameter. No market source was researched; the RBI/FBIL T-bill curve is a candidate (**UNCONFIRMED**).
3. **Joining NSE bhavcopy rows to Kotak tokens.** Join on `(TckrSymb, XpryDt, StrkPric, OptnTp)`, not on `FinInstrmId` vs `pSymbol`. NSE tokens are reused over time, and token equality between the two was not verified.
4. **Tests.** Every server test asserts simulator values (MAP §9). A replay provider over recorded real sessions is needed before the engine can be deleted.
5. **NSE Terms of Use.** NSE §1.5 says the ToU forbids automated collection from the website. The archive files are low-frequency downloads, but `/api/*` polling (FII/DII, holidays, daily-reports) is a policy decision for the owner.

---

## 4. Capacity check (the binding constraint)

**Budgets:**

| Channel | Limit | Source |
|---|---|---|
| WS | 3000 tokens | Official |
| REST, all calls | ≤10 req/s | Official FAQ |
| REST, sustained (client defaults) | 300/min and 5000/h | SDK client defaults, not a documented backend limit |
| Historical / option-chain / expiries | ≤1 per 1.5 s | Community lockout reports |

**Indicative WS demand** (strike windows around spot; real strike grids are needed for exact numbers):

| Item | Tokens |
|---|---|
| Indices (6 + VIX) | 7 |
| Near futures for 64 underlyings | 64 |
| NIFTY, 2 weekly expiries, ±8 % at 50 steps | ≈320 |
| BANKNIFTY ±8 % / 100 | ≈180 |
| FINNIFTY | ≈170 |
| MIDCPNIFTY | ≈170 |
| SENSEX, 2 weeklies | ≈530 |
| BANKEX | ≈200 |
| **Index subtotal** | **≈1,640** |
| Stock snapshot (MAP measured, ±12 %) | ≈2,200 |
| **Total** | **≈3,840, over the 3000 cap** |

**Recommended split:**

- **WS (≤2,700, leaving headroom):**
  - indices
  - all near futures
  - index chains
  - every user contract (orders, positions, strategy legs, alerts, watchlists, running algos)
  - at most a few depth subscriptions for open Order Book views
- **REST option-chain sweep for stock options:**
  - One call per stock per sweep. 58 stocks at 1.5 s spacing gives about a 90 s refresh, about 2,300 calls/h. That fits under the 5000/h client default only if historical and quotes stay small.
  - Each call also returns `openInterest.previous` and `prevClose`, so the stock-option baseline comes free.
- **REST quotes, on demand only.** Use them for misses (≤50 per call), never as a 1 s poll.
- If U3 shows multiple WS connections are allowed, move the stock snapshot onto a second socket instead.
- **The recorder can only record what is subscribed.** OI history for stock options will therefore be about 90 s granular, not per-minute.

---

## 5. Consolidated network allowlist (production server, outbound TCP 443 unless noted)

**Required: Kotak Neo**

| Host | Purpose |
|---|---|
| `*.kotaksecurities.com` (HTTPS **and** WSS) | Recommended rule, because `baseUrl`, `feedUrl`, `rtUrl` and config-service endpoints are per account and per data center. The concrete hosts known today follow. |
| `mis.kotaksecurities.com` | `tradeApiLogin`, `tradeApiValidate`, `get-client-ip`, fallback REST base, `wss://…/realtime` |
| `cis.kotaksecurities.com` | baseUrl in the official sample (ADC) and order feed |
| `e21.kotaksecurities.com`, `e22.kotaksecurities.com`, `e41.kotaksecurities.com`, `e43.kotaksecurities.com` | Per-data-center baseUrl and `/realtime` (SDK constants) |
| `neo-gw.kotaksecurities.com` | Appears as a baseUrl example in the official troubleshooting doc (illustrative) |
| `lapi.kotaksecurities.com` | Scrip-master CSVs (`/wso2-scripmaster/v1/prod/<date>/…`, unauthenticated GET) and the config service (`/5config/config`) |
| `sfeed.kotaksecurities.com` | SFeed `wss://…/apifeed` |
| `cdtstream.kotaksecurities.com` | "ks" feed `wss://…/mfeed` (third-party observation) |

**Required: NSE**

| Host | Purpose |
|---|---|
| `nsearchives.nseindia.com` | FO and CM UDiFF bhavcopies, `ind_close_all`, NSCCL participant OI/volume, `fo_mktlots.csv`, `fii_stats`, circular PDFs (holidays) |
| `archives.nseindia.com` | Fallback mirror (never for `fo_mktlots.csv`) |
| `www.nseindia.com` (and bare `nseindia.com` for redirects) | Only if the owner accepts the unofficial JSON: `fiidiiTradeReact`, `holiday-master`, `daily-reports`, cookie warm-up pages |

**Required for SENSEX/BANKEX EOD**

| Host | Purpose |
|---|---|
| `www.bseindia.com` | `/download/Bhavcopy/Derivative/BhavCopy_BSE_FO_0_0_0_{YYYYMMDD}_F_0000.CSV` |

**Optional**

| Host | Purpose |
|---|---|
| `api.bseindia.com` | BSE index history JSON/CSV |
| `www.niftyindices.com`, `niftyindices.com` | `ind_close_all` mirror; index constituents and sectors |
| `www.fpi.nsdl.co.in` | FPI history |
| An NTP source on **UDP 123** (e.g. `time.google.com` or `pool.ntp.org`) | Clock sync for TOTP. Not HTTPS. |

**Not needed (do not open)**

| Host | Reason |
|---|---|
| `mlhsm.kotaksecurities.com` | Retired HSM feed |
| `d-mis.kotaksecurities.com`, `qapi.kotaksecurities.online`, `nsbxapi*` | UAT |
| `gw-napi`, `napi`, `mnapi`, `cnapi` | v1 APIs, retired 1 Oct 2025 |
| `kotakneo.com` | Documentation only |
| `api.ipify.org` | Only useful for static-IP order placement, which the app does not do |

**Build/dev only (not runtime):** `pypi.org`, `files.pythonhosted.org`, `registry.npmjs.org`, `github.com`, `raw.githubusercontent.com`.

---

## 6. Sources used in this review

**Official Kotak documentation** (`github.com/Kotak-Neo/Kotak-Neo` @ `65a67e5`, local path `live-research/hsm-websocket/repos/Kotak-Neo/docs/`):

- `authentication.md`
- `troubleshooting.md` (Q1–Q8, Q24)
- `static-ip-whitelisting.md`
- `market-data-apis/quotes.md`, `instruments.md`, `expiries.md`, `option-chain.md`, `historical-data.md`, `websocket.md`
- `portfolio-and-funds-apis/positions.md`, `margins.md`
- `order-report-apis.md`

**Official SDK:**

- PyPI `kotakneoapi` 3.0.7 (`live-research/critic/dl/pip/`)
- GitHub `Kotak-Neo/kotak-neo-python` @ `099e6a6` (3.0.9):
  - `utils/urls.py`, `utils/neo_utility.py`, `services/totp.py`, `services/scrip_search.py`, `rate_limiter.py`, `settings.py`
  - `docs/functions/market_data/*.md`
  - `tests/e2e/smoke_test.py`

**Third-party:**

- `LRC24/Kotak-Neo-Hybrid-Algorithmic-Trading-Platform` `data/nse_fo.csv` (2026 Kotak scrip-master copy)
- `marketcalls/openalgo` @ `12e1114` `broker/kotak/streaming/*`
- NSE libraries in `live-research/nse-bse-public-data/src/`: `nse` 5.1.0, `nselib` 2.5.1, `nsepython` 2.101, `jugaad-data` 0.35.10
- Web searches for NSE holidays 2026 and the FII/DII endpoints. Results: an NSE circular `nsearchives.nseindia.com/content/circulars/CD71962.pdf` (currency segment) and third-party holiday lists. No official FII/DII archive was found.

**Could not fetch** (DNS blocked for WebFetch):

- `www.kotakneo.com` PDFs and bulletins
- `www.niftyindices.com`
