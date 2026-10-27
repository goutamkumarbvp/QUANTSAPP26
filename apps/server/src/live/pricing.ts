/**
 * IV and Greeks from market premiums, in one place (DESIGN.md §1.2, critic §3 "Option Chain").
 *
 * Model: Black-76 on the forward of the option's own expiry. Core `impliedVol`/`bsGreeks` are BSM
 * with a carry yield; passing S = F and q = r makes them exactly Black-76 (S·e^{−qT} = F·e^{−rT}).
 * The forward comes from, in order:
 *   1. the same-expiry future's live price            → source 'future'
 *   2. put-call parity at the strike nearest spot      → source 'parity'   F = K + e^{rT}(C − P)
 *      (weekly index expiries have no future, MAP §13.6)
 *   3. spot with zero dividend, F = S·e^{rT}           → source 'spot'
 * and NoLiveData when none of them is live. MCX options are written on futures that expire after
 * them: "the same-expiry future" there is the future the option expiry settles into
 * (ReferenceData.underlyingFuture). Time to expiry is calendar time to the close of the expiry date
 * (15:30 IST for NSE/BSE, the MCX close for MCX; /365, core `yearsBetween`), measured from the valuation time (valuationTs): now while
 * the session is open, otherwise the close of the session whose quotes are still live, so values
 * solved from unchanged premiums do not drift overnight, over a weekend or before the open. An LTP
 * premium (no sane live book) is valued at its own last-trade time (premiumTs). There is no fallback
 * IV anywhere: an unsolvable premium gives null.
 *
 * Live quotes count only when they are of the current session date (outside session hours: also
 * the most recent session's date), never yesterday's quotes during today's session, and only when
 * their LTP is a trade of that session (isLivePrice: last-trade time, zero session volume). A `ts`
 * before the valuation time of now without an explicit forward gives null: the live quotes are newer
 * than `ts` (no look-ahead).
 */
import { bsGreeks, bsPrice, expiryTs, impliedVol, yearsBetween, type ExchangeCode, type Greeks } from '@q26/core';
import { NoLiveData } from './types';
import type { ForwardEstimate, InstrumentKey, LiveQuote, OptKind, Pricing, RawChain, ReferenceData, TradingCalendar } from './types';

/* ------------------------------------------------------------------------------------------ */
/* Pure helpers (shared by LivePricing, the recorder and the EOD store)                         */
/* ------------------------------------------------------------------------------------------ */

/** Years from `ts` to the close of the expiry date on its exchange (0 once expired). */
export function timeToExpiry(expiry: string, ts: number, exchange: ExchangeCode = 'NSE'): number {
  return yearsBetween(ts, expiryTs(expiry, exchange));
}

/** Premiums of one strike (rupees); absent sides are not live. */
export interface PremiumRow {
  strike: number;
  ce?: number;
  pe?: number;
}

export interface ForwardInputs {
  spot?: number;
  /** Price of the SAME-expiry future only. */
  future?: number;
  rows: readonly PremiumRow[];
}

const isPos = (n: number | undefined): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** A forward price and where it came from (all Black-76 needs). */
export interface ForwardPrice {
  forward: number;
  source: ForwardEstimate['source'];
}

/**
 * Forward price of one expiry from live/official inputs (see the module comment for the order).
 * Parity uses the strike nearest spot that has both premiums; without a spot, the strike with the
 * smallest |C − P| (that is the strike nearest the forward). Returns null when nothing is usable.
 */
export function impliedForward(input: ForwardInputs, T: number, r: number): ForwardPrice | null {
  const t = Math.max(0, T);
  const S = isPos(input.spot) ? input.spot : undefined;
  if (isPos(input.future)) return { forward: input.future, source: 'future' };

  const pairs = input.rows.filter((row) => isPos(row.strike) && isPos(row.ce) && isPos(row.pe));
  if (pairs.length) {
    const score = S !== undefined ? (row: PremiumRow) => Math.abs(row.strike - S) : (row: PremiumRow) => Math.abs((row.ce as number) - (row.pe as number));
    const ordered = [...pairs].sort((a, b) => score(a) - score(b) || a.strike - b.strike);
    for (const row of ordered) {
      const F = row.strike + Math.exp(r * t) * ((row.ce as number) - (row.pe as number));
      if (isPos(F)) return { forward: F, source: 'parity' };
    }
  }
  if (S !== undefined) return { forward: S * Math.exp(r * t), source: 'spot' };
  return null;
}

