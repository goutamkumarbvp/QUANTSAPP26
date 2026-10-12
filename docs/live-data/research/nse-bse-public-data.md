# Public NSE and BSE data for gaps in the Kotak Neo API

Research date: 2026-10-12. Scope: real public end-of-day (EOD) and reference data from NSE and BSE that the Kotak Neo Trade API v2 does not provide. Kotak still supplies live quotes, OI, depth, the scrip master and history.

## 0. Method and how far to trust this report

- **Sandbox limits.** This sandbox could not reach `*.nseindia.com` or `*.bseindia.com`, and the WebFetch tool could not either (`getaddrinfo ENOTFOUND`). No URL in this report was called live from here.
- **Primary evidence used:**
  1. **Library source code from PyPI**, read in full in `live-research/nse-bse-public-data/src/`:
     - `nse` 5.1.0 (BennyThadikaran/NseIndiaApi)
     - `nselib` 2.5.1
     - `jugaad-data` 0.35.10
     - `nsepython` 2.101 (its comments carry live-verification notes dated 2026-10)
     - `bse` 3.3.3
  2. **Real file contents mirrored on GitHub**, found with GitHub code search: actual UDiFF rows from 2025–2026, participant OI/volume files from 2026, `ind_close_all` from 2025, `fo_mktlots.csv` from Sep 2026, and raw `/api/daily-reports` JSON captures.
  3. **2026 third-party verification notes** saved in GitHub repos (cited per item).
- **How claims are labelled.**
  - Anything that rests only on third-party observation, or on my own inference from sample rows, is marked **UNCONFIRMED**.
  - NSE and BSE publish no official API documentation for the `www.nseindia.com/api/*` JSON endpoints. They are undocumented website back-ends, so all of section 7 and the JSON parts of sections 4–6 are unofficial by nature.
- **Where the raw material is saved.** Harvested sample rows are in `live-research/nse-bse-public-data/notes/sample-rows.txt`.

---

## 1. Shared access rules (NSE)

### 1.1 Hosts

| Host | Purpose | Access |
|---|---|---|
| `nsearchives.nseindia.com` | Main CDN for all daily report files: bhavcopies, `ind_close_all`, participant OI/volume, `fo_mktlots`, `fii_stats`, contract master | Plain HTTPS GET. Several 2026 reports got **HTTP 200 with only a browser User-Agent and no cookies** (ethosagent 2026-09-25, Adhi-opp 2026-07-07, sahilempire 2026-09). Others saw hangs or timeouts with Python `requests` (nsepython 2.101) and blocks of datacenter IPs on plain requests (thegowlikar/bujji). Treat it as "usually works with browser headers; keep a cookie-warm fallback". |
| `archives.nseindia.com` | Legacy mirror, often byte-identical (ethosagent: `ind_close_all` identical) | Fallback host. Caveat: `archives…/content/fo/fo_mktlots.csv` now **redirects to an unrelated PDF**, so always use `nsearchives` for that file (nsepython 2.101 comment). |
| `www.nseindia.com` | JSON APIs under `/api/...` and the HTML pages used to warm cookies | Sits behind **Akamai Bot Manager**. Needs cookies from a prior HTML page load (`nsit`, `nseappid`, `ak_bmsc`, `bm_sv`, `_abck`, …) and a `Referer`. nsepython 2.101 (2026-10) says plain `requests` and plain `curl` are blocked "purely on TLS fingerprint" and switched to `curl_cffi` Chrome impersonation. 403 on the homepage and 503 on `/api/historical*` were seen from datacenter IPs (ethosagent, sahilempire). |

### 1.2 Recommended request headers (Node/undici)

These combine `nse` 5.1.0, `nselib` and `jugaad-data`. NSE publishes no requirement, so the exact set needed is **UNCONFIRMED**.

```
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36
Accept: */*                                  (JSON calls: application/json, text/plain, */*)
Accept-Language: en-US,en;q=0.9
Accept-Encoding: gzip, deflate
Referer: https://www.nseindia.com/           (JSON calls: the HTML page that hosts the widget, see below)
Cookie: <jar from warm-up GET>               (needed for www.nseindia.com/api/*, optional for nsearchives)
```

Cookie warm-up pages that the libraries use (GET the HTML first, keep `Set-Cookie`, then call the API with that page as `Referer`):

| API | Warm-up page |
|---|---|
| option chain, contract-info | `https://www.nseindia.com/option-chain` |
| `fiidiiTradeReact` | `https://www.nseindia.com/reports/fii-dii` or `https://www.nseindia.com/reports-indices-fii-dii-trading-activity` |
| `historicalOR/vixhistory` | `https://www.nseindia.com/reports-indices-historical-vix` |
| `historicalOR/indicesHistory` | `https://www.nseindia.com/reports-indices-historical-index-data` |
| `historicalOR/foCPV` | `https://www.nseindia.com/report-detail/fo_eq_security` |
| `/api/reports`, `/api/daily-reports` | `https://www.nseindia.com/all-reports-derivatives` (jugaad-rs: `daily-reports` needs no warm-up) |

`nse` 5.1.0 uses a single warm-up GET of `https://www.nseindia.com/option-chain` for its whole session and sends `Referer: https://www.nseindia.com/get-quotes/equity?symbol=HDFCBANK`.

### 1.3 Rate limits

NSE publishes no rate limits.

- Library defaults:
  - `nse` 5.1.0: 3 req/s across API and files; retries on 429/502/503/504 with exponential backoff (max 8 s, 5 tries).
  - ethosagent: 500 ms spacing; 25 back-to-back archive GETs in 5 s were not throttled.
  - Axewatch: about 6 s between `www.nseindia.com` calls and claims "NSE's ~10 req/min bot threshold" (**UNCONFIRMED**).
