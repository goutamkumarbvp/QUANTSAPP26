/**
 * Top-OI option selling (S7).
 *
 *  1. Trading days: the chosen weekdays only (S7: Wednesday and Thursday); other days: no trade.
 *  2. At the entry time the live open interest of every CE and every PE of the run's expiry is read and
 *     ranked separately, highest first. The top `topN` CE strikes and the top `topN` PE strikes are each
 *     sold, `lots` lot(s) apiece (S7: 3 + 3 = 6 positions of 1 lot).
 *     A ranked strike without a traded premium cannot be sold: then nothing is sold and the day is over
 *     (the ranking is never changed to skip it).
 *  3. Daily stop loss in ₹ on the combined P&L of all positions (realised + open, before charges): when hit,
 *     everything is squared off and trading stops for the day (no re-entry). 0 = none.
 *  4. Whatever is open at the exit time is squared off. No overnight positions.
 */
import { hhmmToMinutes, validateTimes, type AlgoDefinition, type AlgoEvent, type AlgoFill, type AlgoLeg, type AlgoPhase, type AlgoSnapshot, type AlgoStatusItem, type FillFn, type OptionSide } from './types';
import { isStrikeMultiple } from './premium-ladder';

export type TradingDays = 'all' | 'wed-thu' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri';

export interface OiTopParams {
  symbol: string;
  expiry: 'current' | 'next';
  /** Lots sold at each ranked strike. */
  lots: number;
  /** How many of the highest-OI strikes are sold on each side. */
  topN: number;
  /** Strikes considered (multiples of this; 0 = any listed strike). */
  strikeMultiple: number;
  days: TradingDays;
  entryTime: string;
  exitTime: string;
  /** Daily stop loss in ₹ on the combined P&L of all positions; 0 = none. */
  stopLoss: number;
  lateEntry: boolean;
}

export interface OiTopState {
  phase: AlgoPhase;
  legs: AlgoLeg[];
  /** The ranking used at entry, for the journal: [strike, OI] highest first. */
  ranked: { CE: [number, number][]; PE: [number, number][] };
  realized: number;
  lotSize: number;
  firstSeenMinute: number | null;
  stopReason: string | null;
  orders: number;
}

const EPS = 1e-9;
const SIDES: OptionSide[] = ['CE', 'PE'];
const r2 = (x: number) => Math.round(x * 100) / 100;
const rupees = (x: number) => `₹${r2(x).toFixed(2).replace(/\.00$/, '')}`;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS: Record<TradingDays, number[]> = { all: [1, 2, 3, 4, 5, 6, 0], 'wed-thu': [3, 4], mon: [1], tue: [2], wed: [3], thu: [4], fri: [5] };
const DAYS_LABEL: Record<TradingDays, string> = { all: 'every trading day', 'wed-thu': 'Wednesday and Thursday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday' };

/** Weekday (0 = Sunday) of an IST date 'YYYY-MM-DD'. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/**
 * Strikes of one side ranked by open interest, highest first (ties: the strike nearer the spot, then the lower).
 * Strikes without a known OI are not ranked.
 */
export function rankByOi(snap: Pick<AlgoSnapshot, 'strikes' | 'oi' | 'spot'>, type: OptionSide, multiple: number): [number, number][] {
  if (!snap.oi) return [];
  const out: [number, number][] = [];
  for (const k of snap.strikes) {
    if (!isStrikeMultiple(k, multiple)) continue;
    const oi = snap.oi(type, k);
    if (oi != null && oi > 0) out.push([k, oi]);
  }
  const d = (k: number) => (snap.spot == null ? 0 : Math.abs(k - snap.spot));
  return out.sort((a, b) => b[1] - a[1] || d(a[0]) - d(b[0]) || a[0] - b[0]);
}

