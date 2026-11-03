/**
 * Rolling short straddle (S5 ATM 20 %, S6 max pain 25 %).
 *
 *  1. At the entry time sell a CE and a PE of the SAME strike: the ATM strike (the multiple of
 *     `strikeMultiple` nearest the underlying) or the max-pain strike of the live chain's open interest.
 *     Their two fill prices add up to the reference combined premium.
 *  2. The combined live premium (CE LTP + PE LTP of the open strike) is watched. When it is `rollPct` %
 *     or more above the reference, both legs are bought back, the strike is chosen afresh (ATM / max
 *     pain now) and a new CE + PE are sold there; their combined fill is the new reference.
 *  3. Daily maximum loss, separately from the roll: realised + open P&L of the day (before charges) at
 *     −`stopLossPerLot` × lots squares everything off and stops trading for the day (0 = none).
 *  4. No strike can be chosen, or a chosen strike has no traded premium on one side: everything is
 *     squared off and the algo stops for the day. Whatever is open at the exit time is squared off.
 *
 * Live data only: premiums are traded prices and OI is the feed's (or recorded) value, never a stand-in.
 */
import { hhmmToMinutes, validateTimes, type AlgoDefinition, type AlgoEvent, type AlgoFill, type AlgoLeg, type AlgoPhase, type AlgoSnapshot, type AlgoStatusItem, type FillFn, type OptionSide } from './types';
import { isStrikeMultiple } from './premium-ladder';

export interface RollingStraddleParams {
  symbol: string;
  expiry: 'current' | 'next';
  lots: number;
  /** 'atm': the strike nearest the underlying; 'maxpain': the max-pain strike of the chain's OI. */
  strikeMode: 'atm' | 'maxpain';
  /** Roll when the combined premium is this many % above the reference (20 → ×1.2). */
  rollPct: number;
  /** Strikes must be multiples of this (100 for NIFTY; 0 = any listed strike). */
  strikeMultiple: number;
  entryTime: string;
  exitTime: string;
  /** Daily maximum loss in ₹ per lot (× lots); 0 = none. */
  stopLossPerLot: number;
  lateEntry: boolean;
  /** Daily profit target in ₹ per lot (× lots): squared off and stopped for the day when reached; 0 or absent = none. */
  profitTargetPerLot?: number;
  /** Rolls allowed in a day: when one more is due, everything is squared off for the day; 0 or absent = no limit. */
  maxRolls?: number;
}

