/**
 * Live market-data provider (DESIGN.md §2 provider.ts): the Kotak session, REST, scrip master and
 * SFeed websocket, the NSE/BSE end-of-day jobs, the recorder and the stores, assembled into one
 * MarketDataProvider and kept running.
 *
 * start() never throws and never waits on the network: it schedules the work and returns. Missing
 * credentials are reported in health ("Kotak credentials missing in .env: <names>") and the parts
 * that do not need Kotak (EOD files, recorded history, a same-day cached instrument master) keep
 * working. Every failing step is recorded in healthReport() and retried with capped exponential
 * back-off, never sooner than the session's own login hold. Re-logins triggered by the feed are
 * capped per hour; a 'native_fallback' feed is treated as fatal for 30 min (logging in again does
 * not change the body layout).
 *
 * Work it keeps going: login and the proactive re-login (session.nextReloginAt), the instrument
 * master at start and daily at 08:45 IST, the SFeed connection (new session after each login), the
 * streaming universe (re-centred every minute), the recorder session (started in pre-open or on a
 * restart mid-session, ended after 15:30), the stock-option sweep, EOD backfill + daily schedule.
 * healthReport() is JSON-safe and carries no secrets.
 */
import { MARKET_CLOSE_MIN, istParts, sessionHoursOf } from '@q26/core';
import { ExchangeCalendar, isIsoDate } from './calendar';
import { LiveClock } from './clock';
import type { NeoEnv } from './env';
import { EodJobs, type EodStatus } from './eod';
import { RateLimiter } from './kotak/ratelimit';
import { KotakRest } from './kotak/rest';
import { DEFAULT_TOP10 } from '../config';
import { INDEX_SPECS, ScripMaster, type ScripMasterStatus } from './kotak/scripmaster';
import fs from 'node:fs';
import path from 'node:path';
import { KotakError, KotakSession, nextIstTime, type FetchLike, type KotakSessionStatus, type LoginStateStore, type SavedLoginState } from './kotak/session';
import { resolveFeedUrl, type SFeedAuthError, type SFeedSocketFactory } from './kotak/sfeed/client';
import { KotakLiveMarket, canonicalKey, isIndexSpot, type KotakLiveMarketOptions, type LiveMarketDetails, type SweepStatus } from './live-market';
import { NseHttp } from './nse/http';
import { LivePricing } from './pricing';
import { Recorder, type RecorderStats } from './recorder';
import { HistoryFiles } from './store/history';
import { RecordedDailyHistory } from './store/recorded-daily';
import { IntradayFiles } from './store/intraday';
import { SecondStore, type SecondStoreUsage } from './store/seconds';
import { SecondRecorder, type SecondRecorderStats } from './second-recorder';
import { NoLiveData } from './types';
import type { Candle, CandleInterval, FeedHealth, HistoryStore, InstrumentKey, IntradayStore, MarketDataProvider, TradingCalendar } from './types';
import { EXTRA_INDEX_SPOTS, LiveUniverse, type UserContract } from './universe';
import type { MarketClockInfo } from '@q26/core';
import { istWhen } from '../log';

/* ------------------------------------------------------------------------------------------ */
/* Options                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export interface LiveProviderConfig {
  dataDir: string;
  /** Risk-free rate for IV/Greeks (config input, not market data). */
  riskFreeRate: number;
  /** HOLIDAYS env list (merged with NSE's holiday master by the EOD jobs). */
  holidays: Iterable<string>;
  /** Full-day MCX closures (MCX_HOLIDAYS); weekends are always closed. */
  mcxHolidays?: Iterable<string>;
  /** Kotak credentials; null when missing/invalid (`neoError` says which variables). */
  neo: NeoEnv | null;
  neoError?: string;
  eodBackfillDays: number;
  sfeedTokenBudget: number;
  /** Recorded sessions kept on disk; unset = keep all. */
  intradayRetentionDays?: number;
  /** Record one-second snapshots (SecondStore) with these limits; unset = not recorded. */
  seconds?: { maxGb: number; retentionDays: number; /** SECONDS_DIR (default DATA_DIR/seconds). */ dir?: string };
  /**
   * The app's stocks (NIFTY_TOP10: the NIFTY top 10 by market cap): the only stocks listed, and their nearest
   * option chains are streamed after the index chains; unset = DEFAULT_TOP10.
   */
  focusStocks?: readonly string[];
}

