/** Alerts (price / option / IV / PCR / OI / MTM), notifications and watchlists. */
import { randomUUID } from 'node:crypto';
import { formatExpiry, formatIndian, formatTimeIST, type AlertDef, type Notification, type WatchItem, type Watchlist, type WatchQuote } from '@q26/core';
import type { Analytics } from './analytics';
import type { MarketTools } from './market-tools';
import type { MarketEngine } from '../market/engine';
import type { Db } from '../store/db';
import type { Pricer } from './pricer';
import type { StrategyManager } from './trading';

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

export class Notifier {
  private listeners = new Set<(uid: string, n: Notification) => void>();
  constructor(private readonly db: Db, private readonly now: () => number) {}

  onPush(fn: (uid: string, n: Notification) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  push(uid: string, n: Omit<Notification, 'id' | 'ts' | 'read'>): Notification {
    const full: Notification = { ...n, id: randomUUID(), ts: this.now(), read: false };
    const list = this.db.list('notifications', uid);
    list.unshift(full);
    if (list.length > 200) list.length = 200;
    this.db.save();
    for (const l of this.listeners) l(uid, full);
    return full;
  }

  list(uid: string): Notification[] {
    return this.db.list('notifications', uid);
  }

  markAllRead(uid: string): void {
    for (const n of this.db.list('notifications', uid)) n.read = true;
    this.db.save();
  }
}

export type AlertInput = Pick<AlertDef, 'kind' | 'symbol' | 'condition' | 'value'> & Partial<Pick<AlertDef, 'optionType' | 'strike' | 'expiry' | 'strategyId' | 'note'>>;

export class AlertService {
  constructor(
    private readonly engine: MarketEngine,
    private readonly db: Db,
    private readonly pricer: Pricer,
    private readonly strategies: StrategyManager,
    private readonly notifier: Notifier,
    private readonly now: () => number,
    private readonly analytics: Analytics,
    private readonly tools: MarketTools,
  ) {}

  list(uid: string): AlertDef[] {
    return this.db.list('alerts', uid);
  }

  create(uid: string, input: AlertInput): AlertDef {
    if (!['PRICE', 'OPTION_PRICE', 'IV', 'PCR', 'OI_CHANGE', 'MTM', 'ORB_BREAK', 'ORDER_FLOW'].includes(input.kind)) throw httpError(400, 'Invalid alert kind');
    if (input.kind === 'ORB_BREAK') {
      // value = opening-range length in minutes
      const v = Number(input.value) || 15;
      if (!(v >= 1 && v <= 120)) throw httpError(400, 'Opening range must be 1–120 minutes');
      input = { ...input, value: Math.round(v) };
    }
    if (input.kind === 'ORDER_FLOW' && !(Number(input.value) >= 0 && Number(input.value) <= 100)) throw httpError(400, 'Buy volume % must be between 0 and 100');
    if (input.condition !== 'above' && input.condition !== 'below') throw httpError(400, 'Invalid condition');
    if (!Number.isFinite(Number(input.value))) throw httpError(400, 'Invalid value');
    if (input.kind === 'MTM') {
      if (!input.strategyId) throw httpError(400, 'strategyId is required');
      this.strategies.get(uid, input.strategyId);
    } else this.engine.inst(input.symbol);
    if (input.kind === 'OPTION_PRICE' || input.kind === 'OI_CHANGE') {
      if (!input.optionType || !input.strike || !input.expiry) throw httpError(400, 'Option contract (type, strike, expiry) is required');
      this.pricer.validate({ symbol: input.symbol, type: input.optionType, strike: Number(input.strike), expiry: input.expiry }, this.now());
    }
    const alert: AlertDef = {
      id: randomUUID(),
      kind: input.kind,
      symbol: input.symbol,
      condition: input.condition,
      value: Number(input.value),
      optionType: input.optionType,
      strike: input.strike ? Number(input.strike) : undefined,
      expiry: input.expiry,
      strategyId: input.strategyId,
      note: input.note,
      status: 'active',
      createdAt: this.now(),
      armedAt: this.now(),
    };
    this.list(uid).unshift(alert);
    this.db.save();
    return alert;
  }

  remove(uid: string, id: string): void {
    const list = this.list(uid);
    const i = list.findIndex((a) => a.id === id);
    if (i < 0) throw httpError(404, 'Alert not found');
    list.splice(i, 1);
    this.db.save();
  }

  setStatus(uid: string, id: string, status: AlertDef['status']): AlertDef {
    const a = this.list(uid).find((x) => x.id === id);
    if (!a) throw httpError(404, 'Alert not found');
    a.status = status;
    if (status === 'active') {
      a.triggeredAt = undefined;
      a.triggeredValue = undefined;
      a.armedAt = this.now();
    }
    this.db.save();
    return a;
  }

