import { describe, expect, it } from 'vitest';
import {
  ALGO_PRESETS,
  ALGOS,
  algoById,
  ladderLevels,
  ladderRules,
  isOtm,
  ladderLevel,
  ladderAtmStrike,
  stopLossCheck,
  openPnl,
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
      if (k % 100 || k <= snap.spot!) continue;
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

describe('live data: missing prices', () => {
  it('a strike without a premium is not eligible; without the underlying price nothing is OTM', () => {
    const snap = market(25010, 560);
    const gapped: AlgoSnapshot = { ...snap, premium: (type, k) => (type === 'PE' ? null : snap.premium(type, k)) };
    const pe = selectStrike(gapped, 'PE', 20, { multiple: 100, maxGapPct: 50 });
    expect(pe.ok).toBe(false);
    if (!pe.ok) expect(pe.reason).toMatch(/No OTM PE strike \(multiple of 100\) has a traded premium/);
    expect(isOtm('CE', 25100, null)).toBe(false);
    const blind = selectStrike({ ...snap, spot: null }, 'CE', 20, { multiple: 100, maxGapPct: 50 });
    expect(blind.ok).toBe(false);
    if (!blind.ok) expect(blind.reason).toMatch(/No underlying price/);
  });

  it('waits at the entry while the underlying price is missing, then enters when it is back', () => {
    const r = runner();
    expect(r.at({ ...market(25000, 560), spot: null })).toEqual([]);
    expect(r.s.phase).toBe('waiting');
    expect(r.orders).toHaveLength(0);
    const ev = r.at(market(25000, 563));
    expect(ev[0].kind).toBe('ENTRY');
  });

  it('without late entry, a day whose entry window passed without data is skipped', () => {
    const r = runner({ ...P, lateEntry: false });
    r.at(market(25000, 556));
    expect(r.at({ ...market(25000, 562), spot: null })[0].message).toMatch(/No NIFTY price at the 09:20 entry/);
    expect(r.s.phase).toBe('exited');
    const r2 = runner({ ...P, lateEntry: false });
    r2.at(market(25000, 556));
    expect(r2.at(market(25000, 570))[0].message).toMatch(/No market data at the 09:20 entry \(first data at 09:30\)/);
    expect(r2.orders).toHaveLength(0);
  });

  it('an adjustment waits for the underlying price (the new leg must be OTM), the time exit does not', () => {
    const r = runner();
    r.at(market(25000, 560));
    const ce = r.s.legs.CE!.strike;
    const n = r.orders.length;
    expect(r.at({ ...market(25000, 600, { [`CE${ce}`]: 40 }), spot: null })).toEqual([]);
    expect(r.orders).toHaveLength(n);
    expect(r.s.level).toBe(20);
    const exit = r.at({ ...market(25000, 925), spot: null });
    expect(exit[0].kind).toBe('EXIT');
    expect(exit[0].data?.spot).toBeNull();
    expect(r.s.legs.CE).toBeNull();
  });

  it('open P&L is unknown when an open leg has no premium', () => {
    const r = runner();
    r.at(market(25000, 560));
    const legs = premiumLadder.openLegs(r.s);
    const snap = market(25000, 600);
    expect(openPnl(legs, snap)).not.toBeNull();
    expect(openPnl(legs, { ...snap, premium: (type, k) => (type === 'CE' ? null : snap.premium(type, k)) })).toBeNull();
  });
});

describe('Strategy 3 (starting premium ₹50)', () => {
  const P50 = ALGO_PRESETS.find((p) => p.id === 'strategy-3-rs50')!.params as unknown as PremiumLadderParams;
  const P20 = ALGO_PRESETS.find((p) => p.id === 'strategy-2-rs20')!.params as unknown as PremiumLadderParams;

  it('differs from Strategy 2 only in the starting premium', () => {
    expect(P50.startPremium).toBe(50);
    expect({ ...P50, startPremium: 20, allowAtm: true }).toEqual(P20); // S2 allows the ATM strike; the ₹50 ladder stays strictly OTM
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
    expect(premiumLadder.label!({ ...P50, startPremium: 30 })).toBe('Premium ladder · ₹30–45');
  });
});

describe('S1–S4 rules (ATM/OTM, daily stop loss, same-side fixed trigger)', () => {
  const preset = (id: string) => ({ ...P, ...(ALGO_PRESETS.find((x) => x.id === id)!.params as Partial<PremiumLadderParams>) }) as PremiumLadderParams;
  const S1 = preset('s1-ladder-40');
  const S3 = preset('s3-fixed-40');
  // The toy market jumps a leg from about ₹29 to ₹99 in one step, past S3's ₹3,000 stop loss: the adjustment
  // tests run without it (the stop loss has its own tests below).
  const S3noSL = { ...S3, stopLossPerLot: 0 };
  const S1noSL = { ...S1, stopLossPerLot: 0 };

  it('presets: S1–S4 with their own premiums, modes and stop losses; S2/S4 have none until it is set', () => {
    expect(ALGO_PRESETS.map((x) => x.name)).toEqual([
      'S1 · NIFTY OTM premium ladder 40–60–90',
      'S2 · NIFTY OTM premium ladder 20–30–45',
      'S3 · NIFTY OTM fixed premium 40–60',
      'S4 · NIFTY OTM fixed premium 20–30',
      'S5 · NIFTY ATM rolling straddle (20%)',
      'S6 · NIFTY max-pain rolling straddle (25%)',
      'S7 · SENSEX OI-based option selling',
      'Ladder · Starting premium ₹50 (earlier Strategy 3)',
    ]);
    expect(ALGO_PRESETS.slice(0, 4).map((x) => [x.params.startPremium, x.params.mode, x.params.stopLossPerLot, x.params.allowAtm, x.params.strikeMultiple, x.params.entryTime, x.params.exitTime])).toEqual([
      [40, 'ladder', 3000, true, 100, '09:20', '15:25'],
      [20, 'ladder', 0, true, 100, '09:20', '15:25'],
      [40, 'fixed', 3000, true, 100, '09:20', '15:25'],
      [20, 'fixed', 0, true, 100, '09:20', '15:25'],
    ]);
    for (const x of ALGO_PRESETS) {
      const a = algoById(x.algoId)!;
      expect(a.validate({ ...(a.defaults({ symbol: String(x.params.symbol), strikeStep: 100, kind: 'index' }) as object), ...x.params })).toBeNull();
    }
    expect(ladderLevels(40, 50, 5)).toEqual([40, 60, 90, 135, 202.5]);
    expect(ladderLevels(20, 50, 5)).toEqual([20, 30, 45, 67.5, 101.25]);
    expect(ladderRules(S3).join(' ')).toMatch(/Fixed trigger at ₹60 .* never moves up/);
    expect(ladderRules(S3).join(' ')).toMatch(/The other leg is not touched/);
    expect(ladderRules(S1).join(' ')).toMatch(/Daily combined stop loss ₹3000 per lot/);
    expect(ladderRules(preset('s4-fixed-20')).join(' ')).toMatch(/Daily stop loss: not set/);
  });

  it('ATM or OTM, never ITM: the strike nearest the spot may be sold, one further in the money never', () => {
    const strikes = [24800, 24900, 25000, 25100, 25200];
    expect(ladderAtmStrike(strikes, 25040, 100)).toBe(25000);
    expect(ladderAtmStrike(strikes, 25050, 100)).toBeNull(); // equally near 25000 and 25100: no ATM, the OTM one is allowed anyway
    const snap = market(25040, 560);
    const atm = selectStrike(snap, 'CE', 147, { multiple: 100, maxGapPct: 50, allowAtm: true });
    expect(atm.ok && atm.pick.strike).toBe(25000);
    const strict = selectStrike(snap, 'CE', 147, { multiple: 100, maxGapPct: 50 });
    expect(strict.ok && strict.pick.strike).not.toBe(25000);
    // A deep target would want the in-the-money 24900 CE: never chosen.
    const itm = selectStrike(snap, 'CE', 250, { multiple: 100, maxGapPct: 100, allowAtm: true });
    expect(itm.ok && itm.pick.strike).toBe(25000);
  });

  it('S3: the leg that reaches ₹60 is bought back and re-sold farther OTM near ₹40; the other leg is untouched; the trigger stays ₹60', () => {
    const r = runner(S3noSL);
    r.at(market(25000, 560));
    expect(r.s.legs.CE?.strike).toBe(25200);
    expect(r.s.legs.PE?.strike).toBe(24800);
    const pe = r.s.legs.PE;
    r.orders.length = 0;
    // CE 25200 rises to about ₹99 (≥ ₹60).
    const ev = r.at(market(25150, 600));
    expect(r.orders.map((o) => [o.side, o.type, o.strike])).toEqual([['BUY', 'CE', 25200], ['SELL', 'CE', 25300]]);
    expect(r.s.legs.PE).toBe(pe); // the same object: not touched
    expect(ev[0].kind).toBe('ADJUSTMENT');
    expect(ev[0].message).toMatch(/CE 25200 premium .* reached the fixed ₹60 trigger.*farther OTM.*PE 24800 .* untouched/);
    expect(r.s.sideAdjustments).toEqual({ CE: 1, PE: 0 });
    // Again at ₹60 (not ₹90): CE 25300 at about ₹107 → rolled to 25400.
    r.orders.length = 0;
    r.at(market(25260, 620));
    expect(r.orders.map((o) => [o.side, o.type, o.strike])).toEqual([['BUY', 'CE', 25300], ['SELL', 'CE', 25400]]);
    expect(r.s.adjustments).toBe(2);
    expect(r.s.phase).toBe('active');
  });

  it('S3: no ATM/OTM strike farther out near ₹40 (and below ₹60) → both legs squared off, stopped for the day', () => {
    const r = runner(S3noSL);
    r.at(market(25000, 560));
    r.orders.length = 0;
    // Only the strikes up to 25300 are listed: nothing farther out than 25200 sits near ₹40 below ₹60.
    const snap = market(25150, 600);
    const ev = r.at({ ...snap, strikes: snap.strikes.filter((k) => k <= 25200) });
    expect(ev[0].kind).toBe('STOP');
    expect(ev[0].message).toMatch(/No ATM\/OTM CE strike \(multiple of 100\) farther OTM than 25200/);
    expect(r.orders.map((o) => [o.side, o.type, o.strike])).toEqual([['BUY', 'CE', 25200], ['BUY', 'PE', 24800]]);
    expect(r.s.phase).toBe('stopped');
    expect(r.at(market(25000, 630))).toEqual([]);
  });

  it('daily combined stop loss: realised + open P&L at −₹3,000 per lot × lots squares off both legs and halts', () => {
    const r = runner({ ...S1, lots: 2 });
    r.at(market(25000, 560));
    r.orders.length = 0;
    // CE 25200 deep in the money: the combined loss is far beyond ₹6,000 (2 lots); checked before any adjustment.
    const ev = r.at(market(25350, 600));
    expect(ev[0].kind).toBe('STOP');
    expect(ev[0].message).toMatch(/Daily stop loss hit: combined P&L .* reached −₹6000 \(₹3000 per lot × 2\)/);
    expect(r.orders.map((o) => [o.side, o.type, o.strike])).toEqual([['BUY', 'CE', 25200], ['BUY', 'PE', 24800]]);
    expect(r.s.phase).toBe('stopped');
    expect(r.s.realized).toBeLessThanOrEqual(-6000);
    expect(r.at(market(25000, 630))).toEqual([]); // no more trades today
  });

  it('stop loss: not set → never fires; an open leg without a premium → not judged on unknown P&L', () => {
    const r = runner(S1noSL);
    r.at(market(25000, 560));
    expect(stopLossCheck({ ...S1, stopLossPerLot: 0 }, r.s, market(25350, 600))).toBeNull();
    const blind = { premium: (t: 'CE' | 'PE') => (t === 'CE' ? null : 1) };
    expect(stopLossCheck(S1, r.s, blind)).toBeNull();
    expect(stopLossCheck(S1, r.s, market(25350, 600))).not.toBeNull();
  });

  it('two runs (S1 and S3) on the same market keep separate legs, P&L and counters', () => {
    const a = runner(S1noSL);
    const b = runner(S3noSL);
    for (const [spot, min] of [[25000, 560], [25150, 600], [25260, 620]] as const) {
      a.at(market(spot, min));
      b.at(market(spot, min));
    }
    // S1 (ladder) rolled the PUT to the new level; S3 (fixed) rolled the CALL farther out.
    expect(a.s.sideAdjustments!.PE).toBeGreaterThan(0);
    expect(a.s.sideAdjustments!.CE).toBe(0);
    expect(b.s.sideAdjustments).toEqual({ CE: 2, PE: 0 });
    expect(a.s.legs.CE).not.toBe(b.s.legs.CE);
    expect(a.orders).not.toEqual(b.orders);
  });
});
