import { describe, expect, it } from 'vitest';
import {
  analyzeStrategy,
  bsGreeks,
  bsPrice,
  buildFromTemplate,
  classifyBuildUp,
  describeStrategy,
  estimateMargin,
  expiryTs,
  findBreakevens,
  formatCompact,
  formatIndian,
  historicalVol,
  impliedVol,
  INDEX_MARGIN,
  invNormCdf,
  istParts,
  istTs,
  ivPercentile,
  ivRank,
  maxPain,
  modifiedPcr,
  normCdf,
  optimizeStrategies,
  pcr,
  prevTradingDay,
  STRATEGY_TEMPLATES,
  strategyPnl,
  tradingDaysBetween,
  volatilityCone,
  weekday,
  type Leg,
} from '../src';

describe('normal distribution', () => {
  it('matches reference values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 12);
    expect(normCdf(1.96)).toBeCloseTo(0.9750021048517795, 10);
    expect(normCdf(-1)).toBeCloseTo(0.15865525393145707, 10);
    expect(invNormCdf(0.975)).toBeCloseTo(1.959963984540054, 8);
    expect(invNormCdf(0.01)).toBeCloseTo(-2.3263478740408408, 8);
  });
});

describe('Black-Scholes', () => {
  it('reproduces the textbook example (Hull 15.6)', () => {
    expect(bsPrice('CE', 42, 40, 0.5, 0.1, 0.2)).toBeCloseTo(4.7594, 3);
    expect(bsPrice('PE', 42, 40, 0.5, 0.1, 0.2)).toBeCloseTo(0.8086, 3);
  });

  it('satisfies put-call parity with carry', () => {
    const S = 25000, K = 25200, T = 12 / 365, r = 0.065, q = 0.012, v = 0.13;
    const c = bsPrice('CE', S, K, T, r, v, q);
    const p = bsPrice('PE', S, K, T, r, v, q);
    expect(c - p).toBeCloseTo(S * Math.exp(-q * T) - K * Math.exp(-r * T), 6);
  });

  it('greeks agree with finite differences', () => {
    const S = 1000, K = 1020, T = 30 / 365, r = 0.065, v = 0.25;
    const g = bsGreeks('CE', S, K, T, r, v);
    const h = 0.01;
    const fd = (bsPrice('CE', S + h, K, T, r, v) - bsPrice('CE', S - h, K, T, r, v)) / (2 * h);
    expect(g.delta).toBeCloseTo(fd, 5);
    const fdGamma = (bsPrice('CE', S + 1, K, T, r, v) - 2 * bsPrice('CE', S, K, T, r, v) + bsPrice('CE', S - 1, K, T, r, v)) / 1;
    expect(g.gamma).toBeCloseTo(fdGamma, 4);
    const fdVega = (bsPrice('CE', S, K, T, r, v + 0.0001) - bsPrice('CE', S, K, T, r, v - 0.0001)) / 0.0002 / 100;
    expect(g.vega).toBeCloseTo(fdVega, 5);
    const fdTheta = bsPrice('CE', S, K, T - 1 / 365, r, v) - bsPrice('CE', S, K, T, r, v);
    expect(g.theta).toBeCloseTo(fdTheta, 1);
    expect(g.theta).toBeLessThan(0);
  });

  it('inverts implied volatility', () => {
    for (const type of ['CE', 'PE'] as const) {
      for (const K of [22000, 24500, 25000, 25500, 28000]) {
        const price = bsPrice(type, 25000, K, 20 / 365, 0.065, 0.14);
        if (price < 0.01) continue;
        expect(impliedVol(type, price, 25000, K, 20 / 365, 0.065)).toBeCloseTo(0.14, 5);
      }
    }
    expect(Number.isNaN(impliedVol('CE', 0.0, 100, 100, 0.1, 0.05))).toBe(true);
    expect(Number.isNaN(impliedVol('CE', 200, 100, 100, 0.1, 0.05))).toBe(true);
  });

  it('returns intrinsic value at expiry', () => {
    expect(bsPrice('CE', 105, 100, 0, 0.05, 0.2)).toBe(5);
    expect(bsPrice('PE', 105, 100, 0, 0.05, 0.2)).toBe(0);
  });
});

describe('calendar & expiries', () => {
  it('knows the weekday', () => {
    expect(weekday('2026-10-11')).toBe(0); // Sunday
    expect(weekday('2026-10-13')).toBe(2); // Tuesday
  });

  it('round-trips IST timestamps', () => {
    const ts = istTs('2026-10-12', 9 * 60 + 15);
    expect(istParts(ts)).toEqual({ date: '2026-10-12', minuteOfDay: 555, second: 0 });
    expect(new Date(expiryTs('2026-10-13')).toISOString()).toBe('2026-10-13T10:00:00.000Z');
  });

  it('counts trading days', () => {
    expect(prevTradingDay('2026-10-12')).toBe('2026-10-09');
    expect(tradingDaysBetween('2026-10-09', '2026-10-16')).toBe(5);
  });
});

