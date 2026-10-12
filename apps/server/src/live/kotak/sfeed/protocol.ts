/**
 * Kotak Neo SFeed market-data protocol ('native_batch'): JSON control frames and the
 * little-endian binary data plane. Pure functions only; the socket lives in client.ts.
 *
 * Sources (see docs/live-data/research/kotak-sfeed-websocket.md, "WS" below, and critic.md):
 * the official language-agnostic spec Kotak-Neo/docs/market-data-apis/websocket.md and the
 * official SDK kotakneoapi 3.0.7 `websocket/feed/protocol.py`. The legacy HSM feed
 * (mlhsm, big-endian) is retired and deliberately not implemented.
 *
 * Decoding never throws: every read is length-checked and unknown packets decode to null.
 */
import type { DepthLevel } from '../../types';

/** Hard-coded SDK default (`utils/urls.py`, WS §2.1). */
export const SFEED_DEFAULT_URL = 'wss://sfeed.kotaksecurities.com/apifeed';

/** Exchange enum, sent as a signed byte in every packet header (WS §3.4, official §9). */
export const SFEED_EXCHANGES = ['none', 'nse_cm', 'nse_fo', 'cde_fo', 'nse_com', 'bse_cm', 'bse_fo', 'bse_cd', 'bse_co', 'mcx_fo', 'ncd_co'] as const;
export type SFeedExchange = (typeof SFEED_EXCHANGES)[number];

const EXCHANGE_IDS = new Map<string, number>(SFEED_EXCHANGES.map((n, i) => [n, i]));

export const exchangeId = (name: string): number | undefined => EXCHANGE_IDS.get(name);
/** Name of an exchange id; unknown ids come back as their decimal string. */
export const exchangeName = (id: number): string => SFEED_EXCHANGES[id] ?? String(id);

/** Divider for an exchange missing from the auth response (official §3 / §9). */
export const DEFAULT_DIVIDER = 100;
export const HEADER_SIZE = 9;

export const MSG = {
  CAS: 104,
  MARKET_STATUS: 105,
  SUBSCRIBE_ACK: 1109,
  AUTH_OK: 1117,
  /** "Initial connect response" — same body as 1117; success only per critic C9 (see client). */
  AUTH_CONNECT: 1119,
  AUTH_FAILED: 1120,
  /** Header-only market open/close, superseded by 105 but still handled by the SDK (WS §5.3). */
  LEGACY_OPEN: 6511,
  LEGACY_CLOSE: 6521,
  INDEX: 7207,
  MARKET_PICTURE: 7208,
} as const;

const PACKET_CODES = new Set<number>([MSG.CAS, MSG.MARKET_STATUS, MSG.LEGACY_OPEN, MSG.LEGACY_CLOSE, MSG.INDEX, MSG.MARKET_PICTURE]);
/** True for binary message codes this decoder understands. */
export const isKnownPacketCode = (code: number): boolean => PACKET_CODES.has(code);

/** Packet sizes of the fixed layouts (official §7). */
export const PACKET_SIZE = { INDEX: 87, MINI: 54, MARKET_PICTURE_FIXED: 144, DEPTH_ROW: 16, MARKET_STATUS: 16, CAS_MIN: 33 } as const;

/* ------------------------------------------------------------------------------------------ */
/* Control plane (JSON text frames)                                                            */
/* ------------------------------------------------------------------------------------------ */

/**
 * Subscription intents (WS §4.2). 'scrips' = touch line (level 4: LTP, OHLC, OI, volume, best
 * bid/ask); 'depth' = level 8 (N depth rows); 'lite' = mini touch line (level 1, LTP only);
 * 'index' = 7207 index packets. Full depth (level 16) is SDK-only and not exposed.
 */
export type SFeedIntent = 'index' | 'scrips' | 'lite' | 'depth';
export const SFEED_INTENTS: readonly SFeedIntent[] = ['index', 'scrips', 'lite', 'depth'];

