/**
 * Opening Range Breakout (ORB).
 *
 * The opening range is the high and low of the first N minutes of the session (default the
 * first 15-minute candle, 09:15–09:30 IST). Once the range is complete, a move beyond either
 * end marks the market as trending in that direction; staying inside means range-bound.
 *
 * Breaks are confirmed on 1-minute candle closes by default ('close' rule) so a single wick
 * does not count; the 'touch' rule counts any trade beyond the level.
 */

export interface MinuteBar {
  /** Start of the minute (epoch ms). */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type OrbRule = 'close' | 'touch';
export type OrbTrend = 'forming' | 'sideways' | 'up' | 'down';

export interface OrbBreak {
  direction: 'up' | 'down';
  /** Start time of the 1-minute candle that broke the level. */
  ts: number;
  /** Price that confirmed the break (candle close for 'close', extreme for 'touch'). */
  price: number;
}

export interface OrbEvaluation {
  rangeMinutes: number;
  rule: OrbRule;
  /** True once all minutes of the opening range have traded. */
  complete: boolean;
  high: number;
  low: number;
  width: number;
  widthPct: number;
  /** Breaks to a new side (consecutive breaks of the same side collapsed). */
  breaks: OrbBreak[];
  /** Every exit from the range, including re-breaks of the same side after re-entering. */
  crossings: OrbBreak[];
  firstUp: OrbBreak | null;
  firstDown: OrbBreak | null;
  /** Direction of the latest break; 'sideways' if never broken, 'forming' before the range completes. */
  trend: OrbTrend;
  /** Both sides have been broken during the session. */
  whipsaw: boolean;
  /** Where the latest price sits relative to the range. */
  position: 'above' | 'inside' | 'below';
  /** Trending, but price has come back inside the range (possible failed breakout). */
  reentered: boolean;
  /**
   * The live price is beyond a level in a direction that is not (yet) a confirmed break — e.g.
   * the minute in progress is above the high but has not closed there. Always null for 'touch'.
   */
  pending: 'up' | 'down' | null;
  last: number;
  /** % distance from the latest price to each level (positive = level is above price). */
  toHighPct: number;
  toLowPct: number;
}

/**
 * Evaluate the opening range over 1-minute bars that start at the session open.
 * `bars[0]` must be the 09:15 candle. The final bar may be the current, still-forming minute;
 * pass `lastIsPartial` so the 'close' rule ignores its provisional close.
 */
export function evaluateOpeningRange(
  bars: readonly MinuteBar[],
  opts: { rangeMinutes?: number; rule?: OrbRule; lastIsPartial?: boolean } = {},
): OrbEvaluation {
  const rangeMinutes = Math.max(1, Math.round(opts.rangeMinutes ?? 15));
  const rule = opts.rule ?? 'close';
  const rangeBars = bars.slice(0, rangeMinutes);
  const complete = bars.length > rangeMinutes || (bars.length === rangeMinutes && !opts.lastIsPartial);
  let high = -Infinity;
  let low = Infinity;
  for (const b of rangeBars) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
  }
  const last = bars.length ? bars[bars.length - 1].close : NaN;
  if (!rangeBars.length) high = low = NaN;

  const breaks: OrbBreak[] = [];
  let side: 'above' | 'inside' | 'below' = 'inside';
  if (complete) {
    for (let i = rangeMinutes; i < bars.length; i++) {
      const b = bars[i];
      const partial = i === bars.length - 1 && opts.lastIsPartial;
      if (rule === 'close' && partial) break;
      const upLevel = rule === 'close' ? b.close : b.high;
      const downLevel = rule === 'close' ? b.close : b.low;
      const brokeUp = upLevel > high;
      const brokeDown = downLevel < low;
      // A 'touch' candle can pierce both sides; attribute it to the side its close favours.
      if (brokeUp && (!brokeDown || b.close >= (high + low) / 2)) {
        if (side !== 'above') breaks.push({ direction: 'up', ts: b.ts, price: rule === 'close' ? b.close : b.high });
        side = 'above';
      } else if (brokeDown) {
        if (side !== 'below') breaks.push({ direction: 'down', ts: b.ts, price: rule === 'close' ? b.close : b.low });
        side = 'below';
      } else if (rule === 'close') {
        side = 'inside';
      } else if (b.close <= high && b.close >= low) {
        side = 'inside';
      }
    }
  }
  // Re-entering and breaking the same side again is not a new break.
  const dedup: OrbBreak[] = [];
  for (const br of breaks) if (!dedup.length || dedup[dedup.length - 1].direction !== br.direction) dedup.push(br);

