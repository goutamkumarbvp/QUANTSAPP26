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
import type { UnderlyingKind } from '../api';

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
  /**
   * Open interest of a strike (contracts' units as the feed reports it); null when not known. Absent where the
   * source carries no OI. Algos that rank or weigh strikes by OI (max pain, top OI) read it.
   */
  oi?(type: OptionSide, strike: number): number | null;
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
  defaults(instrument: { symbol: string; strikeStep: number; kind: UnderlyingKind }): P;
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
  /** Saved by the user ("My strategy"): can be deleted; built-in presets cannot. */
  custom?: boolean;
}

export function hhmmToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

/** Entry/exit times: HH:MM, exit after entry, inside the longest session (MCX: 09:00–23:55); the server checks the symbol's own session. */
export function validateTimes(entryTime: string, exitTime: string): string | null {
  const re = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!re.test(entryTime) || !re.test(exitTime)) return 'Times must be HH:MM';
  const en = hhmmToMinutes(entryTime);
  const ex = hhmmToMinutes(exitTime);
  if (en < 540 || ex > 1435) return 'Times must be within market hours (09:00–23:55)';
  if (ex <= en) return 'Exit time must be after entry time';
  return null;
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
  symbols: { symbol: string; lotSize: number; strikeStep: number; kind: UnderlyingKind }[];
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
  /** Every open position's premium at the point (e.g. "25100 CE"), for algos with more than one leg a side. */
  positions?: { key: string; ltp: number | null }[];
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
  /** Replayed on recorded one-minute bars ('1m') or one-second snapshots ('1s', fills at the recorded bid/ask). */
  resolution: '1m' | '1s';
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
  /** Data the days were replayed on (see AlgoBacktestDay.resolution). */
  resolution: '1m' | '1s';
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
  /** Contract lot size of the day (premium totals in the analysis). */
  lotSize: number;
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
  /**
   * 'auto': the algo places its orders through the paper broker. 'manual': it places none — each order is a
   * signal (notification + journal, at the live bid/ask) for the user to place by hand.
   */
  execution: AlgoExecution;
  /** Settings saved while a day had open positions: they apply from the next session (with `pendingExecution`). */
  pendingParams?: Record<string, unknown>;
  pendingExecution?: AlgoExecution;
}

export type AlgoExecution = 'auto' | 'manual';

/**
 * Settings that may change while a day has open positions: risk limits and the exit, which only affect what the
 * algo does next. Every other setting (underlying, expiry, lots, strikes, premiums, mode…) defines the open
 * positions themselves and applies from the next session.
 */
export const LIVE_EDITABLE_PARAMS = ['stopLossPerLot', 'stopLoss', 'profitTargetPerLot', 'profitTarget', 'maxAdjustments', 'maxRolls', 'exitTime', 'maxGapPct'] as const;

/* ---------------------------------------------------------------------------------- */
/* Portfolio stop loss (all of a user's algo runs together)                             */
/* ---------------------------------------------------------------------------------- */

export interface PortfolioGuardSettings {
  /** The guard is checked (every tick) only when enabled. */
  enabled: boolean;
  /** Loss limit in ₹ per lot traded today (× the most lots held at once today, all underlyings); 0 = not used. */
  perLot: number;
  /** Loss limit in ₹ for the whole portfolio of algo runs today; 0 = not used. With both set, the smaller limit applies. */
  totalLoss: number;
}

export interface PortfolioGuardView extends DataGaps {
  settings: PortfolioGuardSettings;
  /** IST date the figures are of. */
  date: string;
  /** Lots open now and the most held at once today, per underlying (NIFTY, SENSEX, CRUDEOIL …). */
  lots: { symbol: string; open: number; peak: number }[];
  openLots: number;
  peakLots: number;
  /** Combined P&L today of every algo run (realised + open, before charges); null while an open leg has no live price. */
  pnl: number | null;
  /** perLot × peakLots (null when not used), totalLoss (null when not used), and the one that applies (the smaller). */
  perLotLimit: number | null;
  totalLimit: number | null;
  limit: number | null;
  /** Runs counted today (each run's own P&L and lots). */
  runs: { id: string; name: string; symbol: string; pnl: number | null; openLots: number }[];
  /** Set when the guard fired today: every run was squared off and trading is halted for the day. */
  halted: { at: number; reason: string } | null;
}
