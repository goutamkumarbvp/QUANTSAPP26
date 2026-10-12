import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { z, ZodError } from 'zod';
import type { MetaResponse, ServerMessage, ClientMessage } from '@q26/core';
import { profile } from './auth';
import type { StoredUser } from './store/db';
import { SCANNERS } from './services/market-tools';
import type { Services } from './services';

declare module 'fastify' {
  interface FastifyRequest {
    user: StoredUser | null;
  }
}

const INDEX_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];

/* ------------------------------ validation ------------------------------ */

const legSchema = z.object({
  id: z.string().optional(),
  side: z.enum(['BUY', 'SELL']),
  type: z.enum(['CE', 'PE', 'FUT']),
  strike: z.coerce.number().default(0),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lots: z.coerce.number().int().min(1).max(500),
  lotSize: z.coerce.number().optional().default(1),
  price: z.coerce.number().min(0).default(0),
  iv: z.coerce.number().optional(),
  exitPrice: z.coerce.number().nullable().optional(),
  active: z.boolean().optional(),
});

const strategySchema = z.object({
  name: z.string().max(80).optional(),
  symbol: z.string().min(1),
  legs: z.array(legSchema).min(1).max(12),
  notes: z.string().max(1000).optional(),
  targetMtm: z.coerce.number().nullable().optional(),
  stopLossMtm: z.coerce.number().nullable().optional(),
});

const orderSchema = z.object({
  symbol: z.string().min(1),
  type: z.enum(['CE', 'PE', 'FUT']),
  strike: z.coerce.number().optional(),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  side: z.enum(['BUY', 'SELL']),
  lots: z.coerce.number().int(),
  orderType: z.enum(['MARKET', 'LIMIT', 'SL', 'SL-M']).default('MARKET'),
  price: z.coerce.number().optional(),
  triggerPrice: z.coerce.number().optional(),
  product: z.enum(['NRML', 'MIS']).default('NRML'),
  tag: z.string().max(40).optional(),
});

const alertSchema = z.object({
  kind: z.enum(['PRICE', 'OPTION_PRICE', 'IV', 'PCR', 'OI_CHANGE', 'MTM', 'ORB_BREAK', 'ORDER_FLOW']),
  symbol: z.string().min(1),
  condition: z.enum(['above', 'below']),
  value: z.coerce.number(),
  optionType: z.enum(['CE', 'PE']).optional(),
  strike: z.coerce.number().optional(),
  expiry: z.string().optional(),
  strategyId: z.string().optional(),
  note: z.string().max(200).optional(),
});

const watchItemSchema = z.object({
  symbol: z.string().min(1),
  type: z.enum(['EQ', 'CE', 'PE', 'FUT']),
  strike: z.coerce.number().optional(),
  expiry: z.string().optional(),
});

const settingsSchema = z
  .object({
    theme: z.enum(['dark', 'light']),
    defaultSymbol: z.string(),
    strikesAround: z.coerce.number().int().min(5).max(60),
    showGreeks: z.boolean(),
    oiUnit: z.enum(['qty', 'lots']),
    riskFreeRate: z.coerce.number().min(0).max(0.2),
  })
  .partial();

/* ------------------------------ helpers ------------------------------ */

type Q = Record<string, string | undefined>;
const qs = (req: FastifyRequest) => (req.query ?? {}) as Q;
const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) ? n : d;
};

function requireUser(req: FastifyRequest): StoredUser {
  if (!req.user) throw Object.assign(new Error('Please sign in'), { statusCode: 401 });
  return req.user;
}

