/**
 * Adversarial verification of the Phase C follow-up fixes (valuation time, as-of recorder checks, feed
 * gaps, day orders). Every price here is TEST data from the FakeProvider sample book or built in the
 * test (Black-76 at stated vols); nothing is market data.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { istTs, type OptionChain } from '@q26/core';
import { ExchangeCalendar } from '../src/live/calendar';
import { black76Price, liveSessionDates, premiumTs, timeToExpiry, valuationTs } from '../src/live/pricing';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createServices, type Services } from '../src/services';
import { Analytics } from '../src/services/analytics';
import { buildOptionChain, futKey, futuresQuotesAt, optKey, spotKey, underlyingQuoteAt } from '../src/services/live';
import { Pricer } from '../src/services/pricer';
import { PaperBroker } from '../src/services/trading';
import { Db } from '../src/store/db';
import type { MinuteRecord } from '../src/live/types';
import { FakeProvider, loadSampleBook } from './support/fake-provider';

const providers: FakeProvider[] = [];
afterEach(() => {
  for (const p of providers.splice(0)) p.dispose();
});

const MIN = 60_000;
const hm = (date: string, hhmm: string) => istTs(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)));
const r2 = (v: number) => Math.round(v * 100) / 100;
const tick = (v: number) => Math.round(v / 0.05) * 0.05;

const THU = '2026-10-15';
const FRI = '2026-10-16';
const SAT = '2026-10-17';
const SUN = '2026-10-18';
const MON = '2026-10-19';
const TUE = '2026-10-20';

/** Every number nested in `v` is finite (no NaN / Infinity leaks into an API answer). */
function nonFinite(v: unknown, path = '$'): string[] {
  if (typeof v === 'number') return Number.isFinite(v) ? [] : [`${path}=${v}`];
  if (Array.isArray(v)) return v.flatMap((x, i) => nonFinite(x, `${path}[${i}]`));
  if (v && typeof v === 'object') return Object.entries(v).flatMap(([k, x]) => nonFinite(x, `${path}.${k}`));
  return [];
}

/* ------------------------------------------------------------------------------------------ */
/* A. valuation time across calendars                                                           */
/* ------------------------------------------------------------------------------------------ */

