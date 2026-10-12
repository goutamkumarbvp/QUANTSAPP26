import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FiiDiiDay, ParticipantDay } from '@q26/core';
import { parseFoUdiff } from '../../src/live/nse/bhavcopy';
import { black76Iv, black76Price, timeToExpiry } from '../../src/live/pricing';
import { HistoryFiles, eodAtmIv, type SymbolRow } from '../../src/live/store/history';
import type { DailyFuture, DailyOption, OptKind } from '../../src/live/types';

const ist = (date: string, hh: number, mm: number): number => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - 330 * 60_000;
};
const R = 0.065;

const fut = (symbol: string, date: string, expiry: string, close: number, extra: Partial<DailyFuture> = {}): SymbolRow<DailyFuture> => ({ symbol, date, expiry, close, oi: 1_000_000, volume: 50_000, ...extra });
const optRow = (symbol: string, date: string, expiry: string, strike: number, type: OptKind, close: number, extra: Partial<DailyOption> = {}): SymbolRow<DailyOption> => ({
  symbol,
  date,
  expiry,
  strike,
  type,
  close,
  oi: 100_000,
  volume: 10_000,
  ...extra,
});

/** Option rows of one expiry priced off a known forward with Black-76 (test input). */
function pricedChain(symbol: string, date: string, expiry: string, F: number, vol: (K: number, t: OptKind) => number, strikes: number[]): SymbolRow<DailyOption>[] {
  const T = timeToExpiry(expiry, ist(date, 15, 30));
  return strikes.flatMap((K) => (['CE', 'PE'] as OptKind[]).map((t) => optRow(symbol, date, expiry, K, t, black76Price(t, F, K, T, R, vol(K, t)))));
}