  private label(a: AlertDef): string {
    switch (a.kind) {
      case 'PRICE':
        return `${a.symbol} price`;
      case 'OPTION_PRICE':
        return `${a.symbol} ${formatExpiry(a.expiry!)} ${a.strike} ${a.optionType} premium`;
      case 'OI_CHANGE':
        return `${a.symbol} ${formatExpiry(a.expiry!)} ${a.strike} ${a.optionType} OI change %`;
      case 'IV':
        return `${a.symbol} ATM IV`;
      case 'PCR':
        return `${a.symbol} PCR`;
      case 'MTM':
        return 'Strategy MTM';
      case 'ORB_BREAK':
        return `${a.symbol} ${a.value}-min opening range`;
      case 'ORDER_FLOW':
        return `${a.symbol} futures 1-min buy volume %`;
    }
  }

  /** Current observed value for an alert. */
  value(uid: string, a: AlertDef, ts: number, cache: Map<string, number>): number {
    const k = `${a.kind}|${a.symbol}|${a.optionType ?? ''}|${a.strike ?? ''}|${a.expiry ?? ''}|${a.strategyId ?? ''}`;
    const hit = cache.get(k);
    if (hit !== undefined && a.kind !== 'MTM') return hit;
    let v: number;
    switch (a.kind) {
      case 'PRICE':
        v = this.engine.spot(a.symbol, ts);
        break;
      case 'IV':
        v = this.engine.atmIv(a.symbol, ts) * 100;
        break;
      case 'PCR':
        v = this.engine.chain(a.symbol, undefined, ts).pcr;
        break;
      case 'OPTION_PRICE':
        v = this.pricer.price({ symbol: a.symbol, type: a.optionType!, strike: a.strike, expiry: a.expiry }, ts).ltp;
        break;
      case 'OI_CHANGE':
        v = this.pricer.price({ symbol: a.symbol, type: a.optionType!, strike: a.strike, expiry: a.expiry }, ts).oiChangePct ?? 0;
        break;
      case 'MTM':
        v = this.strategies.get(uid, a.strategyId!).live?.mtm ?? 0;
        break;
      case 'ORDER_FLOW':
        v = this.tools.orderFlow(a.symbol, { type: 'FUT' }, ts, { limit: 1 }).lastMinute?.buyPct ?? NaN;
        break;
      case 'ORB_BREAK':
        v = NaN; // event-based, see orbTriggered()
        break;
    }
    cache.set(k, v);
    return v;
  }

  /** An opening-range alert fires on the first break of its side confirmed after it was armed. */
  private orbTriggered(a: AlertDef, ts: number, cache: Map<string, unknown>): { level: number; price: number; at: number; summary: string } | null {
    const key = `orb|${a.symbol}|${a.value}`;
    let r = cache.get(key) as ReturnType<Analytics['orb']> | undefined;
    if (!r) {
      r = this.analytics.orb(a.symbol, ts, { rangeMinutes: a.value });
      cache.set(key, r);
    }
    const since = a.armedAt ?? a.createdAt;
    const want = a.condition === 'above' ? 'up' : 'down';
    // A 'close'-rule break is confirmed when its 1-minute candle closes.
    const hit = r.evaluation.crossings.find((b) => b.direction === want && b.ts + 60_000 >= since);
    if (!hit) return null;
    return { level: want === 'up' ? r.evaluation.high : r.evaluation.low, price: hit.price, at: hit.ts + 60_000, summary: r.summary };
  }

