/**
 * Analytics built on the market engine — one function per tool screen.
 */
import {
  bsGreeks,
  classifyBuildUp,
  expiryTs,
  formatExpiry,
  historicalVol,
  INDEX_MARGIN,
  ivPercentile,
  ivRank,
  legQty,
  maxPain,
  optimizeStrategies,
  pcr as pcrOf,
  rollingHV,
  SESSION_MINUTES,
  sideSign,
  STOCK_MARGIN,
  volatilityCone,
  yearsBetween,
  type BreadthResponse,
  type BuildUp,
  type BuildUpCounts,
  type Candle,
  type DailyPcrPoint,
  type FuturesBuildUpRow,
  type FuturesQuote,
  type IvChartResponse,
  type IvTableRow,
  type Leg,
  type MultiStrikeResponse,
  type OiTrendPoint,
  type OptimizerRequest,
  type RecapRequest,
  type RecapResponse,
  type SkewResponse,
  type StraddlePoint,
  type StrategyChartPoint,
  type StrikeOiResponse,
  type SurfaceResponse,
} from '@q26/core';
import type { ContractCtx, MarketEngine } from '../market/engine';
import { Lru } from '../market/hash';

const M = SESSION_MINUTES;

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

export function emptyCounts(): BuildUpCounts {
  return { 'Long Build-up': 0, 'Short Build-up': 0, 'Short Covering': 0, 'Long Unwinding': 0, Neutral: 0 };
}

export interface OptionSnapshotRow {
  symbol: string;
  kind: 'index' | 'stock';
  sector: string;
  expiry: string;
  type: 'CE' | 'PE';
  strike: number;
  spot: number;
  ltp: number;
  prevLtp: number;
  changePct: number;
  oi: number;
  prevOi: number;
  oiChange: number;
  oiChangePct: number;
  volume: number;
  iv: number;
  prevIv: number;
  lotSize: number;
}

export class Analytics {
  private snapshotCache = new Lru<string, OptionSnapshotRow[]>(8);

  constructor(readonly engine: MarketEngine) {}

  private resolveDay(date: string | undefined, nowTs: number): { dayIdx: number; upto: number } {
    const now = this.engine.parts(nowTs);
    if (!date || date >= now.date) return { dayIdx: now.dayIdx, upto: now.m };
    const idx = this.engine.dayIndex.get(date);
    if (idx === undefined) throw httpError(400, `${date} is not a trading day`);
    return { dayIdx: idx, upto: M };
  }

  private expiryFor(symbol: string, expiry: string | undefined, ts: number): string {
    const list = this.engine.expiries(symbol, ts);
    return expiry && list.includes(expiry) ? expiry : list[0];
  }

  /* ----------------------------- quotes / candles ----------------------------- */

  candles(symbol: string, interval: string, days: number, nowTs: number): Candle[] {
    const e = this.engine;
    const now = e.parts(nowTs);
    if (interval === 'D') {
      const out: Candle[] = [];
      const start = Math.max(0, now.dayIdx - days + 1);
      for (let i = start; i <= now.dayIdx; i++) {
        const st = e.dayStats(symbol, i, i === now.dayIdx ? now.m : M);
        const bar = e.bar(symbol, i);
        out.push({ ts: e.tsOf(i, 0), open: st.open, high: st.high, low: st.low, close: i === now.dayIdx ? e.spot(symbol, nowTs) : st.close, volume: Math.round(bar.volume * (i === now.dayIdx ? now.f : 1)) });
      }
      return out;
    }
    const step = Math.max(1, Number(interval) || 5);
    const out: Candle[] = [];
    const start = Math.max(0, now.dayIdx - Math.max(1, days) + 1);
    for (let i = start; i <= now.dayIdx; i++) {
      const P = e.path(symbol, i);
      const bar = e.bar(symbol, i);
      const last = i === now.dayIdx ? Math.floor(now.m) : M;
      for (let m0 = 0; m0 < Math.max(last, 1); m0 += step) {
        const m1 = Math.min(m0 + step, last);
        let hi = P[m0];
        let lo = P[m0];
        for (let j = m0; j <= m1; j++) {
          if (P[j] > hi) hi = P[j];
          if (P[j] < lo) lo = P[j];
        }
        const vol = bar.volume * ((m1 - m0) / M) * (1 + 0.8 * Math.exp(-m0 / 30) + 0.5 * Math.exp(-(M - m1) / 30));
        out.push({ ts: e.tsOf(i, m0), open: +P[m0].toFixed(2), high: +hi.toFixed(2), low: +lo.toFixed(2), close: +P[m1].toFixed(2), volume: Math.round(vol) });
      }
    }
    return out;
  }

