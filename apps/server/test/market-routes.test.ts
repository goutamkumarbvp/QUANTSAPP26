/**
 * Market routes and the websocket over createServices(config, { provider: FakeProvider }) (TEST-ONLY
 * provider with the sample book): health, meta, clock, quotes, indices, expiries, chain, futures,
 * candles, 503 + NO_LIVE_DATA for missing data, websocket hello + throttled tick batches.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { istTs, type MetaResponse, type OptionChain, type Quote, type ServerMessage } from '@q26/core';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { optKey, spotKey } from '../src/services/live';
import { createServices, type Services } from '../src/services';
import { FakeProvider, loadSampleBook, type SampleBook } from './support/fake-provider';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
const at = (date: string, hhmm: string) => istTs(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)));

async function setup(): Promise<{ p: FakeProvider; book: SampleBook; svc: Services; app: FastifyInstance }> {
  const p = new FakeProvider();
  const book = loadSampleBook(p);
  const svc = createServices(loadConfig({ persist: false, authSecret: 'test-secret' }), { provider: p });
  const app = await buildApp(svc, { serveWeb: false });
  cleanup.push(() => p.dispose(), () => svc.stop(), () => app.close());
  return { p, book, svc, app };
}

const get = async (app: FastifyInstance, url: string) => {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() };
};

describe('market routes', () => {
  it('health: feed status and the provider report, no credentials', async () => {
    const { app, book } = await setup();
    const { status, body } = await get(app, '/api/health');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.feed).toMatchObject({ loggedIn: true, connected: true, refdataReady: true, recordingSince: book.recordedDate });
    expect(body.clock.feed).toEqual(body.feed);
    expect(body.provider.recorder.firstRecordedSession).toBe(book.recordedDate);
    expect(JSON.stringify(body)).not.toMatch(/mpin|totp|password|secret|token/i);
  });

  it('meta lists the instrument master (live data source, no simulator fields); blank with a reason before it loads', async () => {
    const { app, p } = await setup();
    let { status, body } = await get(app, '/api/meta');
    expect(status).toBe(200);
    const meta = body as MetaResponse;
    expect(meta.dataSource).toBe('live');
    expect(meta.clock).not.toHaveProperty('mode');
    expect(meta.clock).not.toHaveProperty('speed');
    expect(meta.symbols.find((s) => s.symbol === 'NIFTY')).toEqual({ symbol: 'NIFTY', name: 'Nifty 50', kind: 'index', exchange: 'NSE', sector: 'Index', lotSize: 75, strikeStep: 50, expiryCycle: 'monthly' });
    p.ref.setStrikes('NIFTY', '2026-10-20', [25000]);
    ({ body } = await get(app, '/api/meta'));
    expect((body as MetaResponse).symbols.find((s) => s.symbol === 'NIFTY')?.expiryCycle).toBe('weekly');
    p.ref.setLoaded(false);
    ({ status, body } = await get(app, '/api/meta'));
    expect(status).toBe(200);
    expect(body.symbols).toEqual([]);
    expect(body.gaps).toEqual({ symbols: 'Instrument master not loaded yet' });
  });

  it('clock: real IST time with the feed status', async () => {
    const { app, book } = await setup();
    const { body } = await get(app, '/api/clock');
    expect(body).toMatchObject({ ts: book.now, date: book.date, time: '11:00', status: 'open', sessionMinute: 105 });
    expect(body.feed.connected).toBe(true);
  });

  it('quotes and indices: live quotes only; symbols without one are left out; none at all is 503', async () => {
    const { app, p } = await setup();
    let { status, body } = await get(app, '/api/quotes?symbols=NIFTY,reliance');
    expect(status).toBe(200);
    expect((body as Quote[]).map((q) => [q.symbol, q.ltp])).toEqual([
      ['NIFTY', 25000],
      ['RELIANCE', 1400],
    ]);
    ({ body } = await get(app, '/api/indices'));
    expect((body as Quote[]).map((q) => q.symbol)).toEqual(['NIFTY', 'BANKNIFTY']);
    p.live.clearQuote(spotKey('BANKNIFTY'));
    ({ body } = await get(app, '/api/indices'));
    expect((body as Quote[]).map((q) => q.symbol)).toEqual(['NIFTY']);
    p.live.clearQuote(spotKey('NIFTY'));
    ({ status, body } = await get(app, '/api/indices'));
    expect(status).toBe(503);
    expect(body).toEqual({ error: 'No live price for NIFTY; No live price for BANKNIFTY', code: 'NO_LIVE_DATA' });
    ({ status } = await get(app, '/api/quotes?symbols=NOPE'));
    expect(status).toBe(404);
  });

  it('expiries: listed and unexpired; as-of from the recorded session only', async () => {
    const { app, book } = await setup();
    let { status, body } = await get(app, '/api/expiries/NIFTY');
    expect(body).toEqual({ options: book.expiries.NIFTY, futures: [book.expiries.NIFTY[1]] });
    ({ body } = await get(app, `/api/expiries/NIFTY?at=${at(book.recordedDate, '12:00')}`));
    expect(body).toEqual({ options: [book.expiries.NIFTY[0]], futures: [book.expiries.NIFTY[1]] });
    ({ status, body } = await get(app, `/api/expiries/NIFTY?at=${at('2026-10-08', '12:00')}`));
    expect(status).toBe(503);
    expect(body).toEqual({ error: `No recorded data for 2026-10-08 — recording started ${book.recordedDate}`, code: 'NO_LIVE_DATA' });
    ({ status } = await get(app, '/api/expiries/NIFTY?at=abc'));
    expect(status).toBe(400);
  });

  it('chain: live chain with solved IV; as-of from recordings; 400/404/503 for bad or missing data', async () => {
    const { app, p, book } = await setup();
    let { status, body } = await get(app, '/api/chain/NIFTY');
    expect(status).toBe(200);
    const c = body as OptionChain;
    expect(c).toMatchObject({ symbol: 'NIFTY', expiry: book.expiries.NIFTY[0], spot: 25000, atm: 25000, lotSize: 75, strikeStep: 50, forwardSource: 'parity' });
    expect(Math.abs((c.atmIv as number) - 14)).toBeLessThan(0.01);
    expect(c.rows.find((r) => r.strike === 25000)?.ce.ivSource).toBe('mid');
    expect(c.gaps?.ivChange).toBeDefined();

    ({ status, body } = await get(app, `/api/chain/NIFTY?expiry=${book.expiries.NIFTY[1]}`));
    expect(body.forwardSource).toBe('future');
    ({ status } = await get(app, '/api/chain/NIFTY?expiry=2026-12-29'));
    expect(status).toBe(400);
    ({ status } = await get(app, '/api/chain/NOPE'));
    expect(status).toBe(404);
    ({ status, body } = await get(app, `/api/chain/NIFTY?at=${at(book.recordedDate, '12:00')}`));
    expect(status).toBe(200);
    expect(body.ts).toBe(at(book.recordedDate, '12:00'));
    ({ status, body } = await get(app, `/api/chain/NIFTY?at=${at('2026-10-08', '12:00')}`));
    expect(status).toBe(503);
    expect(body.code).toBe('NO_LIVE_DATA');
    // ?at= in the future is "now".
    ({ status, body } = await get(app, `/api/chain/NIFTY?at=${book.now + 60_000}`));
    expect(body.ts).toBe(book.now);

    const w1 = book.expiries.NIFTY[0];
    for (const k of p.ref.strikes('NIFTY', w1)) for (const t of ['CE', 'PE'] as const) p.live.clearQuote(optKey('NIFTY', w1, t, k));
    ({ status, body } = await get(app, '/api/chain/NIFTY'));
    expect(status).toBe(503);
    expect(body).toEqual({ error: `No live quotes for the NIFTY ${w1} option chain`, code: 'NO_LIVE_DATA' });
    p.ref.setLoaded(false);
    ({ status, body } = await get(app, '/api/chain/NIFTY'));
    expect(status).toBe(503);
    expect(body).toEqual({ error: 'Instrument master not loaded yet', code: 'NO_LIVE_DATA' });
  });

  it('futures and candles', async () => {
    const { app, book } = await setup();
    let { status, body } = await get(app, '/api/futures/BANKNIFTY');
    expect(status).toBe(200);
    expect(body.map((r: { expiry: string }) => r.expiry)).toEqual(book.expiries.BANKNIFTY);
    expect(body[0].oiChange).toBeNull();
    ({ status, body } = await get(app, `/api/futures/NIFTY?at=${at(book.recordedDate, '10:00')}`));
    expect(status).toBe(200);
    expect(body).toHaveLength(1);

    ({ status, body } = await get(app, '/api/candles/NIFTY?interval=D&days=10'));
    expect(status).toBe(200);
    expect(body).toHaveLength(6);
    expect(body.at(-1)).toEqual({ ts: at(book.date, '09:15'), open: 24950, high: 25050, low: 24920, close: 25000, volume: null });
    ({ status, body } = await get(app, '/api/candles/NIFTY?interval=5&days=2'));
    expect(status).toBe(200);
    expect(body).toHaveLength(75);
    ({ status, body } = await get(app, `/api/candles/NIFTY?interval=15&days=2&type=FUT&expiry=${book.expiries.NIFTY[1]}`));
    expect(status).toBe(200);
    expect(body[0].volume).toBe(45_000);
    ({ status, body } = await get(app, '/api/candles/NIFTY?interval=5'));
    expect(status).toBe(503);
    expect(body.code).toBe('NO_LIVE_DATA');
    ({ status } = await get(app, '/api/candles/NIFTY?interval=7'));
    expect(status).toBe(400);
    ({ status } = await get(app, '/api/candles/NIFTY?interval=5&type=CE&expiry=2026-10-13'));
    expect(status).toBe(400);
  });
});

describe('websocket', () => {
  async function connect(app: FastifyInstance) {
    await app.ready();
    const messages: ServerMessage[] = [];
    // Listen from the start: the server sends `hello` as soon as the socket opens.
    const ws = await app.injectWS('/ws', {}, { onInit: (s) => s.on('message', (raw: Buffer) => messages.push(JSON.parse(raw.toString()) as ServerMessage)) });
    cleanup.push(() => ws.terminate());
    const waitFor = async (pred: (m: ServerMessage) => boolean, ms = 4000): Promise<ServerMessage> => {
      const end = Date.now() + ms;
      for (;;) {
        const hit = messages.find(pred);
        if (hit) return hit;
        if (Date.now() > end) throw new Error(`timeout; got ${JSON.stringify(messages.map((m) => m.type))}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    return { ws, messages, waitFor };
  }
  const symbolsOf = (m: ServerMessage) => (m.type === 'ticks' ? m.quotes.map((q) => q.symbol).sort() : []);

  it('hello with the clock and feed status, then a snapshot batch of the index quotes', async () => {
    const { app } = await setup();
    const { waitFor } = await connect(app);
    const hello = await waitFor((m) => m.type === 'hello');
    expect(hello.type === 'hello' && hello.clock.feed?.connected).toBe(true);
    expect(hello.type === 'hello' && 'mode' in hello.clock).toBe(false);
    const first = await waitFor((m) => m.type === 'ticks' && m.quotes.length > 0);
    expect(symbolsOf(first)).toEqual(['BANKNIFTY', 'NIFTY']);
  });

  it('fans live ticks out at most once a second, only for subscribed symbols, never an older session', async () => {
    const { app, p, book } = await setup();
    const { ws, messages, waitFor } = await connect(app);
    await waitFor((m) => m.type === 'ticks' && m.quotes.length > 0);
    ws.send(JSON.stringify({ type: 'subscribe', symbols: ['reliance', 'BOGUS', 42] }));
    const rel = await waitFor((m) => m.type === 'ticks' && m.quotes.some((q) => q.symbol === 'RELIANCE'));
    expect(symbolsOf(rel)).toEqual(['RELIANCE']);

    const n = messages.length;
    p.setQuote(spotKey('NIFTY'), { ltp: 25010 });
    p.setQuote(spotKey('NIFTY'), { ltp: 25020 });
    p.setQuote(spotKey('NIFTY'), { ltp: 25030 });
    const batch = await waitFor((m) => messages.indexOf(m) >= n && m.type === 'ticks' && m.quotes.length > 0);
    expect(batch.type === 'ticks' && batch.quotes).toEqual([expect.objectContaining({ symbol: 'NIFTY', ltp: 25030 })]);
    expect(messages.slice(n).filter((m) => m.type === 'ticks' && m.quotes.length > 0)).toHaveLength(1);

    // A tick whose quote is of an earlier session is never sent as live.
    p.live.clearQuote(spotKey('BANKNIFTY'));
    const m2 = messages.length;
    p.setQuote(spotKey('BANKNIFTY'), { ltp: 55500, ts: at(book.recordedDate, '15:29') });
    p.setQuote(spotKey('NIFTY'), { ltp: 25040 });
    const next = await waitFor((m) => messages.indexOf(m) >= m2 && m.type === 'ticks' && m.quotes.length > 0);
    expect(symbolsOf(next)).toEqual(['NIFTY']);
  });

  it('pushes order events to the authenticated user', async () => {
    const { app, svc, book } = await setup();
    const login = await app.inject({ method: 'POST', url: '/api/auth/guest' });
    const { token, user } = login.json();
    const { ws, waitFor } = await connect(app);
    await waitFor((m) => m.type === 'hello');
    ws.send(JSON.stringify({ type: 'auth', token }));
    await new Promise((r) => setTimeout(r, 50));
    svc.broker.place(user.id, { symbol: 'NIFTY', type: 'CE', strike: 25000, expiry: book.expiries.NIFTY[0], side: 'BUY', lots: 1, orderType: 'MARKET', product: 'NRML' });
    const ev = await waitFor((m) => m.type === 'order');
    expect(ev.type === 'order' && ev.order.status).toBe('COMPLETE');
  });
});
