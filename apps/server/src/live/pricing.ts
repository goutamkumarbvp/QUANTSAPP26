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
 * and NoLiveData when none of them is live. Time to expiry is calendar time to 15:30 IST on the
 * expiry date (/365, core `yearsBetween`). There is no fallback IV anywhere: an unsolvable premium
 * gives null.
 */
import { bsGreeks, bsPrice, expiryTs, impliedVol, yearsBetween, type Greeks } from '@q26/core';
import { NoLiveData } from './types';
import type { ForwardEstimate, InstrumentKey, LiveQuote, OptKind, Pricing, RawChain, ReferenceData } from './types';

/* ------------------------------------------------------------------------------------------ */
/* Pure helpers (shared by LivePricing, the recorder and the EOD store)                         */
/* ------------------------------------------------------------------------------------------ */

/** Years from `ts` to 15:30 IST on the expiry date (0 once expired). */
export function timeToExpiry(expiry: string, ts: number): number {
  return yearsBetween(ts, expiryTs(expiry));
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

/** Carry r − q implied by F over S, NaN when it is undefined (no spot, or T = 0). */
function carryOf(F: number, S: number | undefined, T: number): number {
  return isPos(S) && T > 0 ? Math.log(F / S) / T : NaN;
}

/**
 * Forward of one expiry from live/official inputs (see the module comment for the order).
 * Parity uses the strike nearest spot that has both premiums; without a spot, the strike with the
 * smallest |C − P| (that is the strike nearest the forward). Returns null when nothing is usable.
 * `carry` is NaN when it cannot be implied (no spot, or T = 0).
 */
export function forwardOf(input: ForwardInputs, T: number, r: number): ForwardEstimate | null {
  const t = Math.max(0, T);
  const S = isPos(input.spot) ? input.spot : undefined;
  if (isPos(input.future)) return { forward: input.future, carry: carryOf(input.future, S, t), source: 'future' };

  const pairs = input.rows.filter((row) => isPos(row.strike) && isPos(row.ce) && isPos(row.pe));
  if (pairs.length) {
    const score = S !== undefined ? (row: PremiumRow) => Math.abs(row.strike - S) : (row: PremiumRow) => Math.abs((row.ce as number) - (row.pe as number));
    const ordered = [...pairs].sort((a, b) => score(a) - score(b) || a.strike - b.strike);
    for (const row of ordered) {
      const F = row.strike + Math.exp(r * t) * ((row.ce as number) - (row.pe as number));
      if (isPos(F)) return { forward: F, carry: carryOf(F, S, t), source: 'parity' };
    }
  }
  if (S !== undefined) return { forward: S * Math.exp(r * t), carry: r, source: 'spot' };
  return null;
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
 * chain's future is used only when it is of the chain's own expiry.
 */
export function chainAtmIv(chain: RawChain, r: number, ts: number = chain.ts): { iv: number; strike: number; forward: ForwardEstimate } | null {
  const T = timeToExpiry(chain.expiry, ts);
  const future = chain.future && chain.future.key.expiry === chain.expiry ? chain.future.ltp : undefined;
  const rows: PremiumRow[] = chain.rows.map((row) => ({ strike: row.strike, ce: row.ce?.ltp, pe: row.pe?.ltp }));
  const forward = forwardOf({ spot: chain.spot?.ltp, future, rows }, T, r);
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
  /** Latest live quote of an instrument (LiveMarket.quote). */
  getQuote: (key: InstrumentKey) => LiveQuote | undefined;
  now?: () => number;
  /** Treat quotes older than this as not live (ms). Default: no age limit. */
  maxQuoteAgeMs?: number;
}

export class LivePricing implements Pricing {
  readonly r: number;
  private readonly now: () => number;

  constructor(private readonly opts: LivePricingOptions) {
    if (!Number.isFinite(opts.r)) throw new Error('LivePricing: r must be a finite number');
    this.r = opts.r;
    this.now = opts.now ?? (() => Date.now());
  }

  /** Live price of an instrument, undefined when there is none (or it is too old). */
  private price(key: InstrumentKey, now: number): number | undefined {
    const q = this.opts.getQuote(key);
    if (!q || !isPos(q.ltp)) return undefined;
    if (this.opts.maxQuoteAgeMs !== undefined && now - q.ts > this.opts.maxQuoteAgeMs) return undefined;
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

  private premiumRows(symbol: string, expiry: string, now: number): PremiumRow[] {
    return this.strikes(symbol, expiry).map((strike) => ({
      strike,
      ce: this.price({ symbol, kind: 'CE', expiry, strike }, now),
      pe: this.price({ symbol, kind: 'PE', expiry, strike }, now),
    }));
  }

  forward(symbol: string, expiry: string): ForwardEstimate {
    const now = this.now();
    return this.forwardAt(symbol, expiry, now);
  }

  private forwardAt(symbol: string, expiry: string, now: number): ForwardEstimate {
    const T = timeToExpiry(expiry, now);
    const spot = this.price({ symbol, kind: 'SPOT' }, now);
    const future = this.price({ symbol, kind: 'FUT', expiry }, now);
    // Parity needs the option quotes only when there is no same-expiry future.
    const rows = future === undefined ? this.premiumRows(symbol, expiry, now) : [];
    const f = forwardOf({ spot, future, rows }, T, this.r);
    if (!f) throw new NoLiveData(`No live future, put-call pair or spot price for ${symbol} ${expiry}`);
    return f;
  }

  iv(input: { symbol: string; expiry: string; type: OptKind; strike: number; premium: number; ts?: number; forward?: number }): number | null {
    const ts = input.ts ?? this.now();
    const F = input.forward ?? this.tryForward(input.symbol, input.expiry, ts);
    if (F === undefined) return null;
    return black76Iv(input.type, input.premium, F, input.strike, timeToExpiry(input.expiry, ts), this.r);
  }

  greeks(input: { symbol: string; expiry: string; type: OptKind; strike: number; iv: number; ts?: number; forward?: number }): Greeks | null {
    const ts = input.ts ?? this.now();
    const F = input.forward ?? this.tryForward(input.symbol, input.expiry, ts);
    if (F === undefined) return null;
    return black76Greeks(input.type, F, input.strike, timeToExpiry(input.expiry, ts), this.r, input.iv);
  }

  atmIv(symbol: string, expiry?: string): number | null {
    const now = this.now();
    const exp = expiry ?? this.nearestExpiry(symbol, now);
    if (!exp) return null;
    const T = timeToExpiry(exp, now);
    if (!(T > 0)) return null;
    const F = this.tryForward(symbol, exp, now);
    if (F === undefined) return null;
    return atmIvOf(this.premiumRows(symbol, exp, now), F, T, this.r)?.iv ?? null;
  }

  /** Nearest listed option expiry that has not expired at `now`. */
  private nearestExpiry(symbol: string, now: number): string | undefined {
    let list: string[];
    try {
      list = this.opts.ref.expiries(symbol, 'OPT');
    } catch (e) {
      if (e instanceof NoLiveData) return undefined;
      throw e;
    }
    return [...list].sort().find((e) => timeToExpiry(e, now) > 0);
  }

  /** Forward price, or undefined when NoLiveData. Live quotes are used even when `ts` is in the past. */
  private tryForward(symbol: string, expiry: string, ts: number): number | undefined {
    try {
      return this.forwardAt(symbol, expiry, ts).forward;
    } catch (e) {
      if (e instanceof NoLiveData) return undefined;
      throw e;
    }
  }
}
