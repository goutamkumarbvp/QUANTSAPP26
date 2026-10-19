/**
 * Valuation time (Phase C review, HIGH): IV, Greeks, carry and forwards are solved from premiums at
 * the time those premiums belong to, never the wall clock. Outside the session that is the close of
 * the session whose quotes are still live, so unchanged premiums give unchanged values overnight, on
 * a weekend and before the open; an LTP premium is valued at its own trade time. Runs on the
 * TEST-ONLY FakeProvider + sample book: every price here is TEST data (Black-76 at stated vols).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { istTs, type OptionChain } from '@q26/core';
import { black76Price, timeToExpiry } from '../src/live/pricing';
import { AlertService, Notifier } from '../src/services/alerts';
import { Analytics } from '../src/services/analytics';
import { buildOptionChain, optKey, spotKey, underlyingQuote } from '../src/services/live';
import { MarketTools } from '../src/services/market-tools';
import { Pricer } from '../src/services/pricer';
import { PaperBroker, StrategyManager } from '../src/services/trading';
import { Db } from '../src/store/db';
import { FakeProvider, loadSampleBook } from './support/fake-provider';

const providers: FakeProvider[] = [];
afterEach(() => {
  for (const p of providers.splice(0)) p.dispose();
});

const hm = (date: string, hhmm: string) => istTs(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)));
const r2 = (v: number) => Math.round(v * 100) / 100;
const tick = (v: number) => Math.round(v / 0.05) * 0.05;

/** The reviewers' repro: a book priced at 14 % on Friday 15:29; the NIFTY weekly expires Tuesday. */
const FRI = '2026-10-16';
const SUN = '2026-10-18';
const MON = '2026-10-19';
const AFTER = [hm(FRI, '16:00'), hm(SUN, '12:00'), hm(MON, '09:05')];

function setup(date = FRI, time = '15:29') {
  const p = new FakeProvider();
  providers.push(p);
  const book = loadSampleBook(p, { date, time });
  const db = new Db(null);
  const pricer = new Pricer(p);
  const an = new Analytics(p, pricer);
  return { p, book, db, pricer, an, w1: book.expiries.NIFTY[0], m1: book.expiries.NIFTY[1] };
}

/** TEST DATA: NIFTY spot and the weekly chain quoted at `at` at a flat `vol` (as the sample book: spot carried at r − 1 %). */
function quoteWeekly(p: FakeProvider, w1: string, at: number, vol: number, spot = 25_000) {
  const r = p.pricing.r;
  const T = timeToExpiry(w1, at);
  const F = spot * Math.exp((r - 0.01) * T);
  p.setQuote(spotKey('NIFTY'), { ltp: spot, prevClose: 25_000, ts: at });
  for (const K of p.ref.strikes('NIFTY', w1)) {
    for (const type of ['CE', 'PE'] as const) {
      const price = tick(black76Price(type, F, K, T, r, vol));
      if (!(price >= 0.1)) continue;
      p.setQuote(optKey('NIFTY', w1, type, K), { ltp: r2(price), bid: r2(price - 0.05), ask: r2(price + 0.05), volume: 10_000, oi: 50_000, ts: at });
    }
  }
}

const atm25000 = (c: OptionChain) => c.rows.find((x) => x.strike === 25_000)!.ce;

