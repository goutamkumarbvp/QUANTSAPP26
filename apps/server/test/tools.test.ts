/**
 * Market tools on live data (TEST-ONLY FakeProvider + sample book): order book from the feed's depth
 * only, order flow from the recorder's quote-rule classification (an estimate, labelled), and the
 * scanners / unusual activity / synopsis from live quotes and the option snapshot. Every input below
 * (ticks, depth, recorded minutes, snapshot rows) is TEST data constructed here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { istTs, ORDER_FLOW_METHOD } from '@q26/core';
import { Recorder } from '../src/live/recorder';
import { NoLiveData } from '../src/live/types';
import type { InstrumentKey, MinuteRecord, WatchLevel } from '../src/live/types';
import { Analytics } from '../src/services/analytics';
import { BOOK_MAX_AGE_MS, futKey, optKey, spotKey } from '../src/services/live';
import { MarketTools, SCANNERS, summariseOrderFlow } from '../src/services/market-tools';
import { Pricer } from '../src/services/pricer';
import { FakeProvider, loadSampleBook, type SampleBook } from './support/fake-provider';

const providers: FakeProvider[] = [];
afterEach(() => {
  for (const p of providers.splice(0)) p.dispose();
});

const MIN = 60_000;
const hm = (date: string, hhmm: string, sec = 0) => istTs(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))) + sec * 1000;

type Stub = Partial<Record<'optionSnapshot' | 'ivTable' | 'orbScan' | 'orbConfirmed', (...args: unknown[]) => unknown>>;
/** TEST-ONLY stand-in for the Analytics methods MarketTools reads (the real ones are tested with Analytics). */
const stubAnalytics = (over: Stub = {}): Analytics => ({ optionSnapshot: () => [], ivTable: () => [], orbScan: () => [], orbConfirmed: () => null, ...over }) as unknown as Analytics;

function setup(stub: Stub = {}) {
  const p = new FakeProvider();
  providers.push(p);
  const book = loadSampleBook(p);
  const tools = new MarketTools(p, stubAnalytics(stub));
  return { p, book, tools };
}

const nearFut = (book: SampleBook) => futKey('NIFTY', book.expiries.NIFTY[1]);

async function rejects503(fn: () => unknown, re: RegExp): Promise<void> {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(NoLiveData);
  expect((err as Error).message).toMatch(re);
}

/* ------------------------------------------------------------------------------------------ */
/* Order book                                                                                   */
/* ------------------------------------------------------------------------------------------ */

