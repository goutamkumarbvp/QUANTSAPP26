import { describe, expect, it } from 'vitest';
import {
  ALGO_PRESETS,
  ALGOS,
  algoById,
  ladderLevels,
  ladderRules,
  isOtm,
  ladderLevel,
  premiumLadder,
  selectStrike,
  totalCharges,
  type AlgoOrder,
  type AlgoSnapshot,
  type PremiumLadderParams,
} from '../src';

const P: PremiumLadderParams = { ...(ALGOS[0].defaults({ symbol: 'NIFTY', strikeStep: 50, kind: 'index' }) as PremiumLadderParams) };

/** Toy market: premium = intrinsic + 150·e^(−|K−S|/120); strikes every 50 from 23000 to 27000. */
function market(spot: number, minuteOfDay: number, bump: Partial<Record<string, number>> = {}): AlgoSnapshot {
  const strikes: number[] = [];
  for (let k = 23000; k <= 27000; k += 50) strikes.push(k);
  return {
    ts: minuteOfDay * 60_000,
    minuteOfDay,
    date: '2026-10-09',
    symbol: 'NIFTY',
    spot,
    expiry: '2026-10-13',
    lotSize: 65,
    strikes,
    premium: (type, k) => {
      const intrinsic = type === 'CE' ? Math.max(0, spot - k) : Math.max(0, k - spot);
      const v = intrinsic + 150 * Math.exp(-Math.abs(k - spot) / 120);
      return Math.round((v + (bump[`${type}${k}`] ?? 0)) * 20) / 20;
    },
  };
}

function runner(p = P) {
  const s = premiumLadder.init(p);
  const orders: (AlgoOrder & { price: number })[] = [];
  const at = (snap: AlgoSnapshot) =>
    premiumLadder.step(p, s, snap, (o) => {
      const price = snap.premium(o.type, o.strike)!;
      orders.push({ ...o, price });
      return price;
    });
  return { s, orders, at };
}

