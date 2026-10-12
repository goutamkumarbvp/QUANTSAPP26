/**
 * Kotak Neo market-data REST calls over a KotakSession, with parsers for the documented response
 * shapes (official market-data-apis/{quotes,option-chain,expiries,historical-data,instruments}.md,
 * kotak-rest-auth.md §3–§6, critic.md C3/C4/C13/R3/R5). All calls use `Authorization` only;
 * option-chain, expiries and historical go through the 'slow' lane (≥1.5 s apart).
 *
 * Parsed shapes carry only values the response actually contained: zero/blank placeholders
 * (index volume and depth, untraded prices, empty depth levels) are dropped, never defaulted.
 */
import type { DepthLevel, InstrumentKey, LiveQuote, OptKind } from '../types';
import { KotakError, type KotakRequestOptions } from './session';

/** The part of KotakSession these calls need (lets tests and the provider wrap it). */
export interface KotakRequester {
  request<T = unknown>(path: string, opts: KotakRequestOptions): Promise<T>;
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/** Number from Kotak's string/number fields; undefined for blanks and non-numbers. */
export function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (s === '' || s === '-') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}
/** Positive number or undefined (prices, where 0 means "no value"). */
const pos = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n > 0 ? n : undefined;
};
/** Non-negative number or undefined (quantities and OI, where 0 is a real value). */
const nonNeg = (v: unknown): number | undefined => {
  const n = num(v);
  return n !== undefined && n >= 0 ? n : undefined;
};
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

/** Drops undefined fields so parsed objects only list what the source provided. */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k];
  return o;
}

/* ------------------------------------------------------------------------------------------ */
/* Quotes                                                                                       */
/* ------------------------------------------------------------------------------------------ */

export const QUOTES_MAX_PER_CALL = 50;

export interface KotakQuote {
  /** `${segment}|${token}` exactly as requested (index name unencoded, e.g. 'nse_cm|Nifty 50'). */
  neosymbol: string;
  segment: string;
  /** Instrument token, or the index name for indices. */
  token: string;
  displaySymbol?: string;
  isIndex: boolean;
  /** lstup_time (epoch ms). */
  ts?: number;
  ltp?: number;
  ltq?: number;
  open?: number;
  high?: number;
  low?: number;
  /** ohlc.close is the PREVIOUS session close (official quotes.md). */
  prevClose?: number;
  change?: number;
  changePct?: number;
  /** Day volume in units: `last_volume` (critic.md C3, SDK reading; verify on day 1). */
  volume?: number;
  atp?: number;
  oi?: number;
  totalBuyQty?: number;
  totalSellQty?: number;
  upperCircuit?: number;
  lowerCircuit?: number;
  yearHigh?: number;
  yearLow?: number;
  depth?: { bids: DepthLevel[]; asks: DepthLevel[] };
}

export interface QuotesResult {
  quotes: Map<string, KotakQuote>;
  /** Chunks that failed (their symbols are absent from `quotes`). */
  errors: { neosymbols: string[]; error: string }[];
}

const SEG_RE = /^(nse_cm|bse_cm|nse_fo|bse_fo|cde_fo|mcx_fo)$/;

function splitNeo(neosymbol: string): { segment: string; token: string } {
  const i = neosymbol.indexOf('|');
  const segment = i > 0 ? neosymbol.slice(0, i) : '';
  const token = i > 0 ? neosymbol.slice(i + 1) : '';
  if (!SEG_RE.test(segment) || !token || /[|,/]/.test(token)) throw new Error(`Invalid neosymbol "${neosymbol}" (expected <segment>|<token or index name>)`);
  return { segment, token };
}

/**
 * Path of one quotes call. '|' and ',' stay literal (SDK 3.0.x keeps them so); the token part is
 * percent-encoded, so index names become e.g. 'Nifty%2050' (kotak-rest-auth.md §4).
 */
export function quotesPath(neosymbols: string[]): string {
  const parts = neosymbols.map((s) => {
    const { segment, token } = splitNeo(s);
    return `${segment}|${encodeURIComponent(token)}`;
  });
  return `script-details/1.0/quotes/neosymbol/${parts.join(',')}/all`;
}