function rules(p: Partial<OiTopParams>): string[] {
  const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
  const n = num(p.topN, 3);
  const lots = num(p.lots, 1);
  const sl = num(p.stopLoss, 0);
  const days = DAYS_LABEL[(p.days as TradingDays) ?? 'all'] ?? 'every trading day';
  return [
    `Trades on ${days} only; other days nothing is sold.`,
    `At ${p.entryTime || '09:20'} the live open interest of every CE and every PE of the expiry is ranked separately, highest first.`,
    `Sell ${lots} lot${lots > 1 ? 's' : ''} at each of the ${n} highest-OI CE strikes and the ${n} highest-OI PE strikes: ${2 * n} positions, ${2 * n * lots} lots in all.`,
    'If a ranked strike has no traded premium it cannot be sold: then nothing is sold today (the ranking is never changed to skip it).',
    sl > 0 ? `Daily stop loss ₹${r2(sl)} on the combined P&L of all positions (realised + open, before charges): when hit, everything is squared off and trading stops for the day (no re-entry).` : 'Daily stop loss: not set (0).',
    `Exit: square off everything at ${p.exitTime || '15:25'}. No overnight positions.`,
    'This run keeps its own positions (its own book in Positions), P&L, stop loss and trade journal.',
    'Live data only: OI is the exchange feed’s and premiums are traded prices. Until OI is live on both sides the algo waits.',
  ];
}

