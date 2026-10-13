/**
 * On-disk intraday store (DESIGN.md §2, §1.3): minute records written by the recorder, read back
 * by every intraday history feature. Only what was recorded exists; nothing is interpolated.
 *
 * Layout (one directory per IST date):
 *   <dataDir>/market/YYYY-MM-DD/bars/<SYMBOL>/SPOT.jsonl
 *                                            FUT_<expiry>.jsonl
 *                                            CE_<expiry>_<strike>.jsonl / PE_…
 *   <dataDir>/market/YYYY-MM-DD/chains/<SYMBOL>/<expiry>.jsonl      (ChainMinute)
 * Each file is append-only JSONL, one minute per line, so a full day of ~3,000 instruments is ~3,000
 * small files: one bar series is one ~40 KB read, one chain is one directory of its strikes.
 * Crash safety: a write is a single append of whole lines; a torn last line is skipped on read and
 * trimmed before the next append (a complete record that only lost its '\n' is kept), so earlier
 * minutes are never lost. Two records of the same minute
 * (a restart inside a minute) are merged on read.
 * Reads hand out copies: callers may mutate what they get without touching the cache.
 */
import fs from 'node:fs';
import path from 'node:path';
import { istParts } from '@q26/core';
import { isIsoDate } from '../calendar';
import { keyId } from '../types';
import type { ChainMinute, ChainRowLive, InstrumentKey, IntradayStore, LiveQuote, MinuteRecord, OptKind, RawChain } from '../types';

const MINUTE_MS = 60_000;

/** What the recorder hands to the store. */
export interface IntradayWriter {
  writeMinutes(items: readonly { key: InstrumentKey; rec: MinuteRecord }[]): void;
  writeChainMinutes(items: readonly { symbol: string; expiry: string; rec: ChainMinute }[]): void;
  /** Delete dates older than the retention window (no-op without retention). */
  prune?(today: string): void;
}

/** Source of the minute in progress (the recorder). */
export interface LiveBarSource {
  liveBar(key: InstrumentKey): MinuteRecord | null;
}

export interface IntradayFilesOptions {
  dataDir: string;
  /**
   * Keep this many sessions (recorded date directories, the date being pruned for included); older
   * dates are deleted by prune(). Unset = keep everything.
   */
  retentionDays?: number;
  /** Parsed files kept in memory (LRU). Default 2,000. */
  cacheFiles?: number;
}

