/**
 * Volatility analytics: historical volatility estimators, IV Rank / IV Percentile,
 * volatility cone.
 */
import { percentile, stdev } from './math';

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

/** Rolling close-to-close HV series aligned with `closes` (NaN until enough data). */
export function rollingHV(closes: readonly number[], window = 20): number[] {
  const r = logReturns(closes);
  const out: number[] = [NaN];
  for (let i = 0; i < r.length; i++) {
    if (i + 1 < window) out.push(NaN);
    else out.push(stdev(r.slice(i + 1 - window, i + 1)) * Math.sqrt(TRADING_DAYS));
  }
  return out;
}

/** Parkinson high/low estimator (annualised). */
export function parkinsonVol(highs: readonly number[], lows: readonly number[], window = 20): number {
  const n = Math.min(highs.length, lows.length);
  const start = Math.max(0, n - window);
  let s = 0;
  let c = 0;
  for (let i = start; i < n; i++) {
    if (highs[i] > 0 && lows[i] > 0) {
      const x = Math.log(highs[i] / lows[i]);
      s += x * x;
      c++;
    }
  }
  if (!c) return NaN;
  return Math.sqrt(s / (4 * Math.log(2) * c)) * Math.sqrt(TRADING_DAYS);
}

/** IV Rank: where current IV sits between the period low (0) and high (100). */
export function ivRank(current: number, history: readonly number[]): number {
  const vals = history.filter(Number.isFinite);
  if (!vals.length || !Number.isFinite(current)) return NaN;
  const lo = Math.min(...vals, current);
  const hi = Math.max(...vals, current);
  return hi > lo ? ((current - lo) / (hi - lo)) * 100 : 50;
}

/** IV Percentile: % of observations in the look-back below the current IV. */
export function ivPercentile(current: number, history: readonly number[]): number {
  const vals = history.filter(Number.isFinite);
  if (!vals.length || !Number.isFinite(current)) return NaN;
  let below = 0;
  for (const v of vals) if (v < current) below++;
  return (below / vals.length) * 100;
}

export interface ConeRow {
  window: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  max: number;
  current: number;
}

/** Realised-volatility cone across horizons. */
export function volatilityCone(closes: readonly number[], windows = [10, 20, 30, 60, 90, 120]): ConeRow[] {
  const r = logReturns(closes);
  return windows
    .filter((w) => r.length > w + 5)
    .map((w) => {
      const vals: number[] = [];
      for (let i = w; i <= r.length; i++) vals.push(stdev(r.slice(i - w, i)) * Math.sqrt(TRADING_DAYS));
      return {
        window: w,
        min: Math.min(...vals),
        p25: percentile(vals, 25),
        median: percentile(vals, 50),
        p75: percentile(vals, 75),
        max: Math.max(...vals),
        current: vals[vals.length - 1],
      };
    });
}