export const SFEED_EVENTS: Record<SFeedIntent, { subscribe: string; unsubscribe: string; snapshot: string }> = {
  index: { subscribe: 'subscribeIndices', unsubscribe: 'unsubscribeIndices', snapshot: 'snapshotIndices' },
  scrips: { subscribe: 'subscribeScrips', unsubscribe: 'unsubscribeScrips', snapshot: 'snapshotScrips' },
  lite: { subscribe: 'subscribeScripsLite', unsubscribe: 'unsubscribeScripsLite', snapshot: 'snapshotScripsLite' },
  depth: { subscribe: 'subscribeDepth', unsubscribe: 'unsubscribeDepth', snapshot: 'snapshotDepth' },
};

/** One `<exchange_segment>|<token>` entry; the token is numeric or an index name ("Nifty 50"). */
export interface SFeedToken {
  segment: string;
  token: string;
}

/** Tokens are joined with ',' and split on '|', so neither may appear inside one (WS §4.1). */
export function isValidToken(t: SFeedToken): boolean {
  const id = exchangeId(t.segment);
  if (id === undefined || id === 0) return false;
  return typeof t.token === 'string' && t.token.trim() === t.token && t.token.length > 0 && !/[|,]/.test(t.token);
}

export function inputToken(t: SFeedToken): string {
  if (!isValidToken(t)) throw new Error(`Invalid SFeed token "${t.segment}|${t.token}"`);
  return `${t.segment}|${t.token}`;
}

const joinTokens = (tokens: readonly SFeedToken[]): string => {
  if (tokens.length === 0) throw new Error('SFeed frame needs at least one token');
  return tokens.map(inputToken).join(',');
};

/**
 * Build-identification fields copied verbatim from SDK 3.0.7 `_build_auth_frame()` (WS §3.2):
 * the server is only known to work with what the official SDK sends.
 */
export const SFEED_CLIENT_ID = {
  source: 'NEOTRADEAPI',
  platform: 'Web',
  version: '1.2.3',
  sdk_version: 2,
  sdk_date: '2026-08-07T09:41:17.667Z',
} as const;

/**
 * First frame after the socket opens. `user` is the UCC and `auth` is the session `sid` from
 * tradeApiValidate (not the JWT token) — official §3, WS §3.2. `conn_req_time` is epoch ms.
 */
export function buildAuthFrame(p: { ucc: string; sid: string; connReqTime: number }): string {
  return JSON.stringify({
    user: p.ucc,
    auth: p.sid,
    format: 'native_batch',
    source: SFEED_CLIENT_ID.source,
    platform: SFEED_CLIENT_ID.platform,
    version: SFEED_CLIENT_ID.version,
    sdk_version: SFEED_CLIENT_ID.sdk_version,
    sdk_date: SFEED_CLIENT_ID.sdk_date,
    conn_req_time: Math.trunc(p.connReqTime),
    sessionValidation: false,
  });
}

/** `ack_symbol: true` asks for the 1109 acknowledgement with trading symbols (official §4–§5). */
export function buildSubscribeFrame(intent: SFeedIntent, tokens: readonly SFeedToken[]): string {
  return JSON.stringify({ event: SFEED_EVENTS[intent].subscribe, inputtoken: joinTokens(tokens), ack_symbol: true });
}

/** Unsubscribe never carries `ack_symbol` (asserted by the SDK tests, WS §4.1). */
export function buildUnsubscribeFrame(intent: SFeedIntent, tokens: readonly SFeedToken[]): string {
  return JSON.stringify({ event: SFEED_EVENTS[intent].unsubscribe, inputtoken: joinTokens(tokens) });
}

/** One-off snapshot; the reply arrives on the binary plane as ordinary packets. */
export function buildSnapshotFrame(intent: SFeedIntent, tokens: readonly SFeedToken[]): string {
  return JSON.stringify({ event: SFEED_EVENTS[intent].snapshot, inputtoken: joinTokens(tokens), ack_symbol: true });
}

/** Segment-wide market-status stream (code 105); SDK-only event without `inputtoken` (WS §4.2). */
export function buildMarketStatusFrame(subscribe: boolean): string {
  return JSON.stringify({ event: subscribe ? 'subscribeExchange' : 'unsubscribeExchange' });
}