  futures(symbol: string, ts: number): FuturesQuote[] {
    const e = this.engine;
    const p = e.parts(ts);
    const prev = Math.max(0, p.dayIdx - 1);
    const spot = e.spot(symbol, ts);
    return e.futureExpiries(symbol, ts).map((expiry) => {
      const ltp = e.futurePrice(symbol, expiry, ts);
      const prevPx = e.futurePrice(symbol, expiry, 0, { dayIdx: prev, m: M });
      const oi = e.futureOi(symbol, expiry, p.dayIdx, p.m);
      const prevOi = e.futureOi(symbol, expiry, prev, M);
      return {
        symbol,
        expiry,
        ltp,
        change: +(ltp - prevPx).toFixed(2),
        changePct: +(((ltp - prevPx) / prevPx) * 100).toFixed(2),
        oi,
        oiChange: oi - prevOi,
        oiChangePct: prevOi ? +(((oi - prevOi) / prevOi) * 100).toFixed(2) : 0,
        volume: e.futureVolume(symbol, expiry, p.dayIdx, p.m),
        basis: +(ltp - spot).toFixed(2),
        buildUp: classifyBuildUp(ltp - prevPx, oi - prevOi),
      };
    });
  }

  /* ----------------------------- open interest ----------------------------- */

  strikeOi(symbol: string, expiryIn: string | undefined, ts: number, fromTs?: number): StrikeOiResponse {
    const e = this.engine;
    const expiry = this.expiryFor(symbol, expiryIn, ts);
    const ctx = e.contract(symbol, expiry);
    const p = e.parts(ts);
    const from = fromTs !== undefined && fromTs < ts ? e.parts(fromTs) : { dayIdx: Math.max(0, p.dayIdx - 1), m: M };
    const strikes = e.strikes(ctx, p.dayIdx);
    const rows = strikes.map((strike) => {
      const ceOi = e.oiAt(ctx, 'CE', strike, p.dayIdx, p.m);
      const peOi = e.oiAt(ctx, 'PE', strike, p.dayIdx, p.m);
      return {
        strike,
        ceOi,
        peOi,
        ceChange: ceOi - e.oiAt(ctx, 'CE', strike, from.dayIdx, from.m),
        peChange: peOi - e.oiAt(ctx, 'PE', strike, from.dayIdx, from.m),
        ceVolume: e.volumeAt(ctx, 'CE', strike, p.dayIdx, p.m),
        peVolume: e.volumeAt(ctx, 'PE', strike, p.dayIdx, p.m),
      };
    });
    const oiRows = rows.map((r) => ({ strike: r.strike, ceOI: r.ceOi, peOI: r.peOi }));
    return {
      symbol,
      expiry,
      spot: e.spot(symbol, ts),
      fromTs: e.tsOf(from.dayIdx, from.m),
      toTs: ts,
      rows,
      maxPain: maxPain(oiRows).maxPain,
      pcr: +pcrOf(oiRows).oi.toFixed(3),
    };
  }

