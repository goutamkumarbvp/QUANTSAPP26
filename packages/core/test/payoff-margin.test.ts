import { describe, expect, it } from 'vitest';
import {
  analyzeStrategy,
  bsGreeks,
  bsPrice,
  estimateMargin,
  expiryTs,
  INDEX_MARGIN,
  istTs,
  legLabel,
  legPnl,
  legTheoPrice,
  payoffCurve,
  scenarioGrid,
  strategyGaps,
  strategyGreeks,
  strategyPnl,
  strategyPnlAt,
  yearsBetween,
  type Leg,
  type ValuationContext,
} from '../src';

/**
 * No fixed or default IV anywhere: a leg without an IV is left out of the theoretical (before-expiry)
 * figures and named, never valued at an assumed volatility. Payoffs at expiry need no IV.
 */
const expiry = '2026-10-27';
const now = istTs('2026-10-12', 600);
const ctx: ValuationContext = { r: 0.065 };
const leg = (side: 'BUY' | 'SELL', type: 'CE' | 'PE', strike: number, price: number, iv?: number): Leg => ({ side, type, strike, expiry, lots: 1, lotSize: 65, price, iv });

describe('legTheoPrice / strategyPnl without an IV', () => {
  it('is null before expiry (no 15 % stand-in), intrinsic at expiry', () => {
    const noIv = leg('BUY', 'CE', 25000, 250);
    expect(legTheoPrice(noIv, 25000, now, ctx)).toBeNull();
    expect(legPnl(noIv, 25000, now, ctx)).toBeNull();
    // The value a 15 % fallback would have produced must not appear anywhere.
    const T = yearsBetween(now, expiryTs(expiry));
    expect(legTheoPrice({ ...noIv, iv: 0.15 }, 25000, now, ctx)).toBeCloseTo(bsPrice('CE', 25000, 25000, T, 0.065, 0.15, 0), 10);
    expect(legTheoPrice(noIv, 25200, expiryTs(expiry), ctx)).toBe(200);
    expect(legTheoPrice(leg('BUY', 'PE', 25000, 100), 24900, expiryTs(expiry) + 1, ctx)).toBe(100);
  });

  it('treats a non-positive or non-finite IV as missing', () => {
    for (const iv of [0, -0.1, Number.NaN]) expect(legTheoPrice(leg('BUY', 'CE', 25000, 250, iv), 25000, now, ctx)).toBeNull();
  });

  it('prices a future without any IV', () => {
    const fut: Leg = { side: 'BUY', type: 'FUT', strike: 0, expiry, lots: 1, lotSize: 65, price: 25010 };
    const T = yearsBetween(now, expiryTs(expiry));
    expect(legTheoPrice(fut, 25000, now, { r: 0.065, carry: () => 0.01 })).toBeCloseTo(25000 * Math.exp((0.065 - 0.01) * T), 8);
    expect(strategyGaps([fut], now, ctx)).toEqual([]);
  });

  it('leaves the leg out of the sum and names it', () => {
    const a = leg('BUY', 'CE', 25000, 300, 0.13);
    const b = leg('SELL', 'CE', 25200, 200); // no IV
    expect(strategyPnl([a, b], 25000, now, ctx)).toBeCloseTo(strategyPnl([a], 25000, now, ctx), 10);
    const gaps = strategyGaps([a, b], now, ctx);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ index: 1, label: 'Sell 25200 CE 27-Oct-26' });
    expect(gaps[0].reason).toMatch(/implied volatility/);
    // At expiry nothing is missing and both legs count.
    expect(strategyGaps([a, b], expiryTs(expiry), ctx)).toEqual([]);
    // 25300 at expiry: the bought 25000 call is worth 300 (paid 300), the sold 25200 call 100 (received 200).
    expect(strategyPnl([a, b], 25300, expiryTs(expiry), ctx)).toBeCloseTo((0 + 100) * 65, 6);
  });

  it('does not need an IV for a closed or inactive leg', () => {
    const closed = { ...leg('BUY', 'CE', 25000, 100), exitPrice: 150 };
    const off = { ...leg('BUY', 'CE', 25000, 100), active: false };
    expect(strategyGaps([closed, off], now, ctx)).toEqual([]);
    expect(strategyPnl([closed], 1, now, ctx)).toBe(50 * 65);
  });

  it('a carry the context cannot give is also a gap (never q = 0)', () => {
    const a = leg('BUY', 'CE', 25000, 300, 0.13);
    const unknown: ValuationContext = { r: 0.065, carry: () => null };
    expect(legTheoPrice(a, 25000, now, unknown)).toBeNull();
    expect(strategyGaps([a], now, unknown)[0].reason).toMatch(/forward \(carry\)/);
    expect(legTheoPrice(a, 25000, now, { r: 0.065 })).not.toBeNull(); // a context that models no carry means q = 0
    expect(legTheoPrice(a, 25100, expiryTs(expiry), unknown)).toBe(100); // intrinsic needs neither
  });

  it('a future at its expiry settles at the underlying and needs no carry', () => {
    const fut: Leg = { side: 'BUY', type: 'FUT', strike: 0, expiry, lots: 1, lotSize: 65, price: 25000 };
    const unknown: ValuationContext = { r: 0.065, carry: () => null };
    expect(legTheoPrice(fut, 25123, expiryTs(expiry), unknown)).toBe(25123);
    expect(legTheoPrice(fut, 25123, now, unknown)).toBeNull(); // before expiry the forward is needed
    expect(strategyGaps([fut], expiryTs(expiry), unknown)).toEqual([]);
    expect(strategyGaps([fut], now, unknown)).toHaveLength(1);
  });

  it('labels legs', () => {
    expect(legLabel(leg('BUY', 'PE', 24800, 1))).toBe('Buy 24800 PE 27-Oct-26');
    expect(legLabel({ ...leg('SELL', 'CE', 0, 1), type: 'FUT' })).toBe('Sell FUT 27-Oct-26');
  });
});

