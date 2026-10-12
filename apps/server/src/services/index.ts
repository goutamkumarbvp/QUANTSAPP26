import type { AppConfig } from '../config';
import { Auth } from '../auth';
import { MarketClock } from '../market/clock';
import { MarketEngine } from '../market/engine';
import { FlowsModel } from '../market/flows';
import { buildUniverse } from '../market/universe';
import { Db } from '../store/db';
import { AlertService, Notifier, Watchlists } from './alerts';
import { AlgoService } from './algo';
import { Analytics } from './analytics';
import { MarketTools } from './market-tools';
import { Pricer } from './pricer';
import { PaperBroker, StrategyManager } from './trading';
import type { Order } from '@q26/core';

export interface Services {
  config: AppConfig;
  clock: MarketClock;
  engine: MarketEngine;
  flows: FlowsModel;
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
  orderListeners: Set<(uid: string, o: Order) => void>;
  start(): void;
  stop(): void;
}

export function createServices(config: AppConfig, opts: { now?: () => number } = {}): Services {
  const clock = new MarketClock({ mode: config.clockMode, speed: config.simSpeed, holidays: config.holidays, start: config.simStart, now: opts.now });
  const engine = new MarketEngine({ seed: config.seed, riskFreeRate: config.riskFreeRate, holidays: config.holidays, universe: buildUniverse() });
  const flows = new FlowsModel(engine, config.seed);
  const analytics = new Analytics(engine);
  const tools = new MarketTools(engine, analytics);
  const pricer = new Pricer(engine);
  const db = new Db(config.persist ? config.dataDir : null);
  const auth = new Auth(db, config.authSecret);
  const now = () => clock.now();
  const notifier = new Notifier(db, now);
  const orderListeners = new Set<(uid: string, o: Order) => void>();
  const broker = new PaperBroker(engine, db, pricer, now, (uid, n) => notifier.push(uid, n), (uid, o) => orderListeners.forEach((l) => l(uid, o)));
  const strategies = new StrategyManager(engine, db, pricer, now);
  const alerts = new AlertService(engine, db, pricer, strategies, notifier, now, analytics, tools);
  const watchlists = new Watchlists(db, pricer, now);
  const algos = new AlgoService(engine, db, broker, notifier, clock);
  const timers: NodeJS.Timeout[] = [];
  return {
    config, clock, engine, flows, analytics, tools, pricer, db, auth, notifier, broker, strategies, alerts, watchlists, algos, orderListeners,
    start() {
      timers.push(setInterval(() => broker.tick(), 1000));
      timers.push(setInterval(() => alerts.evaluate(), 3000));
      timers.push(setInterval(() => algos.tick(), 2000));
    },
    stop() {
      timers.forEach(clearInterval);
      timers.length = 0;
      db.close();
    },
  };
}