export type SFeedControl =
  | {
      kind: 'auth';
      code: typeof MSG.AUTH_OK | typeof MSG.AUTH_CONNECT;
      id?: string;
      format?: string;
      /** Server downgraded to 'native_fallback', a different body layout we do not decode. */
      fallback: boolean;
      /** exchange id → price divider. */
      dividers: Map<number, number>;
    }
  | { kind: 'authFailed'; code: typeof MSG.AUTH_FAILED; message: string }
  | {
      kind: 'ack';
      code: typeof MSG.SUBSCRIBE_ACK;
      ok: boolean;
      errorCode?: number;
      description?: string;
      /** 'seg|token' (as subscribed) → trading symbol. */
      symbols: Record<string, string>;
      /** 'seg|token' → cas_status (official shape only). */
      casStatus: Record<string, number>;
    }
  | { kind: 'error'; code?: number; message: string }
  | { kind: 'other'; code?: number; data: Record<string, unknown> }
  | { kind: 'invalid'; reason: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const toNum = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

const text = (...vals: unknown[]): string | undefined => {
  for (const v of vals) if (typeof v === 'string' && v.trim()) return v.trim();
  return undefined;
};

/**
 * Dividers keyed by exchange id. The SDK prefers the response's own `value`, falling back to the
 * name enum; a missing or non-positive divider means 100 (official §3, SDK `_authenticate`).
 */
export function parseDividers(exchanges: unknown): Map<number, number> {
  const out = new Map<number, number>();
  if (!isRecord(exchanges)) return out;
  for (const [name, info] of Object.entries(exchanges)) {
    if (!isRecord(info)) continue;
    const id = toNum(info.value) ?? exchangeId(name);
    if (id === undefined || !Number.isInteger(id)) continue;
    const div = toNum(info.divider);
    out.set(id, div !== undefined && div > 0 ? div : DEFAULT_DIVIDER);
  }
  return out;
}

/**
 * The 1109 acknowledgement comes in two documented shapes (WS §4.4, open item U5):
 * SDK `{trading_symbols: {"seg|tok": "SYM"}}` and official `{data: {"seg|tok": {trading_symbols, cas_status}}}`.
 */
function parseAck(o: Record<string, unknown>): Extract<SFeedControl, { kind: 'ack' }> {
  const symbols: Record<string, string> = {};
  const casStatus: Record<string, number> = {};
  if (isRecord(o.trading_symbols)) {
    for (const [k, v] of Object.entries(o.trading_symbols)) if (typeof v === 'string') symbols[k] = v;
  }
  if (isRecord(o.data)) {
    for (const [k, v] of Object.entries(o.data)) {
      if (!isRecord(v)) continue;
      if (typeof v.trading_symbols === 'string') symbols[k] = v.trading_symbols;
      const cas = toNum(v.cas_status);
      if (cas !== undefined) casStatus[k] = cas;
    }
  }
  const errorCode = toNum(o.error_code);
  const description = text(o.description, o.message);
  return { kind: 'ack', code: MSG.SUBSCRIBE_ACK, ok: errorCode === undefined || errorCode === 0, errorCode, description, symbols, casStatus };
}

/** Parse one JSON text frame. Never throws. */
export function parseControlFrame(raw: string): SFeedControl {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', reason: 'not JSON' };
  }
  if (!isRecord(o)) return { kind: 'invalid', reason: 'not a JSON object' };
  const code = toNum(o.message_code);
  if (code === MSG.AUTH_OK || code === MSG.AUTH_CONNECT) {
    const format = typeof o.format === 'string' ? o.format : undefined;
    return { kind: 'auth', code, id: typeof o.id === 'string' ? o.id : undefined, format, fallback: format === 'native_fallback', dividers: parseDividers(o.exchanges) };
  }
  if (code === MSG.AUTH_FAILED) return { kind: 'authFailed', code, message: text(o.message, o.description, o.error) ?? 'Auth failed' };
  if (code === MSG.SUBSCRIBE_ACK) return parseAck(o);
  const errorCode = toNum(o.error_code ?? o.errorCode);
  if ((errorCode !== undefined && errorCode !== 0) || o.stat === 'Not_Ok' || typeof o.error === 'string' || o.status === 'error') {
    return { kind: 'error', code, message: text(o.message, o.description, o.emsg, o.error) ?? `error code ${errorCode ?? code ?? '?'}` };
  }
  return { kind: 'other', code, data: o };
}

