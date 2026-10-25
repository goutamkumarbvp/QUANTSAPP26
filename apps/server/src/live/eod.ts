/**
 * End-of-day jobs (DESIGN.md §3 "NSE/BSE files", nse-bse-public-data.md): the official files of a
 * date go into the history store, each source on its own:
 *
 *   index         ind_close_all (index OHLC; NIFTY close + change % for the two joins below)
 *   nseFo / bseFo NSE and BSE F&O UDiFF bhavcopy → futures/options rows + final settlements
 *   nseCm         NSE CM UDiFF bhavcopy → stock daily bars
 *   participants  fao_participant_oi, joined with the same date's NIFTY close
 *   fiidii        NSE fiidiiTradeReact (unofficial, latest session only), joined with NIFTY close and
 *                 change % of the same date; `scope` is stored ('nse' = the NSE-only fallback) and a
 *                 'combined' day is never replaced by an 'nse' one
 *
 * A file that is not published yet (404) is retried later; a blocked or malformed one has its reason
 * recorded in status(). Nothing is estimated: a source that fails leaves its date absent.
 * Schedule: the day's first attempt at 18:30 IST, then hourly until 23:30 IST; dates missing from the
 * last `backfillDays` sessions are loaded at start and once a day. Holidays come from NSE's holiday
 * master merged with the HOLIDAYS env list (env list alone, with the reason, when NSE is unreachable).
 */
import { istTs } from '@q26/core';
import type { ExchangeCalendar } from './calendar';
import { isIsoDate } from './calendar';
import { fetchBseFoBhavcopy, fetchNseCmBhavcopy, fetchNseFoBhavcopy, NSE_UDIFF_START, type FoBhavcopy } from './nse/bhavcopy';
import { fetchFiiDii, toFiiDiiDay } from './nse/fiidii';
import { fetchHolidays } from './nse/holidays';
import { NseError, type NseHttp, type NotPublished } from './nse/http';
import { istWhen } from '../log';
import { fetchIndexCloses, niftyCloseOf, toDailyBar, type IndexCloseFile } from './nse/indices';
import { fetchParticipants, toParticipantDay } from './nse/participants';
import type { EodKind, HistoryFiles } from './store/history';

export type EodSource = 'index' | 'nseFo' | 'nseCm' | 'bseFo' | 'participants' | 'fiidii';
/** Load order: the index closes first (participants and FII/DII join the NIFTY close). */
export const EOD_SOURCES: readonly EodSource[] = ['index', 'nseFo', 'nseCm', 'bseFo', 'participants', 'fiidii'];
/** FII/DII has no history endpoint: it is not backfilled per date. */
/** Sources stored for every past session (FII/DII is served for the latest session only). */
export const BACKFILL_SOURCES: readonly EodSource[] = ['index', 'nseFo', 'nseCm', 'bseFo', 'participants'];
const KINDS: readonly EodKind[] = ['fo', 'cm', 'index', 'participants', 'fiidii'];

/**
 * loaded / already-loaded: in the store. not-published: 404 or not out yet (retried). waiting: a
 * dependency (the NIFTY close) is missing (retried). unavailable: the source cannot serve that date
 * (not retried). failed: blocked, malformed or another error (reason recorded, retried later).
 */
export type EodOutcome = 'loaded' | 'already-loaded' | 'not-published' | 'waiting' | 'unavailable' | 'failed';

export interface EodResult {
  source: EodSource;
  date: string;
  outcome: EodOutcome;
  reason?: string;
  /** Failed because the host could not be reached at all (no internet, DNS or firewall). */
  network?: boolean;
}

export interface EodSourceStatus {
  /** Latest date this source loaded (this process) or found in the store. */
  lastLoaded: string | null;
  lastAttemptAt: number | null;
  last?: { date: string; outcome: EodOutcome; reason?: string };
  lastError?: string;
  lastErrorAt?: number;
}