describe('OI analytics', () => {
  const rows = [
    { strike: 100, ceOI: 100, peOI: 900 },
    { strike: 110, ceOI: 300, peOI: 700 },
    { strike: 120, ceOI: 800, peOI: 200 },
    { strike: 130, ceOI: 1000, peOI: 50 },
  ];
  it('computes max pain', () => {
    const r = maxPain(rows);
    // pain at 110 = calls: 100*10 = 1000 ; puts: 200*10 + 50*20 = 3000 → 4000 (minimum)
    expect(r.maxPain).toBe(110);
    expect(r.pain.find((p) => p.strike === 110)!.total).toBe(4000);
  });
  it('computes PCR and modified PCR', () => {
    expect(pcr(rows).oi).toBeCloseTo(1850 / 2200, 10);
    expect(modifiedPcr(rows, 118, 0)).toBeCloseTo(200 / 800, 10);
  });
  it('classifies build-up quadrants', () => {
    expect(classifyBuildUp(1, 5)).toBe('Long Build-up');
    expect(classifyBuildUp(-1, 5)).toBe('Short Build-up');
    expect(classifyBuildUp(1, -5)).toBe('Short Covering');
    expect(classifyBuildUp(-1, -5)).toBe('Long Unwinding');
  });
});

describe('strategy analytics', () => {
  const expiry = '2026-10-27';
  const now = istTs('2026-10-12', 600);
  const ctx = { r: 0.065 };
  const leg = (side: 'BUY' | 'SELL', type: 'CE' | 'PE', strike: number, price: number): Leg => ({ side, type, strike, expiry, lots: 1, lotSize: 65, price, iv: 0.13 });

  it('bull call spread has defined risk/reward and one breakeven', () => {
    const legs = [leg('BUY', 'CE', 25000, 300), leg('SELL', 'CE', 25200, 200)];
    const a = analyzeStrategy(legs, 25000, now, ctx);
    expect(a.maxProfit).toBeCloseTo((200 - 100) * 65, 6);
    expect(a.maxLoss).toBeCloseTo(-100 * 65, 6);
    expect(a.breakevens).toHaveLength(1);
    expect(a.breakevens[0]).toBeCloseTo(25100, 1);
    expect(a.netPremium).toBeCloseTo(-100 * 65, 6);
    expect(a.pop).toBeGreaterThan(0.2);
    expect(a.pop).toBeLessThan(0.8);
  });

  it('short straddle has unlimited loss and two breakevens', () => {
    const legs = [leg('SELL', 'CE', 25000, 250), leg('SELL', 'PE', 25000, 240)];
    const a = analyzeStrategy(legs, 25000, now, ctx);
    expect(a.maxLoss).toBeNull();
    expect(a.maxProfit).toBeCloseTo(490 * 65, 6);
    expect(a.breakevens.map((b) => Math.round(b))).toEqual([24510, 25490]);
    expect(a.greeks.theta).toBeGreaterThan(0);
    expect(a.greeks.vega).toBeLessThan(0);
  });

  it('long call shows unlimited profit', () => {
    const a = analyzeStrategy([leg('BUY', 'CE', 25000, 250)], 25000, now, ctx);
    expect(a.maxProfit).toBeNull();
    expect(a.maxLoss).toBeCloseTo(-250 * 65, 6);
  });

  it('closed legs contribute realized P&L only', () => {
    const l = { ...leg('BUY', 'CE', 25000, 100), exitPrice: 150 };
    expect(strategyPnl([l], 1, now, ctx)).toBe(50 * 65);
  });

  it('finds roots of payoff functions', () => {
    expect(findBreakevens((x) => (x - 3) * (x - 7), 0, 10)).toEqual([expect.closeTo(3, 6), expect.closeTo(7, 6)]);
  });
});

describe('margin', () => {
  it('gives hedge benefit to spreads', () => {
    const expiry = '2026-10-27';
    const now = istTs('2026-10-12', 600);
    const legs: Leg[] = [
      { side: 'SELL', type: 'PE', strike: 25000, expiry, lots: 1, lotSize: 65, price: 220, iv: 0.13 },
      { side: 'BUY', type: 'PE', strike: 24800, expiry, lots: 1, lotSize: 65, price: 150, iv: 0.135 },
    ];
    const hedged = estimateMargin(legs, 25000, now, { r: 0.065, defaultIv: 0.13 }, INDEX_MARGIN);
    const naked = estimateMargin([legs[0]], 25000, now, { r: 0.065, defaultIv: 0.13 }, INDEX_MARGIN);
    expect(hedged.total).toBeLessThan(naked.total);
    expect(naked.total).toBeGreaterThan(25000 * 65 * 0.05);
    expect(hedged.hedgeBenefit).toBeGreaterThan(0);
  });
});