  multiStrike(symbol: string, expiryIn: string | undefined, strikesIn: number[], date: string | undefined, interval: number, ts: number): MultiStrikeResponse {
    const e = this.engine;
    const expiry = this.expiryFor(symbol, expiryIn, ts);
    const ctx = e.contract(symbol, expiry);
    const { dayIdx, upto } = this.resolveDay(date, ts);
    const marks = e.minuteMarks(upto, Math.max(1, interval));
    let strikes = strikesIn.filter((k) => Number.isFinite(k));
    if (!strikes.length) {
      const atm = e.strikes(ctx, dayIdx).reduce((a, k) => (Math.abs(k - e.bar(symbol, dayIdx).prevClose) < Math.abs(a - e.bar(symbol, dayIdx).prevClose) ? k : a));
      strikes = [atm - ctx.inst.strikeStep * 2, atm, atm + ctx.inst.strikeStep * 2];
    }
    const series: MultiStrikeResponse['series'] = [];
    for (const strike of strikes) {
      for (const type of ['CE', 'PE'] as const) {
        const oi: number[] = [];
        const ltp: number[] = [];
        const iv: number[] = [];
        for (const m of marks) {
          oi.push(e.oiAt(ctx, type, strike, dayIdx, m));
          const o = e.optionAt(ctx, type, strike, 0, { minute: { dayIdx, m } });
          ltp.push(o.ltp);
          iv.push(+(o.iv * 100).toFixed(2));
        }
        series.push({ strike, type, oi, ltp, iv });
      }
    }
    return { symbol, expiry, times: marks.map((m) => e.tsOf(dayIdx, m)), spot: marks.map((m) => e.spotAt(symbol, dayIdx, m)), series };
  }

  oiTrend(symbol: string, expiryIn: string | undefined, date: string | undefined, interval: number, ts: number): { expiry: string; points: OiTrendPoint[] } {
    const e = this.engine;
    const expiry = this.expiryFor(symbol, expiryIn, ts);
    const ctx = e.contract(symbol, expiry);
    const { dayIdx, upto } = this.resolveDay(date, ts);
    const strikes = e.strikes(ctx, dayIdx);
    const prevIdx = Math.max(0, dayIdx - 1);
    const prevCe = strikes.map((k) => e.oiAt(ctx, 'CE', k, prevIdx, M));
    const prevPe = strikes.map((k) => e.oiAt(ctx, 'PE', k, prevIdx, M));
    const sumPrevCe = prevCe.reduce((a, b) => a + b, 0);
    const sumPrevPe = prevPe.reduce((a, b) => a + b, 0);
    const points: OiTrendPoint[] = e.minuteMarks(upto, Math.max(1, interval)).map((m) => {
      const rows = strikes.map((k) => ({ strike: k, ceOI: e.oiAt(ctx, 'CE', k, dayIdx, m), peOI: e.oiAt(ctx, 'PE', k, dayIdx, m) }));
      const ce = rows.reduce((a, r) => a + r.ceOI, 0);
      const pe = rows.reduce((a, r) => a + r.peOI, 0);
      return {
        ts: e.tsOf(dayIdx, m),
        spot: e.spotAt(symbol, dayIdx, m),
        ceOi: ce,
        peOi: pe,
        ceChange: ce - sumPrevCe,
        peChange: pe - sumPrevPe,
        pcr: +(pe / ce).toFixed(3),
        maxPain: maxPain(rows).maxPain,
        atmIv: +(e.atmIvAt(symbol, dayIdx, m) * 100).toFixed(2),
      };
    });
    return { expiry, points };
  }

  dailyPcr(symbol: string, days: number, ts: number): DailyPcrPoint[] {
    const e = this.engine;
    const now = e.parts(ts);
    const out: DailyPcrPoint[] = [];
    for (let i = Math.max(1, now.dayIdx - days + 1); i <= now.dayIdx; i++) {
      const m = i === now.dayIdx ? now.m : M;
      const at = e.tsOf(i, Math.min(m, M - 1));
      const expiry = e.expiries(symbol, at)[0];
      const ctx = e.contract(symbol, expiry);
      let ce = 0;
      let pe = 0;
      for (const k of e.strikes(ctx, i)) {
        ce += e.oiAt(ctx, 'CE', k, i, m);
        pe += e.oiAt(ctx, 'PE', k, i, m);
      }
      out.push({ date: e.days[i], pcr: +(pe / ce).toFixed(3), close: i === now.dayIdx ? e.spot(symbol, ts) : e.bar(symbol, i).close });
    }
    return out;
  }