describe('payoff curve and scenarios', () => {
  const spread = [leg('BUY', 'CE', 25000, 300, 0.13), leg('SELL', 'CE', 25200, 200)];

  it('the expiry payoff of a single-expiry strategy is complete without an IV', () => {
    const curve = payoffCurve(spread, ctx, { lo: 24500, hi: 25700, points: 61, targetTs: now });
    expect(curve.expiryMissing).toEqual([]);
    const i = curve.prices.indexOf(25300);
    expect(i).toBeGreaterThan(-1);
    // 25300 at expiry: the bought 25000 call is worth 300 (paid 300), the sold 25200 call 100 (received 200).
    expect(curve.expiry[i]).toBeCloseTo(((300 - 300) + (200 - 100)) * 65, 6);
    expect(curve.expiry.every(Number.isFinite)).toBe(true);
  });

  it('the theoretical (T+0) curve excludes the leg without an IV and reports it', () => {
    const curve = payoffCurve(spread, ctx, { lo: 24500, hi: 25700, points: 61, targetTs: now });
    expect(curve.targetMissing.map((g) => g.index)).toEqual([1]);
    const only = payoffCurve([spread[0]], ctx, { lo: 24500, hi: 25700, points: 61, targetTs: now });
    expect(curve.target).toEqual(only.target);
    // Pricing the unknown leg with an assumed IV would give a different curve.
    const assumed = payoffCurve([spread[0], { ...spread[1], iv: 0.15 }], ctx, { lo: 24500, hi: 25700, points: 61, targetTs: now });
    expect(curve.target).not.toEqual(assumed.target);
  });

  it('scenarioGrid still returns values; strategyGaps names what each column leaves out', () => {
    const mid = (now + expiryTs(expiry)) / 2;
    const grid = scenarioGrid(spread, 25000, ctx, [-1, 0, 1], [now, mid, expiryTs(expiry)]);
    expect(grid).toHaveLength(3);
    expect(strategyGaps(spread, now, ctx)).toHaveLength(1);
    expect(strategyGaps(spread, mid, ctx)).toHaveLength(1);
    expect(strategyGaps(spread, expiryTs(expiry), ctx)).toHaveLength(0);
  });
});

