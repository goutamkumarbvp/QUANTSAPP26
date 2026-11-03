import { describe, expect, it } from 'vitest';
import { ALGO_PRESETS, maxPainStrike, oiTop, rankByOi, rollingStraddle, straddleAtmStrike, weekdayOf, type AlgoOrder, type AlgoSnapshot, type OiTopParams, type RollingStraddleParams } from '../src';

/** Toy market: strikes every 50 from 23000 to 27000; premium = intrinsic + 150·e^(−|K−S|/120); OI given per test. */
function market(spot: number, minuteOfDay: number, opts: { date?: string; oi?: (t: 'CE' | 'PE', k: number) => number | null; bump?: number } = {}): AlgoSnapshot {
  const strikes: number[] = [];
  for (let k = 23000; k <= 27000; k += 50) strikes.push(k);
  return {
    ts: minuteOfDay * 60_000,
    minuteOfDay,
    date: opts.date ?? '2026-11-04', // a Wednesday
    symbol: 'NIFTY',
    spot,
    expiry: '2026-11-10',
    lotSize: 65,
    strikes,
    premium: (type, k) => {
      const intrinsic = type === 'CE' ? Math.max(0, spot - k) : Math.max(0, k - spot);
      return Math.round((intrinsic + 150 * Math.exp(-Math.abs(k - spot) / 120) + (opts.bump ?? 0)) * 20) / 20;
    },
    ...(opts.oi ? { oi: opts.oi } : {}),
  };
}

function runner<P, S>(algo: { init(p: P): S; step(p: P, s: S, snap: AlgoSnapshot, fill: (o: AlgoOrder) => number): unknown[] }, p: P) {
  const s = algo.init(p);
  const orders: (AlgoOrder & { price: number })[] = [];
  const at = (snap: AlgoSnapshot) =>
    algo.step(p, s, snap, (o) => {
      const price = snap.premium(o.type, o.strike)!;
      orders.push({ ...o, price });
      return price;
    }) as { kind: string; message: string }[];
  return { s, orders, at };
}

const preset = <P>(id: string) => ALGO_PRESETS.find((x) => x.id === id)!.params as unknown as P;
const S5 = preset<RollingStraddleParams>('s5-atm-straddle-20');
const S6 = preset<RollingStraddleParams>('s6-maxpain-straddle-25');
const S7 = preset<OiTopParams>('s7-sensex-top-oi');

describe('S5 · ATM rolling straddle', () => {
  it('ATM is the nearest multiple of 100 — never a 50-point strike', () => {
    const strikes = [24900, 24950, 25000, 25050, 25100];
    expect(straddleAtmStrike(strikes, 25040, 100)).toBe(25000);
    expect(straddleAtmStrike(strikes, 25060, 100)).toBe(25100);
    expect(straddleAtmStrike(strikes, 25050, 100)).toBe(25000); // exact tie: the lower strike
    expect(straddleAtmStrike(strikes, 25040, 50)).toBe(25050); // only when 50 is allowed
  });

  it('sells CE + PE of the ATM strike at 09:20; rolls both to the new ATM strike when CE + PE is up 20%; resets the reference', () => {
    const r = runner(rollingStraddle, { ...S5, stopLossPerLot: 0 });
    expect(r.at(market(25040, 559))).toEqual([]);
    const e = r.at(market(25040, 560));
    expect(e[0].kind).toBe('ENTRY');
    expect(r.orders.map((o) => [o.side, o.type, o.strike])).toEqual([['SELL', 'CE', 25000], ['SELL', 'PE', 25000]]);
    const ref = r.s.reference;
    expect(ref).toBeCloseTo(r.orders[0].price + r.orders[1].price, 6);
    r.orders.length = 0;
    // A small move: combined below +20%: nothing.
    expect(r.at(market(25060, 570))).toEqual([]);
    // A big move up: CE deep in the money, combined > ref × 1.2 → roll to the new ATM (25300).
    const roll = r.at(market(25320, 600));
    expect(roll[0].kind).toBe('ADJUSTMENT');
    expect(r.orders.map((o) => [o.side, o.type, o.strike])).toEqual([['BUY', 'CE', 25000], ['BUY', 'PE', 25000], ['SELL', 'CE', 25300], ['SELL', 'PE', 25300]]);
    expect(r.s.strike).toBe(25300);
    expect(r.s.reference).toBeCloseTo(r.orders[2].price + r.orders[3].price, 6);
    expect(r.s.rolls).toBe(1);
    // Exit 15:25.
    r.orders.length = 0;
    const x = r.at(market(25320, 925));
    expect(x[0].kind).toBe('EXIT');
    expect(r.orders.map((o) => o.side)).toEqual(['BUY', 'BUY']);
    // The exit message quotes the day's P&L after the square-off (the roll lost money: not ₹0).
    expect(r.s.realized).toBeLessThan(0);
    expect(x[0].message).toContain(`Day P&L ₹${(Math.round(r.s.realized * 100) / 100).toFixed(2).replace(/\.00$/, '')}`);
  });

  it('daily max loss ₹3,000 per lot (separate from the roll): everything squared off, no more trades', () => {
    const r = runner(rollingStraddle, S5);
    r.at(market(25000, 560));
    r.orders.length = 0;
    // Premiums of both legs jump ₹50 each (vol spike, same strike): +₹100 × 65 = ₹6,500 loss, roll not reached first? checked first anyway.
    const ev = r.at(market(25000, 600, { bump: 50 }));
    expect(ev[0].kind).toBe('STOP');
    expect(ev[0].message).toMatch(/Daily maximum loss hit/);
    expect(r.orders.map((o) => o.side)).toEqual(['BUY', 'BUY']);
    expect(r.s.phase).toBe('stopped');
    expect(r.at(market(25500, 610))).toEqual([]);
  });
});

