/**
 * Every remaining HTTP route over createServices(config, { provider: FakeProvider }) (TEST-ONLY
 * provider with the sample book; every price, OI and flow figure below is constructed by this test):
 * the dashboard (each card on its own), the analytics/tools routes (200 or 503 + NO_LIVE_DATA, never
 * 500), 404/400 handling, official FII/DII and participant routes, strategy chart/recap lot sizes,
 * user-tier watches of the live views, and the account, paper-trading, strategy, alert and watchlist
 * routes. Replaces the route coverage of the deleted simulator tests (server/trend/algo.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { istTs, ORDER_FLOW_METHOD, type DashboardResponse, type FiiDiiDay, type ParticipantDay } from '@q26/core';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { keyId, type MinuteRecord } from '../src/live/types';
import { futKey, optKey, spotKey } from '../src/services/live';
import { createServices, type Services } from '../src/services';
import { SCANNERS } from '../src/services/market-tools';
import { FakeProvider, loadSampleBook, type SampleBook } from './support/fake-provider';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const hm = (date: string, hhmm: string) => istTs(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)));

async function setup(opts: { sample?: boolean } = {}): Promise<{ p: FakeProvider; book: SampleBook | null; svc: Services; app: FastifyInstance }> {
  const p = new FakeProvider();
  const book = opts.sample === false ? null : loadSampleBook(p);
  const svc = createServices(loadConfig({ persist: false, authSecret: 'test-secret' }), { provider: p });
  const app = await buildApp(svc, { serveWeb: false });
  cleanup.push(() => p.dispose(), () => svc.stop(), () => app.close());
  return { p, book, svc, app };
}

async function call(app: FastifyInstance, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, token?: string) {
  const res = await app.inject({ method, url, ...(body !== undefined ? { payload: body as object } : {}), headers: token ? { authorization: `Bearer ${token}` } : {} });
  let json: unknown = null;
  try {
    json = res.json();
  } catch {
    json = res.body;
  }
  return { status: res.statusCode, body: json as any };
}

/** TEST bars: today's NIFTY spot minutes from 09:15 to 10:59 (completed by 11:00) on a small zig-zag path. */
function recordToday(p: FakeProvider, book: SampleBook): void {
  for (let m = 0; m < 105; m++) {
    const c = 25000 + ((m % 9) - 4) * 3 + (m > 60 ? 15 : 0);
    const o = m ? 25000 + (((m - 1) % 9) - 4) * 3 + (m - 1 > 60 ? 15 : 0) : 25000;
    const rec: MinuteRecord = { ts: p.calendar.ts(book.date, m), open: o, high: Math.max(o, c) + 1, low: Math.min(o, c) - 1, close: c, traded: true };
    p.intraday.addMinutes(spotKey('NIFTY'), [rec]);
  }
  // The near future's 10:58 minute with the recorder's quote-rule split (test numbers).
  const m1 = book.expiries.NIFTY[1];
  p.intraday.addMinutes(futKey('NIFTY', m1), [{ ts: hm(book.date, '10:58'), open: 25100, high: 25101, low: 25099, close: 25100, traded: true, volume: 1000, buyVolume: 700, sellVolume: 200, unclassified: 100 }]);
}

const fiiDay = (date: string, fiiNet: number): FiiDiiDay => ({ date, fiiBuy: 1000, fiiSell: 1000 - fiiNet, fiiNet, diiBuy: 500, diiSell: 400, diiNet: 100, niftyClose: 24900, niftyChangePct: 0.2, scope: 'combined' });

/* ------------------------------------------------------------------------------------------ */

