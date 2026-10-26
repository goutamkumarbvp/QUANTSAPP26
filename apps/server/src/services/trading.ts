/**
 * Paper trading on live prices: a paper broker (orders, trades, positions, funds with a SPAN-style
 * margin estimate) and the virtual strategy manager (saved multi-leg strategies with live MTM).
 * PAPER ONLY: nothing here ever sends an order to the broker.
 *
 * Live-data rules:
 *  - fills only against a live book: MARKET buys at the live ask, sells at the live bid; a MARKET
 *    order without one is rejected ("No live bid/ask for <label>"); LIMIT/SL/SL-M orders keep working
 *    until a live book (and, for triggers, a live-session LTP) is there, only while the market is open;
 *    they are DAY orders: cancelled ("Day order expired") at the close of their session (the session
 *    they were placed in, or the next one when placed after the close or on a holiday);
 *  - exiting a position larger than the exchange freeze quantity places it in slices below the
 *    listing's freeze quantity (one order when the freeze quantity is not known);
 *  - positions are marked at the live-session LTP; without one, ltp/unrealized/pnl are null with the
 *    reason (never a last-known price shown as live);
 *  - margin = core estimateMargin on the live spot, each option leg's IV solved from its live premium
 *    (else the ATM IV of the leg's own expiry) and the expiry's live forward, valued at md.pricing's
 *    valuation time; an order that adds risk is rejected with the reason when those inputs are not live;
 *  - an expired contract settles only at the exchange settlement price (md.history.settlement);
 *    until it is published the position stays open as 'awaiting settlement'.
 */
import { randomUUID } from 'node:crypto';
import {
  estimateMargin,
  marginParamsOf,
  type Funds,
  type Leg,
  type Notification,
  type Order,
  type OrderRequest,
  type Position,
  type SavedStrategy,
  type Trade,
} from '@q26/core';
import { NoLiveData } from '../live/types';
import type { InstrumentKey, MarketDataProvider } from '../live/types';
import type { Db } from '../store/db';
import { Gaps, httpError, livePrice, mdFor, r2, spotKey } from './live';
import { instrumentKey, instrumentLabel, specKey, type InstrumentSpec, type Pricer } from './pricer';

const MAX_LOTS_PER_ORDER = 50;

export type Notify = (userId: string, n: Omit<Notification, 'id' | 'ts' | 'read'>) => void;
export type EmitOrder = (userId: string, order: Order) => void;

interface PositionAgg {
  key: string;
  symbol: string;
  type: Position['type'];
  strike?: number;
  expiry: string;
  product: Position['product'];
  /** Lot size the contract traded with (order quantity / lots). */
  lotSize: number;
  buyQty: number;
  sellQty: number;
  buyValue: number;
  sellValue: number;
}

const specOf = (p: { symbol: string; type: Position['type']; strike?: number; expiry: string }): InstrumentSpec => ({
  symbol: p.symbol,
  type: p.type,
  strike: p.type === 'FUT' ? undefined : p.strike,
  expiry: p.expiry,
});

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isClientError = (e: unknown): boolean => e instanceof NoLiveData || ((e as { statusCode?: number }).statusCode ?? 500) < 500;

/** `price` is a whole multiple of `tick` (paise tolerance). */
function onTick(price: number, tick: number): boolean {
  const n = price / tick;
  return Math.abs(n - Math.round(n)) < 1e-6;
}

export class PaperBroker {
  constructor(
    private readonly md: MarketDataProvider,
    private readonly db: Db,
    private readonly pricer: Pricer,
    private readonly now: () => number,
    private readonly notify: Notify,
    private readonly emitOrder: EmitOrder,
  ) {}

  orders(uid: string): Order[] {
    return this.db.list('orders', uid);
  }

  trades(uid: string): Trade[] {
    return this.db.list('trades', uid);
  }

