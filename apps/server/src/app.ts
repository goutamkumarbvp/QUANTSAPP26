import fs from 'node:fs';
import path from 'node:path';
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { z, ZodError } from 'zod';
import { expiryTs, type ClientMessage, type Leg, type FeedStatus, type MarketClockInfo, type MetaResponse, type Quote, type QuotesResponse, type ServerMessage, type SymbolInfo } from '@q26/core';
import { profile } from './auth';
import { NoLiveData, type InstrumentKey } from './live/types';
import type { StoredUser } from './store/db';
import { SCANNERS, type ToolViewOptions } from './services/market-tools';
import type { Services } from './services';
import type { Operations } from './ops';
import { buildDashboard } from './services/dashboard';
import {
  buildOptionChain,
  candles,
  clockInfo,
  expiryCycle,
  feedStatus,
  futuresQuotes,
  futuresQuotesAt,
  Gaps,
  httpError,
  liveOptionExpiries,
  recordedExpiries,
  underlyingQuote,
  underlyingQuoteAt,
} from './services/live';

declare module 'fastify' {
  interface FastifyRequest {
    user: StoredUser | null;
  }
}

/** Index underlyings by name: the websocket default and /api/indices while the instrument master is not loaded. */
const INDEX_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];
/** Websocket: at most one batch per socket per second; a heartbeat (clock + feed status) at least this often. */
const WS_BATCH_MS = 1000;
const WS_HEARTBEAT_MS = 5000;
const WS_MAX_SYMBOLS = 40;
/** Open market-data sockets per client address (an IPv6 client: per /64), and in total. */
const WS_MAX_PER_CLIENT = 20;
const WS_MAX_TOTAL = 1000;

/**
 * A browser socket from another site is refused: its Origin must be this server's own host name
 * (any port: the Vite dev server proxies from :5173), or listed in WS_ALLOWED_ORIGINS. Clients that
 * send no Origin (scripts, tests) are not browsers acting for a page and are allowed.
 */