export interface ProviderTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface ProviderLogger {
  debug?(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error?(msg: string): void;
}

export interface LiveProviderDeps {
  /** fetch for Kotak (login, REST, scrip-master downloads). */
  kotakFetch?: FetchLike;
  /** Where the login refusal count / hold / pause survives restarts (default DATA_DIR/ops/login-state.json). */
  loginStateStore?: LoginStateStore;
  /** fetch for NSE/BSE public files. */
  nseFetch?: FetchLike;
  /** SFeed socket factory (default: the `ws` package). */
  wsFactory?: SFeedSocketFactory;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timers?: ProviderTimers;
  logger?: ProviderLogger;
  /** Overrides of the live market's tunables (tests). */
  live?: Pick<KotakLiveMarketOptions, 'feedOptions' | 'streamFreshMs' | 'sweepSpacingMs' | 'sweepIdlePollMs' | 'adhocTtlMs' | 'chainStrikeCount'>;
}

export interface JobStatus {
  attempts: number;
  running: boolean;
  lastError?: string;
  lastOkAt?: number;
  nextAt?: number;
}

export interface LiveHealthReport {
  kotak: KotakSessionStatus;
  feed: FeedHealth & { details: LiveMarketDetails };
  refdata: ScripMasterStatus;
  recorder: RecorderStats & { firstRecordedSession: string | null; sessions: number };
  /** One-second store and recorder; absent when one-second recording is off. */
  seconds?: SecondStoreUsage & SecondRecorderStats;
  eod: EodStatus;
  sweep: SweepStatus;
  clock: MarketClockInfo;
  universe: { notes: string[]; centres: Record<string, number> };
  jobs: Record<string, JobStatus>;
  /** HOLIDAYS env entries that are not dates (ignored). */
  invalidHolidays?: string[];
}

/* ------------------------------------------------------------------------------------------ */
/* Candles (pure helpers, also used by the test-only FakeProvider)                              */
/* ------------------------------------------------------------------------------------------ */

export const INTERVAL_MINUTES: Record<Exclude<CandleInterval, 'D'>, number> = {
  '1min': 1,
  '3min': 3,
  '5min': 5,
  '10min': 10,
  '15min': 15,
  '30min': 30,
  '60min': 60,
};

/** A one-minute bar with real OHLC. */
export type MinuteCandle = Candle & { open: number; high: number; low: number };

/**
 * N-minute bars from real one-minute bars: buckets of N minutes from 09:15 IST, OHLC of the minutes
 * present (a bucket without any minute is not produced), volume summed over the minutes that report
 * one (absent when none does); gapVolume summed likewise, partial when any minute is.
 */
export function resampleMinutes(minutes: readonly MinuteCandle[], step: number, calendar: TradingCalendar): MinuteCandle[] {
  const sorted = [...minutes].sort((a, b) => a.ts - b.ts);
  const out: MinuteCandle[] = [];
  let cur: MinuteCandle | null = null;
  for (const m of sorted) {
    const s = calendar.session(m.ts);
    const ts = calendar.ts(s.date, Math.floor(Math.floor(s.minute) / step) * step);
    if (cur && cur.ts === ts) {
      cur.high = Math.max(cur.high, m.high);
      cur.low = Math.min(cur.low, m.low);
      cur.close = m.close;
      if (m.volume !== undefined) cur.volume = (cur.volume ?? 0) + m.volume;
      if (m.gapVolume !== undefined) cur.gapVolume = (cur.gapVolume ?? 0) + m.gapVolume;
      if (m.partial) cur.partial = true;
      continue;
    }
    if (cur) out.push(cur);
    cur = { ts, open: m.open, high: m.high, low: m.low, close: m.close };
    if (m.volume !== undefined) cur.volume = m.volume;
    if (m.gapVolume !== undefined) cur.gapVolume = m.gapVolume;
    if (m.partial) cur.partial = true;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Recorded one-minute bars of an instrument on the given dates: traded minutes only (quote-only
 * minutes carry no trade), plus today's minute in progress when it traded; each keeps its
 * gapVolume / partial labels. `missing` lists the
 * dates the recorder has nothing for.
 */
export function recordedMinutes(intraday: IntradayStore, key: InstrumentKey, dates: readonly string[], today: string): { minutes: MinuteCandle[]; missing: string[] } {
  const minutes: MinuteCandle[] = [];
  const missing: string[] = [];
  for (const d of dates) {
    const recs = intraday.bars(key, d).filter((r) => r.traded);
    if (d === today) {
      const lb = intraday.liveBar(key);
      if (lb?.traded && !recs.some((r) => r.ts === lb.ts)) recs.push(lb);
    }
    if (!recs.length) missing.push(d);
    for (const r of recs)
      minutes.push({
        ts: r.ts,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        ...(r.volume !== undefined ? { volume: r.volume } : {}),
        ...(r.gapVolume !== undefined ? { gapVolume: r.gapVolume } : {}),
        ...(r.partial ? { partial: true as const } : {}),
      });
  }
  return { minutes, missing };
}

/**
 * Daily candles from the official end-of-day store: spot/index OHLC (bars at 09:15 IST of the date);
 * contracts get their official close only (the store keeps no contract OHLC), and untraded rows
 * (volume 0, whose close NSE carries forward from the previous day) are left out.
 */
export function officialDailyCandles(history: HistoryStore, calendar: TradingCalendar, k: InstrumentKey, from: string, to: string): Candle[] {
  const ts = (date: string) => calendar.ts(date, 0);
  if (k.kind === 'SPOT') {
    const index = INDEX_SYMBOLS.has(k.symbol);
    const bars = history.dailyBars(k.symbol, from, to);
    if (!bars.length) throw new NoLiveData(`No official daily bars of ${k.symbol} loaded for ${from}..${to}`);
    // ind_close_all's volume is the constituents' shares, not the index's: left out for indices.
    return bars.map((b) => ({ ts: ts(b.date), open: b.open, high: b.high, low: b.low, close: b.close, ...(!index && b.volume !== undefined ? { volume: b.volume } : {}) }));
  }
  const out: Candle[] = [];
  if (k.kind === 'FUT') {
    for (const f of history.dailyFutures(k.symbol, from, to)) if (f.expiry === k.expiry && f.volume > 0) out.push({ ts: ts(f.date), close: f.close, volume: f.volume });
  } else {
    for (const d of history.loadedDates('fo')) {
      if (d < from || d > to) continue;
      const o = history.dailyOptions(k.symbol, d, k.expiry).find((r) => r.type === k.kind && r.strike === k.strike);
      if (o && o.volume > 0) out.push({ ts: ts(d), close: o.close, volume: o.volume });
    }
  }
  if (!out.length) throw new NoLiveData(`No official daily closes of ${describe(k)} for ${from}..${to}`);
  return out.sort((a, b) => a.ts - b.ts);
}

/* ------------------------------------------------------------------------------------------ */
/* Provider                                                                                     */
/* ------------------------------------------------------------------------------------------ */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
// The session's own login hold (60 s doubling to 30 min after a rejection, 5 s doubling to 1 min
// when Kotak did not answer) is the real back-off (notBefore); the job adds little on top of it.
const LOGIN_BACKOFF = { baseMs: 5 * SECOND, maxMs: MINUTE };
const REFDATA_BACKOFF = { baseMs: MINUTE, maxMs: 30 * MINUTE };
/** The login safety state in a small JSON file (atomic write; unreadable or missing: nothing saved). */
export function fileLoginStateStore(file: string): LoginStateStore {
  return {
    load: () => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8')) as SavedLoginState;
      } catch {
        return undefined;
      }
    },
    save: (state) => {
      if (!state) {
        fs.rmSync(file, { force: true });
        return;
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(tmp, file);
    },
  };
}

/** Daily instrument-master refresh (after the 08:30 proactive re-login, before pre-open). */
const REFDATA_DAILY_MIN = 8 * 60 + 45;
const MAX_FEED_RELOGINS_PER_HOUR = 6;
const FEED_FALLBACK_HOLD_MS = 30 * MINUTE;
const INDEX_SYMBOLS = new Set([...INDEX_SPECS.map((s) => s.symbol), ...EXTRA_INDEX_SPOTS]);

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

const realTimers: ProviderTimers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    h.unref?.();
    return h;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

interface Job extends JobStatus {
  timer: unknown;
}

interface JobSpec {
  baseMs: number;
  maxMs: number;
  /** Earliest retry time imposed by someone else (the session's login hold). */
  notBefore?: () => number | undefined;
  /** Do not retry after a failure (e.g. no credentials: nothing changes until a restart). */
  once?: boolean;
  /** The failure is already logged by the job itself (no second line). */
  quiet?: boolean;
}

export class LiveProvider implements MarketDataProvider {
  readonly ref: ScripMaster;
  readonly calendar: ExchangeCalendar;
  /** MCX sessions (09:00–23:30/23:55 IST) for the commodities. */
  readonly mcxCalendar: ExchangeCalendar;
  readonly clock: LiveClock;
  readonly live: KotakLiveMarket;
  readonly intraday: IntradayFiles;
  /** Official NSE/BSE end-of-day files (written by the EOD jobs). */
  readonly eodFiles: HistoryFiles;
  /** What the services read: the official files, and MCX commodities' rows from recorded ticks. */
  readonly history: RecordedDailyHistory;
  readonly pricing: LivePricing;
  readonly recorder: Recorder;
  /** One-second snapshots (null when not recorded). */
  readonly secondStore: SecondStore | null;
  readonly secondRecorder: SecondRecorder | null;
  readonly eod: EodJobs;
  readonly universe: LiveUniverse;
  /** Null without credentials. */
  readonly session: KotakSession | null;
  readonly rest: KotakRest | null;

  private readonly now: () => number;
  private readonly timers: ProviderTimers;
  private readonly log: ProviderLogger;
  private readonly kotakError: string | undefined;
  private readonly invalidHolidays: string[];
  private readonly jobs = new Map<string, Job>();
  private readonly histCache = new Map<string, { at: number; candles: MinuteCandle[] }>();
  private readonly trackedChains = new Set<string>();
  private intervals: unknown[] = [];
  private started = false;
  private stopped = false;
  private boot: Promise<void> = Promise.resolve();
  /** The instrument-master attempt started by the last login (part of whenStarted()). */
  private refdataAttempt: Promise<void> = Promise.resolve();
  private feedGeneration = -1;
  private feedRelogins: number[] = [];
  private feedHeld: string | undefined;
  private feedFatalUntil = 0;
  private universeNotes: string[] = [];
  private lastSpotRefresh = Number.NEGATIVE_INFINITY;
  private endedSession: string | null = null;

  constructor(
    private readonly config: LiveProviderConfig,
    deps: LiveProviderDeps = {},
  ) {
    this.now = deps.now ?? Date.now;
    this.timers = deps.timers ?? realTimers;
    this.log = deps.logger ?? { info: () => {}, warn: () => {} };
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => this.timers.setTimeout(r, ms)));

    const holidays = [...config.holidays].map((d) => d.trim()).filter(Boolean);
    this.invalidHolidays = holidays.filter((d) => !isIsoDate(d));
    const envHolidays = holidays.filter(isIsoDate);
    this.calendar = new ExchangeCalendar(envHolidays);
    const mcxHol = [...(config.mcxHolidays ?? [])].map((d) => d.trim()).filter(Boolean);
    this.invalidHolidays.push(...mcxHol.filter((d) => !isIsoDate(d)));
    this.mcxCalendar = new ExchangeCalendar(mcxHol.filter(isIsoDate), 'MCX');
    this.clock = new LiveClock(this.calendar, this.now, {
      calendar: this.mcxCalendar,
      hasMcx: () => {
        try {
          return this.ref.ready() && this.ref.underlyings().some((u) => u.exchange === 'MCX');
        } catch {
          return false;
        }
      },
    });
    this.intraday = new IntradayFiles({ dataDir: config.dataDir, retentionDays: config.intradayRetentionDays });
    this.eodFiles = new HistoryFiles({ dataDir: config.dataDir, r: config.riskFreeRate });

    if (config.neo) {
      const limiter = new RateLimiter({ timers: { now: this.now, setTimeout: this.timers.setTimeout, clearTimeout: this.timers.clearTimeout } });
      this.session = new KotakSession(config.neo, {
        fetch: deps.kotakFetch,
        now: this.now,
        sleep,
        limiter,
        logger: this.log,
        loginStateStore: this.guardedStore(deps.loginStateStore ?? fileLoginStateStore(path.join(config.dataDir, 'ops', 'login-state.json'))),
      });
      this.rest = new KotakRest(this.session);
    } else {
      this.session = null;
      this.rest = null;
      this.kotakError = config.neoError ?? 'Kotak credentials missing in .env';
    }
    const rest = this.rest;
    const kotakError = this.kotakError;

    // The app's stocks: only the NIFTY top 10 by market cap (NIFTY_TOP10); indices and MCX commodities are not affected.
    const stocks = config.focusStocks?.length ? config.focusStocks : [...DEFAULT_TOP10];
    this.ref = new ScripMaster({
      dataDir: config.dataDir,
      stocks,
      fetch: deps.kotakFetch,
      logger: this.log,
      filePaths: async () => {
        if (!rest) throw new NoLiveData(kotakError ?? 'Kotak credentials missing');
        return (await rest.scripMasterPaths()).files;
      },
    });

    this.intraday.setRef(this.ref);
    this.history = new RecordedDailyHistory({
      base: this.eodFiles,
      intraday: this.intraday,
      isRecorded: (symbol) => this.calendarOf(symbol) === this.mcxCalendar,
      calendar: this.mcxCalendar,
      r: config.riskFreeRate,
      today: () => this.calendar.session(this.now()).date,
    });

    this.live = new KotakLiveMarket({
      ...deps.live,
      ref: this.ref,
      rest,
      restUnavailable: kotakError,
      calendar: this.calendar,
      calendarOf: (symbol) => this.calendarOf(symbol),
      now: this.now,
      timers: this.timers,
      logger: this.log,
      sessionStatus: () => (this.session ? this.session.status() : { loggedIn: false, error: kotakError }),
      wsFactory: deps.wsFactory,
      tokenBudget: config.sfeedTokenBudget,
      onFeedAuthError: (e) => this.onFeedAuthError(e),
    });

    this.pricing = new LivePricing({ r: config.riskFreeRate, ref: this.ref, calendar: this.calendar, calendarOf: (symbol) => this.calendarOf(symbol), getQuote: (k) => this.live.quote(k), now: this.now });

    this.recorder = new Recorder({
      live: this.live,
      writer: this.intraday,
      pricing: this.pricing,
      calendar: this.calendar,
      calendarOf: (symbol) => this.calendarOf(symbol),
      clock: this.clock,
      ref: this.ref,
      timers: { setInterval: this.timers.setInterval, clearInterval: this.timers.clearInterval },
      onError: (e) => this.log.warn(`live: recorder write failed: ${errMsg(e)}`),
    });

    if (config.seconds) {
      this.secondStore = new SecondStore({ dataDir: config.dataDir, ...(config.seconds.dir ? { dir: config.seconds.dir } : {}), maxBytes: config.seconds.maxGb * 1024 ** 3, retentionDays: config.seconds.retentionDays, logger: this.log });
      this.secondRecorder = new SecondRecorder({
        live: this.live,
        store: this.secondStore,
        clock: this.clock,
        calendarOf: (symbol) => this.calendarOf(symbol),
        calendars: [this.calendar, this.mcxCalendar],
        timers: { setInterval: this.timers.setInterval, clearInterval: this.timers.clearInterval },
        onError: (e) => this.log.warn(`live: 1-second recorder failed: ${errMsg(e)}`),
      });
    } else {
      this.secondStore = null;
      this.secondRecorder = null;
    }

    const http = new NseHttp({ fetch: deps.nseFetch, now: this.now, sleep, logger: this.log });
    this.eod = new EodJobs({
      http,
      history: this.eodFiles,
      calendar: this.calendar,
      now: this.now,
      timers: this.timers,
      logger: this.log,
      envHolidays,
      backfillDays: config.eodBackfillDays,
      symbols: [...INDEX_SPECS.map((s) => s.symbol), ...stocks],
    });

    this.universe = new LiveUniverse({
      ref: this.ref,
      priceOf: (symbol) => {
        const spot = this.live.quote({ symbol, kind: 'SPOT' })?.ltp;
        if (spot !== undefined) return spot;
        try {
          const near = this.ref.expiries(symbol, 'FUT')[0];
          return near ? this.live.quote({ symbol, kind: 'FUT', expiry: near })?.ltp : undefined;
        } catch {
          return undefined;
        }
      },
      // The NIFTY heavyweights desk: their option chains are streamed too (after the index chains).
      options: { focusStocks: stocks },
    });

    this.session?.onChange((st) => {
      if (this.stopped || !st.loggedIn) return;
      const c = this.session!.feedCredentials();
      if (c && c.generation !== this.feedGeneration) {
        this.startOrUpdateFeed();
        this.scheduleRelogin();
      }
    });
  }

