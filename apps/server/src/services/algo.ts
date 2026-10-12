/**
 * Algo strategies: backtests on the simulated history and live deployments that trade through
 * the paper broker. The algos themselves are pure state machines in `@q26/core/algo`; this
 * service feeds them market snapshots and turns their orders into fills.
 */
import { randomUUID } from 'node:crypto';
import {
  ALGO_PRESETS,
  ALGOS,
  algoById,
  openPnl,
  totalCharges,
  type AlgoBacktestDay,
  type AlgoBacktestRange,
  type AlgoCatalog,
  type AlgoDaySummary,
  type AlgoDefinition,
  type AlgoEvent,
  type AlgoExitKind,
  type AlgoFill,
  type AlgoLeg,
  type AlgoRunView,
  type AlgoSeriesPoint,
  type AlgoSnapshot,
  type FillFn,
  type OptionSide,
} from '@q26/core';
import type { MarketClock } from '../market/clock';
import type { MarketEngine } from '../market/engine';
import type { Db } from '../store/db';
import type { Notifier } from './alerts';
import type { PaperBroker } from './trading';

const OPEN_MIN = 555; // 09:15
const M = 375; // session minutes
const MAX_RUNNING = 5;
const MAX_EVENTS_PER_DAY = 400;
const MAX_HISTORY = 250;
const INDEX_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAlgo = AlgoDefinition<any, any>;

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

export interface StoredAlgoDay {
  date: string;
  expiry: string;
  state: unknown;
  events: AlgoEvent[];
  series: AlgoSeriesPoint[];
  lastMinute: number;
  maxProfit: number;
  maxLoss: number;
  maxLevel: number;
  closed: boolean;
}

export interface StoredAlgoRun {
  id: string;
  algoId: string;
  presetId?: string;
  name: string;
  params: Record<string, unknown>;
  status: 'running' | 'stopped';
  createdAt: number;
  stoppedAt?: number;
  day: StoredAlgoDay | null;
  history: AlgoDaySummary[];
  error?: string;
}

export interface AlgoRunInput {
  algoId: string;
  presetId?: string;
  name?: string;
  params: Record<string, unknown>;
}

const FINAL_KINDS: AlgoExitKind[] = ['EXIT', 'STOP', 'ERROR', 'MANUAL_STOP'];

export class AlgoService {
  constructor(
    private readonly engine: MarketEngine,
    private readonly db: Db,
    private readonly broker: PaperBroker,
    private readonly notifier: Notifier,
    private readonly clock: MarketClock,
  ) {}

  /* ------------------------------- catalogue ------------------------------- */

  catalog(): AlgoCatalog {
    return {
      algos: ALGOS.map((a) => ({ id: a.id, name: a.name, description: a.description, rules: a.rules, params: a.params })),
      presets: ALGO_PRESETS,
      symbols: INDEX_SYMBOLS.filter((s) => this.engine.instruments.has(s)).map((s) => {
        const i = this.engine.inst(s);
        return { symbol: s, lotSize: i.lotSize, strikeStep: i.strikeStep, kind: i.kind };
      }),
    };
  }

  private algo(id: string): AnyAlgo {
    const a = algoById(id);
    if (!a) throw httpError(404, `Unknown algo ${id}`);
    return a;
  }

  defaults(algoId: string, symbol: string): Record<string, unknown> {
    return this.params(this.algo(algoId), { symbol });
  }

  /** Defaults for the symbol, overlaid with the user's values (numbers coerced), then validated. */
  params(algo: AnyAlgo, input: Record<string, unknown>): Record<string, unknown> {
    const symbol = String(input.symbol ?? 'NIFTY').toUpperCase();
    const inst = this.engine.inst(symbol);
    const p: Record<string, unknown> = { ...algo.defaults({ symbol, strikeStep: inst.strikeStep, kind: inst.kind }) };
    for (const spec of algo.params) {
      if (!(spec.key in input) || input[spec.key] === undefined || input[spec.key] === '') continue;
      const v = input[spec.key];
      if (spec.type === 'number') p[spec.key] = Number(v);
      else if (spec.type === 'boolean') p[spec.key] = v === true || v === 'true';
      else p[spec.key] = String(v);
    }
    p.symbol = symbol;
    const err = algo.validate(p);
    if (err) throw httpError(400, err);
    return p;
  }

  private pickExpiry(symbol: string, choice: unknown, ts: number): string {
    const list = this.engine.expiries(symbol, ts);
    const e = choice === 'next' ? list[1] : list[0];
    if (!e) throw httpError(400, `No ${choice === 'next' ? 'next' : 'current'} expiry listed for ${symbol}`);
    return e;
  }