  maxPainDetail(symbol: string, expiryIn: string | undefined, ts: number) {
    const s = this.strikeOi(symbol, expiryIn, ts);
    const mp = maxPain(s.rows.map((r) => ({ strike: r.strike, ceOI: r.ceOi, peOI: r.peOi })));
    const trend = this.oiTrend(symbol, s.expiry, undefined, 15, ts);
    return { symbol, expiry: s.expiry, spot: s.spot, maxPain: mp.maxPain, pain: mp.pain, history: trend.points.map((p) => ({ ts: p.ts, maxPain: p.maxPain, spot: p.spot })) };
  }

  futuresBuildUp(ts: number): FuturesBuildUpRow[] {
    const e = this.engine;
    return [...e.instruments.values()].map((inst) => {
      const f = this.futures(inst.symbol, ts)[0];
      return {
        symbol: inst.symbol,
        name: inst.name,
        sector: inst.sector,
        kind: inst.kind,
        ltp: f.ltp,
        changePct: f.changePct,
        oi: f.oi,
        oiChangePct: f.oiChangePct,
        volume: f.volume,
        buildUp: f.buildUp,
        lotSize: inst.lotSize,
      };
    });
  }

  breadth(ts: number, historyDays = 20): BreadthResponse {
    const e = this.engine;
    const rows = this.futuresBuildUp(ts).filter((r) => r.kind === 'stock');
    const overall = emptyCounts();
    const sectors = new Map<string, { counts: BuildUpCounts; symbols: FuturesBuildUpRow[] }>();
    for (const r of rows) {
      overall[r.buildUp]++;
      const s = sectors.get(r.sector) ?? { counts: emptyCounts(), symbols: [] };
      s.counts[r.buildUp]++;
      s.symbols.push(r);
      sectors.set(r.sector, s);
    }
    const now = e.parts(ts);
    const history: BreadthResponse['history'] = [];
    for (let i = Math.max(1, now.dayIdx - historyDays); i < now.dayIdx; i++) {
      const counts = emptyCounts();
      for (const inst of e.instruments.values()) {
        if (inst.kind !== 'stock') continue;
        const b = e.bar(inst.symbol, i);
        counts[classifyBuildUp(b.close - b.prevClose, b.futOi - b.futOiPrev)]++;
      }
      history.push({ date: e.days[i], counts });
    }
    history.push({ date: now.date, counts: overall });
    return {
      overall,
      sectors: [...sectors.entries()].map(([sector, v]) => ({ sector, ...v })).sort((a, b) => b.symbols.length - a.symbols.length),
      history,
    };
  }

  /* ----------------------------- volatility ----------------------------- */

  /** Daily IV history (constant-maturity ATM) and HV for a symbol. */
  ivHistory(symbol: string, days: number, ts: number) {
    const e = this.engine;
    const now = e.parts(ts);
    const bars = e.bars(symbol);
    const start = Math.max(21, now.dayIdx - days + 1);
    const closes = bars.slice(start - 21, now.dayIdx + 1).map((b) => b.close);
    const hv = rollingHV(closes, 20);
    const out: { date: string; iv: number; hv: number; close: number }[] = [];
    for (let i = start; i <= now.dayIdx; i++) {
      const iv = i === now.dayIdx ? e.atmIvAt(symbol, i, now.m) : bars[i].iv;
      out.push({ date: e.days[i], iv: +(iv * 100).toFixed(2), hv: +(hv[i - start + 21] * 100).toFixed(2), close: bars[i].close });
    }
    return out;
  }

