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