  private aggregate(trades: Trade[], orders: Order[]): PositionAgg[] {
    const byOrder = new Map(orders.map((o) => [o.id, o]));
    const map = new Map<string, PositionAgg>();
    for (const t of [...trades].reverse()) {
      const o = byOrder.get(t.orderId);
      if (!o) continue;
      const key = instrumentKey({ symbol: o.symbol, type: o.type, strike: o.strike, expiry: o.expiry, product: o.product });
      const lotSize = o.lots > 0 ? o.quantity / o.lots : 1;
      const agg = map.get(key) ?? { key, symbol: o.symbol, type: o.type, strike: o.strike, expiry: o.expiry, product: o.product, lotSize, buyQty: 0, sellQty: 0, buyValue: 0, sellValue: 0 };
      if (t.side === 'BUY') {
        agg.buyQty += t.quantity;
        agg.buyValue += t.quantity * t.price;
      } else {
        agg.sellQty += t.quantity;
        agg.sellValue += t.quantity * t.price;
      }
      map.set(key, agg);
    }
    return [...map.values()];
  }

  private toPositions(aggs: PositionAgg[], ts: number): Position[] {
    return aggs.map((a) => {
      const spec = specOf(a);
      const label = instrumentLabel(spec);
      const netQty = a.buyQty - a.sellQty;
      const buyAvg = a.buyQty ? a.buyValue / a.buyQty : 0;
      const sellAvg = a.sellQty ? a.sellValue / a.sellQty : 0;
      const closed = Math.min(a.buyQty, a.sellQty);
      let realized = closed * (sellAvg - buyAvg);
      const avgPrice = netQty > 0 ? buyAvg : netQty < 0 ? sellAvg : 0;
      let ltp: number | null = null;
      let ltpTs: number | null = null;
      let unrealized: number | null = 0;
      let status: Position['status'] = netQty === 0 ? 'closed' : 'open';
      let reason: string | undefined;
      let shownQty = netQty;
      if (netQty !== 0 && this.md.calendarOf(a.symbol).expiryTs(a.expiry) < ts) {
        const settle = this.md.history.settlement(specKey(spec));
        if (settle !== undefined) {
          ltp = settle;
          realized += netQty * (settle - avgPrice);
          unrealized = 0;
          status = 'expired';
          shownQty = 0;
        } else {
          unrealized = null;
          status = 'awaiting settlement';
          reason = `Awaiting the exchange settlement price for ${label}`;
        }
      } else if (netQty !== 0) {
        try {
          const px = this.pricer.price(spec, ts);
          ltp = px.ltp;
          ltpTs = ltp !== null ? px.ts : null;
          if (ltp === null) reason = px.reason ?? `No live price for ${label}`;
        } catch (e) {
          if (!isClientError(e)) throw e;
          reason = errMsg(e);
        }
        unrealized = ltp !== null ? netQty * (ltp - avgPrice) : null;
      }
      return {
        key: a.key,
        instrument: label,
        symbol: a.symbol,
        type: a.type,
        strike: a.strike,
        expiry: a.expiry,
        product: a.product,
        netQty: shownQty,
        lotSize: a.lotSize,
        avgPrice: +avgPrice.toFixed(2),
        buyQty: a.buyQty,
        sellQty: a.sellQty,
        buyValue: +a.buyValue.toFixed(2),
        sellValue: +a.sellValue.toFixed(2),
        ltp,
        ltpTs,
        realized: +realized.toFixed(2),
        unrealized: r2(unrealized),
        pnl: unrealized !== null ? +(realized + unrealized).toFixed(2) : null,
        status,
        ...(reason ? { reason } : {}),
      };
    });
  }

  positions(uid: string): Position[] {
    return this.toPositions(this.aggregate(this.trades(uid), this.orders(uid)), this.now());
  }

