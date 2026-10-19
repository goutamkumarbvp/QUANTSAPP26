/**
 * Algo framework. An algo is a deterministic state machine: `step()` is called with a market
 * snapshot (every recorded minute in backtests, every few seconds live) and places orders through a
 * `fill` callback. The same code therefore runs in backtests and in live paper trading.
 *
 * Live-data rule: a snapshot carries only real prices — live-session trades (live runs) or recorded
 * minute closes (backtests on recorded sessions). A price that is not available is `null`, never a
 * stand-in; an algo must not open a position on a missing price.
 */
import type { DataGaps } from '../api';

export type OptionSide = 'CE' | 'PE';

export interface AlgoParamSpec {
  key: string;
  label: string;
  type: 'number' | 'select' | 'boolean' | 'time' | 'symbol';
  min?: number;
  max?: number;
  step?: number;
  options?: { value: string; label: string }[];
  help?: string;
}

/**
 * What an algo can see at one instant. Prices are option LTPs of the run's expiry: live-session
 * trades in live runs, the recorded last price as of the minute in backtests.
 */
export interface AlgoSnapshot {
  ts: number;
  /** IST minute of the day (09:20 = 560). */
  minuteOfDay: number;
  date: string;
  symbol: string;
  /** Underlying price (live-session value, or recorded as of the minute); null when not available. */
  spot: number | null;
  expiry: string;
  lotSize: number;
  strikes: number[];
  /** Premium of a strike; null when the strike has no live (or recorded) traded price. */
  premium(type: OptionSide, strike: number): number | null;
}

export interface AlgoOrder {
  side: 'BUY' | 'SELL';
  type: OptionSide;
  strike: number;
  lots: number;
  reason: string;
}

/** Executes an order and returns its fill price; throws if the order cannot be filled. */
export type FillFn = (order: AlgoOrder) => number;

export interface AlgoFill extends AlgoOrder {
  price: number;
}

export interface AlgoLeg {
  type: OptionSide;
  strike: number;
  side: 'BUY' | 'SELL';
  lots: number;
  entryPrice: number;
  entryTs: number;
}

export type AlgoEventKind = 'ENTRY' | 'ADJUSTMENT' | 'STOP' | 'EXIT' | 'MANUAL_STOP' | 'INFO' | 'ERROR';

export interface AlgoEvent {
  ts: number;
  kind: AlgoEventKind;
  message: string;
  fills: AlgoFill[];
  data?: Record<string, number | string | null>;
}

export type AlgoPhase = 'waiting' | 'active' | 'stopped' | 'exited';

export interface AlgoStatusItem {
  label: string;
  value: string;
}

export interface AlgoDefinition<P = Record<string, unknown>, S = unknown> {
  id: string;
  name: string;
  description: string;
  /** Plain-language rules shown to the user. */
  rules: string[];
  params: AlgoParamSpec[];
  defaults(instrument: { symbol: string; strikeStep: number; kind: 'index' | 'stock' }): P;
  /** Returns an error message for invalid parameters. */
  validate(p: P): string | null;
  init(p: P): S;
  phase(s: S): AlgoPhase;
  openLegs(s: S): AlgoLeg[];
  /** Realised P&L in ₹ (needs the lot size). */
  realized(s: S): number;
  /** Advance the algo; mutates `s` and returns what happened. */
  step(p: P, s: S, snap: AlgoSnapshot, fill: FillFn): AlgoEvent[];
  /** Square off everything and stop (user pressed Stop). */
  squareOff(p: P, s: S, snap: AlgoSnapshot, fill: FillFn, reason: string): AlgoEvent;
  /** Live status lines (current level, next trigger …). */
  status(p: P, s: S): AlgoStatusItem[];
  /** A reference level to plot with the P&L (e.g. the current premium rung), if any. */
  level?(s: S): number | null;
  /** The rules in plain language for a given parameter set (falls back to `rules`). */
  describeRules?(p: Partial<P>): string[];
  /** A short name for a custom parameter set (used when a run's settings differ from its preset). */
  label?(p: P): string;
}

/** A named, ready-to-run parameter set of an algo (e.g. "Strategy 2 — ₹20", "Strategy 3 — ₹50"). */
export interface AlgoPreset {
  id: string;
  algoId: string;
  name: string;
  summary: string;
  params: Record<string, unknown>;
}

export function hhmmToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

/** Unrealised P&L of open legs at current premiums (₹); null when any open leg has no premium. */
export function openPnl(legs: AlgoLeg[], snap: Pick<AlgoSnapshot, 'premium' | 'lotSize'>): number | null {
  let pnl = 0;
  for (const l of legs) {
    const ltp = snap.premium(l.type, l.strike);
    if (ltp == null) return null;
    const sign = l.side === 'SELL' ? 1 : -1;
    pnl += sign * (l.entryPrice - ltp) * l.lots * snap.lotSize;
  }
  return pnl;
}

/* ---------------------------------------------------------------------------------- */
/* API shapes                                                                           */
/* ---------------------------------------------------------------------------------- */

export interface AlgoInfo {
  id: string;
  name: string;
  description: string;
  rules: string[];
  params: AlgoParamSpec[];
}

