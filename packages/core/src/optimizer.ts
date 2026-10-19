/**
 * Strategy optimizer: given a view (target price by a target date, stop-loss level),
 * exhaustively scans 1–4 leg option combinations on the live chain and ranks them by
 * reward-to-risk, expected profit or probability of profit.
 *
 * Each candidate leg's P&L is pre-computed on a price grid at the target date and at
 * expiry, so a combination is evaluated with vector additions only.
 */
import { estimateMargin, type MarginParams } from './margin';
import { legTheoPrice, probabilityOfProfit, type Leg, type ValuationContext } from './payoff';
import { expiryTs } from './dates';
import { describeStrategy } from './strategies';
import type { OptionType } from './bs';

export interface OptimizerQuote {
  price: number;
  iv: number;
}

export interface OptimizerRow {
  strike: number;
  ce?: OptimizerQuote | null;
  pe?: OptimizerQuote | null;
}

export type OptimizerSort = 'rr' | 'profit' | 'pop';

export interface OptimizerInput {
  spot: number;
  nowTs: number;
  expiry: string;
  lotSize: number;
  rows: OptimizerRow[];
  targetPrice: number;
  targetTs: number;
  stopLoss?: number;
  maxLegs?: 1 | 2 | 3 | 4;
  maxLotsPerLeg?: 1 | 2;
  allowUnlimitedRisk?: boolean;
  maxCapital?: number;
  atmIv: number;
  ctx: ValuationContext;
  marginParams: MarginParams;
  sortBy?: OptimizerSort;
  limit?: number;
  /** Upper bound of combinations evaluated per leg-count (search budget). */
  budget?: number;
  /** Ignore options whose premium is below this (illiquid far OTM). */
  minPremium?: number;
}

export interface OptimizerCandidate {
  name: string;
  legs: Leg[];
  targetPnl: number;
  stopPnl: number;
  maxProfit: number | null;
  maxLoss: number | null;
  rewardRisk: number;
  pop: number;
  margin: number;
  netPremium: number;
}

export interface OptimizerOutput {
  scanned: number;
  results: OptimizerCandidate[];
  strikesUsed: number[];
}

interface CandLeg {
  type: OptionType;
  side: 'BUY' | 'SELL';
  strike: number;
  price: number;
  iv: number;
  target: number; // pnl per lot at (targetPrice, targetTs)
  stopNow: number; // pnl per lot at (stopLoss, now)
  stopTarget: number; // pnl per lot at (stopLoss, targetTs)
  grid: Float64Array; // pnl per lot at expiry on grid
  callQty: number; // +1 long call, -1 short call (for unlimited-upside test)
}