  /**
   * Margin estimate of one underlying's open positions (0 when nothing is short and there is no
   * future), valued at md.pricing.valuationTs (the IVs and forwards are solved there: outside the
   * session the last close). A leg without a solvable premium of its own takes the ATM IV of its own
   * expiry only. NoLiveData when the live spot, a leg's IV or an expiry's forward is not available.
   */
  private marginFor(symbol: string, positions: Position[], ts: number): number {
    const open = positions.filter((p) => p.status === 'open' && p.netQty !== 0);
    if (!open.some((p) => p.netQty < 0 || p.type === 'FUT')) return 0;
    const md = mdFor(this.md, symbol);
    const u = md.ref.underlying(symbol);
    const S = livePrice(md, md.live.quote(spotKey(symbol)));
    if (S === null) throw new NoLiveData(`Margin estimate needs a live ${symbol} price`);
    const carry = new Map<string, number>();
    for (const e of new Set(open.map((p) => p.expiry))) carry.set(e, md.pricing.r - md.pricing.forward(symbol, e).carry);
    const atmIv = md.pricing.atmIv(symbol);
    const legs: Leg[] = open.map((p) => {
      let iv: number | undefined;
      if (p.type !== 'FUT') {
        let solved: number | null = null;
        try {
          const pxIv = this.pricer.price(specOf(p), ts).iv;
          solved = pxIv !== null ? pxIv / 100 : null;
        } catch (e) {
          if (!isClientError(e)) throw e;
        }
        solved ??= md.pricing.atmIv(symbol, p.expiry);
        if (solved === null) throw new NoLiveData(`No live IV for ${p.instrument}: margin cannot be estimated`);
        iv = solved;
      }
      return { side: p.netQty > 0 ? 'BUY' : 'SELL', type: p.type, strike: p.strike ?? 0, expiry: p.expiry, lots: Math.abs(p.netQty) / p.lotSize, lotSize: p.lotSize, price: p.avgPrice, iv };
    });
    const ivs = legs.map((l) => l.iv).filter((v): v is number => v !== undefined);
    // Reference IV of the vol scan (core estimateMargin); every option leg is valued at its own IV.
    const volScanIv = atmIv ?? (ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : undefined);
    const carryOf = (e: string): number => {
      const q = carry.get(e);
      if (q === undefined) throw new NoLiveData(`No live forward for ${symbol} ${e}`);
      return q;
    };
    const est = estimateMargin(legs, S, md.pricing.valuationTs(ts, undefined, symbol), { r: md.pricing.r, carry: carryOf, volScanIv, exchange: md.calendar.exchange }, marginParamsOf(u.kind));
    if (!est.margin) throw new NoLiveData(est.reason ?? 'Margin cannot be estimated');
    return est.margin.total;
  }

  private fundsFor(uid: string, positions: Position[], ts: number): Funds {
    const user = this.db.data.users[uid];
    const opening = user?.openingBalance ?? 1_000_000;
    const gaps = new Gaps();
    let realized = 0;
    let unrealized: number | null = 0;
    let premiumPaid = 0;
    let premiumReceived = 0;
    let mtmLossBlock: number | null = 0;
    const bySymbol = new Map<string, Position[]>();
    for (const p of positions) {
      realized += p.realized;
      if (p.unrealized === null) {
        unrealized = null;
        gaps.add('unrealizedPnl', p.reason ?? `No live price for ${p.instrument}`);
      } else if (unrealized !== null) unrealized += p.unrealized;
      if (p.netQty === 0) continue;
      const isOpt = p.type !== 'FUT';
      if (isOpt && p.netQty > 0) premiumPaid += p.netQty * p.avgPrice;
      else {
        if (isOpt) premiumReceived += -p.netQty * p.avgPrice;
        if (p.unrealized === null) mtmLossBlock = null;
        else if (mtmLossBlock !== null) mtmLossBlock += Math.min(0, p.unrealized);
      }
      const list = bySymbol.get(p.symbol) ?? [];
      list.push(p);
      bySymbol.set(p.symbol, list);
    }
    let usedMargin: number | null = 0;
    for (const [symbol, list] of bySymbol) {
      const m = gaps.try('margin', () => this.marginFor(symbol, list, ts));
      if (m === null) usedMargin = null;
      else if (usedMargin !== null) usedMargin += m;
    }
    let available: number | null = null;
    if (mtmLossBlock !== null && usedMargin !== null) available = opening + realized + mtmLossBlock - usedMargin - premiumPaid;
    else gaps.add('available', mtmLossBlock === null ? 'A short position has no live price: its loss cannot be blocked' : 'Margin cannot be estimated');
    return {
      openingBalance: opening,
      available: r2(available),
      usedMargin: r2(usedMargin),
      realizedPnl: +realized.toFixed(2),
      unrealizedPnl: r2(unrealized),
      premiumPaid: +premiumPaid.toFixed(2),
      premiumReceived: +premiumReceived.toFixed(2),
      ...gaps.out(),
    };
  }

  funds(uid: string): Funds {
    const ts = this.now();
    return this.fundsFor(uid, this.positions(uid), ts);
  }

  place(uid: string, req: OrderRequest): Order {
    return this.placeOrder(uid, req, MAX_LOTS_PER_ORDER);
  }

