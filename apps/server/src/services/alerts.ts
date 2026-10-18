/**
 * Alerts (price / option / IV / PCR / OI / MTM / opening range / order flow), notifications and
 * watchlists, on live data only. Each alert is evaluated on the live value of its input:
 *  - PRICE, OPTION_PRICE, OI_CHANGE: the Pricer (live-session trade price; OI vs the previous
 *    session's OI from the quote or the official file);
 *  - IV: ATM IV solved from live premiums (md.pricing.atmIv);
 *  - PCR: the live option chain's aggregate (strikes with OI on both sides), built once per cycle;
 *  - MTM: the strategy's live MTM (StrategyManager);
 *  - ORB_BREAK: the opening range on recorded 1-minute bars (Analytics.orbConfirmed);
 *  - ORDER_FLOW: the recorded quote-rule flow of the near-month future's last completed minute.
 * An alert whose input is not live is skipped for that cycle (`statusNote` says why, `lastValue`
 * is null); it is never evaluated against a stand-in value.
 */
import { randomUUID } from 'node:crypto';
import { describeOrb, expiryTs, formatExpiry, formatIndian, formatTimeIST, type AlertDef, type Notification, type OptionChain, type OrbEvaluation, type WatchItem, type Watchlist, type WatchQuote } from '@q26/core';
import { NoLiveData } from '../live/types';
import type { MarketDataProvider } from '../live/types';
import type { Db } from '../store/db';
import type { Analytics } from './analytics';
import { buildOptionChain, httpError, nearFuture, pct, r2 } from './live';
import type { LastMinuteFlow, MarketTools } from './market-tools';
import { instrumentLabel, type InstrumentSpec, type Pricer } from './pricer';
import type { StrategyManager } from './trading';

const MAX_ALERTS = 100;
/** Opening-range lengths an ORB_BREAK alert may use (minutes). */
const ORB_RANGES = [5, 15, 30];
/**
 * An ORDER_FLOW alert is evaluated only on a minute in which at least this share of the traded
 * volume could be classified (quote rule): a buy % of a small classified remainder says little.
 */
export const MIN_CLASSIFIED_SHARE = 0.5;
const MINUTE = 60_000;

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** A 4xx error raised by validation (unknown symbol, contract not listed …). */
const isClientError = (e: unknown): boolean => {
  const code = (e as { statusCode?: unknown } | null)?.statusCode;
  return e instanceof Error && typeof code === 'number' && code >= 400 && code < 500;
};

export class Notifier {
  private listeners = new Set<(uid: string, n: Notification) => void>();
  constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

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

/** What one evaluation saw: a live value, a reason to skip this cycle, or a reason to disable the alert. */
type Reading = { value: number } | { skip: string } | { disable: string };

/** Per-evaluation caches (one live chain per symbol, one ORB evaluation per symbol and range). */
interface Cycle {
  ts: number;
  values: Map<string, Reading>;
  chains: Map<string, Promise<OptionChain>>;
  orb: Map<string, Promise<OrbEvaluation | null>>;
  /** Last completed recorded minute of each symbol's near future, or why there is none. */
  flows: Map<string, LastMinuteFlow | string>;
}

export class AlertService {
  private running: Promise<void> | null = null;