function parseDepth(side: unknown): DepthLevel[] {
  if (!Array.isArray(side)) return [];
  const out: DepthLevel[] = [];
  for (const l of side) {
    if (!isObj(l)) continue;
    const price = pos(l.price);
    const qty = pos(l.quantity);
    // Empty levels come back as "0"s: no order there, not a level at price 0.
    if (price === undefined || qty === undefined) continue;
    out.push({ price, qty, orders: nonNeg(l.orders) ?? 0 });
  }
  return out;
}

/** One element of the quotes array. Returns null when the row has no identity. */
export function parseQuote(row: unknown): KotakQuote | null {
  if (!isObj(row)) return null;
  const segment = text(row.exchange);
  const token = text(row.exchange_token);
  if (!segment || !token) return null;
  const cash = segment === 'nse_cm' || segment === 'bse_cm';
  // Indices are addressed by name; their volume/depth/52w fields are "0" placeholders (critic.md R3).
  const isIndex = cash && !/^\d+$/.test(token);
  const ohlc = isObj(row.ohlc) ? row.ohlc : {};
  const depth = isObj(row.depth) ? row.depth : {};
  const lstup = pos(row.lstup_time);
  const bids = isIndex ? [] : parseDepth(depth.buy);
  const asks = isIndex ? [] : parseDepth(depth.sell);
  const zeroAsAbsent = (v: unknown) => (isIndex ? pos(v) : nonNeg(v));
  return compact<KotakQuote>({
    neosymbol: `${segment}|${token}`,
    segment,
    token,
    displaySymbol: text(row.display_symbol),
    isIndex,
    ts: lstup !== undefined ? Math.round(lstup * 1000) : undefined,
    ltp: pos(row.ltp),
    ltq: pos(row.last_traded_quantity),
    open: pos(ohlc.open),
    high: pos(ohlc.high),
    low: pos(ohlc.low),
    prevClose: pos(ohlc.close),
    change: num(row.change),
    changePct: num(row.per_change),
    volume: zeroAsAbsent(row.last_volume),
    atp: pos(row.avg_cost),
    // Cash instruments have no OI; "0" there is a placeholder.
    oi: cash ? undefined : nonNeg(row.open_int),
    totalBuyQty: zeroAsAbsent(row.total_buy),
    totalSellQty: zeroAsAbsent(row.total_sell),
    upperCircuit: pos(row.high_price_range),
    lowerCircuit: pos(row.low_price_range),
    yearHigh: pos(row.year_high),
    yearLow: pos(row.year_low),
    depth: bids.length || asks.length ? { bids, asks } : undefined,
  });
}

/** Top-level array (documented) or `{data:[...]}` (seen in SDK internals). */
export function parseQuotes(body: unknown): KotakQuote[] {
  const rows = Array.isArray(body) ? body : isObj(body) && Array.isArray(body.data) ? body.data : null;
  if (!rows) throw new KotakError('Kotak quotes: unexpected response shape', 'protocol');
  const out: KotakQuote[] = [];
  for (const r of rows) {
    const q = parseQuote(r);
    if (q) out.push(q);
  }
  return out;
}

/** LiveQuote for an instrument key; undefined when the quote has no LTP. `receivedAt` stands in
 *  for a missing exchange timestamp (it is when the value was observed). */