describe('Greeks without an IV', () => {
  it('sums the legs that have one and reports the others', () => {
    const a = leg('BUY', 'CE', 25000, 300, 0.13);
    const b = leg('SELL', 'PE', 24800, 150); // no IV
    const g = strategyGreeks([a, b], 25000, now, ctx);
    const ga = strategyGreeks([a], 25000, now, ctx);
    expect(g.delta).toBeCloseTo(ga.delta, 12);
    expect(g.theta).toBeCloseTo(ga.theta, 12);
    expect(g.vega).toBeCloseTo(ga.vega, 12);
    expect(g.missing.map((m) => m.index)).toEqual([1]);
    expect(ga.missing).toEqual([]);
    // Same numbers as a direct Black-Scholes computation of the valued leg.
    const T = yearsBetween(now, expiryTs(expiry));
    expect(ga.delta).toBeCloseTo(65 * bsGreeks('CE', 25000, 25000, T, 0.065, 0.13, 0).delta, 10);
  });

  it('futures contribute their delta with no IV and no carry', () => {
    const fut: Leg = { side: 'SELL', type: 'FUT', strike: 0, expiry, lots: 2, lotSize: 65, price: 25000 };
    const g = strategyGreeks([fut], 25000, now, { r: 0.065, carry: () => null });
    expect(g.delta).toBe(-130);
    expect(g.missing).toEqual([]);
  });

  it('a leg at expiry has intrinsic Greeks and needs no IV', () => {
    const a = leg('BUY', 'CE', 25000, 300);
    const g = strategyGreeks([a], 25100, expiryTs(expiry), ctx);
    expect(g.delta).toBe(65);
    expect(g.gamma).toBe(0);
    expect(g.missing).toEqual([]);
  });

  it('indexes gaps into the array that was passed (inactive legs included)', () => {
    const off = { ...leg('BUY', 'CE', 24000, 1, 0.13), active: false };
    const a = leg('BUY', 'CE', 25000, 300, 0.13);
    const b = leg('SELL', 'CE', 25200, 200);
    expect(strategyGreeks([off, a, b], 25000, now, ctx).missing.map((m) => m.index)).toEqual([2]);
    expect(analyzeStrategy([off, a, b], 25000, now, ctx, { sigma: 0.13 }).missingNow.map((m) => m.index)).toEqual([2]);
  });
});

describe('analyzeStrategy without an IV', () => {
  const spread = [leg('BUY', 'CE', 25000, 300, 0.13), leg('SELL', 'CE', 25200, 200)];

  it('payoff statistics at expiry do not depend on IV', () => {
    const a = analyzeStrategy(spread, 25000, now, ctx, { sigma: 0.13 });
    expect(a.maxProfit).toBeCloseTo(100 * 65, 6);
    expect(a.maxLoss).toBeCloseTo(-100 * 65, 6);
    expect(a.breakevens[0]).toBeCloseTo(25100, 1);
    expect(a.missingAtExpiry).toEqual([]);
    expect(a.missingNow.map((m) => m.index)).toEqual([1]);
    expect(a.greeks.missing.map((m) => m.index)).toEqual([1]);
    expect(a.pop).not.toBeNull();
  });

  it('has no probability of profit when no volatility is known (no 15 % default)', () => {
    const bare = [leg('BUY', 'CE', 25000, 300), leg('SELL', 'CE', 25200, 200)];
    const a = analyzeStrategy(bare, 25000, now, ctx);
    expect(a.pop).toBeNull();
    expect(a.expectedPnl).toBeNull();
    expect(a.maxProfit).toBeCloseTo(100 * 65, 6);
    expect(a.breakevens).toHaveLength(1);
    expect(a.riskReward).toBeCloseTo(1, 6);
    expect(a.missingNow).toHaveLength(2);
  });

  it('a leg IV serves as the distribution width when the caller gives none', () => {
    const a = analyzeStrategy(spread, 25000, now, ctx);
    const b = analyzeStrategy(spread, 25000, now, ctx, { sigma: 0.13 });
    expect(a.pop).toBeCloseTo(b.pop!, 12);
  });

  it('at expiry the outcome is certain and needs no volatility', () => {
    const a = analyzeStrategy([leg('BUY', 'CE', 25000, 300)], 25400, expiryTs(expiry), ctx);
    expect(a.pop).toBe(1);
    expect(a.expectedPnl).toBeCloseTo((400 - 300) * 65, 6);
  });

  it('later-expiry legs without an IV are named in missingAtExpiry', () => {
    const far = { ...leg('SELL', 'CE', 25000, 400), expiry: '2026-11-24' };
    const a = analyzeStrategy([leg('BUY', 'CE', 25000, 300, 0.13), far], 25000, now, ctx, { sigma: 0.13 });
    expect(a.missingAtExpiry.map((m) => m.index)).toEqual([1]);
  });
});

