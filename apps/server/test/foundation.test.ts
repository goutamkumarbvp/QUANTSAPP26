/**
 * Phase C foundation: shared live helpers (services/live.ts), the pricer and option-chain building,
 * on the TEST-ONLY FakeProvider with the sample book (inputs constructed here; tests only).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { istTs } from '@q26/core';
import { NoLiveData, type InstrumentKey } from '../src/live/types';
import {
  BOOK_MAX_AGE_MS,
  buildOptionChain,
  candles,
  currentSession,
  expiryCycle,
  feedStatus,
  futKey,
  futuresQuotes,
  futuresQuotesAt,
  Gaps,
  liveBook,
  nearFuture,
  optKey,
  parseInterval,
  recordedExpiries,
  requireDate,
  requireRecorded,
  saneMid,
  spotKey,
  underlyingQuote,
  underlyingQuoteAt,
  UserWatches,
} from '../src/services/live';
import { parseFoUdiff } from '../src/live/nse/bhavcopy';
import { Pricer } from '../src/services/pricer';
import { fixture } from './live/nse-fake';
import { FakeProvider, loadSampleBook, type SampleBook } from './support/fake-provider';

const providers: FakeProvider[] = [];
afterEach(() => {
  for (const p of providers.splice(0)) p.dispose();
});
function setup(opts: Parameters<typeof loadSampleBook>[1] = {}): { p: FakeProvider; book: SampleBook } {
  const p = new FakeProvider();
  providers.push(p);
  const book = loadSampleBook(p, opts);
  return { p, book };
}
const at = (date: string, hhmm: string) => istTs(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)));

/** Writes official F&O rows of `date` for the NIFTY weekly chain priced like the live book (TEST DATA). */
function writePrevOptions(p: FakeProvider, book: SampleBook, date: string, opts: { volume?: number; oiFactor?: number } = {}) {
  const expiry = book.expiries.NIFTY[0];
  const rows = p.ref.strikes('NIFTY', expiry).flatMap((strike) =>
    (['CE', 'PE'] as const).flatMap((type) => {
      const q = p.live.quote(optKey('NIFTY', expiry, type, strike));
      if (!q) return [];
      return [{ symbol: 'NIFTY', date, expiry, strike, type, close: q.ltp, oi: Math.round((q.oi as number) * (opts.oiFactor ?? 0.9)), volume: opts.volume ?? 1500, lotSize: 75 }];
    }),
  );
  p.history.writeFo(date, { options: rows });
}