export interface AlgoCatalog extends DataGaps {
  algos: AlgoInfo[];
  presets: AlgoPreset[];
  /**
   * Index underlyings an algo may trade (instrument master: lot size, strike step). Empty, with
   * `gaps.symbols`, while the instrument master is not loaded.
   */
  symbols: { symbol: string; lotSize: number; strikeStep: number; kind: 'index' | 'stock' }[];
}

export interface AlgoSeriesPoint {
  ts: number;
  /** Underlying price at the point; null when it was not available. */
  spot: number | null;
  /** Day P&L so far (₹, before charges); null when an open leg had no premium. */
  mtm: number | null;
  level: number;
  ceStrike: number | null;
  ce: number | null;
  peStrike: number | null;
  pe: number | null;
}

export type AlgoExitKind = 'EXIT' | 'STOP' | 'ERROR' | 'MANUAL_STOP' | 'NONE';

export interface AlgoDaySummary {
  date: string;
  expiry: string;
  entered: boolean;
  /** Gross P&L (₹); null when open legs could not be valued (see `incomplete`). */
  pnl: number | null;
  charges: number;
  /** pnl − charges; null with pnl. */
  net: number | null;
  adjustments: number;
  /** Highest premium level reached (₹). */
  maxLevel: number;
  orders: number;
  /** Best and worst intraday P&L (₹, gross). */
  maxProfit: number;
  maxLoss: number;
  exitKind: AlgoExitKind;
  exitReason: string;
  exitTs: number | null;
  /**
   * Why the day's result is not final: the data ended before the algo finished the day (backtests:
   * the recording stopped before the exit), or open legs could not be closed or valued (e.g. awaiting
   * the exchange settlement price). Absent for a complete day. Incomplete days are left out of stats.
   */
  incomplete?: string;
}

/**
 * Replay of one recorded session (backtests run only on sessions the app recorded: every minute's
 * prices are the recorded last traded prices, fills at those prices).
 */
export interface AlgoBacktestDay extends AlgoDaySummary {
  algoId: string;
  symbol: string;
  /** Contract lot size used (instrument master while the contract is listed, else the official F&O file of the day). */
  lotSize: number;
  /** True when the day is today and not finished yet. */
  partial: boolean;
  /** One point per replayed minute (minutes without recorded data are left out). */
  series: AlgoSeriesPoint[];
  events: AlgoEvent[];
}

/** Statistics over the complete replayed days (incomplete and skipped days are counted only). */
export interface AlgoBacktestStats {
  /** Complete replayed days. */
  days: number;
  tradedDays: number;
  winDays: number;
  lossDays: number;
  /** Percent of traded days; null without a traded day. */
  winRate: number | null;
  totalNet: number;
  totalCharges: number;
  /** Null without a traded day. */
  avgNet: number | null;
  bestDay: number | null;
  worstDay: number | null;
  maxDrawdown: number;
  stoppedDays: number;
  avgAdjustments: number | null;
  maxAdjustments: number | null;
  /** Replayed days whose result is not final (see AlgoDaySummary.incomplete). */
  incompleteDays: number;
  /** Trading days of the window that could not be replayed (see AlgoBacktestRange.skipped). */
  skippedDays: number;
}

/** A trading day of a backtest window that was not replayed, and why (not recorded, lot size unknown …). */
export interface AlgoSkippedDay {
  date: string;
  reason: string;
}

export interface AlgoBacktestRange {
  algoId: string;
  symbol: string;
  /** First and last trading day of the window. */
  from: string;
  to: string;
  /** First session the app recorded (null before any). */
  recordedFrom: string | null;
  /** Replayed days, complete and incomplete. */
  days: AlgoDaySummary[];
  skipped: AlgoSkippedDay[];
  /** Equity over the complete days. */
  equity: { date: string; net: number; cum: number }[];
  stats: AlgoBacktestStats;
}

export interface AlgoLiveLeg extends AlgoLeg {
  /** Live-session trade price; null when the leg has not traded in the live session. */
  ltp: number | null;
  /** Null without ltp. */
  pnl: number | null;
}

export interface AlgoRunToday {
  date: string;
  expiry: string;
  phase: AlgoPhase;
  status: AlgoStatusItem[];
  legs: AlgoLiveLeg[];
  realized: number;
  /** Null when an open leg has no live price. */
  unrealized: number | null;
  charges: number;
  /** realized + unrealized; null with unrealized. */
  mtm: number | null;
  series: AlgoSeriesPoint[];
  events: AlgoEvent[];
}

/** A deployed algo. `gaps`: `liveData` (why the run is waiting for live data), `today`, `totalNet`. */
export interface AlgoRunView extends DataGaps {
  id: string;
  algoId: string;
  presetId?: string;
  name: string;
  params: Record<string, unknown>;
  status: 'running' | 'stopped';
  createdAt: number;
  stoppedAt?: number;
  today: AlgoRunToday | null;
  history: AlgoDaySummary[];
  /** Net P&L over finished days + today (₹, after charges); null when a day's result is not known. */
  totalNet: number | null;
  error?: string;
}
