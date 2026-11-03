/**
 * Algo strategies on live data only. The algos themselves are pure state machines in
 * `@q26/core/algo` (rules unchanged); this service feeds them market snapshots and turns their
 * orders into fills.
 *
 *  - Live paper runs: every tick reads the live option chain of the run's expiry (md.live.chain) and
 *    the live underlying price, only while the exchange session is open (md.calendar). Premiums are
 *    live-session trades (pricing.isLivePrice), never a stale or model price. Orders go through the
 *    paper broker, which fills MARKET orders only at a live bid/ask; a rejected order is reported on
 *    the run (the algo squares off and stops for the day), never assumed filled. PAPER ONLY.
 *  - Backtests replay ONLY sessions the app recorded (md.intraday): minute by minute, each snapshot is
 *    the recorded chain as of that minute (the last minute completed at the step time, the rule of
 *    md.intraday.chainAt) and fills are at those recorded last traded prices. Minutes without
 *    recorded data are not replayed; a date without a recorded chain is skipped with the reason.
 *  - A day whose exit was missed is closed at the exchange settlement price when the contracts have
 *    expired (md.history.settlement), else at live prices through the broker (live) — or, when that
 *    is impossible, it is marked incomplete with the reason (its P&L is then blank, not estimated).
 */
import { randomUUID } from 'node:crypto';
import {
  ALGO_PRESETS,
  LIVE_EDITABLE_PARAMS,
  ALGOS,
  algoById,
  formatTimeIST,
  hhmmToMinutes,
  istParts,
  openPnl,
  totalCharges,
  type AlgoBacktestDay,
  type AlgoBacktestRange,
  type AlgoCatalog,
  type AlgoDaySummary,
  type AlgoExecution,
  type PortfolioGuardSettings,
  type PortfolioGuardView,
  type AlgoDefinition,
  type AlgoEvent,
  type AlgoExitKind,
  type AlgoFill,
  type AlgoLeg,
  type AlgoPreset,
  type AlgoRunView,
  type AlgoSeriesPoint,
  type AlgoSkippedDay,
  type AlgoSnapshot,
  type FillFn,
  type OptionSide,
} from '@q26/core';
import { NoLiveData } from '../live/types';
import type { InstrumentKey, LiveQuote, MarketDataProvider, MinuteRecord, RawChain, SecondReader, UserContract } from '../live/types';
import { SecondStore, type SecondRow } from '../live/store/seconds';
import type { Db } from '../store/db';
import type { Notifier } from './alerts';
import { Gaps, httpError, liveDates, liveOptionExpiries, livePrice, mdFor, notRecordedReason, optKey, r2, requireDate, sessionsBack, spotKey } from './live';
import { instrumentLabel, type Pricer } from './pricer';
import type { PaperBroker } from './trading';

const MINUTE = 60_000;
/** Session minutes (09:15 → 15:30). */
/** Runs at once: enough for every built-in strategy (S1–S7) plus a few of the user's own. */
const MAX_RUNNING = 10;
/** Saved strategies per user. */
const MAX_USER_PRESETS = 50;
const MAX_EVENTS_PER_DAY = 400;
const MAX_HISTORY = 250;
/** A recording gap of at least this many minutes is reported in a backtest's trade log. */
const GAP_REPORT_MINUTES = 2;
const INDEX_SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAlgo = AlgoDefinition<any, any>;

export interface StoredAlgoDay {
  date: string;
  expiry: string;
  state: unknown;
  events: AlgoEvent[];
  series: AlgoSeriesPoint[];
  lastMinute: number;
  maxProfit: number;
  maxLoss: number;
  maxLevel: number;
  closed: boolean;
  /** Contract lot size of the day's expiry (instrument master when the day started). */
  lotSize?: number;
  /** Realised + open P&L at the latest tick (null when an open leg had no price then): the portfolio stop loss reads it. */
  lastMtm?: number | null;
}

export interface StoredAlgoRun {
  id: string;
  algoId: string;
  presetId?: string;
  name: string;
  params: Record<string, unknown>;
  status: 'running' | 'stopped';
  createdAt: number;
  stoppedAt?: number;
  day: StoredAlgoDay | null;
  history: AlgoDaySummary[];
  error?: string;
  /** Why the run is waiting for live data right now (cleared when the data is back). */
  waiting?: string;
  /** Finished days whose expired legs await the exchange settlement price (closed once it is published). */
  unsettled?: StoredAlgoDay[];
  /** How orders are executed (absent: 'auto', runs saved before manual mode). */
  execution?: AlgoExecution;
  /** Settings / execution saved while a day had open positions: applied when the next day starts. */
  nextParams?: Record<string, unknown>;
  nextExecution?: AlgoExecution;
}

/** A user's portfolio stop loss: settings, today's peak lots per underlying, and today's halt. */
export interface StoredGuard {
  settings: PortfolioGuardSettings;
  day?: { date: string; peak: Record<string, number> };
  halted?: { date: string; at: number; reason: string };
}

/** Default portfolio stop loss: on, ₹3,000 per lot traded today, no separate total. */
export const DEFAULT_GUARD: PortfolioGuardSettings = { enabled: true, perLot: 3000, totalLoss: 0 };

export interface AlgoRunInput {
  algoId: string;
  presetId?: string;
  name?: string;
  params: Record<string, unknown>;
  execution?: AlgoExecution;
}

export interface AlgoRunUpdate {
  name?: string;
  params?: Record<string, unknown>;
  execution?: AlgoExecution;
}

const FINAL_KINDS: AlgoExitKind[] = ['EXIT', 'STOP', 'ERROR', 'MANUAL_STOP'];
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const hhmm = (ts: number): string => formatTimeIST(ts);
const isFinal = (phase: string): boolean => phase === 'stopped' || phase === 'exited';

/* ------------------------------------------------------------------------------------------ */
/* Recorded session replay                                                                      */
/* ------------------------------------------------------------------------------------------ */

/**
 * The recorded minutes of one session for one underlying and expiry (spot + every recorded leg),
 * read once and replayed in time order. `seek(ts)` moves to the last minute COMPLETED at `ts`
 * (record.ts + 60 s ≤ ts) for every instrument: the same as-of rule as md.intraday.chainAt / at(),
 * without re-reading the store for every minute. No look-ahead.
 */
class SessionTape implements Tape {
  private readonly spot: MinuteRecord[];
  private spotIdx = -1;
  private readonly legs = new Map<string, { bars: MinuteRecord[]; idx: number }>();
  readonly strikes: number[];

  constructor(md: MarketDataProvider, symbol: string, date: string, legKeys: InstrumentKey[]) {
    this.spot = md.intraday.bars(spotKey(symbol), date);
    const strikes = new Set<number>();
    for (const k of legKeys) {
      const bars = md.intraday.bars(k, date);
      if (!bars.length || k.strike === undefined) continue;
      this.legs.set(`${k.kind}|${k.strike}`, { bars, idx: -1 });
      strikes.add(k.strike);
    }
    this.strikes = [...strikes].sort((a, b) => a - b);
  }

  get hasSpot(): boolean {
    return this.spot.length > 0;
  }

  get hasLegs(): boolean {
    return this.legs.size > 0;
  }

  /** Step time of the first minute with a recorded underlying price (its minute + 1). */
  firstStepTs(): number | null {
    return this.spot.length ? this.spot[0].ts + MINUTE : null;
  }

  /** End of the last recorded underlying minute. */
  lastRecordedTs(): number | null {
    return this.spot.length ? this.spot[this.spot.length - 1].ts + MINUTE : null;
  }

  seek(ts: number): void {
    while (this.spotIdx + 1 < this.spot.length && this.spot[this.spotIdx + 1].ts + MINUTE <= ts) this.spotIdx++;
    for (const leg of this.legs.values()) while (leg.idx + 1 < leg.bars.length && leg.bars[leg.idx + 1].ts + MINUTE <= ts) leg.idx++;
  }

  /** The underlying was recorded in the minute that just completed at `ts` (the recorder was running). */
  alive(ts: number): boolean {
    return this.spotIdx >= 0 && this.spot[this.spotIdx].ts === ts - MINUTE;
  }

  spotClose(): number | null {
    return this.spotIdx >= 0 ? this.spot[this.spotIdx].close : null;
  }

  /** The leg's recorded last price as of the seek time (its latest completed minute's close). */
  premium(type: OptionSide, strike: number): number | null {
    const leg = this.legs.get(`${type}|${strike}`);
    if (!leg || leg.idx < 0) return null;
    const c = leg.bars[leg.idx].close;
    return Number.isFinite(c) && c > 0 ? c : null;
  }

  /** The leg's latest recorded open interest as of the seek time (the last completed minute that carried one). */
  oi(type: OptionSide, strike: number): number | null {
    const leg = this.legs.get(`${type}|${strike}`);
    if (!leg) return null;
    for (let i = leg.idx; i >= 0; i--) {
      const v = leg.bars[i].oi;
      if (v !== undefined && Number.isFinite(v)) return v;
    }
    return null;
  }
}

/** What a replay reads: the underlying and the legs as of each step time. */
interface Tape {
  readonly strikes: number[];
  readonly hasSpot: boolean;
  readonly hasLegs: boolean;
  firstStepTs(): number | null;
  lastRecordedTs(): number | null;
  seek(ts: number): void;
  alive(ts: number): boolean;
  spotClose(): number | null;
  premium(type: OptionSide, strike: number): number | null;
  oi(type: OptionSide, strike: number): number | null;
}

/** Data resolution of a backtest: recorded one-minute bars, or one-second snapshots. */
export type BacktestResolution = '1m' | '1s';

