/**
 * Watchdog (Model F #2): checks the running program every 30 s, around the clock, and repairs what
 * can be repaired safely while it runs:
 *   memory          heap near its limit → drop cached REST answers (re-fetched on demand); still
 *                   critical → ask the supervisor for a clean restart
 *   event loop      the server stopped answering in time (p99 delay) → restart when it persists
 *   errors          promise rejections nothing handled → recorded with the message (the server keeps running)
 *   broker login    lost session with nothing armed → the login monitor logs in again
 *   market feed     market open but no tick for 90 s, or the socket down for 2 min → new socket
 *   instrument list not today's master after 08:45 IST → download it again
 *   background jobs repeated failures (login, instrument master, feed) → reported with the next attempt
 *   EOD files       backfill stopped because NSE/BSE could not be reached → reported
 *   disk / storage  little free space → old journals and cached answers removed; DATA_DIR not writable → reported
 * A restart is only requested when the server runs under scripts/supervise.mjs (Q26_SUPERVISED=1),
 * which also restarts it after a crash or when /api/health stops answering. Code defects are not
 * patched at run time: they are recorded (with the error) for a developer and the weekly audit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import v8 from 'node:v8';
import { FEED_STALE_MS, istParts, type LoginMonitorStatus, type OpsEvent, type WatchdogCheck, type WatchdogStatus } from '@q26/core';
import type { JobStatus } from '../live/provider';
import type { FeedHealth } from '../live/types';
import { istWhen } from '../log';
import type { EodStatus } from '../live/eod';
import type { ScripMasterStatus } from '../live/kotak/scripmaster';
import type { OpsJournal } from './journal';

/** What the watchdog needs from the program (index.ts wires the live provider and the login monitor). */
/** Event-loop pauses in the first minutes (start-up loading) are warnings only. */
const STARTUP_GRACE_MS = 5 * 60_000;

export interface WatchdogTarget {
  /** 'open' while the exchange session is open (ticks are expected). */
  marketStatus(): string;
  feed(): FeedHealth;
  login(): LoginMonitorStatus;
  /** Arm a login now when the session is lost (the login monitor's check). */
  checkLogin(): void;
  restartFeed(reason: string): Promise<boolean>;
  clearCaches(opts: { all?: boolean }): number;
  jobs(): Record<string, JobStatus>;
  eod(): EodStatus | null;
  refdata(): ScripMasterStatus;
  refreshInstrumentMaster(): Promise<void>;
  /** Delete operations journals older than N days; returns files removed. */
  pruneJournal(days: number): number;
  /** The last failed write of db.json (users, paper trades), if the latest one failed. */
  dbWriteError?(): string | undefined;
}

export interface WatchdogOptions {
  dataDir: string | null;
  now?: () => number;
  timers?: { setInterval(fn: () => void, ms: number): unknown; clearInterval(h: unknown): void };
  /** Default 30 s. */
  intervalMs?: number;
  supervised?: boolean;
  /** Clean restart (exit for the supervisor); only called when supervised. */
  requestRestart?: (reason: string) => void;
  /** The supervisor saw a restart loop (Q26_RESTART_LOOP=1): restarts are not requested again. */
  restartsSuppressed?: boolean;
  /** Record unhandled promise rejections (index.ts: true; tests: false). */
  captureRejections?: boolean;
  log?: { info(m: string): void; warn(m: string): void; error(m: string): void };
  /** Test hooks. */
  memory?: () => { rss: number; heapUsed: number; heapLimit: number };
  freeDiskBytes?: (dir: string) => number | null;
}

const MB = 1024 * 1024;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** FEED STALE is shown after FEED_STALE_MS (@q26/core, 60 s); the socket is restarted after this. */
const FEED_RESTART_AFTER_MS = 90 * SECOND;
const FEED_DOWN_MS = 2 * MINUTE;
const FEED_RESTART_COOLDOWN_MS = 5 * MINUTE;
const REFDATA_RETRY_MS = 15 * MINUTE;
const JOURNAL_RETAIN_DAYS = 90;
const LOW_DISK_BYTES = 1024 * MB;
const CRITICAL_DISK_BYTES = 200 * MB;
/** 08:45 IST: the daily instrument master is due by then (provider REFDATA job). */
const REFDATA_DUE_MIN = 8 * 60 + 45;

