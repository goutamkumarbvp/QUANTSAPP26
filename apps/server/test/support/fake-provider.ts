/**
 * TEST-ONLY. An in-memory MarketDataProvider for service tests (Phase C): everything it serves is
 * set by the test (listings, quotes, recorded minutes, EOD rows, the clock). src/ must never import
 * this file: the application runs on live data only.
 *
 * Pricing is the real LivePricing over the fake quotes, so IV/Greeks are always solved from the
 * premiums the test sets, never set directly. loadSampleBook() fills a small, internally consistent
 * book whose premiums are produced HERE by Black-76 from a stated vol (test data, labelled so).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addDays, istParts, istTs, maxPain, weekday } from '@q26/core';
import { ExchangeCalendar, isIsoDate } from '../../src/live/calendar';
import { LiveClock } from '../../src/live/clock';
import { INTERVAL_MINUTES, officialDailyCandles, recordedMinutes, resampleMinutes } from '../../src/live/provider';
import { BOOK_FIELDS } from '../../src/live/live-market';
import { LivePricing, black76Price, chainAtmIv, liveSessionDates, timeToExpiry } from '../../src/live/pricing';
import { HistoryFiles } from '../../src/live/store/history';
import type { IntradayWriter } from '../../src/live/store/intraday';
import { NoLiveData, keyId } from '../../src/live/types';
import type {
  Candle,
  CandleInterval,
  ChainMinute,
  ChainRowLive,
  FeedHealth,
  InstrumentKey,
  IntradayStore,
  Listing,
  LiveMarket,
  LiveQuote,
  MarketDataProvider,
  MinuteRecord,
  OptKind,
  RawChain,
  ReferenceData,
  Segment,
  TradingCalendar,
  Underlying,
  UserContract,
  WatchLevel,
} from '../../src/live/types';

const MINUTE = 60_000;

function notFound(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 404 });
}

/** A copy that shares nothing with the cache (depth levels included), as the real live market hands out. */
const copyQuote = (q: LiveQuote): LiveQuote => {
  const out: LiveQuote = { ...q, key: { ...q.key } };
  if (q.depth) out.depth = { bids: q.depth.bids.map((l) => ({ ...l })), asks: q.depth.asks.map((l) => ({ ...l })) };
  return out;
};

const canon = (k: InstrumentKey): InstrumentKey => {
  const key: InstrumentKey = { symbol: k.symbol.trim().toUpperCase(), kind: k.kind };
  if (k.expiry !== undefined) key.expiry = k.expiry;
  if (k.strike !== undefined) key.strike = Math.round(k.strike * 100) / 100;
  return key;
};

/* ------------------------------------------------------------------------------------------ */
/* Reference data                                                                               */
/* ------------------------------------------------------------------------------------------ */

export interface FakeUnderlyingInput {
  symbol: string;
  name?: string;
  kind: 'index' | 'stock';
  exchange?: 'NSE' | 'BSE';
  sector?: string;
  lotSize: number;
  strikeStep: number;
}

export class FakeReference implements ReferenceData {
  private loadedFlag = true;
  private readonly unders = new Map<string, Underlying>();
  private readonly byKey = new Map<string, Listing>();
  private readonly tokens = new Map<string, Listing>();
  private readonly opt = new Map<string, Set<string>>();
  private readonly fut = new Map<string, Set<string>>();
  private readonly strikeSets = new Map<string, Set<number>>();
  private tokenSeq = 100_000;

  /** false → every read throws NoLiveData like an instrument master that is not loaded. */
  setLoaded(v: boolean): void {
    this.loadedFlag = v;
  }

  private check(): void {
    if (!this.loadedFlag) throw new NoLiveData('Instrument master not loaded yet');
  }

  private add(l: Listing): Listing {
    this.byKey.set(keyId(canon(l)), l);
    this.tokens.set(`${l.segment}|${l.token}`, l);
    return l;
  }

  setUnderlying(u: FakeUnderlyingInput): Underlying {
    const exchange = u.exchange ?? 'NSE';
    const segment: Segment = exchange === 'NSE' ? 'nse_cm' : 'bse_cm';
    const spot = this.add(
      u.kind === 'index'
        ? { symbol: u.symbol, kind: 'SPOT', exchange, segment, token: u.name ?? u.symbol, tradingSymbol: u.name ?? u.symbol, lotSize: 1 }
        : { symbol: u.symbol, kind: 'SPOT', exchange, segment, token: String(this.tokenSeq++), tradingSymbol: `${u.symbol}-EQ`, lotSize: 1, tickSize: 0.05 },
    );
    const und: Underlying = { symbol: u.symbol, name: u.name ?? u.symbol, kind: u.kind, exchange, sector: u.sector ?? (u.kind === 'index' ? 'Index' : ''), lotSize: u.lotSize, strikeStep: u.strikeStep, spot };
    this.unders.set(u.symbol, und);
    return und;
  }