  /* ---------------------------------- lifecycle ---------------------------------- */

  /** Starts everything in the background; never throws, never waits on the network. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    try {
      this.recorder.start();
      this.intraday.setLiveSource(this.recorder);
      if (this.secondRecorder) {
        this.secondRecorder.start();
        this.secondsMaintenance();
        this.intervals.push(this.timers.setInterval(() => this.secondsMaintenance(), 10 * MINUTE));
      }
      this.sessionTick();
      this.intervals.push(this.timers.setInterval(() => this.sessionTick(), 30 * SECOND));
      this.intervals.push(this.timers.setInterval(() => this.minuteTick(), MINUTE));
      this.eod.start();
    } catch (e) {
      this.log.warn(`live: start failed: ${errMsg(e)}`);
    }
    this.boot = this.bootKotak().catch((e) => this.log.warn(`live: boot failed: ${errMsg(e)}`));
  }

  /** One-second store upkeep (every 10 min): free space by deleting the oldest days, disk check, gzip of finished days, size / age limits. */
  private secondsMaintenance(): void {
    const store = this.secondStore;
    if (!store || this.stopped) return;
    try {
      const today = this.calendar.session(this.now()).date;
      store.prune(today);
      store.checkDisk();
      store
        .compact(today)
        .then(() => {
          if (!this.stopped) store.prune(today);
        })
        .catch((e) => this.log.warn(`live: 1-second store upkeep failed: ${errMsg(e)}`));
    } catch (e) {
      this.log.warn(`live: 1-second store upkeep failed: ${errMsg(e)}`);
    }
  }

