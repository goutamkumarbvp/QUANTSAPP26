import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { sessionTs, type OptionChain } from '@q26/core';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createServices, type Services } from '../src/services';

let app: FastifyInstance;
let svc: Services;
let token = '';

const auth = () => ({ authorization: `Bearer ${token}` });
const get = async (url: string, headers = {}) => {
  const r = await app.inject({ method: 'GET', url, headers });
  return { status: r.statusCode, body: r.json() };
};
const post = async (url: string, payload: unknown, headers = {}) => {
  const r = await app.inject({ method: 'POST', url, payload: payload as object, headers });
  return { status: r.statusCode, body: r.json() };
};

beforeAll(async () => {
  // Frozen wall clock → deterministic demo session on Fri 9-Oct-2026 at 11:30 IST.
  const frozen = Date.now();
  svc = createServices(loadConfig({ persist: false, simStart: '2026-10-09T11:30', clockMode: 'demo', authSecret: 'test' }), { now: () => frozen });
  app = await buildApp(svc, { serveWeb: false });
  const g = await post('/api/auth/guest', {});
  token = g.body.token;
});

afterAll(async () => {
  svc.stop();
  await app.close();
});

describe('market data', () => {
  it('reports clock and meta', async () => {
    const { body } = await get('/api/meta');
    expect(body.clock.date).toBe('2026-10-09');
    expect(body.clock.time).toBe('11:30');
    expect(body.symbols.find((s: { symbol: string }) => s.symbol === 'NIFTY').lotSize).toBe(65);
    expect(body.symbols.length).toBeGreaterThan(50);
  });

  it('builds a consistent option chain', async () => {
    const { status, body } = await get('/api/chain/NIFTY');
    const c = body as OptionChain;
    expect(status).toBe(200);
    expect(c.expiry).toBe('2026-10-13');
    expect(c.rows.length).toBeGreaterThan(60);
    expect(Math.abs(c.atm - c.spot)).toBeLessThanOrEqual(25);
    expect(c.pcr).toBeGreaterThan(0.3);
    expect(c.pcr).toBeLessThan(3);
    expect(c.atmIv).toBeGreaterThan(5);
    for (const r of c.rows) {
      expect(r.ce.ltp).toBeGreaterThanOrEqual(0.05);
      expect(r.ce.oi).toBeGreaterThanOrEqual(0);
      expect(r.ce.delta).toBeGreaterThanOrEqual(0);
      expect(r.pe.delta).toBeLessThanOrEqual(0);
    }
    // Calls fall and puts rise with strike; adjacent butterflies are non-negative (no arbitrage).
    for (let i = 1; i < c.rows.length - 1; i++) {
      const [a, b, d] = [c.rows[i - 1], c.rows[i], c.rows[i + 1]];
      expect(b.ce.ltp).toBeLessThanOrEqual(a.ce.ltp + 0.05);
      expect(b.pe.ltp).toBeGreaterThanOrEqual(a.pe.ltp - 0.05);
      expect(a.ce.ltp - 2 * b.ce.ltp + d.ce.ltp).toBeGreaterThan(-0.11);
      expect(a.pe.ltp - 2 * b.pe.ltp + d.pe.ltp).toBeGreaterThan(-0.11);
    }
  });

  it('is deterministic for a given seed', () => {
    const other = createServices(loadConfig({ persist: false, simStart: '2026-10-09T11:30' }));
    const ts = sessionTs('2026-10-08', 200);
    const a = svc.engine.chain('BANKNIFTY', undefined, ts);
    const b = other.engine.chain('BANKNIFTY', undefined, ts);
    expect(a.rows.map((r) => [r.ce.ltp, r.pe.oi])).toEqual(b.rows.map((r) => [r.ce.ltp, r.pe.oi]));
    other.stop();
  });

  it('keeps OI continuous across the overnight boundary', () => {
    const e = svc.engine;
    const expiry = e.expiries('NIFTY', sessionTs('2026-10-08', 0))[1];
    const ctx = e.contract('NIFTY', expiry);
    const d = e.dayIndex.get('2026-10-08')!;
    for (const k of [25500, 26000, 26500]) {
      expect(e.oiAt(ctx, 'CE', k, d - 1, 375)).toBe(e.oiAt(ctx, 'CE', k, d, 0));
      expect(e.oiAt(ctx, 'PE', k, d - 1, 375)).toBe(e.oiAt(ctx, 'PE', k, d, 0));
    }
  });

  it('serves every analytics endpoint', async () => {
    const urls = [
      '/api/health', '/api/quotes?symbols=NIFTY,RELIANCE', '/api/indices', '/api/expiries/NIFTY', '/api/futures/NIFTY',
      '/api/candles/NIFTY?interval=5', '/api/candles/RELIANCE?interval=D&days=30', '/api/dashboard',
      '/api/oi/strikes/NIFTY', '/api/oi/multi-strike/NIFTY?strikes=26000,26100', '/api/oi/trend/BANKNIFTY', '/api/oi/pcr/NIFTY',
      '/api/oi/max-pain/NIFTY', '/api/oi/futures', '/api/oi/breadth', '/api/participants?days=10', '/api/fii-dii?days=10',
      '/api/vol/iv-chart/NIFTY', '/api/vol/table', '/api/vol/skew/NIFTY?compare=prev', '/api/vol/surface/SENSEX', '/api/vol/cone/INFY',
      '/api/straddle/NIFTY', '/api/straddle/NIFTY?mode=fixed&width=200', '/api/scanners', '/api/unusual', '/api/synopsis',
      '/api/order-book/NIFTY', '/api/order-book/RELIANCE?type=PE',
    ];
    for (const u of urls) {
      const r = await get(u);
      expect(r.status, u).toBe(200);
    }
    const scanners = (await get('/api/scanners')).body as { id: string }[];
    for (const s of scanners) expect((await get(`/api/scanners/${s.id}`)).status, s.id).toBe(200);
  });

  it('participant longs and shorts balance', async () => {
    const days = (await get('/api/participants?days=5')).body as { rows: Record<string, number>[] }[];
    expect(days).toHaveLength(5);
    for (const d of days) {
      for (const cat of ['futIndex', 'optIndexCall', 'optIndexPut']) {
        const long = d.rows.reduce((s, r) => s + r[`${cat}Long`], 0);
        const short = d.rows.reduce((s, r) => s + r[`${cat}Short`], 0);
        expect(Math.abs(long - short) / long).toBeLessThan(0.001);
      }
    }
  });

  it('returns 404 for unknown symbols', async () => {
    expect((await get('/api/chain/NOPE')).status).toBe(404);
  });
});

