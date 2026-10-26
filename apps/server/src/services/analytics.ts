/**
 * Analytics for the tool screens, read from the MarketDataProvider only (DESIGN.md §1, §4):
 *  - live values from md.live (a price counts only when it is a trade of the live session, a book
 *    only while it is fresh: services/live.ts livePrice/liveBook), IV/Greeks solved from premiums by
 *    md.pricing / live/pricing.ts (Black-76 on the expiry's forward), never a model or fixed IV;
 *  - intraday history only from the recorder (md.intraday) and, for charts of ACTIVE contracts,
 *    Kotak 1-minute candles (md.candles, last 30 sessions, a few contracts per request);
 *  - multi-day history only from the official NSE/BSE end-of-day files (md.history).
 *
 * Series rules: a point at time t uses the records of the window that ends at t (the previous point
 * … t): prices are the close of the last TRADED minute in the window (quote-only minutes carry an
 * older price), OI the last value recorded in the window. A window without a record gives null:
 * nothing is carried forward or interpolated. Official option rows with volume 0 carry a
 * carried-forward/theoretical price: their close is never used as a price (their OI is).
 * Whole answer unavailable → NoLiveData (HTTP 503); a missing field → null, with the reason in `gaps`.
 */
import {
  type UnderlyingKind,
  addDays,
  classifyBuildUp,
  daysToExpiry,
  describeOrb,
  evaluateOpeningRange,
  expiryTs,
  formatExpiry,
  formatTimeIST,
  historicalVol,
  marginParamsOf,
  istTs,
  ivPercentile,
  ivRank,
  legQty,
  MARKET_CLOSE_MIN,
  maxPain,
  optimizeStrategies,
  orbAtPrice,
  SESSION_MINUTES,
  sideSign,
  volatilityCone,
  type BreadthResponse,
  type BuildUp,
  type BuildUpCounts,
  type ConeResponse,
  type DailyPcrPoint,
  type FiiDiiDay,
  type FuturesBuildUpRow,
  type IvChartResponse,
  type IvTableRow,
  type Leg,
  type MaxPainResponse,
  type MinuteBar,
  type MultiStrikeResponse,
  type OiTrendPoint,
  type OiTrendResponse,
  type OptimizerOutput,
  type OptimizerRequest,
  type OptionQuote,
  type OrbEvaluation,
  type OrbHistoryResponse,
  type OrbHistoryRow,
  type OrbResponse,
  type OrbRule,
  type OrbScanRow,
  type ParticipantDay,
  type PcrResponse,
  type RecapRequest,
  type RecapResponse,
  type SkewResponse,
  type StraddlePoint,
  type StraddleResponse,
  type StrategyChartPoint,
  type StrikeOiResponse,
  type SurfaceResponse,
} from '@q26/core';
import { isIsoDate } from '../live/calendar';
import { black76Iv, impliedForward, timeToExpiry, type PremiumRow } from '../live/pricing';
import { NoLiveData, keyId } from '../live/types';
import type { DailyFuture, DailyOption, InstrumentKey, MarketDataProvider, MinuteRecord, OptKind, TradingCalendar, Underlying } from '../live/types';
import {
  buildOptionChain,
  changeOf,
  currentSession,
  eodAtmIvOf,
  eodClose,
  futKey,
  Gaps,
  httpError,
  keyLabel,
  liveBook,
  liveDates,
  liveOptionExpiries,
  livePrice,
  MAX_CANDLE_SESSIONS,
  mdFor,
  nearFuture,
  notRecordedReason,
  onOrBefore,
  optKey,
  pct,
  r2,
  requireDate,
  requireRecorded,
  saneMid,
  sessionDateOf,
  sessionsBack,
  spotKey,
} from './live';
import type { Pricer } from './pricer';

const MINUTE = 60_000;
const M = SESSION_MINUTES;

/** Sessions of official ATM IV that IV rank / percentile are measured over (one year). */
export const IV_WINDOW = 252;
/** IVR/IVP need at least this many of those sessions (90 %); with fewer they are null (gap). */
export const MIN_IV_HISTORY = Math.ceil(IV_WINDOW * 0.9);
/** A recording must start within this many minutes of 09:15 to cover the opening range. */
export const ORB_OPEN_SLACK_MIN = 2;
/** …and end within this many minutes of 15:30 to give the day's close (ORB history). */
export const ORB_CLOSE_SLACK_MIN = 5;
/** Contracts one chart request may fetch from Kotak 1-minute history (slow lane, ≤ 1 call / 1.5 s). */
export const MAX_KOTAK_CONTRACTS = 6;
/** Market-wide snapshots (option snapshot, futures, IV table, ORB scan) are rebuilt at most every 5 s. */
export const SNAPSHOT_MS = 5_000;
/** Moneyness buckets (%) of the surface. */
export const SURFACE_MONEYNESS = [-10, -8, -6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 8, 10];
const CONE_WINDOWS = [10, 20, 30, 60, 90, 120];

/** What the recorded chain totals (ChainMinute) cover (Phase B review item d/g). */
export const RECORDED_CHAIN_COVERAGE = 'streamed strikes (±8 %): the strikes the recorder tracked, re-centred during the day — not the whole chain';

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPos = (v: unknown): v is number => isNum(v) && v > 0;
const rn = (v: number | null | undefined, d: number): number | null => (isNum(v) ? +v.toFixed(d) : null);
const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Math.round(Number(v));
  return v !== undefined && v !== null && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt;
};
/** Official close of a row that traded; untraded rows carry a carried-forward/theoretical price. */
const tradedClose = (row: { close: number; volume: number } | undefined): number | null => (row && row.volume > 0 && isPos(row.close) ? row.close : null);
const traded = (r: MinuteRecord): boolean => r.traded;
const byTs = <T extends { ts: number }>(a: readonly T[]): T[] => [...a].sort((x, y) => x.ts - y.ts);
const toBar = (r: { ts: number; open: number; high: number; low: number; close: number }): MinuteBar => ({ ts: r.ts, open: r.open, high: r.high, low: r.low, close: r.close });
const avg = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function emptyCounts(): BuildUpCounts {
  return { 'Long Build-up': 0, 'Short Build-up': 0, 'Short Covering': 0, 'Long Unwinding': 0, Neutral: 0 };
}

/** Index of the last record completed by `t` (record.ts + 1 min ≤ t), −1 when none. `recs` sorted by ts. */
function lastCompleted(recs: readonly { ts: number }[], t: number): number {
  let lo = 0;
  let hi = recs.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (recs[mid].ts + MINUTE <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/**
 * For each window k: the last record that started at or after `starts[k]` and completed by `ends[k]`
 * (and passes `pick`); undefined when there is none. Nothing is carried over from an earlier window.
 */
export function inWindows<T extends { ts: number }>(recs: readonly T[], starts: readonly number[], ends: readonly number[], pick: (r: T) => boolean = () => true): (T | undefined)[] {
  return ends.map((end, k) => {
    for (let i = lastCompleted(recs, end); i >= 0 && recs[i].ts >= starts[k]; i--) if (pick(recs[i])) return recs[i];
    return undefined;
  });
}

/** Sums FII/DII net flows over 'combined'-scope days only (NSE-only days are a different coverage). */
export function sumFiiDii(days: readonly FiiDiiDay[]): { fiiNet: number | null; diiNet: number | null; days: number; excluded: number } {
  const ok = days.filter((d) => d.scope === 'combined');
  return {
    fiiNet: ok.length ? r2(ok.reduce((a, d) => a + d.fiiNet, 0)) : null,
    diiNet: ok.length ? r2(ok.reduce((a, d) => a + d.diiNet, 0)) : null,
    days: ok.length,
    excluded: days.length - ok.length,
  };
}

/**
 * One near-expiry option contract of the market-wide snapshot (scanners, synopsis, unusual
 * activity): the live quote of a streamed index-chain leg or a swept stock-chain leg.
 */
export interface OptionSnapshotRow {
  symbol: string;
  kind: UnderlyingKind;
  sector: string;
  expiry: string;
  type: OptKind;
  strike: number;
  /** Live spot of the underlying (rows are the strikes within ±5 % (index) / ±12 % (stock) of it). */
  spot: number;
  /** Trade price of the live session; null when the leg has not traded in it (its OI is still real). */
  ltp: number | null;
  /** Previous session close: the quote's, else the official close when that contract traded. */
  prevLtp: number | null;
  changePct: number | null;
  oi: number | null;
  /** The quote's previous OI, else the official previous-session OI. */
  prevOi: number | null;
  oiChange: number | null;
  oiChangePct: number | null;
  /** Session volume (units). */
  volume: number | null;
  /** Percent, Black-76 from the mid of a sane live book, else the session LTP (`ivSource`). */
  iv: number | null;
  ivSource: 'mid' | 'ltp' | null;
  /** Percent, Black-76 from the previous session's official traded close and that session's forward. */
  prevIv: number | null;
  lotSize: number;
  /** Quote time (epoch ms). */
  ts: number;
}

interface Marks {
  date: string;
  /** The session is open now (the last window may be followed by a minute in progress). */
  live: boolean;
  open: number;
  /** Window k is [starts[k], times[k]); times are the as-of instants of the points. */
  starts: number[];
  times: number[];
}

interface KeyMinutes {
  recs: MinuteRecord[];
  source: 'recorded' | 'kotak' | null;
  reason?: string;
}

interface DayBars {
  bars: MinuteBar[];
  partial: boolean;
  source: 'recorded' | 'kotak';
}

/** IVs solved from one session's official option closes (Analytics.eodCurve). */
interface EodCurve {
  /** Official close of the underlying that session. */
  spot: number | null;
  forward: number | null;
  /** Decimal IV per `${type}|${strike}` (traded rows only). */
  iv: Map<string, number>;
  /** Every official row of the expiry (OI usable; close only when it traded). */
  rows: Map<string, DailyOption>;
}

/** A small time-bucketed cache (a few keys, newest kept). */
class BucketCache<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly max = 8) {}
  get(key: string, make: () => V): V {
    const hit = this.map.get(key);
    if (hit !== undefined) return hit;
    const v = make();
    this.map.set(key, v);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
    return v;
  }
}

/**
 * Change-in-OI PCR: put OI added today / call OI added today (both vs the previous close). Null when either
 * change is unknown, or the call change is too small to divide by (under 0.1% of call OI: the ratio would spike).
 */
export function changePcrOf(ceChange: number | null, peChange: number | null, ceOi: number | null): number | null {
  if (ceChange === null || peChange === null) return null;
  const floor = isNum(ceOi) && ceOi > 0 ? ceOi * 0.001 : 1;
  if (Math.abs(ceChange) < floor) return null;
  return Math.round((peChange / ceChange) * 1000) / 1000;
}

export class Analytics {
  private readonly snapCache = new BucketCache<OptionSnapshotRow[]>(4);
  private readonly futCache = new BucketCache<FuturesBuildUpRow[]>(4);
  private readonly ivCache = new BucketCache<IvTableRow[]>(4);
  private readonly orbScanCache = new BucketCache<OrbScanRow[]>(8);
  private readonly eodCurves = new Map<string, EodCurve>();

  constructor(
    readonly md: MarketDataProvider,
    readonly pricer: Pricer,
  ) {}

  /* ------------------------------------------------------------------------------------------ */
  /* Shared helpers                                                                               */
  /* ------------------------------------------------------------------------------------------ */

  private now(): number {
    return this.md.clock.now();
  }

  private bucket(): string {
    return String(Math.floor(this.now() / SNAPSHOT_MS));
  }

  /** As-of points every `interval` minutes of a session, up to its last completed minute. */
  private marks(date: string, interval: number, symbol: string): Marks {
    const md = mdFor(this.md, symbol);
    const now = this.now();
    const s = md.calendar.session(now);
    const open = md.calendar.ts(date, 0);
    const len = md.calendar.sessionMinutes(date);
    const done = date === s.date ? Math.max(0, Math.min(len, Math.floor((now - open) / MINUTE))) : len;
    const step = clampInt(interval, 1, len, 5);
    const mins: number[] = [];
    for (let m = step; m < done; m += step) mins.push(m);
    if (done >= 1) mins.push(done);
    const times = mins.map((m) => md.calendar.ts(date, m));
    return { date, live: date === s.date && s.status === 'open', open, times, starts: times.map((_, k) => (k ? times[k - 1] : open)) };
  }

  private requireMarks(m: Marks): Marks {
    if (!m.times.length) throw new NoLiveData(`No minute of the ${m.date} session has completed yet`);
    return m;
  }

  /** Option expiries recorded for `symbol` on `date` (not expired before that session), ascending. */
  private recordedOptionExpiries(symbol: string, date: string): string[] {
    const set = new Set<string>();
    for (const k of this.md.intraday.recordedKeys(date)) if (k.symbol === symbol && (k.kind === 'CE' || k.kind === 'PE') && k.expiry && k.expiry >= date) set.add(k.expiry);
    return [...set].sort();
  }

  private recordedStrikes(symbol: string, expiry: string, date: string): number[] {
    const set = new Set<number>();
    for (const k of this.md.intraday.recordedKeys(date)) if (k.symbol === symbol && k.expiry === expiry && (k.kind === 'CE' || k.kind === 'PE') && isNum(k.strike)) set.add(k.strike);
    return [...set].sort((a, b) => a - b);
  }

