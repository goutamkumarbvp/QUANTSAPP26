/**
 * Recorder tests. The ticks below are synthetic TEST inputs built here to exercise the minute
 * builder; the program itself never fabricates ticks.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { maxPain } from '@q26/core';
import { ExchangeCalendar } from '../../src/live/calendar';
import { LiveClock } from '../../src/live/clock';
import { black76Iv, black76Price, timeToExpiry } from '../../src/live/pricing';
import { Recorder, type RecorderOptions } from '../../src/live/recorder';
import { IntradayFiles, type IntradayWriter } from '../../src/live/store/intraday';
import { keyId } from '../../src/live/types';
import type { ChainMinute, InstrumentKey, LiveQuote, MinuteRecord, OptKind } from '../../src/live/types';

const ist = (date: string, hh: number, mm: number, ss = 0, ms = 0): number => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm, ss, ms) - 330 * 60_000;
};
const D = '2026-10-12';
const EXP = '2026-10-20';
const t = (hh: number, mm: number, ss = 0, ms = 0) => ist(D, hh, mm, ss, ms);
const R = 0.065;

const FUT: InstrumentKey = { symbol: 'NIFTY', kind: 'FUT', expiry: '2026-10-27' };
const SPOT: InstrumentKey = { symbol: 'NIFTY', kind: 'SPOT' };
const opt = (kind: OptKind, strike: number): InstrumentKey => ({ symbol: 'NIFTY', kind, expiry: EXP, strike });

class FakeLive {
  private readonly listeners = new Set<(q: LiveQuote) => void>();
  readonly latest = new Map<string, LiveQuote>();
  onTick(l: (q: LiveQuote) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  quote(k: InstrumentKey): LiveQuote | undefined {
    return this.latest.get(keyId(k));
  }
  emit(q: LiveQuote): void {
    this.latest.set(keyId(q.key), q);
    for (const l of this.listeners) l(q);
  }
  get listening(): number {
    return this.listeners.size;
  }
}

class MemWriter implements IntradayWriter {
  minutes: { key: InstrumentKey; rec: MinuteRecord }[] = [];
  chains: { symbol: string; expiry: string; rec: ChainMinute }[] = [];
  pruned: string[] = [];
  writeMinutes(items: readonly { key: InstrumentKey; rec: MinuteRecord }[]): void {
    this.minutes.push(...items.map((i) => ({ key: i.key, rec: { ...i.rec } })));
  }
  writeChainMinutes(items: readonly { symbol: string; expiry: string; rec: ChainMinute }[]): void {
    this.chains.push(...items.map((i) => ({ ...i, rec: { ...i.rec } })));
  }
  prune(today: string): void {
    this.pruned.push(today);
  }
  of(key: InstrumentKey): MinuteRecord[] {
    return this.minutes.filter((m) => keyId(m.key) === keyId(key)).map((m) => m.rec);
  }
}

function setup(extra: Partial<RecorderOptions> = {}) {
  const calendar = new ExchangeCalendar();
  const clk = { now: t(9, 0) };
  const clock = new LiveClock(calendar, () => clk.now);
  const live = new FakeLive();
  const writer = new MemWriter();
  const rec = new Recorder({ live, writer, pricing: { r: R }, calendar, clock, timers: { setInterval: () => 0, clearInterval: () => undefined }, ...extra });
  rec.start();
  /** Deliver a tick stamped `ts`, received `lagMs` later. */
  const tick = (key: InstrumentKey, ts: number, fields: Partial<LiveQuote> & { ltp: number }, lagMs = 100) => {
    clk.now = ts + lagMs;
    live.emit({ key, ts, ...fields });
  };
  const at = (ts: number) => {
    clk.now = ts;
    rec.flushDue();
  };
  return { rec, live, writer, clk, tick, at, calendar };
}

