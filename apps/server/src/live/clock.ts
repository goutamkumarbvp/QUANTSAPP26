/**
 * Live session clock (DESIGN.md §2): the real wall clock in IST, nothing else. There is no demo mode
 * and no pinning to the last close: outside market hours `ts` is still "now" and the status says
 * 'closed' / 'pre-open'.
 */
import { formatTimeIST, type MarketClockInfo } from '@q26/core';
import type { SessionClock, TradingCalendar } from './types';

export class LiveClock implements SessionClock {
  constructor(
    private readonly calendar: TradingCalendar,
    /** Wall clock (epoch ms); injectable for tests. */
    private readonly wall: () => number = () => Date.now(),
    /** MCX calendar, reported as `mcxStatus` while `hasMcx()` (commodities are listed). */
    private readonly mcx?: { calendar: TradingCalendar; hasMcx: () => boolean },
  ) {}

  now(): number {
    return this.wall();
  }

  info(): MarketClockInfo {
    const ts = this.wall();
    const s = this.calendar.session(ts);
    return {
      ts,
      date: s.date,
      time: formatTimeIST(ts),
      status: s.status,
      // Whole minutes since 09:15, clamped to 0..375 by the calendar.
      sessionMinute: Math.floor(s.minute),
      ...(this.mcx?.hasMcx() ? { mcxStatus: this.mcx.calendar.session(ts).status } : {}),
    };
  }
}