  /** A market snapshot at an exact session minute (backtests) or a live timestamp. */
  private snapshot(symbol: string, expiry: string, dayIdx: number, at: { m: number } | { ts: number }): AlgoSnapshot {
    const e = this.engine;
    const ctx = e.contract(symbol, expiry);
    const strikes = e.strikes(ctx, dayIdx);
    const listed = new Set(strikes);
    const cache = new Map<string, number>();
    const minute = 'm' in at ? { dayIdx, m: at.m } : undefined;
    const ts = 'm' in at ? e.tsOf(dayIdx, at.m) : at.ts;
    const m = 'm' in at ? at.m : e.parts(at.ts).m;
    return {
      ts,
      minuteOfDay: OPEN_MIN + Math.floor(m),
      date: e.days[dayIdx],
      symbol,
      spot: minute ? e.spotAt(symbol, dayIdx, minute.m) : e.spot(symbol, ts),
      expiry,
      lotSize: ctx.inst.lotSize,
      strikes,
      premium(type: OptionSide, strike: number) {
        if (!listed.has(strike)) return null;
        const key = `${type}${strike}`;
        let v = cache.get(key);
        if (v === undefined) {
          v = e.optionAt(ctx, type, strike, ts, minute ? { minute } : {}).ltp;
          cache.set(key, v);
        }
        return v;
      },
    };
  }

  private point(algo: AnyAlgo, state: unknown, snap: AlgoSnapshot): AlgoSeriesPoint {
    const legs = algo.openLegs(state) as AlgoLeg[];
    const ce = legs.find((l) => l.type === 'CE') ?? null;
    const pe = legs.find((l) => l.type === 'PE') ?? null;
    return {
      ts: snap.ts,
      spot: +snap.spot.toFixed(2),
      mtm: Math.round(algo.realized(state) + openPnl(legs, snap)),
      level: algo.level?.(state) ?? 0,
      ceStrike: ce?.strike ?? null,
      ce: ce ? snap.premium('CE', ce.strike) : null,
      peStrike: pe?.strike ?? null,
      pe: pe ? snap.premium('PE', pe.strike) : null,
    };
  }

  private summary(algo: AnyAlgo, day: { date: string; expiry: string; state: unknown; events: AlgoEvent[]; maxProfit: number; maxLoss: number; maxLevel: number }, unrealized: number, lotSize: number): AlgoDaySummary {
    const fills = day.events.flatMap((e) => e.fills);
    const charges = totalCharges(fills, lotSize);
    const pnl = algo.realized(day.state) + unrealized;
    const last = [...day.events].reverse().find((e) => FINAL_KINDS.includes(e.kind as AlgoExitKind));
    const reason = (day.state as { stopReason?: string | null }).stopReason ?? '';
    return {
      date: day.date,
      expiry: day.expiry,
      entered: day.events.some((e) => e.kind === 'ENTRY'),
      pnl: Math.round(pnl),
      charges: Math.round(charges),
      net: Math.round(pnl) - Math.round(charges),
      adjustments: day.events.filter((e) => e.kind === 'ADJUSTMENT' && e.fills.length > 0).length,
      maxLevel: day.maxLevel,
      orders: fills.length,
      maxProfit: Math.round(day.maxProfit),
      maxLoss: Math.round(day.maxLoss),
      exitKind: (last?.kind as AlgoExitKind) ?? 'NONE',
      exitReason: last?.message ?? reason,
      exitTs: last?.ts ?? null,
    };
  }

  /* -------------------------------- backtests -------------------------------- */

  private runDay(algo: AnyAlgo, p: Record<string, unknown>, dayIdx: number, last: number, withSeries: boolean) {
    const e = this.engine;
    const symbol = String(p.symbol);
    const expiry = this.pickExpiry(symbol, p.expiry, e.tsOf(dayIdx, 0));
    const state = algo.init(p);
    const events: AlgoEvent[] = [];
    const series: AlgoSeriesPoint[] = [];
    let maxProfit = 0;
    let maxLoss = 0;
    let maxLevel = 0;
    let snap: AlgoSnapshot | null = null;
    for (let m = 0; m <= last; m++) {
      const s = this.snapshot(symbol, expiry, dayIdx, { m });
      snap = s;
      const fill: FillFn = (o) => {
        const px = s.premium(o.type, o.strike);
        if (px == null) throw new Error(`${o.strike} ${o.type} is not listed`);
        return px;
      };
      events.push(...algo.step(p, state, s, fill));
      const pt = this.point(algo, state, s);
      maxProfit = Math.max(maxProfit, pt.mtm);
      maxLoss = Math.min(maxLoss, pt.mtm);
      maxLevel = Math.max(maxLevel, pt.level);
      if (withSeries) series.push(pt);
      const phase = algo.phase(state);
      if (!withSeries && (phase === 'stopped' || phase === 'exited')) break;
    }
    const unrealized = snap ? openPnl(algo.openLegs(state) as AlgoLeg[], snap) : 0;
    const lotSize = e.inst(symbol).lotSize;
    const sum = this.summary(algo, { date: e.days[dayIdx], expiry, state, events, maxProfit, maxLoss, maxLevel }, unrealized, lotSize);
    return { sum, series, events, lotSize };
  }

