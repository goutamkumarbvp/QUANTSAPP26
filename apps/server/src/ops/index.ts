/**
 * Operations (Model F): the login monitor, the 24×7 watchdog and the weekly audit, wired to the live
 * provider, plus the status the dashboard shows. index.ts creates it; buildApp() serves it under
 * /api/ops (status is public like /api/health; the three actions need a registered account).
 */
import type { FeedState, OpsStatusResponse } from '@q26/core';
import { KotakRest } from '../live/kotak/rest';
import type { LiveProvider } from '../live/provider';
import { SAFETY } from '../safety';
import type { Db } from '../store/db';
import { OpsJournal } from './journal';
import { LoginMonitor } from './login-monitor';
import { Watchdog } from './watchdog';
import { WeeklyAudit } from './weekly-audit';

export { OpsJournal, LoginMonitor, Watchdog, WeeklyAudit };

export interface OperationsLogger {
  info(m: string): void;
  warn(m: string): void;
  error(m: string): void;
}

export interface Operations {
  readonly journal: OpsJournal;
  readonly login: LoginMonitor;
  readonly watchdog: Watchdog;
  readonly audit: WeeklyAudit;
  status(): OpsStatusResponse;
  start(): void;
  stop(): void;
}

export interface CreateOperationsOptions {
  provider: LiveProvider;
  db: Db | null;
  dataDir: string | null;
  config: { host: string; authSecretSet: boolean; persist: boolean };
  /** Credential values: used to redact the journal and to look for leaks; never returned. */
  secrets: string[];
  scrub: (text: string) => string;
  supervised: boolean;
  requestRestart?: (reason: string) => void;
  log: OperationsLogger;
}

const FEED_STALE_MS = 90_000;

export function createOperations(o: CreateOperationsOptions): Operations {
  const p = o.provider;
  const journal = new OpsJournal({ dataDir: o.dataDir, scrub: o.scrub, now: () => p.clock.now() });
  const login = new LoginMonitor(
    {
      credentials: () => p.credentials(),
      status: () => p.session!.status(),
      loginPending: () => p.loginPending(),
      loginJob: () => p.jobStatuses().login,
      ensureLogin: () => p.ensureLogin(),
      ensureRelogin: () => p.ensureRelogin(),
      loginNow: (opts) => p.loginNow(opts),
      onLoginChange: (fn) => p.onLoginChange(fn),
    },
    journal,
    { now: () => p.clock.now(), log: o.log },
  );
  const watchdog = new Watchdog(
    {
      marketStatus: () => p.calendar.session(p.clock.now()).status,
      feed: () => p.health(),
      login: () => login.status(),
      checkLogin: () => login.check(),
      restartFeed: (why) => p.restartFeed(why),
      clearCaches: (opts) => p.clearCaches(opts),
      jobs: () => p.jobStatuses(),
      eod: () => p.eod.status(),
      refdata: () => p.ref.status(),
      refreshInstrumentMaster: () => p.refreshInstrumentMaster(),
      pruneJournal: (days) => journal.prune(days),
    },
    journal,
    { dataDir: o.dataDir, now: () => p.clock.now(), supervised: o.supervised, requestRestart: o.requestRestart, captureRejections: true, log: o.log },
  );
  const audit = new WeeklyAudit(
    {
      dataDir: o.dataDir,
      calendar: p.calendar,
      eod: p.eod,
      history: p.history,
      intradaySessions: () => p.intraday.sessions(),
      refdata: () => p.ref.status(),
      refreshInstrumentMaster: () => p.refreshInstrumentMaster(),
      login: () => login.status(),
      secrets: () => o.secrets,
      db: o.db,
      config: { ...o.config, invalidHolidays: p.healthReport().invalidHolidays ?? [] },
      journal,
      clearCaches: (opts) => p.clearCaches(opts),
      brokerClientMethods: () => Object.getOwnPropertyNames(KotakRest.prototype),
    },
    { now: () => p.clock.now(), log: o.log },
  );

  const feedState = (): FeedState => {
    const f = p.health();
    if (!f.loggedIn || !f.connected) return 'DATA UNAVAILABLE';
    if (p.calendar.session(p.clock.now()).status !== 'open') return 'MARKET CLOSED';
    return f.lastTickTs !== null && p.clock.now() - f.lastTickTs <= FEED_STALE_MS ? 'LIVE' : 'FEED STALE';
  };

  return {
    journal,
    login,
    watchdog,
    audit,
    status: () => {
      const l = login.status();
      return {
        login: l,
        watchdog: watchdog.status(),
        audit: audit.status(),
        broker: l.state === 'LOGGED_IN' ? 'CONNECTED' : 'DISCONNECTED',
        feed: feedState(),
        safety: { mode: SAFETY.mode, autoExecutionToBroker: SAFETY.autoExecutionToBroker, liveOrderAuthority: SAFETY.liveOrderAuthority, brokerSubmission: SAFETY.brokerSubmission },
        liveTrading: 'NOT READY',
      };
    },
    start: () => {
      journal.add({ source: 'server', level: 'info', type: 'SERVER_START', message: `Server started (pid ${process.pid}${o.supervised ? ', supervised' : ''})` });
      login.start();
      watchdog.start();
      audit.start();
    },
    stop: () => {
      audit.stop();
      watchdog.stop();
      login.stop();
    },
  };
}
