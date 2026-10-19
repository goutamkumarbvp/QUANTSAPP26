/**
 * Strategy (multi-leg) valuation: payoff at expiry, theoretical P&L before expiry,
 * breakevens, max profit / loss, probability of profit and net Greeks.
 */
import { bsGreeks, bsPrice, intrinsic, type OptionType } from './bs';
import { expiryTs, formatExpiry, yearsBetween } from './dates';
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

/**
 * Inputs of the theoretical (before-expiry) valuation. Nothing is assumed for a missing input: a leg
 * that needs an IV it does not have (`Leg.iv`), or a carry the context cannot give, is not valued — it
 * is left out of the theoretical figures and named in the `missing` lists of the results (`LegGap`).
 * Payoffs at expiry (intrinsic values) and closed legs never need either.
 */
export interface ValuationContext {
  r: number;
  /**
   * Carry yield per expiry so that S·e^{(r−q)T} matches the future of that expiry. Omit it for q = 0
   * (a caller that does not model carry); return null when the carry of that expiry is not known —
   * legs of that expiry are then not valued before their expiry.
   */
  carry?: (expiry: string) => number | null;
  /** Additive IV shift in vol points as decimal (0.02 = +2%). */
  ivShift?: number;
}

/** A leg left out of a theoretical figure, and why. */
export interface LegGap {
  /** Position of the leg in the array that was passed in. */
  index: number;
  id?: string;
  /** e.g. "Sell 25000 CE 27-Oct-26". */
  label: string;
  reason: string;
}

export const sideSign = (side: Side) => (side === 'BUY' ? 1 : -1);
export const legQty = (leg: Leg) => leg.lots * leg.lotSize;
const isActive = (leg: Leg) => leg.active !== false && leg.lots !== 0;

/** Short human label of a leg ("Buy 25000 CE 27-Oct-26", "Sell FUT 27-Oct-26"). */
export function legLabel(leg: Leg): string {
  return `${leg.side === 'BUY' ? 'Buy' : 'Sell'} ${leg.type === 'FUT' ? 'FUT' : `${leg.strike} ${leg.type}`} ${formatExpiry(leg.expiry)}`;
}

/** The leg's IV (decimal) with the context's shift applied, or null when the leg has none. */
function legIv(leg: Leg, ctx: ValuationContext): number | null {
  if (!(typeof leg.iv === 'number' && Number.isFinite(leg.iv) && leg.iv > 0)) return null;
  return Math.max(0.005, leg.iv + (ctx.ivShift ?? 0));
}

/** Carry q of `expiry`: 0 when the context models none, null when it does not know it. */
function carryOf(expiry: string, ctx: ValuationContext): number | null {
  if (!ctx.carry) return 0;
  const q = ctx.carry(expiry);
  return typeof q === 'number' && Number.isFinite(q) ? q : null;
}

/**
 * Why the leg cannot be valued before its expiry at `evalTs`, or null when it can. Closed and inactive
 * legs and legs at/after their expiry need nothing. `greeks`: futures need no carry for their delta.
 */
function legGapReason(leg: Leg, evalTs: number, ctx: ValuationContext, greeks = false): string | null {
  if (!isActive(leg) || leg.exitPrice != null) return null;
  if (yearsBetween(evalTs, expiryTs(leg.expiry)) <= 0) return null;
  if (leg.type === 'FUT' && greeks) return null;
  if (carryOf(leg.expiry, ctx) === null) return `no live forward (carry) for the ${formatExpiry(leg.expiry)} expiry`;
  if (leg.type !== 'FUT' && legIv(leg, ctx) === null) return 'no implied volatility (none could be solved from a live premium)';
  return null;
}

function gapsOf(legs: readonly Leg[], reasonOf: (leg: Leg) => string | null): LegGap[] {
  const out: LegGap[] = [];
  legs.forEach((leg, index) => {
    const reason = reasonOf(leg);
    if (reason) out.push({ index, id: leg.id, label: legLabel(leg), reason });
  });
  return out;
}

/** Legs that `strategyPnl` leaves out at `evalTs` (theoretical value needs an IV / carry they lack). */
export function strategyGaps(legs: readonly Leg[], evalTs: number, ctx: ValuationContext): LegGap[] {
  return gapsOf(legs, (l) => legGapReason(l, evalTs, ctx));
}

/**
 * Theoretical price of the instrument for underlying `S` at time `evalTs`; null when it cannot be
 * valued (an option before expiry with no IV, or no known carry). Intrinsic at/after expiry.
 */
export function legTheoPrice(leg: Leg, S: number, evalTs: number, ctx: ValuationContext): number | null {
  const T = yearsBetween(evalTs, expiryTs(leg.expiry));
  if (T <= 0) return leg.type === 'FUT' ? S : intrinsic(leg.type, S, leg.strike); // settles at the underlying / intrinsic
  const q = carryOf(leg.expiry, ctx);
  if (q === null) return null;
  if (leg.type === 'FUT') return S * Math.exp((ctx.r - q) * T);
  const sigma = legIv(leg, ctx);
  if (sigma === null) return null;
  return bsPrice(leg.type, S, leg.strike, T, ctx.r, sigma, q);
}

/** P&L of one leg; 0 for an inactive leg, null when the leg cannot be valued (see `legTheoPrice`). */
export function legPnl(leg: Leg, S: number, evalTs: number, ctx: ValuationContext): number | null {
  if (!isActive(leg)) return 0;
  const qty = legQty(leg) * sideSign(leg.side);
  if (leg.exitPrice != null) return qty * (leg.exitPrice - leg.price);
  const px = legTheoPrice(leg, S, evalTs, ctx);
  return px === null ? null : qty * (px - leg.price);
}

