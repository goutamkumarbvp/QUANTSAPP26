/**
 * Strategy (multi-leg) valuation: payoff at expiry, theoretical P&L before expiry,
 * breakevens, max profit / loss, probability of profit and net Greeks.
 */
import { bsGreeks, bsPrice, intrinsic, type OptionType } from './bs';
import { expiryTs, yearsBetween } from './dates';
import { normPdf } from './math';

export type Side = 'BUY' | 'SELL';
export type InstrumentType = OptionType | 'FUT';

export interface Leg {
  id?: string;
  side: Side;
  type: InstrumentType;
  /** Strike for options; ignored for futures. */
  strike: number;
  expiry: string;
  lots: number;
  lotSize: number;
  /** Entry price per unit. */
  price: number;
  /** Implied vol (decimal) used to value the leg before expiry. */
  iv?: number;
  /** Set once the leg has been squared off. */
  exitPrice?: number | null;
  /** Excluded from analysis when false (builder checkbox). */
  active?: boolean;
}

export interface ValuationContext {
  r: number;
  /** Carry yield per expiry so that S·e^{(r−q)T} matches the future of that expiry. */
  carry?: (expiry: string) => number;
  /** Additive IV shift in vol points as decimal (0.02 = +2%). */
  ivShift?: number;
  /** Default IV when a leg has none. */
  defaultIv?: number;
}

export const sideSign = (side: Side) => (side === 'BUY' ? 1 : -1);
export const legQty = (leg: Leg) => leg.lots * leg.lotSize;
const isActive = (leg: Leg) => leg.active !== false && leg.lots !== 0;

function legIv(leg: Leg, ctx: ValuationContext): number {
  const base = leg.iv && leg.iv > 0 ? leg.iv : ctx.defaultIv ?? 0.15;
  return Math.max(0.005, base + (ctx.ivShift ?? 0));
}

/** Theoretical price of the instrument for underlying `S` at time `evalTs`. */
export function legTheoPrice(leg: Leg, S: number, evalTs: number, ctx: ValuationContext): number {
  const T = yearsBetween(evalTs, expiryTs(leg.expiry));
  const q = ctx.carry ? ctx.carry(leg.expiry) : 0;
  if (leg.type === 'FUT') return S * Math.exp((ctx.r - q) * T);
  if (T <= 0) return intrinsic(leg.type, S, leg.strike);
  return bsPrice(leg.type, S, leg.strike, T, ctx.r, legIv(leg, ctx), q);
}

export function legPnl(leg: Leg, S: number, evalTs: number, ctx: ValuationContext): number {
  if (!isActive(leg)) return 0;
  const qty = legQty(leg) * sideSign(leg.side);
  if (leg.exitPrice != null) return qty * (leg.exitPrice - leg.price);
  return qty * (legTheoPrice(leg, S, evalTs, ctx) - leg.price);
}

export function strategyPnl(legs: readonly Leg[], S: number, evalTs: number, ctx: ValuationContext): number {
  let pnl = 0;
  for (const leg of legs) pnl += legPnl(leg, S, evalTs, ctx);
  return pnl;
}

/** Timestamp of the first expiry among open legs (the payoff "at expiry" horizon). */
export function nearestExpiryTs(legs: readonly Leg[]): number {
  let best = Infinity;
  for (const leg of legs) {
    if (!isActive(leg) || leg.exitPrice != null) continue;
    best = Math.min(best, expiryTs(leg.expiry));
  }
  return best;
}

export interface PayoffCurve {
  prices: number[];
  expiry: number[];
  target: number[];
}