/* ------------------------------------------------------------------------------------------ */
/* File naming                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** Filesystem-safe, reversible symbol encoding: [A-Za-z0-9_-] kept, everything else %XX (so no '.', '/'). */
export function encodeSymbol(symbol: string): string {
  if (!symbol) throw new Error('empty symbol');
  let out = '';
  for (const ch of Buffer.from(symbol, 'utf8')) {
    const c = String.fromCharCode(ch);
    out += /[A-Za-z0-9_-]/.test(c) ? c : `%${ch.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

export function decodeSymbol(name: string): string {
  return decodeURIComponent(name);
}

const OPT_KINDS: readonly OptKind[] = ['CE', 'PE'];

/** File name (inside the symbol directory) of an instrument's minute file. */
export function instrumentFileName(key: InstrumentKey): string {
  if (key.kind === 'SPOT') return 'SPOT.jsonl';
  if (!key.expiry || !isIsoDate(key.expiry)) throw new Error(`invalid expiry for ${keyId(key)}`);
  if (key.kind === 'FUT') return `FUT_${key.expiry}.jsonl`;
  if (!OPT_KINDS.includes(key.kind)) throw new Error(`invalid kind for ${keyId(key)}`);
  if (typeof key.strike !== 'number' || !Number.isFinite(key.strike) || key.strike <= 0) throw new Error(`invalid strike for ${keyId(key)}`);
  return `${key.kind}_${key.expiry}_${key.strike}.jsonl`;
}

const FILE_RE = /^(?:(SPOT)|(FUT)_(\d{4}-\d{2}-\d{2})|(CE|PE)_(\d{4}-\d{2}-\d{2})_(\d+(?:\.\d+)?))\.jsonl$/;

export function parseInstrumentFile(symbol: string, file: string): InstrumentKey | undefined {
  const m = FILE_RE.exec(file);
  if (!m) return undefined;
  if (m[1]) return { symbol, kind: 'SPOT' };
  if (m[2]) return { symbol, kind: 'FUT', expiry: m[3] };
  return { symbol, kind: m[4] as OptKind, expiry: m[5], strike: Number(m[6]) };
}

/* ------------------------------------------------------------------------------------------ */
/* JSONL helpers                                                                                */
/* ------------------------------------------------------------------------------------------ */

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Parse JSONL text, skipping unparseable lines (a torn last line after a crash). */
function parseLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* torn or corrupt line: ignored */
    }
  }
  return out;
}

const OPTIONAL_NUM_FIELDS = ['volume', 'oi', 'bid', 'ask', 'totalBuyQty', 'totalSellQty', 'buyVolume', 'sellVolume', 'unclassified', 'atp'] as const;

/** A valid record (unknown fields dropped). `traded` is required: there is no default for it. */
function toMinuteRecord(v: unknown): MinuteRecord | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (!isNum(o.ts) || !isNum(o.open) || !isNum(o.high) || !isNum(o.low) || !isNum(o.close) || typeof o.traded !== 'boolean') return undefined;
  const rec: MinuteRecord = { ts: o.ts, open: o.open, high: o.high, low: o.low, close: o.close, traded: o.traded };
  for (const f of OPTIONAL_NUM_FIELDS) if (isNum(o[f])) rec[f] = o[f];
  return rec;
}

const numOrNull = (v: unknown): number | null => (isNum(v) ? v : null);

function toChainMinute(v: unknown): ChainMinute | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (!isNum(o.ts) || !isNum(o.spot) || !isNum(o.ceOi) || !isNum(o.peOi) || !isNum(o.atmStrike)) return undefined;
  if (!(o.ceVolume === null || isNum(o.ceVolume)) || !(o.peVolume === null || isNum(o.peVolume))) return undefined;
  return { ts: o.ts, spot: o.spot, ceOi: o.ceOi, peOi: o.peOi, ceVolume: o.ceVolume, peVolume: o.peVolume, pcr: numOrNull(o.pcr), maxPain: numOrNull(o.maxPain), atmStrike: o.atmStrike, atmIv: numOrNull(o.atmIv) };
}

/** Merge two records of the same minute (written before and after a restart). */
function mergeSameMinute(a: MinuteRecord, b: MinuteRecord): MinuteRecord {
  const out: MinuteRecord = { ...a, ...b, open: a.open, high: Math.max(a.high, b.high), low: Math.min(a.low, b.low), close: b.close, traded: a.traded || b.traded };
  for (const f of ['volume', 'buyVolume', 'sellVolume', 'unclassified'] as const) {
    if (a[f] !== undefined || b[f] !== undefined) out[f] = (a[f] ?? 0) + (b[f] ?? 0);
  }
  return out;
}

/** Sort by ts and merge duplicates (records are usually already in order). */
function normaliseBars(list: MinuteRecord[]): MinuteRecord[] {
  const sorted = list.every((r, i) => i === 0 || list[i - 1].ts <= r.ts) ? list : [...list].sort((a, b) => a.ts - b.ts);
  const out: MinuteRecord[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && last.ts === r.ts) out[out.length - 1] = mergeSameMinute(last, r);
    else out.push(r);
  }
  return out;
}

function normaliseChain(list: ChainMinute[]): ChainMinute[] {
  const byTs = new Map<number, ChainMinute>();
  for (const r of list) byTs.set(r.ts, r); // last write of a minute wins
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/** Index of the last record with ts ≤ t, or −1. */
function lastAtOrBefore<T extends { ts: number }>(list: readonly T[], t: number): number {
  let lo = 0;
  let hi = list.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].ts <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/* ------------------------------------------------------------------------------------------ */
/* Store                                                                                        */
/* ------------------------------------------------------------------------------------------ */

export class IntradayFiles implements IntradayStore, IntradayWriter {
  private readonly root: string;
  private readonly cacheMax: number;
  /** path → parsed records (LRU by insertion order). */
  private readonly cache = new Map<string, { ts: number }[]>();
  /** Files this process has already checked/repaired for a torn tail. */
  private readonly repaired = new Set<string>();
  private live: LiveBarSource | null = null;

  constructor(private readonly opts: IntradayFilesOptions) {
    this.root = path.join(opts.dataDir, 'market');
    this.cacheMax = Math.max(16, opts.cacheFiles ?? 2000);
    if (opts.retentionDays !== undefined && !(Number.isInteger(opts.retentionDays) && opts.retentionDays >= 1)) throw new Error('retentionDays must be an integer ≥ 1');
  }

  /** The recorder registers itself here to serve liveBar(). */
  setLiveSource(src: LiveBarSource | null): void {
    this.live = src;
  }

  /* ---------------------------------- paths ---------------------------------- */

  private dateDir(date: string): string {
    if (!isIsoDate(date)) throw new Error(`invalid date '${date}'`);
    return path.join(this.root, date);
  }

  private barPath(key: InstrumentKey, date: string): string {
    return path.join(this.dateDir(date), 'bars', encodeSymbol(key.symbol), instrumentFileName(key));
  }

  private chainPath(symbol: string, expiry: string, date: string): string {
    if (!isIsoDate(expiry)) throw new Error(`invalid expiry '${expiry}'`);
    return path.join(this.dateDir(date), 'chains', encodeSymbol(symbol), `${expiry}.jsonl`);
  }

  /* ---------------------------------- cache ---------------------------------- */

  private cacheGet<T>(p: string): T[] | undefined {
    const v = this.cache.get(p);
    if (v === undefined) return undefined;
    this.cache.delete(p);
    this.cache.set(p, v);
    return v as T[];
  }

  private cacheSet(p: string, v: { ts: number }[]): void {
    this.cache.delete(p);
    this.cache.set(p, v);
    while (this.cache.size > this.cacheMax) {
      const oldest = this.cache.keys().next().value as string;
      this.cache.delete(oldest);
    }
  }

  private loadBars(p: string): MinuteRecord[] {
    const hit = this.cacheGet<MinuteRecord>(p);
    if (hit) return hit;
    let text: string;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const recs = normaliseBars(parseLines(text).map(toMinuteRecord).filter((r): r is MinuteRecord => r !== undefined));
    this.cacheSet(p, recs);
    return recs;
  }

  private loadChain(p: string): ChainMinute[] {
    const hit = this.cacheGet<ChainMinute>(p);
    if (hit) return hit;
    let text: string;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    const recs = normaliseChain(parseLines(text).map(toChainMinute).filter((r): r is ChainMinute => r !== undefined));
    this.cacheSet(p, recs);
    return recs;
  }

  /* ---------------------------------- writes --------------------------------- */

  /**
   * Before the first append of this process to a file, cut a torn last line (no trailing newline)
   * left by a crash, so the new line does not get glued to it.
   */
  private repairTail(p: string): void {
    if (this.repaired.has(p)) return;
    this.repaired.add(p);
    let fd: number;
    try {
      fd = fs.openSync(p, 'r+');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size === 0) return;
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] === 0x0a) return;
      // Scan back for the last newline (lines are short; read in 4 KB chunks).
      let end = size;
      let cut = 0;
      const buf = Buffer.alloc(4096);
      while (end > 0) {
        const start = Math.max(0, end - buf.length);
        const n = fs.readSync(fd, buf, 0, end - start, start);
        const i = buf.subarray(0, n).lastIndexOf(0x0a);
        if (i >= 0) {
          cut = start + i + 1;
          break;
        }
        end = start;
      }
      // A tail that parses is a whole record that only lost its '\n' (records are flat objects, so a
      // cut one never parses): keep it and terminate it; otherwise cut the torn fragment.
      const tail = Buffer.alloc(size - cut);
      fs.readSync(fd, tail, 0, tail.length, cut);
      const [record] = parseLines(tail.toString('utf8'));
      if (toMinuteRecord(record) ?? toChainMinute(record)) fs.writeSync(fd, '\n', size);
      else fs.ftruncateSync(fd, cut);
    } finally {
      fs.closeSync(fd);
    }
  }

  private append(p: string, lines: string[]): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    try {
      this.repairTail(p);
      fs.appendFileSync(p, lines.join(''));
    } catch (e) {
      this.repaired.delete(p); // a failed repair/append may have left a torn tail: re-check next time
      throw e;
    }
  }

  /**
   * Group valid items by file and append each group. One bad item or one failing file must not
   * drop the other instruments of the batch (the recorder flushes every quiet instrument in one
   * call): those are written, and the first error is rethrown at the end.
   */
  private appendGroups<T extends { ts: number }>(
    items: readonly { rec: unknown; label: () => string; file: (date: string) => string }[],
    clean: (v: unknown) => T | undefined,
    normalise: (list: T[]) => T[],
    what: string,
  ): void {
    const errors: string[] = [];
    let firstError: unknown;
    const groups = new Map<string, T[]>();
    for (const item of items) {
      try {
        const rec = clean(item.rec);
        if (!rec) throw new Error(`invalid ${what} for ${item.label()}`);
        const p = item.file(istParts(rec.ts).date);
        let g = groups.get(p);
        if (!g) groups.set(p, (g = []));
        g.push(rec);
      } catch (e) {
        firstError ??= e;
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    for (const [p, recs] of groups) {
      try {
        this.append(p, recs.map((r) => `${JSON.stringify(r)}\n`));
      } catch (e) {
        firstError ??= e;
        errors.push(e instanceof Error ? e.message : String(e));
        continue;
      }
      const cached = this.cacheGet<T>(p);
      if (cached) this.cacheSet(p, normalise([...cached, ...recs]));
    }
    if (errors.length === 1) throw firstError;
    if (errors.length > 1) throw new Error(`${errors.length} ${what} writes failed: ${errors.slice(0, 5).join('; ')}`);
  }

  writeMinutes(items: readonly { key: InstrumentKey; rec: MinuteRecord }[]): void {
    this.appendGroups(
      items.map(({ key, rec }) => ({ rec, label: () => keyId(key), file: (date: string) => this.barPath(key, date) })),
      toMinuteRecord,
      normaliseBars,
      'minute record',
    );
  }

  writeChainMinutes(items: readonly { symbol: string; expiry: string; rec: ChainMinute }[]): void {
    this.appendGroups(
      items.map(({ symbol, expiry, rec }) => ({ rec, label: () => `${symbol} ${expiry}`, file: (date: string) => this.chainPath(symbol, expiry, date) })),
      toChainMinute,
      normaliseChain,
      'chain minute',
    );
  }

  /**
   * Keep exactly `retentionDays` sessions: `today` (recorded or about to be) and the most recent
   * `retentionDays − 1` recorded dates before it. Every other date directory before `today` is
   * deleted (empty ones too); later dates are never touched.
   */
  prune(today: string): void {
    const days = this.opts.retentionDays;
    if (days === undefined) return;
    if (!isIsoDate(today)) throw new Error(`invalid date '${today}'`);
    const before = this.dateDirs().filter((d) => d < today);
    const recorded = before.filter((d) => this.hasRecords(d));
    const keep = new Set(days > 1 ? recorded.slice(-(days - 1)) : []);
    for (const d of before) {
      if (keep.has(d)) continue;
      const dir = path.join(this.root, d);
      fs.rmSync(dir, { recursive: true, force: true });
      const prefix = dir + path.sep;
      for (const p of [...this.cache.keys()]) if (p.startsWith(prefix)) this.cache.delete(p);
      for (const p of [...this.repaired]) if (p.startsWith(prefix)) this.repaired.delete(p);
    }
  }

  /* ---------------------------------- reads ---------------------------------- */

  bars(key: InstrumentKey, date: string): MinuteRecord[] {
    return this.loadBars(this.barPath(key, date)).map((r) => ({ ...r }));
  }

  liveBar(key: InstrumentKey): MinuteRecord | null {
    return this.live?.liveBar(key) ?? null;
  }

  /**
   * Last minute COMPLETED at `ts` (record.ts + 60 s ≤ ts) on the IST date of `ts`. No look-ahead:
   * the minute that is still running at `ts` is not returned.
   */
  at(key: InstrumentKey, ts: number): MinuteRecord | undefined {
    const list = this.loadBars(this.barPath(key, istParts(ts).date));
    const i = lastAtOrBefore(list, ts - MINUTE_MS);
    return i >= 0 ? { ...list[i] } : undefined;
  }

  /**
   * As-of chain at `ts` from recorded minutes (same completion rule as at()): premium = minute
   * close, OI/bid/ask/ATP = values at that minute's close. Day OHLC, cumulative volume and prevOi
   * are not part of a minute record and are left out. Future: the same-expiry future when
   * recorded, else the nearest unexpired recorded future.
   */
  chainAt(symbol: string, expiry: string, ts: number): RawChain | undefined {
    const date = istParts(ts).date;
    const dir = path.join(this.dateDir(date), 'bars', encodeSymbol(symbol));
    const rows = new Map<number, ChainRowLive>();
    const futures: InstrumentKey[] = [];
    for (const file of this.listDir(dir)) {
      const key = parseInstrumentFile(symbol, file);
      if (!key) continue;
      if (key.kind === 'FUT') {
        futures.push(key);
        continue;
      }
      if (key.kind === 'SPOT' || key.expiry !== expiry || key.strike === undefined) continue;
      const q = this.quoteAt(key, ts);
      if (!q) continue;
      let row = rows.get(key.strike);
      if (!row) rows.set(key.strike, (row = { strike: key.strike }));
      if (key.kind === 'CE') row.ce = q;
      else row.pe = q;
    }
    if (!rows.size) return undefined;
    const chain: RawChain = { symbol, expiry, ts, rows: [...rows.values()].sort((a, b) => a.strike - b.strike) };
    const spot = this.quoteAt({ symbol, kind: 'SPOT' }, ts);
    if (spot) chain.spot = spot;
    const same = futures.find((f) => f.expiry === expiry);
    const ordered = [...(same ? [same] : []), ...futures.filter((f) => f !== same && (f.expiry as string) >= date).sort((a, b) => (a.expiry as string).localeCompare(b.expiry as string))];
    for (const f of ordered) {
      const q = this.quoteAt(f, ts);
      if (q) {
        chain.future = q;
        break;
      }
    }
    return chain;
  }

  private quoteAt(key: InstrumentKey, ts: number): LiveQuote | undefined {
    const r = this.at(key, ts);
    if (!r) return undefined;
    const q: LiveQuote = { key, ts: r.ts, ltp: r.close };
    if (r.oi !== undefined) q.oi = r.oi;
    if (r.bid !== undefined) q.bid = r.bid;
    if (r.ask !== undefined) q.ask = r.ask;
    if (r.atp !== undefined) q.atp = r.atp;
    if (r.totalBuyQty !== undefined) q.totalBuyQty = r.totalBuyQty;
    if (r.totalSellQty !== undefined) q.totalSellQty = r.totalSellQty;
    return q;
  }

  chainSeries(symbol: string, expiry: string, date: string): ChainMinute[] {
    return this.loadChain(this.chainPath(symbol, expiry, date)).map((r) => ({ ...r }));
  }

  sessions(): string[] {
    return this.dateDirs().filter((d) => this.hasRecords(d));
  }

  recordedKeys(date: string): InstrumentKey[] {
    const base = path.join(this.dateDir(date), 'bars');
    const out: InstrumentKey[] = [];
    for (const symDir of this.listDir(base)) {
      let symbol: string;
      try {
        symbol = decodeSymbol(symDir);
      } catch {
        continue;
      }
      for (const file of this.listDir(path.join(base, symDir))) {
        const key = parseInstrumentFile(symbol, file);
        if (key) out.push(key);
      }
    }
    return out.sort((a, b) => keyId(a).localeCompare(keyId(b)));
  }

  /* ---------------------------------- fs utils -------------------------------- */

  private listDir(dir: string): string[] {
    try {
      return fs.readdirSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  private dateDirs(): string[] {
    return this.listDir(this.root).filter(isIsoDate).sort();
  }

  /** The date directory holds at least one non-empty bar or chain file. */
  private hasRecords(date: string): boolean {
    return this.hasFiles(path.join(this.root, date, 'bars')) || this.hasFiles(path.join(this.root, date, 'chains'));
  }

  /** True when the directory tree holds at least one non-empty file. */
  private hasFiles(dir: string): boolean {
    for (const sub of this.listDir(dir)) {
      for (const f of this.listDir(path.join(dir, sub))) {
        try {
          if (fs.statSync(path.join(dir, sub, f)).size > 0) return true;
        } catch {
          /* raced with prune */
        }
      }
    }
    return false;
  }
}
