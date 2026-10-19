/**
 * Alerts, notifications and watchlists on live data (TEST-ONLY FakeProvider + sample book): alerts
 * fire on live values only and are skipped (with the reason) when their input is not live; watchlist
 * rows are blank, with the quote's age and the reason, when not live. Every input (quotes, recorded
 * minutes, the ORB evaluation stand-in for Analytics) is TEST data constructed here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { istTs, type OrbEvaluation } from '@q26/core';
import { NoLiveData } from '../src/live/types';
import type { MinuteRecord } from '../src/live/types';
import { AlertService, DEFAULT_WATCHLIST, Notifier, Watchlists } from '../src/services/alerts';
import type { Analytics } from '../src/services/analytics';
import { buildOptionChain, futKey, optKey, pct, spotKey } from '../src/services/live';
import { MarketTools } from '../src/services/market-tools';
import { Pricer } from '../src/services/pricer';
import { StrategyManager } from '../src/services/trading';
import { Db } from '../src/store/db';
import { FakeProvider, loadSampleBook } from './support/fake-provider';

const providers: FakeProvider[] = [];
afterEach(() => {
  for (const p of providers.splice(0)) p.dispose();
});

const hm = (date: string, hhmm: string, sec = 0) => istTs(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))) + sec * 1000;

function setup(orbConfirmed: (symbol: string, ts: number, minutes: number) => OrbEvaluation | null = () => null) {
  const p = new FakeProvider();
  providers.push(p);
  const book = loadSampleBook(p);
  const db = new Db(null);
  const now = () => p.now();
  const pricer = new Pricer(p);
  const strategies = new StrategyManager(p, db, pricer, now);
  const notifier = new Notifier(db, now);
  /** TEST-ONLY stand-in for the Analytics methods these services read. */
  const analytics = { optionSnapshot: () => [], ivTable: () => [], orbScan: () => [], orbConfirmed } as unknown as Analytics;
  const tools = new MarketTools(p, analytics);
  const alerts = new AlertService(p, db, pricer, strategies, notifier, now, analytics, tools);
  const watchlists = new Watchlists(db, pricer, now);
  const w1 = book.expiries.NIFTY[0];
  const m1 = book.expiries.NIFTY[1];
  const prevSession = p.calendar.prev(book.date);
  /** Make a quote's LTP an earlier session's trade (its book/OI stay). */
  const notTradedToday = (key: Parameters<FakeProvider['setQuote']>[0]) => p.setQuote(key, { ltp: p.live.quote(key)!.ltp, ltt: hm(prevSession, '15:29') });
  return { p, book, db, pricer, strategies, notifier, alerts, watchlists, tools, w1, m1, prevSession, notTradedToday };
}