/**
 * Total P&L of the legs that can be valued. A leg that cannot be valued (no IV / carry before its
 * expiry) is left out — `strategyGaps` names those legs for the same arguments.
 */
export function strategyPnl(legs: readonly Leg[], S: number, evalTs: number, ctx: ValuationContext): number {
  let pnl = 0;
  for (const leg of legs) pnl += legPnl(leg, S, evalTs, ctx) ?? 0;
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
  /** Legs left out of `target` (theoretical value on the target date needs an IV they lack). */
  targetMissing: LegGap[];
  /** Legs left out of `expiry` (only legs of a later expiry than the nearest can lack an IV here). */
  expiryMissing: LegGap[];
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
    targetMissing: strategyGaps(legs, opts.targetTs, ctx),
    expiryMissing: strategyGaps(legs, atExpiry, ctx),
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
  /** Option legs left out of the sums (no IV / carry to value them with); their Greeks are unknown, not zero. */
  missing: LegGap[];
}

export function strategyGreeks(legs: readonly Leg[], S: number, nowTs: number, ctx: ValuationContext): StrategyGreeks {
  const g: StrategyGreeks = { delta: 0, gamma: 0, theta: 0, vega: 0, missing: [] };
  legs.forEach((leg, index) => {
    if (!isActive(leg) || leg.exitPrice != null) return;
    const qty = legQty(leg) * sideSign(leg.side);
    if (leg.type === 'FUT') {
      g.delta += qty;
      return;
    }
    const T = yearsBetween(nowTs, expiryTs(leg.expiry));
    const reason = legGapReason(leg, nowTs, ctx, true);
    if (reason) {
      g.missing.push({ index, id: leg.id, label: legLabel(leg), reason });
      return;
    }
    // Before expiry the gap check above guarantees an IV and a carry; at/after expiry (sigma 0) the Greeks are the intrinsic ones.
    const sigma = T > 0 ? (legIv(leg, ctx) as number) : 0;
    const gr = bsGreeks(leg.type, S, leg.strike, T, ctx.r, sigma, carryOf(leg.expiry, ctx) ?? 0);
    g.delta += qty * gr.delta;
    g.gamma += qty * gr.gamma;
    g.theta += qty * gr.theta;
    g.vega += qty * gr.vega;
  });
  return g;
}

export interface StrategyAnalysis {
  maxProfit: number | null; // null => unlimited
  maxLoss: number | null; // null => unlimited (reported as positive number otherwise negative pnl)
  breakevens: number[];
  /** Positive = net credit received, negative = net debit paid. */
  netPremium: number;
  /** Null when no volatility was given to spread the underlying's distribution (`opts.sigma`, or an IV on a leg). */
  pop: number | null;
  expectedPnl: number | null;
  riskReward: number | null;
  greeks: StrategyGreeks;
  /** Theoretical P&L now of the legs that can be valued (`missingNow` are left out) plus closed legs. */
  currentPnl: number;
  realizedPnl: number;
  /** Legs left out of `currentPnl` and `greeks` (no IV / carry to value them with before expiry). */
  missingNow: LegGap[];
  /** Legs left out of the at-expiry figures (maxProfit, maxLoss, breakevens, pop, expectedPnl): later-expiry legs without an IV. */
  missingAtExpiry: LegGap[];
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
  // A closed leg's P&L is its realised one and needs no valuation (legPnl is never null for it).
  const realizedPnl = active.filter((l) => l.exitPrice != null).reduce((a, l) => a + (legPnl(l, S, nowTs, ctx) ?? 0), 0);
  const netPremium = active
    .filter((l) => l.type !== 'FUT' && l.exitPrice == null)
    .reduce((a, l) => a - sideSign(l.side) * l.price * legQty(l), 0);
  // Gaps are taken over the caller's `legs` so that `LegGap.index` points into it (inactive legs are skipped by both).
  const greeks = strategyGreeks(legs, S, nowTs, ctx);
  const currentPnl = strategyPnl(active, S, nowTs, ctx);
  const missingNow = strategyGaps(legs, nowTs, ctx);
  const expTs = nearestExpiryTs(active);
  if (!active.length || !Number.isFinite(expTs)) {
    return { maxProfit: realizedPnl, maxLoss: realizedPnl, breakevens: [], netPremium, pop: realizedPnl > 0 ? 1 : 0, expectedPnl: realizedPnl, riskReward: null, greeks, currentPnl, realizedPnl, missingNow, missingAtExpiry: [] };
  }
  const missingAtExpiry = strategyGaps(legs, expTs, ctx);

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
  // The distribution of the underlying at expiry needs a volatility: the caller's, else a leg's own IV — never an assumed one.
  const sigma = opts.sigma ?? active.find((l) => l.iv !== undefined && l.iv > 0)?.iv;
  let pop: number | null = null;
  let expectedPnl: number | null = null;
  if (sigma !== undefined || yearsBetween(nowTs, expTs) <= 0) {
    const r = probabilityOfProfit(active, S, sigma ?? 0, nowTs, ctx);
    pop = r.pop;
    expectedPnl = r.expected;
  }
  const riskReward = maxProfit !== null && maxLoss !== null && maxLoss < 0 ? maxProfit / Math.abs(maxLoss) : null;
  return { maxProfit, maxLoss, breakevens, netPremium, pop, expectedPnl, riskReward, greeks, currentPnl, realizedPnl, missingNow, missingAtExpiry };
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