- **Recommendation:**
  - Archives: one sequential request at a time with at least 500 ms gap.
  - `www.nseindia.com/api`: at most 1 request per 2–6 s, re-warm cookies once on 401/403/429, then back off for minutes.
  - Cache everything to disk, because EOD files never change after publication.

### 1.4 Failure modes to handle

- **Non-trading day or not yet published:** usually **404**. ethosagent saw a 404 with a 3.5 KB HTML body for `ind_close_all` on 2025-10-02 and 2025-09-27.
- **Wrong endpoint shape:** some routes answer **200 with an HTML error page**. jugaad-rs saw this for an old-style `ind_close_all` URL. mriddyagrawal saw the legacy F&O path return HTML after the UDiFF cutover.
- **Redirects:** finance-quote (Perl) disables redirects because "server redirects instead of 404".
- **Defences:**
  - Check `PK\x03\x04` magic for `.zip`.
  - Check the expected first header token for CSV (`TradDt`, `Index Name`, `""Participant wise`).
  - Never trust a 200 alone.

### 1.5 Terms of use

- NSE's Terms of Use (`https://www.nseindia.com/static/nse-terms-of-use`) **forbid systematic or automated collection** (scraping, data mining, harvesting) from the website or app.
- The archive files are published for download. Polling the `/api/*` JSON endpoints is plainly against the terms.
- Licensed alternatives are NSE Data & Analytics paid feeds and historical data.
- **Recommendation:** use only the low-frequency EOD archive files, once a day each. Do not poll `/api/*` in production.

---

## 2. NSE F&O daily bhavcopy (UDiFF)

**URL (official, current):**

```
GET https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_{YYYYMMDD}_F_0000.csv.zip
e.g. .../BhavCopy_NSE_FO_0_0_0_20261009_F_0000.csv.zip
```

- **Format:** ZIP containing one CSV, `BhavCopy_NSE_FO_0_0_0_{YYYYMMDD}_F_0000.csv`.
  - Size is about 1 MB zipped (nseepana).
  - 28,550 rows on 03-Sep-2025 (sahilempire).
- **Sources:** `nse` 5.1.0 `fno_bhavcopy()`, `nselib` `fno_bhav_copy()`, `jugaad-data` `bhavcopy_fo_udiff_raw()`.
- **Format history:**
  - UDiFF is mandatory from **2024-07-08**. Legacy files were discontinued under NSE circular **NSE/MSD/62424 dated 12-Jun-2024** (cited by javatarz/wealth-tracker).
  - UDiFF files may exist from about Jan-2024 in parallel (ethosagent "verified 03-01-2024" for CM, **UNCONFIRMED** for F&O).
- **Legacy (pre-2024-07-08):**
  - URL: `https://nsearchives.nseindia.com/content/historical/DERIVATIVES/{YYYY}/{MMM}/fo{DD}{MMM}{YYYY}bhav.csv.zip` (MMM in upper case, e.g. `JAN`). Verified 200 for 2003, 2008, 2015 and 2020 (sahilempire).
  - Columns: `INSTRUMENT,SYMBOL,EXPIRY_DT,STRIKE_PR,OPTION_TYP,OPEN,HIGH,LOW,CLOSE,SETTLE_PR,CONTRACTS,VAL_INLAKH,OPEN_INT,CHG_IN_OI,TIMESTAMP`.
  - Instrument codes map as `FUTIDX→IDF`, `OPTIDX→IDO`, `FUTSTK→STF`, `OPTSTK→STO` (jugaad-data).
- **Fallback via the reports API** (nselib), used when the archive returns 403:
  `GET https://www.nseindia.com/api/reports?archives=[{"name":"F&O - Bhavcopy(csv)","type":"archives","category":"derivatives","section":"equity"}]&date={DD-Mon-YYYY}&type=equity&mode=single` (URL-encoded JSON). Needs cookies.
- **"Is it published?" check:** `GET https://www.nseindia.com/api/daily-reports?key=FO` returns:
  - `{"FutureDay":[…],"CurrentDay":[…],"PreviousDay":[…],"currentDate":"12-Sep-2025","previousDate":"11-Sep-2025"}`
  - Each item is `{fileHashKey,fileKey,fileSegment,displayName,fileActlName,filePath,tradingDate:"DD-Mon-YYYY",filePosition}`.
  - The download URL is `filePath + fileActlName`.
  - Relevant `fileKey` values: `FO-UDIFF-BHAVCOPY-CSV`, `FO-PARTICIPANTWISE-OI`, `FO-PARTICIPANTWISE-TRADING-VOL`, `FO-SEC-BAN`.
  - Only the current and previous trading day are listed (jugaad-data, raw captures in kiranfor2004/NSE_Downloader 2025-09-12).

### Columns

34 columns, identical header on NSE and BSE:

```
TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4
```

