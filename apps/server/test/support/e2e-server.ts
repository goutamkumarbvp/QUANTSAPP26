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
  p.history.writeFo(d, { futures, options });
}
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