/* ------------------------------------------------------------------------------------------ */
/* Data plane (binary, little-endian, packed, batched)                                          */
/* ------------------------------------------------------------------------------------------ */

export interface SFeedHeader {
  /** Total packet length incl. these 2 bytes (also the de-framing length). */
  length: number;
  code: number;
  exchangeId: number;
  level: number;
  /** SDK: auction = flag > 0; official: reserved. */
  auction: number;
  seq: number;
  bitmaskLength: number;
}

interface PacketBase {
  exchangeId: number;
  /** Exchange name from the enum ('nse_fo' …), or the id as a string when unknown. */
  exchange: string;
  seq: number;
}

/** Index — code 7207, 87 bytes (official §7.2). No volume, no OI. */
export interface SFeedIndexPacket extends PacketBase {
  kind: 'index';
  /** Numeric token the server resolved the index to (e.g. "26000"), even when subscribed by name. */
  token: string;
  /** Index name from the packet, NUL-trimmed (e.g. "NIFTY 50"). */
  name: string;
  ltp: number;
  open: number;
  high: number;
  low: number;
  /** Previous close / closing index. */
  close: number;
  /** index_value − close_price. */
  change: number;
  changePct: number;
  yearHigh: number;
  yearLow: number;
  /** Raw wire value (epoch seconds, WS §5.10). */
  lttRaw: number;
  /** Epoch ms, null when absent/implausible. */
  ltt: number | null;
  precision: number;
  /** Raw (unused by the reference client). */
  multiplier: number;
}

/** Market picture — code 7208, level 2/4/8/16 (official §7.3). A full record, not a delta. */
export interface SFeedMarketPicturePacket extends PacketBase {
  kind: 'marketPicture';
  level: number;
  token: string;
  /** Quantities are raw exchange units (shares/contracts' underlying quantity, not lots — critic C13). */
  totalBuyQty: number;
  totalSellQty: number;
  volume: number;
  lttRaw: number;
  ltt: number | null;
  /** Raw wire value; −2209008600 (1900-01-01 IST) is the "never updated" sentinel. */
  lutRaw: number;
  lut: number | null;
  open: number;
  /** close_price: previous close (WS §5.5; intraday semantics UNCONFIRMED, WS §10.5). */
  close: number;
  high: number;
  low: number;
  ltp: number;
  ltq: number;
  atp: number;
  buyDepthCount: number;
  sellDepthCount: number;
  changePct: number;
  /** Open interest in units (critic C13). */
  oi: number;
  /** total_traded_value / divider; null when the double is not finite. */
  turnover: number | null;
  change: number;
  upperCircuit: number;
  lowerCircuit: number;
  yearHigh: number;
  yearLow: number;
  lotSize: number;
  precision: number;
  multiplier: number;
  auction: boolean;
  bids: DepthLevel[];
  asks: DepthLevel[];
}

/** Mini touch line — code 7208, level 1, 54 bytes (official §7.4). LTP only, no OHLC/OI/volume. */
export interface SFeedMiniPacket extends PacketBase {
  kind: 'mini';
  token: string;
  lttRaw: number;
  ltt: number | null;
  ltp: number;
  ltq: number;
  /**
   * Divided by the divider. The official doc calls this a "not divided" quirk, but its own worked
   * example (and SDK 3.0.7) prove it is scaled like every other price (WS §5.6).
   */
  close: number;
  changePct: number;
  change: number;
  lotSize: number;
  precision: number;
  multiplier: number;
}

/** Market status — code 105 (16 bytes), or the header-only legacy 6511/6521 (WS §5.7). */
export interface SFeedMarketStatusPacket extends PacketBase {
  kind: 'marketStatus';
  statusCode: number;
  /** Name from the official table, null for an unknown code. */
  name: string | null;
  /** Wire label (unreliable, often empty). */
  raw: string;
}

/** CAS reference — code 104 (closing auction imbalance; cash segment only). */
export interface SFeedCasPacket extends PacketBase {
  kind: 'cas';
  token: string;
  refPrice: number;
  imbalanceQty: number;
  imbalanceQtyAtMkt: number;
}

