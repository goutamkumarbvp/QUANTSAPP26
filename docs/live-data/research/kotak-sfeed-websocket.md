# Kotak Neo live market-data WebSocket — port-level research (for a TypeScript / Node `ws` re-implementation)

Research date: 2026-10-12. No Kotak endpoint was called. Everything below comes from official SDK source code, official docs, and their unit tests. Anything not confirmed by those sources is marked **UNCONFIRMED**.

---

## 0. TL;DR: the "HSM" feed is retired, so build the SFeed `native_batch` client

1. **The HSM feed (`wss://mlhsm.kotaksecurities.com`, binary big-endian, `{"type":"cn","Authorization":…,"Sid":…}`) is legacy.**
   - Kotak's notice says the HS market feed was **deprecated on 15 Sep 2026** and "may no longer deliver market data" after that date. It also says changing only the URL is not enough.
   - The official SDK removed every HSM code path in v2.2.0. `client.subscribe()` now raises `NotImplementedError`.
   - Source for the notice: the openalgo issue that quotes it, plus search snippets of Kotak's support page. I could not fetch the kotakneo.com page itself (see §13).
   - Appendix A still documents HSM for completeness, but **do not build on it.**
2. **The current official feed is "SFeed", protocol `native_batch`.**
   - Default URL: `wss://sfeed.kotaksecurities.com/apifeed`. In practice the URL is resolved per data center (see §2).
   - Control plane: JSON text frames for auth, subscribe, unsubscribe, snapshot and acks.
   - Data plane: binary frames that are little-endian, packed and batched, each packet with a `uint16` length prefix.
   - No application-level heartbeat. Use WebSocket ping/pong.
   - Prices are integers divided by a per-exchange divider that arrives in the auth response.
3. **Primary sources used.** All are official Kotak-Neo artifacts.
   - PyPI `kotakneoapi==3.0.7`. The package name is `neo_api_client`. Files read:
     - `neo_api_client/websocket/feed/{client,protocol,models,exceptions}.py`
     - `utils/urls.py`, `utils/neo_utility.py`, `utils/ws_scheme.py`, `services/totp.py`, `neo_api.py`, `rest.py`
   - GitHub `Kotak-Neo/kotak-neo-python` at `main` commit `099e6a6` (2026-10-08, version 3.0.9). Its `websocket/feed/*` files are byte-identical to PyPI 3.0.7. Also read:
     - `docs/guides/websocket.md`, `docs/functions/websocket/market_feed.md`
     - `tests/unit/test_feed_protocol.py`, `test_feed_client.py`, `test_feed_client_lifecycle.py`
     - `CHANGELOG.md`
   - GitHub `Kotak-Neo/Kotak-Neo` at commit `65a67e5` (2026-10-08). Files read: `docs/market-data-apis/websocket.md` (the **official language-agnostic protocol spec**) and `docs/authentication.md`.
   - Legacy GitHub `Kotak-Neo/kotak-neo-api-v2` at commit `8cee5bd` (2026-06-08). Files read: `neo_api_client/HSWebSocketLib.py`, `NeoWebSocket.py`, `urls.py`, `settings.py`, `docs/webSocket.md`.
   - `pip download neo_api_client` returns no distribution on PyPI. The v2 package only exists on GitHub.
4. **No official JS/TS implementation exists.** The npm packages and third-party ports are covered in §12.

---

## 1. Files saved in the scratchpad

- `live-research/hsm-websocket/dl/kotakneoapi-3.0.7-py3-none-any.whl`, extracted to `…/ex/`
- `live-research/hsm-websocket/repos/kotak-neo-python/` (official SDK, GitHub main)
- `live-research/hsm-websocket/repos/Kotak-Neo/` (official REST and WebSocket docs)
- `live-research/hsm-websocket/repos/kotak-neo-api-v2/` (legacy HSM SDK)
- `live-research/hsm-websocket/repos/openalgo/broker/kotak/streaming/` (third-party Python port, used for cross-checks only)
- `live-research/hsm-websocket/npm/` (npm `kotak-neo-nodejs-sdk@1.0.15` and `@its_seraj/trade@1.0.7`; neither has any WebSocket code)
- `live-research/scripts/vectors.py` (generates the binary test vectors in §9)

---

## 2. Endpoint resolution (which `wss://` URL to dial)

### 2.1 Hard-coded default

`neo_api_client/utils/urls.py`:

```
SFEED_WEBSOCKET_URL = "wss://sfeed.kotaksecurities.com/apifeed"
```

The SDK guide also says the default is `wss://sfeed.kotaksecurities.com/apifeed`. Older SDK docstrings mention `/wsfeed`; that is stale.

### 2.2 Per-account URL, option A: the `feedUrl` from `tradeApiValidate` (official doc)

The official doc (`Kotak-Neo/docs/market-data-apis/websocket.md` §2) works like this:

- Log in with `POST https://mis.kotaksecurities.com/login/1.0/tradeApiValidate`.
- The response `data` contains `sid`, `baseUrl`, **`feedUrl`** and `rtUrl`.
- Use `data.feedUrl` and change the scheme from `https` to `wss`, for example `https://…/apifeed` becomes `wss://…/apifeed`.
- The handshake needs no custom HTTP headers and no sub-protocol. Authentication happens in the first application message.

### 2.3 Per-account URL, option B: dynamic config service (what the SDK prefers)

This is in `utils/neo_utility.py` `resolve_dynamic_urls()` and is called right after `totp_validate()`.

Request:

```
GET https://lapi.kotaksecurities.com/5config/config?appVersion=<sdk version, e.g. 3.0.7>&platform=api&environment=prod
Headers: Content-Type: application/json   (no auth headers; X-Request-ID is optional)
Timeout: 5 s
```

UAT uses `https://qapi.kotaksecurities.online/5config/config` with `environment=qa`.

Response handling:

```
configs = response.data.configs
src = configs["<dataCenter>_broadcast_source"]                  # e.g. "sh" | "ks" | ("hs" = legacy HSM)
feed = configs["<dataCenter>_<src>_broadcast_endpoint"]          # market-data URL, returned with an https scheme
orderFeed = configs["<dataCenter>_<src>_interactive_endpoint"]  # order-feed URL
```

- `dataCenter` comes from the `tradeApiValidate` response (for example `"E22"`, `"E43"`).
- Convert the URL scheme with `https→wss` and `http→ws` (`utils/ws_scheme.py`).
- openalgo adds one more case: some "hs" entries come back as bare hostnames with no scheme, so prefix them with `wss://`.

### 2.4 Precedence

- **SDK precedence** (`neo_api.py create_websocket()`): explicit url, then the config-service result, then `feedUrl`, then the default.
- **Third-party observation (openalgo, UNCONFIRMED):**
  - 6 of 10 data centers resolve to `sh` (SFeed) and 4 resolve to `ks` ("cdtstream").
  - No data center selects `hs` any more.
  - openalgo, like the SDK, speaks `native_batch` to both `sh` and `ks` hosts.
- **Recommendation:** try the config service, then `feedUrl`, then the default, and log which one was used.
  - If `src == "hs"`, refuse. That would be the retired protocol.

### 2.5 Network requirements

You need outbound TLS to `*.kotaksecurities.com` on port 443: `lapi`, `mis`/`cis`, `sfeed`, and whatever host `feedUrl` names.