  constructor(
    private readonly md: MarketDataProvider,
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
    if (this.list(uid).length >= MAX_ALERTS) throw httpError(400, `At most ${MAX_ALERTS} alerts — delete some first`);
    if (input.kind === 'ORB_BREAK') {
      // value = opening-range length in minutes (the lengths the app offers)
      const v = Number(input.value) || 15;
      if (!ORB_RANGES.includes(v)) throw httpError(400, `Opening range must be one of ${ORB_RANGES.join(', ')} minutes`);
      input = { ...input, value: v };
    }
    if (input.kind === 'ORDER_FLOW' && !(Number(input.value) >= 0 && Number(input.value) <= 100)) throw httpError(400, 'Buy volume % must be between 0 and 100');
    if (input.condition !== 'above' && input.condition !== 'below') throw httpError(400, 'Invalid condition');
    if (!Number.isFinite(Number(input.value))) throw httpError(400, 'Invalid value');
    let symbol = input.symbol;
    if (input.kind === 'MTM') {
      if (!input.strategyId) throw httpError(400, 'strategyId is required');
      this.strategies.get(uid, input.strategyId);
    } else symbol = this.md.ref.underlying(input.symbol).symbol;
    if (input.kind === 'OPTION_PRICE' || input.kind === 'OI_CHANGE') {
      if (!input.optionType || !input.strike || !input.expiry) throw httpError(400, 'Option contract (type, strike, expiry) is required');
      this.pricer.validate({ symbol, type: input.optionType, strike: Number(input.strike), expiry: input.expiry }, this.now());
    }
    if (input.kind === 'ORDER_FLOW' && !nearFuture(this.md, symbol, this.now())) throw httpError(400, `${symbol} has no listed future (order flow is measured on the near-month future)`);
    const alert: AlertDef = {
      id: randomUUID(),
      kind: input.kind,
      symbol,
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
      a.statusNote = undefined;
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
        return `${a.symbol} futures 1-min buy volume % (estimated from live ticks)`;
    }
  }

  private chainOf(symbol: string, cycle: Cycle): Promise<OptionChain> {
    let p = cycle.chains.get(symbol);
    if (!p) {
      p = buildOptionChain(this.md, symbol);
      p.catch(() => undefined); // awaited by every alert of the symbol; a rejection is a skip there
      cycle.chains.set(symbol, p);
    }
    return p;
  }

  /** The live value of an alert's input (cached per cycle, except MTM which is per user). */
  private async read(uid: string, a: AlertDef, cycle: Cycle): Promise<Reading> {
    if (a.kind === 'ORDER_FLOW') return this.readFlow(a, cycle); // depends on the alert's arming time
    const k = `${a.kind}|${a.symbol}|${a.optionType ?? ''}|${a.strike ?? ''}|${a.expiry ?? ''}|${a.kind === 'MTM' ? `${uid}|${a.strategyId}` : ''}`;
    const hit = cycle.values.get(k);
    if (hit) return hit;
    const reading = await this.readUncached(uid, a, cycle);
    cycle.values.set(k, reading);
    return reading;
  }

  private async readUncached(uid: string, a: AlertDef, cycle: Cycle): Promise<Reading> {
    const ts = cycle.ts;
    switch (a.kind) {
      case 'PRICE': {
        const px = this.pricer.price({ symbol: a.symbol, type: 'EQ' }, ts);
        return px.ltp !== null ? { value: px.ltp } : { skip: px.reason ?? `No live ${a.symbol} price` };
      }
      case 'OPTION_PRICE':
      case 'OI_CHANGE': {
        const spec: InstrumentSpec = { symbol: a.symbol, type: a.optionType!, strike: a.strike, expiry: a.expiry };
        const label = instrumentLabel(spec);
        if (!a.expiry || expiryTs(a.expiry) < ts) return { disable: `${label} has expired` };
        const px = this.pricer.price(spec, ts);
        if (a.kind === 'OPTION_PRICE') return px.ltp !== null ? { value: px.ltp } : { skip: px.reason ?? `${label} has not traded in the live session` };
        if (px.oiChangePct !== null) return { value: px.oiChangePct };
        return { skip: px.oi === null ? `No live OI for ${label}` : `No previous-session OI for ${label} (official F&O file not loaded yet?)` };
      }
      case 'IV': {
        const iv = pct(this.md.pricing.atmIv(a.symbol));
        return iv !== null ? { value: iv } : { skip: `${a.symbol} ATM IV could not be solved from live premiums` };
      }
      case 'PCR': {
        const chain = await this.chainOf(a.symbol, cycle);
        return chain.pcr !== null ? { value: chain.pcr } : { skip: chain.gaps?.oi ?? `${a.symbol} ${chain.expiry} PCR is not available` };
      }
      case 'MTM': {
        const s = this.strategies.get(uid, a.strategyId!);
        const mtm = s.live?.mtm ?? null;
        if (mtm !== null) return { value: mtm };
        const why = Object.entries(s.live?.gaps ?? {}).map(([what, reason]) => `${what}: ${reason}`);
        return { skip: why.length ? `MTM not live — ${why.slice(0, 3).join('; ')}` : 'MTM not live' };
      }
      case 'ORDER_FLOW':
        return this.readFlow(a, cycle);
      case 'ORB_BREAK':
        return { skip: 'ORB alerts are event-based' }; // evaluated by orbTriggered()
    }
  }