  /** One-second data reader for backtests (undefined when not recorded). */
  get seconds(): SecondStore | undefined {
    return this.secondStore ?? undefined;
  }

  /** Resolves once the first login → instrument master → universe attempt has finished (tests, logs). */
  whenStarted(): Promise<void> {
    return this.boot;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    for (const h of this.intervals) this.timers.clearInterval(h);
    this.intervals = [];
    for (const j of this.jobs.values()) {
      if (j.timer !== null) this.timers.clearTimeout(j.timer);
      j.timer = null;
      j.nextAt = undefined;
    }
    this.eod.stop();
    this.live.stopSweep();
    this.session?.limiter.abort('live data provider stopped');
    try {
      this.recorder.stop(); // writes the minutes in progress
    } catch (e) {
      this.log.warn(`live: recorder stop failed: ${errMsg(e)}`);
    }
    try {
      this.secondRecorder?.stop(); // writes the buffered seconds
    } catch (e) {
      this.log.warn(`live: 1-second recorder stop failed: ${errMsg(e)}`);
    }
    this.intraday.setLiveSource(null);
    await this.live.close();
  }

  /** No writes after stop(): a login attempt that finishes during shutdown must not touch DATA_DIR. */
  private guardedStore(store: LoginStateStore): LoginStateStore {
    return { load: () => store.load(), save: (s) => (this.stopped ? undefined : store.save(s)) };
  }

