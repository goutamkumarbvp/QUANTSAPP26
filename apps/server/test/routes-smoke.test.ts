/**
 * Phase C review, lens "endpoint correctness and robustness": EVERY route of app.ts (the table below
 * is checked against the source) in several data states of the TEST-ONLY FakeProvider:
 *  - full     — loadSampleBook (open session, live quotes, one recorded session, a few EOD bars);
 *  - partial  — some quotes missing, every order book stale (> 10 s);
 *  - closed   — the same session after 15:30 (session prices stay, books do not);
 *  - stale    — the next session at 11:00 with only the previous session's quotes (nothing live);
 *  - empty    — the instrument master not loaded and nothing live.
 * Invariants: never a 5xx other than 503 { error, code: 'NO_LIVE_DATA' }; error bodies carry a reason;
 * with nothing live no live field (price, book, IV, Greeks, OI, MTM …) is filled. Plus ?at= handling,
 * validation, auth/ownership, websocket fan-out/cleanup, background timers, and the paper broker /
 * algo never filling without a live bid/ask. Every price, OI and flow below is test data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { istTs, maxPain, type OptionChain, type Quote, type ServerMessage } from '@q26/core';
import { gunzipSync } from 'node:zlib';
import { buildApp, GZIP_MIN_BYTES } from '../src/app';
import { loadConfig } from '../src/config';
import { futKey, optKey, spotKey } from '../src/services/live';
import { createServices, type Services } from '../src/services';
import { SCANNERS } from '../src/services/market-tools';
import { FakeProvider, loadSampleBook, type SampleBook } from './support/fake-provider';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const hm = (date: string, hhmm: string) => istTs(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NEXT_DAY = '2026-10-13'; // the trading day after the sample book's 2026-10-12
let registerSeq = 0; // distinct e-mails for the register route

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface Ctx {
  p: FakeProvider;
  b: SampleBook;
  svc: Services;
  app: FastifyInstance;
  token: string;
  ids: { strategy: string; alert: string; order: string; watchlist: string; algoRun: string; position: string };
}

async function setup(opts: { onError?: (where: string, e: unknown) => void } = {}): Promise<Omit<Ctx, 'token' | 'ids'>> {
  const p = new FakeProvider();
  const b = loadSampleBook(p);
  const svc = createServices(loadConfig({ persist: false, authSecret: 'test-secret' }), { provider: p, onError: opts.onError });
  const app = await buildApp(svc, { serveWeb: false });
  cleanup.push(() => p.dispose(), () => svc.stop(), () => app.close());
  return { p, b, svc, app };
}

async function call(app: FastifyInstance, method: Method, url: string, body?: unknown, token?: string) {
  const res = await app.inject({ method, url, ...(body !== undefined ? { payload: body as object } : {}), headers: token ? { authorization: `Bearer ${token}` } : {} });
  let json: unknown = res.body;
  try {
    json = res.json();
  } catch {
    /* not JSON */
  }
  return { status: res.statusCode, body: json as any };
}

/** A guest with one of everything (made while the sample book is live): position, working order, strategy, alert, watchlist, algo run. */
async function withFixtures(c: Omit<Ctx, 'token' | 'ids'>): Promise<Ctx> {
  const { app, b } = c;
  const token = (await call(app, 'POST', '/api/auth/guest', {})).body.token as string;
  const w1 = b.expiries.NIFTY[0];
  const filled = await call(app, 'POST', '/api/broker/orders', { symbol: 'NIFTY', type: 'CE', strike: 25000, expiry: w1, side: 'BUY', lots: 1, orderType: 'MARKET' }, token);
  expect(filled.body.status).toBe('COMPLETE');
  const working = await call(app, 'POST', '/api/broker/orders', { symbol: 'NIFTY', type: 'PE', strike: 25000, expiry: w1, side: 'BUY', lots: 1, orderType: 'LIMIT', price: 1 }, token);
  expect(working.body.status).toBe('OPEN');
  const strategy = await call(app, 'POST', '/api/strategies', { name: 'S', symbol: 'NIFTY', legs: [{ side: 'SELL', type: 'CE', strike: 25100, expiry: w1, lots: 1, price: 0 }], targetMtm: 1000, stopLossMtm: 1000 }, token);
  const alert = await call(app, 'POST', '/api/alerts', { kind: 'PRICE', symbol: 'NIFTY', condition: 'above', value: 30000 }, token);
  for (const a of [
    { kind: 'IV', symbol: 'NIFTY', condition: 'above', value: 90 },
    { kind: 'PCR', symbol: 'NIFTY', condition: 'above', value: 9 },
    { kind: 'OPTION_PRICE', symbol: 'NIFTY', condition: 'above', value: 9999, optionType: 'CE', strike: 25000, expiry: w1 },
    { kind: 'OI_CHANGE', symbol: 'NIFTY', condition: 'above', value: 9999, optionType: 'PE', strike: 25000, expiry: w1 },
    { kind: 'MTM', symbol: 'NIFTY', condition: 'above', value: 1e9, strategyId: strategy.body.id },
    { kind: 'ORB_BREAK', symbol: 'NIFTY', condition: 'above', value: 15 },
    { kind: 'ORDER_FLOW', symbol: 'NIFTY', condition: 'above', value: 99 },
  ]) {
    expect((await call(app, 'POST', '/api/alerts', a, token)).status, a.kind).toBe(200);
  }
  const watchlist = await call(app, 'POST', '/api/watchlists', { name: 'W' }, token);
  await call(app, 'PUT', `/api/watchlists/${watchlist.body.id}`, { items: [{ symbol: 'NIFTY', type: 'EQ' }, { symbol: 'NIFTY', type: 'CE', strike: 25000, expiry: w1 }, { symbol: 'NIFTY', type: 'FUT', expiry: b.expiries.NIFTY[1] }] }, token);
  const run = await call(app, 'POST', '/api/algo-runs', { algoId: 'premium-ladder', params: { symbol: 'NIFTY' } }, token);
  expect(run.status).toBe(200);
  const positions = await call(app, 'GET', '/api/broker/positions', undefined, token);
  const position = (positions.body as { key: string; type: string }[]).find((x) => x.type === 'CE' && x.key.includes('|25000|'))!.key;
  return { ...c, token, ids: { strategy: strategy.body.id, alert: alert.body.id, order: working.body.id, watchlist: watchlist.body.id, algoRun: run.body.id, position } };
}

