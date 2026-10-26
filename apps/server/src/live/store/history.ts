/**
 * On-disk end-of-day store (DESIGN.md §1.3, §2): official NSE/BSE files parsed by live/nse/* are
 * persisted here per date and read back by every multi-day feature. Nothing is filled in: a date
 * that was not loaded is simply absent.
 *
 * Layout under <dataDir>/eod/:
 *   fo/YYYY-MM-DD/futures.json              { [symbol]: DailyFuture[] }
 *   fo/YYYY-MM-DD/options/<SYMBOL>.json      DailyOption[]
 *   cm/YYYY-MM-DD.json, index/YYYY-MM-DD.json { [symbol]: DailyBar }
 *   fiidii/YYYY-MM-DD.json                   FiiDiiDay
 *   participants/YYYY-MM-DD.json             ParticipantDay
 *   settle/<expiry>.json                     { [symbol]: underlying final settlement price }
 *   derived/atmiv/<SYMBOL>.json              cached dailyAtmIv results (recomputed when inputs change)
 * Every file is replaced atomically (write to .tmp, rename), so a crash leaves the old or the new
 * version, never a torn one. The cache holds parsed copies of what is on disk and reads hand out
 * copies, so neither a writer nor a reader can change cached rows by mutating its objects.
 */
import fs from 'node:fs';
import path from 'node:path';
import { addDays, istTs, sessionHoursOf, type ExchangeCode, type FiiDiiDay, type ParticipantDay } from '@q26/core';
import { isIsoDate } from '../calendar';
import { atmIvOf, impliedForward, timeToExpiry, type PremiumRow } from '../pricing';
import type { DailyBar, DailyFuture, DailyOption, HistoryStore, InstrumentKey } from '../types';
import { encodeSymbol } from './intraday';

export type EodKind = 'fo' | 'cm' | 'index' | 'participants' | 'fiidii';

/** Rows as produced by the bhavcopy parsers (BhavOption/BhavFuture/CmBar carry a symbol). */
export type SymbolRow<T> = T & { symbol: string };

export interface HistoryWriter {
  /** Replace the F&O rows of the symbols present in `rows` for `date` (other symbols of that date are kept). */
  writeFo(date: string, rows: { futures?: readonly SymbolRow<DailyFuture>[]; options?: readonly SymbolRow<DailyOption>[] }): void;
  /** Replace the daily bars of the given symbols for `date` (CM bhavcopy → 'cm', index closes → 'index'). */
  writeDailyBars(kind: 'cm' | 'index', date: string, bars: readonly SymbolRow<DailyBar>[]): void;
  writeFiiDii(day: FiiDiiDay): void;
  writeParticipants(day: ParticipantDay): void;
  /**
   * Underlying final settlement prices of expired contracts (PROVISIONAL per critic U13: read from the
   * expiry-day bhavcopy `SttlmPric` by nse/bhavcopy.ts).
   */
  writeSettlements(items: readonly { symbol: string; expiry: string; price: number }[]): void;
}

export interface HistoryFilesOptions {
  dataDir: string;
  /** Risk-free rate for dailyAtmIv (config input). */
  r: number;
  /** Parsed files kept in memory (LRU). Default 3,000. */
  cacheFiles?: number;
}

export interface DailyAtmIv {
  date: string;
  iv: number;
  expiry: string;
}

type CachedIv = { iv: number; expiry: string } | null;
interface IvCacheFile {
  r: number;
  days: Record<string, CachedIv>;
}

const KINDS: readonly EodKind[] = ['fo', 'cm', 'index', 'participants', 'fiidii'];
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPos = (v: unknown): v is number => isNum(v) && v > 0;

function assertDate(d: string, what: string): void {
  if (!isIsoDate(d)) throw new Error(`${what}: invalid date '${d}'`);
}