  /** Runs `fn`; NoLiveData → `fallback` (its reason handed to `onNoLive`). */
  private orElse<T>(fn: () => T, fallback: T, onNoLive?: (reason: string) => void): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof NoLiveData) {
        onNoLive?.(e.message);
        return fallback;
      }
      throw e;
    }
  }

  private listedStrikes(symbol: string, expiry: string): number[] {
    try {
      return this.md.ref.strikes(symbol, expiry);
    } catch (e) {
      if (e instanceof NoLiveData || (e as { statusCode?: number }).statusCode === 404) return [];
      throw e;
    }
  }

  /** A requested expiry: 400 when malformed. */
  private checkExpiry(expiry: string | undefined | null): string | undefined {
    if (!expiry) return undefined;
    if (!isIsoDate(expiry)) throw httpError(400, `expiry must be YYYY-MM-DD (got '${expiry}')`);
    return expiry;
  }

  /** Recorded option expiry of a session: the requested one (NoLiveData when not recorded) or the nearest recorded. */
  private recordedExpiry(symbol: string, date: string, expiryIn?: string): string {
    const want = this.checkExpiry(expiryIn);
    const exps = this.recordedOptionExpiries(symbol, date);
    if (want) {
      if (!exps.includes(want)) throw new NoLiveData(`No recorded ${symbol} ${want} options on ${date}${exps.length ? ` (recorded: ${exps.join(', ')})` : ''}`);
      return want;
    }
    if (!exps.length) throw new NoLiveData(`No recorded ${symbol} options on ${date}`);
    return exps[0];
  }

  /** Expiry with recorded chain minutes on `date` (the requested one, else the nearest). */
  private chainExpiry(symbol: string, date: string, expiryIn?: string): string {
    const want = this.checkExpiry(expiryIn);
    const exps = this.recordedOptionExpiries(symbol, date).filter((e) => this.md.intraday.chainSeries(symbol, e, date).length > 0);
    if (want) {
      if (!exps.includes(want)) throw new NoLiveData(`No recorded ${symbol} ${want} chain minutes on ${date}${exps.length ? ` (recorded: ${exps.join(', ')})` : ''}`);
      return want;
    }
    if (!exps.length) throw new NoLiveData(`No recorded ${symbol} option-chain minutes on ${date}`);
    return exps[0];
  }

  /**
   * Minute records per key for one session, with Kotak 1-minute history (md.candles) for keys the
   * recorder does not hold, when `kotak` (active contracts, last 30 sessions, ≤ MAX_KOTAK_CONTRACTS).
   */
  private loader(date: string, kotak: boolean, symbol: string) {
    const md = mdFor(this.md, symbol);
    const cache = new Map<string, Promise<KeyMinutes>>();
    const reasons: string[] = [];
    let calls = 0;
    const oldest = sessionsBack(md, currentSession(md), MAX_CANDLE_SESSIONS['1min'])[0];
    const load = async (key: InstrumentKey): Promise<KeyMinutes> => {
      const recs = byTs(md.intraday.bars(key, date));
      if (recs.length) return { recs, source: 'recorded' };
      const notRec = notRecordedReason(md, date, `minutes of ${keyLabel(key)}`);
      const fail = (reason: string): KeyMinutes => {
        reasons.push(reason);
        return { recs: [], source: null, reason };
      };
      if (!kotak) return fail(notRec);
      if (date < oldest) return fail(`${notRec}; Kotak 1-minute history is used for the last ${MAX_CANDLE_SESSIONS['1min']} sessions only`);
      if (calls >= MAX_KOTAK_CONTRACTS) return fail(`${notRec}; more than ${MAX_KOTAK_CONTRACTS} contracts would need Kotak 1-minute history`);
      calls++;
      try {
        const now = this.now();
        const out: MinuteRecord[] = [];
        for (const c of await md.candles(key, '1min', date, date)) {
          if (!isPos(c.open) || !isPos(c.high) || !isPos(c.low) || !isPos(c.close) || c.ts + MINUTE > now) continue;
          out.push({ ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close, traded: true, ...(c.volume !== undefined ? { volume: c.volume } : {}) });
        }
        if (!out.length) return fail(`${notRec}; Kotak returned no completed 1-minute candles`);
        return { recs: byTs(out), source: 'kotak' };
      } catch (e) {
        if (e instanceof NoLiveData) return fail(`${notRec}; Kotak 1-minute history: ${e.message}`);
        throw e;
      }
    };
    return {
      get(key: InstrumentKey): Promise<KeyMinutes> {
        const id = keyId(key);
        let p = cache.get(id);
        if (!p) cache.set(id, (p = load(key)));
        return p;
      },
      reasons,
    };
  }

  /* -------------------------------- official end-of-day lookups ------------------------------ */

  private eodOptions(symbol: string, expiry: string, date: string): Map<string, DailyOption> {
    const out = new Map<string, DailyOption>();
    for (const o of this.md.history.dailyOptions(symbol, date, expiry)) out.set(`${o.type}|${o.strike}`, o);
    return out;
  }

  private eodFuture(symbol: string, expiry: string, date: string): DailyFuture | undefined {
    return this.md.history.dailyFutures(symbol, date, date).find((f) => f.date === date && f.expiry === expiry);
  }

  /**
   * IVs (decimal) per `${type}|${strike}` at the official close of `date`: Black-76 on the traded
   * closes of `expiry`, forward from its traded future (settle, else close), else put-call parity at
   * the strike nearest the underlying close, else that close carried at r (pricing.impliedForward).
   */
  private eodCurve(symbol: string, expiry: string, date: string): EodCurve {
    const id = `${symbol}|${expiry}|${date}`;
    const hit = this.eodCurves.get(id);
    if (hit) return hit;
    const curve = this.solveEodCurve(symbol, expiry, date);
    // Official files of a past session do not change once loaded: cache only complete inputs (the
    // F&O rows and the underlying close), so a file that loads later is still picked up.
    if (curve.rows.size && curve.spot !== null) {
      this.eodCurves.set(id, curve);
      while (this.eodCurves.size > 512) this.eodCurves.delete(this.eodCurves.keys().next().value as string);
    }
    return curve;
  }

  private solveEodCurve(symbol: string, expiry: string, date: string): EodCurve {
    const rows = this.eodOptions(symbol, expiry, date);
    const iv = new Map<string, number>();
    const byStrike = new Map<number, PremiumRow>();
    for (const o of rows.values()) {
      const c = tradedClose(o);
      if (c === null) continue;
      let row = byStrike.get(o.strike);
      if (!row) byStrike.set(o.strike, (row = { strike: o.strike }));
      row[o.type === 'CE' ? 'ce' : 'pe'] = c;
    }
    const spot = rows.size ? eodClose(this.md, symbol, date) : null;
    if (!byStrike.size) return { spot, forward: null, iv, rows };
    const f = this.eodFuture(symbol, expiry, date);
    const future = f && f.volume > 0 ? (isPos(f.settle) ? f.settle : isPos(f.close) ? f.close : undefined) : undefined;
    const cal = this.md.calendarOf(symbol);
    const T = timeToExpiry(expiry, cal.ts(date, cal.sessionMinutes(date)), cal.exchange);
    const r = this.md.pricing.r;
    const fwd = impliedForward({ spot: spot ?? undefined, future, rows: [...byStrike.values()] }, T, r);
    if (fwd) {
      for (const o of rows.values()) {
        const c = tradedClose(o);
        if (c === null) continue;
        const v = black76Iv(o.type, c, fwd.forward, o.strike, T, r);
        if (v !== null) iv.set(`${o.type}|${o.strike}`, v);
      }
    }
    return { spot, forward: fwd?.forward ?? null, iv, rows };
  }

  /** Consecutive-session run lengths of official bars (a missing session breaks the run). */
  private runs(bars: readonly { date: string }[], cal: TradingCalendar = this.md.calendar): number[] {
    const out: number[] = [];
    bars.forEach((b, i) => out.push(i > 0 && bars[i - 1].date === cal.prev(b.date) ? out[i - 1] + 1 : 1));
    return out;
  }

  /** HV 20D (decimal) per date of official closes; only over 21 consecutive sessions. */
  private hv20(bars: readonly { date: string; close: number }[], cal: TradingCalendar = this.md.calendar): Map<string, number> {
    const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));
    const run = this.runs(sorted, cal);
    const out = new Map<string, number>();
    sorted.forEach((b, i) => {
      if (run[i] < 21) return;
      const v = historicalVol(sorted.slice(i - 20, i + 1).map((x) => x.close), 20);
      if (Number.isFinite(v)) out.set(b.date, v);
    });
    return out;
  }

  /** Nearest listed option expiry with at least one calendar day left (the official ATM IV rule). */
  private ivExpiry(symbol: string): string | null {
    const minExp = addDays(this.md.calendarOf(symbol).session(this.now()).date, 1);
    return this.orElse(() => liveOptionExpiries(this.md, symbol).find((e) => e >= minExp) ?? null, null);
  }

  /** IV rank / percentile of `current` (decimal) over the IV_WINDOW sessions of official ATM IV before `asOf`. */
  private ivStats(symbol: string, current: number | null, asOf: string): { ivr: number | null; ivp: number | null; reason?: string } {
    if (current === null) return { ivr: null, ivp: null, reason: 'No current ATM IV' };
    const md = mdFor(this.md, symbol);
    const end = md.calendar.prev(asOf);
    const win = sessionsBack(md, end, IV_WINDOW);
    const hist = this.md.history.dailyAtmIv(symbol, win[0], end).map((x) => x.iv);
    if (hist.length < MIN_IV_HISTORY) {
      return { ivr: null, ivp: null, reason: `IV rank/percentile need ${IV_WINDOW} sessions of official ATM IV history (at least ${MIN_IV_HISTORY}); ${hist.length} loaded` };
    }
    const ivr = ivRank(current, hist);
    const ivp = ivPercentile(current, hist);
    if (ivr === null || ivp === null) return { ivr: null, ivp: null, reason: `The official ATM IV history of the last ${hist.length} sessions is flat: IV rank/percentile are undefined` };
    return { ivr: rn(ivr, 1), ivp: rn(ivp, 1) };
  }

  /** Previous-session close of an underlying for a session: the quote's (same session), else official. */
  private prevCloseOf(symbol: string, date: string): number | null {
    const q = this.md.live.quote(spotKey(symbol));
    if (q && isPos(q.prevClose) && sessionDateOf(mdFor(this.md, symbol), q.ts) === date) return q.prevClose;
    return eodClose(this.md, symbol, this.md.calendarOf(symbol).prev(date));
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Opening range breakout                                                                       */
  /* ------------------------------------------------------------------------------------------ */

  /**
   * Recorded traded 1-minute bars of an underlying on `date` (+ the minute in progress when `withLive`).
   * Null when nothing is recorded; NoLiveData when the recording started after the open.
   */
  private recordedDay(symbol: string, date: string, live: boolean, withLive: boolean): DayBars | null {
    const md = mdFor(this.md, symbol);
    const key = spotKey(symbol);
    const recs = byTs(md.intraday.bars(key, date));
    const open = md.calendar.ts(date, 0);
    let lb = live && withLive ? md.intraday.liveBar(key) : null;
    if (lb && (lb.ts < open || md.calendar.session(lb.ts).date !== date)) lb = null; // a bar of another session
    if (!recs.length && !lb) return null;
    const first = recs.length ? recs[0].ts : (lb as MinuteRecord).ts;
    if (first > open + ORB_OPEN_SLACK_MIN * MINUTE) throw new NoLiveData(`Recording of ${symbol} on ${date} starts at ${formatTimeIST(first)}: the opening range from ${formatTimeIST(open)} was not recorded`);
    const bars = recs.filter(traded).map(toBar);
    let partial = false;
    if (lb && lb.traded && (!bars.length || lb.ts > bars[bars.length - 1].ts)) {
      bars.push(toBar(lb));
      partial = lb.ts + MINUTE > this.now();
    }
    return { bars, partial, source: 'recorded' };
  }

  /** Kotak 1-minute candles of an underlying for a date the recorder does not hold (last 30 sessions). */
  private async kotakDay(symbol: string, date: string): Promise<DayBars> {
    const md = mdFor(this.md, symbol);
    const notRec = notRecordedReason(md, date, `${symbol} minutes`);
    const oldest = sessionsBack(md, currentSession(md), MAX_CANDLE_SESSIONS['1min'])[0];
    if (date < oldest) throw new NoLiveData(`${notRec}; Kotak 1-minute history is used for the last ${MAX_CANDLE_SESSIONS['1min']} sessions only`);
    let candles;
    try {
      candles = await md.candles(spotKey(symbol), '1min', date, date);
    } catch (e) {
      if (e instanceof NoLiveData) throw new NoLiveData(`${notRec}; Kotak 1-minute history: ${e.message}`);
      throw e;
    }
    const now = this.now();
    const bars: MinuteBar[] = [];
    for (const c of byTs(candles)) if (isPos(c.open) && isPos(c.high) && isPos(c.low) && isPos(c.close)) bars.push({ ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close });
    if (!bars.length) throw new NoLiveData(`${notRec}; Kotak returned no 1-minute candles`);
    if (bars[0].ts > md.calendar.ts(date, ORB_OPEN_SLACK_MIN)) throw new NoLiveData(`Kotak 1-minute history of ${symbol} on ${date} starts at ${formatTimeIST(bars[0].ts)}: the opening range is not covered`);
    const last = bars[bars.length - 1];
    return { bars, partial: last.ts + MINUTE > now, source: 'kotak' };
  }

  /**
   * Opening range on traded minutes. Before the range ends: core rules (forming). After: the range is
   * every bar that started before the range end (minutes without a trade have no bar), so a missing
   * minute never pulls a later bar into the range.
   */
  private evaluate(day: DayBars, symbol: string, date: string, evalTs: number, rangeMinutes: number, rule: OrbRule): OrbEvaluation {
    const rangeEnd = this.md.calendarOf(symbol).ts(date, rangeMinutes);
    if (evalTs < rangeEnd) return evaluateOpeningRange(day.bars, { rangeMinutes, rule, lastIsPartial: day.partial });
    const k = day.bars.filter((b) => b.ts < rangeEnd).length;
    if (!k) throw new NoLiveData(`No ${symbol} trade in the opening range (${formatTimeIST(this.md.calendarOf(symbol).ts(date, 0))} + ${rangeMinutes} min) on ${date}`);
    return { ...evaluateOpeningRange(day.bars, { rangeMinutes: k, rule, lastIsPartial: day.partial }), rangeMinutes };
  }

  /**
   * Opening-range evaluation on completed recorded minutes of the current session (rule 'close'):
   * the minute in progress never confirms a break. Used by alerts. NoLiveData before data exists.
   */
  orbConfirmed(symbol: string, _ts: number | undefined, rangeMinutes: number): OrbEvaluation {
    const md = mdFor(this.md, symbol);
    const s = md.ref.underlying(symbol).symbol;
    const now = this.now();
    const st = md.calendar.session(now);
    const date = currentSession(md, now);
    const live = date === st.date && st.status === 'open';
    const day = this.recordedDay(s, date, live, false);
    if (!day) throw new NoLiveData(notRecordedReason(md, date, `${s} minutes`));
    if (!day.bars.length) throw new NoLiveData(`No ${s} trade recorded on ${date} yet`);
    return this.evaluate(day, s, date, live ? now : md.calendar.ts(date, md.calendar.sessionMinutes(date)), clampInt(rangeMinutes, 1, 120, 15), 'close');
  }

  /**
   * Opening range of one session from recorded 1-minute bars (traded minutes only), else Kotak
   * 1-minute history (last 30 sessions). Live session: the minute in progress is the last bar. A
   * completed session reports its last price, change and day high/low only when its bars reach the
   * close (ORB_CLOSE_SLACK_MIN); else they are null with the reason in `gaps.day`.
   */
  async orb(symbol: string, _ts?: number, opts: { date?: string; rangeMinutes?: number; rule?: OrbRule } = {}): Promise<OrbResponse> {
    const md = mdFor(this.md, symbol);
    const s = md.ref.underlying(symbol).symbol;
    const rangeMinutes = clampInt(opts.rangeMinutes, 1, 120, 15);
    const rule = opts.rule ?? 'close';
    const date = requireDate(md, opts.date);
    const now = this.now();
    const st = md.calendar.session(now);
    const live = date === st.date && st.status === 'open';
    const day = this.recordedDay(s, date, live, true) ?? (await this.kotakDay(s, date));
    if (!day.bars.length) throw new NoLiveData(`No ${s} trade recorded on ${date} yet`);
    const last = day.bars[day.bars.length - 1];
    // Price vs range uses the price shown: the live LTP when there is one, else the last recorded close.
    const spotQ = live ? md.live.quote(spotKey(s)) : undefined;
    const liveLtp = live ? livePrice(md, spotQ) : null;
    const ev0 = this.evaluate(day, s, date, live ? now : md.calendar.ts(date, md.calendar.sessionMinutes(date)), rangeMinutes, rule);
    const ev = liveLtp !== null ? orbAtPrice(ev0, liveLtp) : ev0;
    const gaps = new Gaps();
    // A completed session's close and day range come from bars that reach its close only.
    const whole = live || last.ts >= md.calendar.ts(date, md.calendar.sessionMinutes(date) - ORB_CLOSE_SLACK_MIN);
    if (!whole) gaps.add('day', `${day.source === 'kotak' ? 'Kotak 1-minute history' : 'Recording'} of ${s} on ${date} ends at ${formatTimeIST(last.ts + MINUTE)}: the session's last price and day high/low are not known`);
    const ltp = whole ? (liveLtp ?? last.close) : null;
    return {
      symbol: s,
      date,
      rangeMinutes,
      rule,
      rangeStartTs: md.calendar.ts(date, 0),
      rangeEndTs: md.calendar.ts(date, rangeMinutes),
      live,
      ltp,
      changePct: changeOf(ltp, this.prevCloseOf(s, date)).changePct,
      dayHigh: whole ? Math.max(...day.bars.map((b) => b.high)) : null,
      dayLow: whole ? Math.min(...day.bars.map((b) => b.low)) : null,
      evaluation: ev,
      priceSource: liveLtp !== null ? 'ltp' : 'close',
      priceTs: liveLtp !== null && spotQ ? spotQ.ts : last.ts,
      summary: describeOrb(ev),
      bars: day.bars,
      source: day.source,
      ...gaps.out(),
    };
  }

  /** Market-wide opening-range scan of the current session (recorded minutes only; cached 5 s). Symbols without coverage are left out. */
  orbScan(_ts?: number, opts: { rangeMinutes?: number; rule?: OrbRule } = {}): OrbScanRow[] {
    const rangeMinutes = clampInt(opts.rangeMinutes, 1, 120, 15);
    const rule = opts.rule ?? 'close';
    return this.orbScanCache.get(`${rangeMinutes}|${rule}|${this.bucket()}`, () => this.computeOrbScan(rangeMinutes, rule));
  }

  private computeOrbScan(rangeMinutes: number, rule: OrbRule): OrbScanRow[] {
    const now = this.now();
    const rows: OrbScanRow[] = [];
    for (const u of this.md.ref.underlyings()) {
      // The opening range of each underlying's own session (MCX opens at 09:00).
      const md = mdFor(this.md, u.symbol);
      const st = md.calendar.session(now);
      const date = currentSession(md, now);
      const live = date === st.date && st.status === 'open';
      const evalTs = live ? now : md.calendar.ts(date, md.calendar.sessionMinutes(date));
      let day: DayBars | null;
      let ev: OrbEvaluation;
      try {
        day = this.recordedDay(u.symbol, date, live, true);
        if (!day?.bars.length) continue;
        ev = this.evaluate(day, u.symbol, date, evalTs, rangeMinutes, rule);
      } catch (e) {
        if (e instanceof NoLiveData) continue;
        throw e;
      }
      const ltp = ev.last;
      const lastBreak = ev.breaks[ev.breaks.length - 1] ?? null;
      const beyondPct = !lastBreak ? null : lastBreak.direction === 'up' ? ((ltp - ev.high) / ev.high) * 100 : ((ev.low - ltp) / ev.low) * 100;
      rows.push({
        symbol: u.symbol,
        name: u.name,
        kind: u.kind,
        sector: u.sector,
        ltp,
        changePct: changeOf(ltp, this.prevCloseOf(u.symbol, date)).changePct,
        high: ev.high,
        low: ev.low,
        widthPct: +ev.widthPct.toFixed(2),
        trend: ev.trend,
        whipsaw: ev.whipsaw,
        reentered: ev.reentered,
        position: ev.position,
        pending: ev.pending,
        breakTs: lastBreak?.ts ?? null,
        breakPrice: lastBreak?.price ?? null,
        beyondPct: beyondPct === null ? null : +beyondPct.toFixed(2),
        toHighPct: +ev.toHighPct.toFixed(2),
        toLowPct: +ev.toLowPct.toFixed(2),
        summary: describeOrb(ev),
      });
    }
    if (!rows.length) throw new NoLiveData(`No underlying has recorded 1-minute bars covering the ${currentSession(this.md, now)} opening range`);
    return rows;
  }

  /**
   * Opening-range outcome of each of the last `days` completed sessions: recorded days covering the
   * whole session, else Kotak 1-minute history (last 30 sessions). Other days are left out (gap).
   */
  async orbHistory(symbol: string, days: number, _ts?: number, opts: { rangeMinutes?: number; rule?: OrbRule } = {}): Promise<OrbHistoryResponse> {
    const md = mdFor(this.md, symbol);
    const s = md.ref.underlying(symbol).symbol;
    const rangeMinutes = clampInt(opts.rangeMinutes, 1, 120, 15);
    const rule = opts.rule ?? 'close';
    const n = clampInt(days, 1, 250, 20);
    const now = this.now();
    const st = md.calendar.session(now);
    const cur = currentSession(md, now);
    const lastDone = cur === st.date && st.status === 'open' ? md.calendar.prev(cur) : cur;
    const dates = sessionsBack(md, lastDone, n);
    const endOk = (d: string, b: DayBars) => b.bars.length > 0 && b.bars[b.bars.length - 1].ts >= md.calendar.ts(d, md.calendar.sessionMinutes(d) - ORB_CLOSE_SLACK_MIN);
    const byDate = new Map<string, DayBars>();
    const missing: string[] = [];
    const why: string[] = [];
    for (const d of dates) {
      try {
        const day = this.recordedDay(s, d, false, false);
        if (day && endOk(d, day)) byDate.set(d, day);
        else missing.push(d);
        if (day && !endOk(d, day)) why.push(`${d}: recording ends before the close`);
      } catch (e) {
        if (!(e instanceof NoLiveData)) throw e;
        missing.push(d);
        why.push(e.message);
      }
    }
    // Kotak 1-minute history for the missing recent sessions (one ranged request).
    const oldest = sessionsBack(md, currentSession(md, now), MAX_CANDLE_SESSIONS['1min'])[0];
    const recent = missing.filter((d) => d >= oldest);
    if (recent.length) {
      try {
        const candles = await md.candles(spotKey(s), '1min', recent[0], recent[recent.length - 1]);
        const grouped = new Map<string, MinuteBar[]>();
        for (const c of byTs(candles)) {
          if (!isPos(c.open) || !isPos(c.high) || !isPos(c.low) || !isPos(c.close)) continue;
          const d = md.calendar.session(c.ts).date;
          if (!recent.includes(d)) continue;
          let l = grouped.get(d);
          if (!l) grouped.set(d, (l = []));
          l.push({ ts: c.ts, open: c.open, high: c.high, low: c.low, close: c.close });
        }
        for (const [d, bars] of grouped) {
          const day: DayBars = { bars, partial: false, source: 'kotak' };
          if (bars[0].ts <= md.calendar.ts(d, ORB_OPEN_SLACK_MIN) && endOk(d, day)) byDate.set(d, day);
        }
      } catch (e) {
        if (!(e instanceof NoLiveData)) throw e;
        why.push(`Kotak 1-minute history: ${e.message}`);
      }
    }
    const rows: OrbHistoryRow[] = [];
    for (const d of dates) {
      const day = byDate.get(d);
      if (!day) continue;
      let ev: OrbEvaluation;
      try {
        ev = this.evaluate(day, s, d, md.calendar.ts(d, md.calendar.sessionMinutes(d)), rangeMinutes, rule);
      } catch (e) {
        if (!(e instanceof NoLiveData)) throw e;
        why.push(e.message);
        continue;
      }
      const close = day.bars[day.bars.length - 1].close;
      const first = ev.breaks[0] ?? null;
      const follow = !first ? null : first.direction === 'up' ? ((close - ev.high) / ev.high) * 100 : ((ev.low - close) / ev.low) * 100;
      const hi = Math.max(...day.bars.map((b) => b.high));
      const lo = Math.min(...day.bars.map((b) => b.low));
      rows.push({
        date: d,
        high: ev.high,
        low: ev.low,
        widthPct: +ev.widthPct.toFixed(2),
        trend: ev.trend,
        whipsaw: ev.whipsaw,
        firstBreak: first ? { direction: first.direction, ts: first.ts } : null,
        close,
        closeVsRange: close > ev.high ? 'above' : close < ev.low ? 'below' : 'inside',
        followThroughPct: follow === null ? null : +follow.toFixed(2),
        dayRangePct: +(((hi - lo) / lo) * 100).toFixed(2),
        source: day.source,
      });
    }
    if (!rows.length) throw new NoLiveData(`No ${s} session of the last ${n} has recorded or Kotak 1-minute bars covering the day (${notRecordedReason(md, lastDone, 'minutes')})`);
    const gaps = new Gaps();
    if (rows.length < dates.length) gaps.add('sessions', `${dates.length - rows.length} of ${dates.length} sessions have no recorded or Kotak 1-minute bars covering the whole day${why.length ? ` (${why.slice(0, 3).join('; ')}${why.length > 3 ? '; …' : ''})` : ''}`);
    const broke = rows.filter((r) => r.firstBreak);
    const trendDays = broke.filter((r) => r.closeVsRange === (r.firstBreak!.direction === 'up' ? 'above' : 'below')).length;
    return {
      symbol: s,
      rangeMinutes,
      rule,
      sessions: dates.length,
      rows: rows.reverse(),
      stats: {
        days: rows.length,
        brokeUp: rows.filter((r) => r.firstBreak?.direction === 'up').length,
        brokeDown: rows.filter((r) => r.firstBreak?.direction === 'down').length,
        sideways: rows.filter((r) => !r.firstBreak).length,
        whipsaw: rows.filter((r) => r.whipsaw).length,
        trendDays,
        avgFollowThroughPct: rn(avg(broke.map((r) => r.followThroughPct).filter(isNum)), 2),
      },
      ...gaps.out(),
    };
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Open interest                                                                                */
  /* ------------------------------------------------------------------------------------------ */

  /**
   * Strike-wise OI of the live chain (or the recorded chain at `at`) and its change: vs the previous
   * close (quote prevOi, else the official previous-session OI) or, with `fromTs`, vs the recorded
   * chain at that time of the same session (md.intraday.chainAt).
   */
  async strikeOi(symbol: string, expiryIn?: string, at?: number, fromTs?: number): Promise<StrikeOiResponse> {
    const md = mdFor(this.md, symbol);
    const chain = await buildOptionChain(md, symbol, this.checkExpiry(expiryIn), { at });
    const now = this.now();
    const asOf = at !== undefined && at < now;
    const toTs = chain.ts;
    const gaps = new Gaps();
    for (const k of ['spot', 'oi'] as const) if (chain.gaps?.[k]) gaps.add(k, chain.gaps[k]);
    const session = asOf ? onOrBefore(md, md.calendar.session(toTs).date) : currentSession(md, now);
    let from: StrikeOiResponse['from'] = 'prev-close';
    const prevSession = md.calendar.prev(session);
    let fromAt = md.calendar.ts(prevSession, md.calendar.sessionMinutes(prevSession));
    let base: Map<string, number> | null = null;
    if (fromTs !== undefined && Number.isFinite(fromTs) && fromTs < toTs) {
      const t = Math.max(fromTs, md.calendar.ts(session, 1));
      from = 'recorded';
      fromAt = t;
      const rec = t < toTs ? md.intraday.chainAt(chain.symbol, chain.expiry, t) : undefined;
      if (!rec) gaps.add('change', `No recorded ${chain.symbol} ${chain.expiry} chain at ${formatTimeIST(t)} on ${session} (${notRecordedReason(md, session, 'chain')})`);
      else {
        base = new Map();
        for (const row of rec.rows) {
          if (isNum(row.ce?.oi)) base.set(`CE|${row.strike}`, row.ce.oi);
          if (isNum(row.pe?.oi)) base.set(`PE|${row.strike}`, row.pe.oi);
        }
      }
    } else if (chain.gaps?.oiChange) gaps.add('change', chain.gaps.oiChange);
    const baseOf = (type: OptKind, strike: number, q: OptionQuote): number | null => (from === 'prev-close' ? q.prevOi : (base?.get(`${type}|${strike}`) ?? null));
    const rows = chain.rows
      .filter((row) => row.ce.oi !== null || row.pe.oi !== null)
      .map((row) => {
        const cb = baseOf('CE', row.strike, row.ce);
        const pb = baseOf('PE', row.strike, row.pe);
        return {
          strike: row.strike,
          ceOi: row.ce.oi,
          peOi: row.pe.oi,
          ceChange: row.ce.oi !== null && cb !== null ? row.ce.oi - cb : null,
          peChange: row.pe.oi !== null && pb !== null ? row.pe.oi - pb : null,
          ceVolume: row.ce.volume,
          peVolume: row.pe.volume,
        };
      });
    if (!rows.length) throw new NoLiveData(`No open interest in the ${chain.symbol} ${chain.expiry} chain${asOf ? ` recorded at ${formatTimeIST(toTs)}` : ''}`);
    if (from === 'recorded' && base && rows.some((r) => (r.ceOi !== null && r.ceChange === null) || (r.peOi !== null && r.peChange === null))) {
      gaps.add('change', `Some strikes were not recorded at ${formatTimeIST(fromAt)}: their change is blank`);
    }
    return {
      symbol: chain.symbol,
      expiry: chain.expiry,
      spot: chain.spot,
      fromTs: fromAt,
      from,
      toTs,
      rows,
      maxPain: chain.maxPain,
      pcr: chain.pcr,
      coverage: chain.coverage,
      ...gaps.out(),
    };
  }

  /** Recorded minute series (OI, traded premium, IV solved from it) of chosen strikes of one session. */
  multiStrike(symbol: string, expiryIn: string | undefined, strikesIn: number[], date: string | undefined, interval: number, _ts?: number): MultiStrikeResponse {
    const md = mdFor(this.md, symbol);
    const u = md.ref.underlying(symbol);
    const s = u.symbol;
    const day = requireDate(md, date);
    requireRecorded(md, day);
    const expiry = this.recordedExpiry(s, day, expiryIn);
    const mk = this.requireMarks(this.marks(day, interval, s));
    const gaps = new Gaps();
    const recorded = this.recordedStrikes(s, expiry, day);
    const spotRecs = byTs(md.intraday.bars(spotKey(s), day));
    const spot = inWindows(spotRecs, mk.starts, mk.times, traded).map((r) => r?.close ?? null);

    let strikes = [...new Set(strikesIn.filter((k) => isPos(k)))];
    if (!strikes.length) {
      const nearest = (x: number) => recorded.reduce((a, k) => (Math.abs(k - x) < Math.abs(a - x) ? k : a));
      const cm = md.intraday.chainSeries(s, expiry, day).at(-1);
      const ref = cm?.atmStrike ?? spotRecs.filter(traded).at(-1)?.close;
      if (!recorded.length || ref === undefined) throw new NoLiveData(`No recorded ${s} price or chain on ${day} to pick the strikes around ATM`);
      const atm = nearest(ref);
      strikes = [...new Set([nearest(atm - 2 * u.strikeStep), atm, nearest(atm + 2 * u.strikeStep)])];
    }
    strikes.sort((a, b) => a - b);
    const notRec = strikes.filter((k) => !recorded.includes(k));
    if (notRec.length) gaps.add('strikes', `Not recorded on ${day}: ${notRec.join(', ')} (only streamed strikes are recorded)`);

    const legs = new Map<string, { oi: (number | null)[]; ltp: (number | null)[] }>();
    for (const strike of strikes) {
      for (const type of ['CE', 'PE'] as const) {
        const recs = byTs(md.intraday.bars(optKey(s, expiry, type, strike), day));
        legs.set(`${type}|${strike}`, {
          oi: inWindows(recs, mk.starts, mk.times).map((r) => (r && isNum(r.oi) ? r.oi : null)),
          ltp: inWindows(recs, mk.starts, mk.times, traded).map((r) => r?.close ?? null),
        });
      }
    }
    const futRecs = byTs(md.intraday.bars(futKey(s, expiry), day));
    const fut = inWindows(futRecs, mk.starts, mk.times, traded).map((r) => r?.close ?? null);
    const r = md.pricing.r;
    const forward = mk.times.map((t, k) => {
      const rows: PremiumRow[] = strikes.map((strike) => ({ strike, ce: legs.get(`CE|${strike}`)!.ltp[k] ?? undefined, pe: legs.get(`PE|${strike}`)!.ltp[k] ?? undefined }));
      return impliedForward({ spot: spot[k] ?? undefined, future: fut[k] ?? undefined, rows }, timeToExpiry(expiry, t, md.calendar.exchange), r)?.forward ?? null;
    });
    const series: MultiStrikeResponse['series'] = [];
    for (const strike of strikes) {
      for (const type of ['CE', 'PE'] as const) {
        const leg = legs.get(`${type}|${strike}`)!;
        const iv = leg.ltp.map((p, k) => {
          const F = forward[k];
          return p !== null && F !== null ? pct(md.pricing.iv({ symbol: s, expiry, type, strike, premium: p, ts: mk.times[k], forward: F })) : null;
        });
        series.push({ strike, type, oi: leg.oi, ltp: leg.ltp, iv });
      }
    }
    return { symbol: s, expiry, date: day, times: mk.times, spot, series, ...gaps.out() };
  }

  /**
   * Recorded chain minutes of one session (md.intraday.chainSeries): totals, PCR, max pain and ATM IV
   * of the streamed strikes; OI change vs the previous close over recorded strikes that have an
   * official previous-close OI, each at its OI as of the point (last recorded value of the session).
   */
  oiTrend(symbol: string, expiryIn: string | undefined, date: string | undefined, interval: number, _ts?: number): OiTrendResponse {
    const md = mdFor(this.md, symbol);
    const s = md.ref.underlying(symbol).symbol;
    const day = requireDate(md, date);
    requireRecorded(md, day);
    const expiry = this.chainExpiry(s, day, expiryIn);
    const mk = this.requireMarks(this.marks(day, interval, s));
    const gaps = new Gaps();
    const picks = inWindows(byTs(md.intraday.chainSeries(s, expiry, day)), mk.starts, mk.times);
    const prevDate = md.calendar.prev(day);
    const eod = this.eodOptions(s, expiry, prevDate);
    const ceSum: (number | null)[] = mk.times.map(() => null);
    const peSum: (number | null)[] = mk.times.map(() => null);
    if (!eod.size) gaps.add('change', `Official F&O file for ${prevDate} not loaded (or has no ${s} ${expiry} rows): OI change vs the previous close is blank`);
    else {
      for (const k of md.intraday.recordedKeys(day)) {
        if (k.symbol !== s || k.expiry !== expiry || (k.kind !== 'CE' && k.kind !== 'PE') || !isNum(k.strike)) continue;
        const prev = eod.get(`${k.kind}|${k.strike}`);
        if (!prev || !isNum(prev.oi)) continue;
        const sums = k.kind === 'CE' ? ceSum : peSum;
        // The strike's OI as of each point (its last recorded OI of the session, the chainAt rule, as
        // the recorded chain totals): a strike that did not tick inside one window still counts, so
        // the sum never silently drops strikes from one point to the next.
        inWindows(byTs(md.intraday.bars(k, day)), mk.times.map(() => mk.open), mk.times, (rec) => isNum(rec.oi)).forEach((rec, i) => {
          if (rec && isNum(rec.oi)) sums[i] = (sums[i] ?? 0) + (rec.oi - prev.oi);
        });
      }
    }
    const points: OiTrendPoint[] = [];
    mk.times.forEach((t, i) => {
      const cm = picks[i];
      if (!cm) return;
      points.push({
        ts: t,
        spot: isPos(cm.spot) ? cm.spot : null,
        ceOi: cm.ceOi,
        peOi: cm.peOi,
        ceChange: ceSum[i],
        peChange: peSum[i],
        pcr: rn(cm.pcr, 3),
        maxPain: cm.maxPain,
        atmIv: pct(cm.atmIv),
      });
    });
    if (!points.length) throw new NoLiveData(`No recorded ${s} ${expiry} chain minutes on ${day}`);
    return { symbol: s, expiry, date: day, points, coverage: `Recorded chain totals: ${RECORDED_CHAIN_COVERAGE}. OI change: recorded strikes with an official previous-close OI.`, ...gaps.out() };
  }

  /** PCR per session from the official F&O bhavcopy: every strike of the nearest expiry (≥ that date), real OI only. */
  dailyPcr(symbol: string, days: number, _ts?: number): DailyPcrPoint[] {
    const md = mdFor(this.md, symbol);
    const s = md.ref.underlying(symbol).symbol;
    const n = clampInt(days, 1, 250, 30);
    const loaded = new Set(md.history.loadedDates('fo'));
    const out: DailyPcrPoint[] = [];
    for (const d of sessionsBack(md, currentSession(md), n)) {
      if (!loaded.has(d)) continue;
      const opts = md.history.dailyOptions(s, d);
      const expiry = [...new Set(opts.map((o) => o.expiry))].filter((e) => e >= d).sort()[0];
      if (!expiry) continue;
      let ce = 0;
      let pe = 0;
      for (const o of opts) {
        if (o.expiry !== expiry || !isNum(o.oi)) continue;
        if (o.type === 'CE') ce += o.oi;
        else pe += o.oi;
      }
      if (!(ce > 0)) continue;
      out.push({ date: d, pcr: +(pe / ce).toFixed(3), close: eodClose(md, s, d), expiry });
    }
    return out;
  }

  /** Intraday PCR (recorded chain minutes) and daily PCR (official files); 503 only when both are missing. */
  pcr(symbol: string, expiryIn: string | undefined, date: string | undefined, interval: number, days: number): PcrResponse {
    const s = this.md.ref.underlying(symbol).symbol;
    const gaps = new Gaps();
    const trend = gaps.try('intraday', () => this.oiTrend(s, expiryIn, date, interval));
    const daily = this.dailyPcr(s, days);
    if (!daily.length) gaps.add('daily', `No official F&O bhavcopy with ${s} options loaded for the last ${clampInt(days, 1, 250, 30)} sessions`);
    if (!trend && !daily.length) throw new NoLiveData(Object.values(gaps.out().gaps ?? {}).join('; '));
    if (trend?.gaps) for (const [k, v] of Object.entries(trend.gaps)) gaps.add(`intraday.${k}`, v);
    return {
      symbol: s,
      expiry: trend?.expiry ?? null,
      intraday: (trend?.points ?? []).map((p) => ({ ts: p.ts, pcr: p.pcr, spot: p.spot, ceOi: p.ceOi, peOi: p.peOi, ceChange: p.ceChange, peChange: p.peChange, changePcr: changePcrOf(p.ceChange, p.peChange, p.ceOi) })),
      daily,
      coverage: { intraday: `Recorded chain totals: ${RECORDED_CHAIN_COVERAGE}`, daily: 'Official F&O bhavcopy: every strike of the nearest expiry' },
      ...gaps.out(),
    };
  }

  /** Max pain of the live chain (strikes with OI on both sides) and its drift through the recorded session. */
  async maxPainDetail(symbol: string, expiryIn?: string, _ts?: number): Promise<MaxPainResponse> {
    const sOi = await this.strikeOi(symbol, expiryIn);
    const gaps = new Gaps();
    const oiRows = sOi.rows.filter((r) => r.ceOi !== null && r.peOi !== null).map((r) => ({ strike: r.strike, ceOI: r.ceOi as number, peOI: r.peOi as number }));
    const mp = oiRows.length ? maxPain(oiRows) : null;
    if (!mp) gaps.add('pain', 'No strike has open interest on both sides');
    const trend = gaps.try('history', () => this.oiTrend(sOi.symbol, sOi.expiry, undefined, 15));
    return {
      symbol: sOi.symbol,
      expiry: sOi.expiry,
      spot: sOi.spot,
      maxPain: mp && Number.isFinite(mp.maxPain) ? mp.maxPain : null,
      pain: mp?.pain ?? [],
      history: (trend?.points ?? []).map((p) => ({ ts: p.ts, maxPain: p.maxPain, spot: p.spot })),
      coverage: sOi.coverage,
      ...gaps.out(),
    };
  }

  /** Near-month future of every underlying: live LTP/OI vs the previous close/OI (quote, else the official files). Cached 5 s. */
  futuresBuildUp(_ts?: number): FuturesBuildUpRow[] {
    return this.futCache.get(this.bucket(), () => this.computeFutures());
  }

  private computeFutures(): FuturesBuildUpRow[] {
    const now = this.now();
    const rows: FuturesBuildUpRow[] = [];
    for (const u of this.md.ref.underlyings()) {
      // Each underlying in its own exchange's sessions (MCX commodities: MCX's).
      const md = mdFor(this.md, u.symbol);
      const row = this.nearFutureRow(u, now, liveDates(md), currentSession(md, now));
      if (row) rows.push(row);
    }
    if (!rows.some((r) => r.ltp !== null || r.oi !== null)) throw new NoLiveData('No live futures quotes yet');
    return rows;
  }

  private nearFutureRow(u: Underlying, now: number, dates: ReadonlySet<string>, session: string): FuturesBuildUpRow | null {
    const md = mdFor(this.md, u.symbol);
    const fe = nearFuture(md, u.symbol, now);
    if (!fe) return null;
    const key = futKey(u.symbol, fe);
    const q = md.live.quote(key);
    const prevDate = md.calendar.prev(q ? sessionDateOf(md, q.ts) : session);
    const eod = this.eodFuture(u.symbol, fe, prevDate);
    const ltp = livePrice(md, q, dates);
    const prevClose = q && isPos(q.prevClose) ? q.prevClose : tradedClose(eod);
    const oi = q && isNum(q.oi) ? q.oi : null;
    const prevOi = q && isNum(q.prevOi) ? q.prevOi : eod && isNum(eod.oi) ? eod.oi : null;
    const ch = changeOf(ltp, prevClose);
    const oiChange = oi !== null && prevOi !== null ? oi - prevOi : null;
    const lot = this.orElse(() => md.ref.listing(key)?.lotSize, undefined) ?? u.lotSize;
    return {
      symbol: u.symbol,
      name: u.name,
      sector: u.sector,
      kind: u.kind,
      expiry: fe,
      ltp,
      changePct: ch.changePct,
      oi,
      oiChangePct: oiChange !== null && prevOi ? r2((oiChange / prevOi) * 100) : null,
      volume: q && isNum(q.volume) ? q.volume : null,
      buildUp: ch.change !== null && oiChange !== null ? classifyBuildUp(ch.change, oiChange) : null,
      lotSize: lot,
      ts: q?.ts ?? null,
    };
  }

  /**
   * Build-up breadth of the stock futures: today from the live near futures (stocks without a live
   * classification are not counted), history from the official files (spot close change vs the change
   * of the total futures OI of the same contracts; new contracts count in full).
   */
  breadth(_ts?: number, historyDays = 20): BreadthResponse {
    const md = this.md;
    const gaps = new Gaps();
    const stocks = md.ref.underlyings().filter((u) => u.kind === 'stock');
    let noLive: string | undefined;
    const live = this.orElse(() => this.futuresBuildUp(), [] as FuturesBuildUpRow[], (why) => (noLive = why)).filter((r) => r.kind === 'stock');
    if (!live.length) gaps.add('overall', noLive ?? 'No live stock futures');
    const overall = emptyCounts();
    const sectors = new Map<string, { counts: BuildUpCounts; symbols: FuturesBuildUpRow[] }>();
    let classified = 0;
    for (const r of live) {
      const sec = sectors.get(r.sector || 'Other') ?? { counts: emptyCounts(), symbols: [] };
      sec.symbols.push(r);
      if (r.buildUp) {
        overall[r.buildUp]++;
        sec.counts[r.buildUp]++;
        classified++;
      }
      sectors.set(r.sector || 'Other', sec);
    }
    if (classified < live.length) gaps.add('overall', `${live.length - classified} of ${live.length} stock futures have no live price/OI change vs the previous close yet`);

    const session = currentSession(md);
    const n = clampInt(historyDays, 1, 250, 20);
    const fo = md.history.loadedDates('fo').filter((d) => d < session).slice(-(n + 1));
    const history: BreadthResponse['history'] = [];
    if (fo.length >= 2) {
      const from = fo[0];
      const to = fo[fo.length - 1];
      const data = stocks.map((u) => ({
        closes: new Map(md.history.dailyBars(u.symbol, from, to).map((b) => [b.date, b.close])),
        oi: (() => {
          const m = new Map<string, Map<string, number>>();
          for (const f of md.history.dailyFutures(u.symbol, from, to)) {
            if (!isNum(f.oi)) continue;
            let x = m.get(f.date);
            if (!x) m.set(f.date, (x = new Map()));
            x.set(f.expiry, f.oi);
          }
          return m;
        })(),
      }));
      for (let i = 1; i < fo.length; i++) {
        const d = fo[i];
        const p = fo[i - 1];
        if (p !== md.calendar.prev(d)) continue; // a missing session: no one-day change
        const counts = emptyCounts();
        let c = 0;
        for (const x of data) {
          const cd = x.closes.get(d);
          const cp = x.closes.get(p);
          const od = x.oi.get(d);
          const op = x.oi.get(p);
          if (!isPos(cd) || !isPos(cp) || !od?.size || !op?.size) continue;
          let dOi = 0;
          for (const [exp, v] of od) dOi += v - (op.get(exp) ?? 0);
          counts[classifyBuildUp(cd - cp, dOi)]++;
          c++;
        }
        if (c) history.push({ date: d, counts, classified: c, source: 'eod' });
      }
    }
    if (!history.length) gaps.add('history', 'No two consecutive sessions of official F&O and CM files loaded');
    if (classified) history.push({ date: session, counts: overall, classified, source: 'live' });
    if (!live.length && !history.length) throw new NoLiveData('No live stock futures and no official F&O history loaded');
    return {
      // Counts only over classified futures: with none classified there is no count (never a row of 0s).
      overall: classified ? overall : null,
      classified,
      total: stocks.length,
      sectors: [...sectors.entries()]
        .map(([sector, v]) => ({ sector, counts: v.symbols.some((x) => x.buildUp) ? v.counts : null, symbols: v.symbols }))
        .sort((a, b) => b.symbols.length - a.symbols.length),
      history,
      ...gaps.out(),
    };
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Official FII/DII and participant-wise OI                                                     */
  /* ------------------------------------------------------------------------------------------ */

  /** The last `days` trading sessions up to the current one, as a [from, to] range (for ?days= routes). */
  rangeOf(days: number): { from: string; to: string } {
    const to = currentSession(this.md);
    return { from: sessionsBack(this.md, to, clampInt(days, 1, 250, 30))[0], to };
  }

  private checkRange(from: string, to: string): void {
    if (!isIsoDate(from) || !isIsoDate(to)) throw httpError(400, `from/to must be YYYY-MM-DD (got '${from}', '${to}')`);
    if (from > to) throw httpError(400, `from (${from}) is after to (${to})`);
  }

  /** NSE participant-wise OI of the sessions in [from, to] as published (official files only). */
  participants(from: string, to: string): ParticipantDay[] {
    this.checkRange(from, to);
    const days = this.md.history.participantOi(from, to);
    if (!days.length) {
      const last = this.md.history.loadedDates('participants').at(-1);
      throw new NoLiveData(`NSE participant-wise OI is not loaded for ${from}..${to}${last ? ` (latest loaded: ${last})` : ' (none loaded yet)'}`);
    }
    return days;
  }

  /**
   * FII/DII cash flows of the sessions in [from, to] as stored (NIFTY close/change from the official
   * index file of the same date). Each day keeps its `scope`: sum only 'combined' days (sumFiiDii).
   */
  fiiDii(from: string, to: string): FiiDiiDay[] {
    this.checkRange(from, to);
    const days = this.md.history.fiiDii(from, to);
    if (!days.length) {
      const last = this.md.history.loadedDates('fiidii').at(-1);
      throw new NoLiveData(`FII/DII figures are not loaded for ${from}..${to}${last ? ` (latest loaded: ${last})` : ' (none loaded yet)'}`);
    }
    return days;
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Volatility                                                                                   */
  /* ------------------------------------------------------------------------------------------ */

  /** Official daily ATM IV (bhavcopy closes, nearest expiry with ≥ 1 day left), HV 20D and close of the last `days` sessions. */
  ivHistory(symbol: string, days: number, _ts?: number): IvChartResponse['daily'] {
    const md = mdFor(this.md, symbol);
    const s = md.ref.underlying(symbol).symbol;
    const n = clampInt(days, 1, 400, 120);
    const cur = currentSession(md);
    const from = sessionsBack(md, cur, n)[0];
    const warm = sessionsBack(md, from, 22)[0];
    const atm = new Map(md.history.dailyAtmIv(s, from, cur).map((x) => [x.date, x]));
    const bars = md.history.dailyBars(s, warm, cur);
    const hv = this.hv20(bars, md.calendar);
    const closes = new Map(bars.map((b) => [b.date, b.close]));
    const dates = [...new Set([...atm.keys(), ...bars.map((b) => b.date).filter((d) => d >= from)])].sort();
    if (!dates.length) throw new NoLiveData(`No official ATM IV or daily closes of ${s} loaded for ${from}..${cur}`);
    return dates.map((d) => ({ date: d, iv: pct(atm.get(d)?.iv), hv: pct(hv.get(d)), close: closes.get(d) ?? null, expiry: atm.get(d)?.expiry ?? null }));
  }

  /** Intraday ATM IV of a recorded session, official daily ATM IV/HV, IV rank and percentile. */
  ivChart(symbol: string, expiryIn: string | undefined, date: string | undefined, interval: number, days: number, _ts?: number): IvChartResponse {
    const md = mdFor(this.md, symbol);
    const s = md.ref.underlying(symbol).symbol;
    const day = requireDate(md, date);
    const gaps = new Gaps();
    const intra = gaps.try('intraday', () => this.intradayIv(s, day, expiryIn, interval));
    const daily = gaps.try('daily', () => this.ivHistory(s, days)) ?? [];
    const live = this.ivExpiry(s);
    const liveIv = live ? md.pricing.atmIv(s, live) : null;
    const lastDaily = [...daily].reverse().find((d) => d.iv !== null);
    const lastIv = lastDaily && lastDaily.iv !== null ? lastDaily.iv / 100 : null;
    const current = liveIv ?? lastIv;
    const asOf = liveIv !== null ? currentSession(md) : (lastDaily?.date ?? currentSession(md));
    if (liveIv === null) gaps.add('currentIv', lastDaily ? `No live ATM IV: the latest official one (${lastDaily.date}) is used` : 'No live or official ATM IV');
    const st = this.ivStats(s, current, asOf);
    if (st.reason) gaps.add('ivr', st.reason);
    if (!intra?.points.length && !daily.length && current === null) throw new NoLiveData(Object.values(gaps.out().gaps ?? {}).join('; '));
    return { symbol: s, expiry: intra?.expiry ?? null, date: day, intraday: intra?.points ?? [], daily, currentIv: pct(current), ivr: st.ivr, ivp: st.ivp, ...gaps.out() };
  }

  private intradayIv(s: string, day: string, expiryIn: string | undefined, interval: number): { expiry: string; points: IvChartResponse['intraday'] } {
    const md = mdFor(this.md, s);
    requireRecorded(md, day);
    const expiry = this.chainExpiry(s, day, expiryIn);
    const mk = this.requireMarks(this.marks(day, interval, s));
    const picks = inWindows(byTs(md.intraday.chainSeries(s, expiry, day)), mk.starts, mk.times);
    const fut = inWindows(byTs(md.intraday.bars(futKey(s, expiry), day)), mk.starts, mk.times, traded);
    const legs = new Map<string, MinuteRecord[]>();
    const legClose = (type: OptKind, strike: number, k: number): number | null => {
      const id = `${type}|${strike}`;
      let recs = legs.get(id);
      if (!recs) legs.set(id, (recs = byTs(md.intraday.bars(optKey(s, expiry, type, strike), day))));
      return inWindows(recs, [mk.starts[k]], [mk.times[k]], traded)[0]?.close ?? null;
    };
    const r = md.pricing.r;
    const points: IvChartResponse['intraday'] = [];
    mk.times.forEach((t, k) => {
      const cm = picks[k];
      if (!cm) return;
      const K = cm.atmStrike;
      const ce = legClose('CE', K, k);
      const pe = legClose('PE', K, k);
      const F = impliedForward({ spot: isPos(cm.spot) ? cm.spot : undefined, future: fut[k]?.close, rows: ce !== null && pe !== null ? [{ strike: K, ce, pe }] : [] }, timeToExpiry(expiry, t, md.calendar.exchange), r)?.forward ?? null;
      const iv = (type: OptKind, p: number | null) => (p !== null && F !== null ? pct(md.pricing.iv({ symbol: s, expiry, type, strike: K, premium: p, ts: t, forward: F })) : null);
      points.push({ ts: t, spot: isPos(cm.spot) ? cm.spot : null, atmIv: pct(cm.atmIv), ceIv: iv('CE', ce), peIv: iv('PE', pe) });
    });
    if (!points.length) throw new NoLiveData(`No recorded ${s} ${expiry} chain minutes on ${day}`);
    return { expiry, points };
  }

  /** ATM IV, its change, IV rank/percentile and HV of every underlying (cached 5 s). */
  ivTable(_ts?: number): IvTableRow[] {
    return this.ivCache.get(this.bucket(), () => this.computeIvTable());
  }

  private computeIvTable(): IvTableRow[] {
    const rows: IvTableRow[] = this.md.ref.underlyings().map((u) => {
      // Each underlying in its own exchange's sessions (MCX commodities: MCX's).
      const md = mdFor(this.md, u.symbol);
      const session = currentSession(md);
      const prevDate = md.calendar.prev(session);
      const gaps = new Gaps();
      const q = gaps.try('quote', () => this.spotNow(u.symbol));
      const expiry = this.ivExpiry(u.symbol);
      const ivDec = expiry ? md.pricing.atmIv(u.symbol, expiry) : null;
      if (ivDec === null) gaps.add('iv', expiry ? `ATM IV of ${u.symbol} ${expiry} could not be solved from live premiums` : `No listed ${u.symbol} option expiry`);
      const prevIv = expiry ? eodAtmIvOf(md, u.symbol, expiry, prevDate) : null;
      if (ivDec !== null && prevIv === null) gaps.add('ivChange', u.kind === 'commodity' ? `No recorded option closes of ${u.symbol} ${expiry} for the ${prevDate} MCX session` : `No traded official option closes of ${u.symbol} ${expiry} for ${prevDate}`);
      const st = this.ivStats(u.symbol, ivDec, session);
      if (ivDec !== null && st.reason) gaps.add('ivr', st.reason);
      const bars = md.history.dailyBars(u.symbol, sessionsBack(md, session, 30)[0], session);
      const hvDec = bars.length ? (this.hv20(bars, md.calendar).get(bars[bars.length - 1].date) ?? null) : null;
      if (hvDec === null) gaps.add('hv', u.kind === 'commodity' ? `HV 20D needs 21 consecutive MCX sessions of ${u.symbol} recorded by this app from open to close` : `HV 20D needs 21 consecutive official closes of ${u.symbol}`);
      const iv = pct(ivDec);
      const hv = pct(hvDec);
      return {
        symbol: u.symbol,
        kind: u.kind,
        sector: u.sector,
        ltp: q?.ltp ?? null,
        changePct: q?.changePct ?? null,
        iv,
        ivChange: ivDec !== null && prevIv !== null ? r2((ivDec - prevIv) * 100) : null,
        ivr: st.ivr,
        ivp: st.ivp,
        hv,
        ivHvSpread: iv !== null && hv !== null ? r2(iv - hv) : null,
        expiry,
        ...gaps.out(),
      };
    });
    if (!rows.some((r) => r.iv !== null || r.ltp !== null)) throw new NoLiveData('No live underlying price or ATM IV yet');
    return rows;
  }

  /** Live spot price and change of an underlying (NoLiveData when it has not traded in the live session). */
  private spotNow(symbol: string): { ltp: number; changePct: number | null } {
    const md = mdFor(this.md, symbol);
    const q = md.live.quote(spotKey(symbol));
    const ltp = livePrice(md, q);
    if (!q || ltp === null) throw new NoLiveData(`No live price for ${symbol}`);
    const prev = isPos(q.prevClose) ? q.prevClose : eodClose(md, symbol, md.calendar.prev(sessionDateOf(md, q.ts)));
    return { ltp, changePct: changeOf(ltp, prev).changePct };
  }

  /**
   * IV per listed strike of up to 5 expiries, solved from live premiums (no fill-in); with
   * compare='prev', the same expiries at the previous session's official traded closes.
   */
  async skew(symbol: string, expiriesIn: string[], _ts?: number, compare: 'none' | 'prev' = 'none'): Promise<SkewResponse> {
    const md = mdFor(this.md, symbol);
    const s = md.ref.underlying(symbol).symbol;
    const listed = liveOptionExpiries(md, s);
    let chosen: string[];
    if (expiriesIn.length) {
      for (const e of expiriesIn) this.checkExpiry(e);
      chosen = expiriesIn.filter((e) => listed.includes(e));
      if (!chosen.length) throw httpError(400, `None of ${expiriesIn.join(', ')} is a listed ${s} option expiry`);
    } else chosen = listed.slice(0, 3);
    chosen = [...new Set(chosen)].slice(0, 5);
    if (!chosen.length) throw new NoLiveData(`No ${s} option expiry is listed`);
    const gaps = new Gaps();
    const chains = await Promise.allSettled(chosen.map((e) => buildOptionChain(md, s, e)));
    let spot: number | null = null;
    for (const c of chains) if (c.status === 'fulfilled' && c.value.spot !== null) spot ??= c.value.spot;
    const prevDate = md.calendar.prev(currentSession(md));
    const curves: SkewResponse['curves'] = [];
    chosen.forEach((expiry, i) => {
      const res = chains[i];
      if (res.status === 'rejected') {
        if (!(res.reason instanceof NoLiveData)) throw res.reason;
        gaps.add(expiry, res.reason.message);
      } else {
        const c = res.value;
        const ref = c.spot ?? c.forward;
        const F = c.forward ?? c.spot;
        if (ref === null || F === null) gaps.add(expiry, c.gaps?.forward ?? `No live ${s} price or forward for ${expiry}`);
        else {
          const points = c.rows
            .filter((row) => row.ce.iv !== null || row.pe.iv !== null)
            .map((row) => ({ strike: row.strike, moneyness: +((row.strike / ref - 1) * 100).toFixed(2), ceIv: row.ce.iv, peIv: row.pe.iv, iv: row.strike >= F ? row.ce.iv : row.pe.iv }));
          if (!points.length) gaps.add(expiry, `No ${s} ${expiry} strike has a live premium to solve`);
          curves.push({ expiry, label: formatExpiry(expiry), source: 'live', date: currentSession(md), atmIv: c.atmIv, forward: c.forward, points });
        }
      }
      if (compare === 'prev') {
        const eod = this.eodCurve(s, expiry, prevDate);
        const ref = eod.spot ?? eod.forward;
        const F = eod.forward;
        if (!eod.iv.size || ref === null || F === null) gaps.add(`${expiry} (prev close)`, `No traded official option closes of ${s} ${expiry} for ${prevDate}`);
        else {
          const strikes = [...new Set([...eod.rows.values()].map((o) => o.strike))].sort((a, b) => a - b);
          const points = strikes
            .map((strike) => {
              const ceIv = pct(eod.iv.get(`CE|${strike}`));
              const peIv = pct(eod.iv.get(`PE|${strike}`));
              return { strike, moneyness: +((strike / ref - 1) * 100).toFixed(2), ceIv, peIv, iv: strike >= F ? ceIv : peIv };
            })
            .filter((p) => p.ceIv !== null || p.peIv !== null);
          curves.push({ expiry, label: `${formatExpiry(expiry)} (prev close)`, source: 'eod', date: prevDate, atmIv: pct(eodAtmIvOf(md, s, expiry, prevDate)), forward: r2(F), points });
        }
      }
    });
    if (!curves.some((c) => c.points.length)) throw new NoLiveData(Object.values(gaps.out().gaps ?? {}).join('; ') || `No ${s} option premium to solve`);
    return { symbol: s, spot, curves, ...gaps.out() };
  }

  /**
   * IV by moneyness bucket × expiry (≤ 8 listed expiries): each cell is the solved IV (OTM side) of the
   * listed strike nearest the bucket centre within the bucket; null when there is none (no smile model).
   */
  async surface(symbol: string, _ts?: number): Promise<SurfaceResponse> {
    const md = mdFor(this.md, symbol);
    const s = md.ref.underlying(symbol).symbol;
    const now = this.now();
    const expiries = liveOptionExpiries(md, s, now).slice(0, 8);
    if (!expiries.length) throw new NoLiveData(`No ${s} option expiry is listed`);
    const gaps = new Gaps();
    const chains = await Promise.allSettled(expiries.map((e) => buildOptionChain(md, s, e)));
    let spot: number | null = null;
    for (const c of chains) if (c.status === 'fulfilled' && c.value.spot !== null) spot ??= c.value.spot;
    const B = SURFACE_MONEYNESS;
    const lo = B.map((c, j) => c - (j > 0 ? (c - B[j - 1]) / 2 : (B[1] - c) / 2));
    const hi = B.map((c, j) => c + (j < B.length - 1 ? (B[j + 1] - c) / 2 : (c - B[j - 1]) / 2));
    const iv: (number | null)[][] = [];
    const strikes: (number | null)[][] = [];
    expiries.forEach((expiry, i) => {
      const res = chains[i];
      const blank = () => {
        iv.push(B.map(() => null));
        strikes.push(B.map(() => null));
      };
      if (res.status === 'rejected') {
        if (!(res.reason instanceof NoLiveData)) throw res.reason;
        gaps.add(expiry, res.reason.message);
        return blank();
      }
      const c = res.value;
      const ref = spot ?? c.forward;
      const F = c.forward ?? spot;
      if (ref === null || F === null) {
        gaps.add(expiry, c.gaps?.forward ?? `No live ${s} price or forward for ${expiry}`);
        return blank();
      }
      const cand = c.rows
        .map((row) => ({ strike: row.strike, m: (row.strike / ref - 1) * 100, v: row.strike >= F ? row.ce.iv : row.pe.iv }))
        .filter((x): x is { strike: number; m: number; v: number } => x.v !== null);
      const rowIv: (number | null)[] = [];
      const rowK: (number | null)[] = [];
      B.forEach((centre, j) => {
        let best: { strike: number; m: number; v: number } | null = null;
        for (const x of cand) {
          if (x.m < lo[j] || x.m >= hi[j]) continue;
          if (!best || Math.abs(x.m - centre) < Math.abs(best.m - centre)) best = x;
        }
        rowIv.push(best ? best.v : null);
        rowK.push(best ? best.strike : null);
      });
      if (rowIv.every((v) => v === null)) gaps.add(expiry, `No listed ${s} ${expiry} strike inside the moneyness buckets has a live premium`);
      iv.push(rowIv);
      strikes.push(rowK);
    });
    if (iv.every((row) => row.every((v) => v === null))) throw new NoLiveData(Object.values(gaps.out().gaps ?? {}).join('; ') || `No ${s} option premium to solve`);
    // Days to expiry from the valuation time the IVs are solved at (outside the session: the last close).
    const valTs = md.pricing.valuationTs(now, undefined, s);
    return { symbol: s, spot, expiries, daysToExpiry: expiries.map((e) => +daysToExpiry(valTs, e, md.calendar.exchange).toFixed(1)), moneyness: [...B], iv, strikes, ...gaps.out() };
  }

  /** Realised-volatility cone of the consecutive official daily closes (≤ 505); short windows are null. */
  cone(symbol: string, _ts?: number): ConeResponse {
    const md = mdFor(this.md, symbol);
    const s = md.ref.underlying(symbol).symbol;
    const cur = currentSession(md);
    const from = sessionsBack(md, cur, 505)[0];
    const bars = md.history.dailyBars(s, from, cur).filter((b) => isPos(b.close));
    if (!bars.length) throw new NoLiveData(`No official daily closes of ${s} loaded for ${from}..${cur}`);
    const run = this.runs(bars, md.calendar);
    const used = bars.slice(bars.length - run[run.length - 1]);
    const closes = used.map((b) => b.close);
    const byWindow = new Map(volatilityCone(closes, CONE_WINDOWS).map((r) => [r.window, r]));
    const gaps = new Gaps();
    const rows = CONE_WINDOWS.map((w) => {
      const r = byWindow.get(w);
      return { window: w, min: pct(r?.min), p25: pct(r?.p25), median: pct(r?.median), p75: pct(r?.p75), max: pct(r?.max), current: pct(r?.current) };
    });
    const short = rows.filter((r) => r.median === null).map((r) => r.window);
    if (short.length) gaps.add('rows', `${closes.length} consecutive official closes (from ${used[0].date}): the ${short.join('/')}-session windows need ${short[0] + 7}+`);
    const e = this.ivExpiry(s);
    const atm = e ? md.pricing.atmIv(s, e) : null;
    if (atm === null) gaps.add('atmIv', `No live ATM IV of ${s}`);
    return { symbol: s, atmIv: pct(atm), closes: closes.length, from: used[0].date, to: used[used.length - 1].date, rows, ...gaps.out() };
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Straddle / strategy charts, recap                                                            */
  /* ------------------------------------------------------------------------------------------ */

  /** Strikes of an expiry on a session: recorded ones, plus the listed ones for the current session. */
  private strikesFor(symbol: string, expiry: string, date: string, current: boolean): number[] {
    const set = new Set(this.recordedStrikes(symbol, expiry, date));
    if (current) for (const k of this.listedStrikes(symbol, expiry)) set.add(k);
    return [...set].sort((a, b) => a - b);
  }

  /**
   * Straddle/strangle premium through a session from recorded minutes (Kotak 1-minute history for
   * active contracts the recorder does not hold). Rolling: the centre is the strike nearest the
   * forward of that time (same-expiry future, else spot carried at r). 400 for a fixed strike outside
   * the expiry's strikes, a negative width, or one wider than the strikes allow.
   */
  async straddle(symbol: string, expiryIn: string | undefined, strikeIn: number | 'atm', mode: 'rolling' | 'fixed', date: string | undefined, interval: number, _ts?: number, strangleWidth = 0): Promise<StraddleResponse> {
    const md = mdFor(this.md, symbol);
    const s = md.ref.underlying(symbol).symbol;
    const day = requireDate(md, date);
    const mk = this.requireMarks(this.marks(day, interval, s));
    const current = day === currentSession(md);
    const want = this.checkExpiry(expiryIn);
    const listed = current ? this.orElse(() => liveOptionExpiries(md, s), [] as string[]) : [];
    const choices = [...new Set([...this.recordedOptionExpiries(s, day), ...listed])].sort();
    const expiry = want ?? choices[0];
    const why = md.intraday.sessions().includes(day) ? '' : ` (${notRecordedReason(md, day)})`;
    if (!expiry) throw new NoLiveData(`No ${s} option expiry recorded or listed for ${day}${why}`);
    if (!choices.includes(expiry)) throw new NoLiveData(`No recorded or listed ${s} ${expiry} options for ${day}${why}`);
    const strikes = this.strikesFor(s, expiry, day, current);
    if (!strikes.length) throw new NoLiveData(`No ${s} ${expiry} strikes recorded or listed for ${day}`);
    const nearest = (x: number) => strikes.reduce((a, k) => (Math.abs(k - x) < Math.abs(a - x) ? k : a));
    // A strike or width outside the strikes is refused, not snapped to the nearest end of the strip.
    const lo = strikes[0];
    const hi = strikes[strikes.length - 1];
    const range = `${s} ${expiry} strikes recorded or listed for ${day} (${lo}–${hi})`;
    if (strikeIn !== 'atm' && !(isNum(strikeIn) && strikeIn >= lo && strikeIn <= hi)) throw httpError(400, `Strike ${strikeIn} is outside the ${range}`);
    if (!(isNum(strangleWidth) && strangleWidth >= 0)) throw httpError(400, `Strangle width must be a non-negative number of points (got ${strangleWidth})`);
    if (2 * strangleWidth > hi - lo) throw httpError(400, `Strangle width ${strangleWidth} is wider than the ${range} allow`);
    const width = strangleWidth;
    const load = this.loader(day, true, s);
    const sources = new Set<'recorded' | 'kotak'>();
    const closesOf = async (key: InstrumentKey, track = false) => {
      const m = await load.get(key);
      if (track && m.source) sources.add(m.source);
      return inWindows(m.recs, mk.starts, mk.times, traded).map((r) => r?.close ?? null);
    };
    const spot = await closesOf(spotKey(s));
    const futListed = this.recordedKeysHas(futKey(s, expiry), day) || (current && !!this.orElse(() => md.ref.listing(futKey(s, expiry)), undefined));
    const fut = futListed ? await closesOf(futKey(s, expiry)) : mk.times.map(() => null);
    const r = md.pricing.r;
    const fwd = mk.times.map((t, k) => impliedForward({ spot: spot[k] ?? undefined, future: fut[k] ?? undefined, rows: [] }, timeToExpiry(expiry, t, md.calendar.exchange), r)?.forward ?? null);
    const rolling = mode === 'rolling' && strikeIn === 'atm';
    let fixed: number | null = null;
    if (!rolling) {
      if (strikeIn === 'atm') {
        const f0 = fwd.find((f): f is number => f !== null);
        if (f0 === undefined) throw new NoLiveData(`No recorded ${s} price on ${day} to place the ATM strike`);
        fixed = nearest(f0);
      } else fixed = nearest(strikeIn);
    }
    const centres = mk.times.map((_, k) => (rolling ? (fwd[k] !== null ? nearest(fwd[k] as number) : null) : fixed));
    const legKeys = new Map<string, InstrumentKey>();
    for (const c of centres) {
      if (c === null) continue;
      legKeys.set(`CE|${nearest(c + width)}`, optKey(s, expiry, 'CE', nearest(c + width)));
      legKeys.set(`PE|${nearest(c - width)}`, optKey(s, expiry, 'PE', nearest(c - width)));
    }
    const legCloses = new Map<string, (number | null)[]>();
    for (const [id, key] of legKeys) legCloses.set(id, await closesOf(key, true));
    const points: StraddlePoint[] = [];
    mk.times.forEach((t, k) => {
      const c = centres[k];
      if (c === null) return;
      const kc = nearest(c + width);
      const kp = nearest(c - width);
      const ce = legCloses.get(`CE|${kc}`)?.[k] ?? null;
      const pe = legCloses.get(`PE|${kp}`)?.[k] ?? null;
      if (ce === null && pe === null && spot[k] === null) return;
      const F = impliedForward({ spot: spot[k] ?? undefined, future: fut[k] ?? undefined, rows: kc === kp && ce !== null && pe !== null ? [{ strike: kc, ce, pe }] : [] }, timeToExpiry(expiry, t, md.calendar.exchange), r)?.forward ?? null;
      const ivs: number[] = [];
      for (const [type, strike, p] of [['CE', kc, ce], ['PE', kp, pe]] as const) {
        if (p === null || F === null) continue;
        const v = md.pricing.iv({ symbol: s, expiry, type, strike, premium: p, ts: t, forward: F });
        if (v !== null) ivs.push(v);
      }
      points.push({ ts: t, spot: spot[k], strike: c, ceStrike: kc, peStrike: kp, ce, pe, straddle: ce !== null && pe !== null ? r2(ce + pe) : null, iv: pct(avg(ivs)) });
    });
    if (!points.some((p) => p.ce !== null || p.pe !== null)) throw new NoLiveData(load.reasons[0] ?? `No traded ${s} ${expiry} premiums recorded on ${day}`);
    const gaps = new Gaps();
    if (load.reasons.length) gaps.add('legs', [...new Set(load.reasons)].slice(0, 3).join('; '));
    if (points.some((p) => p.straddle === null)) gaps.add('points', 'Windows where a leg did not trade are blank');
    return { symbol: s, expiry, date: day, source: sources.size === 1 ? [...sources][0] : 'mixed', points, ...gaps.out() };
  }

  private recordedKeysHas(key: InstrumentKey, date: string): boolean {
    const id = keyId(key);
    return this.md.intraday.recordedKeys(date).some((k) => keyId(k) === id);
  }

  /**
   * Lot size of a leg: the instrument master's (active contracts), else the official file of the
   * contract's last day (expired ones), else the lot size the leg was saved with (taken from a listing
   * when it was built).
   */
  private lotOf(symbol: string, leg: Leg, key: InstrumentKey): number {
    const l = this.orElse(() => this.md.ref.listing(key), undefined);
    if (l) return l.lotSize;
    const d = leg.expiry;
    const eod = leg.type === 'FUT' ? this.md.history.dailyFutures(symbol, d, d).find((f) => f.expiry === d)?.lotSize : this.md.history.dailyOptions(symbol, d, d).find((o) => o.type === leg.type && o.strike === leg.strike)?.lotSize;
    if (isPos(eod)) return eod;
    if (isPos(leg.lotSize)) return leg.lotSize;
    throw new NoLiveData(`Lot size of ${keyLabel(key)} is unknown (not listed and no official file of its last day)`);
  }

  private legKey(symbol: string, leg: Leg): InstrumentKey {
    if (!isIsoDate(leg.expiry)) throw httpError(400, `Leg expiry must be YYYY-MM-DD (got '${leg.expiry}')`);
    if (leg.type === 'FUT') return futKey(symbol, leg.expiry);
    if (!isPos(leg.strike)) throw httpError(400, 'Option legs need a strike');
    return optKey(symbol, leg.expiry, leg.type, leg.strike);
  }

  /**
   * A strategy's premium, P&L and Greeks through a session from the legs' recorded (or Kotak) traded
   * minutes; IV/Greeks solved from each leg's premium with the recorded forward of that time.
   */
  async strategyChart(symbol: string, legsIn: Leg[], date: string | undefined, interval: number, _ts?: number): Promise<StrategyChartPoint[]> {
    const md = mdFor(this.md, symbol);
    const s = md.ref.underlying(symbol).symbol;
    const legs = legsIn.filter((l) => l.lots > 0);
    if (!legs.length) throw httpError(400, 'No legs');
    const day = requireDate(md, date);
    const keys = legs.map((l) => this.legKey(s, l));
    for (const l of legs) if (l.expiry < day) throw httpError(400, `${l.expiry} expired before ${day}`);
    const lots = legs.map((l, i) => this.lotOf(s, l, keys[i]));
    const mk = this.requireMarks(this.marks(day, interval, s));
    const load = this.loader(day, true, s);
    const closesOf = async (key: InstrumentKey) => inWindows((await load.get(key)).recs, mk.starts, mk.times, traded).map((r) => r?.close ?? null);
    const spot = await closesOf(spotKey(s));
    const px: (number | null)[][] = [];
    for (const k of keys) px.push(await closesOf(k));
    const expiries = [...new Set(legs.filter((l) => l.type !== 'FUT').map((l) => l.expiry))];
    const fut = new Map<string, (number | null)[]>();
    for (const e of expiries) {
      const i = legs.findIndex((l) => l.type === 'FUT' && l.expiry === e);
      if (i >= 0) fut.set(e, px[i]);
      else if (this.recordedKeysHas(futKey(s, e), day)) fut.set(e, await closesOf(futKey(s, e)));
    }
    const r = md.pricing.r;
    const entry = legs.map((l, i) => (l.price > 0 ? l.price : (px[i].find((p) => p !== null) ?? null)));
    const missing = entry.findIndex((e) => e === null);
    if (missing >= 0) throw new NoLiveData(load.reasons[0] ?? `No traded minute of ${keyLabel(keys[missing])} on ${day}`);
    const points: StrategyChartPoint[] = [];
    mk.times.forEach((t, k) => {
      const prices = px.map((p) => p[k]);
      if (prices.every((p) => p === null) && spot[k] === null) return;
      const complete = prices.every((p) => p !== null);
      let premium = 0;
      let pnl = 0;
      let g: { delta: number; gamma: number; theta: number; vega: number } | null = { delta: 0, gamma: 0, theta: 0, vega: 0 };
      const fwd = new Map<string, number | null>();
      const forwardOf = (e: string): number | null => {
        if (!fwd.has(e)) {
          const rows: PremiumRow[] = [];
          legs.forEach((l, i) => {
            if (l.type === 'FUT' || l.expiry !== e || prices[i] === null) return;
            let row = rows.find((x) => x.strike === l.strike);
            if (!row) rows.push((row = { strike: l.strike }));
            row[l.type === 'CE' ? 'ce' : 'pe'] = prices[i] as number;
          });
          fwd.set(e, impliedForward({ spot: spot[k] ?? undefined, future: fut.get(e)?.[k] ?? undefined, rows }, timeToExpiry(e, t, md.calendar.exchange), r)?.forward ?? null);
        }
        return fwd.get(e) ?? null;
      };
      legs.forEach((leg, i) => {
        const p = prices[i];
        const qty = leg.lots * lots[i] * sideSign(leg.side);
        if (p === null) {
          g = null;
          return;
        }
        premium += sideSign(leg.side) * p * leg.lots;
        pnl += qty * (p - (entry[i] as number));
        if (!g) return;
        if (leg.type === 'FUT') {
          g.delta += qty;
          return;
        }
        const F = forwardOf(leg.expiry);
        const iv = F !== null ? md.pricing.iv({ symbol: s, expiry: leg.expiry, type: leg.type, strike: leg.strike, premium: p, ts: t, forward: F }) : null;
        const gr = iv !== null && F !== null ? md.pricing.greeks({ symbol: s, expiry: leg.expiry, type: leg.type, strike: leg.strike, iv, ts: t, forward: F }) : null;
        if (!gr) {
          g = null;
          return;
        }
        g.delta += qty * gr.delta;
        g.gamma += qty * gr.gamma;
        g.theta += qty * gr.theta;
        g.vega += qty * gr.vega;
      });
      const gg = complete ? (g as { delta: number; gamma: number; theta: number; vega: number } | null) : null;
      points.push({
        ts: t,
        spot: spot[k],
        premium: complete ? r2(premium) : null,
        pnl: complete ? r2(pnl) : null,
        delta: gg ? rn(gg.delta, 2) : null,
        gamma: gg ? rn(gg.gamma, 4) : null,
        theta: gg ? rn(gg.theta, 2) : null,
        vega: gg ? rn(gg.vega, 2) : null,
      });
    });
    if (!points.some((p) => p.premium !== null)) throw new NoLiveData(load.reasons[0] ?? `No window of ${day} has a traded price of every leg`);
    return points;
  }

  /**
   * Replay of a strategy over recorded sessions only, from `fromTs` to `toTs` (or now / the first
   * expiry). A leg's price at a point is the close of its last traded minute in the window. A leg
   * sent without an entry price (≤ 0) enters at its first traded price of the replay (as the strategy
   * chart); its P&L is blank until then — a missing entry is never taken as ₹0.
   */
  recap(req: RecapRequest, _nowTs?: number): RecapResponse {
    const md = mdFor(this.md, req.symbol);
    const s = md.ref.underlying(req.symbol).symbol;
    const legs = req.legs.filter((l) => l.lots > 0);
    if (!legs.length) throw httpError(400, 'No legs');
    const keys = legs.map((l) => this.legKey(s, l));
    const lots = legs.map((l, i) => this.lotOf(s, l, keys[i]));
    const now = this.now();
    if (!Number.isFinite(req.fromTs)) throw httpError(400, 'fromTs must be a timestamp');
    const fromTs = Math.min(req.fromTs, now);
    const firstExpiry = Math.min(...legs.map((l) => md.calendar.expiryTs(l.expiry)));
    const endTs = Math.min(isNum(req.toTs) ? req.toTs : now, now, firstExpiry);
    if (!(fromTs < endTs)) throw httpError(400, 'fromTs must be before the end of the replay (toTs, now or the first expiry)');
    const step = clampInt(req.intervalMin, 1, M, 5) * MINUTE;
    const recorded = new Set(md.intraday.sessions());
    const dates = md.calendar.sessions(md.calendar.session(fromTs).date, md.calendar.session(endTs).date);
    const points: RecapResponse['points'] = [];
    const used: string[] = [];
    const skipped: string[] = [];
    const entry: (number | null)[] = legs.map((l) => (isPos(l.price) ? l.price : null));
    for (const d of dates) {
      if (!recorded.has(d)) {
        skipped.push(d);
        continue;
      }
      const open = md.calendar.ts(d, 0);
      const close = md.calendar.ts(d, md.calendar.sessionMinutes(d));
      const start = Math.max(fromTs, open);
      const end = Math.min(endTs, close, now);
      const times: number[] = [];
      let t = Math.max(open + MINUTE, Math.floor(start / MINUTE) * MINUTE);
      for (; t <= end; t += step) times.push(t);
      const last = Math.floor(end / MINUTE) * MINUTE;
      if (last > open && times[times.length - 1] !== last && last > (times[times.length - 1] ?? 0)) times.push(last);
      if (!times.length) continue;
      const starts = times.map((x, k) => Math.max(open, k ? times[k - 1] : x - step));
      const close1 = (key: InstrumentKey) => inWindows(byTs(md.intraday.bars(key, d)), starts, times, traded).map((rec) => rec?.close ?? null);
      const spot = close1(spotKey(s));
      const px = keys.map((k) => close1(k));
      let any = false;
      times.forEach((x, k) => {
        const legLtp = px.map((p) => p[k]);
        if (legLtp.every((p) => p === null) && spot[k] === null) return;
        any = true;
        legLtp.forEach((p, i) => {
          if (entry[i] === null && p !== null) entry[i] = p;
        });
        let pnl: number | null = 0;
        legs.forEach((leg, i) => {
          const exit = leg.exitPrice ?? legLtp[i];
          const e = entry[i];
          if (pnl === null || exit === null || exit === undefined || e === null) pnl = null;
          else pnl += leg.lots * lots[i] * sideSign(leg.side) * (exit - e);
        });
        points.push({ ts: x, spot: spot[k], pnl: pnl === null ? null : r2(pnl), legLtp });
      });
      if (any) used.push(d);
    }
    if (!points.length) throw new NoLiveData(`${notRecordedReason(md, md.calendar.session(fromTs).date, `${s} minutes`)} (nothing recorded between ${formatTimeIST(fromTs)} on ${md.calendar.session(fromTs).date} and ${formatTimeIST(endTs)} on ${md.calendar.session(endTs).date})`);
    const gaps = new Gaps();
    if (skipped.length) gaps.add('sessions', `Not recorded: ${skipped.slice(0, 5).join(', ')}${skipped.length > 5 ? ` and ${skipped.length - 5} more` : ''}`);
    if (points.some((p) => p.pnl === null)) gaps.add('pnl', 'Windows where a leg did not trade have no P&L');
    const pnls = points.map((p) => p.pnl).filter(isNum);
    return {
      points,
      maxPnl: pnls.length ? Math.max(...pnls) : null,
      minPnl: pnls.length ? Math.min(...pnls) : null,
      finalPnl: pnls.length ? pnls[pnls.length - 1] : null,
      endTs: points[points.length - 1].ts,
      expired: endTs >= firstExpiry,
      sessions: used,
      ...gaps.out(),
    };
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Optimizer                                                                                    */
  /* ------------------------------------------------------------------------------------------ */

  /**
   * Ranks 1–4 leg strategies on the live chain: each leg's price is the premium its IV was solved
   * from (mid of a sane live book, else the session LTP); strikes without a live premium are skipped.
   * Valuation needs the live spot, the expiry's forward (carry) and the ATM IV.
   */
  async optimize(req: OptimizerRequest, _ts?: number): Promise<OptimizerOutput & { expiry: string; spot: number; forward: number; tookMs: number; targetTs: number; coverage: string }> {
    const md = mdFor(this.md, req.symbol);
    const u = md.ref.underlying(req.symbol);
    if (!isIsoDate(req.targetDate)) throw httpError(400, `targetDate must be YYYY-MM-DD (got '${req.targetDate}')`);
    const chain = await buildOptionChain(md, u.symbol, this.checkExpiry(req.expiry));
    if (chain.spot === null) throw new NoLiveData(chain.gaps?.spot ?? `No live ${u.symbol} price`);
    if (chain.forward === null || chain.carry === null) throw new NoLiveData(chain.gaps?.carry ?? chain.gaps?.forward ?? `No forward of ${u.symbol} ${chain.expiry}`);
    if (chain.atmIv === null) throw new NoLiveData(chain.gaps?.atmIv ?? `ATM IV of ${u.symbol} ${chain.expiry} could not be solved`);
    const premiumOf = (q: OptionQuote): number | null => (q.ivSource === 'mid' && q.bid !== null && q.ask !== null ? (q.bid + q.ask) / 2 : q.ivSource === 'ltp' ? q.ltp : null);
    const quote = (q: OptionQuote) => {
      const p = premiumOf(q);
      return p !== null && q.iv !== null ? { price: r2(p) as number, iv: q.iv / 100 } : null;
    };
    const rows = chain.rows.map((r) => ({ strike: r.strike, ce: quote(r.ce), pe: quote(r.pe) })).filter((r) => r.ce || r.pe);
    if (rows.length < 2) throw new NoLiveData(`Fewer than two ${u.symbol} ${chain.expiry} strikes have a live premium`);
    const now = this.now();
    const expTs = md.calendar.expiryTs(chain.expiry);
    const targetTs = Math.min(expTs, Math.max(now + 60_000, md.calendar.expiryTs(req.targetDate)));
    const carry = chain.carry;
    const atmIv = chain.atmIv / 100;
    const t0 = performance.now();
    const out = optimizeStrategies({
      spot: chain.spot,
      // The chain's IVs and carry are solved at its valuation time (outside the session: the last close).
      nowTs: chain.valuationTs,
      expiry: chain.expiry,
      lotSize: chain.lotSize,
      rows,
      targetPrice: req.targetPrice,
      targetTs,
      stopLoss: req.stopLoss,
      maxLegs: req.maxLegs ?? 4,
      allowUnlimitedRisk: req.allowUnlimitedRisk ?? false,
      maxCapital: req.maxCapital,
      atmIv,
      ctx: { r: md.pricing.r, carry: () => carry, exchange: md.calendar.exchange },
      marginParams: marginParamsOf(u.kind),
      sortBy: req.sortBy ?? 'rr',
      limit: 25,
      budget: 220_000,
    });
    return {
      ...out,
      expiry: chain.expiry,
      spot: chain.spot,
      forward: chain.forward,
      tookMs: Math.round(performance.now() - t0),
      targetTs,
      coverage: `${rows.length} strikes with a live premium (of ${chain.rows.length} in the chain; ${chain.rows.length - rows.length} skipped)`,
    };
  }

  /* ------------------------------------------------------------------------------------------ */
  /* Market-wide option snapshot                                                                  */
  /* ------------------------------------------------------------------------------------------ */

  /**
   * Near-expiry option quotes across all underlyings (shared by scanners, synopsis, unusual
   * activity): the live quotes of the streamed index chains and the swept stock chains within ±5 %
   * (index) / ±12 % (stock) of the live spot. No REST calls; cached 5 s.
   */
  optionSnapshot(_ts?: number): OptionSnapshotRow[] {
    return this.snapCache.get(this.bucket(), () => this.computeSnapshot());
  }

  private computeSnapshot(): OptionSnapshotRow[] {
    const now = this.now();
    const out: OptionSnapshotRow[] = [];
    for (const u of this.md.ref.underlyings()) {
      // Each underlying in its own exchange's sessions (MCX commodities: MCX's).
      const md = mdFor(this.md, u.symbol);
      const dates = liveDates(md);
      const prevDate = md.calendar.prev(currentSession(md, now));
      const spot = livePrice(md, md.live.quote(spotKey(u.symbol)), dates);
      if (spot === null) continue;
      const expiry = this.orElse(() => liveOptionExpiries(md, u.symbol, now)[0], undefined);
      if (!expiry) continue;
      const band = u.kind === 'index' ? 0.05 : u.kind === 'commodity' ? 0.08 : 0.12;
      const keys: InstrumentKey[] = [];
      for (const k of this.listedStrikes(u.symbol, expiry)) if (Math.abs(k / spot - 1) <= band) keys.push(optKey(u.symbol, expiry, 'CE', k), optKey(u.symbol, expiry, 'PE', k));
      const quotes = md.live.quotes(keys);
      if (!quotes.size) continue;
      let forward: number | null = null;
      try {
        forward = md.pricing.forward(u.symbol, expiry).forward;
      } catch (e) {
        if (!(e instanceof NoLiveData)) throw e;
      }
      const prev = this.eodCurve(u.symbol, expiry, prevDate);
      for (const key of keys) {
        const q = quotes.get(keyId(key));
        if (!q) continue;
        const type = key.kind as OptKind;
        const strike = key.strike as number;
        const ltp = livePrice(md, q, dates);
        const mid = saneMid(liveBook(md, q, now));
        const premium = mid ?? ltp;
        // Valued at md.pricing's valuation time; an LTP (no sane live book) at its own trade time.
        const iv = premium !== null && forward !== null ? md.pricing.iv({ symbol: u.symbol, expiry, type, strike, premium, forward, ...(mid === null ? { ltt: q.ltt } : {}) }) : null;
        const eod = prev.rows.get(`${type}|${strike}`);
        const prevLtp = isPos(q.prevClose) ? q.prevClose : tradedClose(eod);
        const oi = isNum(q.oi) ? q.oi : null;
        const prevOi = isNum(q.prevOi) ? q.prevOi : eod && isNum(eod.oi) ? eod.oi : null;
        const oiChange = oi !== null && prevOi !== null ? oi - prevOi : null;
        out.push({
          symbol: u.symbol,
          kind: u.kind,
          sector: u.sector,
          expiry,
          type,
          strike,
          spot,
          ltp,
          prevLtp,
          changePct: changeOf(ltp, prevLtp).changePct,
          oi,
          prevOi,
          oiChange,
          oiChangePct: oiChange !== null && prevOi ? r2((oiChange / prevOi) * 100) : null,
          volume: isNum(q.volume) ? q.volume : null,
          iv: pct(iv),
          ivSource: iv === null ? null : mid !== null ? 'mid' : 'ltp',
          prevIv: pct(prev.iv.get(`${type}|${strike}`)),
          lotSize: this.orElse(() => md.ref.listing(key)?.lotSize, undefined) ?? u.lotSize,
          ts: q.ts,
        });
      }
    }
    return out;
  }

  /** Build-up of a snapshot row (premium change vs OI change); null when either is unknown. */
  optionBuildUp(row: OptionSnapshotRow): BuildUp | null {
    return row.ltp !== null && row.prevLtp !== null && row.oiChange !== null ? classifyBuildUp(row.ltp - row.prevLtp, row.oiChange) : null;
  }
}