describe('strategy tools', () => {
  it('optimizer ranks risk-defined strategies for a view', async () => {
    const chain = (await get('/api/chain/NIFTY')).body as OptionChain;
    const expiry = chain.expiries[2];
    const r = await post('/api/optimizer', { symbol: 'NIFTY', expiry, targetPrice: Math.round(chain.spot * 1.015), targetDate: expiry, stopLoss: Math.round(chain.spot * 0.99), maxLegs: 3 });
    expect(r.status).toBe(200);
    expect(r.body.scanned).toBeGreaterThan(10_000);
    expect(r.body.results.length).toBeGreaterThan(5);
    for (const c of r.body.results) {
      expect(c.targetPnl).toBeGreaterThan(0);
      expect(c.maxLoss).toBeLessThan(0);
    }
  });

  it('replays a strategy through history (trade recap)', async () => {
    const from = sessionTs('2026-10-05', 30);
    const chain = (await get(`/api/chain/NIFTY?at=${from}`)).body as OptionChain;
    expect(chain.expiry).toBe('2026-10-06');
    const row = chain.rows.find((x) => x.strike === chain.atm)!;
    const r = await post('/api/recap', { symbol: 'NIFTY', fromTs: from, legs: [{ side: 'SELL', type: 'CE', strike: chain.atm, expiry: chain.expiry, lots: 1, price: row.ce.ltp }] });
    expect(r.status).toBe(200);
    expect(r.body.expired).toBe(true);
    expect(r.body.points.length).toBeGreaterThan(100);
    expect(r.body.points[0].pnl).toBeCloseTo(0, 0);
  });

  it('charts a strategy premium through the day', async () => {
    const chain = (await get('/api/chain/NIFTY')).body as OptionChain;
    const r = await post('/api/strategy-chart', { symbol: 'NIFTY', legs: [{ side: 'SELL', type: 'CE', strike: chain.atm, expiry: chain.expiry, lots: 1 }, { side: 'SELL', type: 'PE', strike: chain.atm, expiry: chain.expiry, lots: 1 }] });
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThan(20);
    expect(r.body[0].pnl).toBe(0);
  });
});