  private placeOrder(uid: string, req: OrderRequest, maxLots: number): Order {
    const ts = this.now();
    if (!Number.isInteger(req.lots) || req.lots < 1 || req.lots > maxLots) throw httpError(400, `Lots must be between 1 and ${MAX_LOTS_PER_ORDER}`);
    if (req.type !== 'FUT' && !(Number(req.strike) > 0)) throw httpError(400, 'Strike is required for options');
    if ((req.orderType === 'LIMIT' || req.orderType === 'SL') && !(Number(req.price) > 0)) throw httpError(400, 'Limit price is required');
    if ((req.orderType === 'SL' || req.orderType === 'SL-M') && !(Number(req.triggerPrice) > 0)) throw httpError(400, 'Trigger price is required');
    const symbol = this.md.ref.underlying(req.symbol).symbol;
    const spec: InstrumentSpec = { symbol, type: req.type, strike: req.type === 'FUT' ? undefined : Number(req.strike), expiry: req.expiry };
    const listing = this.pricer.validate(spec, ts, { trade: true });
    const tick = listing.tickSize;
    if (tick && tick > 0) {
      for (const [name, v] of [['Price', req.price], ['Trigger price', req.triggerPrice]] as const) {
        if (v !== undefined && Number(v) > 0 && !onTick(Number(v), tick)) throw httpError(400, `${name} must be a multiple of the tick size ₹${tick}`);
      }
    }
    // Stream it now; the user-contract tier picks working orders up within a minute.
    this.md.live.watch([specKey(spec)], 'quote');
    const order: Order = {
      ...req,
      symbol,
      strike: spec.strike,
      id: `ORD-${randomUUID().slice(0, 8).toUpperCase()}`,
      instrument: instrumentLabel(spec),
      quantity: req.lots * listing.lotSize,
      status: req.orderType === 'SL' || req.orderType === 'SL-M' ? 'TRIGGER_PENDING' : 'OPEN',
      avgPrice: 0,
      filledQty: 0,
      createdAt: ts,
      updatedAt: ts,
    };
    this.orders(uid).unshift(order);
    this.process(uid, order, ts);
    this.db.save();
    return order;
  }

  /** The order only reduces an existing position of the same contract and product (never flips it). */
  private reducesRisk(uid: string, order: Order): boolean {
    const key = instrumentKey({ symbol: order.symbol, type: order.type, strike: order.strike, expiry: order.expiry, product: order.product });
    const agg = this.aggregate(this.trades(uid), this.orders(uid)).find((a) => a.key === key);
    if (!agg) return false;
    const net = agg.buyQty - agg.sellQty;
    return (order.side === 'BUY' ? net < 0 : net > 0) && order.quantity <= Math.abs(net);
  }

