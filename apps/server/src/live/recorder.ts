/**
 * Recorder (DESIGN.md §1.3, app-dependency-map.md §12): turns live ticks into per-minute records
 * and per-minute chain aggregates in the intraday store. It records only what it sees: a minute
 * without ticks is not written (gaps stay gaps), the first tick of an instrument only sets the
 * cumulative-volume baseline, and nothing is carried into minutes that had no ticks.
 *
 * Per instrument and minute:
 *  - OHLC from LTP: once the minute has a trade, from its trades only (the quote-only ticks before the
 *    first trade repeated an earlier minute's price; a minute without trades keeps that last price,
 *    with traded false); volume = Δ cumulative session volume between ticks (decreases ignored; the
 *    baseline is the highest volume seen today, so out-of-order packets are not double counted),
 *    absent for instruments whose feed carries no volume (index spots);
 *  - traded = at least one trade in the minute: a positive Δvolume, or a last-trade time newer than
 *    any seen before that falls in the minute (index packets: a new index time). A trade time of an
 *    earlier minute marks that minute only while it is still open. Quote-only minutes (bid/ask/OI
 *    moved, no trade) are still written, with traded false;
 *  - oi / bid / ask / total buy & sell qty / ATP = last value seen; bidQty / askQty = the level-1
 *    quantities reported with that bid / ask (absent when that update carried none);
 *  - each positive Δvolume is classified with the quote rule against the bid/ask seen BEFORE the
 *    tick: LTP ≥ ask → buy, LTP ≤ bid → sell, else (or no sane bid/ask) unclassified. This is an
 *    estimate, and only meaningful if the feed is per trade (critic U4);
 *  - feed gaps: when the instrument's previous tick is older than the start of the previous minute
 *    (counted from the open), the Δvolume of the first tick after it traded at an unknown time in the
 *    gap: it is booked as `gapVolume` (never as the minute's volume, never classified, and it does
 *    not make the minute traded), so Σ(volume + gapVolume) still reconciles with the cumulative volume;
 *  - a volume baseline set after the open with volume already traded (restart, late subscription)
 *    marks that minute `partial`: its volume is a lower bound.
 * Minute bucket = the tick's exchange timestamp (critic U7: LUT/LTT, epoch seconds on the wire).
 * Ticks dated another day, outside 09:15–15:30, without a price, whose LTT is another day or whose
 * session volume is still 0 after the open (no trade yet today), or whose timestamp is further than
 * maxLag/maxLead from the clock (re-sent snapshots, skew) update state only. A tick for a minute
 * that was already written is folded into the next open minute instead of rewriting history.
 */
import { maxPain } from '@q26/core';
import { chainAtmIv } from './pricing';
import type { IntradayWriter, LiveBarSource } from './store/intraday';
import { keyId } from './types';
import type { ChainMinute, ChainRowLive, InstrumentKey, LiveMarket, LiveQuote, MinuteRecord, Pricing, RawChain, ReferenceData, SessionClock, TickMeta, TradingCalendar } from './types';

const MINUTE_MS = 60_000;

export interface RecorderTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface RecorderOptions {
  live: Pick<LiveMarket, 'onTick'> & Partial<Pick<LiveMarket, 'quote'>>;
  writer: IntradayWriter;
  /** Only `r` is used: ATM IV is solved on the recorded minute-close premiums (pricing.chainAtmIv). */
  pricing: Pick<Pricing, 'r'>;
  calendar: TradingCalendar;
  /** Calendar of a symbol's exchange (MCX for commodities: 09:00–23:30/23:55); default `calendar`. */
  calendarOf?: (symbol: string) => TradingCalendar;
  clock: SessionClock;
  /**
   * Listed strikes for the ATM strike (strikes seen in ticks when absent / not loaded); the instrument
   * a commodity's SPOT is read from and the future its options are written on (MCX).
   */
  ref?: Partial<Pick<ReferenceData, 'strikes' | 'quoteKey' | 'underlyingFuture'>>;
  /** Flush poll interval, default 1,000 ms. */
  flushIntervalMs?: number;
  /** The timer writes a minute once the clock is this far past its end, default 1,500 ms. */
  graceMs?: number;
  /** Ticks older than clock − maxLagMs are state-only, default 60 s. */
  maxLagMs?: number;
  /** Ticks newer than clock + maxLeadMs are state-only, default 60 s. */
  maxLeadMs?: number;
  timers?: RecorderTimers;
  onError?: (e: unknown) => void;
}