  backtestDay(algoId: string, input: Record<string, unknown>, date: string | undefined, nowTs: number): AlgoBacktestDay {
    const algo = this.algo(algoId);
    const p = this.params(algo, input);
    const e = this.engine;
    const now = e.parts(nowTs);
    let dayIdx = now.dayIdx;
    if (date && date < now.date) {
      const idx = e.dayIndex.get(date);
      if (idx === undefined) throw httpError(400, `${date} is not a trading day`);
      dayIdx = idx;
    }
    const partial = dayIdx === now.dayIdx && now.m < M;
    const last = dayIdx === now.dayIdx ? Math.floor(now.m) : M;
    const r = this.runDay(algo, p, dayIdx, last, true);
    return { ...r.sum, algoId, symbol: String(p.symbol), lotSize: r.lotSize, partial, series: r.series, events: r.events };
  }

  backtestRange(algoId: string, input: Record<string, unknown>, days: number, nowTs: number): AlgoBacktestRange {
    const algo = this.algo(algoId);
    const p = this.params(algo, input);
    const e = this.engine;
    const now = e.parts(nowTs);
    const n = Math.max(1, Math.min(MAX_HISTORY, Math.floor(days)));
    // Completed sessions only: today counts once the market has closed.
    const lastIdx = now.m >= M ? now.dayIdx : now.dayIdx - 1;
    const first = Math.max(0, lastIdx - n + 1);
    const out: AlgoDaySummary[] = [];
    for (let i = first; i <= lastIdx; i++) out.push(this.runDay(algo, p, i, M, false).sum);
    let cum = 0;
    let peak = 0;
    let maxDd = 0;
    const equity = out.map((d) => {
      cum += d.net;
      peak = Math.max(peak, cum);
      maxDd = Math.max(maxDd, peak - cum);
      return { date: d.date, net: d.net, cum };
    });
    const traded = out.filter((d) => d.entered);
    const nets = traded.map((d) => d.net);
    const adj = traded.map((d) => d.adjustments);
    return {
      algoId,
      symbol: String(p.symbol),
      from: out[0]?.date ?? '',
      to: out[out.length - 1]?.date ?? '',
      days: out,
      equity,
      stats: {
        days: out.length,
        tradedDays: traded.length,
        winDays: nets.filter((x) => x > 0).length,
        lossDays: nets.filter((x) => x < 0).length,
        winRate: traded.length ? +((nets.filter((x) => x > 0).length / traded.length) * 100).toFixed(1) : 0,
        totalNet: cum,
        totalCharges: out.reduce((a, d) => a + d.charges, 0),
        avgNet: traded.length ? Math.round(cum / traded.length) : 0,
        bestDay: nets.length ? Math.max(...nets) : 0,
        worstDay: nets.length ? Math.min(...nets) : 0,
        maxDrawdown: maxDd,
        stoppedDays: out.filter((d) => d.exitKind === 'STOP' || d.exitKind === 'ERROR').length,
        avgAdjustments: adj.length ? +(adj.reduce((a, b) => a + b, 0) / adj.length).toFixed(2) : 0,
        maxAdjustments: adj.length ? Math.max(...adj) : 0,
      },
    };
  }

  /* ------------------------------ live deployments ------------------------------ */

  private runs(uid: string): StoredAlgoRun[] {
    return this.db.list('algoRuns', uid);
  }

  private find(uid: string, id: string): StoredAlgoRun {
    const r = this.runs(uid).find((x) => x.id === id);
    if (!r) throw httpError(404, 'Algo run not found');
    return r;
  }

  list(uid: string): AlgoRunView[] {
    return this.runs(uid).map((r) => this.view(r));
  }

  get(uid: string, id: string): AlgoRunView {
    return this.view(this.find(uid, id));
  }