export async function buildApp(svc: Services, opts: { logger?: boolean; serveWeb?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1_000_000 });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    const h = req.headers.authorization;
    req.user = h?.startsWith('Bearer ') ? svc.auth.verify(h.slice(7)) : null;
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply: FastifyReply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    const code = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (code >= 500) app.log.error(err);
    return reply.status(code).send({ error: code >= 500 ? 'Internal error' : err.message });
  });

  const now = () => svc.clock.now();
  /** Historical "as-of" timestamp (trade recap); never in the future. */
  const at = (req: FastifyRequest) => {
    const t = num(qs(req).at, NaN);
    const n = now();
    return Number.isFinite(t) && t < n ? t : n;
  };
  const e = svc.engine;
  const an = svc.analytics;

  /* ============================== market ============================== */

  app.get('/api/health', async () => ({ ok: true, clock: svc.clock.info() }));

  app.get('/api/meta', async (): Promise<MetaResponse> => ({
    appName: 'Q26 Options',
    dataSource: 'simulated',
    riskFreeRate: svc.config.riskFreeRate,
    clock: svc.clock.info(),
    symbols: [...e.instruments.values()].map(({ symbol, name, kind, exchange, sector, lotSize, strikeStep, expiryRule }) => ({ symbol, name, kind, exchange, sector, lotSize, strikeStep, expiryRule })),
  }));

  app.get('/api/clock', async () => svc.clock.info());

  app.get('/api/quotes', async (req) => {
    const list = (qs(req).symbols ?? INDEX_SYMBOLS.join(',')).split(',').filter(Boolean).slice(0, 80);
    const ts = at(req);
    return list.map((s) => e.quote(s, ts));
  });

  app.get('/api/indices', async (req) => INDEX_SYMBOLS.map((s) => e.quote(s, at(req))));

  app.get<{ Params: { symbol: string } }>('/api/expiries/:symbol', async (req) => {
    const ts = at(req);
    return { options: e.expiries(req.params.symbol, ts), futures: e.futureExpiries(req.params.symbol, ts) };
  });

  app.get<{ Params: { symbol: string } }>('/api/chain/:symbol', async (req) => e.chain(req.params.symbol, qs(req).expiry, at(req)));

  app.get<{ Params: { symbol: string } }>('/api/futures/:symbol', async (req) => an.futures(req.params.symbol, at(req)));

  app.get<{ Params: { symbol: string } }>('/api/candles/:symbol', async (req) => {
    const q = qs(req);
    return an.candles(req.params.symbol, q.interval ?? '5', Math.min(400, num(q.days, q.interval === 'D' ? 120 : 1)), at(req));
  });

  app.get('/api/dashboard', async () => {
    const ts = now();
    const indices = INDEX_SYMBOLS.map((s) => e.quote(s, ts));
    const fut = an.futuresBuildUp(ts);
    const stocks = fut.filter((r) => r.kind === 'stock').map((r) => ({ ...r, spot: e.quote(r.symbol, ts) }));
    const byChange = [...stocks].sort((a, b) => b.spot.changePct - a.spot.changePct);
    const counts = { 'Long Build-up': 0, 'Short Build-up': 0, 'Short Covering': 0, 'Long Unwinding': 0, Neutral: 0 };
    for (const r of stocks) counts[r.buildUp]++;
    const orbBySymbol = new Map(an.orbScan(ts).map((r) => [r.symbol, r]));
    const chains = ['NIFTY', 'BANKNIFTY', 'SENSEX'].map((s) => {
      const c = e.chain(s, undefined, ts);
      const o = orbBySymbol.get(s)!;
      const flow = svc.tools.orderFlow(s, { type: 'FUT' }, ts, { limit: 1 });
      return {
        symbol: s, expiry: c.expiry, pcr: c.pcr, maxPain: c.maxPain, atmIv: c.atmIv, ivChange: c.ivChange, support: c.support, resistance: c.resistance, spot: c.spot, daysToExpiry: c.daysToExpiry,
        orb: { high: o.high, low: o.low, trend: o.trend, whipsaw: o.whipsaw, reentered: o.reentered, summary: o.summary },
        flow: flow.lastMinute ? { buyPct: flow.lastMinute.buyPct, delta: flow.lastMinute.delta, sentiment: flow.lastMinute.sentiment, ts: flow.lastMinute.ts } : null,
      };
    });
    const p = e.parts(ts);
    const flows = svc.flows.fiiDii.slice(Math.max(0, p.dayIdx - 5), p.dayIdx);
    const toRow = (r: (typeof stocks)[number]) => ({ symbol: r.symbol, ltp: r.spot.ltp, changePct: r.spot.changePct, oiChangePct: r.oiChangePct, buildUp: r.buildUp });
    return {
      clock: svc.clock.info(),
      indices,
      gainers: byChange.slice(0, 6).map(toRow),
      losers: byChange.slice(-6).reverse().map(toRow),
      oiGainers: [...stocks].sort((a, b) => b.oiChangePct - a.oiChangePct).slice(0, 6).map(toRow),
      buildUpCounts: counts,
      chains,
      fiiDii: flows,
    };
  });

  /* ---------------------------- trend: opening range & order flow ---------------------------- */

  const orbOpts = (q: Q) => ({ rangeMinutes: num(q.minutes, 15), rule: (q.rule === 'touch' ? 'touch' : 'close') as 'touch' | 'close' });

  app.get('/api/orb', async (req) => an.orbScan(now(), orbOpts(qs(req))));
  app.get<{ Params: { symbol: string } }>('/api/orb/:symbol', async (req) => {
    const q = qs(req);
    return an.orb(req.params.symbol, now(), { ...orbOpts(q), date: q.date || undefined });
  });
  app.get<{ Params: { symbol: string } }>('/api/orb/:symbol/history', async (req) => {
    const q = qs(req);
    return an.orbHistory(req.params.symbol, num(q.days, 20), now(), orbOpts(q));
  });
  app.get<{ Params: { symbol: string } }>('/api/order-flow/:symbol', async (req) => {
    const q = qs(req);
    const type = q.type === 'CE' || q.type === 'PE' ? q.type : 'FUT';
    return svc.tools.orderFlow(req.params.symbol, { type, strike: q.strike ? num(q.strike, 0) : undefined, expiry: q.expiry || undefined }, now(), { date: q.date || undefined, limit: num(q.limit, 60) });
  });

  /* ---------------------------- open interest ---------------------------- */

  app.get<{ Params: { symbol: string } }>('/api/oi/strikes/:symbol', async (req) => {
    const q = qs(req);
    return an.strikeOi(req.params.symbol, q.expiry, at(req), q.from ? num(q.from, NaN) : undefined);
  });

  app.get<{ Params: { symbol: string } }>('/api/oi/multi-strike/:symbol', async (req) => {
    const q = qs(req);
    const strikes = (q.strikes ?? '').split(',').map(Number).filter((x) => x > 0).slice(0, 8);
    return an.multiStrike(req.params.symbol, q.expiry, strikes, q.date, num(q.interval, 5), now());
  });

  app.get<{ Params: { symbol: string } }>('/api/oi/trend/:symbol', async (req) => {
    const q = qs(req);
    return an.oiTrend(req.params.symbol, q.expiry, q.date, num(q.interval, 5), now());
  });

  app.get<{ Params: { symbol: string } }>('/api/oi/pcr/:symbol', async (req) => {
    const q = qs(req);
    const trend = an.oiTrend(req.params.symbol, q.expiry, q.date, num(q.interval, 5), now());
    return { expiry: trend.expiry, intraday: trend.points.map((p) => ({ ts: p.ts, pcr: p.pcr, spot: p.spot, ceOi: p.ceOi, peOi: p.peOi })), daily: an.dailyPcr(req.params.symbol, Math.min(120, num(q.days, 30)), now()) };
  });

  app.get<{ Params: { symbol: string } }>('/api/oi/max-pain/:symbol', async (req) => an.maxPainDetail(req.params.symbol, qs(req).expiry, now()));

  app.get('/api/oi/futures', async () => an.futuresBuildUp(now()));

  app.get('/api/oi/breadth', async () => an.breadth(now()));

  app.get('/api/participants', async (req) => {
    const p = e.parts(now());
    const days = Math.min(250, num(qs(req).days, 30));
    // Participant data is published after the close: today's row appears only once the session ends.
    const last = p.m >= 375 ? p.dayIdx : p.dayIdx - 1;
    return svc.flows.participants.slice(Math.max(0, last - days + 1), last + 1);
  });

  app.get('/api/fii-dii', async (req) => {
    const p = e.parts(now());
    const days = Math.min(250, num(qs(req).days, 30));
    const last = p.m >= 375 ? p.dayIdx : p.dayIdx - 1;
    return svc.flows.fiiDii.slice(Math.max(0, last - days + 1), last + 1);
  });

  /* ---------------------------- volatility ---------------------------- */

  app.get<{ Params: { symbol: string } }>('/api/vol/iv-chart/:symbol', async (req) => {
    const q = qs(req);
    return an.ivChart(req.params.symbol, q.expiry, q.date, num(q.interval, 5), Math.min(400, num(q.days, 120)), now());
  });
  app.get('/api/vol/table', async () => an.ivTable(now()));
  app.get<{ Params: { symbol: string } }>('/api/vol/skew/:symbol', async (req) => {
    const q = qs(req);
    return an.skew(req.params.symbol, (q.expiries ?? '').split(',').filter(Boolean), now(), q.compare === 'prev' ? 'prev' : 'none');
  });
  app.get<{ Params: { symbol: string } }>('/api/vol/surface/:symbol', async (req) => an.surface(req.params.symbol, now()));
  app.get<{ Params: { symbol: string } }>('/api/vol/cone/:symbol', async (req) => an.cone(req.params.symbol, now()));

  /* ---------------------------- strategy tools ---------------------------- */

  app.get<{ Params: { symbol: string } }>('/api/straddle/:symbol', async (req) => {
    const q = qs(req);
    const strike = q.strike && q.strike !== 'atm' ? num(q.strike, NaN) : 'atm';
    return an.straddle(req.params.symbol, q.expiry, Number.isFinite(strike as number) || strike === 'atm' ? strike : 'atm', q.mode === 'fixed' ? 'fixed' : 'rolling', q.date, num(q.interval, 1), now(), num(q.width, 0));
  });

  app.post('/api/strategy-chart', async (req) => {
    const body = z.object({ symbol: z.string(), legs: z.array(legSchema).min(1).max(12), date: z.string().optional(), interval: z.coerce.number().optional() }).parse(req.body);
    const inst = e.inst(body.symbol);
    const legs = body.legs.map((l) => ({ ...l, lotSize: inst.lotSize }));
    return an.strategyChart(body.symbol, legs, body.date, body.interval ?? 5, now());
  });

  app.post('/api/optimizer', async (req) => {
    const body = z
      .object({
        symbol: z.string(),
        expiry: z.string(),
        targetPrice: z.coerce.number().positive(),
        targetDate: z.string(),
        stopLoss: z.coerce.number().positive().optional(),
        maxLegs: z.coerce.number().int().min(1).max(4).optional(),
        allowUnlimitedRisk: z.boolean().optional(),
        maxCapital: z.coerce.number().positive().optional(),
        sortBy: z.enum(['rr', 'profit', 'pop']).optional(),
      })
      .parse(req.body);
    return an.optimize({ ...body, maxLegs: body.maxLegs as 1 | 2 | 3 | 4 | undefined }, now());
  });

  app.post('/api/recap', async (req) => {
    const body = z.object({ symbol: z.string(), legs: z.array(legSchema).min(1).max(12), fromTs: z.coerce.number(), toTs: z.coerce.number().optional(), intervalMin: z.coerce.number().optional() }).parse(req.body);
    const inst = e.inst(body.symbol);
    return an.recap({ ...body, legs: body.legs.map((l) => ({ ...l, lotSize: inst.lotSize })) }, now());
  });

  /* ---------------------------- scanners & market-wide ---------------------------- */

  app.get('/api/scanners', async () => SCANNERS);
  app.get<{ Params: { id: string } }>('/api/scanners/:id', async (req) => svc.tools.scanner(req.params.id, now(), Math.min(100, num(qs(req).limit, 25))));
  app.get('/api/unusual', async (req) => svc.tools.unusual(now(), qs(req).symbol || undefined));
  app.get('/api/synopsis', async () => svc.tools.synopsis(now()));
  app.get<{ Params: { symbol: string } }>('/api/order-book/:symbol', async (req) => {
    const q = qs(req);
    const type = q.type === 'CE' || q.type === 'PE' ? q.type : 'FUT';
    return svc.tools.orderBook(req.params.symbol, { type, strike: q.strike ? num(q.strike, 0) : undefined, expiry: q.expiry }, now());
  });

  /* ============================== user ============================== */

  app.post('/api/auth/register', async (req) => {
    const b = z.object({ name: z.string().max(60).default(''), email: z.string().email(), password: z.string().min(6).max(200) }).parse(req.body);
    const user = req.user?.guest ? svc.auth.upgrade(req.user, b.name, b.email, b.password) : svc.auth.register(b.name, b.email, b.password);
    return { token: svc.auth.issue(user.id), user: profile(user) };
  });
  app.post('/api/auth/login', async (req) => {
    const b = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const user = svc.auth.login(b.email, b.password);
    return { token: svc.auth.issue(user.id), user: profile(user) };
  });
  app.post('/api/auth/guest', async () => {
    const user = svc.auth.guest();
    return { token: svc.auth.issue(user.id), user: profile(user) };
  });
  app.get('/api/auth/me', async (req) => profile(requireUser(req)));
  app.put('/api/settings', async (req) => {
    const u = requireUser(req);
    u.settings = { ...u.settings, ...settingsSchema.parse(req.body) };
    svc.db.save();
    return profile(u);
  });

  // strategies (virtual portfolio)
  app.get('/api/strategies', async (req) => svc.strategies.list(requireUser(req).id));
  app.post('/api/strategies', async (req) => svc.strategies.create(requireUser(req).id, strategySchema.parse(req.body)));
  app.get<{ Params: { id: string } }>('/api/strategies/:id', async (req) => svc.strategies.get(requireUser(req).id, req.params.id));
  app.put<{ Params: { id: string } }>('/api/strategies/:id', async (req) => svc.strategies.update(requireUser(req).id, req.params.id, strategySchema.partial().parse(req.body)));
  app.post<{ Params: { id: string } }>('/api/strategies/:id/exit', async (req) => {
    const b = z.object({ legIds: z.array(z.string()).optional() }).parse(req.body ?? {});
    return svc.strategies.exit(requireUser(req).id, req.params.id, b.legIds);
  });
  app.delete<{ Params: { id: string } }>('/api/strategies/:id', async (req) => {
    svc.strategies.remove(requireUser(req).id, req.params.id);
    return { ok: true };
  });

  // paper broker
  app.get('/api/broker/funds', async (req) => svc.broker.funds(requireUser(req).id));
  app.get('/api/broker/orders', async (req) => svc.broker.orders(requireUser(req).id));
  app.get('/api/broker/trades', async (req) => svc.broker.trades(requireUser(req).id));
  app.get('/api/broker/positions', async (req) => svc.broker.positions(requireUser(req).id));
  app.post('/api/broker/orders', async (req) => svc.broker.place(requireUser(req).id, orderSchema.parse(req.body)));
  app.post('/api/broker/basket', async (req) => {
    const uid = requireUser(req).id;
    const b = z.object({ orders: z.array(orderSchema).min(1).max(12) }).parse(req.body);
    return b.orders.map((o) => {
      try {
        return svc.broker.place(uid, o);
      } catch (err) {
        return { error: (err as Error).message, request: o };
      }
    });
  });
  app.delete<{ Params: { id: string } }>('/api/broker/orders/:id', async (req) => svc.broker.cancel(requireUser(req).id, req.params.id));
  app.post('/api/broker/positions/exit', async (req) => {
    const b = z.object({ key: z.string() }).parse(req.body);
    return svc.broker.exitPosition(requireUser(req).id, b.key);
  });
  app.post('/api/broker/reset', async (req) => {
    svc.broker.reset(requireUser(req).id);
    return { ok: true };
  });

  // alerts & notifications
  app.get('/api/alerts', async (req) => svc.alerts.list(requireUser(req).id));
  app.post('/api/alerts', async (req) => svc.alerts.create(requireUser(req).id, alertSchema.parse(req.body)));
  app.patch<{ Params: { id: string } }>('/api/alerts/:id', async (req) => {
    const b = z.object({ status: z.enum(['active', 'disabled']) }).parse(req.body);
    return svc.alerts.setStatus(requireUser(req).id, req.params.id, b.status);
  });
  app.delete<{ Params: { id: string } }>('/api/alerts/:id', async (req) => {
    svc.alerts.remove(requireUser(req).id, req.params.id);
    return { ok: true };
  });
  app.get('/api/notifications', async (req) => svc.notifier.list(requireUser(req).id));
  app.post('/api/notifications/read', async (req) => {
    svc.notifier.markAllRead(requireUser(req).id);
    return { ok: true };
  });

  // watchlists
  app.get('/api/watchlists', async (req) => svc.watchlists.list(requireUser(req).id));
  app.post('/api/watchlists', async (req) => svc.watchlists.create(requireUser(req).id, z.object({ name: z.string().max(40).default('') }).parse(req.body ?? {}).name));
  app.put<{ Params: { id: string } }>('/api/watchlists/:id', async (req) => svc.watchlists.update(requireUser(req).id, req.params.id, z.object({ name: z.string().max(40).optional(), items: z.array(watchItemSchema).optional() }).parse(req.body)));
  app.delete<{ Params: { id: string } }>('/api/watchlists/:id', async (req) => {
    svc.watchlists.remove(requireUser(req).id, req.params.id);
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>('/api/watchlists/:id/quotes', async (req) => svc.watchlists.quotes(requireUser(req).id, req.params.id));

  /* ============================== algo strategies ============================== */

  const algoParams = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({});
  app.get('/api/algos', async () => svc.algos.catalog());
  app.get<{ Params: { id: string } }>('/api/algos/:id/defaults', async (req) => svc.algos.defaults(req.params.id, qs(req).symbol ?? 'NIFTY'));
  app.post<{ Params: { id: string } }>('/api/algos/:id/backtest', async (req) => {
    const b = z.object({ params: algoParams, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(req.body ?? {});
    return svc.algos.backtestDay(req.params.id, b.params, b.date, now());
  });
  app.post<{ Params: { id: string } }>('/api/algos/:id/backtest-range', async (req) => {
    const b = z.object({ params: algoParams, days: z.coerce.number().int().min(1).max(250).default(20) }).parse(req.body ?? {});
    return svc.algos.backtestRange(req.params.id, b.params, b.days, now());
  });
  app.get('/api/algo-runs', async (req) => svc.algos.list(requireUser(req).id));
  app.post('/api/algo-runs', async (req) => {
    const b = z.object({ algoId: z.string().min(1), presetId: z.string().optional(), name: z.string().max(60).optional(), params: algoParams }).parse(req.body ?? {});
    return svc.algos.create(requireUser(req).id, b);
  });
  app.get<{ Params: { id: string } }>('/api/algo-runs/:id', async (req) => svc.algos.get(requireUser(req).id, req.params.id));
  app.post<{ Params: { id: string } }>('/api/algo-runs/:id/stop', async (req) => svc.algos.stop(requireUser(req).id, req.params.id));
  app.delete<{ Params: { id: string } }>('/api/algo-runs/:id', async (req) => {
    svc.algos.remove(requireUser(req).id, req.params.id);
    return { ok: true };
  });

  /* ============================== websocket ============================== */

  app.register(async (scope) => {
    scope.get('/ws', { websocket: true }, (socket) => {
      let uid: string | null = null;
      let symbols = new Set<string>(INDEX_SYMBOLS);
      const send = (m: ServerMessage) => {
        if (socket.readyState === 1) socket.send(JSON.stringify(m));
      };
      send({ type: 'hello', clock: svc.clock.info() });
      const timer = setInterval(() => {
        try {
          const ts = now();
          send({ type: 'ticks', clock: svc.clock.info(), quotes: [...symbols].map((s) => e.quote(s, ts)) });
        } catch {
          /* ignore */
        }
      }, 1000);
      const offNotify = svc.notifier.onPush((target, notification) => {
        if (target === uid) send({ type: 'notification', notification });
      });
      const onOrder = (target: string, order: import('@q26/core').Order) => {
        if (target === uid) send({ type: 'order', order });
      };
      svc.orderListeners.add(onOrder);
      socket.on('message', (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString()) as ClientMessage;
          if (msg.type === 'auth') uid = svc.auth.verify(msg.token)?.id ?? null;
          if (msg.type === 'subscribe') {
            symbols = new Set([...INDEX_SYMBOLS, ...msg.symbols.filter((s) => e.instruments.has(s)).slice(0, 40)]);
          }
        } catch {
          /* ignore malformed */
        }
      });
      socket.on('close', () => {
        clearInterval(timer);
        offNotify();
        svc.orderListeners.delete(onOrder);
      });
    });
  });

  /* ============================== web app ============================== */

  const webDist = svc.config.webDist;
  if (opts.serveWeb !== false && fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/ws')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: 'Not found' });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'Not found' }));
  }

  return app;
}