  ivChart(symbol: string, expiryIn: string | undefined, date: string | undefined, interval: number, days: number, ts: number): IvChartResponse {
    const e = this.engine;
    const expiry = this.expiryFor(symbol, expiryIn, ts);
    const ctx = e.contract(symbol, expiry);
    const { dayIdx, upto } = this.resolveDay(date, ts);
    const intraday = e.minuteMarks(upto, Math.max(1, interval)).map((m) => {
      const spot = e.spotAt(symbol, dayIdx, m);
      const atm = e.strikes(ctx, dayIdx).reduce((a, k) => (Math.abs(k - spot) < Math.abs(a - spot) ? k : a));
      const ce = e.optionAt(ctx, 'CE', atm, 0, { minute: { dayIdx, m } });
      const pe = e.optionAt(ctx, 'PE', atm, 0, { minute: { dayIdx, m } });
      return { ts: e.tsOf(dayIdx, m), spot, ceIv: +(ce.iv * 100).toFixed(2), peIv: +(pe.iv * 100).toFixed(2), atmIv: +(((ce.iv + pe.iv) / 2) * 100).toFixed(2) };
    });
    const daily = this.ivHistory(symbol, days, ts);
    const hist = this.ivHistory(symbol, 252, ts).map((d) => d.iv);
    const cur = hist[hist.length - 1];
    return { symbol, intraday, daily, ivr: +ivRank(cur, hist).toFixed(1), ivp: +ivPercentile(cur, hist.slice(0, -1)).toFixed(1) };
  }

  ivTable(ts: number): IvTableRow[] {
    const e = this.engine;
    const now = e.parts(ts);
    return [...e.instruments.values()].map((inst) => {
      const bars = e.bars(inst.symbol);
      const hist = bars.slice(Math.max(0, now.dayIdx - 252), now.dayIdx).map((b) => b.iv * 100);
      const iv = e.atmIvAt(inst.symbol, now.dayIdx, now.m) * 100;
      const prevIv = bars[now.dayIdx].ivPrev * 100;
      const closes = bars.slice(Math.max(0, now.dayIdx - 30), now.dayIdx).map((b) => b.close);
      closes.push(e.spot(inst.symbol, ts));
      const hv = historicalVol(closes, 20) * 100;
      const q = e.quote(inst.symbol, ts);
      return {
        symbol: inst.symbol,
        kind: inst.kind,
        sector: inst.sector,
        ltp: q.ltp,
        changePct: q.changePct,
        iv: +iv.toFixed(2),
        ivChange: +(iv - prevIv).toFixed(2),
        ivr: +ivRank(iv, hist).toFixed(1),
        ivp: +ivPercentile(iv, hist).toFixed(1),
        hv: +hv.toFixed(2),
        ivHvSpread: +(iv - hv).toFixed(2),
      };
    });
  }

  skew(symbol: string, expiriesIn: string[], ts: number, compare: 'none' | 'prev' = 'none'): SkewResponse {
    const e = this.engine;
    const list = e.expiries(symbol, ts);
    const chosen = (expiriesIn.length ? expiriesIn.filter((x) => list.includes(x)) : list.slice(0, 3)).slice(0, 5);
    const p = e.parts(ts);
    const spot = e.spot(symbol, ts);
    const curves: SkewResponse['curves'] = [];
    const build = (expiry: string, dayIdx: number, m: number, label: string) => {
      const ctx = e.contract(symbol, expiry);
      const S = e.spotAt(symbol, dayIdx, m);
      const points = e.strikes(ctx, p.dayIdx).map((strike) => {
        const ce = e.optionAt(ctx, 'CE', strike, 0, { minute: { dayIdx, m } });
        const pe = e.optionAt(ctx, 'PE', strike, 0, { minute: { dayIdx, m } });
        const otm = strike >= S ? ce.iv : pe.iv;
        return { strike, moneyness: +((strike / S - 1) * 100).toFixed(2), ceIv: +(ce.iv * 100).toFixed(2), peIv: +(pe.iv * 100).toFixed(2), iv: +(otm * 100).toFixed(2) };
      });
      const atmPt = points.reduce((a, b) => (Math.abs(b.strike - S) < Math.abs(a.strike - S) ? b : a));
      curves.push({ expiry, label, atmIv: atmPt.iv, points });
    };
    for (const ex of chosen) {
      build(ex, p.dayIdx, p.m, formatExpiry(ex));
      if (compare === 'prev' && p.dayIdx > 0) build(ex, p.dayIdx - 1, M, `${formatExpiry(ex)} (prev close)`);
    }
    return { symbol, spot, curves };
  }

