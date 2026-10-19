# Q26 Options — Broker Integration Status (Kotak Neo)

**Status: BLOCKED. Live connectivity is not verified.** The code is complete for market data, and its tests pass
against recorded and constructed fixtures. It has never run against Kotak's real servers in this audit,
because the audit environment's network policy denies the Kotak, NSE and BSE hosts. A login attempt from here
ends in `fetch failed`, with DNS refused by the sandbox proxy (see TEST_EXECUTION_REPORT.md §4).

**Order placement: NOT IMPLEMENTED, by design.** Q26 is paper-only. The Kotak client has no order, modify or
cancel methods. The weekly audit checks this at run time (`SAFE-1`), using the method list of `KotakRest` and
the constants in `apps/server/src/safety.ts`.

## 1. What the code implements

| Area | Implementation | Reference |
|---|---|---|
| SDK / API | No vendor SDK: a direct HTTPS client for **Neo Trade API v2** (`mis.kotaksecurities.com`) | `apps/server/src/live/kotak/session.ts`, `rest.ts` |
| Authentication | `tradeApiLogin` (TOTP made from `NEO_TOTP_SECRET`, always a fresh 30 s window) → `tradeApiValidate` (MPIN) → per-account `baseUrl`, token, sid | session.ts `login()`, `totp.ts` |
| Session upkeep | Proactive re-login at token `exp − 5 min` and daily at 08:30 IST. On 401 / stCode 1003, one re-login, then one retry. A 403 on an endpoint is held for that endpoint. A 429 honours Retry-After | session.ts header comment |
| Login monitor (new) | Checks every 5 s and logs in again at once after a session loss. Network failure: retried after 5 s, doubling to 1 min. Refusal: 60 s doubling to 30 min. After 5 refusals in a row automatic logins **pause** to protect the account | `apps/server/src/ops/login-monitor.ts` |
| REST market data | `quotes`, `optionChain`, `futuresChain`, `expiries`, `historical` (1-min candles), `scripMasterPaths` | rest.ts |
| Instrument master | Daily scrip-master CSVs for `nse_cm`, `bse_cm`, `nse_fo`, `bse_fo`, cached per date (`DATA_DIR/refdata`). Lookup by token, symbol, expiry, strike, option type | scripmaster.ts |
| Live feed | SFeed websocket (`HSWebSocket` protocol): authenticate, subscribe/unsubscribe in batches, depth/marketPicture packets, ping/pong. Reconnects with back-off and replays subscriptions. Budget 2,700 of 3,000 tokens | `kotak/sfeed/` |
| Freshness | Quotes carry their timestamp. Only quotes dated a live session count as live. Order books older than 10 s are not traded against (paper fills need a fresh bid/ask). The dashboard shows `FEED STALE` after 90 s without a tick during market hours, and the watchdog then restarts the socket | live-market.ts, services/live.ts (`BOOK_MAX_AGE_MS = 10_000`), ops/index.ts, watchdog.ts |
| Health separation | Login state (`kotak`), feed state (`feed`) and REST errors are reported separately in `/api/health` and `/api/ops` | provider.ts `healthReport()` |

## 2. Instrument coverage

| Instrument | Mapping source | Verified with a real broker response? |
|---|---|---|
| NSE NIFTY 50 (spot `nse_cm` "Nifty 50", F&O `nse_fo` NIFTY) | scripmaster.ts `INDEX_SPECS` | **No.** Fixture rows in the documented layout only |
| NSE BANKNIFTY, FINNIFTY, MIDCPNIFTY, INDIA VIX, NSE stocks/F&O | same | **No** |
| BSE SENSEX, BANKEX (spot `bse_cm`, F&O `bse_fo`) | same. The `bse_fo` symbol name is UNCONFIRMED: `SENSEX`/`BSX` and `BANKEX`/`BKX` are both accepted | **No** |
| MCX commodities | **Not supported.** The scrip master loads no `mcx_fo` file, and no MCX instrument is mapped | **Unavailable** |

## 3. What the tests prove (mocked: not proof of live connectivity)

| Test file | Covers |
|---|---|
| `test/live/kotak-session.test.ts` | Login and validate headers and bodies, TOTP windows, back-off (credential, network, 429), the pause after 5 refusals, re-login on 401, 403 holds |
| `test/live/kotak-rest.test.ts`, `kotak-ratelimit.test.ts` | REST parsing, rate limiter |
| `test/live/kotak-scripmaster.test.ts`, `universe.test.ts` | Instrument master parsing and lookup, subscription universe |
| `test/live/sfeed-protocol.test.ts`, `sfeed-client.test.ts` | Websocket frames, subscribe/ack, reconnect and replay, auth errors |
| `test/live/provider*.test.ts`, `live-market.test.ts` | Provider wiring, freshness, stale handling |
| `test/ops.test.ts` | Login monitor, watchdog feed restart, weekly audit |

All of these use fake `fetch` and fake websockets. None of them contacts Kotak.

## 4. Live verification checklist (to run on a host that allows the Kotak hosts)

Before the C/D readiness gates can pass, a person with the account must do the following, during market hours,
with `LOG_LEVEL=info`:

1. **Login.** The terminal shows `Kotak Neo logged in (data centre …, baseUrl …, token expires …)`. The Operations panel shows Broker `CONNECTED`.
2. **Instrument master.** `/api/health` → `provider.refdata.ready = true`, with today's date and non-zero underlyings and listings. Check that NIFTY, SENSEX and BANKEX map (`/api/expiries/NIFTY`, `/api/expiries/SENSEX`).
3. **Feed.** `/api/health` → `provider.feed.connected = true`, `subscribed > 0`, and `lastTickTs` within seconds. The Operations panel shows Market data `LIVE`.
4. **Contract identity.** For one NIFTY and one SENSEX option, compare `/api/chain/<SYM>?expiry=…` LTP, OI and strike with the Kotak Neo app at the same moment.
5. **Stale detection.** Disconnect the network for 2 minutes. The panel shows `FEED STALE` / `DISCONNECTED`, the watchdog logs a feed restart, and the feed recovers after reconnecting.
6. **Re-login.** Press **Re-login now** while logged out, or wait for the 08:30 IST proactive re-login. The login monitor journal shows `LOGIN_OK`.
7. Record the results, with times and screenshots, in this file under §5.

## 5. Live verification record

| Date | Step | Result | Evidence |
|---|---|---|---|
| — | — | NOT RUN: Kotak hosts are blocked in the audit environment | TEST_EXECUTION_REPORT.md §4 |