/**
 * Forward with the carry r − q it implies over spot, ln(F/S)/T ('spot' source: r by construction).
 * Null when no forward is usable, and also when the carry cannot be implied (no live spot, or the
 * expiry has no time left): the estimate is rejected rather than carrying a NaN.
 */
export function forwardOf(input: ForwardInputs, T: number, r: number): ForwardEstimate | null {
  const f = impliedForward(input, T, r);
  if (!f || !isPos(input.spot) || !(T > 0)) return null;
  return { ...f, carry: f.source === 'spot' ? r : Math.log(f.forward / input.spot) / T };
}

/** Relative + absolute tolerance used to accept a solver result (repricing check). */
const REPRICE_TOL = (premium: number) => 1e-6 + 1e-7 * premium;

/**
 * Black-76 implied vol of a premium (decimal). Null when the premium is non-finite, not strictly
 * above the discounted intrinsic value, at/above the no-arbitrage upper bound, the option has
 * expired, or the solver does not reprice the premium.
 */
export function black76Iv(type: OptKind, premium: number, F: number, K: number, T: number, r: number): number | null {
  if (!isPos(premium) || !isPos(F) || !isPos(K) || !(T > 0) || !Number.isFinite(r)) return null;
  const df = Math.exp(-r * T);
  const lower = type === 'CE' ? Math.max(0, df * (F - K)) : Math.max(0, df * (K - F));
  const upper = type === 'CE' ? df * F : df * K;
  if (premium <= lower + 1e-9 || premium >= upper) return null;
  const iv = impliedVol(type, premium, F, K, T, r, r);
  if (!Number.isFinite(iv) || iv <= 1e-4) return null;
  if (Math.abs(bsPrice(type, F, K, T, r, iv, r) - premium) > REPRICE_TOL(premium)) return null;
  return iv;
}

/** Black-76 price (S = F, q = r). */
export function black76Price(type: OptKind, F: number, K: number, T: number, r: number, iv: number): number {
  return bsPrice(type, F, K, T, r, iv, r);
}

/** Black-76 Greeks via core bsGreeks (S = F, q = r): delta is w.r.t. the forward; theta per day; vega per vol point. */
export function black76Greeks(type: OptKind, F: number, K: number, T: number, r: number, iv: number): Greeks | null {
  if (!isPos(F) || !isPos(K) || !(T > 0) || !isPos(iv) || !Number.isFinite(r)) return null;
  const g = bsGreeks(type, F, K, T, r, iv, r);
  return Object.values(g).every(Number.isFinite) ? g : null;
}

/**
 * ATM IV: the strike nearest `atm` (default the forward) among strikes with both premiums (any
 * premium when no strike has both); the average of the CE/PE IVs that solve there, priced off F.
 * Null when none solves.
 */
export function atmIvOf(rows: readonly PremiumRow[], F: number, T: number, r: number, atm: number = F): { iv: number; strike: number } | null {
  if (!isPos(F) || !(T > 0)) return null;
  const ref = isPos(atm) ? atm : F;
  const both = rows.filter((row) => isPos(row.strike) && isPos(row.ce) && isPos(row.pe));
  const pool = both.length ? both : rows.filter((row) => isPos(row.strike) && (isPos(row.ce) || isPos(row.pe)));
  if (!pool.length) return null;
  let best = pool[0];
  for (const row of pool) {
    const d = Math.abs(row.strike - ref) - Math.abs(best.strike - ref);
    if (d < 0 || (d === 0 && row.strike < best.strike)) best = row;
  }
  const ivs: number[] = [];
  if (isPos(best.ce)) {
    const v = black76Iv('CE', best.ce, F, best.strike, T, r);
    if (v !== null) ivs.push(v);
  }
  if (isPos(best.pe)) {
    const v = black76Iv('PE', best.pe, F, best.strike, T, r);
    if (v !== null) ivs.push(v);
  }
  if (!ivs.length) return null;
  return { iv: ivs.reduce((a, b) => a + b, 0) / ivs.length, strike: best.strike };
}

/**
 * Forward and ATM IV of a RawChain (live or recorded with IntradayStore.chainAt) at `ts`. The
 * chain's future is used only when it is the one the options are written on: of the chain's own
 * expiry (NSE/BSE), or `opts.futureExpiry` (MCX: the future the expiry settles into).
 */
