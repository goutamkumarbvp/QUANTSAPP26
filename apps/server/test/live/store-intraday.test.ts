import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IntradayFiles, decodeSymbol, encodeSymbol, instrumentFileName } from '../../src/live/store/intraday';
import type { ChainMinute, InstrumentKey, MinuteRecord } from '../../src/live/types';

const ist = (date: string, hh: number, mm: number, ss = 0): number => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm, ss) - 330 * 60_000;
};

const D = '2026-10-12';
const EXP = '2026-10-20';
const t = (hh: number, mm: number, ss = 0) => ist(D, hh, mm, ss);
const SPOT: InstrumentKey = { symbol: 'NIFTY', kind: 'SPOT' };
const FUT_OCT: InstrumentKey = { symbol: 'NIFTY', kind: 'FUT', expiry: '2026-10-27' };
const FUT_NOV: InstrumentKey = { symbol: 'NIFTY', kind: 'FUT', expiry: '2026-11-24' };
const opt = (kind: 'CE' | 'PE', strike: number, expiry = EXP): InstrumentKey => ({ symbol: 'NIFTY', kind, expiry, strike });
const bar = (ts: number, close: number, extra: Partial<MinuteRecord> = {}): MinuteRecord => ({ ts, open: close, high: close, low: close, close, volume: 0, ...extra });

