/**
 * Paper broker and strategy manager on live prices (TEST-ONLY FakeProvider + sample book). Paper
 * only: nothing here talks to a broker.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { istTs, type Notification, type Order, type OrderRequest } from '@q26/core';
import { loadConfig } from '../src/config';
import { NoLiveData, keyId } from '../src/live/types';
import { BOOK_MAX_AGE_MS, futKey, optKey, spotKey, UserWatches } from '../src/services/live';
import { collectUserContracts, createServices } from '../src/services';
import { Pricer } from '../src/services/pricer';
import { PaperBroker, StrategyManager } from '../src/services/trading';
import { Db } from '../src/store/db';
import { FakeProvider, loadSampleBook, type SampleBook } from './support/fake-provider';

const providers: FakeProvider[] = [];
afterEach(() => {
  for (const p of providers.splice(0)) p.dispose();
});
const at = (date: string, hhmm: string) => istTs(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)));

function setup() {
  const p = new FakeProvider();
  providers.push(p);
  const book = loadSampleBook(p);
  const db = new Db(null);
  const pricer = new Pricer(p);
  const notes: { uid: string; n: Omit<Notification, 'id' | 'ts' | 'read'> }[] = [];
  const events: Order[] = [];
  const broker = new PaperBroker(p, db, pricer, () => p.now(), (uid, n) => notes.push({ uid, n }), (_uid, o) => events.push({ ...o }));
  const strategies = new StrategyManager(p, db, pricer, () => p.now());
  return { p, book, db, pricer, broker, strategies, notes, events };
}

const W = (book: SampleBook) => book.expiries.NIFTY[0];
const ce = (book: SampleBook, strike = 25000, extra: Partial<OrderRequest> = {}): OrderRequest => ({
  symbol: 'NIFTY', type: 'CE', strike, expiry: W(book), side: 'BUY', lots: 1, orderType: 'MARKET', product: 'NRML', ...extra,
});

describe('paper broker fills', () => {
  it('MARKET buys at the live ask and sells at the live bid', () => {
    const { p, book, broker } = setup();
    const q = p.live.quote(optKey('NIFTY', W(book), 'CE', 25000))!;
    const buy = broker.place('u1', ce(book));
    expect(buy).toMatchObject({ status: 'COMPLETE', avgPrice: q.ask, quantity: 75, filledQty: 75 });
    const sell = broker.place('u1', ce(book, 25000, { side: 'SELL' }));
    expect(sell).toMatchObject({ status: 'COMPLETE', avgPrice: q.bid });
    const trades = broker.trades('u1');
    expect(trades.map((t) => t.price).sort()).toEqual([q.bid, q.ask].sort());
    const pos = broker.positions('u1')[0];
    expect(pos).toMatchObject({ status: 'closed', netQty: 0, unrealized: 0, lotSize: 75 });
    expect(pos.realized).toBeCloseTo(75 * ((q.bid as number) - (q.ask as number)), 2);
  });

  it('rejects a MARKET order without a live bid/ask (stale book, market closed, no book) — never fills at LTP±spread', () => {
    const { p, book, broker, notes } = setup();
    p.advance(BOOK_MAX_AGE_MS + 1_000);
    const stale = broker.place('u1', ce(book));
    expect(stale.status).toBe('REJECTED');
    expect(stale.message).toBe('No live bid/ask for NIFTY 13-Oct-26 25000 CE');
    expect(notes.at(-1)?.n.title).toBe('Order rejected');

    p.setNow(at(book.date, '15:45'));
    expect(broker.place('u1', ce(book)).message).toBe('No live bid/ask for NIFTY 13-Oct-26 25000 CE (market closed)');

    p.setNow(book.now);
    const q50 = p.live.quote(optKey('NIFTY', W(book), 'CE', 25050))!;
    p.setQuote(optKey('NIFTY', W(book), 'CE', 25050), { ltp: q50.ltp, bid: undefined, ask: undefined });
    expect(broker.place('u1', ce(book, 25050)).status).toBe('REJECTED');
    expect(broker.trades('u1')).toHaveLength(0);
  });

  it('validates contracts, lots and the listing tick size', () => {
    const { book, broker } = setup();
    expect(() => broker.place('u1', ce(book, 25010))).toThrow(/Strike 25010 is not available/);
    expect(() => broker.place('u1', ce(book, 25000, { lots: 0 }))).toThrow(/Lots must be between/);
    expect(() => broker.place('u1', ce(book, 25000, { orderType: 'LIMIT', price: 100.03 }))).toThrow(/multiple of the tick size ₹0.05/);
    expect(() => broker.place('u1', ce(book, 25000, { expiry: '2026-10-06' }))).toThrow(/expired/);
  });

  it('LIMIT orders work until the live ask/bid crosses the limit', () => {
    const { p, book, broker } = setup();
    const key = optKey('NIFTY', W(book), 'CE', 25000);
    const q = p.live.quote(key)!;
    const limit = +((q.ask as number) - 5).toFixed(2);
    const o = broker.place('u1', ce(book, 25000, { orderType: 'LIMIT', price: limit }));
    expect(o.status).toBe('OPEN');
    broker.tick();
    expect(broker.orders('u1')[0].status).toBe('OPEN');
    p.advance(1_000);
    p.setQuote(key, { ltp: limit, bid: +(limit - 0.1).toFixed(2), ask: +(limit - 0.05).toFixed(2), volume: 60_000 });
    broker.tick();
    expect(broker.orders('u1')[0]).toMatchObject({ status: 'COMPLETE', avgPrice: +(limit - 0.05).toFixed(2) });
  });

  it('SL-M triggers on the live-session LTP and fills at the live bid', () => {
    const { p, book, broker } = setup();
    const key = optKey('NIFTY', W(book), 'CE', 25000);
    broker.place('u1', ce(book));
    const q = p.live.quote(key)!;
    const trigger = +(Math.floor(q.ltp) - 10).toFixed(2);
    const sl = broker.place('u1', ce(book, 25000, { side: 'SELL', orderType: 'SL-M', triggerPrice: trigger }));
    expect(sl.status).toBe('TRIGGER_PENDING');
    p.advance(1_000);
    p.setQuote(key, { ltp: trigger - 1, bid: trigger - 1.5, ask: trigger - 0.5, volume: 70_000 });
    broker.tick();
    expect(broker.orders('u1')[0]).toMatchObject({ status: 'COMPLETE', avgPrice: trigger - 1.5 });
  });
});

describe('paper broker: day orders, exits and the background tick', () => {
  it('LIMIT / SL / SL-M orders are DAY orders: cancelled "Day order expired" at the close of their session, not before', () => {
    const { p, book, broker, events } = setup(); // Monday 11:00
    const limit = broker.place('u1', ce(book, 25000, { orderType: 'LIMIT', price: 1 }));
    const sl = broker.place('u1', ce(book, 25100, { orderType: 'SL-M', triggerPrice: 9_999 }));
    const slLimit = broker.place('u1', ce(book, 25200, { orderType: 'SL', triggerPrice: 9_999, price: 10_000 }));
    expect([limit.status, sl.status, slLimit.status]).toEqual(['OPEN', 'TRIGGER_PENDING', 'TRIGGER_PENDING']);
    const close = p.calendar.ts(book.date, 375);
    p.setNow(close - 1_000);
    broker.tick();
    expect(broker.orders('u1').map((o) => o.status).sort()).toEqual(['OPEN', 'TRIGGER_PENDING', 'TRIGGER_PENDING']);
    p.setNow(close);
    broker.tick();
    const orders = broker.orders('u1');
    expect(orders.map((o) => [o.status, o.message])).toEqual([['CANCELLED', 'Day order expired'], ['CANCELLED', 'Day order expired'], ['CANCELLED', 'Day order expired']]);
    expect(orders.every((o) => o.updatedAt === close)).toBe(true);
    expect(events.filter((o) => o.status === 'CANCELLED')).toHaveLength(3);
    // A cancelled order never fills later, whatever the market does.
    p.setNow(close + 60_000);
    broker.tick();
    expect(broker.trades('u1')).toHaveLength(0);
  });

  it('an order placed outside the session lives until the close of the next session, not the one that just ended', () => {
    const { p, book, broker } = setup();
    const m1 = book.expiries.NIFTY[1]; // 2026-10-27: still listed after the weekend
    const sat = '2026-10-17';
    p.setNow(at(sat, '12:00'));
    const o = broker.place('u1', ce(book, 25000, { expiry: m1, orderType: 'LIMIT', price: 1 }));
    expect(o.status).toBe('OPEN');
    const nextClose = p.calendar.ts(p.calendar.next(sat), 375);
    p.setNow(p.calendar.ts(p.calendar.next(sat), 0));
    broker.tick(); // the next session opens: the order is still alive
    expect(broker.orders('u1')[0].status).toBe('OPEN');
    p.setNow(nextClose - 1_000);
    broker.tick();
    expect(broker.orders('u1')[0].status).toBe('OPEN');
    p.setNow(nextClose);
    broker.tick();
    expect(broker.orders('u1')[0]).toMatchObject({ status: 'CANCELLED', message: 'Day order expired' });
    // After the close of a session, the same day: lives to the next close.
    const fri = p.calendar.prev(p.calendar.next(sat));
    expect(p.calendar.isTradingDay(fri)).toBe(true);
    p.setNow(p.calendar.ts(fri, 375) + 3_600_000);
    const late = broker.place('u1', ce(book, 25000, { expiry: m1, orderType: 'LIMIT', price: 1 }));
    expect(late.status).toBe('OPEN');
    p.setNow(p.calendar.ts(fri, 375) + 7_200_000);
    broker.tick();
    expect(broker.orders('u1').find((x) => x.id === late.id)?.status).toBe('OPEN');
  });

  it('tick works every order, leaves missing live data to the next tick, and reports an unexpected error after the others were worked', () => {
    const { p, book, broker, pricer } = setup();
    const a = broker.place('u1', ce(book, 25000, { orderType: 'LIMIT', price: 1 }));
    const b = broker.place('u1', ce(book, 25100, { orderType: 'LIMIT', price: 1 }));
    const c = broker.place('u1', ce(book, 25200, { orderType: 'LIMIT', price: 1 }));
    // 25100 CE gets a marketable ask: it fills on the next tick.
    p.setQuote(optKey('NIFTY', W(book), 'CE', 25100), { ltp: 0.9, bid: 0.8, ask: 0.9, volume: 90_000 });
    const real = pricer.price.bind(pricer);
    let fail: (strike: number) => Error | null = () => null;
    pricer.price = (spec, ts) => {
      const err = fail(spec.strike as number);
      if (err) throw err;
      return real(spec, ts);
    };
    // Missing live data (and any 4xx) is expected and silent.
    fail = (k) => (k === 25000 ? new NoLiveData('feed down') : null);
    expect(() => broker.tick()).not.toThrow();
    expect(broker.orders('u1').find((o) => o.id === b.id)?.status).toBe('COMPLETE'); // worked although 25000 failed
    // An unexpected error is thrown out of tick (the services' wrapper reports it) once the rest was worked.
    p.setQuote(optKey('NIFTY', W(book), 'CE', 25200), { ltp: 0.9, bid: 0.8, ask: 0.9, volume: 90_000 });
    fail = (k) => (k === 25000 ? new TypeError('boom') : null);
    expect(() => broker.tick()).toThrow(new TypeError('boom'));
    expect(broker.orders('u1').find((o) => o.id === c.id)?.status).toBe('COMPLETE'); // worked after the failing one
    expect(broker.orders('u1').find((o) => o.id === a.id)?.status).toBe('OPEN'); // retried next tick
    // Several: one error naming how many.
    const d = broker.place('u1', ce(book, 24900, { orderType: 'LIMIT', price: 1 }));
    fail = (k) => (k === 25000 || k === 24900 ? new Error(`bad ${k}`) : null);
    let thrown: unknown;
    try {
      broker.tick();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toHaveLength(2);
    expect((thrown as Error).message).toMatch(/^2 working orders failed: bad (25000|24900); bad (25000|24900)$/);
    expect(new Set((thrown as AggregateError).errors.map((e) => (e as Error).message))).toEqual(new Set(['bad 25000', 'bad 24900']));
    expect(broker.orders('u1').find((o) => o.id === d.id)?.status).toBe('OPEN');
  });

  it('the services\' background tick reports a broker error to onError (and nothing for missing live data)', () => {
    vi.useFakeTimers();
    try {
      const p = new FakeProvider();
      providers.push(p);
      const book = loadSampleBook(p);
      const errors: { where: string; message: string }[] = [];
      const svc = createServices(loadConfig({ persist: false }), { provider: p, onError: (where, e) => errors.push({ where, message: e instanceof Error ? e.message : String(e) }) });
      expect(svc.broker.place('u1', ce(book, 25000, { orderType: 'LIMIT', price: 1 })).status).toBe('OPEN');
      let err: Error = new NoLiveData('feed down');
      svc.pricer.price = () => {
        throw err;
      };
      svc.start();
      vi.advanceTimersByTime(1_100);
      expect(errors.filter((e) => e.where === 'broker.tick')).toEqual([]);
      err = new TypeError('boom');
      vi.advanceTimersByTime(1_000);
      expect(errors.filter((e) => e.where === 'broker.tick')).toEqual([{ where: 'broker.tick', message: 'boom' }]);
      svc.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('exitPosition slices a position larger than the freeze quantity (whole lots below it); one order when none is listed; stops at the first slice that does not fill', () => {
    const { p, book, broker } = setup();
    const key = optKey('NIFTY', W(book), 'CE', 25300);
    const lots = (n: number, side: 'BUY' | 'SELL' = 'BUY') => ({ ...ce(book, 25300, { lots: n, side }) });
    expect(broker.place('u1', lots(50)).status).toBe('COMPLETE');
    expect(broker.place('u1', lots(10)).status).toBe('COMPLETE');
    expect(() => broker.place('u1', lots(51, 'SELL'))).toThrow(/Lots must be between 1 and 50/); // the order limit still holds for placed orders
    const pos = broker.positions('u1')[0];
    expect(pos).toMatchObject({ netQty: 60 * 75, status: 'open' });

    // Freeze quantity 1801 (orders must stay below it): 24 lots of 75 per slice → 24 + 24 + 12.
    (p.ref.listing(key) as { freezeQty?: number }).freezeQty = 1801;
    const orders = broker.exitPosition('u1', pos.key);
    expect(orders.map((o) => [o.side, o.lots, o.quantity, o.status, o.tag])).toEqual([
      ['SELL', 24, 1800, 'COMPLETE', 'exit'],
      ['SELL', 24, 1800, 'COMPLETE', 'exit'],
      ['SELL', 12, 900, 'COMPLETE', 'exit'],
    ]);
    expect(broker.positions('u1')[0]).toMatchObject({ netQty: 0, status: 'closed' });

    // No freeze quantity known: the full quantity in one order (the 50-lot user limit does not apply to an exit).
    delete (p.ref.listing(key) as { freezeQty?: number }).freezeQty;
    broker.place('u1', lots(50));
    broker.place('u1', lots(10));
    const one = broker.exitPosition('u1', broker.positions('u1')[0].key);
    expect(one.map((o) => [o.lots, o.status])).toEqual([[60, 'COMPLETE']]);

    // A position inside the freeze quantity is one order too; a short position is bought back.
    (p.ref.listing(key) as { freezeQty?: number }).freezeQty = 1801;
    broker.place('u1', lots(3, 'SELL'));
    const buyBack = broker.exitPosition('u1', broker.positions('u1')[0].key);
    expect(buyBack.map((o) => [o.side, o.lots, o.status])).toEqual([['BUY', 3, 'COMPLETE']]);
    expect(() => broker.exitPosition('u1', broker.positions('u1')[0].key)).toThrow(/No open position/);
  });

  it('exitPosition stops at the first slice that is not filled and returns what was placed', () => {
    const { p, book, db, pricer } = setup();
    const key = optKey('NIFTY', W(book), 'CE', 25300);
    // The book disappears as soon as the first exit slice has been filled.
    const broker = new PaperBroker(p, db, pricer, () => p.now(), () => undefined, (_uid, o) => {
      if (o.tag === 'exit' && o.status === 'COMPLETE') p.setQuote(key, { ltp: p.live.quote(key)!.ltp, bid: undefined, ask: undefined });
    });
    broker.place('u1', { ...ce(book, 25300, { lots: 50 }) });
    broker.place('u1', { ...ce(book, 25300, { lots: 10 }) });
    (p.ref.listing(key) as { freezeQty?: number }).freezeQty = 1801;
    const orders = broker.exitPosition('u1', broker.positions('u1')[0].key);
    expect(orders.map((o) => [o.lots, o.status])).toEqual([[24, 'COMPLETE'], [24, 'REJECTED']]);
    expect(orders[1].message).toMatch(/^No live bid\/ask for NIFTY .* 25300 CE/);
    expect(broker.positions('u1')[0]).toMatchObject({ netQty: 36 * 75, status: 'open' });
  });
});

describe('positions, funds and margin', () => {
  it('marks positions at the live LTP; blank (with the reason) when the contract has no live price', () => {
    const { p, book, broker } = setup();
    const key = optKey('NIFTY', W(book), 'CE', 25000);
    const fill = broker.place('u1', ce(book)).avgPrice;
    p.advance(1_000);
    p.setQuote(key, { ltp: fill + 10, volume: 61_000 });
    let pos = broker.positions('u1')[0];
    expect(pos).toMatchObject({ status: 'open', netQty: 75, ltp: fill + 10, ltpTs: p.now() });
    expect(pos.unrealized).toBeCloseTo(750, 2);
    // Next session before any trade: yesterday's LTP is not shown as live.
    p.setNow(at('2026-10-13', '09:20'));
    pos = broker.positions('u1')[0];
    expect(pos).toMatchObject({ ltp: null, ltpTs: null, unrealized: null, pnl: null });
    expect(pos.reason).toMatch(/No live quote/);
    const funds = broker.funds('u1');
    expect(funds.unrealizedPnl).toBeNull();
    expect(funds.gaps?.unrealizedPnl).toMatch(/No live quote/);
    expect(funds.premiumPaid).toBeCloseTo(75 * fill, 2);
  });

  it('short options carry a SPAN-style margin on live spot, solved IV and forward', () => {
    const { book, broker } = setup();
    const o = broker.place('u1', ce(book, 25000, { side: 'SELL' }));
    expect(o.status).toBe('COMPLETE');
    const f = broker.funds('u1');
    expect(f.usedMargin as number).toBeGreaterThan(50_000);
    expect(f.available as number).toBeLessThan(1_000_000);
    expect(f.gaps).toBeUndefined();
  });

  it('rejects a risk-adding order when margin inputs are not live; a closing order still fills', () => {
    const { p, book, broker } = setup();
    expect(broker.place('u1', ce(book, 25000, { side: 'SELL' })).status).toBe('COMPLETE');
    p.live.clearQuote(spotKey('NIFTY'));
    const add = broker.place('u1', ce(book, 25100, { side: 'SELL' }));
    expect(add.status).toBe('REJECTED');
    expect(add.message).toBe('Margin cannot be estimated: Margin estimate needs a live NIFTY price');
    expect(broker.funds('u1')).toMatchObject({ usedMargin: null, available: null });
    const close = broker.place('u1', ce(book, 25000, { side: 'BUY' }));
    expect(close.status).toBe('COMPLETE');
  });

  it('rejects an order the paper funds cannot carry', () => {
    const { book, broker } = setup();
    const o = broker.place('u1', { symbol: 'NIFTY', type: 'FUT', expiry: book.expiries.NIFTY[1], side: 'SELL', lots: 50, orderType: 'MARKET', product: 'NRML' });
    expect(o.status).toBe('REJECTED');
    expect(o.message).toMatch(/^Insufficient funds: requires ₹/);
  });

  it('expired positions wait for the exchange settlement price, then settle at it', () => {
    const { p, book, broker } = setup();
    const fill = broker.place('u1', ce(book)).avgPrice;
    p.setNow(at('2026-10-14', '11:00'));
    let pos = broker.positions('u1')[0];
    expect(pos).toMatchObject({ status: 'awaiting settlement', netQty: 75, ltp: null, unrealized: null, pnl: null, reason: 'Awaiting the exchange settlement price for NIFTY 13-Oct-26 25000 CE' });
    expect(() => broker.exitPosition('u1', pos.key)).toThrow(/settlement price/);
    // A long option's loss is bounded by the premium already paid: funds stay known, the MTM does not.
    const waiting = broker.funds('u1');
    expect(waiting.unrealizedPnl).toBeNull();
    expect(waiting.available).toBeCloseTo(1_000_000 - 75 * fill, 2);
    p.history.writeSettlements([{ symbol: 'NIFTY', expiry: W(book), price: 25200 }]);
    pos = broker.positions('u1')[0];
    expect(pos).toMatchObject({ status: 'expired', netQty: 0, ltp: 200, unrealized: 0 });
    expect(pos.realized).toBeCloseTo(75 * (200 - fill), 2);
    expect(broker.funds('u1').available).not.toBeNull();
  });

  it('working orders of an expired contract are cancelled; ticks survive missing data', () => {
    const { p, book, broker } = setup();
    const o = broker.place('u1', ce(book, 25000, { orderType: 'LIMIT', price: 1 }));
    expect(o.status).toBe('OPEN');
    p.ref.setLoaded(false);
    expect(() => broker.tick()).not.toThrow();
    expect(broker.orders('u1')[0].status).toBe('OPEN');
    p.ref.setLoaded(true);
    p.setNow(at('2026-10-14', '10:00'));
    broker.tick();
    expect(broker.orders('u1')[0]).toMatchObject({ status: 'CANCELLED', message: 'Contract expired before execution' });
  });
});

describe('strategy manager', () => {
  it('entry at the live LTP, MTM at the live LTP, blank MTM without one, exit at the live bid', () => {
    const { p, book, strategies } = setup();
    const key = optKey('NIFTY', W(book), 'CE', 25000);
    const q = p.live.quote(key)!;
    const s = strategies.create('u1', { symbol: 'nifty', legs: [{ side: 'BUY', type: 'CE', strike: 25000, expiry: W(book), lots: 2, lotSize: 1, price: 0 }] });
    expect(s.symbol).toBe('NIFTY');
    expect(s.legs[0]).toMatchObject({ price: q.ltp, lotSize: 75 });
    expect(s.live).toMatchObject({ mtm: 0, spot: 25000, legsLtp: [q.ltp] });
    p.advance(1_000);
    p.setQuote(key, { ltp: q.ltp + 4, volume: 62_000 });
    expect(strategies.get('u1', s.id).live?.mtm).toBeCloseTo(2 * 75 * 4, 2);
    p.setQuote(key, { ltp: q.ltp + 4, volume: 0 });
    const blank = strategies.get('u1', s.id).live!;
    expect(blank.mtm).toBeNull();
    expect(blank.legsLtp).toEqual([null]);
    expect(Object.keys(blank.gaps ?? {})).toContain('NIFTY 13-Oct-26 25000 CE');
    p.setQuote(key, { ltp: q.ltp + 4, volume: 63_000, bid: q.ltp + 3, ask: q.ltp + 5 });
    const exited = strategies.exit('u1', s.id);
    expect(exited.legs[0].exitPrice).toBe(q.ltp + 3);
    expect(exited.status).toBe('closed');
  });

  it('a leg without a live price cannot take an entry or exit price', () => {
    const { p, book, strategies } = setup();
    const pe = p.live.quote(optKey('NIFTY', W(book), 'PE', 25000))!;
    p.setQuote(optKey('NIFTY', W(book), 'PE', 25000), { ltp: pe.ltp, volume: 0, bid: undefined, ask: undefined });
    expect(() => strategies.create('u1', { symbol: 'NIFTY', legs: [{ side: 'SELL', type: 'PE', strike: 25000, expiry: W(book), lots: 1, lotSize: 1, price: 0 }] })).toThrow(NoLiveData);
    const s = strategies.create('u1', { symbol: 'NIFTY', legs: [{ side: 'SELL', type: 'PE', strike: 25000, expiry: W(book), lots: 1, lotSize: 1, price: 120 }] });
    expect(() => strategies.exit('u1', s.id)).toThrow(/No live price to exit/);
    expect(strategies.get('u1', s.id).legs[0].exitPrice).toBeNull();
  });

  it('an expired leg without a client lot size takes the lot size of that expiry from the official files, else the strategy is refused; never today\'s lot size', () => {
    const { p, strategies } = setup(); // NIFTY lists lot size 75 today
    const leg = (extra: Record<string, unknown> = {}) => ({ side: 'SELL' as const, type: 'PE' as const, strike: 24000, expiry: '2026-09-29', lots: 2, price: 12.5, lotSize: 1, ...extra });
    // Nothing known about the 29-Sep-26 contracts: not 75, no guess.
    expect(() => strategies.create('u1', { symbol: 'NIFTY', legs: [leg({ lotSize: 0 })] })).toThrow(NoLiveData);
    expect(() => strategies.create('u1', { symbol: 'NIFTY', legs: [leg()] })).toThrow(/Lot size of NIFTY 29-Sep-26 24000 PE is unknown.*official F&O file of 2026-09-29/);
    // The official row of the expiry day has it (65 then, 75 now).
    p.history.writeFo('2026-09-29', {
      options: [{ symbol: 'NIFTY', date: '2026-09-29', expiry: '2026-09-29', strike: 24000, type: 'PE', close: 12.5, oi: 10_000, volume: 7500, lotSize: 65 }],
      futures: [{ symbol: 'NIFTY', date: '2026-09-29', expiry: '2026-09-29', close: 24100, oi: 0, volume: 1000, lotSize: 65 }],
    });
    const s = strategies.create('u1', { symbol: 'NIFTY', legs: [leg(), { side: 'BUY', type: 'FUT', strike: 0, expiry: '2026-09-29', lots: 1, lotSize: 1, price: 24100 }] });
    expect(s.legs.map((l) => l.lotSize)).toEqual([65, 65]);
    // A lot size sent by the client is kept; a strike the file does not hold has none to look up.
    expect(strategies.create('u1', { symbol: 'NIFTY', legs: [leg({ lotSize: 70 })] }).legs[0].lotSize).toBe(70);
    expect(() => strategies.create('u1', { symbol: 'NIFTY', legs: [leg({ strike: 23000 })] })).toThrow(/Lot size of NIFTY 29-Sep-26 23000 PE is unknown/);
  });

  it('expired legs exit at the settlement price; the strategy then reads expired', () => {
    const { p, book, strategies } = setup();
    const s = strategies.create('u1', { symbol: 'NIFTY', legs: [{ side: 'BUY', type: 'CE', strike: 25000, expiry: W(book), lots: 1, lotSize: 1, price: 100 }] });
    p.setNow(at('2026-10-14', '11:00'));
    let v = strategies.get('u1', s.id);
    expect(v.live?.mtm).toBeNull();
    expect(v.status).toBe('open');
    p.history.writeSettlements([{ symbol: 'NIFTY', expiry: W(book), price: 25150 }]);
    v = strategies.get('u1', s.id);
    expect(v.legs[0].exitPrice).toBe(150);
    expect(v.status).toBe('expired');
    expect(v.live?.mtm).toBeCloseTo(75 * 50, 2);
  });
});

describe('user contracts streamed in the user tier', () => {
  it('collects working orders, positions, strategy legs, alerts, watchlists and user watches (deepest level wins)', () => {
    const { p, book, db, broker, strategies } = setup();
    const userWatches = new UserWatches(() => p.now());
    const m1 = book.expiries.NIFTY[1];
    broker.place('u1', ce(book)); // position
    broker.place('u1', ce(book, 25100, { orderType: 'LIMIT', price: 1 })); // working order
    strategies.create('u1', { symbol: 'NIFTY', legs: [{ side: 'SELL', type: 'PE', strike: 24900, expiry: W(book), lots: 1, lotSize: 1, price: 50 }] });
    db.data.watchlists.u1 = [{ id: 'w', name: 'w', items: [{ symbol: 'RELIANCE', type: 'EQ' }, { symbol: 'NIFTY', type: 'FUT', expiry: m1 }, { symbol: 'NIFTY', type: 'CE', strike: 24000, expiry: '2026-09-29' }] }];
    db.data.alerts.u1 = [{ id: 'a', kind: 'OPTION_PRICE', symbol: 'NIFTY', condition: 'above', value: 1, optionType: 'CE', strike: 25200, expiry: W(book), status: 'active', createdAt: 0 }];
    userWatches.touch([futKey('NIFTY', m1)], 'depth');
    const list = collectUserContracts(p, db, { broker, strategies, userWatches });
    const ids = list.map((c) => keyId('key' in c ? c.key : c));
    expect(ids).toEqual(
      expect.arrayContaining([
        keyId(optKey('NIFTY', W(book), 'CE', 25000)),
        keyId(optKey('NIFTY', W(book), 'CE', 25100)),
        keyId(optKey('NIFTY', W(book), 'PE', 24900)),
        keyId(optKey('NIFTY', W(book), 'CE', 25200)),
        keyId(spotKey('RELIANCE')),
      ]),
    );
    expect(ids).not.toContain(keyId(optKey('NIFTY', '2026-09-29', 'CE', 24000))); // expired
    expect(list).toContainEqual({ key: futKey('NIFTY', m1), level: 'depth' });
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('background ticks never throw: NoLiveData is expected (not reported), other errors are reported', () => {
    vi.useFakeTimers();
    try {
      const p = new FakeProvider();
      providers.push(p);
      loadSampleBook(p);
      const errors: string[] = [];
      const svc = createServices(loadConfig({ persist: false }), { provider: p, onError: (where) => errors.push(where) });
      let calls = 0;
      svc.broker.tick = () => {
        calls++;
        if (calls === 1) throw new NoLiveData('feed down');
        throw new Error('bug');
      };
      svc.start();
      vi.advanceTimersByTime(2_100);
      expect(calls).toBe(2);
      expect(errors.filter((w) => w === 'broker.tick')).toEqual(['broker.tick']);
      svc.stop();
      vi.advanceTimersByTime(5_000);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('createServices registers the collector with the provider; stop() clears it', () => {
    const p = new FakeProvider();
    providers.push(p);
    const book = loadSampleBook(p);
    const svc = createServices(loadConfig({ persist: false }), { provider: p });
    svc.broker.place('u9', ce(book));
    expect(p.userContracts().map((c) => keyId('key' in c ? c.key : c))).toContain(keyId(optKey('NIFTY', W(book), 'CE', 25000)));
    svc.stop();
    expect(p.userContracts()).toEqual([]);
  });
});