describe('Recorder: minute bars', () => {
  it('builds OHLC, Δvolume and quote-rule classification from ticks', () => {
    const { rec, writer, tick } = setup();
    tick(FUT, t(10, 0, 5), { ltp: 100, volume: 1000, bid: 99.5, ask: 100.5, oi: 5000 }); // baseline only
    tick(FUT, t(10, 0, 20), { ltp: 100.5, volume: 1010, bid: 100, ask: 101 }); // ≥ prior ask 100.5 → buy 10
    tick(FUT, t(10, 0, 30), { ltp: 99, volume: 1025, bid: 98.5, ask: 99.5, oi: 5100 }); // ≤ prior bid 100 → sell 15
    tick(FUT, t(10, 0, 40), { ltp: 99.2, volume: 1030 }); // inside 98.5–99.5 → unclassified 5
    tick(FUT, t(10, 0, 50), { ltp: 101, volume: 1020, bid: 100.5, ask: 101.5 }); // volume went down: ignored
    tick(FUT, t(10, 0, 55), { ltp: 100.8, volume: 1031, totalBuyQty: 7000, totalSellQty: 8000, atp: 100.1 }); // Δ1 vs max 1030, inside → unclassified
    expect(rec.liveBar(FUT)).toMatchObject({ ts: t(10, 0), open: 100, close: 100.8, volume: 31 });
    expect(writer.minutes).toHaveLength(0);

    tick(FUT, t(10, 1, 2), { ltp: 101.6, volume: 1040 }); // rollover; ≥ prior ask 101.5 → buy 9
    expect(writer.of(FUT)).toEqual([
      { ts: t(10, 0), open: 100, high: 101, low: 99, close: 100.8, volume: 31, buyVolume: 10, sellVolume: 15, unclassified: 6, oi: 5100, bid: 100.5, ask: 101.5, totalBuyQty: 7000, totalSellQty: 8000, atp: 100.1 },
    ]);
    expect(rec.liveBar(FUT)).toMatchObject({ ts: t(10, 1), open: 101.6, volume: 9, buyVolume: 9, sellVolume: 0, unclassified: 0 });
  });

  it('leaves volume unclassified when the prior quote is unknown or crossed; indices carry no volume split', () => {
    const { writer, tick, at } = setup();
    tick(FUT, t(10, 0, 1), { ltp: 100, volume: 10 });
    tick(FUT, t(10, 0, 2), { ltp: 101, volume: 20, bid: 101, ask: 100.9 }); // no prior bid/ask
    tick(FUT, t(10, 0, 3), { ltp: 102, volume: 25 }); // prior quote crossed (bid ≥ ask)
    tick(SPOT, t(10, 0, 4), { ltp: 25_000 });
    tick(SPOT, t(10, 0, 9), { ltp: 25_004 });
    at(t(10, 1, 2));
    expect(writer.of(FUT)[0]).toMatchObject({ volume: 15, buyVolume: 0, sellVolume: 0, unclassified: 15 });
    expect(writer.of(SPOT)).toEqual([{ ts: t(10, 0), open: 25_000, high: 25_004, low: 25_000, close: 25_004, volume: 0 }]);
  });

  it('never writes minutes without ticks (gaps stay gaps)', () => {
    const { writer, tick, at } = setup();
    tick(FUT, t(10, 0, 10), { ltp: 100, volume: 1 });
    tick(FUT, t(10, 3, 10), { ltp: 103, volume: 4 });
    at(t(10, 10));
    expect(writer.of(FUT).map((r) => [r.ts, r.close, r.volume])).toEqual([
      [t(10, 0), 100, 0],
      [t(10, 3), 103, 3],
    ]);
  });

  it('flushes quiet instruments from the timer once the minute plus grace has passed', () => {
    const { writer, tick, at } = setup({ graceMs: 1500 });
    tick(FUT, t(10, 0, 10), { ltp: 100, volume: 1 });
    at(t(10, 1, 1, 499));
    expect(writer.minutes).toHaveLength(0);
    at(t(10, 1, 1, 500));
    expect(writer.of(FUT)).toHaveLength(1);
  });

  it('runs the flush on a real interval timer', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(t(10, 0, 10));
      const calendar = new ExchangeCalendar();
      const live = new FakeLive();
      const writer = new MemWriter();
      const rec = new Recorder({ live, writer, pricing: { r: R }, calendar, clock: new LiveClock(calendar) });
      rec.start();
      live.emit({ key: FUT, ts: Date.now(), ltp: 100, volume: 5 });
      vi.advanceTimersByTime(50_000);
      expect(writer.minutes).toHaveLength(0);
      vi.advanceTimersByTime(2_000); // 10:01:02
      expect(writer.of(FUT)).toHaveLength(1);
      rec.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('records only open-session ticks of today; other ticks update state only', () => {
    const { rec, writer, tick, clk, live, at } = setup();
    // Yesterday's snapshot delivered this morning: ignored entirely (does not set a baseline).
    clk.now = t(9, 5);
    live.emit({ key: FUT, ts: ist('2026-10-09', 15, 29, 59), ltp: 98, volume: 9_999_999 });
    // Pre-open: sets the baseline but makes no bar.
    tick(FUT, t(9, 8), { ltp: 99, volume: 500 });
    tick(FUT, t(9, 15, 2), { ltp: 100, volume: 600 });
    // A re-sent old update (stale), a timestamp far ahead of the clock, and a tick without a price.
    clk.now = t(9, 20);
    live.emit({ key: FUT, ts: t(9, 15, 30), ltp: 50, volume: 600 });
    live.emit({ key: FUT, ts: t(9, 25), ltp: 150, volume: 600 });
    tick(FUT, t(9, 20, 1), { ltp: 0, volume: 600 });
    at(t(9, 30));
    expect(writer.of(FUT)).toEqual([{ ts: t(9, 15), open: 100, high: 100, low: 100, close: 100, volume: 100, buyVolume: 0, sellVolume: 0, unclassified: 100 }]);
    expect(rec.stats().stateOnly).toEqual({ otherDate: 1, outsideSession: 1, noPrice: 1, stale: 1, ahead: 1 });
  });

  it('folds a tick for an already written minute into the next open minute', () => {
    const { writer, tick, at, rec } = setup();
    tick(FUT, t(10, 0, 10), { ltp: 100, volume: 10 });
    at(t(10, 1, 2)); // 10:00 written by the timer
    tick(FUT, t(10, 0, 59), { ltp: 99, volume: 12 }, 4_000); // arrives late
    expect(rec.liveBar(FUT)).toMatchObject({ ts: t(10, 1), open: 99, volume: 2 });
    tick(FUT, t(10, 1, 30), { ltp: 101, volume: 15 });
    tick(FUT, t(10, 1, 20), { ltp: 100, volume: 14 }, 20_000); // older than the minute in progress
    at(t(10, 3));
    expect(writer.of(FUT).map((r) => [r.ts, r.open, r.high, r.low, r.close, r.volume])).toEqual([
      [t(10, 0), 100, 100, 100, 100, 0],
      [t(10, 1), 99, 101, 99, 100, 5],
    ]);
  });

  it('does not write ticks after 15:30 and closes the date when the clock leaves it', () => {
    const { writer, tick, at, rec, clk, live } = setup();
    tick(FUT, t(15, 29, 58), { ltp: 100, volume: 1 });
    tick(FUT, t(15, 30, 1), { ltp: 101, volume: 2 });
    at(t(15, 31));
    expect(writer.of(FUT).map((r) => r.ts)).toEqual([t(15, 29)]);
    expect(rec.stats().date).toBe(D);
    at(ist('2026-10-13', 0, 0, 1));
    expect(rec.stats().date).toBeNull();
    // The next day starts from a fresh baseline.
    clk.now = ist('2026-10-13', 9, 15, 5);
    live.emit({ key: FUT, ts: ist('2026-10-13', 9, 15, 4), ltp: 102, volume: 50 });
    expect(rec.liveBar(FUT)).toMatchObject({ ts: ist('2026-10-13', 9, 15), volume: 0 });
    expect(rec.stats().date).toBe('2026-10-13');
  });
});

describe('Recorder: chain aggregates', () => {
  const strikes = [24_900, 25_000, 25_100];
  const F = 25_050;
  const oi: Record<string, number> = { 'CE|24900': 100, 'CE|25000': 300, 'CE|25100': 600, 'PE|24900': 700, 'PE|25000': 400, 'PE|25100': 50 };

  function feedChain(tick: ReturnType<typeof setup>['tick'], minute: number, oiBump = 0) {
    const T = timeToExpiry(EXP, minute + 60_000); // priced at the minute's end, where the recorder measures T
    tick(SPOT, minute + 1_000, { ltp: 25_010 });
    let s = 2;
    for (const K of strikes) {
      for (const kind of ['CE', 'PE'] as OptKind[]) {
        tick(opt(kind, K), minute + s++ * 1_000, { ltp: black76Price(kind, F, K, T, R, 0.12), oi: oi[`${kind}|${K}`] + oiBump, volume: (kind === 'CE' ? 1_000 : 2_000) + K / 100 });
      }
    }
  }

  it('writes one ChainMinute per minute from the values known at its close', () => {
    const { writer, tick, at } = setup();
    feedChain(tick, t(10, 0));
    at(t(10, 1, 2));
    expect(writer.chains).toHaveLength(1);
    const { symbol, expiry, rec } = writer.chains[0];
    expect([symbol, expiry]).toEqual(['NIFTY', EXP]);
    const ceOi = 100 + 300 + 600;
    const peOi = 700 + 400 + 50;
    const rows = strikes.map((K) => ({ strike: K, ceOI: oi[`CE|${K}`], peOI: oi[`PE|${K}`] }));
    expect(rec).toMatchObject({ ts: t(10, 0), spot: 25_010, ceOi, peOi, ceVolume: 3_000 + 750, peVolume: 6_000 + 750, atmStrike: 25_000 });
    expect(rec.pcr).toBeCloseTo(peOi / ceOi, 12);
    expect(rec.maxPain).toBe(maxPain(rows).maxPain);
    expect(rec.atmIv).toBeCloseTo(0.12, 6); // parity forward at 25,000, Black-76 on the minute-close premiums

    // OI moves in the next minute; the 10:00 aggregate is not rewritten and 10:01 sees the new OI.
    feedChain(tick, t(10, 1, 5), 10);
    at(t(10, 1, 59));
    expect(writer.chains).toHaveLength(1);
    at(t(10, 2, 2));
    expect(writer.chains).toHaveLength(2);
    expect(writer.chains[1].rec).toMatchObject({ ts: t(10, 1), ceOi: ceOi + 30, peOi: peOi + 30 });
  });

  it('uses listed strikes for the ATM strike and skips chains without spot or OI', () => {
    const { writer, tick, at, rec } = setup({ ref: { strikes: () => [24_900, 24_950, 25_000, 25_050, 25_100] } });
    tick(opt('CE', 25_000), t(10, 0, 1), { ltp: 120, oi: 10 });
    at(t(10, 1, 2));
    expect(writer.chains).toHaveLength(0); // no spot yet
    expect(rec.stats().chainSkipped.noSpot).toBe(1);
    tick(SPOT, t(10, 1, 3), { ltp: 25_040 });
    at(t(10, 2, 2));
    expect(writer.chains[0].rec).toMatchObject({ ts: t(10, 1), atmStrike: 25_050, ceOi: 10, peOi: 0, pcr: 0, maxPain: null });
    // Only a call and the spot are live: forward = spot carried at r, IV of that call.
    const T = timeToExpiry(EXP, t(10, 2));
    expect(writer.chains[0].rec.atmIv).toBeCloseTo(black76Iv('CE', 120, 25_040 * Math.exp(R * T), 25_000, T, R) as number, 12);

    rec.trackChain('BANKNIFTY', '2026-10-27');
    tick({ symbol: 'BANKNIFTY', kind: 'SPOT' }, t(10, 2, 3), { ltp: 56_000 });
    at(t(10, 3, 2));
    expect(writer.chains.filter((c) => c.symbol === 'BANKNIFTY')).toHaveLength(0);
    expect(rec.stats().chainSkipped.noOi).toBeGreaterThanOrEqual(1);
  });
});

describe('Recorder: session hooks and the store', () => {
  let dir = '';
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('startSession prunes and is idempotent; endSession writes what is open and clears the day', () => {
    const { rec, writer, tick, clk } = setup();
    clk.now = t(9, 0);
    rec.startSession();
    expect(writer.pruned).toEqual([D]);
    tick(FUT, t(10, 0, 10), { ltp: 100, volume: 1 });
    rec.startSession(D); // same date: no reset
    expect(rec.liveBar(FUT)).not.toBeNull();
    clk.now = t(15, 40);
    const summary = rec.endSession();
    expect(summary).toEqual({ date: D, instruments: 1, minutesWritten: 1, chainMinutesWritten: 0 });
    expect(writer.of(FUT).map((r) => r.ts)).toEqual([t(10, 0)]);
    expect(rec.liveBar(FUT)).toBeNull();
    expect(rec.endSession()).toBeNull();
  });

  it('stop() detaches from the feed and writes the partial minute', () => {
    const { rec, writer, tick, live } = setup();
    tick(FUT, t(10, 0, 10), { ltp: 100, volume: 1 });
    expect(live.listening).toBe(1);
    rec.stop();
    expect(live.listening).toBe(0);
    expect(writer.of(FUT)).toHaveLength(1);
    tick(FUT, t(10, 0, 20), { ltp: 101, volume: 2 });
    expect(rec.liveBar(FUT)).toBeNull();
  });

  it('reports writer failures without throwing into the feed', () => {
    const errors: unknown[] = [];
    const failing: IntradayWriter = {
      writeMinutes: () => {
        throw new Error('disk full');
      },
      writeChainMinutes: () => undefined,
    };
    const { tick, at, rec } = setup({ writer: failing, onError: (e) => errors.push(e) });
    tick(FUT, t(10, 0, 10), { ltp: 100, volume: 1 });
    expect(() => at(t(10, 2))).not.toThrow();
    expect(rec.stats()).toMatchObject({ writeErrors: 1, lastError: 'disk full', minutesWritten: 0 });
    expect(errors).toHaveLength(1);
  });

  it('fills IntradayFiles end to end (bars, liveBar, chain series)', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q26-rec-'));
    const store = new IntradayFiles({ dataDir: dir });
    const { rec, tick, at } = setup({ writer: store });
    store.setLiveSource(rec);
    tick(SPOT, t(10, 0, 1), { ltp: 25_000 });
    tick(opt('CE', 25_000), t(10, 0, 2), { ltp: 120, oi: 1_000, volume: 65 });
    tick(opt('PE', 25_000), t(10, 0, 3), { ltp: 110, oi: 1_200, volume: 130 });
    tick(opt('CE', 25_000), t(10, 0, 30), { ltp: 121, oi: 1_065, volume: 130, bid: 120.9, ask: 121.1 });
    at(t(10, 1, 2));
    tick(SPOT, t(10, 1, 5), { ltp: 25_003 });

    const reopened = new IntradayFiles({ dataDir: dir });
    expect(reopened.bars(opt('CE', 25_000), D)).toEqual([{ ts: t(10, 0), open: 120, high: 121, low: 120, close: 121, volume: 65, buyVolume: 0, sellVolume: 0, unclassified: 65, oi: 1_065, bid: 120.9, ask: 121.1 }]);
    expect(store.liveBar(SPOT)).toMatchObject({ ts: t(10, 1), close: 25_003 });
    expect(reopened.chainSeries('NIFTY', EXP, D)).toEqual([expect.objectContaining({ ts: t(10, 0), spot: 25_000, ceOi: 1_065, peOi: 1_200, ceVolume: 130, peVolume: 130, atmStrike: 25_000 })]);
    expect(reopened.chainAt('NIFTY', EXP, t(10, 1, 30))?.rows[0]).toMatchObject({ strike: 25_000, ce: { ltp: 121, oi: 1_065 }, pe: { ltp: 110, oi: 1_200 } });
    expect(reopened.sessions()).toEqual([D]);
  });
});
