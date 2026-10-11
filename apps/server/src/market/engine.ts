/**
 * Procedural market engine.
 *
 * Every observable — spot, futures, option premium, IV, OI, volume, depth — is a pure
 * function of (instrument, contract, timestamp). Daily series are generated once at boot
 * from seeded factor models (GARCH-clustered market factor + sector + idiosyncratic,
 * mean-reverting IV with leverage effect); intraday paths are Brownian bridges between
 * the day's open and close. OI is a closed-form function of moneyness, sessions to
 * expiry and slowly-varying per-contract factors, interpolated through the session so it
 * is continuous across days. This makes historical replay (trade recap), intraday
 * time-series and "as-of" queries exact and cheap.
 */
import {
  bsGreeks,
  classifyBuildUp,
  dateToNum,
  DAY_MS,
  expiryTs,
  generateExpiries,
  hash32,
  isMonthlyExpiry,
  istParts,
  MARKET_OPEN_MIN,
  maxPain,
  oiSupportResistance,
  pcr as pcrOf,
  Rng,
  roundTick,
  SESSION_MINUTES,
  sessionTs,
  tradingDaysBetween,
  yearsBetween,
  type ChainRow,
  type ExpiryRule,
  type HolidaySet,
  type OptionChain,
  type OptionQuote,
  type Quote,
} from '@q26/core';
import { hashN, hashU, Lru } from './hash';
import { sectorKey, type Instrument } from './universe';

const M = SESSION_MINUTES;
export const SIM_START_DATE = '2024-01-01';
export const SIM_END_DATE = '2029-12-31';
const ANCHOR_DATE = '2026-07-01';

export interface DailyBar {
  date: string;
  open: number;
  close: number;
  prevClose: number;
  iv: number;
  ivPrev: number;
  gap: number;
  futOi: number;
  futOiPrev: number;
  volume: number;
  /** GARCH variance regime (long-run mean 1). */
  h: number;
}

export interface TimeParts {
  dayIdx: number;
  date: string;
  /** Fractional minutes since 09:15, clamped to [0, 375]. */
  m: number;
  f: number;
}

export interface ContractCtx {
  inst: Instrument;
  expiry: string;
  expiryIdx: number;
  expTs: number;
  weeklyType: boolean;
  monthly: boolean;
  expNum: number;
}

export interface OptionPoint {
  ltp: number;
  iv: number;
  spot: number;
  T: number;
}

// U-shaped intraday variance profile (heavier at open and close), normalised to sum 1.
const U_PROFILE: Float64Array = (() => {
  const u = new Float64Array(M + 1);
  let s = 0;
  for (let j = 1; j <= M; j++) {
    // Indian opens absorb overnight news: the first ~15 minutes carry ~11% of the day's variance.
    u[j] = 1 + 3 * Math.exp(-(j - 1) / 15) + 0.7 * Math.exp(-(M - j) / 22);
    s += u[j];
  }
  for (let j = 1; j <= M; j++) u[j] /= s;
  return u;
})();

/** Intraday realised vol relative to close-to-close vol (intraday noise mean-reverts by the close). */
const INTRADAY_VOL_FACTOR = 1.1;

const TYPE_CODE = { CE: 1, PE: 2, FUT: 3 } as const;

function monthlyRuleOf(rule: ExpiryRule): ExpiryRule {
  return rule.endsWith('thu') ? 'monthly-thu' : 'monthly-tue';
}

export class MarketEngine {
  readonly days: string[] = [];
  readonly dayIndex = new Map<string, number>();
  readonly instruments = new Map<string, Instrument>();
  readonly r: number;
  readonly holidays: HolidaySet;
  private readonly daily = new Map<string, DailyBar[]>();
  private readonly seed: number;
  private readonly symIds = new Map<string, number>();
  private readonly marketNoiseCache = new Lru<number, Float64Array>(400);
  private readonly pathCache = new Lru<string, Float64Array>(6000);
  private readonly expiryCache = new Lru<string, string[]>(4000);
  private readonly strikeCache = new Lru<string, number[]>(6000);
  private readonly dayFactorCache = new Lru<string, number>(400_000);

  constructor(opts: { seed: string; riskFreeRate: number; holidays: HolidaySet; universe: Instrument[] }) {
    this.seed = hash32(opts.seed);
    this.r = opts.riskFreeRate;
    this.holidays = opts.holidays;
    for (const inst of opts.universe) {
      this.instruments.set(inst.symbol, inst);
      this.symIds.set(inst.symbol, hash32(opts.seed, inst.symbol));
    }
    let n = dateToNum(SIM_START_DATE);
    const end = dateToNum(SIM_END_DATE);
    for (; n <= end; n++) {
      const d = new Date(n * DAY_MS).toISOString().slice(0, 10);
      const wd = new Date(n * DAY_MS).getUTCDay();
      if (wd === 0 || wd === 6 || this.holidays.has(d)) continue;
      this.dayIndex.set(d, this.days.length);
      this.days.push(d);
    }
    this.generateDaily(opts.universe);
  }