  create(uid: string, input: AlgoRunInput): AlgoRunView {
    const algo = this.algo(input.algoId);
    const params = this.params(algo, input.params ?? {});
    const runs = this.runs(uid);
    if (runs.filter((r) => r.status === 'running').length >= MAX_RUNNING) throw httpError(400, `At most ${MAX_RUNNING} algos can run at once — stop one first`);
    const preset = input.presetId ? ALGO_PRESETS.find((x) => x.id === input.presetId) : undefined;
    const run: StoredAlgoRun = {
      id: `ALG-${randomUUID().slice(0, 8).toUpperCase()}`,
      algoId: algo.id,
      presetId: preset?.id,
      name: (input.name ?? '').trim() || preset?.name || algo.name,
      params,
      status: 'running',
      createdAt: this.clock.now(),
      day: null,
      history: [],
    };
    runs.unshift(run);
    this.notifier.push(uid, { kind: 'system', title: `Algo deployed · ${run.name}`, body: `${params.symbol} · ${params.lots} lot(s) per leg · paper trading` });
    this.tickRun(uid, run);
    this.db.save();
    return this.view(run);
  }

  stop(uid: string, id: string, reason = 'Stopped by user'): AlgoRunView {
    const run = this.find(uid, id);
    if (run.status !== 'running') throw httpError(400, 'Algo is not running');
    const algo = this.algo(run.algoId);
    const day = run.day;
    if (day && !day.closed) {
      const ts = this.clock.now();
      const snap = this.liveSnapshot(run, day, ts);
      const ev = algo.squareOff(run.params, day.state, snap, this.liveFill(uid, run, day), reason);
      this.record(uid, run, day, [ev]);
      this.closeDay(run, day, snap);
    }
    run.status = 'stopped';
    run.stoppedAt = this.clock.now();
    this.db.save();
    return this.view(run);
  }

  remove(uid: string, id: string): void {
    const runs = this.runs(uid);
    const i = runs.findIndex((x) => x.id === id);
    if (i < 0) throw httpError(404, 'Algo run not found');
    if (runs[i].status === 'running') throw httpError(400, 'Stop the algo before deleting it');
    runs.splice(i, 1);
    this.db.save();
  }

  /** Called every couple of seconds: advances every running algo of every user. */
  tick(): void {
    for (const [uid, runs] of Object.entries(this.db.data.algoRuns ?? {})) {
      for (const run of runs as StoredAlgoRun[]) {
        if (run.status === 'running') this.tickRun(uid, run);
      }
    }
  }

  private liveSnapshot(run: StoredAlgoRun, day: StoredAlgoDay, ts: number): AlgoSnapshot {
    const p = this.engine.parts(ts);
    return this.snapshot(String(run.params.symbol), day.expiry, p.dayIdx, { ts });
  }

  private liveFill(uid: string, run: StoredAlgoRun, day: StoredAlgoDay): FillFn {
    return (o) => {
      const order = this.broker.place(uid, {
        symbol: String(run.params.symbol),
        type: o.type,
        strike: o.strike,
        expiry: day.expiry,
        side: o.side,
        lots: o.lots,
        orderType: 'MARKET',
        product: 'MIS',
        tag: `algo:${run.id}`,
      });
      if (order.status !== 'COMPLETE') throw new Error(order.message ?? `order ${order.status.toLowerCase()}`);
      return order.avgPrice;
    };
  }

  private record(uid: string, run: StoredAlgoRun, day: StoredAlgoDay, events: AlgoEvent[]) {
    for (const ev of events) {
      day.events.push(ev);
      if (ev.kind === 'INFO' && !ev.fills.length) continue;
      const label = { ENTRY: 'entry', ADJUSTMENT: 'adjustment', STOP: 'stopped for the day', EXIT: 'exit', MANUAL_STOP: 'stopped', ERROR: 'error', INFO: 'update' }[ev.kind];
      this.notifier.push(uid, { kind: 'system', title: `Algo ${label} · ${run.name}`, body: ev.message });
    }
    if (day.events.length > MAX_EVENTS_PER_DAY) day.events.splice(0, day.events.length - MAX_EVENTS_PER_DAY);
  }

  private closeDay(run: StoredAlgoRun, day: StoredAlgoDay, snap: AlgoSnapshot) {
    if (day.closed) return;
    const algo = this.algo(run.algoId);
    day.closed = true;
    const unrealized = openPnl(algo.openLegs(day.state) as AlgoLeg[], snap);
    run.history.unshift(this.summary(algo, day, unrealized, snap.lotSize));
    if (run.history.length > MAX_HISTORY) run.history.length = MAX_HISTORY;
  }