export interface RecorderStats {
  date: string | null;
  instruments: number;
  openBars: number;
  minutesWritten: number;
  chainMinutesWritten: number;
  /** Ticks that updated state only, by reason. */
  stateOnly: { otherDate: number; outsideSession: number; noPrice: number; oldTrade: number; stale: number; ahead: number };
  /** Chain minutes not written, by reason (noOi: no OI yet on the CE or the PE side). */
  chainSkipped: { noSpot: number; noOi: number };
  writeErrors: number;
  lastError?: string;
}

export interface SessionSummary {
  date: string;
  instruments: number;
  minutesWritten: number;
  chainMinutesWritten: number;
}

/** Latest known values at the end of a clock minute (for chain aggregates). */
interface Snap {
  m: number;
  ltp?: number;
  oi?: number;
  vol?: number;
}

interface Inst {
  key: InstrumentKey;
  id: string;
  bar: MinuteRecord | null;
  /** ts of the last written minute. */
  lastWritten: number;
  /** Close of the last written minute. */
  lastClose?: number;
  /** Highest cumulative volume seen today (baseline). */
  cumVol?: number;
  tracksVolume: boolean;
  /** Latest tick timestamp seen today (feed-gap detection). */
  lastTs?: number;
  /** Minute in which the volume baseline was set after the open with volume already traded (that minute is `partial`). */
  baseMinute?: number;
  /** Δvolume of the first tick after a feed gap, not yet put on a minute (MinuteRecord.gapVolume). */
  pendingGap: number;
  /** Latest last-trade time seen today (epoch ms). */
  lastLtt?: number;
  ltp?: number;
  oi?: number;
  bid?: number;
  ask?: number;
  /** Level-1 quantities reported with the latest bid / ask (undefined when that update carried none). */
  bidQty?: number;
  askQty?: number;
  totalBuyQty?: number;
  totalSellQty?: number;
  atp?: number;
  snaps: Snap[];
}