| Column | Meaning and type | Evidence |
|---|---|---|
| `TradDt`, `BizDt` | Trade date, `YYYY-MM-DD` | rows |
| `Sgmt` | `FO` | rows |
| `Src` | `NSE` (or `BSE` in the BSE file) | rows |
| `FinInstrmTp` | `IDO` index option, `IDF` index future, `STO` stock option, `STF` stock future | rows, jugaad mapping |
| `FinInstrmId` | Exchange token (integer), e.g. `47422` | rows |
| `ISIN` | Empty for F&O | rows |
| `TckrSymb` | Underlying: `NIFTY`, `BANKNIFTY`, `FINNIFTY`, `MIDCPNIFTY`, `NIFTYNXT50`, stock symbols | rows |
| `SctySrs` | Empty for F&O | rows |
| `XpryDt` | Expiry `YYYY-MM-DD` | rows |
| `FininstrmActlXpryDt` | Actual expiry `YYYY-MM-DD`; same as `XpryDt` in every sample. Probably differs only after a holiday shift (**UNCONFIRMED**). | rows |
| `StrkPric` | Strike (decimal, e.g. `25900.0` or `4900.00`); empty for futures | rows |
| `OptnTp` | `CE` or `PE`; empty for futures | rows |
| `FinInstrmNm` | Trading symbol. Weekly: `NIFTY2691525900PE` (YY + 1-character month (`1`–`9`, `O`, `N`, `D`) + DD + strike + type). Monthly: `NIFTY26SEP27050PE`. Future: `KEI25MARFUT`. | rows |
| `OpnPric`, `HghPric`, `LwPric` | OHLC; **`0.00` when untraded** | rows |
| `ClsPric` | Close; **equals `PrvsClsgPric` when untraded** | rows |
| `LastPric` | Last traded price; `0.00` when untraded | rows |
| `PrvsClsgPric` | Previous close | rows |
| `UndrlygPric` | Underlying close (index spot for IDO/IDF) | rows |
| `SttlmPric` | Daily settlement price; theoretical for untraded strikes. **On the expiry date, rows for the expiring contracts carry the underlying's final settlement price here, not the option premium.** Example: 2026-09-15, `NIFTY2691525900PE` has `SttlmPric 23118.6`, equal to `UndrlygPric`. The BSE file showed the same on 2026-04-30. Inferred from samples, **UNCONFIRMED** by spec. | rows |
| `OpnIntrst` | Open interest in **units (shares/qty), not lots** (e.g. 842790 ÷ lot 65 = 12966 lots) | rows (arithmetic) |
| `ChngInOpnIntrst` | Change in OI, units | rows |
| `TtlTradgVol` | **NSE: number of contracts (lots)**. Check: 31834 × 65 × (26200 + ~295) ≈ `TtlTrfVal` 54,820,949,478.75. jugaad maps it to legacy `CONTRACTS`. | rows (arithmetic), jugaad-data |
| `TtlTrfVal` | Turnover in ₹ (not lakhs). For options it is notional, (strike + premium) × quantity. | rows (arithmetic, **UNCONFIRMED** by spec) |
| `TtlNbOfTxsExctd` | Number of trades. 0 means a printed price was never traded; 65.6% of option rows on 03-Sep-2025 (sahilempire). | rows |
| `SsnId` | `F1` (final) | rows |
| `NewBrdLotQty` | Lot size, e.g. NIFTY `65` (2026), KEI `150` | rows |
| `Rmks`, `Rsvd1`–`Rsvd4` | Empty | rows |

- **Publication:**
  - One observed zip mtime is **18:17 IST** (Adhi-opp/alpha, verified 2026-07-07). Others observe "around 7–8 PM IST".
  - NikhilSuthar's catalogue says "daily reports are typically available by 6:00 PM IST" (**UNCONFIRMED**; NSE states no official time).
  - **Plan:** first poll at 18:00 IST, then every 15 min until 22:00 IST. Treat 404 as "not yet published"; treat 404 the next morning as a holiday.
- **Status:** official NSE file.
- **Robustness:**
  - Parse by header name, not position.
  - Normalise units: NSE volume is in contracts but OI is in units.
  - Filter `TtlNbOfTxsExctd > 0` before using `ClsPric` as a traded price.
  - Special-case expiry-day `SttlmPric`.
  - Lot sizes change twice a year, so use `NewBrdLotQty` per row.

---

## 3. NSE index daily closes (`ind_close_all`)

**URL (official):**

```
GET https://nsearchives.nseindia.com/content/indices/ind_close_all_{DDMMYYYY}.csv
    (fallbacks: https://archives.nseindia.com/content/indices/ind_close_all_{DDMMYYYY}.csv
                https://www.niftyindices.com/Daily_Snapshot/ind_close_all_{DDMMYYYY}.csv)
```

- **Format:** plain CSV, not zipped; about 17 KB and 140–166 rows (ethosagent 2026-09-25: 200, 17,285 bytes, `text/csv`).
- **Sources:** `nse` 5.1.0 `indices_bhavcopy()`, `nselib` `bhav_copy_indices()`; the niftyindices route is from `jugaad-data`.
- **Content-type check:** jugaad-rs says to check `Content-Type` (`application/octet-stream` means a real file).

Columns, verbatim:

```
Index Name,Index Date,Open Index Value,High Index Value,Low Index Value,Closing Index Value,Points Change,Change(%),Volume,Turnover (Rs. Cr.),P/E,P/B,Div Yield
```

Real rows from 14-10-2025:

```
Nifty 50,14-10-2025,25277.55,25310.35,25060.55,25145.5,-81.85,-.32,292129083,24151.97,22.23,3.44,1.32
Nifty Bank,14-10-2025,56598.65,56721.3,56230.15,56496.45,-128.55,-.23,129845019,6690.65,15.6,2.13,1.03
Nifty Financial Services,14-10-2025,26886.6,26972.85,26704.95,26828.3,-56.95,-.21,98847385,10684.6,17.67,2.8,.97
Nifty Midcap Select,14-10-2025,13230.5,13248,13015.05,13035.1,-151.85,-1.15,245342691,6320.66,29.61,4.25,.8
India VIX,14-10-2025,11.0075,11.6675,10.0125,11.16,0.15,1.34,-,-,-,-,-
```

