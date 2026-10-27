/**
 * One-second store and recorder. All quotes are TEST DATA built here (no market data, no network).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { istTs } from '@q26/core';
import { ExchangeCalendar } from '../../src/live/calendar';
import { SecondRecorder } from '../../src/live/second-recorder';
import { decodeRows, encodeRows, mergeSpans, ROW_BYTES, SecondStore, type SecondRow } from '../../src/live/store/seconds';
import type { InstrumentKey, LiveQuote } from '../../src/live/types';

const DAY = '2026-10-12'; // a Monday
const NEXT = '2026-10-13';
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'q26-seconds-'));
  dirs.push(d);
  return d;
};
const at = (date: string, hh: number, mm: number, ss = 0) => istTs(date, hh * 60 + mm, ss);
const CE: InstrumentKey = { symbol: 'NIFTY', kind: 'CE', expiry: '2026-10-13', strike: 25000 };
const SPOT: InstrumentKey = { symbol: 'NIFTY', kind: 'SPOT' };

describe('one-second rows', () => {
  it('encode / decode every field to the paisa, and leave absent fields absent', () => {
    const d0 = SecondStore.dayStart(DAY);
    const rows: SecondRow[] = [
      { ts: at(DAY, 9, 15, 1), ltp: 121.25, bid: 121.2, ask: 121.3, bidQty: 750, askQty: 1500, volume: 123_456_789, oi: 9_876_543, traded: true },
      { ts: at(DAY, 9, 15, 2), ltp: 82_000.05, traded: false },
      { ts: at(DAY, 15, 29, 59), bid: 0.05, ask: 0.1, traded: false },
    ];
    const buf = encodeRows(rows, d0);
    expect(buf.length).toBe(3 * ROW_BYTES);
    expect(decodeRows(buf, d0)).toEqual(rows);
    // a torn trailing row is ignored
    expect(decodeRows(Buffer.concat([buf, buf.subarray(0, 10)]), d0)).toEqual(rows);
  });

  it('merges coverage spans', () => {
    expect(mergeSpans([[10, 20], [5, 9], [30, 40], [21, 25]])).toEqual([[5, 25], [30, 40]]);
  });
});

describe('SecondStore', () => {
  it('appends, reads back, trims a torn row before the next append, compacts finished days', async () => {
    const dir = tmp();
    const s = new SecondStore({ dataDir: dir });
    s.append(DAY, CE, [{ ts: at(DAY, 9, 15, 1), ltp: 100, traded: true }]);
    // a crash left half a row
    const file = path.join(dir, 'seconds', DAY, 'NIFTY', 'CE_2026-10-13_25000.bin');
    fs.appendFileSync(file, Buffer.alloc(20, 7));
    const s2 = new SecondStore({ dataDir: dir });
    s2.append(DAY, CE, [{ ts: at(DAY, 9, 15, 2), ltp: 101, traded: false }]);
    expect(fs.statSync(file).size).toBe(2 * ROW_BYTES);
    expect(s2.read(CE, DAY).map((r) => r.ltp)).toEqual([100, 101]);
    expect(s2.keys(DAY)).toEqual([CE]);
    expect(s2.has(CE, DAY)).toBe(true);
    expect(s2.has(SPOT, DAY)).toBe(false);

    // the current day is not compacted; a finished one is gzipped and keeps its rows
    expect(await s2.compact(DAY)).toEqual([]);
    expect(await s2.compact(NEXT)).toEqual([DAY]);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.gz`)).toBe(true);
    expect(s2.read(CE, DAY).map((r) => r.ltp)).toEqual([100, 101]);
    // more rows of the same day after a restart are merged at the next compaction
    s2.append(DAY, CE, [{ ts: at(DAY, 9, 15, 3), ltp: 102, traded: true }]);
    expect(s2.read(CE, DAY).map((r) => r.ltp)).toEqual([100, 101, 102]);
    await s2.compact(NEXT);
    expect(s2.read(CE, DAY).map((r) => r.ltp)).toEqual([100, 101, 102]);
    expect(s2.usage()).toMatchObject({ days: 1, oldest: DAY, newest: DAY, paused: null });
  });

  it('a second written twice (restart inside it) reads once, the later row', () => {
    const s = new SecondStore({ dataDir: tmp() });
    s.append(DAY, CE, [{ ts: at(DAY, 9, 16, 0), ltp: 100, traded: false }]);
    s.append(DAY, CE, [{ ts: at(DAY, 9, 16, 0), ltp: 105, traded: true }]);
    expect(s.read(CE, DAY)).toEqual([{ ts: at(DAY, 9, 16, 0), ltp: 105, traded: true }]);
  });

  it('keeps within the size cap and the age limit by deleting the oldest days, never today', () => {
    const dir = tmp();
    const s = new SecondStore({ dataDir: dir, maxBytes: 2 * ROW_BYTES * 10, retentionDays: 30 });
    const days = ['2026-08-03', '2026-10-05', '2026-10-06', '2026-10-07', DAY];
    for (const d of days) s.append(d, CE, Array.from({ length: 10 }, (_, i) => ({ ts: at(d, 9, 15, i), ltp: 100 + i, traded: true })));
    const removed = s.prune(DAY);
    // 2026-08-03 is older than 30 days; then the oldest go until at most two days' bytes remain (today kept)
    expect(removed).toEqual(['2026-08-03', '2026-10-05', '2026-10-06']);
    expect(s.dates()).toEqual(['2026-10-07', DAY]);
    expect(s.read(CE, DAY)).toHaveLength(10);
  });

  it('reads coverage spans back', () => {
    const s = new SecondStore({ dataDir: tmp() });
    s.setCoverage(DAY, [[33_300, 33_400], [33_401, 33_500], [40_000, 40_010]]);
    expect(s.coverage(DAY)).toEqual([[33_300, 33_500], [40_000, 40_010]]);
    expect(s.coverage(NEXT)).toEqual([]);
  });
});

describe('SecondRecorder', () => {
  function setup(start = at(DAY, 9, 20, 0)) {
    let now = start;
    const listeners: ((q: LiveQuote) => void)[] = [];
    let interval: (() => void) | null = null;
    let connected = true;
    const store = new SecondStore({ dataDir: tmp() });
    const nse = new ExchangeCalendar();
    const rec = new SecondRecorder({
      live: { onTick: (fn) => (listeners.push(fn), () => listeners.splice(listeners.indexOf(fn), 1)), health: () => ({ loggedIn: true, connected, lastTickTs: null, subscribed: 1 }) },
      store,
      clock: { now: () => now, info: () => { throw new Error('unused'); } },
      calendarOf: () => nse,
      calendars: [nse],
      timers: { setInterval: (fn) => ((interval = fn), 1), clearInterval: () => { interval = null; } },
      flushMs: 5000,
    });
    rec.start();
    const tick = (key: InstrumentKey, ts: number, q: Partial<LiveQuote>) => listeners.forEach((fn) => fn({ key, ts, ltp: 0, ...q } as LiveQuote));
    const advance = (ms: number) => {
      const end = now + ms;
      while (now < end) {
        now = Math.min(end, now + 1000);
        interval?.();
      }
    };
    return { store, rec, tick, advance, setConnected: (v: boolean) => (connected = v), now: () => now };
  }

  it('one row per instrument and second: the state at the end of the second, traded when volume rose', () => {
    const { store, rec, tick, advance } = setup();
    const t = at(DAY, 9, 20, 0);
    tick(CE, t + 100, { ltp: 120, bid: 119.9, ask: 120.1, bidQty: 75, askQty: 150, volume: 1000, oi: 5000 });
    tick(CE, t + 600, { ltp: 121, bid: 120.9, ask: 121.1, bidQty: 75, askQty: 75, volume: 1075, oi: 5075 });
    tick(CE, t + 1200, { ltp: 121, bid: 120.95, ask: 121.1, volume: 1075, oi: 5075 }); // quote only
    tick(CE, t + 3500, { ltp: 122, bid: 121.9, ask: 122.1, volume: 1150, oi: 5100 });
    advance(8000);
    rec.stop();
    expect(store.read(CE, DAY)).toEqual([
      { ts: t, ltp: 121, bid: 120.9, ask: 121.1, bidQty: 75, askQty: 75, volume: 1075, oi: 5075, traded: true },
      { ts: t + 1000, ltp: 121, bid: 120.95, ask: 121.1, volume: 1075, oi: 5075, traded: false },
      { ts: t + 3000, ltp: 122, bid: 121.9, ask: 122.1, volume: 1150, oi: 5100, traded: true },
    ]);
    expect(rec.stats()).toMatchObject({ rowsWritten: 3, rowsBuffered: 0, dropped: 0 });
  });

  it('ignores ticks outside the session and far from the clock; notes coverage only while connected', () => {
    const { store, rec, tick, advance, setConnected } = setup();
    tick(SPOT, at(DAY, 9, 18, 0), { ltp: 25001 }); // two minutes behind the clock: stale
    tick(SPOT, at(DAY, 9, 20, 0) + 10, { ltp: 25002 });
    advance(3000);
    setConnected(false);
    advance(5000);
    setConnected(true);
    advance(3000);
    rec.stop();
    expect(store.read(SPOT, DAY).map((r) => r.ltp)).toEqual([25002]);
    expect(rec.stats().ignored).toEqual({ outsideSession: 0, stale: 1, noPrice: 0 });
    const s0 = (9 * 60 + 20) * 60;
    expect(store.coverage(DAY)).toEqual([[s0, s0 + 2], [s0 + 8, s0 + 10]]);
  });

  it('a pre-open tick is not recorded and the pre-open is not coverage', () => {
    const { store, rec, tick, advance } = setup(at(DAY, 9, 5, 0));
    tick(SPOT, at(DAY, 9, 5, 0) + 10, { ltp: 25000 });
    advance(3000);
    rec.stop();
    expect(store.read(SPOT, DAY)).toEqual([]);
    expect(store.coverage(DAY)).toEqual([]);
    expect(rec.stats().ignored.outsideSession).toBe(1);
  });

  it('a late tick of a written second goes into the open second, never rewriting history', () => {
    const { store, rec, tick, advance } = setup();
    const t = at(DAY, 9, 20, 0);
    tick(CE, t + 100, { ltp: 100, volume: 10 });
    tick(CE, t + 2100, { ltp: 102, volume: 30 }); // closes second t
    tick(CE, t + 900, { ltp: 101, volume: 20 }); // late packet of second t
    advance(6000);
    rec.stop();
    const rows = store.read(CE, DAY);
    expect(rows.map((r) => [r.ts - t, r.ltp])).toEqual([[0, 100], [2000, 101]]);
  });
});
