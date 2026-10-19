/**
 * Analytics over the provider (Phase C): every tool reads live quotes (md.live), recorded minutes
 * (md.intraday), Kotak 1-minute history (md.candles) or the official end-of-day files (md.history).
 * Values must be traceable to those inputs, null (with a gap) where an input is missing, and
 * NoLiveData before any data exists. Runs on the TEST-ONLY FakeProvider + loadSampleBook; every
 * input below (quotes, minutes, official rows) is constructed by this test (test data, not market data).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  addDays,
  classifyBuildUp,
  historicalVol,
  istTs,
  ivPercentile,
  ivRank,
  MARKET_CLOSE_MIN,
  maxPain,
  volatilityCone,
  type FiiDiiDay,
  type Leg,
  type ParticipantDay,
} from '@q26/core';
import { black76Price, timeToExpiry } from '../src/live/pricing';
import type { SymbolRow } from '../src/live/store/history';
import { NoLiveData, keyId, type DailyOption, type InstrumentKey, type OptKind } from '../src/live/types';
import { Analytics, IV_WINDOW, RECORDED_CHAIN_COVERAGE, SURFACE_MONEYNESS, inWindows, sumFiiDii } from '../src/services/analytics';
import { buildOptionChain, futKey, optKey, sessionsBack, spotKey } from '../src/services/live';
import { Pricer } from '../src/services/pricer';
import { FakeProvider, loadSampleBook } from './support/fake-provider';

const providers: FakeProvider[] = [];
afterEach(() => {
  for (const p of providers.splice(0)) p.dispose();
});

const MIN = 60_000;
/** Sample book: live session 2026-10-12 (11:00 IST); 2026-10-09 is its one recorded session. */
const DAY = '2026-10-12';
const PREV = '2026-10-09';
const at = (date: string, hhmm: string, sec = 0) => istTs(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)), sec);
const r2 = (v: number) => Math.round(v * 100) / 100;
const pct = (v: number) => Math.round(v * 10_000) / 100;
/** Marks of a full recorded session at a 60-minute interval (minutes after 09:15). */
const HOURLY = [60, 120, 180, 240, 300, 360, 375];

function setup(opts: Parameters<typeof loadSampleBook>[1] = {}) {
  const p = new FakeProvider();
  providers.push(p);
  const book = loadSampleBook(p, opts);
  return { p, book, an: new Analytics(p, new Pricer(p)), w1: book.expiries.NIFTY[0], m1: book.expiries.NIFTY[1] };
}

/** Listings only: nothing live, recorded or official yet. */
function bare() {
  const p = new FakeProvider();
  providers.push(p);
  p.ref.setUnderlying({ symbol: 'NIFTY', name: 'Nifty 50', kind: 'index', lotSize: 75, strikeStep: 50 });
  p.ref.setUnderlying({ symbol: 'RELIANCE', name: 'Reliance Industries', kind: 'stock', sector: 'Energy', lotSize: 500, strikeStep: 20 });
  p.ref.setFutures('NIFTY', ['2026-10-27']);
  p.ref.setFutures('RELIANCE', ['2026-10-27']);
  p.ref.setStrikes('NIFTY', '2026-10-13', [24900, 25000, 25100]);
  return { p, an: new Analytics(p, new Pricer(p)) };
}

/**
 * Official option rows of one expiry at the close of `date` (TEST DATA): Black-76 at `vol` off the
 * official underlying close of that date carried at r, rounded to paise.
 */
function officialOptions(
  p: FakeProvider,
  symbol: string,
  date: string,
  expiry: string,
  o: { vol: number; strikes: number[]; volume?: number; oi?: (type: OptKind, strike: number) => number },
): SymbolRow<DailyOption>[] {
  const S = p.history.dailyBars(symbol, date, date)[0].close;
  const r = p.pricing.r;
  const T = timeToExpiry(expiry, istTs(date, MARKET_CLOSE_MIN));
  const F = S * Math.exp(r * T);
  const out: SymbolRow<DailyOption>[] = [];
  for (const strike of o.strikes) {
    for (const type of ['CE', 'PE'] as const) {
      const close = r2(black76Price(type, F, strike, T, r, o.vol));
      if (!(close >= 0.05)) continue;
      out.push({ symbol, date, expiry, strike, type, close, oi: o.oi ? o.oi(type, strike) : 50_000, volume: o.volume ?? 1_000, lotSize: 75 });
    }
  }
  return out;
}

/** Close of the recorded minute that ends at `t` (the last minute of a window ending at t). */
const closeAt = (p: FakeProvider, key: InstrumentKey, date: string, t: number) => {
  const rec = p.intraday.bars(key, date).find((x) => x.ts === t - MIN);
  if (!rec) throw new Error(`no record of ${keyId(key)} ending at ${t}`);
  return rec.close;
};

/** The error a call throws (sync or async). */
async function errOf(fn: () => unknown): Promise<Error & { statusCode?: number }> {
  try {
    await fn();
  } catch (e) {
    return e as Error & { statusCode?: number };
  }
  throw new Error('expected an error');
}

describe('series windows', () => {
  it('picks the last record completed in each window and carries nothing into a later window', () => {
    const recs = [{ ts: 0 }, { ts: 60_000 }, { ts: 300_000 }];
    expect(inWindows(recs, [0, 120_000, 240_000], [120_000, 240_000, 420_000])).toEqual([recs[1], undefined, recs[2]]);
    // a minute still in progress at the window end is not used
    expect(inWindows(recs, [240_000], [330_000])).toEqual([undefined]);
  });
});

