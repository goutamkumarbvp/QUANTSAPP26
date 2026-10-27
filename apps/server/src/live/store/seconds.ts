/**
 * One-second snapshot store: the state of every streamed instrument at the end of each second in which it
 * ticked, for second-level backtests. Only what the live feed sent is stored; a second without a tick has
 * no row (its state is the previous row's), nothing is interpolated.
 *
 * Layout (one directory per IST date):
 *   <dataDir>/seconds/YYYY-MM-DD/<SYMBOL>/SPOT.bin | FUT_<expiry>.bin | CE_<expiry>_<strike>.bin | PE_…
 *   <dataDir>/seconds/YYYY-MM-DD/coverage.json   seconds of the day the recorder ran with the feed connected
 *   <dataDir>/seconds/YYYY-MM-DD/size.json       bytes of the day once it is compacted
 * Each .bin is append-only fixed-size rows (ROW_BYTES, little-endian); a torn last row after a crash is
 * ignored on read and trimmed before the next append. After the day, each file is gzipped to .bin.gz
 * (about a fifth of the size). The store is capped by size (maxBytes) and age (retentionDays): the
 * oldest days are deleted first, never the current one. Writing pauses while the disk has less than
 * minFreeBytes free, and prune() frees the oldest days while the disk has less than keepFreeBytes free.
 *
 * Row: u32 second of the IST day · u32 flags · i32 ltp · i32 bid · i32 ask (paise) · u32 bidQty ·
 *      u32 askQty · f64 cumulative session volume · f64 open interest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import { istTs } from '@q26/core';
import type { InstrumentKey } from '../types';
import { encodeSymbol, decodeSymbol } from './intraday';

export const ROW_BYTES = 44;
const DAY_MS = 86_400_000;
const GB = 1024 ** 3;

const F_LTP = 1;
const F_BID = 2;
const F_ASK = 4;
const F_BIDQ = 8;
const F_ASKQ = 16;
const F_VOL = 32;
const F_OI = 64;
const F_TRADED = 128;

/** One instrument's state at the end of one second (`ts` = the second's start, epoch ms). */
export interface SecondRow {
  ts: number;
  ltp?: number;
  bid?: number;
  ask?: number;
  bidQty?: number;
  askQty?: number;
  /** Cumulative session volume (units). */
  volume?: number;
  oi?: number;
  /** A trade happened in this second (volume rose or a new last-trade time). */
  traded: boolean;
}

export interface SecondStoreOptions {
  dataDir: string;
  /** Directory of the store itself (SECONDS_DIR, e.g. another drive); default <dataDir>/seconds. */
  dir?: string;
  /** Size cap of the whole store (default 75 GB). */
  maxBytes?: number;
  /** Days kept (default 183, about six months). */
  retentionDays?: number;
  /** Writing pauses below this much free disk (default 2 GB) and resumes above 1.5× it. */
  minFreeBytes?: number;
  /** prune() deletes the oldest days while the disk has less than this free (default 5 GB). */
  keepFreeBytes?: number;
  /** Free bytes of the store's disk (tests); default fs.statfsSync. */
  freeBytes?: () => number | null;
  /**
   * Write appended rows in the background (fs.promises, a few files at a time, each file in order) instead of
   * synchronously: thousands of instruments are appended every few seconds, and a synchronous write each
   * holds up the server meanwhile. Reads include rows not written yet; `drain()` waits for the writes.
   */
  writeBehind?: boolean;
  logger?: { warn(msg: string): void; info?(msg: string): void };
}

