/**
 * Fixtures nse-fo-20260915.csv, nse-fo-20260101.csv and bse-fo-20260430.csv hold REAL rows quoted in
 * docs/live-data/research/nse-bse-public-data.md (sample-rows.txt: snowjug/Trading-Bot, AvilPage,
 * chintanmehta21/OptionsScraper mirrors of the official files). Rows built inside this file are
 * marked CONSTRUCTED: they only exercise the parser and are not market data.
 */
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  buildSettlementLookup,
  bseFoBhavcopyUrl,
  checkVolumeUnit,
  fetchBseFoBhavcopy,
  fetchNseCmBhavcopy,
  fetchNseFoBhavcopy,
  nseCmBhavcopyUrl,
  nseFoBhavcopyUrl,
  parseCmUdiff,
  parseFoUdiff,
  underlyingCloses,
} from '../../src/live/nse/bhavcopy';
import { csvRecords } from '../../src/live/nse/http';
import { fixture, testHttp, text } from './nse-fake';

const NSE_0915 = fixture('nse-fo-20260915.csv');
const NSE_0101 = fixture('nse-fo-20260101.csv');
const BSE_0430 = fixture('bse-fo-20260430.csv');
const HEADER = NSE_0915.split('\n')[0];

describe('NSE F&O UDiFF bhavcopy', () => {
  it('has the documented 34-column header', () => {
    expect(HEADER.split(',')).toHaveLength(34);
    expect(BSE_0430.split('\n')[0]).toBe(HEADER);
  });

  it('maps a regular option row: OI in units, volume contracts × NewBrdLotQty', () => {
    const f = parseFoUdiff(NSE_0915, { exchange: 'NSE' });
    expect(f.date).toBe('2026-09-15');
    expect(f.volumeUnit).toBe('contracts');
    expect(f.volumeUnitCheck).toEqual({ verdict: 'contracts', contractsVotes: 1, unitsVotes: 0 });
    const row = f.options.find((o) => o.expiry === '2026-09-29');
    expect(row).toEqual({
      date: '2026-09-15',
      expiry: '2026-09-29',
      strike: 26500,
      type: 'PE',
      close: 3252.8,
      settle: 3252.8,
      oi: 842790,
      oiChange: -1690,
      volume: 84 * 65,
      underlying: 23118.6,
      symbol: 'NIFTY',
      exchange: 'NSE',
      instrument: 'IDO',
      lotSize: 65,
      contracts: 84,
      trades: 79,
      open: 2980,
      high: 3315,
      low: 2978.15,
      last: 3252.65,
      prevClose: 3008,
      turnover: 161887696.75,
      token: '74482',
      tradingSymbol: 'NIFTY26SEP26500PE',
      expiryDay: false,
    });
  });

  it('expiry-day row: keeps the (untraded) close, drops SttlmPric as option settle, records the underlying settlement', () => {
    const f = parseFoUdiff(NSE_0915, { exchange: 'NSE' });
    const row = f.options.find((o) => o.expiry === '2026-09-15')!;
    expect(row).toMatchObject({ strike: 25900, type: 'PE', close: 1387.75, oi: 0, volume: 0, trades: 0, expiryDay: true, tradingSymbol: 'NIFTY2691525900PE' });
    expect(row.settle).toBeUndefined();
    // 0.00 OHLC/last of an untraded row are absent, never zero prices.
    expect(row.open).toBeUndefined();
    expect(row.high).toBeUndefined();
    expect(row.last).toBeUndefined();
    expect(f.finalSettlements).toEqual([{ symbol: 'NIFTY', expiry: '2026-09-15', price: 23118.6 }]);
  });

  it('builds a settlement lookup from the expiry-day file (provisional)', () => {
    const lookup = buildSettlementLookup([parseFoUdiff(NSE_0915, { exchange: 'NSE' })]);
    expect(lookup.size).toBe(1);
    expect(lookup.underlying('nifty', '2026-09-15')).toBe(23118.6);
    expect(lookup.settlement({ symbol: 'NIFTY', kind: 'PE', expiry: '2026-09-15', strike: 25900 })).toBe(2781.4);
    expect(lookup.settlement({ symbol: 'NIFTY', kind: 'CE', expiry: '2026-09-15', strike: 23000 })).toBe(118.6);
    expect(lookup.settlement({ symbol: 'NIFTY', kind: 'CE', expiry: '2026-09-15', strike: 25900 })).toBe(0);
    expect(lookup.settlement({ symbol: 'NIFTY', kind: 'FUT', expiry: '2026-09-15' })).toBe(23118.6);
    expect(lookup.settlement({ symbol: 'NIFTY', kind: 'PE', expiry: '2026-09-29', strike: 25900 })).toBeUndefined();
    expect(lookup.settlement({ symbol: 'NIFTY', kind: 'SPOT' })).toBeUndefined();
  });

  it('a settlement that two files disagree on is left undefined', () => {
    const lookup = buildSettlementLookup([
      { finalSettlements: [{ symbol: 'NIFTY', expiry: '2026-09-15', price: 23118.6 }] },
      { finalSettlements: [{ symbol: 'NIFTY', expiry: '2026-09-15', price: 23118.7 }] },
    ]);
    expect(lookup.underlying('NIFTY', '2026-09-15')).toBeUndefined();
  });

  it('turnover check confirms contracts on the 2026-01-01 row (31834 × 65 × ~26484 ≈ TtlTrfVal)', () => {
    const f = parseFoUdiff(NSE_0101, { exchange: 'NSE', expectedDate: '2026-01-01' });
    expect(f.volumeUnitCheck.verdict).toBe('contracts');
    expect(f.options).toHaveLength(1);
    expect(f.options[0]).toMatchObject({ strike: 26200, type: 'CE', close: 284.35, settle: 284.35, oi: 2032615, oiChange: 13650, volume: 31834 * 65, contracts: 31834, underlying: 26146.55, trades: 20103 });
  });

  it('refuses an explicit volume unit that the turnover check contradicts', () => {
    expect(() => parseFoUdiff(NSE_0101, { exchange: 'NSE', volumeUnit: 'units' })).toThrow(/looks like contracts/);
  });

  it('maps a future row (CONSTRUCTED row) and skips a contracts volume without lot size', () => {
    const csv = [
      HEADER,
      // CONSTRUCTED: NIFTY future, 100 contracts × 65 × 23180 = 150,670,000 turnover.
      '2026-09-15,2026-09-15,FO,NSE,IDF,99001,,NIFTY,,2026-09-29,2026-09-29,,,NIFTY26SEPFUT,23100.0,23250.0,23050.0,23200.0,23195.0,23150.0,23118.6,23210.0,65000,650,100,150670000.0,90,F1,65,,,,,',
      // CONSTRUCTED: stock future without NewBrdLotQty.
      '2026-09-15,2026-09-15,FO,NSE,STF,99002,,AAA,,2026-09-29,2026-09-29,,,AAA26SEPFUT,10.0,11.0,9.0,10.5,10.5,10.0,10.4,10.5,1000,0,3,0.0,1,F1,,,,,,',
    ].join('\n');
    const f = parseFoUdiff(csv, { exchange: 'NSE' });
    expect(f.futures).toEqual([
      expect.objectContaining({ date: '2026-09-15', expiry: '2026-09-29', close: 23200, settle: 23210, oi: 65000, oiChange: 650, volume: 6500, contracts: 100, underlying: 23118.6, instrument: 'IDF', symbol: 'NIFTY' }),
    ]);
    expect(f.options).toEqual([]);
    expect(f.skipped).toEqual({ 'volume in contracts without lot size': 1 });
  });

  it('tolerates BOM, CRLF, quoted fields, reordered and unknown columns', () => {
    const recs = csvRecords(NSE_0915);
    const shuffled = recs.map((r, i) => [i === 0 ? 'SomeNewColumn' : 'x', ...[...r].reverse()]);
    const csv = '﻿' + shuffled.map((r) => r.map((c) => `"${c}"`).join(',')).join('\r\n') + '\r\n';
    expect(parseFoUdiff(csv, { exchange: 'NSE' })).toEqual(parseFoUdiff(NSE_0915, { exchange: 'NSE' }));
  });

  it('names a missing required column', () => {
    const csv = NSE_0915.replace('OpnIntrst', 'OpenInterest');
    expect(() => parseFoUdiff(csv, { exchange: 'NSE', file: 'fo.csv' })).toThrow('fo.csv: required column "OpnIntrst" is missing');
  });

  it('needs NewBrdLotQty when volume is in contracts (else only untraded rows would survive)', () => {
    const csv = NSE_0915.replace('NewBrdLotQty', 'LotSize');
    expect(() => parseFoUdiff(csv, { exchange: 'NSE', file: 'fo.csv' })).toThrow('fo.csv: required column "NewBrdLotQty" is missing');
    // BSE volume is in units, so the lot size is optional there.
    expect(parseFoUdiff(BSE_0430.replace('NewBrdLotQty', 'LotSize'), { exchange: 'BSE' }).options).toHaveLength(1);
  });

  it('rejects a file of another date and skips rows of another exchange', () => {
    expect(() => parseFoUdiff(NSE_0915, { exchange: 'NSE', expectedDate: '2026-09-16' })).toThrow(/dated 2026-09-15, expected 2026-09-16/);
    expect(() => parseFoUdiff(NSE_0915, { exchange: 'BSE' })).toThrow(/no usable data rows/);
  });

  it('filters by symbol', () => {
    expect(parseFoUdiff(NSE_0915, { exchange: 'NSE', symbols: ['banknifty'] }).options).toEqual([]);
    expect(parseFoUdiff(NSE_0915, { exchange: 'NSE', symbols: ['nifty'] }).options).toHaveLength(2);
  });
});