describe('IntradayFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q26-intraday-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('round-trips minute records across a restart', () => {
    const a = new IntradayFiles({ dataDir: dir });
    const spotBars = [bar(t(9, 15), 25_000, { open: 24_990, high: 25_010, low: 24_985 }), bar(t(9, 16), 25_004)];
    const ceBar = bar(t(9, 15), 120.5, { volume: 650, oi: 1_300_000, bid: 120.4, ask: 120.6, buyVolume: 390, sellVolume: 195, unclassified: 65, atp: 119.8, totalBuyQty: 50_000, totalSellQty: 61_000 });
    a.writeMinutes([...spotBars.map((rec) => ({ key: SPOT, rec })), { key: opt('CE', 25_000), rec: ceBar }]);
    a.writeMinutes([{ key: FUT_OCT, rec: bar(t(9, 15), 25_120, { oi: 13_930_930 }) }]);

    const b = new IntradayFiles({ dataDir: dir });
    expect(b.bars(SPOT, D)).toEqual(spotBars);
    expect(b.bars(opt('CE', 25_000), D)).toEqual([ceBar]);
    expect(b.bars(opt('PE', 25_000), D)).toEqual([]);
    expect(b.bars(SPOT, '2026-10-13')).toEqual([]);
    expect(b.sessions()).toEqual([D]);
    expect(b.recordedKeys(D)).toEqual([opt('CE', 25_000), FUT_OCT, SPOT]);
    expect(b.recordedKeys('2026-10-13')).toEqual([]);
  });

  it('keeps the read cache coherent with later writes', () => {
    const s = new IntradayFiles({ dataDir: dir });
    s.writeMinutes([{ key: SPOT, rec: bar(t(10, 0), 1) }]);
    expect(s.bars(SPOT, D)).toHaveLength(1);
    s.writeMinutes([{ key: SPOT, rec: bar(t(10, 1), 2) }]);
    expect(s.bars(SPOT, D).map((r) => r.close)).toEqual([1, 2]);
  });

  it('at() returns the last minute completed at ts (no look-ahead)', () => {
    const s = new IntradayFiles({ dataDir: dir });
    s.writeMinutes([10, 11, 13].map((m) => ({ key: SPOT, rec: bar(t(10, 0) + (m - 10) * 60_000, m) })));
    expect(s.at(SPOT, t(10, 0, 30))).toBeUndefined();
    expect(s.at(SPOT, t(10, 1))?.close).toBe(10);
    expect(s.at(SPOT, t(10, 1, 59))?.close).toBe(10);
    expect(s.at(SPOT, t(10, 2))?.close).toBe(11);
    expect(s.at(SPOT, t(10, 3, 30))?.close).toBe(11); // 10:02 was not recorded: the gap stays a gap
    expect(s.at(SPOT, t(10, 4))?.close).toBe(13);
    expect(s.at(SPOT, t(15, 45))?.close).toBe(13);
    expect(s.at(SPOT, ist('2026-10-13', 10, 0))).toBeUndefined(); // another date
  });

  it('rebuilds an as-of chain from per-strike records', () => {
    const s = new IntradayFiles({ dataDir: dir });
    const m0 = t(11, 0);
    const m1 = t(11, 1);
    s.writeMinutes([
      { key: SPOT, rec: bar(m0, 25_010) },
      { key: SPOT, rec: bar(m1, 25_020) },
      { key: FUT_NOV, rec: bar(m0, 25_300) },
      { key: opt('CE', 25_000), rec: bar(m0, 130, { oi: 1_000, bid: 129.9, ask: 130.1 }) },
      { key: opt('CE', 25_000), rec: bar(m1, 126, { oi: 1_100 }) },
      { key: opt('PE', 25_000), rec: bar(m0, 110, { oi: 2_000 }) },
      { key: opt('CE', 25_100), rec: bar(m0, 80, { oi: 3_000 }) },
      { key: opt('PE', 24_900), rec: bar(m1, 70, { oi: 500 }) },
      { key: opt('CE', 25_000, '2026-10-27'), rec: bar(m0, 200, { oi: 9 }) }, // other expiry
    ]);
    expect(s.chainAt('NIFTY', EXP, m0)).toBeUndefined(); // nothing completed yet

    const c1 = s.chainAt('NIFTY', EXP, m1 + 10_000);
    expect(c1).toBeDefined();
    expect(c1?.ts).toBe(m1 + 10_000);
    expect(c1?.spot).toEqual({ key: SPOT, ts: m0, ltp: 25_010 });
    expect(c1?.future).toEqual({ key: FUT_NOV, ts: m0, ltp: 25_300 }); // no same-expiry future: nearest
    expect(c1?.rows.map((r) => r.strike)).toEqual([25_000, 25_100]);
    expect(c1?.rows[0].ce).toEqual({ key: opt('CE', 25_000), ts: m0, ltp: 130, oi: 1_000, bid: 129.9, ask: 130.1 });
    expect(c1?.rows[0].pe).toMatchObject({ ltp: 110, oi: 2_000 });
    expect(c1?.rows[1].pe).toBeUndefined();

    s.writeMinutes([{ key: { symbol: 'NIFTY', kind: 'FUT', expiry: EXP }, rec: bar(m0, 25_090) }]);
    const c2 = s.chainAt('NIFTY', EXP, m1 + 60_000);
    expect(c2?.spot?.ltp).toBe(25_020);
    expect(c2?.future?.key.expiry).toBe(EXP); // same-expiry future preferred
    expect(c2?.rows.map((r) => r.strike)).toEqual([24_900, 25_000, 25_100]);
    expect(c2?.rows[1].ce).toMatchObject({ ltp: 126, oi: 1_100 });
    expect(s.chainAt('BANKNIFTY', EXP, m1 + 60_000)).toBeUndefined();
  });

  it('round-trips chain minutes (last write of a minute wins)', () => {
    const s = new IntradayFiles({ dataDir: dir });
    const cm = (ts: number, atmIv: number | null): ChainMinute => ({ ts, spot: 25_000, ceOi: 100, peOi: 120, ceVolume: 1_000, peVolume: 900, pcr: 1.2, maxPain: 25_000, atmStrike: 25_000, atmIv });
    s.writeChainMinutes([{ symbol: 'NIFTY', expiry: EXP, rec: cm(t(10, 0), 0.12) }]);
    s.writeChainMinutes([{ symbol: 'NIFTY', expiry: EXP, rec: cm(t(10, 1), null) }, { symbol: 'NIFTY', expiry: EXP, rec: cm(t(10, 0), 0.125) }]);
    const again = new IntradayFiles({ dataDir: dir });
    expect(again.chainSeries('NIFTY', EXP, D)).toEqual([cm(t(10, 0), 0.125), cm(t(10, 1), null)]);
    expect(again.chainSeries('NIFTY', '2026-10-27', D)).toEqual([]);
    expect(again.sessions()).toEqual([D]);
  });

  it('survives a crash mid-write: a torn last line is ignored and repaired', () => {
    const a = new IntradayFiles({ dataDir: dir });
    a.writeMinutes([{ key: SPOT, rec: bar(t(10, 0), 1) }, { key: SPOT, rec: bar(t(10, 1), 2) }]);
    const file = path.join(dir, 'market', D, 'bars', 'NIFTY', 'SPOT.jsonl');
    fs.appendFileSync(file, '{"ts":1760245380000,"open":3,"hi'); // torn write, no newline

    const b = new IntradayFiles({ dataDir: dir });
    expect(b.bars(SPOT, D).map((r) => r.close)).toEqual([1, 2]);
    b.writeMinutes([{ key: SPOT, rec: bar(t(10, 3), 4) }]);
    expect(b.bars(SPOT, D).map((r) => r.close)).toEqual([1, 2, 4]);
    expect(fs.readFileSync(file, 'utf8').endsWith('\n')).toBe(true);

    fs.appendFileSync(file, 'not json\n');
    const c = new IntradayFiles({ dataDir: dir });
    expect(c.bars(SPOT, D).map((r) => r.close)).toEqual([1, 2, 4]);
  });

  it('merges two records of the same minute (restart inside a minute)', () => {
    const s = new IntradayFiles({ dataDir: dir });
    const k = opt('CE', 25_000);
    s.writeMinutes([{ key: k, rec: { ts: t(10, 0), open: 100, high: 101, low: 99, close: 100.5, volume: 10, buyVolume: 6, sellVolume: 4, unclassified: 0, oi: 100 } }]);
    s.writeMinutes([{ key: k, rec: { ts: t(10, 0), open: 100.4, high: 102, low: 100, close: 101, volume: 5, buyVolume: 1, sellVolume: 0, unclassified: 4, oi: 200 } }]);
    expect(new IntradayFiles({ dataDir: dir }).bars(k, D)).toEqual([{ ts: t(10, 0), open: 100, high: 102, low: 99, close: 101, volume: 15, buyVolume: 7, sellVolume: 4, unclassified: 4, oi: 200 }]);
  });

  it('uses safe, reversible file names', () => {
    expect(encodeSymbol('M&M')).toBe('M%26M');
    expect(encodeSymbol('..')).toBe('%2E%2E');
    expect(decodeSymbol(encodeSymbol('BAJAJ-AUTO'))).toBe('BAJAJ-AUTO');
    expect(instrumentFileName(opt('PE', 102.5))).toBe(`PE_${EXP}_102.5.jsonl`);
    expect(() => instrumentFileName({ symbol: 'NIFTY', kind: 'FUT', expiry: '../../etc' })).toThrow();
    expect(() => instrumentFileName({ symbol: 'NIFTY', kind: 'CE', expiry: EXP })).toThrow();

    const s = new IntradayFiles({ dataDir: dir });
    const mm: InstrumentKey = { symbol: 'M&M', kind: 'CE', expiry: '2026-10-27', strike: 3_250 };
    s.writeMinutes([{ key: mm, rec: bar(t(10, 0), 41.2) }]);
    expect(new IntradayFiles({ dataDir: dir }).recordedKeys(D)).toEqual([mm]);
    expect(() => s.bars(SPOT, '2026-10-1')).toThrow(/invalid date/);
    expect(() => s.writeMinutes([{ key: SPOT, rec: bar(t(10, 0), Number.NaN) }])).toThrow(/invalid minute record/);
  });

  it('prunes dates older than the retention window', () => {
    const s = new IntradayFiles({ dataDir: dir, retentionDays: 5 });
    for (const d of ['2026-10-01', '2026-10-06', '2026-10-07', '2026-10-09', '2026-10-12']) s.writeMinutes([{ key: SPOT, rec: bar(ist(d, 10, 0), 1) }]);
    s.prune('2026-10-12');
    expect(s.sessions()).toEqual(['2026-10-07', '2026-10-09', '2026-10-12']);
    expect(s.bars(SPOT, '2026-10-01')).toEqual([]);
    new IntradayFiles({ dataDir: dir }).prune('2026-12-31'); // no retention configured: keeps everything
    expect(s.sessions()).toHaveLength(3);
  });

  it('serves liveBar from the attached recorder only', () => {
    const s = new IntradayFiles({ dataDir: dir });
    expect(s.liveBar(SPOT)).toBeNull();
    const live = bar(t(10, 5), 25_001);
    s.setLiveSource({ liveBar: (k) => (k.kind === 'SPOT' ? live : null) });
    expect(s.liveBar(SPOT)).toBe(live);
    expect(s.liveBar(FUT_OCT)).toBeNull();
  });
});
