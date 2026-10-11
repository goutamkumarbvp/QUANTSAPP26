/**
 * Ready-made option strategy templates (the "strategy wizard" library) and
 * a classifier that names an arbitrary set of legs.
 */
import type { InstrumentType, Leg, Side } from './payoff';

export type MarketView = 'bullish' | 'bearish' | 'neutral' | 'volatile';

export interface TemplateLeg {
  side: Side;
  type: InstrumentType;
  /** Strike offset from ATM in width units (positive = higher strike). Ignored for FUT. */
  offset: number;
  /** Lots multiplier. */
  ratio: number;
  /** 0 = nearest expiry, 1 = next expiry. */
  expiry?: 0 | 1;
}

export interface StrategyTemplate {
  id: string;
  name: string;
  view: MarketView;
  risk: 'limited' | 'unlimited';
  reward: 'limited' | 'unlimited';
  description: string;
  legs: TemplateLeg[];
}

const L = (side: Side, type: InstrumentType, offset = 0, ratio = 1, expiry: 0 | 1 = 0): TemplateLeg => ({ side, type, offset, ratio, expiry });

export const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  // ---------------- Bullish ----------------
  { id: 'long-call', name: 'Buy Call', view: 'bullish', risk: 'limited', reward: 'unlimited', description: 'Pay premium for upside exposure. Loss limited to the premium.', legs: [L('BUY', 'CE', 0)] },
  { id: 'short-put', name: 'Sell Put', view: 'bullish', risk: 'unlimited', reward: 'limited', description: 'Collect premium expecting the underlying to stay above the strike.', legs: [L('SELL', 'PE', 0)] },
  { id: 'bull-call-spread', name: 'Bull Call Spread', view: 'bullish', risk: 'limited', reward: 'limited', description: 'Buy a call and sell a higher call to cut cost. Debit spread.', legs: [L('BUY', 'CE', 0), L('SELL', 'CE', 2)] },
  { id: 'bull-put-spread', name: 'Bull Put Spread', view: 'bullish', risk: 'limited', reward: 'limited', description: 'Sell a put and buy a lower put as protection. Credit spread.', legs: [L('SELL', 'PE', 0), L('BUY', 'PE', -2)] },
  { id: 'call-ratio-back-spread', name: 'Call Ratio Back Spread', view: 'bullish', risk: 'limited', reward: 'unlimited', description: 'Sell one lower call, buy two higher calls. Profits from a sharp rally.', legs: [L('SELL', 'CE', 0), L('BUY', 'CE', 2, 2)] },
  { id: 'long-synthetic', name: 'Long Synthetic Future', view: 'bullish', risk: 'unlimited', reward: 'unlimited', description: 'Buy ATM call and sell ATM put — behaves like a long future.', legs: [L('BUY', 'CE', 0), L('SELL', 'PE', 0)] },
  { id: 'range-forward', name: 'Range Forward (Bullish Risk Reversal)', view: 'bullish', risk: 'unlimited', reward: 'unlimited', description: 'Sell an OTM put to fund an OTM call.', legs: [L('SELL', 'PE', -2), L('BUY', 'CE', 2)] },
  { id: 'bull-butterfly', name: 'Bull Butterfly', view: 'bullish', risk: 'limited', reward: 'limited', description: 'Call butterfly centred above spot — targets a specific higher level.', legs: [L('BUY', 'CE', 0), L('SELL', 'CE', 2, 2), L('BUY', 'CE', 4)] },
  { id: 'bull-condor', name: 'Bull Condor', view: 'bullish', risk: 'limited', reward: 'limited', description: 'Call condor above spot — profits if price drifts into a higher range.', legs: [L('BUY', 'CE', 0), L('SELL', 'CE', 1), L('SELL', 'CE', 3), L('BUY', 'CE', 4)] },
  { id: 'call-ladder-bull', name: 'Bull Call Ladder', view: 'bullish', risk: 'unlimited', reward: 'limited', description: 'Bull call spread plus an extra short higher call to reduce cost.', legs: [L('BUY', 'CE', 0), L('SELL', 'CE', 2), L('SELL', 'CE', 4)] },
  { id: 'long-futures', name: 'Buy Future', view: 'bullish', risk: 'unlimited', reward: 'unlimited', description: 'Linear long exposure.', legs: [L('BUY', 'FUT')] },
  { id: 'covered-call', name: 'Covered Call', view: 'bullish', risk: 'unlimited', reward: 'limited', description: 'Long future plus a short OTM call for income.', legs: [L('BUY', 'FUT'), L('SELL', 'CE', 2)] },
  { id: 'protective-put', name: 'Protective Put', view: 'bullish', risk: 'limited', reward: 'unlimited', description: 'Long future insured by a long put.', legs: [L('BUY', 'FUT'), L('BUY', 'PE', -1)] },

  // ---------------- Bearish ----------------
  { id: 'long-put', name: 'Buy Put', view: 'bearish', risk: 'limited', reward: 'limited', description: 'Pay premium for downside exposure. Loss limited to the premium.', legs: [L('BUY', 'PE', 0)] },
  { id: 'short-call', name: 'Sell Call', view: 'bearish', risk: 'unlimited', reward: 'limited', description: 'Collect premium expecting the underlying to stay below the strike.', legs: [L('SELL', 'CE', 0)] },
  { id: 'bear-put-spread', name: 'Bear Put Spread', view: 'bearish', risk: 'limited', reward: 'limited', description: 'Buy a put and sell a lower put to cut cost. Debit spread.', legs: [L('BUY', 'PE', 0), L('SELL', 'PE', -2)] },
  { id: 'bear-call-spread', name: 'Bear Call Spread', view: 'bearish', risk: 'limited', reward: 'limited', description: 'Sell a call and buy a higher call as protection. Credit spread.', legs: [L('SELL', 'CE', 0), L('BUY', 'CE', 2)] },
  { id: 'put-ratio-back-spread', name: 'Put Ratio Back Spread', view: 'bearish', risk: 'limited', reward: 'limited', description: 'Sell one higher put, buy two lower puts. Profits from a sharp fall.', legs: [L('SELL', 'PE', 0), L('BUY', 'PE', -2, 2)] },
  { id: 'short-synthetic', name: 'Short Synthetic Future', view: 'bearish', risk: 'unlimited', reward: 'limited', description: 'Sell ATM call and buy ATM put — behaves like a short future.', legs: [L('SELL', 'CE', 0), L('BUY', 'PE', 0)] },
  { id: 'risk-reversal-bear', name: 'Bearish Risk Reversal', view: 'bearish', risk: 'unlimited', reward: 'limited', description: 'Sell an OTM call to fund an OTM put.', legs: [L('SELL', 'CE', 2), L('BUY', 'PE', -2)] },
  { id: 'bear-butterfly', name: 'Bear Butterfly', view: 'bearish', risk: 'limited', reward: 'limited', description: 'Put butterfly centred below spot — targets a specific lower level.', legs: [L('BUY', 'PE', 0), L('SELL', 'PE', -2, 2), L('BUY', 'PE', -4)] },
  { id: 'bear-condor', name: 'Bear Condor', view: 'bearish', risk: 'limited', reward: 'limited', description: 'Put condor below spot — profits if price drifts into a lower range.', legs: [L('BUY', 'PE', 0), L('SELL', 'PE', -1), L('SELL', 'PE', -3), L('BUY', 'PE', -4)] },
  { id: 'put-ladder-bear', name: 'Bear Put Ladder', view: 'bearish', risk: 'unlimited', reward: 'limited', description: 'Bear put spread plus an extra short lower put to reduce cost.', legs: [L('BUY', 'PE', 0), L('SELL', 'PE', -2), L('SELL', 'PE', -4)] },
  { id: 'short-futures', name: 'Sell Future', view: 'bearish', risk: 'unlimited', reward: 'limited', description: 'Linear short exposure.', legs: [L('SELL', 'FUT')] },
  { id: 'covered-put', name: 'Covered Put', view: 'bearish', risk: 'unlimited', reward: 'limited', description: 'Short future plus a short OTM put for income.', legs: [L('SELL', 'FUT'), L('SELL', 'PE', -2)] },
  { id: 'protective-call', name: 'Protective Call', view: 'bearish', risk: 'limited', reward: 'limited', description: 'Short future insured by a long call.', legs: [L('SELL', 'FUT'), L('BUY', 'CE', 1)] },

  // ---------------- Neutral ----------------
  { id: 'short-straddle', name: 'Short Straddle', view: 'neutral', risk: 'unlimited', reward: 'limited', description: 'Sell ATM call and put. Maximum theta, unlimited risk.', legs: [L('SELL', 'CE', 0), L('SELL', 'PE', 0)] },
  { id: 'short-strangle', name: 'Short Strangle', view: 'neutral', risk: 'unlimited', reward: 'limited', description: 'Sell OTM call and put. Wider profit zone than a straddle.', legs: [L('SELL', 'CE', 2), L('SELL', 'PE', -2)] },
  { id: 'iron-condor', name: 'Iron Condor', view: 'neutral', risk: 'limited', reward: 'limited', description: 'Short strangle with protective wings. Defined risk range-bound trade.', legs: [L('BUY', 'PE', -4), L('SELL', 'PE', -2), L('SELL', 'CE', 2), L('BUY', 'CE', 4)] },
  { id: 'iron-butterfly', name: 'Iron Butterfly', view: 'neutral', risk: 'limited', reward: 'limited', description: 'Short straddle with protective wings.', legs: [L('BUY', 'PE', -3), L('SELL', 'PE', 0), L('SELL', 'CE', 0), L('BUY', 'CE', 3)] },
  { id: 'long-call-butterfly', name: 'Long Call Butterfly', view: 'neutral', risk: 'limited', reward: 'limited', description: 'Buy 1 lower call, sell 2 ATM calls, buy 1 higher call.', legs: [L('BUY', 'CE', -2), L('SELL', 'CE', 0, 2), L('BUY', 'CE', 2)] },
  { id: 'long-put-butterfly', name: 'Long Put Butterfly', view: 'neutral', risk: 'limited', reward: 'limited', description: 'Buy 1 higher put, sell 2 ATM puts, buy 1 lower put.', legs: [L('BUY', 'PE', 2), L('SELL', 'PE', 0, 2), L('BUY', 'PE', -2)] },
  { id: 'call-ratio-spread', name: 'Call Ratio Spread', view: 'neutral', risk: 'unlimited', reward: 'limited', description: 'Buy 1 ATM call, sell 2 OTM calls.', legs: [L('BUY', 'CE', 0), L('SELL', 'CE', 2, 2)] },
  { id: 'put-ratio-spread', name: 'Put Ratio Spread', view: 'neutral', risk: 'unlimited', reward: 'limited', description: 'Buy 1 ATM put, sell 2 OTM puts.', legs: [L('BUY', 'PE', 0), L('SELL', 'PE', -2, 2)] },
  { id: 'jade-lizard', name: 'Jade Lizard', view: 'neutral', risk: 'unlimited', reward: 'limited', description: 'Short put plus a bear call spread — no upside risk if credit ≥ call width.', legs: [L('SELL', 'PE', -2), L('SELL', 'CE', 2), L('BUY', 'CE', 3)] },
  { id: 'reverse-jade-lizard', name: 'Reverse Jade Lizard', view: 'neutral', risk: 'unlimited', reward: 'limited', description: 'Short call plus a bull put spread.', legs: [L('SELL', 'CE', 2), L('SELL', 'PE', -2), L('BUY', 'PE', -3)] },
  { id: 'batman', name: 'Batman', view: 'neutral', risk: 'limited', reward: 'limited', description: 'Call butterfly above and put butterfly below spot.', legs: [L('BUY', 'PE', -3), L('SELL', 'PE', -2, 2), L('BUY', 'PE', -1), L('BUY', 'CE', 1), L('SELL', 'CE', 2, 2), L('BUY', 'CE', 3)] },
  { id: 'call-calendar', name: 'Call Calendar', view: 'neutral', risk: 'limited', reward: 'limited', description: 'Sell near-expiry ATM call, buy next-expiry ATM call. Gains from faster near-term decay.', legs: [L('SELL', 'CE', 0, 1, 0), L('BUY', 'CE', 0, 1, 1)] },
  { id: 'put-calendar', name: 'Put Calendar', view: 'neutral', risk: 'limited', reward: 'limited', description: 'Sell near-expiry ATM put, buy next-expiry ATM put.', legs: [L('SELL', 'PE', 0, 1, 0), L('BUY', 'PE', 0, 1, 1)] },
  { id: 'double-calendar', name: 'Double Calendar', view: 'neutral', risk: 'limited', reward: 'limited', description: 'Call calendar above and put calendar below spot.', legs: [L('SELL', 'PE', -1, 1, 0), L('BUY', 'PE', -1, 1, 1), L('SELL', 'CE', 1, 1, 0), L('BUY', 'CE', 1, 1, 1)] },

  // ---------------- Volatile ----------------
  { id: 'long-straddle', name: 'Long Straddle', view: 'volatile', risk: 'limited', reward: 'unlimited', description: 'Buy ATM call and put. Profits from a big move either way.', legs: [L('BUY', 'CE', 0), L('BUY', 'PE', 0)] },
  { id: 'long-strangle', name: 'Long Strangle', view: 'volatile', risk: 'limited', reward: 'unlimited', description: 'Buy OTM call and put. Cheaper than a straddle, needs a bigger move.', legs: [L('BUY', 'CE', 2), L('BUY', 'PE', -2)] },
  { id: 'short-iron-condor', name: 'Short Iron Condor', view: 'volatile', risk: 'limited', reward: 'limited', description: 'Long strangle financed by selling further wings.', legs: [L('SELL', 'PE', -4), L('BUY', 'PE', -2), L('BUY', 'CE', 2), L('SELL', 'CE', 4)] },
  { id: 'short-iron-butterfly', name: 'Short Iron Butterfly', view: 'volatile', risk: 'limited', reward: 'limited', description: 'Long straddle financed by selling OTM wings.', legs: [L('SELL', 'PE', -3), L('BUY', 'PE', 0), L('BUY', 'CE', 0), L('SELL', 'CE', 3)] },
  { id: 'strip', name: 'Strip', view: 'volatile', risk: 'limited', reward: 'unlimited', description: 'Buy 1 ATM call and 2 ATM puts — volatile with bearish tilt.', legs: [L('BUY', 'CE', 0), L('BUY', 'PE', 0, 2)] },
  { id: 'strap', name: 'Strap', view: 'volatile', risk: 'limited', reward: 'unlimited', description: 'Buy 2 ATM calls and 1 ATM put — volatile with bullish tilt.', legs: [L('BUY', 'CE', 0, 2), L('BUY', 'PE', 0)] },
  { id: 'long-guts', name: 'Long Guts', view: 'volatile', risk: 'limited', reward: 'unlimited', description: 'Buy ITM call and ITM put.', legs: [L('BUY', 'CE', -2), L('BUY', 'PE', 2)] },
  { id: 'short-call-butterfly', name: 'Short Call Butterfly', view: 'volatile', risk: 'limited', reward: 'limited', description: 'Reverse butterfly: profits if price moves away from ATM.', legs: [L('SELL', 'CE', -2), L('BUY', 'CE', 0, 2), L('SELL', 'CE', 2)] },
  { id: 'short-put-butterfly', name: 'Short Put Butterfly', view: 'volatile', risk: 'limited', reward: 'limited', description: 'Reverse put butterfly.', legs: [L('SELL', 'PE', 2), L('BUY', 'PE', 0, 2), L('SELL', 'PE', -2)] },
];

