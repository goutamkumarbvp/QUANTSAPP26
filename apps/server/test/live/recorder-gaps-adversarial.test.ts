/**
 * Adversarial checks of the recorder's feed-gap / partial-minute rules around the close, restarts and
 * out-of-order ticks. The ticks are synthetic TEST inputs; the program never fabricates ticks.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExchangeCalendar } from '../../src/live/calendar';
import { LiveClock } from '../../src/live/clock';
import { Recorder, type RecorderOptions } from '../../src/live/recorder';
import { IntradayFiles, type IntradayWriter } from '../../src/live/store/intraday';
import { keyId } from '../../src/live/types';
import type { ChainMinute, InstrumentKey, LiveQuote, MinuteRecord } from '../../src/live/types';

const ist = (date: string, hh: number, mm: number, ss = 0, ms = 0): number => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm, ss, ms) - 330 * 60_000;
};
const D = '2026-10-12';
const t = (hh: number, mm: number, ss = 0, ms = 0) => ist(D, hh, mm, ss, ms);
const FUT: InstrumentKey = { symbol: 'NIFTY', kind: 'FUT', expiry: '2026-10-27' };

class FakeLive {
  private readonly listeners = new Set<(q: LiveQuote) => void>();
  readonly latest = new Map<string, LiveQuote>();
  onTick(l: (q: LiveQuote) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  quote(k: InstrumentKey): LiveQuote | undefined {
    return this.latest.get(keyId(k));
  }
  emit(q: LiveQuote): void {
    this.latest.set(keyId(q.key), q);
    for (const l of this.listeners) l(q);
  }
}

class MemWriter implements IntradayWriter {
  minutes: { key: InstrumentKey; rec: MinuteRecord }[] = [];
  writeMinutes(items: readonly { key: InstrumentKey; rec: MinuteRecord }[]): void {
    this.minutes.push(...items.map((i) => ({ key: i.key, rec: { ...i.rec } })));
  }
  writeChainMinutes(_items: readonly { symbol: string; expiry: string; rec: ChainMinute }[]): void {}
  of(key: InstrumentKey): MinuteRecord[] {
    return this.minutes.filter((m) => keyId(m.key) === keyId(key)).map((m) => m.rec);
  }
}

function setup(extra: Partial<RecorderOptions & { writer: IntradayWriter }> = {}) {
  const calendar = new ExchangeCalendar();
  const clk = { now: t(9, 0) };
  const clock = new LiveClock(calendar, () => clk.now);
  const live = new FakeLive();
  const writer = new MemWriter();
  const rec = new Recorder({ live, writer, pricing: { r: 0.065 }, calendar, clock, timers: { setInterval: () => 0, clearInterval: () => undefined }, ...extra });
  rec.start();
  const tick = (key: InstrumentKey, ts: number, fields: Partial<LiveQuote> & { ltp: number }, lagMs = 100) => {
    clk.now = Math.max(clk.now, ts + lagMs);
    live.emit({ key, ts, ...fields });
  };
  const at = (ts: number) => {
    clk.now = ts;
    rec.flushDue();
  };
  return { rec, live, writer, clk, tick, at };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const total = (recs: MinuteRecord[]) => recs.reduce((a, r) => a + (r.volume ?? 0) + (r.gapVolume ?? 0), 0);

describe('feed gap ending before / spanning the 15:30 close', () => {
  it('a gap that ends inside the last minute is booked as gapVolume of that minute', () => {
    const { writer, tick, at } = setup();
    tick(FUT, t(15, 10, 5), { ltp: 100, volume: 1000 });
    tick(FUT, t(15, 10, 30), { ltp: 100, volume: 1010 });
    tick(FUT, t(15, 29, 50), { ltp: 101, volume: 1100 }); // 15:11–15:28 silent
    at(t(15, 31));
    const recs = writer.of(FUT);
    expect(recs.at(-1)).toMatchObject({ ts: t(15, 29), volume: 0, gapVolume: 90 });
    expect(total(recs)).toBe(100);
  });

  it('a gap that began in the session and ended after the close: the post-close tick\'s volume is gapVolume of the last session minute (labelled, not dropped)', () => {
    const { writer, tick, at, rec } = setup();
    tick(FUT, t(15, 10, 5), { ltp: 100, volume: 1000, oi: 5000 });
    tick(FUT, t(15, 10, 30), { ltp: 100, volume: 1010 });
    // Feed dropped from 15:11; the reconnect snapshot arrives after the close with the day's final volume.
    tick(FUT, t(15, 31, 5), { ltp: 101, volume: 1500, oi: 5200 });
    at(t(15, 32));
    rec.endSession();
    const recs = writer.of(FUT);
    // The 490 units traded somewhere in 15:11–15:30: booked on 15:29 as gapVolume, never as its trades.
    expect(recs.map((r) => r.ts)).toEqual([t(15, 10), t(15, 29)]);
    expect(recs.at(-1)).toMatchObject({ ts: t(15, 29), traded: false, volume: 0, gapVolume: 490, close: 101, oi: 5200 });
    expect(total(recs)).toBe(500);
    // A later post-close tick adds nothing.
    expect(writer.of(FUT).filter((r) => r.gapVolume).length).toBe(1);
  });

  it('a gap ending after the close when 15:29 was already written: a gap-only 15:29 record merges into it (prices unchanged)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q26-rec-adv-'));
    dirs.push(dir);
    const store = new IntradayFiles({ dataDir: dir });
    const { tick, at, rec } = setup({ writer: store });
    tick(FUT, t(15, 29, 10), { ltp: 100, volume: 1000 });
    tick(FUT, t(15, 29, 30), { ltp: 100.5, volume: 1010 });
    at(t(15, 30, 5)); // 15:29 written
    const before = store.bars(FUT, D)[0];
    tick(FUT, t(15, 31, 5), { ltp: 100.5, volume: 1040 }); // no tick 15:29:30–15:31:05: a gap
    at(t(15, 32));
    rec.endSession();
    const bars = store.bars(FUT, D);
    expect(bars).toHaveLength(1);
    expect(bars[0]).toEqual({ ...before, gapVolume: 30 });
    expect(bars[0]).toMatchObject({ ts: t(15, 29), close: 100.5, traded: true, volume: 10 });
    expect(total(bars)).toBe(40);
  });
});

describe('restart mid-minute', () => {
  it('records of the same minute written before and after a restart merge to a partial minute; the lost units are not invented', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q26-rec-adv-'));
    dirs.push(dir);
    const store = new IntradayFiles({ dataDir: dir });
    // Process A: ticks until 11:30:05, then a graceful shutdown writes the open 11:30 minute.
    const a = setup({ writer: store });
    a.tick(FUT, t(11, 29, 10), { ltp: 100, volume: 100 });
    a.tick(FUT, t(11, 29, 50), { ltp: 100.5, volume: 110 });
    a.tick(FUT, t(11, 30, 5), { ltp: 101, volume: 120 });
    a.rec.endSession();
    // Process B starts at 11:30:20; its first tick carries the day's volume so far.
    const b = setup({ writer: store });
    b.tick(FUT, t(11, 30, 22), { ltp: 101, volume: 135 }); // 15 units traded between A's last tick and now: nobody saw them
    b.tick(FUT, t(11, 30, 40), { ltp: 101.5, volume: 140 });
    b.tick(FUT, t(11, 31, 10), { ltp: 102, volume: 150 });
    b.at(t(11, 33));
    const bars = store.bars(FUT, D);
    const m1130 = bars.find((r) => r.ts === t(11, 30))!;
    expect(m1130.partial).toBe(true); // volume is a lower bound
    expect(m1130.volume).toBe(10 + 5); // A's 10 (120-110) + B's 5 (140-135); the 15 between are in no record
    expect(bars.find((r) => r.ts === t(11, 31))!.partial).toBeUndefined();
    // The true Δ over the day so far is 50; the records hold 10 (11:29) + 15 (11:30, partial) + 10 (11:31) = 35, and say so only for 11:30.
    expect(total(bars)).toBe(35);
  });

  it('a restart exactly on a minute boundary: the baseline tick at 11:30:00.000 marks 11:30 partial (conservative), 11:31 is complete', () => {
    const { writer, tick, at } = setup();
    tick(FUT, t(11, 30, 0, 0), { ltp: 100, volume: 500 }, 0);
    tick(FUT, t(11, 30, 30), { ltp: 100, volume: 510 });
    tick(FUT, t(11, 31, 10), { ltp: 100, volume: 530 });
    at(t(11, 34));
    expect(writer.of(FUT).map((r) => [r.ts, r.volume, r.partial])).toEqual([
      [t(11, 30), 10, true],
      [t(11, 31), 20, undefined],
    ]);
  });
});

describe('ordering and clock edge cases', () => {
  it('an out-of-order older tick is not a gap and does not move the gap clock backwards', () => {
    const { writer, tick, at } = setup();
    tick(FUT, t(10, 0, 10), { ltp: 100, volume: 100 });
    tick(FUT, t(10, 1, 10), { ltp: 100, volume: 110 });
    tick(FUT, t(10, 0, 50), { ltp: 100, volume: 115 }); // late packet from the previous minute
    tick(FUT, t(10, 2, 10), { ltp: 100, volume: 120 }); // 10:01:10 → 10:02:10: no silent whole minute
    at(t(10, 5));
    const recs = writer.of(FUT);
    expect(recs.some((r) => r.gapVolume)).toBe(false);
    expect(total(recs)).toBe(20);
  });

  it('a tick stamped far in the future (clock skew) does not switch gap detection off for the rest of the day', () => {
    const { writer, tick, at } = setup();
    tick(FUT, t(10, 0, 10), { ltp: 100, volume: 100 });
    tick(FUT, t(10, 0, 20), { ltp: 100, volume: 105 });
    tick(FUT, t(14, 0, 0), { ltp: 100, volume: 105 }, t(10, 0, 20) - t(14, 0, 0)); // stamped 14:00 while the clock says 10:00:20 → state-only 'ahead'
    tick(FUT, t(10, 6, 10), { ltp: 101, volume: 205 }); // 10:01–10:05 silent: a gap
    at(t(10, 9));
    const recs = writer.of(FUT);
    expect(recs.at(-1)).toMatchObject({ ts: t(10, 6), gapVolume: 100 });
  });
});