/** A book older than this is not filled against in a one-second replay (the last traded price is used). */
const BOOK_MAX_AGE_MS = 10_000;

/**
 * One recorded session of one-second snapshots (SecondStore): the value at step time `ts` is the last row
 * of a second that ended by `ts`. Legs are read on first use (a replay asks for a few strikes, not all).
 * `alive` = the recorder ran with the feed connected in the second that just ended (coverage); a day
 * recorded without coverage falls back to "the underlying ticked in the last 5 seconds".
 */
class SecondTape implements Tape {
  private readonly spot: SecondRow[];
  private spotIdx = -1;
  private readonly legs = new Map<string, { key: InstrumentKey; rows: SecondRow[] | null; lastLtp: number[] }>();
  private readonly cover: [number, number][];
  private coverIdx = 0;
  private now = 0;
  readonly strikes: number[];

  constructor(
    private readonly store: SecondReader,
    symbol: string,
    private readonly date: string,
    legKeys: InstrumentKey[],
  ) {
    this.spot = store.read(spotKey(symbol), date).filter((r) => r.ltp !== undefined);
    const strikes = new Set<number>();
    for (const k of legKeys) {
      if (k.strike === undefined) continue;
      this.legs.set(`${k.kind}|${k.strike}`, { key: k, rows: null, lastLtp: [] });
      strikes.add(k.strike);
    }
    this.strikes = [...strikes].sort((a, b) => a - b);
    const d0 = SecondStore.dayStart(date);
    this.cover = store.coverage(date).map(([a, b]) => [d0 + a * 1000, d0 + b * 1000] as [number, number]);
  }

  get hasSpot(): boolean {
    return this.spot.length > 0;
  }

  get hasLegs(): boolean {
    return this.legs.size > 0;
  }

  firstStepTs(): number | null {
    return this.spot.length ? this.spot[0].ts + 1000 : null;
  }

  lastRecordedTs(): number | null {
    return this.spot.length ? this.spot[this.spot.length - 1].ts + 1000 : null;
  }

  seek(ts: number): void {
    this.now = ts;
    while (this.spotIdx + 1 < this.spot.length && this.spot[this.spotIdx + 1].ts + 1000 <= ts) this.spotIdx++;
  }

  alive(ts: number): boolean {
    if (!this.cover.length) return this.spotIdx >= 0 && ts - (this.spot[this.spotIdx].ts + 1000) <= 5000;
    const sec = ts - 1000;
    while (this.coverIdx < this.cover.length && this.cover[this.coverIdx][1] < sec) this.coverIdx++;
    const c = this.cover[this.coverIdx];
    return !!c && c[0] <= sec && sec <= c[1] && this.spotIdx >= 0;
  }

  spotClose(): number | null {
    return this.spotIdx >= 0 ? (this.spot[this.spotIdx].ltp ?? null) : null;
  }

  /** The leg's rows (read once), and the index of the last row with a price at or before each row. */
  private leg(type: OptionSide, strike: number) {
    const l = this.legs.get(`${type}|${strike}`);
    if (!l) return null;
    if (!l.rows) {
      l.rows = this.store.read(l.key, this.date);
      let last = -1;
      l.lastLtp = l.rows.map((r, i) => (r.ltp !== undefined ? (last = i) : last));
    }
    return l;
  }

  /** Index of the leg's last row whose second ended by the step time, -1 when none. */
  private at(rows: SecondRow[]): number {
    let lo = 0;
    let hi = rows.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].ts + 1000 <= this.now) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  premium(type: OptionSide, strike: number): number | null {
    const l = this.leg(type, strike);
    if (!l?.rows) return null;
    const i = this.at(l.rows);
    const j = i >= 0 ? l.lastLtp[i] : -1;
    const v = j >= 0 ? l.rows[j].ltp : undefined;
    return v !== undefined && v > 0 ? v : null;
  }

  /** The leg's latest recorded open interest as of the step time. */
  oi(type: OptionSide, strike: number): number | null {
    const l = this.leg(type, strike);
    if (!l?.rows) return null;
    for (let i = this.at(l.rows); i >= 0; i--) {
      const v = l.rows[i].oi;
      if (v !== undefined && Number.isFinite(v)) return v;
    }
    return null;
  }

  /** The leg's book as of the step time and its age (null without a two-sided book). */
  book(type: OptionSide, strike: number): { bid: number; ask: number; age: number } | null {
    const l = this.leg(type, strike);
    if (!l?.rows) return null;
    const i = this.at(l.rows);
    if (i < 0) return null;
    const r = l.rows[i];
    return r.bid !== undefined && r.ask !== undefined && r.ask >= r.bid ? { bid: r.bid, ask: r.ask, age: this.now - (r.ts + 1000) } : null;
  }
}

interface ReplayDay {
  sum: AlgoDaySummary;
  series: AlgoSeriesPoint[];
  events: AlgoEvent[];
  lotSize: number;
}

type ReplayOutcome = { ok: true; day: ReplayDay } | { ok: false; reason: string };