export interface TemplateContext {
  spot: number;
  /** Sorted strikes available per expiry. */
  strikes: (expiry: string) => number[];
  expiries: string[];
  lotSize: number;
  lots?: number;
  /** Width unit in points; defaults to ~0.5% of spot snapped to the strike grid. */
  unit?: number;
  /** Quote lookup: price and IV of an instrument (futures strike = 0). */
  quote: (type: InstrumentType, strike: number, expiry: string) => { price: number; iv?: number };
  futureExpiry?: string;
  futureLotSize?: number;
}

export function nearestStrike(strikes: readonly number[], x: number): number {
  let best = strikes[0];
  for (const k of strikes) if (Math.abs(k - x) < Math.abs(best - x)) best = k;
  return best;
}

export function strikeStep(strikes: readonly number[]): number {
  let step = Infinity;
  for (let i = 1; i < strikes.length; i++) step = Math.min(step, strikes[i] - strikes[i - 1]);
  return Number.isFinite(step) ? step : 1;
}

export function defaultUnit(spot: number, step: number): number {
  return Math.max(step, Math.round((spot * 0.005) / step) * step);
}

export function buildFromTemplate(t: StrategyTemplate, ctx: TemplateContext): Leg[] {
  const lots = ctx.lots ?? 1;
  return t.legs.map((tl, i) => {
    const expiry = tl.type === 'FUT' ? ctx.futureExpiry ?? ctx.expiries[0] : ctx.expiries[Math.min(tl.expiry ?? 0, ctx.expiries.length - 1)];
    let strike = 0;
    if (tl.type !== 'FUT') {
      const strikes = ctx.strikes(expiry);
      const step = strikeStep(strikes);
      const unit = ctx.unit ?? defaultUnit(ctx.spot, step);
      const atm = nearestStrike(strikes, ctx.spot);
      strike = nearestStrike(strikes, atm + tl.offset * unit);
    }
    const q = ctx.quote(tl.type, strike, expiry);
    return {
      id: `${t.id}-${i}`,
      side: tl.side,
      type: tl.type,
      strike,
      expiry,
      lots: lots * tl.ratio,
      lotSize: tl.type === 'FUT' ? ctx.futureLotSize ?? ctx.lotSize : ctx.lotSize,
      price: q.price,
      iv: q.iv,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Naming arbitrary leg sets                                            */
/* ------------------------------------------------------------------ */

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : Math.abs(a);
}

export function describeStrategy(legsIn: readonly Leg[]): string {
  const legs = legsIn.filter((l) => l.active !== false && l.lots > 0);
  if (!legs.length) return 'Empty';
  const g = legs.reduce((a, l) => gcd(a, l.lots), 0) || 1;
  const n = legs.map((l) => ({ ...l, lots: l.lots / g })).sort((a, b) => a.strike - b.strike || a.type.localeCompare(b.type));
  const expiries = new Set(n.map((l) => l.expiry));
  const ces = n.filter((l) => l.type === 'CE');
  const pes = n.filter((l) => l.type === 'PE');
  const futs = n.filter((l) => l.type === 'FUT');
  const sig = (arr: Leg[]) => arr.map((l) => `${l.side[0]}${l.lots}`).join(',');

  if (expiries.size === 2 && n.length === 2 && n[0].type === n[1].type && n[0].strike === n[1].strike && n[0].side !== n[1].side) {
    return n[0].type === 'CE' ? 'Call Calendar' : 'Put Calendar';
  }
  if (expiries.size === 2 && n.length === 4 && ces.length === 2 && pes.length === 2) return 'Double Calendar';

  if (n.length === 1) {
    const l = n[0];
    if (l.type === 'FUT') return l.side === 'BUY' ? 'Buy Future' : 'Sell Future';
    return `${l.side === 'BUY' ? 'Buy' : 'Sell'} ${l.type === 'CE' ? 'Call' : 'Put'}`;
  }
  if (futs.length === 1 && n.length === 2) {
    const o = n.find((l) => l.type !== 'FUT')!;
    const f = futs[0];
    if (f.side === 'BUY' && o.type === 'CE' && o.side === 'SELL') return 'Covered Call';
    if (f.side === 'BUY' && o.type === 'PE' && o.side === 'BUY') return 'Protective Put';
    if (f.side === 'SELL' && o.type === 'PE' && o.side === 'SELL') return 'Covered Put';
    if (f.side === 'SELL' && o.type === 'CE' && o.side === 'BUY') return 'Protective Call';
  }
  if (n.length === 2 && ces.length === 1 && pes.length === 1) {
    const c = ces[0];
    const p = pes[0];
    if (c.lots !== p.lots) {
      if (c.side === 'BUY' && p.side === 'BUY' && c.strike === p.strike) return c.lots > p.lots ? 'Strap' : 'Strip';
    } else if (c.side === p.side) {
      const buy = c.side === 'BUY' ? 'Long' : 'Short';
      if (c.strike === p.strike) return `${buy} Straddle`;
      return c.strike > p.strike ? `${buy} Strangle` : `${buy} Guts`;
    } else if (c.side === 'BUY') {
      return c.strike === p.strike ? 'Long Synthetic Future' : 'Range Forward (Bullish Risk Reversal)';
    } else {
      return c.strike === p.strike ? 'Short Synthetic Future' : 'Bearish Risk Reversal';
    }
  }
  if (n.length === 2 && (ces.length === 2 || pes.length === 2)) {
    const [lo, hi] = n;
    const call = lo.type === 'CE';
    if (lo.lots === hi.lots && lo.side !== hi.side) {
      if (call) return lo.side === 'BUY' ? 'Bull Call Spread' : 'Bear Call Spread';
      return hi.side === 'BUY' ? 'Bear Put Spread' : 'Bull Put Spread';
    }
    if (call && sig(n) === 'B1,S2') return 'Call Ratio Spread';
    if (call && sig(n) === 'S1,B2') return 'Call Ratio Back Spread';
    if (!call && sig(n) === 'S2,B1') return 'Put Ratio Spread';
    if (!call && sig(n) === 'B2,S1') return 'Put Ratio Back Spread';
  }
  if (n.length === 3 && (ces.length === 3 || pes.length === 3)) {
    const s = sig(n);
    const name = ces.length === 3 ? 'Call' : 'Put';
    const equalWings = n[1].strike - n[0].strike === n[2].strike - n[1].strike;
    if (s === 'B1,S2,B1') return equalWings ? `Long ${name} Butterfly` : `Broken Wing ${name} Butterfly`;
    if (s === 'S1,B2,S1') return `Short ${name} Butterfly`;
    if (ces.length === 3 && s === 'B1,S1,S1') return 'Bull Call Ladder';
    if (pes.length === 3 && s === 'S1,S1,B1') return 'Bear Put Ladder';
  }
  if (n.length === 3 && ces.length === 2 && pes.length === 1 && pes[0].side === 'SELL' && sig(ces) === 'S1,B1') return 'Jade Lizard';
  if (n.length === 3 && pes.length === 2 && ces.length === 1 && ces[0].side === 'SELL' && sig(pes) === 'B1,S1') return 'Reverse Jade Lizard';
  if (n.length === 4 && ces.length === 2 && pes.length === 2) {
    const [p1, p2] = pes;
    const [c1, c2] = ces;
    if (sig(pes) === 'B1,S1' && sig(ces) === 'S1,B1') return p2.strike === c1.strike ? 'Iron Butterfly' : 'Iron Condor';
    if (sig(pes) === 'S1,B1' && sig(ces) === 'B1,S1') return p2.strike === c1.strike ? 'Short Iron Butterfly' : 'Short Iron Condor';
    void p1;
    void c2;
  }
  if (n.length === 4 && (ces.length === 4 || pes.length === 4)) {
    const name = ces.length === 4 ? 'Call' : 'Put';
    if (sig(n) === 'B1,S1,S1,B1') return `Long ${name} Condor`;
    if (sig(n) === 'S1,B1,B1,S1') return `Short ${name} Condor`;
  }
  if (n.length === 6 && ces.length === 3 && pes.length === 3) return 'Batman';
  return `Custom (${legs.length} legs)`;
}