export function wsOriginAllowed(origin: string | undefined, host: string | undefined, allowed: readonly string[]): boolean {
  if (!origin) return true;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (allowed.includes(o.origin)) return true;
  const hostName = (host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return o.hostname.replace(/^\[|\]$/g, '').toLowerCase() === hostName;
}
const SYMBOL_RE = /^[A-Z0-9&_-]{1,32}$/;
/**
 * Routes that answer `?at=` (as of a past time) from the recorder's minutes. Every other route serves
 * live data only, so a past `?at=` there is refused (NoLiveData) instead of being answered live.
 */
const AS_OF_ROUTES = new Set(['/api/quotes', '/api/indices', '/api/expiries/:symbol', '/api/chain/:symbol', '/api/futures/:symbol', '/api/candles/:symbol', '/api/oi/strikes/:symbol']);

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

/**
 * Legs of the strategy chart and recap: the lot size is resolved by Analytics (instrument master,
 * else the official file of the contract's last day); a lot size sent by the client is used only for
 * a contract neither knows, and is never defaulted.
 */
const chartLegSchema = legSchema.extend({ lotSize: z.coerce.number().positive().optional() });
const chartLeg = (l: z.infer<typeof chartLegSchema>): Leg => ({ ...l, lotSize: l.lotSize ?? 0 });

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

const RATE_WINDOW_MS = 60_000;
/** Client keys kept by the rate limiter at most (oldest windows are dropped first). */
const RATE_MAX_KEYS = 20_000;
/** POST routes limited per client address per minute (operations actions: per operator, below). */
const RATE_LIMITS: Readonly<Record<string, number>> = {
  '/api/auth/login': 30,
  '/api/auth/register': 20,
  '/api/auth/guest': 60,
  // CPU-heavy calculations anyone can call (R-09)
  '/api/optimizer': 60,
  '/api/recap': 60,
  '/api/algos/:id/backtest-range': 20,
};
/** Operations actions per operator account per minute. */
const OPS_ACTIONS_PER_MINUTE = 10;

/** The rate-limit key of a client address: an IPv6 client by its /64 (one host owns the whole prefix). */
export function clientKey(ip: string): string {
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (!v4.includes(':')) return v4;
  const [head] = v4.split('%');
  const parts = head.includes('::')
    ? (() => {
        const [a, b] = head.split('::');
        const left = a ? a.split(':') : [];
        const right = b ? b.split(':') : [];
        return [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
      })()
    : head.split(':');
  return `${parts.slice(0, 4).map((x) => x.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/**
 * Who may run the operations actions (re-login, health check, audit): an account listed in
 * OPS_ADMIN_EMAILS, or — when that is empty — the server's owner, the first account given a password
 * (recorded once in the database; a guest upgraded later cannot take it over). With persistence off
 * the owner would change at every restart, so OPS_ADMIN_EMAILS is then required. "Re-login now" can
 * make a real Kotak login: a self-registered stranger must not be able to press it.
 */
function operatorCheck(req: FastifyRequest, svc: Services): { canOperate: boolean; reason?: string; status: number } {
  const u = req.user;
  if (!u) return { canOperate: false, reason: 'Sign in with the operator account to run operations', status: 401 };
  if (u.guest) return { canOperate: false, reason: 'Sign in with a registered account to run operations (guests cannot)', status: 403 };
  const admins = svc.config.opsAdmins;
  if (admins.length) {
    return admins.includes(u.email.trim().toLowerCase())
      ? { canOperate: true, status: 200 }
      : { canOperate: false, reason: 'Not an operator account: operations are limited to the accounts in OPS_ADMIN_EMAILS', status: 403 };
  }
  if (!svc.config.persist) {
    return { canOperate: false, reason: 'Operations need OPS_ADMIN_EMAILS in .env while persistence is off (PERSIST=false)', status: 403 };
  }
  return ownerId(svc) === u.id
    ? { canOperate: true, status: 200 }
    : { canOperate: false, reason: "Not an operator account: operations are limited to this server's owner (the first account registered); set OPS_ADMIN_EMAILS in .env to choose the operators", status: 403 };
}

function requireOperator(req: FastifyRequest, svc: Services): StoredUser {
  const c = operatorCheck(req, svc);
  if (!c.canOperate) throw Object.assign(new Error(c.reason), { statusCode: c.status });
  return req.user!;
}

/** The owner recorded in the database; a database from before it was recorded: its earliest password account, recorded now. */
function ownerId(svc: Services): string | undefined {
  const d = svc.db.data;
  if (d.ownerId && d.users[d.ownerId]) return d.ownerId;
  let owner: StoredUser | undefined;
  for (const u of Object.values(d.users)) if (!u.guest && u.passwordHash && (!owner || u.createdAt < owner.createdAt)) owner = u;
  if (owner) {
    d.ownerId = owner.id;
    svc.db.save();
  }
  return owner?.id;
}

export async function buildApp(
  svc: Services,
  opts: { logger?: FastifyServerOptions['logger']; serveWeb?: boolean; ops?: Operations } = {},
): Promise<FastifyInstance> {
  // Fastify's own two lines per request would flood the terminal (the web app polls every few seconds):
  // requests are written at debug only (LOG_LEVEL=debug), errors by the error handler below.
  const app = Fastify({
    logger: opts.logger ?? false,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 1_000_000,
    // Behind a reverse proxy (TRUST_PROXY): req.ip is the real client, so the limits apply per client.
    ...(svc.config.trustProxy !== undefined ? { trustProxy: svc.config.trustProxy } : {}),
  });
  await app.register(cors, { origin: true });
  await app.register(websocket);

  app.addHook('onResponse', async (req, reply) => {
    if (app.log.level === 'debug' || app.log.level === 'trace') app.log.debug(`${req.method} ${req.url} → ${reply.statusCode} (${Math.round(reply.elapsedTime)} ms)`);
  });

  // Sign-in and operations actions: a fixed window per client address and route (password guessing,
  // guest-account flooding, button hammering). Generous enough for people and the test suites.
  const windows = new Map<string, { n: number; start: number }>();
  const limit = (key: string, max: number, reply: FastifyReply): void => {
    const t = Date.now();
    let w = windows.get(key);
    if (!w || t - w.start >= RATE_WINDOW_MS) {
      windows.delete(key);
      // Bounded: the oldest windows go first (the Map keeps insertion order).
      while (windows.size >= RATE_MAX_KEYS) windows.delete(windows.keys().next().value as string);
      windows.set(key, (w = { n: 0, start: t }));
    }
    if (++w.n > max) {
      const wait = Math.ceil((w.start + RATE_WINDOW_MS - t) / 1000);
      reply.header('retry-after', String(wait));
      throw Object.assign(new Error(`Too many requests: try again in ${wait} s`), { statusCode: 429 });
    }
  };
  // Expired windows are dropped once a minute, not in the request path.
  const pruneTimer = setInterval(() => {
    const t = Date.now();
    for (const [k, w] of windows) if (t - w.start >= RATE_WINDOW_MS) windows.delete(k);
  }, RATE_WINDOW_MS);
  pruneTimer.unref();
  app.addHook('onClose', async () => clearInterval(pruneTimer));
  app.addHook('onRequest', async (req, reply) => {
    const url = req.routeOptions.url;
    const max = req.method === 'POST' && url ? RATE_LIMITS[url] : undefined;
    if (max) limit(`${clientKey(req.ip)}|${url}`, max, reply);
  });

  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req) => {
    const h = req.headers.authorization;
    req.user = h?.startsWith('Bearer ') ? svc.auth.verify(h.slice(7)) : null;
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply: FastifyReply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    // Live/official data not available: 503 with the reason, never a 500 (the web shows it blank).
    if (err instanceof NoLiveData || err.code === 'NO_LIVE_DATA') return reply.status(503).send({ error: err.message, code: 'NO_LIVE_DATA' });
    const code = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
    if (code >= 500) app.log.error(err);
    return reply.status(code).send({ error: code >= 500 ? 'Internal error' : err.message });
  });

  const md = svc.md;
  const now = () => md.clock.now();
  /**
   * `?at=<epoch ms>` as-of time: undefined when absent or not in the past (= live). A past time is
   * answered only from the recorder's minutes (md.intraday); the helpers throw NoLiveData for a
   * time that was not recorded.
   */
  const at = (req: FastifyRequest): number | undefined => {
    const raw = qs(req).at;
    if (raw === undefined || raw === '') return undefined;
    const t = Number(raw);
    if (!Number.isFinite(t)) throw httpError(400, 'at must be a timestamp in epoch milliseconds');
    return t < now() ? t : undefined;
  };
  // A route without an as-of answer never serves live data for a past `?at=` (it would be shown as of that time).
  app.addHook('preHandler', async (req) => {
    const url = req.routeOptions.url;
    if (req.method !== 'GET' || !url?.startsWith('/api/') || AS_OF_ROUTES.has(url)) return;
    const t = at(req);
    if (t !== undefined) throw new NoLiveData(`${url} is served from live data only: no as-of (?at=) answer for ${new Date(t).toISOString()}`);
  });
  const an = svc.analytics;
  /** Live views (order book, order flow) stream their contract in the provider's 'user' tier (ad-hoc watches, rule h). */
  const userTier: ToolViewOptions = { touch: (key, level) => svc.userWatches.touch([key], level) };

  /** Index underlyings from the instrument master (by name while it is not loaded). */
  const indexSymbols = (): string[] => (md.ref.ready() ? md.ref.underlyings().filter((u) => u.kind === 'index').map((u) => u.symbol) : INDEX_SYMBOLS);
  /** Quotes of the symbols that have one (live, or recorded at `asOf`); 503 when none has. Each one left out is added to `gaps` (symbol → reason). */
  const quotesOf = (symbols: string[], asOf?: number, gaps?: Gaps): Quote[] => {
    const out: Quote[] = [];
    const why: string[] = [];
    for (const s of symbols) {
      try {
        out.push(asOf !== undefined ? underlyingQuoteAt(md, s, asOf) : underlyingQuote(md, s));
      } catch (err) {
        if (!(err instanceof NoLiveData)) throw err;
        why.push(err.message);
        gaps?.add(s, err.message);
      }
    }
    if (!out.length && why.length) throw new NoLiveData([...new Set(why)].slice(0, 3).join('; '));
    return out;
  };

  /* ============================== market ============================== */

  // Feed status + the provider's health report (LiveProvider.healthReport: JSON-safe, no secrets).
  app.get('/api/health', async () => {
    const feed = feedStatus(md);
    const report = (md as { healthReport?: () => unknown }).healthReport;
    return { ok: true, clock: clockInfo(md, feed), feed, ...(typeof report === 'function' ? { provider: report.call(md) } : {}) };
  });

  /* ============================== operations (Model F) ============================== */

  const ops = (): Operations => {
    // 404, not 503: a 503 always means "no live data" (NO_LIVE_DATA) in this API.
    if (!opts.ops) throw Object.assign(new Error('Operations (login monitor, watchdog, weekly audit) are not running on this server'), { statusCode: 404 });
    return opts.ops;
  };
  /** The status as this caller may see it (operators: everything; others: the states only). */
  const opsStatus = (req: FastifyRequest) => {
    const c = operatorCheck(req, svc);
    return ops().status({ canOperate: c.canOperate, ...(c.reason ? { reason: c.reason } : {}) });
  };
  /** An operator's action: authorised first, then limited per operator account (not per address). */
  const opsAction = (req: FastifyRequest, reply: FastifyReply, action: string): StoredUser => {
    const u = requireOperator(req, svc);
    ops();
    limit(`op:${u.id}|${action}`, OPS_ACTIONS_PER_MINUTE, reply);
    return u;
  };
  app.get('/api/ops', async (req) => opsStatus(req));
  app.post('/api/ops/login/relogin', async (req, reply) => {
    opsAction(req, reply, 'relogin');
    const r = await ops().login.relogin();
    return { ok: r.ok, message: r.message, status: opsStatus(req) };
  });
  app.post('/api/ops/watchdog/run', async (req, reply) => {
    opsAction(req, reply, 'watchdog');
    const checks = await ops().watchdog.run();
    const fixed = checks.filter((c) => c.result === 'fixed').length;
    const bad = checks.filter((c) => c.result === 'warn' || c.result === 'fail').length;
    // ok is false when the checks found problems (the dashboard shows the line in the warning colour).
    return { ok: bad === 0, message: `Health check done: ${checks.length} checks, ${fixed} fixed, ${bad} need attention`, status: opsStatus(req) };
  });
  app.post('/api/ops/audit/run', async (req, reply) => {
    opsAction(req, reply, 'audit');
    const r = ops().audit.runNow();
    r.done?.catch((e) => app.log.warn(`weekly audit failed: ${e instanceof Error ? e.message : String(e)}`));
    return { ok: r.started, message: r.message, status: opsStatus(req) };
  });
  app.get<{ Params: { id: string } }>('/api/ops/audit/reports/:id', async (req) => {
    requireOperator(req, svc);
    const r = ops().audit.report(req.params.id);
    if (!r) throw Object.assign(new Error('No such audit report'), { statusCode: 404 });
    return r;
  });

  app.get('/api/meta', async (): Promise<MetaResponse> => {
    const gaps = new Gaps();
    let symbols: SymbolInfo[] = [];
    if (!md.ref.ready()) gaps.add('symbols', 'Instrument master not loaded yet');
    else {
      symbols =
        gaps.try('symbols', () =>
          md.ref.underlyings().map((u) => {
            let cycle: SymbolInfo['expiryCycle'] = null;
            try {
              cycle = expiryCycle(md.ref.expiries(u.symbol, 'OPT'));
            } catch {
              cycle = null;
            }
            return { symbol: u.symbol, name: u.name, kind: u.kind, exchange: u.exchange, sector: u.sector, lotSize: u.lotSize, strikeStep: u.strikeStep, expiryCycle: cycle };
          }),
        ) ?? [];
    }
    return { appName: 'Q26 Options', dataSource: 'live', riskFreeRate: svc.config.riskFreeRate, clock: clockInfo(md), symbols, ...gaps.out() };
  });

  app.get('/api/clock', async () => clockInfo(md));

  // Unknown symbols in the list are left out and named in `gaps` (404 only when none is known).
  app.get('/api/quotes', async (req): Promise<QuotesResponse> => {
    const list = [...new Set((qs(req).symbols ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 80);
    const gaps = new Gaps();
    const known: string[] = [];
    let unknown: Error | null = null;
    for (const s of list.length ? list : indexSymbols()) {
      try {
        md.ref.underlying(s);
        known.push(s);
      } catch (err) {
        if (err instanceof NoLiveData || (err as { statusCode?: number }).statusCode !== 404) known.push(s); // master not loaded: quotesOf says so
        else {
          unknown ??= err as Error;
          gaps.add(s, (err as Error).message);
        }
      }
    }
    if (!known.length && unknown) throw unknown;
    const quotes = quotesOf(known, at(req), gaps);
    return { quotes, ...gaps.out() };
  });

  app.get('/api/indices', async (req) => quotesOf(indexSymbols(), at(req)));

  app.get<{ Params: { symbol: string } }>('/api/expiries/:symbol', async (req) => {
    const t = at(req);
    if (t !== undefined) return recordedExpiries(md, md.ref.underlying(req.params.symbol).symbol, t);
    const symbol = md.ref.underlying(req.params.symbol).symbol;
    const n = now();
    return { options: liveOptionExpiries(md, symbol, n), futures: [...md.ref.expiries(symbol, 'FUT')].sort().filter((x) => expiryTs(x) > n) };
  });

  app.get<{ Params: { symbol: string } }>('/api/chain/:symbol', async (req) => buildOptionChain(md, req.params.symbol, qs(req).expiry || undefined, { at: at(req) }));

  app.get<{ Params: { symbol: string } }>('/api/futures/:symbol', async (req) => {
    const t = at(req);
    return t !== undefined ? futuresQuotesAt(md, req.params.symbol, t) : futuresQuotes(md, req.params.symbol);
  });

  // Spot candles; `type=FUT|CE|PE&expiry=…[&strike=…]` for a contract. Ranges are capped per interval (MAX_CANDLE_SESSIONS).
  app.get<{ Params: { symbol: string } }>('/api/candles/:symbol', async (req) => {
    const q = qs(req);
    const symbol = md.ref.underlying(req.params.symbol).symbol;
    let target: string | InstrumentKey = symbol;
    if (q.type === 'FUT' || q.type === 'CE' || q.type === 'PE') {
      if (!q.expiry || !/^\d{4}-\d{2}-\d{2}$/.test(q.expiry)) throw httpError(400, 'expiry (YYYY-MM-DD) is required for contract candles');
      if (q.type !== 'FUT' && !(num(q.strike, NaN) > 0)) throw httpError(400, 'strike is required for option candles');
      target = q.type === 'FUT' ? { symbol, kind: 'FUT', expiry: q.expiry } : { symbol, kind: q.type, expiry: q.expiry, strike: num(q.strike, NaN) };
    }
    return candles(md, target, q.interval ?? '5', num(q.days, q.interval === 'D' ? 120 : 1), { at: at(req) });
  });

  // Home: every card filled on its own (index quotes, stock movers, build-up, 3 chain cards with
  // opening range and last-minute flow, official FII/DII); a card without data is blank with its gap.
  app.get('/api/dashboard', async () => buildDashboard(md, an, svc.tools, { indices: indexSymbols(), onError: (where, err) => app.log.error({ err, where }, 'dashboard card failed') }));

  /* ---------------------------- trend: opening range & order flow ---------------------------- */

  const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD');
  const notFuture = (d: string | undefined) => {
    if (d && d > md.clock.info().date) throw httpError(400, `${d} is in the future`);
    return d || undefined;
  };
  const orbQuery = z.object({
    minutes: z.coerce.number().int().min(1).max(120).default(15),
    rule: z.enum(['close', 'touch']).default('close'),
    date: day.optional().or(z.literal('')),
    days: z.coerce.number().int().min(1).max(250).default(20),
  });
  const flowQuery = z.object({
    type: z.enum(['FUT', 'CE', 'PE']).default('FUT'),
    strike: z.coerce.number().positive().optional(),
    expiry: day.optional().or(z.literal('')),
    date: day.optional().or(z.literal('')),
    limit: z.coerce.number().int().min(1).max(375).default(60),
  });

  app.get('/api/orb', async (req) => {
    const q = orbQuery.parse(qs(req));
    return an.orbScan(now(), { rangeMinutes: q.minutes, rule: q.rule });
  });
  app.get<{ Params: { symbol: string } }>('/api/orb/:symbol', async (req) => {
    const q = orbQuery.parse(qs(req));
    return an.orb(req.params.symbol, now(), { rangeMinutes: q.minutes, rule: q.rule, date: notFuture(q.date) });
  });
  app.get<{ Params: { symbol: string } }>('/api/orb/:symbol/history', async (req) => {
    const q = orbQuery.parse(qs(req));
    return an.orbHistory(req.params.symbol, q.days, now(), { rangeMinutes: q.minutes, rule: q.rule });
  });
  app.get<{ Params: { symbol: string } }>('/api/order-flow/:symbol', async (req) => {
    const q = flowQuery.parse(qs(req));
    return svc.tools.orderFlow(req.params.symbol, { type: q.type, strike: q.strike, expiry: q.expiry || undefined }, now(), { date: notFuture(q.date), limit: q.limit, ...userTier });
  });

  /* ---------------------------- open interest ---------------------------- */

  app.get<{ Params: { symbol: string } }>('/api/oi/strikes/:symbol', async (req) => {
    const q = qs(req);
    const from = q.from ? Number(q.from) : undefined;
    if (from !== undefined && !Number.isFinite(from)) throw httpError(400, 'from must be a timestamp in epoch milliseconds');
    return an.strikeOi(req.params.symbol, q.expiry, at(req), from);
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
    return an.pcr(req.params.symbol, q.expiry, q.date, num(q.interval, 5), Math.min(120, num(q.days, 30)));
  });

  app.get<{ Params: { symbol: string } }>('/api/oi/max-pain/:symbol', async (req) => an.maxPainDetail(req.params.symbol, qs(req).expiry, now()));

  app.get('/api/oi/futures', async () => an.futuresBuildUp(now()));

  app.get('/api/oi/breadth', async () => an.breadth(now()));

  // Official files only (published after the close): the sessions of the last `days` that are loaded.
  app.get('/api/participants', async (req) => {
    const { from, to } = an.rangeOf(Math.min(250, num(qs(req).days, 30)));
    return an.participants(from, to);
  });

  app.get('/api/fii-dii', async (req) => {
    const { from, to } = an.rangeOf(Math.min(250, num(qs(req).days, 30)));
    return an.fiiDii(from, to);
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

  // A malformed strike or width is a 400, never replaced by ATM / 0 (Analytics also rejects ones outside the strikes).
  app.get<{ Params: { symbol: string } }>('/api/straddle/:symbol', async (req) => {
    const q = qs(req);
    let strike: number | 'atm' = 'atm';
    if (q.strike && q.strike !== 'atm') {
      strike = Number(q.strike);
      if (!(Number.isFinite(strike) && strike > 0)) throw httpError(400, `strike must be a positive strike price or 'atm' (got '${q.strike}')`);
    }
    let width = 0;
    if (q.width !== undefined && q.width !== '') {
      width = Number(q.width);
      if (!(Number.isFinite(width) && width >= 0)) throw httpError(400, `width must be a non-negative number of points (got '${q.width}')`);
    }
    return an.straddle(req.params.symbol, q.expiry, strike, q.mode === 'fixed' ? 'fixed' : 'rolling', q.date, num(q.interval, 1), now(), width);
  });

  app.post('/api/strategy-chart', async (req) => {
    const body = z.object({ symbol: z.string(), legs: z.array(chartLegSchema).min(1).max(12), date: z.string().optional(), interval: z.coerce.number().optional() }).parse(req.body);
    return an.strategyChart(body.symbol, body.legs.map(chartLeg), body.date, body.interval ?? 5, now());
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
    const body = z.object({ symbol: z.string(), legs: z.array(chartLegSchema).min(1).max(12), fromTs: z.coerce.number(), toTs: z.coerce.number().optional(), intervalMin: z.coerce.number().optional() }).parse(req.body);
    return an.recap({ ...body, legs: body.legs.map(chartLeg) }, now());
  });

  /* ---------------------------- scanners & market-wide ---------------------------- */

  app.get('/api/scanners', async () => SCANNERS);
  app.get<{ Params: { id: string } }>('/api/scanners/:id', async (req) => svc.tools.scanner(req.params.id, now(), Math.min(100, num(qs(req).limit, 25))));
  app.get('/api/unusual', async (req) => svc.tools.unusual(now(), qs(req).symbol || undefined));
  app.get('/api/synopsis', async () => svc.tools.synopsis(now()));
  app.get<{ Params: { symbol: string } }>('/api/order-book/:symbol', async (req) => {
    const q = qs(req);
    const type = q.type === 'CE' || q.type === 'PE' ? q.type : 'FUT';
    return svc.tools.orderBook(req.params.symbol, { type, strike: q.strike ? num(q.strike, 0) : undefined, expiry: q.expiry || undefined }, now(), userTier);
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

  // One provider tick listener fanned out to the sockets: a tick of an underlying's spot or future
  // marks the symbol changed; each socket gets at most one batch a second with the changed symbols it
  // subscribed to. Quotes are rebuilt from md.live.quote() (underlyingQuote), so an update of an
  // older session is never sent as live. Quotes (until the symbol's next tick) and the feed status
  // are shared for up to a second.
  interface WsClient {
    symbols: Set<string>;
    dirty: Set<string>;
  }
  const clients = new Set<WsClient>();
  const quoteCache = new Map<string, { at: number; quote: Quote | null }>();
  let feedCache: { at: number; feed: FeedStatus } | null = null;
  const cachedClock = (): MarketClockInfo => {
    const t = Date.now();
    if (!feedCache || t - feedCache.at >= WS_BATCH_MS) feedCache = { at: t, feed: feedStatus(md) };
    return clockInfo(md, feedCache.feed);
  };
  const cachedQuote = (symbol: string): Quote | null => {
    const t = Date.now();
    const hit = quoteCache.get(symbol);
    if (hit && t - hit.at < WS_BATCH_MS) return hit.quote;
    let quote: Quote | null = null;
    try {
      quote = underlyingQuote(md, symbol);
    } catch {
      quote = null; // no live price (or unknown symbol): left out of the batch
    }
    quoteCache.set(symbol, { at: t, quote });
    return quote;
  };
  const offTick = md.live.onTick((q) => {
    if (q.key.kind !== 'SPOT' && q.key.kind !== 'FUT') return;
    // A quote cached before this tick is outdated: a socket whose batch runs next must not send it
    // (its dirty mark would be spent on the older price and the new one never sent).
    quoteCache.delete(q.key.symbol);
    for (const c of clients) if (c.symbols.has(q.key.symbol)) c.dirty.add(q.key.symbol);
  });
  app.addHook('onClose', async () => {
    offTick();
  });
  /** Requested symbols: upper-cased, well-formed, at most 40, and listed in the instrument master once it is loaded. */
  const subscription = (symbols: unknown): string[] => {
    if (!Array.isArray(symbols)) return [];
    const clean = [...new Set(symbols.filter((s): s is string => typeof s === 'string').map((s) => s.trim().toUpperCase()))].filter((s) => SYMBOL_RE.test(s));
    const known = md.ref.ready()
      ? clean.filter((s) => {
          try {
            md.ref.underlying(s);
            return true;
          } catch {
            return false;
          }
        })
      : clean;
    return known.slice(0, WS_MAX_SYMBOLS);
  };

  const wsOpen = new Map<string, number>();
  let wsTotal = 0;
  app.register(async (scope) => {
    scope.get(
      '/ws',
      {
        websocket: true,
        // Checked before the upgrade: a refused socket never opens.
        preValidation: async (req, reply) => {
          if (!wsOriginAllowed(req.headers.origin, req.headers.host, svc.config.wsAllowedOrigins)) return reply.code(403).send({ error: 'WebSocket origin not allowed' });
          const key = clientKey(req.ip);
          if ((wsOpen.get(key) ?? 0) >= WS_MAX_PER_CLIENT || wsTotal >= WS_MAX_TOTAL) return reply.code(429).send({ error: 'Too many open market-data connections' });
        },
      },
      (socket, req) => {
        const key = clientKey(req.ip);
        wsOpen.set(key, (wsOpen.get(key) ?? 0) + 1);
        wsTotal++;
        let uid: string | null = null;
        const client: WsClient = { symbols: new Set(indexSymbols()), dirty: new Set() };
        client.dirty = new Set(client.symbols); // the first batch is a snapshot
        clients.add(client);
        let lastSent = Date.now();
        const send = (m: ServerMessage) => {
          if (socket.readyState === 1) socket.send(JSON.stringify(m));
        };
        try {
          send({ type: 'hello', clock: cachedClock() });
        } catch {
          /* the next batch carries the clock */
        }
        const timer = setInterval(() => {
          try {
            const batch = [...client.dirty].filter((s) => client.symbols.has(s));
            client.dirty.clear();
            const quotes = batch.map(cachedQuote).filter((x): x is Quote => x !== null);
            const t = Date.now();
            if (quotes.length || t - lastSent >= WS_HEARTBEAT_MS) {
              send({ type: 'ticks', clock: cachedClock(), quotes });
              lastSent = t;
            }
          } catch {
            /* keep the socket; the next batch retries */
          }
        }, WS_BATCH_MS);
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
              const next = new Set([...indexSymbols(), ...subscription(msg.symbols)]);
              for (const s of next) if (!client.symbols.has(s)) client.dirty.add(s);
              client.symbols = next;
            }
          } catch {
            /* ignore malformed */
          }
        });
        socket.on('close', () => {
          clearInterval(timer);
          clients.delete(client);
          offNotify();
          svc.orderListeners.delete(onOrder);
          const n = (wsOpen.get(key) ?? 1) - 1;
          if (n > 0) wsOpen.set(key, n);
          else wsOpen.delete(key);
          wsTotal = Math.max(0, wsTotal - 1);
        });
      },
    );
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
