/**
 * TEST-ONLY. The Playwright FIXTURE server (apps/web/playwright.config.ts starts it with tsx): the
 * real Fastify app and services over the in-memory FakeProvider with loadSampleBook() — so the web
 * can be checked with real-looking values (solved IV, scanners, ORB, order flow, paper fills).
 *
 * Every price, OI and volume served here is TEST DATA made by fake-provider.ts and this file; none of
 * it is market data. src/ must never import this file and `npm start` never reaches it: the
 * application itself runs on live data only (src/index.ts → LiveProvider).
 *
 * The fake clock stands still at the sample book's time (2026-10-12 11:00 IST, market open), so every
 * run renders the same values.
 */
import { bsPrice, expiryTs, YEAR_MS } from '@q26/core';
import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import type { InstrumentKey, MinuteRecord } from '../../src/live/types';
import { futKey, spotKey } from '../../src/services/live';
import { createServices } from '../../src/services';
import { FakeProvider, loadSampleBook, type SampleBook } from './fake-provider';
import { testMcx } from './e2e-mcx';

const port = Number(process.env.E2E_FIXTURE_PORT ?? 8791);
const host = process.env.HOST ?? '127.0.0.1';

const p = new FakeProvider();
const book: SampleBook = loadSampleBook(p);

/**
 * TEST bars of today's session up to 10:59 (complete by the 11:00 clock): NIFTY spot on a small
 * deterministic zig-zag (gives the 15-minute opening range and its breakout), and the near NIFTY
 * future with the recorder's quote-rule split (buy/sell/unclassified), one feed-gap minute and one
 * partial minute so the web's "feed gap" and "partial (lower bound)" labels are exercised.
 */
function recordToday(): void {
  const m1 = book.expiries.NIFTY[1];
  const close = (m: number) => 25000 + ((m % 9) - 4) * 3 + (m > 60 ? 15 : 0);
  for (let m = 0; m < 105; m++) {
    const ts = p.calendar.ts(book.date, m);
    const o = m ? close(m - 1) : 25000;
    const c = close(m);
    const spot: MinuteRecord = { ts, open: o, high: Math.max(o, c) + 1, low: Math.min(o, c) - 1, close: c, traded: true };
    p.intraday.addMinutes(spotKey('NIFTY'), [spot]);
    const f = Math.round((book.futures[`NIFTY|${m1}`] - 25000 + c) * 20) / 20;
    const volume = 900 + (m % 7) * 150;
    const buy = Math.round(volume * (m % 3 === 0 ? 0.35 : 0.55));
    const sell = Math.round(volume * 0.3);
    const fut: MinuteRecord =
      m === 40
        ? { ts, open: f, high: f, low: f, close: f, traded: false, volume: 0, gapVolume: 1200, buyVolume: 0, sellVolume: 0, unclassified: 0 }
        : { ts, open: f, high: f + 1, low: f - 1, close: f, traded: true, volume, buyVolume: buy, sellVolume: sell, unclassified: volume - buy - sell, oi: 1_195_000 + m * 50, ...(m === 0 ? { partial: true } : {}) };
    p.intraday.addMinutes(futKey('NIFTY', m1), [fut]);
  }
}
recordToday();

/**
 * TEST official F&O file of the previous session: the futures at a lower close and OI (so the build-up
 * scanners and the dashboard's OI cards have rows) and the NIFTY weekly chain at 90 % of today's OI
 * and 2 % above today's premiums (so the chain's OI change column is filled).
 */
function officialPreviousSession(): void {
  const d = book.recordedDate;
  const futures = Object.entries(book.futures).map(([id, price]) => {
    const [symbol, expiry] = id.split('|');
    return { symbol, date: d, expiry, close: Math.round(price * 0.995 * 20) / 20, oi: 1_000_000, volume: 250_000 };
  });
  const options = [];
  // The weekly and the monthly NIFTY chain (the monthly carries today's recorded test chain, below).
  for (const exp of [book.expiries.NIFTY[0], book.expiries.NIFTY[1]]) {
    for (const strike of p.ref.strikes('NIFTY', exp)) {
      for (const type of ['CE', 'PE'] as const) {
        const q = p.live.quote({ symbol: 'NIFTY', kind: type, expiry: exp, strike });
        if (!q || q.oi === undefined) continue;
        options.push({ symbol: 'NIFTY', date: d, expiry: exp, strike, type, close: Math.round(q.ltp * 1.02 * 20) / 20, oi: Math.round(q.oi * 0.9), volume: 20_000, lotSize: 75 });
      }
    }
  }
  p.history.writeFo(d, { futures: [...futures, ...heavyPrev.futures], options: [...options, ...heavyPrev.options] });
}
/**
 * TEST heavyweights for the NIFTY Top 10 desk (RELIANCE comes from the sample book): each stock gets a
 * spot, a near-month future and a 21-strike chain priced by Black-76 at a flat test volatility, the
 * previous session's official rows (OI change, build-up, change PCR) and today's recorded future
 * minutes with a stock-specific buyer/seller mix. Test values only.
 */