- **Index names to match** (case-insensitive, since the case drifts between years, e.g. "NIFTY Midcap 100" vs "Nifty Midcap 100"):
  - `Nifty 50` → NIFTY
  - `Nifty Bank` → BANKNIFTY
  - `Nifty Financial Services` → FINNIFTY (do not match "Nifty Financial Services 25/50" or "…Ex-Bank")
  - `Nifty Midcap Select` → MIDCPNIFTY
  - `Nifty Next 50` → NIFTYNXT50
  - `India VIX`
- **Parsing quirks:**
  - Decimals with no leading zero (`-.32`).
  - `-` placeholders in the India VIX row.
  - Date is `DD-MM-YYYY`.
- **Depth:** probed back to 2012-06-01 (200). Before Nov-2015 the names use the old brand ("CNX Nifty").
- **Publication:** evening. ethosagent tests "after ~19:00 IST"; exact time **UNCONFIRMED**.
- **Status:** official.
- **JSON alternative for history** (unofficial API, cookies needed):
  - `GET https://www.nseindia.com/api/historicalOR/indicesHistory?indexType=NIFTY%2050&from={DD-MM-YYYY}&to={DD-MM-YYYY}` (Referer `…/reports-indices-historical-index-data`).
  - Response `{"data":[{"EOD_INDEX_NAME":"NIFTY BANK","EOD_OPEN_INDEX_VAL":59053.7,"EOD_HIGH_INDEX_VAL":59533,"EOD_CLOSE_INDEX_VAL":59461.8,"EOD_LOW_INDEX_VAL":59044.65,"HIT_TURN_OVER":4598.78,"HIT_TRADED_QTY":125225674,"EOD_TIMESTAMP":"15-DEC-2025","HI_TIMESTAMP":"2025-12-14T18:30:00.000+00:00"}]}`.
  - The library splits requests into chunks of 365 days or fewer; the NSE-side maximum is **UNCONFIRMED**.
  - Index names come from `GET /api/index-names`.
  - Note: the old path `/api/historical/indicesHistory` returned 503 in 2026 (ethosagent).
- **Recommendation:** backfill index history from `ind_close_all` (one file per day, cacheable forever) rather than the JSON API.

---

## 4. Participant-wise OI and volume (Client / DII / FII / Pro)

**URLs (official, NSE Clearing):**

```
GET https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_{DDMMYYYY}.csv
GET https://nsearchives.nseindia.com/content/nsccl/fao_participant_vol_{DDMMYYYY}.csv
    (fallback host: https://archives.nseindia.com/content/nsccl/...)
```

- **Sources:** `nselib` `participant_wise_open_interest()` and `participant_wise_trading_volume()`.
- **Depth:** verified back to 2016 (sahilempire); about 950 bytes per day.
- **`_b` variant:** some 2026 scrapers try `fao_participant_oi_{DDMMYYYY}_b.csv` first (MrChartist/fii-dii-data, FlintTrade). What the `_b` suffix means is **UNCONFIRMED**. Try the plain name, then `_b`.

**Layout**, from real 2026 files:
- Line 1 is a title wrapped in doubled quotes plus 14 empty fields:
  `""Participant wise Open Interest (no. of contracts) in Equity Derivatives as on Jul 22, 2026"",,,,,,,,,,,,,,`
  (volume file: `""Participant wise Trading Volume (no. of contracts) in Equity Derivatives as on Jun 24, 2026""`).
- Line 2 is the header. Some names carry **trailing spaces or a tab** (`Future Stock Short       `, `Total Long Contracts      `; older files use `\t`), so trim them.

```
Client Type,Future Index Long,Future Index Short,Future Stock Long,Future Stock Short,Option Index Call Long,Option Index Put Long,Option Index Call Short,Option Index Put Short,Option Stock Call Long,Option Stock Put Long,Option Stock Call Short,Option Stock Put Short,Total Long Contracts,Total Short Contracts
Client,227949,63366,3224508,333164,3016955,2004385,2844682,2696167,2650670,884283,1450033,1289420,12008750,8676833
DII,...
FII,...
Pro,...
TOTAL,386715,386715,8561857,8561857,4697731,3945113,4697731,3945113,4199393,2664700,4199393,2664700,24455509,24455509
```

- **Units:** number of contracts.
- **Rows:** `Client`, `DII`, `FII`, `Pro`, `TOTAL`.
- **Column order** is Call Long, Put Long, Call Short, Put Short, **not** paired long/short. MrChartist warns that "positional indexing silently swaps Put Long ↔ Call Short", so map by header. The mapping fits the app's `ParticipantRow` 1:1: `futIndexLong` ← "Future Index Long", … `optStockPutShort` ← "Option Stock Put Short".
- **Data glitches:** one 2021 file had a blank `" "` cell, so tolerate blanks as missing data. Never fill them in.
- **Publication:**
  - Later than the bhavcopy. MrChartist: "publishes the participant-OI file LATER than cash". GammaLeak: "before 8 PM IST may not be published". Adhi-opp schedules 22:00 conservatively. Anvil says ~5:30–6:30 PM.
  - **Plan:** poll 18:30–23:30 IST. Exact time **UNCONFIRMED**.
- **Status:** official.

**Related file — FII derivatives statistics (official):**
- URL: `https://nsearchives.nseindia.com/content/fo/fii_stats_{DD-Mon-YYYY}.xls` (e.g. `fii_stats_03-Sep-2025.xls`, verified 200 by sahilempire).
- Legacy BIFF `.xls`; nselib reads it with `skiprows=3, skipfooter=10`.
- Columns: product, buy contracts, buy value ₹ cr, sell contracts, sell value ₹ cr, OI contracts, OI value ₹ cr.

---

## 5. FII/DII cash-market activity

**Endpoint** (unofficial website API, cookies needed):

```
GET https://www.nseindia.com/api/fiidiiTradeReact
Referer: https://www.nseindia.com/reports/fii-dii       (warm this page first)
Accept: application/json, text/plain, */*
```