type State = 'full' | 'partial' | 'closed' | 'stale' | 'empty';

/** Turns the fixture book into one of the data states. */
function enter(state: State, c: Ctx): void {
  const { p, b } = c;
  if (state === 'partial') {
    const w1 = b.expiries.NIFTY[0];
    p.live.clearQuote(spotKey('BANKNIFTY'));
    p.ref.strikes('NIFTY', w1).forEach((k, i) => {
      if (i % 2 === 0) p.live.clearQuote(optKey('NIFTY', w1, 'CE', k));
      if (i % 3 === 0) p.live.clearQuote(optKey('NIFTY', w1, 'PE', k));
    });
    p.advance(20_000); // every book is now > 10 s old
    p.setQuote(spotKey('NIFTY'), { ltp: 25000 }); // the spot keeps ticking
  }
  if (state === 'closed') p.setNow(hm(b.date, '16:00'));
  if (state === 'stale' || state === 'empty') p.setNow(hm(NEXT_DAY, '11:00'));
  if (state === 'empty') p.ref.setLoaded(false);
}

interface RouteCase {
  method: Method;
  /** The route pattern as registered in app.ts. */
  route: string;
  url: (c: Ctx) => string;
  body?: (c: Ctx) => unknown;
  user?: boolean;
  /** Must answer 200 with the sample book. */
  full200?: boolean;
  /** A live-only view: with nothing live, no live field of its 200 body may hold a value. */
  liveOnly?: boolean;
}

const w1 = (c: Ctx) => c.b.expiries.NIFTY[0];
const m1 = (c: Ctx) => c.b.expiries.NIFTY[1];
const leg = (c: Ctx) => ({ side: 'BUY', type: 'CE', strike: 25000, expiry: w1(c), lots: 1, price: 0 });
const G = (route: string, url: string | ((c: Ctx) => string), extra: Partial<RouteCase> = {}): RouteCase => ({ method: 'GET', route, url: typeof url === 'string' ? () => url : url, ...extra });