describe('valuation time outside the session', () => {
  it("reviewers' table: ATM IV, carry and theta at Fri 16:00, Sun 12:00 and Mon 09:05 equal the Fri 15:29 values; they change only once the session opens with new premiums", async () => {
    const { p, an, w1 } = setup();
    expect(w1).toBe('2026-10-20');
    const read = async () => {
      const c = await buildOptionChain(p, 'NIFTY', w1);
      return { c, atmIv: c.atmIv as number, carry: c.carry as number, theta: atm25000(c).theta as number, iv: atm25000(c).iv as number, quoteIv: underlyingQuote(p, 'NIFTY').atmIv as number, tableIv: an.ivTable().find((x) => x.symbol === 'NIFTY')!.iv as number };
    };
    const fri = await read();
    expect(fri.c.valuationTs).toBe(hm(FRI, '15:29'));
    expect(atm25000(fri.c)).toMatchObject({ ivSource: 'mid', ivTs: hm(FRI, '15:29') });
    expect(fri.atmIv).toBeCloseTo(14, 1);
    expect(fri.carry).toBeCloseTo(0.01, 3);
    expect(fri.theta).toBeLessThan(-15);
    expect(fri.theta).toBeGreaterThan(-25);

    for (const t of AFTER) {
      p.setNow(t);
      const v = await read();
      // Friday's last premiums, valued at Friday's close: 15:29 → 15:30, one minute apart, nothing more.
      expect(v.c.valuationTs).toBe(hm(FRI, '15:30'));
      expect(v.c.ts).toBe(t);
      expect(v.c.daysToExpiry).toBeCloseTo(fri.c.daysToExpiry, 2);
      expect(atm25000(v.c)).toMatchObject({ ivSource: 'ltp', ivTs: hm(FRI, '15:30') });
      expect(Math.abs(v.atmIv - fri.atmIv)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(v.iv - fri.iv)).toBeLessThanOrEqual(0.02);
      expect(Math.abs(v.quoteIv - fri.quoteIv)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(v.tableIv - fri.tableIv)).toBeLessThanOrEqual(0.01);
      expect(Math.abs(v.carry - fri.carry)).toBeLessThan(1e-4);
      expect(Math.abs(v.theta - fri.theta)).toBeLessThan(0.05);
    }

    // The session opens: Friday's quotes are no longer live (nothing is solved from them) …
    p.setNow(hm(MON, '09:15'));
    await expect(buildOptionChain(p, 'NIFTY', w1)).rejects.toThrow(/No live quotes/);
    // … and only new premiums move the values (here quoted at 15 %, valued now).
    p.setNow(hm(MON, '10:00'));
    quoteWeekly(p, w1, hm(MON, '10:00'), 0.15);
    const mon = await read();
    expect(mon.c.valuationTs).toBe(hm(MON, '10:00'));
    expect(mon.atmIv).toBeCloseTo(15, 1);
  });

  it('an IV alert set just above the Friday IV does not fire over the weekend or before the open; it fires on a real move', async () => {
    const { p, db, pricer, w1 } = setup();
    const now = () => p.now();
    const strategies = new StrategyManager(p, db, pricer, now);
    const notifier = new Notifier(db, now);
    const analytics = { optionSnapshot: () => [], ivTable: () => [], orbScan: () => [], orbConfirmed: () => null } as unknown as Analytics;
    const alerts = new AlertService(p, db, pricer, strategies, notifier, now, analytics, new MarketTools(p, analytics));
    await alerts.evaluate();
    const friIv = r2((p.pricing.atmIv('NIFTY') as number) * 100);
    const a = alerts.create('u1', { kind: 'IV', symbol: 'NIFTY', condition: 'above', value: friIv + 0.05 });
    await alerts.evaluate();
    expect(a).toMatchObject({ status: 'active', lastValue: friIv });
    for (const t of [hm(FRI, '15:45'), hm('2026-10-17', '10:00'), hm(SUN, '12:00'), hm(SUN, '23:59'), hm(MON, '08:00'), hm(MON, '09:05'), hm(MON, '09:14')]) {
      p.setNow(t);
      await alerts.evaluate();
      expect(a.status).toBe('active');
      expect(Math.abs((a.lastValue as number) - friIv)).toBeLessThanOrEqual(0.01);
    }
    expect(notifier.list('u1')).toHaveLength(0);
    p.setNow(hm(MON, '10:00'));
    quoteWeekly(p, w1, hm(MON, '10:00'), 0.15);
    await alerts.evaluate();
    expect(a.status).toBe('triggered');
    expect(a.triggeredValue).toBeCloseTo(15, 0);
  });

  it('surface days to expiry, the optimizer and the margin estimate are valued at the same time as the IVs', async () => {
    const { p, db, pricer, an, w1 } = setup();
    const broker = new PaperBroker(p, db, pricer, () => p.now(), () => undefined, () => undefined);
    expect(broker.place('u1', { symbol: 'NIFTY', type: 'CE', strike: 25_000, expiry: w1, side: 'SELL', lots: 1, orderType: 'MARKET', product: 'NRML' }).status).toBe('COMPLETE');
    const req = { symbol: 'NIFTY', expiry: w1, targetPrice: 25_150, targetDate: w1 };
    const snap = async () => {
      const opt = await an.optimize(req);
      return { dte: (await an.surface('NIFTY')).daysToExpiry[0], margin: broker.funds('u1').usedMargin as number, best: opt.results.slice(0, 5).map((c) => JSON.stringify({ legs: c.legs, metrics: { ...c, legs: undefined } })) };
    };
    p.setNow(hm(FRI, '16:00'));
    const close = await snap();
    expect(close.dte).toBeCloseTo((Date.parse(`${w1}T10:00:00Z`) - hm(FRI, '15:30')) / 86_400_000, 1);
    expect(close.margin).toBeGreaterThan(0);
    p.setNow(hm(SUN, '12:00'));
    const sun = await snap();
    expect(sun.dte).toBe(close.dte);
    expect(sun.margin).toBeCloseTo(close.margin, 2);
    expect(sun.best).toEqual(close.best);
  });
});

