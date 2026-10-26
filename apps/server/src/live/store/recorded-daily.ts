/**
 * End-of-day rows of MCX commodities, built from this app's own recorded live ticks.
 *
 * The app loads official end-of-day files for NSE/BSE only. For MCX the previous-session values every
 * tab needs (previous close, previous OI → OI change and build-up, daily PCR, ATM IV history, HV)
 * come from the minutes the recorder wrote from live Kotak ticks of that session:
 *   - close  = the last TRADED minute's close of the session (the session's last trade price);
 *   - oi     = the OI recorded with the session's last minute;
 *   - volume = the sum of recorded minute volumes (a lower bound: what the app saw), used to tell a
 *              traded contract from an untraded one;
 *   - a contract without a recorded OI has no row (its OI is never written as 0);
 *   - a daily BAR (open/high/low/close of the commodity price = its near-month future) only for a
 *     session recorded from its open to its close (within RECORDED_SLACK_MIN), so its open/high/low
 *     are the session's, not of a partial recording.
 * A session the app did not record has no row (blank with the reason), never an estimate. NSE/BSE
 * symbols are served by the official store unchanged.
 */
import type { ExchangeCode, FiiDiiDay, ParticipantDay } from '@q26/core';
import type { DailyBar, DailyFuture, DailyOption, HistoryStore, InstrumentKey, IntradayStore, MinuteRecord, TradingCalendar } from '../types';
import { eodAtmIv } from './history';

/** A recording counts as covering the open / close when it is at most this many minutes off. */
export const RECORDED_SLACK_MIN = 15;
const MINUTE = 60_000;

const isPos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export interface RecordedDailyOptions {
  base: HistoryStore;
  intraday: IntradayStore;
  /** True for MCX commodities (served from recordings); false: the official store. */
  isRecorded: (symbol: string) => boolean;
  /** MCX calendar (sessions, open/close). */
  calendar: TradingCalendar;
  r: number;
  /** Today (IST): its rows change while it is recorded and are not cached. */
  today: () => string;
}

interface DayRows {
  futures: DailyFuture[];
  options: DailyOption[];
  bar: DailyBar | null;
}

export class RecordedDailyHistory implements HistoryStore {
  private readonly days = new Map<string, DayRows>();
  private readonly ivs = new Map<string, { date: string; iv: number; expiry: string } | null>();

  constructor(private readonly o: RecordedDailyOptions) {}

  /** Rows of one symbol and session from its recorded minutes (cached for past sessions). */
  private day(symbol: string, date: string): DayRows {
    const id = `${symbol}|${date}`;
    const hit = this.days.get(id);
    if (hit) return hit;
    const rows = this.build(symbol, date);
    if (date < this.o.today()) {
      this.days.set(id, rows);
      while (this.days.size > 4000) this.days.delete(this.days.keys().next().value as string);
    }
    return rows;
  }

  private build(symbol: string, date: string): DayRows {
    const out: DayRows = { futures: [], options: [], bar: null };
    if (!this.o.calendar.isTradingDay(date)) return out;
    let keys: InstrumentKey[];
    try {
      keys = this.o.intraday.recordedKeys(date).filter((k) => k.symbol === symbol);
    } catch {
      return out;
    }
    for (const key of keys) {
      if (key.kind === 'SPOT' || !key.expiry) continue;
      const recs = this.o.intraday.bars(key, date);
      const row = closeOf(recs);
      // A row needs a recorded OI (an unseen OI is never written as 0).
      if (!row || row.oi === undefined) continue;
      if (key.kind === 'FUT') out.futures.push({ date, expiry: key.expiry, close: row.close, oi: row.oi, volume: row.volume });
      else if (key.strike !== undefined) out.options.push({ date, expiry: key.expiry, strike: key.strike, type: key.kind, close: row.close, oi: row.oi, volume: row.volume });
    }
    // The commodity's daily bar: its near-month future (the intraday store resolves SPOT to it).
    const spot = this.o.intraday.bars({ symbol, kind: 'SPOT' }, date).filter((r) => r.traded).sort((a, b) => a.ts - b.ts);
    if (spot.length) {
      const open = this.o.calendar.ts(date, 0);
      const close = this.o.calendar.ts(date, this.o.calendar.sessionMinutes(date));
      const fromOpen = spot[0].ts <= open + RECORDED_SLACK_MIN * MINUTE;
      const toClose = spot[spot.length - 1].ts + MINUTE >= close - RECORDED_SLACK_MIN * MINUTE;
      if (fromOpen && toClose) {
        let hi = -Infinity;
        let lo = Infinity;
        let vol = 0;
        let hasVol = false;
        for (const r of spot) {
          hi = Math.max(hi, r.high);
          lo = Math.min(lo, r.low);
          if (isNum(r.volume)) {
            vol += r.volume;
            hasVol = true;
          }
        }
        out.bar = { date, open: spot[0].open, high: hi, low: lo, close: spot[spot.length - 1].close, ...(hasVol ? { volume: vol } : {}) };
      }
    }
    return out;
  }

