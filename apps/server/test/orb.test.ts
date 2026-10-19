/**
 * Opening range breakout over the provider (Phase C): recorded traded 1-minute bars of the
 * underlying (md.intraday), Kotak 1-minute history for unrecorded active dates (md.candles),
 * NoLiveData before data exists. Ports the semantics of the old simulator ORB tests onto the
 * TEST-ONLY FakeProvider; every bar below is constructed by this test (test data, not market data).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { istTs } from '@q26/core';
import type { Candle as ProviderCandle, CandleInterval, InstrumentKey, MinuteRecord } from '../src/live/types';
import { NoLiveData } from '../src/live/types';
import { Analytics } from '../src/services/analytics';
import { candles, spotKey } from '../src/services/live';
import { Pricer } from '../src/services/pricer';
import { FakeProvider, loadSampleBook, type SampleBook } from './support/fake-provider';

const providers: FakeProvider[] = [];
afterEach(() => {
  for (const p of providers.splice(0)) p.dispose();
});

const DAY = '2026-10-12';
const at = (date: string, hhmm: string, sec = 0) => istTs(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)), sec);
const NIFTY = spotKey('NIFTY');

function setup(time = '09:20'): { p: FakeProvider; book: SampleBook; an: Analytics } {
  const p = new FakeProvider();
  providers.push(p);
  const book = loadSampleBook(p, { time });
  return { p, book, an: new Analytics(p, new Pricer(p)) };
}

/**
 * TEST PATH (minute → close): a 24988–25012 opening range (wick high at 09:22, wick low at 09:18),
 * a touch of the high at 09:32, a close above it at 09:35, back inside at 09:45, below the low at 09:55.
 */
const C0 = [25002, 24998, 25004, 24996, 25001, 25005, 24999, 25006, 25003, 24997, 25000, 25004, 25002, 24999, 25001];
function close(m: number): number {
  if (m < 15) return C0[m];
  if (m < 20) return [25005, 25007, 25008, 25009, 25010][m - 15];
  if (m === 20) return 25015;
  if (m < 30) return 25015 + (m - 20);
  if (m < 40) return 25000 + (m % 2 ? 2 : -2);
  return 24980 - (m - 40) * 0.5;
}
function bar(m: number): { open: number; high: number; low: number; close: number } {
  const c = close(m);
  const o = m ? close(m - 1) : 25000;
  let high = Math.max(o, c) + 1;
  let low = Math.min(o, c) - 1;
  if (m === 7) high = 25012;
  if (m === 3) low = 24988;
  if (m === 17) high = 25013;
  return { open: o, high, low, close: c };
}
const rec = (p: FakeProvider, date: string, m: number, extra: Partial<MinuteRecord> = {}): MinuteRecord => ({ ts: p.calendar.ts(date, m), ...bar(m), traded: true, ...extra });
/** Records completed minutes [from, to) of the test path for `key` on `date`. */
function record(p: FakeProvider, date: string, from: number, to: number, key: InstrumentKey = NIFTY, skip: (m: number) => boolean = () => false): void {
  for (let m = from; m < to; m++) if (!skip(m)) p.intraday.addMinutes(key, [rec(p, date, m)]);
}
/** The minute in progress (recorder live bar) plus the matching live quote. */
function liveMinute(p: FakeProvider, m: number): void {
  p.intraday.setLiveBar(NIFTY, rec(p, DAY, m));
  p.setQuote(NIFTY, { ltp: close(m) });
}