export interface EodStatus {
  sources: Record<EodSource, EodSourceStatus>;
  /** Latest loaded date per store kind (history.loadedDates). */
  kinds: Record<EodKind, string | null>;
  holidays: { source: 'nse+env' | 'env'; count: number; fetchedAt: number | null; error?: string };
  next: { at: number; date: string } | null;
  backfill: { running: boolean; days: number; lastRunAt: number | null; datesMissing: number | null; stoppedOffline?: string };
}

export interface EodTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface EodLogger {
  /** Per-file detail the summary lines already cover (e.g. each file of a date when the network is down). */
  debug?(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
}

export interface EodJobsOptions {
  http: NseHttp;
  history: HistoryFiles;
  calendar: ExchangeCalendar;
  now?: () => number;
  timers?: EodTimers;
  logger?: EodLogger;
  /** HOLIDAYS env list: always part of the calendar. */
  envHolidays?: Iterable<string>;
  /** Trading days checked for missing files at start and once a day, default 30. */
  backfillDays?: number;
  /** Underlyings whose F&O and cash rows are stored (default: every row of the files). */
  symbols?: Iterable<string>;
  /** First daily attempt, minutes after IST midnight (default 18:30). */
  firstAttemptMinute?: number;
  /** No attempt for a date after this IST time (default 23:30). */
  lastAttemptMinute?: number;
  /** Gap between attempts for the same date (default 1 h). */
  retryMs?: number;
}

const HOUR = 3_600_000;
const MINUTE_MS = 60_000;
const MAX_TIMER_MS = 6 * HOUR;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The reason when every file that was requested failed to connect (NSE/BSE unreachable), else undefined. */
export function offlineReason(results: readonly EodResult[]): string | undefined {
  // 'waiting' sources (participants wait for the NIFTY close) made no request: they do not count.
  const tried = results.filter((r) => r.outcome !== 'waiting');
  if (!tried.length || !tried.every((r) => r.outcome === 'failed' && r.network)) return undefined;
  // "host/path/file: cannot resolve host (ENOTFOUND): …" → the part after the file label.
  return (tried[0].reason ?? 'network error').replace(/^[^\s:]+: /, '');
}

const realTimers: EodTimers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class EodJobs {
  private readonly now: () => number;
  private readonly timers: EodTimers;
  private readonly log: EodLogger;
  private readonly envHolidays: Set<string>;
  readonly backfillDays: number;
  private readonly symbols: string[] | undefined;
  private readonly firstMin: number;
  private readonly lastMin: number;
  private readonly retryMs: number;

  private readonly st = {} as Record<EodSource, EodSourceStatus>;
  /** Dates loaded by this process per source (the store answers for earlier runs). */
  private readonly loaded = new Map<EodSource, Set<string>>();
  /** Dates the last backfill could not complete (status() drops those filled since). */
  private missingDates: string[] = [];
  /** (date, source) pairs the source cannot serve: not attempted again. */
  private readonly unavailable = new Set<string>();
  private readonly indexFiles = new Map<string, IndexCloseFile>();
  /** Last daily attempt per date. */
  private readonly attempts = new Map<string, number>();
  private queue: Promise<unknown> = Promise.resolve();
  private timer: unknown = null;
  private next: { at: number; date: string } | null = null;
  /** The daily schedule runs (start() called, stop() not). */
  private scheduled = false;
  /** stop() was called: in-flight work finishes, nothing new starts. */
  private halted = false;
  private nseHolidays: Set<string> | null = null;
  private hol: EodStatus['holidays'];
  private holFetchedOk = 0;
  /** The holiday-master failure last written at warn level. */
  private holWarned: string | undefined;
  private lastBackfillDay: string | null = null;
  private readonly bf: EodStatus['backfill'];

  constructor(private readonly opts: EodJobsOptions) {
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? realTimers;
    this.log = opts.logger ?? { info: () => {}, warn: () => {} };
    this.envHolidays = new Set(opts.envHolidays ?? []);
    this.backfillDays = Math.max(0, Math.floor(opts.backfillDays ?? 30));
    this.symbols = opts.symbols ? [...opts.symbols].map((s) => s.toUpperCase()) : undefined;
    this.firstMin = opts.firstAttemptMinute ?? 18 * 60 + 30;
    this.lastMin = opts.lastAttemptMinute ?? 23 * 60 + 30;
    this.retryMs = opts.retryMs ?? HOUR;
    for (const s of EOD_SOURCES) this.st[s] = { lastLoaded: null, lastAttemptAt: null };
    this.hol = { source: 'env', count: this.envHolidays.size, fetchedAt: null };
    this.bf = { running: false, days: this.backfillDays, lastRunAt: null, datesMissing: null };
  }

  /* ---------------------------------- lifecycle ---------------------------------- */

  /** Holidays, then the backfill, and the daily schedule. Never throws; runs in the background. */
  start(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.halted = false;
    void this.enqueue(async () => {
      await this.refreshHolidays();
      await this.backfillNow();
      // Stopped because NSE/BSE could not be reached: the next scheduled attempt runs it again.
      if (!this.bf.stoppedOffline) this.lastBackfillDay = this.opts.calendar.session(this.now()).date;
    })
      .catch((e) => this.log.warn(`EOD: start-up backfill failed: ${errMsg(e)}`))
      .finally(() => this.schedule());
  }

  stop(): void {
    this.scheduled = false;
    this.halted = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.next = null;
  }

  /** Resolves once every job queued so far has finished (tests, shutdown). */
  idle(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Next attempt: today's file window (18:30–23:30 IST, hourly) while something is missing, else the next session's 18:30. */
  nextAttempt(now: number): { at: number; date: string } {
    const cal = this.opts.calendar;
    const today = cal.session(now).date;
    const first = istTs(today, this.firstMin);
    const last = istTs(today, this.lastMin);
    if (cal.isTradingDay(today) && !this.dayDone(today) && now <= last) {
      if (now < first) return { at: first, date: today };
      const prev = this.attempts.get(today);
      const at = prev === undefined ? now : Math.max(now, prev + this.retryMs);
      if (at <= last) return { at, date: today };
    }
    const nd = cal.next(today);
    return { at: istTs(nd, this.firstMin), date: nd };
  }

  private schedule(): void {
    if (!this.scheduled) return;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    let next: { at: number; date: string };
    try {
      next = this.nextAttempt(this.now());
    } catch (e) {
      // The store could not be read (a disk error): keep the schedule alive and look again later.
      this.log.warn(`EOD: scheduling failed: ${errMsg(e)}`);
      next = { at: this.now() + this.retryMs, date: this.opts.calendar.session(this.now()).date };
    }
    this.next = next;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = null;
        if (!this.scheduled) return;
        if (this.now() < next.at) return this.schedule(); // long waits are re-armed in steps
        void this.enqueue(() => this.runDaily(next.date))
          .catch((e) => this.log.warn(`EOD: ${next.date} failed: ${errMsg(e)}`))
          .finally(() => this.schedule());
      },
      Math.min(MAX_TIMER_MS, Math.max(0, next.at - this.now())),
    );
  }