export function quoteToLive(q: KotakQuote, key: InstrumentKey, receivedAt: number): LiveQuote | undefined {
  if (q.ltp === undefined) return undefined;
  const bid = q.depth?.bids[0];
  const ask = q.depth?.asks[0];
  return compact<LiveQuote>({
    key,
    ts: q.ts ?? receivedAt,
    ltp: q.ltp,
    ltq: q.ltq,
    open: q.open,
    high: q.high,
    low: q.low,
    prevClose: q.prevClose,
    volume: q.volume,
    atp: q.atp,
    oi: q.oi,
    bid: bid?.price,
    ask: ask?.price,
    bidQty: bid?.qty,
    askQty: ask?.qty,
    totalBuyQty: q.totalBuyQty,
    totalSellQty: q.totalSellQty,
    depth: q.depth,
    upperCircuit: q.upperCircuit,
    lowerCircuit: q.lowerCircuit,
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Option chain / futures chain / expiries                                                      */
/* ------------------------------------------------------------------------------------------ */

export type FoExchange = 'nse_fo' | 'bse_fo';

export interface KotakChainLeg {
  neosymbol: string;
  segment: string;
  token: string;
  tradingSymbol?: string;
  type: OptKind;
  /** Rupees (already unscaled in this endpoint). */
  strike: number;
  moneyness?: string;
  ltp?: number;
  open?: number;
  high?: number;
  low?: number;
  prevClose?: number;
  /** null intraday; the settlement close once published. */
  close?: number;
  /** Units (critic.md C13). */
  volume?: number;
  oi?: number;
  prevOi?: number;
  oiChange?: number;
  oiChangePct?: number;
}

export interface KotakOptionChain {
  exchange: string;
  underlying: string;
  expiry: string | null;
  lotSize?: number;
  multiplier?: number;
  calls: KotakChainLeg[];
  puts: KotakChainLeg[];
}

export interface KotakFutureRow {
  neosymbol: string;
  segment: string;
  token: string;
  tradingSymbol?: string;
  expiry?: string;
  ltp?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  prevClose?: number;
  volume?: number;
  oi?: number;
  prevOi?: number;
  oiChange?: number;
  oiChangePct?: number;
}

export interface KotakFuturesChain {
  exchange: string;
  underlying: string;
  lotSize?: number;
  multiplier?: number;
  futures: KotakFutureRow[];
}

const MONTHS: Record<string, string> = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

/** 'YYYY-MM-DD' from '2026-07-31' or '31-JUL-2026' (futures chain); undefined otherwise. */
export function parseKotakDate(v: unknown): string | undefined {
  const s = text(v);
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = /^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{4})$/.exec(s);
  if (m && MONTHS[m[2].toUpperCase()]) return `${m[3]}-${MONTHS[m[2].toUpperCase()]}-${m[1].padStart(2, '0')}`;
  return undefined;
}

function dataOf(body: unknown, what: string): Json {
  if (isObj(body) && isObj(body.data)) return body.data;
  throw new KotakError(`Kotak ${what}: unexpected response shape`, 'protocol');
}

function parseLeg(row: unknown, side: OptKind): KotakChainLeg | null {
  if (!isObj(row) || !isObj(row.instrument)) return null;
  const inst = row.instrument;
  const neosymbol = text(inst.neoSymbol);
  const strike = pos(inst.strikePrice);
  if (!neosymbol || strike === undefined) return null;
  const i = neosymbol.indexOf('|');
  if (i <= 0) return null;
  const q = isObj(row.quote) ? row.quote : {};
  const oi = isObj(row.openInterest) ? row.openInterest : {};
  const ot = text(inst.optionType)?.toUpperCase();
  return compact<KotakChainLeg>({
    neosymbol,
    segment: neosymbol.slice(0, i),
    token: neosymbol.slice(i + 1),
    tradingSymbol: text(inst.symbol),
    type: ot === 'CE' || ot === 'PE' ? ot : side,
    strike,
    moneyness: text(inst.moneyness),
    ltp: pos(q.ltp),
    open: pos(q.open),
    high: pos(q.high),
    low: pos(q.low),
    prevClose: pos(q.prevClose),
    close: pos(q.close),
    volume: nonNeg(q.volume),
    oi: nonNeg(oi.current),
    prevOi: nonNeg(oi.previous),
    oiChange: num(oi.change),
    oiChangePct: num(oi.changePct),
  });
}

export function parseOptionChain(body: unknown): KotakOptionChain {
  const d = dataOf(body, 'option-chain');
  const common = isObj(d.common_data) ? d.common_data : {};
  const legs = (arr: unknown, side: OptKind) => (Array.isArray(arr) ? arr.map((r) => parseLeg(r, side)).filter((l): l is KotakChainLeg => !!l) : []);
  return compact<KotakOptionChain>({
    exchange: text(common.exSeg) ?? '',
    underlying: text(common.unlSymbol) ?? '',
    expiry: parseKotakDate(common.expiryDt) ?? null,
    lotSize: pos(common.mktLot),
    multiplier: pos(common.multiplier),
    calls: legs(d.call, 'CE').sort((a, b) => a.strike - b.strike),
    puts: legs(d.put, 'PE').sort((a, b) => a.strike - b.strike),
  });
}

/** `instrument_type=fut` rows use abbreviated keys: inst{…}, quote{ltp,o,h,l,c,pc,vol}, oi{cur,prev,chg,chgPct}. */
export function parseFuturesChain(body: unknown): KotakFuturesChain {
  const d = dataOf(body, 'futures chain');
  const common = isObj(d.common_data) ? d.common_data : {};
  const futures: KotakFutureRow[] = [];
  for (const row of Array.isArray(d.fut) ? d.fut : []) {
    if (!isObj(row) || !isObj(row.inst)) continue;
    const neosymbol = text(row.inst.neoSymbol);
    const i = neosymbol?.indexOf('|') ?? -1;
    if (!neosymbol || i <= 0) continue;
    const q = isObj(row.quote) ? row.quote : {};
    const oi = isObj(row.oi) ? row.oi : {};
    futures.push(
      compact<KotakFutureRow>({
        neosymbol,
        segment: neosymbol.slice(0, i),
        token: neosymbol.slice(i + 1),
        tradingSymbol: text(row.inst.symbol),
        expiry: parseKotakDate(row.inst.expiryDt),
        ltp: pos(q.ltp),
        open: pos(q.o),
        high: pos(q.h),
        low: pos(q.l),
        close: pos(q.c),
        prevClose: pos(q.pc),
        volume: nonNeg(q.vol),
        oi: nonNeg(oi.cur),
        prevOi: nonNeg(oi.prev),
        oiChange: num(oi.chg),
        oiChangePct: num(oi.chgPct),
      }),
    );
  }
  futures.sort((a, b) => (a.expiry ?? '').localeCompare(b.expiry ?? ''));
  return compact<KotakFuturesChain>({
    exchange: text(common.exSeg) ?? '',
    underlying: text(common.unlSymbol) ?? '',
    lotSize: pos(common.mktLot),
    multiplier: pos(common.multiplier),
    futures,
  });
}

/** Option-chain leg as a LiveQuote (the endpoint has no timestamp: `receivedAt` is used). */
export function chainLegToLive(leg: KotakChainLeg | KotakFutureRow, key: InstrumentKey, receivedAt: number): LiveQuote | undefined {
  if (leg.ltp === undefined) return undefined;
  return compact<LiveQuote>({
    key,
    ts: receivedAt,
    ltp: leg.ltp,
    open: leg.open,
    high: leg.high,
    low: leg.low,
    prevClose: leg.prevClose,
    volume: leg.volume,
    oi: leg.oi,
    prevOi: leg.prevOi,
  });
}

export function parseExpiries(body: unknown): string[] {
  const src = isObj(body) && Array.isArray(body.expiries) ? body.expiries : isObj(body) && isObj(body.data) && Array.isArray(body.data.expiries) ? body.data.expiries : null;
  if (!src) throw new KotakError('Kotak expiries: unexpected response shape', 'protocol');
  const set = new Set<string>();
  for (const e of src) {
    const d = parseKotakDate(e);
    if (d) set.add(d);
  }
  return [...set].sort();
}

/* ------------------------------------------------------------------------------------------ */
/* Historical candles                                                                           */
/* ------------------------------------------------------------------------------------------ */

export type HistInterval = '1min' | '3min' | '5min' | '10min' | '15min' | '30min' | '60min' | 'D' | 'W';

/** Max calendar days per request, backend-enforced (historical-data.md "Date Range Limits"). */
export const HIST_MAX_DAYS: Record<HistInterval, number> = {
  '1min': 30,
  '3min': 30,
  '5min': 30,
  '10min': 60,
  '15min': 60,
  '30min': 90,
  '60min': 90,
  D: 180,
  W: 180,
};

export interface KotakCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Only when positive: the backend does not populate OI yet ("Phase 1"). */
  oi?: number;
}

const DAY_MS = 86_400_000;
const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** Splits [from, to] (inclusive dates) into windows of at most `maxDays` calendar days. */
export function splitDateRange(from: string, to: string, maxDays: number): { from: string; to: string }[] {
  const a = dayMs(from);
  const b = dayMs(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error(`Invalid date range ${from}..${to} (expected YYYY-MM-DD)`);
  }
  if (a > b) throw new Error(`Invalid date range ${from}..${to} (from is after to)`);
  const out: { from: string; to: string }[] = [];
  for (let s = a; s <= b; s += maxDays * DAY_MS) out.push({ from: isoDay(s), to: isoDay(Math.min(b, s + (maxDays - 1) * DAY_MS)) });
  return out;
}

/**
 * Candle timestamp → epoch ms. ISO with '+0530' (no colon, which Date.parse rejects) is
 * normalised to '+05:30'; a zone-less timestamp is read as IST; numbers are epoch s or ms.
 */
export function parseKotakTimestamp(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? (v < 1e12 ? v * 1000 : v) : undefined;
  if (typeof v !== 'string' || !v.trim()) return undefined;
  let s = v.trim().replace(' ', 'T');
  if (/^\d+$/.test(s)) return parseKotakTimestamp(Number(s));
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00';
  s = s.replace(/(T[\d:.]+[+-]\d{2})(\d{2})$/, '$1:$2');
  if (!/(Z|[+-]\d{2}:\d{2})$/i.test(s)) s += '+05:30';
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
}

function candleFrom(ts: unknown, o: unknown, h: unknown, l: unknown, c: unknown, v: unknown, oi: unknown): KotakCandle | null {
  const t = parseKotakTimestamp(ts);
  const open = pos(o);
  const high = pos(h);
  const low = pos(l);
  const close = pos(c);
  const volume = nonNeg(v);
  if (t === undefined || open === undefined || high === undefined || low === undefined || close === undefined || volume === undefined) return null;
  const oin = pos(oi);
  return compact<KotakCandle>({ ts: t, open, high, low, close, volume, oi: oin });
}

const pick = (o: Json, keys: string[]): unknown => {
  for (const k of keys) if (k in o) return o[k];
  return undefined;
};
const TS_KEYS = ['timestamp', 'timestamps', 'time', 't', 'ts', 'datetime', 'date'];
const O_KEYS = ['open', 'o'];
const H_KEYS = ['high', 'h'];
const L_KEYS = ['low', 'l'];
const C_KEYS = ['close', 'c'];
const V_KEYS = ['volume', 'vol', 'v'];
const OI_KEYS = ['oi', 'openInterest', 'open_interest'];

/**
 * Documented shape: `{status:'success', data:{candles:[[ts,o,h,l,c,v,oi],…]}}`. Also accepted
 * (defensively): object rows, and the legacy parallel-array shape `{data:{t:[],o:[],…}}`
 * (named in historical_data.md as the previous format; its exact keys are not documented).
 */
export function parseCandles(body: unknown): KotakCandle[] {
  const d = isObj(body) && isObj(body.data) ? body.data : isObj(body) ? body : null;
  if (!d) throw new KotakError('Kotak historical: unexpected response shape', 'protocol');
  const out: KotakCandle[] = [];
  if (Array.isArray(d.candles)) {
    for (const r of d.candles) {
      const c = Array.isArray(r)
        ? candleFrom(r[0], r[1], r[2], r[3], r[4], r[5], r[6])
        : isObj(r)
          ? candleFrom(pick(r, TS_KEYS), pick(r, O_KEYS), pick(r, H_KEYS), pick(r, L_KEYS), pick(r, C_KEYS), pick(r, V_KEYS), pick(r, OI_KEYS))
          : null;
      if (c) out.push(c);
    }
  } else {
    const cols = [TS_KEYS, O_KEYS, H_KEYS, L_KEYS, C_KEYS, V_KEYS].map((ks) => pick(d, ks));
    if (!cols.every(Array.isArray)) throw new KotakError('Kotak historical: unexpected response shape', 'protocol');
    const [ts, o, h, l, c, v] = cols as unknown[][];
    const oi = pick(d, OI_KEYS);
    const n = ts.length;
    if ([o, h, l, c, v].some((a) => a.length !== n)) throw new KotakError('Kotak historical: parallel arrays of different lengths', 'protocol');
    for (let i = 0; i < n; i++) {
      const candle = candleFrom(ts[i], o[i], h[i], l[i], c[i], v[i], Array.isArray(oi) ? oi[i] : undefined);
      if (candle) out.push(candle);
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/* ------------------------------------------------------------------------------------------ */
/* Scrip master file paths                                                                      */
/* ------------------------------------------------------------------------------------------ */

export interface ScripMasterPaths {
  baseFolder?: string;
  files: string[];
}

export function parseScripMasterPaths(body: unknown): ScripMasterPaths {
  const d = isObj(body) && isObj(body.data) ? body.data : isObj(body) ? body : null;
  const files = d && Array.isArray(d.filesPaths) ? d.filesPaths.filter((f): f is string => typeof f === 'string' && /^https?:\/\//i.test(f)) : null;
  if (!d || !files) throw new KotakError('Kotak scrip-master file-paths: unexpected response shape', 'protocol');
  return compact<ScripMasterPaths>({ baseFolder: text(d.baseFolder), files });
}

/* ------------------------------------------------------------------------------------------ */
/* Client                                                                                       */
/* ------------------------------------------------------------------------------------------ */

export class KotakRest {
  constructor(private readonly session: KotakRequester) {}

  /** Quotes of any number of instruments, ≤50 per call (official quotes.md). */
  async quotes(neosymbols: string[], signal?: AbortSignal): Promise<QuotesResult> {
    const unique = [...new Set(neosymbols)];
    unique.forEach(splitNeo);
    const chunks: string[][] = [];
    for (let i = 0; i < unique.length; i += QUOTES_MAX_PER_CALL) chunks.push(unique.slice(i, i + QUOTES_MAX_PER_CALL));
    const settled = await Promise.allSettled(
      chunks.map((c) => this.session.request(quotesPath(c), { kind: 'market', lane: 'general', signal }).then(parseQuotes)),
    );
    const quotes = new Map<string, KotakQuote>();
    const errors: QuotesResult['errors'] = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') for (const q of r.value) quotes.set(q.neosymbol, q);
      else errors.push({ neosymbols: chunks[i], error: r.reason instanceof Error ? r.reason.message : String(r.reason) });
    });
    if (chunks.length && errors.length === chunks.length) {
      const first = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')?.reason;
      throw first instanceof Error ? first : new KotakError(errors[0].error, 'api');
    }
    return { quotes, errors };
  }

  /** Option chain of one expiry (nearest when omitted); `count` strikes, a multiple of 10. */
  async optionChain(p: { exchange: FoExchange; underlying: string; expiry?: string; count?: number }, signal?: AbortSignal): Promise<KotakOptionChain> {
    const count = p.count ?? 40;
    if (!Number.isInteger(count) || count <= 0 || count % 10 !== 0) throw new RangeError(`option-chain count must be a positive multiple of 10 (got ${count})`);
    const body = await this.session.request('market-data/1.0/watchlist/option-chain', {
      kind: 'market',
      lane: 'slow',
      signal,
      query: { exchange: p.exchange, underlying: p.underlying, expiry: p.expiry, instrument_type: 'option', count },
    });
    return parseOptionChain(body);
  }

  /** Futures of an underlying (all expiries when `expiry` is omitted). */
  async futuresChain(p: { exchange: FoExchange; underlying: string; expiry?: string }, signal?: AbortSignal): Promise<KotakFuturesChain> {
    const body = await this.session.request('market-data/1.0/watchlist/option-chain', {
      kind: 'market',
      lane: 'slow',
      signal,
      query: { exchange: p.exchange, underlying: p.underlying, expiry: p.expiry, instrument_type: 'fut' },
    });
    return parseFuturesChain(body);
  }

  async expiries(p: { exchange: FoExchange; underlying: string; instrumentType?: 'option' | 'fut' }, signal?: AbortSignal): Promise<string[]> {
    const body = await this.session.request('market-data/1.0/watchlist/expiries', {
      kind: 'market',
      lane: 'slow',
      signal,
      query: { exchange: p.exchange, underlying: p.underlying, instrument_type: p.instrumentType ?? 'option' },
    });
    return parseExpiries(body);
  }

  /**
   * Candles for an ACTIVE instrument (expired contracts are not served), split into windows the
   * backend accepts and fetched one after another on the slow lane.
   */
  async historical(p: { neosymbol: string; interval: HistInterval; from: string; to: string }, signal?: AbortSignal): Promise<KotakCandle[]> {
    const max = HIST_MAX_DAYS[p.interval];
    if (!max) throw new RangeError(`Unsupported historical interval "${p.interval}"`);
    splitNeo(p.neosymbol);
    const byTs = new Map<number, KotakCandle>();
    for (const w of splitDateRange(p.from, p.to, max)) {
      const body = await this.session.request('market-data/1.0/historical/details', {
        kind: 'market',
        lane: 'slow',
        signal,
        query: { neosymbol: p.neosymbol, interval: p.interval, fromdate: w.from, todate: w.to },
      });
      for (const c of parseCandles(body)) byTs.set(c.ts, c);
    }
    return [...byTs.values()].sort((a, b) => a.ts - b.ts);
  }

  async scripMasterPaths(signal?: AbortSignal): Promise<ScripMasterPaths> {
    const body = await this.session.request('script-details/1.0/masterscrip/file-paths', { kind: 'market', lane: 'general', signal });
    return parseScripMasterPaths(body);
  }
}