- **Response:** a JSON array of the **latest session only**, normally 2 rows:
  `[{"category":"DII","date":"DD-Mon-YYYY","buyValue":…,"sellValue":…,"netValue":…},{"category":"FII/FPI",…}]`
  - Values are ₹ crore, sent as strings or numbers that may contain commas, so strip commas.
  - The category label is `FII/FPI`, not `FII`.
- **Sources:** `nselib` `fii_dii_trading_activity()`, `nsepython` `nse_fiidii()`. Field names were verified live by vile-sudo (2026), kirannagarakanti/sachnetra and manitgupta/NSE-MCP.
- **Coverage:** "combined cross-exchange" figures (NSE + BSE + MSEI), per the NSE page title.
- **Sibling endpoint:** `GET https://www.nseindia.com/api/fiidiiTradeNse` is the NSE-only subset (vile-sudo, Parth1501, pchandv).
- **Conflicting report:** Axewatch (2026) says "old `/api/fiidii*` paths are 404" and uses `fiidiiTradeNse`. **Implement both with a fallback.** Which one is live today is **UNCONFIRMED**.
- **Publication:** provisional figures appear in the evening, commonly "after 6 PM IST" (Sahi). Some say about 8:30 PM. They are provisional and get revised after custodial confirmation.
- **No official history.** The endpoint returns only the latest day. Options for the app:
  - **Record daily from go-live**, with one fetch per evening and the date taken from the `date` field.
  - For FPI-only history, NSDL FPI reports are official: `https://www.fpi.nsdl.co.in/web/Reports/Latest.aspx` and `…/Archive.aspx`. These are ASP.NET POST pages with `__VIEWSTATE` (nselib `nsdl_fpi.py`). Their FPI figures differ from the exchange "FII/FPI" provisional figures.
  - **DII has no free official daily history.** Show the history as starting at the recording start date rather than synthesizing it.
- **Mapping to the app's `FiiDiiDay`:**
  - `fiiBuy`, `fiiSell`, `fiiNet` come from the `FII/FPI` row; `diiBuy`, `diiSell`, `diiNet` from the `DII` row.
  - `niftyClose` and `niftyChangePct` come from the `ind_close_all` "Nifty 50" row (`Closing Index Value`, `Change(%)`).

---

## 6. Holidays, lot sizes and expiry calendar

### 6.1 Trading holidays (unofficial API, cookies recommended)

```
GET https://www.nseindia.com/api/holiday-master?type=trading      (or type=clearing; any other value → 200 with empty body)
```

- **Response:** an object keyed by segment.
  - Keys: `CBM, CD, CM, CMOT, COM, EGR, FO, IRD, MF, NDM, NTRP, SLBS` (EGR is new).
  - **Use `FO`** for equity derivatives.
- **Entry shape:**
  `{"Sr_no":1,"tradingDate":"26-Jan-2026","weekDay":"Monday","description":"Republic Day","morning_session":null,"evening_session":null}`
  - The `*_session` fields are non-null only for COM and EGR (jugaad-rs).
- **Muhurat sessions:** listed as holidays (e.g. 2026-11-08 "trading holiday but Muhurat session only", yogesh-ing 2026-10-02). These need special handling.
- **Next year's list:** NSE publishes it around mid-December. `holiday-year-list` currently returns `{"year":["2026"]}` (exact path **UNCONFIRMED**).
- **Recommendation:** fetch rarely (weekly) and store in the DB. Cross-check with NSE holiday circulars.
- **BSE holidays:** in practice the same as NSE equity-derivative holidays (**UNCONFIRMED**).

### 6.2 Lot sizes

1. **Primary source:** the Kotak scrip master (live contracts). This is covered by the Kotak research.
2. **Per-contract, per-day:** the bhavcopy `NewBrdLotQty`.
3. **Official NSE file:** `GET https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv` (not `archives.` — that path redirects to a PDF).
   - Fixed-width-padded CSV.
   - Header: `UNDERLYING,SYMBOL,<MON-YY>,<MON-YY>,…`. Index rows come first.
   - A row `Derivatives on Individual Securities,Symbol,SEP-26,OCT-26,NOV-26,…` starts the stock section.
   - An empty cell means "not available" or the stock is exiting F&O.
   - Trim every cell.
   - Mirror of Sep-2026 values: NIFTY 65, BANKNIFTY 30, FINNIFTY 60, MIDCPNIFTY 120, NIFTYNXT50 25, NIFTYFPI 1100 (a new index).
   - `nse` 5.1.0 reads column index 3 (the next-month column).

### 6.3 Expiry calendar

- **Primary source:** the Kotak scrip master, which lists the actual expiries of live contracts.
- **Public cross-check** (unofficial API):
  - `GET https://www.nseindia.com/api/option-chain-contract-info?symbol=NIFTY` returns `{"expiryDates":["DD-Mon-YYYY",…], …}`. A `strikePrice` list is probably included too (**UNCONFIRMED**).
  - Also `GET /api/NextApi/apiClient/GetQuoteApi?functionName=getOptionChainDropdown&symbol=NIFTY` returns `expiryDates` as `DD-MM-YYYY` (nsepython 2.101).