export interface SecondStoreUsage {
  /** Folder of the store (DATA_DIR/seconds or SECONDS_DIR). */
  dir: string;
  bytes: number;
  maxBytes: number;
  retentionDays: number;
  days: number;
  oldest: string | null;
  newest: string | null;
  /** Free space of the disk holding the store (null when the platform does not report it). */
  freeBytes: number | null;
  /** Why writing is paused (low disk), else null. */
  paused: string | null;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const paise = (v: number | undefined): number | undefined => (isNum(v) && v > 0 && v < 20_000_000 ? Math.round(v * 100) : undefined);
const qty = (v: number | undefined): number | undefined => (isNum(v) && v >= 0 && v <= 0xffffffff ? Math.round(v) : undefined);

/** Encode rows of one IST date (`dayStart` = its 00:00 IST in epoch ms). */
export function encodeRows(rows: readonly SecondRow[], dayStart: number): Buffer {
  const buf = Buffer.alloc(rows.length * ROW_BYTES);
  rows.forEach((r, i) => {
    const o = i * ROW_BYTES;
    const ltp = paise(r.ltp);
    const bid = paise(r.bid);
    const ask = paise(r.ask);
    const bq = qty(r.bidQty);
    const aq = qty(r.askQty);
    const vol = isNum(r.volume) && r.volume >= 0 ? r.volume : undefined;
    const oi = isNum(r.oi) && r.oi >= 0 ? r.oi : undefined;
    const flags = (ltp !== undefined ? F_LTP : 0) | (bid !== undefined ? F_BID : 0) | (ask !== undefined ? F_ASK : 0) | (bq !== undefined ? F_BIDQ : 0) | (aq !== undefined ? F_ASKQ : 0) | (vol !== undefined ? F_VOL : 0) | (oi !== undefined ? F_OI : 0) | (r.traded ? F_TRADED : 0);
    buf.writeUInt32LE(Math.max(0, Math.round((r.ts - dayStart) / 1000)), o);
    buf.writeUInt32LE(flags, o + 4);
    buf.writeInt32LE(ltp ?? 0, o + 8);
    buf.writeInt32LE(bid ?? 0, o + 12);
    buf.writeInt32LE(ask ?? 0, o + 16);
    buf.writeUInt32LE(bq ?? 0, o + 20);
    buf.writeUInt32LE(aq ?? 0, o + 24);
    buf.writeDoubleLE(vol ?? 0, o + 28);
    buf.writeDoubleLE(oi ?? 0, o + 36);
  });
  return buf;
}

/** Decode whole rows (a torn trailing partial row is ignored). */
export function decodeRows(buf: Buffer, dayStart: number): SecondRow[] {
  const n = Math.floor(buf.length / ROW_BYTES);
  const out: SecondRow[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * ROW_BYTES;
    const flags = buf.readUInt32LE(o + 4);
    const r: SecondRow = { ts: dayStart + buf.readUInt32LE(o) * 1000, traded: (flags & F_TRADED) !== 0 };
    if (flags & F_LTP) r.ltp = buf.readInt32LE(o + 8) / 100;
    if (flags & F_BID) r.bid = buf.readInt32LE(o + 12) / 100;
    if (flags & F_ASK) r.ask = buf.readInt32LE(o + 16) / 100;
    if (flags & F_BIDQ) r.bidQty = buf.readUInt32LE(o + 20);
    if (flags & F_ASKQ) r.askQty = buf.readUInt32LE(o + 24);
    if (flags & F_VOL) r.volume = buf.readDoubleLE(o + 28);
    if (flags & F_OI) r.oi = buf.readDoubleLE(o + 36);
    out[i] = r;
  }
  return out;
}

/** File name of an instrument (inside the day's symbol directory). */
export function secondFileName(key: InstrumentKey): string {
  if (key.kind === 'SPOT') return 'SPOT.bin';
  if (key.kind === 'FUT') return `FUT_${key.expiry}.bin`;
  return `${key.kind}_${key.expiry}_${key.strike}.bin`;
}

const FILE_RE = /^(?:(SPOT)|(FUT)_(\d{4}-\d{2}-\d{2})|(CE|PE)_(\d{4}-\d{2}-\d{2})_(\d+(?:\.\d+)?))\.bin(?:\.gz)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseFile(symbol: string, file: string): InstrumentKey | undefined {
  const m = FILE_RE.exec(file);
  if (!m) return undefined;
  if (m[1]) return { symbol, kind: 'SPOT' };
  if (m[2]) return { symbol, kind: 'FUT', expiry: m[3] };
  return { symbol, kind: m[4] as 'CE' | 'PE', expiry: m[5], strike: Number(m[6]) };
}

/** Merge [start, end] second spans (inclusive), sorted. */
export function mergeSpans(spans: readonly [number, number][]): [number, number][] {
  const s = [...spans].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

const gzip = promisify(zlib.gzip);

export class SecondStore {
  readonly root: string;
  readonly maxBytes: number;
  readonly retentionDays: number;
  private readonly minFree: number;
  private readonly keepFree: number;
  private readonly free: (() => number | null) | undefined;
  private readonly log: NonNullable<SecondStoreOptions['logger']>;
  /** Files appended to by this process (their length is checked once for a torn row). */
  private readonly checked = new Set<string>();
  /** Bytes of each date (computed once, then kept current by appends / compaction / pruning). */
  private readonly sizes = new Map<string, number>();
  private pausedWhy: string | null = null;
  private compacting = false;
  private readonly writeBehind: boolean;

  constructor(opts: SecondStoreOptions) {
    this.root = opts.dir ? path.resolve(opts.dir) : path.join(opts.dataDir, 'seconds');
    this.maxBytes = opts.maxBytes ?? 75 * GB;
    this.retentionDays = opts.retentionDays ?? 183;
    this.minFree = opts.minFreeBytes ?? 2 * GB;
    this.keepFree = opts.keepFreeBytes ?? 5 * GB;
    this.free = opts.freeBytes;
    this.log = opts.logger ?? { warn: () => {} };
    this.writeBehind = opts.writeBehind === true;
  }

  private dayDir(date: string): string {
    return path.join(this.root, date);
  }

  private file(key: InstrumentKey, date: string): string {
    return path.join(this.dayDir(date), encodeSymbol(key.symbol), secondFileName(key));
  }

  /** 00:00 IST of a date, epoch ms. */
  static dayStart(date: string): number {
    return istTs(date, 0);
  }

  /* ---------------------------------------- writing ---------------------------------------- */

  /** Append rows of one instrument and date (rows must belong to `date`). False while writing is paused. */
  append(date: string, key: InstrumentKey, rows: readonly SecondRow[]): boolean {
    if (!rows.length) return true;
    if (this.pausedWhy) return false;
    const p = this.file(key, date);
    if (!this.writeBehind && !this.checked.has(p)) {
      this.checked.add(p);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      // A row torn by a crash would shift every later row: cut the file back to whole rows first.
      try {
        const size = fs.statSync(p).size;
        if (size % ROW_BYTES) fs.truncateSync(p, size - (size % ROW_BYTES));
      } catch {
        /* new file */
      }
    }
    const buf = encodeRows(rows, SecondStore.dayStart(date));
    const before = this.sizeOf(date) ?? 0;
    if (this.writeBehind) this.queueWrite(p, buf);
    else fs.appendFileSync(p, buf);
    this.sizes.set(date, before + buf.length);
    return true;
  }

  /* ------------------------------------- write-behind ------------------------------------- */

  /** Rows not written yet, per file (oldest first). */
  private readonly pending = new Map<string, Buffer[]>();
  /** The buffer being written, per file (at most one write per file at a time, so a file stays in order). */
  private readonly writing = new Map<string, Buffer>();
  private readonly writeQueue: string[] = [];
  private idleWaiters: Array<() => void> = [];
  private static readonly WRITERS = 8;

  private queueWrite(p: string, buf: Buffer): void {
    const list = this.pending.get(p);
    if (list) list.push(buf);
    else {
      this.pending.set(p, [buf]);
      if (!this.writing.has(p)) this.writeQueue.push(p);
    }
    this.pump();
  }

  private pump(): void {
    while (this.writing.size < SecondStore.WRITERS && this.writeQueue.length) {
      const p = this.writeQueue.shift() as string;
      const bufs = this.pending.get(p);
      if (!bufs || this.writing.has(p)) continue;
      this.pending.delete(p);
      const buf = bufs.length === 1 ? bufs[0] : Buffer.concat(bufs);
      this.writing.set(p, buf);
      this.prepare(p)
        .then(() => fs.promises.appendFile(p, buf))
        .catch((e: unknown) => this.log.warn(`seconds: write of ${p} failed: ${(e as Error).message}`))
        .finally(() => {
          this.writing.delete(p);
          if (this.pending.has(p)) this.writeQueue.push(p);
          this.pump();
          if (!this.writing.size && !this.pending.size) {
            const w = this.idleWaiters;
            this.idleWaiters = [];
            for (const f of w) f();
          }
        });
    }
  }

  /** First write of a file (write-behind): its folder exists, and a row torn by a crash is cut back first. */
  private async prepare(p: string): Promise<void> {
    if (this.checked.has(p)) return;
    this.checked.add(p);
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    try {
      const size = (await fs.promises.stat(p)).size;
      if (size % ROW_BYTES) await fs.promises.truncate(p, size - (size % ROW_BYTES));
    } catch {
      /* new file */
    }
  }

  /** Resolves once every appended row is on disk (write-behind; at once otherwise). */
  drain(): Promise<void> {
    if (!this.writing.size && !this.pending.size) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Replace the day's recorded-coverage spans (seconds of the IST day, inclusive). */
  setCoverage(date: string, spans: readonly [number, number][]): void {
    if (this.pausedWhy) return;
    const dir = this.dayDir(date);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `coverage.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(mergeSpans(spans)));
    fs.renameSync(tmp, path.join(dir, 'coverage.json'));
  }

  /* ---------------------------------------- reading ---------------------------------------- */

  /** Dates with stored seconds, ascending. */
  dates(): string[] {
    try {
      return fs.readdirSync(this.root).filter((d) => DATE_RE.test(d)).sort();
    } catch {
      return [];
    }
  }

  /** Instruments stored for a date. */
  keys(date: string): InstrumentKey[] {
    const out: InstrumentKey[] = [];
    const seen = new Set<string>();
    let syms: string[];
    try {
      syms = fs.readdirSync(this.dayDir(date), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
    for (const enc of syms) {
      const symbol = decodeSymbol(enc);
      for (const f of fs.readdirSync(path.join(this.dayDir(date), enc))) {
        const k = parseFile(symbol, f);
        const id = `${symbol}|${f.replace(/\.gz$/, '')}`;
        if (k && !seen.has(id)) {
          seen.add(id);
          out.push(k);
        }
      }
    }
    return out;
  }

  has(key: InstrumentKey, date: string): boolean {
    const p = this.file(key, date);
    return fs.existsSync(p) || fs.existsSync(`${p}.gz`);
  }

  /** Rows of one instrument and date, ascending by time ([] when none). */
  read(key: InstrumentKey, date: string): SecondRow[] {
    const p = this.file(key, date);
    const parts: Buffer[] = [];
    try {
      parts.push(zlib.gunzipSync(fs.readFileSync(`${p}.gz`)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn(`seconds: ${p}.gz unreadable: ${(e as Error).message}`);
    }
    try {
      parts.push(fs.readFileSync(p));
    } catch {
      /* compacted or never written */
    }
    // Rows still being written (write-behind): a row both on disk and here is the same second, deduplicated below.
    const inFlight = this.writing.get(p);
    if (inFlight) parts.push(inFlight);
    for (const b of this.pending.get(p) ?? []) parts.push(b);
    if (!parts.length) return [];
    const rows = parts.flatMap((b) => decodeRows(b, SecondStore.dayStart(date)));
    // Appends are in time order; a restart can repeat a second: keep the later row of a second.
    rows.sort((a, b) => a.ts - b.ts);
    const out: SecondRow[] = [];
    for (const r of rows) {
      if (out.length && out[out.length - 1].ts === r.ts) out[out.length - 1] = r;
      else out.push(r);
    }
    return out;
  }

  /** Seconds of the IST day (inclusive spans) the recorder ran with the feed connected. */
  coverage(date: string): [number, number][] {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(this.dayDir(date), 'coverage.json'), 'utf8')) as unknown;
      return Array.isArray(v) ? (v.filter((x) => Array.isArray(x) && x.length === 2 && isNum(x[0]) && isNum(x[1])) as [number, number][]) : [];
    } catch {
      return [];
    }
  }

  /* -------------------------------------- maintenance -------------------------------------- */

  private dirBytes(dir: string): number {
    let n = 0;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return 0;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) n += this.dirBytes(p);
      else
        try {
          n += fs.statSync(p).size;
        } catch {
          /* removed meanwhile */
        }
    }
    return n;
  }

  /** Bytes of a date: size.json of a compacted day, else counted once and kept current. */
  private sizeOf(date: string): number | undefined {
    const hit = this.sizes.get(date);
    if (hit !== undefined) return hit;
    let n: number | undefined;
    try {
      const v = JSON.parse(fs.readFileSync(path.join(this.dayDir(date), 'size.json'), 'utf8')) as { bytes?: unknown };
      if (isNum(v.bytes)) n = v.bytes;
    } catch {
      /* not compacted yet */
    }
    n ??= this.dirBytes(this.dayDir(date));
    this.sizes.set(date, n);
    return n;
  }

  /**
   * Gzip the files of every date before `today` that still has raw .bin files (one file at a time, off
   * the event loop), then record the day's size. Safe to call repeatedly; one run at a time.
   */
  async compact(today: string): Promise<string[]> {
    if (this.compacting) return [];
    this.compacting = true;
    // Rows of a finished day still being written (just after midnight) go in before it is gzipped.
    await this.drain();
    const done: string[] = [];
    try {
      for (const date of this.dates()) {
        if (date >= today) continue;
        const dir = this.dayDir(date);
        let raw = 0;
        for (const sym of fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
          for (const f of fs.readdirSync(path.join(dir, sym.name)).filter((x) => x.endsWith('.bin'))) {
            const p = path.join(dir, sym.name, f);
            const data = fs.readFileSync(p);
            let out = data.subarray(0, data.length - (data.length % ROW_BYTES));
            // A day compacted in two goes (a restart) keeps the earlier part.
            try {
              out = Buffer.concat([zlib.gunzipSync(fs.readFileSync(`${p}.gz`)), out]);
            } catch {
              /* first compaction of this file */
            }
            const z = await gzip(out, { level: 6 });
            fs.writeFileSync(`${p}.gz.tmp`, z);
            fs.renameSync(`${p}.gz.tmp`, `${p}.gz`);
            fs.unlinkSync(p);
            raw++;
          }
        }
        if (raw || !fs.existsSync(path.join(dir, 'size.json'))) {
          this.sizes.delete(date);
          const bytes = this.dirBytes(dir);
          fs.writeFileSync(path.join(dir, 'size.json'), JSON.stringify({ bytes, compactedAt: new Date().toISOString() }));
          this.sizes.set(date, bytes);
          if (raw) done.push(date);
        }
      }
    } finally {
      this.compacting = false;
    }
    return done;
  }

  /**
   * Delete the oldest dates beyond the age limit, while the store is over its size cap, or while its disk
   * has less than keepFreeBytes free (so the store fits the disk it is on). Never `today`.
   */
  prune(today: string): string[] {
    const removed: string[] = [];
    const cutoff = new Date(Date.parse(`${today}T00:00:00Z`) - this.retentionDays * DAY_MS).toISOString().slice(0, 10);
    const dates = this.dates();
    let total = dates.reduce((a, d) => a + (this.sizeOf(d) ?? 0), 0);
    for (const d of dates) {
      if (d >= today) break;
      const free = this.freeBytes();
      if (d >= cutoff && total <= this.maxBytes && (free === null || free >= this.keepFree)) break;
      total -= this.sizeOf(d) ?? 0;
      fs.rmSync(this.dayDir(d), { recursive: true, force: true });
      this.sizes.delete(d);
      for (const p of [...this.checked]) if (p.startsWith(this.dayDir(d))) this.checked.delete(p);
      removed.push(d);
    }
    if (removed.length) this.log.info?.(`seconds: removed ${removed.length} old day(s) (${removed[0]}…${removed[removed.length - 1]}) to stay within ${(this.maxBytes / GB).toFixed(0)} GB / ${this.retentionDays} days / ${(this.keepFree / GB).toFixed(0)} GB free disk`);
    return removed;
  }

  /** Free disk space of the store (null when unknown). */
  freeBytes(): number | null {
    if (this.free) return this.free();
    try {
      fs.mkdirSync(this.root, { recursive: true });
      const s = (fs as unknown as { statfsSync?: (p: string) => { bavail: number; bsize: number } }).statfsSync?.(this.root);
      return s ? s.bavail * s.bsize : null;
    } catch {
      return null;
    }
  }

  /** Pause writing while the disk is nearly full; resume once there is room again. */
  checkDisk(): void {
    const free = this.freeBytes();
    if (free === null) return;
    if (!this.pausedWhy && free < this.minFree) {
      this.pausedWhy = `Disk almost full (${(free / GB).toFixed(1)} GB free, ${(this.minFree / GB).toFixed(0)} GB needed): 1-second recording paused`;
      this.log.warn(`seconds: ${this.pausedWhy}`);
    } else if (this.pausedWhy && free > this.minFree * 1.5) {
      this.pausedWhy = null;
      this.log.info?.('seconds: disk space available again, 1-second recording resumed');
    }
  }

  usage(): SecondStoreUsage {
    const dates = this.dates();
    return {
      dir: this.root,
      bytes: dates.reduce((a, d) => a + (this.sizeOf(d) ?? 0), 0),
      maxBytes: this.maxBytes,
      retentionDays: this.retentionDays,
      days: dates.length,
      oldest: dates[0] ?? null,
      newest: dates[dates.length - 1] ?? null,
      freeBytes: this.freeBytes(),
      paused: this.pausedWhy,
    };
  }
}
