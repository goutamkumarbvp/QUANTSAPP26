/**
 * IST trading-calendar helpers. Dates are 'YYYY-MM-DD' strings in IST;
 * timestamps are epoch milliseconds (UTC).
 */

export const IST_OFFSET_MS = 330 * 60 * 1000;
export const DAY_MS = 86_400_000;
export const MARKET_OPEN_MIN = 9 * 60 + 15; // 09:15
export const MARKET_CLOSE_MIN = 15 * 60 + 30; // 15:30
export const SESSION_MINUTES = MARKET_CLOSE_MIN - MARKET_OPEN_MIN; // 375
export const YEAR_MS = 365 * DAY_MS;

/** Exchanges the app takes data from. */
export type ExchangeCode = 'NSE' | 'BSE' | 'MCX';

/** 09:00 IST, MCX (commodity) open. */
export const MCX_OPEN_MIN = 9 * 60;
/** MCX close while the US observes daylight saving time (mid-March to early November). */
export const MCX_CLOSE_SUMMER_MIN = 23 * 60 + 30;
/** MCX close while the US is on standard time (early November to mid-March). */
export const MCX_CLOSE_WINTER_MIN = 23 * 60 + 55;

/** n-th Sunday (1-based) of a month, 'YYYY-MM-DD'. */
function nthSunday(year: number, month: number, n: number): string {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const offset = (7 - weekday(first)) % 7;
  return addDays(first, offset + 7 * (n - 1));
}

/**
 * MCX close (minute of the IST day) on `date`: 23:30 while the US observes daylight saving time
 * (second Sunday of March to first Sunday of November), else 23:55 (MCX's published timings follow
 * the US switch from the next Indian session).
 */
export function mcxCloseMin(date: string): number {
  const y = Number(date.slice(0, 4));
  let dst = US_DST.get(y);
  if (!dst) US_DST.set(y, (dst = [nthSunday(y, 3, 2), nthSunday(y, 11, 1)]));
  return date > dst[0] && date <= dst[1] ? MCX_CLOSE_SUMMER_MIN : MCX_CLOSE_WINTER_MIN;
}

/** US daylight-saving bounds per year (they never change once computed). */
const US_DST = new Map<number, [string, string]>();