describe('S6 · max-pain rolling straddle', () => {
  // OI peaks: calls heavy at 25200, puts heavy at 24800 → max pain between them.
  const oi = (t: 'CE' | 'PE', k: number) => (t === 'CE' ? (k >= 25000 ? 1_000_000 / (1 + Math.abs(k - 25200) / 50) : 1000) : k <= 25000 ? 1_000_000 / (1 + Math.abs(k - 24800) / 50) : 1000);

  it('max pain: the strike where writers pay the least; null without OI', () => {
    const snap = market(25100, 560, { oi });
    const m = maxPainStrike(snap, 0);
    expect(m.strike).not.toBeNull();
    // Brute force over every strike.
    let best = Infinity;
    let at = 0;
    for (const x of snap.strikes) {
      let pain = 0;
      for (const k of snap.strikes) {
        if (x > k) pain += (oi('CE', k) ?? 0) * (x - k);
        if (x < k) pain += (oi('PE', k) ?? 0) * (k - x);
      }
      if (pain < best) [best, at] = [pain, x];
    }
    expect(m.strike).toBe(at);
    expect(maxPainStrike(market(25100, 560), 0)).toMatchObject({ strike: null });
  });

  it('sells the max-pain straddle; waits (sells nothing) while OI is not live', () => {
    const r = runner(rollingStraddle, S6);
    expect(r.at(market(25100, 560))).toEqual([]); // no OI yet
    expect(r.s.phase).toBe('waiting');
    r.at(market(25100, 561, { oi }));
    const k = maxPainStrike(market(25100, 561, { oi }), 0).strike;
    expect(r.orders.map((o) => [o.type, o.strike])).toEqual([['CE', k], ['PE', k]]);
    expect(S6.rollPct).toBe(25);
  });
});

