/**
 * Open-interest analytics: max pain, PCR, modified PCR, build-up classification,
 * OI-based support / resistance.
 */

export interface StrikeOI {
  strike: number;
  ceOI: number;
  peOI: number;
  ceVolume?: number;
  peVolume?: number;
  ceOIChange?: number;
  peOIChange?: number;
}

export interface MaxPainResult {
  maxPain: number;
  /** Total writer payout (option buyers' gain) if expiry settles at each strike. */
  pain: { strike: number; callPain: number; putPain: number; total: number }[];
}

/**
 * Max pain = settlement price at which option holders collectively receive the least
 * (equivalently, option writers pay the least).
 */
export function maxPain(rows: readonly StrikeOI[]): MaxPainResult {
  const pain = rows.map(({ strike: X }) => {
    let callPain = 0;
    let putPain = 0;
    for (const r of rows) {
      if (X > r.strike) callPain += r.ceOI * (X - r.strike);
      if (X < r.strike) putPain += r.peOI * (r.strike - X);
    }
    return { strike: X, callPain, putPain, total: callPain + putPain };
  });
  let best = pain[0];
  for (const p of pain) if (p.total < best.total) best = p;
  return { maxPain: best ? best.strike : NaN, pain };
}

export function pcr(rows: readonly StrikeOI[]): { oi: number; volume: number; oiChange: number } {
  let ce = 0, pe = 0, cev = 0, pev = 0, cec = 0, pec = 0;
  for (const r of rows) {
    ce += r.ceOI;
    pe += r.peOI;
    cev += r.ceVolume ?? 0;
    pev += r.peVolume ?? 0;
    cec += r.ceOIChange ?? 0;
    pec += r.peOIChange ?? 0;
  }
  return {
    oi: ce > 0 ? pe / ce : NaN,
    volume: cev > 0 ? pev / cev : NaN,
    oiChange: cec !== 0 ? pec / cec : NaN,
  };
}

/**
 * Modified PCR: PCR computed only over strikes within `width` strikes on either side of
 * the ATM strike — filters out deep OTM noise that skews the plain PCR.
 */
export function modifiedPcr(rows: readonly StrikeOI[], spot: number, width = 10): number {
  if (!rows.length) return NaN;
  const sorted = [...rows].sort((a, b) => a.strike - b.strike);
  let atmIdx = 0;
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].strike - spot) < Math.abs(sorted[atmIdx].strike - spot)) atmIdx = i;
  }
  const slice = sorted.slice(Math.max(0, atmIdx - width), atmIdx + width + 1);
  return pcr(slice).oi;
}

export type BuildUp = 'Long Build-up' | 'Short Build-up' | 'Short Covering' | 'Long Unwinding' | 'Neutral';

/** Classic price/OI quadrant classification. */
export function classifyBuildUp(priceChange: number, oiChange: number, eps = 0): BuildUp {
  if (Math.abs(priceChange) <= eps && Math.abs(oiChange) <= eps) return 'Neutral';
  if (priceChange >= 0 && oiChange > 0) return 'Long Build-up';
  if (priceChange < 0 && oiChange > 0) return 'Short Build-up';
  if (priceChange >= 0 && oiChange <= 0) return 'Short Covering';
  return 'Long Unwinding';
}

export const BUILDUP_SENTIMENT: Record<BuildUp, 'bullish' | 'bearish' | 'neutral'> = {
  'Long Build-up': 'bullish',
  'Short Covering': 'bullish',
  'Short Build-up': 'bearish',
  'Long Unwinding': 'bearish',
  Neutral: 'neutral',
};

export interface SupportResistance {
  support: number;
  resistance: number;
  support2: number;
  resistance2: number;
  /** Strikes with the largest fresh writing today. */
  supportByChange: number;
  resistanceByChange: number;
}

export function oiSupportResistance(rows: readonly StrikeOI[]): SupportResistance {
  const byPe = [...rows].sort((a, b) => b.peOI - a.peOI);
  const byCe = [...rows].sort((a, b) => b.ceOI - a.ceOI);
  const byPeChg = [...rows].sort((a, b) => (b.peOIChange ?? 0) - (a.peOIChange ?? 0));
  const byCeChg = [...rows].sort((a, b) => (b.ceOIChange ?? 0) - (a.ceOIChange ?? 0));
  return {
    support: byPe[0]?.strike ?? NaN,
    support2: byPe[1]?.strike ?? NaN,
    resistance: byCe[0]?.strike ?? NaN,
    resistance2: byCe[1]?.strike ?? NaN,
    supportByChange: byPeChg[0]?.strike ?? NaN,
    resistanceByChange: byCeChg[0]?.strike ?? NaN,
  };
}

/** Nearest listed strike to the spot. */
export function atmStrike(strikes: readonly number[], spot: number): number {
  let best = strikes[0];
  for (const k of strikes) if (Math.abs(k - spot) < Math.abs(best - spot)) best = k;
  return best;
}

/** Interpret PCR the way option desks usually read it. */
export function pcrSentiment(value: number): 'Bullish' | 'Bearish' | 'Neutral' | 'Overbought' | 'Oversold' {
  if (!Number.isFinite(value)) return 'Neutral';
  if (value > 1.5) return 'Overbought';
  if (value > 1.1) return 'Bullish';
  if (value < 0.5) return 'Oversold';
  if (value < 0.8) return 'Bearish';
  return 'Neutral';
}
