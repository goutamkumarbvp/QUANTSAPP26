import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { NoLiveData, type InstrumentKey, type LiveQuote, type MinuteRecord } from '../../src/live/types';
import { FakeProvider, loadSampleBook } from './fake-provider';

const providers: FakeProvider[] = [];
afterEach(() => {
  for (const p of providers.splice(0)) p.dispose();
});
const fresh = () => {
  const p = new FakeProvider();
  providers.push(p);
  return p;
};

describe('FakeProvider + loadSampleBook (test data)', () => {
  it('IV solved from the sample premiums gives back the stated vol within 1e-4', () => {
    const p = fresh();
    const book = loadSampleBook(p);
    const cases = [
      { symbol: 'NIFTY', expiry: book.expiries.NIFTY[0], strike: 25000, vol: book.vols.NIFTY },
      { symbol: 'NIFTY', expiry: book.expiries.NIFTY[1], strike: 25000, vol: book.vols.NIFTY },
      { symbol: 'NIFTY', expiry: book.expiries.NIFTY[1], strike: 25100, vol: book.vols.NIFTY },
      { symbol: 'BANKNIFTY', expiry: book.expiries.BANKNIFTY[0], strike: 56000, vol: book.vols.BANKNIFTY },
      { symbol: 'BANKNIFTY', expiry: book.expiries.BANKNIFTY[1], strike: 56000, vol: book.vols.BANKNIFTY },
      { symbol: 'RELIANCE', expiry: book.expiries.RELIANCE[0], strike: 1400, vol: book.vols.RELIANCE },
    ];
    for (const c of cases) {
      for (const type of ['CE', 'PE'] as const) {
        const q = p.live.quote({ symbol: c.symbol, kind: type, expiry: c.expiry, strike: c.strike })!;
        const iv = p.pricing.iv({ symbol: c.symbol, expiry: c.expiry, type, strike: c.strike, premium: q.ltp });
        expect(iv, `${c.symbol} ${c.expiry} ${c.strike} ${type}`).not.toBeNull();
        expect(Math.abs((iv as number) - c.vol), `${c.symbol} ${c.expiry} ${c.strike} ${type}`).toBeLessThan(1e-4);
      }
    }
    expect(Math.abs((p.pricing.atmIv('NIFTY') as number) - book.vols.NIFTY)).toBeLessThan(1e-4);
    // Premiums sit on the ₹0.05 tick.
    const q = p.live.quote({ symbol: 'NIFTY', kind: 'CE', expiry: book.expiries.NIFTY[0], strike: 25000 })!;
    expect(Math.abs(q.ltp * 20 - Math.round(q.ltp * 20))).toBeLessThan(1e-9);
  });

  it('chains come from the set quotes: ~21 strikes, spot, same-expiry future only when listed', async () => {
    const p = fresh();
    const book = loadSampleBook(p);
    const weekly = await p.live.chain('NIFTY', book.expiries.NIFTY[0]);
    expect(weekly.rows.length).toBeGreaterThanOrEqual(19);
    expect(weekly.spot?.ltp).toBe(25000);
    expect(weekly.future).toBeUndefined();
    const monthly = await p.live.chain('NIFTY', book.expiries.NIFTY[1]);
    expect(monthly.future?.ltp).toBe(book.futures[`NIFTY|${book.expiries.NIFTY[1]}`]);
    expect(p.pricing.forward('NIFTY', book.expiries.NIFTY[1]).source).toBe('future');
    expect(p.pricing.forward('NIFTY', book.expiries.NIFTY[0]).source).toBe('parity');
    await expect(p.live.chain('NIFTY', '2026-12-29')).rejects.toMatchObject({ statusCode: 404 });
    p.ref.setStrikes('NIFTY', '2026-12-29', [25000]);
    await expect(p.live.chain('NIFTY', '2026-12-29')).rejects.toThrow(NoLiveData);
  });

  it('setQuote merges and fires onTick; the clock is settable', () => {
    const p = fresh();
    loadSampleBook(p);
    const ticks: LiveQuote[] = [];
    p.live.onTick((q) => ticks.push(q));
    p.advance(1000);
    p.setQuote({ symbol: 'nifty', kind: 'SPOT' }, { ltp: 25010 });
    expect(ticks).toHaveLength(1);
    expect(p.live.quote({ symbol: 'NIFTY', kind: 'SPOT' })).toMatchObject({ ltp: 25010, prevClose: 24900, ts: p.now() });
    expect(p.clock.info()).toMatchObject({ date: '2026-10-12', status: 'open', time: '11:00' });
  });

  it('one recorded session: minute bars, chain aggregates, as-of chains and candles', async () => {
    const p = fresh();
    const book = loadSampleBook(p);
    const d = book.recordedDate;
    expect(p.intraday.sessions()).toEqual([d]);
    expect(p.intraday.bars({ symbol: 'NIFTY', kind: 'SPOT' }, d)).toHaveLength(375);
    const series = p.intraday.chainSeries('NIFTY', book.expiries.NIFTY[0], d);
    expect(series).toHaveLength(375);
    expect(series[0].atmIv).not.toBeNull();
    expect(Math.abs((series[0].atmIv as number) - book.vols.NIFTY)).toBeLessThan(1e-3);
    const asOf = p.intraday.chainAt('NIFTY', book.expiries.NIFTY[0], p.calendar.ts(d, 60));
    expect(asOf?.rows.length).toBeGreaterThan(15);
    expect(asOf?.spot?.ts).toBe(p.calendar.ts(d, 59));
    expect(await p.candles({ symbol: 'NIFTY', kind: 'SPOT' }, '1min', d, d)).toHaveLength(375);
    expect(await p.candles({ symbol: 'NIFTY', kind: 'SPOT' }, '5min', d, d)).toHaveLength(75);
    const daily = await p.candles({ symbol: 'NIFTY', kind: 'SPOT' }, 'D', '2026-10-01', '2026-10-12');
    expect(daily).toHaveLength(5);
    expect(daily[0].volume).toBeUndefined();
    await expect(p.candles({ symbol: 'NIFTY', kind: 'SPOT' }, '1min', '2026-10-12', '2026-10-12')).rejects.toThrow(/not recorded/);
  });

  it('src/ never imports the test-only provider (or anything else under test/)', () => {
    const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) walk(f);
        else if (/\.ts$/.test(e.name) && /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"](?:[^'"]*\/)?test\//.test(fs.readFileSync(f, 'utf8'))) offenders.push(f);
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});