  /** Try to trigger / fill a working order against the live market. */
  private process(uid: string, order: Order, ts: number): void {
    if (order.status !== 'OPEN' && order.status !== 'TRIGGER_PENDING') return;
    const spec: InstrumentSpec = { symbol: order.symbol, type: order.type, strike: order.strike, expiry: order.expiry };
    if (this.md.calendarOf(order.symbol).expiryTs(order.expiry) < ts) {
      this.finish(uid, order, 'CANCELLED', 'Contract expired before execution', ts);
      return;
    }
    if (ts >= this.dayOrderEnd(order)) {
      this.finish(uid, order, 'CANCELLED', 'Day order expired', ts);
      return;
    }
    const isMarket = order.orderType === 'MARKET';
    let px;
    try {
      px = this.pricer.price(spec, ts);
    } catch (e) {
      if (!isClientError(e)) throw e;
      if (isMarket) this.finish(uid, order, 'REJECTED', `No live bid/ask for ${order.instrument}: ${errMsg(e)}`, ts);
      return; // working orders wait for live prices
    }
    const open = this.md.calendarOf(order.symbol).session(this.md.clock.now()).status === 'open';
    if (order.status === 'TRIGGER_PENDING') {
      if (!open || px.ltp === null) return;
      const hit = order.side === 'BUY' ? px.ltp >= order.triggerPrice! : px.ltp <= order.triggerPrice!;
      if (!hit) return;
      order.status = 'OPEN';
      order.updatedAt = ts;
    }
    const market = order.side === 'BUY' ? px.ask : px.bid;
    if (market === null) {
      if (isMarket) this.finish(uid, order, 'REJECTED', `No live bid/ask for ${order.instrument}${open ? '' : ' (market closed)'}`, ts);
      return;
    }
    let fillPrice: number | null = null;
    if (isMarket || order.orderType === 'SL-M') fillPrice = market;
    else if (order.side === 'BUY' && market <= order.price!) fillPrice = market;
    else if (order.side === 'SELL' && market >= order.price!) fillPrice = market;
    if (fillPrice === null) return;

    const trades = this.trades(uid);
    const orders = this.orders(uid);
    const trade: Trade = { id: `TRD-${randomUUID().slice(0, 8).toUpperCase()}`, orderId: order.id, instrument: order.instrument, symbol: order.symbol, side: order.side, quantity: order.quantity, price: fillPrice, ts };

    // Margin check on the post-trade portfolio; orders that only reduce a position always pass.
    if (!this.reducesRisk(uid, order)) {
      const before = this.fundsFor(uid, this.toPositions(this.aggregate(trades, orders), ts), ts);
      const afterPositions = this.toPositions(this.aggregate([trade, ...trades], orders), ts);
      // The traded contract without a live-session trade yet is marked at its fill (a live bid/ask).
      const key = instrumentKey({ symbol: order.symbol, type: order.type, strike: order.strike, expiry: order.expiry, product: order.product });
      for (const p of afterPositions) {
        if (p.key === key && p.status === 'open' && p.ltp === null) {
          p.ltp = fillPrice;
          p.unrealized = p.netQty * (fillPrice - p.avgPrice);
          p.pnl = p.realized + p.unrealized;
        }
      }
      const after = this.fundsFor(uid, afterPositions, ts);
      if (after.available === null) {
        const why = after.gaps?.margin ?? after.gaps?.available ?? 'live prices are missing';
        this.finish(uid, order, 'REJECTED', `Margin cannot be estimated: ${why}`, ts);
        return;
      }
      if (after.available < 0 && (before.available === null || after.available < before.available)) {
        const inr = (v: number) => `₹${Math.round(v).toLocaleString('en-IN')}`;
        // Unknown current funds (a position without a live price) are said so, never shown as ₹0.
        const message =
          before.available !== null
            ? `Insufficient funds: requires ${inr(before.available - after.available)}, available ${inr(Math.max(0, before.available))}`
            : `Insufficient funds: the order would leave the funds ${inr(-after.available)} short (current available funds unknown: ${before.gaps?.available ?? before.gaps?.margin ?? 'live prices are missing'})`;
        this.finish(uid, order, 'REJECTED', message, ts);
        return;
      }
    }
    trades.unshift(trade);
    order.avgPrice = fillPrice;
    order.filledQty = order.quantity;
    this.finish(uid, order, 'COMPLETE', undefined, ts);
  }

  /** Close (15:30; MCX 23:30/23:55) of the session a working order belongs to: the one it was placed in, or the next when placed after the close / on a holiday. */
  private dayOrderEnd(order: Order): number {
    const cal = this.md.calendarOf(order.symbol);
    let date = cal.session(order.createdAt).date;
    if (!cal.isTradingDay(date) || order.createdAt >= cal.ts(date, cal.sessionMinutes(date))) date = cal.next(date);
    return cal.ts(date, cal.sessionMinutes(date));
  }

  private finish(uid: string, order: Order, status: Order['status'], message: string | undefined, ts: number) {
    order.status = status;
    order.message = message;
    order.updatedAt = ts;
    this.emitOrder(uid, order);
    const verb = order.side === 'BUY' ? 'Bought' : 'Sold';
    if (status === 'COMPLETE') this.notify(uid, { kind: 'order', title: `Order executed`, body: `${verb} ${order.quantity} ${order.instrument} @ ₹${order.avgPrice.toFixed(2)}` });
    else if (status === 'REJECTED') this.notify(uid, { kind: 'order', title: 'Order rejected', body: `${order.instrument}: ${message}` });
    this.db.save();
  }

  cancel(uid: string, orderId: string): Order {
    const order = this.orders(uid).find((o) => o.id === orderId);
    if (!order) throw httpError(404, 'Order not found');
    if (order.status !== 'OPEN' && order.status !== 'TRIGGER_PENDING') throw httpError(400, `Order is ${order.status}`);
    this.finish(uid, order, 'CANCELLED', 'Cancelled by user', this.now());
    return order;
  }