  private async runDaily(date: string): Promise<void> {
    this.attempts.set(date, this.now());
    if (this.now() - this.holFetchedOk > 20 * HOUR) await this.refreshHolidays();
    if (this.opts.calendar.isTradingDay(date)) {
      const offline = offlineReason(await this.loadDate(date));
      if (offline) {
        // One line for the whole date (each file's failure is at debug); the backfill would fail the same way.
        this.log.warn(`EOD: ${date} files not fetched — NSE/BSE unreachable (${offline}); next attempt ${this.nextAttemptText()}`);
        return;
      }
    }
    if (this.lastBackfillDay !== date) {
      await this.backfillNow();
      if (!this.bf.stoppedOffline) this.lastBackfillDay = date;
    }
  }

  private nextAttemptText(): string {
    try {
      const at = this.nextAttempt(this.now()).at;
      // Today's files are due now (queued right behind this): their own line gives the time after that.
      return at - this.now() < MINUTE_MS ? "right away (today's files)" : istWhen(at, this.now());
    } catch {
      return 'later';
    }
  }

  private dayDone(date: string): boolean {
    return EOD_SOURCES.every((s) => this.isLoaded(s, date) || this.unavailable.has(`${date}|${s}`));
  }

  /* ---------------------------------- holidays ---------------------------------- */

