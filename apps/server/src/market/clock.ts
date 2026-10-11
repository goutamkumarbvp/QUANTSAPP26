/**
 * Market clock.
 *  - demo: an always-open simulated session that advances at `speed`× real time and
 *          rolls to the next trading day at 15:30.
 *  - live: follows the real IST wall clock; outside market hours the "as-of" time is
 *          the last session close (like a real terminal after hours).
 */
import {
  istParts,
  isTradingDay,
  MARKET_CLOSE_MIN,
  MARKET_OPEN_MIN,
  nextTradingDay,
  onOrBeforeTradingDay,
  prevTradingDay,
  SESSION_MINUTES,
  sessionMinuteLabel,
  sessionTs,
  type HolidaySet,
  type MarketClockInfo,
} from '@q26/core';

const SESSION_SECONDS = SESSION_MINUTES * 60;

export interface ClockOptions {
  mode: 'demo' | 'live';
  speed: number;
  holidays: HolidaySet;
  /** demo start "YYYY-MM-DDTHH:MM" (IST). */
  start?: string;
  /** Injectable wall clock for tests. */
  now?: () => number;
}

export class MarketClock {
  private readonly bootReal: number;
  private readonly startDate: string;
  private readonly startSec: number;
  private readonly realNow: () => number;

  constructor(private readonly opts: ClockOptions) {
    this.realNow = opts.now ?? (() => Date.now());
    this.bootReal = this.realNow();
    if (opts.start) {
      const [d, t = '10:30'] = opts.start.split('T');
      const [hh, mm] = t.split(':').map(Number);
      this.startDate = onOrBeforeTradingDay(d, opts.holidays);
      this.startSec = Math.min(SESSION_SECONDS - 60, Math.max(0, (hh * 60 + mm - MARKET_OPEN_MIN) * 60));
    } else {
      const p = istParts(this.bootReal);
      const inSession = isTradingDay(p.date, opts.holidays) && p.minuteOfDay >= MARKET_OPEN_MIN && p.minuteOfDay < MARKET_CLOSE_MIN;
      this.startDate = onOrBeforeTradingDay(p.date, opts.holidays);
      this.startSec = inSession ? (p.minuteOfDay - MARKET_OPEN_MIN) * 60 + p.second : 75 * 60; // 10:30
    }
  }

  get mode() {
    return this.opts.mode;
  }

  get holidays() {
    return this.opts.holidays;
  }

  /** Current market timestamp (epoch ms) that all data is computed "as of". */
  now(): number {
    return this.info().ts;
  }

  info(): MarketClockInfo {
    if (this.opts.mode === 'live') return this.liveInfo();
    const elapsed = ((this.realNow() - this.bootReal) / 1000) * this.opts.speed;
    let total = this.startSec + elapsed;
    let date = this.startDate;
    while (total >= SESSION_SECONDS) {
      total -= SESSION_SECONDS;
      date = nextTradingDay(date, this.opts.holidays);
    }
    const sec = Math.floor(total);
    const ts = sessionTs(date, 0, 0) + Math.floor(total * 1000);
    const sessionMinute = Math.floor(sec / 60);
    return { ts, date, time: sessionMinuteLabel(sessionMinute), status: 'open', sessionMinute, mode: 'demo', speed: this.opts.speed };
  }

  private liveInfo(): MarketClockInfo {
    const real = this.realNow();
    const p = istParts(real);
    const h = this.opts.holidays;
    const base = { mode: 'live' as const, speed: 1 };
    if (isTradingDay(p.date, h) && p.minuteOfDay >= MARKET_OPEN_MIN && p.minuteOfDay < MARKET_CLOSE_MIN) {
      const sessionMinute = p.minuteOfDay - MARKET_OPEN_MIN;
      return { ...base, ts: real, date: p.date, time: sessionMinuteLabel(sessionMinute), status: 'open', sessionMinute };
    }
    let date: string;
    let status: MarketClockInfo['status'] = 'closed';
    if (isTradingDay(p.date, h) && p.minuteOfDay >= MARKET_CLOSE_MIN) date = p.date;
    else {
      date = isTradingDay(p.date, h) ? prevTradingDay(p.date, h) : onOrBeforeTradingDay(p.date, h);
      if (isTradingDay(p.date, h) && p.minuteOfDay >= 9 * 60) status = 'pre-open';
    }
    return { ...base, ts: sessionTs(date, SESSION_MINUTES), date, time: '15:30', status, sessionMinute: SESSION_MINUTES };
  }
}
