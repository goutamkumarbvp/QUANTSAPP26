/**
 * Paper trading: a simulated broker (orders, trades, positions, funds with SPAN-style
 * margin) and the virtual strategy manager (saved multi-leg strategies with live MTM).
 */
import { randomUUID } from 'node:crypto';
import {
  estimateMargin,
  INDEX_MARGIN,
  STOCK_MARGIN,
  type Funds,
  type Leg,
  type Notification,
  type Order,
  type OrderRequest,
  type Position,
  type SavedStrategy,
  type Trade,
} from '@q26/core';
import type { MarketEngine } from '../market/engine';
import type { Db } from '../store/db';
import { instrumentKey, instrumentLabel, type Pricer } from './pricer';

const MAX_LOTS_PER_ORDER = 50;

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

export type Notify = (userId: string, n: Omit<Notification, 'id' | 'ts' | 'read'>) => void;
export type EmitOrder = (userId: string, order: Order) => void;

interface PositionAgg {
  key: string;
  symbol: string;
  type: Position['type'];
  strike?: number;
  expiry: string;
  product: Position['product'];
  buyQty: number;
  sellQty: number;
  buyValue: number;
  sellValue: number;
}

export class PaperBroker {
  constructor(
    private readonly engine: MarketEngine,
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
    for (const t of trades) {
      const o = byOrder.get(t.orderId);
      if (!o) continue;
      const key = instrumentKey({ symbol: o.symbol, type: o.type, strike: o.strike, expiry: o.expiry, product: o.product });
      const agg = map.get(key) ?? { key, symbol: o.symbol, type: o.type, strike: o.strike, expiry: o.expiry, product: o.product, buyQty: 0, sellQty: 0, buyValue: 0, sellValue: 0 };
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
      const inst = this.engine.inst(a.symbol);
      const px = this.pricer.price({ symbol: a.symbol, type: a.type, strike: a.strike, expiry: a.expiry }, ts);
      const netQty = a.buyQty - a.sellQty;
      const buyAvg = a.buyQty ? a.buyValue / a.buyQty : 0;
      const sellAvg = a.sellQty ? a.sellValue / a.sellQty : 0;
      const closed = Math.min(a.buyQty, a.sellQty);
      let realized = closed * (sellAvg - buyAvg);
      const avgPrice = netQty > 0 ? buyAvg : netQty < 0 ? sellAvg : 0;
      let unrealized = netQty * (px.ltp - avgPrice);
      let status: Position['status'] = netQty === 0 ? 'closed' : 'open';
      if (px.expired && netQty !== 0) {
        realized += unrealized;
        unrealized = 0;
        status = 'expired';
      }
      return {
        key: a.key,
        instrument: instrumentLabel({ symbol: a.symbol, type: a.type, strike: a.strike, expiry: a.expiry }),
        symbol: a.symbol,
        type: a.type,
        strike: a.strike,
        expiry: a.expiry,
        product: a.product,
        netQty: status === 'expired' ? 0 : netQty,
        lotSize: inst.lotSize,
        avgPrice: +avgPrice.toFixed(2),
        buyQty: a.buyQty,
        sellQty: a.sellQty,
        buyValue: +a.buyValue.toFixed(2),
        sellValue: +a.sellValue.toFixed(2),
        ltp: px.ltp,
        realized: +realized.toFixed(2),
        unrealized: +unrealized.toFixed(2),
        pnl: +(realized + unrealized).toFixed(2),
        status,
      };
    });
  }

  positions(uid: string): Position[] {
    return this.toPositions(this.aggregate(this.trades(uid), this.orders(uid)), this.now());
  }

  private fundsFor(uid: string, positions: Position[], ts: number): Funds {
    const user = this.db.data.users[uid];
    const opening = user?.openingBalance ?? 1_000_000;
    let realized = 0;
    let unrealized = 0;
    let premiumPaid = 0;
    let premiumReceived = 0;
    let mtmLossBlock = 0;
    const legsBySymbol = new Map<string, Leg[]>();
    for (const p of positions) {
      realized += p.realized;
      unrealized += p.unrealized;
      if (p.netQty === 0) continue;
      const isOpt = p.type !== 'FUT';
      if (isOpt && p.netQty > 0) premiumPaid += p.netQty * p.avgPrice;
      else {
        if (isOpt) premiumReceived += -p.netQty * p.avgPrice;
        mtmLossBlock += Math.min(0, p.unrealized);
      }
      const legs = legsBySymbol.get(p.symbol) ?? [];
      legs.push({ side: p.netQty > 0 ? 'BUY' : 'SELL', type: p.type, strike: p.strike ?? 0, expiry: p.expiry, lots: Math.abs(p.netQty) / p.lotSize, lotSize: p.lotSize, price: p.ltp });
      legsBySymbol.set(p.symbol, legs);
    }
    let usedMargin = 0;
    for (const [symbol, legs] of legsBySymbol) {
      const inst = this.engine.inst(symbol);
      if (!legs.some((l) => l.side === 'SELL' || l.type === 'FUT')) continue;
      const spot = this.engine.spot(symbol, ts);
      const iv = this.engine.atmIv(symbol, ts);
      const m = estimateMargin(legs.map((l) => ({ ...l, iv })), spot, ts, { r: this.engine.r, carry: () => inst.divYield, defaultIv: iv }, inst.kind === 'index' ? INDEX_MARGIN : STOCK_MARGIN);
      usedMargin += m.total;
    }
    const available = opening + realized + mtmLossBlock - usedMargin - premiumPaid;
    return {
      openingBalance: opening,
      available: +available.toFixed(2),
      usedMargin: +usedMargin.toFixed(2),
      realizedPnl: +realized.toFixed(2),
      unrealizedPnl: +unrealized.toFixed(2),
      premiumPaid: +premiumPaid.toFixed(2),
      premiumReceived: +premiumReceived.toFixed(2),
    };
  }

  funds(uid: string): Funds {
    const ts = this.now();
    return this.fundsFor(uid, this.positions(uid), ts);
  }

  place(uid: string, req: OrderRequest): Order {
    const ts = this.now();
    if (!Number.isInteger(req.lots) || req.lots < 1 || req.lots > MAX_LOTS_PER_ORDER) throw httpError(400, `Lots must be between 1 and ${MAX_LOTS_PER_ORDER}`);
    if (req.type !== 'FUT' && !(Number(req.strike) > 0)) throw httpError(400, 'Strike is required for options');
    if ((req.orderType === 'LIMIT' || req.orderType === 'SL') && !(Number(req.price) > 0)) throw httpError(400, 'Limit price is required');
    if ((req.orderType === 'SL' || req.orderType === 'SL-M') && !(Number(req.triggerPrice) > 0)) throw httpError(400, 'Trigger price is required');
    const spec = { symbol: req.symbol, type: req.type, strike: req.type === 'FUT' ? undefined : Number(req.strike), expiry: req.expiry };
    this.pricer.validate(spec, ts);
    const inst = this.engine.inst(req.symbol);
    const order: Order = {
      ...req,
      strike: spec.strike,
      id: `ORD-${randomUUID().slice(0, 8).toUpperCase()}`,
      instrument: instrumentLabel(spec),
      quantity: req.lots * inst.lotSize,
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

  /** Try to fill / trigger a working order against the current book. */
  private process(uid: string, order: Order, ts: number): void {
    if (order.status !== 'OPEN' && order.status !== 'TRIGGER_PENDING') return;
    const px = this.pricer.price({ symbol: order.symbol, type: order.type, strike: order.strike, expiry: order.expiry }, ts);
    if (px.expired) {
      this.finish(uid, order, 'CANCELLED', 'Contract expired before execution', ts);
      return;
    }
    if (order.status === 'TRIGGER_PENDING') {
      const hit = order.side === 'BUY' ? px.ltp >= order.triggerPrice! : px.ltp <= order.triggerPrice!;
      if (!hit) return;
      order.status = 'OPEN';
      order.updatedAt = ts;
    }
    const market = order.side === 'BUY' ? px.ask : px.bid;
    let fillPrice: number | null = null;
    if (order.orderType === 'MARKET' || order.orderType === 'SL-M') fillPrice = market;
    else if (order.side === 'BUY' && market <= order.price!) fillPrice = market;
    else if (order.side === 'SELL' && market >= order.price!) fillPrice = market;
    if (fillPrice === null) return;

    // Margin check on the post-trade portfolio; risk-reducing orders always pass.
    const trades = this.trades(uid);
    const orders = this.orders(uid);
    const trade: Trade = { id: `TRD-${randomUUID().slice(0, 8).toUpperCase()}`, orderId: order.id, instrument: order.instrument, symbol: order.symbol, side: order.side, quantity: order.quantity, price: fillPrice, ts };
    const before = this.fundsFor(uid, this.toPositions(this.aggregate(trades, orders), ts), ts);
    const after = this.fundsFor(uid, this.toPositions(this.aggregate([...trades, trade], orders), ts), ts);
    if (after.available < 0 && after.available < before.available) {
      this.finish(uid, order, 'REJECTED', `Insufficient funds: requires ₹${Math.round(before.available - after.available).toLocaleString('en-IN')}, available ₹${Math.round(before.available).toLocaleString('en-IN')}`, ts);
      return;
    }
    trades.unshift(trade);
    order.avgPrice = fillPrice;
    order.filledQty = order.quantity;
    this.finish(uid, order, 'COMPLETE', undefined, ts);
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

  exitPosition(uid: string, key: string): Order {
    const pos = this.positions(uid).find((p) => p.key === key);
    if (!pos || pos.netQty === 0) throw httpError(404, 'No open position');
    return this.place(uid, {
      symbol: pos.symbol, type: pos.type, strike: pos.strike, expiry: pos.expiry, side: pos.netQty > 0 ? 'SELL' : 'BUY', lots: Math.abs(pos.netQty) / pos.lotSize, orderType: 'MARKET', product: pos.product, tag: 'exit',
    });
  }

  reset(uid: string): void {
    this.db.data.orders[uid] = [];
    this.db.data.trades[uid] = [];
    this.db.save();
  }

  /** Called every second: works pending orders for all users. */
  tick(): void {
    const ts = this.now();
    for (const [uid, orders] of Object.entries(this.db.data.orders)) {
      for (const o of orders) {
        if (o.status === 'OPEN' || o.status === 'TRIGGER_PENDING') {
          try {
            this.process(uid, o, ts);
          } catch {
            /* keep ticking other orders */
          }
        }
      }
    }
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
  constructor(private readonly engine: MarketEngine, private readonly db: Db, private readonly pricer: Pricer, private readonly now: () => number) {}

  private normaliseLegs(symbol: string, legs: Leg[], ts: number): Leg[] {
    const inst = this.engine.inst(symbol);
    if (!Array.isArray(legs) || !legs.length) throw httpError(400, 'At least one leg is required');
    if (legs.length > 12) throw httpError(400, 'Maximum 12 legs');
    return legs.map((l, i) => {
      if (l.side !== 'BUY' && l.side !== 'SELL') throw httpError(400, 'Invalid side');
      if (!['CE', 'PE', 'FUT'].includes(l.type)) throw httpError(400, 'Invalid instrument type');
      const lots = Math.round(Number(l.lots));
      if (!(lots >= 1 && lots <= 500)) throw httpError(400, 'Invalid lots');
      const spec = { symbol, type: l.type, strike: l.type === 'FUT' ? undefined : Number(l.strike), expiry: l.expiry };
      let price = Number(l.price);
      if (!(price > 0)) {
        this.pricer.validate(spec, ts);
        price = this.pricer.price(spec, ts).ltp;
      }
      return {
        id: l.id ?? `leg-${i}-${randomUUID().slice(0, 6)}`,
        side: l.side,
        type: l.type,
        strike: l.type === 'FUT' ? 0 : Number(l.strike),
        expiry: l.expiry,
        lots,
        lotSize: inst.lotSize,
        price: +price.toFixed(2),
        iv: l.iv,
        exitPrice: l.exitPrice ?? null,
        active: l.active !== false,
      };
    });
  }

  private withLive(s: SavedStrategy, ts: number): SavedStrategy {
    let mtm = 0;
    let realized = 0;
    let changed = false;
    const legsLtp = s.legs.map((l) => {
      const px = this.pricer.price({ symbol: s.symbol, type: l.type, strike: l.type === 'FUT' ? undefined : l.strike, expiry: l.expiry }, ts);
      if (px.expired && l.exitPrice == null) {
        l.exitPrice = px.ltp;
        changed = true;
      }
      const sign = l.side === 'BUY' ? 1 : -1;
      const qty = l.lots * l.lotSize * sign;
      const exit = l.exitPrice ?? px.ltp;
      const pnl = qty * (exit - l.price);
      if (l.active === false) return px.ltp;
      mtm += pnl;
      if (l.exitPrice != null) realized += pnl;
      return px.ltp;
    });
    if (changed) {
      if (s.legs.every((l) => l.exitPrice != null)) s.status = 'expired';
      this.db.save();
    }
    return { ...s, live: { mtm: +mtm.toFixed(2), realized: +realized.toFixed(2), spot: this.engine.spot(s.symbol, ts), legsLtp, ts } };
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
    const legs = this.normaliseLegs(input.symbol, input.legs, ts);
    const s: SavedStrategy = {
      id: randomUUID(),
      name: (input.name ?? '').trim() || `${input.symbol} strategy`,
      symbol: input.symbol,
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
    if (patch.name !== undefined) s.name = patch.name.trim() || s.name;
    if (patch.notes !== undefined) s.notes = patch.notes;
    if (patch.targetMtm !== undefined) s.targetMtm = patch.targetMtm;
    if (patch.stopLossMtm !== undefined) s.stopLossMtm = patch.stopLossMtm;
    if (patch.legs) s.legs = this.normaliseLegs(s.symbol, patch.legs, ts);
    s.status = s.legs.every((l) => l.exitPrice != null) ? 'closed' : 'open';
    s.updatedAt = ts;
    this.db.save();
    return this.withLive(s, ts);
  }

  exit(uid: string, id: string, legIds?: string[]): SavedStrategy {
    const s = this.db.list('strategies', uid).find((x) => x.id === id);
    if (!s) throw httpError(404, 'Strategy not found');
    const ts = this.now();
    for (const l of s.legs) {
      if (l.exitPrice != null) continue;
      if (legIds && legIds.length && !legIds.includes(l.id!)) continue;
      l.exitPrice = this.pricer.price({ symbol: s.symbol, type: l.type, strike: l.type === 'FUT' ? undefined : l.strike, expiry: l.expiry }, ts).ltp;
    }
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
}
