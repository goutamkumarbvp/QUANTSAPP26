import { describe, expect, it } from 'vitest';
import { bsGreeks } from '@q26/core';
import {
  LivePricing,
  atmIvOf,
  black76Greeks,
  black76Iv,
  black76Price,
  chainAtmIv,
  forwardOf,
  impliedForward,
  isLivePrice,
  liveSessionDates,
  premiumTs,
  timeToExpiry,
  valuationTs,
} from '../../src/live/pricing';
import { ExchangeCalendar } from '../../src/live/calendar';
import { NoLiveData, keyId } from '../../src/live/types';
import type { InstrumentKey, Listing, LiveQuote, OptKind, RawChain, ReferenceData, Segment, Underlying } from '../../src/live/types';

const ist = (date: string, hh: number, mm: number): number => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm) - 330 * 60_000;
};

/** Minimal instrument master for tests (strikes / expiries only). */
class FakeRef implements ReferenceData {
  constructor(
    private readonly strikeMap: Record<string, number[]>,
    private readonly expiryMap: Record<string, string[]>,
    private loaded = true,
  ) {}
  async refresh(): Promise<void> {}
  ready(): boolean {
    return this.loaded;
  }
  underlyings(): Underlying[] {
    return [];
  }
  underlying(symbol: string): Underlying {
    throw new NoLiveData(`no master for ${symbol}`);
  }
  expiries(symbol: string, kind: 'OPT' | 'FUT'): string[] {
    if (!this.loaded) throw new NoLiveData('instrument master not loaded');
    return this.expiryMap[`${symbol}|${kind}`] ?? [];
  }
  strikes(symbol: string, expiry: string): number[] {
    if (!this.loaded) throw new NoLiveData('instrument master not loaded');
    return this.strikeMap[`${symbol}|${expiry}`] ?? [];
  }
  listing(_key: InstrumentKey): Listing | undefined {
    return undefined;
  }
  byToken(_segment: Segment, _token: string): Listing | undefined {
    return undefined;
  }
}

