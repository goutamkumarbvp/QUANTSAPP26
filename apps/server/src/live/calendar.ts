/**
 * Real exchange calendar (DESIGN.md §2): weekends plus the published holiday list. Holidays come from
 * the caller (NSE holiday master / HOLIDAYS env, nse/holidays.ts) and can be replaced at runtime.
 * Kotak has no holiday API (critic R11). Times are IST; NSE/BSE equity derivatives: pre-open
 * 09:00–09:15, continuous session 09:15–15:30.
 *
 * Not modelled: special sessions on weekends/holidays (Muhurat trading, DR drills); they run
 * outside the normal hours and are announced by circular.
 */
import {
  DAY_MS,
  IST_OFFSET_MS,
  MARKET_CLOSE_MIN,
  MARKET_OPEN_MIN,
  SESSION_MINUTES,
  isTradingDay,
  nextTradingDay,
  numToDate,
  onOrAfterTradingDay,
  onOrBeforeTradingDay,
  prevTradingDay,
  sessionTs,
  addDays,
} from '@q26/core';
import type { TradingCalendar } from './types';

/** 09:00 IST, start of the equity pre-open session. */
export const PRE_OPEN_MIN = 9 * 60;

export type SessionStatus = 'pre-open' | 'open' | 'closed';

export interface SessionPosition {
  /** IST calendar date of the timestamp. */
  date: string;
  /** Minutes since 09:15 IST (fractional), clamped to 0..375. */
  minute: number;
  status: SessionStatus;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real 'YYYY-MM-DD' calendar date (rejects 2026-02-30 and friends). */
export function isIsoDate(s: string): boolean {
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
}

function assertDate(s: string, what: string): void {
  if (!isIsoDate(s)) throw new Error(`${what}: invalid date '${s}' (expected YYYY-MM-DD)`);
}

export class ExchangeCalendar implements TradingCalendar {
  private hol: Set<string> = new Set();

  constructor(holidays: Iterable<string> = []) {
    this.setHolidays(holidays);
  }

  /** Replace the holiday set (e.g. after the yearly NSE list or an ad-hoc circular). */
  setHolidays(dates: Iterable<string>): void {
    const next = new Set<string>();
    for (const d of dates) {
      const t = d.trim();
      assertDate(t, 'holiday');
      next.add(t);
    }
    this.hol = next;
  }

  holidays(): ReadonlySet<string> {
    return this.hol;
  }

  isTradingDay(date: string): boolean {
    assertDate(date, 'isTradingDay');
    return isTradingDay(date, this.hol);
  }

  prev(date: string): string {
    assertDate(date, 'prev');
    return prevTradingDay(date, this.hol);
  }

  next(date: string): string {
    assertDate(date, 'next');
    return nextTradingDay(date, this.hol);
  }

  /** `date` when it is a trading day, else the previous trading day. */
  onOrBefore(date: string): string {
    assertDate(date, 'onOrBefore');
    return onOrBeforeTradingDay(date, this.hol);
  }

  /** `date` when it is a trading day, else the next trading day. */
  onOrAfter(date: string): string {
    assertDate(date, 'onOrAfter');
    return onOrAfterTradingDay(date, this.hol);
  }

  sessions(from: string, to: string): string[] {
    assertDate(from, 'sessions');
    assertDate(to, 'sessions');
    const out: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) if (isTradingDay(d, this.hol)) out.push(d);
    return out;
  }

  /**
   * IST session position of a timestamp. The minute is computed from the wall-clock time on any day;
   * on weekends and holidays the status is always 'closed'.
   */
  session(ts: number): SessionPosition {
    const shifted = ts + IST_OFFSET_MS;
    const dayNum = Math.floor(shifted / DAY_MS);
    const minuteOfDay = (shifted - dayNum * DAY_MS) / 60_000;
    const date = numToDate(dayNum);
    const minute = Math.min(SESSION_MINUTES, Math.max(0, minuteOfDay - MARKET_OPEN_MIN));
    let status: SessionStatus = 'closed';
    if (isTradingDay(date, this.hol)) {
      if (minuteOfDay >= MARKET_OPEN_MIN && minuteOfDay < MARKET_CLOSE_MIN) status = 'open';
      else if (minuteOfDay >= PRE_OPEN_MIN && minuteOfDay < MARKET_OPEN_MIN) status = 'pre-open';
    }
    return { date, minute, status };
  }

  /** Epoch ms of `minute` (may be fractional) minutes after 09:15 IST on `date`. */
  ts(date: string, minute: number): number {
    assertDate(date, 'ts');
    return sessionTs(date, minute);
  }
}