export interface RollingStraddleState {
  phase: AlgoPhase;
  legs: { CE: AlgoLeg | null; PE: AlgoLeg | null };
  /** Combined entry premium of the open straddle (CE + PE fills); the roll is measured from it. */
  reference: number;
  strike: number | null;
  rolls: number;
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

/** The multiple of `multiple` nearest the spot among listed strikes (a tie goes to the lower strike); null without a spot. */
export function straddleAtmStrike(strikes: readonly number[], spot: number | null, multiple: number): number | null {
  if (spot == null || !Number.isFinite(spot)) return null;
  let best: number | null = null;
  for (const k of [...strikes].sort((a, b) => a - b)) {
    if (!isStrikeMultiple(k, multiple)) continue;
    if (best == null || Math.abs(k - spot) < Math.abs(best - spot) - EPS) best = k;
  }
  return best;
}

/**
 * Max-pain strike: among the listed strikes (multiples of `multiple`), the expiry price at which option writers
 * pay the least to holders, from the OI of every strike that has one. Null (with why) when OI is missing.
 */
export function maxPainStrike(snap: Pick<AlgoSnapshot, 'strikes' | 'oi'>, multiple: number): { strike: number; strikesWithOi: number } | { strike: null; why: string } {
  if (!snap.oi) return { strike: null, why: 'No open interest in this data source' };
  const rows: { strike: number; ce: number; pe: number }[] = [];
  for (const k of snap.strikes) {
    const ce = snap.oi('CE', k);
    const pe = snap.oi('PE', k);
    if (ce == null && pe == null) continue;
    rows.push({ strike: k, ce: ce ?? 0, pe: pe ?? 0 });
  }
  if (!rows.some((r) => r.ce > 0) || !rows.some((r) => r.pe > 0)) return { strike: null, why: 'No live open interest on both calls and puts yet' };
  let best: { strike: number; pain: number } | null = null;
  for (const x of snap.strikes) {
    if (!isStrikeMultiple(x, multiple)) continue;
    let pain = 0;
    for (const r of rows) {
      if (x > r.strike) pain += r.ce * (x - r.strike);
      if (x < r.strike) pain += r.pe * (r.strike - x);
    }
    if (!best || pain < best.pain - EPS) best = { strike: x, pain };
  }
  return best ? { strike: best.strike, strikesWithOi: rows.length } : { strike: null, why: `No listed strike that is a multiple of ${multiple}` };
}

/** Daily P&L (realised + open legs at current premiums); null while an open leg has no premium. */
function dayPnl(s: RollingStraddleState, snap: Pick<AlgoSnapshot, 'premium'>): number | null {
  let pnl = s.realized;
  for (const t of SIDES) {
    const l = s.legs[t];
    if (!l) continue;
    const ltp = snap.premium(t, l.strike);
    if (ltp == null) return null;
    pnl += (l.entryPrice - ltp) * l.lots * s.lotSize;
  }
  return pnl;
}

function rules(p: Partial<RollingStraddleParams>): string[] {
  const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
  const symbol = p.symbol || 'NIFTY';
  const mult = num(p.strikeMultiple, symbol === 'NIFTY' ? 100 : 0);
  const roll = num(p.rollPct, 20);
  const sl = num(p.stopLossPerLot, 0);
  const maxpain = p.strikeMode === 'maxpain';
  const where = maxpain ? 'the max-pain strike (from the open interest of every strike of the live option chain)' : `the ATM strike (the strike nearest the ${symbol} price)`;
  const strikes = mult > 0 ? `Only strikes that are multiples of ${mult}${mult === 100 && symbol === 'NIFTY' ? ' — never a 50-point strike' : ''}.` : 'Any listed strike.';
  return [
    `Entry at ${p.entryTime || '09:20'}: sell one CE and one PE of the same strike — ${where}. ${strikes} Their two sell prices add up to the reference combined premium.`,
    `Roll: CE LTP + PE LTP of the open strike is watched. When it is ${roll}% or more above the reference, both legs are bought back, ${maxpain ? 'the max-pain strike is recalculated from the current OI' : `the ATM strike is found again from the current ${symbol} price`}, a fresh CE + PE are sold there, and their combined sell price becomes the new reference. This repeats with no limit.`,
    sl > 0
      ? `Daily maximum loss ₹${r2(sl)} per lot (× lots), watched separately from the roll: when realised + open P&L of the day (before charges) reaches −₹${r2(sl)} per lot, everything is squared off and trading stops for the day (no re-entry, no roll).`
      : 'Daily maximum loss: not set (0).',
    ...(num(p.profitTargetPerLot, 0) > 0 ? [`Daily profit target ₹${r2(num(p.profitTargetPerLot, 0))} per lot (× lots): when the day's P&L reaches it, everything is squared off and trading stops for the day.`] : []),
    ...(num(p.maxRolls, 0) > 0 ? [`At most ${num(p.maxRolls, 0)} roll${num(p.maxRolls, 0) === 1 ? '' : 's'} a day: when one more is due, everything is squared off and trading stops for the day.`] : []),
    'If no strike can be chosen, or the chosen strike has no traded premium on one side, everything is squared off and trading stops for the day.',
    `Exit: square off everything at ${p.exitTime || '15:25'}. No overnight positions.`,
    'This run keeps its own positions (its own book in Positions), P&L, stop loss, roll count and trade journal.',
    'Live data only: premiums are traded prices and OI is the exchange feed’s. Without a live underlying price (or OI for max pain) the algo waits and never sells blind.',
  ];
}

class Book {
  readonly fills: AlgoFill[] = [];
  constructor(private readonly p: RollingStraddleParams, private readonly s: RollingStraddleState, private readonly snap: AlgoSnapshot, private readonly fill: FillFn) {}
  sell(type: OptionSide, strike: number, reason: string): number {
    const price = this.fill({ side: 'SELL', type, strike, lots: this.p.lots, reason });
    this.s.orders++;
    this.fills.push({ side: 'SELL', type, strike, lots: this.p.lots, reason, price });
    this.s.legs[type] = { type, strike, side: 'SELL', lots: this.p.lots, entryPrice: price, entryTs: this.snap.ts };
    return price;
  }
  close(type: OptionSide, reason: string): number | null {
    const l = this.s.legs[type];
    if (!l) return null;
    const price = this.fill({ side: 'BUY', type, strike: l.strike, lots: l.lots, reason });
    this.s.orders++;
    this.fills.push({ side: 'BUY', type, strike: l.strike, lots: l.lots, reason, price });
    this.s.realized += (l.entryPrice - price) * l.lots * this.s.lotSize;
    this.s.legs[type] = null;
    return price;
  }
  closeAll(reason: string): string[] {
    const errors: string[] = [];
    for (const t of SIDES) {
      try {
        this.close(t, reason);
      } catch (e) {
        errors.push(`${t}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return errors;
  }
}

export const rollingStraddle: AlgoDefinition<RollingStraddleParams, RollingStraddleState> = {
  id: 'rolling-straddle',
  name: 'Rolling short straddle',
  description: 'Sell a CE and a PE of the same strike (ATM or max pain); when their combined premium rises by the roll %, square off and sell a fresh straddle at the new ATM / max-pain strike.',
  rules: rules({}),
  describeRules: (p) => rules(p),
  label: (p) => `${p.strikeMode === 'maxpain' ? 'Max-pain' : 'ATM'} straddle · roll +${r2(p.rollPct)}%${p.symbol !== 'NIFTY' ? ` · ${p.symbol}` : ''}`,
  params: [
    { key: 'symbol', label: 'Underlying', type: 'symbol' },
    { key: 'expiry', label: 'Expiry', type: 'select', options: [{ value: 'current', label: 'Current (nearest)' }, { value: 'next', label: 'Next' }] },
    { key: 'lots', label: 'Lots per leg', type: 'number', min: 1, max: 50, step: 1 },
    { key: 'strikeMode', label: 'Strike', type: 'select', options: [{ value: 'atm', label: 'ATM (nearest the spot)' }, { value: 'maxpain', label: 'Max pain (live OI)' }] },
    { key: 'rollPct', label: 'Roll when combined premium rises %', type: 'number', min: 1, max: 500, step: 1 },
    { key: 'strikeMultiple', label: 'Strike multiple', type: 'number', min: 0, max: 10000, step: 50, help: 'Only strikes that are multiples of this (100 for NIFTY: never a 50-point strike). 0 = any strike.' },
    { key: 'entryTime', label: 'Entry time', type: 'time' },
    { key: 'exitTime', label: 'Exit time', type: 'time' },
    { key: 'stopLossPerLot', label: 'Daily max loss ₹ per lot', type: 'number', min: 0, max: 100000, step: 100, help: 'Realised + open P&L of the day. 0 = none.' },
    { key: 'profitTargetPerLot', label: 'Daily profit target ₹ per lot', type: 'number', min: 0, max: 100000, step: 100, help: 'Realised + open P&L of the day: squared off and stopped when reached. 0 = none.' },
    { key: 'maxRolls', label: 'Max rolls per day', type: 'number', min: 0, max: 100, step: 1, help: 'When one more roll is due after this many, everything is squared off for the day instead. 0 = no limit.' },
    { key: 'lateEntry', label: 'Deployed after entry time: enter immediately', type: 'boolean' },
  ],
  defaults(instrument) {
    return { symbol: instrument.symbol, expiry: 'current', lots: 1, strikeMode: 'atm', rollPct: 20, strikeMultiple: instrument.symbol === 'NIFTY' ? 100 : instrument.strikeStep, entryTime: '09:20', exitTime: '15:25', stopLossPerLot: 3000, lateEntry: true, profitTargetPerLot: 0, maxRolls: 0 };
  },
  validate(p) {
    if (!p.symbol) return 'Choose an underlying';
    if (!Number.isInteger(p.lots) || p.lots < 1 || p.lots > 50) return 'Lots must be a whole number from 1 to 50';
    if (p.strikeMode !== 'atm' && p.strikeMode !== 'maxpain') return 'Strike must be ATM or max pain';
    if (!(p.rollPct >= 1 && p.rollPct <= 500)) return 'Roll % must be between 1 and 500';
    if (!(p.strikeMultiple >= 0)) return 'Strike multiple cannot be negative';
    if (!(p.stopLossPerLot >= 0 && p.stopLossPerLot <= 100000)) return 'Daily max loss must be between ₹0 (none) and ₹1,00,000 per lot';
    if (p.expiry !== 'current' && p.expiry !== 'next') return 'Expiry must be current or next';
    if (p.profitTargetPerLot !== undefined && !(p.profitTargetPerLot >= 0 && p.profitTargetPerLot <= 100000)) return 'Daily profit target must be between ₹0 (none) and ₹1,00,000 per lot';
    if (p.maxRolls !== undefined && !(Number.isInteger(p.maxRolls) && p.maxRolls >= 0 && p.maxRolls <= 100)) return 'Max rolls must be a whole number from 0 (no limit) to 100';
    return validateTimes(p.entryTime, p.exitTime);
  },
  init: () => ({ phase: 'waiting', legs: { CE: null, PE: null }, reference: 0, strike: null, rolls: 0, realized: 0, lotSize: 0, firstSeenMinute: null, stopReason: null, orders: 0 }),
  phase: (s) => s.phase,
  openLegs: (s) => SIDES.map((t) => s.legs[t]).filter((l): l is AlgoLeg => l != null),
  realized: (s) => s.realized,
  level: (s) => (s.reference > 0 ? s.reference : null),

  step(p, s, snap, fill) {
    if (s.phase === 'stopped' || s.phase === 'exited') return [];
    if (s.firstSeenMinute == null) s.firstSeenMinute = snap.minuteOfDay;
    const b = new Book(p, s, snap, fill);
    const data = () => ({ spot: snap.spot == null ? null : r2(snap.spot), strike: s.strike, reference: r2(s.reference), combined: combined(s, snap) });
    const ev = (kind: AlgoEvent['kind'], message: string): AlgoEvent => ({ ts: snap.ts, kind, message, fills: b.fills.splice(0), data: data() });
    const stop = (kind: AlgoEvent['kind'], why0: string | (() => string), closeWhy: string): AlgoEvent[] => {
      const errors = b.closeAll(closeWhy);
      // The message is built after the square-off, so it can quote the day's final P&L.
      const reason = typeof why0 === 'function' ? why0() : why0;
      s.phase = kind === 'EXIT' ? 'exited' : 'stopped';
      s.stopReason = reason;
      const out = [ev(kind, reason)];
      if (errors.length) out.push(ev('ERROR', `Square-off failed — ${errors.join('; ')}`));
      return out;
    };
    const entryMin = hhmmToMinutes(p.entryTime);
    const exitMin = hhmmToMinutes(p.exitTime);

    if (snap.minuteOfDay >= exitMin) {
      if (s.phase === 'waiting') {
        s.phase = 'exited';
        s.stopReason = `No entry before ${p.exitTime}`;
        return [ev('INFO', s.stopReason)];
      }
      return stop('EXIT', () => `${p.exitTime} exit — all positions squared off. Day P&L ${rupees(s.realized)} (before charges)`, `Time exit ${p.exitTime}`);
    }

    if (s.phase === 'waiting') {
      if (snap.minuteOfDay < entryMin) return [];
      const missed = !p.lateEntry && (s.firstSeenMinute > entryMin + 1 || snap.minuteOfDay > entryMin + 1);
      if (missed) {
        s.phase = 'exited';
        s.stopReason = `No market data at the ${p.entryTime} entry — no trade today`;
        return [ev('INFO', s.stopReason)];
      }
      const pick = chooseStrike(p, snap);
      if ('wait' in pick) return []; // no live price / OI yet: wait, never sell blind
      s.lotSize = snap.lotSize;
      if ('fail' in pick) {
        s.phase = 'stopped';
        s.stopReason = `${pick.fail}. No trades today.`;
        return [ev('STOP', s.stopReason)];
      }
      const err = openStraddle(p, s, snap, b, pick.strike, 'Entry');
      if (err) return [...stop('STOP', `${err}. No trades today.`, 'Entry failed')];
      s.phase = 'active';
      return [ev('ENTRY', `Sold ${pick.strike} CE @ ${rupees(s.legs.CE!.entryPrice)} and ${pick.strike} PE @ ${rupees(s.legs.PE!.entryPrice)} (${pick.why}). Reference combined premium ${rupees(s.reference)}; roll at ${rupees(s.reference * (1 + p.rollPct / 100))}.`)];
    }

    // Daily maximum loss (independent of the roll), checked first.
    if (p.stopLossPerLot > 0) {
      const pnl = dayPnl(s, snap);
      const limit = p.stopLossPerLot * p.lots;
      if (pnl != null && pnl <= -limit + EPS) {
        return stop('STOP', `Daily maximum loss hit: day P&L ${rupees(pnl)} reached −${rupees(limit)} (${rupees(p.stopLossPerLot)} per lot × ${p.lots}). Everything squared off; no more trades today.`, 'Daily max loss');
      }
    }

    // Daily profit target.
    const target = (p.profitTargetPerLot ?? 0) * p.lots;
    if (target > 0) {
      const pnl = dayPnl(s, snap);
      if (pnl != null && pnl + EPS >= target) {
        return stop('STOP', `Daily profit target reached: day P&L ${rupees(pnl)} reached +${rupees(target)} (${rupees(p.profitTargetPerLot ?? 0)} per lot × ${p.lots}). Everything squared off; no more trades today.`, 'Daily profit target');
      }
    }

    const now = combined(s, snap);
    if (now == null || now + EPS < s.reference * (1 + p.rollPct / 100)) return [];
    if ((p.maxRolls ?? 0) > 0 && s.rolls >= (p.maxRolls ?? 0)) {
      return stop('STOP', `Combined premium ${rupees(now)} rose ${p.rollPct}% above the ${rupees(s.reference)} reference, but the ${p.maxRolls} roll${p.maxRolls === 1 ? '' : 's'} allowed today are used up. Everything squared off; no more trades today.`, 'Roll limit');
    }
    const pick = chooseStrike(p, snap);
    if ('wait' in pick) return [];
    const from = s.strike;
    const head = `Combined premium ${rupees(now)} of ${from} rose ${(((now - s.reference) / s.reference) * 100).toFixed(1)}% above the ${rupees(s.reference)} reference`;
    if ('fail' in pick) return stop('STOP', `${head}. ${pick.fail}. Everything squared off; no more trades today.`, 'No strike for the roll');
    try {
      b.close('CE', `Roll +${p.rollPct}%`);
      b.close('PE', `Roll +${p.rollPct}%`);
    } catch (e) {
      return stop('ERROR', `Order failed: ${e instanceof Error ? e.message : String(e)}. Open positions squared off; no more trades today.`, 'Order failure');
    }
    const err = openStraddle(p, s, snap, b, pick.strike, `Roll +${p.rollPct}%`);
    if (err) return stop('STOP', `${head}. Both legs bought back. ${err}. No more trades today.`, 'Roll failed');
    s.rolls++;
    return [ev('ADJUSTMENT', `${head}: both legs bought back; sold ${pick.strike} CE @ ${rupees(s.legs.CE!.entryPrice)} + PE @ ${rupees(s.legs.PE!.entryPrice)} (${pick.why}). New reference ${rupees(s.reference)}; next roll at ${rupees(s.reference * (1 + p.rollPct / 100))}.`)];
  },

  squareOff(p, s, snap, fill, reason) {
    const b = new Book(p, s, snap, fill);
    const errors = b.closeAll(reason);
    s.phase = 'stopped';
    s.stopReason = reason;
    return { ts: snap.ts, kind: 'MANUAL_STOP', message: `${reason} — all positions squared off${errors.length ? ` (failed: ${errors.join('; ')})` : ''}.`, fills: b.fills, data: { strike: s.strike } };
  },

  status(p, s) {
    const items: AlgoStatusItem[] = [{ label: 'State', value: { waiting: `Waiting for ${p.entryTime}`, active: 'Active', stopped: 'Stopped for the day', exited: 'Exited for the day' }[s.phase] }];
    items.push({ label: 'Straddle', value: s.legs.CE && s.legs.PE ? `${s.strike} CE @ ${rupees(s.legs.CE.entryPrice)} + PE @ ${rupees(s.legs.PE.entryPrice)}` : '—' });
    if (s.reference > 0) items.push({ label: 'Reference combined', value: `${rupees(s.reference)} → roll at ${rupees(s.reference * (1 + p.rollPct / 100))}` });
    items.push({ label: 'Rolls', value: `${s.rolls}${(p.maxRolls ?? 0) > 0 ? ` of ${p.maxRolls} allowed` : ''}` });
    if ((p.profitTargetPerLot ?? 0) > 0) items.push({ label: 'Daily profit target', value: `+${rupees((p.profitTargetPerLot ?? 0) * p.lots)} (${rupees(p.profitTargetPerLot ?? 0)} per lot × ${p.lots})` });
    items.push({ label: 'Daily max loss', value: p.stopLossPerLot > 0 ? `−${rupees(p.stopLossPerLot * p.lots)} (${rupees(p.stopLossPerLot)} per lot × ${p.lots})` : 'Not set' });
    if (s.stopReason) items.push({ label: 'Reason', value: s.stopReason });
    return items;
  },
};

function combined(s: RollingStraddleState, snap: Pick<AlgoSnapshot, 'premium'>): number | null {
  const ce = s.legs.CE;
  const pe = s.legs.PE;
  if (!ce || !pe) return null;
  const a = snap.premium('CE', ce.strike);
  const b = snap.premium('PE', pe.strike);
  return a == null || b == null ? null : a + b;
}

type StrikeChoice = { strike: number; why: string } | { wait: string } | { fail: string };

function chooseStrike(p: RollingStraddleParams, snap: AlgoSnapshot): StrikeChoice {
  if (snap.spot == null) return { wait: `No ${snap.symbol} price` };
  if (p.strikeMode === 'maxpain') {
    const m = maxPainStrike(snap, p.strikeMultiple);
    if (m.strike == null) return { wait: m.why };
    return { strike: m.strike, why: `max pain from the OI of ${m.strikesWithOi} strikes, spot ${snap.spot.toFixed(2)}` };
  }
  const k = straddleAtmStrike(snap.strikes, snap.spot, p.strikeMultiple);
  if (k == null) return { fail: `No listed ${snap.symbol} strike${p.strikeMultiple > 0 ? ` that is a multiple of ${p.strikeMultiple}` : ''}` };
  return { strike: k, why: `ATM to spot ${snap.spot.toFixed(2)}` };
}

/** Sell CE + PE of `strike`; returns why it could not (a side without a traded premium), else sets the reference. */
function openStraddle(p: RollingStraddleParams, s: RollingStraddleState, snap: AlgoSnapshot, b: Book, strike: number, reason: string): string | null {
  const missing = SIDES.filter((t) => snap.premium(t, strike) == null);
  if (missing.length) return `${strike} ${missing.join(' and ')} has no traded premium, so the straddle cannot be sold`;
  try {
    const ce = b.sell('CE', strike, reason);
    const pe = b.sell('PE', strike, reason);
    s.reference = ce + pe;
    s.strike = strike;
    return null;
  } catch (e) {
    return `Order failed: ${e instanceof Error ? e.message : String(e)}`;
  }
}