describe('strike selection', () => {
  it('only picks OTM strikes that are multiples of 100, nearest the target premium', () => {
    const snap = market(25010, 560);
    const ce = selectStrike(snap, 'CE', 20, { multiple: 100, maxGapPct: 100 });
    const pe = selectStrike(snap, 'PE', 20, { multiple: 100, maxGapPct: 100 });
    expect(ce.ok && pe.ok).toBe(true);
    if (!ce.ok || !pe.ok) return;
    expect(ce.pick.strike % 100).toBe(0);
    expect(pe.pick.strike % 100).toBe(0);
    expect(isOtm('CE', ce.pick.strike, snap.spot)).toBe(true);
    expect(isOtm('PE', pe.pick.strike, snap.spot)).toBe(true);
    // brute force: no other eligible strike is closer to ₹20
    for (const k of snap.strikes) {
      if (k % 100 || k <= snap.spot) continue;
      expect(Math.abs(snap.premium('CE', k)! - 20)).toBeGreaterThanOrEqual(Math.abs(ce.pick.premium - 20) - 1e-9);
    }
  });

  it('treats the ATM strike as not OTM and reports when nothing is near the target', () => {
    const snap = market(25000, 560);
    expect(isOtm('CE', 25000, 25000)).toBe(false);
    expect(isOtm('PE', 25000, 25000)).toBe(false);
    const r = selectStrike(snap, 'CE', 400, { multiple: 100, maxGapPct: 50 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/No OTM CE strike/);
  });

  it('computes ladder levels with jumps', () => {
    expect(ladderLevel(20, 29.95, 50)).toEqual({ level: 20, rungs: 0 });
    expect(ladderLevel(20, 30, 50)).toEqual({ level: 30, rungs: 1 });
    expect(ladderLevel(20, 50, 50)).toEqual({ level: 45, rungs: 2 });
    expect(ladderLevel(45, 70, 50).level).toBeCloseTo(67.5);
  });
});

describe('premium ladder (Strategy 2)', () => {
  it('waits for 09:20, then sells an OTM CE and PE near ₹20', () => {
    const r = runner();
    expect(r.at(market(25000, 559))).toEqual([]);
    expect(r.s.phase).toBe('waiting');
    const ev = r.at(market(25000, 560));
    expect(ev[0].kind).toBe('ENTRY');
    expect(r.s.phase).toBe('active');
    expect(r.orders.map((o) => `${o.side} ${o.type}`)).toEqual(['SELL CE', 'SELL PE']);
    expect(r.s.legs.CE!.strike).toBeGreaterThan(25000);
    expect(r.s.legs.PE!.strike).toBeLessThan(25000);
    expect(r.s.legs.CE!.strike % 100).toBe(0);
    expect(r.s.level).toBe(20);
  });

  it('shifts the opposite leg when a leg gains 50%, then again at +50% of that level', () => {
    const r = runner();
    r.at(market(25000, 560));
    const ce = r.s.legs.CE!.strike;
    const pe0 = r.s.legs.PE!.strike;
    // Spot rises until the call trades ≥ ₹30.
    let spot = 25000;
    let ev: ReturnType<typeof r.at> = [];
    while (!ev.length) {
      spot += 5;
      ev = r.at(market(spot, 600));
    }
    expect(ev[0].kind).toBe('ADJUSTMENT');
    expect(r.s.level).toBe(30);
    expect(r.s.legs.CE!.strike).toBe(ce); // the triggering leg stays
    const pe1 = r.s.legs.PE!;
    expect(pe1.strike).toBeGreaterThan(pe0); // moved closer to the money
    expect(pe1.strike).toBeLessThan(spot);
    expect(Math.abs(pe1.entryPrice - 30)).toBeLessThan(15);
    expect(r.orders.slice(-2).map((o) => `${o.side} ${o.type} ${o.strike}`)).toEqual([`BUY PE ${pe0}`, `SELL PE ${pe1.strike}`]);
    // Next rung is ₹45.
    ev = [];
    while (!ev.length) {
      spot += 5;
      ev = r.at(market(spot, 620));
    }
    expect(r.s.level).toBe(45);
    expect(r.s.adjustments).toBe(2);
    expect(r.s.legs.PE!.strike).toBeLessThan(spot);
  });

  it('jumps straight to the highest level reached on a gap', () => {
    const r = runner();
    r.at(market(25000, 560));
    const ce = r.s.legs.CE!.strike;
    r.at(market(25000, 561, { [`CE${ce}`]: 60 })); // CE gaps to ~₹75+
    expect(r.s.level).toBeGreaterThanOrEqual(67.5);
    expect(r.s.rung).toBeGreaterThanOrEqual(3);
  });

  it('squares off and stops for the day when no OTM strike is near the new level', () => {
    const r = runner({ ...P, maxGapPct: 10 });
    r.at(market(25000, 560));
    const ce = r.s.legs.CE?.strike;
    if (!ce) {
      // With a 10% gap the toy chain may not even allow entry — then it must stop with no orders.
      expect(r.s.phase).toBe('stopped');
      expect(r.orders).toHaveLength(0);
      return;
    }
    r.at(market(25000, 561, { [`CE${ce}`]: 400 })); // needs a PE near ₹>400: impossible OTM
    expect(r.s.phase).toBe('stopped');
    expect(r.s.legs.CE).toBeNull();
    expect(r.s.legs.PE).toBeNull();
    const n = r.orders.length;
    expect(r.orders.slice(-2).every((o) => o.side === 'BUY')).toBe(true);
    // No further trades that day, whatever happens.
    expect(r.at(market(24000, 600))).toEqual([]);
    expect(r.at(market(24000, 925))).toEqual([]);
    expect(r.orders).toHaveLength(n);
  });

  it('squares off everything at 15:25', () => {
    const r = runner();
    r.at(market(25000, 560));
    r.at(market(25050, 924));
    expect(r.s.phase).toBe('active');
    const ev = r.at(market(25050, 925));
    expect(ev[0].kind).toBe('EXIT');
    expect(r.s.phase).toBe('exited');
    expect(r.s.legs).toEqual({ CE: null, PE: null });
    const buys = r.orders.filter((o) => o.side === 'BUY').length;
    expect(buys).toBe(r.orders.filter((o) => o.side === 'SELL').length);
    // realised P&L equals Σ sells − Σ buys
    const cash = r.orders.reduce((a, o) => a + (o.side === 'SELL' ? 1 : -1) * o.price * o.lots * 65, 0);
    expect(r.s.realized).toBeCloseTo(cash, 6);
  });

  it('can restrict the next trigger to the leg that triggered last', () => {
    const r = runner({ ...P, triggerOn: 'same' });
    r.at(market(25000, 560));
    const ce = r.s.legs.CE!.strike;
    const bump = 31 - market(25000, 561).premium('CE', ce)!; // call trades at ₹31
    r.at(market(25000, 561, { [`CE${ce}`]: bump }));
    expect(r.s.lastTrigger).toBe('CE');
    const pe = r.s.legs.PE!.strike;
    expect(r.at(market(25000, 562, { [`CE${ce}`]: bump, [`PE${pe}`]: 40 }))).toEqual([]); // PE rise ignored
    expect(r.s.level).toBe(30);
  });

  it('stops safely when an order is rejected', () => {
    const s = premiumLadder.init(P);
    let n = 0;
    const ev = premiumLadder.step(P, s, market(25000, 560), (o) => {
      if (++n === 2) throw new Error('Insufficient funds');
      return 20;
    });
    expect(ev[0].kind).toBe('ERROR');
    expect(s.phase).toBe('stopped');
    expect(s.legs).toEqual({ CE: null, PE: null }); // the filled CE was bought back
    expect(n).toBe(3);
  });

  it('skips the day when deployed late without late entry', () => {
    const r = runner({ ...P, lateEntry: false });
    r.at(market(25000, 640));
    expect(r.s.phase).toBe('exited');
    expect(r.orders).toHaveLength(0);
  });

  it('validates parameters and is registered', () => {
    expect(premiumLadder.validate(P)).toBeNull();
    expect(premiumLadder.validate({ ...P, exitTime: '09:00' })).toMatch(/market hours|after/);
    expect(premiumLadder.validate({ ...P, lots: 0 })).toMatch(/Lots/);
    expect(algoById('premium-ladder')).toBe(premiumLadder);
    expect(totalCharges([{ side: 'SELL', price: 20, lots: 1 }], 65)).toBeGreaterThan(20);
  });
});

describe('Strategy 3 (starting premium ₹50)', () => {
  const P50 = ALGO_PRESETS.find((p) => p.id === 'strategy-3-rs50')!.params as unknown as PremiumLadderParams;
  const P20 = ALGO_PRESETS.find((p) => p.id === 'strategy-2-rs20')!.params as unknown as PremiumLadderParams;

  it('differs from Strategy 2 only in the starting premium', () => {
    expect(P50.startPremium).toBe(50);
    expect({ ...P50, startPremium: 20 }).toEqual(P20);
    expect(premiumLadder.validate(P50)).toBeNull();
  });

  it('describes its own ladder', () => {
    expect(ladderLevels(50, 50)).toEqual([50, 75, 112.5, 168.75]);
    const rules = ladderRules(P50).join(' ');
    expect(rules).toMatch(/closest to the starting premium \(₹50\)/);
    expect(rules).toMatch(/₹50 → ₹75 → ₹112.5 → ₹168.75/);
    expect(rules).toMatch(/multiples of 100/);
    expect(ladderRules(P20).join(' ')).toMatch(/₹20 → ₹30 → ₹45 → ₹67.5/);
  });

  it('enters nearer the money at ~₹50 and adjusts at ₹75', () => {
    const r = runner(P50);
    r.at(market(25000, 560));
    const ce = r.s.legs.CE!;
    const pe = r.s.legs.PE!;
    expect(r.s.level).toBe(50);
    expect(ce.strike % 100).toBe(0);
    expect(ce.strike).toBeGreaterThan(25000);
    expect(pe.strike).toBeLessThan(25000);
    // nearest-to-₹50 strike: no eligible strike is closer to 50
    const snap = market(25000, 560);
    for (const k of snap.strikes) {
      if (k % 100 || k <= 25000) continue;
      expect(Math.abs(snap.premium('CE', k)! - 50)).toBeGreaterThanOrEqual(Math.abs(ce.entryPrice - 50) - 1e-9);
    }
    // the ₹20 version sells further out of the money
    const r20 = runner(P20);
    r20.at(market(25000, 560));
    expect(ce.strike).toBeLessThan(r20.s.legs.CE!.strike);
    // CE trades at ₹76 → level ₹75, PE rolled near ₹75
    const bump = 76 - market(25000, 561).premium('CE', ce.strike)!;
    const ev = r.at(market(25000, 561, { [`CE${ce.strike}`]: bump }));
    expect(ev[0].kind).toBe('ADJUSTMENT');
    expect(r.s.level).toBe(75);
    // The put is moved to (or kept at, if it already is) the OTM strike nearest ₹75.
    const pe2 = r.s.legs.PE!;
    expect(pe2.strike).toBeGreaterThanOrEqual(pe.strike);
    expect(pe2.strike).toBeLessThan(25000);
    const s1 = market(25000, 561, { [`CE${ce.strike}`]: bump });
    for (const k of s1.strikes) {
      if (k % 100 || k >= 25000) continue;
      expect(Math.abs(s1.premium('PE', k)! - 75)).toBeGreaterThanOrEqual(Math.abs(s1.premium('PE', pe2.strike)! - 75) - 1e-9);
    }
    expect(ev[0].message).toMatch(pe2.strike === pe.strike ? /kept/ : /sold/);
  });
});

describe('Strategy 3 rolls the opposite leg to the strike nearest the new level', () => {
  const P50 = ALGO_PRESETS.find((p) => p.id === 'strategy-3-rs50')!.params as unknown as PremiumLadderParams;
  it('buys back the old put and sells the OTM put nearest ₹75', () => {
    const r = runner(P50);
    r.at(market(25050, 560));
    const ce = r.s.legs.CE!;
    const pe0 = r.s.legs.PE!;
    expect([ce.strike, pe0.strike]).toEqual([25200, 24900]);
    const bump = 76 - market(25050, 561).premium('CE', ce.strike)!;
    const snap = market(25050, 561, { [`CE${ce.strike}`]: bump });
    const ev = r.at(snap);
    expect(ev[0].kind).toBe('ADJUSTMENT');
    expect(r.s.level).toBe(75);
    expect(ev[0].fills.map((f) => `${f.side} ${f.type} ${f.strike}`)).toEqual(['BUY PE 24900', 'SELL PE 25000']);
    expect(r.s.legs.CE!.strike).toBe(ce.strike); // the triggering call stays
    // 25000 PE is OTM (spot 25050) and nearer ₹75 than any other eligible put
    for (const k of snap.strikes) {
      if (k % 100 || k >= 25050) continue;
      expect(Math.abs(snap.premium('PE', k)! - 75)).toBeGreaterThanOrEqual(Math.abs(snap.premium('PE', 25000)! - 75));
    }
  });

  it('describes the trigger mode, the premium tolerance and the strike fallback', () => {
    expect(ladderRules({ ...P50, triggerOn: 'same' }).join(' ')).toMatch(/only the leg that triggered last/);
    expect(ladderRules({ ...P50, maxGapPct: 20 }).join(' ')).toMatch(/within ±20% of the target/);
    expect(ladderRules({ symbol: 'FINNIFTY', strikeMultiple: '' as unknown as number }).join(' ')).toMatch(/Any listed FINNIFTY strike/);
    expect(premiumLadder.label!({ ...P50, startPremium: 30 })).toBe('Premium ladder · ₹30 start');
  });
});
