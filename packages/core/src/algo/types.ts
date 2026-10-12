/**
 * Algo framework. An algo is a deterministic state machine: `step()` is called with a market
 * snapshot (every minute in backtests, every few seconds live) and places orders through a
 * `fill` callback. The same code therefore runs in backtests and in live paper trading.
 */

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

/** What an algo can see at one instant. Prices are option LTPs of the run's expiry. */
export interface AlgoSnapshot {
  ts: number;
  /** IST minute of the day (09:20 = 560). */
  minuteOfDay: number;
  date: string;
  symbol: string;
  spot: number;
  expiry: string;
  lotSize: number;
  strikes: number[];
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
}

/** A named, ready-to-run parameter set of an algo (e.g. "Strategy 2 — ₹20"). */
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

/** Unrealised P&L of open legs at current premiums (₹). */
export function openPnl(legs: AlgoLeg[], snap: Pick<AlgoSnapshot, 'premium' | 'lotSize'>): number {
  let pnl = 0;
  for (const l of legs) {
    const ltp = snap.premium(l.type, l.strike);
    if (ltp == null) continue;
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

export interface AlgoCatalog {
  algos: AlgoInfo[];
  presets: AlgoPreset[];
  /** Underlyings an algo may trade, with their defaults per algo id. */
  symbols: { symbol: string; lotSize: number; strikeStep: number; kind: 'index' | 'stock' }[];
}

export interface AlgoSeriesPoint {
  ts: number;
  spot: number;
  /** Day P&L so far (₹, before charges). */
  mtm: number;
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
  /** Gross P&L (₹). */
  pnl: number;
  charges: number;
  net: number;
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
}

export interface AlgoBacktestDay extends AlgoDaySummary {
  algoId: string;
  symbol: string;
  lotSize: number;
  /** True when the day is today and not finished yet. */
  partial: boolean;
  series: AlgoSeriesPoint[];
  events: AlgoEvent[];
}

export interface AlgoBacktestStats {
  days: number;
  tradedDays: number;
  winDays: number;
  lossDays: number;
  winRate: number;
  totalNet: number;
  totalCharges: number;
  avgNet: number;
  bestDay: number;
  worstDay: number;
  maxDrawdown: number;
  stoppedDays: number;
  avgAdjustments: number;
  maxAdjustments: number;
}

export interface AlgoBacktestRange {
  algoId: string;
  symbol: string;
  from: string;
  to: string;
  days: AlgoDaySummary[];
  equity: { date: string; net: number; cum: number }[];
  stats: AlgoBacktestStats;
}

export interface AlgoLiveLeg extends AlgoLeg {
  ltp: number | null;
  pnl: number;
}

export interface AlgoRunToday {
  date: string;
  expiry: string;
  phase: AlgoPhase;
  status: AlgoStatusItem[];
  legs: AlgoLiveLeg[];
  realized: number;
  unrealized: number;
  charges: number;
  mtm: number;
  series: AlgoSeriesPoint[];
  events: AlgoEvent[];
}

export interface AlgoRunView {
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
  /** Net P&L over finished days + today (₹, after charges). */
  totalNet: number;
  error?: string;
}