/** Every route of app.ts, read-only ones first, destructive ones last (each state runs on a fresh fixture set). */
const ROUTES: RouteCase[] = [
  G('/api/health', '/api/health', { full200: true }),
  // operations (Model F): not running in this test server (404); the actions need a registered account (403 for the guest)
  G('/api/ops', '/api/ops'),
  G('/api/ops/audit/reports/:id', '/api/ops/audit/reports/2026-10-10_100000', { user: true }),
  { method: 'POST', route: '/api/ops/login/relogin', url: () => '/api/ops/login/relogin', body: () => ({}), user: true },
  { method: 'POST', route: '/api/ops/watchdog/run', url: () => '/api/ops/watchdog/run', body: () => ({}), user: true },
  { method: 'POST', route: '/api/ops/audit/run', url: () => '/api/ops/audit/run', body: () => ({}), user: true },
  G('/api/meta', '/api/meta', { full200: true }),
  G('/api/clock', '/api/clock', { full200: true }),
  G('/api/quotes', '/api/quotes?symbols=NIFTY,BANKNIFTY,RELIANCE', { full200: true, liveOnly: true }),
  G('/api/indices', '/api/indices', { full200: true, liveOnly: true }),
  G('/api/top10', '/api/top10', { liveOnly: true }),
  // MCX: the fake provider has no MCX source → 503 with the reason; a malformed expiry is a 400.
  G('/api/mcx/symbols', '/api/mcx/symbols', { liveOnly: true }),
  G('/api/mcx/chain/:symbol', '/api/mcx/chain/CRUDEOIL?expiry=2026-11-16', { liveOnly: true }),
  G('/api/expiries/:symbol', '/api/expiries/NIFTY', { full200: true }),
  G('/api/chain/:symbol', '/api/chain/NIFTY', { full200: true, liveOnly: true }),
  G('/api/futures/:symbol', '/api/futures/NIFTY', { full200: true, liveOnly: true }),
  G('/api/candles/:symbol', '/api/candles/NIFTY?interval=D&days=10', { full200: true }),
  G('/api/dashboard', '/api/dashboard', { full200: true, liveOnly: true }),
  G('/api/orb', '/api/orb'),
  G('/api/orb/:symbol', (c) => `/api/orb/NIFTY?date=${c.b.recordedDate}`, { full200: true }),
  G('/api/orb/:symbol/history', '/api/orb/NIFTY/history?days=5', { full200: true }),
  G('/api/order-flow/:symbol', (c) => `/api/order-flow/NIFTY?date=${c.b.recordedDate}`, { full200: true }),
  G('/api/oi/strikes/:symbol', '/api/oi/strikes/NIFTY', { full200: true, liveOnly: true }),
  G('/api/oi/multi-strike/:symbol', (c) => `/api/oi/multi-strike/NIFTY?strikes=25000,25100&date=${c.b.recordedDate}`, { full200: true }),
  G('/api/oi/trend/:symbol', (c) => `/api/oi/trend/NIFTY?date=${c.b.recordedDate}`, { full200: true }),
  G('/api/oi/pcr/:symbol', (c) => `/api/oi/pcr/NIFTY?date=${c.b.recordedDate}`, { full200: true }),
  G('/api/oi/max-pain/:symbol', '/api/oi/max-pain/NIFTY', { full200: true, liveOnly: true }),
  G('/api/oi/futures', '/api/oi/futures', { full200: true, liveOnly: true }),
  G('/api/oi/breadth', '/api/oi/breadth', { full200: true }),
  G('/api/participants', '/api/participants'),
  G('/api/fii-dii', '/api/fii-dii'),
  G('/api/vol/iv-chart/:symbol', (c) => `/api/vol/iv-chart/NIFTY?date=${c.b.recordedDate}`, { full200: true }),
  G('/api/vol/table', '/api/vol/table', { full200: true, liveOnly: true }),
  G('/api/vol/skew/:symbol', '/api/vol/skew/NIFTY', { full200: true, liveOnly: true }),
  G('/api/vol/surface/:symbol', '/api/vol/surface/NIFTY', { full200: true, liveOnly: true }),
  G('/api/vol/cone/:symbol', '/api/vol/cone/NIFTY', { full200: true }),
  G('/api/straddle/:symbol', (c) => `/api/straddle/NIFTY?date=${c.b.recordedDate}`, { full200: true }),
  { method: 'POST', route: '/api/strategy-chart', url: () => '/api/strategy-chart', body: (c) => ({ symbol: 'NIFTY', legs: [leg(c)], date: c.b.recordedDate }), full200: true },
  { method: 'POST', route: '/api/optimizer', url: () => '/api/optimizer', body: (c) => ({ symbol: 'NIFTY', expiry: w1(c), targetPrice: 25200, targetDate: w1(c) }), full200: true, liveOnly: true },
  { method: 'POST', route: '/api/recap', url: () => '/api/recap', body: (c) => ({ symbol: 'NIFTY', legs: [leg(c)], fromTs: hm(c.b.recordedDate, '09:30') }), full200: true },
  G('/api/scanners', '/api/scanners', { full200: true }),
  ...SCANNERS.map((s) => G('/api/scanners/:id', `/api/scanners/${s.id}`, { liveOnly: true })),
  G('/api/unusual', '/api/unusual', { liveOnly: true }),
  G('/api/synopsis', '/api/synopsis', { full200: true, liveOnly: true }),
  G('/api/order-book/:symbol', (c) => `/api/order-book/NIFTY?type=FUT&expiry=${m1(c)}`, { liveOnly: true }),
  G('/api/algos', '/api/algos', { full200: true }),
  G('/api/algos/:id/defaults', '/api/algos/premium-ladder/defaults?symbol=NIFTY', { full200: true }),
  { method: 'POST', route: '/api/algos/:id/backtest', url: () => '/api/algos/premium-ladder/backtest', body: (c) => ({ params: { symbol: 'NIFTY' }, date: c.b.recordedDate }), full200: true },
  { method: 'POST', route: '/api/algos/:id/backtest-range', url: () => '/api/algos/premium-ladder/backtest-range', body: () => ({ params: { symbol: 'NIFTY' }, days: 3 }), full200: true },
  // accounts
  { method: 'POST', route: '/api/auth/register', url: () => '/api/auth/register', body: () => ({ name: 'R', email: `r${++registerSeq}@example.com`, password: 'secret1' }), full200: true },
  { method: 'POST', route: '/api/auth/login', url: () => '/api/auth/login', body: () => ({ email: 'nobody@example.com', password: 'secret1' }) },
  { method: 'POST', route: '/api/auth/guest', url: () => '/api/auth/guest', body: () => ({}), full200: true },
  { method: 'GET', route: '/api/auth/me', url: () => '/api/auth/me', user: true, full200: true },
  { method: 'PUT', route: '/api/settings', url: () => '/api/settings', body: () => ({ theme: 'light' }), user: true, full200: true },
  // user views
  { method: 'GET', route: '/api/strategies', url: () => '/api/strategies', user: true, full200: true, liveOnly: true },
  { method: 'GET', route: '/api/strategies/:id', url: (c) => `/api/strategies/${c.ids.strategy}`, user: true, full200: true, liveOnly: true },
  { method: 'GET', route: '/api/broker/funds', url: () => '/api/broker/funds', user: true, full200: true },
  { method: 'GET', route: '/api/broker/orders', url: () => '/api/broker/orders', user: true, full200: true },
  { method: 'GET', route: '/api/broker/trades', url: () => '/api/broker/trades', user: true, full200: true },
  { method: 'GET', route: '/api/broker/positions', url: () => '/api/broker/positions', user: true, full200: true, liveOnly: true },
  { method: 'GET', route: '/api/alerts', url: () => '/api/alerts', user: true, full200: true },
  { method: 'GET', route: '/api/notifications', url: () => '/api/notifications', user: true, full200: true },
  { method: 'GET', route: '/api/watchlists', url: () => '/api/watchlists', user: true, full200: true },
  { method: 'GET', route: '/api/watchlists/:id/quotes', url: (c) => `/api/watchlists/${c.ids.watchlist}/quotes`, user: true, full200: true, liveOnly: true },
  { method: 'GET', route: '/api/algo-runs', url: () => '/api/algo-runs', user: true, full200: true },
  { method: 'GET', route: '/api/algo-runs/:id', url: (c) => `/api/algo-runs/${c.ids.algoRun}`, user: true, full200: true },
  // user mutations
  { method: 'POST', route: '/api/strategies', url: () => '/api/strategies', body: (c) => ({ symbol: 'NIFTY', legs: [leg(c)] }), user: true, full200: true },
  { method: 'PUT', route: '/api/strategies/:id', url: (c) => `/api/strategies/${c.ids.strategy}`, body: () => ({ name: 'Renamed' }), user: true, full200: true },
  { method: 'POST', route: '/api/strategies/:id/exit', url: (c) => `/api/strategies/${c.ids.strategy}/exit`, body: () => ({}), user: true, full200: true },
  { method: 'POST', route: '/api/broker/orders', url: () => '/api/broker/orders', body: (c) => ({ symbol: 'NIFTY', type: 'FUT', expiry: m1(c), side: 'SELL', lots: 1, orderType: 'MARKET' }), user: true, full200: true },
  { method: 'POST', route: '/api/broker/basket', url: () => '/api/broker/basket', body: (c) => ({ orders: [{ symbol: 'NIFTY', type: 'CE', strike: 25000, expiry: w1(c), side: 'BUY', lots: 1, orderType: 'MARKET' }] }), user: true, full200: true },
  { method: 'DELETE', route: '/api/broker/orders/:id', url: (c) => `/api/broker/orders/${c.ids.order}`, user: true, full200: true },
  { method: 'POST', route: '/api/broker/positions/exit', url: () => '/api/broker/positions/exit', body: (c) => ({ key: c.ids.position }), user: true, full200: true },
  { method: 'POST', route: '/api/alerts', url: () => '/api/alerts', body: () => ({ kind: 'PRICE', symbol: 'NIFTY', condition: 'below', value: 1 }), user: true, full200: true },
  { method: 'PATCH', route: '/api/alerts/:id', url: (c) => `/api/alerts/${c.ids.alert}`, body: () => ({ status: 'disabled' }), user: true, full200: true },
  { method: 'POST', route: '/api/notifications/read', url: () => '/api/notifications/read', body: () => ({}), user: true, full200: true },
  { method: 'POST', route: '/api/watchlists', url: () => '/api/watchlists', body: () => ({ name: 'X' }), user: true, full200: true },
  { method: 'PUT', route: '/api/watchlists/:id', url: (c) => `/api/watchlists/${c.ids.watchlist}`, body: () => ({ name: 'Y' }), user: true, full200: true },
  { method: 'POST', route: '/api/algo-runs', url: () => '/api/algo-runs', body: () => ({ algoId: 'premium-ladder', params: { symbol: 'NIFTY', startPremium: 30 } }), user: true, full200: true },
  { method: 'POST', route: '/api/algo-runs/:id/stop', url: (c) => `/api/algo-runs/${c.ids.algoRun}/stop`, user: true, full200: true },
  // destructive, last
  { method: 'DELETE', route: '/api/algo-runs/:id', url: (c) => `/api/algo-runs/${c.ids.algoRun}`, user: true, full200: true },
  { method: 'DELETE', route: '/api/alerts/:id', url: (c) => `/api/alerts/${c.ids.alert}`, user: true, full200: true },
  { method: 'DELETE', route: '/api/watchlists/:id', url: (c) => `/api/watchlists/${c.ids.watchlist}`, user: true, full200: true },
  { method: 'DELETE', route: '/api/strategies/:id', url: (c) => `/api/strategies/${c.ids.strategy}`, user: true, full200: true },
  { method: 'POST', route: '/api/broker/reset', url: () => '/api/broker/reset', body: () => ({}), user: true, full200: true },
];