describe('Black-76 helpers', () => {
  it('match textbook Black-76 values (Hull)', () => {
    // F = K = 20, r = 9 %, T = 4 months, σ = 25 % → c = p = 1.1166
    expect(black76Price('CE', 20, 20, 4 / 12, 0.09, 0.25)).toBeCloseTo(1.1166, 4);
    expect(black76Price('PE', 20, 20, 4 / 12, 0.09, 0.25)).toBeCloseTo(1.1166, 4);
    // F = 19, K = 20, r = 12 %, T = 5 months, σ = 20 % → p = 1.50 (Hull, Black's model example)
    expect(black76Price('PE', 19, 20, 5 / 12, 0.12, 0.2)).toBeCloseTo(1.5045, 4);
    expect(black76Iv('PE', black76Price('PE', 19, 20, 5 / 12, 0.12, 0.2), 19, 20, 5 / 12, 0.12)).toBeCloseTo(0.2, 9);
  });

  it('round-trips iv → price → iv within 1e-6', () => {
    const F = 25_000;
    const r = 0.065;
    let checked = 0;
    for (const T of [2 / 365, 30 / 365, 1]) {
      for (const sigma of [0.06, 0.15, 0.4, 1.0]) {
        for (const m of [0.85, 0.95, 1, 1.05, 1.15]) {
          const K = Math.round(F * m);
          for (const type of ['CE', 'PE'] as OptKind[]) {
            const p = black76Price(type, F, K, T, r, sigma);
            const intrinsic = Math.exp(-r * T) * Math.max(0, type === 'CE' ? F - K : K - F);
            if (p - intrinsic < 0.01) continue; // no time value left to solve for
            const iv = black76Iv(type, p, F, K, T, r);
            expect(iv, `${type} K=${K} T=${T} σ=${sigma}`).not.toBeNull();
            expect(Math.abs((iv as number) - sigma)).toBeLessThan(1e-6);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(80);
  });

  it('returns null for premiums that cannot be solved', () => {
    const F = 25_000;
    const K = 24_000;
    const T = 8 / 365;
    const r = 0.065;
    const intrinsic = Math.exp(-r * T) * (F - K);
    expect(black76Iv('CE', intrinsic - 5, F, K, T, r)).toBeNull(); // below intrinsic
    expect(black76Iv('CE', intrinsic, F, K, T, r)).toBeNull(); // no time value
    expect(black76Iv('CE', Math.exp(-r * T) * F, F, K, T, r)).toBeNull(); // at the upper bound
    expect(black76Iv('CE', Number.NaN, F, K, T, r)).toBeNull();
    expect(black76Iv('CE', Number.POSITIVE_INFINITY, F, K, T, r)).toBeNull();
    expect(black76Iv('CE', 0, F, K, T, r)).toBeNull();
    expect(black76Iv('PE', -1, F, K, T, r)).toBeNull();
    expect(black76Iv('CE', 1200, F, K, 0, r)).toBeNull(); // expired
    expect(black76Iv('CE', 1200, F, Number.NaN, T, r)).toBeNull();
  });

  it('gives Black-76 Greeks through core bsGreeks with S = F, q = r', () => {
    const g = black76Greeks('CE', 25_000, 25_100, 10 / 365, 0.065, 0.13);
    expect(g).toEqual(bsGreeks('CE', 25_000, 25_100, 10 / 365, 0.065, 0.13, 0.065));
    // Black-76 call delta = e^{−rT} N(d1)
    expect((g as { delta: number }).delta).toBeGreaterThan(0.4);
    expect((g as { delta: number }).delta).toBeLessThan(0.5);
    expect(black76Greeks('CE', 25_000, 25_100, 0, 0.065, 0.13)).toBeNull();
    expect(black76Greeks('CE', 25_000, 25_100, 0.1, 0.065, Number.NaN)).toBeNull();
  });

  it('measures time to 15:30 IST on the expiry date', () => {
    const now = ist('2026-10-12', 15, 30);
    expect(timeToExpiry('2026-10-20', now)).toBeCloseTo(8 / 365, 12);
    expect(timeToExpiry('2026-10-12', ist('2026-10-12', 9, 30))).toBeCloseTo(6 / 24 / 365, 12);
    expect(timeToExpiry('2026-10-12', ist('2026-10-12', 16, 0))).toBe(0);
  });
});

describe('forwardOf', () => {
  const r = 0.065;
  const T = 8 / 365;
  const Ftrue = 25_050;
  const rows = [24_900, 25_000, 25_100].map((K) => ({ strike: K, ce: black76Price('CE', Ftrue, K, T, r, 0.12), pe: black76Price('PE', Ftrue, K, T, r, 0.12) }));

  it('prefers the same-expiry future and implies carry from spot', () => {
    const f = forwardOf({ spot: 25_000, future: 25_100, rows }, T, r);
    expect(f).toEqual({ forward: 25_100, carry: Math.log(25_100 / 25_000) / T, source: 'future' });
  });

  it('never carries a NaN: without a spot or with no time left the estimate is rejected', () => {
    // The forward price alone (all Black-76 needs) is still known.
    expect(impliedForward({ future: 25_100, rows: [] }, T, r)).toEqual({ forward: 25_100, source: 'future' });
    expect(forwardOf({ future: 25_100, rows: [] }, T, r)).toBeNull();
    expect(forwardOf({ spot: 25_000, future: 25_100, rows }, 0, r)).toBeNull();
    expect(forwardOf({ spot: 25_000, rows: [] }, -1, r)).toBeNull();
    expect(impliedForward({ spot: 25_000, future: 25_100, rows }, 0, r)).toEqual({ forward: 25_100, source: 'future' });
  });

  it('uses put-call parity at the strike nearest spot', () => {
    const f = forwardOf({ spot: 25_010, rows }, T, r);
    expect(f?.source).toBe('parity');
    expect(Math.abs((f?.forward as number) - Ftrue)).toBeLessThan(1e-6);
    expect(f?.carry).toBeCloseTo(Math.log(Ftrue / 25_010) / T, 9);
    // The strike actually used is the one nearest spot: break parity elsewhere to prove it.
    const skewed = rows.map((row) => (row.strike === 25_000 ? row : { ...row, ce: (row.ce as number) + 50 }));
    expect(Math.abs((forwardOf({ spot: 25_010, rows: skewed }, T, r)?.forward as number) - Ftrue)).toBeLessThan(1e-6);
  });

  it('without spot, uses the pair with the smallest |C − P|', () => {
    const f = impliedForward({ rows }, T, r);
    expect(f?.source).toBe('parity');
    expect(Math.abs((f?.forward as number) - Ftrue)).toBeLessThan(1e-6);
    expect(forwardOf({ rows }, T, r)).toBeNull(); // no carry without a spot
  });

  it('falls back to spot carried at r, then to null', () => {
    expect(forwardOf({ spot: 25_000, rows: [{ strike: 25_000, ce: 100 }] }, T, r)).toEqual({ forward: 25_000 * Math.exp(r * T), carry: r, source: 'spot' });
    expect(forwardOf({ rows: [] }, T, r)).toBeNull();
    expect(forwardOf({ spot: Number.NaN, future: 0, rows: [] }, T, r)).toBeNull();
  });

  it('ATM IV averages the CE/PE IVs at the strike nearest the forward', () => {
    const chain = [24_900, 25_000, 25_100].map((K) => ({ strike: K, ce: black76Price('CE', Ftrue, K, T, r, 0.11), pe: black76Price('PE', Ftrue, K, T, r, 0.13) }));
    const atm = atmIvOf(chain, Ftrue, T, r);
    expect(atm?.strike).toBe(25_000); // 25,050 is equidistant: the lower strike wins the tie
    expect(atm?.iv).toBeCloseTo(0.12, 6);
    expect(atmIvOf([{ strike: 25_000, ce: black76Price('CE', Ftrue, 25_000, T, r, 0.11) }], Ftrue, T, r)?.iv).toBeCloseTo(0.11, 6);
    expect(atmIvOf([], Ftrue, T, r)).toBeNull();
    expect(atmIvOf([{ strike: 25_000, ce: 0.0001 }], Ftrue, T, r)).toBeNull();
  });
});

describe('LivePricing', () => {
  const r = 0.065;
  const now = ist('2026-10-12', 10, 0);
  const WEEKLY = '2026-10-20';
  const MONTHLY = '2026-10-27';
  const strikes = [24_800, 24_900, 25_000, 25_100, 25_200];
  const ref = new FakeRef(
    { [`NIFTY|${WEEKLY}`]: strikes, [`NIFTY|${MONTHLY}`]: strikes },
    { 'NIFTY|OPT': ['2026-10-06', WEEKLY, MONTHLY], 'NIFTY|FUT': [MONTHLY] },
  );

  const calendar = new ExchangeCalendar(); // 2026-10-09 Fri, 10-12 Mon, 10-13 Tue

  function setup(quotes: LiveQuote[], extra: Partial<ConstructorParameters<typeof LivePricing>[0]> = {}) {
    const map = new Map(quotes.map((q) => [keyId(q.key), q]));
    return new LivePricing({ r, ref, calendar, getQuote: (k) => map.get(keyId(k)), now: () => now, ...extra });
  }
  const q = (key: InstrumentKey, ltp: number, ts = now): LiveQuote => ({ key, ts, ltp });
  const spot = (ltp: number, ts = now) => q({ symbol: 'NIFTY', kind: 'SPOT' }, ltp, ts);
  const opt = (type: OptKind, expiry: string, strike: number, ltp: number) => q({ symbol: 'NIFTY', kind: type, expiry, strike }, ltp);

  /** Option quotes of an expiry priced off a known forward. */
  const chainQuotes = (expiry: string, F: number, ceVol: number | ((K: number) => number), peVol: number | ((K: number) => number)) => {
    const T = timeToExpiry(expiry, now);
    const v = (x: number | ((K: number) => number), K: number) => (typeof x === 'number' ? x : x(K));
    return strikes.flatMap((K) => [opt('CE', expiry, K, black76Price('CE', F, K, T, r, v(ceVol, K))), opt('PE', expiry, K, black76Price('PE', F, K, T, r, v(peVol, K)))]);
  };

  it('forward: same-expiry future with carry ln(F/S)/T', () => {
    const p = setup([spot(25_000), q({ symbol: 'NIFTY', kind: 'FUT', expiry: MONTHLY }, 25_180)]);
    const T = timeToExpiry(MONTHLY, now);
    expect(p.forward('NIFTY', MONTHLY)).toEqual({ forward: 25_180, carry: Math.log(25_180 / 25_000) / T, source: 'future' });
  });

  it('forward: parity for a weekly expiry without a future', () => {
    const p = setup([spot(25_020), q({ symbol: 'NIFTY', kind: 'FUT', expiry: MONTHLY }, 25_180), ...chainQuotes(WEEKLY, 25_061.5, 0.12, 0.12)]);
    const f = p.forward('NIFTY', WEEKLY);
    expect(f.source).toBe('parity');
    expect(f.forward).toBeCloseTo(25_061.5, 6);
  });

  it('forward: spot when no future or pair is live; NoLiveData when nothing is', () => {
    const T = timeToExpiry(WEEKLY, now);
    expect(setup([spot(25_000)]).forward('NIFTY', WEEKLY)).toEqual({ forward: 25_000 * Math.exp(r * T), carry: r, source: 'spot' });
    expect(() => setup([]).forward('NIFTY', WEEKLY)).toThrow(NoLiveData);
    expect(() => setup([spot(0)]).forward('NIFTY', WEEKLY)).toThrow(NoLiveData);
  });

  it('forward: NoLiveData instead of a NaN carry when no spot is live, and once the expiry has passed', () => {
    const fut = q({ symbol: 'NIFTY', kind: 'FUT', expiry: MONTHLY }, 25_180);
    expect(() => setup([fut]).forward('NIFTY', MONTHLY)).toThrow(/No live spot price for NIFTY/);
    expect(() => setup([spot(25_000), fut]).forward('NIFTY', '2026-10-06')).toThrow(/has expired/);
    // Black-76 itself needs no spot: IV off the live future still solves.
    const T = timeToExpiry(MONTHLY, now);
    const premium = black76Price('CE', 25_180, 25_200, T, r, 0.13);
    expect(setup([fut]).iv({ symbol: 'NIFTY', expiry: MONTHLY, type: 'CE', strike: 25_200, premium })).toBeCloseTo(0.13, 6);
  });

  it('treats stale quotes as not live when maxQuoteAgeMs is set', () => {
    const p = setup([spot(25_000, now - 120_000)], { maxQuoteAgeMs: 60_000 });
    expect(() => p.forward('NIFTY', WEEKLY)).toThrow(NoLiveData);
    expect(setup([spot(25_000, now - 120_000)]).forward('NIFTY', WEEKLY).source).toBe('spot');
  });

  it('counts a quote only on the current session date (outside hours also the most recent session)', () => {
    const fri = ist('2026-10-09', 15, 29); // last quote of the previous session
    const thu = ist('2026-10-08', 15, 29);
    const fridaySpot = [spot(25_000, fri)];
    const at = (t: number, quotes: LiveQuote[]) => setup(quotes, { now: () => t });
    // During Monday's session Friday's quote is not live.
    expect(() => at(now, fridaySpot).forward('NIFTY', WEEKLY)).toThrow(NoLiveData);
    // Before Monday's open (and in pre-open), on the weekend: Friday is the most recent session.
    for (const t of [ist('2026-10-12', 8, 0), ist('2026-10-12', 9, 5), ist('2026-10-11', 12, 0), ist('2026-10-10', 1, 0)]) {
      expect(at(t, fridaySpot).forward('NIFTY', WEEKLY).forward).toBeGreaterThan(25_000);
      expect(() => at(t, [spot(25_000, thu)]).forward('NIFTY', WEEKLY)).toThrow(NoLiveData);
    }
    // After Monday's close, Monday is the most recent session: Friday's quote is not live.
    expect(at(ist('2026-10-12', 18, 0), [spot(25_000, ist('2026-10-12', 15, 29))]).forward('NIFTY', WEEKLY).source).toBe('spot');
    expect(() => at(ist('2026-10-12', 18, 0), fridaySpot).forward('NIFTY', WEEKLY)).toThrow(NoLiveData);
    // A holiday Monday: Friday stays the most recent session all day.
    const holiday = new LivePricing({ r, ref, calendar: new ExchangeCalendar(['2026-10-12']), getQuote: (k) => (k.kind === 'SPOT' ? fridaySpot[0] : undefined), now: () => now });
    expect(holiday.forward('NIFTY', WEEKLY).source).toBe('spot');
    // Same rule for option premiums: yesterday's chain gives no ATM IV today.
    const old = chainQuotes(WEEKLY, 25_010, 0.12, 0.12).map((x) => ({ ...x, ts: fri }));
    expect(at(now, [spot(25_000), ...old]).atmIv('NIFTY', WEEKLY)).toBeNull();
  });

  it('a quote dated today whose LTP is an earlier session trade is not a live price (review)', () => {
    const F = 25_061.5;
    const fri = ist('2026-10-09', 15, 20);
    const thu = ist('2026-10-08', 15, 20);
    const live = chainQuotes(WEEKLY, F, 0.12, 0.12);
    const isAtm = (x: LiveQuote) => x.key.strike === 25_000;
    // The 25,000 strike (nearest spot) as the feed reports it when it has not traded today: the
    // update time is today (a book change), the last trade is Friday's at another price.
    const staleCe = live.map((x) => (isAtm(x) && x.key.kind === 'CE' ? { ...x, ltp: 150, ltt: fri, volume: 0 } : x));
    const p = setup([spot(25_020), ...staleCe]);
    // Parity skips it and uses the next pair (25,100), which recovers the true forward.
    expect(p.forward('NIFTY', WEEKLY).forward).toBeCloseTo(F, 6);
    // A REST option-chain leg (stamped when received, no trade time) with no volume today.
    const restLeg = live.map((x) => (isAtm(x) && x.key.kind === 'PE' ? { ...x, ltp: 99, volume: 0 } : x));
    expect(setup([spot(25_020), ...restLeg]).forward('NIFTY', WEEKLY).forward).toBeCloseTo(F, 6);
    // Traded today (volume, today's trade time): used as usual.
    const traded = live.map((x) => (isAtm(x) ? { ...x, ltt: now - 5_000, volume: 1_500 } : x));
    expect(setup([spot(25_020), ...traded]).forward('NIFTY', WEEKLY).forward).toBeCloseTo(F, 6);
    // Before Monday's open Friday is the last session: a Friday trade is live, a Thursday one is not.
    const preOpen = ist('2026-10-12', 9, 5);
    const sp = spot(25_000, preOpen);
    const fut = (ltt: number) => ({ key: { symbol: 'NIFTY', kind: 'FUT' as const, expiry: MONTHLY }, ts: preOpen, ltp: 25_180, ltt, volume: 0 });
    expect(setup([sp, fut(fri)], { now: () => preOpen }).forward('NIFTY', MONTHLY).source).toBe('future');
    expect(setup([sp, fut(thu)], { now: () => preOpen }).forward('NIFTY', MONTHLY).source).toBe('spot');
  });

  it('isLivePrice / liveSessionDates are the shared rule', () => {
    const dates = liveSessionDates(calendar, now);
    expect([...dates]).toEqual(['2026-10-12']);
    expect(isLivePrice({ ts: now }, calendar, dates)).toBe(true);
    expect(isLivePrice({ ts: now, volume: 0 }, calendar, dates)).toBe(false);
    expect(isLivePrice({ ts: now, ltt: ist('2026-10-09', 15, 0) }, calendar, dates)).toBe(false);
    expect(isLivePrice({ ts: ist('2026-10-09', 15, 0) }, calendar, dates)).toBe(false);
    const weekend = liveSessionDates(calendar, ist('2026-10-11', 12, 0));
    expect([...weekend].sort()).toEqual(['2026-10-09', '2026-10-11']);
    expect(isLivePrice({ ts: ist('2026-10-09', 15, 29), ltt: ist('2026-10-09', 15, 29), volume: 10 }, calendar, weekend)).toBe(true);
  });

  it('iv/greeks with a past ts and no forward give null (no look-ahead); a passed forward is used', () => {
    const F = 25_061.5;
    const p = setup([spot(25_020), ...chainQuotes(WEEKLY, F, 0.12, 0.12)]);
    const past = now - 30 * 60_000;
    const Tpast = timeToExpiry(WEEKLY, past);
    const premium = black76Price('CE', F, 25_200, Tpast, r, 0.16);
    expect(p.iv({ symbol: 'NIFTY', expiry: WEEKLY, type: 'CE', strike: 25_200, premium, ts: past })).toBeNull();
    expect(p.greeks({ symbol: 'NIFTY', expiry: WEEKLY, type: 'CE', strike: 25_200, iv: 0.16, ts: past })).toBeNull();
    expect(p.iv({ symbol: 'NIFTY', expiry: WEEKLY, type: 'CE', strike: 25_200, premium, ts: past, forward: F })).toBeCloseTo(0.16, 6);
    expect(p.greeks({ symbol: 'NIFTY', expiry: WEEKLY, type: 'CE', strike: 25_200, iv: 0.16, ts: past, forward: F })?.delta).toBeCloseTo(
      bsGreeks('CE', F, 25_200, Tpast, r, 0.16, r).delta,
      9,
    );
    // A ts of "now" give or take call overhead is live.
    const Tnow = timeToExpiry(WEEKLY, now - 2_000);
    const premiumNow = black76Price('CE', F, 25_200, Tnow, r, 0.16);
    expect(p.iv({ symbol: 'NIFTY', expiry: WEEKLY, type: 'CE', strike: 25_200, premium: premiumNow, ts: now - 2_000 })).toBeCloseTo(0.16, 6);
  });

  it('iv/greeks: solves market premiums off the live forward, never a fixed IV', () => {
    const F = 25_061.5;
    const T = timeToExpiry(WEEKLY, now);
    const p = setup([spot(25_020), ...chainQuotes(WEEKLY, F, 0.12, 0.12)]);
    const premium = black76Price('CE', F, 25_200, T, r, 0.175);
    expect(p.iv({ symbol: 'NIFTY', expiry: WEEKLY, type: 'CE', strike: 25_200, premium })).toBeCloseTo(0.175, 6);
    expect(p.iv({ symbol: 'NIFTY', expiry: WEEKLY, type: 'CE', strike: 24_000, premium: 900 })).toBeNull(); // below intrinsic
    expect(p.iv({ symbol: 'NIFTY', expiry: WEEKLY, type: 'CE', strike: 25_000, premium: 120, forward: 25_000 })).toBeCloseTo(
      black76Iv('CE', 120, 25_000, 25_000, T, r) as number,
      12,
    );
    const g = p.greeks({ symbol: 'NIFTY', expiry: WEEKLY, type: 'PE', strike: 25_000, iv: 0.15 });
    expect(g?.delta).toBeCloseTo(bsGreeks('PE', F, 25_000, T, r, 0.15, r).delta, 6);
    // No forward at all → null, not a guess.
    const empty = setup([]);
    expect(empty.iv({ symbol: 'NIFTY', expiry: WEEKLY, type: 'CE', strike: 25_000, premium: 120 })).toBeNull();
    expect(empty.greeks({ symbol: 'NIFTY', expiry: WEEKLY, type: 'CE', strike: 25_000, iv: 0.12 })).toBeNull();
  });

  it('atmIv: nearest unexpired expiry, CE/PE average at the strike nearest the forward', () => {
    // Spot sits at 24,890, so parity uses 24,900 (consistent CE/PE there) and recovers F = 25,010;
    // the ATM strike nearest F is 25,000, where CE and PE trade at different vols (0.11 / 0.13).
    const ce = (K: number) => (K === 25_000 ? 0.11 : 0.12);
    const pe = (K: number) => (K === 25_000 ? 0.13 : 0.12);
    const p = setup([spot(24_890), ...chainQuotes(WEEKLY, 25_010, ce, pe), ...chainQuotes(MONTHLY, 25_150, 0.14, 0.14)]);
    expect(p.forward('NIFTY', WEEKLY).forward).toBeCloseTo(25_010, 6);
    expect(p.atmIv('NIFTY')).toBeCloseTo(0.12, 6); // 2026-10-06 has expired, so the weekly is nearest
    expect(p.atmIv('NIFTY', MONTHLY)).toBeCloseTo(0.14, 6);
  });

  it('atmIv: null when no premium is live or the master is not loaded', () => {
    expect(setup([spot(25_000)]).atmIv('NIFTY')).toBeNull();
    expect(setup([]).atmIv('NIFTY')).toBeNull();
    const p = new LivePricing({ r, ref: new FakeRef({}, {}, false), calendar, getQuote: () => undefined, now: () => now });
    expect(p.atmIv('NIFTY')).toBeNull();
    expect(p.atmIv('NIFTY', WEEKLY)).toBeNull();
  });

  it('chainAtmIv ignores a future of another expiry', () => {
    const T = timeToExpiry(WEEKLY, now);
    const F = 25_040;
    const chain: RawChain = {
      symbol: 'NIFTY',
      expiry: WEEKLY,
      ts: now,
      spot: spot(25_000),
      future: q({ symbol: 'NIFTY', kind: 'FUT', expiry: MONTHLY }, 25_300),
      rows: [25_000, 25_100].map((K) => ({
        strike: K,
        ce: opt('CE', WEEKLY, K, black76Price('CE', F, K, T, r, 0.12)),
        pe: opt('PE', WEEKLY, K, black76Price('PE', F, K, T, r, 0.12)),
      })),
    };
    const out = chainAtmIv(chain, r);
    expect(out?.forward.source).toBe('parity');
    expect(out?.forward.forward).toBeCloseTo(F, 6);
    expect(out?.iv).toBeCloseTo(0.12, 6);
  });
});

describe('valuation time (review: IV/Greeks/carry drifted outside the session on unchanged premiums)', () => {
  const r = 0.065;
  const cal = new ExchangeCalendar(); // 2026-10-09 Fri, 10-12 Mon … 10-16 Fri, 10-19 Mon, 10-20 Tue
  const friClose = ist('2026-10-09', 15, 30);

  it('valuationTs: now while the session is open, else the close of the session whose quotes are live', () => {
    expect(valuationTs(cal, ist('2026-10-09', 15, 29))).toBe(ist('2026-10-09', 15, 29));
    expect(valuationTs(cal, ist('2026-10-12', 9, 15))).toBe(ist('2026-10-12', 9, 15));
    const outside = [ist('2026-10-09', 15, 30), ist('2026-10-09', 18, 0), ist('2026-10-10', 12, 0), ist('2026-10-11', 23, 59), ist('2026-10-12', 0, 1), ist('2026-10-12', 9, 5), ist('2026-10-12', 9, 14)];
    for (const t of outside) {
      expect(valuationTs(cal, t)).toBe(friClose);
      // The same session liveSessionDates treats as live.
      expect(liveSessionDates(cal, t).has('2026-10-09')).toBe(true);
    }
    expect(valuationTs(cal, ist('2026-10-12', 16, 0))).toBe(ist('2026-10-12', 15, 30));
    // A holiday Monday: Friday's close until Tuesday's open.
    const hol = new ExchangeCalendar(['2026-10-12']);
    expect(valuationTs(hol, ist('2026-10-12', 11, 0))).toBe(friClose);
    expect(valuationTs(hol, ist('2026-10-13', 9, 0))).toBe(friClose);
    expect(valuationTs(hol, ist('2026-10-13', 9, 30))).toBe(ist('2026-10-13', 9, 30));
  });

  it('premiumTs: an LTP at its own trade time of a live session, capped by the valuation time', () => {
    const now = ist('2026-10-12', 14, 0);
    expect(premiumTs(cal, now, now, ist('2026-10-12', 10, 0))).toBe(ist('2026-10-12', 10, 0));
    expect(premiumTs(cal, now, now)).toBe(now); // a mid, or an LTP without a trade time
    expect(premiumTs(cal, now, now, Number.NaN)).toBe(now);
    expect(premiumTs(cal, now, now, ist('2026-10-09', 15, 0))).toBe(now); // not a trade of a live session
    expect(premiumTs(cal, now, now, now + 60_000)).toBe(now); // capped
    const sun = ist('2026-10-11', 12, 0);
    expect(premiumTs(cal, sun, friClose, ist('2026-10-09', 11, 0))).toBe(ist('2026-10-09', 11, 0));
    expect(premiumTs(cal, sun, friClose, ist('2026-10-12', 9, 5))).toBe(friClose); // a pre-open trade after the close is capped
  });

  it('LivePricing: unchanged Friday premiums give the same forward, carry, ATM IV, IV and Greeks after the close, on the weekend and before the open', () => {
    const EXP = '2026-10-20';
    const strikes = [24_800, 24_900, 25_000, 25_100, 25_200];
    const ref = new FakeRef({ [`NIFTY|${EXP}`]: strikes }, { 'NIFTY|OPT': [EXP], 'NIFTY|FUT': [] });
    const fri = ist('2026-10-16', 15, 29);
    const F = 25_030;
    const T = timeToExpiry(EXP, fri);
    const quotes: LiveQuote[] = [{ key: { symbol: 'NIFTY', kind: 'SPOT' }, ts: fri, ltp: 25_000 }];
    for (const K of strikes) for (const type of ['CE', 'PE'] as OptKind[]) quotes.push({ key: { symbol: 'NIFTY', kind: type, expiry: EXP, strike: K }, ts: fri, ltp: black76Price(type, F, K, T, r, 0.14) });
    const map = new Map(quotes.map((x) => [keyId(x.key), x]));
    let t = fri;
    const p = new LivePricing({ r, ref, calendar: cal, getQuote: (k) => map.get(keyId(k)), now: () => t });
    const premium = black76Price('CE', F, 25_200, T, r, 0.14);
    const read = () => ({
      fwd: p.forward('NIFTY', EXP),
      atm: p.atmIv('NIFTY') as number,
      iv: p.iv({ symbol: 'NIFTY', expiry: EXP, type: 'CE', strike: 25_200, premium }) as number,
      theta: (p.greeks({ symbol: 'NIFTY', expiry: EXP, type: 'CE', strike: 25_000, iv: 0.14 }) as { theta: number }).theta,
    });
    const base = read();
    expect(base.atm).toBeCloseTo(0.14, 6);
    expect(base.iv).toBeCloseTo(0.14, 6);
    const friClose16 = ist('2026-10-16', 15, 30);
    for (const when of [ist('2026-10-16', 16, 0), ist('2026-10-18', 12, 0), ist('2026-10-19', 9, 5)]) {
      t = when;
      expect(p.valuationTs()).toBe(friClose16);
      const v = read();
      // One minute (15:29 → the 15:30 close) apart, nothing more.
      expect(v.fwd.forward).toBeCloseTo(base.fwd.forward, 4);
      expect(v.fwd.carry).toBeCloseTo(base.fwd.carry, 4);
      expect(v.atm).toBeCloseTo(base.atm, 4);
      expect(v.iv).toBeCloseTo(base.iv, 4);
      expect(v.theta).toBeCloseTo(base.theta, 1);
      // No look-ahead: a session ts before the close needs its own forward; a weekend ts is the close.
      expect(p.iv({ symbol: 'NIFTY', expiry: EXP, type: 'CE', strike: 25_200, premium, ts: ist('2026-10-16', 12, 0) })).toBeNull();
      expect(p.iv({ symbol: 'NIFTY', expiry: EXP, type: 'CE', strike: 25_200, premium, ts: ist('2026-10-17', 10, 0) })).toBeCloseTo(v.iv, 9);
    }
    // An LTP traded at 11:00 on Friday is valued at 11:00.
    t = ist('2026-10-18', 12, 0);
    const at11 = black76Price('CE', F, 25_200, timeToExpiry(EXP, ist('2026-10-16', 11, 0)), r, 0.16);
    expect(p.valuationTs(undefined, ist('2026-10-16', 11, 0))).toBe(ist('2026-10-16', 11, 0));
    expect(p.iv({ symbol: 'NIFTY', expiry: EXP, type: 'CE', strike: 25_200, premium: at11, ltt: ist('2026-10-16', 11, 0) })).toBeCloseTo(0.16, 3);
  });
});