describe('HistoryFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q26-eod-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('persists F&O rows per date and symbol across a restart', () => {
    const a = new HistoryFiles({ dataDir: dir, r: R });
    a.writeFo('2026-10-12', {
      futures: [fut('NIFTY', '2026-10-12', '2026-11-24', 25_300), fut('NIFTY', '2026-10-12', '2026-10-27', 25_150), fut('RELIANCE', '2026-10-12', '2026-10-27', 1_400)],
      options: [optRow('NIFTY', '2026-10-12', '2026-10-20', 25_000, 'CE', 120), optRow('NIFTY', '2026-10-12', '2026-10-27', 25_000, 'PE', 180), optRow('M&M', '2026-10-12', '2026-10-27', 3_200, 'CE', 41)],
    });
    a.writeFo('2026-10-13', { futures: [fut('NIFTY', '2026-10-13', '2026-10-27', 25_200)] });
    // A later write for another symbol (e.g. the BSE file) keeps the NSE rows of that date.
    a.writeFo('2026-10-12', { futures: [fut('SENSEX', '2026-10-12', '2026-10-29', 82_000)] });

    const b = new HistoryFiles({ dataDir: dir, r: R });
    expect(b.loadedDates('fo')).toEqual(['2026-10-12', '2026-10-13']);
    expect(b.dailyFutures('NIFTY', '2026-10-01', '2026-10-31').map((f) => `${f.date}/${f.expiry}/${f.close}`)).toEqual([
      '2026-10-12/2026-10-27/25150',
      '2026-10-12/2026-11-24/25300',
      '2026-10-13/2026-10-27/25200',
    ]);
    expect(b.dailyFutures('NIFTY', '2026-10-13', '2026-10-13')).toHaveLength(1);
    expect(b.dailyFutures('SENSEX', '2026-10-12', '2026-10-12')).toHaveLength(1);
    expect(b.dailyOptions('NIFTY', '2026-10-12')).toHaveLength(2);
    expect(b.dailyOptions('NIFTY', '2026-10-12', '2026-10-27')).toEqual([{ date: '2026-10-12', expiry: '2026-10-27', strike: 25_000, type: 'PE', close: 180, oi: 100_000, volume: 10_000 }]);
    expect(b.dailyOptions('M&M', '2026-10-12')[0].close).toBe(41);
    expect(b.dailyOptions('NIFTY', '2026-10-13')).toEqual([]);
    expect(() => b.writeFo('2026-10-14', { futures: [fut('NIFTY', '2026-10-13', '2026-10-27', 1)] })).toThrow(/dated/);
  });

  it('stores daily bars, FII/DII and participant days', () => {
    const a = new HistoryFiles({ dataDir: dir, r: R });
    a.writeDailyBars('index', '2026-10-12', [{ symbol: 'NIFTY', date: '2026-10-12', open: 24_950, high: 25_080, low: 24_900, close: 25_000 }]);
    a.writeDailyBars('cm', '2026-10-12', [{ symbol: 'RELIANCE', date: '2026-10-12', open: 1_390, high: 1_410, low: 1_385, close: 1_402, volume: 9_000_000, turnover: 1.26e10 }]);
    a.writeDailyBars('cm', '2026-10-13', [{ symbol: 'RELIANCE', date: '2026-10-13', open: 1_402, high: 1_420, low: 1_400, close: 1_415 }]);
    const fii: FiiDiiDay = { date: '2026-10-12', fiiBuy: 12_000, fiiSell: 13_500, fiiNet: -1_500, diiBuy: 14_000, diiSell: 11_000, diiNet: 3_000, niftyClose: 25_000, niftyChangePct: 0.4 };
    a.writeFiiDii(fii);
    const part: ParticipantDay = { date: '2026-10-12', niftyClose: 25_000, rows: [] };
    a.writeParticipants(part);

    const b = new HistoryFiles({ dataDir: dir, r: R });
    expect(b.dailyBars('RELIANCE', '2026-10-01', '2026-10-31').map((x) => x.close)).toEqual([1_402, 1_415]);
    expect(b.dailyBars('RELIANCE', '2026-10-13', '2026-10-13')[0]).toEqual({ date: '2026-10-13', open: 1_402, high: 1_420, low: 1_400, close: 1_415 });
    expect(b.dailyBars('NIFTY', '2026-10-12', '2026-10-12')[0].close).toBe(25_000);
    expect(b.dailyBars('NIFTY', '2026-10-13', '2026-10-31')).toEqual([]);
    expect(b.loadedDates('cm')).toEqual(['2026-10-12', '2026-10-13']);
    expect(b.loadedDates('index')).toEqual(['2026-10-12']);
    expect(b.fiiDii('2026-10-01', '2026-10-31')).toEqual([fii]);
    expect(b.fiiDii('2026-10-13', '2026-10-31')).toEqual([]);
    expect(b.participantOi('2026-10-12', '2026-10-12')).toEqual([part]);
    expect(b.loadedDates('participants')).toEqual(['2026-10-12']);
    expect(b.loadedDates('fiidii')).toEqual(['2026-10-12']);
    expect(b.loadedDates('fo')).toEqual([]);
  });

  it('derives contract settlement from the underlying final settlement price', () => {
    const a = new HistoryFiles({ dataDir: dir, r: R });
    a.writeSettlements([{ symbol: 'NIFTY', expiry: '2026-09-15', price: 23_118.6 }]);
    const b = new HistoryFiles({ dataDir: dir, r: R });
    expect(b.settlement({ symbol: 'NIFTY', kind: 'FUT', expiry: '2026-09-15' })).toBe(23_118.6);
    expect(b.settlement({ symbol: 'NIFTY', kind: 'PE', expiry: '2026-09-15', strike: 25_900 })).toBe(2_781.4);
    expect(b.settlement({ symbol: 'NIFTY', kind: 'CE', expiry: '2026-09-15', strike: 25_900 })).toBe(0);
    expect(b.settlement({ symbol: 'NIFTY', kind: 'CE', expiry: '2026-09-22', strike: 25_900 })).toBeUndefined();
    expect(b.settlement({ symbol: 'NIFTY', kind: 'SPOT' })).toBeUndefined();
  });

  it('solves daily ATM IV from closing premiums (parity forward, traded rows only)', () => {
    const date = '2026-10-12';
    const s = new HistoryFiles({ dataDir: dir, r: R });
    const strikes = [24_800, 24_900, 25_000, 25_100, 25_200];
    const options = [
      ...pricedChain('NIFTY', date, '2026-10-20', 25_040, (K, t) => (K === 25_000 ? (t === 'CE' ? 0.11 : 0.13) : 0.12), strikes),
      // Expiring today: excluded (no day left), even though it traded.
      optRow('NIFTY', date, date, 25_000, 'CE', 5),
      optRow('NIFTY', date, date, 25_000, 'PE', 3),
    ];
    s.writeFo(date, { options });
    s.writeDailyBars('index', date, [{ symbol: 'NIFTY', date, open: 24_900, high: 25_100, low: 24_880, close: 24_905 }]);
    // Underlying 24,905 → parity at 24,900 gives F = 25,040; ATM by forward = 25,000 → (0.11 + 0.13) / 2.
    const out = s.dailyAtmIv('NIFTY', '2026-10-01', '2026-10-31');
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe(date);
    expect(out[0].expiry).toBe('2026-10-20');
    expect(out[0].iv).toBeCloseTo(0.12, 6);
  });

  it('uses the same-expiry future settle as the forward and skips untraded strikes', () => {
    const date = '2026-10-13';
    const strikes = [24_900, 25_000, 25_100];
    const options = pricedChain('BANKNIFTY', date, '2026-10-27', 25_100, () => 0.15, strikes).map((o) =>
      // 25,100 did not trade: NSE prints a carried close and a theoretical settle; neither may be used.
      o.strike === 25_100 ? { ...o, close: 999, volume: 0 } : o,
    );
    const futures = [fut('BANKNIFTY', date, '2026-10-27', 25_090, { settle: 25_100 })];
    const iv = eodAtmIv({ date, underlying: 25_000, options, futures, r: R });
    expect(iv?.expiry).toBe('2026-10-27');
    expect(iv?.iv).toBeCloseTo(0.15, 6); // ATM by forward 25,100 → nearest traded strike 25,000
    expect(eodAtmIv({ date, options: [], futures, r: R })).toBeNull();
  });

  it('caches daily ATM IV on disk and recomputes when inputs change', () => {
    const date = '2026-10-14';
    const s = new HistoryFiles({ dataDir: dir, r: R });
    const T = timeToExpiry('2026-10-20', ist(date, 15, 30));
    // Only calls, no future, no underlying close yet → no forward → nothing (cached as "none").
    const ceOnly = [24_900, 25_000, 25_100].map((K) => optRow('NIFTY', date, '2026-10-20', K, 'CE', black76Price('CE', 25_000 * Math.exp(R * T), K, T, R, 0.14)));
    s.writeFo(date, { options: ceOnly });
    expect(s.dailyAtmIv('NIFTY', date, date)).toEqual([]);
    const cacheFile = path.join(dir, 'eod', 'derived', 'atmiv', 'NIFTY.json');
    expect(JSON.parse(fs.readFileSync(cacheFile, 'utf8'))).toEqual({ r: R, days: { [date]: null } });

    // The index close arrives later: the cached "none" is invalidated and the spot forward is used.
    s.writeDailyBars('index', date, [{ symbol: 'NIFTY', date, open: 25_000, high: 25_000, low: 25_000, close: 25_000 }]);
    const out = s.dailyAtmIv('NIFTY', date, date);
    expect(out).toHaveLength(1);
    expect(out[0].iv).toBeCloseTo(0.14, 6);

    // Served from the disk cache after a restart, even if the option file disappears.
    fs.rmSync(path.join(dir, 'eod', 'fo', date, 'options', 'NIFTY.json'));
    expect(new HistoryFiles({ dataDir: dir, r: R }).dailyAtmIv('NIFTY', date, date)).toEqual(out);
    // A different rate invalidates the whole cache.
    expect(new HistoryFiles({ dataDir: dir, r: 0.07 }).dailyAtmIv('NIFTY', date, date)).toEqual([]);
  });

  it('accepts rows parsed from the official NSE FO bhavcopy sample', () => {
    const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'nse', 'nse-fo-20260101.csv'), 'utf8');
    const file = parseFoUdiff(text, { exchange: 'NSE' });
    const s = new HistoryFiles({ dataDir: dir, r: R });
    s.writeFo(file.date, { futures: file.futures, options: file.options });
    const rows = new HistoryFiles({ dataDir: dir, r: R }).dailyOptions('NIFTY', '2026-01-01');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ expiry: '2026-01-27', strike: 26_200, type: 'CE', close: 284.35, underlying: 26_146.55 });
    expect((rows[0] as unknown as Record<string, unknown>).symbol).toBeUndefined(); // parser metadata is not persisted

    // One call only, no future: forward = UndrlygPric carried at r (source 'spot').
    const T = timeToExpiry('2026-01-27', ist('2026-01-01', 15, 30));
    const expected = black76Iv('CE', 284.35, 26_146.55 * Math.exp(R * T), 26_200, T, R) as number;
    const out = s.dailyAtmIv('NIFTY', '2026-01-01', '2026-01-01');
    expect(out).toEqual([{ date: '2026-01-01', iv: expected, expiry: '2026-01-27' }]);
    expect(expected).toBeGreaterThan(0.05);
    expect(expected).toBeLessThan(0.3);
  });
});