export function chainAtmIv(
  chain: RawChain,
  r: number,
  ts: number = chain.ts,
  opts: { exchange?: ExchangeCode; futureExpiry?: string } = {},
): { iv: number; strike: number; forward: ForwardPrice } | null {
  const T = timeToExpiry(chain.expiry, ts, opts.exchange);
  const fe = opts.futureExpiry ?? chain.expiry;
  const future = chain.future && chain.future.key.expiry === fe ? chain.future.ltp : undefined;
  const rows: PremiumRow[] = chain.rows.map((row) => ({ strike: row.strike, ce: row.ce?.ltp, pe: row.pe?.ltp }));
  const forward = impliedForward({ spot: chain.spot?.ltp, future, rows }, T, r);
  if (!forward) return null;
  const atm = atmIvOf(rows, forward.forward, T, r);
  return atm ? { ...atm, forward } : null;
}

/* ------------------------------------------------------------------------------------------ */
/* Live pricing                                                                                 */
/* ------------------------------------------------------------------------------------------ */

export interface LivePricingOptions {
  /** Risk-free rate (config input, critic §3 cross-cutting #2). */
  r: number;
  ref: ReferenceData;
  /** Exchange calendar: which session date a quote belongs to. */
  calendar: TradingCalendar;
  /** Calendar of a symbol's exchange (MCX for commodities); default `calendar` for every symbol. */
  calendarOf?: (symbol: string) => TradingCalendar;
  /** Latest live quote of an instrument (LiveMarket.quote). */
  getQuote: (key: InstrumentKey) => LiveQuote | undefined;
  now?: () => number;
  /**
   * Additionally treat quotes older than this as not live (ms). Without it the session rule alone
   * applies: a quote counts only when it is of the current session date (outside session hours:
   * also the most recent session's date).
   */
  maxQuoteAgeMs?: number;
}

/** A `ts` this close to now is "now" (call overhead), not a past evaluation time. */
export const LIVE_TS_SLACK_MS = 5_000;

/**
 * Session dates whose quotes are live at `now`: today; outside session hours also the most recent
 * session (the previous trading day before 09:15 and on holidays, today after the close).
 */
export function liveSessionDates(calendar: TradingCalendar, now: number): Set<string> {
  const s = calendar.session(now);
  const dates = new Set([s.date]);
  if (s.status !== 'open') dates.add(lastStartedSession(calendar, now));
  return dates;
}

/** The most recent session that has started at `ts`: its date from 09:15 on a trading day, else the previous trading day. */
function lastStartedSession(calendar: TradingCalendar, ts: number): string {
  const date = calendar.session(ts).date;
  return calendar.isTradingDay(date) && ts >= calendar.ts(date, 0) ? date : calendar.prev(date);
}

/**
 * Valuation time at `ts` (time to expiry is measured from it): `ts` while the session is open;
 * otherwise the close (15:30 IST; MCX: its close) of the most recent session, the one whose quotes are still live
 * then (liveSessionDates). Outside the session the premiums are that session's last ones; measuring
 * from the clock would decay them overnight and over weekends with no market move.
 */
export function valuationTs(calendar: TradingCalendar, ts: number): number {
  if (calendar.session(ts).status === 'open') return ts;
  const last = lastStartedSession(calendar, ts);
  return Math.min(ts, calendar.ts(last, calendar.sessionMinutes(last)));
}

/**
 * Time a live premium is valued at, given the valuation time `ts` (valuationTs at `now`): an LTP (no
 * sane live book) at its own last-trade time `ltt` when that is a trade of a live session, capped by
 * `ts`; the mid of a live book, or an LTP without a reported trade time, at `ts`.
 */
export function premiumTs(calendar: TradingCalendar, now: number, ts: number, ltt?: number): number {
  if (ltt === undefined || !Number.isFinite(ltt) || !liveSessionDates(calendar, now).has(calendar.session(ltt).date)) return ts;
  return Math.min(ltt, ts);
}

/**
 * The quote's LTP is a trade of a live session (`dates` from liveSessionDates). A quote can be dated
 * today while its LTP is an older trade: the feed stamps the update time (a book change), REST
 * option-chain legs the receive time. So the quote must be of a live date, its last-trade time (when
 * reported) too, and a quote dated after its session opened with a zero session volume has not
 * traded in that session (its LTP is from an earlier one). Callers that use an LTP as a current
 * price (premiums for IV, forwards, marks) apply this rule; the quote itself (book, OI) stays live.
 */