  /* ------------------------------------------------------------------ */
  /* Daily series                                                         */
  /* ------------------------------------------------------------------ */

  private generateDaily(universe: Instrument[]) {
    const N = this.days.length;
    const anchorIdx = this.days.findIndex((d) => d >= ANCHOR_DATE);
    const rngM = Rng.of(this.seed, 'market-factor');
    const mkt = new Float64Array(N);
    const hArr = new Float64Array(N);
    let h = 1;
    let eps = 0;
    for (let i = 0; i < N; i++) {
      h = 0.05 + 0.08 * eps * eps + 0.87 * h;
      eps = Math.sqrt(h) * rngM.fatNormal(0.03, 2.3);
      mkt[i] = eps;
      hArr[i] = h;
    }
    const sectors = new Map<string, Float64Array>();
    const sectorSeries = (key: string) => {
      let arr = sectors.get(key);
      if (!arr) {
        arr = new Float64Array(N);
        const rng = Rng.of(this.seed, 'sector', key);
        for (let i = 0; i < N; i++) arr[i] = rng.normal() * Math.sqrt(0.5 + 0.5 * hArr[i]);
        sectors.set(key, arr);
      }
      return arr;
    };
    const niftyVol = universe.find((u) => u.symbol === 'NIFTY')?.vol ?? 0.12;
    for (const inst of universe) {
      const sd = inst.vol / Math.sqrt(252);
      const sm = niftyVol / Math.sqrt(252);
      const a = inst.symbol === 'NIFTY' ? 1 : Math.min(inst.kind === 'index' ? 0.995 : 0.85, Math.max(0, (inst.beta * sm) / sd));
      const key = sectorKey(inst);
      const b = key === 'Market' ? 0 : inst.sectorLoad * Math.sqrt(1 - a * a);
      const c = Math.sqrt(Math.max(0, 1 - a * a - b * b));
      const sec = b ? sectorSeries(key) : null;
      const rng = Rng.of(this.seed, 'daily', inst.symbol);
      const drift = 0.1 / 252;
      const trend = (i: number) => Math.log(inst.basePrice) + (0.1 * (i - anchorIdx)) / 252;
      let logP = trend(0) + 0.03 * rng.normal();
      let iv = inst.baseIv;
      let foi = inst.futOi;
      const bars: DailyBar[] = new Array(N);
      for (let i = 0; i < N; i++) {
        const z = rng.normal() * Math.sqrt(0.5 + 0.5 * hArr[i]);
        const r = sd * (a * mkt[i] + b * (sec ? sec[i] : 0) + c * z) + drift - 0.006 * (logP - trend(i));
        const prevClose = roundTick(Math.exp(logP));
        const gap = 0.3 * r + 0.12 * sd * rng.normal();
        logP += r;
        const close = roundTick(Math.exp(logP));
        const open = roundTick(prevClose * Math.exp(gap));
        const hEff = a * a * hArr[i] + (1 - a * a);
        const ivTarget = inst.baseIv * (0.8 + 0.2 * Math.sqrt(hEff));
        const logIv = Math.log(iv) + 0.1 * (Math.log(ivTarget) - Math.log(iv)) - 2.6 * r + 0.035 * rng.normal();
        const ivNew = Math.min(3 * inst.baseIv, Math.max(0.55 * inst.baseIv, Math.exp(logIv)));
        const lf = Math.log(foi) + 0.04 * (Math.log(inst.futOi) - Math.log(foi)) + 0.035 * rng.normal();
        const foiNew = Math.exp(lf);
        const volume = ((inst.kind === 'index' ? inst.futOi * 0.6 : (inst.liquidity * 2e9) / close) * (0.7 + (0.6 * Math.abs(r)) / sd)) * Math.exp(0.2 * rng.normal());
        bars[i] = { date: this.days[i], open, close, prevClose, iv: ivNew, ivPrev: iv, gap, futOi: foiNew, futOiPrev: foi, volume, h: hArr[i] };
        iv = ivNew;
        foi = foiNew;
      }
      this.daily.set(inst.symbol, bars);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Lookups                                                              */
  /* ------------------------------------------------------------------ */

  inst(symbol: string): Instrument {
    const i = this.instruments.get(symbol);
    if (!i) throw Object.assign(new Error(`Unknown symbol ${symbol}`), { statusCode: 404 });
    return i;
  }

  bars(symbol: string): DailyBar[] {
    return this.daily.get(this.inst(symbol).symbol)!;
  }

  bar(symbol: string, dayIdx: number): DailyBar {
    return this.bars(symbol)[dayIdx];
  }

  symId(symbol: string): number {
    return this.symIds.get(symbol) ?? 0;
  }

  /** Map a timestamp to (trading day, session minute). Outside hours → nearest session edge. */
  parts(ts: number): TimeParts {
    const p = istParts(ts);
    let idx = this.dayIndex.get(p.date);
    let m = p.minuteOfDay - MARKET_OPEN_MIN + p.second / 60 + (ts % 1000) / 60000;
    if (idx === undefined) {
      // weekend/holiday → previous session close
      let d = p.date;
      for (let k = 0; k < 10 && idx === undefined; k++) {
        const n = dateToNum(d) - 1;
        d = new Date(n * DAY_MS).toISOString().slice(0, 10);
        idx = this.dayIndex.get(d);
      }
      if (idx === undefined) idx = 0;
      m = M;
    } else if (m < 0) {
      if (idx > 0) {
        idx -= 1;
        m = M;
      } else m = 0;
    }
    m = Math.min(M, Math.max(0, m));
    return { dayIdx: idx, date: this.days[idx], m, f: m / M };
  }

  tsOf(dayIdx: number, minute: number): number {
    return sessionTs(this.days[dayIdx], minute);
  }

  /* ------------------------------------------------------------------ */
  /* Intraday price paths                                                 */
  /* ------------------------------------------------------------------ */

  private marketNoise(dayIdx: number): Float64Array {
    return this.marketNoiseCache.getOrCreate(dayIdx, () => {
      const rng = Rng.of(this.seed, 'intraday-market', dayIdx);
      const W = new Float64Array(M + 1);
      for (let j = 1; j <= M; j++) W[j] = W[j - 1] + Math.sqrt(U_PROFILE[j]) * rng.normal();
      return W;
    });
  }

  /** Minute-resolution price path for a day (index 0 = 09:15 open, 375 = 15:30 close). */
  path(symbol: string, dayIdx: number): Float64Array {
    return this.pathCache.getOrCreate(`${symbol}|${dayIdx}`, () => {
      const inst = this.inst(symbol);
      const bar = this.bar(symbol, dayIdx);
      const Wm = this.marketNoise(dayIdx);
      const rho = symbol === 'NIFTY' ? 1 : inst.kind === 'index' ? 0.92 : 0.5;
      const k = Math.sqrt(1 - rho * rho);
      const rng = Rng.of(this.seed, 'intraday', symbol, dayIdx);
      const C = new Float64Array(M + 1);
      let w = 0;
      for (let j = 1; j <= M; j++) {
        w += Math.sqrt(U_PROFILE[j]) * rng.normal();
        C[j] = rho * Wm[j] + k * w;
      }
      const sigma = (inst.vol / Math.sqrt(252)) * Math.sqrt(bar.h) * INTRADAY_VOL_FACTOR;
      const lo = Math.log(bar.open);
      const lc = Math.log(bar.close);
      const P = new Float64Array(M + 1);
      for (let j = 0; j <= M; j++) {
        const t = j / M;
        P[j] = Math.exp(lo + t * (lc - lo) + sigma * (C[j] - t * C[M]));
      }
      P[0] = bar.open;
      P[M] = bar.close;
      return P;
    });
  }

  /** Spot at an exact minute (no sub-minute noise) — used for time series. */
  spotAt(symbol: string, dayIdx: number, minute: number): number {
    const P = this.path(symbol, dayIdx);
    const j = Math.min(M, Math.max(0, Math.floor(minute)));
    const frac = Math.min(1, Math.max(0, minute - j));
    if (j >= M || frac === 0) return roundTick(P[j]);
    return roundTick(P[j] + (P[j + 1] - P[j]) * frac);
  }

  /** Live spot including second-level micro-structure noise. */
  spot(symbol: string, ts: number): number {
    const p = this.parts(ts);
    if (p.m >= M) return this.bar(symbol, p.dayIdx).close;
    const P = this.path(symbol, p.dayIdx);
    const j = Math.floor(p.m);
    const frac = p.m - j;
    const base = P[j] + (P[j + 1] - P[j]) * frac;
    const inst = this.inst(symbol);
    const sec = Math.floor(frac * 60);
    const micro = base * (inst.vol / Math.sqrt(252 * M)) * 0.3 * Math.sin(Math.PI * frac) * hashN(this.seed, this.symId(symbol), p.dayIdx, j, sec);
    return roundTick(base + micro);
  }

  dayStats(symbol: string, dayIdx: number, uptoMinute: number): { open: number; high: number; low: number; close: number } {
    const P = this.path(symbol, dayIdx);
    const last = Math.min(M, Math.floor(uptoMinute));
    let hi = P[0];
    let lo = P[0];
    for (let j = 1; j <= last; j++) {
      if (P[j] > hi) hi = P[j];
      if (P[j] < lo) lo = P[j];
    }
    return { open: P[0], high: roundTick(hi), low: roundTick(lo), close: roundTick(P[last]) };
  }

  /* ------------------------------------------------------------------ */
  /* Implied volatility                                                   */
  /* ------------------------------------------------------------------ */

  /** Base ATM IV (decimal) for the underlying at a session point. */
  atmIvAt(symbol: string, dayIdx: number, m: number): number {
    const bar = this.bar(symbol, dayIdx);
    const f = m / M;
    const open = bar.ivPrev * Math.exp(-2 * bar.gap);
    const base = open + (bar.iv - open) * f;
    const P = this.path(symbol, dayIdx);
    const j = Math.min(M, Math.floor(m));
    const lin = bar.open * Math.pow(bar.close / bar.open, j / M);
    const dev = Math.log(P[j] / lin);
    const wiggle = 1 + 0.012 * Math.sin(Math.PI * f) * hashN(this.seed, this.symId(symbol), dayIdx, Math.floor(j / 5), 31);
    return Math.max(0.04, base * Math.exp(-2.5 * dev) * wiggle);
  }

  atmIv(symbol: string, ts: number): number {
    const p = this.parts(ts);
    return this.atmIvAt(symbol, p.dayIdx, p.m);
  }

  /* ------------------------------------------------------------------ */
  /* Contracts                                                            */
  /* ------------------------------------------------------------------ */

  expiries(symbol: string, ts: number): string[] {
    const inst = this.inst(symbol);
    const p = this.parts(ts);
    const key = `${symbol}|${p.date}|${p.m >= M ? 1 : 0}`;
    return this.expiryCache.getOrCreate(key, () => {
      const list = generateExpiries(inst.expiryRule, p.date, { holidays: this.holidays, weeklyCount: 5, monthlyCount: 3, quarterlyCount: inst.expiryRule.startsWith('weekly') ? 2 : 0 });
      // An expiry on today stays listed through the close (15:30) snapshot.
      return list.filter((e) => e > p.date || (e === p.date && p.m <= M));
    });
  }

  futureExpiries(symbol: string, ts: number): string[] {
    const inst = this.inst(symbol);
    const p = this.parts(ts);
    const key = `F|${symbol}|${p.date}`;
    return this.expiryCache.getOrCreate(key, () =>
      generateExpiries(monthlyRuleOf(inst.expiryRule), p.date, { holidays: this.holidays, monthlyCount: 3, quarterlyCount: 0 }),
    );
  }

  contract(symbol: string, expiry: string): ContractCtx {
    const inst = this.inst(symbol);
    let expiryIdx = this.dayIndex.get(expiry);
    if (expiryIdx === undefined) expiryIdx = this.days.length - 1 + tradingDaysBetween(this.days[this.days.length - 1], expiry, this.holidays);
    return {
      inst,
      expiry,
      expiryIdx,
      expTs: expiryTs(expiry),
      weeklyType: inst.expiryRule.startsWith('weekly'),
      monthly: isMonthlyExpiry(inst.expiryRule, expiry, this.holidays),
      expNum: dateToNum(expiry),
    };
  }

  strikes(ctx: ContractCtx, dayIdx: number): number[] {
    const key = `${ctx.inst.symbol}|${ctx.expiry}|${dayIdx}`;
    return this.strikeCache.getOrCreate(key, () => {
      const inst = ctx.inst;
      const ref = this.bar(inst.symbol, dayIdx).prevClose;
      const step = inst.strikeStep;
      const center = Math.round(ref / step) * step;
      const far = ctx.expiryIdx - dayIdx > 30;
      const n = inst.kind === 'index'
        ? Math.min(far ? 55 : 45, Math.ceil(((far ? 0.12 : 0.09) * ref) / step))
        : Math.min(20, Math.max(8, Math.ceil((0.15 * ref) / step)));
      const out: number[] = [];
      for (let i = -n; i <= n; i++) {
        const k = +(center + i * step).toFixed(2);
        if (k > 0) out.push(k);
      }
      return out;
    });
  }

  contractId(ctx: ContractCtx, type: 'CE' | 'PE' | 'FUT', strike: number): number {
    return hash32(this.symId(ctx.inst.symbol), ctx.expNum, TYPE_CODE[type], Math.round(strike * 100));
  }

  private sessionsLeft(ctx: ContractCtx, dayIdx: number, f: number): number {
    return ctx.expiryIdx - dayIdx + (1 - f);
  }

  private oiWeight(ctx: ContractCtx, sl: number): number {
    const base = ctx.weeklyType ? 0.1 : 0.14;
    const tau = ctx.weeklyType ? 5 : 16;
    let w = base + (1 - base) * Math.exp(-Math.max(0, sl) / tau);
    if (sl > 30) w *= Math.exp(-(sl - 30) / 45);
    if (ctx.monthly && ctx.weeklyType) w *= 1.35;
    if (sl < 1) w *= 0.6 + 0.4 * Math.max(0, sl);
    return w;
  }

  private dayFactor(cid: number, dayIdx: number): number {
    const key = `${cid}|${dayIdx}`;
    const cached = this.dayFactorCache.get(key);
    if (cached !== undefined) return cached;
    const pers = Math.exp(0.32 * hashN(this.seed, cid, 7));
    const daily = Math.exp(0.12 * hashN(this.seed, cid, dayIdx, 11));
    let ev = 1;
    for (let e = dayIdx - 4; e <= dayIdx; e++) {
      if (hashU(this.seed, cid, e, 13) < 0.02) ev *= 1 + (0.5 + 1.3 * hashU(this.seed, cid, e, 17)) * Math.pow(0.82, dayIdx - e);
    }
    const v = pers * daily * ev;
    this.dayFactorCache.set(key, v);
    return v;
  }

  private roundBonus(inst: Instrument, strike: number): number {
    const s = inst.strikeStep;
    const k = Math.round(strike * 100);
    if (k % Math.round(s * 1000) === 0) return 1.9;
    if (k % Math.round(s * 200) === 0) return 1.3;
    return 1;
  }

  /** Open interest (quantity) of an option at a session point. */
  oiAt(ctx: ContractCtx, type: 'CE' | 'PE', strike: number, dayIdx: number, m: number): number {
    const f = m / M;
    const sl = this.sessionsLeft(ctx, dayIdx, f);
    if (sl < 0) return 0;
    const inst = ctx.inst;
    const bar = this.bar(inst.symbol, dayIdx);
    const sref = bar.prevClose + (bar.close - bar.prevClose) * f;
    const scale = inst.baseIv * Math.sqrt(Math.max(sl, 1.5) / 252);
    const x = Math.log(strike / sref) / scale;
    const z = (x - (type === 'CE' ? 0.75 : -0.75)) / 1.15;
    const shape = Math.exp(-0.5 * z * z) + 0.012;
    const cid = this.contractId(ctx, type, strike);
    const nf = this.dayFactor(cid, dayIdx - 1) * (1 - f) + this.dayFactor(cid, dayIdx) * f;
    const jit = 1 + 0.015 * Math.sin(Math.PI * f) * hashN(this.seed, cid, dayIdx, Math.floor(m / 3), 19);
    const raw = inst.peakOi * this.oiWeight(ctx, sl) * shape * this.roundBonus(inst, strike) * nf * jit;
    return Math.max(0, Math.round(raw / inst.lotSize)) * inst.lotSize;
  }

  /** Cumulative traded volume (quantity) of an option since the open. */
  volumeAt(ctx: ContractCtx, type: 'CE' | 'PE', strike: number, dayIdx: number, m: number): number {
    if (ctx.expiryIdx < dayIdx) return 0;
    const inst = ctx.inst;
    const f = m / M;
    const slDay = ctx.expiryIdx - dayIdx + 1;
    const bar = this.bar(inst.symbol, dayIdx);
    const smid = (bar.prevClose + bar.close) / 2;
    const x = Math.log(strike / smid) / (inst.baseIv * Math.sqrt(Math.max(slDay, 1.5) / 252));
    const act = Math.exp(-0.5 * (x / 0.85) ** 2) + 0.015;
    const turnover = ctx.weeklyType ? 0.5 + 9 * Math.exp(-(slDay - 1) / 1.2) : 0.35 + 3 * Math.exp(-(slDay - 1) / 2.5);
    const cid = this.contractId(ctx, type, strike);
    const daily = inst.peakOi * this.oiWeight(ctx, slDay - 0.5) * act * turnover * Math.exp(0.25 * hashN(this.seed, cid, dayIdx, 23)) * (type === 'CE' ? 1 : 0.95);
    const cum = f + (0.7 / (2 * Math.PI)) * Math.sin(2 * Math.PI * f);
    return Math.max(0, Math.round((daily * cum) / inst.lotSize)) * inst.lotSize;
  }

  /** Smile-adjusted implied vol for a strike. */
  optionIv(ctx: ContractCtx, type: 'CE' | 'PE', strike: number, spot: number, T: number, atmBase: number, dayIdx: number): number {
    const inst = ctx.inst;
    const F = spot * Math.exp((this.r - inst.divYield) * T);
    const tDays = T * 365;
    const term = 0.95 + 0.07 * Math.min(1, tDays / 60) + (tDays < 1 ? 0.1 * (1 - tDays) : 0);
    const atm = atmBase * term;
    const sd = atm * Math.sqrt(Math.max(T, 0.5 / 365));
    const x = Math.max(-6.5, Math.min(6.5, Math.log(strike / F) / sd));
    const smile = 1 + inst.skew * x + inst.smile * x * x;
    // Smooth (low-frequency in strike) daily distortion keeps the curve market-like without
    // breaking strike convexity; CE/PE get only a tiny independent jitter.
    const phase = 2 * Math.PI * hashU(this.seed, this.symId(inst.symbol), ctx.expNum, dayIdx, 29);
    const wave = 0.0018 * Math.sin(0.9 * x + phase);
    const jitter = 0.00004 * hashN(this.seed, this.contractId(ctx, type, strike), dayIdx, 31);
    return Math.max(0.3 * atm, atm * smile + wave + jitter);
  }

  /** Option premium & IV at an exact session minute (for series) or live ts. */
  optionAt(ctx: ContractCtx, type: 'CE' | 'PE', strike: number, ts: number, opts: { minute?: { dayIdx: number; m: number } } = {}): OptionPoint {
    const p = opts.minute ? { dayIdx: opts.minute.dayIdx, m: opts.minute.m } : this.parts(ts);
    const at = opts.minute ? this.tsOf(p.dayIdx, p.m) : ts;
    const S = opts.minute ? this.spotAt(ctx.inst.symbol, p.dayIdx, p.m) : this.spot(ctx.inst.symbol, ts);
    const T = yearsBetween(at, ctx.expTs);
    const atm = this.atmIvAt(ctx.inst.symbol, p.dayIdx, p.m);
    const iv = this.optionIv(ctx, type, strike, S, T, atm, p.dayIdx);
    const g = bsGreeks(type, S, strike, T, this.r, iv, ctx.inst.divYield);
    return { ltp: Math.max(0.05, roundTick(g.price)), iv, spot: S, T };
  }

  /* ------------------------------------------------------------------ */
  /* Futures                                                              */
  /* ------------------------------------------------------------------ */

  futurePrice(symbol: string, expiry: string, ts: number, minute?: { dayIdx: number; m: number }): number {
    const inst = this.inst(symbol);
    const at = minute ? this.tsOf(minute.dayIdx, minute.m) : ts;
    const S = minute ? this.spotAt(symbol, minute.dayIdx, minute.m) : this.spot(symbol, ts);
    const T = yearsBetween(at, expiryTs(expiry));
    const p = minute ?? this.parts(ts);
    const basis = 1 + 0.00012 * hashN(this.seed, this.symId(symbol), dateToNum(expiry), p.dayIdx, Math.floor(p.m / 2));
    return roundTick(S * Math.exp((this.r - inst.divYield) * T) * basis);
  }

  futureOi(symbol: string, expiry: string, dayIdx: number, m: number): number {
    const inst = this.inst(symbol);
    const exps = this.futureExpiries(symbol, this.tsOf(dayIdx, Math.min(m, M - 1)));
    const rank = exps.indexOf(expiry);
    if (rank < 0) return 0;
    const f = m / M;
    const near = this.contract(symbol, exps[0]);
    const slNear = this.sessionsLeft(near, dayIdx, f);
    const nearShare = slNear > 6 ? 0.88 : 0.25 + (0.63 * Math.max(0, slNear)) / 6;
    const shares = [nearShare, (1 - nearShare) * 0.92, (1 - nearShare) * 0.08];
    const bar = this.bar(symbol, dayIdx);
    const agg = bar.futOiPrev + (bar.futOi - bar.futOiPrev) * f;
    const jit = 1 + 0.004 * Math.sin(Math.PI * f) * hashN(this.seed, this.symId(symbol), dayIdx, Math.floor(m / 3), 37);
    return Math.max(0, Math.round((agg * shares[rank] * jit) / inst.lotSize)) * inst.lotSize;
  }

  futureVolume(symbol: string, expiry: string, dayIdx: number, m: number): number {
    const inst = this.inst(symbol);
    const exps = this.futureExpiries(symbol, this.tsOf(dayIdx, 0));
    const rank = exps.indexOf(expiry);
    if (rank < 0) return 0;
    const bar = this.bar(symbol, dayIdx);
    const share = [0.85, 0.13, 0.02][rank] ?? 0;
    const f = m / M;
    const cum = f + (0.7 / (2 * Math.PI)) * Math.sin(2 * Math.PI * f);
    const daily = (inst.kind === 'index' ? bar.volume : bar.futOi * 0.45) * share;
    return Math.max(0, Math.round((daily * cum) / inst.lotSize)) * inst.lotSize;
  }

  /* ------------------------------------------------------------------ */
  /* Order flow                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Order-book pressure for an underlying (changes every 2 minutes): > 0 means resting bids
   * outweigh offers. Shared by the depth view and the order-flow split so they agree.
   */
  bookTilt(symbol: string, dayIdx: number, minute: number): number {
    return 0.35 * hashN(this.symId(symbol), dayIdx, Math.floor(minute / 2), 3);
  }

  /** Std-dev of the underlying's log move over session minute j → j+1. */
  private minuteSigma(symbol: string, dayIdx: number, j: number): number {
    const inst = this.inst(symbol);
    const bar = this.bar(symbol, dayIdx);
    return (inst.vol / Math.sqrt(252)) * Math.sqrt(bar.h) * INTRADAY_VOL_FACTOR * Math.sqrt(U_PROFILE[Math.min(M, Math.max(1, j + 1))]);
  }

  /**
   * Split traded volume between aggressive buyers and sellers. Buyers dominate when the price
   * (for puts: the underlying, inverted) rises over the interval and when the book leans bid.
   */
  private buyShare(symbol: string, sign: 1 | -1, dayIdx: number, j: number, move: number, noiseId: number): number {
    const z = move / this.minuteSigma(symbol, dayIdx, j);
    const x = 0.6 * sign * Math.max(-4, Math.min(4, z)) + 0.8 * this.bookTilt(symbol, dayIdx, j) + 0.3 * hashN(this.seed ^ noiseId, dayIdx, j, 53);
    return 1 / (1 + Math.exp(-x));
  }

  /**
   * Buy/sell volume for the 1-minute interval [j, j+1] (or a partial interval up to `to`).
   * Futures are used for the underlying itself (indices have no traded spot volume).
   */
  minuteFlow(
    symbol: string,
    spec: { type: 'FUT' | 'CE' | 'PE'; expiry: string; strike?: number },
    dayIdx: number,
    j: number,
    to = j + 1,
  ): { volume: number; buyVolume: number; sellVolume: number; close: number } {
    const inst = this.inst(symbol);
    const lot = inst.lotSize;
    const P = this.path(symbol, dayIdx);
    const end = Math.min(M, to);
    const pEnd = end === Math.floor(end) ? P[end] : P[Math.floor(end)] + (P[Math.min(M, Math.floor(end) + 1)] - P[Math.floor(end)]) * (end - Math.floor(end));
    const move = Math.log(pEnd / P[j]);
    let volume: number;
    let close: number;
    let sign: 1 | -1 = 1;
    let noiseId: number;
    if (spec.type === 'FUT') {
      volume = this.futureVolume(symbol, spec.expiry, dayIdx, end) - this.futureVolume(symbol, spec.expiry, dayIdx, j);
      close = this.futurePrice(symbol, spec.expiry, 0, { dayIdx, m: end });
      noiseId = this.symId(symbol) ^ dateToNum(spec.expiry);
    } else {
      const ctx = this.contract(symbol, spec.expiry);
      const k = Number(spec.strike);
      volume = this.volumeAt(ctx, spec.type, k, dayIdx, end) - this.volumeAt(ctx, spec.type, k, dayIdx, j);
      close = this.optionAt(ctx, spec.type, k, 0, { minute: { dayIdx, m: end } }).ltp;
      sign = spec.type === 'CE' ? 1 : -1;
      noiseId = this.contractId(ctx, spec.type, k);
    }
    volume = Math.max(0, volume);
    const buyVolume = Math.min(volume, Math.max(0, Math.round((volume * this.buyShare(symbol, sign, dayIdx, j, move, noiseId)) / lot) * lot));
    return { volume, buyVolume, sellVolume: volume - buyVolume, close };
  }

  /* ------------------------------------------------------------------ */
  /* Composite views                                                      */
  /* ------------------------------------------------------------------ */

  quote(symbol: string, ts: number): Quote {
    const p = this.parts(ts);
    const bar = this.bar(symbol, p.dayIdx);
    const ltp = this.spot(symbol, ts);
    const st = this.dayStats(symbol, p.dayIdx, p.m);
    const futExp = this.futureExpiries(symbol, ts)[0];
    const fut = this.futurePrice(symbol, futExp, ts);
    const prevFutTs = this.tsOf(Math.max(0, p.dayIdx - 1), M);
    const futPrev = this.futurePrice(symbol, futExp, prevFutTs, { dayIdx: Math.max(0, p.dayIdx - 1), m: M });
    return {
      symbol,
      ltp,
      change: +(ltp - bar.prevClose).toFixed(2),
      changePct: +(((ltp - bar.prevClose) / bar.prevClose) * 100).toFixed(2),
      open: st.open,
      high: Math.max(st.high, ltp),
      low: Math.min(st.low, ltp),
      prevClose: bar.prevClose,
      future: fut,
      futureChange: +(fut - futPrev).toFixed(2),
      atmIv: +(this.atmIvAt(symbol, p.dayIdx, p.m) * 100).toFixed(2),
      ts,
    };
  }

  optionQuote(ctx: ContractCtx, type: 'CE' | 'PE', strike: number, ts: number): OptionQuote {
    const p = this.parts(ts);
    const now = this.optionAt(ctx, type, strike, ts);
    const prevIdx = Math.max(0, p.dayIdx - 1);
    const prev = this.optionAt(ctx, type, strike, 0, { minute: { dayIdx: prevIdx, m: M } });
    const prevLtp = ctx.expiryIdx >= prevIdx ? prev.ltp : now.ltp;
    const oi = this.oiAt(ctx, type, strike, p.dayIdx, p.m);
    const prevOi = this.oiAt(ctx, type, strike, prevIdx, M);
    const volume = this.volumeAt(ctx, type, strike, p.dayIdx, p.m);
    const g = bsGreeks(type, now.spot, strike, now.T, this.r, now.iv, ctx.inst.divYield);
    const intrinsic = type === 'CE' ? Math.max(0, now.spot - strike) : Math.max(0, strike - now.spot);
    const spreadTicks = Math.max(1, Math.round((now.ltp * (0.002 + 0.01 / ctx.inst.liquidity)) / 0.05));
    const half = (spreadTicks * 0.05) / 2;
    const cid = this.contractId(ctx, type, strike);
    const secKey = Math.floor(ts / 1000);
    const bid = Math.max(0.05, roundTick(now.ltp - half));
    const ask = roundTick(Math.max(bid + 0.05, now.ltp + half));
    const lot = ctx.inst.lotSize;
    const qtyBase = Math.max(1, Math.round(ctx.inst.liquidity * 40 * Math.exp(-Math.abs(Math.log(strike / now.spot)) * 8)));
    const change = now.ltp - prevLtp;
    const oiChange = oi - prevOi;
    return {
      ltp: now.ltp,
      change: +change.toFixed(2),
      changePct: prevLtp > 0 ? +((change / prevLtp) * 100).toFixed(2) : 0,
      prevClose: prevLtp,
      oi,
      prevOi,
      oiChange,
      oiChangePct: prevOi > 0 ? +((oiChange / prevOi) * 100).toFixed(2) : 0,
      volume,
      iv: +(now.iv * 100).toFixed(2),
      delta: +g.delta.toFixed(4),
      gamma: +g.gamma.toFixed(6),
      theta: +g.theta.toFixed(2),
      vega: +g.vega.toFixed(2),
      bid,
      ask,
      bidQty: lot * (1 + Math.floor(hashU(this.seed, cid, secKey, 41) * qtyBase)),
      askQty: lot * (1 + Math.floor(hashU(this.seed, cid, secKey, 43) * qtyBase)),
      buildUp: classifyBuildUp(change, oiChange),
      intrinsic: +intrinsic.toFixed(2),
      timeValue: +Math.max(0, now.ltp - intrinsic).toFixed(2),
    };
  }

  chain(symbol: string, expiryIn: string | undefined, ts: number): OptionChain {
    const inst = this.inst(symbol);
    const p = this.parts(ts);
    const expiries = this.expiries(symbol, ts);
    const expiry = expiryIn && expiries.includes(expiryIn) ? expiryIn : expiries[0];
    const ctx = this.contract(symbol, expiry);
    const strikes = this.strikes(ctx, p.dayIdx);
    const spot = this.spot(symbol, ts);
    const bar = this.bar(symbol, p.dayIdx);
    const rows: ChainRow[] = strikes.map((strike) => ({
      strike,
      ce: this.optionQuote(ctx, 'CE', strike, ts),
      pe: this.optionQuote(ctx, 'PE', strike, ts),
    }));
    let atm = strikes[0];
    for (const k of strikes) if (Math.abs(k - spot) < Math.abs(atm - spot)) atm = k;
    const atmRow = rows.find((r) => r.strike === atm)!;
    const oiRows = rows.map((r) => ({ strike: r.strike, ceOI: r.ce.oi, peOI: r.pe.oi, ceVolume: r.ce.volume, peVolume: r.pe.volume, ceOIChange: r.ce.oiChange, peOIChange: r.pe.oiChange }));
    const pc = pcrOf(oiRows);
    const sr = oiSupportResistance(oiRows);
    const prevIdx = Math.max(0, p.dayIdx - 1);
    const prevAtm = this.optionAt(ctx, 'CE', atm, 0, { minute: { dayIdx: prevIdx, m: M } }).iv;
    const atmIv = (atmRow.ce.iv + atmRow.pe.iv) / 2;
    const futExp = this.futureExpiries(symbol, ts)[0];
    const T = yearsBetween(ts, ctx.expTs);
    return {
      symbol,
      expiry,
      expiries,
      ts,
      spot,
      spotChange: +(spot - bar.prevClose).toFixed(2),
      spotChangePct: +(((spot - bar.prevClose) / bar.prevClose) * 100).toFixed(2),
      future: this.futurePrice(symbol, futExp, ts),
      futureExpiry: futExp,
      carry: inst.divYield,
      lotSize: inst.lotSize,
      strikeStep: inst.strikeStep,
      daysToExpiry: +(T * 365).toFixed(2),
      atm,
      atmIv: +atmIv.toFixed(2),
      ivChange: +(atmIv - prevAtm * 100).toFixed(2),
      pcr: +pc.oi.toFixed(2),
      pcrVolume: +pc.volume.toFixed(2),
      maxPain: maxPain(oiRows).maxPain,
      totalCeOi: oiRows.reduce((a, r) => a + r.ceOI, 0),
      totalPeOi: oiRows.reduce((a, r) => a + r.peOI, 0),
      totalCeOiChange: oiRows.reduce((a, r) => a + (r.ceOIChange ?? 0), 0),
      totalPeOiChange: oiRows.reduce((a, r) => a + (r.peOIChange ?? 0), 0),
      support: sr.support,
      resistance: sr.resistance,
      rows,
    };
  }

  /** Minute marks from the open up to `uptoMinute`, stepping `interval`, always ending at the last point. */
  minuteMarks(uptoMinute: number, interval: number): number[] {
    const out: number[] = [];
    const last = Math.min(M, Math.floor(uptoMinute));
    for (let m = 0; m <= last; m += interval) out.push(m);
    if (out[out.length - 1] !== last) out.push(last);
    return out;
  }
}
