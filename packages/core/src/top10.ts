/**
 * NIFTY heavyweights desk: a transparent bias from four independent live readings of one stock. Each
 * reading votes +1 (bullish), −1 (bearish) or 0 (neutral or not available) and always says why; the
 * score is their sum. A reading that is not available never votes — it is never assumed.
 *
 *  - futures: near-month future price vs OI change (long build-up / short covering = +1,
 *             short build-up / long unwinding = −1);
 *  - flow:    buyer vs seller initiated quantity over the last minutes, with the price
 *             (buyers in control = +1, sellers in control = −1; absorbed or balanced = 0);
 *  - options: change-in-OI PCR of today (≥ 1.2: puts written = +1; ≤ 0.8: calls written = −1);
 *  - trend:   the 15-minute opening range (broken up = +1, broken down = −1).
 *
 * An indicator summary to support a view, not a trading signal.
 */
import type { BuildUp } from './oi';
import type { OrbTrend } from './orb';
import type { FlowRead } from './ordertrade';

export type BiasFactor = 'futures' | 'flow' | 'options' | 'trend';

export interface BiasVote {
  factor: BiasFactor;
  vote: -1 | 0 | 1;
  /** False when the reading was not available (the vote is then 0 and `why` says what is missing). */
  available: boolean;
  why: string;
}

export interface Bias {
  score: number;
  /** Readings that were available (out of 4). */
  available: number;
  label: 'Bullish' | 'Mild bullish' | 'Neutral' | 'Mild bearish' | 'Bearish' | 'No live reading';
  votes: BiasVote[];
}

export interface BiasInputs {
  buildUp: BuildUp | null;
  flowRead: FlowRead | null;
  /** Buyer share of the flow window (%), for the explanation. */
  flowBuyPct?: number | null;
  changePcr: number | null;
  orbTrend: OrbTrend | null;
}

export function biasOf(i: BiasInputs): Bias {
  const votes: BiasVote[] = [];
  // Futures build-up.
  if (i.buildUp === null) votes.push({ factor: 'futures', vote: 0, available: false, why: 'Future build-up not available (needs live price and OI vs the previous session)' });
  else if (i.buildUp === 'Long Build-up' || i.buildUp === 'Short Covering') votes.push({ factor: 'futures', vote: 1, available: true, why: `Future: ${i.buildUp}` });
  else if (i.buildUp === 'Short Build-up' || i.buildUp === 'Long Unwinding') votes.push({ factor: 'futures', vote: -1, available: true, why: `Future: ${i.buildUp}` });
  else votes.push({ factor: 'futures', vote: 0, available: true, why: 'Future: no clear build-up' });
  // Order flow.
  const pct = i.flowBuyPct !== null && i.flowBuyPct !== undefined ? ` (${i.flowBuyPct}% buyer initiated)` : '';
  if (i.flowRead === null) votes.push({ factor: 'flow', vote: 0, available: false, why: 'Order flow not available (the future has no recorded minutes yet)' });
  else if (i.flowRead === 'buyers') votes.push({ factor: 'flow', vote: 1, available: true, why: `Flow: buyers in control${pct}` });
  else if (i.flowRead === 'sellers') votes.push({ factor: 'flow', vote: -1, available: true, why: `Flow: sellers in control${pct}` });
  else votes.push({ factor: 'flow', vote: 0, available: true, why: `Flow: ${i.flowRead.replace('-', ' ')}${pct}` });
  // Options OI.
  if (i.changePcr === null) votes.push({ factor: 'options', vote: 0, available: false, why: 'Change-in-OI PCR not available (needs live OI and the previous close)' });
  else if (i.changePcr >= 1.2) votes.push({ factor: 'options', vote: 1, available: true, why: `Options: change PCR ${i.changePcr.toFixed(2)} — puts written (support)` });
  else if (i.changePcr <= 0.8) votes.push({ factor: 'options', vote: -1, available: true, why: `Options: change PCR ${i.changePcr.toFixed(2)} — calls written (resistance)` });
  else votes.push({ factor: 'options', vote: 0, available: true, why: `Options: change PCR ${i.changePcr.toFixed(2)} — balanced writing` });
  // Opening range.
  if (i.orbTrend === null || i.orbTrend === 'forming') votes.push({ factor: 'trend', vote: 0, available: i.orbTrend === 'forming', why: i.orbTrend === 'forming' ? 'Trend: opening range still forming' : 'Trend: opening range not available' });
  else if (i.orbTrend === 'up') votes.push({ factor: 'trend', vote: 1, available: true, why: 'Trend: broke above the 15-min opening range' });
  else if (i.orbTrend === 'down') votes.push({ factor: 'trend', vote: -1, available: true, why: 'Trend: broke below the 15-min opening range' });
  else votes.push({ factor: 'trend', vote: 0, available: true, why: 'Trend: sideways inside the opening range' });

  const score = votes.reduce((s, v) => s + v.vote, 0);
  const available = votes.filter((v) => v.available).length;
  const label: Bias['label'] = available === 0 ? 'No live reading' : score >= 2 ? 'Bullish' : score === 1 ? 'Mild bullish' : score === 0 ? 'Neutral' : score === -1 ? 'Mild bearish' : 'Bearish';
  return { score, available, label, votes };
}