describe('BSE F&O UDiFF bhavcopy (SENSEX/BANKEX)', () => {
  it('infers TtlTradgVol in units from turnover (2940 × ~79,970 ≈ 234.3 M) and maps the row', () => {
    const f = parseFoUdiff(BSE_0430, { exchange: 'BSE' });
    expect(f.volumeUnitCheck).toEqual({ verdict: 'units', contractsVotes: 0, unitsVotes: 1 });
    expect(f.volumeUnit).toBe('units');
    expect(f.options).toEqual([
      expect.objectContaining({ date: '2026-04-30', expiry: '2026-06-25', strike: 78000, type: 'CE', close: 1969.3, settle: 1969.3, oi: 2320, oiChange: 1860, volume: 2940, contracts: 147, lotSize: 20, underlying: 76913.5, exchange: 'BSE', symbol: 'SENSEX', expiryDay: false }),
    ]);
    expect(underlyingCloses(f)).toEqual(new Map([['SENSEX', 76913.5]]));
  });

  it('skips an expiring option whose close equals the underlying settlement (CONSTRUCTED row per §9 quirk)', () => {
    // CONSTRUCTED from the §9 description: ClsPric = SttlmPric = UndrlygPric = 76913.50 on expiry day.
    const row = '2026-04-30,2026-04-30,FO,BSE,IDO,800001,,SENSEX,,2026-04-30,2026-04-30,75200.00,CE,SENSEX26APR75200CE,0.00,0.00,0.00,76913.50,0.00,1700.00,76913.50,76913.50,0,0,0,0.00,0,F1,20,,,,,';
    const f = parseFoUdiff(`${BSE_0430.trimEnd()}\n${row}\n`, { exchange: 'BSE' });
    expect(f.options.map((o) => o.tradingSymbol)).toEqual(['SENSEX26JUN78000CE']);
    expect(f.skipped).toEqual({ 'expiry-day close equals the underlying settlement': 1 });
    expect(f.finalSettlements).toEqual([{ symbol: 'SENSEX', expiry: '2026-04-30', price: 76913.5 }]);
    expect(buildSettlementLookup([f]).settlement({ symbol: 'SENSEX', kind: 'CE', expiry: '2026-04-30', strike: 75200 })).toBe(1713.5);
  });

  it('falls back to the documented unit when the turnover check is inconclusive', () => {
    const noTurnover = BSE_0430.replace('234310908.00', '0.00');
    expect(parseFoUdiff(noTurnover, { exchange: 'BSE' })).toMatchObject({ volumeUnit: 'units', volumeUnitCheck: { verdict: 'inconclusive' } });
  });
});