/* ------------------------------------------------------------------------------------------ */
/* Service                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export class AlgoService {
  private readonly locks = new Map<string, Promise<unknown>>();
  private ticking = false;

  constructor(
    private readonly md: MarketDataProvider,
    private readonly db: Db,
    private readonly broker: PaperBroker,
    private readonly notifier: Notifier,
    private readonly pricer: Pricer,
  ) {}

  /* ------------------------------- catalogue ------------------------------- */

  /** Algos and presets always; the tradable index underlyings from the instrument master (blank with a reason before it loads). */
  catalog(): AlgoCatalog {
    const gaps = new Gaps();
    const symbols: AlgoCatalog['symbols'] = [];
    gaps.try('symbols', () => {
      const all = this.md.ref.underlyings();
      for (const s of INDEX_SYMBOLS) {
        const u = all.find((x) => x.symbol === s);
        if (u) symbols.push({ symbol: u.symbol, lotSize: u.lotSize, strikeStep: u.strikeStep, kind: u.kind });
      }
      // MCX commodities (options on the commodity futures), on their own session.
      for (const u of all.filter((x) => x.kind === 'commodity').sort((a, b) => a.symbol.localeCompare(b.symbol))) {
        symbols.push({ symbol: u.symbol, lotSize: u.lotSize, strikeStep: u.strikeStep, kind: u.kind });
      }
    });
    return {
      algos: ALGOS.map((a) => ({ id: a.id, name: a.name, description: a.description, rules: a.rules, params: a.params })),
      presets: ALGO_PRESETS,
      symbols,
      ...gaps.out(),
    };
  }

  private algo(id: string): AnyAlgo {
    const a = algoById(id);
    if (!a) throw httpError(404, `Unknown algo ${id}`);
    return a;
  }

  defaults(algoId: string, symbol: string): Record<string, unknown> {
    return this.params(this.algo(algoId), { symbol });
  }

  /**
   * Defaults for the symbol (strike step and kind from the instrument master: 404 unknown symbol,
   * 503 while it is not loaded), overlaid with the user's values (numbers coerced), then validated.
   */
  params(algo: AnyAlgo, input: Record<string, unknown>): Record<string, unknown> {
    const u = this.md.ref.underlying(String(input.symbol ?? 'NIFTY'));
    const symbol = u.symbol;
    const p: Record<string, unknown> = { ...algo.defaults({ symbol, strikeStep: u.strikeStep, kind: u.kind }) };
    for (const spec of algo.params) {
      if (!(spec.key in input) || input[spec.key] === undefined || input[spec.key] === '') continue;
      const v = input[spec.key];
      if (spec.type === 'number') p[spec.key] = Number(v);
      else if (spec.type === 'boolean') p[spec.key] = v === true || v === 'true';
      else p[spec.key] = String(v);
    }
    p.symbol = symbol;
    const err = algo.validate(p) ?? this.sessionTimesError(symbol, p);
    if (err) throw httpError(400, err);
    return p;
  }

  /** Entry and exit must fall inside the symbol's own exchange session (NSE/BSE 09:15–15:30, MCX 09:00–23:30/23:55). */
  private sessionTimesError(symbol: string, p: Record<string, unknown>): string | null {
    if (typeof p.entryTime !== 'string' || typeof p.exitTime !== 'string') return null;
    const cal = this.md.calendarOf(symbol);
    const today = cal.session(this.md.clock.now()).date;
    const day = cal.isTradingDay(today) ? today : cal.prev(today);
    const open = istParts(cal.ts(day, 0)).minuteOfDay;
    const close = open + cal.sessionMinutes(day);
    const en = hhmmToMinutes(p.entryTime);
    const ex = hhmmToMinutes(p.exitTime);
    if (en < open || ex >= close) {
      const t = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
      return `${symbol} trades ${t(open)}–${t(close)} (${cal.exchange}): entry and exit must be inside that session, the exit before the close (by ${t(close - 1)})`;
    }
    return null;
  }

  /** The listed, unexpired option expiry a live run trades (nearest, or the one after it). */
  private pickExpiry(symbol: string, choice: unknown, ts: number): string {
    const list = liveOptionExpiries(this.md, symbol, ts);
    const e = choice === 'next' ? list[1] : list[0];
    if (!e) throw httpError(400, `No ${choice === 'next' ? 'next' : 'current'} ${symbol} option expiry is listed`);
    return e;
  }

  /** Lot size of a listed expiry's contracts (instrument master), else the underlying's. */
  private listedLotSize(symbol: string, expiry: string): number {
    const u = this.md.ref.underlying(symbol);
    try {
      for (const k of this.md.ref.strikes(symbol, expiry).slice(0, 3)) {
        const l = this.md.ref.listing(optKey(symbol, expiry, 'CE', k)) ?? this.md.ref.listing(optKey(symbol, expiry, 'PE', k));
        if (l) return l.lotSize;
      }
    } catch (e) {
      if (!(e instanceof NoLiveData) && ((e as { statusCode?: number }).statusCode ?? 500) >= 500) throw e;
    }
    return u.lotSize;
  }

  private dayLotSize(day: StoredAlgoDay): number {
    // Days stored before lot sizes were recorded: the algo's own record of it (no fills → no charges either way).
    return day.lotSize ?? (day.state as { lotSize?: number } | null)?.lotSize ?? 0;
  }

  private point(algo: AnyAlgo, state: unknown, snap: AlgoSnapshot): AlgoSeriesPoint {
    const legs = algo.openLegs(state) as AlgoLeg[];
    const ce = legs.find((l) => l.type === 'CE') ?? null;
    const pe = legs.find((l) => l.type === 'PE') ?? null;
    const open = openPnl(legs, snap);
    return {
      ts: snap.ts,
      spot: snap.spot === null ? null : r2(snap.spot),
      mtm: open === null ? null : Math.round(algo.realized(state) + open),
      level: algo.level?.(state) ?? 0,
      ceStrike: ce?.strike ?? null,
      ce: ce ? snap.premium('CE', ce.strike) : null,
      peStrike: pe?.strike ?? null,
      pe: pe ? snap.premium('PE', pe.strike) : null,
      ...(legs.length > 2 ? { positions: legs.map((l) => ({ key: `${l.strike} ${l.type}`, ltp: snap.premium(l.type, l.strike) })) } : {}),
    };
  }

  /** Day result. `unrealized` null → the open legs could not be valued: P&L blank (and `incomplete` says why). */
  private summary(
    algo: AnyAlgo,
    day: { date: string; expiry: string; state: unknown; events: AlgoEvent[]; maxProfit: number; maxLoss: number; maxLevel: number },
    unrealized: number | null,
    lotSize: number,
    incomplete?: string,
  ): AlgoDaySummary {
    const fills = day.events.flatMap((e) => e.fills);
    const charges = Math.round(totalCharges(fills, lotSize));
    const pnl = unrealized === null ? null : Math.round(algo.realized(day.state) + unrealized);
    const last = [...day.events].reverse().find((e) => FINAL_KINDS.includes(e.kind as AlgoExitKind));
    const reason = (day.state as { stopReason?: string | null }).stopReason ?? '';
    return {
      date: day.date,
      expiry: day.expiry,
      entered: day.events.some((e) => e.kind === 'ENTRY'),
      pnl,
      charges,
      net: pnl === null ? null : pnl - charges,
      adjustments: day.events.filter((e) => e.kind === 'ADJUSTMENT' && e.fills.length > 0).length,
      maxLevel: day.maxLevel,
      orders: fills.length,
      maxProfit: Math.round(day.maxProfit),
      maxLoss: Math.round(day.maxLoss),
      exitKind: (last?.kind as AlgoExitKind) ?? 'NONE',
      exitReason: last?.message ?? incomplete ?? reason,
      exitTs: last?.ts ?? null,
      ...(incomplete ? { incomplete } : {}),
    };
  }

  /** Exchange settlement price of every leg (CE/PE: intrinsic at the final settlement), or the legs still awaiting it. */
  private settlements(symbol: string, expiry: string, legs: AlgoLeg[]): { prices: Map<string, number>; missing: string[] } {
    const prices = new Map<string, number>();
    const missing: string[] = [];
    for (const l of legs) {
      const v = this.md.history.settlement(optKey(symbol, expiry, l.type, l.strike));
      if (v === undefined) missing.push(instrumentLabel({ symbol, type: l.type, strike: l.strike, expiry }));
      else prices.set(`${l.type}|${l.strike}`, v);
    }
    return { prices, missing };
  }

  /** Snapshot at an expiry's close whose premiums are the settlement values (spot unknown here). */
  private settledSnapshot(symbol: string, day: { date: string; expiry: string }, lotSize: number, prices: Map<string, number>): AlgoSnapshot {
    const ts = this.md.calendarOf(symbol).expiryTs(day.expiry);
    return {
      ts,
      minuteOfDay: istParts(ts).minuteOfDay,
      date: day.expiry,
      symbol,
      spot: null,
      expiry: day.expiry,
      lotSize,
      strikes: [...new Set([...prices.keys()].map((k) => Number(k.split('|')[1])))].sort((a, b) => a - b),
      premium: (type, strike) => prices.get(`${type}|${strike}`) ?? null,
    };
  }

  /* -------------------------------- backtests -------------------------------- */

  /**
   * Replay one recorded session. Skipped (with the reason) when the session has no recorded chain of
   * the symbol, the expiry to trade was not recorded, the contract lot size is unknown or the
   * recording started after the algo's entry time. `until` (today, session in progress): replay up to
   * that time only.
   */
  private replayDay(algo: AnyAlgo, p: Record<string, unknown>, date: string, opts: { until?: number; withSeries: boolean; recorded?: ReadonlySet<string>; resolution?: BacktestResolution }): ReplayOutcome {
    const symbol = String(p.symbol);
    const md = mdFor(this.md, symbol);
    const perSecond = opts.resolution === '1s';
    const seconds = md.seconds;
    if (perSecond && !seconds) return { ok: false, reason: 'One-second data is not recorded (SECONDS_RECORD=false in .env)' };
    const recordedDates = opts.recorded ?? new Set(perSecond ? seconds!.dates() : md.intraday.sessions());
    if (!recordedDates.has(date)) return { ok: false, reason: perSecond ? `No one-second data was recorded on ${date}` : notRecordedReason(md, date, 'market data') };

    // Expiry: from the recorded chain's expiries of that session (nearest unexpired, or the one after it).
    const recorded = (perSecond ? seconds!.keys(date) : md.intraday.recordedKeys(date)).filter((k) => k.symbol === symbol && (k.kind === 'CE' || k.kind === 'PE') && k.expiry !== undefined && k.strike !== undefined && k.expiry >= date);
    const expiries = [...new Set(recorded.map((k) => k.expiry as string))].sort();
    if (!expiries.length) return { ok: false, reason: `No recorded ${symbol} option chain for ${date}` };
    const idx = p.expiry === 'next' ? 1 : 0;
    const choice = idx ? 'next' : 'current';
    const expiry = expiries[idx];
    if (!expiry) return { ok: false, reason: `Only the ${expiries[0]} ${symbol} expiry was recorded on ${date}: no ${choice} expiry to trade` };
    // Where the official F&O file of the day is loaded, it tells which expiry really was nearest.
    let eod: { expiry: string; strike: number; type: string; lotSize?: number }[] = [];
    try {
      eod = md.history.dailyOptions(symbol, date);
    } catch {
      eod = [];
    }
    const eodExpiries = [...new Set(eod.map((o) => o.expiry).filter((e) => e >= date))].sort();
    if (eodExpiries[idx] && eodExpiries[idx] !== expiry) {
      return { ok: false, reason: `The ${choice} ${symbol} expiry on ${date} was ${eodExpiries[idx]} (official F&O file), and its chain was not recorded` };
    }

    // Lot size: the contract's listing while it is listed, else the official file of that day.
    const legKeys = recorded.filter((k) => k.expiry === expiry);
    let lotSize: number | null = null;
    for (const k of legKeys.slice(0, 5)) {
      try {
        const l = md.ref.listing(k);
        if (l) {
          lotSize = l.lotSize;
          break;
        }
      } catch {
        break; // instrument master not loaded
      }
    }
    lotSize ??= eod.find((o) => o.expiry === expiry && Number(o.lotSize) > 0)?.lotSize ?? null;
    if (lotSize === null) {
      return { ok: false, reason: `Lot size of the ${symbol} ${expiry} contracts is unknown: they are no longer in the instrument master and the official F&O file for ${date} is not loaded` };
    }

    const secTape = perSecond ? new SecondTape(seconds!, symbol, date, legKeys) : null;
    const tape: Tape = secTape ?? new SessionTape(md, symbol, date, legKeys);
    if (!tape.hasSpot) return { ok: false, reason: `No recorded ${symbol} price on ${date}` };
    if (!tape.hasLegs) return { ok: false, reason: `No recorded ${symbol} ${expiry} option prices on ${date}` };
    const firstStep = tape.firstStepTs() as number;
    const entry = typeof p.entryTime === 'string' && /^\d{2}:\d{2}$/.test(p.entryTime) ? hhmmToMinutes(p.entryTime) : null;
    if (entry !== null && istParts(firstStep).minuteOfDay > entry + 1 && (opts.until === undefined || opts.until >= firstStep)) {
      return { ok: false, reason: `Recording of ${date} started at ${hhmm(firstStep - MINUTE)}, after the ${p.entryTime} entry` };
    }
    if (opts.until !== undefined && opts.until < firstStep) return { ok: false, reason: `Nothing of ${date} is recorded yet (${symbol} price)` };

    const state = algo.init(p);
    const events: AlgoEvent[] = [];
    const series: AlgoSeriesPoint[] = [];
    let maxProfit = 0;
    let maxLoss = 0;
    let maxLevel = 0;
    let last: AlgoSnapshot | null = null;
    let lastAlive: number | null = null;
    const len = md.calendar.sessionMinutes(date);
    const lastM = opts.until !== undefined ? Math.min(len, Math.floor(md.calendar.session(opts.until).minute)) : len;
    // Steps: every minute of the session, or every second of it (one-second data).
    const stepMs = perSecond ? 1000 : MINUTE;
    const firstTs = md.calendar.ts(date, 0) + (perSecond ? 1000 : 0);
    const lastTs = perSecond ? Math.min(md.calendar.ts(date, len), opts.until ?? Infinity) : md.calendar.ts(date, lastM);
    const fillBasis = { book: 0, ltp: 0 };
    let lastSeriesMinute = -1;
    for (let ts = firstTs; ts <= lastTs; ts += stepMs) {
      tape.seek(ts);
      if (!tape.alive(ts)) continue; // the recorder was not running: nothing is replayed for this step
      if (lastAlive !== null && ts - lastAlive - stepMs >= GAP_REPORT_MINUTES * MINUTE && !isFinal(algo.phase(state))) {
        const fmt = perSecond ? (t: number) => formatTimeIST(t) : hhmm;
        events.push({ ts, kind: 'INFO', message: `No recorded ${symbol} data ${fmt(lastAlive)}–${fmt(ts - stepMs)}: the algo was paused`, fills: [] });
      }
      lastAlive = ts;
      const snap: AlgoSnapshot = {
        ts,
        minuteOfDay: istParts(ts).minuteOfDay,
        date,
        symbol,
        spot: tape.spotClose(),
        expiry,
        lotSize,
        strikes: tape.strikes,
        premium: (type, strike) => tape.premium(type, strike),
        oi: (type, strike) => tape.oi(type, strike),
      };
      const fill: FillFn = (o) => {
        // One-second data: a buy fills at the recorded ask, a sell at the bid (book at most 10 s old),
        // else at the last traded price; one-minute data: at the minute's last traded price.
        if (secTape) {
          const b = secTape.book(o.type, o.strike);
          if (b && b.age <= BOOK_MAX_AGE_MS) {
            fillBasis.book++;
            return o.side === 'BUY' ? b.ask : b.bid;
          }
        }
        const px = tape.premium(o.type, o.strike);
        if (px == null) throw new Error(`No recorded price for ${o.strike} ${o.type} at ${perSecond ? formatTimeIST(ts) : hhmm(ts)}`);
        if (secTape) fillBasis.ltp++;
        return px;
      };
      events.push(...algo.step(p, state, snap, fill));
      const pt = this.point(algo, state, snap);
      if (pt.mtm !== null) {
        maxProfit = Math.max(maxProfit, pt.mtm);
        maxLoss = Math.min(maxLoss, pt.mtm);
      }
      maxLevel = Math.max(maxLevel, pt.level);
      // One point per minute for the chart (a one-second replay would give 22,500 points a day).
      const minuteOfDay = snap.minuteOfDay;
      if (opts.withSeries && (!perSecond || minuteOfDay !== lastSeriesMinute)) {
        series.push(pt);
        lastSeriesMinute = minuteOfDay;
      }
      // The snapshot reads the tape lazily: keep the open legs' premiums of this minute for valuation.
      last = { ...snap, premium: frozenPremiums(snap, algo.openLegs(state) as AlgoLeg[]) };
      if (!opts.withSeries && isFinal(algo.phase(state))) break;
    }

    if (perSecond && fillBasis.book + fillBasis.ltp > 0) {
      events.push({ ts: lastAlive ?? firstTs, kind: 'INFO', message: `One-second replay: ${fillBasis.book} fill(s) at the recorded bid/ask, ${fillBasis.ltp} at the last traded price (no two-sided book within 10 s)`, fills: [] });
    }
    const partial = opts.until !== undefined && opts.until < md.calendar.ts(date, md.calendar.sessionMinutes(date));
    const dayRec = { date, expiry, state, events, maxProfit, maxLoss, maxLevel };
    let unrealized: number | null = 0;
    let incomplete: string | undefined;
    const open = algo.openLegs(state) as AlgoLeg[];
    if (partial) {
      unrealized = open.length ? (last ? openPnl(open, last) : null) : 0;
    } else if (!isFinal(algo.phase(state))) {
      // The recording ended before the algo finished the day (its exit never ran).
      const ended = hhmm(tape.lastRecordedTs() as number);
      const exit = typeof p.exitTime === 'string' ? `the ${p.exitTime} exit` : 'the exit';
      if (!open.length) {
        incomplete = `Recording of ${date} ended at ${ended}, before the algo finished the day`;
      } else if (md.calendar.expiryTs(expiry) <= md.calendar.ts(date, md.calendar.sessionMinutes(date))) {
        const st = this.settlements(symbol, expiry, open);
        if (!st.missing.length) {
          const snap = this.settledSnapshot(symbol, { date, expiry }, lotSize, st.prices);
          const ev = algo.squareOff(p, state, snap, (o) => snap.premium(o.type, o.strike) as number, `Recording ended at ${ended}, before ${exit} — the contracts expired on ${expiry}: closed at the exchange settlement price`);
          events.push(ev);
        } else {
          unrealized = null;
          incomplete = `Recording of ${date} ended at ${ended}, before ${exit}; the contracts expired and the exchange settlement price is not published yet for ${st.missing.join(', ')}`;
        }
      } else {
        unrealized = null;
        incomplete = `Recording of ${date} ended at ${ended}, before ${exit}: the open legs have no recorded exit price`;
      }
    } else if (open.length) {
      // Final phase with legs still open (an exit order could not be filled at a recorded price).
      unrealized = last ? openPnl(open, last) : null;
      incomplete = `${open.length} leg(s) could not be squared off at a recorded price`;
    }
    const sum = this.summary(algo, dayRec, unrealized, lotSize, incomplete);
    return { ok: true, day: { sum, series, events, lotSize } };
  }

  /**
   * Replay one session the app recorded (default: the current session, replayed up to now while it
   * is in progress). 400 for a malformed/future/non-trading date; 503 when the day cannot be replayed.
   */
  async backtestDay(algoId: string, input: Record<string, unknown>, date: string | undefined, nowTs: number = this.md.clock.now(), resolution: BacktestResolution = '1m'): Promise<AlgoBacktestDay> {
    const algo = this.algo(algoId);
    const p = this.params(algo, input);
    const md = mdFor(this.md, String(p.symbol));
    const d = requireDate(md, date);
    const inProgress = d === md.calendar.session(nowTs).date && nowTs < md.calendar.ts(d, md.calendar.sessionMinutes(d));
    const r = this.replayDay(algo, p, d, { withSeries: true, resolution, ...(inProgress ? { until: nowTs } : {}) });
    if (!r.ok) throw new NoLiveData(r.reason);
    return { ...r.day.sum, algoId, symbol: String(p.symbol), lotSize: r.day.lotSize, partial: inProgress, resolution, series: r.day.series, events: r.day.events };
  }

  /**
   * Replay the last `days` completed trading sessions (today counts once the market has closed).
   * Sessions that were not recorded (or cannot be replayed) are listed in `skipped` with the reason;
   * stats and equity cover the complete days. 503 when no session has been recorded at all.
   */
  async backtestRange(algoId: string, input: Record<string, unknown>, days: number, nowTs: number = this.md.clock.now(), resolution: BacktestResolution = '1m'): Promise<AlgoBacktestRange> {
    const algo = this.algo(algoId);
    const p = this.params(algo, input);
    const md = mdFor(this.md, String(p.symbol));
    if (resolution === '1s' && !md.seconds) throw new NoLiveData('One-second data is not recorded (SECONDS_RECORD=false in .env)');
    const recordedDates = resolution === '1s' ? md.seconds!.dates() : md.intraday.sessions();
    if (!recordedDates.length) throw new NoLiveData(resolution === '1s' ? 'No one-second data has been recorded yet: it is recorded from the live feed while the market is open' : 'No session has been recorded yet: backtests replay only sessions the app recorded from the live feed');
    const n = Math.max(1, Math.min(MAX_HISTORY, Math.floor(Number.isFinite(days) ? days : 1)));
    const today = md.calendar.session(nowTs).date;
    // Completed sessions only: today counts once the market has closed.
    const lastDone = md.calendar.isTradingDay(today) && nowTs >= md.calendar.ts(today, md.calendar.sessionMinutes(today)) ? today : md.calendar.prev(today);
    const window = sessionsBack(md, lastDone, n);
    const recorded = new Set(recordedDates);
    const out: AlgoDaySummary[] = [];
    const skipped: AlgoSkippedDay[] = [];
    for (const date of window) {
      const r = this.replayDay(algo, p, date, { withSeries: false, recorded, resolution });
      if (r.ok) out.push(r.day.sum);
      else skipped.push({ date, reason: r.reason });
    }
    const complete = out.filter((d) => !d.incomplete && d.net !== null);
    let cum = 0;
    let peak = 0;
    let maxDd = 0;
    const equity = complete.map((d) => {
      cum += d.net as number;
      peak = Math.max(peak, cum);
      maxDd = Math.max(maxDd, peak - cum);
      return { date: d.date, net: d.net as number, cum };
    });
    const traded = complete.filter((d) => d.entered);
    const nets = traded.map((d) => d.net as number);
    const adj = traded.map((d) => d.adjustments);
    return {
      algoId,
      symbol: String(p.symbol),
      from: window[0],
      to: window[window.length - 1],
      recordedFrom: recordedDates[0] ?? null,
      resolution,
      days: out,
      skipped,
      equity,
      stats: {
        days: complete.length,
        tradedDays: traded.length,
        winDays: nets.filter((x) => x > 0).length,
        lossDays: nets.filter((x) => x < 0).length,
        winRate: traded.length ? +((nets.filter((x) => x > 0).length / traded.length) * 100).toFixed(1) : null,
        totalNet: cum,
        totalCharges: complete.reduce((a, d) => a + d.charges, 0),
        avgNet: traded.length ? Math.round(cum / traded.length) : null,
        bestDay: nets.length ? Math.max(...nets) : null,
        worstDay: nets.length ? Math.min(...nets) : null,
        maxDrawdown: maxDd,
        stoppedDays: complete.filter((d) => d.exitKind === 'STOP' || d.exitKind === 'ERROR').length,
        avgAdjustments: adj.length ? +(adj.reduce((a, b) => a + b, 0) / adj.length).toFixed(2) : null,
        maxAdjustments: adj.length ? Math.max(...adj) : null,
        incompleteDays: out.length - complete.length,
        skippedDays: skipped.length,
      },
    };
  }

  /* ------------------------------ live deployments ------------------------------ */

  private runs(uid: string): StoredAlgoRun[] {
    return this.db.list('algoRuns', uid);
  }

  private find(uid: string, id: string): StoredAlgoRun {
    const r = this.runs(uid).find((x) => x.id === id);
    if (!r) throw httpError(404, 'Algo run not found');
    return r;
  }

  /** One operation at a time per run (ticks, the first tick on deployment, stop). */
  private async withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const chained = prev.then(() => mine, () => mine);
    this.locks.set(id, chained);
    try {
      await prev.catch(() => undefined);
      return await fn();
    } finally {
      release();
      if (this.locks.get(id) === chained) this.locks.delete(id);
    }
  }

  list(uid: string): AlgoRunView[] {
    return this.runs(uid).map((r) => this.view(r));
  }

  get(uid: string, id: string): AlgoRunView {
    return this.view(this.find(uid, id));
  }

  /* ------------------------------- the user's own strategies ------------------------------- */

  /** Strategies the user saved (an algo with settings and a name), newest first. */
  userPresets(uid: string): AlgoPreset[] {
    return this.db.list('algoPresets', uid);
  }

  /**
   * Save the current settings of an algo as the user's own strategy: validated like a deploy (unknown algo 404,
   * invalid settings 400); at most MAX_USER_PRESETS per user. Built-in presets are never changed.
   */
  savePreset(uid: string, input: { algoId: string; name: string; summary?: string; params: Record<string, unknown> }): AlgoPreset {
    const algo = this.algo(input.algoId);
    const name = input.name.trim();
    if (!name) throw httpError(400, 'Give the strategy a name');
    const params = this.params(algo, input.params);
    const list = this.userPresets(uid);
    if (list.length >= MAX_USER_PRESETS) throw httpError(400, `At most ${MAX_USER_PRESETS} saved strategies — delete one first`);
    if ([...ALGO_PRESETS, ...list].some((x) => x.name.toLowerCase() === name.toLowerCase())) throw httpError(400, `A strategy named "${name}" already exists`);
    const rules = algo.describeRules?.(params) ?? algo.rules;
    const preset: AlgoPreset = { id: `my-${randomUUID().slice(0, 8)}`, algoId: algo.id, name, summary: (input.summary ?? '').trim() || `${algo.name}: ${rules[0] ?? ''}`.slice(0, 400), params, custom: true };
    list.unshift(preset);
    this.db.save();
    return preset;
  }

  deletePreset(uid: string, id: string): void {
    const list = this.userPresets(uid);
    const i = list.findIndex((x) => x.id === id);
    if (i < 0) throw httpError(404, ALGO_PRESETS.some((x) => x.id === id) ? 'Built-in strategies cannot be deleted' : 'No such saved strategy');
    list.splice(i, 1);
    this.db.save();
  }

  async create(uid: string, input: AlgoRunInput): Promise<AlgoRunView> {
    const algo = this.algo(input.algoId);
    const preset = input.presetId ? [...ALGO_PRESETS, ...this.userPresets(uid)].find((x) => x.id === input.presetId) : undefined;
    if (input.presetId && !preset) throw httpError(404, `Unknown preset ${input.presetId}`);
    if (preset && preset.algoId !== algo.id) throw httpError(400, `Preset ${preset.id} belongs to algo ${preset.algoId}`);
    // A preset's own values fill anything the request leaves out (or blank).
    const given = Object.fromEntries(Object.entries(input.params ?? {}).filter(([, v]) => v !== undefined && v !== ''));
    const params = this.params(algo, { ...(preset?.params ?? {}), ...given });
    const now = this.md.clock.now();
    // The expiry to trade must be listed (400), from the loaded instrument master (503 otherwise).
    this.pickExpiry(String(params.symbol), params.expiry, now);
    const runs = this.runs(uid);
    if (runs.filter((r) => r.status === 'running').length >= MAX_RUNNING) throw httpError(400, `At most ${MAX_RUNNING} algos can run at once — stop one first`);
    // Keep the preset's name only while its settings are unchanged.
    const asPreset = preset && JSON.stringify(this.params(algo, preset.params)) === JSON.stringify(params);
    const autoName = asPreset ? preset!.name : algo.label?.(params) ?? algo.name;
    const run: StoredAlgoRun = {
      id: `ALG-${randomUUID().slice(0, 8).toUpperCase()}`,
      algoId: algo.id,
      presetId: asPreset ? preset!.id : undefined,
      name: (input.name ?? '').trim() || autoName,
      params,
      status: 'running',
      createdAt: now,
      day: null,
      history: [],
      execution: input.execution === 'manual' ? 'manual' : 'auto',
    };
    runs.unshift(run);
    this.notifier.push(uid, { kind: 'system', title: `Algo deployed · ${run.name}`, body: `${params.symbol} · ${params.lots} lot(s) per leg · ${run.execution === 'manual' ? 'MANUAL: signals only, you place the orders' : 'paper trading on live prices'}` });
    await this.withLock(run.id, () => this.tickRun(uid, run));
    this.db.save();
    return this.view(run);
  }

  /**
   * Change a deployed run's name, settings or execution. The settings are validated like a deploy (400 with the
   * reason). While today's day has open positions (or has traded), only LIVE_EDITABLE_PARAMS (risk limits, exit
   * time) change now; every other changed setting — and a change of execution — is kept and applied when the next
   * day starts, so the open positions are never re-interpreted under other rules. With nothing traded today (or
   * no day yet) everything applies at once (a day still waiting for its entry is restarted with them).
   * Every change is written to the day's journal and notified.
   */
  async update(uid: string, id: string, input: AlgoRunUpdate): Promise<AlgoRunView> {
    const run = this.find(uid, id);
    const algo = this.algo(run.algoId);
    await this.withLock(run.id, async () => {
      const changes: string[] = [];
      // Everything is validated before anything changes: a refused edit leaves the run exactly as it was.
      const name = input.name?.trim();
      if (input.name !== undefined && !name) throw httpError(400, 'The name cannot be empty');
      const next = input.params ? this.params(algo, { ...(run.nextParams ?? run.params), ...input.params }) : null;
      if (name !== undefined && name !== run.name) {
        changes.push(`name → ${name}`);
        run.name = name;
      }
      const day = run.day;
      const legs = day && !day.closed ? (algo.openLegs(day.state) as AlgoLeg[]) : [];
      const traded = !!day && !day.closed && (legs.length > 0 || day.events.some((e) => e.fills.length > 0));
      if (next) {
        const before = run.params; // the journal quotes the values in force before this change
        const changed = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(before[k]));
        const live = (LIVE_EDITABLE_PARAMS as readonly string[]).filter((k) => changed.includes(k));
        const later = changed.filter((k) => !live.includes(k));
        const show = (k: string) => `${k} ${JSON.stringify(before[k] ?? null)} → ${JSON.stringify(next[k])}`;
        if (traded) {
          // Risk limits and the exit apply now; the rest from the next session.
          for (const k of live) run.params = { ...run.params, [k]: next[k] };
          if (later.length) run.nextParams = { ...run.params, ...Object.fromEntries(later.map((k) => [k, next[k]])) };
          else delete run.nextParams;
          if (live.length) changes.push(`now: ${live.map(show).join(', ')}`);
          if (later.length) changes.push(`from the next session (positions are open today): ${later.map(show).join(', ')}`);
        } else {
          if (changed.length) changes.push(changed.map(show).join(', '));
          run.params = next;
          delete run.nextParams;
          // A day still waiting for its entry restarts with the new settings (underlying / expiry may differ).
          if (day && !day.closed && changed.length) run.day = null;
        }
      }
      if (input.execution && input.execution !== (run.nextExecution ?? run.execution ?? 'auto')) {
        if (traded) {
          run.nextExecution = input.execution;
          changes.push(`execution → ${input.execution} from the next session (positions are open today)`);
        } else {
          run.execution = input.execution;
          delete run.nextExecution;
          changes.push(`execution → ${input.execution}`);
        }
      }
      if (!changes.length) return;
      const msg = `Settings changed: ${changes.join('; ')}`;
      if (run.day && !run.day.closed) run.day.events.push({ ts: this.md.clock.now(), kind: 'INFO', message: msg, fills: [] });
      this.notifier.push(uid, { kind: 'system', title: `Algo settings changed · ${run.name}`, body: msg });
      this.db.save();
    });
    return this.view(run);
  }

  async stop(uid: string, id: string, reason = 'Stopped by user'): Promise<AlgoRunView> {
    const run = this.find(uid, id);
    if (run.status !== 'running') throw httpError(400, 'Algo is not running');
    await this.withLock(run.id, async () => {
      if (run.status !== 'running') return; // stopped meanwhile (e.g. by an error)
      const day = run.day;
      if (day && !day.closed) await this.finishDay(uid, run, day, this.md.clock.now(), reason);
      run.status = 'stopped';
      run.stoppedAt = this.md.clock.now();
      delete run.waiting;
      this.db.save();
    });
    return this.view(run);
  }

  remove(uid: string, id: string): void {
    const runs = this.runs(uid);
    const i = runs.findIndex((x) => x.id === id);
    if (i < 0) throw httpError(404, 'Algo run not found');
    if (runs[i].status === 'running') throw httpError(400, 'Stop the algo before deleting it');
    runs.splice(i, 1);
    this.db.save();
  }

  /**
   * Called every couple of seconds: advances every running algo of every user while the session is
   * open, and closes days awaiting a settlement price once it is published. Overlapping calls are
   * skipped (a tick waits for live chains).
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const [uid, runs] of Object.entries(this.db.data.algoRuns ?? {})) {
        for (const run of [...(runs as StoredAlgoRun[])]) {
          if (run.unsettled?.length) this.settlePending(uid, run);
          if (run.status === 'running') await this.withLock(run.id, () => this.tickRun(uid, run));
        }
        // After every run moved: the user's portfolio stop loss over all of them.
        try {
          await this.checkGuard(uid);
        } catch (err) {
          this.notifier.push(uid, { kind: 'system', title: 'Portfolio stop loss check failed', body: `${errMsg(err)}. Watch your algo positions.` });
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /* ----------------------------------- portfolio stop loss ----------------------------------- */

  private guardOf(uid: string): StoredGuard {
    const all = (this.db.data.algoGuard ??= {});
    return (all[uid] ??= { settings: { ...DEFAULT_GUARD } });
  }

  /** IST date of now (the guard's day: NSE, BSE and MCX share it). */
  private guardDate(): string {
    return istParts(this.md.clock.now()).date;
  }

  /** The guard fired today: no run trades again today (new days are not started). */
  haltedToday(uid: string, date = this.guardDate()): string | null {
    const h = this.db.data.algoGuard?.[uid]?.halted;
    return h && h.date === date ? h.reason : null;
  }

  /**
   * Today's figures over the user's runs: each run's P&L today (realised + open at its last priced tick, before
   * charges; null while an open leg has no live price) and open lots per underlying; the peak lots of the day are
   * kept (a limit per lot traded never shrinks when positions are closed at a loss).
   */
  private guardFigures(uid: string, persist: boolean): Omit<PortfolioGuardView, 'settings' | 'halted' | 'gaps'> & { unknown: string[] } {
    const g = this.guardOf(uid);
    const date = this.guardDate();
    if (!g.day || g.day.date !== date) g.day = { date, peak: {} };
    const open: Record<string, number> = {};
    const runs: PortfolioGuardView['runs'] = [];
    const unknown: string[] = [];
    let pnl: number | null = 0;
    for (const run of this.runs(uid)) {
      const day = run.day;
      if (!day || day.date !== date) continue;
      const algo = algoById(run.algoId);
      if (!algo) continue;
      const symbol = String(run.params.symbol);
      // Legs still open on a closed day (a square-off the broker could not fill) are still exposure: counted.
      const legs = algo.openLegs(day.state) as AlgoLeg[];
      const lots = legs.reduce((a, l) => a + l.lots, 0);
      if (lots) open[symbol] = (open[symbol] ?? 0) + lots;
      let runPnl: number | null;
      if (!legs.length) runPnl = Math.round(algo.realized(day.state));
      else runPnl = day.lastMtm ?? null; // the latest tick's (every few seconds), not the minute series
      if (runPnl === null) {
        unknown.push(run.name);
        pnl = null;
      } else if (pnl !== null) pnl += runPnl;
      runs.push({ id: run.id, name: run.name, symbol, pnl: runPnl, openLots: lots });
    }
    for (const [sym, n] of Object.entries(open)) g.day.peak[sym] = Math.max(g.day.peak[sym] ?? 0, n);
    if (persist) this.db.save();
    const symbols = [...new Set([...Object.keys(open), ...Object.keys(g.day.peak)])].sort();
    const lots = symbols.map((symbol) => ({ symbol, open: open[symbol] ?? 0, peak: g.day!.peak[symbol] ?? 0 }));
    const peakLots = lots.reduce((a, l) => a + l.peak, 0);
    const s = g.settings;
    const perLotLimit = s.perLot > 0 && peakLots > 0 ? s.perLot * peakLots : null;
    const totalLimit = s.totalLoss > 0 ? s.totalLoss : null;
    const limits = [perLotLimit, totalLimit].filter((x): x is number => x !== null);
    return { date, lots, openLots: lots.reduce((a, l) => a + l.open, 0), peakLots, pnl, perLotLimit, totalLimit, limit: limits.length ? Math.min(...limits) : null, runs, unknown };
  }

  guardView(uid: string): PortfolioGuardView {
    const g = this.guardOf(uid);
    const f = this.guardFigures(uid, false);
    const gaps = new Gaps();
    if (f.unknown.length) gaps.add('pnl', `No live price for an open leg of ${f.unknown.join(', ')}: the combined P&L is not known right now (the limit is checked again with the next price)`);
    if (!g.settings.enabled) gaps.add('limit', 'The portfolio stop loss is switched off');
    else if (f.limit === null) gaps.add('limit', g.settings.totalLoss > 0 ? 'No limit applies yet' : 'No lots traded today yet: the per-lot limit starts with the first position');
    const { unknown: _u, ...rest } = f;
    const h = g.halted && g.halted.date === f.date ? { at: g.halted.at, reason: g.halted.reason } : null;
    return { settings: { ...g.settings }, ...rest, halted: h, ...gaps.out() };
  }

  saveGuard(uid: string, input: Partial<PortfolioGuardSettings>): PortfolioGuardView {
    const g = this.guardOf(uid);
    const next = { ...g.settings, ...input };
    if (typeof next.enabled !== 'boolean') throw httpError(400, 'enabled must be true or false');
    if (!(Number.isFinite(next.perLot) && next.perLot >= 0 && next.perLot <= 1_000_000)) throw httpError(400, 'Per-lot limit must be between ₹0 (not used) and ₹10,00,000');
    if (!(Number.isFinite(next.totalLoss) && next.totalLoss >= 0 && next.totalLoss <= 100_000_000)) throw httpError(400, 'Total loss limit must be between ₹0 (not used) and ₹10,00,00,000');
    if (next.enabled && next.perLot === 0 && next.totalLoss === 0) throw httpError(400, 'Set a per-lot or a total loss limit (or switch the portfolio stop loss off)');
    const before = g.settings;
    g.settings = next;
    const rs = (v: number) => (v > 0 ? `₹${v.toLocaleString('en-IN')}` : 'not used');
    this.notifier.push(uid, { kind: 'system', title: 'Portfolio stop loss changed', body: `${next.enabled ? 'On' : 'OFF'} · per lot ${rs(next.perLot)} (was ${rs(before.perLot)}) · total ${rs(next.totalLoss)} (was ${rs(before.totalLoss)})` });
    this.db.save();
    return this.guardView(uid);
  }

  /** Lift today's halt (the user's explicit decision): runs may trade again today. */
  resumeGuard(uid: string): PortfolioGuardView {
    const g = this.guardOf(uid);
    if (!g.halted || g.halted.date !== this.guardDate()) throw httpError(400, 'Trading is not halted today');
    // Today's realised losses still count: resuming while they are beyond the limit would halt again at once.
    const f = this.guardFigures(uid, false);
    if (g.settings.enabled && f.limit !== null && f.pnl !== null && f.pnl <= -f.limit) {
      throw httpError(400, `Today's combined P&L ₹${Math.round(f.pnl).toLocaleString('en-IN')} is still beyond the −₹${Math.round(f.limit).toLocaleString('en-IN')} limit: raise the limit (or switch the portfolio stop loss off) to resume`);
    }
    const reason = g.halted.reason;
    delete g.halted;
    this.notifier.push(uid, { kind: 'system', title: 'Portfolio stop loss: trading resumed by you', body: `Halt lifted (it was: ${reason}). Runs whose day was already squared off stay closed today; runs that had not started may trade.` });
    this.db.save();
    return this.guardView(uid);
  }

  /**
   * The portfolio stop loss: when the combined P&L of today's algo runs reaches −limit, every run with an open day
   * is squared off through the broker (its day closed), trading is halted for the rest of the day for all runs,
   * and the user is told — loudly if a square-off left a position open.
   */
  private async checkGuard(uid: string): Promise<void> {
    const g = this.guardOf(uid);
    const f = this.guardFigures(uid, false);
    if (!g.settings.enabled || f.limit === null || f.pnl === null || this.haltedToday(uid)) return;
    if (f.pnl > -f.limit) return;
    const ts = this.md.clock.now();
    const reason = `Portfolio stop loss: today's combined P&L of the algo runs ₹${Math.round(f.pnl).toLocaleString('en-IN')} reached −₹${Math.round(f.limit).toLocaleString('en-IN')} (${f.limit === f.perLotLimit ? `₹${g.settings.perLot.toLocaleString('en-IN')} per lot × ${f.peakLots} lots` : 'total loss limit'})`;
    g.halted = { date: f.date, at: ts, reason };
    this.db.save();
    const left: string[] = [];
    for (const run of this.runs(uid)) {
      const day = run.day;
      if (run.status !== 'running' || !day || day.closed) continue;
      // One run failing to square off never stops the others (and tickRun retries an open day while halted).
      try {
        await this.withLock(run.id, async () => {
          if (day.closed) return;
          await this.finishDay(uid, run, day, ts, `${reason} — all algo positions squared off; trading halted for the day`);
        });
      } catch (err) {
        left.push(`${run.name}: square-off error — ${errMsg(err)}`);
      }
      const still = this.algo(run.algoId).openLegs(day.state) as AlgoLeg[];
      for (const l of still) left.push(`${run.name}: ${instrumentLabel({ symbol: String(run.params.symbol), type: l.type, strike: l.strike, expiry: day.expiry })}`);
    }
    this.notifier.push(uid, { kind: 'system', title: 'PORTFOLIO STOP LOSS HIT — algo trading halted for today', body: `${reason}. Every algo run was squared off and none trades again today.` });
    if (left.length) {
      this.notifier.push(uid, { kind: 'system', title: 'CRITICAL: square-off failed — close these positions yourself now', body: left.join('; ') });
    }
    this.db.save();
  }

  /** Open legs of running algos (streamed in the provider's 'user' tier; createServices picks this up). */
  userContracts(): UserContract[] {
    const out: UserContract[] = [];
    for (const runs of Object.values(this.db.data.algoRuns ?? {})) {
      for (const run of runs as StoredAlgoRun[]) {
        const day = run.day;
        if (run.status !== 'running' || !day || day.closed) continue;
        const algo = algoById(run.algoId);
        if (!algo) continue;
        for (const l of algo.openLegs(day.state) as AlgoLeg[]) out.push(optKey(String(run.params.symbol), day.expiry, l.type, l.strike));
      }
    }
    return out;
  }

  /**
   * Live snapshot of the run's expiry: the live chain (md.live.chain) and the live underlying price.
   * Premiums are live-session trades only (null otherwise). When the chain or the underlying price is
   * not live, the snapshot carries no underlying price and `waiting` says why: the algo then opens
   * nothing (it waits — a data outage is not "no eligible strike"); an exit still goes to the broker,
   * which fills only against a live bid/ask.
   */
  private async liveSnapshot(symbol: string, expiry: string, lotSize: number, ts: number): Promise<{ snap: AlgoSnapshot; waiting?: string }> {
    const md = mdFor(this.md, symbol);
    const dates = liveDates(md);
    let chain: RawChain | null = null;
    let waiting: string | undefined;
    try {
      chain = await md.live.chain(symbol, expiry);
    } catch (e) {
      if (!(e instanceof NoLiveData)) throw e;
      waiting = e.message;
    }
    const spot = chain ? livePrice(md, md.live.quote(spotKey(symbol)), dates) : null;
    if (spot === null) waiting ??= `No live ${symbol} price`;
    const legs = new Map<string, LiveQuote>();
    const strikes = new Set<number>();
    for (const row of chain?.rows ?? []) {
      strikes.add(row.strike);
      if (row.ce) legs.set(`CE|${row.strike}`, row.ce);
      if (row.pe) legs.set(`PE|${row.strike}`, row.pe);
    }
    try {
      for (const k of md.ref.strikes(symbol, expiry)) strikes.add(k);
    } catch (e) {
      if (!(e instanceof NoLiveData) && ((e as { statusCode?: number }).statusCode ?? 500) >= 500) throw e;
    }
    const cache = new Map<string, number | null>();
    const snap: AlgoSnapshot = {
      ts,
      minuteOfDay: istParts(ts).minuteOfDay,
      date: md.calendar.session(ts).date,
      symbol,
      spot,
      expiry,
      lotSize,
      strikes: [...strikes].sort((a, b) => a - b),
      premium(type, strike) {
        const id = `${type}|${strike}`;
        let v = cache.get(id);
        if (v === undefined) {
          // A leg the chain does not carry (or no chain at all): its own live quote, if any.
          const q = legs.get(id) ?? (chain && strikes.has(strike) ? undefined : md.live.quote(optKey(symbol, expiry, type, strike)));
          v = livePrice(md, q, dates);
          cache.set(id, v);
        }
        return v;
      },
      // Open interest as the feed reports it on the live chain (a strike off the chain: its own quote).
      oi(type, strike) {
        const id = `${type}|${strike}`;
        const q = legs.get(id) ?? (chain && strikes.has(strike) ? undefined : md.live.quote(optKey(symbol, expiry, type, strike)));
        return q && typeof q.oi === 'number' && Number.isFinite(q.oi) ? q.oi : null;
      },
    };
    return { snap, ...(waiting ? { waiting } : {}) };
  }

  /**
   * Paper orders through the broker: MARKET, filled only at a live bid/ask; anything else throws (reported by the
   * algo). Manual execution: no order — a signal at the live bid (sell) / ask (buy), notified for the user to place
   * by hand; without a live bid/ask it throws like a rejected order.
   */
  private liveFill(uid: string, run: StoredAlgoRun, day: StoredAlgoDay): FillFn {
    if (run.execution === 'manual') {
      return (o) => {
        const symbol = String(run.params.symbol);
        const spec = { symbol, type: o.type, strike: o.strike, expiry: day.expiry };
        const px = this.pricer.price(spec);
        const price = o.side === 'BUY' ? px.ask : px.bid;
        if (price === null) throw new Error(`No live ${o.side === 'BUY' ? 'ask' : 'bid'} for ${instrumentLabel(spec)}`);
        this.notifier.push(uid, {
          kind: 'system',
          title: `Algo SIGNAL · ${run.name}: ${o.side} ${o.lots} lot${o.lots > 1 ? 's' : ''} ${instrumentLabel(spec)}`,
          body: `Place this order yourself (manual mode): ${o.side} ${o.lots} lot(s) ${instrumentLabel(spec)} at market — live ${o.side === 'BUY' ? 'ask' : 'bid'} ₹${price}. Reason: ${o.reason}. The algo counts it at this price.`,
        });
        return price;
      };
    }
    return (o) => {
      const order = this.broker.place(uid, {
        symbol: String(run.params.symbol),
        type: o.type,
        strike: o.strike,
        expiry: day.expiry,
        side: o.side,
        lots: o.lots,
        orderType: 'MARKET',
        product: 'MIS',
        tag: `algo:${run.id}`,
      });
      if (order.status !== 'COMPLETE') throw new Error(order.message ?? `order ${order.status.toLowerCase()}`);
      return order.avgPrice;
    };
  }

  private record(uid: string, run: StoredAlgoRun, day: StoredAlgoDay, events: AlgoEvent[]) {
    for (const ev of events) {
      day.events.push(ev);
      if (ev.kind === 'INFO' && !ev.fills.length) continue;
      const label = { ENTRY: 'entry', ADJUSTMENT: 'adjustment', STOP: 'stopped for the day', EXIT: 'exit', MANUAL_STOP: 'stopped', ERROR: 'error', INFO: 'update' }[ev.kind];
      this.notifier.push(uid, { kind: 'system', title: `Algo ${label} · ${run.name}`, body: ev.message });
    }
    if (day.events.length > MAX_EVENTS_PER_DAY) day.events.splice(0, day.events.length - MAX_EVENTS_PER_DAY);
  }

  /** Close the day into the run's history. Legs still open (an order was rejected) make it incomplete. */
  private closeDay(run: StoredAlgoRun, day: StoredAlgoDay, snap: AlgoSnapshot | null) {
    if (day.closed) return;
    const algo = this.algo(run.algoId);
    day.closed = true;
    const open = algo.openLegs(day.state) as AlgoLeg[];
    const unrealized = open.length ? (snap ? openPnl(open, snap) : null) : 0;
    const symbol = String(run.params.symbol);
    const incomplete = open.length
      ? `Not squared off: ${open.map((l) => instrumentLabel({ symbol, type: l.type, strike: l.strike, expiry: day.expiry })).join(', ')} — check open positions; the day's result is not final`
      : undefined;
    this.addHistory(run, this.summary(algo, day, unrealized, this.dayLotSize(day), incomplete));
  }

  private addHistory(run: StoredAlgoRun, sum: AlgoDaySummary) {
    const i = run.history.findIndex((h) => h.date === sum.date && h.expiry === sum.expiry);
    if (i >= 0) run.history[i] = sum;
    else run.history.unshift(sum);
    if (run.history.length > MAX_HISTORY) run.history.length = MAX_HISTORY;
  }

  /**
   * Square off a day that is still open (user stop, or a missed exit found on the next session):
   * expired contracts close at the exchange settlement price (the broker settles those positions
   * itself, no order) — or wait for it, the day marked incomplete meanwhile; live contracts are
   * squared off through the broker at the live bid/ask.
   */
  private async finishDay(uid: string, run: StoredAlgoRun, day: StoredAlgoDay, ts: number, why: string): Promise<void> {
    const algo = this.algo(run.algoId);
    const symbol = String(run.params.symbol);
    const lotSize = this.dayLotSize(day);
    const open = algo.openLegs(day.state) as AlgoLeg[];
    if (this.md.calendarOf(symbol).expiryTs(day.expiry) <= ts) {
      if (!open.length) {
        const snap = this.settledSnapshot(symbol, day, lotSize, new Map());
        const none: FillFn = () => {
          throw new Error('no open leg to close');
        };
        this.record(uid, run, day, [algo.squareOff(run.params, day.state, snap, none, why)]);
        this.closeDay(run, day, snap);
        return;
      }
      const st = this.settlements(symbol, day.expiry, open);
      if (st.missing.length) {
        const reason = `${why} — the contracts expired on ${day.expiry}; awaiting the exchange settlement price for ${st.missing.join(', ')}`;
        this.record(uid, run, day, [{ ts, kind: 'INFO', message: reason, fills: [] }]);
        day.closed = true;
        this.addHistory(run, this.summary(algo, day, null, lotSize, reason));
        (run.unsettled ??= []).push(day);
        return;
      }
      const snap = this.settledSnapshot(symbol, day, lotSize, st.prices);
      const ev = algo.squareOff(run.params, day.state, snap, (o) => snap.premium(o.type, o.strike) as number, `${why} — the contracts expired on ${day.expiry}: closed at the exchange settlement price`);
      this.record(uid, run, day, [ev]);
      this.closeDay(run, day, snap);
      return;
    }
    const { snap } = await this.liveSnapshot(symbol, day.expiry, lotSize, ts);
    const ev = algo.squareOff(run.params, day.state, snap, this.liveFill(uid, run, day), why);
    this.record(uid, run, day, [ev]);
    this.closeDay(run, day, snap);
  }

  /** Close days whose expired legs were waiting for the settlement price, once it is published. */
  private settlePending(uid: string, run: StoredAlgoRun): void {
    const algo = algoById(run.algoId);
    if (!algo || !run.unsettled) return;
    const symbol = String(run.params.symbol);
    for (const day of [...run.unsettled]) {
      const open = algo.openLegs(day.state) as AlgoLeg[];
      const st = this.settlements(symbol, day.expiry, open);
      if (st.missing.length) continue;
      const lotSize = this.dayLotSize(day);
      const snap = this.settledSnapshot(symbol, day, lotSize, st.prices);
      const ev = algo.squareOff(run.params, day.state, snap, (o) => snap.premium(o.type, o.strike) as number, `Closed at the exchange settlement price of ${day.expiry}`);
      this.record(uid, run, day, [ev]);
      this.addHistory(run, this.summary(algo, day, 0, lotSize));
      run.unsettled = run.unsettled.filter((d) => d !== day);
      this.db.save();
    }
    if (!run.unsettled.length) delete run.unsettled;
  }

  private async tickRun(uid: string, run: StoredAlgoRun): Promise<void> {
    if (run.status !== 'running') return;
    const md = mdFor(this.md, String(run.params.symbol));
    const ts = md.clock.now();
    const session = md.calendar.session(ts);
    if (session.status !== 'open') {
      // Real trading sessions only (weekends and exchange holidays are closed).
      delete run.waiting;
      return;
    }
    const algo = this.algo(run.algoId);
    const symbol = String(run.params.symbol);
    try {
      let day = run.day;
      if (day && day.date !== session.date) {
        // The session ended without the algo's exit running (server down): close it now.
        if (!day.closed) await this.finishDay(uid, run, day, ts, `Missed the ${String(run.params.exitTime ?? 'exit')} exit on ${day.date}`);
        day = null;
      }
      if (!day && (run.nextParams || run.nextExecution)) {
        // Settings saved during the last open day take effect now, before anything of the new day.
        if (run.nextParams) run.params = run.nextParams;
        if (run.nextExecution) run.execution = run.nextExecution;
        delete run.nextParams;
        delete run.nextExecution;
        this.db.save();
        return; // the next tick starts the day with them (the underlying may have changed)
      }
      if (!day) {
        // The portfolio stop loss fired today: no run starts a day again today.
        const halt = this.haltedToday(uid);
        if (halt) {
          run.waiting = `Trading halted for today — ${halt}`;
          return;
        }
        const expiry = this.pickExpiry(symbol, run.params.expiry, ts);
        day = { date: session.date, expiry, state: algo.init(run.params), events: [], series: [], lastMinute: -1, maxProfit: 0, maxLoss: 0, maxLevel: 0, closed: false, lotSize: this.listedLotSize(symbol, expiry) };
        run.day = day;
      }
      if (day.closed) {
        delete run.waiting;
        return;
      }
      // Safety nets before the algo's own step: the portfolio stop loss halted trading today (a day still open,
      // e.g. its square-off failed, is squared off again), and the session's last minute (an exit time at or
      // after the close would otherwise leave positions overnight).
      const halt = this.haltedToday(uid);
      const closing = session.minute >= md.calendar.sessionMinutes(session.date) - 1;
      if (halt || closing) {
        await this.finishDay(uid, run, day, ts, halt ? `Trading halted for today — ${halt}` : 'Session closing: squared off before the close');
        this.db.save();
        return;
      }
      const { snap, waiting } = await this.liveSnapshot(symbol, day.expiry, this.dayLotSize(day), ts);
      if (run.status !== 'running' || run.day !== day || day.closed) return;
      if (waiting) run.waiting = waiting;
      else delete run.waiting;
      const events = algo.step(run.params, day.state, snap, this.liveFill(uid, run, day));
      if (events.length) this.record(uid, run, day, events);
      const pt = this.point(algo, day.state, snap);
      day.lastMtm = pt.mtm;
      if (pt.mtm !== null) {
        day.maxProfit = Math.max(day.maxProfit, pt.mtm);
        day.maxLoss = Math.min(day.maxLoss, pt.mtm);
      }
      day.maxLevel = Math.max(day.maxLevel, pt.level);
      const minute = Math.floor(session.minute);
      const newMinute = minute !== day.lastMinute;
      if (newMinute || events.length) {
        if (minute === day.lastMinute) day.series[day.series.length - 1] = pt;
        else day.series.push(pt);
        day.lastMinute = minute;
      }
      if (isFinal(algo.phase(day.state))) this.closeDay(run, day, snap);
      if (events.length || newMinute) this.db.save();
    } catch (err) {
      if (err instanceof NoLiveData) {
        // Live data (instrument master, quotes) not available: wait, the run keeps going.
        run.waiting = err.message;
        return;
      }
      run.error = errMsg(err);
      run.status = 'stopped';
      run.stoppedAt = ts;
      this.notifier.push(uid, { kind: 'system', title: `Algo error · ${run.name}`, body: `${run.error}. The algo was stopped; check open positions.` });
      this.db.save();
    }
  }

  private view(run: StoredAlgoRun): AlgoRunView {
    const algo = this.algo(run.algoId);
    const md = mdFor(this.md, String(run.params.symbol));
    const gaps = new Gaps();
    const day = run.day;
    let today: AlgoRunView['today'] = null;
    let todayNet: number | null = 0;
    if (run.status === 'running' && run.waiting) gaps.add('liveData', run.waiting);
    if (day) {
      const symbol = String(run.params.symbol);
      const sameDay = md.calendar.session(md.clock.now()).date === day.date;
      const lotSize = this.dayLotSize(day);
      const legs = (algo.openLegs(day.state) as AlgoLeg[]).map((l) => {
        // Live-session trade price (an expired contract: its exchange settlement value); null otherwise.
        let ltp: number | null = null;
        try {
          ltp = this.pricer.price({ symbol, type: l.type, strike: l.strike, expiry: day.expiry }).ltp;
        } catch {
          ltp = null; // not listed / awaiting settlement / master not loaded: blank
        }
        const sign = l.side === 'SELL' ? 1 : -1;
        const pnl = ltp === null ? null : Math.round(sign * (l.entryPrice - ltp) * l.lots * lotSize);
        return { ...l, ltp, pnl };
      });
      const realized = algo.realized(day.state);
      const unrealized = legs.some((l) => l.pnl === null) ? null : legs.reduce((a, l) => a + (l.pnl as number), 0);
      if (unrealized === null) {
        const missing = legs.filter((l) => l.pnl === null).map((l) => instrumentLabel({ symbol, type: l.type, strike: l.strike, expiry: day.expiry }));
        gaps.add('today', `No live price for ${missing.join(', ')}${sameDay ? '' : ` (positions of ${day.date})`}`);
      }
      const charges = Math.round(totalCharges(day.events.flatMap((e) => e.fills as AlgoFill[]), lotSize));
      const mtm = unrealized === null ? null : Math.round(realized + unrealized);
      today = {
        date: day.date,
        expiry: day.expiry,
        phase: algo.phase(day.state),
        status: [...algo.status(run.params, day.state), ...(run.status === 'running' && run.waiting && !day.closed ? [{ label: 'Live data', value: run.waiting }] : [])],
        legs,
        realized: Math.round(realized),
        unrealized,
        charges,
        mtm,
        series: day.series,
        events: [...day.events].reverse(),
        lotSize,
      };
      // A closed day is already in the history.
      if (!day.closed) todayNet = mtm === null ? null : mtm - charges;
    }
    const unknownDays = run.history.filter((d) => d.net === null);
    const totalNet: number | null = todayNet === null || unknownDays.length ? null : run.history.reduce((a, d) => a + (d.net as number), 0) + todayNet;
    if (totalNet === null) gaps.add('totalNet', unknownDays.length ? `Result not known for ${unknownDays.map((d) => d.date).join(', ')}` : "Today's open legs have no live price");
    return {
      id: run.id,
      algoId: run.algoId,
      presetId: run.presetId,
      name: run.name,
      params: run.params,
      status: run.status,
      createdAt: run.createdAt,
      stoppedAt: run.stoppedAt,
      today,
      history: run.history,
      totalNet,
      error: run.error,
      execution: run.execution ?? 'auto',
      ...(run.nextParams ? { pendingParams: run.nextParams } : {}),
      ...(run.nextExecution ? { pendingExecution: run.nextExecution } : {}),
      ...gaps.out(),
    };
  }
}

/** Premiums of the open legs frozen at the current tape position (the tape moves on afterwards). */
function frozenPremiums(snap: AlgoSnapshot, legs: AlgoLeg[]): AlgoSnapshot['premium'] {
  const m = new Map<string, number | null>();
  for (const l of legs) m.set(`${l.type}|${l.strike}`, snap.premium(l.type, l.strike));
  return (type, strike) => {
    const id = `${type}|${strike}`;
    return m.has(id) ? (m.get(id) as number | null) : null;
  };
}