describe('order book (exchange depth only)', () => {
  it('answers 503 until the feed has sent depth for the contract, and asks for it at depth level (user tier)', async () => {
    const { p, book, tools } = setup();
    const touched: { key: InstrumentKey; level: WatchLevel }[] = [];
    const key = nearFut(book);
    // The sample future has a best bid/ask but no depth packet: no levels are made up from it.
    await rejects503(() => tools.orderBook('NIFTY', { type: 'FUT' }, p.now(), { touch: (k, level) => touched.push({ key: k, level }) }), /market depth/i);
    expect(touched).toEqual([{ key, level: 'depth' }]);
    expect(p.live.watched.at(-1)).toMatchObject({ keys: [key], level: 'depth' });
  });

  it('serves the levels as sent (never padded), real totals, and blanks what the feed did not send', () => {
    const { p, book, tools } = setup();
    const key = nearFut(book);
    const ltp = book.futures[`NIFTY|${book.expiries.NIFTY[1]}`];
    p.setQuote(key, {
      ltp,
      prevClose: ltp - 50,
      open: ltp - 20,
      high: ltp + 10,
      low: ltp - 30,
      atp: ltp - 5,
      ltq: 75,
      upperCircuit: ltp * 1.1,
      lowerCircuit: ltp * 0.9,
      totalBuyQty: 600_000,
      totalSellQty: 400_000,
      depth: {
        bids: [
          { price: ltp - 0.1, qty: 750, orders: 3 },
          { price: ltp - 0.2, qty: 1_500, orders: 5 },
          { price: ltp - 0.3, qty: 300, orders: 1 },
        ],
        asks: [
          { price: ltp + 0.1, qty: 225 }, // no order count from the feed
          { price: ltp + 0.2, qty: 900, orders: 4 },
        ],
      },
    });
    const ob = tools.orderBook('NIFTY', { type: 'FUT' }, p.now());
    expect(ob).toMatchObject({ symbol: 'NIFTY', type: 'FUT', expiry: book.expiries.NIFTY[1], bookLive: true, bookTs: p.now(), ltp, prevClose: ltp - 50, vwap: ltp - 5, lastTradeQty: 75, totalBidQty: 600_000, totalAskQty: 400_000 });
    expect(ob.bids).toHaveLength(3);
    expect(ob.asks).toEqual([
      { price: ltp + 0.1, qty: 225, orders: null },
      { price: ltp + 0.2, qty: 900, orders: 4 },
    ]);
    expect(ob.spread).toBeCloseTo(0.2, 6);
    expect(ob.imbalance).toBe(0.2);
    expect(ob.change).toBe(50);
    const a = Object.fromEntries(ob.analytics.map((x) => [x.label, x]));
    expect(a['Buy / Sell Qty Ratio'].value).toBe('1.50');
    expect(a['Avg Bid Order Size'].value).not.toBeNull();
    expect(a['Avg Ask Order Size']).toMatchObject({ value: null, hint: 'The feed sent no order counts' });
    // Not recorded today: no history, and the reason is given.
    expect(ob.history).toEqual([]);
    expect(ob.gaps?.history).toMatch(/No recorded minutes/);
  });

  it('a book older than 10 s (or after the close) is shown as of its time, flagged not live', () => {
    const { p, book, tools } = setup();
    const key = nearFut(book);
    p.setQuote(key, { ltp: 25_100, depth: { bids: [{ price: 25_099.9, qty: 75, orders: 1 }], asks: [] } });
    p.advance(BOOK_MAX_AGE_MS + 1_000);
    const ob = tools.orderBook('NIFTY', { type: 'FUT' }, p.now());
    expect(ob.bookLive).toBe(false);
    expect(ob.gaps?.book).toMatch(/s old\): not live/);
    expect(ob.asks).toEqual([]);
    expect(ob.spread).toBeNull(); // one-sided book: no spread invented
    expect(ob.analytics.find((x) => x.label === 'Mid Price')?.value).toBeNull();
  });

  it('history comes only from recorded minutes: level-1 quantities, totals, spread and ATP', () => {
    const { p, book, tools } = setup();
    const key = nearFut(book);
    p.setQuote(key, { ltp: 25_100, depth: { bids: [{ price: 25_099.9, qty: 75, orders: 1 }], asks: [{ price: 25_100.1, qty: 150, orders: 2 }] } });
    const recs: MinuteRecord[] = Array.from({ length: 10 }, (_, i) => ({
      ts: hm(book.date, '09:15') + i * MIN,
      open: 25_000 + i,
      high: 25_000 + i,
      low: 25_000 + i,
      close: 25_000 + i,
      traded: i !== 9,
      volume: i !== 9 ? 750 : 0,
      bid: 24_999.9 + i,
      ask: 25_000.2 + i,
      bidQty: 750 * (i + 1),
      askQty: 375,
      totalBuyQty: 100_000 + i,
      totalSellQty: 50_000,
      atp: 25_000.5,
    }));
    p.intraday.addMinutes(key, recs);
    const ob = tools.orderBook('NIFTY', { type: 'FUT' }, p.now());
    expect(ob.history.map((h) => h.ts)).toEqual([recs[4].ts, recs[9].ts]);
    expect(ob.history[0]).toEqual({ ts: recs[4].ts, ltp: 25_004, bidQty: 3_750, askQty: 375, totalBidQty: 100_004, totalAskQty: 50_000, ratio: 2, spread: 0.3, vwap: 25_000.5 });
    // 09:24 had no trade: its price is the last trade before it (09:23), never the carried close.
    expect(ob.history[1].ltp).toBe(25_008);
    expect(ob.gaps?.history).toBeUndefined();
  });

  it('validates the contract (400) and needs a live price to choose the ATM strike', async () => {
    const { p, book, tools } = setup();
    const w1 = book.expiries.NIFTY[0];
    expect(() => tools.orderBook('NIFTY', { type: 'CE', expiry: w1, strike: 25_010 }, p.now())).toThrow(/Strike 25010 is not listed/);
    expect(() => tools.orderBook('NIFTY', { type: 'FUT', expiry: '2026-12-29' }, p.now())).toThrow(/future 2026-12-29 is not listed/);
    p.live.clearQuote(spotKey('NIFTY'));
    p.live.clearQuote(nearFut(book));
    await rejects503(() => tools.orderBook('NIFTY', { type: 'CE', expiry: w1 }, p.now()), /No live NIFTY price to pick the ATM strike/);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Order flow                                                                                   */
/* ------------------------------------------------------------------------------------------ */

describe('order flow (recorded quote-rule estimate)', () => {
  /** The real Recorder on the fake feed, writing into the fake intraday store. */
  function recordFlow(p: FakeProvider, key: InstrumentKey, date: string) {
    const rec = new Recorder({ live: p.live, writer: p.intraday, pricing: p.pricing, calendar: p.calendar, clock: p.clock, timers: { setInterval: () => 0, clearInterval: () => undefined } });
    rec.start();
    const tick = (hhmm: string, sec: number, q: { ltp: number; volume: number; bid?: number; ask?: number }) => {
      p.setNow(hm(date, hhmm, sec) + 50);
      p.setQuote(key, { ...q, ts: hm(date, hhmm, sec) });
    };
    return { rec, tick };
  }

  it('is labelled an estimate, and buy + sell + unclassified = Δ cumulative volume, minute by minute and in total', () => {
    const { p, book, tools } = setup();
    const key = nearFut(book);
    const { rec, tick } = recordFlow(p, key, book.date);
    tick('11:00', 5, { ltp: 25_100, volume: 300_000, bid: 25_099.9, ask: 25_100.1 }); // baseline only
    tick('11:00', 20, { ltp: 25_100.1, volume: 300_150, bid: 25_100, ask: 25_100.2 }); // ≥ prior ask → buy 150
    tick('11:00', 40, { ltp: 25_100, volume: 300_375, bid: 25_099.8, ask: 25_100.1 }); // ≤ prior bid → sell 225
    tick('11:00', 50, { ltp: 25_099.9, volume: 300_450, bid: 25_099.8, ask: 25_100.1 }); // inside → unclassified 75
    tick('11:01', 10, { ltp: 25_100.1, volume: 300_525, bid: 25_100, ask: 25_100.3 }); // ≥ prior ask → buy 75
    tick('11:01', 30, { ltp: 25_100, volume: 300_600, bid: 25_099.9, ask: 25_100.2 }); // ≤ prior bid → sell 75
    p.setNow(hm(book.date, '11:02', 5));
    rec.flushDue();
    rec.stop();

    const of = tools.orderFlow('NIFTY', { type: 'FUT' }, p.now());
    expect(of.method).toBe(ORDER_FLOW_METHOD);
    expect(of.signal).toContain(ORDER_FLOW_METHOD);
    expect(of).toMatchObject({ live: true, date: book.date, expiry: book.expiries.NIFTY[1], lotSize: 75 });
    expect(of.minutes.map((m) => [m.volume, m.buyVolume, m.sellVolume, m.unclassified, m.delta, m.cumDelta])).toEqual([
      [450, 150, 225, 75, -75, -75],
      [150, 75, 75, 0, 0, -75],
    ]);
    for (const m of of.minutes) expect(m.buyVolume + m.sellVolume + m.unclassified).toBe(m.volume);
    // Each minute is also a 1-minute candle (Order & Trade chart): first, highest, lowest and last trade (the 11:00:05 tick is only the volume baseline, not a trade).
    expect(of.minutes.map((m) => [m.open, m.high, m.low, m.close])).toEqual([
      [25_100.1, 25_100.1, 25_099.9, 25_099.9],
      [25_100.1, 25_100.1, 25_100, 25_100],
    ]);
    expect(of.session).toMatchObject({ volume: 600, buyVolume: 225, sellVolume: 300, unclassified: 75, unclassifiedPct: 12.5, buyPct: 42.9, sentiment: 'Sellers dominant' });
    expect(of.session.volume).toBe(300_600 - 300_000); // Δ cumulative session volume since recording began
    expect(of.minutes[0].buyPct).toBe(40); // 150 / (150 + 225) of the classified volume
    expect(of.lastMinute).toMatchObject({ ts: hm(book.date, '11:01'), buyPct: 50, sentiment: 'Balanced', close: 25_100 });
    expect(of.coverage).toMatch(/^2 recorded minutes 11:00–11:02/);
    expect(of.gaps?.minutes).toMatch(/starts at 11:00/);
  });

  it('minutes the recorder did not see come from Kotak 1-minute candles: price and volume, unclassified, labelled; the split figures stay the recorded ones', async () => {
    const { p, book, tools } = setup();
    const key = nearFut(book);
    const t0 = hm(book.date, '10:00');
    p.intraday.addMinutes(key, [
      { ts: t0, open: 25_100, high: 25_110, low: 25_095, close: 25_105, traded: true, volume: 600, buyVolume: 400, sellVolume: 100, unclassified: 100 },
      { ts: t0 + MIN, open: 25_105, high: 25_108, low: 25_100, close: 25_102, traded: true, volume: 300, buyVolume: 100, sellVolume: 200, unclassified: 0 },
    ]);
    const kotak = [
      { ts: hm(book.date, '09:15'), open: 25_000, high: 25_020, low: 24_990, close: 25_010, volume: 5_000 },
      { ts: hm(book.date, '09:16'), open: 25_010, high: 25_030, low: 25_005, close: 25_025, volume: 0 }, // no trade: not a minute
      { ts: t0, open: 1, high: 1, low: 1, close: 1, volume: 1 }, // recorded: the recorder's minute wins
      { ts: hm(book.date, '10:30'), open: 25_200, high: 25_200, low: 25_200, close: 25_200, volume: 50 }, // after now: left out
    ];
    let asked = 0;
    (p as unknown as { historicalMinutes: (k: InstrumentKey, d: string) => Promise<typeof kotak> }).historicalMinutes = async (k, d) => {
      asked++;
      expect([k, d]).toEqual([key, book.date]);
      return kotak;
    };
    p.setNow(hm(book.date, '10:05'));
    const of = await tools.orderFlowWithHistory('NIFTY', { type: 'FUT' }, p.now());
    expect(asked).toBe(1);
    expect(of.minutes.map((m) => [m.ts, m.source ?? 'recorded', m.volume, m.buyVolume, m.sellVolume, m.unclassified, m.buyPct, m.close, m.cumDelta])).toEqual([
      [hm(book.date, '09:15'), 'kotak', 5_000, 0, 0, 5_000, null, 25_010, 0],
      [t0, 'recorded', 600, 400, 100, 100, 80, 25_105, 300],
      [t0 + MIN, 'recorded', 300, 100, 200, 0, 33.3, 25_102, 200],
    ]);
    // Session / last-minute figures are the recorded estimate only.
    expect(of.session).toMatchObject({ volume: 900, buyVolume: 500, sellVolume: 300 });
    expect(of.gaps?.kotakMinutes).toMatch(/1 minute \(09:15–09:16\) the recorder did not see are Kotak 1-minute candles/);
    expect(of.coverage).toMatch(/1 minutes the recorder did not see from Kotak 1-minute candles/);

    // Nothing recorded yet: the Kotak minutes alone, nothing classified.
    const { p: p2, book: b2, tools: t2 } = setup();
    (p2 as unknown as { historicalMinutes: () => Promise<typeof kotak> }).historicalMinutes = async () => kotak.slice(0, 1).map((k) => ({ ...k, ts: hm(b2.date, '09:15') }));
    p2.setNow(hm(b2.date, '10:05'));
    const only = await t2.orderFlowWithHistory('NIFTY', { type: 'FUT' }, p2.now());
    expect(only.minutes).toHaveLength(1);
    expect(only).toMatchObject({ lastMinute: null, last5: null, session: { volume: 0, sentiment: 'No trades' } });
    expect(only.minutes[0]).toMatchObject({ source: 'kotak', volume: 5_000, unclassified: 5_000 });
    expect(only.signal).toMatch(/No recorded minute .* Kotak 1-minute candles/);

    // Kotak cannot serve it (e.g. MCX): the recorded minutes alone, the reason in the gap note.
    const { p: p3, book: b3, tools: t3 } = setup();
    p3.intraday.addMinutes(nearFut(b3), [{ ts: hm(b3.date, '10:00'), open: 1, high: 1, low: 1, close: 1, traded: true, volume: 10, buyVolume: 10, sellVolume: 0, unclassified: 0 }]);
    (p3 as unknown as { historicalMinutes: () => Promise<never> }).historicalMinutes = async () => {
      throw new NoLiveData('Kotak historical candles are not available for MCX');
    };
    p3.setNow(hm(b3.date, '10:05'));
    const rec = await t3.orderFlowWithHistory('NIFTY', { type: 'FUT' }, p3.now());
    expect(rec.minutes.every((m) => m.source === undefined)).toBe(true);
    expect(rec.gaps?.minutes).toMatch(/earlier minutes not available from Kotak: Kotak historical candles are not available for MCX/);
  });

  it('never splits 50/50: unclassified volume stays unclassified and the buy share is null', () => {
    const { p, book, tools } = setup();
    const key = nearFut(book);
    const t0 = hm(book.date, '10:00');
    p.intraday.addMinutes(key, [
      { ts: t0, open: 25_100, high: 25_100, low: 25_100, close: 25_100, traded: true, volume: 500, buyVolume: 0, sellVolume: 0, unclassified: 500 },
      { ts: t0 + MIN, open: 25_100, high: 25_100, low: 25_100, close: 25_100, traded: false, volume: 0, buyVolume: 0, sellVolume: 0, unclassified: 0 },
    ]);
    const of = tools.orderFlow('NIFTY', { type: 'FUT' }, p.now());
    expect(of.minutes[0]).toMatchObject({ volume: 500, unclassified: 500, buyPct: null, close: 25_100 });
    expect(of.minutes[1]).toMatchObject({ volume: 0, buyPct: null, close: null }); // a quote-only minute has no trade price
    expect(of.session).toMatchObject({ buyPct: null, unclassifiedPct: 100, sentiment: 'Not classified' });
    expect(of.lastMinute?.sentiment).toBe('No trades');
    expect(summariseOrderFlow([]).buyPct).toBeNull();
    expect(summariseOrderFlow([]).sentiment).toBe('No trades');
  });

  it('a feed gap: the volume that traded during it is shown as gapVolume, never as the minute\'s volume nor classified; the totals still reconcile', () => {
    const { p, book, tools } = setup();
    const key = nearFut(book);
    const { rec, tick } = recordFlow(p, key, book.date);
    tick('11:00', 5, { ltp: 25_100, volume: 300_000, bid: 25_099.9, ask: 25_100.1 }); // baseline only
    tick('11:00', 20, { ltp: 25_100.1, volume: 300_150, bid: 25_100, ask: 25_100.2 }); // buy 150
    // The feed drops from 11:01 to 11:04. The first tick back reports +500 at the ask of the old book:
    // booked as the minute's volume it would be 500 more "buyer-initiated" units.
    tick('11:05', 10, { ltp: 25_100.3, volume: 300_650, bid: 25_100.2, ask: 25_100.3 });
    tick('11:05', 30, { ltp: 25_100.3, volume: 300_700, bid: 25_100.2, ask: 25_100.4 }); // an ordinary buy 50
    p.setNow(hm(book.date, '11:07', 5));
    rec.flushDue();
    rec.stop();

    const of = tools.orderFlow('NIFTY', { type: 'FUT' }, p.now());
    expect(of.minutes.map((m) => [m.volume, m.buyVolume, m.sellVolume, m.unclassified, m.gapVolume])).toEqual([
      [150, 150, 0, 0, null],
      [50, 50, 0, 0, 500],
    ]);
    expect(of.minutes[1].ts).toBe(hm(book.date, '11:05'));
    expect(of.session).toMatchObject({ volume: 200, buyVolume: 200, gapVolume: 500, buyPct: 100, unclassifiedPct: 0 });
    // Σ(volume + gapVolume) is the feed's Δ cumulative volume.
    expect(of.session.volume + of.session.gapVolume).toBe(300_700 - 300_000);
    expect(of.lastMinute).toMatchObject({ gapVolume: 500, volume: 50, sentiment: 'Buyers dominant' });
    expect(of.signal).toMatch(/a feed gap ended in this minute: 500 traded during the gap are not classified/);
    expect(of.gaps?.feedGaps).toMatch(/1 minute \(11:05\) follow a feed gap: 500 traded during the gaps at unknown times.*never classified/);
    // The dashboard / alert one-minute view carries it too.
    expect(tools.lastMinuteFlow('NIFTY', p.now())).toMatchObject({ ts: hm(book.date, '11:05'), gapVolume: 500, partialMinutes: 0, buyVolume: 50, delta: 50 });
  });

  it('a minute whose only volume is gap volume is "Feed gap": nothing is classified, no buy share', () => {
    const { p, book, tools } = setup();
    const t0 = hm(book.date, '10:58');
    p.intraday.addMinutes(nearFut(book), [
      { ts: t0, open: 1, high: 1, low: 1, close: 1, traded: true, volume: 100, buyVolume: 60, sellVolume: 40, unclassified: 0 },
      { ts: t0 + MIN, open: 1, high: 1, low: 1, close: 1, traded: false, volume: 0, gapVolume: 800, buyVolume: 0, sellVolume: 0, unclassified: 0 },
    ]);
    const of = tools.orderFlow('NIFTY', { type: 'FUT' }, p.now());
    expect(of.lastMinute).toMatchObject({ volume: 0, gapVolume: 800, buyVolume: 0, sellVolume: 0, buyPct: null, delta: 0, sentiment: 'Feed gap' });
    expect(of.signal).toMatch(/^10:59–11:00: the feed had a gap before this minute — 800 traded during the gap, not classified/);
    expect(of.minutes[1]).toMatchObject({ volume: 0, gapVolume: 800, buyPct: null, close: null });
    expect(tools.lastMinuteFlow('NIFTY', p.now())).toMatchObject({ sentiment: 'Feed gap', gapVolume: 800, buyPct: null });
    expect(summariseOrderFlow([{ volume: 0, buyVolume: 0, sellVolume: 0, unclassified: 0, gapVolume: 5 }]).sentiment).toBe('Feed gap');
    expect(summariseOrderFlow([{ volume: 0, buyVolume: 0, sellVolume: 0, unclassified: 0 }]).sentiment).toBe('No trades');
  });

  it('a minute the recording started inside is a lower bound: marked partial in the minutes, the summary, the signal and the gaps', () => {
    const { p, book, tools } = setup();
    const t0 = hm(book.date, '10:58');
    p.intraday.addMinutes(nearFut(book), [
      { ts: t0, open: 1, high: 1, low: 1, close: 1, traded: true, volume: 100, buyVolume: 60, sellVolume: 40, unclassified: 0, partial: true },
      { ts: t0 + MIN, open: 1, high: 1, low: 1, close: 1, traded: true, volume: 100, buyVolume: 70, sellVolume: 30, unclassified: 0 },
    ]);
    let of = tools.orderFlow('NIFTY', { type: 'FUT' }, p.now());
    expect(of.minutes.map((m) => m.partial)).toEqual([true, false]);
    expect(of.session.partialMinutes).toBe(1);
    expect(of.lastMinute?.partialMinutes).toBe(0);
    expect(of.gaps?.partial).toMatch(/started \(or restarted\) inside 10:58: the volume of that minute is a lower bound/);
    expect(of.signal).not.toMatch(/lower bound/);
    // When the partial minute is the last one, the signal says so.
    p.intraday.addMinutes(nearFut(book), [{ ts: t0 + 2 * MIN, open: 1, high: 1, low: 1, close: 1, traded: true, volume: 10, buyVolume: 10, sellVolume: 0, unclassified: 0, partial: true }]);
    p.setNow(hm(book.date, '11:01', 5));
    of = tools.orderFlow('NIFTY', { type: 'FUT' }, p.now());
    expect(of.signal).toMatch(/recording started inside this minute, so its volume is a lower bound/);
    expect(tools.lastMinuteFlow('NIFTY', p.now())).toMatchObject({ partialMinutes: 1, gapVolume: 0 });
  });

  it('a past session is served from its recorded minutes only; earlier dates and unrecorded contracts are 503', async () => {
    const { p, book, tools } = setup();
    // The sample book's recorded session has NIFTY future minutes with volume but no buy/sell split:
    // that volume is reported as unclassified, never divided up.
    const of = tools.orderFlow('NIFTY', { type: 'FUT' }, p.now(), { date: book.recordedDate, limit: 5 });
    expect(of).toMatchObject({ live: false, date: book.recordedDate, currentMinute: null });
    expect(of.minutes).toHaveLength(5);
    expect(of.session).toMatchObject({ volume: 375 * 3000, unclassified: 375 * 3000, buyVolume: 0, sellVolume: 0, buyPct: null });
    expect(of.expiries).toEqual([book.expiries.NIFTY[1]]);
    const before = p.calendar.prev(book.recordedDate);
    await rejects503(() => tools.orderFlow('NIFTY', { type: 'FUT' }, p.now(), { date: before }), new RegExp(`No recorded order flow for ${before} — recording started ${book.recordedDate}`));
    await rejects503(() => tools.orderFlow('BANKNIFTY', { type: 'FUT' }, p.now(), { date: book.recordedDate }), /No BANKNIFTY futures were recorded/);
    await rejects503(() => tools.orderFlow('NIFTY', { type: 'CE', expiry: book.expiries.NIFTY[0], strike: 27_000 }, p.now(), { date: book.recordedDate }), /was not recorded/);
  });

  it('today: a listed contract without records is watched for the user tier and answered 503', async () => {
    const { p, tools } = setup();
    const touched: WatchLevel[] = [];
    await rejects503(() => tools.orderFlow('BANKNIFTY', { type: 'FUT' }, p.now(), { touch: (_k, l) => touched.push(l) }), /no recorded minutes yet this session/);
    expect(touched).toEqual(['quote']);
    expect(() => tools.orderFlow('NIFTY', { type: 'FUT', expiry: '2026-12-29' }, p.now())).toThrow(/not listed/);
  });

  it('lastMinuteFlow: the near future\'s last completed recorded minute, else null with the reason', () => {
    const { p, book, tools } = setup();
    let why = '';
    expect(tools.lastMinuteFlow('NIFTY', p.now(), (r) => (why = r))).toBeNull();
    expect(why).toMatch(/No recorded minute of the NIFTY .* future on 2026-10-12/);
    const t0 = hm(book.date, '10:58');
    p.intraday.addMinutes(nearFut(book), [{ ts: t0, open: 1, high: 1, low: 1, close: 1, traded: true, volume: 1000, buyVolume: 700, sellVolume: 200, unclassified: 100 }]);
    expect(tools.lastMinuteFlow('NIFTY', p.now())).toMatchObject({ ts: t0, buyPct: 77.8, unclassifiedPct: 10, delta: 500, sentiment: 'Buyers dominant', method: ORDER_FLOW_METHOD });
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Scanners, unusual activity, synopsis                                                         */
/* ------------------------------------------------------------------------------------------ */

/** TEST snapshot rows (the shape Analytics.optionSnapshot returns), with nulls where a value is not live. */
function snapRows(book: SampleBook) {
  const w1 = book.expiries.NIFTY[0];
  const m1 = book.expiries.RELIANCE[0];
  const row = (symbol: string, kind: string, expiry: string, type: 'CE' | 'PE', strike: number, v: Record<string, number | null>) => ({ symbol, kind, sector: '', expiry, type, strike, lotSize: 75, spot: null, ltp: null, prevLtp: null, changePct: null, oi: null, prevOi: null, oiChange: null, oiChangePct: null, volume: null, iv: null, prevIv: null, ...v });
  return [
    row('NIFTY', 'index', w1, 'CE', 25_000, { spot: 25_000, ltp: 120, prevLtp: 130, oi: 200_000, prevOi: 100_000, volume: 900_000, iv: 15, prevIv: 13, atp: 118 }),
    row('NIFTY', 'index', w1, 'PE', 25_000, { spot: 25_000, ltp: 110, prevLtp: 100, oi: 110_000, prevOi: 100_000, volume: 40_000, iv: 14.5, prevIv: null }),
    row('NIFTY', 'index', w1, 'CE', 25_100, { spot: 25_000, ltp: 70, prevLtp: 75, oi: 90_000, prevOi: 88_000, volume: 30_000, iv: 14, prevIv: 14, atp: 71 }),
    row('NIFTY', 'index', w1, 'PE', 25_100, { spot: 25_000, ltp: 160, prevLtp: 150, oi: 95_000, prevOi: 94_000, volume: 20_000, iv: 14.2, prevIv: 14.1, atp: 158 }),
    row('RELIANCE', 'stock', m1, 'CE', 1_400, { spot: 1_400, ltp: null, oi: 50_000, prevOi: 45_000 }), // OI live, premium not traded today
    row('RELIANCE', 'stock', m1, 'PE', 1_400, { spot: 1_400, ltp: 30, prevLtp: 32, oi: 60_000, prevOi: 61_000, volume: 5_000, iv: 22, prevIv: 21, atp: 30.5 }),
  ];
}

describe('scanners', () => {
  it('lists every scanner; an unknown id is 404', async () => {
    const { p, tools } = setup();
    expect(SCANNERS).toHaveLength(23);
    await expect(tools.scanner('nope', p.now())).rejects.toMatchObject({ statusCode: 404 });
  });

  it('futures scanners need live OI and the previous session\'s OI (503 with the reason until then)', async () => {
    const { p, book, tools } = setup();
    await rejects503(() => tools.scanner('oi-gainers', p.now()), /none has both its live OI and the previous session's OI/);
    const [m1, m2] = book.expiries.BANKNIFTY;
    p.setQuote(futKey('NIFTY', m1), { ltp: book.futures[`NIFTY|${m1}`], prevClose: 24_950, prevOi: 1_000_000 }); // price ↑, OI ↑ (1.2 M)
    p.setQuote(futKey('RELIANCE', m1), { ltp: book.futures[`RELIANCE|${m1}`], prevClose: 1_450, prevOi: 1_500_000 }); // price ↓, OI ↓
    const res = await tools.scanner('oi-gainers', p.now());
    expect(res.coverage).toBe('2 of 3 near-month futures with live OI vs the previous session');
    expect(res.rows.map((r) => [r.symbol, r.metric])).toEqual([
      ['NIFTY', 20],
      ['RELIANCE', -20],
    ]);
    expect(res.rows[0]).toMatchObject({ type: 'FUT', expiry: m1, oi: 1_200_000, oiChangePct: 20, volume: 300_000, buildUp: 'Long Build-up' });
    const long = await tools.scanner('long-buildup', p.now());
    expect(long.rows.map((r) => r.symbol)).toEqual(['NIFTY']);
    const unwind = await tools.scanner('long-unwinding', p.now());
    expect(unwind.rows.map((r) => r.symbol)).toEqual(['RELIANCE']);
    expect(m2).toBeDefined();
  });

  it('price scanners rank live stock prices with the stock\'s own volume (no OI or build-up of its future); losers are only stocks that are down', async () => {
    const { p, tools } = setup();
    const res = await tools.scanner('price-gainers', p.now());
    expect(res.rows).toHaveLength(1);
    // The stock's own session volume (3.2M on its quote), not the near future's 300,000; OI is the future's, so null.
    expect(res.rows[0]).toMatchObject({ symbol: 'RELIANCE', type: 'EQ', ltp: 1_400, metric: 0.72, volume: 3_200_000, oi: null, oiChangePct: null });
    expect(res.rows[0].buildUp ?? null).toBeNull();
    expect(res.coverage).toBe('1 of 1 F&O stocks with a live price and the previous close (1 up)');
    // RELIANCE is up 0.72 %: it is not a loser.
    const losers = await tools.scanner('price-losers', p.now());
    expect(losers.rows).toEqual([]);
    expect(losers.coverage).toBe('1 of 1 F&O stocks with a live price and the previous close (0 down)');
    // Down: listed as a loser, not a gainer.
    p.setQuote(spotKey('RELIANCE'), { ltp: 1_380, prevClose: 1_390, volume: 3_300_000 });
    expect((await tools.scanner('price-losers', p.now())).rows).toMatchObject([{ symbol: 'RELIANCE', ltp: 1_380, metric: -0.72, volume: 3_300_000, oi: null }]);
    expect((await tools.scanner('price-gainers', p.now())).rows).toEqual([]);
  });

  it('option scanners come from the snapshot: rows without live inputs are left out, turnover = volume × ATP', async () => {
    const { p, book, tools } = setup({ optionSnapshot: () => snapRows(book) });
    const calls = await tools.scanner('most-active-calls', p.now());
    expect(calls.rows.map((r) => [r.instrument, r.metric])).toEqual([
      [`NIFTY 13-Oct-26 25000 CE`, 900_000 * 118],
      [`NIFTY 13-Oct-26 25100 CE`, 30_000 * 71],
    ]);
    expect(calls.coverage).toBe('2 of 3 underlyings with live option prices (5 contracts, nearest expiry); stock options refresh about every 90 s');
    // The 25000 PE has no ATP in its row; the live quote of the sample book has none either: left out.
    const puts = await tools.scanner('most-active-puts', p.now());
    expect(puts.rows.map((r) => r.strike)).toEqual([25_100, 1_400]);
    expect(puts.gaps?.turnover).toMatch(/1 traded contracts have no average traded price/);
    // An ATP on the live quote fills it in.
    p.setQuote(optKey('NIFTY', book.expiries.NIFTY[0], 'PE', 25_000), { ltp: 110, atp: 109 });
    expect((await tools.scanner('most-active-puts', p.now())).rows[0]).toMatchObject({ strike: 25_000, metric: 40_000 * 109 });

    const oi = await tools.scanner('highest-call-oi', p.now());
    expect(oi.rows.map((r) => [r.symbol, r.strike, r.ltp])).toEqual([
      ['NIFTY', 25_000, 120],
      ['NIFTY', 25_100, 70],
      ['RELIANCE', 1_400, null], // live OI, no trade today: the premium stays blank
    ]);
    const writing = await tools.scanner('call-writing', p.now());
    expect(writing.rows.map((r) => [r.strike, r.metric, r.buildUp])).toEqual([
      [25_000, 100_000, 'Short Build-up'],
      [25_100, 2_000, 'Short Build-up'],
    ]);
    const prem = await tools.scanner('premium-gainers', p.now());
    expect(prem.rows[0]).toMatchObject({ type: 'PE', strike: 25_000, metric: 10, ivChange: null });
  });

  it('IV and ORB scanners read Analytics; missing values leave the row out and EQ rows carry no OI placeholders', async () => {
    const { p, tools } = setup({
      ivTable: () => [
        { symbol: 'NIFTY', ltp: 25_000, changePct: 0.4, iv: 14, ivChange: 1.2, ivp: 80 },
        { symbol: 'BANKNIFTY', ltp: 56_000, changePct: 0.36, iv: 16, ivChange: null, ivp: null },
      ],
      orbScan: () => [
        { symbol: 'NIFTY', ltp: 25_000, changePct: 0.4, trend: 'up', pending: null, widthPct: 0.3, beyondPct: 0.12 },
        { symbol: 'RELIANCE', ltp: 1_400, changePct: 0.72, trend: 'sideways', pending: null, widthPct: 0.8, beyondPct: null },
      ],
    });
    const iv = await tools.scanner('iv-gainers', p.now());
    expect(iv.rows.map((r) => r.symbol)).toEqual(['NIFTY']);
    expect(iv.rows[0]).toMatchObject({ type: 'EQ', iv: 14, ivChange: 1.2, ivp: 80, oi: null, oiChangePct: null, volume: null, metric: 1.2 });
    const up = await tools.scanner('orb-up', p.now());
    expect(up.rows).toEqual([expect.objectContaining({ symbol: 'NIFTY', metric: 0.12, metricLabel: '% above OR high', oi: null, volume: null })]);
    expect(up.coverage).toBe('2 of 3 underlyings with recorded 1-minute bars this session');
    const inside = await tools.scanner('orb-inside', p.now());
    expect(inside.rows.map((r) => r.symbol)).toEqual(['RELIANCE']);
  });
});

describe('unusual activity and synopsis', () => {
  it('unusual: scores live contracts with previous OI; IV/turnover gaps are reported, never filled', async () => {
    const { p, book, tools } = setup({ optionSnapshot: () => snapRows(book) });
    const res = await tools.unusual(p.now());
    expect(res.rows.map((r) => [r.strike, r.type])).toEqual([[25_000, 'CE']]);
    expect(res.rows[0]).toMatchObject({ oiChange: 100_000, oiChangePct: 100, volumeOiRatio: 4.5, ivChange: 2, premiumTurnover: 900_000 * 118, buildUp: 'Short Build-up', signal: 'Call writing — bearish' });
    expect(res.gaps?.ivChange).toMatch(/1 of 5 contracts have no IV change/);
    expect(res.gaps?.premiumTurnover).toMatch(/1 of 5 contracts have no average traded price/);
    expect(res.coverage).toMatch(/5 contracts with live OI vs the previous session scored$/);
    await rejects503(() => tools.unusual(p.now(), 'BANKNIFTY'), /No live option quotes for BANKNIFTY/);
  });

  it('unusual: 503 while no live contract has the previous session\'s OI', async () => {
    const { p, book, tools } = setup({ optionSnapshot: () => snapRows(book).map((r) => ({ ...r, prevOi: null, oiChange: null })) });
    await rejects503(() => tools.unusual(p.now()), /none has the previous session's OI/);
  });

  it('synopsis: live stocks only; turnover = volume × ATP (blank without ATP); PCR over strikes with OI on both sides', async () => {
    const { p, book, tools } = setup({ optionSnapshot: () => snapRows(book), ivTable: () => [{ symbol: 'RELIANCE', iv: 22, ivChange: null }] });
    const a = await tools.synopsis(p.now());
    expect(a.rows).toEqual([{ symbol: 'RELIANCE', name: 'Reliance Industries', sector: 'Energy', ltp: 1_400, changePct: 0.72, oiChangePct: null, ivChange: null, iv: 22, turnover: null, buildUp: null, pcr: 1.2 }]);
    expect(a.gaps?.turnover).toMatch(/no session volume or average traded price/);
    expect(a.coverage).toMatch(/^1 of 1 F&O stocks with a live price/);
    p.setQuote(spotKey('RELIANCE'), { ltp: 1_400, atp: 1_398.5 });
    const b = await tools.synopsis(p.now());
    expect(b.rows[0].turnover).toBe(Math.round(3_200_000 * 1_398.5));
    p.live.clearQuote(spotKey('RELIANCE'));
    await rejects503(() => tools.synopsis(p.now()), /No live F&O stock prices/);
  });
});

describe('with the real Analytics (sample book)', () => {
  it('every scanner, unusual and synopsis answer from live rows or 503 with the reason (no placeholder rows)', async () => {
    const p = new FakeProvider();
    providers.push(p);
    const book = loadSampleBook(p);
    const tools = new MarketTools(p, new Analytics(p, new Pricer(p)));
    for (const s of SCANNERS) {
      let res: Awaited<ReturnType<MarketTools['scanner']>>;
      try {
        res = await tools.scanner(s.id, p.now());
      } catch (e) {
        expect(e, s.id).toBeInstanceOf(NoLiveData);
        expect((e as Error).message.length, s.id).toBeGreaterThan(20);
        continue;
      }
      expect(res.coverage, s.id).toMatch(/\d+ of \d+/);
      for (const r of res.rows) {
        expect(Number.isFinite(r.metric), s.id).toBe(true);
        if (r.type === 'EQ') expect([r.oi === null || r.oi > 0, r.volume === null || r.volume > 0], s.id).toEqual([true, true]);
      }
    }
    // Real OI of the live snapshot, calls only.
    const oi = await tools.scanner('highest-call-oi', p.now());
    expect(oi.rows.length).toBeGreaterThan(0);
    expect(oi.rows.every((r) => r.type === 'CE' && (r.oi as number) > 0)).toBe(true);
    // The sample book's option quotes carry no ATP: no turnover, so no "most active" rows (gap reported) …
    const calls = await tools.scanner('most-active-calls', p.now());
    expect(calls.rows).toEqual([]);
    expect(calls.gaps?.turnover).toMatch(/no average traded price from the feed/);
    // … until the feed sends one for a traded contract.
    const w1 = book.expiries.NIFTY[0];
    const atm = optKey('NIFTY', w1, 'CE', 25_000);
    const q = p.live.quote(atm)!;
    p.setQuote(atm, { ltp: q.ltp, atp: q.ltp - 1 });
    const again = await tools.scanner('most-active-calls', p.now());
    expect(again.rows[0]).toMatchObject({ symbol: 'NIFTY', type: 'CE', strike: 25_000, metric: Math.round((q.volume as number) * (q.ltp - 1)) });
    // Unusual needs the previous session's OI (none in the sample book): 503 with the reason.
    await rejects503(() => tools.unusual(p.now()), /none has the previous session's OI/);
    const syn = await tools.synopsis(p.now());
    expect(syn.rows.map((r) => r.symbol)).toEqual(['RELIANCE']);
  });
});