  /**
   * Square off a position with MARKET orders. The user order limit (MAX_LOTS_PER_ORDER) does not apply:
   * a position larger than the exchange freeze quantity is placed in slices below the listing's
   * freeze quantity, else (freeze quantity not known) as one order. Slicing stops at the first slice
   * that does not complete (its reason is on that order). Returns the orders placed.
   */
  exitPosition(uid: string, key: string): Order[] {
    const pos = this.positions(uid).find((p) => p.key === key);
    if (!pos || pos.netQty === 0) throw httpError(404, 'No open position');
    if (pos.status === 'awaiting settlement') throw httpError(400, `${pos.instrument} has expired: it closes at the exchange settlement price`);
    const spec = specOf(pos);
    const listing = this.pricer.validate(spec, this.now(), { trade: true });
    const lots = Math.abs(pos.netQty) / pos.lotSize;
    // Freeze quantity (units): an order must stay below it; whole lots per slice.
    const freeze = listing.freezeQty;
    const perSlice = freeze && freeze > listing.lotSize ? Math.floor((freeze - 1) / listing.lotSize) : lots;
    const orders: Order[] = [];
    for (let left = lots; left > 0; ) {
      const n = Math.min(perSlice, left);
      const o = this.placeOrder(
        uid,
        { symbol: pos.symbol, type: pos.type, strike: pos.strike, expiry: pos.expiry, side: pos.netQty > 0 ? 'SELL' : 'BUY', lots: n, orderType: 'MARKET', product: pos.product, tag: 'exit' },
        Infinity,
      );
      orders.push(o);
      if (o.status !== 'COMPLETE') break;
      left -= n;
    }
    return orders;
  }

  reset(uid: string): void {
    this.db.data.orders[uid] = [];
    this.db.data.trades[uid] = [];
    this.db.save();
  }

  /**
   * Called every second: works pending orders for all users. Missing live data is expected (the order
   * is retried next tick); an unexpected error does not stop the other orders and is rethrown once
   * every order was worked (the services' tick wrapper reports it to onError).
   */
  tick(): void {
    const ts = this.now();
    const errors: unknown[] = [];
    for (const [uid, orders] of Object.entries(this.db.data.orders)) {
      for (const o of orders) {
        if (o.status !== 'OPEN' && o.status !== 'TRIGGER_PENDING') continue;
        try {
          this.process(uid, o, ts);
        } catch (e) {
          if (!isClientError(e)) errors.push(e); // this one is retried next tick
        }
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, `${errors.length} working orders failed: ${errors.slice(0, 3).map(errMsg).join('; ')}`);
  }

  /** Contracts of working orders and open positions of every user (streamed in the provider's 'user' tier). */
  openContracts(): InstrumentKey[] {
    const out: InstrumentKey[] = [];
    for (const [uid, orders] of Object.entries(this.db.data.orders)) {
      for (const o of orders) if (o.status === 'OPEN' || o.status === 'TRIGGER_PENDING') out.push(specKey(specOf(o)));
      for (const a of this.aggregate(this.trades(uid), orders)) if (a.buyQty !== a.sellQty) out.push(specKey(specOf(a)));
    }
    return out;
  }
}

/* ======================================================================= */
/* Strategy manager (virtual / paper strategies)                            */
/* ======================================================================= */

export interface StrategyInput {
  name?: string;
  symbol: string;
  legs: Leg[];
  notes?: string;
  targetMtm?: number | null;
  stopLossMtm?: number | null;
}

export class StrategyManager {
  constructor(
    private readonly md: MarketDataProvider,
    private readonly db: Db,
    private readonly pricer: Pricer,
    private readonly now: () => number,
  ) {}