  /** Phase C hook: contracts the user holds or watches (streamed in the 'user' tier). */
  setUserContracts(fn: (() => Iterable<UserContract>) | null): void {
    this.universe.setUserContracts(fn);
    void this.updateUniverse();
  }

  private async bootKotak(): Promise<void> {
    if (!this.session) {
      this.log.warn(`live: ${this.kotakError}; streaming and REST are off`);
      // A same-day cached instrument master loads without Kotak (no network).
      // The instrument master logs its own failure ("Instrument master refresh … failed").
      await this.execJob('refdata', () => this.refreshRefdata(), { ...REFDATA_BACKOFF, once: true, quiet: true });
      return;
    }
    await this.execJob('login', () => this.login(), { ...LOGIN_BACKOFF, notBefore: () => this.session?.status().loginBlockedUntil });
    await this.refdataAttempt;
  }

  private async login(force = false, fresh = false): Promise<void> {
    // An attempt armed for later (the end of a login hold, a back-off) may find the session already
    // restored by a REST caller: logging in again would only replace a working session (unless the
    // operator asks for a fresh one because its re-logins keep failing).
    if (fresh || !this.session!.status().loggedIn) await this.session!.login({ force });
    this.startOrUpdateFeed();
    this.scheduleRelogin();
    // Its own job, not awaited: while the login job runs, another login request (a feed refusal) is
    // dropped, so the job must not last as long as the instrument-master download.
    if (!this.refdataCurrent()) this.refdataAttempt = this.execJob('refdata', () => this.refreshRefdata(), REFDATA_BACKOFF);
  }

  /* ---------------------------------- jobs ---------------------------------- */

  private job(name: string): Job {
    let j = this.jobs.get(name);
    if (!j) this.jobs.set(name, (j = { attempts: 0, running: false, timer: null }));
    return j;
  }

  /** Run `fn` at `at` (default now); a failure is retried with capped exponential back-off. */
  private runJob(name: string, fn: () => Promise<void>, spec: JobSpec, at = this.now()): void {
    if (this.stopped) return;
    const j = this.job(name);
    if (j.timer !== null) this.timers.clearTimeout(j.timer);
    j.nextAt = at;
    j.timer = this.timers.setTimeout(() => {
      j.timer = null;
      void this.execJob(name, fn, spec);
    }, Math.max(0, at - this.now()));
  }

  /**
   * One attempt now (resolves when it has finished; never rejects). A failure is retried with
   * `retry` when given (e.g. a forced login is retried as a normal one), else with `fn`.
   */
  private async execJob(name: string, fn: () => Promise<void>, spec: JobSpec, retry: () => Promise<void> = fn): Promise<void> {
    const j = this.job(name);
    if (this.stopped) return;
    if (j.running) return; // the attempt in flight covers this call (never two logins at once)
    if (j.timer !== null) this.timers.clearTimeout(j.timer);
    j.timer = null;
    j.nextAt = undefined;
    j.running = true;
    try {
      await fn();
      j.attempts = 0;
      j.lastError = undefined;
      j.lastOkAt = this.now();
    } catch (e) {
      j.attempts++;
      j.lastError = errMsg(e);
      if (spec.once || this.stopped) {
        if (!spec.quiet) this.log.warn(`live: ${name} failed: ${j.lastError}`);
        return;
      }
      let at = this.now() + Math.min(spec.maxMs, spec.baseMs * 2 ** (j.attempts - 1));
      if (e instanceof KotakError && e.retryAfterMs) at = Math.max(at, this.now() + e.retryAfterMs);
      const hold = spec.notBefore?.();
      if (hold !== undefined) at = Math.max(at, hold + SECOND);
      // A failed Kotak login is already logged by the session (with its next login time): one line, not two.
      if (!(e instanceof KotakError && e.kind === 'login')) this.log.warn(`live: ${name} failed (${j.lastError}); next attempt ${istWhen(at, this.now())}`);
      this.runJob(name, retry, spec, at);
    } finally {
      j.running = false;
    }
  }

  private jobPending(name: string): boolean {
    const j = this.jobs.get(name);
    return !!j && (j.running || j.timer !== null);
  }

  /* ---------------------------------- Kotak session and feed ---------------------------------- */

  private scheduleRelogin(): void {
    const at = this.session?.nextReloginAt();
    if (at == null) return;
    this.runJob(
      'relogin',
      async () => {
        // Not due (yet): the time moved (new token expiry); re-arm for the new time.
        if (!(await this.session!.refreshIfDue())) this.scheduleRelogin();
      },
      { ...LOGIN_BACKOFF, notBefore: () => this.session?.status().loginBlockedUntil },
      at,
    );
  }