describe('checkVolumeUnit', () => {
  it('needs a lot ≥ 2 and turnover to vote', () => {
    expect(checkVolumeUnit([{ volume: 10, lot: 1, turnover: 1000, price: 100 }]).verdict).toBe('inconclusive');
    expect(checkVolumeUnit([{ volume: 10, lot: 50, turnover: 50_000, price: 100 }]).verdict).toBe('contracts');
    expect(checkVolumeUnit([{ volume: 10, lot: 50, turnover: 1_000, price: 100 }]).verdict).toBe('units');
  });
});

describe('NSE CM UDiFF bhavcopy', () => {
  // CONSTRUCTED rows on the UDiFF header (the CM file shares it, critic R10 / nselib column map).
  const cm = [
    HEADER,
    '2026-09-15,2026-09-15,CM,NSE,STK,1001,INE000A00001,AAA,EQ,,,,,AAA LIMITED,100.00,110.00,95.00,105.00,104.50,99.00,,,,,12345,1296000.00,321,F1,1,,,,,',
    '2026-09-15,2026-09-15,CM,NSE,STK,1002,INE000A00002,BBB,BE,,,,,BBB LIMITED,50.00,51.00,49.00,50.50,50.50,50.00,,,,,10,505.00,2,F1,1,,,,,',
    '2026-09-15,2026-09-15,CM,NSE,STK,1003,INE000A00003,CCC,EQ,,,,,CCC LIMITED,0.00,0.00,0.00,70.00,0.00,70.00,,,,,0,0.00,0,F1,1,,,,,',
  ].join('\n');

  it('maps EQ rows to DailyBar (volume shares, turnover ₹) and skips untraded rows', () => {
    const f = parseCmUdiff(cm, { expectedDate: '2026-09-15' });
    expect(f.date).toBe('2026-09-15');
    expect(f.bars).toEqual([
      { date: '2026-09-15', open: 100, high: 110, low: 95, close: 105, volume: 12345, turnover: 1296000, symbol: 'AAA', series: 'EQ', isin: 'INE000A00001', prevClose: 99, last: 104.5, trades: 321 },
    ]);
    expect(f.skipped).toEqual({ 'untraded or missing OHLC': 1 });
    expect(parseCmUdiff(cm, { series: ['EQ', 'BE'] }).bars.map((b) => b.symbol)).toEqual(['AAA', 'BBB']);
  });

  it('names a missing required column', () => {
    expect(() => parseCmUdiff(cm.replace('SctySrs', 'Series'))).toThrow(/required column "SctySrs"/);
  });
});