  surface(symbol: string, ts: number): SurfaceResponse {
    const e = this.engine;
    const p = e.parts(ts);
    const spot = e.spot(symbol, ts);
    const expiries = e.expiries(symbol, ts).slice(0, 8);
    const moneyness = [-10, -8, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 8, 10];
    const iv = expiries.map((ex) => {
      const ctx = e.contract(symbol, ex);
      const T = yearsBetween(ts, ctx.expTs);
      const atm = e.atmIvAt(symbol, p.dayIdx, p.m);
      return moneyness.map((mny) => {
        const K = spot * (1 + mny / 100);
        return +(e.optionIv(ctx, K >= spot ? 'CE' : 'PE', K, spot, T, atm, p.dayIdx) * 100).toFixed(2);
      });
    });
    return { symbol, spot, expiries, daysToExpiry: expiries.map((ex) => +((expiryTs(ex) - ts) / 86400000).toFixed(1)), moneyness, iv };
  }

  cone(symbol: string, ts: number) {
    const e = this.engine;
    const now = e.parts(ts);
    const closes = e.bars(symbol).slice(Math.max(0, now.dayIdx - 504), now.dayIdx).map((b) => b.close);
    closes.push(e.spot(symbol, ts));
    return { symbol, atmIv: +(e.atmIvAt(symbol, now.dayIdx, now.m) * 100).toFixed(2), rows: volatilityCone(closes).map((r) => ({ window: r.window, min: +(r.min * 100).toFixed(2), p25: +(r.p25 * 100).toFixed(2), median: +(r.median * 100).toFixed(2), p75: +(r.p75 * 100).toFixed(2), max: +(r.max * 100).toFixed(2), current: +(r.current * 100).toFixed(2) })) };
  }

  /* ----------------------------- straddle / strategy charts ----------------------------- */

  straddle(symbol: string, expiryIn: string | undefined, strikeIn: number | 'atm', mode: 'rolling' | 'fixed', date: string | undefined, interval: number, ts: number, strangleWidth = 0): { expiry: string; points: StraddlePoint[] } {
    const e = this.engine;
    const expiry = this.expiryFor(symbol, expiryIn, ts);
    const ctx = e.contract(symbol, expiry);
    const { dayIdx, upto } = this.resolveDay(date, ts);
    const strikes = e.strikes(ctx, dayIdx);
    const nearest = (x: number) => strikes.reduce((a, k) => (Math.abs(k - x) < Math.abs(a - x) ? k : a));
    const fixed = strikeIn === 'atm' ? nearest(e.spotAt(symbol, dayIdx, 0)) : nearest(strikeIn);
    const points = e.minuteMarks(upto, Math.max(1, interval)).map((m) => {
      const spot = e.spotAt(symbol, dayIdx, m);
      // Synthetic ATM: the strike nearest the forward, so the rolling straddle doesn't flip on carry.
      const fwd = spot * Math.exp((e.r - ctx.inst.divYield) * yearsBetween(e.tsOf(dayIdx, m), ctx.expTs));
      const center = mode === 'rolling' && strikeIn === 'atm' ? nearest(fwd) : fixed;
      const kc = nearest(center + strangleWidth);
      const kp = nearest(center - strangleWidth);
      const ce = e.optionAt(ctx, 'CE', kc, 0, { minute: { dayIdx, m } });
      const pe = e.optionAt(ctx, 'PE', kp, 0, { minute: { dayIdx, m } });
      return { ts: e.tsOf(dayIdx, m), spot, strike: center, ce: ce.ltp, pe: pe.ltp, straddle: +(ce.ltp + pe.ltp).toFixed(2), iv: +(((ce.iv + pe.iv) / 2) * 100).toFixed(2) };
    });
    return { expiry, points };
  }