export function payoffCurve(
  legs: readonly Leg[],
  ctx: ValuationContext,
  opts: { lo: number; hi: number; points?: number; targetTs: number; extraPrices?: number[] },
): PayoffCurve {
  const n = opts.points ?? 161;
  const set = new Set<number>();
  for (let i = 0; i < n; i++) set.add(+(opts.lo + ((opts.hi - opts.lo) * i) / (n - 1)).toFixed(2));
  for (const p of opts.extraPrices ?? []) if (p >= opts.lo && p <= opts.hi) set.add(p);
  for (const leg of legs) if (leg.type !== 'FUT' && leg.strike >= opts.lo && leg.strike <= opts.hi) set.add(leg.strike);
  const prices = [...set].sort((a, b) => a - b);
  const expTs = nearestExpiryTs(legs);
  const atExpiry = Number.isFinite(expTs) ? expTs : opts.targetTs;
  return {
    prices,
    expiry: prices.map((S) => strategyPnl(legs, S, atExpiry, ctx)),
    target: prices.map((S) => strategyPnl(legs, S, opts.targetTs, ctx)),
  };
}

export function findBreakevens(f: (S: number) => number, lo: number, hi: number, steps = 2000): number[] {
  const out: number[] = [];
  let prevS = lo;
  let prevV = f(lo);
  for (let i = 1; i <= steps; i++) {
    const S = lo + ((hi - lo) * i) / steps;
    const v = f(S);
    if ((prevV < 0 && v >= 0) || (prevV > 0 && v <= 0)) {
      if (v === 0 && i < steps) {
        out.push(S);
      } else {
        let a = prevS;
        let b = S;
        let fa = prevV;
        for (let k = 0; k < 50; k++) {
          const m = 0.5 * (a + b);
          const fm = f(m);
          if ((fa < 0 && fm < 0) || (fa > 0 && fm > 0)) {
            a = m;
            fa = fm;
          } else b = m;
        }
        out.push(0.5 * (a + b));
      }
    }
    prevS = S;
    prevV = v;
  }
  // de-duplicate near-identical roots (flat zero regions)
  return out.filter((x, i) => i === 0 || Math.abs(x - out[i - 1]) > (hi - lo) * 1e-4);
}

export interface StrategyGreeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

export function strategyGreeks(legs: readonly Leg[], S: number, nowTs: number, ctx: ValuationContext): StrategyGreeks {
  const g: StrategyGreeks = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  for (const leg of legs) {
    if (!isActive(leg) || leg.exitPrice != null) continue;
    const qty = legQty(leg) * sideSign(leg.side);
    if (leg.type === 'FUT') {
      g.delta += qty;
      continue;
    }
    const T = yearsBetween(nowTs, expiryTs(leg.expiry));
    const q = ctx.carry ? ctx.carry(leg.expiry) : 0;
    const gr = bsGreeks(leg.type, S, leg.strike, T, ctx.r, legIv(leg, ctx), q);
    g.delta += qty * gr.delta;
    g.gamma += qty * gr.gamma;
    g.theta += qty * gr.theta;
    g.vega += qty * gr.vega;
  }
  return g;
}

export interface StrategyAnalysis {
  maxProfit: number | null; // null => unlimited
  maxLoss: number | null; // null => unlimited (reported as positive number otherwise negative pnl)
  breakevens: number[];
  /** Positive = net credit received, negative = net debit paid. */
  netPremium: number;
  pop: number;
  expectedPnl: number;
  riskReward: number | null;
  greeks: StrategyGreeks;
  currentPnl: number;
  realizedPnl: number;
}

/**
 * Risk-neutral probability of profit and expected P&L at the nearest expiry,
 * integrating the payoff against the lognormal density.
 */
export function probabilityOfProfit(
  legs: readonly Leg[],
  S: number,
  sigma: number,
  nowTs: number,
  ctx: ValuationContext,
): { pop: number; expected: number } {
  const expTs = nearestExpiryTs(legs);
  if (!Number.isFinite(expTs)) {
    const v = strategyPnl(legs, S, nowTs, ctx);
    return { pop: v > 0 ? 1 : 0, expected: v };
  }
  const T = yearsBetween(nowTs, expTs);
  if (T <= 0 || sigma <= 0) {
    const v = strategyPnl(legs, S, expTs, ctx);
    return { pop: v > 0 ? 1 : 0, expected: v };
  }
  const sd = sigma * Math.sqrt(T);
  const mu = Math.log(S) - 0.5 * sd * sd;
  const N = 800;
  const zLo = -6;
  const zHi = 6;
  const dz = (zHi - zLo) / N;
  let pop = 0;
  let expected = 0;
  let mass = 0;
  for (let i = 0; i < N; i++) {
    const z = zLo + (i + 0.5) * dz;
    const w = normPdf(z) * dz;
    const ST = Math.exp(mu + sd * z);
    const v = strategyPnl(legs, ST, expTs, ctx);
    mass += w;
    expected += w * v;
    if (v > 0) pop += w;
  }
  return { pop: pop / mass, expected: expected / mass };
}