  /**
   * Legs of a live contract are validated against the instrument master and take its lot size; a leg
   * without an entry price takes the live-session LTP (NoLiveData without one). Legs of an expired
   * contract that carry their price (the master no longer lists them) keep the lot size given, else
   * the contract's lot size from the official F&O file of its last day; NoLiveData when neither is
   * there (today's lot size of the underlying is never used for a past contract).
   */
  private normaliseLegs(symbol: string, legs: Leg[], ts: number): Leg[] {
    const u = this.md.ref.underlying(symbol);
    if (!Array.isArray(legs) || !legs.length) throw httpError(400, 'At least one leg is required');
    if (legs.length > 12) throw httpError(400, 'Maximum 12 legs');
    return legs.map((l, i) => {
      if (l.side !== 'BUY' && l.side !== 'SELL') throw httpError(400, 'Invalid side');
      if (!['CE', 'PE', 'FUT'].includes(l.type)) throw httpError(400, 'Invalid instrument type');
      const lots = Math.round(Number(l.lots));
      if (!(lots >= 1 && lots <= 500)) throw httpError(400, 'Invalid lots');
      const spec: InstrumentSpec = { symbol: u.symbol, type: l.type, strike: l.type === 'FUT' ? undefined : Number(l.strike), expiry: l.expiry };
      let price = Number(l.price);
      const expiredWithPrice = price > 0 && typeof l.expiry === 'string' && this.md.calendarOf(u.symbol).expiryTs(l.expiry) < ts;
      const listing = expiredWithPrice ? undefined : this.pricer.validate(spec, ts);
      if (!(price > 0)) {
        const ltp = this.pricer.price(spec, ts).ltp;
        if (ltp === null) throw new NoLiveData(`No live price for ${instrumentLabel(spec)} to use as the entry price`);
        price = ltp;
      }
      let lotSize = listing?.lotSize ?? (Number(l.lotSize) > 1 ? Number(l.lotSize) : null);
      if (lotSize === null) {
        lotSize = this.pricer.pastLotSize(specKey(spec));
        if (lotSize === null) throw new NoLiveData(`Lot size of ${instrumentLabel(spec)} is unknown: the contract has expired and the official F&O file of ${l.expiry} (its last day) is not loaded; send the leg's lot size`);
      }
      return {
        id: l.id ?? `leg-${i}-${randomUUID().slice(0, 6)}`,
        side: l.side,
        type: l.type,
        strike: l.type === 'FUT' ? 0 : Number(l.strike),
        expiry: l.expiry,
        lots,
        lotSize,
        price: +price.toFixed(2),
        iv: l.iv,
        exitPrice: l.exitPrice ?? null,
        active: l.active !== false,
      };
    });
  }

  /** Live MTM: open legs at their live-session LTP (null MTM when one is not live), exited legs at their exit; expired legs exit at the settlement. */
  private withLive(s: SavedStrategy, ts: number): SavedStrategy {
    const gaps = new Gaps();
    let mtm = 0;
    let mtmKnown = true;
    let realized = 0;
    let changed = false;
    const legsLtp = s.legs.map((l) => {
      const spec: InstrumentSpec = { symbol: s.symbol, type: l.type, strike: l.type === 'FUT' ? undefined : l.strike, expiry: l.expiry };
      const label = instrumentLabel(spec);
      let ltp: number | null = null;
      try {
        const px = this.pricer.price(spec, ts);
        ltp = px.ltp;
        if (px.expired && l.exitPrice == null && px.ltp !== null) {
          l.exitPrice = px.ltp;
          changed = true;
        }
        if (ltp === null && l.exitPrice == null && l.active !== false) gaps.add(label, px.reason ?? `No live price for ${label}`);
      } catch (e) {
        if (!isClientError(e)) throw e;
        if (l.exitPrice == null && l.active !== false) gaps.add(label, errMsg(e));
      }
      if (l.active === false) return ltp;
      const exit = l.exitPrice ?? ltp;
      if (exit === null) {
        mtmKnown = false;
        return ltp;
      }
      const pnl = l.lots * l.lotSize * (l.side === 'BUY' ? 1 : -1) * (exit - l.price);
      mtm += pnl;
      if (l.exitPrice != null) realized += pnl;
      return ltp;
    });
    if (changed) {
      if (s.legs.every((l) => l.exitPrice != null)) s.status = 'expired';
      this.db.save();
    }
    let spot: number | null = null;
    try {
      spot = livePrice(this.md, this.md.live.quote(spotKey(s.symbol)));
    } catch {
      spot = null;
    }
    if (spot === null) gaps.add('spot', `No live ${s.symbol} price`);
    const g = gaps.out();
    return { ...s, live: { mtm: mtmKnown ? +mtm.toFixed(2) : null, realized: +realized.toFixed(2), spot, legsLtp, ts, ...(g.gaps ? { gaps: g.gaps } : {}) } };
  }