describe('valuationTs / liveSessionDates / premiumTs over holidays and long weekends', () => {
  // Friday 16 Oct is a holiday: the last session before the long weekend is Thursday 15 Oct.
  const holFri = new ExchangeCalendar([FRI]);
  // Monday 19 Oct and Tuesday 20 Oct are holidays: Friday 16 Oct is the last session until Wednesday.
  const holMonTue = new ExchangeCalendar([MON, TUE]);

  it('Friday-holiday long weekend: Thursday 15:30 from Thursday 15:30 until Monday 09:15', () => {
    const thuClose = hm(THU, '15:30');
    for (const t of [hm(THU, '15:30'), hm(THU, '15:31'), hm(THU, '23:59'), hm(FRI, '10:00'), hm(SAT, '12:00'), hm(SUN, '23:59'), hm(MON, '00:00'), hm(MON, '09:00'), hm(MON, '09:14')]) {
      expect(valuationTs(holFri, t), new Date(t).toISOString()).toBe(thuClose);
      expect([...liveSessionDates(holFri, t)].sort(), new Date(t).toISOString()).toContain(THU);
    }
    // The session itself: valued now.
    expect(valuationTs(holFri, hm(MON, '09:15'))).toBe(hm(MON, '09:15'));
    expect(valuationTs(holFri, hm(MON, '15:29'))).toBe(hm(MON, '15:29'));
    // Monday after the close: Monday's close.
    expect(valuationTs(holFri, hm(MON, '15:30'))).toBe(hm(MON, '15:30'));
    // Thursday before the close: now.
    expect(valuationTs(holFri, hm(THU, '15:29'))).toBe(hm(THU, '15:29'));
  });

  it('Monday+Tuesday holidays: Friday 15:30 until Wednesday 09:15; the live dates never include a day with no session', () => {
    const friClose = hm(FRI, '15:30');
    for (const t of [hm(FRI, '15:30'), hm(SAT, '03:00'), hm(SUN, '12:00'), hm(MON, '12:00'), hm(TUE, '09:05'), hm(TUE, '15:45'), hm('2026-10-21', '09:14')]) {
      expect(valuationTs(holMonTue, t), new Date(t).toISOString()).toBe(friClose);
      const dates = liveSessionDates(holMonTue, t);
      expect(dates.has(FRI), new Date(t).toISOString()).toBe(true);
    }
    expect(valuationTs(holMonTue, hm('2026-10-21', '09:15'))).toBe(hm('2026-10-21', '09:15'));
    // Never later than the clock, never later than the close of a started session.
    for (let t = hm(THU, '00:00'); t < hm('2026-10-22', '00:00'); t += 17 * MIN) {
      const v = valuationTs(holMonTue, t);
      expect(v).toBeLessThanOrEqual(t);
      expect(t - v).toBeLessThan(5 * 24 * 60 * MIN);
    }
  });

  it('is monotone non-decreasing in time and idempotent (a valuation time is its own valuation time)', () => {
    for (const cal of [holFri, holMonTue, new ExchangeCalendar()]) {
      let prev = -Infinity;
      for (let t = hm(THU, '00:00'); t < hm('2026-10-23', '00:00'); t += 7 * MIN) {
        const v = valuationTs(cal, t);
        expect(v).toBeGreaterThanOrEqual(prev);
        expect(valuationTs(cal, v)).toBe(v);
        prev = v;
      }
    }
  });

  it('premiumTs: an LTT of the previous session is used pre-open (capped at the valuation time); a pre-open LTT before the open is capped back; junk LTTs fall back to the valuation time', () => {
    const cal = new ExchangeCalendar();
    const now = hm(MON, '09:05');
    const val = valuationTs(cal, now); // Friday 15:30
    expect(val).toBe(hm(FRI, '15:30'));
    expect(premiumTs(cal, now, val, hm(FRI, '15:20'))).toBe(hm(FRI, '15:20'));
    expect(premiumTs(cal, now, val, hm(MON, '09:03'))).toBe(val); // a pre-open trade is capped back to the previous close
    expect(premiumTs(cal, now, val, hm(THU, '12:00'))).toBe(val); // Thursday is no live session
    expect(premiumTs(cal, now, val, Number.NaN)).toBe(val);
    expect(premiumTs(cal, now, val, Infinity)).toBe(val);
    expect(premiumTs(cal, now, val, -1)).toBe(val);
    expect(premiumTs(cal, now, val, undefined)).toBe(val);
    // Open session: an LTT of today is itself; of yesterday it is not a live trade at all.
    const open = hm(MON, '11:00');
    expect(premiumTs(cal, open, valuationTs(cal, open), hm(MON, '10:00'))).toBe(hm(MON, '10:00'));
    expect(premiumTs(cal, open, open, hm(FRI, '15:20'))).toBe(open);
    // Clock skew: an LTT ahead of the clock is capped at the valuation time.
    expect(premiumTs(cal, open, open, hm(MON, '11:00') + 30_000)).toBe(open);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* B. end-to-end across holiday / long weekend / expiry day                                     */
/* ------------------------------------------------------------------------------------------ */

function setup(opts: { date?: string; time?: string; holidays?: string[] } = {}) {
  const p = new FakeProvider({ holidays: opts.holidays });
  providers.push(p);
  const book = loadSampleBook(p, { date: opts.date ?? FRI, time: opts.time ?? '15:29' });
  const db = new Db(null);
  const pricer = new Pricer(p);
  const an = new Analytics(p, pricer);
  return { p, book, db, pricer, an, w1: book.expiries.NIFTY[0], m1: book.expiries.NIFTY[1] };
}

/** TEST DATA: NIFTY spot and the weekly chain quoted at `at` at a flat `vol`. */
function quoteWeekly(p: FakeProvider, w1: string, at: number, vol: number, spot = 25_000, extra: Record<string, unknown> = {}) {
  const r = p.pricing.r;
  const T = timeToExpiry(w1, at);
  const F = spot * Math.exp((r - 0.01) * T);
  p.setQuote(spotKey('NIFTY'), { ltp: spot, prevClose: 25_000, ts: at });
  for (const K of p.ref.strikes('NIFTY', w1)) {
    for (const type of ['CE', 'PE'] as const) {
      const price = tick(black76Price(type, F, K, T, r, vol));
      if (!(price >= 0.1)) continue;
      p.setQuote(optKey('NIFTY', w1, type, K), { ltp: r2(price), bid: r2(price - 0.05), ask: r2(price + 0.05), volume: 10_000, oi: 50_000, ts: at, ...extra });
    }
  }
}

const leg = (c: OptionChain, strike: number, side: 'ce' | 'pe' = 'ce') => c.rows.find((x) => x.strike === strike)![side];

describe('end to end over a holiday and a long weekend', () => {
  it('Monday holiday: Friday 15:29 premiums give the same ATM IV / carry / theta on Saturday, Monday (holiday) and Tuesday 09:05 (expiry morning); no NaN anywhere', async () => {
    const { p, w1 } = setup({ holidays: [MON] });
    expect(w1).toBe(TUE);
    const read = async () => {
      const c = await buildOptionChain(p, 'NIFTY', w1);
      return { c, atmIv: c.atmIv as number, carry: c.carry as number, theta: leg(c, 25_000).theta as number };
    };
    const fri = await read();
    expect(fri.atmIv).toBeCloseTo(14, 1);
    for (const t of [hm(SAT, '10:00'), hm(MON, '12:00'), hm(TUE, '09:05'), hm(TUE, '09:14')]) {
      p.setNow(t);
      const v = await read();
      expect(v.c.valuationTs, new Date(t).toISOString()).toBe(hm(FRI, '15:30'));
      expect(Math.abs(v.atmIv - fri.atmIv)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(v.carry - fri.carry)).toBeLessThan(1e-4);
      expect(Math.abs(v.theta - fri.theta)).toBeLessThan(0.05);
      expect(nonFinite(v.c)).toEqual([]);
    }
    // The same holiday, the Friday-evening values equal those of Friday 16:00 (not drifting with the hours).
    p.setNow(hm(FRI, '16:00'));
    const a = await read();
    p.setNow(hm(FRI, '23:30'));
    const b = await read();
    expect(b.atmIv).toBe(a.atmIv);
    expect(b.theta).toBe(a.theta);
  });

  it('Friday holiday (long weekend): Thursday 15:29 premiums are valued at Thursday 15:30 on Friday, Saturday, Sunday and Monday pre-open', async () => {
    const { p, w1 } = setup({ date: THU, holidays: [FRI] });
    const thu = await buildOptionChain(p, 'NIFTY', w1);
    for (const t of [hm(FRI, '11:00'), hm(SAT, '11:00'), hm(SUN, '23:59'), hm(MON, '09:10')]) {
      p.setNow(t);
      const c = await buildOptionChain(p, 'NIFTY', w1);
      expect(c.valuationTs, new Date(t).toISOString()).toBe(hm(THU, '15:30'));
      expect(Math.abs((c.atmIv as number) - (thu.atmIv as number))).toBeLessThanOrEqual(0.01);
      expect(c.daysToExpiry).toBeCloseTo(thu.daysToExpiry, 2);
    }
    // Monday 09:15: Thursday's quotes are no longer live.
    p.setNow(hm(MON, '09:15'));
    await expect(buildOptionChain(p, 'NIFTY', w1)).rejects.toThrow(/No live quotes/);
  });

  it('expiry day: before the close the IV is finite; from 15:30 the expired contract is a 400 (not NaN) and the next expiry is valued at the close', async () => {
    const { p, w1, m1 } = setup({ date: MON, time: '15:29' });
    expect(w1).toBe(TUE);
    // Tuesday (expiry day) 15:20: new weekly premiums at 14 %, ten minutes to the expiry.
    const t1520 = hm(TUE, '15:20');
    p.setNow(t1520);
    quoteWeekly(p, w1, t1520, 0.14);
    const c = await buildOptionChain(p, 'NIFTY', w1);
    expect(c.valuationTs).toBe(t1520);
    expect(nonFinite(c)).toEqual([]);
    expect(c.daysToExpiry).toBe(0.01); // 10 minutes, rounded to 2 decimals
    expect(c.atmIv as number).toBeGreaterThan(5);
    expect(c.atmIv as number).toBeLessThan(30);
    // 15:29:30: thirty seconds left.
    p.setNow(hm(TUE, '15:29') + 30_000);
    const late = await buildOptionChain(p, 'NIFTY', w1);
    expect(nonFinite(late)).toEqual([]);
    // Exactly the close, and after it.
    for (const t of [hm(TUE, '15:30'), hm(TUE, '16:00'), hm('2026-10-21', '09:05')]) {
      p.setNow(t);
      await expect(buildOptionChain(p, 'NIFTY', w1), new Date(t).toISOString()).rejects.toMatchObject({ statusCode: 400 });
      expect(() => p.pricing.forward('NIFTY', w1)).toThrow(/expired/);
      expect(p.pricing.atmIv('NIFTY', w1)).toBeNull();
      // The nearest-expiry choice skips the expired weekly.
      const near = p.pricing.atmIv('NIFTY');
      expect(near === null || Number.isFinite(near)).toBe(true);
    }
    // The monthly after the weekly's expiry, evaluated at the Tuesday close: its valuation time is 15:30, T finite.
    p.setNow(hm(TUE, '16:00'));
    expect(p.pricing.valuationTs()).toBe(hm(TUE, '15:30'));
    expect(timeToExpiry(m1, p.pricing.valuationTs())).toBeGreaterThan(0);
  });
});

describe('pre-open (09:00-09:15)', () => {
  it('a pre-open spot / future is not combined with Friday premiums: the IV is Friday\'s, the forward is Friday\'s, the carry is unknown with the reason (not an overnight gap read as carry)', async () => {
    const { p, w1, m1 } = setup();
    const fri = await buildOptionChain(p, 'NIFTY', w1);
    const friM = await buildOptionChain(p, 'NIFTY', m1);
    expect(fri.carry).toBeCloseTo(0.01, 3);
    // Monday 09:05: the index spot ticks in the pre-open (indicative open, +0.2 %); 09:10 the monthly future prints 0.5 % above Friday's.
    p.setNow(hm(MON, '09:10'));
    p.setQuote(spotKey('NIFTY'), { ltp: 25_050, prevClose: 25_000, ts: hm(MON, '09:05') });
    p.setQuote(futKey('NIFTY', m1), { ltp: r2((friM.forward as number) * 1.005), ts: hm(MON, '09:10') });
    for (const [expiry, base] of [[w1, fri], [m1, friM]] as const) {
      const c = await buildOptionChain(p, 'NIFTY', expiry);
      expect(c.valuationTs).toBe(hm(FRI, '15:30'));
      expect(nonFinite(c)).toEqual([]);
      // The spot is shown (a live price with its time) …
      expect(c.spot).toBe(25_050);
      expect(c.spotTs).toBe(hm(MON, '09:05'));
      // … but Friday's premiums are solved against Friday's forward: IVs unchanged, carry unknown (spot and forward are two moments).
      expect(Math.abs((c.atmIv as number) - (base.atmIv as number)), expiry).toBeLessThanOrEqual(0.02);
      expect(leg(c, 25_000).iv, expiry).toBeCloseTo(leg(base, 25_000).iv as number, 1);
      expect(c.forwardSource, expiry).toBe('parity');
      expect(Math.abs((c.forward as number) - (base.forward as number)), expiry).toBeLessThan(base.forward! * 0.0005);
      expect(c.carry, expiry).toBeNull();
      expect(c.gaps?.carry, expiry).toMatch(/pre-open/);
    }
    expect(p.pricing.atmIv('NIFTY', m1)).toBeCloseTo(friM.atmIv! / 100, 3);
    // The session opens: only now is the pre-open future the forward (valued now, with new premiums).
    p.setNow(hm(MON, '09:16'));
    p.setQuote(futKey('NIFTY', m1), { ltp: r2((friM.forward as number) * 1.005), ts: hm(MON, '09:16') });
    expect(p.pricing.forward('NIFTY', m1).source).toBe('future');
  });

  it('funds in the pre-open: the margin of a short option is Friday\'s estimate while the spot is Friday\'s, and blank with the reason (not an error) once a pre-open spot print is the only spot', () => {
    const { p, db, pricer, w1 } = setup();
    const broker = new PaperBroker(p, db, pricer, () => p.now(), () => undefined, () => undefined);
    expect(broker.place('u1', { symbol: 'NIFTY', type: 'CE', strike: 25_000, expiry: w1, side: 'SELL', lots: 1, orderType: 'MARKET', product: 'NRML' }).status).toBe('COMPLETE');
    const fri = broker.funds('u1').usedMargin as number;
    expect(fri).toBeGreaterThan(0);
    p.setNow(hm(MON, '09:05'));
    expect(broker.funds('u1').usedMargin).toBeCloseTo(fri, -2);
    p.setQuote(spotKey('NIFTY'), { ltp: 25_050, prevClose: 25_000, ts: hm(MON, '09:05') });
    const f = broker.funds('u1');
    expect(f.usedMargin).toBeNull();
    expect(f.gaps?.margin).toMatch(/pre-open/);
    p.setNow(hm(MON, '09:16'));
    p.setQuote(spotKey('NIFTY'), { ltp: 25_052, prevClose: 25_000, ts: hm(MON, '09:16') });
    quoteWeekly(p, w1, hm(MON, '09:16'), 0.15, 25_052);
    expect(broker.funds('u1').usedMargin).toBeGreaterThan(0);
  });

  it('an LTP with an LTT of the previous session is not a live price once the session is open, and is valued at its own trade time in the pre-open', async () => {
    const { p, w1 } = setup();
    const key = optKey('NIFTY', w1, 'CE', 25_000);
    const ltt = hm(FRI, '15:20');
    // Pre-open Monday 09:05: the Friday 15:20 trade is still the live (last) one, valued at 15:20 (not 15:30).
    p.setNow(hm(MON, '09:05'));
    p.live.clearQuote(key);
    p.setQuote(key, { ltp: 150, ltt, volume: 5_000, oi: 40_000, ts: hm(FRI, '15:29') });
    const pre = await buildOptionChain(p, 'NIFTY', w1);
    expect(leg(pre, 25_000)).toMatchObject({ ltp: 150, ivSource: 'ltp', ivTs: ltt });
    // Monday 10:00: the quote arrives stamped today (a REST refresh) but its last trade is Friday's: not a price.
    p.setNow(hm(MON, '10:00'));
    quoteWeekly(p, w1, hm(MON, '10:00'), 0.15);
    p.live.clearQuote(key);
    p.setQuote(key, { ltp: 150, ltt, volume: 5_000, ts: hm(MON, '10:00') });
    const open = await buildOptionChain(p, 'NIFTY', w1);
    expect(leg(open, 25_000)).toMatchObject({ ltp: null, iv: null, ivSource: null, ivTs: null });
    // The price API agrees: no IV from yesterday's trade.
    expect(new Pricer(p).price({ symbol: 'NIFTY', type: 'CE', strike: 25_000, expiry: w1 })).toMatchObject({ ltp: null, iv: null });
  });
});

describe('LTP from an old trade in the open session', () => {
  it('an LTT from the future (clock skew) is capped at the valuation time; an LTT at the very open is its own time', async () => {
    const { p, w1 } = setup({ date: '2026-10-12', time: '14:00' });
    const now = hm('2026-10-12', '14:00');
    const key = optKey('NIFTY', w1, 'CE', 25_200);
    const F = (await buildOptionChain(p, 'NIFTY', w1)).forward as number;
    const prem = r2(black76Price('CE', F, 25_200, timeToExpiry(w1, now), p.pricing.r, 0.16));
    p.live.clearQuote(key);
    p.setQuote(key, { ltp: prem, ltt: now + 20_000, volume: 2_000, oi: 40_000, ts: now });
    const skew = await buildOptionChain(p, 'NIFTY', w1);
    expect(leg(skew, 25_200).ivTs).toBe(now);
    p.live.clearQuote(key);
    const open = hm('2026-10-12', '09:15');
    p.setQuote(key, { ltp: prem, ltt: open, volume: 2_000, oi: 40_000, ts: now });
    const atOpen = await buildOptionChain(p, 'NIFTY', w1);
    expect(leg(atOpen, 25_200).ivTs).toBe(open);
    expect(nonFinite(atOpen)).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* C. as-of boundaries                                                                          */
/* ------------------------------------------------------------------------------------------ */

describe('?at= at the first and last recorded minute', () => {
  it('chain, quote and futures: first minute not yet completed -> 503; first completed -> answer; last completed (15:30) and after the close -> the 15:29 minute; the recorder stopping gives the boundary at +2 min', async () => {
    const { p, book } = setup({ date: '2026-10-12', time: '11:00' });
    const d = book.recordedDate;
    const w1 = book.expiries.NIFTY[0];
    // The recorded session starts at 09:15 and ends with the 15:29 minute.
    await expect(buildOptionChain(p, 'NIFTY', w1, { at: hm(d, '09:15') })).rejects.toMatchObject({ name: 'NoLiveData' });
    expect(() => underlyingQuoteAt(p, 'NIFTY', hm(d, '09:15'))).toThrow(/No recorded NIFTY price/);
    const first = await buildOptionChain(p, 'NIFTY', w1, { at: hm(d, '09:16') });
    expect(first.spotTs).toBe(hm(d, '09:15'));
    expect(underlyingQuoteAt(p, 'NIFTY', hm(d, '09:16')).ts).toBe(hm(d, '09:15'));
    expect(futuresQuotesAt(p, 'NIFTY', hm(d, '09:16'))[0].ts).toBe(hm(d, '09:15'));
    for (const hhmm of ['15:30', '15:31', '16:00', '23:59']) {
      const c = await buildOptionChain(p, 'NIFTY', w1, { at: hm(d, hhmm) });
      expect(c.spotTs, hhmm).toBe(hm(d, '15:29'));
      expect(c.valuationTs, hhmm).toBe(hm(d, '15:30'));
      expect(underlyingQuoteAt(p, 'NIFTY', hm(d, hhmm)).ts, hhmm).toBe(hm(d, '15:29'));
      expect(futuresQuotesAt(p, 'NIFTY', hm(d, hhmm))[0].ts, hhmm).toBe(hm(d, '15:29'));
      expect(nonFinite(c)).toEqual([]);
    }
    // 15:29:59.999 is inside the last minute: only the 15:28 minute is complete (still near).
    const justBefore = await buildOptionChain(p, 'NIFTY', w1, { at: hm(d, '15:30') - 1 });
    expect(justBefore.spotTs).toBe(hm(d, '15:28'));
    // A recorder that stopped after the 11:59 minute (BANKNIFTY here): near through 12:01:59, 503 from 12:02:00.
    const e = book.expiries.BANKNIFTY[0];
    const rec = (from: string, to: string): MinuteRecord[] => {
      const out: MinuteRecord[] = [];
      for (let t = hm(d, from); t < hm(d, to); t += MIN) out.push({ ts: t, open: 56000, high: 56001, low: 55999, close: 56000, traded: true });
      return out;
    };
    p.intraday.addMinutes(spotKey('BANKNIFTY'), rec('09:15', '12:00'));
    for (const type of ['CE', 'PE'] as const) p.intraday.addMinutes(optKey('BANKNIFTY', e, type, 56000), rec('09:15', '12:00').map((r) => ({ ...r, close: 800, open: 800, high: 800, low: 800, oi: 50_000 })));
    expect((await buildOptionChain(p, 'BANKNIFTY', e, { at: hm(d, '12:01') + 59_999 })).spotTs).toBe(hm(d, '11:59'));
    await expect(buildOptionChain(p, 'BANKNIFTY', e, { at: hm(d, '12:02') })).rejects.toThrow(/Nothing recorded for BANKNIFTY at 12:02 .*last recorded minute 11:59.*not running/);
  });

  it('a chain with recorded books: ?at=18:00 equals ?at=15:30 (same books, same IV source), not a bookless re-derivation', async () => {
    const { p, book } = setup({ date: '2026-10-12', time: '11:00' });
    const d = book.recordedDate;
    const w1 = book.expiries.NIFTY[0];
    // Re-record the 25000 CE/PE of the last minute with a two-sided book.
    for (const type of ['CE', 'PE'] as const) {
      const key = optKey('NIFTY', w1, type, 25_000);
      const last = p.intraday.bars(key, d).at(-1) as MinuteRecord;
      p.intraday.addMinutes(key, [{ ...last, bid: last.close - 0.5, ask: last.close + 0.5 }]);
    }
    const close = await buildOptionChain(p, 'NIFTY', w1, { at: hm(d, '15:30') });
    const evening = await buildOptionChain(p, 'NIFTY', w1, { at: hm(d, '18:00') });
    const a = leg(close, 25_000);
    const b = leg(evening, 25_000);
    expect(a.ivSource).toBe('mid');
    expect(b.ivSource).toBe(a.ivSource);
    expect([b.bid, b.ask, b.iv]).toEqual([a.bid, a.ask, a.iv]);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* D. day-order expiry straddle                                                                 */
/* ------------------------------------------------------------------------------------------ */

describe('day orders around the close', () => {
  function brokerSetup(opts: { date?: string; time?: string; holidays?: string[] } = {}) {
    const s = setup({ date: opts.date ?? '2026-10-12', time: opts.time ?? '15:20', holidays: opts.holidays });
    const broker = new PaperBroker(s.p, s.db, s.pricer, () => s.p.now(), () => undefined, () => undefined);
    return { ...s, broker };
  }
  const buyReq = (w1: string, price: number) => ({ symbol: 'NIFTY', type: 'CE' as const, strike: 25_000, expiry: w1, side: 'BUY' as const, lots: 1, orderType: 'LIMIT' as const, price, product: 'NRML' as const });

  it('placed 15:29:50, a fresh crossing book at 15:29:58 fills; the same order not filled by 15:30:00 is cancelled "Day order expired" and never fills afterwards', () => {
    const { p, broker, w1 } = brokerSetup();
    const key = optKey('NIFTY', w1, 'CE', 25_000);
    const ask = (p.live.quote(key) as { ask: number }).ask;
    // Limit below the ask: working.
    p.setNow(hm('2026-10-12', '15:29') + 50_000);
    const o = broker.place('u1', buyReq(w1, tick(ask - 5)));
    expect(o.status).toBe('OPEN');
    broker.tick();
    expect(o.status).toBe('OPEN');
    // 15:30:00: expired, with the reason.
    p.setNow(hm('2026-10-12', '15:30'));
    broker.tick();
    expect(o).toMatchObject({ status: 'CANCELLED', message: 'Day order expired' });
    // A later (next-session) book that would cross never revives it.
    p.setNow(hm('2026-10-13', '10:00'));
    p.setQuote(key, { ltp: ask, bid: tick(ask - 8), ask: tick(ask - 6), volume: 1, ts: hm('2026-10-13', '10:00') });
    broker.tick();
    expect(o.status).toBe('CANCELLED');
  });

  it('placed 15:29:59.999 with a crossing book it fills; at 15:30:00.000 the book is not live and the order expires', () => {
    const { p, broker, w1 } = brokerSetup({ time: '15:29' });
    const key = optKey('NIFTY', w1, 'CE', 25_000);
    const ask = (p.live.quote(key) as { ask: number }).ask;
    p.setNow(hm('2026-10-12', '15:30') - 1);
    p.setQuote(key, { ts: hm('2026-10-12', '15:30') - 1, ltp: ask });
    const filled = broker.place('u1', buyReq(w1, ask));
    expect(filled.status).toBe('COMPLETE');
    const working = broker.place('u1', buyReq(w1, tick(ask - 10)));
    expect(working.status).toBe('OPEN');
    p.setNow(hm('2026-10-12', '15:30'));
    broker.tick();
    expect(working.status).toBe('CANCELLED');
  });

  it('placed after the close on Friday it lives through the weekend to Monday 15:30 (not cancelled at 09:15 Monday, cancelled after Monday 15:30); a holiday Monday moves the end to Tuesday', () => {
    for (const holidays of [[], [MON]]) {
      const { p, broker, w1 } = brokerSetup({ date: FRI, time: '15:29', holidays });
      const key = optKey('NIFTY', w1, 'CE', 25_000);
      p.setNow(hm(FRI, '16:00'));
      const ask = (p.live.quote(key) as { ask: number }).ask;
      const o = broker.place('u1', buyReq(w1, tick(ask - 20)));
      expect(o.status).toBe('OPEN');
      for (const t of [hm(SAT, '12:00'), hm(SUN, '23:59')]) {
        p.setNow(t);
        broker.tick();
        expect(o.status, new Date(t).toISOString()).toBe('OPEN');
      }
      p.setNow(hm(MON, '09:20'));
      broker.tick();
      expect(o.status, `holidays=${holidays}`).toBe('OPEN');
      const end = holidays.length ? hm(TUE, '15:30') : hm(MON, '15:30');
      p.setNow(end - 1);
      broker.tick();
      expect(o.status).toBe('OPEN');
      // The Tuesday weekly expires at the same instant as a Tuesday day order would: either reason ends it.
      p.setNow(end);
      broker.tick();
      expect(o.status).toBe('CANCELLED');
      expect(o.message).toMatch(/Day order expired|Contract expired/);
    }
  });

  it('a pre-open order (09:05) belongs to that day, not the previous one', () => {
    const { p, broker, w1 } = brokerSetup({ date: FRI, time: '15:29' });
    const key = optKey('NIFTY', w1, 'CE', 25_000);
    // Monday 09:05, Friday's quotes are still the live ones in the pre-open.
    p.setNow(hm(MON, '09:05'));
    const ask = (p.live.quote(key) as { ask: number }).ask;
    const o = broker.place('u1', buyReq(w1, tick(ask - 20)));
    expect(o.status).toBe('OPEN');
    p.setNow(hm(MON, '12:00'));
    broker.tick();
    expect(o.status).toBe('OPEN');
  });
});

/* ------------------------------------------------------------------------------------------ */
/* E. over HTTP                                                                                 */
/* ------------------------------------------------------------------------------------------ */

describe('routes: valuation time and the recorder-not-running 503', () => {
  const cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });
  async function app(date: string, time: string) {
    const p = new FakeProvider();
    const book = loadSampleBook(p, { date, time });
    const svc: Services = createServices(loadConfig({ persist: false, authSecret: 'test-secret' }), { provider: p });
    const a: FastifyInstance = await buildApp(svc, { serveWeb: false });
    cleanup.push(() => p.dispose(), () => svc.stop(), () => a.close());
    return { p, book, a };
  }
  const get = async (a: FastifyInstance, url: string) => {
    const res = await a.inject({ method: 'GET', url });
    return { status: res.statusCode, body: res.json() };
  };

  it('GET /api/chain on a Sunday carries Friday\'s close as its valuation time and the same IV as Friday 15:29', async () => {
    const { p, a, book } = await app(FRI, '15:29');
    const w1 = book.expiries.NIFTY[0];
    const fri = (await get(a, `/api/chain/NIFTY?expiry=${w1}`)).body as OptionChain;
    p.setNow(hm(SUN, '12:00'));
    const { status, body } = await get(a, `/api/chain/NIFTY?expiry=${w1}`);
    expect(status).toBe(200);
    const sun = body as OptionChain;
    expect(sun.valuationTs).toBe(hm(FRI, '15:30'));
    expect(Math.abs((sun.atmIv as number) - (fri.atmIv as number))).toBeLessThanOrEqual(0.01);
    expect(JSON.stringify(sun)).not.toMatch(/NaN|Infinity/);
  });

  it('GET /api/chain?at= answers 503 NO_LIVE_DATA with the last recorded minute when the recorder was not running, 200 at the edges of what was recorded', async () => {
    const { p, a, book } = await app('2026-10-12', '11:00');
    const d = book.recordedDate;
    const e = book.expiries.BANKNIFTY[0];
    const rec = (from: string, to: string, price: number, extra: Partial<MinuteRecord> = {}): MinuteRecord[] => {
      const out: MinuteRecord[] = [];
      for (let t = hm(d, from); t < hm(d, to); t += MIN) out.push({ ts: t, open: price, high: price, low: price, close: price, traded: true, ...extra });
      return out;
    };
    p.intraday.addMinutes(spotKey('BANKNIFTY'), rec('09:15', '10:00', 56000));
    for (const type of ['CE', 'PE'] as const) p.intraday.addMinutes(optKey('BANKNIFTY', e, type, 56000), rec('09:15', '10:00', 800, { oi: 50_000, volume: 10 }));
    const url = (hhmm: string) => `/api/chain/BANKNIFTY?expiry=${e}&at=${hm(d, hhmm)}`;
    expect((await get(a, url('09:16'))).status).toBe(200); // first completed minute
    expect((await get(a, url('10:01'))).status).toBe(200); // last recorded minute + 1 min
    const late = await get(a, url('14:00')); // the reviewer's scenario: recording ended 09:59, asked at 14:00
    expect(late.status).toBe(503);
    expect(late.body.code).toBe('NO_LIVE_DATA');
    expect(late.body.error).toMatch(/last recorded minute 09:59.*recorder was not running/);
    // Quotes and futures routes alike: a gap with the reason / a 503, never the 09:59 price as 14:00's.
    const q = await get(a, `/api/quotes?symbols=BANKNIFTY&at=${hm(d, '14:00')}`);
    expect(q.body.quotes ?? []).toEqual([]);
    expect(q.status === 503 || q.body.gaps?.BANKNIFTY).toBeTruthy();
    expect((await get(a, `/api/futures/BANKNIFTY?at=${hm(d, '14:00')}`)).status).toBe(503);
  });
});