describe('templates & naming', () => {
  const strikes = Array.from({ length: 81 }, (_, i) => 23000 + i * 50);
  const ctx = {
    spot: 25010,
    strikes: () => strikes,
    expiries: ['2026-10-13', '2026-10-20'],
    lotSize: 65,
    quote: () => ({ price: 100, iv: 0.13 }),
  };
  it('names every template it builds', () => {
    const named = ['Bull Call Spread', 'Bear Put Spread', 'Iron Condor', 'Iron Butterfly', 'Short Straddle', 'Long Strangle', 'Long Call Butterfly', 'Call Ratio Back Spread', 'Put Calendar', 'Jade Lizard', 'Batman'];
    for (const t of STRATEGY_TEMPLATES) {
      const legs = buildFromTemplate(t, ctx);
      expect(legs.length).toBe(t.legs.length);
      if (named.includes(t.name)) expect(describeStrategy(legs)).toBe(t.name);
    }
  });
  it('snaps strikes to ATM', () => {
    const legs = buildFromTemplate(STRATEGY_TEMPLATES.find((t) => t.id === 'short-straddle')!, ctx);
    expect(legs.every((l) => l.strike === 25000)).toBe(true);
  });
});

describe('volatility', () => {
  it('computes HV, IV rank and percentile', () => {
    // Test closes: log returns alternating ±1 % (daily σ = 1 % → annualised ≈ 15.9 %).
    const closes = [100];
    for (let i = 0; i < 400; i++) closes.push(closes[i] * Math.exp(i % 2 ? -0.01 : 0.01));
    const hv = historicalVol(closes, 252);
    expect(hv).toBeGreaterThan(0.12);
    expect(hv).toBeLessThan(0.2);
    expect(ivRank(15, [10, 20])).toBe(50);
    expect(ivPercentile(15, [10, 12, 14, 16, 18])).toBe(60);
    const cone = volatilityCone(closes);
    expect(cone[0].min).toBeLessThanOrEqual(cone[0].median);
    expect(cone[0].median).toBeLessThanOrEqual(cone[0].max);
  });

  it('IV rank / percentile are null (not 50) for a flat or too-short history', () => {
    // Flat: no range to rank in (was 50 for rank, 0 for percentile).
    expect(ivRank(14, [14, 14, 14])).toBeNull();
    expect(ivPercentile(14, [14, 14, 14])).toBeNull();
    expect(ivRank(15, [14, 14, 14])).toBeNull();
    expect(ivPercentile(15, [14, 14, 14])).toBeNull();
    // Too short (one observation, or none finite) and a non-finite current IV.
    expect(ivRank(15, [10])).toBeNull();
    expect(ivPercentile(15, [10])).toBeNull();
    expect(ivRank(15, [Number.NaN, Number.NaN])).toBeNull();
    expect(ivRank(Number.NaN, [10, 20])).toBeNull();
    expect(ivPercentile(Number.NaN, [10, 20])).toBeNull();
    // A real range still ranks, including a current IV outside it.
    expect(ivRank(25, [10, 20])).toBe(100);
    expect(ivPercentile(25, [10, 20])).toBe(100);
  });
});

describe('optimizer', () => {
  it('finds bullish strategies for a bullish target', () => {
    const spot = 25000;
    const expiry = '2026-10-27';
    const now = istTs('2026-10-12', 600);
    const T = (expiryTs(expiry) - now) / (365 * 86400000);
    const rows = Array.from({ length: 31 }, (_, i) => {
      const strike = 24250 + i * 50;
      return {
        strike,
        ce: { price: bsPrice('CE', spot, strike, T, 0.065, 0.13), iv: 0.13 },
        pe: { price: bsPrice('PE', spot, strike, T, 0.065, 0.13), iv: 0.13 },
      };
    });
    const out = optimizeStrategies({
      spot, nowTs: now, expiry, lotSize: 65, rows, targetPrice: 25400, targetTs: istTs('2026-10-20', 900), stopLoss: 24800,
      atmIv: 0.13, ctx: { r: 0.065 }, marginParams: INDEX_MARGIN, maxLegs: 3, budget: 60_000,
    });
    expect(out.scanned).toBeGreaterThan(1000);
    expect(out.results.length).toBeGreaterThan(5);
    for (const r of out.results) {
      expect(r.targetPnl).toBeGreaterThan(0);
      expect(r.maxLoss).not.toBeNull();
    }
    expect(out.results[0].rewardRisk).toBeGreaterThanOrEqual(out.results[out.results.length - 1].rewardRisk);
  });
});

describe('formatting', () => {
  it('uses Indian digit grouping', () => {
    expect(formatIndian(12345678.9)).toBe('1,23,45,678.90');
    expect(formatIndian(-999, 0)).toBe('-999');
    expect(formatCompact(12_500_000)).toBe('1.25Cr');
    expect(formatCompact(250_000)).toBe('2.50L');
  });
});