  /** A spot-only listing (India VIX). */
  setSpotOnly(symbol: string, name: string): Listing {
    return this.add({ symbol, kind: 'SPOT', exchange: 'NSE', segment: 'nse_cm', token: name, tradingSymbol: name, lotSize: 1 });
  }

  addListing(l: Listing): void {
    this.add(l);
    if (l.kind === 'FUT' && l.expiry) this.setOf(this.fut, l.symbol).add(l.expiry);
    if ((l.kind === 'CE' || l.kind === 'PE') && l.expiry && l.strike !== undefined) {
      this.setOf(this.opt, l.symbol).add(l.expiry);
      this.setOf(this.strikeSets, `${l.symbol}|${l.expiry}`).add(l.strike);
    }
  }

  private setOf<T>(m: Map<string, Set<T>>, k: string): Set<T> {
    let s = m.get(k);
    if (!s) m.set(k, (s = new Set()));
    return s;
  }

  private exchangeOf(symbol: string): { exchange: 'NSE' | 'BSE'; segment: Segment } {
    const u = this.unders.get(symbol);
    return u?.exchange === 'BSE' ? { exchange: 'BSE', segment: 'bse_fo' } : { exchange: 'NSE', segment: 'nse_fo' };
  }

  setFutures(symbol: string, expiries: string[]): void {
    const u = this.unders.get(symbol);
    for (const expiry of expiries) {
      this.addListing({ symbol, kind: 'FUT', expiry, ...this.exchangeOf(symbol), token: String(this.tokenSeq++), tradingSymbol: `${symbol}${expiry}FUT`, lotSize: u?.lotSize ?? 1, tickSize: 0.05 });
    }
  }

  /** Lists CE and PE at every strike of an option expiry. */
  setStrikes(symbol: string, expiry: string, strikes: number[]): void {
    const u = this.unders.get(symbol);
    for (const strike of strikes) {
      for (const kind of ['CE', 'PE'] as const) {
        this.addListing({ symbol, kind, expiry, strike, ...this.exchangeOf(symbol), token: String(this.tokenSeq++), tradingSymbol: `${symbol}${expiry}${strike}${kind}`, lotSize: u?.lotSize ?? 1, tickSize: 0.05 });
      }
    }
  }

  async refresh(): Promise<void> {}

  ready(): boolean {
    return this.loadedFlag;
  }

  underlyings(): Underlying[] {
    this.check();
    return [...this.unders.values()];
  }

  underlying(symbol: string): Underlying {
    this.check();
    const u = this.unders.get(symbol.trim().toUpperCase());
    if (!u) throw notFound(`Unknown symbol ${symbol}`);
    return u;
  }

  expiries(symbol: string, kind: 'OPT' | 'FUT'): string[] {
    this.underlying(symbol);
    return [...((kind === 'OPT' ? this.opt : this.fut).get(symbol.toUpperCase()) ?? [])].sort();
  }

  strikes(symbol: string, expiry: string): number[] {
    this.underlying(symbol);
    const s = this.strikeSets.get(`${symbol.toUpperCase()}|${expiry}`);
    if (!s) throw notFound(`${symbol} has no options listed for expiry ${expiry}`);
    return [...s].sort((a, b) => a - b);
  }

  listing(key: InstrumentKey): Listing | undefined {
    this.check();
    return this.byKey.get(keyId(canon(key)));
  }

  byToken(segment: Segment, token: string): Listing | undefined {
    return this.tokens.get(`${segment}|${token}`);
  }