  private startOrUpdateFeed(): void {
    const c = this.session?.feedCredentials();
    if (!c || this.stopped) return;
    if (this.now() < this.feedFatalUntil) return;
    if (c.generation === this.feedGeneration && this.live.hasFeed()) return;
    try {
      this.live.startFeed({ url: resolveFeedUrl({ feedUrl: c.feedUrl }).url, sid: c.sid, ucc: c.user });
      this.feedGeneration = c.generation;
    } catch (e) {
      this.log.warn(`live: SFeed start failed: ${errMsg(e)}`);
    }
  }

  private onFeedAuthError(err: SFeedAuthError): void {
    if (this.stopped || !this.session) return;
    if (err.kind === 'fallback') {
      // A different body layout: logging in again would not help. Stop the stream for a while.
      this.feedFatalUntil = this.now() + FEED_FALLBACK_HOLD_MS;
      const reason = `SFeed switched to native_fallback, which this client does not decode; stream stopped until ${istWhen(this.feedFatalUntil, this.now())}`;
      this.log.warn(`live: ${reason}`);
      void this.live.closeFeed(reason);
      this.feedGeneration = -1;
      this.runJob('feed', async () => this.startOrUpdateFeed(), { baseMs: FEED_FALLBACK_HOLD_MS, maxMs: FEED_FALLBACK_HOLD_MS }, this.feedFatalUntil + SECOND);
      return;
    }
    // Only a refusal of the session's current sid calls for a re-login (and counts against the cap):
    // while a re-login is pending the client keeps re-dialling with the old sid, and the login hands
    // it the new one (onChange → startOrUpdateFeed).
    const c = this.session.feedCredentials();
    if (!c) {
      this.ensureLogin();
      return;
    }
    if (c.generation !== this.feedGeneration) return this.startOrUpdateFeed();
    // Most likely an expired sid: one re-login, capped per hour (the session adds its own cooldown).
    const t = this.now();
    this.feedRelogins = this.feedRelogins.filter((x) => t - x < HOUR);
    if (this.feedRelogins.length >= MAX_FEED_RELOGINS_PER_HOUR) {
      this.feedHeld = `SFeed refused the session ${this.feedRelogins.length} times within an hour; no further re-login for it until ${istWhen(this.feedRelogins[0] + HOUR, this.now())}`;
      this.log.warn(`live: ${this.feedHeld}`);
      return;
    }
    this.feedHeld = undefined;
    this.feedRelogins.push(t);
    this.session.invalidate(`SFeed auth failed (${err.kind}): ${err.message}`);
    void this.execJob('login', () => this.login(), { ...LOGIN_BACKOFF, notBefore: () => this.session?.status().loginBlockedUntil });
  }

  /* ---------------------------------- reference data and universe ---------------------------------- */

  private istDate(): string {
    return this.calendar.session(this.now()).date;
  }

  private refdataCurrent(): boolean {
    return this.ref.ready() && this.ref.status().date === this.istDate();
  }

  private async refreshRefdata(): Promise<void> {
    await this.ref.refresh(this.istDate());
    this.scheduleDailyRefdata();
    await this.updateUniverse();
    if (this.rest) this.live.startSweep();
  }

  private scheduleDailyRefdata(): void {
    // Without credentials only a cached master can load: one attempt a day, no retries.
    this.runJob('refdata', () => this.refreshRefdata(), { ...REFDATA_BACKOFF, once: !this.session }, nextIstTime(this.now(), REFDATA_DAILY_MIN));
  }

  private async updateUniverse(): Promise<void> {
    if (this.stopped || !this.ref.ready()) return;
    try {
      // Centre the index chains on a real price: one REST call when the stream has none yet.
      const spots: InstrumentKey[] = this.ref
        .underlyings()
        .filter((u) => u.kind === 'index')
        .map((u) => ({ symbol: u.symbol, kind: 'SPOT' as const }))
        .filter((k) => !this.live.quote(k));
      if (spots.length && this.rest && this.now() - this.lastSpotRefresh > MINUTE) {
        this.lastSpotRefresh = this.now();
        await this.live.refresh(spots).catch((e) => this.log.warn(`live: index spot quotes: ${errMsg(e)}`));
      }
      const u = this.universe.update();
      this.universeNotes = u.notes;
      this.live.setPinned(u.entries);
      for (const c of u.chains) {
        const id = `${c.symbol}|${c.expiry}`;
        if (this.trackedChains.has(id)) continue;
        this.trackedChains.add(id);
        this.recorder.trackChain(c.symbol, c.expiry);
      }
    } catch (e) {
      this.universeNotes = [`universe update failed: ${errMsg(e)}`];
      this.log.warn(`live: universe update failed: ${errMsg(e)}`);
    }
  }

  /** Every minute: re-centre the universe; log in again when the session was lost and nothing is pending. */
  private minuteTick(): void {
    if (this.stopped) return;
    void this.updateUniverse();
    this.ensureLogin();
  }

  /**
   * A login at the end of any login hold when the session is lost and no login is pending. The
   * proactive re-login only counts while it runs: its timer (next 08:30 IST) is nearly always set.
   * Returns whether it armed a login (the login monitor calls it every few seconds).
   */
  ensureLogin(): boolean {
    const s = this.session;
    if (this.stopped || !s || s.status().loggedIn || this.jobPending('login') || this.jobs.get('relogin')?.running) return false;
    const hold = s.status().loginBlockedUntil;
    this.runJob('login', () => this.login(), { ...LOGIN_BACKOFF, notBefore: () => this.session?.status().loginBlockedUntil }, Math.max(this.now(), (hold ?? 0) + SECOND));
    return true;
  }

  /* ---------------------------------- operations (login monitor, watchdog, audit) ---------------------------------- */

  /** Kotak credentials are configured (a session exists); otherwise the reason (variable names only). */
  credentials(): { ok: true } | { ok: false; error: string } {
    return this.session ? { ok: true } : { ok: false, error: this.kotakError ?? 'Kotak credentials missing' };
  }

  /** A login attempt is running or armed. */
  loginPending(): boolean {
    return this.jobPending('login') || !!this.jobs.get('relogin')?.running;
  }