describe('LTP premiums are valued at their own trade time', () => {
  it('during the session an LTP traded at 10:00 is valued at 10:00 (chain, pricer, option snapshot); a mid is valued now', async () => {
    const { p, pricer, an, w1 } = setup('2026-10-12', '14:00');
    expect(w1).toBe('2026-10-13');
    const now = hm('2026-10-12', '14:00');
    const ten = hm('2026-10-12', '10:00');
    const F = (await buildOptionChain(p, 'NIFTY', w1)).forward as number;
    // 25,200 CE last traded at 10:00 at a 16 % premium; the book update at 14:00 carries no bid/ask.
    const key = optKey('NIFTY', w1, 'CE', 25_200);
    p.live.clearQuote(key);
    const premium = r2(black76Price('CE', F, 25_200, timeToExpiry(w1, ten), p.pricing.r, 0.16));
    p.setQuote(key, { ltp: premium, ltt: ten, volume: 2_000, oi: 40_000, ts: now });
    const c = await buildOptionChain(p, 'NIFTY', w1);
    expect(c.valuationTs).toBe(now);
    const leg = c.rows.find((x) => x.strike === 25_200)!.ce;
    expect(leg).toMatchObject({ ivSource: 'ltp', ivTs: ten, ltp: premium });
    expect(leg.iv).toBeCloseTo(16, 1);
    // Solved at 14:00 instead, the same premium would read about 17 %.
    expect(Math.abs((leg.iv as number) - 16)).toBeLessThan(0.1);
    expect(atm25000(c)).toMatchObject({ ivSource: 'mid', ivTs: now });
    expect(pricer.price({ symbol: 'NIFTY', type: 'CE', strike: 25_200, expiry: w1 }).iv).toBeCloseTo(16, 1);
    const snapRow = an.optionSnapshot().find((x) => x.symbol === 'NIFTY' && x.expiry === w1 && x.type === 'CE' && x.strike === 25_200)!;
    expect(snapRow).toMatchObject({ ivSource: 'ltp' });
    expect(snapRow.iv).toBeCloseTo(16, 1);
  });
});