  /** Evaluate every active alert plus strategy target/stop-loss MTM levels. */
  evaluate(): void {
    const ts = this.now();
    const cache = new Map<string, number>();
    const orbCache = new Map<string, unknown>();
    for (const [uid, alerts] of Object.entries(this.db.data.alerts)) {
      for (const a of alerts) {
        if (a.status !== 'active') continue;
        if (a.kind === 'ORB_BREAK') {
          let hit: ReturnType<AlertService['orbTriggered']>;
          try {
            hit = this.orbTriggered(a, ts, orbCache);
          } catch {
            a.status = 'disabled';
            continue;
          }
          if (!hit) continue;
          a.status = 'triggered';
          a.triggeredAt = hit.at;
          a.triggeredValue = hit.price;
          const dir = a.condition === 'above' ? 'above' : 'below';
          this.notifier.push(uid, {
            kind: 'alert',
            title: `${a.symbol} broke ${dir} its ${a.value}-min opening range — trending ${a.condition === 'above' ? 'up' : 'down'}`,
            body: `${a.condition === 'above' ? 'High' : 'Low'} ${formatIndian(hit.level)} broken at ${formatTimeIST(hit.at)} (close ${formatIndian(hit.price)})${a.note ? ` — ${a.note}` : ''}`,
          });
          continue;
        }
        let v: number;
        try {
          v = this.value(uid, a, ts, cache);
        } catch {
          a.status = 'disabled';
          continue;
        }
        if (!Number.isFinite(v)) continue;
        const hit = a.condition === 'above' ? v >= a.value : v <= a.value;
        if (!hit) continue;
        a.status = 'triggered';
        a.triggeredAt = ts;
        a.triggeredValue = +v.toFixed(2);
        this.notifier.push(uid, { kind: 'alert', title: `Alert: ${this.label(a)} ${a.condition} ${a.value}`, body: `Now ${v.toFixed(2)}${a.note ? ` — ${a.note}` : ''}` });
      }
    }
    for (const [uid, list] of Object.entries(this.db.data.strategies)) {
      for (const s of list) {
        if (s.status !== 'open' || (s.targetMtm == null && s.stopLossMtm == null)) continue;
        const flags = s as typeof s & { _targetHit?: boolean; _slHit?: boolean };
        let mtm: number;
        try {
          mtm = this.strategies.get(uid, s.id).live?.mtm ?? 0;
        } catch {
          continue;
        }
        if (s.targetMtm != null && !flags._targetHit && mtm >= s.targetMtm) {
          flags._targetHit = true;
          this.notifier.push(uid, { kind: 'alert', title: `🎯 Target hit: ${s.name}`, body: `MTM ₹${mtm.toFixed(0)} ≥ target ₹${s.targetMtm}` });
        }
        if (s.stopLossMtm != null && !flags._slHit && mtm <= -Math.abs(s.stopLossMtm)) {
          flags._slHit = true;
          this.notifier.push(uid, { kind: 'alert', title: `🛑 Stop-loss hit: ${s.name}`, body: `MTM ₹${mtm.toFixed(0)} ≤ -₹${Math.abs(s.stopLossMtm)}` });
        }
      }
    }
    this.db.save();
  }
}

export const DEFAULT_WATCHLIST: WatchItem[] = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY', 'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'SBIN'].map((symbol) => ({ symbol, type: 'EQ' as const }));

export class Watchlists {
  constructor(private readonly db: Db, private readonly pricer: Pricer, private readonly now: () => number) {}

  list(uid: string): Watchlist[] {
    const lists = this.db.list('watchlists', uid);
    if (!lists.length) {
      lists.push({ id: randomUUID(), name: 'My Watchlist', items: [...DEFAULT_WATCHLIST] });
      this.db.save();
    }
    return lists;
  }

  create(uid: string, name: string): Watchlist {
    const lists = this.list(uid);
    if (lists.length >= 10) throw httpError(400, 'Maximum 10 watchlists');
    const w: Watchlist = { id: randomUUID(), name: name.trim() || `Watchlist ${lists.length + 1}`, items: [] };
    lists.push(w);
    this.db.save();
    return w;
  }

  update(uid: string, id: string, patch: { name?: string; items?: WatchItem[] }): Watchlist {
    const w = this.list(uid).find((x) => x.id === id);
    if (!w) throw httpError(404, 'Watchlist not found');
    if (patch.name !== undefined) w.name = patch.name.trim() || w.name;
    if (patch.items) {
      if (patch.items.length > 50) throw httpError(400, 'Maximum 50 items per watchlist');
      const ts = this.now();
      for (const it of patch.items) this.pricer.validate({ ...it, strike: it.strike !== undefined ? Number(it.strike) : undefined }, ts);
      w.items = patch.items.map((it) => ({ symbol: it.symbol, type: it.type, strike: it.strike !== undefined ? Number(it.strike) : undefined, expiry: it.expiry }));
    }
    this.db.save();
    return w;
  }

  remove(uid: string, id: string): void {
    const lists = this.list(uid);
    const i = lists.findIndex((x) => x.id === id);
    if (i < 0) throw httpError(404, 'Watchlist not found');
    lists.splice(i, 1);
    this.db.save();
  }

  quotes(uid: string, id: string): WatchQuote[] {
    const w = this.list(uid).find((x) => x.id === id);
    if (!w) throw httpError(404, 'Watchlist not found');
    const ts = this.now();
    return w.items.map((it) => {
      try {
        const p = this.pricer.price(it, ts);
        return { ...it, label: p.label, ltp: p.ltp, change: p.change, changePct: p.changePct, oi: p.oi, oiChangePct: p.oiChangePct, iv: p.iv };
      } catch {
        return { ...it, label: `${it.symbol} (unavailable)`, ltp: 0, change: 0, changePct: 0 };
      }
    });
  }
}