  chain(symbol: string, expiry: string): { strike: number; ce?: Listing; pe?: Listing }[] {
    return this.strikes(symbol, expiry).map((strike) => ({ strike, ce: this.listing({ symbol, kind: 'CE', expiry, strike }), pe: this.listing({ symbol, kind: 'PE', expiry, strike }) }));
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Live market                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export type QuoteInput = Partial<Omit<LiveQuote, 'key'>> & { ltp: number };

/**
 * Quotes as the test sets them, served with the real market's date rule: only quotes dated a live
 * session (today; outside market hours also the last session) are returned, and a quote of a new
 * session date starts afresh (no earlier prevOi/book carried over).
 */
export class FakeLiveMarket implements LiveMarket {
  private readonly map = new Map<string, LiveQuote>();
  private readonly listeners = new Set<(q: LiveQuote) => void>();
  readonly watched: { keys: InstrumentKey[]; level: WatchLevel; ttlMs?: number }[] = [];
  private state: FeedHealth = { loggedIn: true, connected: true, lastTickTs: null, subscribed: 0 };

  constructor(
    private readonly ref: FakeReference,
    private readonly now: () => number,
    private readonly calendar: TradingCalendar = new ExchangeCalendar(),
  ) {}

  private liveDates(): Set<string> {
    return liveSessionDates(this.calendar, this.now());
  }

  /**
   * Set (merge) a quote and fan it out like a tick. `ts` defaults to the fake clock. As the real live
   * market: an update dated before the stored quote's session is ignored, and an older update of the
   * same session only fills fields the quote does not have yet.
   */
  setQuote(key: InstrumentKey, q: QuoteInput): LiveQuote {
    const k = canon(key);
    const ts = q.ts ?? this.now();
    let prev = this.map.get(keyId(k));
    if (prev) {
      const was = this.calendar.session(prev.ts).date;
      const day = this.calendar.session(ts).date;
      if (day < was) return copyQuote(prev); // an older session's update changes nothing
      if (day !== was) prev = undefined;
    }
    let next: LiveQuote;
    if (prev && ts < prev.ts) {
      next = copyQuote(prev);
      const rec = next as unknown as Record<string, unknown>;
      // Never an older book (bid/ask/depth): fill-only, as the real merge.
      for (const [f, v] of Object.entries(q)) if (f !== 'ts' && !(BOOK_FIELDS as readonly string[]).includes(f) && v !== undefined && rec[f] === undefined) rec[f] = v;
    } else next = { ...prev, ...q, key: k, ts } as LiveQuote;
    for (const f of Object.keys(next) as (keyof LiveQuote)[]) if (next[f] === undefined) delete next[f];
    this.map.set(keyId(k), copyQuote(next));
    this.state.lastTickTs = Math.max(this.state.lastTickTs ?? -Infinity, ts);
    for (const fn of this.listeners) fn(copyQuote(next));
    return copyQuote(next);
  }

  clearQuote(key: InstrumentKey): void {
    this.map.delete(keyId(canon(key)));
  }

  setHealth(h: Partial<FeedHealth>): void {
    this.state = { ...this.state, ...h };
  }

  quote(key: InstrumentKey): LiveQuote | undefined {
    const q = this.map.get(keyId(canon(key)));
    return q && this.liveDates().has(this.calendar.session(q.ts).date) ? copyQuote(q) : undefined;
  }

  quotes(keys: InstrumentKey[]): Map<string, LiveQuote> {
    const out = new Map<string, LiveQuote>();
    for (const k of keys) {
      const q = this.quote(k);
      if (q) out.set(keyId(q.key), q);
    }
    return out;
  }

  /** No network: the quotes already set for these keys. As the real one, NoLiveData when none of the keys is listed. */
  async refresh(keys: InstrumentKey[]): Promise<Map<string, LiveQuote>> {
    const listed = keys.filter((k) => {
      try {
        return !!this.ref.listing(k);
      } catch {
        return false; // master not loaded
      }
    });
    if (keys.length && !listed.length) throw new NoLiveData(`Not in the instrument master: ${keys.slice(0, 5).map((k) => keyId(canon(k))).join(', ')}`);
    return this.quotes(listed);
  }

  async chain(symbol: string, expiry: string): Promise<RawChain> {
    const sym = symbol.toUpperCase();
    const rows: ChainRowLive[] = [];
    let ts = -Infinity;
    for (const { strike } of this.ref.chain(sym, expiry)) {
      const ce = this.quote({ symbol: sym, kind: 'CE', expiry, strike });
      const pe = this.quote({ symbol: sym, kind: 'PE', expiry, strike });
      if (!ce && !pe) continue;
      rows.push({ strike, ...(ce ? { ce } : {}), ...(pe ? { pe } : {}) });
      ts = Math.max(ts, ce?.ts ?? -Infinity, pe?.ts ?? -Infinity);
    }
    if (!rows.length) throw new NoLiveData(`No live quotes for the ${sym} ${expiry} option chain`);
    const chain: RawChain = { symbol: sym, expiry, ts, rows };
    const spot = this.quote({ symbol: sym, kind: 'SPOT' });
    if (spot) chain.spot = spot;
    const futKey: InstrumentKey = { symbol: sym, kind: 'FUT', expiry };
    const fut = this.ref.listing(futKey) ? this.quote(futKey) : undefined;
    if (fut) chain.future = fut;
    return chain;
  }

  watch(keys: InstrumentKey[], level: WatchLevel = 'quote', ttlMs?: number): void {
    this.watched.push({ keys: keys.map(canon), level, ttlMs });
  }

  onTick(listener: (q: LiveQuote) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  health(): FeedHealth {
    return { ...this.state };
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Intraday store                                                                               */
/* ------------------------------------------------------------------------------------------ */

/** In-memory IntradayStore (also an IntradayWriter, so the real Recorder can write into it). */
export class MemoryIntraday implements IntradayStore, IntradayWriter {
  private readonly bar = new Map<string, Map<number, MinuteRecord>>();
  private readonly chainRecs = new Map<string, Map<number, ChainMinute>>();
  private readonly liveBars = new Map<string, MinuteRecord>();

  private static dateOf(ts: number): string {
    return istParts(ts).date;
  }

  addMinutes(key: InstrumentKey, recs: readonly MinuteRecord[]): void {
    this.writeMinutes(recs.map((rec) => ({ key, rec })));
  }

  addChainMinutes(symbol: string, expiry: string, recs: readonly ChainMinute[]): void {
    this.writeChainMinutes(recs.map((rec) => ({ symbol, expiry, rec })));
  }

  /** As IntradayFiles: a record needs numeric ts/OHLC and `traded`; two records of one minute are merged. */
  writeMinutes(items: readonly { key: InstrumentKey; rec: MinuteRecord }[]): void {
    for (const { key, rec } of items) {
      const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
      if (![rec.ts, rec.open, rec.high, rec.low, rec.close].every(num) || typeof rec.traded !== 'boolean') throw new Error(`invalid minute record for ${keyId(key)}`);
      const id = `${MemoryIntraday.dateOf(rec.ts)}|${keyId(canon(key))}`;
      let m = this.bar.get(id);
      if (!m) this.bar.set(id, (m = new Map()));
      const a = m.get(rec.ts);
      if (!a) {
        m.set(rec.ts, { ...rec });
        continue;
      }
      const merged: MinuteRecord = { ...a, ...rec, open: a.open, high: Math.max(a.high, rec.high), low: Math.min(a.low, rec.low), close: rec.close, traded: a.traded || rec.traded };
      if (a.partial || rec.partial) merged.partial = true;
      for (const f of ['volume', 'gapVolume', 'buyVolume', 'sellVolume', 'unclassified'] as const) if (a[f] !== undefined || rec[f] !== undefined) merged[f] = (a[f] ?? 0) + (rec[f] ?? 0);
      m.set(rec.ts, merged);
    }
  }

  writeChainMinutes(items: readonly { symbol: string; expiry: string; rec: ChainMinute }[]): void {
    for (const { symbol, expiry, rec } of items) {
      const id = `${MemoryIntraday.dateOf(rec.ts)}|${symbol.toUpperCase()}|${expiry}`;
      let m = this.chainRecs.get(id);
      if (!m) this.chainRecs.set(id, (m = new Map()));
      m.set(rec.ts, { ...rec });
    }
  }

  setLiveBar(key: InstrumentKey, rec: MinuteRecord | null): void {
    if (rec) this.liveBars.set(keyId(canon(key)), { ...rec });
    else this.liveBars.delete(keyId(canon(key)));
  }

  bars(key: InstrumentKey, date: string): MinuteRecord[] {
    return [...(this.bar.get(`${date}|${keyId(canon(key))}`)?.values() ?? [])].sort((a, b) => a.ts - b.ts).map((r) => ({ ...r }));
  }

  liveBar(key: InstrumentKey): MinuteRecord | null {
    const r = this.liveBars.get(keyId(canon(key)));
    return r ? { ...r } : null;
  }

  /** Last minute completed at `ts` on its IST date (no look-ahead). */
  at(key: InstrumentKey, ts: number): MinuteRecord | undefined {
    const list = this.bars(key, MemoryIntraday.dateOf(ts)).filter((r) => r.ts + MINUTE <= ts);
    return list.at(-1);
  }

  chainAt(symbol: string, expiry: string, ts: number): RawChain | undefined {
    const sym = symbol.toUpperCase();
    const date = MemoryIntraday.dateOf(ts);
    const rows = new Map<number, ChainRowLive>();
    const quoteAt = (key: InstrumentKey): LiveQuote | undefined => {
      const r = this.at(key, ts);
      if (!r) return undefined;
      const q: LiveQuote = { key, ts: r.ts, ltp: r.close };
      for (const f of ['oi', 'bid', 'ask', 'bidQty', 'askQty', 'atp', 'totalBuyQty', 'totalSellQty'] as const) if (r[f] !== undefined) q[f] = r[f];
      return q;
    };
    const futures: InstrumentKey[] = [];
    for (const key of this.recordedKeys(date)) {
      if (key.symbol === sym && key.kind === 'FUT') futures.push(key);
      if (key.symbol !== sym || key.expiry !== expiry || key.strike === undefined || (key.kind !== 'CE' && key.kind !== 'PE')) continue;
      const q = quoteAt(key);
      if (!q) continue;
      let row = rows.get(key.strike);
      if (!row) rows.set(key.strike, (row = { strike: key.strike }));
      row[key.kind === 'CE' ? 'ce' : 'pe'] = q;
    }
    if (!rows.size) return undefined;
    const chain: RawChain = { symbol: sym, expiry, ts, rows: [...rows.values()].sort((a, b) => a.strike - b.strike) };
    const spot = quoteAt({ symbol: sym, kind: 'SPOT' });
    if (spot) chain.spot = spot;
    // As IntradayFiles: the same-expiry future, else the nearest unexpired recorded future.
    const same = futures.find((f) => f.expiry === expiry);
    const ordered = [...(same ? [same] : []), ...futures.filter((f) => f !== same && (f.expiry as string) >= date).sort((a, b) => (a.expiry as string).localeCompare(b.expiry as string))];
    for (const f of ordered) {
      const q = quoteAt(f);
      if (q) {
        chain.future = q;
        break;
      }
    }
    return chain;
  }

  chainSeries(symbol: string, expiry: string, date: string): ChainMinute[] {
    return [...(this.chainRecs.get(`${date}|${symbol.toUpperCase()}|${expiry}`)?.values() ?? [])].sort((a, b) => a.ts - b.ts).map((r) => ({ ...r }));
  }

  sessions(): string[] {
    const dates = new Set<string>();
    for (const id of [...this.bar.keys(), ...this.chainRecs.keys()]) dates.add(id.slice(0, 10));
    return [...dates].sort();
  }

  recordedKeys(date: string): InstrumentKey[] {
    const out: InstrumentKey[] = [];
    for (const id of this.bar.keys()) {
      if (!id.startsWith(`${date}|`)) continue;
      const [symbol, kind, expiry, strike] = id.slice(11).split('|');
      const key: InstrumentKey = { symbol, kind: kind as InstrumentKey['kind'] };
      if (expiry) key.expiry = expiry;
      if (strike) key.strike = Number(strike);
      out.push(key);
    }
    return out.sort((a, b) => keyId(a).localeCompare(keyId(b)));
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Provider                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export interface FakeProviderOptions {
  /** Initial clock (epoch ms); default 2026-10-12 11:00 IST. */
  now?: number;
  r?: number;
  holidays?: string[];
  /** Directory for the EOD store (default: a fresh temp dir, removed by dispose()). */
  dataDir?: string;
}

export class FakeProvider implements MarketDataProvider {
  readonly ref = new FakeReference();
  readonly calendar: ExchangeCalendar;
  readonly clock: LiveClock;
  readonly live: FakeLiveMarket;
  readonly intraday = new MemoryIntraday();
  readonly history: HistoryFiles;
  readonly pricing: LivePricing;
  private t: number;
  private readonly dir: string;
  private readonly ownsDir: boolean;

  constructor(opts: FakeProviderOptions = {}) {
    this.t = opts.now ?? Date.parse('2026-10-12T05:30:00Z');
    this.calendar = new ExchangeCalendar(opts.holidays ?? []);
    this.clock = new LiveClock(this.calendar, () => this.t);
    this.live = new FakeLiveMarket(this.ref, () => this.t, this.calendar);
    this.ownsDir = !opts.dataDir;
    this.dir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'q26-fake-provider-'));
    const r = opts.r ?? 0.065;
    this.history = new HistoryFiles({ dataDir: this.dir, r });
    this.pricing = new LivePricing({ r, ref: this.ref, calendar: this.calendar, getQuote: (k) => this.live.quote(k), now: () => this.t });
  }

  now(): number {
    return this.t;
  }

  setNow(ts: number): void {
    this.t = ts;
  }

  advance(ms: number): void {
    this.t += ms;
  }

  setQuote(key: InstrumentKey, q: QuoteInput): LiveQuote {
    return this.live.setQuote(key, q);
  }

  /** Same rules as LiveProvider.candles, without Kotak historical (dates not recorded → NoLiveData). */
  async candles(key: InstrumentKey, interval: CandleInterval, from: string, to: string): Promise<Candle[]> {
    const badRequest = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
    if (!isIsoDate(from) || !isIsoDate(to) || from > to) throw badRequest(`Invalid date range ${from}..${to}`);
    const k = canon(key);
    if (k.kind !== 'SPOT' && !k.expiry) throw badRequest(`${k.symbol} ${k.kind} needs an expiry`);
    if (interval === 'D') return officialDailyCandles(this.history, this.calendar, k, from, to);
    if (!INTERVAL_MINUTES[interval]) throw badRequest(`Unsupported interval ${String(interval)}`);
    const dates = this.calendar.sessions(from, to);
    const { minutes } = recordedMinutes(this.intraday, k, dates, this.calendar.session(this.t).date);
    if (!minutes.length) throw new NoLiveData(`No ${interval} candles of ${keyId(k)} for ${from}..${to}: not recorded`);
    return resampleMinutes(minutes, INTERVAL_MINUTES[interval], this.calendar);
  }

  private userFn: (() => Iterable<UserContract>) | null = null;

  setUserContracts(fn: (() => Iterable<UserContract>) | null): void {
    this.userFn = fn;
  }

  /** What the last setUserContracts callback returns now (tests assert what a service declared). */
  userContracts(): UserContract[] {
    return this.userFn ? [...this.userFn()] : [];
  }

  /** Stand-in for LiveProvider.healthReport() (/api/health): JSON-safe, no credentials. */
  healthReport(): { feed: FeedHealth; refdata: { ready: boolean }; recorder: { firstRecordedSession: string | null; sessions: number }; clock: ReturnType<LiveClock['info']> } {
    const sessions = this.intraday.sessions();
    return { feed: this.live.health(), refdata: { ready: this.ref.ready() }, recorder: { firstRecordedSession: sessions[0] ?? null, sessions: sessions.length }, clock: this.clock.info() };
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  /** Remove the temp EOD directory. */
  dispose(): void {
    if (this.ownsDir) fs.rmSync(this.dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Sample book (TEST DATA)                                                                      */
/* ------------------------------------------------------------------------------------------ */

export interface SampleBookOptions {
  /** Trading date of the book, default 2026-10-12. */
  date?: string;
  /** IST time of the live quotes, default '11:00'. */
  time?: string;
  /** Flat vol per underlying the premiums are priced at (decimal). */
  vols?: Partial<Record<'NIFTY' | 'BANKNIFTY' | 'RELIANCE', number>>;
  /** Test carry yield of the futures over spot (decimal), default 0.01. */
  carry?: number;
}

export interface SampleBook {
  date: string;
  now: number;
  /** The previous trading day: one full recorded session of minute bars. */
  recordedDate: string;
  spots: Record<'NIFTY' | 'BANKNIFTY' | 'RELIANCE' | 'INDIAVIX', number>;
  vols: Record<'NIFTY' | 'BANKNIFTY' | 'RELIANCE', number>;
  expiries: { NIFTY: [weekly: string, monthly: string]; BANKNIFTY: [string, string]; RELIANCE: [string] };
  futures: Record<string, number>;
}

/** Last Tuesday of the month of `date`. */
function lastTuesday(date: string): string {
  let d = `${date.slice(0, 7)}-28`;
  while (addDays(d, 1).slice(5, 7) === date.slice(5, 7)) d = addDays(d, 1);
  while (weekday(d) !== 2) d = addDays(d, -1);
  return d;
}

/** First Tuesday strictly after `date`. */
function nextTuesday(date: string): string {
  let d = addDays(date, 1);
  while (weekday(d) !== 2) d = addDays(d, 1);
  return d;
}

const tick = (p: number): number => Math.round(p / 0.05) * 0.05;
const r2 = (p: number): number => Math.round(p * 100) / 100;

/**
 * Fills `p` with a small but realistic book. TEST DATA: every price below is produced by this test
 * helper (Black-76 at the stated vols, futures at spot·e^{(r−carry)T}, rounded to the ₹0.05 tick);
 * OI/volume are fixed test numbers. Nothing here is market data.
 */
export function loadSampleBook(p: FakeProvider, opts: SampleBookOptions = {}): SampleBook {
  const date = opts.date ?? '2026-10-12';
  const now = istTs(date, Number((opts.time ?? '11:00').slice(0, 2)) * 60 + Number((opts.time ?? '11:00').slice(3, 5)));
  p.setNow(now);
  const r = p.pricing.r;
  const carry = opts.carry ?? 0.01;
  const vols = { NIFTY: 0.14, BANKNIFTY: 0.16, RELIANCE: 0.22, ...opts.vols };
  const spots = { NIFTY: 25000, BANKNIFTY: 56000, RELIANCE: 1400, INDIAVIX: 12.5 };
  const w1 = nextTuesday(date);
  let m1 = lastTuesday(date);
  if (m1 <= w1) m1 = lastTuesday(addDays(`${date.slice(0, 7)}-01`, 32));
  const m2 = lastTuesday(addDays(`${m1.slice(0, 7)}-01`, 32));
  const expiries: SampleBook['expiries'] = { NIFTY: [w1, m1], BANKNIFTY: [m1, m2], RELIANCE: [m1] };

  const ref = p.ref;
  ref.setUnderlying({ symbol: 'NIFTY', name: 'Nifty 50', kind: 'index', lotSize: 75, strikeStep: 50 });
  ref.setUnderlying({ symbol: 'BANKNIFTY', name: 'Nifty Bank', kind: 'index', lotSize: 35, strikeStep: 100 });
  ref.setUnderlying({ symbol: 'RELIANCE', name: 'Reliance Industries', kind: 'stock', sector: 'Energy', lotSize: 500, strikeStep: 20 });
  ref.setSpotOnly('INDIAVIX', 'INDIA VIX');
  ref.setFutures('NIFTY', [m1]);
  ref.setFutures('BANKNIFTY', [m1, m2]);
  ref.setFutures('RELIANCE', [m1]);

  const futures: Record<string, number> = {};
  const fwd = (symbol: keyof typeof vols, expiry: string, at: number, spot: number) => spot * Math.exp((r - carry) * timeToExpiry(expiry, at));
  const quoteChain = (symbol: keyof typeof vols, expiry: string, step: number, at: number, spot: number, set: (key: InstrumentKey, q: QuoteInput) => void) => {
    const atm = Math.round(spot / step) * step;
    const strikes = Array.from({ length: 21 }, (_, i) => atm + (i - 10) * step);
    const T = timeToExpiry(expiry, at);
    const F = futures[`${symbol}|${expiry}`] ?? fwd(symbol, expiry, at, spot);
    for (const strike of strikes) {
      for (const type of ['CE', 'PE'] as OptKind[]) {
        const price = tick(black76Price(type, F, strike, T, r, vols[symbol]));
        if (!(price >= 0.05)) continue; // worth less than a tick: no quote at all
        const away = Math.abs(strike - atm) / step;
        set({ symbol, kind: type, expiry, strike }, { ltp: r2(price), bid: r2(price - 0.05 > 0 ? price - 0.05 : price), ask: r2(price + 0.05), oi: Math.round((100 - 4 * away) * 1000 * (type === 'PE' ? 1.1 : 1)), volume: (50 - 2 * away) * 1000, ts: at });
      }
    }
    return strikes;
  };

  // Live quotes at `now`.
  p.setQuote({ symbol: 'NIFTY', kind: 'SPOT' }, { ltp: spots.NIFTY, prevClose: 24900, open: 24950, high: 25050, low: 24920 });
  p.setQuote({ symbol: 'BANKNIFTY', kind: 'SPOT' }, { ltp: spots.BANKNIFTY, prevClose: 55800, open: 55900, high: 56100, low: 55850 });
  p.setQuote({ symbol: 'RELIANCE', kind: 'SPOT' }, { ltp: spots.RELIANCE, prevClose: 1390, open: 1392, high: 1405, low: 1388, bid: 1399.95, ask: 1400.05, volume: 3_200_000 });
  p.setQuote({ symbol: 'INDIAVIX', kind: 'SPOT' }, { ltp: spots.INDIAVIX, prevClose: 12.8 });
  for (const [symbol, list] of [['NIFTY', [m1]], ['BANKNIFTY', [m1, m2]], ['RELIANCE', [m1]]] as const) {
    for (const expiry of list) {
      const price = r2(tick(fwd(symbol, expiry, now, spots[symbol])));
      futures[`${symbol}|${expiry}`] = price;
      p.setQuote({ symbol, kind: 'FUT', expiry }, { ltp: price, bid: r2(price - 0.05), ask: r2(price + 0.05), oi: 1_200_000, volume: 300_000 });
    }
  }
  const set = (key: InstrumentKey, q: QuoteInput) => p.setQuote(key, q);
  for (const [symbol, step, list] of [['NIFTY', 50, [w1, m1]], ['BANKNIFTY', 100, [m1, m2]], ['RELIANCE', 20, [m1]]] as const) {
    for (const expiry of list) ref.setStrikes(symbol, expiry, quoteChain(symbol, expiry, step, now, spots[symbol], set));
  }

  // One recorded session (the previous trading day): NIFTY spot, near future and the W1 chain,
  // on a deterministic test path (no randomness), plus the chain aggregates.
  const recordedDate = p.calendar.prev(date);
  const path = (m: number) => spots.NIFTY * (1 + 0.002 * Math.sin(m / 30) - 0.001);
  const strikes = ref.strikes('NIFTY', w1);
  for (let m = 0; m < 375; m++) {
    const ts = p.calendar.ts(recordedDate, m);
    const s0 = path(m);
    const s1 = path(m + 1);
    const bar = (o: number, c: number, extra: Partial<MinuteRecord> = {}): MinuteRecord => ({ ts, open: r2(o), high: r2(Math.max(o, c)), low: r2(Math.min(o, c)), close: r2(c), traded: true, ...extra });
    p.intraday.addMinutes({ symbol: 'NIFTY', kind: 'SPOT' }, [bar(s0, s1)]);
    const f0 = tick(fwd('NIFTY', m1, ts, s0));
    const f1 = tick(fwd('NIFTY', m1, ts + MINUTE, s1));
    p.intraday.addMinutes({ symbol: 'NIFTY', kind: 'FUT', expiry: m1 }, [bar(f0, f1, { volume: 3000, oi: 1_190_000 })]);
    const rows: { strike: number; ceOI: number; peOI: number }[] = [];
    const chainRows: ChainRowLive[] = [];
    const T = timeToExpiry(w1, ts + MINUTE);
    const F = fwd('NIFTY', w1, ts + MINUTE, s1);
    for (const strike of strikes) {
      const atmDist = Math.abs(strike - Math.round(spots.NIFTY / 50) * 50) / 50;
      const oi = { CE: (100 - 4 * atmDist) * 1000, PE: (100 - 4 * atmDist) * 1100 };
      const row: ChainRowLive = { strike };
      for (const type of ['CE', 'PE'] as OptKind[]) {
        const c = tick(black76Price(type, F, strike, T, r, vols.NIFTY));
        if (!(c >= 0.05)) continue;
        p.intraday.addMinutes({ symbol: 'NIFTY', kind: type, expiry: w1, strike }, [bar(c, c, { volume: 750, oi: oi[type] })]);
        row[type === 'CE' ? 'ce' : 'pe'] = { key: { symbol: 'NIFTY', kind: type, expiry: w1, strike }, ts, ltp: r2(c) };
      }
      rows.push({ strike, ceOI: oi.CE, peOI: oi.PE });
      chainRows.push(row);
    }
    const ceOi = rows.reduce((a, x) => a + x.ceOI, 0);
    const peOi = rows.reduce((a, x) => a + x.peOI, 0);
    let atmStrike = strikes[0];
    for (const k of strikes) if (Math.abs(k - s1) < Math.abs(atmStrike - s1)) atmStrike = k;
    const iv = chainAtmIv({ symbol: 'NIFTY', expiry: w1, ts: ts + MINUTE, spot: { key: { symbol: 'NIFTY', kind: 'SPOT' }, ts, ltp: r2(s1) }, rows: chainRows }, r, ts + MINUTE);
    p.intraday.addChainMinutes('NIFTY', w1, [
      { ts, spot: r2(s1), ceOi, peOi, ceVolume: 750 * (m + 1) * strikes.length, peVolume: 750 * (m + 1) * strikes.length, pcr: peOi / ceOi, maxPain: maxPain(rows).maxPain, atmStrike, atmIv: iv ? iv.iv : null },
    ]);
  }

  // EOD daily bars of the five sessions before `date` (index closes and the stock's cash bars).
  let d = date;
  for (let i = 0; i < 5; i++) {
    d = p.calendar.prev(d);
    const k = 1 + 0.003 * (i - 2);
    p.history.writeDailyBars('index', d, [{ symbol: 'NIFTY', date: d, open: r2(24900 * k), high: r2(25050 * k), low: r2(24850 * k), close: r2(24950 * k) }]);
    p.history.writeDailyBars('cm', d, [{ symbol: 'RELIANCE', date: d, open: r2(1385 * k), high: r2(1402 * k), low: r2(1380 * k), close: r2(1395 * k), volume: 4_000_000 }]);
  }

  return { date, now, recordedDate, spots, vols, expiries, futures };
}