export class Watchdog {
  readonly intervalMs: number;
  readonly supervised: boolean;
  private readonly now: () => number;
  private readonly timers: NonNullable<WatchdogOptions['timers']>;
  private readonly log: NonNullable<WatchdogOptions['log']>;
  private readonly startedAt: number;
  private timer: unknown = null;
  private running: Promise<WatchdogCheck[]> | null = null;
  private histogram: IntervalHistogram | null = null;
  private lastP99Ms: number | null = null;
  private lastRunAt: number | null = null;
  private runs = 0;
  private checks: WatchdogCheck[] = [];
  private readonly lastResult = new Map<string, string>();
  private rejections: { count: number; last?: string } = { count: 0 };
  private onRejection: ((reason: unknown) => void) | null = null;
  private feedDownSince: number | null = null;
  private lastFeedRestart = Number.NEGATIVE_INFINITY;
  private lastRefdataTry = Number.NEGATIVE_INFINITY;
  private memoryStrikes = 0;
  private lagStrikes = 0;
  private writeProbeRun = -1;
  private stopped = false;

  constructor(
    private readonly target: WatchdogTarget,
    private readonly journal: OpsJournal,
    private readonly opts: WatchdogOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? { setInterval: (fn, ms) => setInterval(fn, ms).unref(), clearInterval: (h) => clearInterval(h as NodeJS.Timeout) };
    this.intervalMs = opts.intervalMs ?? 30 * SECOND;
    this.supervised = !!opts.supervised;
    this.log = opts.log ?? { info: () => undefined, warn: () => undefined, error: () => undefined };
    this.startedAt = this.now();
  }