  /**
   * Buy % (of the classified volume) of the near future's last completed recorded minute, once that
   * minute completed after the alert was armed and at least MIN_CLASSIFIED_SHARE of it was classified.
   */
  private readFlow(a: AlertDef, cycle: Cycle): Reading {
    let f = cycle.flows.get(a.symbol);
    if (f === undefined) {
      let reason = 'No recorded order flow';
      f = this.tools.lastMinuteFlow(a.symbol, cycle.ts, (r) => (reason = r)) ?? reason;
      cycle.flows.set(a.symbol, f);
    }
    if (typeof f === 'string') return { skip: f };
    if (f.ts + MINUTE <= (a.armedAt ?? a.createdAt)) return { skip: `Waiting for a minute completed after the alert was armed (last recorded minute ${formatTimeIST(f.ts)})` };
    if (f.volume === 0) return { skip: `${formatTimeIST(f.ts)}: no trades in the ${a.symbol} ${formatExpiry(f.expiry)} future` };
    if (f.buyPct === null || (f.unclassifiedPct ?? 0) > (1 - MIN_CLASSIFIED_SHARE) * 100) {
      return { skip: `${formatTimeIST(f.ts)}: only ${(100 - (f.unclassifiedPct ?? 100)).toFixed(0)}% of the volume could be classified (needs ${MIN_CLASSIFIED_SHARE * 100}%)` };
    }
    return { value: f.buyPct };
  }

  private orbOf(symbol: string, minutes: number, cycle: Cycle): Promise<OrbEvaluation | null> {
    const key = `${symbol}|${minutes}`;
    let p = cycle.orb.get(key);
    if (!p) {
      p = Promise.resolve().then(async () => (await this.analytics.orbConfirmed(symbol, cycle.ts, minutes)) ?? null);
      p.catch(() => undefined);
      cycle.orb.set(key, p);
    }
    return p;
  }

  /** An opening-range alert fires on the first break of its side confirmed after it was armed. */
  private async orbTriggered(a: AlertDef, cycle: Cycle): Promise<{ ev: OrbEvaluation; hit: { level: number; price: number; at: number; summary: string } | null } | { skip: string }> {
    const ev = await this.orbOf(a.symbol, a.value, cycle);
    if (!ev) return { skip: `No recorded 1-minute bars of ${a.symbol} this session` };
    if (!ev.complete) return { ev, hit: null };
    const since = a.armedAt ?? a.createdAt;
    const want = a.condition === 'above' ? 'up' : 'down';
    // A 'close'-rule break is confirmed when its 1-minute candle closes; it must close strictly
    // after the alert was armed.
    const b = ev.crossings.find((x) => x.direction === want && x.ts + MINUTE > since);
    if (!b) return { ev, hit: null };
    return { ev, hit: { level: want === 'up' ? ev.high : ev.low, price: b.price, at: b.ts + MINUTE, summary: describeOrb(ev) } };
  }