/** Fields that only a live (or recorded/official) source can fill. */
const LIVE_KEYS = new Set([
  'ltp', 'bid', 'ask', 'bidQty', 'askQty', 'change', 'changePct', 'iv', 'atmIv', 'ivChange', 'delta', 'gamma', 'theta', 'vega',
  'oi', 'oiChange', 'oiChangePct', 'volume', 'spot', 'future', 'forward', 'carry', 'basis', 'pcr', 'pcrVolume', 'maxPain',
  'mtm', 'unrealized', 'unrealizedPnl', 'legsLtp', 'lastValue', 'turnover', 'support', 'resistance', 'metric', 'totalCeOi', 'totalPeOi',
]);

/** Paths of live fields that hold a number (directly or inside arrays). */
function filledLiveFields(v: unknown, at = '$', out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x, i) => filledLiveFields(x, `${at}[${i}]`, out));
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      const p = `${at}.${k}`;
      const hasNumber = (y: unknown): boolean => typeof y === 'number' || (Array.isArray(y) && y.some(hasNumber));
      if (LIVE_KEYS.has(k) && hasNumber(x)) out.push(`${p}=${JSON.stringify(x).slice(0, 40)}`);
      else filledLiveFields(x, p, out);
    }
  }
  return out;
}

describe('route table', () => {
  it('covers every route registered in app.ts', () => {
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/app.ts'), 'utf8');
    const registered = new Set([...src.matchAll(/\bapp\.(get|post|put|patch|delete)(?:<[^>]*>)?\('([^']+)'/g)].map((m) => `${m[1].toUpperCase()} ${m[2]}`));
    const tested = new Set(ROUTES.map((r) => `${r.method} ${r.route}`));
    expect([...registered].filter((r) => !tested.has(r))).toEqual([]);
    expect([...tested].filter((r) => !registered.has(r))).toEqual([]);
    expect(registered.size).toBeGreaterThan(70);
  });
});

describe('every route in every data state', () => {
  for (const state of ['full', 'partial', 'closed', 'stale', 'empty'] as State[]) {
    it(`${state}: 2xx/4xx or 503 NO_LIVE_DATA with the reason — never 500${state === 'stale' || state === 'empty' ? '; no live field filled' : ''}`, async () => {
      const c = await withFixtures(await setup());
      enter(state, c);
      const filled: string[] = [];
      const walked: string[] = [];
      const statuses: Record<string, number> = {};
      for (const r of ROUTES) {
        const url = r.url(c);
        const { status, body } = await call(c.app, r.method, url, r.body?.(c), r.user ? c.token : undefined);
        const what = `${state} ${r.method} ${url} → ${status} ${JSON.stringify(body).slice(0, 300)}`;
        statuses[`${r.method} ${url}`] = status;
        expect(status === 503 || status < 500, what).toBe(true);
        if (status === 503) expect(body, what).toEqual({ error: expect.stringMatching(/\S{3}/), code: 'NO_LIVE_DATA' });
        else if (status >= 400) expect(body.error, what).toEqual(expect.stringMatching(/\S{3}/));
        if (state === 'full' && r.full200) expect(status, what).toBe(200);
        if (r.liveOnly && status === 200) {
          walked.push(`${r.method} ${r.route}`);
          filled.push(...filledLiveFields(body).map((f) => `${r.method} ${url} ${f}`));
        }
      }
      if (state === 'full') expect(filled.length).toBeGreaterThan(500); // the walker sees the live values
      if (state === 'stale' || state === 'empty') {
        // With nothing live, live views are blank or 503 — never a value.
        expect(filled).toEqual([]);
        expect(walked).toEqual(expect.arrayContaining(['GET /api/dashboard', 'GET /api/strategies', 'GET /api/broker/positions', 'GET /api/watchlists/:id/quotes']));
        if (state === 'stale') expect(walked).toEqual(expect.arrayContaining(['GET /api/futures/:symbol', 'GET /api/strategies/:id']));
      }
      if (state === 'empty' || state === 'stale') {
        for (const u of ['/api/quotes?symbols=NIFTY,BANKNIFTY,RELIANCE', '/api/indices', '/api/chain/NIFTY', '/api/oi/strikes/NIFTY', '/api/vol/table', '/api/vol/skew/NIFTY', '/api/unusual', '/api/synopsis']) expect(statuses[`GET ${u}`], u).toBe(503);
        for (const u of ['/api/health', '/api/meta', '/api/clock', '/api/dashboard', '/api/scanners', '/api/algos']) expect(statuses[`GET ${u}`], u).toBe(200);
        expect(statuses['POST /api/broker/orders']).not.toBe(500);
      }
    });
  }
});

/* ------------------------------------------------------------------------------------------ */

describe('values are traceable to the inputs (sample book)', () => {
  it('quotes, chain, futures, max pain, IV views and scanners reproduce the test inputs', async () => {
    const { app, p, b } = await setup();
    const quotes = ((await call(app, 'GET', '/api/quotes?symbols=NIFTY,RELIANCE')).body as { quotes: Quote[] }).quotes;
    expect(quotes.map((q) => [q.symbol, q.ltp, q.prevClose, q.change])).toEqual([
      ['NIFTY', 25000, 24900, 100],
      ['RELIANCE', 1400, 1390, 10],
    ]);
    expect(quotes[0].future).toBe(b.futures[`NIFTY|${b.expiries.NIFTY[1]}`]);

    const chain = (await call(app, 'GET', '/api/chain/NIFTY')).body as OptionChain;
    const w1 = b.expiries.NIFTY[0];
    for (const row of chain.rows) {
      for (const t of ['CE', 'PE'] as const) {
        const q = p.live.quote(optKey('NIFTY', w1, t, row.strike));
        const leg = t === 'CE' ? row.ce : row.pe;
        if (!q) {
          expect(leg.ltp).toBeNull();
          continue;
        }
        expect([leg.ltp, leg.bid, leg.ask, leg.oi, leg.volume]).toEqual([q.ltp, q.bid, q.ask, q.oi, q.volume]);
        // IV solved back from the premium (priced at 14 % by the test helper; ₹0.05 rounding moves deep OTM legs).
        if (leg.iv !== null && (leg.ltp as number) > 20) expect(Math.abs(leg.iv - 14)).toBeLessThan(0.5);
      }
    }
    const oiRows = chain.rows.filter((r) => r.ce.oi !== null && r.pe.oi !== null).map((r) => ({ strike: r.strike, ceOI: r.ce.oi as number, peOI: r.pe.oi as number }));
    expect(chain.maxPain).toBe(maxPain(oiRows).maxPain);
    expect((await call(app, 'GET', '/api/oi/max-pain/NIFTY')).body.maxPain).toBe(chain.maxPain);
    expect(chain.pcr).toBeCloseTo(oiRows.reduce((a, r) => a + r.peOI, 0) / oiRows.reduce((a, r) => a + r.ceOI, 0), 2);

    const futs = (await call(app, 'GET', '/api/futures/BANKNIFTY')).body as { expiry: string; ltp: number; basis: number; oi: number }[];
    expect(futs.map((f) => [f.expiry, f.ltp, f.oi, f.basis])).toEqual(b.expiries.BANKNIFTY.map((e) => [e, b.futures[`BANKNIFTY|${e}`], 1_200_000, +(b.futures[`BANKNIFTY|${e}`] - 56000).toFixed(2)]));

    const table = (await call(app, 'GET', '/api/vol/table')).body as { symbol: string; iv: number | null }[];
    for (const [s, vol] of Object.entries(b.vols)) expect(Math.abs((table.find((r) => r.symbol === s)?.iv as number) - vol * 100), s).toBeLessThan(0.2);

    const surface = (await call(app, 'GET', '/api/vol/surface/NIFTY')).body as { strikes: (number | null)[][]; iv: (number | null)[][] };
    const listed = new Set(p.ref.strikes('NIFTY', w1));
    surface.strikes[0].forEach((k, i) => {
      if (k === null) expect(surface.iv[0][i]).toBeNull(); // no smile fill-in
      else expect(listed.has(k)).toBe(true);
    });

    const oiTop = (await call(app, 'GET', '/api/scanners/highest-call-oi')).body as { rows: { oi: number; metric: number }[] };
    expect(oiTop.rows[0].metric).toBe(oiTop.rows[0].oi);
    expect(oiTop.rows[0].oi).toBe(100_000); // the test book's ATM call OI
  });
});

describe('partial data: nulls and gaps, never stand-ins', () => {
  it('missing legs and stale books are blank; the rest is served with the reasons', async () => {
    const c = await withFixtures(await setup());
    enter('partial', c);
    const { app, p, b, token } = c;
    const w1 = b.expiries.NIFTY[0];
    const quotes = (await call(app, 'GET', '/api/indices')).body as Quote[];
    expect(quotes.map((q) => q.symbol)).toEqual(['NIFTY']);
    const dash = (await call(app, 'GET', '/api/dashboard')).body;
    expect(dash.gaps.indices).toMatch(/BANKNIFTY/);

    const chain = (await call(app, 'GET', '/api/chain/NIFTY')).body as OptionChain;
    for (const row of chain.rows) {
      for (const t of ['CE', 'PE'] as const) {
        const leg = t === 'CE' ? row.ce : row.pe;
        expect([leg.bid, leg.ask, leg.bidQty, leg.askQty]).toEqual([null, null, null, null]); // books > 10 s old
        if (!p.live.quote(optKey('NIFTY', w1, t, row.strike))) expect([leg.ltp, leg.oi, leg.iv, leg.delta, leg.ivSource]).toEqual([null, null, null, null, null]);
        else if (leg.iv !== null) expect(leg.ivSource).toBe('ltp');
      }
    }
    expect(chain.coverage).toMatch(/strikes with OI on both sides/);

    // A MARKET order needs a live book: rejected with the reason, never filled at the LTP.
    const order = await call(app, 'POST', '/api/broker/orders', { symbol: 'NIFTY', type: 'PE', strike: 25050, expiry: w1, side: 'BUY', lots: 1, orderType: 'MARKET' }, token);
    expect(order.body).toMatchObject({ status: 'REJECTED', filledQty: 0, message: expect.stringMatching(/No live bid\/ask/) });
    // Watchlist rows: live values or null with the reason.
    const wq = (await call(app, 'GET', `/api/watchlists/${c.ids.watchlist}/quotes`, undefined, token)).body as { ltp: number | null; bid: number | null; reason?: string }[];
    expect(wq.map((x) => x.bid)).toEqual([null, null, null]);
    expect(wq[2].reason).toMatch(/no live bid\/ask/);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('?at= (as of a past time)', () => {
  it('is answered from recorded minutes on the as-of routes and refused elsewhere; a future ?at= is live', async () => {
    const { app, b } = await setup();
    const past = hm(b.recordedDate, '12:00');
    const before = hm('2026-10-08', '12:00');
    for (const u of ['/api/indices', '/api/expiries/NIFTY', '/api/chain/NIFTY', '/api/futures/NIFTY', '/api/candles/NIFTY?interval=5', '/api/oi/strikes/NIFTY']) {
      const sep = u.includes('?') ? '&' : '?';
      expect((await call(app, 'GET', `${u}${sep}at=${past}`)).status, u).toBe(200);
      const miss = await call(app, 'GET', `${u}${sep}at=${before}`);
      expect(miss.status, u).toBe(503);
      expect(miss.body.error).toMatch(/recording started/);
      expect((await call(app, 'GET', `${u}${sep}at=nope`)).status, u).toBe(400);
    }
    // Live-only routes never answer a past ?at= with live data.
    for (const u of ['/api/oi/max-pain/NIFTY', '/api/vol/skew/NIFTY', '/api/vol/surface/NIFTY', '/api/vol/table', '/api/dashboard', '/api/scanners/highest-call-oi', '/api/order-book/NIFTY', '/api/oi/futures']) {
      const res = await call(app, 'GET', `${u}?at=${past}`);
      expect(res.status, u).toBe(503);
      expect(res.body).toEqual({ error: expect.stringMatching(/live data only/), code: 'NO_LIVE_DATA' });
      expect((await call(app, 'GET', `${u}?at=nope`)).status, u).toBe(400);
      expect((await call(app, 'GET', `${u}?at=${b.now + 60_000}`)).status, `${u} future at`).toBe((await call(app, 'GET', u)).status);
    }
    // The as-of chain is the recorded one, stamped with the requested time.
    const chain = (await call(app, 'GET', `/api/chain/NIFTY?at=${past}`)).body as OptionChain;
    expect(chain.ts).toBe(past);
    expect(chain.expiries).toEqual([b.expiries.NIFTY[0]]);
  });

  it('strike OI: a malformed ?from= is a 400, not a silent switch to the previous-close baseline', async () => {
    const { app, b } = await setup();
    expect((await call(app, 'GET', '/api/oi/strikes/NIFTY?from=abc')).status).toBe(400);
    const ok = await call(app, 'GET', `/api/oi/strikes/NIFTY?from=${hm(b.date, '10:00')}`);
    expect(ok.status).toBe(200);
    expect(ok.body.from).toBe('recorded');
    expect((await call(app, 'GET', '/api/oi/strikes/NIFTY')).body.from).toBe('prev-close');
  });

  it('503 reasons are not repeated', async () => {
    const { app, p } = await setup();
    p.ref.setLoaded(false);
    const res = await call(app, 'GET', '/api/indices');
    expect(res.body).toEqual({ error: 'Instrument master not loaded yet', code: 'NO_LIVE_DATA' });
  });
});

describe('validation, auth and ownership', () => {
  it('bad input is a 400/404 with the reason; user routes need a token; one user cannot reach another user\'s items', async () => {
    const c = await withFixtures(await setup());
    const { app, b, token, ids } = c;
    const w1 = b.expiries.NIFTY[0];
    const ord = { symbol: 'NIFTY', type: 'CE', strike: 25000, expiry: w1, side: 'BUY', lots: 1, orderType: 'MARKET' };
    const bad: [Method, string, unknown, number][] = [
      ['POST', '/api/broker/orders', undefined, 400],
      ['POST', '/api/broker/orders', { ...ord, lots: 'x' }, 400],
      ['POST', '/api/broker/orders', { ...ord, lots: 51 }, 400],
      ['POST', '/api/broker/orders', { ...ord, strike: 25025 }, 400],
      ['POST', '/api/broker/orders', { ...ord, expiry: '2026-13-45' }, 400],
      ['POST', '/api/broker/orders', { ...ord, orderType: 'LIMIT', price: 10.03 }, 400],
      ['POST', '/api/broker/orders', { ...ord, symbol: 'NOPE' }, 404],
      ['POST', '/api/broker/basket', { orders: [] }, 400],
      ['POST', '/api/broker/positions/exit', { key: 'nope' }, 404],
      ['POST', '/api/strategies', { symbol: 'NIFTY', legs: [] }, 400],
      ['POST', '/api/strategies', { symbol: 'NIFTY', legs: [{ ...leg(c), strike: 25025 }] }, 400],
      ['POST', '/api/alerts', { kind: 'NOPE', symbol: 'NIFTY', condition: 'above', value: 1 }, 400],
      ['POST', '/api/alerts', { kind: 'OPTION_PRICE', symbol: 'NIFTY', condition: 'above', value: 1 }, 400],
      ['POST', '/api/alerts', { kind: 'PRICE', symbol: 'NOPE', condition: 'above', value: 1 }, 404],
      ['PUT', '/api/watchlists/' + ids.watchlist, { items: [{ symbol: 'NIFTY', type: 'CE', strike: 1, expiry: w1 }] }, 400],
      ['POST', '/api/algo-runs', { algoId: 'nope', params: {} }, 404],
      ['POST', '/api/algo-runs', { algoId: 'premium-ladder', params: { symbol: 'NIFTY', lots: 1000 } }, 400],
      ['POST', '/api/algos/premium-ladder/backtest', { params: {}, date: '2030-01-01' }, 400],
      ['POST', '/api/strategy-chart', { symbol: 'NIFTY', legs: [leg(c)], date: 'garbage' }, 400],
      ['POST', '/api/recap', { symbol: 'NIFTY', legs: [leg(c)], fromTs: 'abc' }, 400],
      ['POST', '/api/optimizer', { symbol: 'NIFTY', expiry: w1, targetPrice: -1, targetDate: w1 }, 400],
      ['PUT', '/api/settings', { riskFreeRate: 5 }, 400],
    ];
    for (const [method, url, body, want] of bad) {
      const res = await call(app, method, url, body, token);
      expect(res.status, `${method} ${url} ${JSON.stringify(body)} → ${JSON.stringify(res.body)}`).toBe(want);
      expect(res.body.error).toEqual(expect.any(String));
    }

    // No token → 401 on every user route; a bad token is no token.
    for (const r of ROUTES.filter((x) => x.user)) {
      expect((await call(app, r.method, r.url(c), r.body?.(c))).status, `${r.method} ${r.route}`).toBe(401);
      expect((await call(app, r.method, r.url(c), r.body?.(c), 'not-a-token')).status, `${r.method} ${r.route}`).toBe(401);
    }

    // Another user sees none of the fixture user's items.
    const other = (await call(app, 'POST', '/api/auth/guest', {})).body.token as string;
    for (const [method, url, body] of [
      ['GET', `/api/strategies/${ids.strategy}`],
      ['PUT', `/api/strategies/${ids.strategy}`, { name: 'x' }],
      ['POST', `/api/strategies/${ids.strategy}/exit`, {}],
      ['DELETE', `/api/strategies/${ids.strategy}`],
      ['DELETE', `/api/broker/orders/${ids.order}`],
      ['POST', '/api/broker/positions/exit', { key: ids.position }],
      ['PATCH', `/api/alerts/${ids.alert}`, { status: 'disabled' }],
      ['DELETE', `/api/alerts/${ids.alert}`],
      ['PUT', `/api/watchlists/${ids.watchlist}`, { name: 'x' }],
      ['GET', `/api/watchlists/${ids.watchlist}/quotes`],
      ['DELETE', `/api/watchlists/${ids.watchlist}`],
      ['GET', `/api/algo-runs/${ids.algoRun}`],
      ['POST', `/api/algo-runs/${ids.algoRun}/stop`],
      ['DELETE', `/api/algo-runs/${ids.algoRun}`],
    ] as [Method, string, unknown?][]) {
      expect((await call(app, method, url, body, other)).status, `${method} ${url}`).toBe(404);
    }
    expect((await call(app, 'GET', '/api/broker/positions', undefined, other)).body).toEqual([]);
    expect((await call(app, 'GET', '/api/strategies', undefined, other)).body).toEqual([]);
    // The fixture user's items are untouched.
    expect((await call(app, 'GET', `/api/strategies/${ids.strategy}`, undefined, token)).status).toBe(200);
    expect((await call(app, 'GET', '/api/broker/orders', undefined, token)).body.find((o: { id: string }) => o.id === ids.order).status).toBe('OPEN');
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('browser hardening: CORS, headers, compression', () => {
  it('answers CORS only for the same host or WS_ALLOWED_ORIGINS, never for another website', async () => {
    const { app } = await setup();
    const same = await app.inject({ method: 'GET', url: '/api/meta', headers: { host: 'localhost:8787', origin: 'http://localhost:8787' } });
    expect(same.headers['access-control-allow-origin']).toBe('http://localhost:8787');
    const evil = await app.inject({ method: 'GET', url: '/api/meta', headers: { host: 'localhost:8787', origin: 'https://evil.example' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const pre = await app.inject({ method: 'OPTIONS', url: '/api/auth/guest', headers: { host: 'localhost:8787', origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sends defensive headers and gzips large JSON only when the client accepts it', async () => {
    const { app } = await setup();
    const plain = await app.inject({ method: 'GET', url: '/api/chain/NIFTY' });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers['x-content-type-options']).toBe('nosniff');
    expect(plain.headers['x-frame-options']).toBe('DENY');
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.length).toBeGreaterThan(GZIP_MIN_BYTES);
    const zipped = await app.inject({ method: 'GET', url: '/api/chain/NIFTY', headers: { 'accept-encoding': 'gzip, deflate, br' } });
    expect(zipped.headers['content-encoding']).toBe('gzip');
    expect(zipped.rawPayload.length).toBeLessThan(plain.rawPayload.length / 3);
    expect(JSON.parse(gunzipSync(zipped.rawPayload).toString('utf8'))).toEqual(plain.json());
    const small = await app.inject({ method: 'GET', url: '/api/health', headers: { 'accept-encoding': 'gzip' } });
    expect(small.headers['content-encoding']).toBeUndefined();
  });
});

describe('websocket fan-out', () => {
  async function connect(app: FastifyInstance) {
    await app.ready();
    const messages: ServerMessage[] = [];
    const ws = await app.injectWS('/ws', {}, { onInit: (s) => s.on('message', (raw: Buffer) => messages.push(JSON.parse(raw.toString()) as ServerMessage)) });
    cleanup.push(() => ws.terminate());
    return { ws, messages };
  }
  const lastLtp = (ms: ServerMessage[], symbol: string): number | undefined => {
    let v: number | undefined;
    for (const m of ms) if (m.type === 'ticks') for (const q of m.quotes) if (q.symbol === symbol) v = q.ltp;
    return v;
  };
  const waitUntil = async (pred: () => boolean, ms = 4000) => {
    const end = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > end) throw new Error('timeout');
      await sleep(5);
    }
  };

  it('every socket ends on the latest price (a quote cached before a tick is never sent for it)', async () => {
    const { app, p } = await setup();
    const a = await connect(app);
    await sleep(450);
    const bb = await connect(app); // batches ~0.5 s out of phase with the first socket
    await waitUntil(() => lastLtp(a.messages, 'NIFTY') === 25000 && lastLtp(bb.messages, 'NIFTY') === 25000);
    await sleep(1100);
    p.setQuote(spotKey('NIFTY'), { ltp: 25010 });
    // As soon as one socket has sent 25010 (and cached it), the price moves again.
    await waitUntil(() => lastLtp(a.messages, 'NIFTY') === 25010 || lastLtp(bb.messages, 'NIFTY') === 25010);
    p.setQuote(spotKey('NIFTY'), { ltp: 25020 });
    await sleep(2300);
    expect([lastLtp(a.messages, 'NIFTY'), lastLtp(bb.messages, 'NIFTY')]).toEqual([25020, 25020]);
  }, 15000);

  it('a burst of ticks is one batch a second per socket; closing sockets and the app releases every listener', async () => {
    const { app, p, svc } = await setup();
    const ticks = () => (p.live as unknown as { listeners: Set<unknown> }).listeners.size;
    const pushes = () => (svc.notifier as unknown as { listeners: Set<unknown> }).listeners.size;
    await app.ready();
    const base = { ticks: ticks(), pushes: pushes(), orders: svc.orderListeners.size };
    const s1 = await connect(app);
    const s2 = await connect(app);
    expect([pushes(), svc.orderListeners.size]).toEqual([base.pushes + 2, base.orders + 2]);
    await waitUntil(() => s1.messages.some((m) => m.type === 'ticks' && m.quotes.length > 0) && s2.messages.some((m) => m.type === 'ticks' && m.quotes.length > 0));
    const n1 = s1.messages.length;
    const t0 = Date.now();
    for (let i = 1; i <= 40; i++) {
      p.setQuote(spotKey('NIFTY'), { ltp: 25000 + i });
      await sleep(25);
    }
    await sleep(1100);
    const elapsed = Date.now() - t0;
    const batches = s1.messages.slice(n1).filter((m) => m.type === 'ticks' && m.quotes.length > 0);
    expect(batches.length).toBeGreaterThan(0);
    expect(batches.length).toBeLessThanOrEqual(Math.ceil(elapsed / 1000) + 1);
    expect(lastLtp(s1.messages, 'NIFTY')).toBe(25040);
    s1.ws.terminate();
    s2.ws.terminate();
    await waitUntil(() => pushes() === base.pushes && svc.orderListeners.size === base.orders);
    const after = s1.messages.length;
    await sleep(1200);
    expect(s1.messages.length).toBe(after); // the per-socket batch timer is gone
    await app.close();
    expect(ticks()).toBe(base.ticks - 1); // the app's one tick listener is released
  }, 15000);
});

/* ------------------------------------------------------------------------------------------ */

describe('background timers and the paper broker / algo without live data', () => {
  it('broker, alert and algo ticks run on every data state without throwing or reporting NoLiveData', async () => {
    const errors: [string, unknown][] = [];
    const c = await withFixtures(await setup({ onError: (where, e) => errors.push([where, e]) }));
    const { svc, p } = c;
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    svc.start();
    for (const state of ['partial', 'closed', 'stale', 'empty'] as State[]) {
      enter(state, c);
      await vi.advanceTimersByTimeAsync(7_000);
      expect(() => p.userContracts()).not.toThrow();
      expect(errors, state).toEqual([]);
    }
    // The ticks did run: with nothing live every active alert was checked and is blank with its reason.
    const alerts = svc.alerts.list(Object.keys(svc.db.data.alerts)[0]);
    expect(alerts.length).toBe(8);
    for (const a of alerts.filter((x) => x.status === 'active')) {
      expect(a.checkedAt, a.kind).toBe(p.now());
      expect(a.lastValue ?? null, a.kind).toBeNull();
      expect(a.statusNote, a.kind).toEqual(expect.any(String));
    }
    svc.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('nothing fills without a live bid/ask: working orders wait, MARKET orders are rejected, the algo never assumes a fill', async () => {
    const c = await withFixtures(await setup());
    const { app, p, b, svc, token } = c;
    const w1 = b.expiries.NIFTY[0];
    const ce = optKey('NIFTY', w1, 'CE', 25100);
    const trades0 = (await call(app, 'GET', '/api/broker/trades', undefined, token)).body.length as number;
    // A LIMIT buy above the (soon stale) ask: it may only fill against a live book.
    p.advance(11_000); // books > 10 s old
    const limit = await call(app, 'POST', '/api/broker/orders', { symbol: 'NIFTY', type: 'CE', strike: 25100, expiry: w1, side: 'BUY', lots: 1, orderType: 'LIMIT', price: 500 }, token);
    expect(limit.body.status).toBe('OPEN');
    // A live-session LTP alone (no book) never fills anything.
    p.setQuote(ce, { ltp: 70, bid: undefined, ask: undefined });
    svc.broker.tick();
    const mkt = await call(app, 'POST', '/api/broker/orders', { symbol: 'NIFTY', type: 'CE', strike: 25100, expiry: w1, side: 'SELL', lots: 1, orderType: 'MARKET' }, token);
    expect(mkt.body).toMatchObject({ status: 'REJECTED', message: expect.stringMatching(/No live bid\/ask/) });
    expect((await call(app, 'GET', '/api/broker/trades', undefined, token)).body.length).toBe(trades0);
    // One-sided or crossed books are not live books either.
    p.setQuote(ce, { ltp: 70, bid: 69.5, ask: undefined });
    svc.broker.tick();
    p.setQuote(ce, { ltp: 70, bid: 71, ask: 70.5 });
    svc.broker.tick();
    expect((await call(app, 'GET', '/api/broker/orders', undefined, token)).body.find((o: { id: string }) => o.id === limit.body.id).status).toBe('OPEN');
    // A fresh two-sided book: the working order fills at its ask.
    p.setQuote(ce, { ltp: 70, bid: 69.9, ask: 70.1 });
    svc.broker.tick();
    const filled = (await call(app, 'GET', '/api/broker/orders', undefined, token)).body.find((o: { id: string }) => o.id === limit.body.id);
    expect(filled).toMatchObject({ status: 'COMPLETE', avgPrice: 70.1 });

    // The algo run of the fixtures entered at 11:00 (both legs sold through the broker). At its 15:25
    // exit the books are stale: the square-off is rejected, and the run keeps the legs as open — the
    // same legs the broker still holds — instead of booking fills that did not happen.
    p.setNow(hm(b.date, '15:25'));
    await svc.algos.tick();
    const run = (await call(app, 'GET', `/api/algo-runs/${c.ids.algoRun}`, undefined, token)).body;
    const algoLegs = (run.today.legs as { type: string; strike: number }[]).map((l) => `${l.type}|${l.strike}`).sort();
    expect(algoLegs.length).toBe(2);
    expect(run.today.events.some((e: { kind: string; message: string }) => e.kind === 'ERROR' && /No live bid\/ask/.test(e.message))).toBe(true);
    const open = ((await call(app, 'GET', '/api/broker/positions', undefined, token)).body as { type: string; strike: number; product: string; netQty: number }[])
      .filter((x) => x.product === 'MIS' && x.netQty !== 0)
      .map((x) => `${x.type}|${x.strike}`)
      .sort();
    expect(open).toEqual(algoLegs);
    expect(run.history[0]?.incomplete ?? run.today.phase).toBeTruthy();
  });
});
