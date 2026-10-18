import { describe, expect, it } from 'vitest';
import { ExchangeCalendar } from '../../src/live/calendar';
import { LiveClock } from '../../src/live/clock';

const ist = (date: string, hh: number, mm: number, ss = 0): number => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm, ss) - 330 * 60_000;
};

describe('LiveClock', () => {
  const cal = new ExchangeCalendar(['2026-10-20']);
  let now = 0;
  const clock = new LiveClock(cal, () => now);

  it('follows the wall clock during the session', () => {
    now = ist('2026-10-12', 10, 30, 42);
    expect(clock.now()).toBe(now);
    expect(clock.info()).toEqual({ ts: now, date: '2026-10-12', time: '10:30', status: 'open', sessionMinute: 75 });
  });

  it('reports pre-open with sessionMinute 0', () => {
    now = ist('2026-10-12', 9, 7);
    expect(clock.info()).toMatchObject({ ts: now, time: '09:07', status: 'pre-open', sessionMinute: 0 });
  });

  it('does not pin to the last close outside hours', () => {
    now = ist('2026-10-12', 21, 5, 9);
    expect(clock.info()).toMatchObject({ ts: now, date: '2026-10-12', time: '21:05', status: 'closed', sessionMinute: 375 });
    now = ist('2026-10-11', 11, 0); // Sunday
    expect(clock.info()).toMatchObject({ ts: now, date: '2026-10-11', status: 'closed' });
    now = ist('2026-10-20', 11, 0); // holiday
    expect(clock.info()).toMatchObject({ ts: now, date: '2026-10-20', status: 'closed' });
  });

  it('uses Date.now by default', () => {
    const c = new LiveClock(cal);
    const before = Date.now();
    const t = c.now();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });
});
