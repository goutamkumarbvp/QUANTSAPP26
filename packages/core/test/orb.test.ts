import { describe, expect, it } from 'vitest';
import { describeOrb, evaluateOpeningRange, summariseFlow, type MinuteBar } from '../src';

const T0 = 1_000_000;
/** Build 1-minute bars from a list of minute-boundary prices (n prices → n-1 bars). */
function barsFrom(points: number[]): MinuteBar[] {
  const out: MinuteBar[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [o, c] = [points[i], points[i + 1]];
    out.push({ ts: T0 + i * 60_000, open: o, close: c, high: Math.max(o, c), low: Math.min(o, c) });
  }
  return out;
}
// 15 range minutes oscillating between 100 and 102 (16 boundary points).
const RANGE = [101, 102, 100, 101, 102, 101, 100, 101, 101.5, 100.5, 101, 102, 100, 101, 101.5, 101];

describe('opening range breakout', () => {
  it('is forming until the range minutes complete', () => {
    const e = evaluateOpeningRange(barsFrom(RANGE.slice(0, 10)), { rangeMinutes: 15 });
    expect(e.complete).toBe(false);
    expect(e.trend).toBe('forming');
    const partial = evaluateOpeningRange(barsFrom(RANGE), { rangeMinutes: 15, lastIsPartial: true });
    expect(partial.complete).toBe(false);
    expect(evaluateOpeningRange(barsFrom(RANGE), { rangeMinutes: 15 }).complete).toBe(true);
  });

  it('takes the high and low of the first N minutes', () => {
    const e = evaluateOpeningRange(barsFrom([...RANGE, 101.2]), { rangeMinutes: 15 });
    expect(e.high).toBe(102);
    expect(e.low).toBe(100);
    expect(e.width).toBe(2);
    expect(e.trend).toBe('sideways');
    expect(e.position).toBe('inside');
    expect(describeOrb(e)).toMatch(/not trending/);
  });

  it('marks an up-trend on a 1-minute close above the high', () => {
    const e = evaluateOpeningRange(barsFrom([...RANGE, 101.8, 102.4, 103]), { rangeMinutes: 15 });
    expect(e.trend).toBe('up');
    expect(e.firstUp?.ts).toBe(T0 + 16 * 60_000);
    expect(e.firstUp?.price).toBe(102.4);
    expect(e.position).toBe('above');
    expect(e.whipsaw).toBe(false);
  });

  it('marks a down-trend on a close below the low', () => {
    const e = evaluateOpeningRange(barsFrom([...RANGE, 100.2, 99.5]), { rangeMinutes: 15 });
    expect(e.trend).toBe('down');
    expect(e.firstDown?.price).toBe(99.5);
    expect(e.toLowPct).toBeGreaterThan(0);
  });

  it('ignores a wick under the close rule but counts it under touch', () => {
    const bars = barsFrom([...RANGE, 101.5]);
    bars.push({ ts: T0 + 16 * 60_000, open: 101.5, high: 102.6, low: 101.4, close: 101.9 });
    expect(evaluateOpeningRange(bars, { rule: 'close' }).trend).toBe('sideways');
    const t = evaluateOpeningRange(bars, { rule: 'touch' });
    expect(t.trend).toBe('up');
    expect(t.firstUp?.price).toBe(102.6);
  });

  it('flags whipsaws and follows the latest break', () => {
    const e = evaluateOpeningRange(barsFrom([...RANGE, 102.5, 101, 99.4, 99]), { rangeMinutes: 15 });
    expect(e.whipsaw).toBe(true);
    expect(e.trend).toBe('down');
    expect(e.breaks.map((b) => b.direction)).toEqual(['up', 'down']);
  });

  it('collapses re-breaks of the same side but keeps them as crossings', () => {
    const e = evaluateOpeningRange(barsFrom([...RANGE, 102.5, 101.5, 102.7]), { rangeMinutes: 15 });
    expect(e.breaks).toHaveLength(1);
    expect(e.crossings).toHaveLength(2);
    expect(e.trend).toBe('up');
  });

  it('reports a failed breakout when price returns inside', () => {
    const e = evaluateOpeningRange(barsFrom([...RANGE, 102.5, 101.5]), { rangeMinutes: 15 });
    expect(e.trend).toBe('up');
    expect(e.reentered).toBe(true);
    expect(describeOrb(e)).toMatch(/back inside/);
  });

  it('does not confirm a break on the still-forming minute under the close rule', () => {
    const e = evaluateOpeningRange(barsFrom([...RANGE, 103]), { rangeMinutes: 15, lastIsPartial: true });
    expect(e.trend).toBe('sideways');
    expect(evaluateOpeningRange(barsFrom([...RANGE, 103]), { rangeMinutes: 15, rule: 'touch', lastIsPartial: true }).trend).toBe('up');
  });
});

describe('order flow summary', () => {
  it('aggregates buy and sell volume', () => {
    const s = summariseFlow([
      { ts: 0, volume: 100, buyVolume: 70, sellVolume: 30 },
      { ts: 60_000, volume: 50, buyVolume: 20, sellVolume: 30 },
    ]);
    expect(s.buyVolume).toBe(90);
    expect(s.sellVolume).toBe(60);
    expect(s.delta).toBe(30);
    expect(s.buyPct).toBeCloseTo(60, 10);
    expect(s.sentiment).toBe('Buyers dominant');
    expect(summariseFlow([{ ts: 0, volume: 100, buyVolume: 52, sellVolume: 48 }]).sentiment).toBe('Balanced');
    expect(summariseFlow([{ ts: 0, volume: 100, buyVolume: 40, sellVolume: 60 }]).sentiment).toBe('Sellers dominant');
    expect(summariseFlow([]).buyPct).toBe(50);
  });
});