export function analyzeStrategy(
  legs: readonly Leg[],
  S: number,
  nowTs: number,
  ctx: ValuationContext,
  opts: { sigma?: number } = {},
): StrategyAnalysis {
  const active = legs.filter(isActive);
  const realizedPnl = active.filter((l) => l.exitPrice != null).reduce((a, l) => a + legPnl(l, S, nowTs, ctx), 0);
  const netPremium = active
    .filter((l) => l.type !== 'FUT' && l.exitPrice == null)
    .reduce((a, l) => a - sideSign(l.side) * l.price * legQty(l), 0);
  const greeks = strategyGreeks(active, S, nowTs, ctx);
  const currentPnl = strategyPnl(active, S, nowTs, ctx);
  const expTs = nearestExpiryTs(active);
  if (!active.length || !Number.isFinite(expTs)) {
    return { maxProfit: realizedPnl, maxLoss: realizedPnl, breakevens: [], netPremium, pop: realizedPnl > 0 ? 1 : 0, expectedPnl: realizedPnl, riskReward: null, greeks, currentPnl, realizedPnl };
  }

  const f = (x: number) => strategyPnl(active, x, expTs, ctx);
  const strikes = active.filter((l) => l.type !== 'FUT').map((l) => l.strike);
  const hi = Math.max(S, ...strikes) * 3;
  const samples: number[] = [0.01, ...strikes];
  for (let i = 0; i <= 600; i++) samples.push((hi * i) / 600);
  let max = -Infinity;
  let min = Infinity;
  for (const x of samples) {
    const v = f(x);
    if (v > max) max = v;
    if (v < min) min = v;
  }
  // Unlimited detection: payoff keeps trending beyond the sampled range.
  const far1 = f(hi * 4);
  const far2 = f(hi * 8);
  const slope = (far2 - far1) / (hi * 4);
  const tol = Math.max(1e-6, Math.abs(far1) * 1e-9);
  let maxProfit: number | null = max;
  let maxLoss: number | null = min;
  if (slope > tol) maxProfit = null;
  if (slope < -tol) maxLoss = null;

  const breakevens = findBreakevens(f, Math.max(0.01, S * 0.2), Math.max(S * 2.5, ...strikes.map((k) => k * 1.5)), 3000);
  const sigma = opts.sigma ?? (active.find((l) => l.iv)?.iv ?? ctx.defaultIv ?? 0.15);
  const { pop, expected } = probabilityOfProfit(active, S, sigma, nowTs, ctx);
  const riskReward = maxProfit !== null && maxLoss !== null && maxLoss < 0 ? maxProfit / Math.abs(maxLoss) : null;
  return { maxProfit, maxLoss, breakevens, netPremium, pop, expectedPnl: expected, riskReward, greeks, currentPnl, realizedPnl };
}

/** Grid of P&L for spot moves (rows) × evaluation dates (columns). */
export function scenarioGrid(
  legs: readonly Leg[],
  S: number,
  ctx: ValuationContext,
  movesPct: number[],
  evalTs: number[],
): { spot: number; movePct: number; pnl: number[] }[] {
  return movesPct.map((m) => {
    const spot = S * (1 + m / 100);
    return { spot, movePct: m, pnl: evalTs.map((ts) => strategyPnl(legs, spot, ts, ctx)) };
  });
}
