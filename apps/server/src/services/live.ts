/**
 * Shared live-data helpers for the services and routes (Phase C). Everything here reads the
 * MarketDataProvider: live quotes (md.live), recorded minutes (md.intraday), official end-of-day
 * files (md.history), and IV/Greeks solved from premiums (md.pricing). Derived values (PCR, max pain,
 * build-up, changes) are computed from those inputs only.
 *
 * Blank rules shared by every helper:
 *  - a price counts as live only when it is a trade of the live session (pricing.isLivePrice: quote
 *    and last-trade time of a live date, session volume not 0); otherwise the price is null and the
 *    instrument's OI (real) is still shown;
 *  - a bid/ask counts only while the session is open and the quote is at most BOOK_MAX_AGE_MS old
 *    (liveBook); otherwise bid/ask are null;
 *  - previous-session values come from the quote (prevClose, prevOi) or the official EOD files of the
 *    previous session; EOD option/future rows with volume 0 carry an exchange carried-forward or
 *    theoretical price, so their close is never used as a price (their OI is);
 *  - `?at=` (as-of) answers come from the recorder's minutes only (md.intraday), never from anything else;
 *  - a whole answer that is not available throws NoLiveData (HTTP 503); a missing field is null and,
 *    where a response has sections, the reason is put in `gaps`.
 */
import {
  classifyBuildUp,
  daysToExpiry,
  expiryTs,
  formatTimeIST,
  istTs,
  MARKET_CLOSE_MIN,
  maxPain,
  oiSupportResistance,
  SESSION_MINUTES,
  type BuildUp,
  type Candle,
  type ChainRow,
  type DataGaps,
  type FeedStatus,
  type FuturesQuote,
  type MarketClockInfo,
  type OptionChain,
  type OptionQuote,
  type Quote,
  type StrikeOI,
} from '@q26/core';
import { isIsoDate } from '../live/calendar';
import { atmIvOf, chainAtmIv, impliedForward, isAfterValuation, isLivePrice, liveSessionDates, timeToExpiry, type PremiumRow } from '../live/pricing';
import { recordedMinutes, resampleMinutes } from '../live/provider';
import { NoLiveData, keyId } from '../live/types';
import type { CandleInterval, DailyOption, InstrumentKey, LiveQuote, MarketDataProvider, MinuteRecord, OptKind, RawChain, UserContract, WatchLevel } from '../live/types';

const MINUTE = 60_000;

/** A bid/ask older than this (or outside the open session) is not a live book (paper fills, mids). */
export const BOOK_MAX_AGE_MS = 10_000;
/** A two-sided book is used as an IV premium (mid) only when its spread is at most this fraction of the mid. */
export const MAX_MID_SPREAD = 0.25;

/* ------------------------------------------------------------------------------------------ */
/* Small utilities                                                                              */
/* ------------------------------------------------------------------------------------------ */

export function httpError(statusCode: number, message: string): Error {
  return Object.assign(new Error(message), { statusCode });
}

const isPos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
/** Rounded to paise; null stays null. */
export const r2 = (v: number | null | undefined): number | null => (isNum(v) ? Math.round(v * 100) / 100 : null);
const rn = (v: number | null | undefined, d: number): number | null => (isNum(v) ? +v.toFixed(d) : null);
/** Decimal → percent (2 dp); null stays null. */
export const pct = (v: number | null | undefined): number | null => (isNum(v) ? Math.round(v * 10_000) / 100 : null);
/** Change and change % of `now` over `prev`; nulls when either is missing (or prev is not positive). */
export function changeOf(now: number | null | undefined, prev: number | null | undefined): { change: number | null; changePct: number | null } {
  if (!isNum(now) || !isNum(prev)) return { change: null, changePct: null };
  return { change: r2(now - prev), changePct: prev > 0 ? r2(((now - prev) / prev) * 100) : null };
}

/* ------------------------------------------------------------------------------------------ */
/* Keys                                                                                         */
/* ------------------------------------------------------------------------------------------ */

const sym = (s: string) => s.trim().toUpperCase();
export const spotKey = (symbol: string): InstrumentKey => ({ symbol: sym(symbol), kind: 'SPOT' });
export const futKey = (symbol: string, expiry: string): InstrumentKey => ({ symbol: sym(symbol), kind: 'FUT', expiry });
export const optKey = (symbol: string, expiry: string, type: OptKind, strike: number): InstrumentKey => ({ symbol: sym(symbol), kind: type, expiry, strike });

/** Human label of a key ("NIFTY 28-Oct-26 25000 CE"). */
export function keyLabel(k: InstrumentKey): string {
  return [k.symbol, k.expiry, k.strike, k.kind === 'SPOT' ? undefined : k.kind].filter((v) => v !== undefined).join(' ');
}

/* ------------------------------------------------------------------------------------------ */
/* Gaps                                                                                         */
/* ------------------------------------------------------------------------------------------ */

/** Collects section → reason for partially available responses (DataGaps). The first reason per section wins. */
export class Gaps {
  private readonly map: Record<string, string> = {};

  add(section: string, reason: string): void {
    if (!(section in this.map)) this.map[section] = reason;
  }

  /** Runs `fn`; NoLiveData becomes a gap for `section` and null. Any other error propagates. */
  try<T>(section: string, fn: () => T): T | null {
    try {
      return fn();
    } catch (e) {
      if (e instanceof NoLiveData) {
        this.add(section, e.message);
        return null;
      }
      throw e;
    }
  }

  get size(): number {
    return Object.keys(this.map).length;
  }