  /**
   * Log in now (operator "Re-login now"). `force` skips the failure back-off, never a 429 hold nor
   * the hold after repeated session rejections (the session enforces both). Resolves once the
   * attempt has finished; rejects with its error. A login already running is not doubled.
   */
  async loginNow(opts: { force?: boolean; fresh?: boolean } = {}): Promise<'logged-in' | 'already-logged-in' | 'in-progress'> {
    const s = this.session;
    if (!s) throw new KotakError(this.kotakError ?? 'Kotak credentials missing', 'login');
    if (s.status().loggedIn && !opts.fresh) return 'already-logged-in';
    if (this.jobs.get('login')?.running || this.jobs.get('relogin')?.running) return 'in-progress';
    const before = s.status().loggedInAt;
    // Only this attempt is forced: its retries are normal logins (they respect the back-off and the pause).
    await this.execJob('login', () => this.login(opts.force, opts.fresh), { ...LOGIN_BACKOFF, notBefore: () => this.session?.status().loginBlockedUntil }, () => this.login());
    const after = s.status();
    if (!after.loggedIn || (opts.fresh && after.loggedInAt === before)) {
      throw new KotakError(this.jobs.get('login')?.lastError ?? after.loginFailures?.lastError ?? after.error ?? 'Kotak login failed', 'login');
    }
    return 'logged-in';
  }

  /** Re-arm the proactive re-login when it is missing (it is normally always armed while logged in). */
  ensureRelogin(): boolean {
    if (this.stopped || !this.session?.status().loggedIn || this.jobPending('relogin')) return false;
    this.scheduleRelogin();
    return this.jobPending('relogin');
  }

  /** Called with the session status after every login attempt, logout and invalidation. */
  onLoginChange(fn: (s: KotakSessionStatus) => void): () => void {
    return this.session ? this.session.onChange(fn) : () => undefined;
  }

  /**
   * Drop the market-data websocket and dial a new one with the current session (the watchdog's fix
   * for a feed that stopped delivering). False when there is no session or the feed is held.
   */
  async restartFeed(reason: string): Promise<boolean> {
    const c = this.session?.feedCredentials();
    if (this.stopped || !c || this.now() < this.feedFatalUntil) return false;
    await this.live.closeFeed();
    this.feedGeneration = -1;
    this.startOrUpdateFeed();
    this.log.warn(`live: SFeed restarted (${reason})`);
    return this.live.hasFeed();
  }

  /** Drop cached REST answers (re-fetched on demand): expired ones, or all of them. Returns entries dropped. */
  clearCaches(opts: { all?: boolean } = {}): number {
    let n = 0;
    const t = this.now();
    for (const [id, hit] of this.histCache) {
      if (opts.all || t - hit.at > 6 * HOUR) {
        this.histCache.delete(id);
        n++;
      }
    }
    return n + this.live.pruneChains(opts.all ? 0 : undefined);
  }

  /** Load the instrument master again now (the daily job at 08:45 IST normally does it). */
  refreshInstrumentMaster(): Promise<void> {
    return this.execJob('refdata', () => this.refreshRefdata(), REFDATA_BACKOFF);
  }

  /** Background jobs (login, relogin, refdata …): attempts, last error, last success, next attempt. */
  jobStatuses(): Record<string, JobStatus> {
    return this.healthReport().jobs;
  }

  /** Calendar of the exchange `symbol` trades on: MCX for commodities, else the NSE/BSE calendar. */
  calendarOf(symbol: string): ExchangeCalendar {
    if (!this.ref.ready()) return this.calendar;
    try {
      return this.ref.underlying(symbol).exchange === 'MCX' ? this.mcxCalendar : this.calendar;
    } catch {
      return this.calendar;
    }
  }

  /**
   * Recorder session: started from the first pre-open of the day (NSE/BSE 09:00, MCX 08:45; at once
   * after a restart mid-session), ended once every exchange has closed (MCX 23:30/23:55).
   */
  private sessionTick(): void {
    if (this.stopped) return;
    const now = this.now();
    const s = this.calendar.session(now);
    const m = this.mcxCalendar.session(now);
    const active = this.recorder.stats().date;
    const live = (cal: ExchangeCalendar, x: typeof s) => cal.isTradingDay(x.date) && (x.status === 'pre-open' || x.status === 'open');
    const mcxListed = this.ref.ready() && this.ref.underlyings().some((u) => u.exchange === 'MCX');
    const lastClose = Math.max(MARKET_CLOSE_MIN, mcxListed ? sessionHoursOf('MCX', s.date).close : 0);
    try {
      if (live(this.calendar, s) || (mcxListed && live(this.mcxCalendar, m))) {
        if (active !== s.date) this.recorder.startSession(s.date);
        this.endedSession = null;
      } else if (active !== null && this.endedSession !== active && (active !== s.date || istParts(now).minuteOfDay >= lastClose)) {
        this.endedSession = active;
        this.recorder.endSession();
      }
    } catch (e) {
      this.log.warn(`live: recorder session change failed: ${errMsg(e)}`);
    }
  }

  /* ---------------------------------- candles ---------------------------------- */