- **Current rules** (secondary sources: HDFC Sec, Business Standard, Kotak Neo bulletin):
  - Effective for contracts expiring on or after **1-Sep-2025**.
  - NSE: NIFTY weekly on **Tuesday**; NIFTY monthly and quarterly on the last Tuesday.
  - BANKNIFTY, FINNIFTY, MIDCPNIFTY and NIFTYNXT50 are **monthly only**, last Tuesday. Their weeklies ended in Nov-2024 under the SEBI 01-Oct-2024 one-weekly-per-exchange rule.
  - BSE: SENSEX weekly on **Thursday**; BANKEX and SENSEX50 monthly on the last Thursday.
  - The 2026 bhavcopy rows agree (NIFTY expiries 2026-01-20/27, 2026-09-08/15/29 — all Tuesdays).
  - If the expiry falls on a holiday, it moves to the previous trading day.
  - Do not hard-code these rules. Derive expiries from data, and use the rules only as a sanity check.

---

## 7. India VIX history

1. **`ind_close_all` "India VIX" row** (official file, OHLC only; volume fields are `-`). Recommended for backfill.
2. **JSON** (unofficial, cookies needed; Referer `https://www.nseindia.com/reports-indices-historical-vix`):

   ```
   GET https://www.nseindia.com/api/historicalOR/vixhistory?from={DD-MM-YYYY}&to={DD-MM-YYYY}
   → {"data":[{"EOD_TIMESTAMP":"15-DEC-2025","EOD_INDEX_NAME":"INDIA VIX","EOD_OPEN_INDEX_VAL":10.1075,
       "EOD_HIGH_INDEX_VAL":10.8425,"EOD_LOW_INDEX_VAL":10.0475,"EOD_CLOSE_INDEX_VAL":10.25,
       "EOD_PREV_CLOSE":10.1075,"VIX_PTS_CHG":0.14,"VIX_PERC_CHG":1.41}]}     (newest first)
   ```

   - The library splits requests into chunks of 365 days or fewer.
   - Source: `nse` 5.1.0 `fetch_historical_vix_data()`; sample from the NseIndiaApi repo `src/samples`.
3. **Live intraday VIX:** from Kotak (out of scope here).

---

## 8. NSE live option-chain JSON (use only as a fallback or cross-check)

- **Legacy endpoint is dead.** `GET https://www.nseindia.com/api/option-chain-indices?symbol=NIFTY` (and `option-chain-equities`) **now returns `{}`**. Reported by kirannagarakanti/sachnetra, verified 2026-05-22; iTraders/nseoptions notes the "migration to option-chain-v3" around 2026-06-12. Do not build on it.
- **Current endpoint:**

  ```
  GET https://www.nseindia.com/api/option-chain-contract-info?symbol=NIFTY           → {"expiryDates":[...]}
  GET https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=NIFTY&expiry=14-Oct-2026
      (type=Equity for stocks; one expiry per call; NIFTY ≈ 456 KB)
  Warm-up: GET https://www.nseindia.com/option-chain ; Referer: https://www.nseindia.com/option-chain
  ```

  Used by `nse` 5.1.0 `option_chain()` and `nselib` 2.5.1 `get_nse_option_chain()`.
- **Response:**
  - `records.timestamp` is `"21-May-2026 15:30:00"` (IST).
  - `records.underlyingValue` is the spot price.
  - `records.data[]` holds `{expiryDates:"DD-Mon-YYYY", strikePrice, CE:{…}, PE:{…}}`.
  - `filtered.data[]` and `filtered.CE/PE.{totOI,totVol}` are also present.
- **Per-leg fields:**
  - `strikePrice`, `expiryDate`, `underlying`, `identifier`
  - `openInterest`, `changeinOpenInterest`, `pchangeinOpenInterest`
  - `totalTradedVolume`, `impliedVolatility`, `lastPrice`, `change`, `pchange`/`pChange`
  - `totalBuyQuantity`, `totalSellQuantity`, `underlyingValue`
  - **v3 bid/ask:** `buyPrice1`, `buyQuantity1`, `sellPrice1`, `sellQuantity1` (the legacy names were `bidprice`, `bidQty`, `askPrice`, `askQty`)
  - `optionType` (always null)
- **Units and quirks:**
  - `openInterest` is in **contracts**, unlike bhavcopy units. It can be fractional after lot-size revisions (old sample: `41.5`).
  - IV is 0 for far-OTM strikes.
  - Empty legs appear with `identifier:null` and zeros.
- **NextApi alternatives** (nsepython 2.101, 2026-10):
  - `GET /api/NextApi/apiClient/GetQuoteApi?functionName=getOptionChainData&symbol=NIFTY&params=expiryDate={DD-MM-YYYY}`
  - `functionName=getSymbolDerivativesData&symbol=NIFTY` (flat per-leg list; `underlyingValue` only inside legs)
- **Permission and reliability:**
  - The data is undocumented and changes without notice: two schema migrations in 2026 alone.
  - It is Akamai-protected, with TLS fingerprinting and cookie expiry (re-warm on 401/403).
  - It refreshes about once a minute in market hours. After hours it returns the last session with a **stale timestamp**.
  - Automated collection breaches NSE's Terms of Use.
- **Conclusion:** take the live chain from Kotak quotes (LTP, OI, bid/ask, volume) and compute IV in-house. Do not depend on this endpoint.
- **Per-contract daily history** (unofficial, cookies; Referer `…/report-detail/fo_eq_security`):
  - `GET /api/historicalOR/foCPV?from=DD-MM-YYYY&to=DD-MM-YYYY&instrumentType=OPTIDX&symbol=NIFTY&year=2026&expiryDate=29-Sep-2026&optionType=CE&strikePrice=25000`
  - Returns `data[]` with `FH_INSTRUMENT, FH_SYMBOL, FH_EXPIRY_DT, FH_STRIKE_PRICE, FH_OPTION_TYPE, FH_MARKET_TYPE, FH_OPENING_PRICE, FH_TRADE_HIGH_PRICE, FH_TRADE_LOW_PRICE, FH_CLOSING_PRICE, FH_LAST_TRADED_PRICE, FH_PREV_CLS, FH_SETTLE_PRICE, FH_TOT_TRADED_QTY, FH_TOT_TRADED_VAL, FH_OPEN_INT, FH_CHANGE_IN_OI, FH_MARKET_LOT, FH_TIMESTAMP, FH_TIMESTAMP_ORDER, FH_UNDERLYING_VALUE, CALCULATED_PREMIUM_VAL`.
  - The bhavcopy archive is the better choice.