  start(): void {
    if (this.timer !== null || this.stopped) return;
    try {
      this.histogram = monitorEventLoopDelay({ resolution: 20 });
      this.histogram.enable();
    } catch {
      this.histogram = null;
    }
    if (this.opts.captureRejections) {
      this.onRejection = (reason) => {
        this.rejections.count++;
        this.rejections.last = reason instanceof Error ? reason.message : String(reason);
        this.log.error(`unhandled promise rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
      };
      process.on('unhandledRejection', this.onRejection);
    }
    this.timer = this.timers.setInterval(() => void this.run(), this.intervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
    this.histogram?.disable();
    if (this.onRejection) process.off('unhandledRejection', this.onRejection);
    this.onRejection = null;
  }

  /** One round of checks (the "Run health check" button awaits it); concurrent calls share one round. */
  run(): Promise<WatchdogCheck[]> {
    if (!this.running) {
      this.running = this.runChecks().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  status(): WatchdogStatus {
    const m = this.memory();
    const failed = this.checks.some((c) => c.result === 'fail');
    // 'fixed' means a repair was just attempted: DEGRADED until a later round finds it ok.
    const warned = this.checks.some((c) => c.result === 'warn' || c.result === 'fixed');
    return {
      state: this.lastRunAt === null ? 'STARTING' : failed ? 'CRITICAL' : warned ? 'DEGRADED' : 'HEALTHY',
      intervalMs: this.intervalMs,
      lastRunAt: this.lastRunAt,
      runs: this.runs,
      supervised: this.supervised,
      process: {
        pid: process.pid,
        uptimeSec: Math.round((this.now() - this.startedAt) / 1000),
        rssMb: Math.round(m.rss / MB),
        heapUsedMb: Math.round(m.heapUsed / MB),
        heapLimitMb: Math.round(m.heapLimit / MB),
        eventLoopP99Ms: this.lastP99Ms,
      },
      checks: this.checks.map((c) => ({ ...c })),
      incidents: this.journal.list({ source: 'watchdog', minLevel: 'warn', limit: 20 }),
    };
  }

  /* ---------------------------------- checks ---------------------------------- */

  private async runChecks(): Promise<WatchdogCheck[]> {
    const out: WatchdogCheck[] = [];
    const steps: Array<[string, string, () => WatchdogCheck | Promise<WatchdogCheck>]> = [
      ['memory', 'Memory', () => this.checkMemory()],
      ['event-loop', 'Responsiveness', () => this.checkEventLoop()],
      ['errors', 'Unhandled errors', () => this.checkRejections()],
      ['login', 'Broker login', () => this.checkLogin()],
      ['feed', 'Market feed', () => this.checkFeed()],
      ['instruments', 'Instrument master', () => this.checkRefdata()],
      ['jobs', 'Background jobs', () => this.checkJobs()],
      ['eod', 'End-of-day files', () => this.checkEod()],
      ['storage', 'Disk and storage', () => this.checkStorage()],
    ];
    for (const [id, title, fn] of steps) {
      let c: WatchdogCheck;
      try {
        c = await fn();
      } catch (e) {
        // A failing check is itself a finding; the other checks still run.
        c = { id, title, result: 'fail', detail: `check failed: ${e instanceof Error ? e.message : String(e)}` };
      }
      out.push(c);
      this.record(c);
    }
    this.checks = out;
    this.lastRunAt = this.now();
    this.runs++;
    return out;
  }

  private memory(): { rss: number; heapUsed: number; heapLimit: number } {
    if (this.opts.memory) return this.opts.memory();
    const m = process.memoryUsage();
    return { rss: m.rss, heapUsed: m.heapUsed, heapLimit: v8.getHeapStatistics().heap_size_limit };
  }

  private checkMemory(): WatchdogCheck {
    const base = { id: 'memory', title: 'Memory' };
    const m = this.memory();
    const pct = (x: { heapUsed: number; heapLimit: number }) => Math.round((100 * x.heapUsed) / x.heapLimit);
    const before = pct(m);
    if (before < 75) {
      this.memoryStrikes = 0;
      return { ...base, result: 'ok', detail: `heap ${Math.round(m.heapUsed / MB)} MB of ${Math.round(m.heapLimit / MB)} MB (${before}%), RSS ${Math.round(m.rss / MB)} MB` };
    }
    // Dropped answers free memory only at the next garbage collection: the effect is judged at the next round.
    const dropped = this.target.clearCaches({ all: before >= 85 });
    const freed = `dropped ${dropped} cached answers (re-fetched on demand); checked again at the next round`;
    if (before < 90) {
      this.memoryStrikes = 0;
      return { ...base, result: 'warn', detail: `heap at ${before}% of its limit`, action: freed };
    }
    this.memoryStrikes++;
    const restart = this.restartIfSupervised(this.memoryStrikes >= 3, `heap above 90% for ${this.memoryStrikes} checks`);
    return { ...base, result: 'fail', detail: `heap at ${before}% of its limit (${this.memoryStrikes} check(s) in a row)`, action: restart ? `${freed}; ${restart}` : freed };
  }

  private checkEventLoop(): WatchdogCheck {
    const base = { id: 'event-loop', title: 'Responsiveness' };
    if (!this.histogram) return { ...base, result: 'skipped', detail: 'event-loop monitor unavailable' };
    const p99 = Math.round(this.histogram.percentile(99) / 1e6);
    this.histogram.reset();
    this.lastP99Ms = p99;
    if (p99 < 1000) {
      this.lagStrikes = 0;
      return { ...base, result: 'ok', detail: `99% of event-loop delays under ${p99} ms` };
    }
    // The first minutes load the instrument master and the EOD backfill (large CSVs parsed in one
    // go): a long pause then is expected once, not a hang. Report it, never count it towards a restart.
    if (this.now() - this.startedAt < STARTUP_GRACE_MS) {
      return { ...base, result: 'warn', detail: `event loop delayed up to ${p99} ms during start-up (loading the instrument master and EOD files)` };
    }
    this.lagStrikes++;
    if (p99 < 5000) return { ...base, result: 'warn', detail: `event loop delayed up to ${p99} ms (requests answer slowly)` };
    const action = this.restartIfSupervised(this.lagStrikes >= 3, `event loop blocked ${p99} ms for ${this.lagStrikes} checks`);
    return { ...base, result: 'fail', detail: `event loop blocked up to ${p99} ms`, ...(action ? { action } : {}) };
  }

  private checkRejections(): WatchdogCheck {
    const base = { id: 'errors', title: 'Unhandled errors' };
    if (!this.opts.captureRejections) return { ...base, result: 'skipped', detail: 'not captured in this process' };
    const n = this.rejections.count;
    this.rejections = { count: 0 };
    if (!n) return { ...base, result: 'ok', detail: 'none since the last check' };
    return { ...base, result: 'warn', detail: `${n} unhandled promise rejection${n > 1 ? 's' : ''} since the last check (logged with stack); the server kept running` };
  }

  private checkLogin(): WatchdogCheck {
    const base = { id: 'login', title: 'Broker login' };
    const s = this.target.login();
    switch (s.state) {
      case 'LOGGED_IN':
        return { ...base, result: 'ok', detail: s.detail };
      case 'NO_CREDENTIALS':
        return { ...base, result: 'warn', detail: s.detail };
      case 'PAUSED':
        // Needs a person: retrying wrong credentials automatically could lock the account. While the
        // current session is still valid it is a warning (data still flows until the token runs out).
        return { ...base, result: s.sessionValid ? 'warn' : 'fail', detail: s.detail };
      case 'DISCONNECTED':
        this.target.checkLogin();
        return { ...base, result: 'fixed', detail: 'not logged in and no login armed', action: 'login monitor armed a login' };
      default:
        // Stable text (the login monitor reports each attempt): one journal line per cause, not per attempt.
        return { ...base, result: 'warn', detail: `not logged in; the login monitor is retrying${s.lastFailure ? ` (last problem: ${s.lastFailure.reason})` : ''}` };
    }
  }

  private async checkFeed(): Promise<WatchdogCheck> {
    const base = { id: 'feed', title: 'Market feed' };
    const f = this.target.feed();
    const t = this.now();
    if (!f.loggedIn) {
      this.feedDownSince = null;
      return { ...base, result: 'skipped', detail: 'DATA UNAVAILABLE: needs a Kotak login first' };
    }
    const open = this.target.marketStatus() === 'open';
    if (!f.connected) {
      this.feedDownSince ??= t;
      const down = t - this.feedDownSince;
      if (!open) return { ...base, result: 'warn', detail: `DISCONNECTED (market ${this.target.marketStatus()}): ${f.error ?? 'socket not connected'}` };
      if (down < FEED_DOWN_MS) return { ...base, result: 'warn', detail: `DISCONNECTED for ${Math.round(down / 1000)} s: ${f.error ?? 'reconnecting'}` };
      return this.restartFeed(base, `socket down for ${Math.round(down / 60_000)} min during market hours`);
    }
    this.feedDownSince = null;
    if (!open) return { ...base, result: 'ok', detail: `connected, ${f.subscribed} subscribed (market ${this.target.marketStatus()}: no ticks expected)` };
    if (f.subscribed === 0) return { ...base, result: 'warn', detail: 'connected but nothing subscribed (instrument master not loaded?)' };
    const age = f.lastTickTs === null ? Infinity : t - f.lastTickTs;
    if (age <= FEED_STALE_MS) return { ...base, result: 'ok', detail: `LIVE: ${f.subscribed} subscribed, last tick ${Math.round(age / 1000)} s ago` };
    if (age <= FEED_RESTART_AFTER_MS) return { ...base, result: 'warn', detail: `FEED STALE: no tick for ${Math.round(age / 1000)} s (the socket is restarted after ${FEED_RESTART_AFTER_MS / 1000} s)` };
    return this.restartFeed(base, `FEED STALE: no tick for ${age === Infinity ? 'the whole connection' : `${Math.round(age / 1000)} s`} during market hours`);
  }

  private async restartFeed(base: { id: string; title: string }, why: string): Promise<WatchdogCheck> {
    const t = this.now();
    if (t - this.lastFeedRestart < FEED_RESTART_COOLDOWN_MS) {
      return { ...base, result: 'fail', detail: why, action: `feed restarted ${Math.round((t - this.lastFeedRestart) / 1000)} s ago; next restart not before ${Math.ceil((this.lastFeedRestart + FEED_RESTART_COOLDOWN_MS - t) / 1000)} s` };
    }
    this.lastFeedRestart = t;
    const ok = await this.target.restartFeed(`watchdog: ${why}`);
    this.feedDownSince = null;
    return ok ? { ...base, result: 'fixed', detail: why, action: 'market-data socket restarted with the current session' } : { ...base, result: 'fail', detail: why, action: 'feed could not be restarted (no session or feed on hold)' };
  }

  private async checkRefdata(): Promise<WatchdogCheck> {
    const base = { id: 'instruments', title: 'Instrument master' };
    const r = this.target.refdata();
    const p = istParts(this.now());
    const current = r.ready && r.date === p.date;
    if (current) return { ...base, result: 'ok', detail: `loaded for ${r.date} (${r.underlyings} underlyings, ${r.listings} listings)` };
    if (r.ready && p.minuteOfDay < REFDATA_DUE_MIN) return { ...base, result: 'ok', detail: `loaded for ${r.date}; today's is due at 08:45 IST` };
    const was = r.ready ? `loaded for ${r.date}, not today` : `not loaded${r.error ? ` (${r.error})` : ''}`;
    if (!this.target.login().sessionValid) {
      // A consequence of the login problem (reported by the login check), not a failure of its own.
      return { ...base, result: 'warn', detail: `${was}; needs a Kotak login to download` };
    }
    const job = this.target.jobs().refdata;
    if (job?.running) return { ...base, result: 'warn', detail: `${was}; download in progress` };
    if (this.now() - this.lastRefdataTry < REFDATA_RETRY_MS) {
      return job?.lastError
        ? { ...base, result: 'fail', detail: `${was}; the last download failed: ${job.lastError}`, action: 'the provider keeps retrying with back-off' }
        : { ...base, result: 'warn', detail: `${was}; download started recently` };
    }
    // Started, not awaited: a download can take minutes and must not hold up the other checks.
    this.lastRefdataTry = this.now();
    void this.target.refreshInstrumentMaster().catch(() => undefined);
    return { ...base, result: 'warn', detail: was, action: 'download started; checked again at the next round' };
  }

  private checkJobs(): WatchdogCheck {
    const base = { id: 'jobs', title: 'Background jobs' };
    // Login jobs are the login monitor's (its own check above); the others are reported here.
    const bad = Object.entries(this.target.jobs()).filter(([n, j]) => n !== 'login' && n !== 'relogin' && j.attempts >= 3 && j.lastError);
    if (!bad.length) return { ...base, result: 'ok', detail: 'no job failing repeatedly' };
    const list = bad.map(([n, j]) => `${n}: ${j.attempts} failed attempts (${j.lastError})${j.nextAt ? `, next ${istWhen(j.nextAt, this.now())}` : ''}`);
    return { ...base, result: 'warn', detail: list.join('; ') };
  }

  private checkEod(): WatchdogCheck {
    const base = { id: 'eod', title: 'End-of-day files' };
    const e = this.target.eod();
    if (!e) return { ...base, result: 'skipped', detail: 'EOD jobs not running' };
    if (e.backfill.stoppedOffline) return { ...base, result: 'warn', detail: `NSE/BSE unreachable (${e.backfill.stoppedOffline}); backfill retries on schedule` };
    if (e.backfill.running) return { ...base, result: 'ok', detail: `backfill running (F&O ${e.kinds.fo ?? 'none yet'})` };
    if (e.backfill.datesMissing) return { ...base, result: 'warn', detail: `${e.backfill.datesMissing} session(s) still missing files after the last backfill` };
    if (!e.kinds.fo) return { ...base, result: 'warn', detail: 'no F&O end-of-day file loaded yet (history, OI and IV views stay blank)' };
    return { ...base, result: 'ok', detail: `F&O ${e.kinds.fo ?? 'none'}, cash ${e.kinds.cm ?? 'none'}, indices ${e.kinds.index ?? 'none'}` };
  }

  private checkStorage(): WatchdogCheck {
    const base = { id: 'storage', title: 'Disk and storage' };
    const dbErr = this.target.dbWriteError?.();
    if (dbErr) return { ...base, result: 'fail', detail: `db.json (users, paper trades) could not be written: ${dbErr}`, action: 'the write is retried; check DATA_DIR ownership and free space' };
    const dir = this.opts.dataDir;
    if (!dir) return { ...base, result: 'skipped', detail: 'persistence off (PERSIST=false)' };
    // Write probe every 10th run (and the first).
    if (this.runs - this.writeProbeRun >= 10 || this.writeProbeRun < 0) {
      this.writeProbeRun = this.runs;
      const probe = path.join(dir, `.watchdog-probe-${process.pid}`);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(probe, String(this.now()));
        fs.rmSync(probe, { force: true });
      } catch (e) {
        return { ...base, result: 'fail', detail: `DATA_DIR not writable: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    const free = (this.opts.freeDiskBytes ?? freeDisk)(dir);
    if (free === null) return { ...base, result: 'ok', detail: 'DATA_DIR writable (free space unknown)' };
    const gb = (free / (1024 * MB)).toFixed(1);
    if (free >= LOW_DISK_BYTES) return { ...base, result: 'ok', detail: `DATA_DIR writable, ${gb} GB free` };
    const removed = this.target.pruneJournal(JOURNAL_RETAIN_DAYS);
    const dropped = this.target.clearCaches({ all: false });
    const action = `removed ${removed} old journal file(s), dropped ${dropped} expired cached answers`;
    if (free < CRITICAL_DISK_BYTES) return { ...base, result: 'fail', detail: `only ${Math.round(free / MB)} MB free on DATA_DIR: recording will fail soon`, action };
    return { ...base, result: 'warn', detail: `${gb} GB free on DATA_DIR`, action };
  }

  /* ---------------------------------- helpers ---------------------------------- */

  private restartIfSupervised(due: boolean, why: string): string | undefined {
    if (!due) return undefined;
    if (!this.supervised || !this.opts.requestRestart) return 'restart needed: run the server with npm run start:supervised so the watchdog can restart it';
    if (this.opts.restartsSuppressed) return 'restart NOT requested: the supervisor saw a restart loop (3 watchdog restarts within an hour); a person must investigate';
    this.opts.requestRestart(why);
    return 'clean restart requested (supervisor starts the server again)';
  }

  /** Journal a check when its outcome changes, and every fix. */
  private record(c: WatchdogCheck): void {
    const key = `${c.result}|${c.result === 'ok' || c.result === 'skipped' ? '' : c.detail.replace(/\d+/g, '#')}`;
    const prev = this.lastResult.get(c.id);
    this.lastResult.set(c.id, key);
    if (c.result !== 'fixed' && prev === key) return;
    if (prev === undefined && (c.result === 'ok' || c.result === 'skipped')) return;
    const level: OpsEvent['level'] = c.result === 'fail' ? 'error' : c.result === 'warn' || c.result === 'fixed' ? 'warn' : 'info';
    const type = c.result === 'fixed' ? 'FIXED' : c.result === 'ok' ? 'RECOVERED' : c.result.toUpperCase();
    const msg = `${c.title}: ${c.detail}${c.action ? ` → ${c.action}` : ''}`;
    this.journal.add({ source: 'watchdog', level, type: `${c.id.toUpperCase()}_${type}`, message: msg });
    if (level === 'error') this.log.error(`watchdog: ${msg}`);
    else if (level === 'warn') this.log.warn(`watchdog: ${msg}`);
    else this.log.info(`watchdog: ${msg}`);
  }
}

function freeDisk(dir: string): number | null {
  try {
    const s = fs.statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
}
