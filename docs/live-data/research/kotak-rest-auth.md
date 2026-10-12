# Kotak Neo Trade API v2: authentication and REST (research report)

Researched 2026-10-12. Nothing here was called against Kotak with real credentials. The `*.kotaksecurities.com` and `kotakneo.com` hosts are blocked from both Bash and WebFetch in this sandbox, so every statement comes from the sources listed in section 0.

---

## 0. Sources and how much to trust them

| # | Source | What it is | Trust |
|---|---|---|---|
| S1 | PyPI `kotakneoapi==3.0.7` wheel (`pip download kotakneoapi --no-deps`), import package `neo_api_client` | **Official SDK** ("Official Python SDK for Kotak Neo Trading APIs", author Kotak Neo). It is the latest release on PyPI; the versions on PyPI are 3.0.0, 3.0.1, 3.0.6 and 3.0.7. | PRIMARY |
| S2 | `git clone https://github.com/Kotak-Neo/kotak-neo-python` (main @ `099e6a6d`, 2026-10-08, `__version__ = "3.0.9"`, not yet on PyPI). Includes `docs/functions/**`, the Postman collection `docs/postman/*.json`, the e2e test `tests/e2e/smoke_test.py` and `CHANGELOG.md`. | Official SDK repo plus docs. Its README says it supersedes `kotak-neo-api-v2`. | PRIMARY |
| S3 | `git clone https://github.com/Kotak-Neo/kotak-neo-api-v2` (main @ `8cee5bda`, 2026-06-08). Includes sample scrip-master CSVs `neo_api_client/api/nse_cm.csv` and `nse_fo.csv` (data from 2023). | Legacy official SDK | PRIMARY (legacy) |
| S4 | GitHub issues Kotak-Neo/kotak-neo-python #35, #39, #43 (read with WebFetch) | Community reports; #39 and #43 have maintainer replies | #39 maintainer reply: PRIMARY. #35: COMMUNITY |
| S5 | Kotak PDFs `API_Migration_guide_03_12_2025_accfccef45.pdf` and `Migration_guide_client_PDF_1_141c1e7b53.pdf` | **Could not be fetched** (DNS for kotakneo.com is blocked for both WebFetch and curl). Only web-search snippets were seen. | SNIPPET ONLY |
| S6 | npm `@its_seraj/trade` (`neo-client.js`) | Third-party Node client | CORROBORATION ONLY |
| S7 | PyPI `pyotp` source (`totp.py`, `otp.py`) | TOTP library used by the official SDK's e2e test | PRIMARY for TOTP parameters |

Statements that are inferences, community observations or untested are marked **UNCONFIRMED**.

---

## 1. Authentication: TOTP login, then MPIN validate