describe('dashboard', () => {
  it('fills every card on its own; a card without data is blank with its reason and never fails the response', async () => {
    const { app, p, book } = await setup();
    const b = book as SampleBook;
    let { status, body } = await call(app, 'GET', '/api/dashboard');
    expect(status).toBe(200);
    let d = body as DashboardResponse;
    expect(d.clock).toMatchObject({ ts: b.now, date: b.date, status: 'open' });
    expect(d.clock.feed?.connected).toBe(true);
    expect(d.indices.map((q) => [q.symbol, q.ltp]).sort()).toEqual([
      ['BANKNIFTY', 56000],
      ['NIFTY', 25000],
    ]);
    // RELIANCE spot 1400 vs the feed's previous close 1390; its future has no previous OI yet.
    expect(d.gainers).toEqual([{ symbol: 'RELIANCE', ltp: 1400, changePct: 0.72, oiChangePct: null, buildUp: null }]);
    expect(d.losers).toEqual([]);
    expect(d.oiGainers).toEqual([]);
    expect(d.buildUpCounts).toBeNull();
    expect([d.buildUpClassified, d.buildUpTotal]).toEqual([0, 1]);
    expect(d.gaps?.oiGainers).toMatch(/No stock future has live OI/);
    expect(d.gaps?.buildUpCounts).toMatch(/No stock future has a live price and OI change/);
    expect(d.fiiDii).toEqual([]);
    expect(d.gaps?.fiiDii).toMatch(/FII\/DII figures are not loaded/);
    expect(d.gaps?.indices).toBeUndefined();

    expect(d.chains.map((c) => c.symbol)).toEqual(['NIFTY', 'BANKNIFTY', 'SENSEX']);
    const nifty = d.chains[0];
    expect(nifty).toMatchObject({ expiry: b.expiries.NIFTY[0], spot: 25000, orb: null, flow: null });
    expect(nifty.pcr).toBeGreaterThan(0);
    expect(nifty.atmIv).toBeCloseTo(b.vols.NIFTY * 100, 0);
    expect(nifty.coverage).toEqual(expect.any(String));
    expect(nifty.gaps?.orb).toEqual(expect.any(String));
    expect(nifty.gaps?.flow).toMatch(/No recorded minute of the NIFTY .* future on 2026-10-12/);
    expect(nifty.gaps?.chain).toBeUndefined();
    // SENSEX is not in the (test) instrument master: its card is blank with the reason, the rest is served.
    expect(d.chains[2]).toMatchObject({ symbol: 'SENSEX', expiry: null, spot: null, pcr: null, maxPain: null, atmIv: null, orb: null, flow: null, coverage: null });
    expect(d.chains[2].gaps?.chain).toMatch(/SENSEX/);

    // Official files, today's recorded minutes and the previous session's futures OI arrive.
    const m1 = b.expiries.RELIANCE[0];
    p.history.writeFo(b.recordedDate, { futures: [{ symbol: 'RELIANCE', date: b.recordedDate, expiry: m1, close: 1395, oi: 1_000_000, volume: 10 }] });
    p.history.writeFiiDii(fiiDay('2026-10-08', 120.5));
    p.history.writeFiiDii(fiiDay(b.recordedDate, -80));
    recordToday(p, b);
    p.advance(5_000); // past the 5 s futures cache
    p.setQuote(spotKey('NIFTY'), { ltp: 25000 });
    ({ status, body } = await call(app, 'GET', '/api/dashboard'));
    expect(status).toBe(200);
    d = body as DashboardResponse;
    expect(d.oiGainers).toEqual([{ symbol: 'RELIANCE', ltp: 1400, changePct: 0.72, oiChangePct: 20, buildUp: 'Long Build-up' }]);
    expect(d.buildUpCounts).toEqual({ 'Long Build-up': 1, 'Short Build-up': 0, 'Short Covering': 0, 'Long Unwinding': 0, Neutral: 0 });
    expect(d.buildUpClassified).toBe(1);
    expect(d.fiiDii.map((x) => [x.date, x.fiiNet])).toEqual([
      ['2026-10-08', 120.5],
      [b.recordedDate, -80],
    ]);
    expect(d.gaps?.oiGainers).toBeUndefined();
    expect(d.gaps?.buildUpCounts).toBeUndefined();
    expect(d.gaps?.fiiDii).toBeUndefined();
    const n2 = d.chains[0];
    expect(n2.orb).not.toBeNull();
    expect(n2.orb!.high).toBeGreaterThanOrEqual(n2.orb!.low);
    expect(n2.orb!.summary).toEqual(expect.any(String));
    // The ORB card names the session of its range; the flow card carries its (here empty) feed-gap and lower-bound fields.
    expect(n2.orb).toMatchObject({ date: b.date, live: true, note: null });
    expect(n2.flow).toEqual({ buyPct: 77.8, unclassifiedPct: 10, delta: 500, sentiment: 'Buyers dominant', method: ORDER_FLOW_METHOD, ts: hm(b.date, '10:58'), gapVolume: 0, partial: false, note: null });
    expect(n2.gaps).toBeUndefined();
  });

  it('the flow card shows a feed gap and a lower-bound minute explicitly: gap volume is never classified', async () => {
    const { app, p, book } = await setup();
    const b = book as SampleBook;
    const fut = futKey('NIFTY', b.expiries.NIFTY[1]);
    // 10:58: 800 units reported after a feed gap and nothing else; the card must not turn them into a buy/sell share.
    p.intraday.addMinutes(fut, [
      { ts: hm(b.date, '10:57'), open: 25100, high: 25101, low: 25099, close: 25100, traded: true, volume: 1000, buyVolume: 700, sellVolume: 200, unclassified: 100 },
      { ts: hm(b.date, '10:58'), open: 25100, high: 25100, low: 25100, close: 25100, traded: false, volume: 0, gapVolume: 800, buyVolume: 0, sellVolume: 0, unclassified: 0 },
    ]);
    let d = (await call(app, 'GET', '/api/dashboard')).body as DashboardResponse;
    expect(d.chains[0].flow).toMatchObject({ ts: hm(b.date, '10:58'), sentiment: 'Feed gap', buyPct: null, unclassifiedPct: null, delta: 0, gapVolume: 800, partial: false });
    expect(d.chains[0].flow?.note).toBe('10:58: a feed gap ended in this minute — 800 units traded during the gap are not classified');
    // A gap that ended inside a minute that also traded: the traded part is classified, the gap part is only reported.
    p.intraday.addMinutes(fut, [{ ts: hm(b.date, '10:59'), open: 25100, high: 25101, low: 25099, close: 25100, traded: true, volume: 100, gapVolume: 50, buyVolume: 80, sellVolume: 20, unclassified: 0, partial: true }]);
    d = (await call(app, 'GET', '/api/dashboard')).body as DashboardResponse;
    expect(d.chains[0].flow).toMatchObject({ ts: hm(b.date, '10:59'), sentiment: 'Buyers dominant', buyPct: 80, delta: 60, gapVolume: 50, partial: true });
    expect(d.chains[0].flow?.note).toBe('10:59: a feed gap ended in this minute — 50 units traded during the gap are not classified; 10:59: recording started inside this minute — its volume is a lower bound');
  });

  it('the ORB card names the session of its range: before 09:15 and on a holiday it is the previous session\'s, and says so', async () => {
    const { app, p, book } = await setup();
    const b = book as SampleBook;
    // Monday 08:30: today\'s session has not opened; the range is Friday\'s (recorded in full).
    p.setNow(hm(b.date, '08:30'));
    let d = (await call(app, 'GET', '/api/dashboard')).body as DashboardResponse;
    expect(d.chains[0].orb).toMatchObject({ date: b.recordedDate, live: false, note: `Previous session (${b.recordedDate}): today's session opens at 09:15` });
    // Sunday: not a trading day.
    p.setNow(hm('2026-10-11', '12:00'));
    d = (await call(app, 'GET', '/api/dashboard')).body as DashboardResponse;
    expect(d.chains[0].orb).toMatchObject({ date: b.recordedDate, live: false, note: `Last session (${b.recordedDate}): 2026-10-11 is not a trading day` });
    // Open session: its own range, no note.
    p.setNow(hm(b.date, '11:00'));
    recordToday(p, b);
    d = (await call(app, 'GET', '/api/dashboard')).body as DashboardResponse;
    expect(d.chains[0].orb).toMatchObject({ date: b.date, live: true, note: null });
  });

  it('answers 200 with every card blank (and its reason) before the instrument master or any data exists', async () => {
    const { app, p } = await setup({ sample: false });
    p.ref.setLoaded(false);
    const { status, body } = await call(app, 'GET', '/api/dashboard');
    expect(status).toBe(200);
    const d = body as DashboardResponse;
    expect(d.indices).toEqual([]);
    expect(d.gaps?.indices).toMatch(/Instrument master not loaded yet/);
    expect(d.gaps?.movers).toBe('Instrument master not loaded yet');
    expect([d.gainers, d.losers, d.oiGainers, d.fiiDii]).toEqual([[], [], [], []]);
    expect(d.buildUpCounts).toBeNull();
    expect(d.chains).toHaveLength(3);
    for (const c of d.chains) {
      expect(c).toMatchObject({ expiry: null, spot: null, pcr: null, orb: null, flow: null });
      expect(c.gaps?.chain).toBe('Instrument master not loaded yet');
    }
    expect(d.gaps?.fiiDii).toEqual(expect.any(String));
  });
});

