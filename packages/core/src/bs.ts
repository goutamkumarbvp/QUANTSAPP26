/**
 * Black–Scholes–Merton pricing, Greeks and implied volatility.
 *
 * Conventions (match what Indian options platforms display):
 *  - `T` in years (calendar days / 365), `r` and `q` continuously compounded decimals.
 *  - `sigma` decimal (0.15 = 15% IV).
 *  - theta is per calendar day, vega per 1 vol point (1%), rho per 1% rate change.
 *  - Pass `q` so that S·e^{(r−q)T} equals the traded future to price off the forward (Black-76 equivalent).
 */
import { normCdf, normPdf } from './math';

export type OptionType = 'CE' | 'PE';

export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}

const MIN_T = 1e-9;

function d1d2(S: number, K: number, T: number, r: number, sigma: number, q: number) {
  const vsqrt = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / vsqrt;
  return { d1, d2: d1 - vsqrt, vsqrt };
}

export function intrinsic(type: OptionType, S: number, K: number): number {
  return type === 'CE' ? Math.max(0, S - K) : Math.max(0, K - S);
}

export function bsPrice(type: OptionType, S: number, K: number, T: number, r: number, sigma: number, q = 0): number {
  if (!(S > 0) || !(K > 0)) return 0;
  if (T <= MIN_T || sigma <= 0) {
    const fwdIntrinsic = type === 'CE' ? S * Math.exp(-q * Math.max(T, 0)) - K * Math.exp(-r * Math.max(T, 0)) : K * Math.exp(-r * Math.max(T, 0)) - S * Math.exp(-q * Math.max(T, 0));
    return Math.max(0, fwdIntrinsic);
  }
  const { d1, d2 } = d1d2(S, K, T, r, sigma, q);
  const dfq = Math.exp(-q * T);
  const dfr = Math.exp(-r * T);
  if (type === 'CE') return S * dfq * normCdf(d1) - K * dfr * normCdf(d2);
  return K * dfr * normCdf(-d2) - S * dfq * normCdf(-d1);
}

export function bsGreeks(type: OptionType, S: number, K: number, T: number, r: number, sigma: number, q = 0): Greeks {
  if (!(S > 0) || !(K > 0)) return { price: 0, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  if (T <= MIN_T || sigma <= 0) {
    const price = intrinsic(type, S, K);
    const itm = type === 'CE' ? S > K : S < K;
    return { price, delta: itm ? (type === 'CE' ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  }
  const { d1, d2, vsqrt } = d1d2(S, K, T, r, sigma, q);
  const dfq = Math.exp(-q * T);
  const dfr = Math.exp(-r * T);
  const pdf1 = normPdf(d1);
  const gamma = (dfq * pdf1) / (S * vsqrt);
  const vega = (S * dfq * pdf1 * Math.sqrt(T)) / 100;
  let price: number, delta: number, thetaYear: number, rho: number;
  if (type === 'CE') {
    const Nd1 = normCdf(d1);
    const Nd2 = normCdf(d2);
    price = S * dfq * Nd1 - K * dfr * Nd2;
    delta = dfq * Nd1;
    thetaYear = (-S * dfq * pdf1 * sigma) / (2 * Math.sqrt(T)) - r * K * dfr * Nd2 + q * S * dfq * Nd1;
    rho = (K * T * dfr * Nd2) / 100;
  } else {
    const Nmd1 = normCdf(-d1);
    const Nmd2 = normCdf(-d2);
    price = K * dfr * Nmd2 - S * dfq * Nmd1;
    delta = -dfq * Nmd1;
    thetaYear = (-S * dfq * pdf1 * sigma) / (2 * Math.sqrt(T)) + r * K * dfr * Nmd2 - q * S * dfq * Nmd1;
    rho = (-K * T * dfr * Nmd2) / 100;
  }
  return { price, delta, gamma, theta: thetaYear / 365, vega, rho };
}

/**
 * Implied volatility by safeguarded Newton–Raphson (falls back to bisection).
 * Returns NaN when the price violates no-arbitrage bounds.
 */
export function impliedVol(type: OptionType, price: number, S: number, K: number, T: number, r: number, q = 0, guess = 0.2): number {
  if (!(price > 0) || !(S > 0) || !(K > 0) || T <= MIN_T) return NaN;
  const dfq = Math.exp(-q * T);
  const dfr = Math.exp(-r * T);
  const lower = type === 'CE' ? Math.max(0, S * dfq - K * dfr) : Math.max(0, K * dfr - S * dfq);
  const upper = type === 'CE' ? S * dfq : K * dfr;
  if (price < lower - 1e-9 || price >= upper) return NaN;
  if (price - lower < 1e-10) return 1e-4;

  let lo = 1e-4;
  let hi = 5;
  let sigma = Math.min(Math.max(guess, 0.01), 3);
  for (let i = 0; i < 60; i++) {
    const p = bsPrice(type, S, K, T, r, sigma, q);
    const diff = p - price;
    if (Math.abs(diff) < 1e-8) return sigma;
    if (diff > 0) hi = sigma;
    else lo = sigma;
    const { d1 } = d1d2(S, K, T, r, sigma, q);
    const vega = S * dfq * normPdf(d1) * Math.sqrt(T);
    let next = vega > 1e-10 ? sigma - diff / vega : NaN;
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    if (Math.abs(next - sigma) < 1e-10) return next;
    sigma = next;
  }
  return sigma;
}

/** Continuous yield implied by spot and futures (cost of carry). */
export function impliedCarryYield(spot: number, future: number, T: number, r: number): number {
  if (!(spot > 0) || !(future > 0) || T <= MIN_T) return 0;
  return r - Math.log(future / spot) / T;
}

/** Probability (risk-neutral, lognormal) that S_T ends above K. */
export function probAbove(S: number, K: number, T: number, sigma: number, r = 0, q = 0): number {
  if (T <= MIN_T || sigma <= 0) return S > K ? 1 : 0;
  const { d2 } = d1d2(S, K, T, r, sigma, q);
  return normCdf(d2);
}

/** One standard deviation expected move for horizon T. */
export function expectedMove(S: number, sigma: number, T: number): number {
  return S * sigma * Math.sqrt(Math.max(T, 0));
}