  private legPriceAt(symbol: string, leg: Leg, dayIdx: number, m: number): { ltp: number; iv: number; spot: number; T: number } {
    const e = this.engine;
    if (leg.type === 'FUT') {
      const at = e.tsOf(dayIdx, m);
      return { ltp: e.futurePrice(symbol, leg.expiry, at, { dayIdx, m }), iv: 0, spot: e.spotAt(symbol, dayIdx, m), T: yearsBetween(at, expiryTs(leg.expiry)) };
    }
    const ctx = e.contract(symbol, leg.expiry);
    return e.optionAt(ctx, leg.type, leg.strike, 0, { minute: { dayIdx, m } });
  }

  strategyChart(symbol: string, legs: Leg[], date: string | undefined, interval: number, ts: number): StrategyChartPoint[] {
    const e = this.engine;
    const { dayIdx, upto } = this.resolveDay(date, ts);
    const inst = e.inst(symbol);
    const marks = e.minuteMarks(upto, Math.max(1, interval));
    const first = marks[0];
    const entry = legs.map((l) => (l.price > 0 ? l.price : this.legPriceAt(symbol, l, dayIdx, first).ltp));
    return marks.map((m) => {
      let premium = 0;
      let pnl = 0;
      const g = { delta: 0, gamma: 0, theta: 0, vega: 0 };
      let spot = 0;
      legs.forEach((leg, i) => {
        const q = this.legPriceAt(symbol, leg, dayIdx, m);
        spot = q.spot;
        const qty = legQty(leg) * sideSign(leg.side);
        premium += sideSign(leg.side) * q.ltp * leg.lots;
        pnl += qty * (q.ltp - entry[i]);
        if (leg.type === 'FUT') g.delta += qty;
        else {
          const gr = bsGreeks(leg.type, q.spot, leg.strike, q.T, e.r, q.iv, inst.divYield);
          g.delta += qty * gr.delta;
          g.gamma += qty * gr.gamma;
          g.theta += qty * gr.theta;
          g.vega += qty * gr.vega;
        }
      });
      return { ts: e.tsOf(dayIdx, m), spot, premium: +premium.toFixed(2), pnl: +pnl.toFixed(2), delta: +g.delta.toFixed(2), gamma: +g.gamma.toFixed(4), theta: +g.theta.toFixed(2), vega: +g.vega.toFixed(2) };
    });
  }

  /* ----------------------------- recap / backtest ----------------------------- */

  recap(req: RecapRequest, nowTs: number): RecapResponse {
    const e = this.engine;
    const legs = req.legs.filter((l) => l.lots > 0);
    if (!legs.length) throw httpError(400, 'No legs');
    const from = e.parts(Math.min(req.fromTs, nowTs));
    const firstExpiry = Math.min(...legs.map((l) => expiryTs(l.expiry)));
    const endTs = Math.min(req.toTs ?? nowTs, nowTs, firstExpiry);
    const end = e.parts(endTs);
    const step = Math.max(1, req.intervalMin ?? 5);
    const points: RecapResponse['points'] = [];
    for (let d = from.dayIdx; d <= end.dayIdx; d++) {
      const startM = d === from.dayIdx ? Math.floor(from.m) : 0;
      const endM = d === end.dayIdx ? end.m : M;
      const marks: number[] = [];
      for (let m = startM; m <= endM; m += step) marks.push(m);
      if (marks[marks.length - 1] !== Math.floor(endM)) marks.push(Math.floor(endM));
      for (const m of marks) {
        const legLtp: number[] = [];
        let pnl = 0;
        let spot = 0;
        for (const leg of legs) {
          const q = this.legPriceAt(req.symbol, leg, d, m);
          spot = q.spot;
          legLtp.push(q.ltp);
          const exit = leg.exitPrice ?? q.ltp;
          pnl += legQty(leg) * sideSign(leg.side) * (exit - leg.price);
        }
        points.push({ ts: e.tsOf(d, m), spot, pnl: +pnl.toFixed(2), legLtp });
      }
    }
    const pnls = points.map((p) => p.pnl);
    return {
      points,
      maxPnl: Math.max(...pnls),
      minPnl: Math.min(...pnls),
      finalPnl: pnls[pnls.length - 1] ?? 0,
      endTs: points[points.length - 1]?.ts ?? endTs,
      expired: endTs >= firstExpiry,
    };
  }