/* ------------------------------------------------------------------------------------------ */

const MARKET_GETS = [
  '/api/health',
  '/api/meta',
  '/api/clock',
  '/api/quotes',
  '/api/indices',
  '/api/expiries/NIFTY',
  '/api/chain/NIFTY',
  '/api/futures/NIFTY',
  '/api/candles/NIFTY?interval=D&days=10',
  '/api/candles/NIFTY?interval=5',
  '/api/dashboard',
  '/api/orb',
  '/api/orb/NIFTY',
  '/api/orb/NIFTY/history?days=5',
  '/api/order-flow/NIFTY',
  '/api/oi/strikes/NIFTY',
  '/api/oi/multi-strike/NIFTY',
  '/api/oi/trend/NIFTY',
  '/api/oi/pcr/NIFTY',
  '/api/oi/max-pain/NIFTY',
  '/api/oi/futures',
  '/api/oi/breadth',
  '/api/participants',
  '/api/fii-dii',
  '/api/straddle/NIFTY',
  '/api/scanners',
  ...SCANNERS.map((x) => `/api/scanners/${x.id}`),
  '/api/unusual',
  '/api/synopsis',
  '/api/order-book/NIFTY',
  '/api/algos',
];

describe('market routes never answer 500', () => {
  for (const sample of [true, false]) {
    it(`every route answers 200, or 503 with code NO_LIVE_DATA and the reason (${sample ? 'sample book' : 'nothing loaded'})`, async () => {
      const { app, p, book } = await setup({ sample });
      if (!sample) p.ref.setLoaded(false);
      const w1 = book?.expiries.NIFTY[0] ?? '2026-10-13';
      const leg = { side: 'BUY', type: 'CE', strike: 25000, expiry: w1, lots: 1, price: 0 };
      const posts: [string, unknown][] = [
        ['/api/optimizer', { symbol: 'NIFTY', expiry: w1, targetPrice: 25200, targetDate: w1 }],
        ['/api/strategy-chart', { symbol: 'NIFTY', legs: [leg], date: book?.recordedDate }],
        ['/api/recap', { symbol: 'NIFTY', legs: [leg], fromTs: hm(book?.recordedDate ?? '2026-10-09', '09:30') }],
      ];
      const seen: Record<string, number> = {};
      for (const url of MARKET_GETS) {
        const { status, body } = await call(app, 'GET', url);
        seen[url] = status;
        expect([200, 503], `${url} → ${status} ${JSON.stringify(body)}`).toContain(status);
        if (status === 503) {
          expect(body.code, url).toBe('NO_LIVE_DATA');
          expect(body.error, url).toEqual(expect.any(String));
          expect(body.error.length, url).toBeGreaterThan(5);
        }
      }
      for (const [url, payload] of posts) {
        const { status, body } = await call(app, 'POST', url, payload);
        seen[url] = status;
        expect([200, 503], `${url} → ${status} ${JSON.stringify(body)}`).toContain(status);
        if (status === 503) expect(body.code, url).toBe('NO_LIVE_DATA');
      }
      if (sample) {
        // What the sample book holds is served.
        for (const url of ['/api/quotes', '/api/chain/NIFTY', '/api/futures/NIFTY', '/api/oi/strikes/NIFTY', '/api/oi/max-pain/NIFTY', '/api/oi/futures', '/api/oi/trend/NIFTY?date=' + book!.recordedDate, '/api/optimizer', '/api/strategy-chart']) {
          if (url.includes('?')) expect((await call(app, 'GET', url)).status, url).toBe(200);
          else expect(seen[url], url).toBe(200);
        }
      } else {
        for (const url of ['/api/quotes', '/api/chain/NIFTY', '/api/orb', '/api/optimizer']) expect(seen[url], url).toBe(503);
        expect(seen['/api/health']).toBe(200);
        expect(seen['/api/dashboard']).toBe(200);
      }
    });
  }

  it('unknown symbols are 404; malformed queries are 400', async () => {
    const { app } = await setup();
    for (const url of ['/api/chain/NOPE', '/api/expiries/NOPE', '/api/futures/NOPE', '/api/candles/NOPE', '/api/orb/NOPE', '/api/order-flow/NOPE', '/api/oi/strikes/NOPE', '/api/oi/max-pain/NOPE', '/api/straddle/NOPE', '/api/order-book/NOPE', '/api/scanners/nope']) {
      const { status, body } = await call(app, 'GET', url);
      expect(status, `${url} ${JSON.stringify(body)}`).toBe(404);
    }
    for (const url of [
      '/api/orb?minutes=0',
      '/api/orb/NIFTY?rule=bogus',
      '/api/orb/NIFTY?date=2030-01-05',
      '/api/orb/NIFTY?date=12-10-2026',
      '/api/order-flow/NIFTY?type=XX',
      '/api/order-flow/NIFTY?strike=-5',
      '/api/order-flow/NIFTY?date=2030-01-05',
      '/api/chain/NIFTY?at=yesterday',
      '/api/chain/NIFTY?expiry=2026-10-14',
    ]) {
      const { status, body } = await call(app, 'GET', url);
      expect(status, `${url} ${JSON.stringify(body)}`).toBe(400);
    }
  });
});