interface ChainReg {
  symbol: string;
  expiry: string;
  options: Set<Inst>;
  /** Start of the last chain minute written. */
  lastTs: number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPos = (v: unknown): v is number => isNum(v) && v > 0;
const minuteOf = (ts: number): number => Math.floor(ts / MINUTE_MS) * MINUTE_MS;

const realTimers: RecorderTimers = {
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    h.unref?.();
    return h;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export class Recorder implements LiveBarSource {
  private readonly insts = new Map<string, Inst>();
  private readonly chains = new Map<string, ChainReg>();
  /** Chains registered with trackChain(); they survive day resets. */
  private readonly tracked = new Map<string, { symbol: string; expiry: string }>();
  private date: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private timer: unknown = null;
  private readonly graceMs: number;
  private readonly maxLagMs: number;
  private readonly maxLeadMs: number;
  private readonly timers: RecorderTimers;
  private readonly st: RecorderStats = {
    date: null,
    instruments: 0,
    openBars: 0,
    minutesWritten: 0,
    chainMinutesWritten: 0,
    stateOnly: { otherDate: 0, outsideSession: 0, noPrice: 0, oldTrade: 0, stale: 0, ahead: 0 },
    chainSkipped: { noSpot: 0, noOi: 0 },
    writeErrors: 0,
  };
  private sessionWritten = { minutes: 0, chains: 0 };

  constructor(private readonly opts: RecorderOptions) {
    this.graceMs = opts.graceMs ?? 1500;
    this.maxLagMs = opts.maxLagMs ?? 60_000;
    this.maxLeadMs = opts.maxLeadMs ?? 60_000;
    this.timers = opts.timers ?? realTimers;
  }

  /* ---------------------------------- lifecycle ---------------------------------- */

  /** Subscribe to ticks and start the flush timer (idempotent). */
  start(): void {
    if (!this.unsubscribe) this.unsubscribe = this.opts.live.onTick((q, meta) => this.onTick(q, meta));
    if (this.timer === null) this.timer = this.timers.setInterval(() => this.flushDue(), this.opts.flushIntervalMs ?? 1000);
  }

  /** Write everything in progress (a partial minute is merged with its continuation on read) and detach. */
  stop(): SessionSummary | null {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
    return this.date ? this.endSession() : null;
  }

  /**
   * Session-open hook (~09:00 IST): ends a previous date still open, resets per-day state, applies
   * store retention and starts recording. Calling it again for the active date is a no-op.
   */
  startSession(date?: string): void {
    const d = date ?? this.opts.calendar.session(this.opts.clock.now()).date;
    if (this.date !== d) {
      if (this.date) this.endSession();
      this.resetDay(d);
    }
    try {
      this.opts.writer.prune?.(d);
    } catch (e) {
      this.fail(e);
    }
    this.start();
  }

  /** Session-close hook (after 15:30 IST): writes every open minute and the last chain minute, then clears the day. */
  endSession(): SessionSummary | null {
    const date = this.date;
    if (!date) return null;
    const items: { key: InstrumentKey; rec: MinuteRecord }[] = [];
    for (const inst of this.insts.values()) {
      const rec = this.takeBar(inst);
      if (rec) items.push({ key: inst.key, rec });
    }
    this.write(items);
    // Chain aggregates of the last minute that started at or before now (and inside each session).
    const now = this.opts.clock.now();
    for (const reg of this.chains.values()) {
      const cal = this.cal(reg.symbol);
      const last = minuteOf(Math.min(now, cal.ts(date, cal.sessionMinutes(date))) - 1);
      this.writeChains(last, [reg]);
    }
    const summary: SessionSummary = { date, instruments: this.insts.size, minutesWritten: this.sessionWritten.minutes, chainMinutesWritten: this.sessionWritten.chains };
    this.resetDay(null);
    return summary;
  }

  /** Aggregate this chain every minute even before its first tick. */
  trackChain(symbol: string, expiry: string): void {
    this.tracked.set(`${symbol}|${expiry}`, { symbol, expiry });
    this.chainReg(symbol, expiry);
  }

  /* ---------------------------------- reads ---------------------------------- */

  liveBar(key: InstrumentKey): MinuteRecord | null {
    const bar = this.insts.get(keyId(key))?.bar;
    return bar ? { ...bar } : null;
  }

  stats(): RecorderStats {
    let open = 0;
    for (const i of this.insts.values()) if (i.bar) open++;
    return { ...this.st, date: this.date, instruments: this.insts.size, openBars: open, stateOnly: { ...this.st.stateOnly }, chainSkipped: { ...this.st.chainSkipped } };
  }

  /* ---------------------------------- ticks ---------------------------------- */

  /**
   * `meta.stream === false` (a REST snapshot, not a tick): its prices and volume are recorded, but the
   * volume is never split into buyer / seller initiated — between two snapshots many trades happened at
   * unknown bid/ask, so it is booked unclassified. Only live ticks are classified.
   */
  onTick(q: LiveQuote, meta?: TickMeta): void {
    const { clock } = this.opts;
    const calendar = this.cal(q.key.symbol);
    const now = clock.now();
    // The recording day is the IST date (NSE/BSE and MCX sessions both lie within it).
    const today = this.opts.calendar.session(now).date;
    const at = calendar.session(q.ts);
    // A packet stamped another day (e.g. yesterday's snapshot) must not touch today's baselines.
    if (at.date !== today) {
      this.st.stateOnly.otherDate++;
      return;
    }
    if (this.date !== today) {
      if (this.date) this.endSession();
      this.resetDay(today);
    }
    const inst = this.inst(q.key);

    // State: classification uses the quote seen BEFORE this tick (stream ticks only, see above).
    const tick = meta?.stream !== false;
    const prevBid = tick ? inst.bid : undefined;
    const prevAsk = tick ? inst.ask : undefined;
    const open = calendar.ts(today, 0);
    // Feed gap: no tick of this instrument since before the start of the previous minute (counted
    // from the open: the pre-open's last tick is not a gap), e.g. a dropped feed, a reconnect or a
    // re-subscription. The volume this tick reports traded somewhere in that gap.
    const gap = inst.lastTs !== undefined && Math.max(inst.lastTs, open) < minuteOf(q.ts) - MINUTE_MS;
    // (A tick stamped ahead of the clock is state-only: it must not move the gap clock past real time.)
    if (q.ts <= now + this.maxLeadMs && (inst.lastTs === undefined || q.ts > inst.lastTs)) inst.lastTs = q.ts;
    let dv = 0;
    if (isNum(q.volume) && q.volume >= 0) {
      inst.tracksVolume = true;
      if (inst.cumVol !== undefined && q.volume > inst.cumVol) dv = q.volume - inst.cumVol;
      // First volume seen after the open with trades already done (a restart, a late subscription):
      // the trades of this minute before this tick are not counted anywhere.
      else if (inst.cumVol === undefined && q.volume > 0 && q.ts >= open) inst.baseMinute = minuteOf(q.ts);
      if (inst.cumVol === undefined || q.volume > inst.cumVol) inst.cumVol = q.volume;
    }
    // The gap's volume is booked apart (gapVolume of the next minute written), never as this minute's trades.
    if (gap && dv > 0) {
      inst.pendingGap += dv;
      dv = 0;
    }
    // A last-trade time newer than any seen today is a trade in the minute of that time (the first
    // LTT seen only sets the baseline, unless it falls in the tick's own minute).
    let tradeMinute: number | undefined;
    if (isNum(q.ltt) && (inst.lastLtt === undefined || q.ltt > inst.lastLtt)) {
      if (inst.lastLtt !== undefined || q.ltt >= minuteOf(q.ts)) tradeMinute = minuteOf(q.ltt);
      inst.lastLtt = q.ltt;
    }
    // A fresh packet (LUT today) can still carry an earlier session's last trade: its LTT is another
    // day, or (REST option-chain legs, stamped when received) the session has opened and it has no
    // volume yet. That LTP is neither a trade of a minute nor a premium for the chain's ATM IV.
    const oldTrade = (isNum(q.ltt) && calendar.session(q.ltt).date !== today) || (q.volume === 0 && q.ts >= calendar.ts(today, 0));
    if (isPos(q.ltp) && !oldTrade) inst.ltp = q.ltp;
    if (isNum(q.oi) && q.oi >= 0) inst.oi = q.oi;
    // A quantity belongs to the price it was reported with: a new bid/ask without one clears it.
    if (isPos(q.bid)) {
      inst.bid = q.bid;
      inst.bidQty = isNum(q.bidQty) && q.bidQty >= 0 ? q.bidQty : undefined;
    }
    if (isPos(q.ask)) {
      inst.ask = q.ask;
      inst.askQty = isNum(q.askQty) && q.askQty >= 0 ? q.askQty : undefined;
    }
    if (isNum(q.totalBuyQty) && q.totalBuyQty >= 0) inst.totalBuyQty = q.totalBuyQty;
    if (isNum(q.totalSellQty) && q.totalSellQty >= 0) inst.totalSellQty = q.totalSellQty;
    if (isPos(q.atp)) inst.atp = q.atp;
    this.snap(inst, now);
    if ((q.key.kind === 'CE' || q.key.kind === 'PE') && q.key.expiry) this.chainReg(q.key.symbol, q.key.expiry).options.add(inst);

    // Bar.
    if (!isPos(q.ltp)) return void this.st.stateOnly.noPrice++;
    if (oldTrade) return void this.st.stateOnly.oldTrade++;
    if (q.ts < now - this.maxLagMs) return void this.st.stateOnly.stale++;
    if (q.ts > now + this.maxLeadMs) return void this.st.stateOnly.ahead++;
    if (at.status !== 'open') {
      if (inst.pendingGap > 0 && q.ts >= calendar.ts(today, calendar.sessionMinutes(today))) this.bookGapAtClose(inst, today, q.ltp);
      return void this.st.stateOnly.outsideSession++;
    }
    let m = minuteOf(q.ts);
    if (inst.bar && inst.bar.ts > m) m = inst.bar.ts;
    if (inst.lastWritten + MINUTE_MS > m) m = inst.lastWritten + MINUTE_MS;
    if (!this.inSession(m, today, q.key.symbol)) return void this.st.stateOnly.outsideSession++;

    // A trade reported late, in the minute still open before this tick's: the trade (its price and the
    // volume behind it) belongs to that minute, not to the one this tick opens.
    if (inst.bar && tradeMinute === inst.bar.ts && m > inst.bar.ts) {
      addTrade(inst.bar, q.ltp, dv, prevBid, prevAsk);
      dv = 0;
    }
    if (inst.bar && m > inst.bar.ts) {
      const done = this.takeBar(inst);
      if (done) this.write([{ key: inst.key, rec: done }]);
    }
    let bar = inst.bar;
    if (!bar) bar = inst.bar = { ts: m, open: q.ltp, high: q.ltp, low: q.ltp, close: q.ltp, traded: false };
    if (inst.tracksVolume && bar.volume === undefined) {
      bar.volume = 0;
      bar.buyVolume = 0;
      bar.sellVolume = 0;
      bar.unclassified = 0;
    }
    if (inst.pendingGap > 0) {
      bar.gapVolume = (bar.gapVolume ?? 0) + inst.pendingGap;
      inst.pendingGap = 0;
    }
    if (inst.baseMinute === bar.ts) bar.partial = true;
    if (dv > 0 || (tradeMinute !== undefined && tradeMinute >= minuteOf(q.ts))) addTrade(bar, q.ltp, dv, prevBid, prevAsk);
    else {
      // Quote-only tick: its LTP repeats the last trade (of this minute once the minute has traded).
      bar.high = Math.max(bar.high, q.ltp);
      bar.low = Math.min(bar.low, q.ltp);
      bar.close = q.ltp;
    }
    if (inst.oi !== undefined) bar.oi = inst.oi;
    if (inst.bid !== undefined) bar.bid = inst.bid;
    if (inst.ask !== undefined) bar.ask = inst.ask;
    if (inst.bidQty !== undefined) bar.bidQty = inst.bidQty;
    else delete bar.bidQty;
    if (inst.askQty !== undefined) bar.askQty = inst.askQty;
    else delete bar.askQty;
    if (inst.totalBuyQty !== undefined) bar.totalBuyQty = inst.totalBuyQty;
    if (inst.totalSellQty !== undefined) bar.totalSellQty = inst.totalSellQty;
    if (inst.atp !== undefined) bar.atp = inst.atp;
  }

  /* ---------------------------------- timer ---------------------------------- */

  /**
   * Runs every second: writes minutes whose end + grace has passed (quiet instruments), the chain
   * aggregates of the minute that just completed, and closes a date the clock has left.
   */
  flushDue(now: number = this.opts.clock.now()): void {
    if (!this.date) return;
    const items: { key: InstrumentKey; rec: MinuteRecord }[] = [];
    for (const inst of this.insts.values()) {
      if (inst.bar && inst.bar.ts + MINUTE_MS + this.graceMs <= now) {
        const rec = this.takeBar(inst);
        if (rec) items.push({ key: inst.key, rec });
      }
    }
    this.write(items);
    this.writeChains(minuteOf(now - MINUTE_MS - this.graceMs), [...this.chains.values()]);
    if (this.opts.calendar.session(now).date !== this.date) this.endSession();
  }

  /* ---------------------------------- chains ---------------------------------- */

  /** Chain aggregates of minute x for the chains not yet written for it whose session x is in. */
  private writeChains(x: number, regs: ChainReg[]): void {
    const date = this.date;
    if (!date) return;
    const out: { symbol: string; expiry: string; rec: ChainMinute }[] = [];
    for (const reg of regs) {
      if (x <= reg.lastTs || !this.inSession(x, date, reg.symbol)) continue;
      reg.lastTs = x;
      const rec = this.chainMinute(reg, x);
      if (rec) out.push({ symbol: reg.symbol, expiry: reg.expiry, rec });
    }
    if (!out.length) return;
    try {
      this.opts.writer.writeChainMinutes(out);
      this.st.chainMinutesWritten += out.length;
      this.sessionWritten.chains += out.length;
    } catch (e) {
      this.fail(e);
    }
  }

  /** Aggregate of one chain as of the end of minute x, from the latest values known by then. */
  private chainMinute(reg: ChainReg, x: number): ChainMinute | null {
    const { symbol, expiry } = reg;
    // An MCX commodity's spot is its near-month future (quoteKey).
    const spotKey: InstrumentKey = { symbol, kind: 'SPOT' };
    const spotInst = this.insts.get(keyId(this.opts.ref?.quoteKey?.(spotKey) ?? spotKey));
    let spot = spotInst ? snapAt(spotInst, x)?.ltp : undefined;
    if (spot === undefined) {
      // No spot ticks reached the recorder: the latest live spot of the same day (≤ a few seconds after x).
      const q = this.opts.live.quote?.(spotKey);
      if (q && isPos(q.ltp) && this.opts.calendar.session(q.ts).date === this.date) spot = q.ltp;
    }
    if (spot === undefined) {
      this.st.chainSkipped.noSpot++;
      return null;
    }
    const rows = new Map<number, { strike: number; ce?: Snap; pe?: Snap }>();
    for (const inst of reg.options) {
      const s = snapAt(inst, x);
      const k = inst.key.strike;
      if (!s || k === undefined) continue;
      let row = rows.get(k);
      if (!row) rows.set(k, (row = { strike: k }));
      if (inst.key.kind === 'CE') row.ce = s;
      else row.pe = s;
    }
    let ceOi = 0;
    let peOi = 0;
    // Null until a strike of that side has reported volume (never a 0 that was not seen).
    let ceVolume: number | null = null;
    let peVolume: number | null = null;
    let ceSeen = 0;
    let peSeen = 0;
    const painRows: { strike: number; ceOI: number; peOI: number }[] = [];
    for (const row of rows.values()) {
      if (row.ce?.oi !== undefined) (ceOi += row.ce.oi), ceSeen++;
      if (row.pe?.oi !== undefined) (peOi += row.pe.oi), peSeen++;
      if (row.ce?.vol !== undefined) ceVolume = (ceVolume ?? 0) + row.ce.vol;
      if (row.pe?.vol !== undefined) peVolume = (peVolume ?? 0) + row.pe.vol;
      // Max pain only over strikes whose OI is known on both sides.
      if (row.ce?.oi !== undefined && row.pe?.oi !== undefined) painRows.push({ strike: row.strike, ceOI: row.ce.oi, peOI: row.pe.oi });
    }
    // Both sides must have reported OI: an unseen side would be written as ceOi/peOi 0 and PCR 0/∞.
    if (!ceSeen || !peSeen) {
      this.st.chainSkipped.noOi++;
      return null;
    }
    const mp = painRows.length ? maxPain(painRows).maxPain : NaN;
    const strikes = this.listedStrikes(symbol, expiry) ?? [...rows.keys()];
    let atmStrike = strikes[0];
    for (const k of strikes) if (Math.abs(k - spot) < Math.abs(atmStrike - spot) || (Math.abs(k - spot) === Math.abs(atmStrike - spot) && k < atmStrike)) atmStrike = k;

    // ATM IV on the minute-close premiums (the future the options are written on, else parity, else spot).
    const futureExpiry = this.futureExpiry(symbol, expiry);
    const futInst = this.insts.get(keyId({ symbol, kind: 'FUT', expiry: futureExpiry }));
    const fut = futInst ? snapAt(futInst, x)?.ltp : undefined;
    const quote = (key: InstrumentKey, ltp: number | undefined): LiveQuote | undefined => (ltp === undefined ? undefined : { key, ts: x, ltp });
    const chain: RawChain = {
      symbol,
      expiry,
      ts: x + MINUTE_MS,
      spot: quote({ symbol, kind: 'SPOT' }, spot),
      future: quote({ symbol, kind: 'FUT', expiry: futureExpiry }, fut),
      rows: [...rows.values()].map((row): ChainRowLive => ({
        strike: row.strike,
        ce: quote({ symbol, kind: 'CE', expiry, strike: row.strike }, row.ce?.ltp),
        pe: quote({ symbol, kind: 'PE', expiry, strike: row.strike }, row.pe?.ltp),
      })),
    };
    const iv = chainAtmIv(chain, this.opts.pricing.r, x + MINUTE_MS, { exchange: this.cal(symbol).exchange, futureExpiry });
    return {
      ts: x,
      spot,
      ceOi,
      peOi,
      ceVolume,
      peVolume,
      pcr: ceOi > 0 ? peOi / ceOi : null,
      maxPain: Number.isFinite(mp) ? mp : null,
      atmStrike,
      atmIv: iv ? iv.iv : null,
    };
  }

  private listedStrikes(symbol: string, expiry: string): number[] | undefined {
    try {
      const s = this.opts.ref?.strikes?.(symbol, expiry);
      return s && s.length ? s : undefined;
    } catch {
      return undefined; // master not loaded: fall back to the strikes seen
    }
  }

  /* ---------------------------------- internals -------------------------------- */

  private inSession(ts: number, date: string, symbol: string): boolean {
    const s = this.cal(symbol).session(ts);
    return s.status === 'open' && s.date === date;
  }

  /** Calendar of the symbol's exchange. */
  private cal(symbol: string): TradingCalendar {
    return this.opts.calendarOf?.(symbol) ?? this.opts.calendar;
  }

  /** Expiry of the future the options of `expiry` are written on (MCX: the one they settle into). */
  private futureExpiry(symbol: string, expiry: string): string {
    try {
      return this.opts.ref?.underlyingFuture?.(symbol, expiry) ?? expiry;
    } catch {
      return expiry;
    }
  }

  private inst(key: InstrumentKey): Inst {
    const id = keyId(key);
    let inst = this.insts.get(id);
    if (!inst) {
      inst = { key: { ...key }, id, bar: null, lastWritten: -Infinity, tracksVolume: false, pendingGap: 0, snaps: [] };
      this.insts.set(id, inst);
    }
    return inst;
  }

  private chainReg(symbol: string, expiry: string): ChainReg {
    const id = `${symbol}|${expiry}`;
    let reg = this.chains.get(id);
    if (!reg) {
      reg = { symbol, expiry, options: new Set(), lastTs: -Infinity };
      for (const inst of this.insts.values()) {
        if ((inst.key.kind === 'CE' || inst.key.kind === 'PE') && inst.key.symbol === symbol && inst.key.expiry === expiry) reg.options.add(inst);
      }
      this.chains.set(id, reg);
    }
    return reg;
  }

  /** Record the latest values under the current clock minute (keeps the last 3 minutes). */
  private snap(inst: Inst, now: number): void {
    const m = minuteOf(now);
    const s: Snap = { m, ltp: inst.ltp, oi: inst.oi, vol: inst.cumVol };
    const last = inst.snaps[inst.snaps.length - 1];
    if (last && last.m >= m) inst.snaps[inst.snaps.length - 1] = { ...s, m: last.m };
    else {
      inst.snaps.push(s);
      if (inst.snaps.length > 3) inst.snaps.shift();
    }
  }

  private takeBar(inst: Inst): MinuteRecord | null {
    const rec = inst.bar;
    if (!rec) return null;
    inst.bar = null;
    inst.lastWritten = rec.ts;
    inst.lastClose = rec.close;
    return rec;
  }

  /**
   * A feed gap that began in the session and ended after the close (its first tick is post-close):
   * the units it reports traded during the session, at an unknown time up to the close, so they are
   * booked as gapVolume of the session's last minute (15:29), never as its trades. That minute is
   * the open bar when it is 15:29; else a record of 15:29 carrying only the gap volume, which the
   * store merges with a 15:29 record already written (at its close: no price is changed), or which
   * stands as a quote-only (traded: false) minute at the post-close LTP (the session's last trade).
   */
  private bookGapAtClose(inst: Inst, date: string, ltp: number): void {
    const cal = this.cal(inst.key.symbol);
    const last = cal.ts(date, cal.sessionMinutes(date) - 1);
    const gapVolume = inst.pendingGap;
    inst.pendingGap = 0;
    if (inst.bar && inst.bar.ts === last) {
      inst.bar.gapVolume = (inst.bar.gapVolume ?? 0) + gapVolume;
      return;
    }
    const done = this.takeBar(inst);
    if (done) this.write([{ key: inst.key, rec: done }]);
    if (inst.lastWritten >= last && inst.lastClose !== undefined) {
      const c = inst.lastClose;
      this.write([{ key: inst.key, rec: { ts: last, open: c, high: c, low: c, close: c, traded: false, gapVolume } }]);
      return;
    }
    const bar: MinuteRecord = { ts: last, open: ltp, high: ltp, low: ltp, close: ltp, traded: false, gapVolume };
    if (inst.tracksVolume) Object.assign(bar, { volume: 0, buyVolume: 0, sellVolume: 0, unclassified: 0 });
    if (inst.oi !== undefined) bar.oi = inst.oi;
    inst.bar = bar;
  }

  private write(items: { key: InstrumentKey; rec: MinuteRecord }[]): void {
    if (!items.length) return;
    try {
      this.opts.writer.writeMinutes(items);
      this.st.minutesWritten += items.length;
      this.sessionWritten.minutes += items.length;
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(e: unknown): void {
    this.st.writeErrors++;
    this.st.lastError = e instanceof Error ? e.message : String(e);
    this.opts.onError?.(e);
  }

  private resetDay(date: string | null): void {
    this.insts.clear();
    this.chains.clear();
    for (const t of this.tracked.values()) this.chainReg(t.symbol, t.expiry);
    this.date = date;
    this.sessionWritten = { minutes: 0, chains: 0 };
  }
}

/**
 * A trade at `ltp` (and the Δvolume `dv` behind it) in the minute of `bar`. The minute's first trade
 * replaces the prices seen before it: quote-only ticks only repeated an earlier minute's trade, which
 * is not part of this minute's OHLC.
 */
function addTrade(bar: MinuteRecord, ltp: number, dv: number, prevBid: number | undefined, prevAsk: number | undefined): void {
  if (!bar.traded) {
    bar.open = bar.high = bar.low = ltp;
    bar.traded = true;
  }
  bar.high = Math.max(bar.high, ltp);
  bar.low = Math.min(bar.low, ltp);
  bar.close = ltp;
  if (dv > 0) {
    bar.volume = (bar.volume ?? 0) + dv;
    const sane = isPos(prevBid) && isPos(prevAsk) && prevBid < prevAsk;
    if (sane && ltp >= prevAsk) bar.buyVolume = (bar.buyVolume ?? 0) + dv;
    else if (sane && ltp <= prevBid) bar.sellVolume = (bar.sellVolume ?? 0) + dv;
    else bar.unclassified = (bar.unclassified ?? 0) + dv;
  }
}

/** Latest snapshot at or before the end of minute x. */
function snapAt(inst: Inst, x: number): Snap | undefined {
  for (let i = inst.snaps.length - 1; i >= 0; i--) if (inst.snaps[i].m <= x) return inst.snaps[i];
  return undefined;
}