describe('strike-wise OI', () => {
  it('live chain OI vs the previous close: the quote prevOi, else the official previous-session OI', async () => {
    const { p, an, w1 } = setup();
    const q = (type: OptKind, k: number) => p.live.quote(optKey('NIFTY', w1, type, k));
    let r = await an.strikeOi('NIFTY', w1);
    expect(r).toMatchObject({ symbol: 'NIFTY', expiry: w1, from: 'prev-close', fromTs: p.calendar.ts(PREV, 375), spot: 25000 });
    const atm = r.rows.find((x) => x.strike === 25000)!;
    expect([atm.ceOi, atm.peOi, atm.ceVolume, atm.peVolume]).toEqual([q('CE', 25000)!.oi, q('PE', 25000)!.oi, q('CE', 25000)!.volume, q('PE', 25000)!.volume]);
    expect([atm.ceChange, atm.peChange]).toEqual([null, null]);
    expect(r.gaps?.change).toMatch(/Previous-close OI missing for \d+ of \d+ strikes \(official F&O file for 2026-10-09/);
    // PCR and max pain over the strikes with OI on both sides
    const both = r.rows.filter((x) => x.ceOi !== null && x.peOi !== null);
    expect(both.length).toBeGreaterThan(10);
    expect(r.pcr).toBe(r2(both.reduce((a, x) => a + x.peOi!, 0) / both.reduce((a, x) => a + x.ceOi!, 0)));
    expect(r.maxPain).toBe(maxPain(both.map((x) => ({ strike: x.strike, ceOI: x.ceOi!, peOI: x.peOi! }))).maxPain);
    expect(r.coverage).toMatch(/live strikes with OI on both sides/);

    const prevOi = (type: OptKind, k: number) => Math.round((q(type, k)?.oi ?? 1_000) * 0.9);
    p.history.writeFo(PREV, { options: officialOptions(p, 'NIFTY', PREV, w1, { vol: 0.12, strikes: p.ref.strikes('NIFTY', w1), oi: prevOi }) });
    r = await an.strikeOi('NIFTY', w1);
    const row = r.rows.find((x) => x.strike === 25000)!;
    expect(row.ceChange).toBe(q('CE', 25000)!.oi! - prevOi('CE', 25000));
    expect(row.peChange).toBe(q('PE', 25000)!.oi! - prevOi('PE', 25000));
    expect(r.gaps).toBeUndefined();

    // the quote's own previous-close OI (REST legs) wins over the official file
    p.setQuote(optKey('NIFTY', w1, 'PE', 25000), { ltp: q('PE', 25000)!.ltp, prevOi: 100_000 });
    r = await an.strikeOi('NIFTY', w1);
    expect(r.rows.find((x) => x.strike === 25000)!.peChange).toBe(q('PE', 25000)!.oi! - 100_000);
  });

  it('change from a recorded minute of the session (?from) and the as-of chain (?at)', async () => {
    const { p, an, w1 } = setup();
    const ce = optKey('NIFTY', w1, 'CE', 25000);
    const pe = optKey('NIFTY', w1, 'PE', 25000);
    for (const [k, oi] of [[ce, 90_000], [pe, 99_000]] as const) p.intraday.addMinutes(k, [{ ts: at(DAY, '10:00'), open: 80, high: 80, low: 80, close: 80, traded: true, oi }]);
    const r = await an.strikeOi('NIFTY', w1, undefined, at(DAY, '10:01'));
    expect(r).toMatchObject({ from: 'recorded', fromTs: at(DAY, '10:01') });
    const row = r.rows.find((x) => x.strike === 25000)!;
    expect(row.ceChange).toBe(p.live.quote(ce)!.oi! - 90_000);
    expect(row.peChange).toBe(p.live.quote(pe)!.oi! - 99_000);
    expect(r.rows.find((x) => x.strike === 25100)!.ceChange).toBeNull(); // not recorded at 10:01
    expect(r.gaps?.change).toMatch(/not recorded at 10:01/);

    const early = await an.strikeOi('NIFTY', w1, undefined, at(DAY, '09:50'));
    expect(early.rows.every((x) => x.ceChange === null && x.peChange === null)).toBe(true);
    expect(early.gaps?.change).toMatch(/No recorded NIFTY .* chain at 09:50/);

    // ?at= replay: the recorded chain of 2026-10-09 (sample OI: 100,000 CE / 110,000 PE at 25000)
    const asOf = await an.strikeOi('NIFTY', w1, at(PREV, '11:00'));
    expect(asOf.toTs).toBe(at(PREV, '11:00'));
    expect(asOf.fromTs).toBe(p.calendar.ts('2026-10-08', 375));
    const a = asOf.rows.find((x) => x.strike === 25000)!;
    expect([a.ceOi, a.peOi, a.ceVolume, a.ceChange]).toEqual([100_000, 110_000, null, null]);
    await expect(an.strikeOi('NIFTY', w1, at('2026-10-08', '11:00'))).rejects.toThrow(/No recorded data for 2026-10-08 — recording started 2026-10-09/);
  });
});

describe('multi-strike series', () => {
  it('recorded minute series of the chosen strikes; unrecorded strikes are blank with a gap', () => {
    const { p, an, w1 } = setup();
    const r = an.multiStrike('NIFTY', w1, [25000, 31000], PREV, 60);
    expect(r).toMatchObject({ symbol: 'NIFTY', expiry: w1, date: PREV });
    expect(r.times).toEqual(HOURLY.map((m) => p.calendar.ts(PREV, m)));
    expect(r.spot).toEqual(r.times.map((t) => closeAt(p, spotKey('NIFTY'), PREV, t)));
    expect(r.gaps?.strikes).toMatch(/Not recorded on 2026-10-09: 31000/);
    for (const type of ['CE', 'PE'] as const) {
      const s = r.series.find((x) => x.strike === 25000 && x.type === type)!;
      expect(s.ltp).toEqual(r.times.map((t) => closeAt(p, optKey('NIFTY', w1, type, 25000), PREV, t)));
      expect(s.oi).toEqual(r.times.map(() => (type === 'CE' ? 100_000 : 110_000)));
      for (const v of s.iv) expect(v!).toBeCloseTo(14, 0); // solved from the recorded premiums (book priced at 14 %)
    }
    const far = r.series.filter((x) => x.strike === 31000);
    expect(far).toHaveLength(2);
    expect(far.every((x) => [...x.oi, ...x.ltp, ...x.iv].every((v) => v === null))).toBe(true);
  });

  it('defaults to ATM ± 2 steps; quote-only minutes give OI but no price; nothing is carried forward', () => {
    const { p, an, w1 } = setup();
    const def = an.multiStrike('NIFTY', w1, [], PREV, 60);
    const atm = p.intraday.chainSeries('NIFTY', w1, PREV).at(-1)!.atmStrike;
    expect([...new Set(def.series.map((x) => x.strike))]).toEqual([atm - 100, atm, atm + 100]);

    const k = optKey('NIFTY', w1, 'CE', 25000);
    p.intraday.addMinutes(k, [
      { ts: at(DAY, '10:00'), open: 80, high: 81, low: 79, close: 80.5, traded: true, oi: 1_000 },
      { ts: at(DAY, '10:01'), open: 80.5, high: 80.5, low: 80.5, close: 80.5, traded: false, oi: 1_100 },
    ]);
    const r = an.multiStrike('NIFTY', w1, [25000], DAY, 1);
    const s = r.series.find((x) => x.type === 'CE')!;
    const i = (hhmm: string) => r.times.indexOf(at(DAY, hhmm));
    expect(r.times.at(-1)).toBe(at(DAY, '11:00')); // the last completed minute
    expect([s.ltp[i('10:01')], s.oi[i('10:01')]]).toEqual([80.5, 1_000]);
    expect([s.ltp[i('10:02')], s.oi[i('10:02')]]).toEqual([null, 1_100]);
    expect([s.ltp[i('10:03')], s.oi[i('10:03')]]).toEqual([null, null]);
    expect(s.iv[i('10:01')]).toBeNull(); // no recorded spot, future or put-call pair today: no forward to solve with
  });

  it('NoLiveData for an unrecorded session, 400 for a future date', async () => {
    const { an, w1 } = setup();
    expect(() => an.multiStrike('NIFTY', w1, [25000], '2026-10-08', 5)).toThrow(/No recorded data for 2026-10-08 — recording started 2026-10-09/);
    expect(await errOf(() => an.multiStrike('NIFTY', w1, [25000], '2026-10-13', 5))).toMatchObject({ statusCode: 400 });
    expect(() => an.multiStrike('NIFTY', '2026-10-27', [25000], PREV, 5)).toThrow(/No recorded NIFTY 2026-10-27 options on 2026-10-09/);
  });
});

describe('OI trend, PCR and max pain', () => {
  it('OI trend reads the recorded chain minutes; OI change needs the official previous-close OI', () => {
    const { p, an, w1 } = setup();
    let r = an.oiTrend('NIFTY', w1, PREV, 60);
    const series = p.intraday.chainSeries('NIFTY', w1, PREV);
    expect(r.points.map((x) => x.ts)).toEqual(HOURLY.map((m) => p.calendar.ts(PREV, m)));
    for (const pt of r.points) {
      const cm = series.find((c) => c.ts === pt.ts - MIN)!;
      expect(pt).toMatchObject({ spot: cm.spot, ceOi: cm.ceOi, peOi: cm.peOi, pcr: +cm.pcr!.toFixed(3), maxPain: cm.maxPain, atmIv: pct(cm.atmIv!), ceChange: null, peChange: null });
    }
    expect(r.coverage).toContain(RECORDED_CHAIN_COVERAGE);
    expect(r.coverage).toMatch(/^Recorded chain totals: streamed strikes \(±8 %\)/);
    expect(r.gaps?.change).toMatch(/2026-10-08 not loaded/);

    // official 2026-10-08 OI of three strikes, 5,000 below what was recorded on 2026-10-09
    const recOi = (type: OptKind, k: number) => (100 - 4 * (Math.abs(k - 25000) / 50)) * (type === 'CE' ? 1000 : 1100);
    p.history.writeFo('2026-10-08', {
      options: [24950, 25000, 25050].flatMap((strike) => (['CE', 'PE'] as const).map((type) => ({ symbol: 'NIFTY', date: '2026-10-08', expiry: w1, strike, type, close: 50, oi: recOi(type, strike) - 5_000, volume: 10 }))),
    });
    r = an.oiTrend('NIFTY', w1, PREV, 60);
    expect(r.points.map((x) => [x.ceChange, x.peChange])).toEqual(r.points.map(() => [15_000, 15_000]));
    expect(r.gaps).toBeUndefined();

    expect(() => an.oiTrend('NIFTY', w1, DAY, 5)).toThrow(/No recorded data for 2026-10-12 — recording started 2026-10-09/);
    expect(() => an.oiTrend('NIFTY', '2026-10-27', PREV, 5)).toThrow(/No recorded NIFTY 2026-10-27 chain minutes on 2026-10-09/);
  });

  it('daily PCR from the official files (nearest expiry, every strike, real OI only) and the combined PCR view', () => {
    const { p, an, w1, m1 } = setup();
    const rows = (date: string, list: [string, OptKind, number, number, number][]) => list.map(([expiry, type, strike, oi, volume]) => ({ symbol: 'NIFTY', date, expiry, type, strike, oi, volume, close: 10 }));
    // untraded rows (volume 0) still carry real OI
    p.history.writeFo('2026-10-07', { options: rows('2026-10-07', [[w1, 'CE', 25000, 1_000, 5], [w1, 'CE', 25100, 2_000, 0], [w1, 'PE', 25000, 1_500, 5], [w1, 'PE', 24900, 3_500, 0], [m1, 'CE', 25000, 9_000, 5], [m1, 'PE', 25000, 1, 5]]) });
    p.history.writeFo('2026-10-08', { options: rows('2026-10-08', [[w1, 'CE', 25000, 4_000, 5], [w1, 'PE', 25000, 2_000, 5]]) });
    expect(an.dailyPcr('NIFTY', 5)).toEqual([
      { date: '2026-10-07', pcr: 1.667, close: 24950, expiry: w1 },
      { date: '2026-10-08', pcr: 0.5, close: 24875.15, expiry: w1 },
    ]);

    const both = an.pcr('NIFTY', w1, PREV, 60, 5);
    expect(both.expiry).toBe(w1);
    expect(both.intraday).toHaveLength(7);
    expect(both.daily).toHaveLength(2);
    expect(both.coverage.intraday).toMatch(/streamed strikes \(±8 %\)/);
    const today = an.pcr('NIFTY', undefined, undefined, 5, 5);
    expect(today.intraday).toEqual([]);
    expect(today.expiry).toBeNull();
    expect(today.gaps?.intraday).toMatch(/No recorded data for 2026-10-12 — recording started 2026-10-09/);
    expect(() => an.pcr('BANKNIFTY', undefined, undefined, 5, 5)).toThrow(NoLiveData);
  });

  it('max pain of the live chain over strikes with OI on both sides; its recorded drift is a gap until today is recorded', async () => {
    const { p, an, w1 } = setup();
    const r = await an.maxPainDetail('NIFTY', w1);
    const legs = p.ref
      .strikes('NIFTY', w1)
      .map((strike) => ({ strike, ce: p.live.quote(optKey('NIFTY', w1, 'CE', strike))?.oi, pe: p.live.quote(optKey('NIFTY', w1, 'PE', strike))?.oi }))
      .filter((x) => x.ce !== undefined && x.pe !== undefined);
    const expected = maxPain(legs.map((x) => ({ strike: x.strike, ceOI: x.ce!, peOI: x.pe! })));
    expect(r.maxPain).toBe(expected.maxPain);
    expect(r.pain).toEqual(expected.pain);
    expect(r.spot).toBe(25000);
    expect(r.history).toEqual([]);
    expect(r.gaps?.history).toMatch(/recording started 2026-10-09/);
  });
});

describe('futures build-up and breadth', () => {
  it('near futures: live LTP/OI vs the quote, else the official previous close (traded rows only) and OI', () => {
    const { p, book, an, m1 } = setup();
    const ltp = book.futures[`NIFTY|${m1}`];
    let rows = an.futuresBuildUp();
    expect(rows.map((x) => x.symbol)).toEqual(['NIFTY', 'BANKNIFTY', 'RELIANCE']);
    expect(rows[0]).toMatchObject({ expiry: m1, ltp, oi: 1_200_000, volume: 300_000, lotSize: 75, ts: book.now, changePct: null, oiChangePct: null, buildUp: null });
    expect(an.futuresBuildUp()).toBe(rows); // cached within 5 s

    p.history.writeFo(PREV, {
      futures: [
        { symbol: 'NIFTY', date: PREV, expiry: m1, close: 25010, oi: 1_000_000, volume: 1_000 },
        { symbol: 'RELIANCE', date: PREV, expiry: m1, close: 1395, oi: 1_300_000, volume: 0 }, // untraded: carried price
      ],
    });
    p.advance(5_000);
    rows = an.futuresBuildUp();
    const n = rows.find((x) => x.symbol === 'NIFTY')!;
    expect(n.changePct).toBe(r2(((ltp - 25010) / 25010) * 100));
    expect(n.oiChangePct).toBe(20);
    expect(n.buildUp).toBe(classifyBuildUp(ltp - 25010, 200_000));
    const rel = rows.find((x) => x.symbol === 'RELIANCE')!;
    expect(rel.changePct).toBeNull(); // the untraded official row's close is not a price
    expect(rel.oiChangePct).toBe(r2((-100_000 / 1_300_000) * 100));
    expect(rel.buildUp).toBeNull();
    expect(rows.find((x) => x.symbol === 'BANKNIFTY')!.oiChangePct).toBeNull(); // no official row

    // the quote's own previous close / OI win
    const relLtp = book.futures[`RELIANCE|${m1}`];
    p.setQuote(futKey('RELIANCE', m1), { ltp: relLtp, prevClose: 1380, prevOi: 1_000_000 });
    p.advance(5_000);
    const rel2 = an.futuresBuildUp().find((x) => x.symbol === 'RELIANCE')!;
    expect(rel2.changePct).toBe(r2(((relLtp - 1380) / 1380) * 100));
    expect(rel2.buildUp).toBe(classifyBuildUp(relLtp - 1380, 200_000));
  });

  it('breadth: live stock futures today, official sessions before (spot close change vs futures OI change)', () => {
    const { p, book, an, m1 } = setup();
    const zero = { 'Long Build-up': 0, 'Short Build-up': 0, 'Short Covering': 0, 'Long Unwinding': 0, Neutral: 0 };
    let b = an.breadth();
    expect([b.total, b.classified]).toEqual([1, 0]);
    expect(b.gaps?.overall).toMatch(/1 of 1 stock futures have no live price\/OI change/);
    expect(b.gaps?.history).toMatch(/No two consecutive sessions/);

    p.setQuote(futKey('RELIANCE', m1), { ltp: book.futures[`RELIANCE|${m1}`], prevClose: 1380, prevOi: 1_000_000 }); // price ↑, OI ↑
    // official F&O of two consecutive sessions; the CM closes (sample) fall from 1390.82 to 1386.63
    p.history.writeFo('2026-10-08', { futures: [{ symbol: 'RELIANCE', date: '2026-10-08', expiry: m1, close: 1391, oi: 1_000_000, volume: 10 }] });
    p.history.writeFo(PREV, {
      futures: [
        { symbol: 'RELIANCE', date: PREV, expiry: m1, close: 1387, oi: 1_050_000, volume: 10 },
        { symbol: 'RELIANCE', date: PREV, expiry: '2026-11-24', close: 1395, oi: 20_000, volume: 10 }, // new contract counts in full
      ],
    });
    p.advance(5_000);
    b = an.breadth();
    expect(b.classified).toBe(1);
    expect(b.overall).toEqual({ ...zero, 'Long Build-up': 1 });
    expect(b.sectors).toHaveLength(1);
    expect(b.sectors[0]).toMatchObject({ sector: 'Energy', counts: { ...zero, 'Long Build-up': 1 } });
    expect(b.sectors[0].symbols.map((x) => x.symbol)).toEqual(['RELIANCE']);
    expect(b.history).toEqual([
      { date: PREV, counts: { ...zero, 'Short Build-up': 1 }, classified: 1, source: 'eod' },
      { date: DAY, counts: { ...zero, 'Long Build-up': 1 }, classified: 1, source: 'live' },
    ]);
    expect(b.gaps).toBeUndefined();
  });
});

describe('official FII/DII and participant OI', () => {
  it('returns the stored days with their scope; only combined days are summed; NoLiveData / 400 otherwise', async () => {
    const { p, an } = setup();
    const day = (date: string, scope: 'combined' | 'nse', fiiNet: number): FiiDiiDay => ({ date, fiiBuy: 1_000, fiiSell: 1_000 - fiiNet, fiiNet, diiBuy: 500, diiSell: 400, diiNet: 100, niftyClose: 24_900, niftyChangePct: 0.2, scope });
    expect(() => an.fiiDii('2026-10-01', DAY)).toThrow(/none loaded yet/);
    p.history.writeFiiDii(day('2026-10-08', 'combined', 120.5));
    p.history.writeFiiDii(day(PREV, 'nse', 80));
    const days = an.fiiDii('2026-10-01', DAY);
    expect(days.map((d) => [d.date, d.scope, d.fiiNet, d.niftyClose])).toEqual([
      ['2026-10-08', 'combined', 120.5, 24_900],
      [PREV, 'nse', 80, 24_900],
    ]);
    expect(sumFiiDii(days)).toEqual({ fiiNet: 120.5, diiNet: 100, days: 1, excluded: 1 });
    expect(sumFiiDii(days.filter((d) => d.scope === 'nse'))).toEqual({ fiiNet: null, diiNet: null, days: 0, excluded: 1 });
    expect(() => an.fiiDii('2026-09-01', '2026-09-30')).toThrow(/latest loaded: 2026-10-09/);
    expect(await errOf(() => an.fiiDii(DAY, '2026-10-01'))).toMatchObject({ statusCode: 400 });
    expect(await errOf(() => an.fiiDii('yesterday', DAY))).toMatchObject({ statusCode: 400 });

    const range = an.rangeOf(5);
    expect(range).toEqual({ from: '2026-10-06', to: DAY });
    expect(() => an.participants(range.from, range.to)).toThrow(/participant-wise OI is not loaded .* \(none loaded yet\)/);
    const row = { futIndexLong: 1, futIndexShort: 2, futStockLong: 3, futStockShort: 4, optIndexCallLong: 5, optIndexCallShort: 6, optIndexPutLong: 7, optIndexPutShort: 8, optStockCallLong: 9, optStockCallShort: 10, optStockPutLong: 11, optStockPutShort: 12 };
    const pd: ParticipantDay = { date: PREV, niftyClose: 24_800.3, rows: [{ participant: 'FII', ...row }, { participant: 'Client', ...row }] };
    p.history.writeParticipants(pd);
    expect(an.participants(range.from, range.to)).toEqual([pd]);
  });
});

describe('volatility', () => {
  it('IV table: live ATM IV vs the previous official close; IVR/IVP and HV blank while the official history is short', () => {
    const { p, an, w1 } = setup();
    p.history.writeFo(PREV, { options: officialOptions(p, 'NIFTY', PREV, w1, { vol: 0.12, strikes: p.ref.strikes('NIFTY', w1) }) });
    const rows = an.ivTable();
    expect(rows.map((r) => r.symbol)).toEqual(['NIFTY', 'BANKNIFTY', 'RELIANCE']);
    const n = rows[0];
    expect(n.expiry).toBe(w1);
    expect(n.iv).toBe(pct(p.pricing.atmIv('NIFTY', w1)!));
    expect(n.iv!).toBeCloseTo(14, 0);
    expect(n.ivChange!).toBeCloseTo(2, 0); // 14 % now vs 12 % at the official close
    expect([n.ltp, n.changePct]).toEqual([25000, r2((100 / 24900) * 100)]);
    expect([n.ivr, n.ivp, n.hv, n.ivHvSpread]).toEqual([null, null, null, null]);
    expect(n.gaps?.ivr).toMatch(/252 sessions of official ATM IV history \(at least 227\); 1 loaded/);
    expect(n.gaps?.hv).toMatch(/21 consecutive official closes/);
    const bn = rows[1];
    expect(bn.iv!).toBeCloseTo(16, 0);
    expect(bn.ivChange).toBeNull();
    expect(bn.gaps?.ivChange).toMatch(/No traded official option closes of BANKNIFTY/);
    expect(rows[2].iv!).toBeCloseTo(22, 0);
    expect(an.ivTable()).toBe(rows); // cached within 5 s
  });

  it('IV rank/percentile are blank with the reason (not 50) when the official ATM IV history is flat', () => {
    const { p, an } = setup();
    const live = p.pricing.atmIv('NIFTY') as number;
    // TEST DATA: a full window of official ATM IV, every session at the live ATM IV.
    vi.spyOn(p.history, 'dailyAtmIv').mockImplementation(() => Array.from({ length: IV_WINDOW }, (_, i) => ({ date: addDays('2025-01-01', i), iv: live, expiry: '2026-10-13' })));
    const n = an.ivTable().find((r) => r.symbol === 'NIFTY')!;
    expect([n.ivr, n.ivp]).toEqual([null, null]);
    expect(n.gaps?.ivr).toMatch(/history of the last 252 sessions is flat/);
  });

  it('IV chart: recorded intraday ATM IV, daily rows from the official files, current IV from live premiums', () => {
    const { p, an, w1 } = setup();
    const r = an.ivChart('NIFTY', undefined, PREV, 60, 30);
    expect([r.expiry, r.date]).toEqual([w1, PREV]);
    const series = p.intraday.chainSeries('NIFTY', w1, PREV);
    expect(r.intraday).toHaveLength(7);
    for (const pt of r.intraday) {
      const cm = series.find((c) => c.ts === pt.ts - MIN)!;
      expect([pt.atmIv, pt.spot]).toEqual([pct(cm.atmIv!), cm.spot]);
      expect(pt.ceIv!).toBeCloseTo(14, 0);
      expect(pt.peIv!).toBeCloseTo(14, 0);
    }
    // no official F&O file yet: the daily rows carry the official closes only
    expect(r.daily.map((d) => d.date)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', PREV]);
    expect(r.daily.every((d) => d.iv === null && d.hv === null && d.expiry === null)).toBe(true);
    expect(r.daily.at(-1)!.close).toBe(24800.3);
    expect(r.currentIv).toBe(pct(p.pricing.atmIv('NIFTY', w1)!));
    expect([r.ivr, r.ivp]).toEqual([null, null]);
    expect(r.gaps?.ivr).toMatch(/0 loaded/);

    const today = an.ivChart('NIFTY', undefined, undefined, 5, 30); // today is not recorded
    expect(today.intraday).toEqual([]);
    expect(today.gaps?.intraday).toMatch(/recording started 2026-10-09/);
  });

  it('a year of official history: daily ATM IV, IV rank/percentile, HV 20D and the realised-vol cone', async () => {
    const { p, an, w1 } = setup();
    const n = 260;
    const dates = sessionsBack(p, PREV, n);
    const closes = dates.map((_, i) => r2(25000 * Math.exp(0.02 * Math.sin(i / 6) + 0.0004 * i)));
    const vol = (i: number) => 0.1 + (0.1 * i) / (n - 1);
    dates.forEach((d, i) => {
      const S = closes[i];
      p.history.writeDailyBars('index', d, [{ symbol: 'NIFTY', date: d, open: S, high: S, low: S, close: S }]);
      const K = Math.round(S / 50) * 50;
      p.history.writeFo(d, { options: officialOptions(p, 'NIFTY', d, addDays(d, 7), { vol: vol(i), strikes: [K - 50, K, K + 50] }) });
    });
    const hist = p.history.dailyAtmIv('NIFTY', dates[0], PREV);
    expect(hist).toHaveLength(n);
    hist.forEach((h, i) => expect(h.iv).toBeCloseTo(vol(i), 3));
    const hv = historicalVol(closes.slice(-21), 20);

    const daily = an.ivHistory('NIFTY', 120);
    expect(daily.map((d) => d.date)).toEqual(dates.filter((d) => d >= sessionsBack(p, DAY, 120)[0]));
    expect(daily.at(-1)).toEqual({ date: PREV, iv: pct(hist.at(-1)!.iv), hv: pct(hv), close: closes.at(-1), expiry: addDays(PREV, 7) });

    const live = p.pricing.atmIv('NIFTY', w1)!;
    const window = hist.slice(-IV_WINDOW).map((h) => h.iv);
    const row = an.ivTable().find((x) => x.symbol === 'NIFTY')!;
    expect(row.ivr).toBe(+(ivRank(live, window) as number).toFixed(1));
    expect(row.ivp).toBe(+(ivPercentile(live, window) as number).toFixed(1));
    expect(row.ivr!).toBeGreaterThan(0);
    expect(row.hv).toBe(pct(hv));
    expect(row.ivHvSpread).toBe(r2(row.iv! - row.hv!));
    expect(row.gaps?.ivr).toBeUndefined();
    const chart = an.ivChart('NIFTY', undefined, PREV, 60, 120);
    expect([chart.ivr, chart.ivp]).toEqual([row.ivr, row.ivp]);

    const c = an.cone('NIFTY');
    expect([c.closes, c.from, c.to]).toEqual([n, dates[0], PREV]);
    expect(c.rows).toEqual(
      volatilityCone(closes, [10, 20, 30, 60, 90, 120]).map((e) => ({ window: e.window, min: pct(e.min), p25: pct(e.p25), median: pct(e.median), p75: pct(e.p75), max: pct(e.max), current: pct(e.current) })),
    );
    expect(c.atmIv).toBe(pct(live));
    expect(c.gaps).toBeUndefined();
  });

  it('cone: windows longer than the official history are blank; NoLiveData without closes', () => {
    const { an } = setup();
    const c = an.cone('NIFTY'); // five sample closes
    expect(c.closes).toBe(5);
    expect(c.rows.map((r) => r.window)).toEqual([10, 20, 30, 60, 90, 120]);
    expect(c.rows.every((r) => [r.min, r.p25, r.median, r.p75, r.max, r.current].every((v) => v === null))).toBe(true);
    expect(c.gaps?.rows).toMatch(/5 consecutive official closes \(from 2026-10-05\): the 10\/20\/30\/60\/90\/120-session windows need 17\+/);
    expect(c.atmIv!).toBeCloseTo(14, 0);
    expect(() => an.cone('BANKNIFTY')).toThrow(NoLiveData);
  });

  it('skew: IV per listed strike from live premiums, and the previous official close for comparison', async () => {
    const { p, an, w1, m1 } = setup();
    p.history.writeFo(PREV, { options: officialOptions(p, 'NIFTY', PREV, w1, { vol: 0.12, strikes: p.ref.strikes('NIFTY', w1) }) });
    const s = await an.skew('NIFTY', [], undefined, 'prev');
    expect(s.spot).toBe(25000);
    expect(s.curves.map((c) => [c.expiry, c.source, c.date])).toEqual([
      [w1, 'live', DAY],
      [w1, 'eod', PREV],
      [m1, 'live', DAY],
    ]);
    expect(s.gaps?.[`${m1} (prev close)`]).toMatch(/No traded official option closes of NIFTY/);
    const live = s.curves[0];
    expect(live.points.length).toBeGreaterThan(15);
    for (const pt of live.points) {
      expect(p.ref.strikes('NIFTY', w1)).toContain(pt.strike);
      expect(pt.moneyness).toBe(+((pt.strike / 25000 - 1) * 100).toFixed(2));
      expect(pt.iv).toBe(pt.strike >= live.forward! ? pt.ceIv : pt.peIv);
      if (Math.abs(pt.strike - 25000) <= 300) expect(pt.iv!).toBeCloseTo(14, 0);
    }
    const prev = s.curves[1];
    expect(prev.points.length).toBeGreaterThan(15);
    expect(prev.atmIv!).toBeCloseTo(12, 0);
    for (const pt of prev.points) if (Math.abs(pt.strike - 24800) <= 300) expect(pt.iv!).toBeCloseTo(12, 0);

    expect((await an.skew('NIFTY', [m1])).curves.map((c) => c.expiry)).toEqual([m1]);
    expect(await errOf(() => an.skew('NIFTY', ['2030-01-08']))).toMatchObject({ statusCode: 400 });
  });

  it('surface: solved IV on listed strikes only; buckets without a listed live premium stay blank (no smile fill-in)', async () => {
    const { p, an, w1, m1 } = setup();
    const s = await an.surface('NIFTY');
    expect(s.expiries).toEqual([w1, m1]);
    expect(s.moneyness).toEqual(SURFACE_MONEYNESS);
    expect(s.spot).toBe(25000);
    s.iv.forEach((row, i) =>
      row.forEach((v, j) => {
        const k = s.strikes[i][j];
        expect(v === null).toBe(k === null);
        if (k === null) return;
        expect(p.ref.strikes('NIFTY', s.expiries[i])).toContain(k);
        expect(Math.abs((k / 25000 - 1) * 100 - s.moneyness[j])).toBeLessThanOrEqual(1);
      }),
    );
    // the sample lists strikes within ±2 % only: every wider bucket is blank
    for (const row of s.iv) expect(s.moneyness.filter((_, j) => row[j] !== null)).toEqual([-2, -1, 0, 1, 2]);
    expect(s.iv[0][s.moneyness.indexOf(0)]!).toBeCloseTo(14, 0);
    expect(s.strikes[0][s.moneyness.indexOf(0)]).toBe(25000);
  });
});

describe('straddle, strategy chart and recap', () => {
  it('straddle from recorded premiums: rolling ATM at the recorded forward, fixed strikes and strangles', async () => {
    const { p, an, w1 } = setup();
    const strikes = p.ref.strikes('NIFTY', w1);
    const s = await an.straddle('NIFTY', w1, 'atm', 'rolling', PREV, 60);
    expect([s.source, s.expiry, s.date]).toEqual(['recorded', w1, PREV]);
    expect(s.points.map((x) => x.ts)).toEqual(HOURLY.map((m) => p.calendar.ts(PREV, m)));
    for (const pt of s.points) {
      const spot = closeAt(p, spotKey('NIFTY'), PREV, pt.ts);
      const F = spot * Math.exp(p.pricing.r * timeToExpiry(w1, pt.ts)); // spot carried at r (no same-expiry future)
      const atm = strikes.reduce((a, k) => (Math.abs(k - F) < Math.abs(a - F) ? k : a));
      expect([pt.spot, pt.strike, pt.ceStrike, pt.peStrike]).toEqual([spot, atm, atm, atm]);
      expect(pt.ce).toBe(closeAt(p, optKey('NIFTY', w1, 'CE', atm), PREV, pt.ts));
      expect(pt.pe).toBe(closeAt(p, optKey('NIFTY', w1, 'PE', atm), PREV, pt.ts));
      expect(pt.straddle).toBe(r2(pt.ce! + pt.pe!));
      expect(pt.iv!).toBeCloseTo(14, 0);
    }
    const strangle = await an.straddle('NIFTY', w1, 25100, 'fixed', PREV, 60, undefined, 100);
    expect(strangle.points.every((x) => x.strike === 25100 && x.ceStrike === 25200 && x.peStrike === 25000)).toBe(true);
    expect(strangle.points[0].ce).toBe(closeAt(p, optKey('NIFTY', w1, 'CE', 25200), PREV, strangle.points[0].ts));
  });

  it('straddle falls back to Kotak 1-minute history for active contracts; NoLiveData when nothing is recorded or served', async () => {
    const { p, an, w1 } = setup();
    const asked: string[] = [];
    p.candles = async (key, interval, from, to) => {
      asked.push(`${keyId(key)} ${interval} ${from} ${to}`);
      const base = key.kind === 'SPOT' ? 25000 : key.strike === 25000 ? (key.kind === 'CE' ? 80 : 75) : null;
      if (base === null) throw new NoLiveData('not served');
      return Array.from({ length: 106 }, (_, m) => {
        const c = r2(base + m * 0.05);
        return { ts: p.calendar.ts(DAY, m), open: base, high: c, low: base, close: c };
      });
    };
    const s = await an.straddle('NIFTY', w1, 25000, 'fixed', DAY, 15);
    expect(s.source).toBe('kotak');
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((a) => a.endsWith(`1min ${DAY} ${DAY}`))).toBe(true);
    const pt = s.points.find((x) => x.ts === at(DAY, '10:00'))!;
    expect([pt.ce, pt.pe, pt.spot]).toEqual([r2(80 + 44 * 0.05), r2(75 + 44 * 0.05), r2(25000 + 44 * 0.05)]); // the 09:59 minute
    expect(s.points.at(-1)!.ts).toBe(at(DAY, '11:00')); // the 11:00 minute is still forming: not a point

    await expect(an.straddle('NIFTY', w1, 'atm', 'rolling', '2026-10-08', 60)).rejects.toThrow(/No recorded or listed NIFTY 2026-10-13 options for 2026-10-08 \(No recorded data for 2026-10-08 — recording started 2026-10-09\)/);
    await expect(an.straddle('NIFTY', undefined, 'atm', 'rolling', '2026-10-08', 60)).rejects.toThrow(/No NIFTY option expiry recorded or listed for 2026-10-08 \(No recorded data for 2026-10-08 — recording started 2026-10-09\)/);
    const fresh = setup();
    await expect(fresh.an.straddle('NIFTY', fresh.w1, 25000, 'fixed', DAY, 15)).rejects.toThrow(/No recorded minutes of NIFTY for 2026-10-12 — recording started 2026-10-09; Kotak 1-minute history: /);
  });

  it('strategy chart: premium, P&L and Greeks from the legs\' recorded premiums; lot size from the listing', async () => {
    const { p, an, w1 } = setup();
    const leg = (type: 'CE' | 'PE', extra: Partial<Leg> = {}): Leg => ({ side: 'SELL', type, strike: 25000, expiry: w1, lots: 2, lotSize: 50, price: 0, ...extra });
    const pts = await an.strategyChart('NIFTY', [leg('CE'), leg('PE')], PREV, 60);
    const ce = (t: number) => closeAt(p, optKey('NIFTY', w1, 'CE', 25000), PREV, t);
    const pe = (t: number) => closeAt(p, optKey('NIFTY', w1, 'PE', 25000), PREV, t);
    expect(pts.map((x) => x.ts)).toEqual(HOURLY.map((m) => p.calendar.ts(PREV, m)));
    const [ce0, pe0] = [ce(pts[0].ts), pe(pts[0].ts)]; // price 0 → entry at the first traded premium
    for (const pt of pts) {
      expect(pt.spot).toBe(closeAt(p, spotKey('NIFTY'), PREV, pt.ts));
      expect(pt.premium!).toBeCloseTo(-2 * (ce(pt.ts) + pe(pt.ts)), 2);
      expect(pt.pnl!).toBeCloseTo(-150 * (ce(pt.ts) - ce0) - 150 * (pe(pt.ts) - pe0), 2); // 2 lots × 75 (listing), short
      expect(pt.gamma!).toBeLessThan(0);
      expect(pt.vega!).toBeLessThan(0);
      expect(pt.theta!).toBeGreaterThan(0);
      expect(Math.abs(pt.delta!)).toBeLessThan(150);
    }
    expect(pts[0].pnl).toBe(0);
    // an entry price given: P&L from it
    const priced = await an.strategyChart('NIFTY', [leg('CE', { price: 100 })], PREV, 60);
    expect(priced[0].pnl!).toBeCloseTo(-150 * (ce(pts[0].ts) - 100), 2);

    await expect(an.strategyChart('NIFTY', [leg('CE', { strike: 31000 })], PREV, 60)).rejects.toThrow(NoLiveData);
    expect(await errOf(() => an.strategyChart('NIFTY', [leg('CE', { expiry: '2026-10-06' })], PREV, 60))).toMatchObject({ statusCode: 400 });
    expect(await errOf(() => an.strategyChart('NIFTY', [leg('CE', { lots: 0 })], PREV, 60))).toMatchObject({ statusCode: 400 });
  });

  it('recap replays recorded sessions only and says which sessions were skipped', () => {
    const { p, an, w1 } = setup();
    const CE = optKey('NIFTY', w1, 'CE', 25000);
    const legs: Leg[] = [{ side: 'BUY', type: 'CE', strike: 25000, expiry: w1, lots: 1, lotSize: 75, price: 100 }];
    const r = an.recap({ symbol: 'NIFTY', legs, fromTs: at(PREV, '10:00'), toTs: at(PREV, '11:00'), intervalMin: 15 });
    expect(r.points.map((x) => x.ts)).toEqual(['10:00', '10:15', '10:30', '10:45', '11:00'].map((h) => at(PREV, h)));
    for (const pt of r.points) {
      const c = closeAt(p, CE, PREV, pt.ts);
      expect(pt.legLtp).toEqual([c]);
      expect(pt.pnl).toBe(r2(75 * (c - 100)));
      expect(pt.spot).toBe(closeAt(p, spotKey('NIFTY'), PREV, pt.ts));
    }
    expect(r.sessions).toEqual([PREV]);
    expect(r.finalPnl).toBe(r.points.at(-1)!.pnl);
    expect(r.maxPnl).toBe(Math.max(...r.points.map((x) => x.pnl!)));
    expect(r.expired).toBe(false);
    expect(r.gaps).toBeUndefined();

    const exited = an.recap({ symbol: 'NIFTY', legs: [{ ...legs[0], exitPrice: 120 }], fromTs: at(PREV, '10:00'), toTs: at(PREV, '11:00'), intervalMin: 30 });
    expect(exited.points.every((x) => x.pnl === 1500)).toBe(true);

    const span = an.recap({ symbol: 'NIFTY', legs, fromTs: at('2026-10-08', '14:00'), toTs: at(PREV, '09:30'), intervalMin: 15 });
    expect(span.sessions).toEqual([PREV]);
    expect(span.gaps?.sessions).toBe('Not recorded: 2026-10-08');
    expect(span.points.map((x) => x.ts)).toEqual([at(PREV, '09:16'), at(PREV, '09:30')]);

    expect(() => an.recap({ symbol: 'NIFTY', legs, fromTs: at('2026-10-07', '10:00'), toTs: at('2026-10-07', '12:00') })).toThrow(/recording started 2026-10-09/);
    expect(() => an.recap({ symbol: 'NIFTY', legs, fromTs: at(PREV, '12:00'), toTs: at(PREV, '11:00') })).toThrow(/fromTs must be before/);
  });
});

describe('optimizer and the market-wide option snapshot', () => {
  it('optimizer ranks strategies on live premiums only and skips strikes without one', async () => {
    const { p, an, w1 } = setup();
    const req = { symbol: 'NIFTY', expiry: w1, targetPrice: 25150, targetDate: w1 };
    const out = await an.optimize(req);
    expect(out).toMatchObject({ expiry: w1, spot: 25000 });
    expect(out.coverage).toBe('21 strikes with a live premium (of 21 in the chain; 0 skipped)');
    expect(out.results.length).toBeGreaterThan(0);
    const chain = await buildOptionChain(p, 'NIFTY', w1);
    expect(out.forward).toBe(chain.forward);
    for (const c of out.results) {
      for (const l of c.legs) {
        const q = chain.rows.find((x) => x.strike === l.strike)![l.type === 'CE' ? 'ce' : 'pe'];
        expect(l.price).toBe(r2(q.ivSource === 'mid' ? (q.bid! + q.ask!) / 2 : q.ltp!));
      }
    }
    // 25200: no trade this session and no live book on either leg → skipped (its OI stays real)
    for (const type of ['CE', 'PE'] as const) {
      const k = optKey('NIFTY', w1, type, 25200);
      p.live.clearQuote(k);
      p.setQuote(k, { ltp: 50, oi: 10_000, volume: 0 });
    }
    const out2 = await an.optimize(req);
    expect(out2.coverage).toBe('20 strikes with a live premium (of 21 in the chain; 1 skipped)');
    expect(out2.strikesUsed).not.toContain(25200);
    expect(out2.results.every((c) => c.legs.every((l) => l.strike !== 25200))).toBe(true);

    p.live.clearQuote(spotKey('NIFTY'));
    await expect(an.optimize(req)).rejects.toThrow(NoLiveData);
  });

  it('option snapshot: live legs of the near chains with their timestamps; previous values from the official file', () => {
    const { p, book, an, w1, m1 } = setup();
    let rows = an.optionSnapshot();
    const nifty = rows.filter((x) => x.symbol === 'NIFTY');
    expect(new Set(nifty.map((x) => x.expiry))).toEqual(new Set([w1]));
    expect(nifty.every((x) => Math.abs(x.strike / 25000 - 1) <= 0.05)).toBe(true);
    const rel = rows.filter((x) => x.symbol === 'RELIANCE');
    expect(new Set(rel.map((x) => x.expiry))).toEqual(new Set([m1]));
    expect(rel.length).toBeGreaterThan(0);
    expect(rel.every((x) => Math.abs(x.strike / 1400 - 1) <= 0.12)).toBe(true);
    const q = p.live.quote(optKey('NIFTY', w1, 'CE', 25000))!;
    const a = nifty.find((x) => x.strike === 25000 && x.type === 'CE')!;
    expect(a).toMatchObject({ kind: 'index', sector: 'Index', spot: 25000, ltp: q.ltp, oi: q.oi, volume: q.volume, ivSource: 'mid', ts: book.now, lotSize: 75, prevLtp: null, prevOi: null, oiChange: null, prevIv: null, changePct: null });
    expect(a.iv!).toBeCloseTo(14, 0);
    expect(an.optionBuildUp(a)).toBeNull();
    expect(an.optionSnapshot()).toBe(rows); // cached within 5 s

    // official previous session: traded rows priced at 12 %, the 25000 PE untraded (carried price)
    const prevOi = (type: OptKind, k: number) => Math.round((p.live.quote(optKey('NIFTY', w1, type, k))?.oi ?? 1_000) * 0.9);
    const off = officialOptions(p, 'NIFTY', PREV, w1, { vol: 0.12, strikes: p.ref.strikes('NIFTY', w1), oi: prevOi });
    off.find((o) => o.type === 'PE' && o.strike === 25000)!.volume = 0;
    p.history.writeFo(PREV, { options: off });
    // 25100 CE: no trade today and no book; 24900 CE: traded, but its book is 30 s old
    const k1 = optKey('NIFTY', w1, 'CE', 25100);
    p.live.clearQuote(k1);
    p.setQuote(k1, { ltp: 60, oi: 77_000, volume: 0 });
    const k2 = optKey('NIFTY', w1, 'CE', 24900);
    const q2 = p.live.quote(k2)!;
    p.live.clearQuote(k2);
    p.setQuote(k2, { ltp: q2.ltp, bid: q2.bid, ask: q2.ask, oi: q2.oi, volume: q2.volume, ts: book.now - 30_000 });
    p.advance(5_000);
    rows = an.optionSnapshot();
    const find = (type: OptKind, k: number) => rows.find((x) => x.symbol === 'NIFTY' && x.type === type && x.strike === k)!;
    const o = off.find((x) => x.type === 'CE' && x.strike === 25000)!;
    const b = find('CE', 25000);
    expect(b).toMatchObject({ prevLtp: o.close, prevOi: o.oi, oiChange: q.oi! - o.oi, changePct: r2(((q.ltp - o.close) / o.close) * 100) });
    expect(b.prevIv!).toBeCloseTo(12, 0);
    expect(an.optionBuildUp(b)).toBe(classifyBuildUp(q.ltp - o.close, q.oi! - o.oi));
    const pe = find('PE', 25000);
    expect([pe.prevLtp, pe.prevIv, pe.prevOi]).toEqual([null, null, prevOi('PE', 25000)]); // the untraded row's close is not a price
    expect([find('CE', 25100).ltp, find('CE', 25100).iv, find('CE', 25100).ivSource, find('CE', 25100).oi]).toEqual([null, null, null, 77_000]);
    const st = find('CE', 24900);
    expect([st.ivSource, st.ts]).toEqual(['ltp', book.now - 30_000]);
    expect(st.iv!).toBeCloseTo(14, 0);
  });
});

describe('before any data exists', () => {
  it('every tool answers NoLiveData (or an empty list) with nothing live, recorded or official', async () => {
    const { p, an } = bare();
    const leg: Leg = { side: 'BUY', type: 'CE', strike: 25000, expiry: '2026-10-13', lots: 1, lotSize: 75, price: 100 };
    await expect(an.strikeOi('NIFTY')).rejects.toThrow(NoLiveData);
    expect(() => an.multiStrike('NIFTY', undefined, [25000], undefined, 5)).toThrow(NoLiveData);
    expect(() => an.oiTrend('NIFTY', undefined, undefined, 5)).toThrow(NoLiveData);
    expect(an.dailyPcr('NIFTY', 30)).toEqual([]);
    expect(() => an.pcr('NIFTY', undefined, undefined, 5, 30)).toThrow(NoLiveData);
    await expect(an.maxPainDetail('NIFTY')).rejects.toThrow(NoLiveData);
    expect(() => an.futuresBuildUp()).toThrow(/No live futures quotes yet/);
    expect(() => an.breadth()).toThrow(NoLiveData);
    expect(() => an.participants('2026-10-01', DAY)).toThrow(NoLiveData);
    expect(() => an.fiiDii('2026-10-01', DAY)).toThrow(NoLiveData);
    expect(() => an.ivChart('NIFTY', undefined, undefined, 5, 120)).toThrow(NoLiveData);
    expect(() => an.ivTable()).toThrow(/No live underlying price or ATM IV yet/);
    await expect(an.skew('NIFTY', [])).rejects.toThrow(NoLiveData);
    await expect(an.surface('NIFTY')).rejects.toThrow(NoLiveData);
    expect(() => an.cone('NIFTY')).toThrow(NoLiveData);
    await expect(an.straddle('NIFTY', undefined, 'atm', 'rolling', undefined, 5)).rejects.toThrow(NoLiveData);
    await expect(an.strategyChart('NIFTY', [leg], undefined, 5)).rejects.toThrow(NoLiveData);
    expect(() => an.recap({ symbol: 'NIFTY', legs: [leg], fromTs: at(DAY, '09:30') })).toThrow(NoLiveData);
    await expect(an.optimize({ symbol: 'NIFTY', expiry: '2026-10-13', targetPrice: 25100, targetDate: '2026-10-13' })).rejects.toThrow(NoLiveData);
    expect(an.optionSnapshot()).toEqual([]);
    await expect(an.orb('NIFTY')).rejects.toThrow(NoLiveData);
    expect(() => an.orbScan()).toThrow(NoLiveData);
    await expect(an.orbHistory('NIFTY', 5)).rejects.toThrow(NoLiveData);

    // instrument master not loaded yet: NoLiveData; unknown symbol: 404
    p.ref.setLoaded(false);
    expect(() => an.cone('NIFTY')).toThrow(/Instrument master not loaded yet/);
    await expect(an.orb('NIFTY')).rejects.toThrow(NoLiveData);
    p.ref.setLoaded(true);
    expect(await errOf(() => an.cone('NOPE'))).toMatchObject({ statusCode: 404 });
  });
});