export type SFeedPacket = SFeedIndexPacket | SFeedMarketPicturePacket | SFeedMiniPacket | SFeedMarketStatusPacket | SFeedCasPacket;

/** status_code values of code 105 (official §7.5). */
export const MARKET_STATUS_NAMES: Readonly<Record<number, string>> = {
  1: 'OpenMessage',
  2: 'CloseMessage',
  3: 'PreopenShutdownMsg',
  4: 'NormalMktPreopenEnded',
  5: 'AuctionStatusChange',
  6: 'ClosingStart',
  7: 'ClosingEnd',
  8: 'CtsCloseForCas',
  9: 'RevisedPriceBandCompleted',
  10: 'CasStart',
  11: 'MarketOrderRestricted',
  12: 'CasEnd',
};

/** 2100-01-01T00:00:00Z in seconds: anything later is not an epoch-seconds timestamp. */
const MAX_EPOCH_S = 4_102_444_800;

/**
 * Feed timestamps are Unix epoch seconds (WS §5.10: the official worked example 1756636800 and
 * the SDK's 1900-IST sentinel both fit; live confirmation is open item U7). ≤ 0 means "never".
 */
export function feedTimeMs(raw: number): number | null {
  if (!Number.isFinite(raw) || raw <= 0 || raw >= MAX_EPOCH_S) return null;
  return raw * 1000;
}

const view = (p: Uint8Array): DataView => new DataView(p.buffer, p.byteOffset, p.byteLength);
const i64 = (v: DataView, o: number): number => Number(v.getBigInt64(o, true));
const u64 = (v: DataView, o: number): number => Number(v.getBigUint64(o, true));
const utf8 = new TextDecoder('utf-8');

/** Fixed-size UTF-8, NUL-padded: decode up to the first NUL and trim (official §6.3). */
function cString(p: Uint8Array, start: number, end: number): string {
  const b = p.subarray(start, Math.min(end, p.byteLength));
  const z = b.indexOf(0);
  return utf8.decode(z < 0 ? b : b.subarray(0, z)).trim();
}

function dividerFor(dividers: ReadonlyMap<number, number>, id: number): number {
  const d = dividers.get(id);
  return d !== undefined && Number.isFinite(d) && d > 0 ? d : DEFAULT_DIVIDER;
}

/**
 * Split one binary message into packets: each starts with its own uint16 LE total length.
 * Stops (without throwing) at a zero/garbage length or a truncated tail (official §6.1, SDK `split_batch`).
 */
export function splitBatch(frame: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  const v = view(frame);
  let off = 0;
  while (off + 2 <= frame.byteLength) {
    const size = v.getUint16(off, true);
    if (size < HEADER_SIZE || off + size > frame.byteLength) break;
    out.push(frame.subarray(off, off + size));
    off += size;
  }
  return out;
}

export function readHeader(p: Uint8Array): SFeedHeader | null {
  if (p.byteLength < HEADER_SIZE) return null;
  const v = view(p);
  return {
    length: v.getUint16(0, true),
    code: v.getUint16(2, true),
    exchangeId: v.getInt8(4),
    level: v.getUint8(5),
    auction: v.getUint8(6),
    seq: v.getUint8(7),
    bitmaskLength: v.getUint8(8),
  };
}

function decodeIndex(p: Uint8Array, base: PacketBase, d: number): SFeedIndexPacket | null {
  if (p.byteLength < PACKET_SIZE.INDEX) return null;
  const v = view(p);
  const close = v.getInt32(17, true);
  const value = v.getInt32(29, true);
  const lttRaw = u64(v, 33);
  return {
    ...base,
    kind: 'index',
    token: String(v.getUint32(9, true)),
    name: cString(p, 66, 87),
    ltp: value / d,
    open: v.getInt32(13, true) / d,
    high: v.getInt32(21, true) / d,
    low: v.getInt32(25, true) / d,
    close: close / d,
    change: (value - close) / d,
    changePct: v.getInt32(49, true) / 100,
    yearHigh: v.getInt32(41, true) / d,
    yearLow: v.getInt32(45, true) / d,
    lttRaw,
    ltt: feedTimeMs(lttRaw),
    precision: v.getUint8(61),
    multiplier: v.getInt32(62, true),
  };
}