describe('accounts & paper trading', () => {
  it('requires auth for user routes', async () => {
    expect((await get('/api/broker/funds')).status).toBe(401);
  });

  it('registers, logs in and rejects bad passwords', async () => {
    const reg = await post('/api/auth/register', { name: 'Asha', email: 'asha@example.com', password: 'secret123' });
    expect(reg.status).toBe(200);
    expect((await post('/api/auth/login', { email: 'asha@example.com', password: 'secret123' })).status).toBe(200);
    expect((await post('/api/auth/login', { email: 'asha@example.com', password: 'nope-nope' })).status).toBe(401);
    expect((await post('/api/auth/register', { name: 'Dup', email: 'asha@example.com', password: 'secret123' })).status).toBe(409);
  });

  it('fills, rejects and exits paper orders with margin checks', async () => {
    const chain = (await get('/api/chain/NIFTY')).body as OptionChain;
    const sell = await post('/api/broker/orders', { symbol: 'NIFTY', type: 'PE', strike: chain.atm, expiry: chain.expiry, side: 'SELL', lots: 1, orderType: 'MARKET' }, auth());
    expect(sell.body.status).toBe('COMPLETE');
    const limit = await post('/api/broker/orders', { symbol: 'NIFTY', type: 'CE', strike: chain.atm, expiry: chain.expiry, side: 'BUY', lots: 1, orderType: 'LIMIT', price: 0.05 }, auth());
    expect(limit.body.status).toBe('OPEN');
    const huge = await post('/api/broker/orders', { symbol: 'NIFTY', type: 'FUT', expiry: chain.futureExpiry, side: 'SELL', lots: 50, orderType: 'MARKET' }, auth());
    expect(huge.body.status).toBe('REJECTED');
    const funds = (await get('/api/broker/funds', auth())).body;
    expect(funds.usedMargin).toBeGreaterThan(50_000);
    expect(funds.available).toBeLessThan(1_000_000);
    const positions = (await get('/api/broker/positions', auth())).body;
    expect(positions).toHaveLength(1);
    expect(positions[0].netQty).toBe(-65);
    const exit = await post('/api/broker/positions/exit', { key: positions[0].key }, auth());
    expect(exit.body.status).toBe('COMPLETE');
    const after = (await get('/api/broker/positions', auth())).body;
    expect(after[0].netQty).toBe(0);
    expect(after[0].status).toBe('closed');
    const cancel = await app.inject({ method: 'DELETE', url: `/api/broker/orders/${limit.body.id}`, headers: auth() });
    expect(cancel.json().status).toBe('CANCELLED');
    expect((await post('/api/broker/orders', { symbol: 'NIFTY', type: 'CE', strike: 12345, expiry: chain.expiry, side: 'BUY', lots: 1 }, auth())).status).toBe(400);
  });

  it('manages virtual strategies', async () => {
    const chain = (await get('/api/chain/NIFTY')).body as OptionChain;
    const created = await post('/api/strategies', { name: 'Straddle', symbol: 'NIFTY', legs: [{ side: 'SELL', type: 'CE', strike: chain.atm, expiry: chain.expiry, lots: 1 }, { side: 'SELL', type: 'PE', strike: chain.atm, expiry: chain.expiry, lots: 1 }] }, auth());
    expect(created.status).toBe(200);
    expect(created.body.legs[0].price).toBeGreaterThan(0);
    expect(created.body.live.legsLtp).toHaveLength(2);
    const list = (await get('/api/strategies', auth())).body;
    expect(list.some((s: { id: string }) => s.id === created.body.id)).toBe(true);
    const exited = await post(`/api/strategies/${created.body.id}/exit`, {}, auth());
    expect(exited.body.status).toBe('closed');
  });

  it('triggers alerts and notifies', async () => {
    const a = await post('/api/alerts', { kind: 'PRICE', symbol: 'NIFTY', condition: 'above', value: 1000 }, auth());
    expect(a.body.status).toBe('active');
    const iv = await post('/api/alerts', { kind: 'IV', symbol: 'NIFTY', condition: 'above', value: 99 }, auth());
    svc.alerts.evaluate();
    const alerts = (await get('/api/alerts', auth())).body as { id: string; status: string }[];
    expect(alerts.find((x) => x.id === a.body.id)!.status).toBe('triggered');
    expect(alerts.find((x) => x.id === iv.body.id)!.status).toBe('active');
    const notes = (await get('/api/notifications', auth())).body as { title: string }[];
    expect(notes.some((n) => n.title.includes('NIFTY price above 1000'))).toBe(true);
  });

  it('serves watchlist quotes', async () => {
    const lists = (await get('/api/watchlists', auth())).body;
    expect(lists[0].items.length).toBeGreaterThan(3);
    const quotes = (await get(`/api/watchlists/${lists[0].id}/quotes`, auth())).body;
    expect(quotes[0].ltp).toBeGreaterThan(0);
  });
});
