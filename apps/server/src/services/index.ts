/**
 * Service wiring. Every service reads market data only through the MarketDataProvider passed in:
 * LiveProvider in production (index.ts), the test-only FakeProvider in tests. There is no other mode.
 */
import type { Order } from '@q26/core';
import type { AppConfig } from '../config';
import { Auth } from '../auth';
import { NoLiveData, keyId } from '../live/types';
import type { InstrumentKey, MarketDataProvider, SessionClock, UserContract, WatchLevel } from '../live/types';
import { Db } from '../store/db';
import { AlertService, Notifier, Watchlists } from './alerts';
import { AlgoService } from './algo';
import { Analytics } from './analytics';
import { futKey, nearFuture, optKey, spotKey, UserWatches } from './live';
import { MarketTools } from './market-tools';
import { Pricer } from './pricer';
import { PaperBroker, StrategyManager } from './trading';

export interface Services {
  config: AppConfig;
  /** The market-data provider (the only source of market data). */
  md: MarketDataProvider;
  /** md.clock (real IST time). */
  clock: SessionClock;
  analytics: Analytics;
  tools: MarketTools;
  pricer: Pricer;
  db: Db;
  auth: Auth;
  notifier: Notifier;
  broker: PaperBroker;
  strategies: StrategyManager;
  alerts: AlertService;
  watchlists: Watchlists;
  algos: AlgoService;
  /** Instruments users are looking at right now (Order Book depth views …): streamed in the 'user' tier. */
  userWatches: UserWatches;
  orderListeners: Set<(uid: string, o: Order) => void>;
  start(): void;
  stop(): void;
}

export interface CreateServicesOptions {
  /** Required: LiveProvider in production, the test-only FakeProvider in tests. */
  provider: MarketDataProvider;
  /** Errors a background tick could not handle (NoLiveData is expected and never reported). */
  onError?: (where: string, e: unknown) => void;
}

/** User contracts streamed in the provider's 'user' tier (the pinned universe leaves ~290 tokens). */
export const MAX_USER_CONTRACTS = 250;

const LEVEL_RANK: Record<WatchLevel, number> = { ltp: 0, quote: 1, depth: 2 };

/**
 * Contracts users hold or look at, highest priority first: working orders and open positions,
 * ad-hoc user watches (depth views), open strategy legs, active alerts, running algos (optional
 * AlgoService.userContracts()), watchlist items. Expired contracts are left out; at most
 * MAX_USER_CONTRACTS distinct keys (a key keeps its deepest level).
 */
export function collectUserContracts(
  md: MarketDataProvider,
  db: Db,
  sources: { broker: PaperBroker; strategies: StrategyManager; userWatches: UserWatches; algos?: unknown },
): UserContract[] {
  const today = md.calendar.session(md.clock.now()).date;
  const wanted = new Map<string, { key: InstrumentKey; level: WatchLevel }>();
  const add = (key: InstrumentKey | null, level: WatchLevel = 'quote') => {
    if (!key || (key.expiry !== undefined && key.expiry < today)) return;
    const id = keyId(key);
    const prev = wanted.get(id);
    if (prev) {
      if (LEVEL_RANK[level] > LEVEL_RANK[prev.level]) prev.level = level;
      return;
    }
    if (wanted.size < MAX_USER_CONTRACTS) wanted.set(id, { key, level });
  };
  const fromItem = (symbol: string, type: string, expiry?: string, strike?: number): InstrumentKey | null => {
    if (type === 'EQ') return spotKey(symbol);
    if (!expiry) return null;
    if (type === 'FUT') return futKey(symbol, expiry);
    if ((type === 'CE' || type === 'PE') && Number(strike) > 0) return optKey(symbol, expiry, type, Number(strike));
    return null;
  };

  for (const k of sources.broker.openContracts()) add(k);
  for (const c of sources.userWatches.list()) add('key' in c ? c.key : c, 'key' in c ? c.level : 'quote');
  for (const k of sources.strategies.openContracts()) add(k);
  for (const list of Object.values(db.data.alerts)) {
    for (const a of list) {
      if (a.status !== 'active' || a.kind === 'MTM') continue;
      if ((a.kind === 'OPTION_PRICE' || a.kind === 'OI_CHANGE') && a.optionType) add(fromItem(a.symbol, a.optionType, a.expiry, a.strike));
      else add(spotKey(a.symbol));
      if (a.kind === 'ORDER_FLOW') {
        const nf = nearFuture(md, a.symbol);
        if (nf) add(futKey(a.symbol, nf));
      }
    }
  }
  const hook = (sources.algos as { userContracts?: () => Iterable<UserContract> } | undefined)?.userContracts;
  if (typeof hook === 'function') for (const c of hook.call(sources.algos)) add('key' in c ? c.key : c, 'key' in c ? c.level : 'quote');
  for (const lists of Object.values(db.data.watchlists)) for (const w of lists) for (const it of w.items) add(fromItem(it.symbol, it.type, it.expiry, it.strike));

  return [...wanted.values()].map((w) => (w.level === 'quote' ? w.key : { key: w.key, level: w.level }));
}

export function createServices(config: AppConfig, opts: CreateServicesOptions): Services {
  if (!opts?.provider) throw new Error('createServices: a MarketDataProvider is required (LiveProvider; tests: FakeProvider)');
  const md = opts.provider;
  const now = () => md.clock.now();
  const pricer = new Pricer(md);
  const analytics = new Analytics(md, pricer);
  const tools = new MarketTools(md, analytics);
  const db = new Db(config.persist ? config.dataDir : null);
  const auth = new Auth(db, config.authSecret);
  const notifier = new Notifier(db, now);
  const orderListeners = new Set<(uid: string, o: Order) => void>();
  const broker = new PaperBroker(md, db, pricer, now, (uid, n) => notifier.push(uid, n), (uid, o) => orderListeners.forEach((l) => l(uid, o)));
  const strategies = new StrategyManager(md, db, pricer, now);
  const alerts = new AlertService(md, db, pricer, strategies, notifier, now, analytics, tools);
  const watchlists = new Watchlists(db, pricer, now);
  const algos = new AlgoService(md, db, broker, notifier, pricer);
  const userWatches = new UserWatches(now);

  // Everything users hold or look at is always streamed (the provider reads this about once a minute).
  md.setUserContracts(() => collectUserContracts(md, db, { broker, strategies, userWatches, algos }));

  /** A background tick never throws: missing live data is expected, other errors are reported. */
  const safe = (where: string, fn: () => unknown) => () => {
    const report = (e: unknown) => {
      if (!(e instanceof NoLiveData)) opts.onError?.(where, e);
    };
    try {
      const r = fn();
      if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).catch(report);
    } catch (e) {
      report(e);
    }
  };

  const timers: NodeJS.Timeout[] = [];
  return {
    config,
    md,
    clock: md.clock,
    analytics,
    tools,
    pricer,
    db,
    auth,
    notifier,
    broker,
    strategies,
    alerts,
    watchlists,
    algos,
    userWatches,
    orderListeners,
    start() {
      if (timers.length) return;
      timers.push(setInterval(safe('broker.tick', () => broker.tick()), 1000));
      timers.push(setInterval(safe('alerts.evaluate', () => alerts.evaluate()), 3000));
      timers.push(setInterval(safe('algos.tick', () => algos.tick()), 2000));
    },
    stop() {
      timers.forEach(clearInterval);
      timers.length = 0;
      md.setUserContracts(null);
      db.close();
    },
  };
}
