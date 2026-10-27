/**
 * One-second recorder: turns live ticks into one row per instrument and second (SecondStore), for
 * second-level backtests. Records only what the feed sent:
 *  - the row of a second is the instrument's state at the end of that second (last LTP, best bid/ask
 *    with their quantities, cumulative session volume, OI); a second without a tick has no row;
 *  - `traded` = the cumulative volume rose, or a newer last-trade time arrived, within the second;
 *  - a second is closed when a tick of a later second arrives, or by the 1-second timer once the clock
 *    is past it (with a one-second grace for late packets); a late tick of a closed second is folded
 *    into the instrument's open second, never rewriting a written one;
 *  - ticks outside the exchange session (pre-open, after the close, other days) and ticks dated more
 *    than maxLagMs away from the clock (re-sent snapshots, clock skew) are ignored;
 *  - coverage: each second the recorder ran with the feed connected during a session is noted, so a
 *    backtest can tell "no tick" (unchanged) from "not recorded" (gap).
 * Rows are buffered and appended every flushMs (one write per instrument), so a crash loses at most
 * that much.
 */
import { istParts } from '@q26/core';
import type { SecondRow, SecondStore } from './store/seconds';
import { keyId } from './types';
import type { InstrumentKey, LiveMarket, LiveQuote, SessionClock, TradingCalendar } from './types';

export interface SecondRecorderOptions {
  live: Pick<LiveMarket, 'onTick' | 'health'>;
  store: Pick<SecondStore, 'append' | 'setCoverage' | 'coverage'>;
  clock: SessionClock;
  /** Calendar of a symbol's exchange (sessions differ: NSE/BSE vs MCX). */
  calendarOf: (symbol: string) => TradingCalendar;
  /** Calendars whose open session marks a second as covered (NSE and MCX). */
  calendars: readonly TradingCalendar[];
  timers: { setInterval(fn: () => void, ms: number): unknown; clearInterval(h: unknown): void };
  /** Buffered rows are written this often (default 5 s). */
  flushMs?: number;
  /** Ticks further than this from the clock are ignored (default 60 s). */
  maxLagMs?: number;
  onError?: (e: unknown) => void;
}

export interface SecondRecorderStats {
  instruments: number;
  rowsWritten: number;
  rowsBuffered: number;
  ignored: { outsideSession: number; stale: number; noPrice: number };
  /** Rows dropped because the store paused writing (disk almost full). */
  dropped: number;
}

interface Inst {
  key: InstrumentKey;
  date: string;
  /** Epoch second being collected, null when none is open. */
  sec: number | null;
  ltp?: number;
  bid?: number;
  ask?: number;
  bidQty?: number;
  askQty?: number;
  volume?: number;
  oi?: number;
  ltt?: number;
  traded: boolean;
  rows: SecondRow[];
}