---

## 3. Connect and authenticate

### 3.1 Handshake

Plain RFC 6455 handshake. TLS certificates are verified (SDK `verify_ssl=True`).

The SDK uses the Python `websockets` library with `ping_interval=20`. That library's default `ping_timeout` is 20 s, and by default it also offers `permessage-deflate`. Node `ws` also offers permessage-deflate by default, so keep that default. Whether the server accepts deflate is **UNCONFIRMED**. There is no application-level compression.

### 3.2 Auth frame

This is the first frame after `open`. It is a JSON **text** frame.

SDK `_build_auth_frame()`, exactly as sent by v3.0.7:

```json
{
  "user": "<UCC>",
  "auth": "<sid from tradeApiValidate>",
  "format": "native_batch",
  "source": "NEOTRADEAPI",
  "platform": "Web",
  "version": "1.2.3",
  "sdk_version": 2,
  "sdk_date": "2026-08-07T09:41:17.667Z",
  "conn_req_time": 1760250000000,
  "sessionValidation": false
}
```

Field notes:

- **`user`** is the UCC (for example `ABC12`).
  - The SDK uses the `ucc` from the `tradeApiValidate` or `tradeApiLogin` response.
  - The official auth doc says the `ucc` in those responses is "(masked)" in the doc samples.
  - Safer choice: send the UCC you logged in with. Whether the server validates `user` is **UNCONFIRMED**. The SDK falls back to the placeholder `"neome"` when it has no UCC.
- **`auth`** is the **`sid`** (session id) from the `tradeApiValidate` response. It is **not** the JWT `token`.
  - The official doc says: "`auth` — Your session token (the `sid` from the login response)".
  - SDK: `self.auth = auth if auth is not None else (sid or "1")`, with `sid=configuration.edit_sid`.
  - The `create_websocket()` docstring says "user = edit_sid, auth = edit_token". That docstring is **stale and wrong**; the code passes `ucc` and `sid`.
- **`format`** must be `"native_batch"`.
- **`source`** must be `"NEOTRADEAPI"`.
  - The official doc says "`source` / `platform` … must be `NEOTRADEAPI`". The SDK sends `platform: "Web"`.
  - openalgo claims (UNCONFIRMED) that the frame is rejected if these fields are missing but that their values are not validated.
  - Copy the SDK frame verbatim.
- **`sdk_version` / `sdk_date`** are build markers. The official doc example uses `"sdk_version": 1.1`; the SDK sends `2`.
- **`conn_req_time`** is the current epoch in **milliseconds** (`int(time.time()*1000)`).
- **`sessionValidation`** is `false` in the SDK.

### 3.3 Auth responses (JSON text frames)

| `message_code` | Meaning (official doc §3 and §9) | SDK 3.0.7 behaviour |
|---|---|---|
| **1117** | Auth success. Carries `exchanges` and dividers. | Treated as success. |
| **1119** | "Initial connect response". Same body as 1117. The doc says it "does **not** by itself indicate success". | **Treated as success.** The SDK comment says "1119 (SFeed production)". The test fixture `_AUTH_1119` is labelled "Real SFeed production auth response". |
| **1120** | `{"message_code":1120,"message":"Auth failed ..."}`. The doc says "the server breaks the socket after sending". | Not handled explicitly. The SDK treats any first text frame other than 1117/1119 as `AuthenticationError`. |

Real production body, taken from an SDK test fixture:

```json
{"message_code":1119,"id":"SFD_CPROD_701","version":1,
 "exchanges":{"nse_cm":{"value":1,"divider":100},"nse_fo":{"value":2,"divider":100},
              "cde_fo":{"value":3,"divider":10000000},"bse_cd":{"value":7,"divider":10000000}}}
```

How the SDK authenticates:

- It reads up to 10 frames, each with a 10 s `recv` timeout, **skipping binary frames**, until the first text frame arrives.
- If that frame's `format == "native_fallback"`, it fails. That is a different body layout, out of scope.
- Dividers are stored keyed by numeric exchange id: `id = info.value ?? EXCHANGE_NAME_TO_ID[name]` and `divider = info.divider ?? 100`.
- Any exchange missing from the response defaults to divider **100**.

Recommended TS behaviour:

- Accept 1117 or 1119 as authenticated and store the dividers from each.
- On 1120, or on a close within about 15 s of opening, treat the attempt as an auth failure. The likely cause is an expired `sid`, so re-run TOTP login and then reconnect.
- openalgo reports (UNCONFIRMED) that "the socket stays open on a rejected auth", which conflicts with the official doc. So also arm an auth timeout of about 15 s.
- The SDK docstring notes that "some endpoints (e.g. the beta feed) reject the connection a few seconds in if `auth` doesn't match a real session's sid".

### 3.4 Exchange enum (`exchange_id`, signed int8 in packet headers)

| id | name | typical divider |
|---|---|---|
| 0 | `none` | |
| 1 | `nse_cm` | 100 |
| 2 | `nse_fo` | 100 |
| 3 | `cde_fo` | 10,000,000 |
| 4 | `nse_com` | 10,000 |
| 5 | `bse_cm` | 100 |
| 6 | `bse_fo` | 100 |
| 7 | `bse_cd` | 10,000,000 |
| 8 | `bse_co` | 10,000 |
| 9 | `mcx_fo` | 100 |
| 10 | `ncd_co` | 1 |

Always use the dividers from the auth response. The "typical" column comes from the official doc §9.

---

## 4. Control plane: subscribe, unsubscribe, snapshot, ack

### 4.1 Frame shapes (JSON text)

```json
{"event":"subscribeScrips","inputtoken":"nse_fo|44498,nse_fo|44500","ack_symbol":true}
{"event":"unsubscribeScrips","inputtoken":"nse_fo|44498,nse_fo|44500"}
{"event":"snapshotScrips","inputtoken":"nse_cm|11536","ack_symbol":true}
{"event":"subscribeExchange"}
{"event":"unsubscribeExchange"}
```

- `inputtoken` is a **comma-separated** list of `<exchange_segment>|<token>` entries.
  - The legacy HSM used `&` as the separator; SFeed uses `,`.
  - The token can be numeric (the scrip-master token) or an index or instrument **name**, for example `nse_cm|Nifty 50`.
- `ack_symbol: true` is **only** sent on subscribe and snapshot. It is **never** sent on unsubscribe (the SDK test asserts this).
- The SDK puts *all* tokens in one frame. It never chunks, and there is no documented per-frame cap.
  - A 3000-token string is about 45–50 KB.
  - Whether the server has a frame-size cap is **UNCONFIRMED**. Suggested defensive chunk size: ≤ 500 tokens per frame.

### 4.2 Events by intent