---

## 9. BSE SENSEX/BANKEX derivatives bhavcopy

**URL (official):**

```
GET https://www.bseindia.com/download/Bhavcopy/Derivative/BhavCopy_BSE_FO_0_0_0_{YYYYMMDD}_F_0000.CSV
```

- **Evidence:** BSE's own bhavcopy page HTML, captured 07-Aug-2024 in JBalakrishnaReddy/bse_stock_analysis, links exactly this URL under "Equity Derivatives (UDiFF)" (64.81 KB).
- **Case and format:** some code spells it `/BhavCopy/` with a capital C. The host is IIS, so the path is probably case-insensitive (**UNCONFIRMED**). The file is **plain CSV, not zipped**.
- **Related files** listed on the same page:
  - Market summary: `https://www.bseindia.com/download/Bhavcopy/Derivative/MS_{YYYYMMDD}-01.csv`
  - CM UDiFF: `https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_{YYYYMMDD}_F_0000.CSV`
- **Legacy (pre-UDiFF):** `https://www.bseindia.com/download/Bhavcopy/Derivative/bhavcopy{DD-MM-YY}.zip` (**UNCONFIRMED**).
- **Columns:** the same 34-column UDiFF header as NSE, with `Src=BSE` and `Sgmt=FO`, `FinInstrmTp ∈ {IDO, IDF, STO, STF}`, and `TckrSymb` `SENSEX` or `BANKEX`. The SENSEX 50 symbol string is **UNCONFIRMED**. Lot size is in `NewBrdLotQty`: SENSEX 20 in the 2026 sample. About 848 rows on 03-Sep-2025 (sahilempire, verified 200).
- **Unit difference from NSE (inferred, UNCONFIRMED):** in the BSE sample, `TtlTradgVol` is **quantity (units), not contracts**. Check: 2940 × (78000 + ~1700) ≈ `TtlTrfVal` 234,310,908, with lot 20. `OpnIntrst` also looks like units. Normalise per exchange.
- **Expiry-day quirk:** on 2026-04-30, the expiring `SENSEX26APR75200CE` row had `ClsPric = SttlmPric = UndrlygPric = 76913.50`.
- **Access:**
  - javatarz (2026-09-19) got **HTTP 403** for all `www.bseindia.com` URLs from a non-browser client.
  - Others fetch successfully with `User-Agent: <browser>`, `Referer: https://www.bseindia.com/` and `Origin: https://www.bseindia.com` (the `bse` 3.3.3 package and chintanmehta21).
  - Expect to need full browser headers; IP-based blocking is possible.
- **Publication:** **UNCONFIRMED**. The legacy BSE equity bhavcopy help gave about 16:45 IST; plan to poll 18:00–22:00 IST.
- **Status:** official BSE file.
- **BSE index history** (unofficial JSON, `bse` 3.3.3):
  - `GET https://api.bseindia.com/BseIndiaAPI/api/ProduceCSVForDate/w?strIndex=SENSEX&dtFromDate=DD/MM/YYYY&dtToDate=DD/MM/YYYY&period=D` (CSV)
  - `GET https://api.bseindia.com/BseIndiaAPI/api/IndexArchDailyAll/w?fmdt=DD/MM/YYYY&todt=DD/MM/YYYY&index=All&period=D`
  - The FO bhavcopy `UndrlygPric` also gives the daily SENSEX and BANKEX close.
- **BSE live option chain** (unofficial, not needed because Kotak covers BSE F&O): `GET https://api.bseindia.com/BseIndiaAPI/api/DerivOptionChain_IV/w?Expiry={DD+Mon+YYYY}&scrip_cd=1&strprice=0` (**UNCONFIRMED** fields).

---

## 10. Publication schedule summary (IST, trading days)

| Dataset | Official? | Earliest seen | Suggested poll window | Confidence |
|---|---|---|---|---|
| F&O UDiFF bhavcopy | Yes (file) | 18:17 | 18:00–22:00 every 15 min | Third-party observation |
| `ind_close_all` | Yes (file) | evening | 18:00–22:00 | **UNCONFIRMED** |
| Participant OI / volume | Yes (file, NSCCL) | after bhavcopy (~19:00–21:00) | 18:30–23:30 | Third-party observation |
| `fii_stats_*.xls` | Yes (file) | evening | 18:30–23:00 | **UNCONFIRMED** |
| FII/DII cash provisional (`fiidiiTradeReact`) | Unofficial API; data is official provisional | ~18:00 (reports range up to 20:30) | 17:30–21:30 | Secondary sources |
| India VIX (`vixhistory`) | Unofficial API | after 15:30 | EOD | **UNCONFIRMED** |
| Holiday master | Unofficial API | yearly, mid-Dec plus ad-hoc circulars | weekly | Third-party observation |
| `fo_mktlots.csv` | Yes (file) | on lot revision | weekly | — |
| BSE FO bhavcopy | Yes (file) | evening | 18:00–22:00 | **UNCONFIRMED** |

Handling rules:
- **404 after 23:30 on a weekday:** check the holiday list. If it is not a holiday, retry the next morning.
- **Polling the NSE metadata:** `/api/daily-reports?key=FO` lists files as they are released, so it can stand in for blind polling. Whether entries appear in `CurrentDay` only after release is **UNCONFIRMED**.

