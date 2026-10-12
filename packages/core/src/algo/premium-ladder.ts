/**
 * "Premium ladder" short strangle (Strategy 2).
 *
 *  1. At the entry time sell one OTM CE and one OTM PE whose premiums are closest to the
 *     starting premium (₹20 in Strategy 2, ₹50 in Strategy 3), using only strikes that are multiples of `strikeMultiple`
 *     (100 for NIFTY).
 *  2. The ladder starts at the starting premium. When a leg's premium reaches the next rung
 *     (+50 %: 20 → 30 → 45 → 67.5 …) the opposite leg is bought back and re-sold at the OTM
 *     strike whose premium is nearest the new rung. There is no limit on the number of rungs.
 *     A jump through several rungs at once moves straight to the highest rung reached.
 *  3. Every newly sold option must be OTM at that moment. If no eligible OTM strike exists for
 *     a required entry or adjustment, everything is squared off and the algo stops for the day.
 *  4. Whatever is open at the exit time (15:25) is squared off.
 */
import {
  hhmmToMinutes,
  type AlgoDefinition,
  type AlgoEvent,
  type AlgoFill,
  type AlgoLeg,
  type AlgoOrder,
  type AlgoPhase,
  type AlgoPreset,
  type AlgoSnapshot,
  type AlgoStatusItem,
  type FillFn,
  type OptionSide,
} from './types';

export interface PremiumLadderParams {
  symbol: string;
  /** Which weekly/monthly expiry to trade: the nearest listed one or the one after it. */
  expiry: 'current' | 'next';
  lots: number;
  /** Starting premium in ₹ (first rung of the ladder). */
  startPremium: number;
  /** Rung spacing in percent (50 → each rung is 1.5× the previous one). */
  stepPct: number;
  /** Strikes must be a multiple of this (100 for NIFTY). 0 → any listed strike. */
  strikeMultiple: number;
  entryTime: string;
  exitTime: string;
  /**
   * A strike only counts as "near" the target premium if its premium is within this many
   * percent of it; otherwise no eligible strike exists and the algo stops for the day.
   */
  maxGapPct: number;
  /** Which leg can trigger the next rung: either leg, or only the leg that triggered last. */
  triggerOn: 'either' | 'same';
  /** A live run started after the entry time enters straight away (else it waits a day). */
  lateEntry: boolean;
}

export interface PremiumLadderState {
  phase: AlgoPhase;
  /** Current rung (₹). */
  level: number;
  /** Number of rungs climbed. */
  rung: number;
  legs: { CE: AlgoLeg | null; PE: AlgoLeg | null };
  lastTrigger: OptionSide | null;
  adjustments: number;
  /** Realised P&L of closed legs (₹, before charges). */
  realized: number;
  lotSize: number;
  firstSeenMinute: number | null;
  entryTs: number | null;
  stopReason: string | null;
  orders: number;
}

const EPS = 1e-9;
const SIDES: OptionSide[] = ['CE', 'PE'];
const other = (s: OptionSide): OptionSide => (s === 'CE' ? 'PE' : 'CE');
const r2 = (x: number) => Math.round(x * 100) / 100;
const rupees = (x: number) => `₹${r2(x).toFixed(2).replace(/\.00$/, '')}`;

export function isStrikeMultiple(strike: number, multiple: number): boolean {
  if (!(multiple > 0)) return true;
  const q = strike / multiple;
  return Math.abs(q - Math.round(q)) < 1e-6;
}

/** Strictly out of the money: CE above spot, PE below spot. */
export function isOtm(type: OptionSide, strike: number, spot: number): boolean {
  return type === 'CE' ? strike > spot : strike < spot;
}

export interface StrikePick {
  strike: number;
  premium: number;
  /** |premium − target| / target × 100 */
  gapPct: number;
}

export type StrikeSelection = { ok: true; pick: StrikePick } | { ok: false; reason: string; nearest: StrikePick | null };