| Intent | Level byte in data packets | subscribe | unsubscribe | snapshot | Decoded type |
|---|---|---|---|---|---|
| Mini touch line ("lite") | 1 | `subscribeScripsLite` | `unsubscribeScripsLite` | `snapshotScripsLite` | Mini (54 B) |
| Touch line (LTP + OHLC + OI + best bid/ask) | 4 | `subscribeScrips` | `unsubscribeScrips` | `snapshotScrips` | MarketPicture |
| Depth | 8 | `subscribeDepth` | `unsubscribeDepth` | `snapshotDepth` | MarketPicture with N rows |
| Full depth (SDK only, not in the official doc) | 16 | `subscribeFullDepth` | `unsubscribeFullDepth` | (none) | MarketPicture |
| Index | n/a (message_code 7207) | `subscribeIndices` | `unsubscribeIndices` | `snapshotIndices` | Index (87 B) |
| Market status (SDK only) | n/a (message_code 105) | `subscribeExchange` (no `inputtoken`) | `unsubscribeExchange` | (none) | MarketStatus (16 B) |

Notes on the table:

- Subscribe and depth subscriptions can also deliver message_code 104 (CAS) packets for the same tokens.
- Snapshot replies arrive on the **binary** feed using the same packet types as live data.

### 4.3 Subscribing to indices

- The official doc example uses `{"event":"subscribeIndices","inputtoken":"nse_cm|26000"}` (numeric token).
- The SDK docs use names, for example `WsToken("nse_cm","Nifty 50")`, `("nse_cm","Nifty Bank")`, `("bse_cm","SENSEX")`.
- Legacy name list from the v2 docs, all valid under `nse_cm` except SENSEX:
  `Nifty 50`, `Nifty Bank`, `Nifty Fin Service`, `SENSEX` (bse_cm), `INDIA VIX`, `NIFTY MIDCAP 100`, `Nifty 100`, `Nifty PSU Bank`, `Nifty Pharma`, `Nifty IT`, `Nifty PSE`, `Nifty FMCG`, `Nifty 500`, `Nifty Auto`, `Nifty CPSE`, `Nifty 200`, `Nifty Next 50`, `NIFTY MID SELECT`.
- Exact case sensitivity is **UNCONFIRMED**.
- Index packets carry the **numeric** token (for example 26000) plus a 21-byte `name` (for example `"NIFTY 50"` in the SDK test). The 1109 ack for an index is keyed by the name you subscribed with, so look symbols up by `exchange|name` as a fallback.
- The SDK README also shows `subscribe_scrips([WsToken("nse_cm","Nifty 50")])`. Use `subscribeIndices` for indices. What `subscribeScrips` returns for an index is **UNCONFIRMED**.

### 4.4 Subscribe acknowledgement (`message_code` 1109, JSON text)

The two primary sources **disagree** on the format. Parse both.

Format the SDK and openalgo parse (from an SDK test fixture):

```json
{"message_code":1109,"message":"Subscribed",
 "trading_symbols":{"nse_cm|2885":"RELIANCE-EQ","nse_cm|22":"ACC-EQ"}}
```

Format in the official doc §5:

```json
{"message_code":1109,"error_code":0,"description":"SUBSCRIBED",
 "data":{"nse_cm|1333":{"cas_status":1,"trading_symbols":"HDFCBANK-EQ"}}}
```

How the ack behaves:

- The ack is **not guaranteed to arrive before the first tick** (official doc).
- The SDK withholds ticks for tokens with unknown symbols for up to `ack_wait_timeout = 5 s`. During that window it keeps only the latest tick per `(exch|token|type|level)` and then flushes.
- **For our app:** do not withhold anything. Our scrip master already gives token→symbol, so the ack is optional. You can even omit `ack_symbol`, though the SDK always sends it.

### 4.5 Subscription limit

- **3000 input tokens** may be subscribed per client at once.
- The count is a running total across all intents, so the same token under two intents counts twice in the SDK's `(token,intent)` set.
- Both the official doc and the SDK state this. The SDK enforces it client-side by raising `SubscriptionError` and sending nothing.
- What the server does when the cap is exceeded is **UNCONFIRMED**.
- The number of concurrent feed connections allowed per user is **UNCONFIRMED**. Use one.
- No rate limit on control frames is documented (**UNCONFIRMED**).

---

## 5. Data plane: binary framing and structures

All multi-byte integers are **little-endian**. Structs are **packed** (no padding). Offsets `@n` are from the start of the *packet*, header included.

### 5.1 Batch de-framing

One WebSocket binary message is a batch of packets laid back to back.

- Each packet starts with its own `uint16 LE` total length `N`.
- `N` counts the whole packet: the 2 length bytes, the rest of the 9-byte header, and the body.
- SDK `split_batch`:

```
off = 0
while off + 2 <= frame.length:
    size = u16le(frame, off)
    if size < 9 or off + size > frame.length: break   # garbage or truncated tail: stop
    packets.push(frame[off : off+size]); off += size
```

### 5.2 Common header (9 bytes)

| @ | type | field | notes |
|---|---|---|---|
| 0 | u16 | `message_length` | total packet length |
| 2 | u16 | `message_code` | 7207 index, 7208 market picture or mini, 105 market status, 104 CAS, 6511/6521 open/close (legacy codes still handled by the SDK) |
| 4 | i8 | `exchange_id` | §3.4 |
| 5 | u8 | `level` | 1 mini, 2/4 touch line, 8 depth, 16 full depth |
| 6 | u8 | `auction_flag` | SDK: `auction = flag > 0`. Doc: "reserved — auction is not currently enabled". |
| 7 | u8 | `seq_no` | informational |
| 8 | u8 | `bitmask_length` | 0 for native_batch full messages |

Every native_batch packet is a **full** record (`bitmask_length = 0`). There are no deltas, so each packet *replaces* the instrument's state. HSM was different: it sent partial updates with sentinels.

### 5.3 Routing order (SDK `decode_packet`, consistent with doc §6.2)

1. `code ∈ {6511, 6521}` → MarketStatus. The packet is header-only: 6511 is status 1 (open), 6521 is status 2 (close).
   - The doc says code 105 has replaced these, but the SDK still handles them.
2. `code == 7207` → Index.
3. `code == 105` → MarketStatus (with a body).
4. `code == 104` → CAS. Drop it if `ref_price`, `imb` and `imb_mkt` are all 0.
5. `level == 1` → Mini touch line. Market-data packets are routed by `level`; both Mini and MarketPicture arrive with code 7208.
6. `level ∈ {2, 4, 8, 16}` → MarketPicture. The doc lists `{2,4,8}`; the SDK adds 16.
7. Otherwise, ignore.

### 5.4 Index — `code 7207`, 87 bytes (`<IiiiiiQiiidBi21s` at @9)

| @ | type | field | scale |
|---|---|---|---|
| 9 | u32 | `token` | (for example 26000) |
| 13 | i32 | `open_price` | / div |
| 17 | i32 | `close_price` | / div (previous close) |
| 21 | i32 | `high_price` | / div |
| 25 | i32 | `low_price` | / div |
| 29 | i32 | `index_value` | / div (LTP) |
| 33 | u64 | `last_trade_time` | epoch seconds (see §5.10) |
| 41 | i32 | `yearly_high` | / div |
| 45 | i32 | `yearly_low` | / div |
| 49 | i32 | `net_chg_percent` | / 100 |
| 53 | f64 | `_market_cap` | unused |
| 61 | u8 | `precision` | display decimals |
| 62 | i32 | `multiplier` | SDK computes `/ div`; unused |
| 66 | char[21] | `name` | UTF-8, NUL-padded, trimmed (for example "NIFTY 50") |

Derived values in the SDK:

- `change = (index_value - close_price) / div`
- `net_change_percent = raw / 100`

The index packet has **no volume and no OI**.

### 5.5 Market Picture — `code 7208`, `level ∈ {2,4,8,16}`

The fixed part runs from @0 to @144 (`<IqqqqqIIIIIqIIIIhiIdiIIIIIBI` at @9, 135 bytes). Depth rows follow it.

| @ | type | field | scale |
|---|---|---|---|
| 9 | u32 | `token` | |
| 13 | i64 | `total_buy_qty` | |
| 21 | i64 | `total_sell_qty` | |
| 29 | i64 | `volume_traded_today` | |
| 37 | i64 | `last_trade_time` (LTT) | epoch s |
| 45 | i64 | `last_update_time` (LUT) | epoch s. A negative sentinel (-2209008600 = 1900-01-01 IST) means "never"; the SDK sets it to 0. |
| 53 | u32 | `open_price` | / div |
| 57 | u32 | `close_price` | / div (previous close) |
| 61 | u32 | `high_price` | / div |
| 65 | u32 | `low_price` | / div |
| 69 | u32 | `last_traded_price` | / div |
| 73 | i64 | `last_trade_qty` | |
| 81 | u32 | `avg_trade_price` (ATP/VWAP) | / div |
| 85 | u32 | `_indicative_close` | unused |
| 89 | u32 | `buy_depth_count` | |
| 93 | u32 | `sell_depth_count` | |
| 97 | i16 | `_trading_status` | unused |
| 99 | i32 | `net_chg_percent` | / 100 |
| 103 | u32 | `open_interest` | raw |
| 107 | f64 | `total_traded_value` | / div |
| 115 | i32 | `net_chg` | / div |
| 119 | u32 | `upper_circuit` | / div |
| 123 | u32 | `lower_circuit` | / div |
| 127 | u32 | `yearly_high` | / div |
| 131 | u32 | `yearly_low` | / div |
| 135 | u32 | `market_lot` | |
| 139 | u8 | `precision` | |
| 140 | u32 | `multiplier` | raw |
| 144 | DepthRow[] | rows | `buy_n + sell_n` rows, bids first, then asks |

**DepthRow (16 bytes, `<qii`):**

| @ (within the row) | type | field |
|---|---|---|
| +0 | i64 | qty |
| +8 | i32 | price (/ div) |
| +12 | i32 | number_of_orders |

**Depth-row rules (doc and SDK):**

- For `level == 4` (touch line), force `buy_n = sell_n = 1` regardless of the counts in the body.
- Otherwise use `buy_depth_count` and `sell_depth_count`.
- Stop early once `offset + 16 > min(message_length, packet.length)`.

Packet sizes:

- A touch-line packet with 1+1 rows is 176 bytes (the test vector in §9).
- Depth (level 8) row counts are probably 5+5, matching the 5-level depth in the REST quotes. **UNCONFIRMED.**
- Full depth (level 16) row counts are **UNCONFIRMED** (possibly 20).

### 5.6 Mini Touch Line — `code 7208`, `level 1`, 54 bytes (`<IqIqIiiIBI` at @9)

| @ | type | field | scale |
|---|---|---|---|
| 9 | u32 | `token` | |
| 13 | i64 | `last_trade_time` | epoch s |
| 21 | u32 | `last_traded_price` | / div |
| 25 | i64 | `last_trade_qty` | |
| 33 | u32 | `close_price` | **divide by div. The SDK 3.0.7 does this; see the conflict below.** |
| 37 | i32 | `net_chg_percent` | / 100 |
| 41 | i32 | `net_chg` | / div |
| 45 | u32 | `market_lot` | |
| 49 | u8 | `precision` | |
| 50 | u32 | `multiplier` | |

**Conflict: does the Mini `close_price` get divided?**

- The official doc §7.4 says `close_price` here is "NOT divided (quirk of the reference client)".
- SDK 3.0.7 divides it. Its test `test_mini_touch_line_close_price_scaled` expects 149900 → 1499.00.
- The **doc's own worked example proves dividing is correct:**
  - LTP = 123456/100 = 1234.56
  - close raw = 122000
  - net_chg = 1456/100 = 14.56
  - 1234.56 − 1220.00 = 14.56, and 14.56/1220 = 1.19 %, which matches `net_chg_percent` = 119/100.
- **Divide.**

The Mini packet has **no volume, OI, OHLC or depth**. Do not use it for the option chain.

### 5.7 Market status — `code 105`, 16 bytes (`<H5s` at @9)

| @ | type | field |
|---|---|---|
| 9 | u16 | `status_code` |
| 11 | char[5] | `status`. **Unreliable** (often empty); use the code→text table instead. |

`status_code` values:

| code | name |
|---|---|
| 1 | Open |
| 2 | Close |
| 3 | PreopenShutdown |
| 4 | NormalMktPreopenEnded |
| 5 | AuctionStatusChange |
| 6 | ClosingStart |
| 7 | ClosingEnd |
| 8 | CtsCloseForCas |
| 9 | RevisedPriceBandCompleted |
| 10 | CasStart |
| 11 | MarketOrderRestricted |
| 12 | CasEnd |

The packet carries no token. `exchange_id` in the header identifies the segment. It is delivered via `subscribeExchange`.

### 5.8 CAS reference — `code 104`

| @ | type | field | scale |
|---|---|---|---|
| 9 | u32 (doc: int32) | `token` | |
| 13 | u32 (doc: int32) | `ref_price` | / div |
| 17 | i64 | `imbalance_qty` | |
| 25 | i64 | `imbalance_qty_at_mkt` | |
| 33 | char[15] | reserved | |

The doc gives a 48-byte total; the SDK reads only the first 33 bytes. Drop the packet if `ref_price`, `imbalance_qty` and `imbalance_qty_at_mkt` are all 0, which is what the exchange sends outside the CAS window. CAS is the equity closing auction and is not relevant for F&O.

### 5.9 Scaling rules (doc §6.3)

| field | display value |
|---|---|
| Prices | raw / divider (per exchange, from auth) |
| `net_chg` | raw / divider |
| `net_chg_percent` | raw / 100, always |
| `total_traded_value` (f64) | raw / divider |
| Quantities, OI, counts | raw |
| `precision` | number of display decimals |

### 5.10 Timestamps

The doc says to "treat them as opaque". The evidence is consistent with **Unix epoch seconds**:

- The official worked example has `last_trade_time = 1756636800`, which is 2025-08-31T10:40:00Z.
- The SDK's "never updated" sentinel `-2209008600` equals 1900-01-01 00:00 IST expressed as Unix seconds.

The exact semantics for live NSE data are **UNCONFIRMED**; verify on first live tick.

### 5.11 Units of OI and volume

Whether `open_interest` and `volume_traded_today` are in shares/units or in lots for `nse_fo` is **UNCONFIRMED**. NSE broadcasts are normally in units/shares; verify against the REST quote and the NSE option chain on day 1. `open_interest` is u32 (max about 4.29e9, which is enough).

---

## 6. Decoding algorithm (TypeScript, Node `ws`)

Port-level notes for Node `ws` v8:

- `ws.on('message', (data, isBinary) => …)` delivers **both** text and binary messages as `Buffer` by default. You **must** branch on `isBinary`.
- Do not branch on `typeof data`, which is how the Python SDK distinguishes them.
- 64-bit fields: `readBigInt64LE` / `readBigUInt64LE`, then `Number()`. Values are safely below 2^53.
- Guard every read with a length check. Out-of-range reads throw `RangeError`. The SDK swallows per-packet errors and continues with the next packet.

```ts
const EXCH = ['none','nse_cm','nse_fo','cde_fo','nse_com','bse_cm','bse_fo','bse_cd','bse_co','mcx_fo','ncd_co'];
const NAME_TO_ID: Record<string, number> = Object.fromEntries(EXCH.map((n, i) => [n, i]));

export function splitBatch(b: Buffer): Buffer[] {
  const out: Buffer[] = []; let off = 0;
  while (off + 2 <= b.length) {
    const size = b.readUInt16LE(off);
    if (size < 9 || off + size > b.length) break;
    out.push(b.subarray(off, off + size)); off += size;
  }
  return out;
}
const cstr = (b: Buffer) => { const z = b.indexOf(0); return (z < 0 ? b : b.subarray(0, z)).toString('utf8').trim(); };
const i64 = (b: Buffer, o: number) => Number(b.readBigInt64LE(o));
const u64 = (b: Buffer, o: number) => Number(b.readBigUInt64LE(o));

export function decodePacket(p: Buffer, dividers: Map<number, number>) {
  if (p.length < 9) return null;
  const msgLen = p.readUInt16LE(0), code = p.readUInt16LE(2);
  const exId = p.readInt8(4), level = p.readUInt8(5), auction = p.readUInt8(6);
  const exchange = EXCH[exId] ?? String(exId);
  const d = dividers.get(exId) || 100;

  if (code === 6511 || code === 6521) return { kind: 'status', exchange, statusCode: code === 6511 ? 1 : 2 };
  if (code === 7207) {
    if (p.length < 87) return null;
    const close = p.readInt32LE(17), value = p.readInt32LE(29);
    return { kind: 'index', exchange, token: String(p.readUInt32LE(9)), name: cstr(p.subarray(66, 87)),
      ltp: value / d, open: p.readInt32LE(13) / d, close: close / d, high: p.readInt32LE(21) / d, low: p.readInt32LE(25) / d,
      change: (value - close) / d, changePct: p.readInt32LE(49) / 100, ltt: u64(p, 33),
      yearHigh: p.readInt32LE(41) / d, yearLow: p.readInt32LE(45) / d, precision: p.readUInt8(61) };
  }
  if (code === 105) {
    if (p.length < 11) return null;
    return { kind: 'status', exchange, statusCode: p.readUInt16LE(9), raw: cstr(p.subarray(11, Math.min(16, p.length))) };
  }
  if (code === 104) {
    if (p.length < 33) return null;
    const ref = p.readUInt32LE(13), imb = i64(p, 17), imbM = i64(p, 25);
    if (ref === 0 && imb === 0 && imbM === 0) return null;
    return { kind: 'cas', exchange, token: String(p.readUInt32LE(9)), refPrice: ref / d, imbalanceQty: imb, imbalanceQtyAtMkt: imbM };
  }
  if (level === 1) {
    if (p.length < 54) return null;
    return { kind: 'lite', exchange, token: String(p.readUInt32LE(9)), ltt: i64(p, 13), ltp: p.readUInt32LE(21) / d,
      ltq: i64(p, 25), close: p.readUInt32LE(33) / d, changePct: p.readInt32LE(37) / 100, change: p.readInt32LE(41) / d,
      lot: p.readUInt32LE(45), precision: p.readUInt8(49) };
  }
  if (level === 2 || level === 4 || level === 8 || level === 16) {
    if (p.length < 144) return null;
    let lut = i64(p, 45); if (lut < 0) lut = 0;
    const buyCnt = p.readUInt32LE(89), sellCnt = p.readUInt32LE(93);
    const [bn, sn] = level === 4 ? [1, 1] : [buyCnt, sellCnt];
    const limit = Math.min(msgLen, p.length); const bids = [], asks = [];
    for (let i = 0, off = 144; i < bn + sn && off + 16 <= limit; i++, off += 16) {
      const row = { qty: i64(p, off), price: p.readInt32LE(off + 8) / d, orders: p.readInt32LE(off + 12) };
      (i < bn ? bids : asks).push(row);
    }
    return { kind: 'quote', exchange, level, token: String(p.readUInt32LE(9)),
      totalBuyQty: i64(p, 13), totalSellQty: i64(p, 21), volume: i64(p, 29), ltt: i64(p, 37), lut,
      open: p.readUInt32LE(53) / d, close: p.readUInt32LE(57) / d, high: p.readUInt32LE(61) / d, low: p.readUInt32LE(65) / d,
      ltp: p.readUInt32LE(69) / d, ltq: i64(p, 73), atp: p.readUInt32LE(81) / d,
      changePct: p.readInt32LE(99) / 100, oi: p.readUInt32LE(103), turnover: p.readDoubleLE(107) / d,
      change: p.readInt32LE(115) / d, upperCircuit: p.readUInt32LE(119) / d, lowerCircuit: p.readUInt32LE(123) / d,
      yearHigh: p.readUInt32LE(127) / d, yearLow: p.readUInt32LE(131) / d, lot: p.readUInt32LE(135),
      precision: p.readUInt8(139), multiplier: p.readUInt32LE(140), auction: auction > 0, bids, asks };
  }
  return null;
}
```

### 6.1 Client state machine (mirrors SDK `SFeedWebSocket`, hardened)

1. Resolve the URL (§2).
2. Call `new WebSocket(url)`. Default options are fine: TLS verification on, `perMessageDeflate` default.
3. On `open`, send the auth JSON. Start an auth timer of about 15 s.
4. On a text message, `JSON.parse` it, then dispatch on `message_code`:
   - **1117 or 1119**: rebuild `dividers` from `exchanges` (use `value ?? NAME_TO_ID[name]` and `divider ?? 100`). Set `authenticated = true`. Clear the auth timer. **Replay all remembered subscriptions**, one frame per intent, chunked. Re-send `subscribeExchange` if it was active.
   - If `format === 'native_fallback'`: fatal for this connection. Close and report.
   - **1120**: auth failed. Invalidate the session, re-login with TOTP and MPIN, then reconnect.
   - **1109**: merge the symbol map. Handle both formats from §4.4.
   - Anything else: log at debug level.
5. On a binary message: if not authenticated, drop it (openalgo does this; a wrong divider is worse than a late tick). Otherwise `splitBatch` → `decodePacket` → upsert state keyed by `exchange|token` (indices: `exchange|token` *and* `exchange|name`) → emit.
6. Keepalive. The SDK relies on the WS layer: ping every 20 s, and the Python library closes after 20 s without a pong. Node `ws` does **not** auto-ping as a client, so:
   - Run `setInterval(() => { if (!alive) return ws.terminate(); alive = false; ws.ping(); }, 20000)`.
   - Set `alive = true` on `'pong'`.
   - `ws` already auto-replies to server pings.
   - There is **no** app-level heartbeat message in native_batch (official doc §8).