---

## 11. Network allowlist

**Required:**
- `nsearchives.nseindia.com` — all NSE EOD files
- `archives.nseindia.com` — fallback mirror
- `www.nseindia.com` — `/api/holiday-master`, `/api/fiidiiTradeReact`, `/api/fiidiiTradeNse`, `/api/daily-reports`, `/api/historicalOR/*`, `/api/option-chain-*`, and the cookie warm-up HTML pages
- `www.bseindia.com` — BSE FO bhavcopy

**Optional:**
- `api.bseindia.com` — BSE index archive and option-chain JSON
- `www.niftyindices.com` and `niftyindices.com` — mirror at `/Daily_Snapshot/ind_close_all_*.csv`. Its history endpoints redirected to `/Sitefinity/Login` in 2026 (ethosagent).
- `www.fpi.nsdl.co.in` and `pilot.fpi.nsdl.co.in` — FPI daily and archive history
- `nseindia.com` — the bare domain redirects to `www.`

---

## 12. Implementation notes for QUANTSAPP26 (Node/Fastify)

1. **One `NsePublicClient`:**
   - Serial request queue with at least 500 ms spacing for archives and at least 3 s for `www.nseindia.com/api`.
   - A cookie jar warmed per API page, re-warmed once on 401/403/429.
   - Host fallback `nsearchives → archives` on network errors or 5xx.
   - Content sniffing: ZIP magic, or a CSV header check.
   - A disk cache keyed by URL. EOD files never change, but cache a 404 only for past dates confirmed as holidays.
2. **TLS fingerprint risk:**
   - Node's fetch did get 200 from `nsearchives` with browser headers (ethosagent, TypeScript).
   - `www.nseindia.com/api` may reject Node's TLS fingerprint, as nsepython reports for Python `requests`.
   - If blocked, the options are a TLS-impersonating client or running the fetcher from a residential IP. Never fall back to fabricated data.
3. **Persist each dataset to the DB as soon as it is fetched:**
   - FII/DII and the option chain have no public history, so build the recorder from day one.
   - Backfill only from archive files: F&O bhavcopy, `ind_close_all` and participant OI/volume all go back years.
4. **Normalise units:**
   - NSE bhavcopy OI is in units and volume in contracts.
   - BSE bhavcopy volume is in units.
   - The NSE option-chain OI is in contracts.
   - Participant files are in contracts.
   - Store everything in contracts and units explicitly, with the lot size.
5. **Strike rows:**
   - Untraded strikes have `OpnPric=0` and `ClsPric=PrvsClsgPric`.
   - On expiry day, `SttlmPric` of expiring contracts is the underlying's settlement price.
   - Surface both cases in the UI as "no trade" or "expired", not as prices.

---

## 13. Sources

**Library source code (downloaded from PyPI, read locally):**
- `nse` 5.1.0 — https://pypi.org/project/nse/ ; https://github.com/BennyThadikaran/NseIndiaApi (samples in `src/samples/*.json`)
- `nselib` 2.5.1 — https://pypi.org/project/nselib/
- `jugaad-data` 0.35.10 — https://pypi.org/project/jugaad-data/ ; https://github.com/jugaad-py/jugaad-data
- `nsepython` 2.101 — https://pypi.org/project/nsepython/
- `bse` 3.3.3 — https://pypi.org/project/bse/ ; https://github.com/BennyThadikaran/BseIndiaApi

**Real file mirrors and 2026 verification notes (GitHub):**
- AvilPage/historical-option-chain-data
- snowjug/Trading-Bot `data/real_2026/bhavcopies`
- sahilempire/groww-market-data `nse_archives/`
- sahilempire/nifty-options-research-lab `docs/research/21-free-data-sources.md`
- noswear94/quantdata `raw/bhavcopy/index`
- shah18122/ALTAIR `fo_mktlots.csv`
- ethosagent/tools-nse-market-data (`plan/nse-index-history.md`, `src/nse-archive.ts`)
- javatarz/wealth-tracker `docs/research/market-data-sources.md`
- Am1n1602/jugaad-rs `docs/nse-findings.md`
- kirannagarakanti/sachnetra `ai_docs/tasks/V2-024_nse_options_oi.md`
- iTraders/nseoptions
- kiranfor2004/NSE_Downloader `network_capture_logs`
- MrChartist/fii-dii-data
- vile-sudo/deep-microcap-screener
- Axemoth/Axewatch-app
- Adhi-opp/alpha `docs/DATA.md`
- nseepana/eodreport
- JBalakrishnaReddy/bse_stock_analysis `scratch.ipynb` (BSE page capture)
- chintanmehta21/OptionsScraper
- finance-quote/finance-quote `NSEIndia.pm`
- yogesh-ing/back-test `docs/MARKET-STATUS-SPEC-2026-10-02.md`

**Official pages and secondary sources:**
- NSE Terms of Use — https://www.nseindia.com/static/nse-terms-of-use
- NSE FII/DII page — https://www.nseindia.com/reports/fii-dii
- Expiry-day change — https://www.hdfcsec.com/blog/details/changes-in-expiry-day-for-index-derivatives-on-bse-nse ; https://www.business-standard.com/amp/markets/news/nse-bids-adieu-to-thursday-expiry-as-dates-swap-come-into-effect-explained-125082800635_1.html ; https://www.kotakneo.com/bulletins/important-changes-in-derivatives-expiry-dates/
- Weekly-option rationalisation — https://www.business-standard.com/markets/capital-market-news/nse-retains-nifty-discontinues-other-three-weekly-options-contracts-124101100337_1.html
- FII/DII timing — https://sahi.com/blogs/fii-dii-data-meaning-how-to-read