const HEAVY: [string, string, string, number, number, number][] = [
  // symbol, name, sector, spot, strike step, lot
  ['HDFCBANK', 'HDFC Bank', 'Banks', 1650, 10, 550],
  ['ICICIBANK', 'ICICI Bank', 'Banks', 1300, 10, 700],
  ['INFY', 'Infosys', 'IT', 1550, 20, 400],
  ['BHARTIARTL', 'Bharti Airtel', 'Telecom', 1900, 20, 475],
  ['LT', 'Larsen & Toubro', 'Infra', 3600, 50, 175],
  ['ITC', 'ITC', 'FMCG', 420, 5, 1600],
  ['TCS', 'Tata Consultancy Services', 'IT', 3100, 20, 175],
  ['AXISBANK', 'Axis Bank', 'Banks', 1150, 10, 625],
  ['SBIN', 'State Bank of India', 'Banks', 820, 5, 750],
];
const heavyPrev: { futures: { symbol: string; date: string; expiry: string; close: number; oi: number; volume: number }[]; options: { symbol: string; date: string; expiry: string; strike: number; type: 'CE' | 'PE'; close: number; oi: number; volume: number; lotSize: number }[] } = { futures: [], options: [] };
function addTestHeavyweights(): void {
  const m1 = book.expiries.NIFTY[1];
  const now = p.now();
  const T = Math.max(1e-4, (expiryTs(m1) - now) / YEAR_MS);
  const r = 0.065;
  const tick = (x: number) => Math.round(x * 20) / 20;
  HEAVY.forEach(([symbol, name, sector, spot, step, lot], i) => {
    const chg = ((i % 5) - 2) * 0.006; // −1.2 % … +1.2 %
    p.ref.setUnderlying({ symbol, name, kind: 'stock', sector, lotSize: lot, strikeStep: step });
    p.ref.setFutures(symbol, [m1]);
    p.setQuote({ symbol, kind: 'SPOT' }, { ltp: spot, prevClose: tick(spot / (1 + chg)), open: tick(spot / (1 + chg / 2)), high: tick(spot * 1.006), low: tick(spot * 0.994), volume: 2_000_000 + i * 150_000 });
    const fut = tick(spot * 1.004);
    const oiNow = Math.round(1_000_000 * (1 + ((i % 3) - 1) * 0.05)); // OI −5 %, 0 or +5 % vs the previous session
    p.setQuote({ symbol, kind: 'FUT', expiry: m1 }, { ltp: fut, bid: fut - 0.05, ask: fut + 0.05, oi: oiNow, volume: 400_000 });
    heavyPrev.futures.push({ symbol, date: book.recordedDate, expiry: m1, close: tick(fut / (1 + chg)), oi: 1_000_000, volume: 300_000 });
    const atm = Math.round(spot / step) * step;
    const strikes = Array.from({ length: 21 }, (_, k) => atm + (k - 10) * step);
    const vol = 0.18 + (i % 4) * 0.03;
    const putTilt = 0.7 + (i % 5) * 0.15; // put vs call OI added today
    for (const strike of strikes) {
      for (const type of ['CE', 'PE'] as const) {
        const price = tick(bsPrice(type, fut, strike, T, r, vol, r));
        if (!(price >= 0.05)) continue;
        const away = Math.abs(strike - atm) / step;
        const prevOi = Math.round((60 - 2 * away) * 1000);
        const added = Math.round((type === 'PE' ? putTilt : 1) * (12 - away / 2) * 1000);
        p.setQuote({ symbol, kind: type, expiry: m1, strike }, { ltp: price, bid: tick(Math.max(0.05, price - 0.05)), ask: tick(price + 0.05), oi: prevOi + added, volume: (30 - away) * 1000, ts: now });
        heavyPrev.options.push({ symbol, date: book.recordedDate, expiry: m1, strike, type, close: tick(price * 1.02), oi: prevOi, volume: 10_000, lotSize: lot });
      }
    }
    p.ref.setStrikes(symbol, m1, strikes);
    // Today's recorded future minutes (09:15–10:59) and spot minutes (opening range).
    const buyShare = 0.35 + (i % 4) * 0.1; // 35 % … 65 % of the classified volume
    for (let m = 0; m < 105; m++) {
      const ts = p.calendar.ts(book.date, m);
      const drift = (chg >= 0 ? 1 : -1) * Math.min(1, m / 60);
      const px = tick(spot * (1 - chg / 2 + (chg / 2) * drift) + Math.sin(m / 5) * step * 0.2);
      const volume = 600 + ((m * (i + 3)) % 9) * 120;
      const buy = Math.round(volume * buyShare * 0.85);
      const sell = Math.round(volume * (1 - buyShare) * 0.85);
      p.intraday.addMinutes(spotKey(symbol), [{ ts, open: px, high: px + step * 0.1, low: px - step * 0.1, close: px, traded: true }]);
      p.intraday.addMinutes(futKey(symbol, m1), [{ ts, open: tick(px * 1.004), high: tick(px * 1.004) + 1, low: tick(px * 1.004) - 1, close: tick(px * 1.004), traded: true, volume, buyVolume: buy, sellVolume: sell, unclassified: volume - buy - sell, oi: oiNow }]);
    }
  });
}
addTestHeavyweights();