describe('S7 · SENSEX top-OI selling', () => {
  const oi = (t: 'CE' | 'PE', k: number) => (k % 100 ? null : t === 'CE' ? (k > 25000 ? 30_000_000 / (k - 24900) : 100) : k < 25000 ? 30_000_000 / (25100 - k) : 100);

  it('ranks CE and PE by OI separately, highest first', () => {
    const snap = market(25000, 560, { oi });
    expect(rankByOi(snap, 'CE', 0).slice(0, 3).map(([k]) => k)).toEqual([25100, 25200, 25300]);
    expect(rankByOi(snap, 'PE', 0).slice(0, 3).map(([k]) => k)).toEqual([24900, 24800, 24700]);
  });

  it('Wednesday: sells 1 lot at each of the top 3 CE and top 3 PE (6 positions); combined ₹3,000 stop loss squares off all', () => {
    expect(weekdayOf('2026-11-04')).toBe(3);
    const r = runner(oiTop, S7);
    const e = r.at(market(25000, 560, { oi }));
    expect(e[0].kind).toBe('ENTRY');
    expect(r.orders.map((o) => [o.side, o.type, o.strike, o.lots])).toEqual([
      ['SELL', 'CE', 25100, 1], ['SELL', 'CE', 25200, 1], ['SELL', 'CE', 25300, 1],
      ['SELL', 'PE', 24900, 1], ['SELL', 'PE', 24800, 1], ['SELL', 'PE', 24700, 1],
    ]);
    expect(r.s.legs).toHaveLength(6);
    r.orders.length = 0;
    expect(r.at(market(25010, 570, { oi }))).toEqual([]);
    // A rally: the call positions lose far more than ₹3,000 in all.
    const ev = r.at(market(25400, 600, { oi }));
    expect(ev[0].kind).toBe('STOP');
    expect(ev[0].message).toMatch(/Daily stop loss hit: combined P&L .* of 6 positions reached −₹3000/);
    expect(r.orders).toHaveLength(6);
    expect(r.orders.every((o) => o.side === 'BUY')).toBe(true);
    expect(r.s.legs).toHaveLength(0);
    expect(r.at(market(25000, 610, { oi }))).toEqual([]);
  });

  it('other weekdays: no trade; a top-OI strike without a premium: nothing sold', () => {
    const tue = runner(oiTop, S7);
    const ev = tue.at(market(25000, 560, { oi, date: '2026-11-03' }));
    expect(ev[0].message).toMatch(/Tuesday is not a trading day of this strategy \(Wednesday and Thursday only\)/);
    expect(tue.orders).toHaveLength(0);
    const r = runner(oiTop, S7);
    const snap = market(25000, 560, { oi });
    const ev2 = r.at({ ...snap, premium: (t, k) => (t === 'CE' && k === 25200 ? null : snap.premium(t, k)) });
    expect(ev2[0].kind).toBe('STOP');
    expect(ev2[0].message).toMatch(/No traded premium for 25200 CE among the top-OI strikes — nothing sold today/);
    expect(r.orders).toHaveLength(0);
  });

  it('waits until OI is live on both sides', () => {
    const r = runner(oiTop, S7);
    expect(r.at(market(25000, 560))).toEqual([]);
    expect(r.s.phase).toBe('waiting');
  });
});

describe('profit target and roll limit (straddle, top OI)', () => {
  it('S5 with a profit target: squared off when the day P&L reaches it', () => {
    const r = runner(rollingStraddle, { ...S5, stopLossPerLot: 0, profitTargetPerLot: 1000 });
    r.at(market(25000, 560));
    r.orders.length = 0;
    const ev = r.at(market(25000, 620, { bump: -20 })); // both legs ₹20 cheaper: +₹2,600
    expect(ev[0].kind).toBe('STOP');
    expect(ev[0].message).toMatch(/Daily profit target reached: day P&L .* reached \+₹1000/);
    expect(r.orders.map((o) => o.side)).toEqual(['BUY', 'BUY']);
  });

  it('S5 with max 1 roll: the second roll squares off instead', () => {
    const r = runner(rollingStraddle, { ...S5, stopLossPerLot: 0, maxRolls: 1 });
    r.at(market(25000, 560));
    r.at(market(25400, 600)); // CE 25000 deep in the money: CE + PE ≈ ₹403 ≥ ₹360 (300 × 1.2) → roll to 25400
    expect(r.s.rolls).toBe(1);
    r.orders.length = 0;
    const ev = r.at(market(25800, 620));
    expect(ev[0].kind).toBe('STOP');
    expect(ev[0].message).toMatch(/the 1 roll allowed today are used up/);
    expect(r.orders.map((o) => o.side)).toEqual(['BUY', 'BUY']);
  });

  it('S7 with a profit target on all six positions', () => {
    const oi = (t: 'CE' | 'PE', k: number) => (k % 100 ? null : t === 'CE' ? (k > 25000 ? 30_000_000 / (k - 24900) : 100) : k < 25000 ? 30_000_000 / (25100 - k) : 100);
    const r = runner(oiTop, { ...S7, stopLoss: 0, profitTarget: 2000 });
    r.at(market(25000, 560, { oi }));
    r.orders.length = 0;
    const ev = r.at(market(25000, 620, { oi, bump: -10 }));
    expect(ev[0].kind).toBe('STOP');
    expect(ev[0].message).toMatch(/Daily profit target reached: combined P&L .* of 6 positions reached \+₹2000/);
    expect(r.orders).toHaveLength(6);
  });
});