  async candles(key: InstrumentKey, interval: CandleInterval, from: string, to: string): Promise<Candle[]> {
    if (!isIsoDate(from) || !isIsoDate(to) || from > to) throw badRequest(`Invalid date range ${from}..${to}`);
    const asked = canonicalKey(key);
    if (asked.kind !== 'SPOT' && !asked.expiry) throw badRequest(`${asked.symbol} ${asked.kind} needs an expiry`);
    // A commodity's "spot" is its near-month future (its candles are that future's).
    const k = this.ref.ready() ? canonicalKey(this.ref.quoteKey(asked)) : asked;
    const cal = this.calendarOf(k.symbol);
    if (interval === 'D') {
      if (cal.exchange === 'MCX') throw new NoLiveData(`No official end-of-day history for MCX ${k.symbol}: the app loads NSE/BSE files only; recorded sessions are shown on intraday intervals`);
      return officialDailyCandles(this.eodFiles, this.calendar, k, from, to);
    }
    const step = INTERVAL_MINUTES[interval];
    if (!step) throw badRequest(`Unsupported interval ${String(interval)}`);
    const dates = cal.sessions(from, to);
    if (!dates.length) throw new NoLiveData(`No trading sessions between ${from} and ${to}`);

    const { minutes, missing } = recordedMinutes(this.intraday, k, dates, this.istDate());
    let kotakNote: string | undefined;
    if (missing.length) {
      try {
        minutes.push(...(await this.kotakMinutes(k, missing)));
      } catch (e) {
        kotakNote = errMsg(e);
      }
    }
    if (!minutes.length) {
      throw new NoLiveData(`No ${interval} candles of ${describe(k)} for ${from}..${to}: not recorded${kotakNote ? `, and Kotak historical: ${kotakNote}` : ''}`);
    }
    return resampleMinutes(minutes, step, cal);
  }

  /** Kotak 1-minute candles of an ACTIVE contract for the given dates (cached). */
  private async kotakMinutes(k: InstrumentKey, dates: string[]): Promise<MinuteCandle[]> {
    if (!this.rest) throw new NoLiveData(this.kotakError ?? 'Kotak REST is not available');
    if (this.calendarOf(k.symbol).exchange === 'MCX') throw new NoLiveData('Kotak historical candles are not available for MCX; only minutes this app recorded are shown');
    let listing;
    try {
      listing = this.ref.listing(k);
    } catch (e) {
      throw e instanceof NoLiveData ? e : new NoLiveData(errMsg(e));
    }
    if (!listing) throw new NoLiveData(`${describe(k)} is not listed today (expired contracts are not served by Kotak historical)`);
    const neosymbol = ScripMaster.neosymbol(listing);
    const from = dates[0];
    const to = dates[dates.length - 1];
    const id = `${neosymbol}|${from}|${to}`;
    const today = this.istDate();
    const ttl = to >= today ? MINUTE : 6 * HOUR;
    let hit = this.histCache.get(id);
    if (!hit || this.now() - hit.at > ttl) {
      const raw = await this.rest.historical({ neosymbol, interval: '1min', from, to });
      const index = k.kind === 'SPOT' && (isIndexSpot(listing) || INDEX_SYMBOLS.has(k.symbol));
      // Index candles carry a 0 volume placeholder: left out, never reported as "no trades". A
      // contract's candle with volume 0 had no trade: its OHLC is a carried-forward price, so it is
      // dropped like the recorder's quote-only minutes.
      hit = {
        at: this.now(),
        candles: raw.filter((c) => index || c.volume > 0).map((c) => ({ ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close, ...(index ? {} : { volume: c.volume }) })),
      };
      this.histCache.set(id, hit);
      while (this.histCache.size > 200) this.histCache.delete(this.histCache.keys().next().value as string);
    }
    const want = new Set(dates);
    return hit.candles
      .filter((c) => {
        const s = this.calendarOf(k.symbol).session(c.ts);
        return want.has(s.date) && s.status === 'open';
      })
      .map((c) => ({ ...c }));
  }

  /* ---------------------------------- health ---------------------------------- */

  health(): FeedHealth {
    return this.live.health();
  }

  healthReport(): LiveHealthReport {
    const jobs: Record<string, JobStatus> = {};
    for (const [name, j] of this.jobs) {
      jobs[name] = { attempts: j.attempts, running: j.running, ...(j.lastError ? { lastError: j.lastError } : {}), ...(j.lastOkAt ? { lastOkAt: j.lastOkAt } : {}), ...(j.nextAt ? { nextAt: j.nextAt } : {}) };
    }
    const sessions = this.intraday.sessions();
    const centres: Record<string, number> = {};
    for (const s of INDEX_SPECS) {
      const c = this.universe.centreOf(s.symbol);
      if (c !== undefined) centres[s.symbol] = c;
    }
    const feed = this.live.health();
    if (this.feedHeld && !feed.connected) feed.error = this.feedHeld;
    const report: LiveHealthReport = {
      kotak: this.session ? this.session.status() : { loggedIn: false, error: this.kotakError, feedUrlKnown: false },
      feed: { ...feed, details: this.live.details() },
      refdata: this.ref.status(),
      recorder: { ...this.recorder.stats(), firstRecordedSession: sessions[0] ?? null, sessions: sessions.length },
      ...(this.secondStore && this.secondRecorder ? { seconds: { ...this.secondStore.usage(), ...this.secondRecorder.stats() } } : {}),
      eod: this.eod.status(),
      sweep: this.live.sweepStatus(),
      clock: this.clock.info(),
      universe: { notes: [...this.universeNotes], centres },
      jobs,
    };
    if (this.invalidHolidays.length) report.invalidHolidays = [...this.invalidHolidays];
    return report;
  }

  /** One line for the server log (no secrets). */
  healthLine(): string {
    const h = this.live.health();
    const r = this.ref.status();
    const fo = this.eodFiles.loadedDates('fo').at(-1);
    const parts = [
      h.loggedIn ? 'Kotak logged in' : `Kotak not logged in (${h.error ?? 'unknown'})`,
      h.connected ? `feed connected (${h.subscribed} subscribed)` : h.loggedIn ? `feed down${h.error ? ` (${h.error})` : ''}` : 'feed off',
      r.ready ? `instrument master ${r.date} (${r.underlyings} underlyings, ${r.listings} listings)` : `instrument master not loaded${r.error ? ` (${r.error})` : ''}`,
      `EOD F&O ${fo ?? 'none loaded'}`,
      `recorded sessions ${this.intraday.sessions().length}`,
    ];
    return `live data: ${parts.join('; ')}`;
  }
}

function describe(k: InstrumentKey): string {
  return [k.symbol, k.expiry, k.strike, k.kind].filter((v) => v !== undefined).join(' ');
}