  list(uid: string): SavedStrategy[] {
    const ts = this.now();
    return this.db.list('strategies', uid).map((s) => this.withLive(s, ts));
  }

  get(uid: string, id: string): SavedStrategy {
    const s = this.db.list('strategies', uid).find((x) => x.id === id);
    if (!s) throw httpError(404, 'Strategy not found');
    return this.withLive(s, this.now());
  }

  create(uid: string, input: StrategyInput): SavedStrategy {
    const ts = this.now();
    const symbol = this.md.ref.underlying(input.symbol).symbol;
    const legs = this.normaliseLegs(symbol, input.legs, ts);
    const s: SavedStrategy = {
      id: randomUUID(),
      name: (input.name ?? '').trim() || `${symbol} strategy`,
      symbol,
      legs,
      notes: input.notes,
      createdAt: ts,
      updatedAt: ts,
      targetMtm: input.targetMtm ?? null,
      stopLossMtm: input.stopLossMtm ?? null,
      status: 'open',
    };
    this.db.list('strategies', uid).unshift(s);
    this.db.save();
    return this.withLive(s, ts);
  }

  update(uid: string, id: string, patch: Partial<StrategyInput>): SavedStrategy {
    const s = this.db.list('strategies', uid).find((x) => x.id === id);
    if (!s) throw httpError(404, 'Strategy not found');
    const ts = this.now();
    if (patch.legs) s.legs = this.normaliseLegs(s.symbol, patch.legs, ts);
    if (patch.name !== undefined) s.name = patch.name.trim() || s.name;
    if (patch.notes !== undefined) s.notes = patch.notes;
    if (patch.targetMtm !== undefined) s.targetMtm = patch.targetMtm;
    if (patch.stopLossMtm !== undefined) s.stopLossMtm = patch.stopLossMtm;
    s.status = s.legs.every((l) => l.exitPrice != null) ? 'closed' : 'open';
    s.updatedAt = ts;
    this.db.save();
    return this.withLive(s, ts);
  }

  /**
   * Exit legs at live prices: a long leg at the live bid, a short leg at the live ask, else the
   * live-session LTP; an expired leg at its settlement. All-or-nothing: NoLiveData when any leg has
   * no live price (nothing is changed then).
   */
  exit(uid: string, id: string, legIds?: string[]): SavedStrategy {
    const s = this.db.list('strategies', uid).find((x) => x.id === id);
    if (!s) throw httpError(404, 'Strategy not found');
    const ts = this.now();
    const exits = new Map<Leg, number>();
    for (const l of s.legs) {
      if (l.exitPrice != null) continue;
      if (legIds && legIds.length && !legIds.includes(l.id!)) continue;
      const spec: InstrumentSpec = { symbol: s.symbol, type: l.type, strike: l.type === 'FUT' ? undefined : l.strike, expiry: l.expiry };
      const px = this.pricer.price(spec, ts);
      const price = px.expired ? px.ltp : ((l.side === 'BUY' ? px.bid : px.ask) ?? px.ltp);
      if (price === null) throw new NoLiveData(`No live price to exit ${instrumentLabel(spec)}`);
      exits.set(l, price);
    }
    for (const [l, price] of exits) l.exitPrice = price;
    if (s.legs.every((l) => l.exitPrice != null)) s.status = 'closed';
    s.updatedAt = ts;
    this.db.save();
    return this.withLive(s, ts);
  }

  remove(uid: string, id: string): void {
    const list = this.db.list('strategies', uid);
    const idx = list.findIndex((x) => x.id === id);
    if (idx < 0) throw httpError(404, 'Strategy not found');
    list.splice(idx, 1);
    this.db.save();
  }

  /** Legs of open strategies still running (streamed in the provider's 'user' tier). */
  openContracts(): InstrumentKey[] {
    const out: InstrumentKey[] = [];
    for (const list of Object.values(this.db.data.strategies)) {
      for (const s of list) {
        if (s.status !== 'open') continue;
        for (const l of s.legs) {
          if (l.exitPrice != null || l.active === false) continue;
          out.push(specKey({ symbol: s.symbol, type: l.type, strike: l.type === 'FUT' ? undefined : l.strike, expiry: l.expiry }));
        }
      }
    }
    return out;
  }
}