  /** NSE holiday master (FO segment) ∪ HOLIDAYS env; the env list alone (reason kept) when NSE fails. */
  async refreshHolidays(): Promise<void> {
    let reason: string | undefined;
    try {
      const r = await fetchHolidays(this.opts.http);
      if (r.data) {
        this.nseHolidays = r.data.fo ?? r.data.cm ?? new Set();
        this.holFetchedOk = this.now();
      } else reason = r.reason;
    } catch (e) {
      reason = `holiday-master: ${errMsg(e)}`;
    }
    const all = new Set([...(this.nseHolidays ?? []), ...this.envHolidays]);
    try {
      this.opts.calendar.setHolidays(all);
    } catch (e) {
      reason = `holiday list rejected: ${errMsg(e)}`;
    }
    this.hol = {
      source: this.nseHolidays ? 'nse+env' : 'env',
      count: all.size,
      fetchedAt: this.holFetchedOk || null,
      ...(reason ? { error: this.nseHolidays ? `${reason} (keeping the list fetched earlier)` : `${reason} (HOLIDAYS env list only)` } : {}),
    };
    // The same failure again (the daily run retries it) goes to debug: one warning per cause.
    if (reason && reason !== this.holWarned) this.log.warn(`EOD: holidays: ${this.hol.error}`);
    else if (reason) this.log.debug?.(`EOD: holidays: ${this.hol.error}`);
    this.holWarned = reason;
  }

  /* ---------------------------------- loading ---------------------------------- */

  /** Load the official files of one date (each source independently). */
  /** `force`: fetch even when the store already reads as loaded (e.g. after a damaged file was moved away). */
  async loadDate(date: string, sources: readonly EodSource[] = EOD_SOURCES, opts: { force?: boolean } = {}): Promise<EodResult[]> {
    if (!isIsoDate(date)) throw new Error(`loadDate: invalid date '${date}'`);
    const out: EodResult[] = [];
    for (const s of EOD_SOURCES) if (sources.includes(s)) out.push(await this.loadSource(s, date, opts.force));
    return out;
  }

  /** loadDate() after the backfill / daily job in progress (never two loads of the store at once). */
  loadDateQueued(date: string, sources: readonly EodSource[] = EOD_SOURCES, opts: { force?: boolean } = {}): Promise<EodResult[]> {
    return this.enqueue(() => this.loadDate(date, sources, opts));
  }

  /** Backfill sources of `date` neither loaded nor known to be unpublished. */
  private backfillGaps(date: string): EodSource[] {
    return BACKFILL_SOURCES.filter((s) => !this.isLoaded(s, date) && !this.unavailable.has(`${date}|${s}`));
  }

  /** Load the dates missing from the store over the last `days` sessions (newest first). */
  backfill(days: number = this.backfillDays): Promise<EodResult[]> {
    return this.enqueue(() => this.backfillNow(days));
  }