export function isLivePrice(q: Pick<LiveQuote, 'ts' | 'ltt' | 'volume'>, calendar: TradingCalendar, dates: ReadonlySet<string>): boolean {
  if (!Number.isFinite(q.ts)) return false;
  const day = calendar.session(q.ts).date;
  if (!dates.has(day)) return false;
  if (q.ltt !== undefined && Number.isFinite(q.ltt) && !dates.has(calendar.session(q.ltt).date)) return false;
  if (q.volume === 0 && calendar.isTradingDay(day) && q.ts >= calendar.ts(day, 0)) return false;
  return true;
}

/**
 * A spot/future quote whose price is from the pre-open (09:00–09:15) of a session that has not opened
 * yet, i.e. newer than the valuation time `val` (outside the session: the previous close). Premiums
 * are valued at `val`; combined with such a price the overnight gap would be read as IV / carry (a
 * future 0.5 % above Friday's close turns a 14 % IV into 9.6 %). It stays a live quote (shown); it is
 * not an input of the forward / IV valuation until the session opens (then `val` is the clock). Its
 * trade time (`ltt`, else the stamp) decides; options do not trade in the pre-open.
 */
export function isAfterValuation(q: Pick<LiveQuote, 'key' | 'ts' | 'ltt'>, calendar: TradingCalendar, val: number): boolean {
  if (q.key.kind !== 'SPOT' && q.key.kind !== 'FUT') return false;
  const t = q.ltt !== undefined && Number.isFinite(q.ltt) ? q.ltt : q.ts;
  return Number.isFinite(t) && t > val && calendar.session(t).status === 'pre-open';
}

export class LivePricing implements Pricing {
  readonly r: number;
  private readonly now: () => number;