describe('alerts on live values', () => {
  it('PRICE fires on the live spot; a spot whose LTP is not a trade of the session is skipped, not compared', async () => {
    const { p, alerts, notifier, notTradedToday } = setup();
    const a = alerts.create('u1', { kind: 'PRICE', symbol: 'nifty', condition: 'above', value: 24_990 });
    const b = alerts.create('u1', { kind: 'PRICE', symbol: 'BANKNIFTY', condition: 'above', value: 1 });
    expect(a.symbol).toBe('NIFTY');
    notTradedToday(spotKey('BANKNIFTY'));
    await alerts.evaluate();
    expect(a).toMatchObject({ status: 'triggered', triggeredValue: 25_000, lastValue: 25_000, checkedAt: p.now(), statusNote: undefined });
    expect(b).toMatchObject({ status: 'active', lastValue: null, statusNote: 'BANKNIFTY has not traded in the live session' });
    expect(notifier.list('u1').map((n) => n.title)).toEqual(['Alert: NIFTY price above 24990']);
  });

  it('IV uses the ATM IV solved from live premiums; skipped once the premiums are not live', async () => {
    const { p, book, alerts } = setup();
    const up = alerts.create('u1', { kind: 'IV', symbol: 'NIFTY', condition: 'above', value: 10 });
    const down = alerts.create('u1', { kind: 'IV', symbol: 'NIFTY', condition: 'below', value: 5 });
    await alerts.evaluate();
    const iv = pct(p.pricing.atmIv('NIFTY')) as number;
    expect(iv).toBeGreaterThan(12);
    expect(up).toMatchObject({ status: 'triggered', triggeredValue: iv });
    expect(down).toMatchObject({ status: 'active', lastValue: iv, statusNote: undefined });
    p.setNow(hm(p.calendar.next(book.date), '10:00')); // yesterday's quotes are not live in the next session
    await alerts.evaluate();
    expect(down).toMatchObject({ status: 'active', lastValue: null, statusNote: 'NIFTY ATM IV could not be solved from live premiums' });
  });

  it('PCR comes from the live chain aggregate, built once per evaluation cycle; skipped when the chain is not live', async () => {
    const { p, book, alerts } = setup();
    const spy = vi.spyOn(p.live, 'chain');
    const a1 = alerts.create('u1', { kind: 'PCR', symbol: 'NIFTY', condition: 'above', value: 0.5 });
    const a2 = alerts.create('u2', { kind: 'PCR', symbol: 'NIFTY', condition: 'below', value: 0.1 });
    const r = alerts.create('u1', { kind: 'PCR', symbol: 'RELIANCE', condition: 'above', value: 0.1 });
    const rm1 = book.expiries.RELIANCE[0];
    for (const k of p.ref.strikes('RELIANCE', rm1)) for (const t of ['CE', 'PE'] as const) p.live.clearQuote(optKey('RELIANCE', rm1, t, k));
    await alerts.evaluate();
    expect(spy.mock.calls.filter((c) => c[0] === 'NIFTY')).toHaveLength(1);
    const chain = await buildOptionChain(p, 'NIFTY');
    expect(chain.pcr).toBeGreaterThan(1);
    expect(a1).toMatchObject({ status: 'triggered', triggeredValue: chain.pcr });
    expect(a2).toMatchObject({ status: 'active', lastValue: chain.pcr });
    expect(r).toMatchObject({ status: 'active', lastValue: null });
    expect(r.statusNote).toMatch(/No live quotes for the RELIANCE .* option chain/);
  });

  it('OI_CHANGE needs live OI and the previous session\'s OI; OPTION_PRICE fires on the live premium; an expired contract disables', async () => {
    const { p, book, alerts, w1 } = setup();
    const k = optKey('NIFTY', w1, 'CE', 25_000);
    const q = p.live.quote(k)!;
    const oi = alerts.create('u1', { kind: 'OI_CHANGE', symbol: 'NIFTY', optionType: 'CE', strike: 25_000, expiry: w1, condition: 'above', value: 10 });
    const prem = alerts.create('u1', { kind: 'OPTION_PRICE', symbol: 'NIFTY', optionType: 'CE', strike: 25_000, expiry: w1, condition: 'above', value: 1 });
    await alerts.evaluate();
    expect(oi).toMatchObject({ status: 'active', lastValue: null });
    expect(oi.statusNote).toMatch(/No previous-session OI for NIFTY 13-Oct-26 25000 CE/);
    expect(prem).toMatchObject({ status: 'triggered', triggeredValue: q.ltp });
    p.setQuote(k, { ltp: q.ltp, prevOi: 80_000 }); // OI 100,000 vs 80,000 at the previous close
    await alerts.evaluate();
    expect(oi).toMatchObject({ status: 'triggered', triggeredValue: 25 });

    const later = alerts.create('u1', { kind: 'OPTION_PRICE', symbol: 'NIFTY', optionType: 'PE', strike: 25_000, expiry: w1, condition: 'above', value: 1e9 });
    p.setNow(hm(p.calendar.next(p.calendar.next(book.date)), '10:00'));
    await alerts.evaluate();
    expect(later).toMatchObject({ status: 'disabled', statusNote: 'NIFTY 13-Oct-26 25000 PE has expired' });
    expect(() => alerts.create('u1', { kind: 'OPTION_PRICE', symbol: 'NIFTY', optionType: 'CE', strike: 25_000, expiry: w1, condition: 'above', value: 1 })).toThrow(/expired/);
  });

  it('MTM alerts and strategy target/stop-loss use the live MTM; a leg that is not live skips them (never MTM 0)', async () => {
    const { alerts, strategies, notifier, w1, notTradedToday, p } = setup();
    const s = strategies.create('u1', { name: 'Long call', symbol: 'NIFTY', legs: [{ side: 'BUY', type: 'CE', strike: 25_000, expiry: w1, lots: 1, lotSize: 75, price: 1 }], targetMtm: 1, stopLossMtm: 1 });
    const above = alerts.create('u1', { kind: 'MTM', symbol: 'NIFTY', strategyId: s.id, condition: 'above', value: 0 });
    const k = optKey('NIFTY', w1, 'CE', 25_000);
    notTradedToday(k);
    await alerts.evaluate();
    expect(above).toMatchObject({ status: 'active', lastValue: null });
    expect(above.statusNote).toMatch(/^MTM not live — NIFTY 13-Oct-26 25000 CE: /);
    expect(notifier.list('u1')).toHaveLength(0); // target/stop-loss not compared against a stand-in

    p.setQuote(k, { ltp: p.live.quote(k)!.ltp, ltt: p.now() }); // a trade of this session again
    await alerts.evaluate();
    const mtm = strategies.get('u1', s.id).live?.mtm as number;
    expect(mtm).toBeGreaterThan(0);
    expect(above).toMatchObject({ status: 'triggered', triggeredValue: mtm });
    expect(notifier.list('u1').map((n) => n.title)).toEqual(['🎯 Target hit: Long call', 'Alert: Strategy MTM above 0']); // newest first

    // A deleted strategy disables its alert (client error), with the reason.
    const gone = alerts.create('u1', { kind: 'MTM', symbol: 'NIFTY', strategyId: s.id, condition: 'below', value: -1e9 });
    strategies.remove('u1', s.id);
    await alerts.evaluate();
    expect(gone).toMatchObject({ status: 'disabled', statusNote: 'Strategy not found' });
  });

  it('ORDER_FLOW uses the recorded flow of a minute completed after arming, and only when enough volume was classified', async () => {
    const { p, book, alerts, m1 } = setup();
    const fut = futKey('NIFTY', m1);
    const rec = (hhmm: string, buy: number, sell: number, uncl: number): MinuteRecord => ({ ts: hm(book.date, hhmm), open: 1, high: 1, low: 1, close: 1, traded: true, volume: buy + sell + uncl, buyVolume: buy, sellVolume: sell, unclassified: uncl });
    const none = alerts.create('u1', { kind: 'ORDER_FLOW', symbol: 'NIFTY', condition: 'above', value: 60 });
    await alerts.evaluate();
    expect(none.statusNote).toMatch(/No recorded minute of the NIFTY .* future/);

    p.intraday.addMinutes(fut, [rec('10:59', 900, 100, 0)]); // completed before the alert was armed (11:00)
    await alerts.evaluate();
    expect(none).toMatchObject({ status: 'active', lastValue: null });
    expect(none.statusNote).toMatch(/Waiting for a minute completed after the alert was armed/);

    p.intraday.addMinutes(fut, [rec('11:00', 800, 200, 100)]);
    p.setNow(hm(book.date, '11:01', 3));
    const late = alerts.create('u2', { kind: 'ORDER_FLOW', symbol: 'NIFTY', condition: 'above', value: 60 }); // armed after 11:00 completed
    p.setNow(hm(book.date, '11:01', 5));
    await alerts.evaluate();
    expect(none).toMatchObject({ status: 'triggered', triggeredValue: 80 }); // 800 of 1,000 classified units
    expect(late).toMatchObject({ status: 'active', lastValue: null }); // same cycle, its own arming time
    expect(late.statusNote).toMatch(/Waiting for a minute completed after the alert was armed \(last recorded minute 11:00\)/);

    const thin = alerts.create('u1', { kind: 'ORDER_FLOW', symbol: 'NIFTY', condition: 'above', value: 0 });
    p.intraday.addMinutes(fut, [rec('11:01', 100, 0, 900)]); // 100 % "buy" — of 10 % of the volume
    p.setNow(hm(book.date, '11:02', 5));
    await alerts.evaluate();
    expect(thin).toMatchObject({ status: 'active', lastValue: null, statusNote: '11:01: only 10% of the volume could be classified (needs 50%)' });
    expect(() => alerts.create('u1', { kind: 'ORDER_FLOW', symbol: 'NIFTY', condition: 'above', value: 101 })).toThrow(/between 0 and 100/);
  });

  it('ORDER_FLOW never evaluates a minute that follows a feed gap or whose volume is a lower bound; the next ordinary minute is evaluated', async () => {
    const { p, book, alerts, m1 } = setup();
    const fut = futKey('NIFTY', m1);
    const a = alerts.create('u1', { kind: 'ORDER_FLOW', symbol: 'NIFTY', condition: 'above', value: 60 });
    // 11:00: a feed gap ended here; the minute's own trades are 100 % buys, the 400 units of the gap are unknown.
    p.intraday.addMinutes(fut, [{ ts: hm(book.date, '11:00'), open: 1, high: 1, low: 1, close: 1, traded: true, volume: 100, gapVolume: 400, buyVolume: 100, sellVolume: 0, unclassified: 0 }]);
    p.setNow(hm(book.date, '11:01', 5));
    await alerts.evaluate();
    expect(a).toMatchObject({ status: 'active', lastValue: null });
    expect(a.statusNote).toBe('11:00: a feed gap ended in this minute (400 units traded during the gap cannot be classified): not evaluated');
    // 11:01: the recording started inside the minute (its volume is a lower bound).
    p.intraday.addMinutes(fut, [{ ts: hm(book.date, '11:01'), open: 1, high: 1, low: 1, close: 1, traded: true, volume: 100, buyVolume: 100, sellVolume: 0, unclassified: 0, partial: true }]);
    p.setNow(hm(book.date, '11:02', 5));
    await alerts.evaluate();
    expect(a).toMatchObject({ status: 'active', lastValue: null });
    expect(a.statusNote).toMatch(/^11:01: recording of the NIFTY .* future started inside this minute \(its volume is incomplete\): not evaluated$/);
    // 11:02: an ordinary minute is evaluated again.
    p.intraday.addMinutes(fut, [{ ts: hm(book.date, '11:02'), open: 1, high: 1, low: 1, close: 1, traded: true, volume: 100, buyVolume: 90, sellVolume: 10, unclassified: 0 }]);
    p.setNow(hm(book.date, '11:03', 5));
    await alerts.evaluate();
    expect(a).toMatchObject({ status: 'triggered', triggeredValue: 90 });
  });

  it('ORB_BREAK: recorded bars missing → skipped (not disabled); fires on a break confirmed after arming', async () => {
    let mode: 'nodata' | 'old' | 'new' = 'nodata';
    const ev = (crossTs: number): OrbEvaluation => ({
      rangeMinutes: 15, rule: 'close', complete: true, high: 25_050, low: 24_950, width: 100, widthPct: 0.4,
      breaks: [{ direction: 'up', ts: crossTs, price: 25_060 }], crossings: [{ direction: 'up', ts: crossTs, price: 25_060 }],
      firstUp: { direction: 'up', ts: crossTs, price: 25_060 }, firstDown: null, trend: 'up', whipsaw: false, position: 'above', reentered: false, pending: null, last: 25_060, toHighPct: -0.04, toLowPct: -0.44,
    });
    const { p, book, alerts, notifier } = setup(() => {
      if (mode === 'nodata') throw new NoLiveData('No recorded 1-minute bars of NIFTY on 2026-10-12');
      return ev(mode === 'old' ? hm(book.date, '10:30') : hm(book.date, '11:00'));
    });
    const a = alerts.create('u1', { kind: 'ORB_BREAK', symbol: 'NIFTY', condition: 'above', value: 15 });
    await alerts.evaluate();
    expect(a).toMatchObject({ status: 'active', lastValue: null, statusNote: 'No recorded 1-minute bars of NIFTY on 2026-10-12' });
    mode = 'old';
    await alerts.evaluate();
    expect(a).toMatchObject({ status: 'active', lastValue: 25_060, statusNote: undefined });
    mode = 'new';
    p.setNow(hm(book.date, '11:01', 2));
    await alerts.evaluate();
    expect(a).toMatchObject({ status: 'triggered', triggeredAt: hm(book.date, '11:01'), triggeredValue: 25_060 });
    expect(notifier.list('u1')[0].title).toBe('NIFTY broke above its 15-min opening range — trending up');
  });

  it('an unexpected error is noted on its alert and reported after the others were evaluated; concurrent calls share a run', async () => {
    const { alerts } = setup(() => {
      throw new Error('boom');
    });
    const orb = alerts.create('u1', { kind: 'ORB_BREAK', symbol: 'NIFTY', condition: 'above', value: 15 });
    const price = alerts.create('u1', { kind: 'PRICE', symbol: 'NIFTY', condition: 'above', value: 1 });
    const run = alerts.evaluate();
    expect(alerts.evaluate()).toBe(run);
    await expect(run).rejects.toThrow('boom');
    expect(orb).toMatchObject({ status: 'active', statusNote: 'Evaluation failed: boom' });
    expect(price.status).toBe('triggered');
  });

  it('validates symbols and contracts on create', () => {
    const { alerts, w1 } = setup();
    expect(() => alerts.create('u1', { kind: 'PRICE', symbol: 'NOPE', condition: 'above', value: 1 })).toThrow(/Unknown symbol/);
    expect(() => alerts.create('u1', { kind: 'OPTION_PRICE', symbol: 'NIFTY', optionType: 'CE', strike: 25_010, expiry: w1, condition: 'above', value: 1 })).toThrow(/Strike 25010 is not available/);
    expect(() => alerts.create('u1', { kind: 'ORB_BREAK', symbol: 'NIFTY', condition: 'above', value: 7 })).toThrow(/Opening range must be one of/);
  });
});