/** Continuous-session hours (minutes of the IST day) of an exchange on `date`. */
export function sessionHoursOf(exchange: ExchangeCode, date: string): { open: number; close: number } {
  return exchange === 'MCX' ? { open: MCX_OPEN_MIN, close: mcxCloseMin(date) } : { open: MARKET_OPEN_MIN, close: MARKET_CLOSE_MIN };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/*
 * Date ↔ day-number conversions run for every quote, strike and session the services look at (the same
 * few hundred dates, thousands of times per request), so both directions are memoised. The caches are
 * bounded: when one reaches DATE_CACHE_MAX entries it is cleared and refills with the dates in use.
 */
const DATE_CACHE_MAX = 50_000;
const dayNums = new Map<string, number>();
const dayDates = new Map<number, string>();

export function dateToNum(date: string): number {
  let n = dayNums.get(date);
  if (n === undefined) {
    const [y, m, d] = date.split('-').map(Number);
    n = Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
    if (dayNums.size >= DATE_CACHE_MAX) dayNums.clear();
    dayNums.set(date, n);
  }
  return n;
}

export function numToDate(n: number): string {
  let date = dayDates.get(n);
  if (date === undefined) {
    date = new Date(n * DAY_MS).toISOString().slice(0, 10);
    if (dayDates.size >= DATE_CACHE_MAX) dayDates.clear();
    dayDates.set(n, date);
  }
  return date;
}

export function addDays(date: string, n: number): string {
  return numToDate(dateToNum(date) + n);
}

/** 0 = Sunday … 6 = Saturday */
export function weekday(date: string): number {
  return (dateToNum(date) + 4) % 7; // 1970-01-01 was a Thursday
}

export function isWeekend(date: string): boolean {
  const w = weekday(date);
  return w === 0 || w === 6;
}

export type HolidaySet = ReadonlySet<string>;
const NO_HOLIDAYS: HolidaySet = new Set();

export function isTradingDay(date: string, holidays: HolidaySet = NO_HOLIDAYS): boolean {
  return !isWeekend(date) && !holidays.has(date);
}

export function nextTradingDay(date: string, holidays: HolidaySet = NO_HOLIDAYS): string {
  let d = addDays(date, 1);
  while (!isTradingDay(d, holidays)) d = addDays(d, 1);
  return d;
}

export function prevTradingDay(date: string, holidays: HolidaySet = NO_HOLIDAYS): string {
  let d = addDays(date, -1);
  while (!isTradingDay(d, holidays)) d = addDays(d, -1);
  return d;
}

/** Same day if trading, else the previous trading day. */
export function onOrBeforeTradingDay(date: string, holidays: HolidaySet = NO_HOLIDAYS): string {
  return isTradingDay(date, holidays) ? date : prevTradingDay(date, holidays);
}

export function onOrAfterTradingDay(date: string, holidays: HolidaySet = NO_HOLIDAYS): string {
  return isTradingDay(date, holidays) ? date : nextTradingDay(date, holidays);
}

/** Trading days in (from, to] — positive when `to` is after `from`. */
export function tradingDaysBetween(from: string, to: string, holidays: HolidaySet = NO_HOLIDAYS): number {
  const a = dateToNum(from);
  const b = dateToNum(to);
  const sign = b >= a ? 1 : -1;
  let count = 0;
  for (let n = Math.min(a, b) + 1; n <= Math.max(a, b); n++) {
    if (isTradingDay(numToDate(n), holidays)) count++;
  }
  return sign * count;
}

export function tradingDaysBack(date: string, count: number, holidays: HolidaySet = NO_HOLIDAYS): string[] {
  const out: string[] = [];
  let d = onOrBeforeTradingDay(date, holidays);
  while (out.length < count) {
    out.push(d);
    d = prevTradingDay(d, holidays);
  }
  return out.reverse();
}

/** Epoch ms for an IST wall-clock time on `date`. */
export function istTs(date: string, minuteOfDay: number, second = 0): number {
  return dateToNum(date) * DAY_MS + minuteOfDay * 60_000 + second * 1000 - IST_OFFSET_MS;
}

/** Epoch ms for `minute` minutes after the 09:15 open. */
export function sessionTs(date: string, sessionMinute: number, second = 0): number {
  return istTs(date, MARKET_OPEN_MIN + sessionMinute, second);
}

export interface IstParts {
  date: string;
  minuteOfDay: number;
  second: number;
}

export function istParts(ts: number): IstParts {
  const shifted = ts + IST_OFFSET_MS;
  const dayNum = Math.floor(shifted / DAY_MS);
  const msInDay = shifted - dayNum * DAY_MS;
  return {
    date: numToDate(dayNum),
    minuteOfDay: Math.floor(msInDay / 60_000),
    second: Math.floor((msInDay % 60_000) / 1000),
  };
}

/** Expiry instant: the close of the expiry day (15:30 IST for NSE/BSE, the MCX close for MCX). */
export function expiryTs(expiry: string, exchange: ExchangeCode = 'NSE'): number {
  return istTs(expiry, sessionHoursOf(exchange, expiry).close);
}

export function yearsBetween(fromTs: number, toTs: number): number {
  return Math.max(0, (toTs - fromTs) / YEAR_MS);
}

export function daysToExpiry(nowTs: number, expiry: string, exchange: ExchangeCode = 'NSE'): number {
  return Math.max(0, (expiryTs(expiry, exchange) - nowTs) / DAY_MS);
}

export function formatDate(date: string, withYear = false): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]}${withYear ? ` ${y}` : ''}`;
}

export function formatExpiry(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return `${String(d).padStart(2, '0')}-${MONTHS[m - 1]}-${String(y).slice(2)}`;
}

export function formatTimeIST(ts: number, withSeconds = false): string {
  const p = istParts(ts);
  const hh = String(Math.floor(p.minuteOfDay / 60)).padStart(2, '0');
  const mm = String(p.minuteOfDay % 60).padStart(2, '0');
  return withSeconds ? `${hh}:${mm}:${String(p.second).padStart(2, '0')}` : `${hh}:${mm}`;
}

export function sessionMinuteLabel(sessionMinute: number): string {
  const m = MARKET_OPEN_MIN + sessionMinute;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