  private tickRun(uid: string, run: StoredAlgoRun): void {
    const info = this.clock.info();
    if (info.status !== 'open') return;
    const ts = info.ts;
    const parts = this.engine.parts(ts);
    const algo = this.algo(run.algoId);
    try {
      let day = run.day;
      if (day && day.date !== parts.date) {
        if (!day.closed) {
          // The session ended without the algo's exit running (server down): flatten at today's prices.
          const snap = this.snapshot(String(run.params.symbol), day.expiry, parts.dayIdx, { ts });
          const ev = algo.squareOff(run.params, day.state, snap, this.liveFill(uid, run, day), `Missed the ${String(run.params.exitTime ?? 'exit')} exit on ${day.date}`);
          this.record(uid, run, day, [ev]);
          this.closeDay(run, day, snap);
        }
        day = null;
      }
      if (!day) {
        day = { date: parts.date, expiry: this.pickExpiry(String(run.params.symbol), run.params.expiry, ts), state: algo.init(run.params), events: [], series: [], lastMinute: -1, maxProfit: 0, maxLoss: 0, maxLevel: 0, closed: false };
        run.day = day;
      }
      if (day.closed) return;
      const snap = this.liveSnapshot(run, day, ts);
      const events = algo.step(run.params, day.state, snap, this.liveFill(uid, run, day));
      if (events.length) this.record(uid, run, day, events);
      const pt = this.point(algo, day.state, snap);
      day.maxProfit = Math.max(day.maxProfit, pt.mtm);
      day.maxLoss = Math.min(day.maxLoss, pt.mtm);
      day.maxLevel = Math.max(day.maxLevel, pt.level);
      const minute = Math.floor(parts.m);
      const newMinute = minute !== day.lastMinute;
      if (newMinute || events.length) {
        if (minute === day.lastMinute) day.series[day.series.length - 1] = pt;
        else day.series.push(pt);
        day.lastMinute = minute;
      }
      const phase = algo.phase(day.state);
      if (phase === 'stopped' || phase === 'exited') this.closeDay(run, day, snap);
      if (events.length || newMinute) this.db.save();
    } catch (err) {
      run.error = err instanceof Error ? err.message : String(err);
      run.status = 'stopped';
      run.stoppedAt = ts;
      this.notifier.push(uid, { kind: 'system', title: `Algo error · ${run.name}`, body: `${run.error}. The algo was stopped; check open positions.` });
      this.db.save();
    }
  }

  private view(run: StoredAlgoRun): AlgoRunView {
    const algo = this.algo(run.algoId);
    const day = run.day;
    let today: AlgoRunView['today'] = null;
    let todayNet = 0;
    if (day) {
      const ts = this.clock.now();
      const parts = this.engine.parts(ts);
      const sameDay = parts.date === day.date;
      const snap = sameDay ? this.liveSnapshot(run, day, ts) : null;
      const legs = (algo.openLegs(day.state) as AlgoLeg[]).map((l) => {
        const ltp = snap ? snap.premium(l.type, l.strike) : null;
        const sign = l.side === 'SELL' ? 1 : -1;
        const pnl = ltp == null ? 0 : Math.round(sign * (l.entryPrice - ltp) * l.lots * this.engine.inst(String(run.params.symbol)).lotSize);
        return { ...l, ltp, pnl };
      });
      const lotSize = this.engine.inst(String(run.params.symbol)).lotSize;
      const realized = algo.realized(day.state);
      const unrealized = legs.reduce((a, l) => a + l.pnl, 0);
      const charges = totalCharges(day.events.flatMap((e) => e.fills as AlgoFill[]), lotSize);
      today = {
        date: day.date,
        expiry: day.expiry,
        phase: algo.phase(day.state),
        status: algo.status(run.params, day.state),
        legs,
        realized: Math.round(realized),
        unrealized,
        charges: Math.round(charges),
        mtm: Math.round(realized + unrealized),
        series: day.series,
        events: [...day.events].reverse(),
      };
      if (!day.closed) todayNet = Math.round(realized + unrealized - charges);
    }
    return {
      id: run.id,
      algoId: run.algoId,
      presetId: run.presetId,
      name: run.name,
      params: run.params,
      status: run.status,
      createdAt: run.createdAt,
      stoppedAt: run.stoppedAt,
      today,
      history: run.history,
      totalNet: run.history.reduce((a, d) => a + d.net, 0) + todayNet,
      error: run.error,
    };
  }
}
