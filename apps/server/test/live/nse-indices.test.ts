/** ind_close_all_14102025.csv holds the REAL rows quoted in nse-bse-public-data.md §3 (noswear94/quantdata mirror). */
import { describe, expect, it } from 'vitest';
import { fetchIndexCloses, indCloseAllUrl, indexClose, niftyCloseOf, parseIndCloseAll, toDailyBar } from '../../src/live/nse/indices';
import { fixture, testHttp, text } from './nse-fake';

const CSV = fixture('ind_close_all_14102025.csv');

describe('ind_close_all', () => {
  it('maps the official index names to app symbols', () => {
    const f = parseIndCloseAll(CSV, { expectedDate: '2025-10-14' });
    expect(f.date).toBe('2025-10-14');
    expect(f.closes.map((c) => c.symbol)).toEqual(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'INDIAVIX']);
    expect(indexClose(f, 'nifty')).toEqual({
      date: '2025-10-14',
      open: 25277.55,
      high: 25310.35,
      low: 25060.55,
      close: 25145.5,
      volume: 292129083,
      turnover: 241_519_700_000,
      symbol: 'NIFTY',
      name: 'Nifty 50',
      pointsChange: -81.85,
      changePct: -0.32,
      pe: 22.23,
      pb: 3.44,
      divYield: 1.32,
    });
    expect(indexClose(f, 'MIDCPNIFTY')).toMatchObject({ close: 13035.1, changePct: -1.15, divYield: 0.8 });
  });

  it('India VIX: OHLC kept, "-" placeholders stay undefined', () => {
    const vix = indexClose(parseIndCloseAll(CSV), 'INDIAVIX')!;
    expect(vix).toMatchObject({ open: 11.0075, high: 11.6675, low: 10.0125, close: 11.16, pointsChange: 0.15, changePct: 1.34 });
    expect(vix.volume).toBeUndefined();
    expect(vix.turnover).toBeUndefined();
    expect(vix.pe).toBeUndefined();
    expect(toDailyBar(vix)).toEqual({ date: '2025-10-14', open: 11.0075, high: 11.6675, low: 10.0125, close: 11.16 });
  });

  it('matches names exactly (case-insensitive) and ignores look-alikes (CONSTRUCTED rows)', () => {
    const extra = [
      'Nifty Financial Services 25/50,14-10-2025,1,2,0.5,1.5,0,0,0,0,0,0,0',
      'Nifty Financial Services Ex-Bank,14-10-2025,1,2,0.5,1.5,0,0,0,0,0,0,0',
      'NIFTY NEXT 50,14-10-2025,1,2,0.5,1.5,0,0,0,0,0,0,0',
    ];
    const f = parseIndCloseAll(`${CSV.trimEnd()}\n${extra.join('\n')}\n`);
    expect(f.closes.filter((c) => c.symbol === 'FINNIFTY').map((c) => c.close)).toEqual([26828.3]);
    expect(indexClose(f, 'NIFTYNXT50')?.name).toBe('NIFTY NEXT 50');
  });

  it('tolerates BOM/CRLF/reordered columns, names a missing column, rejects another date', () => {
    const lines = CSV.trimEnd().split('\n').map((l) => {
      const c = l.split(',');
      return [c[5], ...c.slice(0, 5), ...c.slice(6)].join(',');
    });
    const moved = parseIndCloseAll('﻿' + lines.join('\r\n'));
    expect(niftyCloseOf(moved)).toEqual({ close: 25145.5, changePct: -0.32 });
    expect(() => parseIndCloseAll(CSV.replace('Closing Index Value', 'Close'), { file: 'ind.csv' })).toThrow('ind.csv: required column "Closing Index Value" is missing');
    expect(() => parseIndCloseAll(CSV, { expectedDate: '2025-10-15' })).toThrow(/expected 2025-10-15/);
  });

  it('a row with a blank OHLC value is skipped, not filled', () => {
    const f = parseIndCloseAll(CSV.replace('Nifty Bank,14-10-2025,56598.65', 'Nifty Bank,14-10-2025,'));
    expect(indexClose(f, 'BANKNIFTY')).toBeUndefined();
    expect(f.skipped).toEqual({ 'missing OHLC': 1 });
  });

  it('fetches the dated file; 404 is not-published', async () => {
    const url = indCloseAllUrl('2025-10-14');
    expect(url).toBe('https://nsearchives.nseindia.com/content/indices/ind_close_all_14102025.csv');
    const ok = testHttp({ [url]: text(CSV) });
    const res = await fetchIndexCloses(ok.http, '2025-10-14');
    expect(res.status === 'ok' && res.data.closes).toHaveLength(5);
    const missing = testHttp({ [url]: text('<html>404</html>', 404) });
    expect(await fetchIndexCloses(missing.http, '2025-10-14')).toMatchObject({ status: 'not-published' });
  });
});