  /* ----------------------------- optimizer ----------------------------- */

  optimize(req: OptimizerRequest, ts: number) {
    const e = this.engine;
    const inst = e.inst(req.symbol);
    const chain = e.chain(req.symbol, req.expiry, ts);
    const expTs = expiryTs(chain.expiry);
    const targetTs = Math.min(expTs, Math.max(ts + 60_000, expiryTs(req.targetDate)));
    const t0 = performance.now();
    const out = optimizeStrategies({
      spot: chain.spot,
      nowTs: ts,
      expiry: chain.expiry,
      lotSize: inst.lotSize,
      rows: chain.rows.map((r) => ({ strike: r.strike, ce: { price: r.ce.ltp, iv: r.ce.iv / 100 }, pe: { price: r.pe.ltp, iv: r.pe.iv / 100 } })),
      targetPrice: req.targetPrice,
      targetTs,
      stopLoss: req.stopLoss,
      maxLegs: req.maxLegs ?? 4,
      allowUnlimitedRisk: req.allowUnlimitedRisk ?? false,
      maxCapital: req.maxCapital,
      atmIv: chain.atmIv / 100,
      ctx: { r: e.r, carry: () => inst.divYield, defaultIv: chain.atmIv / 100 },
      marginParams: inst.kind === 'index' ? INDEX_MARGIN : STOCK_MARGIN,
      sortBy: req.sortBy ?? 'rr',
      limit: 25,
      budget: 220_000,
    });
    return { ...out, expiry: chain.expiry, spot: chain.spot, tookMs: Math.round(performance.now() - t0), targetTs };
  }

  /* ----------------------------- market-wide option snapshot ----------------------------- */

  /** Near-expiry option contracts across all symbols (shared by scanners, synopsis, UOA). */
  optionSnapshot(ts: number): OptionSnapshotRow[] {
    const key = String(Math.floor(ts / 5000));
    return this.snapshotCache.getOrCreate(key, () => {
      const e = this.engine;
      const p = e.parts(ts);
      const prevIdx = Math.max(0, p.dayIdx - 1);
      const out: OptionSnapshotRow[] = [];
      for (const inst of e.instruments.values()) {
        const expiry = e.expiries(inst.symbol, ts)[0];
        const ctx: ContractCtx = e.contract(inst.symbol, expiry);
        const spot = e.spot(inst.symbol, ts);
        const strikes = e.strikes(ctx, p.dayIdx);
        for (const strike of strikes) {
          if (Math.abs(strike / spot - 1) > (inst.kind === 'index' ? 0.05 : 0.12)) continue;
          for (const type of ['CE', 'PE'] as const) {
            const now = e.optionAt(ctx, type, strike, ts);
            const prev = e.optionAt(ctx, type, strike, 0, { minute: { dayIdx: prevIdx, m: M } });
            const oi = e.oiAt(ctx, type, strike, p.dayIdx, p.m);
            const prevOi = e.oiAt(ctx, type, strike, prevIdx, M);
            out.push({
              symbol: inst.symbol,
              kind: inst.kind,
              sector: inst.sector,
              expiry,
              type,
              strike,
              spot,
              ltp: now.ltp,
              prevLtp: prev.ltp,
              changePct: prev.ltp > 0 ? +(((now.ltp - prev.ltp) / prev.ltp) * 100).toFixed(2) : 0,
              oi,
              prevOi,
              oiChange: oi - prevOi,
              oiChangePct: prevOi > 0 ? +(((oi - prevOi) / prevOi) * 100).toFixed(2) : 0,
              volume: e.volumeAt(ctx, type, strike, p.dayIdx, p.m),
              iv: +(now.iv * 100).toFixed(2),
              prevIv: +(prev.iv * 100).toFixed(2),
              lotSize: inst.lotSize,
            });
          }
        }
      }
      return out;
    });
  }

  optionBuildUp(row: OptionSnapshotRow): BuildUp {
    return classifyBuildUp(row.ltp - row.prevLtp, row.oiChange);
  }
}