  /**
   * Evaluate every active alert plus strategy target/stop-loss MTM levels. Concurrent calls share
   * one run. Errors other than missing live data are rethrown after every alert was looked at.
   */
  evaluate(): Promise<void> {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async run(): Promise<void> {
    const ts = this.now();
    const cycle: Cycle = { ts, values: new Map(), chains: new Map(), orb: new Map(), flows: new Map() };
    let failure: unknown;
    for (const [uid, alerts] of Object.entries(this.db.data.alerts)) {
      for (const a of alerts) {
        if (a.status !== 'active') continue;
        a.checkedAt = ts;
        try {
          if (a.kind === 'ORB_BREAK') {
            const r = await this.orbTriggered(a, cycle);
            if ('skip' in r) {
              a.lastValue = null;
              a.statusNote = r.skip;
              continue;
            }
            a.lastValue = Number.isFinite(r.ev.last) ? r2(r.ev.last) : null;
            a.statusNote = r.ev.complete ? undefined : `${a.value}-min opening range still forming`;
            if (!r.hit) continue;
            const hit = r.hit;
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
          const reading = await this.read(uid, a, cycle);
          if ('disable' in reading) {
            a.status = 'disabled';
            a.lastValue = null;
            a.statusNote = reading.disable;
            continue;
          }
          if ('skip' in reading) {
            a.lastValue = null;
            a.statusNote = reading.skip;
            continue;
          }
          const v = reading.value;
          a.lastValue = r2(v);
          a.statusNote = undefined;
          const hit = a.condition === 'above' ? v >= a.value : v <= a.value;
          if (!hit) continue;
          a.status = 'triggered';
          a.triggeredAt = ts;
          a.triggeredValue = r2(v) as number;
          this.notifier.push(uid, { kind: 'alert', title: `Alert: ${this.label(a)} ${a.condition} ${a.value}`, body: `Now ${v.toFixed(2)}${a.note ? ` — ${a.note}` : ''}` });
        } catch (e) {
          a.lastValue = null;
          if (e instanceof NoLiveData) a.statusNote = e.message;
          else if (isClientError(e)) {
            a.status = 'disabled';
            a.statusNote = errMsg(e);
          } else {
            a.statusNote = `Evaluation failed: ${errMsg(e)}`;
            failure ??= e;
          }
        }
      }
    }
    for (const [uid, list] of Object.entries(this.db.data.strategies)) {
      for (const s of list) {
        if (s.status !== 'open' || (s.targetMtm == null && s.stopLossMtm == null)) continue;
        const flags = s as typeof s & { _targetHit?: boolean; _slHit?: boolean };
        let mtm: number | null;
        try {
          mtm = this.strategies.get(uid, s.id).live?.mtm ?? null;
        } catch (e) {
          if (!(e instanceof NoLiveData) && !isClientError(e)) failure ??= e;
          continue;
        }
        if (mtm === null) continue; // not live: never compared against a stand-in
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
    if (failure !== undefined) throw failure;
  }
}

export const DEFAULT_WATCHLIST: WatchItem[] = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'FINNIFTY', 'RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'SBIN'].map((symbol) => ({ symbol, type: 'EQ' as const }));

export class Watchlists {
  constructor(
    private readonly db: Db,
    private readonly pricer: Pricer,
    private readonly now: () => number,
  ) {}

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

  /**
   * Live quotes of a watchlist's items (Pricer: live-session trade price, live book, OI vs the
   * previous session, solved IV). Values that are not live are null, with the quote's time and age
   * and the reason; an item that cannot be priced at all is a row of nulls with the reason.
   */
  quotes(uid: string, id: string): WatchQuote[] {
    const w = this.list(uid).find((x) => x.id === id);
    if (!w) throw httpError(404, 'Watchlist not found');
    const now = this.now();
    return w.items.map((it): WatchQuote => {
      try {
        const p = this.pricer.price(it, now);
        const reason = p.expired ? 'Expired: exchange settlement price' : p.reason;
        return {
          ...it,
          label: p.label,
          ltp: p.ltp,
          change: p.change,
          changePct: p.changePct,
          bid: p.bid,
          ask: p.ask,
          oi: p.oi,
          oiChangePct: p.oiChangePct,
          iv: p.iv,
          ts: p.ts,
          ageSec: p.ts !== null ? Math.max(0, Math.round((now - p.ts) / 1000)) : null,
          ...(reason ? { reason } : {}),
        };
      } catch (e) {
        if (!(e instanceof NoLiveData) && !isClientError(e)) throw e;
        let label = it.symbol;
        try {
          label = instrumentLabel(it);
        } catch {
          /* keep the symbol */
        }
        return { ...it, label, ltp: null, change: null, changePct: null, bid: null, ask: null, oi: null, oiChangePct: null, iv: null, ts: null, ageSec: null, reason: errMsg(e) };
      }
    });
  }
}