describe('estimateMargin without an IV', () => {
  const hedged: Leg[] = [
    { side: 'SELL', type: 'PE', strike: 25000, expiry, lots: 1, lotSize: 65, price: 220, iv: 0.13 },
    { side: 'BUY', type: 'PE', strike: 24800, expiry, lots: 1, lotSize: 65, price: 150, iv: 0.135 },
  ];

  it('is null with the reason (and the legs) when a leg has no IV', () => {
    const legs = [hedged[0], { ...hedged[1], iv: undefined }];
    const e = estimateMargin(legs, 25000, now, { r: 0.065, volScanIv: 0.13 }, INDEX_MARGIN);
    expect(e.margin).toBeNull();
    expect(e.reason).toMatch(/^Margin cannot be estimated: Buy 24800 PE 27-Oct-26 \(no implied volatility/);
    expect(e.missing.map((m) => m.index)).toEqual([1]);
  });

  it('a short leg without an IV blocks the estimate too', () => {
    const e = estimateMargin([{ ...hedged[0], iv: undefined }], 25000, now, { r: 0.065 }, INDEX_MARGIN);
    expect(e.margin).toBeNull();
    expect(e.reason).toBeTruthy();
  });

  it('is null when the expiry has no known carry', () => {
    const e = estimateMargin(hedged, 25000, now, { r: 0.065, carry: () => null }, INDEX_MARGIN);
    expect(e.margin).toBeNull();
    expect(e.reason).toMatch(/forward \(carry\)/);
  });

  it('is estimated when every leg has an IV, with the vol scan sized by the legs when no reference is given', () => {
    const a = estimateMargin(hedged, 25000, now, { r: 0.065 }, INDEX_MARGIN);
    expect(a.reason).toBeNull();
    expect(a.margin!.total).toBeGreaterThan(0);
    const mean = (0.13 + 0.135) / 2;
    const b = estimateMargin(hedged, 25000, now, { r: 0.065, volScanIv: mean }, INDEX_MARGIN);
    expect(a.margin).toEqual(b.margin);
    // A reference IV only sizes the scan; it can change the margin but never makes a missing-IV leg valuable.
    const c = estimateMargin([hedged[0], { ...hedged[1], iv: undefined }], 25000, now, { r: 0.065, volScanIv: 0.13 }, INDEX_MARGIN);
    expect(c.margin).toBeNull();
  });

  it('ignores legs that are closed or inactive, and expired legs need no IV', () => {
    const closed = { ...hedged[1], iv: undefined, exitPrice: 100 };
    const only = estimateMargin([hedged[0], closed], 25000, now, { r: 0.065 }, INDEX_MARGIN);
    expect(only.margin).not.toBeNull();
    const expired = estimateMargin([{ ...hedged[0], iv: undefined }], 25000, expiryTs(expiry) + 1, { r: 0.065 }, INDEX_MARGIN);
    expect(expired.margin).not.toBeNull();
  });

  it('futures only: no volatility to scan, margin still estimated', () => {
    const fut: Leg = { side: 'BUY', type: 'FUT', strike: 0, expiry, lots: 1, lotSize: 65, price: 25000 };
    const e = estimateMargin([fut], 25000, now, { r: 0.065 }, INDEX_MARGIN);
    expect(e.margin!.total).toBeGreaterThan(0);
    expect(Number.isFinite(e.margin!.total)).toBe(true);
  });
});

describe('strategyPnlAt', () => {
  it('gives the sum of the legs\' P&L (legPnl) at every price, for every kind of leg', () => {
    const later = '2026-11-24';
    const legs: Leg[] = [
      leg('BUY', 'CE', 25000, 120, 0.14),
      leg('SELL', 'PE', 24800, 90, 0.16),
      { ...leg('SELL', 'CE', 25500, 60, 0.15), expiry: later },
      { ...leg('BUY', 'PE', 24500, 40), expiry: later }, // no IV: left out before expiry
      { side: 'BUY', type: 'FUT', strike: 0, expiry: later, lots: 1, lotSize: 65, price: 25100 },
      { ...leg('SELL', 'CE', 25200, 80, 0.15), exitPrice: 50 },
      { ...leg('BUY', 'CE', 25300, 70, 0.15), active: false },
    ];
    const ctxs: ValuationContext[] = [ctx, { r: 0.065, carry: (e) => (e === later ? 0.012 : 0.01), ivShift: 0.02 }, { r: 0.065, carry: (e) => (e === later ? null : 0.01) }];
    for (const c of ctxs) {
      for (const ts of [now, expiryTs(expiry), expiryTs(later)]) {
        const f = strategyPnlAt(legs, ts, c);
        for (let S = 20000; S <= 30000; S += 137) {
          const sum = legs.reduce((a, l) => a + (legPnl(l, S, ts, c) ?? 0), 0);
          expect(f(S)).toBe(sum);
          expect(strategyPnl(legs, S, ts, c)).toBe(sum);
        }
      }
    }
  });
});