  private async backfillNow(days: number = this.backfillDays): Promise<EodResult[]> {
    const cal = this.opts.calendar;
    this.bf.running = true;
    this.bf.lastRunAt = this.now();
    const results: EodResult[] = [];
    const missing: string[] = [];
    delete this.bf.stoppedOffline;
    try {
      const today = cal.session(this.now()).date;
      const dates: string[] = [];
      for (let d = cal.prev(today); dates.length < days && d >= NSE_UDIFF_START; d = cal.prev(d)) dates.push(d);
      for (const date of dates) {
        if (this.halted) break;
        const need = this.backfillGaps(date);
        if (!need.length) continue;
        const got = await this.loadDate(date, need);
        results.push(...got);
        if (this.backfillGaps(date).length) missing.push(date);
        const offline = offlineReason(got);
        if (offline) {
          // Every file of the date failed to connect: the other dates would too. Stop and say so once.
          this.bf.stoppedOffline = offline;
          this.log.warn(`EOD: NSE/BSE unreachable (${offline}); end-of-day backfill stopped — next attempt ${this.nextAttemptText()}`);
          break;
        }
      }
      // FII/DII serves the latest session only: one call stores it.
      if (!this.halted && !this.bf.stoppedOffline && dates.length && !this.isLoaded('fiidii', dates[0])) results.push(await this.loadSource('fiidii', dates[0]));
    } finally {
      this.bf.running = false;
      this.missingDates = missing;
      this.bf.datesMissing = missing.length;
    }
    return results;
  }

  private async loadSource(source: EodSource, date: string, force = false): Promise<EodResult> {
    const st = this.st[source];
    st.lastAttemptAt = this.now();
    let r: EodResult;
    try {
      r = !force && this.isLoaded(source, date) ? { source, date, outcome: 'already-loaded' } : await this.load(source, date);
    } catch (e) {
      r = { source, date, outcome: 'failed', reason: errMsg(e), ...(e instanceof NseError && e.kind === 'network' ? { network: true } : {}) };
    }
    st.last = { date, outcome: r.outcome, ...(r.reason ? { reason: r.reason } : {}) };
    if (r.outcome === 'loaded') {
      let set = this.loaded.get(source);
      if (!set) this.loaded.set(source, (set = new Set()));
      set.add(date);
      this.log.info(`EOD: ${source} ${date} loaded`);
    }
    if ((r.outcome === 'loaded' || r.outcome === 'already-loaded') && (st.lastLoaded === null || date > st.lastLoaded)) st.lastLoaded = date;
    if (r.outcome === 'unavailable') this.unavailable.add(`${date}|${source}`);
    if (r.outcome === 'failed') {
      st.lastError = r.reason;
      st.lastErrorAt = this.now();
      // Network-down failures are summed up once per date by the caller.
      if (r.network) this.log.debug?.(`EOD: ${source} ${date} failed: ${r.reason}`);
      else this.log.warn(`EOD: ${source} ${date} failed: ${r.reason}`);
    }
    return r;
  }

  private load(source: EodSource, date: string): Promise<EodResult> {
    switch (source) {
      case 'index':
        return this.loadIndex(date);
      case 'nseFo':
        return this.loadFo('nseFo', date);
      case 'bseFo':
        return this.loadFo('bseFo', date);
      case 'nseCm':
        return this.loadCm(date);
      case 'participants':
        return this.loadParticipants(date);
      case 'fiidii':
        return this.loadFiiDii(date);
    }
  }

  /** The exchange answered that `source` is not published for `date` (not retried by the backfill). */
  wasUnavailable(source: EodSource, date: string): boolean {
    return this.unavailable.has(`${date}|${source}`);
  }

  /** Forget that `source` was loaded (or unavailable) for `date`, so the next load fetches it again. */
  forget(source: EodSource, date: string): void {
    this.loaded.get(source)?.delete(date);
    this.unavailable.delete(`${date}|${source}`);
  }