describe('straddle route', () => {
  it('a malformed or out-of-range strike or width is a 400 with the reason, never snapped to ATM or to the end of the strip', async () => {
    const { app, book } = await setup();
    const b = book as SampleBook;
    const url = (q: string) => `/api/straddle/NIFTY?date=${b.recordedDate}&expiry=${b.expiries.NIFTY[0]}&mode=fixed&interval=60${q}`;
    for (const [q, re] of [
      ['&strike=0', /strike must be a positive strike price or 'atm' \(got '0'\)/],
      ['&strike=-1', /strike must be a positive strike price/],
      ['&strike=abc', /strike must be a positive strike price/],
      ['&strike=1e999', /strike must be a positive strike price/],
      ['&strike=99999', /Strike 99999 is outside the NIFTY .* strikes/],
      ['&strike=100', /Strike 100 is outside the NIFTY .* strikes/],
      ['&strike=25000&width=-5', /width must be a non-negative number of points \(got '-5'\)/],
      ['&strike=25000&width=abc', /width must be a non-negative number/],
      ['&strike=25000&width=1000000', /Strangle width 1000000 is wider than the NIFTY .* allow/],
    ] as [string, RegExp][]) {
      const r = await call(app, 'GET', url(q));
      expect(r.status, q).toBe(400);
      expect(r.body.error, q).toMatch(re);
    }
    // Valid requests are unchanged: a listed strike, ATM, a strangle.
    expect((await call(app, 'GET', url('&strike=25000'))).body.points[0]).toMatchObject({ strike: 25000, ceStrike: 25000, peStrike: 25000 });
    expect((await call(app, 'GET', url('&strike=atm'))).status).toBe(200);
    expect((await call(app, 'GET', url('&strike=25000&width=100'))).body.points[0]).toMatchObject({ ceStrike: 25100, peStrike: 24900 });
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('official, OI and strategy-tool routes', () => {
  it('fii-dii and participants serve the loaded official days of the range; 503 with the reason before', async () => {
    const { app, p, book } = await setup();
    const b = book as SampleBook;
    let res = await call(app, 'GET', '/api/fii-dii?days=5');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'NO_LIVE_DATA' });
    expect(res.body.error).toMatch(/none loaded yet/);
    p.history.writeFiiDii(fiiDay('2026-09-01', 10)); // outside the last 5 sessions
    p.history.writeFiiDii(fiiDay(b.recordedDate, 55));
    res = await call(app, 'GET', '/api/fii-dii?days=5');
    expect(res.status).toBe(200);
    expect(res.body.map((x: FiiDiiDay) => x.date)).toEqual([b.recordedDate]);
    res = await call(app, 'GET', '/api/fii-dii?days=60');
    expect(res.body.map((x: FiiDiiDay) => x.date)).toEqual(['2026-09-01', b.recordedDate]);

    expect((await call(app, 'GET', '/api/participants')).status).toBe(503);
    const row = { futIndexLong: 1, futIndexShort: 2, futStockLong: 3, futStockShort: 4, optIndexCallLong: 5, optIndexCallShort: 6, optIndexPutLong: 7, optIndexPutShort: 8, optStockCallLong: 9, optStockCallShort: 10, optStockPutLong: 11, optStockPutShort: 12 };
    const pd: ParticipantDay = { date: b.recordedDate, niftyClose: 24800, rows: [{ participant: 'FII', ...row }] };
    p.history.writeParticipants(pd);
    res = await call(app, 'GET', '/api/participants?days=5');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([pd]);
  });

  it('oi/pcr returns the combined intraday (recorded) and daily (official) view', async () => {
    const { app, book } = await setup();
    const b = book as SampleBook;
    const res = await call(app, 'GET', `/api/oi/pcr/NIFTY?date=${b.recordedDate}&expiry=${b.expiries.NIFTY[0]}&interval=15`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ symbol: 'NIFTY', expiry: b.expiries.NIFTY[0] });
    expect(res.body.intraday.length).toBeGreaterThan(20);
    // No official previous-close file in this book: the OI changes and the change PCR are blank (null), not 0.
    expect(res.body.intraday[0]).toEqual({ ts: expect.any(Number), pcr: expect.any(Number), spot: expect.any(Number), ceOi: expect.any(Number), peOi: expect.any(Number), ceChange: null, peChange: null, changePcr: null });
    expect(res.body.gaps?.['intraday.change']).toMatch(/OI change vs the previous close is blank/);
    expect(res.body.coverage).toEqual({ intraday: expect.stringMatching(/streamed strikes/), daily: expect.any(String) });
    expect(res.body.gaps?.daily).toEqual(expect.any(String));
  });

  it('strategy chart and recap resolve lot sizes themselves and never default one', async () => {
    const { app, book } = await setup();
    const b = book as SampleBook;
    const w1 = b.expiries.NIFTY[0];
    const leg = { side: 'SELL', type: 'CE', strike: 25000, expiry: w1, lots: 2, price: 0 };
    let res = await call(app, 'POST', '/api/strategy-chart', { symbol: 'NIFTY', legs: [leg], date: b.recordedDate, interval: 30 });
    expect(res.status).toBe(200);
    // premium = −2 × price (2 lots sold, per unit); P&L = −2 lots × 75 (the listing's lot size) × (price − entry).
    const pts = (res.body as { premium: number | null; pnl: number | null }[]).filter((x) => x.premium !== null && x.pnl !== null);
    expect(pts.length).toBeGreaterThan(5);
    const entry = -(pts[0].premium as number) / 2;
    const moved = pts.filter((x) => -(x.premium as number) / 2 !== entry);
    expect(moved.length).toBeGreaterThan(0);
    for (const x of moved) expect(x.pnl).toBeCloseTo(-150 * (-(x.premium as number) / 2 - entry), 1);

    // An unlisted contract with no official file: the lot size is unknown → 503, never 1.
    const unlisted = { side: 'BUY', type: 'CE', strike: 25025, expiry: w1, lots: 1, price: 10 };
    res = await call(app, 'POST', '/api/recap', { symbol: 'NIFTY', legs: [unlisted], fromTs: hm(b.recordedDate, '09:30') });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/Lot size of NIFTY .* is unknown/);
    // A lot size sent with the leg is used for such a contract.
    res = await call(app, 'POST', '/api/recap', { symbol: 'NIFTY', legs: [{ ...unlisted, lotSize: 75 }], fromTs: hm(b.recordedDate, '09:30') });
    expect(res.body.error ?? '').not.toMatch(/Lot size/);
    expect((await call(app, 'POST', '/api/recap', { symbol: 'NIFTY', legs: [{ ...unlisted, lotSize: 0 }], fromTs: hm(b.recordedDate, '09:30') })).status).toBe(400);
  });

  it('order book and order flow stream their contract in the provider\'s user tier', async () => {
    const { app, p, svc, book } = await setup();
    const b = book as SampleBook;
    const m1 = b.expiries.NIFTY[1];
    const res = await call(app, 'GET', `/api/order-book/NIFTY?type=FUT&expiry=${m1}`);
    expect([200, 503]).toContain(res.status);
    const ids = (lvl: string) => svc.userWatches.list().map((c) => ('key' in c ? c : { key: c, level: 'quote' })).filter((c) => c.level === lvl).map((c) => keyId(c.key));
    expect(ids('depth')).toContain(keyId(futKey('NIFTY', m1)));
    expect(p.userContracts()).toContainEqual({ key: futKey('NIFTY', m1), level: 'depth' });
    await call(app, 'GET', `/api/order-flow/NIFTY?type=CE&strike=25000&expiry=${b.expiries.NIFTY[0]}`);
    expect(ids('quote')).toContain(keyId(optKey('NIFTY', b.expiries.NIFTY[0], 'CE', 25000)));
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('accounts and paper trading over HTTP', () => {
  it('user routes need a token; register, login, wrong password, guest, settings', async () => {
    const { app } = await setup();
    for (const url of ['/api/strategies', '/api/broker/funds', '/api/broker/positions', '/api/alerts', '/api/watchlists', '/api/notifications', '/api/algo-runs', '/api/auth/me']) {
      expect((await call(app, 'GET', url)).status, url).toBe(401);
    }
    const reg = await call(app, 'POST', '/api/auth/register', { name: 'Test', email: 'a@example.com', password: 'secret1' });
    expect(reg.status).toBe(200);
    expect(reg.body.user.email).toBe('a@example.com');
    expect((await call(app, 'POST', '/api/auth/register', { name: 'Test', email: 'a@example.com', password: 'secret1' })).status).toBe(409);
    expect((await call(app, 'POST', '/api/auth/login', { email: 'a@example.com', password: 'wrong-one' })).status).toBe(401);
    const login = await call(app, 'POST', '/api/auth/login', { email: 'a@example.com', password: 'secret1' });
    expect(login.status).toBe(200);
    const me = await call(app, 'GET', '/api/auth/me', undefined, login.body.token);
    expect(me.body.email).toBe('a@example.com');
    const set = await call(app, 'PUT', '/api/settings', { theme: 'light', strikesAround: 12 }, login.body.token);
    expect(set.body.settings).toMatchObject({ theme: 'light', strikesAround: 12 });
    expect((await call(app, 'PUT', '/api/settings', { strikesAround: 1 }, login.body.token)).status).toBe(400);
    const guest = await call(app, 'POST', '/api/auth/guest', {});
    expect(guest.body.token).toEqual(expect.any(String));
  });

  it('paper orders fill at the live book, baskets report bad orders, positions exit, funds and reset', async () => {
    const { app, p, book } = await setup();
    const b = book as SampleBook;
    const token = (await call(app, 'POST', '/api/auth/guest', {})).body.token as string;
    const w1 = b.expiries.NIFTY[0];
    const q = p.live.quote(optKey('NIFTY', w1, 'CE', 25000))!;
    const order = { symbol: 'NIFTY', type: 'CE', strike: 25000, expiry: w1, side: 'BUY', lots: 1, orderType: 'MARKET' };
    let res = await call(app, 'POST', '/api/broker/orders', order, token);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'COMPLETE', avgPrice: q.ask, quantity: 75 });

    res = await call(app, 'POST', '/api/broker/basket', { orders: [order, { ...order, strike: 25025 }] }, token);
    expect(res.status).toBe(200);
    expect(res.body[0]).toMatchObject({ status: 'COMPLETE' });
    expect(res.body[1].error).toEqual(expect.any(String));

    res = await call(app, 'GET', '/api/broker/positions', undefined, token);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ netQty: 150, status: 'open', ltp: q.ltp });
    res = await call(app, 'POST', '/api/broker/positions/exit', { key: res.body[0].key }, token);
    // The exit answers with the orders placed: one slice here (no freeze quantity is listed for the contract).
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ side: 'SELL', status: 'COMPLETE', avgPrice: q.bid, quantity: 150, tag: 'exit' });
    expect((await call(app, 'GET', '/api/broker/positions', undefined, token)).body[0]).toMatchObject({ netQty: 0, status: 'closed' });
    expect((await call(app, 'GET', '/api/broker/trades', undefined, token)).body).toHaveLength(3);
    const funds = await call(app, 'GET', '/api/broker/funds', undefined, token);
    expect(funds.status).toBe(200);
    expect(funds.body.realizedPnl).toBeCloseTo(150 * ((q.bid as number) - (q.ask as number)), 2);

    // A LIMIT order below the ask works; cancel it.
    res = await call(app, 'POST', '/api/broker/orders', { ...order, orderType: 'LIMIT', price: 1 }, token);
    expect(res.body.status).toBe('OPEN');
    res = await call(app, 'DELETE', `/api/broker/orders/${res.body.id}`, undefined, token);
    expect(res.body.status).toBe('CANCELLED');
    // Tick size is enforced (₹0.05).
    res = await call(app, 'POST', '/api/broker/orders', { ...order, orderType: 'LIMIT', price: 1.03 }, token);
    expect(res.status === 400 || res.body.status === 'REJECTED').toBe(true);

    expect((await call(app, 'POST', '/api/broker/reset', {}, token)).body).toEqual({ ok: true });
    expect((await call(app, 'GET', '/api/broker/orders', undefined, token)).body).toEqual([]);
  });

  it('strategies, alerts, notifications and watchlists', async () => {
    const { app, p, svc, book } = await setup();
    const b = book as SampleBook;
    const token = (await call(app, 'POST', '/api/auth/guest', {})).body.token as string;
    const w1 = b.expiries.NIFTY[0];
    const q = p.live.quote(optKey('NIFTY', w1, 'CE', 25000))!;

    // Virtual strategies.
    let res = await call(app, 'POST', '/api/strategies', { name: 'Test long call', symbol: 'NIFTY', legs: [{ side: 'BUY', type: 'CE', strike: 25000, expiry: w1, lots: 1, price: 0 }] }, token);
    expect(res.status).toBe(200);
    const sid = res.body.id as string;
    expect(res.body.legs[0]).toMatchObject({ lotSize: 75, price: q.ltp });
    res = await call(app, 'GET', '/api/strategies', undefined, token);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].live.mtm).toBe(0);
    res = await call(app, 'PUT', `/api/strategies/${sid}`, { name: 'Renamed' }, token);
    expect(res.body.name).toBe('Renamed');
    res = await call(app, 'POST', `/api/strategies/${sid}/exit`, {}, token);
    expect(res.status).toBe(200);
    expect(res.body.legs[0].exitPrice).toBe(q.bid);
    expect((await call(app, 'DELETE', `/api/strategies/${sid}`, undefined, token)).body).toEqual({ ok: true });
    expect((await call(app, 'GET', `/api/strategies/${sid}`, undefined, token)).status).toBe(404);

    // Alerts: a PRICE alert fires on the live spot and notifies.
    res = await call(app, 'POST', '/api/alerts', { kind: 'PRICE', symbol: 'NIFTY', condition: 'above', value: 25100 }, token);
    expect(res.status).toBe(200);
    const aid = res.body.id as string;
    expect((await call(app, 'POST', '/api/alerts', { kind: 'PRICE', symbol: 'NOPE', condition: 'above', value: 1 }, token)).status).toBe(404);
    expect((await call(app, 'PATCH', `/api/alerts/${aid}`, { status: 'disabled' }, token)).body.status).toBe('disabled');
    expect((await call(app, 'PATCH', `/api/alerts/${aid}`, { status: 'active' }, token)).body.status).toBe('active');
    p.setQuote(spotKey('NIFTY'), { ltp: 25150 });
    await svc.alerts.evaluate();
    res = await call(app, 'GET', '/api/alerts', undefined, token);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe('triggered');
    const notes = await call(app, 'GET', '/api/notifications', undefined, token);
    expect(notes.body.length).toBeGreaterThan(0);
    expect(notes.body[0].read).toBe(false);
    expect((await call(app, 'DELETE', `/api/alerts/${aid}`, undefined, token)).body).toEqual({ ok: true });
    expect((await call(app, 'GET', '/api/alerts', undefined, token)).body).toEqual([]);
    expect((await call(app, 'GET', '/api/notifications', undefined, token)).status).toBe(200);
    expect((await call(app, 'POST', '/api/notifications/read', {}, token)).body).toEqual({ ok: true });

    // Watchlists with live quotes (blank, never 0, when not live).
    res = await call(app, 'POST', '/api/watchlists', { name: 'Mine' }, token);
    const wid = res.body.id as string;
    res = await call(app, 'PUT', `/api/watchlists/${wid}`, { items: [{ symbol: 'NIFTY', type: 'EQ' }, { symbol: 'NIFTY', type: 'CE', strike: 25000, expiry: w1 }] }, token);
    expect(res.body.items).toHaveLength(2);
    res = await call(app, 'GET', `/api/watchlists/${wid}/quotes`, undefined, token);
    expect(res.status).toBe(200);
    expect(res.body.map((x: { ltp: number | null }) => x.ltp)).toEqual([25150, q.ltp]);
    p.live.clearQuote(optKey('NIFTY', w1, 'CE', 25000));
    res = await call(app, 'GET', `/api/watchlists/${wid}/quotes`, undefined, token);
    expect(res.body[1].ltp).toBeNull();
    expect(res.body[1].reason).toEqual(expect.any(String));
    expect((await call(app, 'DELETE', `/api/watchlists/${wid}`, undefined, token)).body).toEqual({ ok: true });
  });
});