### 1.1 Prerequisites (S1 README, S2 `docs/functions/authentication/totp_login.md`)
- **Consumer key**: Neo app or web → **More** tab → **Trade API** card → "Generate application" → copy the token. S2 `.env.example` says "Invest tab" instead of More, so the menu location varies. This is a plain opaque string (the user's looks like a UUID). It goes in the `Authorization` header **as-is, with no `Bearer ` prefix**.
- **TOTP registration** (one-time): API dashboard (Neo app/web → More → Trade API) → top-right "TOTP Registration" → scan the QR code or copy the setup key into Google or Microsoft Authenticator → enter the 6-digit code → "TOTP successfully registered". The docs say to "Save the secret key from QR code (for automated TOTP generation)". That saved value is the base32 secret, i.e. `NEO_TOTP_SECRET`.
- **UCC**: Neo app → Profile.
- **MPIN**: the 6-digit trading MPIN.
- `neo-fin-key`: the SDK default is the literal string **`neotradeapi`** (`NeoUtility.get_neo_fin_key()`: `return self.neo_fin_key or "neotradeapi"`).

### 1.2 Step 1: TOTP login (`tradeApiLogin`). The response carries a VIEW token.

```
POST https://mis.kotaksecurities.com/login/1.0/tradeApiLogin
Authorization: <consumer_key>              # raw, no "Bearer"
neo-fin-key: neotradeapi
Content-Type: application/json

{"mobileNumber":"+919876543210","ucc":"ABC12","totp":"123456"}
```
- Source: S1 `services/totp.py` `TotpAPI.totp_login`. The URL is built from `settings.PROD_URL["totp_login"] = "login/1.0/tradeApiLogin"` and `urls.SESSION_PROD_BASE_URL = "https://mis.kotaksecurities.com"`. The Postman collection (S2) shows the same request. UAT uses `https://d-mis.kotaksecurities.com/api/1.0/login/v6/totp/login`; that environment is internal and not for users.
- **mobileNumber format**: E.164 **with `+91`**, e.g. `"+919876543210"` (SDK docstring: "Your registered mobile number with country code. Example: "+919876543210""). The Postman env uses `+91XXXXXXXXXX`.
- **Body keys are camelCase**: `mobileNumber`, `ucc`, `totp`. All three are strings.
- Issue #43 says accounts that need a PAN instead of a mobile number must contact support@kotakneo.com. The API has no PAN path.
- Measured latency in the docs: about 367 ms on average.

**Success response** (S2 `totp_login.md`, "Real API Response"):
```json
{"data":{
  "token":"eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...",   // JWT VIEW token
  "sid":"xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",        // session id
  "rid":"xxxxxxxx-...",
  "isUserPwdExpired":false, "ucc":"XXXXX", "greetingName":"USER_NAME",
  "isTrialAccount":false, "dataCenter":"E43", "derivativesRiskDisclosure":"...",
  "mfAccess":1, "dataCenterMap":null, "dormancyStatus":"A", "asbaStatus":"",
  "clientType":"RI", "isNRI":false, "kId":"<PAN>", "kType":"View",
  "status":"success", "incRange":0, "incUpdFlag":"", "clientGroup":"", "kraStatus":"", "rcFlag":0 }}
```
The SDK keeps `data.token` as `view_token`, `data.sid` as `sid` and `data.ucc` as `ucc`.

**Error handling** (S1 code comment): "A 2xx response can still carry an error body (e.g. invalid/empty UCC), in which case 'data' is absent." A login only counts as successful when the HTTP status is 2xx **and** `data` is an object (in practice also check `data.token` and `data.status === "success"`). Otherwise return the body as the error. The documented error shape is `{"error":[{"code":"400","message":"Missing required field 'MobileNumber'"}]}`. The HTTP codes listed are 200, 400, 429, 500, 503 and 504.

### 1.3 Step 2: MPIN validate (`tradeApiValidate`). The response carries a TRADE token and the baseUrl.

```
POST https://mis.kotaksecurities.com/login/1.0/tradeApiValidate
Authorization: <consumer_key>
neo-fin-key: neotradeapi
sid: <data.sid from step 1>
Auth: <data.token from step 1>       # VIEW token, raw (no Bearer)
Content-Type: application/json       # see note below

{"mpin":"123456"}
```
- Source: S1 `TotpAPI.totp_validate` (headers `Authorization`, `sid`, `Auth`, `neo-fin-key`) and the Postman request "2. TOTP Validate (MPIN)".
- Note on Content-Type: the validate docs say "No Content-Type ... headers are sent by this call". However, the transport in S1 `rest.py` adds `Content-Type: application/json` whenever it is missing (`if "Content-Type" not in headers: headers["Content-Type"] = "application/json"`) and sends the body as a raw JSON string. In practice, then, the request goes out as JSON. Send it as JSON.
- Header-name casing: the SDK sends lowercase `sid` here and `Sid` on later calls. HTTP header names are case-insensitive.

**Success response** (S2 `totp_validate.md`):
```json
{"data":{
  "token":"eyJhbGc...",            // JWT TRADE token  -> "Auth" header on all session calls
  "sid":"xxxxxxxx-...",            // trade session id -> "Sid" header
  "rid":"xxxxxxxx-...",
  "baseUrl":"https://eXX.kotaksecurities.com",   // per-data-center REST host for ALL later calls
  "isUserPwdExpired":false, "ucc":"XXXXX", "greetingName":"USER_NAME",
  "isTrialAccount":false, "dataCenter":"E43", "mfAccess":1, "dataCenterMap":null,
  "dormancyStatus":"A", "asbaStatus":"", "clientType":"RI", "isNRI":false,
  "kId":"<PAN>", "kType":"Trade", "status":"success", "incRange":0, "incUpdFlag":"",
  "clientGroup":"", "kraStatus":"", "rcFlag":0 }}
```
- The SDK also reads two optional fields, `data.feedUrl` (SFeed websocket URL) and `data.rtUrl` (order-feed websocket URL), as fallbacks (S1 `totp.py`). They are not in the documented sample, so their presence is **UNCONFIRMED**.
- `hsServerId` (and `searchAPIKey`) appeared only in the **legacy** v2 SDK sample (S3 `docs/Totp_validate.md`; S3 stored `serverId = data.hsServerId` for the old HSM websocket). The current SDK ignores both. Treat them as optional or absent.
- `dataCenter` values seen in the sources: `E21`, `E22`, `E41`, `E43`, `gdc`, `adc`.
- Measured latency in the docs: about 134 ms on average.

### 1.4 The dynamic config lookup the SDK does after validate (needed only for websocket URLs)
S1 `NeoUtility.resolve_dynamic_urls()` runs right after validate:
```
GET https://lapi.kotaksecurities.com/5config/config?appVersion=<sdk version>&platform=api&environment=prod
(no auth headers; timeout 5 s; best-effort)
```
- Response: `data.configs`.
  - `configs["<dataCenter>_broadcast_source"]` gives a source name, e.g. `"sh"` or `"ks"`.
  - `configs["<dc>_<src>_broadcast_endpoint"]` is the SFeed websocket URL.
  - `configs["<dc>_<src>_interactive_endpoint"]` is the order-feed URL.
- The URLs come back with the `https` scheme; convert them to `wss`.
- Fallback order: config service, then `data.feedUrl`/`data.rtUrl`, then hardcoded values (`wss://sfeed.kotaksecurities.com/apifeed` for SFeed; `wss://<baseUrl host>/realtime` for the order feed).

### 1.5 TOTP generation: RFC 6238, HMAC-SHA1, 30 s period, 6 digits, base32 secret
- Kotak's own e2e test (S2 `tests/e2e/smoke_test.py`) builds the code with `pyotp.TOTP(NEO_TOTP_SECRET).now()`, i.e. pyotp defaults.
- pyotp source (S7) gives those defaults: `digits=6`, `digest=hashlib.sha1`, `interval=30`, T0 = Unix epoch. `byte_secret()` pads the secret with `=` to a multiple of 8 and then calls `base64.b32decode(secret, casefold=True)`. Unpadded and lowercase secrets therefore work, e.g. a 26-character setup key.
- The docs also say the code "changes every 30 seconds".
- The Node implementation below matched pyotp exactly at 5 timestamps (verified in scratchpad `scripts/totp.mjs` against `scripts/check.py`, using a dummy secret):
```ts
import { createHmac } from 'node:crypto';
function base32Decode(s: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = s.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of clean) { const i = A.indexOf(ch); if (i < 0) throw new Error('bad base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; } }
  return Buffer.from(out);
}
export function totp(secret: string, unixMs = Date.now()): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(Math.floor(unixMs / 30000)));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1_000_000).padStart(6, '0');
}
```
- Practical tip (not from Kotak docs): if fewer than about 3 s remain in the current 30 s window, wait for the next window before calling login so the code does not expire in flight. Keep the server clock NTP-synced.

### 1.6 Token lifetime, expiry and re-login strategy
- **No official lifetime is documented anywhere** (searched S1–S3, the issues and the web). The JWT lifetime and the daily cutoff are **UNCONFIRMED**.
  - The ~3600 s "access token" that turns up on Kotak web pages refers to the retired v1 OAuth `oauth2/token` flow. That flow is dead code in S1 `services/login.py`, and the v1 APIs were retired on 1 Oct 2025 according to the S5 snippet.
- Both tokens are JWTs (S1 decodes the view token with `jwt.decode(..., verify_signature=False)` to read the `sub` claim, which is the userId). The app can base64url-decode the trade token payload and read the standard `exp` claim, if one is present (**UNCONFIRMED** that it is), to schedule a re-login.
- Signs that a session has expired: HTTP **401/403** ("Invalid session, please re-login", listed in every endpoint's status table), or a 2xx response whose body has no `data`.
- Recommended strategy (inference, not a Kotak statement):
  1. Log in at server start.
  2. Log in again proactively every trading day before 09:00 IST, or at `exp` minus 5 min if `exp` exists.
  3. On 401/403, re-run the full TOTP and MPIN flow once, using a new TOTP code from a later 30 s window, then retry the request.
  4. Never loop. Login also returns 429 when called too often.
  5. Keep a single session per consumer key. Whether a new login invalidates older sessions is **UNCONFIRMED**.
- **Logout**: in SDK v3, `logout()` makes **no network call**. It only clears tokens locally (`# log_off = LogoutAPI(...)` is commented out). The legacy endpoint `apim/login/2.0/logout` uses the dead Bearer flow. There is nothing to call server-side.

---

## 2. Headers and base URL for every later REST call

**Base URL rule:** every non-login REST call goes to `data.baseUrl` from validate, e.g. `https://e21.kotaksecurities.com`. If it is not known yet, the SDK falls back to `https://mis.kotaksecurities.com` (S1 `NeoUtility.get_domain()`: `base_url = self.base_url if self.base_url else PROD_BASE_URL`).
- The S5 snippet says the same: "Order, report and other APIs became dynamic and must be called using the baseUrl returned after MPIN validation".
- Join the base and the path with exactly one `/` (the SDK strips duplicate slashes).
- Login, validate and `get-client-ip` always use `https://mis.kotaksecurities.com`.

| Call class | Headers (exact, from S1 services and the S2 Postman collection) |
|---|---|
| Login | `Authorization: <consumer_key>`, `neo-fin-key: neotradeapi`, `Content-Type: application/json` |
| Validate | `Authorization: <consumer_key>`, `neo-fin-key`, `sid: <view sid>`, `Auth: <view token>` (+ JSON content type) |
| **Market data** (quotes, scrip-master file-paths, expiries, option-chain, historical) | **`Authorization: <consumer_key>` only**. The SDK also sends `Content-Type: application/x-www-form-urlencoded`, which means nothing on a GET. No Sid or Auth. The docs say these "do not require a completed 2FA session". However, the official e2e test notes "All three [expiries/option-chain/historical] require totp_validate() to have run (for base_url resolution)". **Call them after validate, on `baseUrl`.** Whether they work pre-login on `mis` is **UNCONFIRMED**. |
| Session reads (orders, trades, positions, holdings, limits, margin, history) | `Sid: <trade sid>`, `Auth: <trade token>` (+ `accept: application/json`). The SDK sends **no** `Authorization` header on these. A third-party client sends Authorization + neo-fin-key + Sid + Auth on everything and works (S6), so extra headers seem to be tolerated (**UNCONFIRMED**). |
| Order place/modify/cancel (NOT USED by us) | `Authorization: <consumer_key>`, `Sid`, `Auth`, `Content-Type: application/x-www-form-urlencoded` |
| `get-client-ip` | `Authorization`, `Sid`, `Auth`, `accept: application/json`, on `https://mis.kotaksecurities.com/login/1.0/get-client-ip` |

Other conventions:
- **POST body convention** (Kotak "jData"): `Content-Type: application/x-www-form-urlencoded` with a single form field `jData=<JSON string>`, e.g. `jData={"seg":"ALL","exch":"ALL","prod":"ALL"}` (S1 `rest.py`: `request_kwargs["data"] = {"jData": json.dumps(body)}`).
- SDK-only extras that are not needed: `User-Agent: NeoSDK-Python/<ver>`, `Accept: application/json`, `Accept-Encoding: gzip, deflate`, `X-Request-ID: <uuid>`, `X-Client-ID: <first 8 chars of key>***`. The SDK negotiates HTTP/2 with HTTP/1.1 fallback, so plain HTTP/1.1 from Node fetch is fine.
- **Common response envelopes and error shapes:**
  - Validation errors: `{"error":[{"code":"400","message":"..."}]}`.
  - Session APIs: `{"stat":"ok","stCode":200,"data":[...]}`.
  - Historical: `{"status":"ERROR","fault":{"code":400,"message":"Invalid interval value"}}`.
  - Rate limit, as seen in community issue #35: `{"code":429,"error":"Rate limit exceeded","message":"too many request received"}`.
- **Rate-limit response headers**: SDK 3.0.9 surfaces `Retry-After`, `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset` "when the backend sends them". Read them case-insensitively and honour `Retry-After` (seconds).

---

## 3. Scrip master

### 3.1 File-paths endpoint
```
GET {baseUrl}/script-details/1.0/masterscrip/file-paths
Authorization: <consumer_key>
```
Response (S1 reads `resp.json()["data"]["filesPaths"]`; the S2 doc sample is shown unwrapped):
```json
{"data":{
  "baseFolder":"https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod",
  "filesPaths":[
   "https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/2026-07-14/transformed/cde_fo.csv",
   "https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/2026-07-14/transformed/mcx_fo.csv",
   "https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/2026-07-14/transformed/nse_fo.csv",
   "https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/2026-07-14/transformed/bse_fo.csv",
   "https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/2026-07-14/transformed/nse_com.csv",
   "https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/2026-07-14/transformed-v1/bse_cm-v1.csv",
   "https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/2026-07-14/transformed-v1/nse_cm-v1.csv"]}}
```
- The folder is **date-stamped and changes daily**. `nse_cm` and `bse_cm` currently come from `transformed-v1/*-v1.csv`; the other segments come from `transformed/*.csv`. `nse_com.csv` is an older-format NSE CM file, not NSE commodities. The docs say: "Always resolve the exact filename from this response rather than hardcoding."
- The SDK picks a file by substring match: `segment.lower() in url.lower()` ("nse_cm" matches `nse_cm-v1.csv` but not `nse_com.csv`).
- **CSV download is a plain unauthenticated GET** with no Kotak headers (S2 smoke_test: "CSV file download: plain GET to the resolved file URL, no headers").
- Kotak publishes a new file "roughly once a day". The SDK caches it until local midnight. Recommended: fetch once per day before 09:00 IST.
- Size: the 2023 `nse_fo.csv` sample is **16.8 MB, 51 209 rows**. Stream-parse it.

### 3.2 CSV columns
There are 78 columns, taken verbatim from the S3 sample header. **Header names contain trailing spaces and one has a semicolon. Trim every header.** The exact names include `"dTickSize "`, `"lExpiryDate "`, `"lMultiplier "`, `"iBoardLotQty "`, `"iMaxOrderSize "`, `"dOpenInterest "`, `"dHighPriceRange "`, `"dLowPriceRange "`, `"dPriceNum   "`, `"dPriceQuatation "`, `"dIssuerate "`, `"dWarningQty "`, `"dIssueCapital "`, `"dExposureMargin "`, `"dMinRedemptionQty "`, plus **`"dStrikePrice;"`** (the semicolon is part of the name and the SDK uses it literally).

`pSymbol, pGroup, pExchSeg, pInstType, pSymbolName, pTrdSymbol, pOptionType, pScripRefKey, pISIN, pAssetCode, pSubGroup, pCombinedSymbol, pDesc, pAmcCode, pContractId, dTickSize, lLotSize, lExpiryDate, lMultiplier, lPrecision, dStrikePrice;, pExchange, pInstName, pExpiryDate, pIssueDate, pMaturityDate, pListingDate, pNoDelStartDate, pNoDelEndDate, pBookClsStartDate, pBookClsEndDate, pRecordDate, pCreditRating, pReAdminDate, pExpulsionDate, pLocalUpdateTime, pDeliveryUnits, pPriceUnits, pLastTradingDate, pTenderPeridEndDate, pTenderPeridStartDate, pSellVarMargin, pBuyVarMargin, pInstrumentInfo, pRemarksText, pSegment, pNav, pNavDate, pMfAmt, pSipSecurity, pFaceValue, pTrdUnits, pExerciseStartDate, pExerciseEndDate, pElmMargin, pVarMargin, pTotProposedLimitValue, pScripBasePrice, pSettlementType, pCurrectionTime, iPermittedToTrade, iBoardLotQty, iMaxOrderSize, iLotSize, dOpenInterest, dHighPriceRange, dLowPriceRange, dPriceNum, dGenDen, dGenNum, dPriceQuatation, dIssuerate, dPriceDen, dWarningQty, dIssueCapital, dExposureMargin, dMinRedemptionQty, lFreezeQty`

The 2026 `transformed`/`transformed-v1` files are assumed to keep these names. The SDK 3.0.9 code still reads `pSymbolName`, `pOptionType`, `pExpiryDate` and `dStrikePrice;` from all segments, including `nse_cm-v1.csv`, which strongly suggests the names are unchanged. A live 2026 file could not be inspected, so the exact current header is **UNCONFIRMED**. Parse by header name, never by position.

Meanings of the columns we need:

| Column | Meaning and encoding | Evidence |
|---|---|---|
| `pSymbol` | **Instrument token** (numeric string). This is the `instrument_token` used in quotes (`nse_fo\|<pSymbol>`), websocket and margin. **Gotcha:** 390 rows in the 2023 nse_fo sample are calendar spreads, with `pSymbol` = `"53032 72263"` (two tokens), an empty `pSegment` and `pExchange`, and `pTrdSymbol` like `NESTLEIND27APR2325MAY23FUT`. Drop rows where `pSegment` is empty or `pSymbol` has a space. | S3 sample; S1 docs ("instrument token (pSymbol)") |
| `pGroup` | Series: `EQ`, `BE`, `BL`, `SG`, `MF`, ... for cash; `XX` for all F&O rows | S3 |
| `pExchSeg` | `nse_cm`, `nse_fo`, `bse_cm`, `bse_fo`, `cde_fo`, `mcx_fo` | S3 |
| `pInstType` | nse_fo: `OPTIDX`, `OPTSTK`, `FUTIDX`, `FUTSTK`. Empty for cash. bse_fo values are **UNCONFIRMED** (an S2 unit-test mock uses `FUTIDX` for SENSEX). | S3 counts: OPTSTK 45 566, OPTIDX 4 657, FUTSTK 955, FUTIDX 31 |
| `pSymbolName` | Underlying symbol: `NIFTY`, `BANKNIFTY`, `FINNIFTY`, `MIDCPNIFTY`, `SENSEX`, ... This is the value expected by the `underlying` parameter of the expiries and option-chain endpoints ("Matches `pSymbolName` in the scrip master file"). | S2 docs, S3 |
| `pTrdSymbol` | Trading symbol (used for orders). Monthly: `NIFTY23APR15450CE`, `NIFTY23MAYFUT`. Weekly: `NIFTY2342015450CE` (YY + month code 1–9/O/N/D + DD), `MIDCPNIFTY23516FUT`. Do not parse it for data. Use the numeric columns. | S3 |
| `pOptionType` | `CE`, `PE`, or **`XX` for futures** | S1 code comment, S3 |
| `pAssetCode` | For index F&O rows, the underlying's nse_cm token: NIFTY **26000**, BANKNIFTY **26009**, FINNIFTY **26037**, MIDCPNIFTY **26074**. Sometimes empty. | S3 (2023) |
| `pExpiryDate` / `lExpiryDate` | **nse_fo (and cde_fo)**: seconds since **1980-01-01 00:00:00 IST** (the NSE epoch), stamped at 14:30 IST of the expiry date. Example: `1366468200` → 2023-04-20 14:30, matching `NIFTY2342015450CE`. Convert with `unix = v + 315513000` (315513000 = 1980-01-01T00:00+05:30). The SDK instead uses `pd.to_datetime(v, unit="s") + 315511200 s` and keeps only the date (`%d%b%Y`), which gives the same date. **bse_fo and mcx_fo**: the SDK treats the value as plain **Unix seconds** with no offset (**UNCONFIRMED** against a live file). Robust rule: if `v` read as Unix is more than 30 days in the past for a listed contract, add 315513000. `-1` means no expiry. | S1 `scrip_search.py`; arithmetic verified on S3 rows |
| `dStrikePrice;` | **Strike × 100** (paise). Example: `1.75e+06` → ₹17 500. **May appear in scientific notation**: 5 395 of 51 209 rows in S3. Use `parseFloat(x) / 100` and round to 2 dp. `-1` for futures and cash. The SDK's strike filter multiplies the user's strike by 100. For cde_fo/mcx_fo the scale may follow `lPrecision` instead (**UNCONFIRMED**). | S1, S2 unit test ("22000 matches 2200000"), S3 |
| `lLotSize`, `iLotSize` | Lot size (identical in the sample; NIFTY 50 in 2023). Today the option-chain endpoint's `common_data.mktLot` also gives it. | S3 |
| `iMaxOrderSize`, `lFreezeQty` | Max order quantity, i.e. freeze limit + 1 (NIFTY 1801 when the freeze was 1800). Use it to slice orders. This reading is an inference. | S3 |
| `lPrecision` | Decimal precision (2), i.e. paise scaling for prices in the CSV | S3 |
| `dTickSize` | Tick in paise (`5` → ₹0.05; cash `1` → ₹0.01) | S3 |
| `dHighPriceRange`, `dLowPriceRange` | Price band / circuit limits at file time, **in paise**. Can be scientific (`2.07898e+06`). | S3 |
| `dOpenInterest` | OI snapshot at file generation. **Stale. Do not use as live.** | S3 |
| `dPriceNum`, `dPriceDen`, `dGenNum`, `dGenDen`, `lMultiplier` | Price/general multipliers (1/1/1/1 and −1 for NSE). Relevant for currency/commodity (**UNCONFIRMED** semantics). | S3 |
| `pSegment`, `pExchange` | `FO` or `CASH`, and `NSE` or `BSE` (empty on spread rows) | S3 |
| `pISIN`, `pDesc`, `pSettlementType`, `pFaceValue`, `iBoardLotQty`, `iPermittedToTrade` | Static reference data | S3 |

### 3.3 Index identification (spot underlying)
- For **quotes and the websocket**, indices are addressed by **name in place of the token**, in segment `nse_cm` (or `bse_cm` for SENSEX). The official list in the legacy doc (S3 `docs/webSocket.md`, "For Indexes ... Below is the Index Names that should be used in place of instrument token") is:
  - `Nifty 50`
  - `Nifty Bank`
  - `Nifty Fin Service`
  - `SENSEX`
  - `INDIA VIX`
  - `NIFTY MIDCAP 100`
- The current docs (S2) confirm `WsToken("nse_cm","Nifty 50")`, `("nse_cm","Nifty Bank")` and `("bse_cm","SENSEX")`, and the legacy Quotes doc shows `{"instrument_token":"Nifty 50","exchange_segment":"nse_cm"}`. URL-encode the space: `nse_cm|Nifty%2050`.
- Names for Nifty Midcap Select (MIDCPNIFTY) and BANKEX are **UNCONFIRMED**.
- The legacy `nse_cm.csv` also has numeric index rows (`pSymbol` 26000 `NIFTY`, 26009 `BANKNIFTY`, 26037 `FINNIFTY`, 26074 `MIDCPNIFTY`, empty `pGroup`). The streamed `SFeedIndex` messages carry this numeric token ("the server resolved the index to"). Whether REST quotes accept `nse_cm|26000` is **UNCONFIRMED**. Use the names.

### 3.4 Building an option chain from the scrip master (needed if the option-chain endpoint is not enough)
1. Resolve the file paths, then download `nse_fo` (or `bse_fo` for SENSEX). Parse with trimmed headers.
2. Keep rows with `pSymbolName == "NIFTY"`, `pInstType == "OPTIDX"`, `pOptionType ∈ {CE, PE}` and non-empty `pSegment`. The single-token check comes from section 3.2.
3. Decode the expiry as in section 3.2 and group by expiry date. Optionally cross-check against `GET .../watchlist/expiries` (section 6).
4. Compute `strike = parseFloat(row["dStrikePrice;"]) / 100`. Pair CE and PE per strike. Key each leg as `nse_fo|<pSymbol>`. The lot comes from `lLotSize`.
5. Get spot from `quotes(nse_cm|Nifty 50)` and futures from the `FUTIDX` rows of the same `pSymbolName`.
6. Get live data for the legs with REST quotes in chunks of ≤50 at ≤25 req/s (section 4), or with a websocket subscription (≤3000 tokens total per connection, S2 `websocket.md`).

---

## 4. Quotes REST (LTP / OHLC / depth / OI)

```
GET {baseUrl}/script-details/1.0/quotes/neosymbol/{seg}|{token}[,{seg}|{token}...]/{quote_type}
Authorization: <consumer_key>
```
- Example: `.../neosymbol/nse_cm|1333,nse_fo|71472,nse_cm|Nifty%2050/all`.
- S1 3.0.x keeps `|` and `,` **literal** (`urllib.parse.quote(s, safe="|,")`) and says "The REST API expects the '|' and ',' delimiters ... to stay literal". The legacy S3 and the Node client S6 percent-encoded them (`%7C`, `%2C`), so both forms seem to work (**UNCONFIRMED** for the encoded form today).
- `quote_type` values: `all` (default), `market_depth` (the legacy doc says `depth`), `ohlc`, `ltp`, `oi`, `52w`, `circuit_limits`, `scrip_details`. Use `all`. The field sets for the other types are undocumented, except `ltp`, which returns `exchange`, `exchange_token`, `ltp` (S2 positions code).
- **Limits (official S2 `quotes.md`): max 50 instruments per call, enforced by the backend; endpoint rate limit 25 requests/second.** Average latency is about 289 ms.
- Response is a **JSON array** at the top level. Defensively, also accept `{"data":[...]}`, since S2 internal code handles both. Every value is a **string**.

```json
[{"exchange_token":"1333","display_symbol":"HDFCBANK-EQ","exchange":"nse_cm",
  "lstup_time":"1782374657","ltp":"801.6000","last_traded_quantity":"550",
  "total_buy":"907335","total_sell":"2883870","last_volume":"30043533",
  "avg_cost":"799.8900","open_int":"0","change":"8.4000","per_change":"1.0600",
  "low_price_range":"713.9000","high_price_range":"872.5000",
  "year_high":"2037.7","year_low":"726.65",
  "ohlc":{"open":"798.5000","high":"804.4500","low":"796.0000","close":"793.2000"},
  "depth":{"buy":[{"price":"801.6000","quantity":"1733","orders":"4"}, ... 5 levels],
           "sell":[{"price":"801.6500","quantity":"550","orders":"1"}, ... 5 levels]}}]
```

| Need | Field |
|---|---|
| LTP | `ltp` |
| Open / High / Low | `ohlc.open`, `ohlc.high`, `ohlc.low` |
| **Previous close** | `ohlc.close`. It is the previous day's close: in the sample, `ltp − ohlc.close = 801.60 − 793.20 = 8.40 = change` and `8.4/793.2 = 1.06% = per_change`. |
| Change / % change | `change`, `per_change` |
| Volume (day total) | `last_volume` |
| Open interest | `open_int`. Previous OI and OI change are **not** in quotes; use the option-chain endpoint. |
| Avg traded price (VWAP/ATP) | `avg_cost` |
| Total buy / sell qty | `total_buy`, `total_sell` |
| Last traded qty | `last_traded_quantity` |
| Last update time | `lstup_time`, Unix epoch **seconds** as a string (1782374657 → 2026-06-25 13:34:17 IST). There is no separate last-trade-time field (**UNCONFIRMED**). |
| 52-week high / low | `year_high`, `year_low` |
| Upper / lower circuit | `high_price_range`, `low_price_range` (±10% of prev close in the sample) |
| Depth | `depth.buy[0..4]`, `depth.sell[0..4]`, each `{price, quantity, orders}` |
| Symbol | `display_symbol`, `exchange`, `exchange_token` |

- The response shape for **index** symbols (e.g. `nse_cm|Nifty 50`) is not documented. The SFeed index packet carries LTP, prev close, high, low, open, change and %change, but the REST field names for indices are **UNCONFIRMED**. Expect `ltp` and `ohlc`, but code defensively.
- HTTP codes: 200, 400, 403 (invalid session), 429, 500, 502 (OMS), 503, 504.

---

## 5. Historical candles: **YES**, an endpoint exists in SDK ≥ 3.0.6 (2026-09-05)

The S2 CHANGELOG for 3.0.6 says: "New Functions — `expiries()`, `option_chain()`, `historical_data()` ... (expiry dates, option/futures chains, historical candles)".
```
GET {baseUrl}/market-data/1.0/historical/details?neosymbol=nse_cm|1333&interval=10min&fromdate=2026-08-20&todate=2026-09-01
Authorization: <consumer_key>
```
- Query params are lowercase on the wire: `neosymbol`, `interval`, `fromdate`, `todate` (S1 comment: "Wire query params are lowercase ... matching the real backend endpoint").
- `neosymbol` is `{exchange_segment}|{instrument_token}`.
- `interval` is one of `1min 3min 5min 10min 15min 30min 60min D W`. Anything else returns `{"status":"ERROR","fault":{"code":400,"message":"Invalid interval value"}}`.
- Dates are `YYYY-MM-DD`. `todate` may be today, which gives intraday-to-now candles.
- **Max range per request** (backend-enforced):

  | Interval | Max days |
  |---|---|
  | 1, 3, 5 min | 30 |
  | 10, 15 min | 60 |
  | 30, 60 min | 90 |
  | D | 180 |
  | W | 180 |

- **Not available** for `mcx_fo` and `nse_com`.
- Response:
```json
{"status":"success","interval":"1min",
 "data":{"candles":[["2026-08-20T09:15:00+0530",12009.9,12019.35,12001.25,12001.5,163275,13667775], ...]}}
```
  - Each row is `[timestamp, open, high, low, close, volume, oi]`, with numeric values (not strings).
  - The timestamp is ISO 8601 with a **`+0530` offset that has no colon**. Normalise it to `+05:30` before calling `Date.parse` in JS.
  - The docs call this "the key change from the legacy parallel-array response shape". Older or other backends may return parallel arrays, so code defensively.
- **OI in candles is not populated yet.** Maintainer reply, issue #39 (2026-09-28): `oi` "currently returns 0/null ... shouldn't be relied on ... hasn't been rolled out on the backend ... no firm ETA". **No OI history is available from Kotak.** Record it yourself from live quotes or option-chain polling.
- **F&O and index coverage:** the issue #35 reporter fetched candles for 14 NIFTY option contracts (nse_fo tokens), so nse_fo works (COMMUNITY). Index candles (`nse_cm|Nifty 50` or `nse_cm|26000`) are **UNCONFIRMED**.
- **Rate limit:** undocumented ("rate-limited by the backend Trade APIs"). In issue #35 (COMMUNITY, Sep 2026):
  - About 0.25–0.5 s spacing produced 429 after 1–2 calls; 1.0 s and 2.0 s spacing gave 14/14 successes.
  - About 50 calls/min across loops caused a multi-hour 429 lockout (about 2h45m, cleared after about 7h45m on one occasion).
  - The reporter's mitigation: ≥1.5 s between `historical_data`/`expiries`/`option_chain` calls, cache expiries and chains, and retry once after 3 s on 429.
  - **Budget about 1 req/s or slower for this endpoint family.**

---

## 6. Option chain and expiries: **YES**, endpoints exist. **No Greeks or IV anywhere** (searched: no greek, delta or IV fields in SDK, docs or tests).

### 6.1 Expiries
```
GET {baseUrl}/market-data/1.0/watchlist/expiries?exchange=nse_fo&underlying=NIFTY[&instrument_type=option|fut]
Authorization: <consumer_key>
```
- `exchange` is one of `nse_fo`, `bse_fo`, `mcx_fo`. `underlying` equals `pSymbolName`. `instrument_type` defaults to `option`.
- Response: `{"exchange":"nse_fo","underlying":"RELIANCE","expiries":["2026-06-25","2026-06-30","2026-07-31"]}` (ISO dates, ascending).

### 6.2 Option chain
```
GET {baseUrl}/market-data/1.0/watchlist/option-chain?exchange=nse_fo&underlying=NIFTY&expiry=2026-06-23&instrument_type=option&count=40
Authorization: <consumer_key>
```
- `expiry` (ISO) is optional; the default is the nearest expiry.
- `count` is the number of strikes. It must be a multiple of 10 or the call returns 400. The default is 40 strikes, i.e. 80 instruments. **The maximum `count` is UNCONFIRMED.** For a full chain of more than 40 strikes, build it from the scrip master (section 3.4).
- Response:
```json
{"data":{
  "common_data":{"mktLot":"65","multiplier":"1","unlSymbol":"NIFTY","exSeg":"nse_fo","expiryDt":"2026-06-23"},
  "call":[{"instrument":{"neoSymbol":"nse_fo|71472","symbol":"NIFTY26JUN22250CE","optionType":"CE","strikePrice":"22250","moneyness":"ATM"},
           "quote":{"ltp":"166.7500","open":"89.8000","high":"214.0000","low":"77.1000","prevClose":"99.7000","close":null,"volume":225431505},
           "openInterest":{"current":10715645,"previous":13647630,"change":-2931985,"changePct":-21.48}}],
  "put":[ ...same shape... ]}}
```
- Here `strikePrice` is already in rupees, as a string. `close` is null intraday and is filled at settlement. `prevClose` is stable for the session. `openInterest.change` and `changePct` are computed by the server.
- `instrument_type=fut` returns a `fut[]` array with **different, abbreviated keys**: `inst{neoSymbol,symbol,expiryDt:"31-JUL-2026"}`, `quote{ltp,o,h,l,c,pc,vol}` and `oi{cur,prev,chg,chgPct}`, all strings. Without `expiry`, the array holds all futures expiries.
- The response has no underlying spot, no IV and no Greeks. **Compute IV and Greeks locally** (Black-76 or Black-Scholes) from LTP, spot or futures, time to expiry and a rate.
- Rate limit: undocumented. Treat it like historical (≥1–1.5 s spacing, COMMUNITY).

---

## 7. Positions, orders and limits (we will NOT place orders; listed briefly)
All of these go on `{baseUrl}` with the `Sid` + `Auth` headers from section 2 and need a completed validate. The SDK returns `{"Error Message":"Complete the 2fa process ..."}` without them.

| Function | Method + path | Body (`jData`) |
|---|---|---|
| Order book | GET `quick/user/orders` (single order: `quick/user/orders/{orderNo}`) | – |
| Order history | POST `quick/order/history` | `{"nOrdNo":"<id>"}` |
| Trade book | GET `quick/user/trades` | – |
| Positions | GET `portfolio/v2/positions` (SDK 3.0.9; 3.0.7 used `quick/user/positions`). The response carries `ltp`, `tok`, `exSeg`, `trdSym`, buy/sell qty and amounts, `lotSz`, `exp` (Unix seconds), ... | – |
| Holdings | GET `portfolio/v1/holdings` | – |
| Limits | POST `quick/user/limits` | `{"seg":"ALL","exch":"ALL","prod":"ALL"}` |
| Margin check | POST `quick/user/check-margin` | `{exSeg,prc,prcTp,prod,qty,tok,trnsTp,trgPrc,brkName,brnchId,...}` |
| Client IP | GET `https://mis.kotaksecurities.com/login/1.0/get-client-ip`, returning `{"data":[{"ip","time"}],"stCode":1000}` | – |
| **DO NOT USE** place / modify / cancel | POST `quick/order/rule/ms/place`, `quick/order/vr/modify`, `quick/order/cancel` (these also need the `Authorization` consumer key) | `{am,dq,es,mp,pc,pr,pt,qt,rt,tp,ts,tt,ig,os:"NEOTRADEAPI"}` |

The order/position push feed is `wss://<baseUrl host>/realtime` (or the config-service `interactive_endpoint`). Its handshake text frame is `{type:cn,Authorization:<trade token>,Sid:<trade sid>,src:WEB}`. This is not JSON-quoted; it is verbatim from S1 and S2.

---

## 8. Hostnames the app must be allowed to reach

| Host | Used for | Evidence |
|---|---|---|
| `mis.kotaksecurities.com` | `tradeApiLogin`, `tradeApiValidate`, `get-client-ip`; default REST base before `baseUrl` is known; default order feed `wss://mis.../realtime` | S1 `urls.py`, `settings.py` |
| `e21.kotaksecurities.com`, `e22.kotaksecurities.com`, `e41.kotaksecurities.com`, `e43.kotaksecurities.com` | Per-data-center `baseUrl` (all REST incl. quotes, scrip-master paths, option-chain, historical) and `wss://<host>/realtime` | S1 `urls.py` `ORDER_FEED_URL_E*`; validate sample `"baseUrl":"https://eXX.kotaksecurities.com"` |
| `cis.kotaksecurities.com` | ADC data-center base and `wss://cis.../realtime` | S1 `PROD_BASE_URL_ADC`, `ORDER_FEED_URL_ADC` |
| `lapi.kotaksecurities.com` | **Scrip-master CSV files** (`/wso2-scripmaster/v1/prod/<date>/...`) and the **dynamic config service** (`/5config/config`) | S2 docs; S1 `CONFIG_SERVICE_URL_PROD` |
| `sfeed.kotaksecurities.com` | SFeed market-data websocket. The SDK constant is `wss://sfeed.kotaksecurities.com/apifeed`; the Postman/README stub says `/wsfeed`. The real URL comes from the config service or `feedUrl` at runtime. | S1 `urls.py`, S2 Postman |

- **Recommendation: allow `*.kotaksecurities.com` on 443 (HTTPS and WSS).** `baseUrl`, `feedUrl`, `rtUrl` and the config-service websocket endpoints are dynamic per account and data center, and new hosts can appear without an SDK change. The config service exists precisely so feeds "stay accurate without needing an SDK update".
- Legacy and UAT hosts are not needed: `mlhsm.kotaksecurities.com` (old HSM websocket), `gw-napi`, `napi`, `mnapi`, `cnapi` (v1, retired 1 Oct 2025), `d-mis.kotaksecurities.com`, `nsbxapi*` (UAT) and `qapi.kotaksecurities.online` (UAT config).
- For TOTP, sync time with any NTP source. No Kotak host is involved.

---

## 9. Implementation checklist for the TypeScript server (derived)
1. Read the env vars `NEO_CONSUMER_KEY`, `NEO_MOBILE_NUMBER` (+91...), `NEO_UCC`, `NEO_MPIN` and `NEO_TOTP_SECRET` (base32). Never log them. The SDK masks `totp`/`mpin`/token fields in its logs; do the same.
2. Login sequence:
   1. Generate the TOTP (section 1.5).
   2. POST `tradeApiLogin` and check `data.token`/`data.sid`.
   3. POST `tradeApiValidate` and store `token`, `sid`, `baseUrl`, `dataCenter` and `ucc` (plus `feedUrl`/`rtUrl` if present).
   4. Optionally GET the config service for the websocket URLs.
3. Daily: fetch the scrip-master file paths, then the CSVs for `nse_cm`, `nse_fo`, `bse_cm` and `bse_fo`. Trim the headers, drop spread rows, decode expiry and strike, and build token maps (underlying → expiry → strike → {CE, PE} tokens, lot, freeze qty).
4. Live snapshots: quotes in batches of ≤50, globally throttled to ≤25 req/s, with `Retry-After` honoured. Use option-chain or expiries for server-computed OI change, at ≤1 req/1–1.5 s. Use websocket streaming for ticks (separate research topic; 3000-token cap).
5. History: `historical/details` paced at ≤1 req/s, with chunked date windows per the interval limits table (section 5). There is no OI history, so persist your own OI snapshots.
6. On 401/403 or a missing `data`, re-login once (new TOTP window) and retry. On 429, back off with `Retry-After`, or ≥3 s otherwise; never hammer.
7. Greeks and IV are computed locally. Kotak supplies none.
