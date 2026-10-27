/**
 * Order & Trade chart analytics: what aggressive buyers and sellers did, minute by minute, and what the
 * price did meanwhile. Inputs are recorded 1-minute order-flow minutes (buyer-initiated = trades at or
 * above the ask, seller-initiated = at or below the bid; an estimate from live ticks).
 *
 *  - Spike: a minute whose buyer- (seller-) initiated quantity is at least `factor` × the median of the
 *    previous `window` minutes, and larger than the other side. Big aggressive orders show up as spikes.
 *  - Direction: over the last `lookback` minutes, who initiated more quantity, and whether the price
 *    moved with them (confirmation) or against them (absorption: the other side soaked it up).
 *
 * Partial minutes (recording started inside them) are not judged: their quantity is a lower bound.
 */

export interface OrderTradeMinute {
  ts: number;
  buyVolume: number;
  sellVolume: number;
  partial?: boolean;
  open?: number | null;
  close: number | null;
}

export interface FlowSpike {
  ts: number;
  side: 'buy' | 'sell';
  qty: number;
  /** qty ÷ the median of the previous minutes. */
  ratio: number;
}

export type FlowRead = 'buyers' | 'sellers' | 'buying-absorbed' | 'selling-absorbed' | 'balanced';

export interface FlowDirection {
  read: FlowRead;
  text: string;
  /** Minutes judged (completed, not partial) in the lookback. */
  minutes: number;
  buy: number;
  sell: number;
  /** Buyer share of the initiated quantity (%), null when nothing was initiated. */
  buyPct: number | null;
  /** Price change over the lookback (last close − first open/close), null without prices. */
  priceChange: number | null;
  buySpikes: number;
  sellSpikes: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function flowSpikes(minutes: readonly OrderTradeMinute[], opts: { window?: number; factor?: number; minHistory?: number; fromTs?: number } = {}): FlowSpike[] {
  const window = opts.window ?? 30;
  const factor = opts.factor ?? 3;
  const minHistory = opts.minHistory ?? 10;
  const full = minutes.filter((m) => !m.partial);
  const out: FlowSpike[] = [];
  for (let i = minHistory; i < full.length; i++) {
    const m = full[i];
    // Minutes before `fromTs` are history only (a caller that reads the last few minutes skips the rest).
    if (opts.fromTs !== undefined && m.ts < opts.fromTs) continue;
    // A spike needs the side's quantity above the other's, so only that side's median is ever needed.
    const side = m.buyVolume > m.sellVolume ? 'buy' : m.sellVolume > m.buyVolume ? 'sell' : null;
    if (!side) continue;
    const qty = side === 'buy' ? m.buyVolume : m.sellVolume;
    const prev = full.slice(Math.max(0, i - window), i);
    const floor = Math.max(median(prev.map((p) => (side === 'buy' ? p.buyVolume : p.sellVolume))), 1);
    if (qty >= factor * floor) out.push({ ts: m.ts, side, qty, ratio: Math.round((qty / floor) * 10) / 10 });
  }
  return out;
}

export function flowDirection(minutes: readonly OrderTradeMinute[], opts: { lookback?: number; threshold?: number; spikes?: readonly FlowSpike[] } = {}): FlowDirection | null {
  const lookback = opts.lookback ?? 15;
  const threshold = opts.threshold ?? 55;
  const full = minutes.filter((m) => !m.partial);
  if (!full.length) return null;
  const win = full.slice(-lookback);
  const from = win[0].ts;
  const buy = win.reduce((s, m) => s + m.buyVolume, 0);
  const sell = win.reduce((s, m) => s + m.sellVolume, 0);
  const buyPct = buy + sell > 0 ? Math.round((buy / (buy + sell)) * 1000) / 10 : null;
  const priced = win.filter((m) => typeof m.close === 'number');
  const firstPx = priced.length ? (typeof priced[0].open === 'number' ? priced[0].open : priced[0].close) : null;
  const lastPx = priced.length ? priced[priced.length - 1].close : null;
  const priceChange = firstPx !== null && lastPx !== null ? Math.round((lastPx - firstPx) * 100) / 100 : null;
  const spikes = (opts.spikes ?? flowSpikes(minutes, { fromTs: from })).filter((s) => s.ts >= from);
  const buySpikes = spikes.filter((s) => s.side === 'buy').length;
  const sellSpikes = spikes.filter((s) => s.side === 'sell').length;
  const span = `last ${win.length} min`;
  let read: FlowRead = 'balanced';
  let text = `Balanced: neither side initiated clearly more quantity (${span})`;
  if (buyPct !== null && priceChange !== null) {
    if (buyPct >= threshold && priceChange > 0) {
      read = 'buyers';
      text = `Buyers in control: ${buyPct}% of initiated quantity was bought and the price rose ${priceChange} (${span})`;
    } else if (buyPct <= 100 - threshold && priceChange < 0) {
      read = 'sellers';
      text = `Sellers in control: ${(100 - buyPct).toFixed(1)}% of initiated quantity was sold and the price fell ${Math.abs(priceChange)} (${span})`;
    } else if (buyPct >= threshold) {
      read = 'buying-absorbed';
      text = `Buying absorbed: aggressive buyers (${buyPct}%) but the price did not rise (${priceChange}) — sellers are absorbing; caution for longs (${span})`;
    } else if (buyPct <= 100 - threshold) {
      read = 'selling-absorbed';
      text = `Selling absorbed: aggressive sellers (${(100 - buyPct).toFixed(1)}%) but the price did not fall (+${priceChange}) — buyers are absorbing; caution for shorts (${span})`;
    }
  } else if (buyPct === null) text = `No initiated quantity in the ${span}`;
  return { read, text, minutes: win.length, buy, sell, buyPct, priceChange, buySpikes, sellSpikes };
}