function choose(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

export function optimizeStrategies(input: OptimizerInput): OptimizerOutput {
  const {
    spot, nowTs, expiry, lotSize, rows, targetPrice, targetTs, ctx, marginParams,
  } = input;
  const maxLegs = input.maxLegs ?? 4;
  const maxLots = input.maxLotsPerLeg ?? 2;
  const allowUnlimited = input.allowUnlimitedRisk ?? false;
  const sortBy = input.sortBy ?? 'rr';
  const limit = input.limit ?? 20;
  const budget = input.budget ?? 250_000;
  const minPremium = input.minPremium ?? 0.5;
  const stopLoss = input.stopLoss ?? (targetPrice >= spot ? spot - (targetPrice - spot) * 0.5 : spot + (spot - targetPrice) * 0.5);
  const expTs = expiryTs(expiry);
  const evalTarget = Math.min(targetTs, expTs);

  const sorted = [...rows].filter((r) => r.ce || r.pe).sort((a, b) => a.strike - b.strike);
  const lo = Math.min(spot, targetPrice, stopLoss);
  const hi = Math.max(spot, targetPrice, stopLoss);
  const step = sorted.length > 1 ? sorted[1].strike - sorted[0].strike : 1;
  const pad = Math.max(step * 3, (hi - lo) * 0.35);
  let window = sorted.filter((r) => r.strike >= lo - pad && r.strike <= hi + pad);
  if (window.length < 4) window = sorted;

  // Expiry P&L grid: dense around the view, plus anchors.
  const gLo = Math.max(0.01, lo - (hi - lo) - spot * 0.08);
  const gHi = hi + (hi - lo) + spot * 0.08;
  const G = 121;
  const grid = new Float64Array(G);
  for (let i = 0; i < G; i++) grid[i] = gLo + ((gHi - gLo) * i) / (G - 1);

  const makeLeg = (type: OptionType, side: 'BUY' | 'SELL', strike: number, q: OptimizerQuote): CandLeg => {
    const leg: Leg = { side, type, strike, expiry, lots: 1, lotSize, price: q.price, iv: q.iv };
    const sgn = side === 'BUY' ? 1 : -1;
    // Every candidate has a solved IV (buildCands skips quotes without one), so the theoretical price exists.
    const val = (S: number, ts: number) => sgn * lotSize * ((legTheoPrice(leg, S, ts, ctx) as number) - q.price);
    const g = new Float64Array(G);
    for (let i = 0; i < G; i++) g[i] = val(grid[i], expTs);
    return {
      type, side, strike, price: q.price, iv: q.iv,
      target: val(targetPrice, evalTarget),
      stopNow: val(stopLoss, nowTs),
      stopTarget: val(stopLoss, evalTarget),
      grid: g,
      callQty: type === 'CE' ? sgn : 0,
    };
  };

  const buildCands = (strikeRows: OptimizerRow[]): CandLeg[] => {
    const out: CandLeg[] = [];
    for (const r of strikeRows) {
      for (const type of ['CE', 'PE'] as const) {
        const q = type === 'CE' ? r.ce : r.pe;
        if (!q || !(q.price >= minPremium) || !(q.iv > 0)) continue;
        out.push(makeLeg(type, 'BUY', r.strike, q));
        out.push(makeLeg(type, 'SELL', r.strike, q));
      }
    }
    return out;
  };

  // Thin the strike window for higher leg counts to respect the search budget.
  const thinFor = (k: number): CandLeg[] => {
    let rowsK = window;
    let stride = 1;
    while (choose(rowsK.length * 4, k) * (k <= 2 ? maxLots * maxLots : 1) > budget && rowsK.length > 4) {
      stride++;
      const atmIdx = rowsK.reduce((bi, r, i) => (Math.abs(r.strike - spot) < Math.abs(rowsK[bi].strike - spot) ? i : bi), 0);
      rowsK = window.filter((_, i) => Math.abs(i - atmIdx) % stride === 0);
    }
    return buildCands(rowsK);
  };

  const strikesUsed = new Set<number>();
  type Scored = { legs: { c: CandLeg; lots: number }[]; target: number; stop: number; maxP: number; maxL: number; unlimitedUp: boolean; unlimitedLoss: boolean; rr: number };
  const pool: Scored[] = [];
  let scanned = 0;
  const acc = new Float64Array(G);

  const evaluate = (combo: { c: CandLeg; lots: number }[]) => {
    scanned++;
    let target = 0, stopA = 0, stopB = 0, callQty = 0;
    acc.fill(0);
    for (const { c, lots } of combo) {
      target += c.target * lots;
      stopA += c.stopNow * lots;
      stopB += c.stopTarget * lots;
      callQty += c.callQty * lots;
      const g = c.grid;
      for (let i = 0; i < G; i++) acc[i] += g[i] * lots;
    }
    if (!(target > 0)) return;
    const unlimitedLoss = callQty < 0;
    if (unlimitedLoss && !allowUnlimited) return;
    let maxP = -Infinity, maxL = Infinity;
    for (let i = 0; i < G; i++) {
      if (acc[i] > maxP) maxP = acc[i];
      if (acc[i] < maxL) maxL = acc[i];
    }
    // A combination that can never lose is a pricing artefact (stale/rounded quotes), not a trade.
    if (maxL >= 0 && !unlimitedLoss) return;
    const stop = Math.min(stopA, stopB);
    const risk = Math.max(-stop, -Math.min(maxL, 0) * 0.25, lotSize * spot * 0.0005);
    const rr = target / risk;
    pool.push({ legs: combo, target, stop, maxP, maxL, unlimitedUp: callQty > 0, unlimitedLoss, rr });
    if (pool.length > 6000) prune();
  };

  const key = (s: Scored) => (sortBy === 'profit' ? s.target : s.rr);
  const prune = () => {
    pool.sort((a, b) => key(b) - key(a));
    pool.length = 1500;
  };

  const conflict = (a: CandLeg, b: CandLeg) => a.type === b.type && a.strike === b.strike;

  // 1 leg
  const c1 = thinFor(1);
  for (const a of c1) for (let la = 1; la <= 1; la++) evaluate([{ c: a, lots: la }]);
  // 2 legs (with ratios)
  if (maxLegs >= 2) {
    const c = thinFor(2);
    for (let i = 0; i < c.length; i++)
      for (let j = i + 1; j < c.length; j++) {
        if (conflict(c[i], c[j])) continue;
        for (let la = 1; la <= maxLots; la++)
          for (let lb = 1; lb <= maxLots; lb++) {
            if (la === 2 && lb === 2) continue;
            evaluate([{ c: c[i], lots: la }, { c: c[j], lots: lb }]);
          }
      }
  }
  // 3 legs (1:1:1 and butterfly 1:2:1)
  if (maxLegs >= 3) {
    const c = thinFor(3);
    for (let i = 0; i < c.length; i++)
      for (let j = i + 1; j < c.length; j++) {
        if (conflict(c[i], c[j])) continue;
        for (let k = j + 1; k < c.length; k++) {
          if (conflict(c[i], c[k]) || conflict(c[j], c[k])) continue;
          evaluate([{ c: c[i], lots: 1 }, { c: c[j], lots: 1 }, { c: c[k], lots: 1 }]);
          if (maxLots >= 2) evaluate([{ c: c[i], lots: 1 }, { c: c[j], lots: 2 }, { c: c[k], lots: 1 }]);
        }
      }
  }
  // 4 legs (1:1:1:1)
  if (maxLegs >= 4) {
    const c = thinFor(4);
    for (let i = 0; i < c.length; i++)
      for (let j = i + 1; j < c.length; j++) {
        if (conflict(c[i], c[j])) continue;
        for (let k = j + 1; k < c.length; k++) {
          if (conflict(c[i], c[k]) || conflict(c[j], c[k])) continue;
          for (let m = k + 1; m < c.length; m++) {
            if (conflict(c[i], c[m]) || conflict(c[j], c[m]) || conflict(c[k], c[m])) continue;
            evaluate([{ c: c[i], lots: 1 }, { c: c[j], lots: 1 }, { c: c[k], lots: 1 }, { c: c[m], lots: 1 }]);
          }
        }
      }
  }

  prune();
  // Final, more expensive scoring on the short-list: margin, POP, de-duplication.
  const seen = new Set<string>();
  const perName = new Map<string, number>();
  const results: OptimizerCandidate[] = [];
  for (const s of pool) {
    if (results.length >= limit * 3) break;
    const legs: Leg[] = s.legs.map(({ c, lots }, i) => ({
      id: `opt-${i}`, side: c.side, type: c.type, strike: c.strike, expiry, lots, lotSize, price: c.price, iv: c.iv,
    }));
    const sig = legs.map((l) => `${l.side}${l.type}${l.strike}x${l.lots}`).sort().join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    const est = estimateMargin(legs, spot, nowTs, { ...ctx, volScanIv: input.atmIv }, marginParams);
    // A combination whose margin cannot be estimated (no carry for the expiry) is not offered.
    if (!est.margin) continue;
    const m = est.margin;
    const capital = m.total + Math.max(0, m.premiumPaid - m.premiumReceived);
    if (input.maxCapital && capital > input.maxCapital) continue;
    // Keep the short-list varied: at most 3 variants of the same structure.
    const name = describeStrategy(legs);
    if ((perName.get(name) ?? 0) >= 3) continue;
    perName.set(name, (perName.get(name) ?? 0) + 1);
    const { pop } = probabilityOfProfit(legs, spot, input.atmIv, nowTs, ctx);
    for (const l of legs) strikesUsed.add(l.strike);
    results.push({
      name,
      legs,
      targetPnl: s.target,
      stopPnl: s.stop,
      maxProfit: s.unlimitedUp ? null : s.maxP,
      maxLoss: s.unlimitedLoss ? null : s.maxL,
      rewardRisk: s.rr,
      pop,
      margin: capital,
      netPremium: legs.reduce((a, l) => a + (l.side === 'SELL' ? 1 : -1) * l.price * l.lots * l.lotSize, 0),
    });
  }
  const finalKey = (r: OptimizerCandidate) => (sortBy === 'pop' ? r.pop : sortBy === 'profit' ? r.targetPnl : r.rewardRisk);
  results.sort((a, b) => finalKey(b) - finalKey(a));
  return { scanned, results: results.slice(0, limit), strikesUsed: [...strikesUsed].sort((a, b) => a - b) };
}