describe('bhavcopy fetchers', () => {
  it('NSE F&O: zip from nsearchives, parsed for the requested date', async () => {
    const url = nseFoBhavcopyUrl('2026-09-15');
    expect(url).toBe('https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_20260915_F_0000.csv.zip');
    const zip = zipSync({ 'BhavCopy_NSE_FO_0_0_0_20260915_F_0000.csv': strToU8(NSE_0915) });
    const { http } = testHttp({ [url]: text(zip) });
    const res = await fetchNseFoBhavcopy(http, '2026-09-15');
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.data.options).toHaveLength(2);
  });

  it('NSE F&O: 404 is not-published; legacy dates are refused', async () => {
    const url = nseFoBhavcopyUrl('2026-10-12');
    const { http, calls } = testHttp({ [url]: text('', 404) });
    expect(await fetchNseFoBhavcopy(http, '2026-10-12')).toEqual({ status: 'not-published', url, httpStatus: 404 });
    expect(calls).toHaveLength(1);
    await expect(fetchNseFoBhavcopy(http, '2024-07-05')).rejects.toMatchObject({ kind: 'unsupported' });
  });

  it('NSE CM: zip URL per critic R10', async () => {
    const url = nseCmBhavcopyUrl('2026-09-15');
    expect(url).toBe('https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_20260915_F_0000.csv.zip');
    const csv = `${HEADER}\n2026-09-15,2026-09-15,CM,NSE,STK,1001,INE000A00001,AAA,EQ,,,,,AAA LIMITED,100.00,110.00,95.00,105.00,104.50,99.00,,,,,12345,1296000.00,321,F1,1,,,,,\n`;
    const { http } = testHttp({ [url]: text(zipSync({ 'BhavCopy_NSE_CM_0_0_0_20260915_F_0000.csv': strToU8(csv) })) });
    const res = await fetchNseCmBhavcopy(http, '2026-09-15');
    expect(res.status === 'ok' && res.data.bars.map((b) => b.symbol)).toEqual(['AAA']);
  });

  it('BSE F&O: plain CSV from www.bseindia.com, no host fallback', async () => {
    const url = bseFoBhavcopyUrl('2026-04-30');
    expect(url).toBe('https://www.bseindia.com/download/Bhavcopy/Derivative/BhavCopy_BSE_FO_0_0_0_20260430_F_0000.CSV');
    const { http, calls } = testHttp({ [url]: text(BSE_0430) });
    const res = await fetchBseFoBhavcopy(http, '2026-04-30');
    expect(res.status === 'ok' && res.data.options[0].symbol).toBe('SENSEX');
    expect(calls).toHaveLength(1);
  });
});