const isPos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export class SecondRecorder {
  private readonly insts = new Map<string, Inst>();
  private readonly cover = new Map<string, [number, number][]>();
  private coverDirty = new Set<string>();
  private handles: unknown[] = [];
  private off: (() => void) | null = null;
  private lastFlush = 0;
  private readonly st: SecondRecorderStats = { instruments: 0, rowsWritten: 0, rowsBuffered: 0, ignored: { outsideSession: 0, stale: 0, noPrice: 0 }, dropped: 0 };

  constructor(private readonly o: SecondRecorderOptions) {}

  start(): void {
    if (this.off) return;
    this.off = this.o.live.onTick((q) => {
      try {
        this.onTick(q);
      } catch (e) {
        this.o.onError?.(e);
      }
    });
    this.lastFlush = this.o.clock.now();
    this.handles.push(this.o.timers.setInterval(() => this.tick(), 1000));
  }

  /** Close every open second and write everything buffered. */
  stop(): void {
    this.off?.();
    this.off = null;
    for (const h of this.handles) this.o.timers.clearInterval(h);
    this.handles = [];
    for (const i of this.insts.values()) this.close(i);
    this.flush();
  }

  stats(): SecondRecorderStats {
    return { ...this.st, instruments: this.insts.size, ignored: { ...this.st.ignored } };
  }

  onTick(q: LiveQuote): void {
    if (!isNum(q.ts)) return;
    const now = this.o.clock.now();
    if (Math.abs(q.ts - now) > (this.o.maxLagMs ?? 60_000)) {
      this.st.ignored.stale++;
      return;
    }
    const pos = this.o.calendarOf(q.key.symbol).session(q.ts);
    if (pos.status !== 'open') {
      this.st.ignored.outsideSession++;
      return;
    }
    if (!isPos(q.ltp) && !isPos(q.bid) && !isPos(q.ask)) {
      this.st.ignored.noPrice++;
      return;
    }
    const id = keyId(q.key);
    let i = this.insts.get(id);
    if (!i || i.date !== pos.date) {
      if (i) this.close(i);
      i = { key: { ...q.key }, date: pos.date, sec: null, traded: false, rows: i?.rows ?? [] };
      this.insts.set(id, i);
    }
    const sec = Math.floor(q.ts / 1000);
    if (i.sec !== null && sec > i.sec) this.close(i);
    // Trade in this second: the cumulative volume rose, or a newer last-trade time.
    if ((isNum(q.volume) && isNum(i.volume) && q.volume > i.volume) || (isNum(q.ltt) && (i.ltt === undefined || q.ltt > i.ltt))) i.traded = true;
    if (isPos(q.ltp)) i.ltp = q.ltp;
    if (isPos(q.bid)) {
      i.bid = q.bid;
      i.bidQty = isNum(q.bidQty) ? q.bidQty : undefined;
    }
    if (isPos(q.ask)) {
      i.ask = q.ask;
      i.askQty = isNum(q.askQty) ? q.askQty : undefined;
    }
    if (isNum(q.volume)) i.volume = Math.max(i.volume ?? 0, q.volume);
    if (isNum(q.oi)) i.oi = q.oi;
    if (isNum(q.ltt)) i.ltt = Math.max(i.ltt ?? 0, q.ltt);
    // A late packet of an already closed second is folded into the open one.
    i.sec = i.sec === null ? sec : Math.max(i.sec, sec);
  }

  /** Every second: close seconds the clock is past, note coverage, flush now and then. */
  tick(): void {
    try {
      const now = this.o.clock.now();
      const nowSec = Math.floor(now / 1000);
      for (const i of this.insts.values()) if (i.sec !== null && i.sec < nowSec - 1) this.close(i);
      this.noteCoverage(now);
      if (now - this.lastFlush >= (this.o.flushMs ?? 5000)) this.flush();
    } catch (e) {
      this.o.onError?.(e);
    }
  }

  private close(i: Inst): void {
    if (i.sec === null) return;
    i.rows.push({ ts: i.sec * 1000, ltp: i.ltp, bid: i.bid, ask: i.ask, bidQty: i.bidQty, askQty: i.askQty, volume: i.volume, oi: i.oi, traded: i.traded });
    this.st.rowsBuffered++;
    i.sec = null;
    i.traded = false;
  }

  private noteCoverage(now: number): void {
    if (!this.o.live.health().connected) return;
    const t = now - 1000; // the second that just completed
    if (!this.o.calendars.some((c) => c.session(t).status === 'open')) return;
    const p = istParts(t);
    const s = p.minuteOfDay * 60 + p.second;
    let spans = this.cover.get(p.date);
    if (!spans) {
      spans = this.o.store.coverage(p.date).map(([a, b]) => [a, b] as [number, number]);
      this.cover.set(p.date, spans);
    }
    const last = spans[spans.length - 1];
    if (last && s >= last[0] && s <= last[1] + 1) last[1] = Math.max(last[1], s);
    else spans.push([s, s]);
    this.coverDirty.add(p.date);
  }

  /** Write buffered rows (one append per instrument) and the coverage of changed days. */
  flush(): void {
    this.lastFlush = this.o.clock.now();
    for (const i of this.insts.values()) {
      if (!i.rows.length) continue;
      const byDate = new Map<string, SecondRow[]>();
      for (const r of i.rows) {
        const d = istParts(r.ts).date;
        const list = byDate.get(d);
        if (list) list.push(r);
        else byDate.set(d, [r]);
      }
      const n = i.rows.length;
      i.rows = [];
      this.st.rowsBuffered -= n;
      for (const [d, rows] of byDate) {
        try {
          if (this.o.store.append(d, i.key, rows)) this.st.rowsWritten += rows.length;
          else this.st.dropped += rows.length;
        } catch (e) {
          this.st.dropped += rows.length;
          this.o.onError?.(e);
        }
      }
    }
    for (const d of this.coverDirty) {
      try {
        this.o.store.setCoverage(d, this.cover.get(d) ?? []);
      } catch (e) {
        this.o.onError?.(e);
      }
    }
    this.coverDirty = new Set();
    // Coverage of past days stays on disk only.
    const today = istParts(this.o.clock.now()).date;
    for (const d of [...this.cover.keys()]) if (d < today) this.cover.delete(d);
  }
}