7. On close or error: `authenticated = false` and stop the ping timer. Reconnect with backoff and go back to step 2. The server forgets subscriptions, so always re-auth and re-subscribe.
   - SDK defaults: `reconnect_delay = 5 s` and `max_reconnect_attempts = 5`, after which the SDK **gives up silently**. The counter resets after each successful connect.
   - Initial connect: `max_connect_retries = 3` with 5 s delay.
   - For a 24×7 server, use unbounded exponential backoff (1 s up to 30 s with jitter). Re-login when the auth is rejected.
8. Keep a client-side cap of 3000 tokens, and a `Set<intent|exch|token>` for replay.

---

## 7. Mapping to the app's data needs (indices vs equities vs F&O)

| Need | Index (`subscribeIndices`) | Equity `nse_cm` (`subscribeScrips`, L4) | F&O `nse_fo` option or future (`subscribeScrips`, L4; or `subscribeDepth`, L8) |
|---|---|---|---|
| LTP | `index_value` | `last_traded_price` | `last_traded_price` |
| Prev close | `close_price` | `close_price` | `close_price` |
| Change / % | derived / `net_chg_percent` | `net_chg` / `net_chg_percent` | same |
| OHLC | yes | yes | yes |
| Volume | **no** | `volume_traded_today` | `volume_traded_today` (units, UNCONFIRMED) |
| OI | **no** | 0 | `open_interest` (u32) |
| OI change vs previous day | no | no | **not in the feed.** Needs the previous-day OI baseline from REST quotes, option chain or NSE (other topic) |
| Best bid/ask | no | depth row 0 (L4 gives exactly 1+1) | same; L8 gives N levels |
| Total buy/sell qty | no | `total_buy_qty` / `total_sell_qty` | same |
| ATP / VWAP | no | `avg_trade_price` | same |
| LTQ, LTT, LUT | LTT only | yes | yes |
| Lot size | no | `market_lot` | `market_lot` |
| Circuit limits, 52-week high/low | 52-week only | yes | yes |
| Turnover | no | `total_traded_value` | same |
| IV, Greeks | no | no | **not provided.** Compute locally from LTP or mid plus spot or futures |

Practical recommendations:

- **Option chain.** Use `subscribeScrips` (level 4) on near-ATM strikes across the active expiries, inside the 3000-token budget. That gives LTP, OI, volume, bid/ask and ATP per strike.
- **Indices.** Use `subscribeIndices` for NIFTY, BANKNIFTY, FINNIFTY, SENSEX and INDIA VIX.
- **Futures.** Use `subscribeScrips` on the `nse_fo` futures tokens; use those for the basis and for the underlying in option pricing.
- **Session state.** Use `subscribeExchange` for open/close status.
- **Tokens and trading symbols** come from the scrip master (separate research topic). The feed carries only numeric tokens.

---

## 8. Lifecycle facts from the SDK (exact defaults)

| setting | default |
|---|---|
| `ping_interval` | 20 s |
| `reconnect_delay` | 5 s |
| `max_reconnect_attempts` | 5 |
| `max_connect_retries` | 3 |
| `max_subscriptions` | 3000 |
| `ack_wait_timeout` | 5.0 s |
| `verify_ssl` | True |

Other lifecycle behaviour:

- **Auth wait:** the SDK reads up to 10 frames, each with a 10 s `recv` timeout.
- **Reconnect replay:** subscriptions are re-sent grouped by intent, one frame per intent, followed by `{"event":"subscribeExchange"}` if it was active.
- **Unsubscribe bookkeeping:** a token's trading symbol is removed only when no intent still holds that token.
- **Malformed packets** are reported through `on_error` and never tear down the receive loop.
- **v3.0.7 fix:** the reconnect and idle loops were changed from recursion to loops to stop a `RecursionError` after hours of running. Make sure the TS version has no unbounded recursion either.

---

## 9. Test vectors (for TS unit tests)

**(a) Official worked example (doc §10).** One 54-byte Mini packet, `nse_cm`, divider 100:

```
36 00 28 1c 01 01 00 07 00 10 2d 00 00 80 26 b4 68 00 00 00 00 40 e2 01 00 32 00 00 00 00 00 00
00 90 dc 01 00 77 00 00 00 b0 05 00 00 01 00 00 00 02 01 00 00 00
```

I verified the decode in Python:

- header = (54, 7208, exch 1, level 1, 0, seq 7, 0)
- token = 11536
- ltt = 1756636800
- ltp = 123456 → 1234.56
- ltq = 50
- close = 122000 → 1220.00
- net_chg_percent = 119 → 1.19
- net_chg = 1456 → 14.56
- lot = 1, precision = 2, multiplier = 1

**(b) Index, 87 bytes.** These are the SDK test values: token 26000, open 20000.00, close 19900.00, high 20100.00, low 19800.00, value 20050.00, ltt 1234567890, net_chg_percent 1.50, precision 2, multiplier 100, name "NIFTY 50".

```
57 00 27 1c 01 00 00 00 00 90 65 00 00 80 84 1e 00 70 5d 1e 00 90 ab 1e 00 60 36 1e 00 08 98 1e 00
d2 02 96 49 00 00 00 00 20 0b 20 00 60 e3 16 00 96 00 00 00 00 00 00 00 00 00 00 00 02 64 00 00 00
4e 49 46 54 59 20 35 30 00 00 00 00 00 00 00 00 00 00 00 00 00
```

Expected: ltp 20050, close 19900, change 150, changePct 1.5.

**(c) MarketPicture level 4, `nse_fo` (exch 2), 176 bytes.** Values:

- token 44498, tbq 1000, tsq 2000, vol 50000
- ltt 1234567890, lut 1234567891
- O/C/H/L = 1500.00 / 1490.00 / 1510.00 / 1480.00
- ltp 1500.50, ltq 10, atp 1500.25
- buy 1, sell 1
- chg% 1.23, OI 500, turnover 12345.67, chg 1.05
- ucl 1650, lcl 1350, 52wH 2000, 52wL 1000
- lot 75, precision 2, multiplier 1
- bid 1500.00 × 100 (5 orders), ask 1501.00 × 101 (6 orders)

```
b0 00 28 1c 02 04 00 00 00 d2 ad 00 00 e8 03 00 00 00 00 00 00 d0 07 00 00 00 00 00 00 50 c3 00 00
00 00 00 00 d2 02 96 49 00 00 00 00 d3 02 96 49 00 00 00 00 f0 49 02 00 08 46 02 00 d8 4d 02 00 20
42 02 00 22 4a 02 00 0a 00 00 00 00 00 00 00 09 4a 02 00 00 00 00 00 01 00 00 00 01 00 00 00 00 00
7b 00 00 00 f4 01 00 00 00 00 00 00 87 d6 32 41 69 00 00 00 88 84 02 00 58 0f 02 00 40 0d 03 00 a0
86 01 00 4b 00 00 00 02 01 00 00 00 64 00 00 00 00 00 00 00 f0 49 02 00 05 00 00 00 65 00 00 00 00
00 00 00 54 4a 02 00 06 00 00 00
```

**(d) Batch.** Concatenate (b) and (c) into one frame of 263 bytes. `splitBatch` must return 2 packets. Appending `99 99 02` must still return 2 (truncated tail is ignored).

**(e) Market status.** 16 bytes, open, `nse_cm`:

```
10 00 69 00 01 00 00 00 00 01 00 4f 50 45 4e 00
```

**(f) Auth fixtures.** The 1119 production body from §3.3, a 1120 failure, and a `native_fallback` rejection.

**(g) Ack fixtures.** Both 1109 shapes from §4.4.

`live-research/scripts/vectors.py` regenerates (b), (c) and (e).

The §6 decoder was run under Node 22 (`live-research/scripts/dec.cjs`) against (a)–(e). All fields came out as listed above, and the batch split gave 2 packets.

---

## 10. Remaining open questions (**UNCONFIRMED** until the first live session)

1. Whether the server sends **1117**, **1119**, or both on success in production today. The SDK says production sends 1119; the doc calls 1117 the success code.
2. Whether a failed auth closes the socket (the doc says yes) or stays silent (openalgo's claim).
3. The **1109 ack** shape: the top-level `trading_symbols` map or `data[key].trading_symbols`.
4. Exact `feedUrl` and config-service values per data center. Whether `ks` (cdtstream) hosts speak identical native_batch.
5. Units of `volume_traded_today` and `open_interest` for `nse_fo` (units vs lots). Whether `close_price` is the previous close during the session. Timestamp epoch (Unix seconds is strongly implied).
6. Depth row counts for level 8 (expected 5+5) and level 16.
7. Server behaviour above 3000 tokens; per-frame `inputtoken` size limits; maximum connections per user; control-frame rate limits.
8. Whether the server accepts `permessage-deflate`.
9. Index name matching (case and spelling), and whether `subscribeScrips` on an index name yields 7207 packets.
10. `sid` lifetime. The feed `auth` presumably dies with the trading session (daily re-login). The REST-side session rules belong to a separate topic.

Suggested day-1 live verification:

- Log raw text frames, and the first 64 bytes of a few binary frames in hex. This mirrors the SDK `on_raw` hook.
- Compare LTP, OI and volume against the REST `quotes` endpoint for the same tokens.

---

## 11. Not covered here

The order/position feed (`wss://<baseUrl host>/realtime`, `rtUrl`) is out of scope for this topic.

---

## 12. Existing JS/TS implementations

| Package / repo | Official? | Feed coverage |
|---|---|---|
| npm `kotak-neo-nodejs-sdk@1.0.15` (2024-01-08, tradesavvy) | **No** | REST only. I downloaded the tarball and found **no WebSocket code**. Predates SFeed. |
| npm `@its_seraj/trade@1.0.7` (2026-03-22) | **No** | REST trading bot. **No WebSocket code.** |
| npm `kotak`, `@imflow/kotak` | **No** | Unrelated (a Next.js app) |
| GitHub `marketcalls/openalgo` `broker/kotak/streaming/sfeed_protocol.py` and `sfeed_websocket.py` (PR #2016, 2026-09-07) | **No** (Python) | Third-party clone of the SDK wire format: same structs and codes, threaded `websocket-client`, ping 30 s / timeout 10 s, 15 s auth watchdog, drops binary before auth. Useful cross-check, not a primary source. |
| Kotak's own JS | **Not published** | Legacy HSM used `"JS_API"` as its source string, which suggests an internal JS library existed. It is not on npm or GitHub. |

**Conclusion:** there is no official, or any public, TypeScript SFeed client. We must write our own about 300-line client from §5 and §6. The wire format is small and fully specified by the official doc plus the SDK.

---

## Appendix A: Legacy HSM feed (retired; reference only)

Source: `Kotak-Neo/kotak-neo-api-v2` `neo_api_client/HSWebSocketLib.py` and `NeoWebSocket.py`. Status: Kotak deprecated the "HS feed" on 15 Sep 2026. openalgo notes (UNCONFIRMED) that the host still answers but no data center routes to it.

### A.1 URL and transport

- URL: `WEBSOCKET_URL = "wss://mlhsm.kotaksecurities.com"`. No path; one global host, not per data center.
- The SDK used `websocket-client` `run_forever(ping_interval=0, reconnect=5, sslopt={"cert_reqs": ssl.CERT_NONE})`. That means no WS pings, auto-reconnect after 5 s, and TLS verification disabled.
- **All requests and responses are binary, big-endian.**
- Each request frame is `[u16 BE length of everything after these 2 bytes][u8 type][u8 fieldCount][fields…]`.
- Each field is `[u8 fid][u16 BE len][bytes]`.

### A.2 Connection request

`NeoWebSocket.on_hsm_open` sends `{"type":"cn","Authorization":<edit_token JWT>,"Sid":<edit_sid>}`. `prepareConnectionRequest2` encodes it as:

```
[u16 len][0x01 CONNECTION][0x03 fields]
  [0x01][u16 jwtLen][jwt ascii]
  [0x02][u16 sidLen][sid ascii]
  [0x03][u16 6]["JS_API"]
```

- Here `Authorization` is the **trade JWT** and `Sid` is the trade sid. That is unlike SFeed, where `auth` is the sid and `user` is the UCC.
- An alternate mode, `{"type":"cn","user":…}` or `sessionid`, used `prepare_connection_request`, which is buggy and references a non-existent `END_OF_MSG`.

### A.3 Subscribe and unsubscribe request

Built by `prepareSubsUnSubsRequest(scrips, type, prefix, channel)`. The JSON forms were:

- `{"type":"mws"|"mwu"|"ifs"|"ifu"|"dps"|"dpu","scrips":"nse_cm|11536&nse_fo|44498","channelnum":2}`
- Scrips are `&`-separated `<exch>|<token>`.

Wire encoding:

```
scripArr = [u16 BE count] + for each: [u8 len]["<prefix>|<exch>|<token>" ascii]
  prefix: "sf" = scrip (mws/mwu), "if" = index (ifs/ifu), "dp" = depth (dps/dpu)
frame = [u16 len][type: 4=SUBSCRIBE | 5=UNSUBSCRIBE][0x02 fields]
        [0x01][u16 len(scripArr)][scripArr]
        [0x02][u16 1][u8 channelNum]
```

Limits:

- At most 100 scrips per request (`MAX_SCRIPS`).
- The SDK allocated channels 2..16 with at most 200 tokens each, and a 3000-token total. Channel 1 was used for quote snapshots (`QuotesChannel = 1`).

### A.4 Snapshot request

- JSON types: `mwsp`, `ifsp`, `dpsp`.
- Wire: `[u16 len][0x09 SNAPSHOT][0x01 fields][0x02][u16 len][scripArr]`.

### A.5 Other HSM requests

- **Ack request**, sent after every `ack_num` data messages: `[u16 len][0x03 ACK][0x01][0x01][u16 4][u32 BE msgNum]`.
- **Channel pause and resume** (`cp`/`cr`, types 7/8) and **throttling** (`ti`, type 2): the SDK builds these **without** the u16 length prefix. They look buggy and unused.
  - Channel bitmask: two u32 BE values, `int2` for channels 33–64 and then `int1` for channels 1–32.
- **Option-chain request** (`opc`, type 10): present in the SDK but broken. It reads from an empty `req` dict.
- **Heartbeat** (`{"type":"hb"}`): **not encodable**. `hs_send` has no branch for it, and the ping thread is commented out ("add logic to send binary data"). So the SDK sent no app heartbeat. GitHub issue `kotak-neo-api#225` reports HSM sockets closing after a few minutes.

### A.6 Response parsing (`HSWrapper.parseData`)

Every response starts with `[u16 BE length][u8 type]`.

| type | Meaning | Body |
|---|---|---|
| 1 | Connection response | `[u8 fCount]`. If ≥2: `[u8 fid][u16 len][status "K" = ok / "N" = not ok][u8 fid][u16 len][ackCount, big-endian int of len bytes]` and `ack_num = ackCount`. If 1: status only. |
| 6 | Data | See below. |
| 4 / 5 / 9 / 7 / 8 | Subscribe / unsubscribe / snapshot / channel-pause / channel-resume ack | `[u8 fCount]`, then if >0 `[u8 fid][u16 len][status "K"/"N"]` |

Type 6 (data) body, in order:

1. If `ack_num > 0`: `[u32 BE msgNum]`, and the client sends an ACK every `ack_num` messages.
2. `[u16 BE msgCount]`.
3. For each message: skip 2 bytes (per-message length), then `[u8 respType]`.
4. **`respType` 83 ('S', snapshot):**
   - `[u32 BE topicId][u8 nameLen][topicName e.g. "sf|nse_fo|44498"]`
   - `[u8 n]` followed by n × `i32 BE` values for field indexes 0..n−1
   - `[u8 m]` followed by m × `[u8 fid][u8 len][string]`, where fid 52 = token `tk`, 53 = exchange `e`, 54 = trading symbol `ts`
   - Register `topicId → topic` (sf, if or dp).
5. **`respType` 85 ('U', update):**
   - `[u32 BE topicId][u8 n]` followed by n × `i32 BE` for field indexes 0..n−1
   - Value `-2147483648` (`0x80000000`, `TRASH_VAL`) means "not available or unchanged"; skip it. Equal values are also skipped.
   - Merge into the topic's stored state.

### A.7 Field scaling

- FLOAT32 fields: `value / (multiplier × 10^precision)`.
  - Multiplier and precision come **inside the tick** (scrip fields 23/24, index 8/9, depth 32/33). There is no divider.
- DATE fields: epoch seconds, formatted as local `dd/mm/yyyy HH:MM:SS`.
- LONG fields: raw.

### A.8 Field-index maps

**Scrip (`sf`):**

| index | name | type |
|---|---|---|
| 0 | ftm0 | DATE |
| 1 | dtm1 | DATE |
| 2 | fdtm (feed time) | DATE |
| 3 | ltt | DATE |
| 4 | v (volume) | LONG |
| 5 | ltp | FLOAT32 |
| 6 | ltq | LONG |
| 7 | tbq | LONG |
| 8 | tsq | LONG |
| 9 | bp (best bid) | FLOAT32 |
| 10 | sp (best ask) | FLOAT32 |
| 11 | bq | LONG |
| 12 | bs (ask size) | LONG |
| 13 | ap (average price) | FLOAT32 |
| 14 | lo | FLOAT32 |
| 15 | h | FLOAT32 |
| 16 | lcl | FLOAT32 |
| 17 | ucl | FLOAT32 |
| 18 | yh | FLOAT32 |
| 19 | yl | FLOAT32 |
| 20 | op | FLOAT32 |
| 21 | c (close) | FLOAT32 |
| 22 | oi | LONG |
| 23 | mul | LONG |
| 24 | prec | LONG |
| 25 | cng | derived: ltp − c |
| 26 | nc | derived: cng / c × 100 |
| 27 | to | derived: v × ap |
| 51–54 | name, tk, e, ts | STRING |

**Index (`if`):**

| index | name | type |
|---|---|---|
| 0 | ftm0 | DATE |
| 1 | dtm1 | DATE |
| 2 | iv (LTP) | FLOAT32 |
| 3 | ic (previous close) | FLOAT32 |
| 4 | tvalue (time) | DATE |
| 5 | highPrice | FLOAT32 |
| 6 | lowPrice | FLOAT32 |
| 7 | openingPrice | FLOAT32 |
| 8 | mul | LONG |
| 9 | prec | LONG |
| 10 | cng | derived |
| 11 | nc | derived |

The SDK has a bug here: it *appends* `mul` at index 55 instead of setting index 8. Scaling still works because it reads `fieldDataArray[8]` directly.

**Depth (`dp`):**

| indexes | fields | type |
|---|---|---|
| 0–1 | ftm0, dtm1 | DATE |
| 2–6 | bp, bp1..bp4 | FLOAT32 |
| 7–11 | sp, sp1..sp4 | FLOAT32 |
| 12–16 | bq, bq1..bq4 | LONG |
| 17–21 | bs, bs1..bs4 | LONG |
| 22–26 | bno1..bno5 (bid orders) | LONG |
| 27–31 | sno1..sno5 (ask orders) | LONG |
| 32 | mul | LONG |
| 33 | prec | LONG |

### A.9 Reconnect and decompression

- **Reconnect:** `websocket-client` re-opens after 5 s. `on_open` re-sends `cn`. On the `cn` ack, the SDK replays every channel's subscriptions, one request per token. Quote snapshots that are still pending are re-sent.
- **Decompression:** none.

---

## 13. Sources

Official, primary:

- PyPI `kotakneoapi` 3.0.7: https://pypi.org/project/kotakneoapi/. Wheel source files read are listed in §0.
- https://github.com/Kotak-Neo/kotak-neo-python (`neo_api_client/websocket/feed/*.py`, `docs/guides/websocket.md`, `docs/functions/websocket/market_feed.md`, `tests/unit/test_feed_protocol.py`, `test_feed_client.py`, `test_feed_client_lifecycle.py`, `CHANGELOG.md`)
- https://github.com/Kotak-Neo/Kotak-Neo/blob/main/docs/market-data-apis/websocket.md (official native_batch spec) and `docs/authentication.md`
- https://github.com/Kotak-Neo/kotak-neo-api-v2 (`neo_api_client/HSWebSocketLib.py`, `NeoWebSocket.py`, `urls.py`, `settings.py`, `docs/webSocket.md`). This is the legacy HSM SDK.

Kotak deprecation notices. **Not fetched**: kotakneo.com is blocked from the sandbox and was unresolvable from WebFetch. Content is known only from search snippets and the openalgo issue that quotes it.

- https://www.kotakneo.com/support/kotak-neo-trade-api-market-feed-changes/
- https://www.kotakneo.com/bulletins/trade-api-market-feed-migration-15-september-2026/
- https://www.kotakneo.com/uploads/kotak_neo_market_data_websocket_guide_38e4831feb.pdf. Search snippets indicate this has the same content as the GitHub `websocket.md`.

Third-party, secondary:

- https://github.com/marketcalls/openalgo/issues/2010 (quotes the HS-feed deprecation on 15 Sep 2026)
- https://github.com/marketcalls/openalgo/pull/2016 and `broker/kotak/streaming/{kotak_feed_config,sfeed_protocol,sfeed_websocket}.py` at commit `12e1114`
- https://github.com/Kotak-Neo/kotak-neo-api/issues/225 (HSM socket closes after minutes)
- npm: https://www.npmjs.com/package/kotak-neo-nodejs-sdk and https://www.npmjs.com/package/@its_seraj/trade (no WebSocket code)