  isLoaded(source: EodSource, date: string): boolean {
    if (this.loaded.get(source)?.has(date)) return true;
    const h = this.opts.history;
    switch (source) {
      case 'index':
        return h.loadedDates('index').includes(date);
      case 'nseCm':
        return h.loadedDates('cm').includes(date);
      case 'participants':
        return h.loadedDates('participants').includes(date);
      case 'fiidii':
        return h.fiiDii(date, date).some((d) => d.scope !== 'nse');
      case 'nseFo':
        return h.loadedDates('fo').includes(date) && h.dailyOptions('NIFTY', date).length > 0;
      case 'bseFo':
        return h.loadedDates('fo').includes(date) && (h.dailyOptions('SENSEX', date).length > 0 || h.dailyOptions('BANKEX', date).length > 0);
    }
  }

  private notPublished(source: EodSource, date: string, res: NotPublished): EodResult {
    return { source, date, outcome: 'not-published', reason: `not published yet (HTTP ${res.httpStatus} ${res.url})` };
  }

  private rememberIndex(f: IndexCloseFile): void {
    this.indexFiles.set(f.date, f);
    while (this.indexFiles.size > 10) this.indexFiles.delete(this.indexFiles.keys().next().value as string);
  }

  private async loadIndex(date: string): Promise<EodResult> {
    const res = await fetchIndexCloses(this.opts.http, date);
    if (res.status !== 'ok') return this.notPublished('index', date, res);
    this.rememberIndex(res.data);
    const bars = res.data.closes.map((c) => ({ ...toDailyBar(c), symbol: c.symbol }));
    if (!bars.length) return { source: 'index', date, outcome: 'failed', reason: 'ind_close_all lists none of the app indices' };
    this.opts.history.writeDailyBars('index', date, bars);
    return { source: 'index', date, outcome: 'loaded' };
  }

  private async loadFo(source: 'nseFo' | 'bseFo', date: string): Promise<EodResult> {
    if (source === 'nseFo' && date < NSE_UDIFF_START) return { source, date, outcome: 'unavailable', reason: `NSE F&O bhavcopy before ${NSE_UDIFF_START} uses the legacy format (not supported)` };
    const opts = this.symbols ? { symbols: this.symbols } : {};
    const res = source === 'nseFo' ? await fetchNseFoBhavcopy(this.opts.http, date, opts) : await fetchBseFoBhavcopy(this.opts.http, date, opts);
    if (res.status !== 'ok') return this.notPublished(source, date, res);
    const f: FoBhavcopy = res.data;
    if (!f.options.length && !f.futures.length) return { source, date, outcome: 'failed', reason: `${f.exchange} F&O bhavcopy has no rows for the app's underlyings` };
    this.opts.history.writeFo(date, { futures: f.futures, options: f.options });
    if (f.finalSettlements.length) this.opts.history.writeSettlements(f.finalSettlements);
    return { source, date, outcome: 'loaded' };
  }

  private async loadCm(date: string): Promise<EodResult> {
    if (date < NSE_UDIFF_START) return { source: 'nseCm', date, outcome: 'unavailable', reason: `NSE CM bhavcopy before ${NSE_UDIFF_START} uses the legacy format (not supported)` };
    const res = await fetchNseCmBhavcopy(this.opts.http, date, this.symbols ? { symbols: this.symbols } : {});
    if (res.status !== 'ok') return this.notPublished('nseCm', date, res);
    if (!res.data.bars.length) return { source: 'nseCm', date, outcome: 'failed', reason: "NSE CM bhavcopy has no rows for the app's stocks" };
    this.opts.history.writeDailyBars('cm', date, res.data.bars);
    return { source: 'nseCm', date, outcome: 'loaded' };
  }

  /** NIFTY close of a date from the index file read by this process, else from the store. */
  private niftyClose(date: string): { date: string; close: number } | undefined {
    const f = this.indexFiles.get(date);
    const n = f ? niftyCloseOf(f) : undefined;
    if (n) return n;
    const bar = this.opts.history.dailyBars('NIFTY', date, date)[0];
    return bar && bar.close > 0 ? { date, close: bar.close } : undefined;
  }