/**
 * The eligible strike (OTM, multiple of `multiple`) whose premium is closest to `target`.
 * Ties go to the strike further out of the money.
 */
export function selectStrike(
  snap: Pick<AlgoSnapshot, 'spot' | 'strikes' | 'premium'>,
  type: OptionSide,
  target: number,
  opts: { multiple: number; maxGapPct: number },
): StrikeSelection {
  let best: StrikePick | null = null;
  let eligible = 0;
  for (const k of snap.strikes) {
    if (!isStrikeMultiple(k, opts.multiple) || !isOtm(type, k, snap.spot)) continue;
    const prem = snap.premium(type, k);
    if (prem == null || !(prem > 0.05)) continue;
    eligible++;
    const gapPct = (Math.abs(prem - target) / target) * 100;
    const furtherOtm = best != null && (type === 'CE' ? k > best.strike : k < best.strike);
    if (!best || gapPct < best.gapPct - EPS || (Math.abs(gapPct - best.gapPct) <= EPS && furtherOtm)) best = { strike: k, premium: prem, gapPct };
  }
  const mult = opts.multiple > 0 ? ` (multiple of ${opts.multiple})` : '';
  if (!best) return { ok: false, reason: eligible === 0 ? `No OTM ${type} strike${mult} is listed` : `No tradable OTM ${type} strike${mult}`, nearest: null };
  if (best.gapPct > opts.maxGapPct + EPS) {
    return {
      ok: false,
      reason: `No OTM ${type} strike${mult} near ${rupees(target)}: nearest is ${best.strike} at ${rupees(best.premium)} (${best.gapPct.toFixed(0)}% away, limit ${opts.maxGapPct}%)`,
      nearest: best,
    };
  }
  return { ok: true, pick: best };
}

/** Rung reached by a premium: the highest level × (1+step)^n that is ≤ premium. */
export function ladderLevel(level: number, premium: number, stepPct: number): { level: number; rungs: number } {
  const f = 1 + stepPct / 100;
  let l = level;
  let n = 0;
  while (premium + EPS >= l * f && n < 1000) {
    l *= f;
    n++;
  }
  return { level: l, rungs: n };
}

function initState(): PremiumLadderState {
  return { phase: 'waiting', level: 0, rung: 0, legs: { CE: null, PE: null }, lastTrigger: null, adjustments: 0, realized: 0, lotSize: 0, firstSeenMinute: null, entryTs: null, stopReason: null, orders: 0 };
}

function mmToHhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

class Ctx {
  readonly fills: AlgoFill[] = [];
  constructor(private readonly p: PremiumLadderParams, private readonly s: PremiumLadderState, private readonly snap: AlgoSnapshot, private readonly fill: FillFn) {}

  private exec(order: AlgoOrder): number {
    const price = this.fill(order);
    this.s.orders++;
    this.fills.push({ ...order, price });
    return price;
  }

  sell(type: OptionSide, strike: number, reason: string): AlgoLeg {
    const price = this.exec({ side: 'SELL', type, strike, lots: this.p.lots, reason });
    const leg: AlgoLeg = { type, strike, side: 'SELL', lots: this.p.lots, entryPrice: price, entryTs: this.snap.ts };
    this.s.legs[type] = leg;
    return leg;
  }

  close(type: OptionSide, reason: string): number | null {
    const leg = this.s.legs[type];
    if (!leg) return null;
    const price = this.exec({ side: leg.side === 'SELL' ? 'BUY' : 'SELL', type, strike: leg.strike, lots: leg.lots, reason });
    const sign = leg.side === 'SELL' ? 1 : -1;
    this.s.realized += sign * (leg.entryPrice - price) * leg.lots * this.s.lotSize;
    this.s.legs[type] = null;
    return price;
  }

