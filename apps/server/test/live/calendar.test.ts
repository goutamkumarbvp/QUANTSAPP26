import { describe, expect, it } from 'vitest';
import { ExchangeCalendar, isIsoDate } from '../../src/live/calendar';

/** Epoch ms of an IST wall-clock time. */
const ist = (date: string, hh: number, mm: number, ss = 0, ms = 0): number => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh, mm, ss, ms) - 330 * 60_000;
};

// 2026-10-09 Fri, 10-10 Sat, 10-11 Sun, 10-12 Mon, 10-13 Tue; holidays given by the caller.
const HOLIDAYS = ['2026-10-02', '2026-10-20'];

describe('ExchangeCalendar', () => {
  const cal = new ExchangeCalendar(HOLIDAYS);

  it('treats weekends and listed holidays as non-trading days', () => {
    expect(cal.isTradingDay('2026-10-12')).toBe(true);
    expect(cal.isTradingDay('2026-10-10')).toBe(false); // Saturday
    expect(cal.isTradingDay('2026-10-11')).toBe(false); // Sunday
    expect(cal.isTradingDay('2026-10-02')).toBe(false); // holiday (Friday)
    expect(cal.isTradingDay('2026-10-20')).toBe(false); // holiday (Tuesday)
  });

  it('steps over weekends and holidays with prev/next', () => {
    expect(cal.prev('2026-10-12')).toBe('2026-10-09');
    expect(cal.next('2026-10-09')).toBe('2026-10-12');
    expect(cal.prev('2026-10-05')).toBe('2026-10-01'); // skips the weekend and the 2nd
    expect(cal.next('2026-10-19')).toBe('2026-10-21');
    expect(cal.onOrBefore('2026-10-11')).toBe('2026-10-09');
    expect(cal.onOrAfter('2026-10-11')).toBe('2026-10-12');
    expect(cal.onOrBefore('2026-10-12')).toBe('2026-10-12');
  });

  it('lists sessions in an inclusive range', () => {
    expect(cal.sessions('2026-10-01', '2026-10-06')).toEqual(['2026-10-01', '2026-10-05', '2026-10-06']);
    expect(cal.sessions('2026-10-10', '2026-10-11')).toEqual([]);
    expect(cal.sessions('2026-10-12', '2026-10-09')).toEqual([]);
  });

  it('classifies pre-open, open and closed in IST', () => {
    const d = '2026-10-12';
    expect(cal.session(ist(d, 8, 59, 59, 999))).toEqual({ date: d, minute: 0, status: 'closed' });
    expect(cal.session(ist(d, 9, 0))).toEqual({ date: d, minute: 0, status: 'pre-open' });
    expect(cal.session(ist(d, 9, 14, 59, 999)).status).toBe('pre-open');
    expect(cal.session(ist(d, 9, 15))).toEqual({ date: d, minute: 0, status: 'open' });
    expect(cal.session(ist(d, 10, 0, 30))).toEqual({ date: d, minute: 45.5, status: 'open' });
    expect(cal.session(ist(d, 15, 29, 30))).toEqual({ date: d, minute: 374.5, status: 'open' });
    expect(cal.session(ist(d, 15, 30))).toEqual({ date: d, minute: 375, status: 'closed' });
    expect(cal.session(ist(d, 20, 0))).toEqual({ date: d, minute: 375, status: 'closed' });
  });

  it('is closed all day on weekends and holidays', () => {
    expect(cal.session(ist('2026-10-10', 10, 0)).status).toBe('closed');
    expect(cal.session(ist('2026-10-20', 9, 5)).status).toBe('closed');
    expect(cal.session(ist('2026-10-20', 11, 0))).toEqual({ date: '2026-10-20', minute: 105, status: 'closed' });
  });

  it('converts UTC instants to the IST date (05:30 offset, across midnight)', () => {
    // 2026-10-12 18:29:59 UTC = 23:59:59 IST on the 12th; 18:30 UTC = 00:00 IST on the 13th.
    expect(cal.session(Date.UTC(2026, 9, 12, 18, 29, 59)).date).toBe('2026-10-12');
    expect(cal.session(Date.UTC(2026, 9, 12, 18, 30, 0)).date).toBe('2026-10-13');
    // 03:45 UTC is the 09:15 IST open.
    expect(cal.session(Date.UTC(2026, 9, 13, 3, 45)).status).toBe('open');
    expect(cal.session(Date.UTC(2026, 9, 13, 3, 44, 59)).status).toBe('pre-open');
  });

  it('maps (date, minute) to epoch ms and back', () => {
    expect(cal.ts('2026-10-12', 0)).toBe(ist('2026-10-12', 9, 15));
    expect(cal.ts('2026-10-12', 375)).toBe(ist('2026-10-12', 15, 30));
    expect(cal.ts('2026-10-12', 45.5)).toBe(ist('2026-10-12', 10, 0, 30));
    for (const m of [0, 1, 74, 374]) expect(cal.session(cal.ts('2026-10-12', m)).minute).toBe(m);
  });

  it('updates holidays at runtime and validates dates', () => {
    const c = new ExchangeCalendar();
    expect(c.isTradingDay('2026-10-20')).toBe(true);
    c.setHolidays(['2026-10-20']);
    expect(c.isTradingDay('2026-10-20')).toBe(false);
    expect(c.holidays().has('2026-10-20')).toBe(true);
    expect(() => c.setHolidays(['2026-02-30'])).toThrow(/invalid date/);
    expect(() => c.isTradingDay('12-10-2026')).toThrow(/invalid date/);
    expect(isIsoDate('2026-02-28')).toBe(true);
    expect(isIsoDate('2026-13-01')).toBe(false);
  });
});