function decodeMini(p: Uint8Array, base: PacketBase, d: number): SFeedMiniPacket | null {
  if (p.byteLength < PACKET_SIZE.MINI) return null;
  const v = view(p);
  const lttRaw = i64(v, 13);
  return {
    ...base,
    kind: 'mini',
    token: String(v.getUint32(9, true)),
    lttRaw,
    ltt: feedTimeMs(lttRaw),
    ltp: v.getUint32(21, true) / d,
    ltq: i64(v, 25),
    close: v.getUint32(33, true) / d,
    changePct: v.getInt32(37, true) / 100,
    change: v.getInt32(41, true) / d,
    lotSize: v.getUint32(45, true),
    precision: v.getUint8(49),
    multiplier: v.getUint32(50, true),
  };
}

function decodeMarketPicture(p: Uint8Array, h: SFeedHeader, base: PacketBase, d: number): SFeedMarketPicturePacket | null {
  if (p.byteLength < PACKET_SIZE.MARKET_PICTURE_FIXED) return null;
  const v = view(p);
  const buyDepthCount = v.getUint32(89, true);
  const sellDepthCount = v.getUint32(93, true);
  // Touch line (level 4) always carries exactly 1 bid + 1 ask, whatever the counts say (official §6.2).
  const [buyN, sellN] = h.level === 4 ? [1, 1] : [buyDepthCount, sellDepthCount];
  // A packet may carry fewer rows than the counts imply: stop at message_length (official §7.3).
  const limit = Math.min(h.length, p.byteLength);
  const bids: DepthLevel[] = [];
  const asks: DepthLevel[] = [];
  for (let i = 0, off = PACKET_SIZE.MARKET_PICTURE_FIXED; i < buyN + sellN && off + PACKET_SIZE.DEPTH_ROW <= limit; i++, off += PACKET_SIZE.DEPTH_ROW) {
    const row: DepthLevel = { qty: i64(v, off), price: v.getInt32(off + 8, true) / d, orders: v.getInt32(off + 12, true) };
    (i < buyN ? bids : asks).push(row);
  }
  const lttRaw = i64(v, 37);
  const lutRaw = i64(v, 45);
  const ttv = v.getFloat64(107, true);
  return {
    ...base,
    kind: 'marketPicture',
    level: h.level,
    token: String(v.getUint32(9, true)),
    totalBuyQty: i64(v, 13),
    totalSellQty: i64(v, 21),
    volume: i64(v, 29),
    lttRaw,
    ltt: feedTimeMs(lttRaw),
    lutRaw,
    lut: feedTimeMs(lutRaw),
    open: v.getUint32(53, true) / d,
    close: v.getUint32(57, true) / d,
    high: v.getUint32(61, true) / d,
    low: v.getUint32(65, true) / d,
    ltp: v.getUint32(69, true) / d,
    ltq: i64(v, 73),
    atp: v.getUint32(81, true) / d,
    buyDepthCount,
    sellDepthCount,
    changePct: v.getInt32(99, true) / 100,
    oi: v.getUint32(103, true),
    turnover: Number.isFinite(ttv) ? ttv / d : null,
    change: v.getInt32(115, true) / d,
    upperCircuit: v.getUint32(119, true) / d,
    lowerCircuit: v.getUint32(123, true) / d,
    yearHigh: v.getUint32(127, true) / d,
    yearLow: v.getUint32(131, true) / d,
    lotSize: v.getUint32(135, true),
    precision: v.getUint8(139),
    multiplier: v.getUint32(140, true),
    auction: h.auction > 0,
    bids,
    asks,
  };
}

function decodeMarketStatus(p: Uint8Array, base: PacketBase): SFeedMarketStatusPacket | null {
  if (p.byteLength < HEADER_SIZE + 2) return null;
  const statusCode = view(p).getUint16(9, true);
  return { ...base, kind: 'marketStatus', statusCode, name: MARKET_STATUS_NAMES[statusCode] ?? null, raw: cString(p, 11, PACKET_SIZE.MARKET_STATUS) };
}