  private sessions(from: string, to: string): string[] {
    try {
      return this.o.calendar.sessions(from, to);
    } catch {
      return [];
    }
  }

  dailyBars(symbol: string, from: string, to: string): DailyBar[] {
    if (!this.o.isRecorded(symbol)) return this.o.base.dailyBars(symbol, from, to);
    return this.sessions(from, to)
      .map((d) => this.day(symbol, d).bar)
      .filter((b): b is DailyBar => b !== null)
      .map((b) => ({ ...b }));
  }

  dailyFutures(symbol: string, from: string, to: string): DailyFuture[] {
    if (!this.o.isRecorded(symbol)) return this.o.base.dailyFutures(symbol, from, to);
    return this.sessions(from, to).flatMap((d) => this.day(symbol, d).futures.map((f) => ({ ...f })));
  }

  dailyOptions(symbol: string, date: string, expiry?: string): DailyOption[] {
    if (!this.o.isRecorded(symbol)) return this.o.base.dailyOptions(symbol, date, expiry);
    return this.day(symbol, date)
      .options.filter((o) => expiry === undefined || o.expiry === expiry)
      .map((o) => ({ ...o }));
  }

  dailyAtmIv(symbol: string, from: string, to: string): { date: string; iv: number; expiry: string }[] {
    if (!this.o.isRecorded(symbol)) return this.o.base.dailyAtmIv(symbol, from, to);
    const out: { date: string; iv: number; expiry: string }[] = [];
    const exchange: ExchangeCode = this.o.calendar.exchange;
    for (const date of this.sessions(from, to)) {
      const id = `${symbol}|${date}`;
      let v = this.ivs.get(id);
      if (v === undefined) {
        const d = this.day(symbol, date);
        const res = d.options.length ? eodAtmIv({ date, underlying: d.bar?.close, options: d.options, futures: d.futures, r: this.o.r, exchange }) : null;
        v = res ? { date, iv: res.iv, expiry: res.expiry } : null;
        if (date < this.o.today()) this.ivs.set(id, v);
      }
      if (v) out.push({ ...v });
    }
    return out;
  }

  fiiDii(from: string, to: string): FiiDiiDay[] {
    return this.o.base.fiiDii(from, to);
  }

  participantOi(from: string, to: string): ParticipantDay[] {
    return this.o.base.participantOi(from, to);
  }

  settlement(key: InstrumentKey): number | undefined {
    return this.o.isRecorded(key.symbol) ? undefined : this.o.base.settlement(key);
  }

  loadedDates(kind: 'fo' | 'cm' | 'index' | 'participants' | 'fiidii'): string[] {
    return this.o.base.loadedDates(kind);
  }
}

/** The session's last trade (last traded minute's close), its last OI and recorded volume; null when it never traded. */
function closeOf(recs: readonly MinuteRecord[]): { close: number; oi?: number; volume: number } | null {
  if (!recs.length) return null;
  const sorted = [...recs].sort((a, b) => a.ts - b.ts);
  let close: number | undefined;
  let volume = 0;
  for (const r of sorted) {
    if (r.traded && isPos(r.close)) close = r.close;
    if (isNum(r.volume)) volume += r.volume;
  }
  if (close === undefined) return null;
  let oi: number | undefined;
  for (let i = sorted.length - 1; i >= 0 && oi === undefined; i--) if (isNum(sorted[i].oi)) oi = sorted[i].oi;
  return { close, ...(oi !== undefined ? { oi } : {}), volume };
}