class Book {
  readonly fills: AlgoFill[] = [];
  constructor(private readonly s: OiTopState, private readonly snap: AlgoSnapshot, private readonly fill: FillFn) {}
  sell(type: OptionSide, strike: number, lots: number, reason: string): void {
    const price = this.fill({ side: 'SELL', type, strike, lots, reason });
    this.s.orders++;
    this.fills.push({ side: 'SELL', type, strike, lots, reason, price });
    this.s.legs.push({ type, strike, side: 'SELL', lots, entryPrice: price, entryTs: this.snap.ts });
  }
  closeAll(reason: string): string[] {
    const errors: string[] = [];
    for (const l of [...this.s.legs]) {
      try {
        const price = this.fill({ side: 'BUY', type: l.type, strike: l.strike, lots: l.lots, reason });
        this.s.orders++;
        this.fills.push({ side: 'BUY', type: l.type, strike: l.strike, lots: l.lots, reason, price });
        this.s.realized += (l.entryPrice - price) * l.lots * this.s.lotSize;
        this.s.legs.splice(this.s.legs.indexOf(l), 1);
      } catch (e) {
        errors.push(`${l.strike} ${l.type}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return errors;
  }
}

export const oiTop: AlgoDefinition<OiTopParams, OiTopState> = {
  id: 'oi-top-sell',
  name: 'Top open-interest option selling',
  description: 'On the chosen weekdays, sell the highest-OI CE strikes and the highest-OI PE strikes at the entry time; one daily stop loss on all positions; exit at the end time.',
  rules: rules({}),
  describeRules: (p) => rules(p),
  label: (p) => `Top ${p.topN} OI CE + PE · ${p.symbol}`,
  params: [
    { key: 'symbol', label: 'Underlying', type: 'symbol' },
    { key: 'expiry', label: 'Expiry', type: 'select', options: [{ value: 'current', label: 'Current (nearest)' }, { value: 'next', label: 'Next' }] },
    { key: 'lots', label: 'Lots per strike', type: 'number', min: 1, max: 50, step: 1 },
    { key: 'topN', label: 'Strikes per side (top OI)', type: 'number', min: 1, max: 10, step: 1 },
    { key: 'strikeMultiple', label: 'Strike multiple', type: 'number', min: 0, max: 10000, step: 50, help: 'Only strikes that are multiples of this are ranked. 0 = any listed strike.' },
    { key: 'days', label: 'Trading days', type: 'select', options: (Object.keys(DAYS_LABEL) as TradingDays[]).map((v) => ({ value: v, label: DAYS_LABEL[v][0].toUpperCase() + DAYS_LABEL[v].slice(1) })) },
    { key: 'entryTime', label: 'Entry time', type: 'time' },
    { key: 'exitTime', label: 'Exit time', type: 'time' },
    { key: 'stopLoss', label: 'Daily stop loss ₹ (all positions)', type: 'number', min: 0, max: 1000000, step: 100, help: 'Combined realised + open P&L of every position. 0 = none.' },
    { key: 'lateEntry', label: 'Deployed after entry time: enter immediately', type: 'boolean' },
  ],
  defaults(instrument) {
    return { symbol: instrument.symbol, expiry: 'current', lots: 1, topN: 3, strikeMultiple: 0, days: 'all', entryTime: '09:20', exitTime: '15:25', stopLoss: 3000, lateEntry: true };
  },
  validate(p) {
    if (!p.symbol) return 'Choose an underlying';
    if (!Number.isInteger(p.lots) || p.lots < 1 || p.lots > 50) return 'Lots must be a whole number from 1 to 50';
    if (!Number.isInteger(p.topN) || p.topN < 1 || p.topN > 10) return 'Strikes per side must be a whole number from 1 to 10';
    if (!(p.strikeMultiple >= 0)) return 'Strike multiple cannot be negative';
    if (!(p.days in DAYS)) return 'Unknown trading-day choice';
    if (!(p.stopLoss >= 0 && p.stopLoss <= 1000000)) return 'Daily stop loss must be between ₹0 (none) and ₹10,00,000';
    if (p.expiry !== 'current' && p.expiry !== 'next') return 'Expiry must be current or next';
    return validateTimes(p.entryTime, p.exitTime);
  },
  init: () => ({ phase: 'waiting', legs: [], ranked: { CE: [], PE: [] }, realized: 0, lotSize: 0, firstSeenMinute: null, stopReason: null, orders: 0 }),
  phase: (s) => s.phase,
  openLegs: (s) => [...s.legs],
  realized: (s) => s.realized,

  step(p, s, snap, fill) {
    if (s.phase === 'stopped' || s.phase === 'exited') return [];
    if (s.firstSeenMinute == null) s.firstSeenMinute = snap.minuteOfDay;
    const b = new Book(s, snap, fill);
    const ev = (kind: AlgoEvent['kind'], message: string): AlgoEvent => ({ ts: snap.ts, kind, message, fills: b.fills.splice(0), data: { spot: snap.spot == null ? null : r2(snap.spot), positions: s.legs.length } });
    const stop = (kind: AlgoEvent['kind'], why0: string | (() => string), why: string): AlgoEvent[] => {
      const errors = b.closeAll(why);
      // The message is built after the square-off, so it can quote the day's final P&L.
      const reason = typeof why0 === 'function' ? why0() : why0;
      s.phase = kind === 'EXIT' ? 'exited' : 'stopped';
      s.stopReason = reason;
      const out = [ev(kind, reason)];
      if (errors.length) out.push(ev('ERROR', `Square-off failed — ${errors.join('; ')}`));
      return out;
    };

    if (s.phase === 'waiting' && !DAYS[p.days].includes(weekdayOf(snap.date))) {
      s.phase = 'exited';
      s.stopReason = `${DAY_NAMES[weekdayOf(snap.date)]} is not a trading day of this strategy (${DAYS_LABEL[p.days]} only)`;
      return [ev('INFO', s.stopReason)];
    }
    if (snap.minuteOfDay >= hhmmToMinutes(p.exitTime)) {
      if (s.phase === 'waiting') {
        s.phase = 'exited';
        s.stopReason = `No entry before ${p.exitTime}`;
        return [ev('INFO', s.stopReason)];
      }
      return stop('EXIT', () => `${p.exitTime} exit — all positions squared off. Day P&L ${rupees(s.realized)} (before charges)`, `Time exit ${p.exitTime}`);
    }

    if (s.phase === 'waiting') {
      const entryMin = hhmmToMinutes(p.entryTime);
      if (snap.minuteOfDay < entryMin) return [];
      if (!p.lateEntry && (s.firstSeenMinute > entryMin + 1 || snap.minuteOfDay > entryMin + 1)) {
        s.phase = 'exited';
        s.stopReason = `No market data at the ${p.entryTime} entry — no trade today`;
        return [ev('INFO', s.stopReason)];
      }
      const ce = rankByOi(snap, 'CE', p.strikeMultiple);
      const pe = rankByOi(snap, 'PE', p.strikeMultiple);
      if (ce.length < p.topN || pe.length < p.topN) return []; // OI not live on both sides yet: wait
      s.lotSize = snap.lotSize;
      s.ranked = { CE: ce.slice(0, p.topN), PE: pe.slice(0, p.topN) };
      const picks = SIDES.flatMap((t) => s.ranked[t].map(([k]) => [t, k] as const));
      const unpriced = picks.filter(([t, k]) => snap.premium(t, k) == null);
      if (unpriced.length) {
        s.phase = 'stopped';
        s.stopReason = `No traded premium for ${unpriced.map(([t, k]) => `${k} ${t}`).join(', ')} among the top-OI strikes — nothing sold today`;
        return [ev('STOP', s.stopReason)];
      }
      try {
        for (const [t, k] of picks) b.sell(t, k, p.lots, `Top OI ${t}`);
      } catch (e) {
        return stop('ERROR', `Order failed: ${e instanceof Error ? e.message : String(e)}. Open positions squared off; no more trades today.`, 'Order failure');
      }
      s.phase = 'active';
      const fmt = (t: OptionSide) => s.ranked[t].map(([k, oi]) => `${k} (OI ${Math.round(oi).toLocaleString('en-IN')})`).join(', ');
      return [ev('ENTRY', `Sold the top ${p.topN} OI strikes — CE: ${fmt('CE')}; PE: ${fmt('PE')}. ${s.legs.length} positions, ${p.lots} lot${p.lots > 1 ? 's' : ''} each.`)];
    }

    if (p.stopLoss > 0) {
      let pnl = s.realized;
      for (const l of s.legs) {
        const ltp = snap.premium(l.type, l.strike);
        if (ltp == null) return []; // P&L unknown right now: judged on the next price
        pnl += (l.entryPrice - ltp) * l.lots * s.lotSize;
      }
      if (pnl <= -p.stopLoss + EPS) return stop('STOP', `Daily stop loss hit: combined P&L ${rupees(pnl)} of ${s.legs.length} positions reached −${rupees(p.stopLoss)}. Everything squared off; no more trades today.`, 'Daily stop loss');
    }
    return [];
  },

  squareOff(_p, s, snap, fill, reason) {
    const b = new Book(s, snap, fill);
    const errors = b.closeAll(reason);
    s.phase = 'stopped';
    s.stopReason = reason;
    return { ts: snap.ts, kind: 'MANUAL_STOP', message: `${reason} — all positions squared off${errors.length ? ` (failed: ${errors.join('; ')})` : ''}.`, fills: b.fills };
  },

  status(p, s) {
    const items: AlgoStatusItem[] = [{ label: 'State', value: { waiting: `Waiting for ${p.entryTime}`, active: 'Active', stopped: 'Stopped for the day', exited: 'Exited for the day' }[s.phase] }];
    items.push({ label: 'Trading days', value: DAYS_LABEL[p.days] });
    for (const t of SIDES) items.push({ label: `${t} positions`, value: s.legs.filter((l) => l.type === t).map((l) => `${l.strike} @ ${rupees(l.entryPrice)}`).join(', ') || '—' });
    items.push({ label: 'Daily stop loss', value: p.stopLoss > 0 ? `−${rupees(p.stopLoss)} (all positions)` : 'Not set' });
    if (s.stopReason) items.push({ label: 'Reason', value: s.stopReason });
    return items;
  },
};