  constructor(private readonly opts: LivePricingOptions) {
    if (!Number.isFinite(opts.r)) throw new Error('LivePricing: r must be a finite number');
    this.r = opts.r;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Session dates whose quotes are live at `now`: today; outside session hours also the most
   * recent session (the previous trading day before 09:15 and on holidays, today after the close).
   */
  private liveDates(cal: TradingCalendar, now: number): Set<string> {
    return liveSessionDates(cal, now);
  }

  /** Calendar of the symbol's exchange. */
  private cal(symbol: string): TradingCalendar {
    return this.opts.calendarOf?.(symbol) ?? this.opts.calendar;
  }

  /** Live price of an instrument, undefined when there is none (or its LTP is not a trade of a live session / too old). */
  private price(key: InstrumentKey, now: number, dates: Set<string>): number | undefined {
    const cal = this.cal(key.symbol);
    const q = this.opts.getQuote(key);
    if (!q || !isPos(q.ltp) || !isLivePrice(q, cal, dates)) return undefined;
    if (this.opts.maxQuoteAgeMs !== undefined && now - q.ts > this.opts.maxQuoteAgeMs) return undefined;
    // A pre-open price is newer than the valuation time of the premiums (isAfterValuation; spot and future
    // quotes only, so the valuation time is not worked out for every option quote).
    if ((key.kind === 'SPOT' || key.kind === 'FUT') && isAfterValuation(q, cal, valuationTs(cal, now))) return undefined;
    return q.ltp;
  }

  /** Listed strikes, [] while the instrument master is not loaded. */
  private strikes(symbol: string, expiry: string): number[] {
    try {
      return this.opts.ref.strikes(symbol, expiry);
    } catch (e) {
      if (e instanceof NoLiveData) return [];
      throw e;
    }
  }

  private premiumRows(symbol: string, expiry: string, now: number, dates: Set<string>): PremiumRow[] {
    return this.strikes(symbol, expiry).map((strike) => ({
      strike,
      ce: this.price({ symbol, kind: 'CE', expiry, strike }, now, dates),
      pe: this.price({ symbol, kind: 'PE', expiry, strike }, now, dates),
    }));
  }

  /**
   * The time a premium is valued at: valuationTs of `ts` (default now); with `ltt`, an LTP premium's
   * last-trade time when it is a trade of a live session, capped by that (premiumTs).
   */
  valuationTs(ts?: number, ltt?: number, symbol?: string): number {
    const now = this.now();
    const cal = symbol ? this.cal(symbol) : this.opts.calendar;
    return premiumTs(cal, now, valuationTs(cal, ts ?? now), ltt);
  }

  /** NoLiveData when no forward is live, when there is no live spot to imply the carry from, or once expired. */
  forward(symbol: string, expiry: string): ForwardEstimate {
    const now = this.now();
    const cal = this.cal(symbol);
    const dates = this.liveDates(cal, now);
    const T = timeToExpiry(expiry, valuationTs(cal, now), cal.exchange);
    if (!(T > 0)) throw new NoLiveData(`${symbol} ${expiry} has expired: no forward`);
    const inputs = this.forwardInputs(symbol, expiry, now, dates);
    const f = forwardOf(inputs, T, this.r);
    if (f) return f;
    if (!impliedForward(inputs, T, this.r)) throw new NoLiveData(`No live future, put-call pair or spot price for ${symbol} ${expiry}`);
    const sq = this.opts.getQuote({ symbol, kind: 'SPOT' });
    const pre = sq && isAfterValuation(sq, cal, valuationTs(cal, now)) ? " (its latest price is a pre-open one, newer than the premiums' valuation time)" : '';
    throw new NoLiveData(`No live spot price for ${symbol}${pre}: the carry of the ${expiry} forward cannot be implied`);
  }

  /** Expiry of the future the options of `expiry` are written on (MCX: the one they settle into). */
  private futureExpiry(symbol: string, expiry: string): string {
    try {
      return this.opts.ref.underlyingFuture(symbol, expiry) ?? expiry;
    } catch {
      return expiry;
    }
  }

  private forwardInputs(symbol: string, expiry: string, now: number, dates: Set<string>): ForwardInputs {
    const spot = this.price({ symbol, kind: 'SPOT' }, now, dates);
    const future = this.price({ symbol, kind: 'FUT', expiry: this.futureExpiry(symbol, expiry) }, now, dates);
    // Parity needs the option quotes only when there is no same-expiry future.
    const rows = future === undefined ? this.premiumRows(symbol, expiry, now, dates) : [];
    return { spot, future, rows };
  }

  iv(input: { symbol: string; expiry: string; type: OptKind; strike: number; premium: number; ts?: number; forward?: number; ltt?: number }): number | null {
    const now = this.now();
    const cal = this.cal(input.symbol);
    const ts = valuationTs(cal, input.ts ?? now);
    const F = input.forward ?? this.liveForward(input.symbol, input.expiry, ts, now);
    if (F === undefined) return null;
    return black76Iv(input.type, input.premium, F, input.strike, timeToExpiry(input.expiry, premiumTs(cal, now, ts, input.ltt), cal.exchange), this.r);
  }

  greeks(input: { symbol: string; expiry: string; type: OptKind; strike: number; iv: number; ts?: number; forward?: number; ltt?: number }): Greeks | null {
    const now = this.now();
    const cal = this.cal(input.symbol);
    const ts = valuationTs(cal, input.ts ?? now);
    const F = input.forward ?? this.liveForward(input.symbol, input.expiry, ts, now);
    if (F === undefined) return null;
    return black76Greeks(input.type, F, input.strike, timeToExpiry(input.expiry, premiumTs(cal, now, ts, input.ltt), cal.exchange), this.r, input.iv);
  }

  atmIv(symbol: string, expiry?: string): number | null {
    const now = this.now();
    const cal = this.cal(symbol);
    const val = valuationTs(cal, now);
    const exp = expiry ?? this.nearestExpiry(symbol, val);
    if (!exp) return null;
    const T = timeToExpiry(exp, val, cal.exchange);
    if (!(T > 0)) return null;
    const dates = this.liveDates(cal, now);
    const F = impliedForward(this.forwardInputs(symbol, exp, now, dates), T, this.r)?.forward;
    if (F === undefined) return null;
    return atmIvOf(this.premiumRows(symbol, exp, now, dates), F, T, this.r)?.iv ?? null;
  }

  /** Nearest listed option expiry that has not expired at `now` (the valuation time). */
  private nearestExpiry(symbol: string, now: number): string | undefined {
    let list: string[];
    try {
      list = this.opts.ref.expiries(symbol, 'OPT');
    } catch (e) {
      if (e instanceof NoLiveData) return undefined;
      throw e;
    }
    const ex = this.cal(symbol).exchange;
    return [...list].sort().find((e) => timeToExpiry(e, now, ex) > 0);
  }

  /**
   * Forward price from the live quotes (future / parity / spot; no spot needed for the first two),
   * undefined when none is live. Undefined for a `ts` before the valuation time of now: the live
   * quotes are newer than it.
   */
  private liveForward(symbol: string, expiry: string, ts: number, now: number): number | undefined {
    const cal = this.cal(symbol);
    const val = valuationTs(cal, now);
    if (ts < val - LIVE_TS_SLACK_MS) return undefined;
    const dates = this.liveDates(cal, now);
    return impliedForward(this.forwardInputs(symbol, expiry, now, dates), timeToExpiry(expiry, val, cal.exchange), this.r)?.forward;
  }
}