  const firstUp = dedup.find((b) => b.direction === 'up') ?? null;
  const firstDown = dedup.find((b) => b.direction === 'down') ?? null;
  const trend: OrbTrend = !complete ? 'forming' : dedup.length ? dedup[dedup.length - 1].direction : 'sideways';
  const { position, pending, reentered, toHighPct, toLowPct } = priceVsRange(high, low, complete, trend, last);
  const width = high - low;
  return {
    rangeMinutes,
    rule,
    complete,
    high,
    low,
    width,
    widthPct: low > 0 ? (width / low) * 100 : NaN,
    breaks: dedup,
    crossings: breaks,
    firstUp,
    firstDown,
    trend,
    whipsaw: !!firstUp && !!firstDown,
    position,
    reentered,
    pending,
    last,
    toHighPct,
    toLowPct,
  };
}

/** Where `price` sits relative to the range, and its % distance to each level. */
function priceVsRange(high: number, low: number, complete: boolean, trend: OrbTrend, price: number) {
  const position: OrbEvaluation['position'] = !Number.isFinite(price) || !complete ? 'inside' : price > high ? 'above' : price < low ? 'below' : 'inside';
  const pending: OrbEvaluation['pending'] = position === 'above' && trend !== 'up' ? 'up' : position === 'below' && trend !== 'down' ? 'down' : null;
  return {
    position,
    pending,
    reentered: (trend === 'up' || trend === 'down') && position === 'inside',
    toHighPct: price > 0 ? ((high - price) / price) * 100 : NaN,
    toLowPct: price > 0 ? ((low - price) / price) * 100 : NaN,
  };
}

/**
 * The evaluation with its price-dependent fields (position, pending, reentered, last, toHighPct,
 * toLowPct) taken at `price` instead of the last bar's close, e.g. the live LTP. Breaks are unchanged.
 */
export function orbAtPrice(e: OrbEvaluation, price: number): OrbEvaluation {
  return { ...e, ...priceVsRange(e.high, e.low, e.complete, e.trend, price), last: price };
}

/** Human summary used by UI, alerts and scanners. */
export function describeOrb(e: OrbEvaluation): string {
  switch (e.trend) {
    case 'forming':
      return `Opening range forming (first ${e.rangeMinutes} min)`;
    case 'sideways':
      if (e.pending === 'up') return 'Testing the range high — break not confirmed yet';
      if (e.pending === 'down') return 'Testing the range low — break not confirmed yet';
      return 'Inside opening range — not trending';
    case 'up':
      if (e.pending === 'down') return 'Broke above range, now below the range low (reversal not confirmed yet)';
      return e.reentered ? 'Broke above range, now back inside (failed breakout?)' : e.whipsaw ? 'Trending up after a whipsaw' : 'Trending up — opening range high broken';
    case 'down':
      if (e.pending === 'up') return 'Broke below range, now above the range high (reversal not confirmed yet)';
      return e.reentered ? 'Broke below range, now back inside (failed breakdown?)' : e.whipsaw ? 'Trending down after a whipsaw' : 'Trending down — opening range low broken';
  }
}

/* ------------------------------------------------------------------ */
/* Order flow                                                            */
/* ------------------------------------------------------------------ */

/**
 * @deprecated The server sends `OrderFlowSummary` (api.ts: nullable buy share, unclassified volume,
 * estimate label). Kept only while the web still imports it (Phase D).
 */
export interface FlowSummary {
  buyVolume: number;
  sellVolume: number;
  volume: number;
  delta: number;
  /** Buy share of volume (%). */
  buyPct: number;
  sentiment: 'Buyers dominant' | 'Sellers dominant' | 'Balanced' | 'No trades';
}