  /** NIFTY close and change % of a date (the store keeps no change %, so the official file is read). */
  private async niftyWithChange(date: string): Promise<{ date: string; close: number; changePct?: number } | undefined> {
    let f = this.indexFiles.get(date);
    if (!f) {
      const res = await fetchIndexCloses(this.opts.http, date);
      if (res.status !== 'ok') return undefined;
      f = res.data;
      this.rememberIndex(f);
      if (!this.isLoaded('index', date)) {
        const bars = f.closes.map((c) => ({ ...toDailyBar(c), symbol: c.symbol }));
        if (bars.length) this.opts.history.writeDailyBars('index', date, bars);
      }
    }
    return niftyCloseOf(f);
  }

  private async loadParticipants(date: string): Promise<EodResult> {
    const nifty = this.niftyClose(date);
    if (!nifty) return { source: 'participants', date, outcome: 'waiting', reason: `NIFTY close of ${date} not loaded yet (ind_close_all)` };
    const res = await fetchParticipants(this.opts.http, date, 'oi');
    if (res.status !== 'ok') return this.notPublished('participants', date, res);
    const day = toParticipantDay(res.data, nifty);
    if (!day) return { source: 'participants', date, outcome: 'failed', reason: `participant file is dated ${res.data.date}, NIFTY close is of ${nifty.date}` };
    if (!day.rows.length) return { source: 'participants', date, outcome: 'failed', reason: 'participant file has no complete rows' };
    this.opts.history.writeParticipants(day);
    return { source: 'participants', date, outcome: 'loaded' };
  }

  private async loadFiiDii(date: string): Promise<EodResult> {
    const r = await fetchFiiDii(this.opts.http);
    if (!r.data) return { source: 'fiidii', date, outcome: 'failed', reason: r.reason, ...(r.network ? { network: true } : {}) };
    const flows = r.data;
    // The endpoint has no history: store the session it serves, whatever date was asked for.
    const stored = this.opts.history.fiiDii(flows.date, flows.date)[0];
    let waiting: string | undefined;
    if (!stored || (stored.scope === 'nse' && flows.scope === 'combined')) {
      const nifty = await this.niftyWithChange(flows.date);
      const day = toFiiDiiDay(flows, nifty);
      if (day) {
        this.opts.history.writeFiiDii(day);
        this.log.info(`EOD: FII/DII ${flows.date} (${flows.scope}) stored`);
      } else waiting = `NIFTY close/change of ${flows.date} not available yet (ind_close_all)`;
    }
    if (flows.date === date) {
      if (waiting) return { source: 'fiidii', date, outcome: 'waiting', reason: waiting };
      const kept = this.opts.history.fiiDii(date, date)[0];
      if (kept?.scope === 'nse') return { source: 'fiidii', date, outcome: 'not-published', reason: 'only the NSE-only figures (fiidiiTradeNse) are available so far' };
      return { source: 'fiidii', date, outcome: 'loaded' };
    }
    if (flows.date < date) return { source: 'fiidii', date, outcome: 'not-published', reason: `the latest FII/DII figures are for ${flows.date}` };
    return { source: 'fiidii', date, outcome: 'unavailable', reason: `the FII/DII source serves only the latest session (${flows.date})` };
  }

  /* ---------------------------------- status ---------------------------------- */

  status(): EodStatus {
    const sources = {} as Record<EodSource, EodSourceStatus>;
    for (const s of EOD_SOURCES) sources[s] = { ...this.st[s], ...(this.st[s].last ? { last: { ...this.st[s].last! } } : {}) };
    const kinds = {} as Record<EodKind, string | null>;
    for (const k of KINDS) kinds[k] = this.opts.history.loadedDates(k).at(-1) ?? null;
    return { sources, kinds, holidays: { ...this.hol }, next: this.next ? { ...this.next } : null, backfill: { ...this.bf, ...(this.bf.datesMissing !== null ? { datesMissing: this.missingDates.filter((d) => this.backfillGaps(d).length).length } : {}) } };
  }
}