describe('as-of chains and carry', () => {
  it('an as-of chain after the close is valued at the close of that session', async () => {
    const { p, book } = setup('2026-10-12', '11:00');
    const w1 = book.expiries.NIFTY[0];
    const close = await buildOptionChain(p, 'NIFTY', w1, { at: hm(book.recordedDate, '15:30') });
    const evening = await buildOptionChain(p, 'NIFTY', w1, { at: hm(book.recordedDate, '18:00') });
    expect(close.valuationTs).toBe(hm(book.recordedDate, '15:30'));
    expect(evening.valuationTs).toBe(hm(book.recordedDate, '15:30'));
    expect(evening.ts).toBe(hm(book.recordedDate, '18:00'));
    expect(evening.atmIv).toBe(close.atmIv);
    expect(evening.daysToExpiry).toBe(close.daysToExpiry);
    expect(atm25000(evening).iv).toBe(atm25000(close).iv);
    expect(atm25000(evening).theta).toBe(atm25000(close).theta);
    expect(atm25000(evening).ivTs).toBe(hm(book.recordedDate, '15:30'));
  });

  it('carry is null with the reason (not an assumed zero dividend) when the forward is taken from spot', async () => {
    const { p, book } = setup('2026-10-12', '11:00');
    const w1 = book.expiries.NIFTY[0];
    // No PE is live: no put-call pair, and the weekly has no future → forward = spot carried at r.
    for (const K of p.ref.strikes('NIFTY', w1)) p.live.clearQuote(optKey('NIFTY', w1, 'PE', K));
    const live = await buildOptionChain(p, 'NIFTY', w1);
    expect(live.forwardSource).toBe('spot');
    expect(live.forward).not.toBeNull();
    expect(live.carry).toBeNull();
    expect(live.gaps?.carry).toMatch(/dividend yield is not implied/);

    // As-of: a recorded RELIANCE CE-only chain with its spot and no recorded future.
    const m1 = book.expiries.RELIANCE[0];
    const d = book.recordedDate;
    for (let m = 0; m < 5; m++) {
      const ts = p.calendar.ts(d, m);
      p.intraday.addMinutes(spotKey('RELIANCE'), [{ ts, open: 1400, high: 1400, low: 1400, close: 1400, traded: true, volume: 1_000 }]);
      p.intraday.addMinutes(optKey('RELIANCE', m1, 'CE', 1400), [{ ts, open: 30, high: 30, low: 30, close: 30, traded: true, volume: 500, oi: 10_000 }]);
    }
    const asOf = await buildOptionChain(p, 'RELIANCE', m1, { at: p.calendar.ts(d, 5) });
    expect(asOf.forwardSource).toBe('spot');
    expect(asOf.carry).toBeNull();
    expect(asOf.gaps?.carry).toMatch(/dividend yield is not implied/);
  });
});

describe('margin IV fallback', () => {
  it("a leg without a solvable premium takes its own expiry's ATM IV only, never the nearest expiry's", () => {
    const { p, db, pricer, m1, w1 } = setup('2026-10-12', '11:00');
    const broker = new PaperBroker(p, db, pricer, () => p.now(), () => undefined, () => undefined);
    expect(broker.place('u1', { symbol: 'NIFTY', type: 'CE', strike: 25_000, expiry: m1, side: 'SELL', lots: 1, orderType: 'MARKET', product: 'NRML' }).status).toBe('COMPLETE');
    expect(broker.funds('u1').usedMargin).toBeGreaterThan(0);
    // The monthly's premiums stop being live; the weekly's ATM IV is still there.
    for (const K of p.ref.strikes('NIFTY', m1)) for (const t of ['CE', 'PE'] as const) p.live.clearQuote(optKey('NIFTY', m1, t, K));
    expect(p.pricing.atmIv('NIFTY', m1)).toBeNull();
    expect(p.pricing.atmIv('NIFTY', w1)).not.toBeNull();
    const f = broker.funds('u1');
    expect(f.usedMargin).toBeNull();
    expect(f.gaps?.margin).toMatch(/No live IV for NIFTY .* margin cannot be estimated/);
  });
});