officialPreviousSession();

/**
 * TEST chain minutes of today for the NIFTY MONTHLY (so the OI trend and the change-in-OI PCR have a
 * session to draw; the weekly stays unrecorded today, which the algo replay test relies on): every strike's OI moves from the previous official close (90 %) to today's live OI,
 * puts a little ahead of calls in the morning. Test values only.
 */
function recordTodayChain(): void {
  const w1 = book.expiries.NIFTY[1];
  const legs: { key: InstrumentKey; from: number; to: number; ltp: number; put: boolean }[] = [];
  for (const strike of p.ref.strikes('NIFTY', w1)) {
    for (const type of ['CE', 'PE'] as const) {
      const key: InstrumentKey = { symbol: 'NIFTY', kind: type, expiry: w1, strike };
      const q = p.live.quote(key);
      if (!q || q.oi === undefined) continue;
      legs.push({ key, from: Math.round(q.oi * 0.9), to: q.oi, ltp: q.ltp, put: type === 'PE' });
    }
  }
  for (let m = 0; m < 105; m++) {
    const ts = p.calendar.ts(book.date, m);
    const share = (put: boolean) => Math.min(1, ((m + 1) / 105) * (put ? 1 + 0.4 * Math.sin(m / 17) : 1 - 0.2 * Math.sin(m / 23)));
    let ceOi = 0;
    let peOi = 0;
    for (const l of legs) {
      const oi = Math.round(l.from + (l.to - l.from) * Math.max(0, share(l.put)));
      p.intraday.addMinutes(l.key, [{ ts, open: l.ltp, high: l.ltp, low: l.ltp, close: l.ltp, traded: true, oi }]);
      if (l.put) peOi += oi;
      else ceOi += oi;
    }
    p.intraday.writeChainMinutes([{ symbol: 'NIFTY', expiry: w1, rec: { ts, spot: 25000, ceOi, peOi, ceVolume: null, peVolume: null, pcr: ceOi > 0 ? peOi / ceOi : null, maxPain: 25000, atmStrike: 25000, atmIv: 0.14 } }]);
  }
}
recordTodayChain();

// TEST-ONLY MCX contracts and quotes (synthetic), so the MCX Option Chain page has something to show.
(p as unknown as { mcx: ReturnType<typeof testMcx> }).mcx = testMcx(() => p.now(), book.date);

const config = loadConfig({ port, host, persist: false, authSecret: process.env.AUTH_SECRET || 'e2e-fixture' });
const svc = createServices(config, { provider: p, onError: (where, e) => console.warn(`${where} failed: ${e instanceof Error ? e.message : String(e)}`) });
const app = await buildApp(svc, { logger: false });
svc.start();

const shutdown = async () => {
  svc.stop();
  await app.close();
  p.dispose();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port, host });
console.log(`E2E fixture server (TEST DATA, FakeProvider) on http://${host}:${port}, clock ${book.date} 11:00 IST`);