describe('FakeProvider keeps the real provider rules (review)', () => {
  const SPOT: InstrumentKey = { symbol: 'NIFTY', kind: 'SPOT' };

  it("serves only quotes of a live session; a new session date starts the quote afresh", () => {
    const p = fresh();
    const book = loadSampleBook(p); // Monday 11:00 IST
    const fri = p.calendar.prev(book.date);
    const friClose = p.calendar.ts(fri, 374);
    p.setQuote({ symbol: 'RELIANCE', kind: 'FUT', expiry: book.expiries.RELIANCE[0] }, { ltp: 1, ts: friClose }); // older day: no effect on today's
    expect(p.live.quote({ symbol: 'RELIANCE', kind: 'FUT', expiry: book.expiries.RELIANCE[0] })?.ltp).toBe(book.futures[`RELIANCE|${book.expiries.RELIANCE[0]}`]);
    const k: InstrumentKey = { symbol: 'NIFTY', kind: 'CE', expiry: book.expiries.NIFTY[0], strike: 26500 };
    p.ref.setStrikes('NIFTY', book.expiries.NIFTY[0], [26500]);
    p.setQuote(k, { ltp: 2.5, prevOi: 1000, bid: 2.45, ts: friClose });
    expect(p.live.quote(k)).toBeUndefined(); // Friday's quote during Monday's session
    p.setNow(p.calendar.ts(book.date, 0) - 30 * 60_000); // Monday 08:45: Friday is the last session
    expect(p.live.quote(k)).toMatchObject({ ltp: 2.5, ts: friClose });
    p.setNow(book.now);
    p.setQuote(k, { ltp: 3 });
    expect(p.live.quote(k)).toEqual({ key: k, ts: book.now, ltp: 3 }); // no Friday prevOi/bid
    expect(p.live.quote(SPOT)?.ltp).toBe(25000);
  });

  it('as-of chains: weekly expiry falls back to the nearest recorded future; ATP and total buy/sell carried', () => {
    const p = fresh();
    const d = '2026-10-09';
    const m28 = p.calendar.ts(d, 28);
    const rec = (close: number, extra: Partial<MinuteRecord> = {}): MinuteRecord => ({ ts: m28, open: close, high: close, low: close, close, traded: true, ...extra });
    p.intraday.addMinutes({ symbol: 'NIFTY', kind: 'CE', expiry: '2026-10-13', strike: 25000 }, [rec(120)]);
    p.intraday.addMinutes({ symbol: 'NIFTY', kind: 'FUT', expiry: '2026-09-29' }, [rec(24990)]); // expired by then: not used
    p.intraday.addMinutes({ symbol: 'NIFTY', kind: 'FUT', expiry: '2026-11-24' }, [rec(25180)]);
    p.intraday.addMinutes({ symbol: 'NIFTY', kind: 'FUT', expiry: '2026-10-27' }, [rec(25080, { atp: 25070, totalBuyQty: 100, totalSellQty: 200 })]);
    const c = p.intraday.chainAt('NIFTY', '2026-10-13', p.calendar.ts(d, 30))!;
    expect(c.future).toMatchObject({ key: { symbol: 'NIFTY', kind: 'FUT', expiry: '2026-10-27' }, ltp: 25080, atp: 25070, totalBuyQty: 100, totalSellQty: 200 });
  });

  it('minute records: `traded` is required and two records of one minute merge', () => {
    const p = fresh();
    const ts = p.calendar.ts('2026-10-09', 10);
    expect(() => p.intraday.addMinutes(SPOT, [{ ts, open: 1, high: 1, low: 1, close: 1 } as MinuteRecord])).toThrow(/invalid minute record/);
    const key: InstrumentKey = { symbol: 'NIFTY', kind: 'FUT', expiry: '2026-10-27' };
    p.intraday.addMinutes(key, [{ ts, open: 10, high: 12, low: 9, close: 11, traded: true, volume: 100 }]);
    p.intraday.addMinutes(key, [{ ts, open: 11, high: 13, low: 10, close: 12, traded: false }]);
    expect(p.intraday.bars(key, '2026-10-09')).toEqual([{ ts, open: 10, high: 13, low: 9, close: 12, traded: true, volume: 100 }]);
  });

  it('setUserContracts is part of the provider; candles reject a bad request like LiveProvider', async () => {
    const p = fresh();
    const k: InstrumentKey = { symbol: 'NIFTY', kind: 'CE', expiry: '2026-10-13', strike: 25000 };
    p.setUserContracts(() => [k, { key: SPOT, level: 'depth' }]);
    expect(p.userContracts()).toEqual([k, { key: SPOT, level: 'depth' }]);
    p.setUserContracts(null);
    expect(p.userContracts()).toEqual([]);
    await expect(p.candles(SPOT, '1min', '2026-10-12', '2026-10-09')).rejects.toMatchObject({ statusCode: 400 });
    await expect(p.candles({ symbol: 'NIFTY', kind: 'FUT' }, '1min', '2026-10-09', '2026-10-09')).rejects.toMatchObject({ statusCode: 400 });
  });
});
