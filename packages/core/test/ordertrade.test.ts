import { describe, expect, it } from 'vitest';
import { flowDirection, flowSpikes, type OrderTradeMinute } from '../src/ordertrade';

const T0 = Date.UTC(2026, 9, 26, 3, 45);
const min = (i: number, buy: number, sell: number, close: number | null, extra: Partial<OrderTradeMinute> = {}): OrderTradeMinute => ({ ts: T0 + i * 60_000, buyVolume: buy, sellVolume: sell, open: close, close, ...extra });

describe('order & trade: spikes', () => {
  it('a minute ≥ 3× the median of the previous 30 and larger than the other side is a spike', () => {
    const ms = Array.from({ length: 20 }, (_, i) => min(i, 100, 100, 25000));
    ms.push(min(20, 450, 120, 25010)); // buyer spike 4.5×
    ms.push(min(21, 120, 380, 25000)); // seller spike 3.8×
    ms.push(min(22, 290, 100, 25000)); // 2.9×: not a spike
    ms.push(min(23, 900, 950, 25000)); // big but the other side is bigger: no buy spike; sell 9.5× → sell spike
    expect(flowSpikes(ms)).toEqual([
      { ts: T0 + 20 * 60_000, side: 'buy', qty: 450, ratio: 4.5 },
      { ts: T0 + 21 * 60_000, side: 'sell', qty: 380, ratio: 3.8 },
      { ts: T0 + 23 * 60_000, side: 'sell', qty: 950, ratio: 9.5 },
    ]);
  });

  it('needs 10 minutes of history; partial minutes are never judged', () => {
    expect(flowSpikes([min(0, 1, 1, 1), min(1, 500, 1, 1)])).toEqual([]);
    const ms = Array.from({ length: 12 }, (_, i) => min(i, 100, 100, 1));
    ms.push(min(12, 5000, 100, 1, { partial: true }));
    expect(flowSpikes(ms)).toEqual([]);
  });
});

describe('order & trade: direction', () => {
  const run = (buy: number, sell: number, from: number, to: number) => Array.from({ length: 15 }, (_, i) => min(i, buy, sell, from + ((to - from) * i) / 14));

  it('buyers / sellers in control when the price moves with them', () => {
    expect(flowDirection(run(700, 300, 25000, 25040))).toMatchObject({ read: 'buyers', buyPct: 70, priceChange: 40, minutes: 15 });
    expect(flowDirection(run(300, 700, 25040, 25000))).toMatchObject({ read: 'sellers', buyPct: 30, priceChange: -40 });
  });

  it('absorption when the price moves against the aggressive side', () => {
    const d = flowDirection(run(700, 300, 25040, 25000))!;
    expect(d.read).toBe('buying-absorbed');
    expect(d.text).toMatch(/sellers are absorbing/);
    expect(flowDirection(run(300, 700, 25000, 25040))!.read).toBe('selling-absorbed');
  });

  it('balanced inside 45–55%; nothing judged without minutes', () => {
    expect(flowDirection(run(520, 480, 25000, 25040))!.read).toBe('balanced');
    expect(flowDirection([])).toBeNull();
    expect(flowDirection([min(0, 0, 0, null)])!.text).toMatch(/No initiated quantity/);
  });
});

describe('flowSpikes matches the straightforward definition', () => {
  // The original, unoptimised rule: for each minute and side, quantity above the other side and ≥ factor × the
  // side's median over the previous `window` minutes.
  const reference = (ms: OrderTradeMinute[], window = 30, factor = 3, minHistory = 10) => {
    const full = ms.filter((m) => !m.partial);
    const out: { ts: number; side: 'buy' | 'sell'; qty: number; ratio: number }[] = [];
    const med = (xs: number[]) => {
      const s = [...xs].sort((a, b) => a - b);
      const k = s.length >> 1;
      return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
    };
    for (let i = minHistory; i < full.length; i++) {
      const prev = full.slice(Math.max(0, i - window), i);
      for (const side of ['buy', 'sell'] as const) {
        const q = side === 'buy' ? full[i].buyVolume : full[i].sellVolume;
        const o = side === 'buy' ? full[i].sellVolume : full[i].buyVolume;
        const floor = Math.max(med(prev.map((p) => (side === 'buy' ? p.buyVolume : p.sellVolume))), 1);
        if (q > o && q >= factor * floor) out.push({ ts: full[i].ts, side, qty: q, ratio: Math.round((q / floor) * 10) / 10 });
      }
    }
    return out;
  };
  it('on random sessions, and from a start time', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let run = 0; run < 25; run++) {
      const ms = Array.from({ length: 375 }, (_, i) => ({ ...min(i, Math.floor(rnd() * (rnd() < 0.05 ? 5000 : 500)), Math.floor(rnd() * (rnd() < 0.05 ? 5000 : 500)), 0), ...(rnd() < 0.03 ? { partial: true as const } : {}) }));
      const ref = reference(ms);
      expect(flowSpikes(ms)).toEqual(ref);
      const from = ms[300].ts;
      expect(flowSpikes(ms, { fromTs: from })).toEqual(ref.filter((s) => s.ts >= from));
      expect(flowDirection(ms)).toEqual(flowDirection(ms, { spikes: ref }));
    }
  });
});