describe('watchlist quotes', () => {
  it('live values with the quote time and age; blanks with the reason when not live (never 0)', () => {
    const { p, book, watchlists, w1, notTradedToday } = setup();
    const [wl] = watchlists.list('u1');
    expect(wl.items).toEqual(DEFAULT_WATCHLIST);
    // Symbols the instrument master does not list (here: not in the sample book) are blank rows with the reason.
    const def = watchlists.quotes('u1', wl.id);
    expect(def.find((r) => r.symbol === 'SENSEX')).toMatchObject({ label: 'SENSEX', ltp: null, change: null, oi: null, iv: null, ts: null, ageSec: null, reason: 'Unknown symbol SENSEX' });

    const m2 = book.expiries.BANKNIFTY[1];
    watchlists.update('u1', wl.id, {
      items: [
        { symbol: 'NIFTY', type: 'EQ' },
        { symbol: 'NIFTY', type: 'CE', strike: 25_000, expiry: w1 },
        { symbol: 'NIFTY', type: 'PE', strike: 25_000, expiry: w1 },
        { symbol: 'BANKNIFTY', type: 'FUT', expiry: m2 },
      ],
    });
    notTradedToday(optKey('NIFTY', w1, 'PE', 25_000));
    p.live.clearQuote(futKey('BANKNIFTY', m2));
    p.advance(11_000); // books are older than 10 s now
    const [eq, ce, pe, fut] = watchlists.quotes('u1', wl.id);
    expect(eq).toMatchObject({ label: 'NIFTY', ltp: 25_000, change: 100, changePct: 0.4, ts: book.now, ageSec: 11, bid: null, ask: null });
    expect(eq.iv).toBeGreaterThan(12);
    expect(ce).toMatchObject({ ltp: p.live.quote(optKey('NIFTY', w1, 'CE', 25_000))!.ltp, bid: null, ask: null, oi: 100_000, ageSec: 11 });
    expect(ce.reason).toMatch(/no live bid\/ask/);
    expect(pe).toMatchObject({ ltp: null, change: null, iv: null, oi: 110_000, ageSec: 11 });
    expect(pe.reason).toMatch(/has not traded in the live session/);
    expect(fut).toMatchObject({ ltp: null, oi: null, ts: null, ageSec: null, reason: `No live quote for BANKNIFTY ${'24-Nov-26'} FUT yet` });
    expect(p.live.watched.at(-1)).toMatchObject({ keys: [futKey('BANKNIFTY', m2)], level: 'quote' });
  });
});