describe('keys, dates and gaps', () => {
  it('builds canonical keys and labels', () => {
    expect(spotKey(' nifty ')).toEqual({ symbol: 'NIFTY', kind: 'SPOT' });
    expect(futKey('nifty', '2026-10-27')).toEqual({ symbol: 'NIFTY', kind: 'FUT', expiry: '2026-10-27' });
    expect(optKey('nifty', '2026-10-13', 'CE', 25000)).toEqual({ symbol: 'NIFTY', kind: 'CE', expiry: '2026-10-13', strike: 25000 });
  });

  it('current session, requireDate and recorded-session checks', () => {
    const { p, book } = setup();
    expect(currentSession(p)).toBe(book.date);
    p.setNow(at(book.date, '09:05')); // pre-open: the last session is the previous trading day
    expect(currentSession(p)).toBe(book.recordedDate);
    p.setNow(at('2026-10-17', '11:00')); // Saturday
    expect(currentSession(p)).toBe('2026-10-16');
    p.setNow(book.now);
    expect(requireDate(p)).toBe(book.date);
    expect(requireDate(p, '2026-10-09')).toBe('2026-10-09');
    expect(() => requireDate(p, '2026-10-10')).toThrow(/not a trading day/);
    expect(() => requireDate(p, '2026-10-13')).toThrow(/in the future/);
    expect(() => requireDate(p, '12-10-2026')).toThrow(/YYYY-MM-DD/);
    expect(() => requireRecorded(p, book.recordedDate)).not.toThrow();
    expect(() => requireRecorded(p, '2026-10-08')).toThrow(new NoLiveData(`No recorded data for 2026-10-08 — recording started ${book.recordedDate}`));
  });

  it('Gaps collect NoLiveData reasons and pass other errors on', () => {
    const g = new Gaps();
    expect(g.try('a', () => 1)).toBe(1);
    expect(
      g.try('b', () => {
        throw new NoLiveData('no b');
      }),
    ).toBeNull();
    expect(() =>
      g.try('c', () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(g.out()).toEqual({ gaps: { b: 'no b' } });
    expect(new Gaps().out()).toEqual({});
  });

  it('expiry cycle is derived from the listed expiries', () => {
    expect(expiryCycle(['2026-10-13', '2026-10-20', '2026-10-27'])).toBe('weekly');
    expect(expiryCycle(['2026-10-27', '2026-11-24'])).toBe('monthly');
    expect(expiryCycle(['2026-10-27'])).toBeNull();
  });

  it('feed status reports health, master, recording and EOD dates (no secrets)', () => {
    const { p, book } = setup();
    const f = feedStatus(p);
    expect(f).toMatchObject({ loggedIn: true, connected: true, refdataReady: true, recordingSince: book.recordedDate });
    expect(f.eod.index).toBe(book.recordedDate);
    expect(f.eod.fo).toBeNull();
    p.ref.setLoaded(false);
    expect(feedStatus(p).refdataReady).toBe(false);
  });

  it('user watches expire after their TTL and keep the deepest level', () => {
    let t = 0;
    const w = new UserWatches(() => t);
    const k: InstrumentKey = { symbol: 'NIFTY', kind: 'FUT', expiry: '2026-10-27' };
    w.touch([k], 'depth', 1000);
    w.touch([k], 'quote', 2000);
    expect(w.list()).toEqual([{ key: k, level: 'depth' }]);
    t = 2500;
    expect(w.list()).toEqual([]);
  });
});

describe('live prices and books', () => {
  it('a book is live only in the open session and while fresh; a mid only with a sane spread', () => {
    const { p, book } = setup();
    const q = p.live.quote(futKey('NIFTY', book.expiries.NIFTY[1]))!;
    expect(liveBook(p, q)).toMatchObject({ bid: q.bid, ask: q.ask });
    expect(liveBook(p, q, q.ts + BOOK_MAX_AGE_MS + 1)).toBeNull();
    expect(liveBook(p, q, at(book.date, '15:45'))).toBeNull();
    expect(saneMid({ bid: 100, ask: 101 })).toBe(100.5);
    expect(saneMid({ bid: 0.05, ask: 0.1 })).toBeNull();
    expect(saneMid({ bid: 101, ask: 100 })).toBeNull();
  });

  it('underlying quote: live spot, change vs previous close, near future and solved ATM IV', () => {
    const { p, book } = setup();
    const q = underlyingQuote(p, 'NIFTY');
    expect(q).toMatchObject({ symbol: 'NIFTY', ltp: 25000, prevClose: 24900, change: 100, changePct: 0.4, open: 24950, high: 25050, low: 24920 });
    expect(q.future).toBe(book.futures[`NIFTY|${book.expiries.NIFTY[1]}`]);
    expect(q.futureExpiry).toBe(book.expiries.NIFTY[1]);
    expect(q.futureChange).toBeNull(); // no previous close of the future anywhere
    expect(Math.abs((q.atmIv as number) - 14)).toBeLessThan(0.01);
  });

  it('underlying quote takes the previous close from the official file when the feed has none', () => {
    const { p, book } = setup();
    p.live.clearQuote(spotKey('NIFTY'));
    p.setQuote(spotKey('NIFTY'), { ltp: 25010 });
    const q = underlyingQuote(p, 'NIFTY');
    const official = p.history.dailyBars('NIFTY', book.recordedDate, book.recordedDate)[0].close;
    expect(q.prevClose).toBe(official);
    expect(q.open).toBeNull();
    expect(q.change).toBeCloseTo(25010 - official, 2);
  });

  it('underlying quote: NoLiveData without a live spot (none, or only an older session) and 404 for unknown', () => {
    const { p, book } = setup();
    p.live.clearQuote(spotKey('NIFTY'));
    expect(() => underlyingQuote(p, 'NIFTY')).toThrow(NoLiveData);
    p.setQuote(spotKey('NIFTY'), { ltp: 24900, ts: at(book.recordedDate, '15:29') });
    expect(() => underlyingQuote(p, 'NIFTY')).toThrow(NoLiveData);
    expect(() => underlyingQuote(p, 'NOPE')).toThrow(/Unknown symbol/);
  });

  it('as-of underlying quote comes from recorded minutes only', () => {
    const { p, book } = setup();
    const t = at(book.recordedDate, '12:00');
    const q = underlyingQuoteAt(p, 'NIFTY', t);
    const rec = p.intraday.at(spotKey('NIFTY'), t)!;
    expect(q.ltp).toBe(rec.close);
    expect(q.ts).toBe(t);
    expect(q.future).toBe(p.intraday.at(futKey('NIFTY', book.expiries.NIFTY[1]), t)!.close);
    expect(q.atmIv).not.toBeNull();
    expect(() => underlyingQuoteAt(p, 'NIFTY', at('2026-10-08', '12:00'))).toThrow(/recording started/);
  });

  it('near future and recorded expiries', () => {
    const { p, book } = setup();
    expect(nearFuture(p, 'BANKNIFTY')).toBe(book.expiries.BANKNIFTY[0]);
    expect(nearFuture(p, 'BANKNIFTY', at(book.expiries.BANKNIFTY[0], '15:31'))).toBe(book.expiries.BANKNIFTY[1]);
    expect(recordedExpiries(p, 'NIFTY', at(book.recordedDate, '12:00'))).toEqual({ options: [book.expiries.NIFTY[0]], futures: [book.expiries.NIFTY[1]] });
  });
});

describe('option chain', () => {
  it('solves IV back from the sample premiums, parity forward on the weekly, future on the monthly', async () => {
    const { p, book } = setup();
    const c = await buildOptionChain(p, 'NIFTY');
    expect(c.expiry).toBe(book.expiries.NIFTY[0]);
    expect(c.expiries).toEqual(book.expiries.NIFTY);
    expect(c.forwardSource).toBe('parity');
    expect(c.spot).toBe(25000);
    expect(c.rows.length).toBe(21);
    expect(c.atm).toBe(25000);
    expect(Math.abs((c.atmIv as number) - 14)).toBeLessThan(0.01);
    for (const row of c.rows.filter((r) => Math.abs(r.strike - 25000) <= 300)) {
      for (const leg of [row.ce, row.pe]) {
        expect(leg.ivSource).toBe('mid');
        expect(Math.abs((leg.iv as number) - 14), `${row.strike}`).toBeLessThan(0.05);
        expect(leg.delta).not.toBeNull();
        expect(leg.bid).not.toBeNull();
      }
    }
    const atmRow = c.rows.find((r) => r.strike === 25000)!;
    expect(atmRow.ce.delta as number).toBeGreaterThan(0.3);
    expect(atmRow.pe.delta as number).toBeLessThan(-0.3);
    expect(atmRow.ce.intrinsic).toBe(0);
    // PE OI is 1.1 × CE OI in the sample book.
    expect(c.pcr).toBe(1.1);
    expect(c.maxPain).not.toBeNull();
    expect(c.totalCeOi).toBeGreaterThan(0);
    expect(c.coverage).toMatch(/^21 live strikes with OI on both sides \(24500–25500\) of 21 listed$/);
    // Previous-close OI and IV are not available yet.
    expect(c.totalCeOiChange).toBeNull();
    expect(c.ivChange).toBeNull();
    expect(c.gaps?.oiChange).toMatch(/Previous-close OI missing/);
    expect(c.gaps?.ivChange).toMatch(/No traded official option closes/);

    const m = await buildOptionChain(p, 'NIFTY', book.expiries.NIFTY[1]);
    expect(m.forwardSource).toBe('future');
    expect(m.forward).toBe(book.futures[`NIFTY|${book.expiries.NIFTY[1]}`]);
    expect(Math.abs((m.carry as number) - 0.01)).toBeLessThan(0.002); // the book's test carry yield
    expect(m.future).toBe(m.forward);
    expect(m.futureExpiry).toBe(book.expiries.NIFTY[1]);
  });

  it('previous-close OI and IV from the official file give OI change, build-up and ivChange', async () => {
    const { p, book } = setup();
    writePrevOptions(p, book, book.recordedDate);
    const c = await buildOptionChain(p, 'NIFTY');
    const row = c.rows.find((r) => r.strike === 25000)!;
    expect(row.ce.prevOi).toBe(Math.round((row.ce.oi as number) * 0.9));
    expect(row.ce.oiChange).toBe((row.ce.oi as number) - (row.ce.prevOi as number));
    expect(row.ce.prevClose).toBe(row.ce.ltp); // test file closes = today's premiums
    expect(row.ce.buildUp).toBe('Long Build-up');
    expect(c.totalCeOiChange).toBeGreaterThan(0);
    expect(c.gaps?.oiChange).toBeUndefined();
    expect(c.ivChange).not.toBeNull();
  });

  it('untraded official rows give OI but never a previous close or IV', async () => {
    const { p, book } = setup();
    writePrevOptions(p, book, book.recordedDate, { volume: 0 });
    const c = await buildOptionChain(p, 'NIFTY');
    const row = c.rows.find((r) => r.strike === 25000)!;
    expect(row.ce.prevOi).not.toBeNull();
    expect(row.ce.prevClose).toBeNull();
    expect(row.ce.change).toBeNull();
    expect(c.ivChange).toBeNull();
  });

  it('legs without a live quote are blank; an untraded leg keeps its OI; a stale book falls back to the LTP', async () => {
    const { p, book } = setup();
    const w1 = book.expiries.NIFTY[0];
    p.live.clearQuote(optKey('NIFTY', w1, 'CE', 25100));
    p.setQuote(optKey('NIFTY', w1, 'PE', 25100), { ltp: 150, volume: 0, oi: 77_000, bid: undefined, ask: undefined });
    let c = await buildOptionChain(p, 'NIFTY');
    const row = c.rows.find((r) => r.strike === 25100)!;
    expect(row.ce).toMatchObject({ ltp: null, oi: null, iv: null, bid: null, ivSource: null, ts: null });
    expect(row.pe).toMatchObject({ ltp: null, oi: 77_000, iv: null, ivSource: null });
    // That strike has no OI on both sides: left out of the aggregates.
    expect(c.coverage).toMatch(/^20 live strikes/);

    p.advance(BOOK_MAX_AGE_MS + 1_000);
    c = await buildOptionChain(p, 'NIFTY');
    const atm = c.rows.find((r) => r.strike === 25000)!;
    expect(atm.ce.bid).toBeNull();
    expect(atm.ce.ivSource).toBe('ltp');
    expect(atm.ce.iv).not.toBeNull();
  });

  it('after the close the session prices stay, the book does not', async () => {
    const { p } = setup();
    p.setNow(at('2026-10-12', '16:00'));
    const c = await buildOptionChain(p, 'NIFTY');
    const atm = c.rows.find((r) => r.strike === 25000)!;
    expect(atm.ce.ltp).not.toBeNull();
    expect(atm.ce.bid).toBeNull();
    expect(atm.ce.ivSource).toBe('ltp');
  });

  it('without a live spot the forward still comes from the put-call pairs; carry and intrinsic are blank', async () => {
    const { p } = setup();
    p.live.clearQuote(spotKey('NIFTY'));
    const c = await buildOptionChain(p, 'NIFTY');
    expect(c.spot).toBeNull();
    expect(c.forwardSource).toBe('parity');
    expect(c.carry).toBeNull();
    expect(c.gaps?.spot).toBe('No live NIFTY price');
    expect(c.gaps?.carry).toBeDefined();
    const atm = c.rows.find((r) => r.strike === 25000)!;
    expect(atm.ce.iv).not.toBeNull();
    expect(atm.ce.intrinsic).toBeNull();
  });

  it('NoLiveData when nothing of the chain is live; 400 for an unlisted expiry; 404 for an unknown symbol', async () => {
    const { p, book } = setup();
    const w1 = book.expiries.NIFTY[0];
    for (const k of p.ref.strikes('NIFTY', w1)) for (const t of ['CE', 'PE'] as const) p.live.clearQuote(optKey('NIFTY', w1, t, k));
    await expect(buildOptionChain(p, 'NIFTY', w1)).rejects.toThrow(NoLiveData);
    await expect(buildOptionChain(p, 'NIFTY', '2026-12-29')).rejects.toMatchObject({ statusCode: 400 });
    await expect(buildOptionChain(p, 'NOPE')).rejects.toMatchObject({ statusCode: 404 });
    p.ref.setLoaded(false);
    await expect(buildOptionChain(p, 'NIFTY')).rejects.toThrow('Instrument master not loaded yet');
  });

  it('as-of chain (?at=) comes from recorded minutes; unrecorded times are NoLiveData', async () => {
    const { p, book } = setup();
    const t = at(book.recordedDate, '12:00');
    const c = await buildOptionChain(p, 'NIFTY', undefined, { at: t });
    expect(c.ts).toBe(t);
    expect(c.expiry).toBe(book.expiries.NIFTY[0]);
    expect(c.spot).toBe(p.intraday.at(spotKey('NIFTY'), t)!.close);
    const atm = c.rows.find((r) => r.strike === c.atm)!;
    expect(Math.abs((atm.ce.iv as number) - 14)).toBeLessThan(0.5);
    expect(c.pcr).toBe(1.1);
    await expect(buildOptionChain(p, 'NIFTY', undefined, { at: at('2026-10-08', '12:00') })).rejects.toThrow(/recording started/);
  });
});

describe('futures and candles', () => {
  it('futures: live price, basis vs spot, OI change from the official file of the previous session', () => {
    const { p, book } = setup();
    let rows = futuresQuotes(p, 'BANKNIFTY');
    expect(rows.map((r) => r.expiry)).toEqual(book.expiries.BANKNIFTY);
    expect(rows[0].ltp).toBe(book.futures[`BANKNIFTY|${book.expiries.BANKNIFTY[0]}`]);
    expect(rows[0].basis).toBeCloseTo((rows[0].ltp as number) - 56000, 2);
    expect(rows[0].oiChange).toBeNull();
    expect(rows[0].buildUp).toBeNull();
    p.history.writeFo(book.recordedDate, {
      futures: [{ symbol: 'BANKNIFTY', date: book.recordedDate, expiry: book.expiries.BANKNIFTY[0], close: 56000, oi: 1_000_000, volume: 90_000, lotSize: 35 }],
    });
    rows = futuresQuotes(p, 'BANKNIFTY');
    expect(rows[0]).toMatchObject({ oi: 1_200_000, oiChange: 200_000, oiChangePct: 20 });
    expect(rows[0].change).toBeCloseTo((rows[0].ltp as number) - 56000, 2);
    expect(rows[0].buildUp).toBe('Long Build-up');
  });

  it('as-of futures from recorded minutes', () => {
    const { p, book } = setup();
    const t = at(book.recordedDate, '10:00');
    const rows = futuresQuotesAt(p, 'NIFTY', t);
    expect(rows).toHaveLength(1);
    expect(rows[0].ltp).toBe(p.intraday.at(futKey('NIFTY', book.expiries.NIFTY[1]), t)!.close);
    expect(rows[0].volume).toBe(3000 * 45); // 45 recorded minutes before 10:00 at 3,000 each (test data)
  });

  it('candles: official daily bars plus today\'s live bar; recorded intraday minutes; capped ranges', async () => {
    const { p, book } = setup();
    const daily = await candles(p, 'NIFTY', 'D', 30);
    expect(daily).toHaveLength(6);
    const today = daily.at(-1)!;
    expect(today).toEqual({ ts: at(book.date, '09:15'), open: 24950, high: 25050, low: 24920, close: 25000, volume: null });
    expect(daily[0].volume).toBeNull(); // index bars carry no volume

    await expect(candles(p, 'NIFTY', '5', 1)).rejects.toThrow(NoLiveData); // nothing recorded today
    const five = await candles(p, 'NIFTY', '5', 2);
    expect(five).toHaveLength(75);
    expect(five[0].ts).toBe(at(book.recordedDate, '09:15'));
    expect(five[0].volume).toBeNull();
    const fut = await candles(p, futKey('NIFTY', book.expiries.NIFTY[1]), '15', 2);
    expect(fut[0].volume).toBe(15 * 3000);

    const asOf = await candles(p, 'NIFTY', '1', 1, { at: at(book.recordedDate, '09:20') });
    expect(asOf).toHaveLength(5);
    await expect(candles(p, 'NIFTY', 'D', 5, { at: at(book.recordedDate, '12:00') })).rejects.toThrow(NoLiveData);
    expect(() => parseInterval('7')).toThrow(/Unsupported interval/);
  });
});

describe('pricer', () => {
  it('validates against the instrument master', () => {
    const { p, book } = setup();
    const px = new Pricer(p);
    const w1 = book.expiries.NIFTY[0];
    expect(px.validate({ symbol: 'NIFTY', type: 'CE', strike: 25000, expiry: w1 }).lotSize).toBe(75);
    expect(() => px.validate({ symbol: 'NOPE', type: 'FUT', expiry: w1 })).toThrow(/Unknown symbol/);
    expect(() => px.validate({ symbol: 'NIFTY', type: 'CE', strike: 25010, expiry: w1 })).toThrow(/Strike 25010 is not available/);
    expect(() => px.validate({ symbol: 'NIFTY', type: 'FUT', expiry: w1 })).toThrow(/is not listed/);
    expect(() => px.validate({ symbol: 'NIFTY', type: 'CE', strike: 25000, expiry: '2026-10-06' })).toThrow(/expired/);
    expect(() => px.validate({ symbol: 'NIFTY', type: 'EQ' }, p.now(), { trade: true })).toThrow(/index and cannot be traded/);
    expect(px.validate({ symbol: 'NIFTY', type: 'EQ' }).kind).toBe('SPOT');
    expect(px.validate({ symbol: 'RELIANCE', type: 'EQ' }, p.now(), { trade: true }).tickSize).toBe(0.05);
    p.ref.setLoaded(false);
    expect(() => px.validate({ symbol: 'NIFTY', type: 'EQ' })).toThrow(NoLiveData);
  });

  it('prices options from the live quote: book, IV from the mid, OI change only with a previous OI', () => {
    const { p, book } = setup();
    const px = new Pricer(p);
    const w1 = book.expiries.NIFTY[0];
    const q = p.live.quote(optKey('NIFTY', w1, 'CE', 25000))!;
    let r = px.price({ symbol: 'NIFTY', type: 'CE', strike: 25000, expiry: w1 });
    expect(r).toMatchObject({ ltp: q.ltp, bid: q.bid, ask: q.ask, lotSize: 75, tickSize: 0.05, expired: false, prevClose: null, change: null, oiChangePct: null, ts: q.ts });
    expect(Math.abs((r.iv as number) - 14)).toBeLessThan(0.05);
    p.setQuote(optKey('NIFTY', w1, 'CE', 25000), { ltp: q.ltp, prevOi: 80_000, prevClose: 100 });
    r = px.price({ symbol: 'NIFTY', type: 'CE', strike: 25000, expiry: w1 });
    expect(r.oiChangePct).toBe(+((((q.oi as number) - 80_000) / 80_000) * 100).toFixed(2));
    expect(r.change).toBeCloseTo(q.ltp - 100, 2);
    p.advance(BOOK_MAX_AGE_MS + 1);
    r = px.price({ symbol: 'NIFTY', type: 'CE', strike: 25000, expiry: w1 });
    expect(r.bid).toBeNull();
    expect(r.ask).toBeNull();
    expect(r.ltp).toBe(q.ltp);
    expect(r.reason).toMatch(/no live bid\/ask/);
  });

  it('EQ and FUT prices; no ±spread is ever made up; missing quotes are blank and watched', () => {
    const { p, book } = setup();
    const px = new Pricer(p);
    const eq = px.price({ symbol: 'RELIANCE', type: 'EQ' });
    expect(eq).toMatchObject({ ltp: 1400, bid: 1399.95, ask: 1400.05, prevClose: 1390, change: 10 });
    expect(Math.abs((eq.iv as number) - 22)).toBeLessThan(0.05);
    const idx = px.price({ symbol: 'NIFTY', type: 'EQ' });
    expect(idx.bid).toBeNull(); // index spots carry no book
    expect(idx.ask).toBeNull();
    expect(idx.tickSize).toBeNull();

    const m1 = book.expiries.NIFTY[1];
    p.history.writeFo(book.recordedDate, { futures: [{ symbol: 'NIFTY', date: book.recordedDate, expiry: m1, close: 25010, oi: 1_000_000, volume: 0 }] });
    const fut = px.price({ symbol: 'NIFTY', type: 'FUT', expiry: m1 });
    expect(fut.prevOi).toBe(1_000_000);
    expect(fut.oiChangePct).toBe(20);
    expect(fut.prevClose).toBeNull(); // the official row did not trade: its close is not a price

    p.live.clearQuote(futKey('BANKNIFTY', book.expiries.BANKNIFTY[1]));
    const none = px.price({ symbol: 'BANKNIFTY', type: 'FUT', expiry: book.expiries.BANKNIFTY[1] });
    expect(none).toMatchObject({ ltp: null, bid: null, ask: null, ts: null });
    expect(none.reason).toMatch(/No live quote/);
    expect(p.live.watched.some((w) => w.keys.some((k) => k.kind === 'FUT' && k.expiry === book.expiries.BANKNIFTY[1]))).toBe(true);
  });

  it('expired contracts settle at the exchange settlement price only', () => {
    const { p, book } = setup();
    const px = new Pricer(p);
    const w1 = book.expiries.NIFTY[0];
    p.setNow(at('2026-10-14', '11:00'));
    expect(() => px.price({ symbol: 'NIFTY', type: 'CE', strike: 25000, expiry: w1 })).toThrow(new NoLiveData(`Awaiting the exchange settlement price for NIFTY 13-Oct-26 25000 CE`));
    p.history.writeSettlements([{ symbol: 'NIFTY', expiry: w1, price: 25123.4 }]);
    const r = px.price({ symbol: 'NIFTY', type: 'CE', strike: 25000, expiry: w1 });
    expect(r).toMatchObject({ expired: true, ltp: 123.4, bid: null, ask: null, lotSize: 75 });
  });

  it('the EOD store keeps the bhavcopy NewBrdLotQty of every F&O row (real NSE rows)', () => {
    const { p } = setup();
    const f = parseFoUdiff(fixture('nse-fo-20260915.csv'), { exchange: 'NSE' });
    p.history.writeFo(f.date, { options: f.options, futures: f.futures });
    const opt = p.history.dailyOptions('NIFTY', f.date).find((o) => o.expiry === '2026-09-29' && o.strike === 26500 && o.type === 'PE');
    expect(opt?.lotSize).toBe(65);
    for (const row of f.futures) {
      const stored = p.history.dailyFutures(row.symbol, f.date, f.date).find((x) => x.expiry === row.expiry);
      expect(stored?.lotSize).toBe(row.lotSize);
    }
  });

  it('lot sizes of past contracts are kept from the official files (NewBrdLotQty)', () => {
    const { p } = setup();
    const px = new Pricer(p);
    // A contract the instrument master no longer lists (expired), with its official last-day row.
    p.history.writeFo('2026-09-29', {
      options: [{ symbol: 'NIFTY', date: '2026-09-29', expiry: '2026-09-29', strike: 24000, type: 'PE', close: 12.5, oi: 10_000, volume: 7500, lotSize: 65 }],
      futures: [{ symbol: 'NIFTY', date: '2026-09-29', expiry: '2026-09-29', close: 24100, oi: 0, volume: 1000, lotSize: 65 }],
    });
    expect(p.history.dailyOptions('NIFTY', '2026-09-29')[0].lotSize).toBe(65);
    expect(p.history.dailyFutures('NIFTY', '2026-09-29', '2026-09-29')[0].lotSize).toBe(65);
    p.history.writeSettlements([{ symbol: 'NIFTY', expiry: '2026-09-29', price: 23950 }]);
    expect(px.price({ symbol: 'NIFTY', type: 'PE', strike: 24000, expiry: '2026-09-29' })).toMatchObject({ expired: true, ltp: 50, lotSize: 65 });
    expect(px.price({ symbol: 'NIFTY', type: 'FUT', expiry: '2026-09-29' })).toMatchObject({ expired: true, ltp: 23950, lotSize: 65 });
  });
});