function decodeCas(p: Uint8Array, base: PacketBase, d: number): SFeedCasPacket | null {
  if (p.byteLength < PACKET_SIZE.CAS_MIN) return null;
  const v = view(p);
  const ref = v.getUint32(13, true);
  const imb = i64(v, 17);
  const imbMkt = i64(v, 25);
  // Outside the CAS window the exchange sends all zeros: no information (SDK `_decode_cas_change`).
  if (ref === 0 && imb === 0 && imbMkt === 0) return null;
  return { ...base, kind: 'cas', token: String(v.getUint32(9, true)), refPrice: ref / d, imbalanceQty: imb, imbalanceQtyAtMkt: imbMkt };
}

/**
 * Decode one de-framed packet, or null for unknown/short/empty packets. Routing follows
 * official §6.2 / SDK `decode_packet`: code first (7207, 105, 104, legacy 6511/6521), then the
 * level byte for code 7208. Unlike the reference routing, a level byte under an unknown code is
 * not decoded as market data — unknown codes are skipped.
 */
export function decodePacket(p: Uint8Array, dividers: ReadonlyMap<number, number>): SFeedPacket | null {
  const h = readHeader(p);
  if (!h) return null;
  const base: PacketBase = { exchangeId: h.exchangeId, exchange: exchangeName(h.exchangeId), seq: h.seq };
  const d = dividerFor(dividers, h.exchangeId);
  switch (h.code) {
    case MSG.LEGACY_OPEN:
    case MSG.LEGACY_CLOSE: {
      const statusCode = h.code === MSG.LEGACY_OPEN ? 1 : 2;
      return { ...base, kind: 'marketStatus', statusCode, name: MARKET_STATUS_NAMES[statusCode], raw: '' };
    }
    case MSG.INDEX:
      return decodeIndex(p, base, d);
    case MSG.MARKET_STATUS:
      return decodeMarketStatus(p, base);
    case MSG.CAS:
      return decodeCas(p, base, d);
    case MSG.MARKET_PICTURE:
      if (h.level === 1) return decodeMini(p, base, d);
      if (h.level === 2 || h.level === 4 || h.level === 8 || h.level === 16) return decodeMarketPicture(p, h, base, d);
      return null;
    default:
      return null;
  }
}

/** De-frame and decode a whole binary message; malformed or unknown packets are skipped. */
export function decodeBatch(frame: Uint8Array, dividers: ReadonlyMap<number, number>): SFeedPacket[] {
  const out: SFeedPacket[] = [];
  for (const p of splitBatch(frame)) {
    const d = decodePacket(p, dividers);
    if (d) out.push(d);
  }
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* Endpoint                                                                                     */
/* ------------------------------------------------------------------------------------------ */

/** Retired HSM host (WS §0, appendix A): never dial it, it speaks a different protocol. */
const LEGACY_HSM_HOST = 'mlhsm.kotaksecurities.com';

/**
 * Normalise a feed endpoint to a websocket URL: https→wss, http→ws (SDK `ws_scheme.py`), a bare
 * host gets `wss://` (config-service entries can lack a scheme, WS §2.3). Returns null for
 * empty/invalid values and for the retired HSM host.
 */
export function toWebSocketUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (/^https:\/\//i.test(s)) s = `wss://${s.slice(8)}`;
  else if (/^http:\/\//i.test(s)) s = `ws://${s.slice(7)}`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `wss://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null;
  if (!u.hostname || u.hostname.toLowerCase() === LEGACY_HSM_HOST) return null;
  return s;
}

export type FeedUrlSource = 'config' | 'feedUrl' | 'default';

/**
 * SDK precedence (`neo_api.py create_websocket`, WS §2.4, critic C1): the dynamic config service's
 * `<dc>_<src>_broadcast_endpoint`, then tradeApiValidate's `data.feedUrl`, then the default.
 * Callers should log the returned `source`.
 */
export function resolveFeedUrl(p: { configEndpoint?: string | null; feedUrl?: string | null }): { url: string; source: FeedUrlSource } {
  const fromConfig = toWebSocketUrl(p.configEndpoint);
  if (fromConfig) return { url: fromConfig, source: 'config' };
  const fromFeed = toWebSocketUrl(p.feedUrl);
  if (fromFeed) return { url: fromFeed, source: 'feedUrl' };
  return { url: SFEED_DEFAULT_URL, source: 'default' };
}