function pickDefined<T extends object>(src: T, keys: readonly (keyof T)[]): T {
  const out = {} as T;
  for (const k of keys) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

const BAR_KEYS: readonly (keyof DailyBar)[] = ['date', 'open', 'high', 'low', 'close', 'volume', 'turnover'];
const FUT_KEYS: readonly (keyof DailyFuture)[] = ['date', 'expiry', 'close', 'settle', 'oi', 'oiChange', 'volume', 'lotSize'];
const OPT_KEYS: readonly (keyof DailyOption)[] = ['date', 'expiry', 'strike', 'type', 'close', 'settle', 'oi', 'oiChange', 'volume', 'underlying', 'lotSize'];

/**
 * ATM IV of one date from official closing data (pricing math of pricing.ts):
 *  - nearest expiry with at least one calendar day left after `date`;
 *  - only contracts that traded that day (volume > 0): NSE prints the previous close for untraded
 *    contracts and a theoretical SttlmPric (nse-bse-public-data.md §2), so neither is a premium;
 *  - forward: that expiry's traded future (settle, else close), else put-call parity at the strike nearest
 *    the underlying close, else the underlying close carried at r;
 *  - ATM strike: nearest the underlying close (nearest the forward when there is no close);
 *  - IV: Black-76 (off that forward) average of CE/PE at the ATM strike (pricing.atmIvOf).
 */
export function eodAtmIv(input: { date: string; underlying?: number; options: readonly DailyOption[]; futures: readonly DailyFuture[]; r: number; exchange?: ExchangeCode }): CachedIv {
  const { date, options, futures, r } = input;
  const exchange = input.exchange ?? 'NSE';
  if (!isIsoDate(date)) return null;
  const minExpiry = addDays(date, 1);
  const expiries = [...new Set(options.map((o) => o.expiry))].filter((e) => isIsoDate(e) && e >= minExpiry).sort();
  const expiry = expiries[0];
  if (!expiry) return null;
  const spot = isPos(input.underlying) ? input.underlying : undefined;
  const byStrike = new Map<number, PremiumRow>();
  for (const o of options) {
    if (o.expiry !== expiry || !isPos(o.strike) || !isPos(o.close) || !(o.volume > 0)) continue;
    let row = byStrike.get(o.strike);
    if (!row) byStrike.set(o.strike, (row = { strike: o.strike }));
    if (o.type === 'CE') row.ce = o.close;
    else if (o.type === 'PE') row.pe = o.close;
  }
  const rows = [...byStrike.values()];
  // Same rule for the future: an untraded one carries a previous/theoretical price, not a market forward.
  // MCX options are written on the future they settle into: the nearest one expiring on or after them.
  const futExpiry = exchange === 'MCX' ? [...new Set(futures.map((f) => f.expiry))].filter((e) => e >= expiry).sort()[0] : expiry;
  const fut = futures.find((f) => f.expiry === futExpiry && f.volume > 0);
  const future = fut ? (isPos(fut.settle) ? fut.settle : isPos(fut.close) ? fut.close : undefined) : undefined;
  const T = timeToExpiry(expiry, istTs(date, sessionHoursOf(exchange, date).close), exchange);
  const fwd = impliedForward({ spot, future, rows }, T, r);
  if (!fwd) return null;
  const atm = atmIvOf(rows, fwd.forward, T, r, spot ?? fwd.forward);
  return atm ? { iv: atm.iv, expiry } : null;
}

export class HistoryFiles implements HistoryStore, HistoryWriter {
  private readonly root: string;
  private readonly cacheMax: number;
  private readonly cache = new Map<string, unknown>();
  private readonly dates = new Map<EodKind, string[]>();
  private readonly ivCache = new Map<string, IvCacheFile>();
  readonly r: number;

  constructor(opts: HistoryFilesOptions) {
    if (!Number.isFinite(opts.r)) throw new Error('HistoryFiles: r must be a finite number');
    this.root = path.join(opts.dataDir, 'eod');
    this.r = opts.r;
    this.cacheMax = Math.max(16, opts.cacheFiles ?? 3000);
  }

  /* ---------------------------------- file utils ------------------------------ */

  private readJson<T>(p: string): T | undefined {
    if (this.cache.has(p)) {
      const v = this.cache.get(p);
      this.cache.delete(p);
      this.cache.set(p, v);
      return v as T;
    }
    let v: T | undefined;
    try {
      v = JSON.parse(fs.readFileSync(p, 'utf8')) as T;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e;
      v = undefined; // missing, or unreadable (left by something other than this store)
    }
    if (v !== undefined) this.remember(p, v);
    return v;
  }

  private remember(p: string, v: unknown): void {
    this.cache.delete(p);
    this.cache.set(p, v);
    while (this.cache.size > this.cacheMax) this.cache.delete(this.cache.keys().next().value as string);
  }

  private writeJson(p: string, v: unknown): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    const text = JSON.stringify(v);
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, p);
    // Cache what is on disk, not the caller's object (which it may still change).
    this.remember(p, JSON.parse(text));
  }

  private listDir(dir: string): string[] {
    try {
      return fs.readdirSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  private foDir(date: string): string {
    assertDate(date, 'fo');
    return path.join(this.root, 'fo', date);
  }

  private dayFile(kind: Exclude<EodKind, 'fo'>, date: string): string {
    assertDate(date, kind);
    return path.join(this.root, kind, `${date}.json`);
  }

  private markLoaded(kind: EodKind, date: string): void {
    const list = this.loadedDates(kind);
    if (!list.includes(date)) this.dates.set(kind, [...list, date].sort());
  }

  /* ---------------------------------- writes ---------------------------------- */

  writeFo(date: string, rows: { futures?: readonly SymbolRow<DailyFuture>[]; options?: readonly SymbolRow<DailyOption>[] }): void {
    const dir = this.foDir(date);
    const futBySym = new Map<string, DailyFuture[]>();
    for (const f of rows.futures ?? []) {
      if (f.date !== date) throw new Error(`writeFo: future row dated ${f.date} in file for ${date}`);
      let l = futBySym.get(f.symbol);
      if (!l) futBySym.set(f.symbol, (l = []));
      l.push(pickDefined(f, FUT_KEYS));
    }
    const optBySym = new Map<string, DailyOption[]>();
    for (const o of rows.options ?? []) {
      if (o.date !== date) throw new Error(`writeFo: option row dated ${o.date} in file for ${date}`);
      let l = optBySym.get(o.symbol);
      if (!l) optBySym.set(o.symbol, (l = []));
      l.push(pickDefined(o, OPT_KEYS));
    }
    const symbols = new Set([...futBySym.keys(), ...optBySym.keys()]);
    if (futBySym.size) {
      const p = path.join(dir, 'futures.json');
      const cur = { ...(this.readJson<Record<string, DailyFuture[]>>(p) ?? {}) };
      for (const [sym, list] of futBySym) cur[sym] = list.sort((a, b) => a.expiry.localeCompare(b.expiry));
      this.writeJson(p, cur);
    }
    for (const [sym, list] of optBySym) {
      list.sort((a, b) => a.expiry.localeCompare(b.expiry) || a.strike - b.strike || a.type.localeCompare(b.type));
      this.writeJson(path.join(dir, 'options', `${encodeSymbol(sym)}.json`), list);
    }
    for (const sym of symbols) this.invalidateIv(sym, date);
    // Only a date with rows on disk counts as loaded (loadedDates() after a restart agrees).
    if (symbols.size) this.markLoaded('fo', date);
  }

  writeDailyBars(kind: 'cm' | 'index', date: string, bars: readonly SymbolRow<DailyBar>[]): void {
    const p = this.dayFile(kind, date);
    const cur = { ...(this.readJson<Record<string, DailyBar>>(p) ?? {}) };
    for (const b of bars) {
      if (b.date !== date) throw new Error(`writeDailyBars: bar dated ${b.date} in file for ${date}`);
      if (![b.open, b.high, b.low, b.close].every(isNum)) throw new Error(`writeDailyBars: non-numeric OHLC for ${b.symbol} ${date}`);
      cur[b.symbol] = pickDefined(b, BAR_KEYS);
      this.invalidateIv(b.symbol, date);
    }
    this.writeJson(p, cur);
    this.markLoaded(kind, date);
  }

  writeFiiDii(day: FiiDiiDay): void {
    this.writeJson(this.dayFile('fiidii', day.date), day);
    this.markLoaded('fiidii', day.date);
  }

  writeParticipants(day: ParticipantDay): void {
    this.writeJson(this.dayFile('participants', day.date), day);
    this.markLoaded('participants', day.date);
  }

  writeSettlements(items: readonly { symbol: string; expiry: string; price: number }[]): void {
    const byExpiry = new Map<string, Record<string, number>>();
    for (const s of items) {
      assertDate(s.expiry, 'settlement');
      if (!isPos(s.price)) throw new Error(`writeSettlements: invalid price for ${s.symbol} ${s.expiry}`);
      let m = byExpiry.get(s.expiry);
      if (!m) byExpiry.set(s.expiry, (m = {}));
      m[s.symbol.toUpperCase()] = s.price;
    }
    for (const [expiry, m] of byExpiry) {
      const p = path.join(this.root, 'settle', `${expiry}.json`);
      this.writeJson(p, { ...(this.readJson<Record<string, number>>(p) ?? {}), ...m });
    }
  }

  /**
   * Forget what is cached about one date of one kind (after its files were moved away, e.g. to
   * quarantine): it then reads as not loaded and the EOD jobs fetch it again.
   */
  forgetDate(kind: EodKind, date: string): void {
    if (!KINDS.includes(kind)) throw new Error(`unknown EOD kind '${kind}'`);
    this.dates.delete(kind);
    const target = kind === 'fo' ? this.foDir(date) : this.dayFile(kind, date);
    for (const p of [...this.cache.keys()]) if (p === target || p.startsWith(`${target}${path.sep}`)) this.cache.delete(p);
  }

  /** Root of the EOD files (DATA_DIR/eod). */
  dir(): string {
    return this.root;
  }

  /* ---------------------------------- reads ----------------------------------- */

  loadedDates(kind: EodKind): string[] {
    if (!KINDS.includes(kind)) throw new Error(`unknown EOD kind '${kind}'`);
    let list = this.dates.get(kind);
    if (!list) {
      const base = path.join(this.root, kind);
      list =
        kind === 'fo'
          ? this.listDir(base).filter((d) => isIsoDate(d) && this.listDir(path.join(base, d)).length > 0)
          : this.listDir(base)
              .filter((f) => f.endsWith('.json') && isIsoDate(f.slice(0, -5)))
              .map((f) => f.slice(0, -5));
      list.sort();
      this.dates.set(kind, list);
    }
    return list.slice();
  }

  private datesIn(kind: EodKind, from: string, to: string): string[] {
    assertDate(from, 'from');
    assertDate(to, 'to');
    return this.loadedDates(kind).filter((d) => d >= from && d <= to);
  }

  dailyBars(symbol: string, from: string, to: string): DailyBar[] {
    const out = new Map<string, DailyBar>();
    // Index closes win over a CM row of the same name (they are different products).
    for (const kind of ['cm', 'index'] as const) {
      for (const d of this.datesIn(kind, from, to)) {
        const bar = this.readJson<Record<string, DailyBar>>(this.dayFile(kind, d))?.[symbol];
        if (bar) out.set(d, bar);
      }
    }
    return [...out.values()].sort((a, b) => a.date.localeCompare(b.date)).map((b) => ({ ...b }));
  }

  dailyFutures(symbol: string, from: string, to: string): DailyFuture[] {
    const out: DailyFuture[] = [];
    for (const d of this.datesIn('fo', from, to)) {
      const rows = this.readJson<Record<string, DailyFuture[]>>(path.join(this.foDir(d), 'futures.json'))?.[symbol];
      if (rows) for (const r of rows) out.push({ ...r });
    }
    return out;
  }

  dailyOptions(symbol: string, date: string, expiry?: string): DailyOption[] {
    const rows = this.readJson<DailyOption[]>(path.join(this.foDir(date), 'options', `${encodeSymbol(symbol)}.json`)) ?? [];
    return (expiry ? rows.filter((o) => o.expiry === expiry) : rows).map((o) => ({ ...o }));
  }

  fiiDii(from: string, to: string): FiiDiiDay[] {
    return this.datesIn('fiidii', from, to)
      .map((d) => this.readJson<FiiDiiDay>(this.dayFile('fiidii', d)))
      .filter((v): v is FiiDiiDay => v !== undefined)
      .map((v) => structuredClone(v));
  }

  participantOi(from: string, to: string): ParticipantDay[] {
    return this.datesIn('participants', from, to)
      .map((d) => this.readJson<ParticipantDay>(this.dayFile('participants', d)))
      .filter((v): v is ParticipantDay => v !== undefined)
      .map((v) => structuredClone(v));
  }

  /** FUT → underlying final settlement price; CE/PE → intrinsic value at it (rounded to paise). */
  settlement(key: InstrumentKey): number | undefined {
    if (key.kind === 'SPOT' || !key.expiry || !isIsoDate(key.expiry)) return undefined;
    const s = this.readJson<Record<string, number>>(path.join(this.root, 'settle', `${key.expiry}.json`))?.[key.symbol.toUpperCase()];
    if (!isPos(s)) return undefined;
    if (key.kind === 'FUT') return s;
    if (!isPos(key.strike)) return undefined;
    const intrinsic = key.kind === 'CE' ? s - key.strike : key.strike - s;
    return Math.round(Math.max(0, intrinsic) * 100) / 100;
  }

  /* ---------------------------------- daily ATM IV ------------------------------ */

  private ivPath(symbol: string): string {
    return path.join(this.root, 'derived', 'atmiv', `${encodeSymbol(symbol)}.json`);
  }

  private ivFile(symbol: string): IvCacheFile {
    let f = this.ivCache.get(symbol);
    if (!f) {
      const disk = this.readJson<IvCacheFile>(this.ivPath(symbol));
      // A cache computed with another rate is stale.
      f = disk && disk.r === this.r && disk.days && typeof disk.days === 'object' ? { r: disk.r, days: { ...disk.days } } : { r: this.r, days: {} };
      this.ivCache.set(symbol, f);
    }
    return f;
  }

  private invalidateIv(symbol: string, date: string): void {
    const f = this.ivFile(symbol);
    if (date in f.days) {
      delete f.days[date];
      this.writeJson(this.ivPath(symbol), f);
    }
  }

  /** Underlying close of a date: the CM/index bar, else the bhavcopy `UndrlygPric` when all rows agree. */
  private underlyingClose(symbol: string, date: string, options: readonly DailyOption[]): number | undefined {
    const bar = this.dailyBars(symbol, date, date)[0];
    if (bar && isPos(bar.close)) return bar.close;
    const seen = new Set(options.map((o) => o.underlying).filter(isPos));
    return seen.size === 1 ? [...seen][0] : undefined;
  }

  dailyAtmIv(symbol: string, from: string, to: string): DailyAtmIv[] {
    const f = this.ivFile(symbol);
    let dirty = false;
    const out: DailyAtmIv[] = [];
    for (const date of this.datesIn('fo', from, to)) {
      let v = f.days[date];
      if (v === undefined) {
        const options = this.dailyOptions(symbol, date);
        if (!options.length) continue; // symbol not in that day's file: nothing to cache
        const futures = this.readJson<Record<string, DailyFuture[]>>(path.join(this.foDir(date), 'futures.json'))?.[symbol] ?? [];
        v = eodAtmIv({ date, underlying: this.underlyingClose(symbol, date, options), options, futures, r: this.r });
        f.days[date] = v;
        dirty = true;
      }
      if (v) out.push({ date, iv: v.iv, expiry: v.expiry });
    }
    if (dirty) this.writeJson(this.ivPath(symbol), f);
    return out;
  }
}