  /** `{ gaps }` when any section is missing, else `{}` (spread into a response). */
  out(): DataGaps {
    return this.size ? { gaps: { ...this.map } } : {};
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Sessions, dates, recorded data                                                               */
/* ------------------------------------------------------------------------------------------ */

/**
 * The provider as seen by one underlying: `calendar` is the calendar of the exchange `symbol`
 * trades on (MCX for commodities: 09:00–23:30/23:55, its own holidays), everything else is the
 * provider itself. Every helper below that takes `md` then works in that exchange's sessions.
 */
export function mdFor(md: MarketDataProvider, symbol: string): MarketDataProvider {
  const cal = md.calendarOf(symbol);
  if (cal === md.calendar) return md;
  return new Proxy(md, {
    get(target, prop) {
      if (prop === 'calendar') return cal;
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/** `date` when it is a trading day, else the previous trading day. */
export function onOrBefore(md: MarketDataProvider, date: string): string {
  return md.calendar.isTradingDay(date) ? date : md.calendar.prev(date);
}

/** Trading session a timestamp belongs to (weekend/holiday stamps → the session before). */
export function sessionDateOf(md: MarketDataProvider, ts: number): string {
  return onOrBefore(md, md.calendar.session(ts).date);
}

/** The most recent session that has started: today from 09:15 on a trading day, else the previous trading day. */
export function currentSession(md: MarketDataProvider, now: number = md.clock.now()): string {
  const s = md.calendar.session(now);
  if (md.calendar.isTradingDay(s.date) && now >= md.calendar.ts(s.date, 0)) return s.date;
  return md.calendar.prev(s.date);
}

/** Session dates whose quotes are live now (pricing.liveSessionDates). */
export function liveDates(md: MarketDataProvider): Set<string> {
  return liveSessionDates(md.calendar, md.clock.now());
}

/**
 * A requested session date: absent → the current session; 400 for a malformed, future or
 * non-trading date. It does not check that anything is recorded (requireRecorded does).
 */
export function requireDate(md: MarketDataProvider, date?: string | null): string {
  if (!date) return currentSession(md);
  if (!isIsoDate(date)) throw httpError(400, `date must be YYYY-MM-DD (got '${date}')`);
  const today = md.calendar.session(md.clock.now()).date;
  if (date > today) throw httpError(400, `${date} is in the future`);
  if (!md.calendar.isTradingDay(date)) throw httpError(400, `${date} is not a trading day`);
  return date;
}

/** Dates the recorder holds minute data for (ascending). */
export function recordedSessions(md: MarketDataProvider): string[] {
  return md.intraday.sessions();
}

/** "No recorded data for <date> — recording started <first>" (or "no session has been recorded yet"). */
export function notRecordedReason(md: MarketDataProvider, date: string, what = 'data'): string {
  const first = md.intraday.sessions()[0];
  return first ? `No recorded ${what} for ${date} — recording started ${first}` : `No recorded ${what} for ${date}: no session has been recorded yet`;
}

/** NoLiveData unless the recorder holds data for `date`. */
export function requireRecorded(md: MarketDataProvider, date: string, what = 'data'): void {
  if (!md.intraday.sessions().includes(date)) throw new NoLiveData(notRecordedReason(md, date, what));
}

/** Records of a key on the date of `at` completed by `at` (no look-ahead). */
function minutesUpTo(md: MarketDataProvider, key: InstrumentKey, at: number): MinuteRecord[] {
  const date = md.calendar.session(at).date;
  return md.intraday.bars(key, date).filter((r) => r.ts + MINUTE <= at);
}

/**
 * A recording counts as covering a session's open when its first minute of the day starts at most
 * this many minutes after 09:15. Session values rebuilt from recorded minutes (open, day high/low,
 * session volume) are only shown for such recordings: a recording that started at 11:00 has no
 * session open, and the sum of its minute volumes is not the session's volume.
 */
export const RECORDING_OPEN_SLACK_MIN = 2;

/** The recorder holds `key` (its traded minutes when `traded`) on `date` from the session's open (RECORDING_OPEN_SLACK_MIN). */
function recordedFromOpen(md: MarketDataProvider, key: InstrumentKey, date: string, traded = false): boolean {
  const recs = md.intraday.bars(key, date).filter((r) => !traded || r.traded);
  if (!recs.length) return false;
  return Math.min(...recs.map((r) => r.ts)) <= md.calendar.ts(date, RECORDING_OPEN_SLACK_MIN);
}

/**
 * An as-of (`?at=`) answer needs the recorder to have been running at `at`: the last minute of the
 * underlying's spot (else of the instrument itself) completed by `at` must have ended at most this
 * many minutes before `at` (after the close: before the 15:30 close). The algo replay's rule
 * (SessionTape.alive), with one minute of slack. Otherwise the last recorded values are hours old
 * and are not shown as the values at `at`.
 */
export const AS_OF_RECORDING_SLACK_MIN = 2;

/** `at`, capped at the close of its session date (nothing is recorded after 15:30). */
function asOfRef(md: MarketDataProvider, at: number): number {
  const date = md.calendar.session(at).date;
  return Math.min(at, md.calendar.ts(date, md.calendar.sessionMinutes(date)));
}

/** A recorded minute (its start `ts`) completed by `at` shows the recorder running at `at` (AS_OF_RECORDING_SLACK_MIN). */
export function recordedNear(md: MarketDataProvider, rec: { ts: number } | undefined, at: number): boolean {
  return !!rec && rec.ts + MINUTE <= at && rec.ts + MINUTE > asOfRef(md, at) - AS_OF_RECORDING_SLACK_MIN * MINUTE;
}

/** NoLiveData for an as-of time at which the recorder was not running ("last recorded minute HH:MM"). */
function notRecordingAt(md: MarketDataProvider, what: string, at: number, last: number | undefined): NoLiveData {
  const ref = asOfRef(md, at);
  const lastText = last !== undefined ? `last recorded minute ${formatTimeIST(last)}` : 'no minute recorded before it';
  return new NoLiveData(`Nothing recorded for ${what} at ${formatTimeIST(ref)} on ${md.calendar.session(at).date} (${lastText}): the recorder was not running`);
}

/* ------------------------------------------------------------------------------------------ */
/* Live prices and books                                                                        */
/* ------------------------------------------------------------------------------------------ */

/** The quote's LTP when it is a trade of the live session, else null (see the module comment). */
export function livePrice(md: MarketDataProvider, q: LiveQuote | undefined, dates: ReadonlySet<string> = liveDates(md)): number | null {
  return q && isPos(q.ltp) && isLivePrice(q, md.calendar, dates) ? q.ltp : null;
}

export interface LiveBook {
  bid: number;
  ask: number;
  bidQty: number | null;
  askQty: number | null;
  ts: number;
}

/** Best bid/ask while the session is open and the quote is ≤ BOOK_MAX_AGE_MS old and two-sided (ask ≥ bid > 0); else null. */
export function liveBook(md: MarketDataProvider, q: LiveQuote | undefined, now: number = md.clock.now()): LiveBook | null {
  if (!q || !isPos(q.bid) || !isPos(q.ask) || q.ask < q.bid) return null;
  if (md.calendar.session(now).status !== 'open' || now - q.ts > BOOK_MAX_AGE_MS || q.ts > now + BOOK_MAX_AGE_MS) return null;
  return { bid: q.bid, ask: q.ask, bidQty: isNum(q.bidQty) ? q.bidQty : null, askQty: isNum(q.askQty) ? q.askQty : null, ts: q.ts };
}

/** Mid of a two-sided book whose spread is sane (≤ MAX_MID_SPREAD of the mid); else null. */
export function saneMid(book: { bid?: number; ask?: number } | null | undefined): number | null {
  if (!book || !isPos(book.bid) || !isPos(book.ask) || book.ask < book.bid) return null;
  const mid = (book.bid + book.ask) / 2;
  return book.ask - book.bid <= MAX_MID_SPREAD * mid ? mid : null;
}

/* ------------------------------------------------------------------------------------------ */
/* Reference helpers                                                                            */
/* ------------------------------------------------------------------------------------------ */

/** Nearest listed future not expired at `ts`; null when none is listed (or the master is not loaded). */
export function nearFuture(md: MarketDataProvider, symbol: string, ts: number = md.clock.now()): string | null {
  md = mdFor(md, symbol);
  let list: string[];
  try {
    list = md.ref.expiries(symbol, 'FUT');
  } catch (e) {
    if (e instanceof NoLiveData) return null;
    throw e;
  }
  return [...list].sort().find((e) => md.calendar.expiryTs(e) > ts) ?? null;
}

/** Listed option expiries not expired at `ts` (ascending). */
export function liveOptionExpiries(md: MarketDataProvider, symbol: string, ts: number = md.clock.now()): string[] {
  md = mdFor(md, symbol);
  return [...md.ref.expiries(symbol, 'OPT')].sort().filter((e) => md.calendar.expiryTs(e) > ts);
}

/** Expiries recorded on the date of `at` (as-of pickers); NoLiveData when the date is not recorded. */
export function recordedExpiries(md: MarketDataProvider, symbol: string, at: number): { options: string[]; futures: string[] } {
  md = mdFor(md, symbol);
  const date = md.calendar.session(at).date;
  requireRecorded(md, date);
  const s = sym(symbol);
  const opt = new Set<string>();
  const fut = new Set<string>();
  for (const k of md.intraday.recordedKeys(date)) {
    if (k.symbol !== s || !k.expiry || md.calendar.expiryTs(k.expiry) <= at) continue;
    if (k.kind === 'FUT') fut.add(k.expiry);
    else if (k.kind === 'CE' || k.kind === 'PE') opt.add(k.expiry);
  }
  if (!opt.size && !fut.size) throw new NoLiveData(`No recorded ${s} contracts on ${date}`);
  return { options: [...opt].sort(), futures: [...fut].sort() };
}

/** Option expiry cycle from listed expiries: two consecutive expiries ≤ 8 days apart → weekly; null with < 2 listed. */
export function expiryCycle(expiries: readonly string[]): 'weekly' | 'monthly' | null {
  const list = [...expiries].sort();
  if (list.length < 2) return null;
  for (let i = 1; i < list.length; i++) if ((Date.parse(list[i]) - Date.parse(list[i - 1])) / 86_400_000 <= 8) return 'weekly';
  return 'monthly';
}

/* ------------------------------------------------------------------------------------------ */
/* Feed status and clock                                                                        */
/* ------------------------------------------------------------------------------------------ */

/** Connection / data health for the web (FeedStatus). Holds no credentials. */
export function feedStatus(md: MarketDataProvider): FeedStatus {
  const h = md.live.health();
  const last = (kind: 'fo' | 'cm' | 'index' | 'participants' | 'fiidii'): string | null => {
    try {
      return md.history.loadedDates(kind).at(-1) ?? null;
    } catch {
      return null;
    }
  };
  let recordingSince: string | null = null;
  try {
    recordingSince = md.intraday.sessions()[0] ?? null;
  } catch {
    recordingSince = null;
  }
  return {
    loggedIn: h.loggedIn,
    connected: h.connected,
    lastTickTs: h.lastTickTs,
    subscribed: h.subscribed,
    ...(h.error ? { error: h.error } : {}),
    refdataReady: md.ref.ready(),
    recordingSince,
    eod: { fo: last('fo'), cm: last('cm'), index: last('index'), participants: last('participants'), fiidii: last('fiidii') },
  };
}

/** md.clock.info() plus the feed status. */
export function clockInfo(md: MarketDataProvider, feed: FeedStatus = feedStatus(md)): MarketClockInfo {
  return { ...md.clock.info(), feed };
}

/* ------------------------------------------------------------------------------------------ */
/* EOD previous-session lookups                                                                 */
/* ------------------------------------------------------------------------------------------ */

/** Official close of the underlying on `date` (index/CM file); null when not loaded. */
export function eodClose(md: MarketDataProvider, symbol: string, date: string): number | null {
  md = mdFor(md, symbol);
  const bar = md.history.dailyBars(sym(symbol), date, date)[0];
  return bar && isPos(bar.close) ? bar.close : null;
}

/** A future's official row on `date` (OI is always usable; its close only when it traded). */
function eodFuture(md: MarketDataProvider, symbol: string, expiry: string, date: string) {
  md = mdFor(md, symbol);
  return md.history.dailyFutures(sym(symbol), date, date).find((f) => f.date === date && f.expiry === expiry);
}

/** Official option rows of one expiry on `date`, by `${type}|${strike}`. */
function eodOptions(md: MarketDataProvider, symbol: string, expiry: string, date: string): Map<string, DailyOption> {
  md = mdFor(md, symbol);
  const out = new Map<string, DailyOption>();
  for (const o of md.history.dailyOptions(sym(symbol), date, expiry)) out.set(`${o.type}|${o.strike}`, o);
  return out;
}

/** Traded official close (volume > 0); untraded rows carry an exchange carried-forward/theoretical price. */
const tradedClose = (row: { close: number; volume: number } | undefined): number | null => (row && row.volume > 0 && isPos(row.close) ? row.close : null);

/**
 * ATM IV (decimal) of one expiry at the official close of `date`: Black-76 on traded option closes,
 * forward from the traded same-expiry future (settle, else close), else put-call parity at the strike
 * nearest the underlying close, else that close carried at r. Null when not solvable / not loaded.
 */
export function eodAtmIvOf(md: MarketDataProvider, symbol: string, expiry: string, date: string): number | null {
  md = mdFor(md, symbol);
  const byStrike = new Map<number, PremiumRow>();
  for (const o of md.history.dailyOptions(sym(symbol), date, expiry)) {
    const c = tradedClose(o);
    if (c === null) continue;
    let row = byStrike.get(o.strike);
    if (!row) byStrike.set(o.strike, (row = { strike: o.strike }));
    row[o.type === 'CE' ? 'ce' : 'pe'] = c;
  }
  if (!byStrike.size) return null;
  const spot = eodClose(md, symbol, date) ?? undefined;
  // The future the options are written on (MCX: the one the expiry settles into).
  const futs = md.history.dailyFutures(sym(symbol), date, date).filter((x) => x.date === date && x.expiry >= expiry).sort((a, b) => a.expiry.localeCompare(b.expiry));
  const f = md.calendar.exchange === 'MCX' ? futs[0] : eodFuture(md, symbol, expiry, date);
  const future = f && f.volume > 0 ? (isPos(f.settle) ? f.settle : isPos(f.close) ? f.close : undefined) : undefined;
  const T = timeToExpiry(expiry, md.calendar.ts(date, md.calendar.sessionMinutes(date)), md.calendar.exchange);
  const rows = [...byStrike.values()];
  const fwd = impliedForward({ spot, future, rows }, T, md.pricing.r);
  if (!fwd) return null;
  return atmIvOf(rows, fwd.forward, T, md.pricing.r, spot ?? fwd.forward)?.iv ?? null;
}

/* ------------------------------------------------------------------------------------------ */
/* Underlying quote                                                                             */
/* ------------------------------------------------------------------------------------------ */

/**
 * Live quote of an underlying. ltp = the spot's live-session price (NoLiveData when there is none);
 * prevClose from the quote, else the official close of the previous session; open/high/low from
 * the quote (null when absent); future = the near future's live price; atmIv solved by md.pricing.
 */
export function underlyingQuote(md: MarketDataProvider, symbol: string): Quote {
  md = mdFor(md, symbol);
  const u = md.ref.underlying(symbol);
  const now = md.clock.now();
  const dates = liveDates(md);
  const key = spotKey(u.symbol);
  const q = md.live.quote(key);
  const ltp = livePrice(md, q, dates);
  if (!q || ltp === null) {
    md.live.watch([key], 'quote');
    throw new NoLiveData(q ? `${u.symbol}: no trade of the live session yet` : `No live price for ${u.symbol}`);
  }
  const prevDate = md.calendar.prev(sessionDateOf(md, q.ts));
  const prevClose = isPos(q.prevClose) ? q.prevClose : eodClose(md, u.symbol, prevDate);
  const fe = nearFuture(md, u.symbol, now);
  let future: number | null = null;
  let futureChange: number | null = null;
  if (fe) {
    const fq = md.live.quote(futKey(u.symbol, fe));
    future = livePrice(md, fq, dates);
    const fPrev = fq && isPos(fq.prevClose) ? fq.prevClose : fq ? tradedClose(eodFuture(md, u.symbol, fe, md.calendar.prev(sessionDateOf(md, fq.ts)))) : null;
    futureChange = future !== null && fPrev !== null ? r2(future - fPrev) : null;
  }
  return {
    symbol: u.symbol,
    ltp,
    ...changeOf(ltp, prevClose),
    open: isPos(q.open) ? q.open : null,
    high: isPos(q.high) ? q.high : null,
    low: isPos(q.low) ? q.low : null,
    prevClose,
    future,
    futureExpiry: fe,
    futureChange,
    atmIv: pct(md.pricing.atmIv(u.symbol)),
    ts: q.ts,
  };
}

/**
 * As-of quote of an underlying at a past `at`, from recorded minutes only: ltp = the last recorded
 * minute close, `ts` = that minute; NoLiveData when that minute ended more than
 * AS_OF_RECORDING_SLACK_MIN before `at` (the recorder was not running then). open/high/low over that
 * day's traded minutes up to `at`, only when the recording covers the session's open (else null);
 * prevClose = official close of the previous session; future = the nearest recorded future and
 * atmIv = the recorded chain minute, each only when recorded just before `at` (else null).
 */
export function underlyingQuoteAt(md: MarketDataProvider, symbol: string, at: number): Quote {
  md = mdFor(md, symbol);
  const u = md.ref.underlying(symbol);
  const date = md.calendar.session(at).date;
  requireRecorded(md, date);
  const rec = md.intraday.at(spotKey(u.symbol), at);
  if (!rec) throw new NoLiveData(`No recorded ${u.symbol} price at ${formatTimeIST(at)} on ${date}`);
  if (!recordedNear(md, rec, at)) throw notRecordingAt(md, u.symbol, at, rec.ts);
  const traded = recordedFromOpen(md, spotKey(u.symbol), date, true) ? minutesUpTo(md, spotKey(u.symbol), at).filter((r) => r.traded) : [];
  const prevDate = md.calendar.prev(onOrBefore(md, date));
  const prevClose = eodClose(md, u.symbol, prevDate);
  const keys = md.intraday.recordedKeys(date).filter((k) => k.symbol === u.symbol && k.expiry && md.calendar.expiryTs(k.expiry) > at);
  const fut = keys.filter((k) => k.kind === 'FUT').sort((a, b) => (a.expiry as string).localeCompare(b.expiry as string))[0];
  const futRec = fut ? md.intraday.at(fut, at) : undefined;
  const future = futRec && recordedNear(md, futRec, at) ? futRec.close : null;
  const fPrev = fut ? tradedClose(eodFuture(md, u.symbol, fut.expiry as string, prevDate)) : null;
  const optExp = keys.filter((k) => k.kind === 'CE' || k.kind === 'PE').map((k) => k.expiry as string).sort()[0];
  const cmLast = optExp ? md.intraday.chainSeries(u.symbol, optExp, date).filter((c) => c.ts + MINUTE <= at).at(-1) : undefined;
  const cm = recordedNear(md, cmLast, at) ? cmLast : undefined;
  return {
    symbol: u.symbol,
    ltp: rec.close,
    ...changeOf(rec.close, prevClose),
    open: traded[0]?.open ?? null,
    high: traded.length ? Math.max(...traded.map((r) => r.high)) : null,
    low: traded.length ? Math.min(...traded.map((r) => r.low)) : null,
    prevClose,
    future,
    futureExpiry: fut?.expiry ?? null,
    futureChange: future !== null && fPrev !== null ? r2(future - fPrev) : null,
    atmIv: pct(cm?.atmIv ?? null),
    ts: rec.ts,
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Option chain                                                                                 */
/* ------------------------------------------------------------------------------------------ */

export interface BuildChainOptions {
  /** As-of time (epoch ms in the past): the chain is built from md.intraday.chainAt only. */
  at?: number;
}

const BLANK_LEG: OptionQuote = {
  ltp: null,
  change: null,
  changePct: null,
  prevClose: null,
  oi: null,
  prevOi: null,
  oiChange: null,
  oiChangePct: null,
  volume: null,
  iv: null,
  delta: null,
  gamma: null,
  theta: null,
  vega: null,
  bid: null,
  ask: null,
  bidQty: null,
  askQty: null,
  buildUp: null,
  intrinsic: null,
  timeValue: null,
  ivSource: null,
  ivTs: null,
  ts: null,
};

export const blankLeg = (): OptionQuote => ({ ...BLANK_LEG });

/** Gap reason of a chain whose forward is spot carried at r: no dividend yield is implied, so no carry is shown. */
const SPOT_CARRY_GAP = (what: 'live' | 'recorded') =>
  `The forward is spot carried at r (no ${what} future or put-call pair): the dividend yield is not implied, so the carry is unknown`;

interface ChainCtx {
  md: MarketDataProvider;
  symbol: string;
  expiry: string;
  evalTs: number;
  /** Valuation time of the chain (md.pricing.valuationTs of evalTs). */
  valTs: number;
  asOf: boolean;
  dates: ReadonlySet<string> | null;
  spot: number | null;
  forward: number | null;
  prev: Map<string, DailyOption>;
}

/**
 * One leg: ltp = live-session trade (as-of: the recorded minute close); bid/ask only from a live book
 * (as-of: the book recorded with the minute just completed at `at`); IV/Greeks from md.pricing on the mid of a sane live
 * book, else the ltp (ivSource says which), null without a premium or a forward; valued at the chain's
 * valuation time, a live LTP at its own trade time (ivTs); prevOi/prevClose from the quote, else the
 * previous session's official row (its close only when it traded).
 */
function buildLeg(c: ChainCtx, type: OptKind, strike: number, q: LiveQuote | undefined, stale = false): OptionQuote {
  if (!q) return blankLeg();
  const { md } = c;
  const ltp = c.asOf ? (isPos(q.ltp) ? q.ltp : null) : livePrice(md, q, c.dates ?? undefined);
  // As-of: the book recorded with the leg's minute, only when that minute is the one just completed
  // at `at` (q.ts is the minute's start; after the close: at the close, so an `at` after 15:30 shows
  // the last minute's book as ?at=15:30 does); an older minute's book is not the book at `at`.
  const asOfBookFresh = c.asOf && asOfRef(md, c.evalTs) - q.ts < 2 * MINUTE;
  const book = c.asOf ? (asOfBookFresh && isPos(q.bid) && isPos(q.ask) && q.ask >= q.bid ? { bid: q.bid, ask: q.ask, bidQty: null, askQty: null, ts: q.ts } : null) : liveBook(md, q, c.evalTs);
  const mid = saneMid(book);
  // As-of: a leg last recorded well before `at` (stale) keeps its own ltp/ts but no IV is solved at `at` from it.
  const premium = stale ? null : mid ?? ltp;
  const ivSource: OptionQuote['ivSource'] = stale ? null : mid !== null ? 'mid' : ltp !== null ? 'ltp' : null;
  // A live LTP is valued at its own trade time (an older trade is not decayed to now); a mid at the chain's valuation time.
  const ivTs = ivSource === null ? null : ivSource === 'ltp' && !c.asOf ? md.pricing.valuationTs(c.valTs, q.ltt, c.symbol) : c.valTs;
  let iv: number | null = null;
  let g: ReturnType<MarketDataProvider['pricing']['greeks']> = null;
  if (premium !== null && ivTs !== null && c.forward !== null) {
    iv = md.pricing.iv({ symbol: c.symbol, expiry: c.expiry, type, strike, premium, ts: ivTs, forward: c.forward });
    if (iv !== null) g = md.pricing.greeks({ symbol: c.symbol, expiry: c.expiry, type, strike, iv, ts: ivTs, forward: c.forward });
  }
  const eod = c.prev.get(`${type}|${strike}`);
  const prevClose = isPos(q.prevClose) && !c.asOf ? q.prevClose : tradedClose(eod);
  const oi = isNum(q.oi) ? q.oi : null;
  const prevOi = isNum(q.prevOi) && !c.asOf ? q.prevOi : eod && isNum(eod.oi) ? eod.oi : null;
  const ch = changeOf(ltp, prevClose);
  const oiChange = oi !== null && prevOi !== null ? oi - prevOi : null;
  const intrinsic = c.spot !== null ? Math.max(0, type === 'CE' ? c.spot - strike : strike - c.spot) : null;
  return {
    ltp,
    ...ch,
    prevClose,
    oi,
    prevOi,
    oiChange,
    oiChangePct: oiChange !== null && prevOi ? r2((oiChange / prevOi) * 100) : null,
    volume: isNum(q.volume) ? q.volume : null,
    iv: pct(iv),
    delta: rn(g?.delta, 4),
    gamma: rn(g?.gamma, 6),
    theta: rn(g?.theta, 2),
    vega: rn(g?.vega, 2),
    bid: book ? book.bid : null,
    ask: book ? book.ask : null,
    bidQty: book ? book.bidQty : null,
    askQty: book ? book.askQty : null,
    buildUp: ch.change !== null && oiChange !== null ? classifyBuildUp(ch.change, oiChange) : null,
    intrinsic: r2(intrinsic),
    timeValue: ltp !== null && intrinsic !== null ? r2(Math.max(0, ltp - intrinsic)) : null,
    ivSource,
    ivTs,
    ts: q.ts,
  };
}

/**
 * Option chain of one expiry (nearest listed when omitted). Live: md.live.chain + per-leg IV/Greeks
 * (buildLeg). As-of (`opts.at`): md.intraday.chainAt only. Aggregates (PCR, max pain, totals,
 * support/resistance) use real OI of the strikes that have it on both sides (`coverage` says which);
 * OI changes need every such strike's previous-close OI, else null. ivChange = ATM IV now − ATM IV
 * solved from the previous session's official traded closes (null when those are not loaded).
 * IV, Greeks, forward, carry and daysToExpiry are valued at md.pricing.valuationTs of now (or `at`):
 * outside the session the close of the last session, whose premiums they are.
 * NoLiveData when nothing of the chain is live (or recorded at `at`), and for an `at` at which the
 * recorder was not running (recordedNear on the spot, else on the newest recorded leg). As-of, a leg
 * (or the future) not itself recordedNear `at` keeps its ltp/OI and own `ts` but gets no IV and is left
 * out of the forward, ATM IV and the OI aggregates (`gaps.staleLegs` counts them). 400 for an
 * expiry that is not listed or has expired.
 */
export async function buildOptionChain(md: MarketDataProvider, symbol: string, expiry?: string | null, opts: BuildChainOptions = {}): Promise<OptionChain> {
  md = mdFor(md, symbol);
  const u = md.ref.underlying(symbol);
  const s = u.symbol;
  const now = md.clock.now();
  const asOf = opts.at !== undefined && opts.at < now;
  const evalTs = asOf ? (opts.at as number) : now;
  const valTs = md.pricing.valuationTs(evalTs, undefined, s);
  const gaps = new Gaps();
  const r = md.pricing.r;
  const exchange = md.calendar.exchange;

  let expiries: string[];
  if (asOf) expiries = recordedExpiries(md, s, evalTs).options;
  else expiries = liveOptionExpiries(md, s, now);
  if (expiry && !isIsoDate(expiry)) throw httpError(400, `expiry must be YYYY-MM-DD (got '${expiry}')`);
  const exp = expiry || expiries[0];
  if (!exp) throw new NoLiveData(asOf ? `No recorded ${s} option chain on ${md.calendar.session(evalTs).date}` : `No ${s} option expiry is listed`);
  if (!expiries.includes(exp)) {
    if (asOf) throw new NoLiveData(`No recorded ${s} ${exp} option chain on ${md.calendar.session(evalTs).date}`);
    // Still in the instrument master (it lists the day's contracts until the next load) but past its expiry.
    if (md.calendar.expiryTs(exp) <= now && md.ref.expiries(s, 'OPT').includes(exp)) throw httpError(400, `${s} expiry ${exp} has expired`);
    throw httpError(400, `${exp} is not a listed ${s} option expiry`);
  }

  let raw: RawChain;
  /** As-of: the legs whose last record is not recordedNear `at` (`${type}|${strike}`); left out of IV and the aggregates. */
  const staleLegs = new Set<string>();
  /** `raw` without the stale legs (and a stale future): the input of the forward and ATM IV. */
  let fresh: RawChain | undefined;
  if (asOf) {
    const rec = md.intraday.chainAt(s, exp, evalTs);
    if (!rec) throw new NoLiveData(`No recorded ${s} ${exp} option chain at ${formatTimeIST(evalTs)} on ${md.calendar.session(evalTs).date}`);
    // The recorder must have been running at `at`: the spot's minute (else the newest recorded leg or future) ended just before it.
    const newest = rec.spot?.ts ?? Math.max(...[rec.future, ...rec.rows.flatMap((row) => [row.ce, row.pe])].map((q) => q?.ts ?? -Infinity));
    if (!recordedNear(md, { ts: newest }, evalTs)) throw notRecordingAt(md, rec.spot ? s : `${s} ${exp} options`, evalTs, Number.isFinite(newest) ? newest : undefined);
    raw = rec;
    // A leg whose last minute ended more than AS_OF_RECORDING_SLACK_MIN before `at` is not the leg at `at`.
    for (const row of raw.rows)
      for (const [type, q] of [['CE', row.ce], ['PE', row.pe]] as const) if (q && !recordedNear(md, q, evalTs)) staleLegs.add(`${type}|${row.strike}`);
    const staleFuture = !!raw.future && !recordedNear(md, raw.future, evalTs);
    if (staleLegs.size || staleFuture) {
      const legs = raw.rows.reduce((a, row) => a + (row.ce ? 1 : 0) + (row.pe ? 1 : 0), 0);
      gaps.add(
        'staleLegs',
        `${staleLegs.size} of ${legs} recorded legs${staleFuture ? ' and the future' : ''} were last recorded more than ${AS_OF_RECORDING_SLACK_MIN} min before ${formatTimeIST(asOfRef(md, evalTs))}: ` +
          'they are shown at their own time (ts) and left out of IV, ATM IV, the forward, PCR, max pain and the OI totals',
      );
      fresh = {
        ...raw,
        rows: raw.rows.map((row) => ({
          strike: row.strike,
          ce: staleLegs.has(`CE|${row.strike}`) ? undefined : row.ce,
          pe: staleLegs.has(`PE|${row.strike}`) ? undefined : row.pe,
        })),
        future: staleFuture ? undefined : raw.future,
      };
    }
  } else raw = await md.live.chain(s, exp);
  fresh ??= raw;

  const session = asOf ? onOrBefore(md, md.calendar.session(evalTs).date) : currentSession(md, now);
  const prevDate = md.calendar.prev(session);
  const dates = asOf ? null : liveDates(md);
  const T = timeToExpiry(exp, valTs, exchange);
  // The future the options are written on: same expiry (NSE/BSE), the one the expiry settles into (MCX).
  const fe = md.ref.underlyingFuture(s, exp) ?? exp;

  // Spot and its change.
  const spotQ = asOf ? raw.spot : md.live.quote(spotKey(s));
  const spot = asOf ? (raw.spot && isPos(raw.spot.ltp) ? raw.spot.ltp : null) : livePrice(md, spotQ, dates ?? undefined);
  if (spot === null) gaps.add('spot', asOf ? `No recorded ${s} price at ${formatTimeIST(evalTs)}` : `No live ${s} price`);
  const spotTs = spot !== null && spotQ ? spotQ.ts : null;
  const spotPrev = !asOf && spotQ && isPos(spotQ.prevClose) ? spotQ.prevClose : eodClose(md, s, prevDate);
  const spotCh = changeOf(spot, spotPrev);

  // Forward of this expiry (Black-76 input): md.pricing.forward when live; without a live spot the
  // forward itself can still come from the future or a put-call pair (carry then unknown).
  const legPrice = (q: LiveQuote | undefined): number | undefined => {
    // Live: a pre-open future price is newer than the valuation time of the premiums (isAfterValuation).
    if (!asOf && q && isAfterValuation(q, md.calendar, valTs)) return undefined;
    const p = asOf ? (q && isPos(q.ltp) ? q.ltp : null) : livePrice(md, q, dates ?? undefined);
    return p ?? undefined;
  };
  const premiumRows: PremiumRow[] = fresh.rows.map((row) => ({ strike: row.strike, ce: legPrice(row.ce), pe: legPrice(row.pe) }));
  const sameFut = fresh.future && fresh.future.key.expiry === fe ? legPrice(fresh.future) : undefined;
  let forward: number | null = null;
  let forwardSource: OptionChain['forwardSource'] = null;
  let carry: number | null = null;
  if (!asOf) {
    try {
      const f = md.pricing.forward(s, exp);
      forward = f.forward;
      forwardSource = f.source;
      if (f.source === 'spot') gaps.add('carry', SPOT_CARRY_GAP('live'));
      else carry = rn(r - f.carry, 6);
    } catch (e) {
      if (!(e instanceof NoLiveData)) throw e;
      const f = impliedForward({ future: sameFut, rows: premiumRows }, T, r);
      if (f) {
        forward = f.forward;
        forwardSource = f.source;
        gaps.add('carry', e.message);
      } else gaps.add('forward', e.message);
    }
  } else {
    const f = impliedForward({ spot: spot ?? undefined, future: sameFut, rows: premiumRows }, T, r);
    if (f) {
      forward = f.forward;
      forwardSource = f.source;
      if (f.source === 'spot') gaps.add('carry', SPOT_CARRY_GAP('recorded'));
      else if (spot !== null && T > 0) carry = rn(r - Math.log(f.forward / spot) / T, 6);
      else gaps.add('carry', 'No recorded spot price to imply the carry from');
    } else gaps.add('forward', `No recorded future, put-call pair or spot price for ${s} ${exp}`);
  }
  if (forward === null) gaps.add('iv', 'IV and Greeks need a forward price (live future, put-call pair or spot)');

  const prev = eodOptions(md, s, exp, prevDate);
  const ctx: ChainCtx = { md, symbol: s, expiry: exp, evalTs, valTs, asOf, dates, spot, forward, prev };

  // Rows: the chain's strikes plus listed strikes inside its range (blank legs), ascending.
  const byStrike = new Map<number, { ce?: LiveQuote; pe?: LiveQuote }>();
  for (const row of raw.rows) byStrike.set(row.strike, { ce: row.ce, pe: row.pe });
  const covered = [...byStrike.keys()].sort((a, b) => a - b);
  let listed: number[] = [];
  if (!asOf) {
    try {
      listed = md.ref.strikes(s, exp);
    } catch (e) {
      if (!(e instanceof NoLiveData)) throw e;
    }
    if (covered.length) for (const k of listed) if (k >= covered[0] && k <= covered[covered.length - 1] && !byStrike.has(k)) byStrike.set(k, {});
  }
  const rows: ChainRow[] = [...byStrike.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([strike, legs]) => ({
      strike,
      ce: buildLeg(ctx, 'CE', strike, legs.ce, staleLegs.has(`CE|${strike}`)),
      pe: buildLeg(ctx, 'PE', strike, legs.pe, staleLegs.has(`PE|${strike}`)),
    }));

  // OI aggregates over strikes with real OI on both sides (as-of: neither leg stale).
  const both = rows.filter((row) => row.ce.oi !== null && row.pe.oi !== null && !staleLegs.has(`CE|${row.strike}`) && !staleLegs.has(`PE|${row.strike}`));
  const oiRows: StrikeOI[] = both.map((row) => ({
    strike: row.strike,
    ceOI: row.ce.oi as number,
    peOI: row.pe.oi as number,
    ...(row.ce.oiChange !== null ? { ceOIChange: row.ce.oiChange } : {}),
    ...(row.pe.oiChange !== null ? { peOIChange: row.pe.oiChange } : {}),
  }));
  const totalCeOi = oiRows.length ? oiRows.reduce((a, x) => a + x.ceOI, 0) : null;
  const totalPeOi = oiRows.length ? oiRows.reduce((a, x) => a + x.peOI, 0) : null;
  if (!oiRows.length) gaps.add('oi', 'No strike has open interest on both sides');
  const changesKnown = both.length > 0 && both.every((row) => row.ce.oiChange !== null && row.pe.oiChange !== null);
  if (both.length && !changesKnown) {
    const missing = both.filter((row) => row.ce.oiChange === null || row.pe.oiChange === null).length;
    gaps.add('oiChange', `Previous-close OI missing for ${missing} of ${both.length} strikes (${exchange === 'MCX' ? `the ${prevDate} MCX session was not recorded by this app` : `official F&O file for ${prevDate} not loaded`} or the contracts are new)`);
  }
  const volRows = both.filter((row) => row.ce.volume !== null && row.pe.volume !== null);
  const ceVol = volRows.reduce((a, row) => a + (row.ce.volume as number), 0);
  const peVol = volRows.reduce((a, row) => a + (row.pe.volume as number), 0);
  const sr = oiRows.length ? oiSupportResistance(oiRows) : null;
  const lo = both[0]?.strike;
  const hi = both[both.length - 1]?.strike;
  const coverage = both.length
    ? `${both.length} ${asOf ? 'recorded' : 'live'} strikes with OI on both sides (${lo}–${hi})${!asOf && listed.length ? ` of ${listed.length} listed` : ''}`
    : 'no strike with OI on both sides';

  // ATM, ATM IV and its change vs the previous close.
  const ref = forward ?? spot;
  let atm: number | null = null;
  if (ref !== null) for (const row of rows) if (atm === null || Math.abs(row.strike - ref) < Math.abs(atm - ref)) atm = row.strike;
  const atmIvDec = asOf ? (chainAtmIv(fresh, r, valTs, { exchange, futureExpiry: fe })?.iv ?? null) : md.pricing.atmIv(s, exp);
  if (atmIvDec === null) gaps.add('atmIv', 'ATM IV could not be solved from the available premiums');
  const prevAtmIv = eodAtmIvOf(md, s, exp, prevDate);
  if (prevAtmIv === null) gaps.add('ivChange', `No traded official option closes of ${s} ${exp} for ${prevDate}`);
  const atmIv = pct(atmIvDec);
  const ivChange = atmIvDec !== null && prevAtmIv !== null ? r2((atmIvDec - prevAtmIv) * 100) : null;

  // The future shown in the header: same expiry when listed, else the nearest.
  let future: number | null = null;
  let futureExpiry: string | null = null;
  if (asOf) {
    if (fresh.future) {
      future = isPos(fresh.future.ltp) ? fresh.future.ltp : null;
      futureExpiry = fresh.future.key.expiry ?? null;
    }
  } else {
    futureExpiry = md.ref.listing(futKey(s, fe)) ? fe : nearFuture(md, s, now);
    if (futureExpiry) future = livePrice(md, md.live.quote(futKey(s, futureExpiry)), dates ?? undefined);
  }

  let lotSize = u.lotSize;
  if (!asOf) {
    const first = rows.find((row) => row.ce.ts !== null || row.pe.ts !== null);
    const l = first ? md.ref.listing(optKey(s, exp, 'CE', first.strike)) ?? md.ref.listing(optKey(s, exp, 'PE', first.strike)) : undefined;
    if (l) lotSize = l.lotSize;
  }

  return {
    symbol: s,
    expiry: exp,
    expiries,
    ts: evalTs,
    valuationTs: valTs,
    spot,
    spotTs,
    spotChange: spotCh.change,
    spotChangePct: spotCh.changePct,
    future,
    futureExpiry,
    forward: r2(forward),
    forwardSource,
    carry,
    lotSize,
    strikeStep: u.strikeStep,
    daysToExpiry: +daysToExpiry(valTs, exp, exchange).toFixed(2),
    atm,
    atmIv,
    ivChange,
    pcr: totalCeOi && totalPeOi !== null ? r2(totalPeOi / totalCeOi) : null,
    pcrVolume: ceVol > 0 ? r2(peVol / ceVol) : null,
    maxPain: oiRows.length ? maxPain(oiRows).maxPain : null,
    totalCeOi,
    totalPeOi,
    totalCeOiChange: changesKnown ? both.reduce((a, row) => a + (row.ce.oiChange as number), 0) : null,
    totalPeOiChange: changesKnown ? both.reduce((a, row) => a + (row.pe.oiChange as number), 0) : null,
    support: sr && Number.isFinite(sr.support) ? sr.support : null,
    resistance: sr && Number.isFinite(sr.resistance) ? sr.resistance : null,
    coverage,
    rows,
    ...gaps.out(),
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Futures                                                                                      */
/* ------------------------------------------------------------------------------------------ */

function futureRow(
  symbol: string,
  expiry: string,
  v: { ltp: number | null; prevClose: number | null; oi: number | null; prevOi: number | null; volume: number | null; spot: number | null; ts: number | null },
): FuturesQuote {
  const ch = changeOf(v.ltp, v.prevClose);
  const oiChange = v.oi !== null && v.prevOi !== null ? v.oi - v.prevOi : null;
  let buildUp: BuildUp | null = null;
  if (ch.change !== null && oiChange !== null) buildUp = classifyBuildUp(ch.change, oiChange);
  return {
    symbol,
    expiry,
    ltp: v.ltp,
    ...ch,
    oi: v.oi,
    oiChange,
    oiChangePct: oiChange !== null && v.prevOi ? r2((oiChange / v.prevOi) * 100) : null,
    volume: v.volume,
    basis: v.ltp !== null && v.spot !== null ? r2(v.ltp - v.spot) : null,
    buildUp,
    ts: v.ts,
  };
}

/**
 * Every listed (unexpired) future of an underlying. ltp = live-session trade; prevClose from the quote,
 * else the previous session's official close when that future traded; prevOi from the quote, else the
 * official OI; basis vs the live spot. A future without a quote is a row of nulls (and is watched).
 */
export function futuresQuotes(md: MarketDataProvider, symbol: string): FuturesQuote[] {
  md = mdFor(md, symbol);
  const u = md.ref.underlying(symbol);
  const now = md.clock.now();
  const dates = liveDates(md);
  const spot = livePrice(md, md.live.quote(spotKey(u.symbol)), dates);
  const exps = [...md.ref.expiries(u.symbol, 'FUT')].sort().filter((e) => md.calendar.expiryTs(e) > now);
  const missing: InstrumentKey[] = [];
  const rows = exps.map((expiry) => {
    const key = futKey(u.symbol, expiry);
    const q = md.live.quote(key);
    if (!q) missing.push(key);
    const prevDate = md.calendar.prev(q ? sessionDateOf(md, q.ts) : currentSession(md, now));
    const eod = eodFuture(md, u.symbol, expiry, prevDate);
    return futureRow(u.symbol, expiry, {
      ltp: livePrice(md, q, dates),
      prevClose: q && isPos(q.prevClose) ? q.prevClose : tradedClose(eod),
      oi: q && isNum(q.oi) ? q.oi : null,
      prevOi: q && isNum(q.prevOi) ? q.prevOi : eod && isNum(eod.oi) ? eod.oi : null,
      volume: q && isNum(q.volume) ? q.volume : null,
      spot,
      ts: q?.ts ?? null,
    });
  });
  if (missing.length) md.live.watch(missing, 'quote');
  return rows;
}

/**
 * As-of futures at a past `at` from recorded minutes (previous-session values from the official
 * files); NoLiveData when the recorder was not running at `at` (recordedNear on the spot, else on the
 * newest future). Each row is its future's last recorded minute (`ts`); its basis only when that
 * minute and the spot's were both recorded just before `at`. Volume = the recorded minute volumes
 * (plus the volume recorded after feed gaps) up to `at`, only when the future was recorded from the
 * session's open and no minute's volume is a lower bound (`partial`: a recording restarted inside
 * it); else null, as a partial sum is not the session volume.
 */
export function futuresQuotesAt(md: MarketDataProvider, symbol: string, at: number): FuturesQuote[] {
  md = mdFor(md, symbol);
  const u = md.ref.underlying(symbol);
  const date = md.calendar.session(at).date;
  requireRecorded(md, date);
  const prevDate = md.calendar.prev(onOrBefore(md, date));
  const spotRec = md.intraday.at(spotKey(u.symbol), at);
  if (spotRec && !recordedNear(md, spotRec, at)) throw notRecordingAt(md, u.symbol, at, spotRec.ts);
  const spot = spotRec?.close ?? null;
  const keys = md.intraday
    .recordedKeys(date)
    .filter((k) => k.symbol === u.symbol && k.kind === 'FUT' && k.expiry && md.calendar.expiryTs(k.expiry) > at)
    .sort((a, b) => (a.expiry as string).localeCompare(b.expiry as string));
  if (!keys.length) throw new NoLiveData(`No recorded ${u.symbol} futures on ${date}`);
  const series = keys.map((key) => ({ key, recs: minutesUpTo(md, key, at) }));
  if (!spotRec) {
    const newest = Math.max(...series.map((x) => x.recs.at(-1)?.ts ?? -Infinity));
    if (!recordedNear(md, { ts: newest }, at)) throw notRecordingAt(md, `${u.symbol} futures`, at, Number.isFinite(newest) ? newest : undefined);
  }
  return series.map(({ key, recs }) => {
    const last = recs.at(-1);
    const eod = eodFuture(md, u.symbol, key.expiry as string, prevDate);
    const vols = recordedFromOpen(md, key, date) && !recs.some((x) => x.partial) ? recs.filter((x) => isNum(x.volume) || isNum(x.gapVolume)) : [];
    return futureRow(u.symbol, key.expiry as string, {
      ltp: last ? last.close : null,
      prevClose: tradedClose(eod),
      oi: last && isNum(last.oi) ? last.oi : null,
      prevOi: eod && isNum(eod.oi) ? eod.oi : null,
      volume: vols.length ? vols.reduce((a, x) => a + (x.volume ?? 0) + (x.gapVolume ?? 0), 0) : null,
      spot: recordedNear(md, last, at) ? spot : null,
      ts: last ? last.ts : null,
    });
  });
}

/* ------------------------------------------------------------------------------------------ */
/* Candles                                                                                      */
/* ------------------------------------------------------------------------------------------ */

const INTERVALS: Record<string, CandleInterval> = {
  '1': '1min',
  '3': '3min',
  '5': '5min',
  '10': '10min',
  '15': '15min',
  '30': '30min',
  '60': '60min',
  D: 'D',
  '1min': '1min',
  '3min': '3min',
  '5min': '5min',
  '10min': '10min',
  '15min': '15min',
  '30min': '30min',
  '60min': '60min',
};

/**
 * Sessions one request may span, per interval. Every intraday interval is resampled from 1-minute
 * bars, which Kotak serves for active contracts through the slow lane (≤ 1 call / 1.5 s), so intraday
 * ranges are capped at 30 sessions; daily bars come from the local EOD store.
 */
export const MAX_CANDLE_SESSIONS: Record<CandleInterval, number> = {
  '1min': 30,
  '3min': 30,
  '5min': 30,
  '10min': 30,
  '15min': 30,
  '30min': 30,
  '60min': 30,
  D: 400,
};

export function parseInterval(interval: string | undefined): CandleInterval {
  const iv = INTERVALS[(interval ?? '5').trim()];
  if (!iv) throw httpError(400, `Unsupported interval '${interval}' (1, 3, 5, 10, 15, 30, 60 or D)`);
  return iv;
}

/** The last `count` trading sessions ending at `to` (ascending). */
export function sessionsBack(md: MarketDataProvider, to: string, count: number): string[] {
  const out = [onOrBefore(md, to)];
  while (out.length < count) out.unshift(md.calendar.prev(out[0]));
  return out;
}

const toCandle = (c: { ts: number; open?: number; high?: number; low?: number; close: number; volume?: number; gapVolume?: number; partial?: true }): Candle => ({
  ts: c.ts,
  open: c.open ?? null,
  high: c.high ?? null,
  low: c.low ?? null,
  close: c.close,
  volume: c.volume ?? null,
  ...(c.gapVolume !== undefined ? { gapVolume: c.gapVolume } : {}),
  ...(c.partial ? { partial: true } : {}),
});

/**
 * Candles of the last `days` sessions (clamped to MAX_CANDLE_SESSIONS) of an underlying spot (string)
 * or any key, over md.candles: intraday from recorded traded minutes or Kotak 1-minute history of
 * active contracts; 'D' from the official EOD files, plus today's live bar (quote open/high/low/LTP)
 * while today's file is not loaded. As-of (`opts.at`): recorded minutes completed by `at` only.
 * NoLiveData when nothing is available.
 */
export async function candles(md: MarketDataProvider, target: string | InstrumentKey, interval: string | undefined, days: number, opts: { at?: number } = {}): Promise<Candle[]> {
  const key = typeof target === 'string' ? spotKey(target) : { ...target, symbol: sym(target.symbol) };
  md.ref.underlying(key.symbol);
  const iv = parseInterval(interval);
  const count = Math.max(1, Math.min(MAX_CANDLE_SESSIONS[iv], Math.floor(Number.isFinite(days) ? days : 1)));
  const now = md.clock.now();
  const asOf = opts.at !== undefined && opts.at < now;

  if (asOf) {
    if (iv === 'D') throw new NoLiveData('As-of (?at=) answers come from recorded intraday minutes only: daily candles are not served as of a past time');
    const at = opts.at as number;
    const end = md.calendar.session(at).date;
    requireRecorded(md, end);
    const dates = sessionsBack(md, end, count);
    const { minutes } = recordedMinutes(md.intraday, key, dates, '');
    const done = minutes.filter((m) => m.ts + MINUTE <= at);
    if (!done.length) throw new NoLiveData(`No recorded ${iv} candles of ${keyLabel(key)} before ${formatTimeIST(at)} on ${end}`);
    const step = Number(iv.replace('min', ''));
    return resampleMinutes(done, step, md.calendar).map(toCandle);
  }

  const to = currentSession(md, now);
  const dates = sessionsBack(md, to, count);
  if (iv !== 'D') return (await md.candles(key, iv, dates[0], to)).map(toCandle);

  // Daily: official bars, plus today's live bar until today's official file is loaded.
  const today = md.calendar.session(now).date;
  let official: Candle[] = [];
  let reason: string | undefined;
  try {
    official = (await md.candles(key, 'D', dates[0], to)).map(toCandle);
  } catch (e) {
    if (!(e instanceof NoLiveData)) throw e;
    reason = e.message;
  }
  const todayTs = md.calendar.isTradingDay(today) ? md.calendar.ts(today, 0) : null;
  if (todayTs !== null && now >= todayTs && !official.some((c) => c.ts === todayTs)) {
    const q = md.live.quote(key);
    const ltp = livePrice(md, q);
    if (q && ltp !== null && sessionDateOf(md, q.ts) === today) {
      official.push({ ts: todayTs, open: isPos(q.open) ? q.open : null, high: isPos(q.high) ? q.high : null, low: isPos(q.low) ? q.low : null, close: ltp, volume: isNum(q.volume) && q.volume > 0 ? q.volume : null });
    }
  }
  if (!official.length) throw new NoLiveData(reason ?? `No daily candles of ${keyLabel(key)}`);
  return official;
}

/* ------------------------------------------------------------------------------------------ */
/* User-requested instruments                                                                   */
/* ------------------------------------------------------------------------------------------ */

/**
 * Instruments a user is looking at right now (Order Book depth views, tickets …), kept for a TTL and
 * streamed in the provider's 'user' tier (createServices adds them to setUserContracts). The tier is
 * read about once a minute, so callers also md.live.watch() the key for an immediate subscription.
 */
export class UserWatches {
  private readonly items = new Map<string, { key: InstrumentKey; level: WatchLevel; until: number }>();

  constructor(private readonly now: () => number) {}

  touch(keys: InstrumentKey[], level: WatchLevel = 'quote', ttlMs = 120_000): void {
    const until = this.now() + ttlMs;
    for (const k of keys) {
      const id = keyId(k);
      const prev = this.items.get(id);
      const rank: Record<WatchLevel, number> = { ltp: 0, quote: 1, depth: 2 };
      const lvl = prev && prev.until > this.now() && rank[prev.level] > rank[level] ? prev.level : level;
      this.items.set(id, { key: { ...k }, level: lvl, until: Math.max(until, prev?.until ?? 0) });
    }
  }

  list(): UserContract[] {
    const now = this.now();
    const out: UserContract[] = [];
    for (const [id, it] of this.items) {
      if (it.until <= now) this.items.delete(id);
      else out.push({ key: it.key, level: it.level });
    }
    return out;
  }
}