  /** Close every open leg; individual failures are reported but do not stop the others. */
  closeAll(reason: string): string[] {
    const errors: string[] = [];
    for (const t of SIDES) {
      try {
        this.close(t, reason);
      } catch (err) {
        errors.push(`${t}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return errors;
  }
}

function legText(l: AlgoLeg | null): string {
  return l ? `${l.strike} ${l.type} @ ${rupees(l.entryPrice)}` : '—';
}

function eventData(s: PremiumLadderState, snap: AlgoSnapshot): Record<string, number | string | null> {
  return {
    spot: r2(snap.spot),
    level: r2(s.level),
    ce: s.legs.CE ? s.legs.CE.strike : null,
    ceLtp: s.legs.CE ? snap.premium('CE', s.legs.CE.strike) : null,
    pe: s.legs.PE ? s.legs.PE.strike : null,
    peLtp: s.legs.PE ? snap.premium('PE', s.legs.PE.strike) : null,
  };
}

/** The ladder's first rungs for a starting premium, e.g. 20 → "₹20 → ₹30 → ₹45 → ₹67.5". */
export function ladderLevels(startPremium: number, stepPct: number, count = 4): number[] {
  const out: number[] = [];
  let l = startPremium;
  for (let i = 0; i < count; i++) {
    out.push(r2(l));
    l *= 1 + stepPct / 100;
  }
  return out;
}

/** Plain-language rules for a parameter set (shown in the Algo panel; defaults = Strategy 2). */
export function ladderRules(p: Partial<PremiumLadderParams>): string[] {
  const num = (v: unknown, d: number) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);
  const start = num(p.startPremium, 20);
  const step = num(p.stepPct, 50);
  const mult = num(p.strikeMultiple, 100);
  const entry = p.entryTime || '09:20';
  const exit = p.exitTime || '15:25';
  const symbol = p.symbol || 'NIFTY';
  const levels = ladderLevels(start, step).map((x) => `₹${x}`).join(' → ');
  return [
    `Entry at ${entry}: sell one CE and one PE, both OTM, with premiums closest to the starting premium (₹${r2(start)}).${mult > 0 ? ` ${symbol} strikes must be multiples of ${mult}.` : ''}`,
    `Adjustment ladder: levels at +${step}% steps — ${levels} → … with no limit.`,
    'When a leg’s premium reaches the next level, buy back the opposite leg and sell the OTM strike whose premium is nearest that level. A jump through several levels goes straight to the highest one reached.',
    'Strict OTM: every newly sold option must be out of the money at the time it is sold.',
    'If no eligible OTM strike is available for a required entry or adjustment, square off all positions and stop trading for the day.',
    `Exit: square off everything at ${exit} regardless of profit or loss.`,
  ];
}

export const premiumLadder: AlgoDefinition<PremiumLadderParams, PremiumLadderState> = {
  id: 'premium-ladder',
  name: 'Premium ladder short strangle',
  description: 'Sell an OTM call and put at a target premium; each time either leg gains another 50%, roll the other leg to the new premium level.',
  rules: ladderRules({}),
  describeRules: (p) => ladderRules(p),
  params: [
    { key: 'symbol', label: 'Underlying', type: 'symbol' },
    { key: 'expiry', label: 'Expiry', type: 'select', options: [{ value: 'current', label: 'Current (nearest)' }, { value: 'next', label: 'Next' }] },
    { key: 'lots', label: 'Lots per leg', type: 'number', min: 1, max: 50, step: 1 },
    { key: 'startPremium', label: 'Starting premium ₹', type: 'number', min: 1, max: 1000, step: 0.5 },
    { key: 'stepPct', label: 'Adjustment step %', type: 'number', min: 5, max: 500, step: 5, help: 'Premium increase from the previous trigger level that fires the next adjustment.' },
    { key: 'strikeMultiple', label: 'Strike multiple', type: 'number', min: 0, max: 10000, step: 50, help: 'Only strikes that are multiples of this are traded (100 for NIFTY). 0 = any strike.' },
    { key: 'entryTime', label: 'Entry time', type: 'time' },
    { key: 'exitTime', label: 'Exit time', type: 'time' },
    { key: 'maxGapPct', label: 'Max premium gap %', type: 'number', min: 1, max: 100, step: 1, help: 'How far the nearest OTM premium may be from the target before the strike counts as unavailable (then everything is squared off).' },
    { key: 'triggerOn', label: 'Next trigger from', type: 'select', options: [{ value: 'either', label: 'Either leg' }, { value: 'same', label: 'Same leg that triggered' }] },
    { key: 'lateEntry', label: 'Deployed after entry time: enter immediately', type: 'boolean' },
  ],
  defaults(instrument) {
    return {
      symbol: instrument.symbol,
      expiry: 'current',
      lots: 1,
      startPremium: 20,
      stepPct: 50,
      strikeMultiple: instrument.symbol === 'NIFTY' ? 100 : instrument.strikeStep,
      entryTime: '09:20',
      exitTime: '15:25',
      maxGapPct: 50,
      triggerOn: 'either',
      lateEntry: true,
    };
  },
  validate(p) {
    if (!p.symbol) return 'Choose an underlying';
    if (!Number.isInteger(p.lots) || p.lots < 1 || p.lots > 50) return 'Lots must be a whole number from 1 to 50';
    if (!(p.startPremium >= 1 && p.startPremium <= 1000)) return 'Starting premium must be between ₹1 and ₹1000';
    if (!(p.stepPct >= 5 && p.stepPct <= 500)) return 'Adjustment step must be between 5% and 500%';
    if (!(p.strikeMultiple >= 0)) return 'Strike multiple cannot be negative';
    if (!(p.maxGapPct >= 1 && p.maxGapPct <= 100)) return 'Max premium gap must be between 1% and 100%';
    if (p.expiry !== 'current' && p.expiry !== 'next') return 'Expiry must be current or next';
    if (p.triggerOn !== 'either' && p.triggerOn !== 'same') return 'Invalid trigger mode';
    const re = /^([01]\d|2[0-3]):[0-5]\d$/;
    if (!re.test(p.entryTime) || !re.test(p.exitTime)) return 'Times must be HH:MM';
    const en = hhmmToMinutes(p.entryTime);
    const ex = hhmmToMinutes(p.exitTime);
    if (en < 555 || ex > 930) return 'Times must be within market hours (09:15–15:30)';
    if (ex <= en) return 'Exit time must be after entry time';
    return null;
  },
  init: initState,
  phase: (s) => s.phase,
  openLegs: (s) => SIDES.map((t) => s.legs[t]).filter((l): l is AlgoLeg => l != null),
  realized: (s) => s.realized,
  level: (s) => (s.level > 0 ? s.level : null),

  step(p, s, snap, fill) {
    if (s.phase === 'stopped' || s.phase === 'exited') return [];
    if (s.firstSeenMinute == null) s.firstSeenMinute = snap.minuteOfDay;
    const entryMin = hhmmToMinutes(p.entryTime);
    const exitMin = hhmmToMinutes(p.exitTime);
    const c = new Ctx(p, s, snap, fill);
    const ev = (kind: AlgoEvent['kind'], message: string): AlgoEvent => ({ ts: snap.ts, kind, message, fills: c.fills.splice(0), data: eventData(s, snap) });

    // 8. Time exit.
    if (snap.minuteOfDay >= exitMin) {
      if (s.phase === 'waiting') {
        s.phase = 'exited';
        s.stopReason = `No entry before ${p.exitTime}`;
        return [ev('INFO', s.stopReason)];
      }
      const errors = c.closeAll(`Time exit ${p.exitTime}`);
      s.phase = 'exited';
      s.stopReason = `Time exit at ${p.exitTime}`;
      const out = [ev('EXIT', `${p.exitTime} exit — all positions squared off. Day P&L ${rupees(s.realized)}`)];
      if (errors.length) out.push(ev('ERROR', `Square-off failed — ${errors.join('; ')}`));
      return out;
    }

    // 1–2. Entry.
    if (s.phase === 'waiting') {
      if (snap.minuteOfDay < entryMin) return [];
      if (!p.lateEntry && s.firstSeenMinute > entryMin + 1) {
        s.phase = 'exited';
        s.stopReason = `Deployed at ${mmToHhmm(s.firstSeenMinute)}, after the ${p.entryTime} entry — no trade today`;
        return [ev('INFO', s.stopReason)];
      }
      s.lotSize = snap.lotSize;
      const opts = { multiple: p.strikeMultiple, maxGapPct: p.maxGapPct };
      const ce = selectStrike(snap, 'CE', p.startPremium, opts);
      const pe = selectStrike(snap, 'PE', p.startPremium, opts);
      if (!ce.ok || !pe.ok) {
        s.phase = 'stopped';
        s.stopReason = `No eligible OTM strike at entry — ${[ce, pe].filter((x): x is Extract<StrikeSelection, { ok: false }> => !x.ok).map((x) => x.reason).join('; ')}. No trades today.`;
        return [ev('STOP', s.stopReason)];
      }
      try {
        c.sell('CE', ce.pick.strike, 'Entry');
        c.sell('PE', pe.pick.strike, 'Entry');
      } catch (err) {
        return failed(s, c, ev, err);
      }
      s.level = p.startPremium;
      s.rung = 0;
      s.entryTs = snap.ts;
      s.phase = 'active';
      return [ev('ENTRY', `Sold ${legText(s.legs.CE)} and ${legText(s.legs.PE)} (spot ${snap.spot.toFixed(2)}). Next adjustment when a leg reaches ${rupees(s.level * (1 + p.stepPct / 100))}.`)];
    }

    // 3–5. Ladder adjustments.
    const watch = p.triggerOn === 'same' && s.lastTrigger ? [s.lastTrigger] : SIDES;
    let trig: { side: OptionSide; ltp: number; ratio: number } | null = null;
    for (const side of watch) {
      const leg = s.legs[side];
      if (!leg) continue;
      const ltp = snap.premium(side, leg.strike);
      if (ltp == null) continue;
      const ratio = ltp / s.level;
      if (ltp + EPS >= s.level * (1 + p.stepPct / 100) && (!trig || ratio > trig.ratio)) trig = { side, ltp, ratio };
    }
    if (!trig) return [];
    const next = ladderLevel(s.level, trig.ltp, p.stepPct);
    const opp = other(trig.side);
    const from = s.level;
    const sel = selectStrike(snap, opp, next.level, { multiple: p.strikeMultiple, maxGapPct: p.maxGapPct });
    const head = `${trig.side} ${s.legs[trig.side]!.strike} premium ${rupees(trig.ltp)} reached ${rupees(next.level)} (${rupees(from)} → ${rupees(next.level)}${next.rungs > 1 ? `, ${next.rungs} levels at once` : ''})`;
    if (!sel.ok) {
      s.level = next.level;
      s.rung += next.rungs;
      s.lastTrigger = trig.side;
      const errors = c.closeAll('No eligible OTM strike');
      s.phase = 'stopped';
      s.stopReason = `${sel.reason}. All positions squared off; no more trades today.`;
      const out = [ev('STOP', `${head}. ${s.stopReason}`)];
      if (errors.length) out.push(ev('ERROR', `Square-off failed — ${errors.join('; ')}`));
      return out;
    }
    const oldLeg = s.legs[opp];
    s.level = next.level;
    s.rung += next.rungs;
    s.lastTrigger = trig.side;
    if (oldLeg && oldLeg.strike === sel.pick.strike) {
      return [ev('ADJUSTMENT', `${head}. ${opp} ${oldLeg.strike} (${rupees(sel.pick.premium)}) is already the nearest OTM strike to ${rupees(next.level)} — kept.`)];
    }
    try {
      const exit = c.close(opp, `Shift ${opp} to ${rupees(next.level)}`);
      c.sell(opp, sel.pick.strike, `Shift ${opp} to ${rupees(next.level)}`);
      s.adjustments++;
      return [ev('ADJUSTMENT', `${head}. Bought back ${oldLeg ? `${oldLeg.strike} ${opp} @ ${rupees(exit ?? 0)}` : `no ${opp}`}, sold ${legText(s.legs[opp])}. Next adjustment at ${rupees(s.level * (1 + p.stepPct / 100))}.`)];
    } catch (err) {
      return failed(s, c, ev, err);
    }
  },

  squareOff(_p, s, snap, fill, reason) {
    const c = new Ctx(_p, s, snap, fill);
    const errors = c.closeAll(reason);
    s.phase = 'stopped';
    s.stopReason = reason;
    return { ts: snap.ts, kind: 'MANUAL_STOP', message: `${reason} — all positions squared off${errors.length ? ` (failed: ${errors.join('; ')})` : ''}.`, fills: c.fills, data: eventData(s, snap) };
  },

  status(p, s) {
    const items: AlgoStatusItem[] = [];
    const phase = { waiting: `Waiting for ${p.entryTime}`, active: 'Active', stopped: 'Stopped for the day', exited: 'Exited for the day' }[s.phase];
    items.push({ label: 'State', value: phase });
    if (s.phase === 'active' || s.level > 0) {
      items.push({ label: 'Premium level', value: `${rupees(s.level)} (level ${s.rung})` });
      if (s.phase === 'active') items.push({ label: 'Next trigger', value: `${rupees(s.level * (1 + p.stepPct / 100))}${p.triggerOn === 'same' && s.lastTrigger ? ` on ${s.lastTrigger}` : ''}` });
    }
    items.push({ label: 'Call leg', value: legText(s.legs.CE) });
    items.push({ label: 'Put leg', value: legText(s.legs.PE) });
    items.push({ label: 'Adjustments', value: String(s.adjustments) });
    if (s.stopReason) items.push({ label: 'Reason', value: s.stopReason });
    return items;
  },
};

/** An order could not be filled: square off what is open and stop for the day. */
function failed(s: PremiumLadderState, c: Ctx, ev: (k: AlgoEvent['kind'], m: string) => AlgoEvent, err: unknown): AlgoEvent[] {
  const msg = err instanceof Error ? err.message : String(err);
  const errors = c.closeAll('Order failure');
  s.phase = 'stopped';
  s.stopReason = `Order failed: ${msg}. Open positions squared off; no more trades today.`;
  return [ev('ERROR', s.stopReason + (errors.length ? ` Square-off failed — ${errors.join('; ')}` : ''))];
}

export const ALGO_PRESETS: AlgoPreset[] = [
  {
    id: 'strategy-2-rs20',
    algoId: 'premium-ladder',
    name: 'Strategy 2 · Starting premium ₹20',
    summary: 'NIFTY short strangle at ₹20 premiums (strikes in 100s) entered 09:20; shift the opposite leg every +50% (20 → 30 → 45 …); stop if no OTM strike; exit 15:25.',
    params: { symbol: 'NIFTY', expiry: 'current', lots: 1, startPremium: 20, stepPct: 50, strikeMultiple: 100, entryTime: '09:20', exitTime: '15:25', maxGapPct: 50, triggerOn: 'either', lateEntry: true },
  },
  {
    // Same rules as Strategy 2, starting from ₹50 premiums (closer to the money).
    id: 'strategy-3-rs50',
    algoId: 'premium-ladder',
    name: 'Strategy 3 · Starting premium ₹50',
    summary: 'NIFTY short strangle at ₹50 premiums (strikes in 100s) entered 09:20; shift the opposite leg every +50% (50 → 75 → 112.5 …); stop if no OTM strike; exit 15:25.',
    params: { symbol: 'NIFTY', expiry: 'current', lots: 1, startPremium: 50, stepPct: 50, strikeMultiple: 100, entryTime: '09:20', exitTime: '15:25', maxGapPct: 50, triggerOn: 'either', lateEntry: true },
  },
];

