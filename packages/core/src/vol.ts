/**
 * Volatility analytics: close-to-close historical volatility and IV Rank / IV Percentile
 * (the IV scanners and the IV table need them).
 */
import { stdev } from './math';

export const TRADING_DAYS = 252;

export function logReturns(closes: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) out.push(Math.log(closes[i] / closes[i - 1]));
  return out;
}

/** Annualised close-to-close volatility over the last `window` returns. */
export function historicalVol(closes: readonly number[], window = 20): number {
  const r = logReturns(closes);
  if (r.length < 2) return NaN;
  const slice = r.slice(-window);
  return stdev(slice) * Math.sqrt(TRADING_DAYS);
}

/** Fewest finite look-back observations IV rank / percentile are computed from. */
export const MIN_IV_RANK_HISTORY = 2;

/** The finite look-back values when rank/percentile are defined: enough of them, not all equal, and a finite current IV. */
function rankable(current: number, history: readonly number[]): number[] | null {
  const vals = history.filter(Number.isFinite);
  if (vals.length < MIN_IV_RANK_HISTORY || !Number.isFinite(current)) return null;
  return Math.max(...vals) > Math.min(...vals) ? vals : null;
}

/** IV Rank: where current IV sits between the period low (0) and high (100); null for a flat or too-short history. */
export function ivRank(current: number, history: readonly number[]): number | null {
  const vals = rankable(current, history);
  if (!vals) return null;
  const lo = Math.min(...vals, current);
  const hi = Math.max(...vals, current);
  return ((current - lo) / (hi - lo)) * 100;
}

/** IV Percentile: % of observations in the look-back below the current IV; null for a flat or too-short history. */
export function ivPercentile(current: number, history: readonly number[]): number | null {
  const vals = rankable(current, history);
  if (!vals) return null;
  let below = 0;
  for (const v of vals) if (v < current) below++;
  return (below / vals.length) * 100;
}
