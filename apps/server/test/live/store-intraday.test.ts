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
const bar = (ts: number, close: number, extra: Partial<MinuteRecord> = {}): MinuteRecord => ({ ts, open: close, high: close, low: close, close, traded: true, ...extra });

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
    // A quote-only minute: written (chainAt needs its book and OI), flagged as not traded.
    const quoteOnly = bar(t(9, 15), 25_120, { traded: false, volume: 0, oi: 13_930_930 });
    a.writeMinutes([{ key: FUT_OCT, rec: quoteOnly }]);

    const b = new IntradayFiles({ dataDir: dir });
    expect(b.bars(SPOT, D)).toEqual(spotBars);
    expect(b.bars(SPOT, D).every((r) => !('volume' in r))).toBe(true); // index volume stays absent
    expect(b.bars(FUT_OCT, D)).toEqual([quoteOnly]);
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

  it('round-trips level-1 bid/ask quantities and serves them in as-of chains (Phase C order-book history)', () => {
    const a = new IntradayFiles({ dataDir: dir });
    const rec = bar(t(11, 0), 130, { oi: 1_000, bid: 129.9, ask: 130.1, bidQty: 750, askQty: 1_500, totalBuyQty: 90_000, totalSellQty: 80_000 });
    a.writeMinutes([{ key: opt('CE', 25_000), rec }, { key: opt('PE', 25_000), rec: bar(t(11, 0), 110, { bid: 109.9, ask: 110.1 }) }]);
    const b = new IntradayFiles({ dataDir: dir });
    expect(b.bars(opt('CE', 25_000), D)).toEqual([rec]);
    // Absent quantities stay absent (never a 0 that looks like an empty level).
    expect('bidQty' in b.bars(opt('PE', 25_000), D)[0]).toBe(false);
    const c = b.chainAt('NIFTY', EXP, t(11, 1));
    expect(c?.rows[0].ce).toEqual({ key: opt('CE', 25_000), ts: t(11, 0), ltp: 130, oi: 1_000, bid: 129.9, ask: 130.1, bidQty: 750, askQty: 1_500, totalBuyQty: 90_000, totalSellQty: 80_000 });
    expect(c?.rows[0].pe).toEqual({ key: opt('PE', 25_000), ts: t(11, 0), ltp: 110, bid: 109.9, ask: 110.1 });
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

  it('keeps a complete last record that only lost its newline', () => {
    const a = new IntradayFiles({ dataDir: dir });
    a.writeMinutes([{ key: SPOT, rec: bar(t(10, 0), 1) }]);
    const file = path.join(dir, 'market', D, 'bars', 'NIFTY', 'SPOT.jsonl');
    fs.appendFileSync(file, JSON.stringify(bar(t(10, 1), 2))); // crash just before the '\n'

    const b = new IntradayFiles({ dataDir: dir });
    b.writeMinutes([{ key: SPOT, rec: bar(t(10, 2), 3) }]);
    expect(new IntradayFiles({ dataDir: dir }).bars(SPOT, D).map((r) => r.close)).toEqual([1, 2, 3]);
  });

  it('merges two records of the same minute (restart inside a minute)', () => {
    const s = new IntradayFiles({ dataDir: dir });
    const k = opt('CE', 25_000);
    s.writeMinutes([{ key: k, rec: { ts: t(10, 0), open: 100, high: 101, low: 99, close: 100.5, traded: true, volume: 10, buyVolume: 6, sellVolume: 4, unclassified: 0, oi: 100 } }]);
    s.writeMinutes([{ key: k, rec: { ts: t(10, 0), open: 100.4, high: 102, low: 100, close: 101, traded: false, volume: 0, buyVolume: 0, sellVolume: 0, unclassified: 0, oi: 200 } }]);
    expect(new IntradayFiles({ dataDir: dir }).bars(k, D)).toEqual([{ ts: t(10, 0), open: 100, high: 102, low: 99, close: 101, traded: true, volume: 10, buyVolume: 6, sellVolume: 4, unclassified: 0, oi: 200 }]);
    // A restart inside a minute: the volumes behind a feed gap (gapVolume) add up and the lower-bound flag survives the merge.
    const g = opt('PE', 25_000);
    s.writeMinutes([{ key: g, rec: { ts: t(10, 1), open: 5, high: 5, low: 5, close: 5, traded: true, volume: 4, gapVolume: 3, buyVolume: 4, sellVolume: 0, unclassified: 0 } }]);
    s.writeMinutes([{ key: g, rec: { ts: t(10, 1), open: 5, high: 6, low: 5, close: 6, traded: true, volume: 2, gapVolume: 1, buyVolume: 0, sellVolume: 0, unclassified: 2, partial: true } }]);
    expect(new IntradayFiles({ dataDir: dir }).bars(g, D)).toEqual([{ ts: t(10, 1), open: 5, high: 6, low: 5, close: 6, traded: true, volume: 6, gapVolume: 4, buyVolume: 4, sellVolume: 0, unclassified: 2, partial: true }]);
    // Records without volume (index spots) stay without it; quote-only halves stay not traded.
    s.writeMinutes([{ key: SPOT, rec: bar(t(10, 0), 25_000, { traded: false }) }, { key: SPOT, rec: bar(t(10, 0), 25_002, { traded: false }) }]);
    expect(s.bars(SPOT, D)).toEqual([{ ts: t(10, 0), open: 25_000, high: 25_002, low: 25_000, close: 25_002, traded: false }]);
  });

  it('refuses a minute record without the traded flag (no default is invented)', () => {
    const s = new IntradayFiles({ dataDir: dir });
    const { traded: _t, ...noFlag } = bar(t(10, 0), 1);
    expect(() => s.writeMinutes([{ key: SPOT, rec: noFlag as MinuteRecord }])).toThrow(/invalid minute record/);
    // A line on disk without it (written by something else) is skipped on read.
    const file = path.join(dir, 'market', D, 'bars', 'NIFTY', 'SPOT.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ ...noFlag, volume: 5 })}\n${JSON.stringify(bar(t(10, 1), 2))}\n`);
    expect(new IntradayFiles({ dataDir: dir }).bars(SPOT, D).map((r) => r.close)).toEqual([2]);
  });

  it('round-trips chain minutes whose CE/PE volume was never seen as null', () => {
    const s = new IntradayFiles({ dataDir: dir });
    const rec: ChainMinute = { ts: t(10, 0), spot: 25_000, ceOi: 10, peOi: 4, ceVolume: null, peVolume: 130, pcr: 0.4, maxPain: null, atmStrike: 25_000, atmIv: null };
    s.writeChainMinutes([{ symbol: 'NIFTY', expiry: EXP, rec }]);
    expect(new IntradayFiles({ dataDir: dir }).chainSeries('NIFTY', EXP, D)).toEqual([rec]);
    expect(() => s.writeChainMinutes([{ symbol: 'NIFTY', expiry: EXP, rec: { ...rec, ts: t(10, 1), ceVolume: undefined } as unknown as ChainMinute }])).toThrow(/invalid chain minute/);
  });

  it('hands out copies: callers mutating results cannot corrupt the cache', () => {
    const s = new IntradayFiles({ dataDir: dir });
    s.writeMinutes([{ key: SPOT, rec: bar(t(10, 0), 25_000) }, { key: opt('CE', 25_000), rec: bar(t(10, 0), 120, { oi: 1_000 }) }]);
    const cm: ChainMinute = { ts: t(10, 0), spot: 25_000, ceOi: 10, peOi: 4, ceVolume: 1, peVolume: 2, pcr: 0.4, maxPain: null, atmStrike: 25_000, atmIv: 0.12 };
    s.writeChainMinutes([{ symbol: 'NIFTY', expiry: EXP, rec: cm }]);
    s.at(SPOT, t(10, 1))!.close = -1;
    s.bars(SPOT, D)[0].close = -2;
    s.chainSeries('NIFTY', EXP, D)[0].spot = -3;
    s.chainAt('NIFTY', EXP, t(10, 1))!.rows[0].ce!.ltp = -4;
    expect(s.at(SPOT, t(10, 1))?.close).toBe(25_000);
    expect(s.bars(SPOT, D)[0].close).toBe(25_000);
    expect(s.chainSeries('NIFTY', EXP, D)[0].spot).toBe(25_000);
    expect(s.chainAt('NIFTY', EXP, t(10, 1))?.rows[0].ce?.ltp).toBe(120);
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

  it('writes the valid items of a batch when one item is invalid, then reports it', () => {
    const s = new IntradayFiles({ dataDir: dir });
    const badKey: InstrumentKey = { symbol: 'NIFTY', kind: 'CE', expiry: EXP }; // no strike
    expect(() =>
      s.writeMinutes([
        { key: SPOT, rec: bar(t(10, 0), 25_000) },
        { key: badKey, rec: bar(t(10, 0), 120) },
        { key: FUT_OCT, rec: bar(t(10, 0), 25_100) },
      ]),
    ).toThrow(/invalid strike/);
    const again = new IntradayFiles({ dataDir: dir });
    expect(again.bars(SPOT, D).map((r) => r.close)).toEqual([25_000]);
    expect(again.bars(FUT_OCT, D).map((r) => r.close)).toEqual([25_100]);
    expect(() =>
      s.writeChainMinutes([
        { symbol: 'NIFTY', expiry: 'bad', rec: { ts: t(10, 0), spot: 1, ceOi: 1, peOi: 1, ceVolume: 1, peVolume: 1, pcr: 1, maxPain: null, atmStrike: 1, atmIv: null } },
        { symbol: 'NIFTY', expiry: EXP, rec: { ts: t(10, 0), spot: 1, ceOi: 1, peOi: 1, ceVolume: 1, peVolume: 1, pcr: 1, maxPain: null, atmStrike: 1, atmIv: null } },
        { symbol: 'NIFTY', expiry: EXP, rec: { ts: t(10, 1), spot: Number.NaN } as unknown as ChainMinute },
      ]),
    ).toThrow(/2 chain minute writes failed/);
    expect(again.chainSeries('NIFTY', EXP, D).map((r) => r.ts)).toEqual([t(10, 0)]);
  });

  it('retention keeps exactly retentionDays sessions (today included)', () => {
    const s = new IntradayFiles({ dataDir: dir, retentionDays: 3 });
    for (const d of ['2026-10-01', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-12']) s.writeMinutes([{ key: SPOT, rec: bar(ist(d, 10, 0), 1) }]);
    fs.mkdirSync(path.join(dir, 'market', '2026-10-10', 'bars'), { recursive: true }); // an empty date: not a session
    s.prune('2026-10-12');
    expect(s.sessions()).toEqual(['2026-10-08', '2026-10-09', '2026-10-12']);
    expect(fs.existsSync(path.join(dir, 'market', '2026-10-10'))).toBe(false);
    expect(s.bars(SPOT, '2026-10-07')).toEqual([]);
    // At the start of a day nothing is recorded for it yet: it still counts as one of the sessions.
    s.prune('2026-10-13');
    expect(s.sessions()).toEqual(['2026-10-09', '2026-10-12']);
    s.writeMinutes([{ key: SPOT, rec: bar(ist('2026-10-13', 10, 0), 1) }]);
    expect(s.sessions()).toEqual(['2026-10-09', '2026-10-12', '2026-10-13']);
    new IntradayFiles({ dataDir: dir, retentionDays: 1 }).prune('2026-10-13');
    expect(new IntradayFiles({ dataDir: dir }).sessions()).toEqual(['2026-10-13']);
    new IntradayFiles({ dataDir: dir }).prune('2026-12-31'); // no retention configured: keeps everything
    expect(new IntradayFiles({ dataDir: dir }).sessions()).toEqual(['2026-10-13']);
    expect(() => new IntradayFiles({ dataDir: dir, retentionDays: 2.5 })).toThrow(/integer/);
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