describe('opening range from recorded minutes', () => {
  it('is forming before 09:30 and complete after; the minute in progress closes at the live price', async () => {
    const { p, an } = setup('09:20');
    record(p, DAY, 0, 5);
    let o = await an.orb('NIFTY');
    expect(o).toMatchObject({ symbol: 'NIFTY', date: DAY, live: true, source: 'recorded', rangeMinutes: 15, rule: 'close' });
    expect(o.evaluation.trend).toBe('forming');
    expect(o.evaluation.complete).toBe(false);
    expect(o.bars).toHaveLength(5); // exactly 09:20:00 → five completed minutes
    expect(o.summary).toMatch(/forming/);

    p.advance(30_000); // 09:20:30: a sixth, still-forming candle
    liveMinute(p, 5);
    o = await an.orb('NIFTY');
    expect(o.bars).toHaveLength(6);
    expect(o.bars[5].close).toBe(o.ltp);
    expect(o.ltp).toBe(close(5));
    expect(o.changePct).toBeCloseTo(((close(5) - 24900) / 24900) * 100, 2); // quote prevClose 24900

    p.setNow(at(DAY, '11:30', 20));
    record(p, DAY, 5, 135);
    liveMinute(p, 135);
    o = await an.orb('NIFTY');
    const e = o.evaluation;
    expect(e.complete).toBe(true);
    expect(e.trend).toBe('down');
    expect(e.whipsaw).toBe(true);
    expect([e.high, e.low]).toEqual([25012, 24988]);
    expect(e.breaks.map((b) => [b.direction, b.ts])).toEqual([
      ['up', p.calendar.ts(DAY, 20)],
      ['down', p.calendar.ts(DAY, 40)],
    ]);
    expect(o.rangeEndTs - o.rangeStartTs).toBe(15 * 60_000);
    expect(o.dayHigh).toBe(Math.max(...o.bars.map((b) => b.high)));
  });

  it('uses exactly the first 15-minute candle high and low', async () => {
    const { p, an } = setup('11:30');
    record(p, DAY, 0, 135);
    const o = await an.orb('NIFTY');
    const c15 = (await candles(p, 'NIFTY', '15', 1))[0];
    expect(c15.ts).toBe(o.rangeStartTs);
    expect(o.evaluation.high).toBe(c15.high);
    expect(o.evaluation.low).toBe(c15.low);
  });

  it('agrees with its own candles about breaks', async () => {
    const { p, an } = setup('11:30');
    record(p, DAY, 0, 135);
    const o = await an.orb('NIFTY');
    const e = o.evaluation;
    expect(e.crossings.length).toBeGreaterThan(0);
    for (const b of e.crossings) {
      const c = o.bars.find((x) => x.ts === b.ts)!;
      expect(c).toBeTruthy();
      expect(b.ts).toBeGreaterThanOrEqual(o.rangeEndTs);
      if (b.direction === 'up') expect(c.close).toBeGreaterThan(e.high);
      else expect(c.close).toBeLessThan(e.low);
    }
    const first = e.crossings[0].ts;
    for (const c of o.bars) {
      if (c.ts >= o.rangeEndTs && c.ts < first) {
        expect(c.close).toBeLessThanOrEqual(e.high);
        expect(c.close).toBeGreaterThanOrEqual(e.low);
      }
    }
  });

  it('supports other range lengths, the touch rule, past dates; 400 for a non-trading day', async () => {
    const { p, an, book } = setup('11:30');
    record(p, DAY, 0, 135);
    const r5 = await an.orb('NIFTY', undefined, { rangeMinutes: 5 });
    expect(r5.rangeMinutes).toBe(5);
    expect(r5.evaluation.high).toBe(Math.max(...[0, 1, 2, 3, 4].map((m) => bar(m).high)));
    const c15 = (await an.orb('NIFTY')).evaluation;
    expect(r5.evaluation.high).toBeLessThanOrEqual(c15.high);
    const touch = (await an.orb('NIFTY', undefined, { rule: 'touch' })).evaluation;
    expect(touch.firstUp?.ts).toBe(p.calendar.ts(DAY, 17)); // the 09:32 wick
    expect(c15.firstUp?.ts).toBe(p.calendar.ts(DAY, 20)); // the 09:35 close
    expect(touch.firstUp!.ts).toBeLessThanOrEqual(c15.firstUp!.ts);

    const past = await an.orb('NIFTY', undefined, { date: book.recordedDate });
    expect(past.live).toBe(false);
    expect(past.bars).toHaveLength(375);
    expect(past.ltp).toBe(past.bars[374].close);
    // vs the official close of the session before (24950 × 0.997, sample EOD bars).
    expect(past.changePct).toBeCloseTo((((past.ltp as number) - 24875.15) / 24875.15) * 100, 2);
    await expect(an.orb('NIFTY', undefined, { date: '2026-10-04' })).rejects.toMatchObject({ statusCode: 400 }); // a Sunday
    await expect(an.orb('NIFTY', undefined, { date: '2026-10-13' })).rejects.toMatchObject({ statusCode: 400 }); // future
  });

  it('builds the range by time: untraded minutes have no bar and never pull a later bar into the range', async () => {
    const { p, an } = setup('09:40');
    // 09:25 is quote-only (its high is a carried price, not a trade); 09:29 has no record at all.
    for (let m = 0; m < 25; m++) {
      if (m === 14) continue;
      const extra: Partial<MinuteRecord> = m === 10 ? { traded: false, high: 25100 } : m === 15 ? { high: 25020, close: 25010 } : {};
      p.intraday.addMinutes(NIFTY, [rec(p, DAY, m, extra)]);
    }
    const o = await an.orb('NIFTY');
    expect(o.bars.some((b) => b.ts === p.calendar.ts(DAY, 10))).toBe(false);
    expect(o.evaluation.rangeMinutes).toBe(15);
    expect(o.evaluation.complete).toBe(true);
    expect([o.evaluation.high, o.evaluation.low]).toEqual([25012, 24988]);
    const touch = (await an.orb('NIFTY', undefined, { rule: 'touch' })).evaluation;
    expect(touch.firstUp?.ts).toBe(p.calendar.ts(DAY, 15)); // the 09:30 bar is the first after the range
  });

  it('a recording that starts after the open is not an opening range (NoLiveData with the reason)', async () => {
    const { p, an } = setup('11:00');
    record(p, DAY, 25, 100);
    await expect(an.orb('NIFTY')).rejects.toThrow(/starts at 09:40/);
    await expect(an.orb('NIFTY')).rejects.toBeInstanceOf(NoLiveData);
    expect(() => an.orbConfirmed('NIFTY', undefined, 15)).toThrow(/starts at 09:40/);
  });

  it('a recorder live bar of another session is never taken as the minute in progress', async () => {
    const { p, an, book } = setup('09:20');
    // nothing recorded today (and no Kotak history); the store still reports a bar of the previous session
    p.intraday.setLiveBar(NIFTY, { ts: p.calendar.ts(book.recordedDate, 374), open: 26000, high: 26000, low: 26000, close: 26000, traded: true });
    p.candles = async () => {
      throw new NoLiveData('not served');
    };
    await expect(an.orb('NIFTY')).rejects.toThrow(/No recorded NIFTY minutes for 2026-10-12 — recording started 2026-10-09; Kotak 1-minute history: not served/);
    expect(() => an.orbScan()).toThrow(NoLiveData);
    record(p, DAY, 0, 5);
    const o = await an.orb('NIFTY');
    expect(o.bars).toHaveLength(5);
    expect(o.bars.every((b) => b.high < 26000)).toBe(true);
  });

  it('history with no break on any day has no average follow-through (null, not 0)', async () => {
    const { p, an } = setup('11:30');
    // 2026-10-08 recorded flat: closes never leave the opening range
    for (let m = 0; m < 375; m++) p.intraday.addMinutes(NIFTY, [{ ts: p.calendar.ts('2026-10-08', m), open: 25000, high: 25001, low: 24999, close: 25000, traded: true }]);
    p.setNow(at('2026-10-09', '11:00')); // the next session is live: 2026-10-08 is the last completed one
    const h = await an.orbHistory('NIFTY', 1);
    expect(h.rows.map((r) => [r.date, r.trend, r.firstBreak, r.followThroughPct])).toEqual([['2026-10-08', 'sideways', null, null]]);
    expect(h.stats).toMatchObject({ days: 1, sideways: 1, brokeUp: 0, brokeDown: 0, trendDays: 0, avgFollowThroughPct: null });
  });

  it('is NoLiveData before any trade exists', async () => {
    const { p, an } = setup('09:15');
    p.advance(30_000);
    await expect(an.orb('NIFTY')).rejects.toBeInstanceOf(NoLiveData);
    await expect(an.orb('NIFTY')).rejects.toThrow(/recording started 2026-10-09/);
    expect(() => an.orbConfirmed('NIFTY', undefined, 15)).toThrow(NoLiveData);
  });

  it('orbConfirmed uses completed minutes only (the forming minute never confirms a break)', async () => {
    const { p, an } = setup('09:35');
    p.advance(30_000);
    record(p, DAY, 0, 20);
    liveMinute(p, 20); // 09:35 in progress, closing above the high so far
    const live = await an.orb('NIFTY');
    expect(live.evaluation.trend).toBe('sideways');
    expect(live.evaluation.pending).toBe('up');
    let c = an.orbConfirmed('NIFTY', undefined, 15);
    expect(c.trend).toBe('sideways');
    expect(c.pending).toBeNull();
    p.setNow(at(DAY, '09:36', 5));
    record(p, DAY, 20, 21);
    p.intraday.setLiveBar(NIFTY, null);
    c = an.orbConfirmed('NIFTY', undefined, 15);
    expect(c.trend).toBe('up');
    expect(c.breaks[0].ts).toBe(p.calendar.ts(DAY, 20));
  });

  it('falls back to Kotak 1-minute history for an unrecorded date of the last 30 sessions', async () => {
    const { p, an } = setup('11:30');
    const date = '2026-10-08';
    const asked: [string, CandleInterval, string, string][] = [];
    p.candles = async (key: InstrumentKey, interval: CandleInterval, from: string, to: string): Promise<ProviderCandle[]> => {
      asked.push([key.symbol, interval, from, to]);
      return Array.from({ length: 375 }, (_, m) => ({ ts: p.calendar.ts(date, m), ...bar(m) }));
    };
    const o = await an.orb('NIFTY', undefined, { date });
    expect(asked).toEqual([['NIFTY', '1min', date, date]]);
    expect(o.source).toBe('kotak');
    expect(o.live).toBe(false);
    expect(o.bars).toHaveLength(375);
    expect([o.evaluation.high, o.evaluation.low]).toEqual([25012, 24988]);
    await expect(an.orb('NIFTY', undefined, { date: '2026-08-03' })).rejects.toThrow(/last 30 sessions/);
  });

  it('the market-wide scan covers the underlyings with recorded bars only', async () => {
    const { p, an } = setup('11:30');
    record(p, DAY, 0, 135);
    record(p, DAY, 30, 135, spotKey('RELIANCE')); // recording started late: left out
    const rows = an.orbScan(undefined, { rangeMinutes: 15 });
    expect(rows.map((r) => r.symbol)).toEqual(['NIFTY']);
    const o = await an.orb('NIFTY');
    expect(rows[0]).toMatchObject({ name: 'Nifty 50', kind: 'index', trend: o.evaluation.trend, whipsaw: true, high: 25012, low: 24988, breakTs: p.calendar.ts(DAY, 40) });
    expect(rows[0].changePct).toBeCloseTo(((rows[0].ltp - 24900) / 24900) * 100, 2);
    expect(an.orbScan()).toBe(an.orbScan()); // cached within 5 s

    const fresh = setup('11:30');
    expect(() => fresh.an.orbScan()).toThrow(NoLiveData);
  });

  it('history covers the recorded (or Kotak) sessions only and says which are missing', async () => {
    const { p, an, book } = setup('11:30');
    // 2026-10-08 fully recorded; 2026-10-07 recorded from 10:00 only; 2026-10-06 from Kotak.
    record(p, '2026-10-08', 0, 375);
    record(p, '2026-10-07', 45, 375);
    p.candles = async (_key, _iv, from, to) => {
      expect([from, to]).toEqual(['2026-10-05', '2026-10-07']);
      return Array.from({ length: 375 }, (_, m) => ({ ts: p.calendar.ts('2026-10-06', m), ...bar(m) }));
    };
    const h = await an.orbHistory('NIFTY', 5);
    expect(h.sessions).toBe(5);
    expect(h.rows.map((r) => [r.date, r.source])).toEqual([
      [book.recordedDate, 'recorded'],
      ['2026-10-08', 'recorded'],
      ['2026-10-06', 'kotak'],
    ]);
    expect(h.gaps?.sessions).toMatch(/^2 of 5 sessions/);
    expect(h.stats.days).toBe(3);
    expect(h.stats.brokeUp + h.stats.brokeDown + h.stats.sideways).toBe(3);
    expect(h.stats.trendDays).toBeLessThanOrEqual(h.stats.brokeUp + h.stats.brokeDown);
    const r8 = h.rows[1];
    expect(r8).toMatchObject({ high: 25012, low: 24988, whipsaw: true, close: close(374), closeVsRange: 'below' });
    expect(r8.firstBreak).toEqual({ direction: 'up', ts: p.calendar.ts('2026-10-08', 20) });
    expect(r8.followThroughPct).toBeCloseTo(((close(374) - 25012) / 25012) * 100, 2);
    const broke = h.rows.filter((r) => r.firstBreak);
    expect(h.stats.avgFollowThroughPct).toBe(+(broke.reduce((a, r) => a + r.followThroughPct!, 0) / broke.length).toFixed(2));

    const none = setup('11:30');
    await expect(none.an.orbHistory('BANKNIFTY', 3)).rejects.toThrow(NoLiveData);
  });
});
