/**
 * Live market-data contracts shared by the Kotak Neo client, the NSE/BSE EOD sources, the
 * recorder/stores and every service.
 *
 * Rule of the whole app: values come from a live or official source, or they are absent.
 * Nothing is synthesised. When a value cannot be obtained, code throws `NoLiveData` (HTTP 503)
 * or returns `null` for that field, and the UI shows the field blank with the reason.
 *
 * Time is real IST time: dates are 'YYYY-MM-DD', a session minute is minutes since the exchange's
 * open (NSE/BSE 09:15, 0..375; MCX 09:00, 0..870/895), timestamps are epoch milliseconds.
 */
import type { ExchangeCode, FiiDiiDay, Greeks, MarketClockInfo, ParticipantDay, UnderlyingKind } from '@q26/core';

/* ------------------------------------------------------------------------------------------ */
/* Errors                                                                                       */
/* ------------------------------------------------------------------------------------------ */

/** Thrown when live/official data needed for a response is not available. Never fall back to estimates. */
export class NoLiveData extends Error {
  readonly code = 'NO_LIVE_DATA';
  readonly statusCode = 503;
  constructor(reason: string) {
    super(reason);
    this.name = 'NoLiveData';
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Identity                                                                                     */
/* ------------------------------------------------------------------------------------------ */

export type OptKind = 'CE' | 'PE';
export type InstKind = 'SPOT' | 'FUT' | OptKind;

/** Exchange segment codes as used by Kotak Neo. */
export type Segment = 'nse_cm' | 'bse_cm' | 'nse_fo' | 'bse_fo' | 'mcx_fo';

export interface InstrumentKey {
  /** Underlying symbol as the app uses it: NIFTY, BANKNIFTY, FINNIFTY, MIDCPNIFTY, SENSEX, BANKEX, RELIANCE, GOLD, CRUDEOIL … */
  symbol: string;
  kind: InstKind;
  /** 'YYYY-MM-DD' for FUT/CE/PE. */
  expiry?: string;
  /** Rupees, for CE/PE. */
  strike?: number;
}

export const keyId = (k: InstrumentKey): string => `${k.symbol}|${k.kind}|${k.expiry ?? ''}|${k.strike ?? ''}`;

/** A tradable listing resolved from the broker's instrument master (scrip master). */
export interface Listing extends InstrumentKey {
  exchange: ExchangeCode;
  segment: Segment;
  /** Broker instrument token (numeric string), or the index name for index spots ("Nifty 50"). */
  token: string;
  tradingSymbol: string;
  /** Contract lot size from the scrip master. Index spots: 1, the value the exchange's cash master lists for index rows. */
  lotSize: number;
  /** Rupees. Absent for index spots: indices are not traded and have no official tick size. */
  tickSize?: number;
  freezeQty?: number;
}

export interface Underlying {
  symbol: string;
  name: string;
  kind: UnderlyingKind;
  exchange: ExchangeCode;
  /** Reference metadata (hand-maintained map), '' when unknown. */
  sector: string;
  lotSize: number;
  /** Most common gap between consecutive listed strikes, counted over every live expiry. */
  strikeStep: number;
  /**
   * The price the underlying is read from. Indices and stocks: the cash-market spot. MCX commodities
   * have no cash market: their "spot" is the near-month FUTURE (this listing is that future's, with
   * kind 'SPOT'), the reference price MCX itself quotes and the one the options settle into.
   */
  spot: Listing;
}

/* ------------------------------------------------------------------------------------------ */
/* Live snapshot                                                                                */
/* ------------------------------------------------------------------------------------------ */

export interface DepthLevel {
  price: number;
  qty: number;
  /** Number of orders at the level; absent when the source did not send it. */
  orders?: number;
}

/** Latest live state of one instrument. Optional fields are absent when the feed does not provide them. */
export interface LiveQuote {
  key: InstrumentKey;
  /** Exchange/feed timestamp of the last update (epoch ms). */
  ts: number;
  ltp: number;
  /** Last traded quantity (units). */
  ltq?: number;
  /** Last trade time (epoch ms). */
  ltt?: number;
  open?: number;
  high?: number;
  low?: number;
  /** Previous session close. */
  prevClose?: number;
  /** Cumulative session volume in units (quantity, not lots). */
  volume?: number;
  /** Average traded price (VWAP). */
  atp?: number;
  /** Open interest in units. */
  oi?: number;
  /** Open interest at the previous session close, in units. */
  prevOi?: number;
  bid?: number;
  ask?: number;
  bidQty?: number;
  askQty?: number;
  totalBuyQty?: number;
  totalSellQty?: number;
  depth?: { bids: DepthLevel[]; asks: DepthLevel[] };
  upperCircuit?: number;
  lowerCircuit?: number;
  /** Total traded value (₹) when the feed provides it. */
  turnover?: number;
}

export interface ChainRowLive {
  strike: number;
  ce?: LiveQuote;
  pe?: LiveQuote;
}

/** Raw live inputs of one option chain (analytics such as IV, PCR, max pain are derived from it). */
export interface RawChain {
  symbol: string;
  expiry: string;
  ts: number;
  spot?: LiveQuote;
  /**
   * Live chains (LiveMarket.chain): the same-expiry future when listed, else absent (weekly expiries
   * have none). Recorded chains (IntradayStore.chainAt): the same-expiry future, else the nearest
   * unexpired recorded future.
   */
  future?: LiveQuote;
  rows: ChainRowLive[];
}

export type WatchLevel = 'ltp' | 'quote' | 'depth';

/** A contract the user holds or looks at (orders, positions, strategy legs, alerts, watchlists, algos); level defaults to 'quote'. */
export type UserContract = InstrumentKey | { key: InstrumentKey; level?: WatchLevel };

export interface FeedHealth {
  /** Logged in to the broker (TOTP + MPIN). */
  loggedIn: boolean;
  /** Live market-data socket connected and authenticated. */
  connected: boolean;
  lastTickTs: number | null;
  subscribed: number;
  /** Human-readable reason when something is down (e.g. "Kotak login failed: Invalid TOTP"). */
  error?: string;
}

export interface LiveMarket {
  /** Ask for live updates of these instruments (demand driven; `ttlMs` releases idle subscriptions). */
  watch(keys: InstrumentKey[], level?: WatchLevel, ttlMs?: number): void;
  /**
   * Latest quote, only while it is dated a live session: today; outside market hours (pre-open,
   * after the close, weekends, holidays) also the last session. An older quote is undefined. The
   * book (bid/ask/depth) is the one last reported: check `ts` before trading against it.
   */
  quote(key: InstrumentKey): LiveQuote | undefined;
  quotes(keys: InstrumentKey[]): Map<string, LiveQuote>;
  /** Fetch fresh quotes over REST for keys without a live stream (rate-limited). */
  refresh(keys: InstrumentKey[]): Promise<Map<string, LiveQuote>>;
  /** Live chain of one expiry; throws NoLiveData when it cannot be built. */
  chain(symbol: string, expiry: string): Promise<RawChain>;
  /** `meta.stream`: the update came from the live tick stream (false: a REST snapshot). */
  onTick(listener: (q: LiveQuote, meta?: TickMeta) => void): () => void;
  health(): FeedHealth;
}

/* ------------------------------------------------------------------------------------------ */
/* Reference data and calendar                                                                  */
/* ------------------------------------------------------------------------------------------ */

export interface ReferenceData {
  /** Load the day's instrument master (call before 09:15 and on start). */
  refresh(date: string): Promise<void>;
  ready(): boolean;
  underlyings(): Underlying[];
  /** Throws an HTTP 404 error for unknown symbols, NoLiveData when the master is not loaded yet. */
  underlying(symbol: string): Underlying;
  /** Listed expiries ascending ('YYYY-MM-DD'). */
  expiries(symbol: string, kind: 'OPT' | 'FUT'): string[];
  strikes(symbol: string, expiry: string): number[];
  listing(key: InstrumentKey): Listing | undefined;
  /**
   * Expiry of the future an option expiry is written on / priced off: the same expiry for NSE/BSE
   * (undefined when no future of that expiry is listed: weekly expiries), the nearest future expiring
   * on or after it for MCX (MCX options expire before their future and settle into it).
   */
  underlyingFuture(symbol: string, optionExpiry: string): string | undefined;
  /**
   * The instrument whose quotes stand for `key`: an MCX commodity's SPOT is its near-month future
   * (there is no cash market), any other key is itself. Never throws (identity when unknown).
   */
  quoteKey(key: InstrumentKey): InstrumentKey;
  /** Reverse lookup used by the feed decoder. */
  byToken(segment: Segment, token: string): Listing | undefined;
}

export interface TradingCalendar {
  /** Exchange whose sessions this calendar describes. */
  readonly exchange: ExchangeCode;
  /** Length of the continuous session of `date` in minutes (NSE/BSE 375; MCX 870 or 895). */
  sessionMinutes(date: string): number;
  /** Expiry instant: the close of the expiry day on this exchange. */
  expiryTs(expiry: string): number;
  isTradingDay(date: string): boolean;
  prev(date: string): string;
  next(date: string): string;
  /** Trading days in [from, to]. */
  sessions(from: string, to: string): string[];
  /** IST session position of a timestamp; the minute counts from this exchange's open. */
  session(ts: number): { date: string; minute: number; status: 'pre-open' | 'open' | 'closed' };
  /** Epoch ms of `minute` minutes after this exchange's open on `date`. */
  ts(date: string, minute: number): number;
}

export interface SessionClock {
  now(): number;
  info(): MarketClockInfo;
}

/* ------------------------------------------------------------------------------------------ */
/* Recorded intraday data                                                                       */
/* ------------------------------------------------------------------------------------------ */

/**
 * One recorded minute of an instrument (built from live ticks). A minute is written when a tick with
 * a price arrived in it, including quote-only updates (bid/ask/OI changed, no trade): `chainAt` needs
 * those values. Bar consumers (ORB, candles, straddle charts) must skip minutes with `traded: false`,
 * whose OHLC is only the last traded price carried by the quotes.
 */
export interface MinuteRecord {
  /** Start of the minute (epoch ms). */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /**
   * At least one trade happened in the minute: the cumulative volume rose, or the feed reported a
   * new last-trade time (for index spots: a new index value time). False for quote-only minutes.
   */
  traded: boolean;
  /**
   * Units traded in the minute (Δ cumulative volume); absent when the feed reports no volume (e.g.
   * index spots). Excludes `gapVolume`, so volume = buyVolume + sellVolume + unclassified.
   */
  volume?: number;
  /**
   * Δ cumulative volume reported by the first tick after a feed gap (the instrument's previous tick
   * was older than the start of the previous minute: a gap spanning whole minutes, a reconnect or a
   * re-subscription). Those units traded at some time during the gap, not necessarily in this minute:
   * they are kept out of volume/buyVolume/sellVolume/unclassified and never classified, so that
   * Σ(volume + gapVolume) still equals the session's Δ cumulative volume. Absent when no gap ended here.
   */
  gapVolume?: number;
  /**
   * True when the minute's volume is a lower bound: the recorder's volume baseline was set inside it
   * (recording or the subscription started, e.g. after a restart, with session volume already traded),
   * so trades of the minute before that first tick are not counted anywhere. Absent otherwise.
   */
  partial?: true;
  oi?: number;
  bid?: number;
  ask?: number;
  /** Quantity (units) at the best bid recorded with `bid`; absent when the feed did not report it with that bid. */
  bidQty?: number;
  /** Quantity (units) at the best ask recorded with `ask`; absent when the feed did not report it with that ask. */
  askQty?: number;
  totalBuyQty?: number;
  totalSellQty?: number;
  /** Δvolume classified at/above the ask (buyer-initiated), from live ticks. */
  buyVolume?: number;
  /** Δvolume classified at/below the bid (seller-initiated), from live ticks. */
  sellVolume?: number;
  /** Δvolume that could not be classified. */
  unclassified?: number;
  atp?: number;
}

/** Per-minute aggregate of a recorded option chain. */
export interface ChainMinute {
  ts: number;
  spot: number;
  ceOi: number;
  peOi: number;
  /** Sum of the CE strikes' cumulative session volume (units); null when no CE volume was seen. */
  ceVolume: number | null;
  /** Sum of the PE strikes' cumulative session volume (units); null when no PE volume was seen. */
  peVolume: number | null;
  pcr: number | null;
  maxPain: number | null;
  atmStrike: number;
  atmIv: number | null;
}

export interface IntradayStore {
  /** Completed minute records of one instrument on one recorded date. */
  bars(key: InstrumentKey, date: string): MinuteRecord[];
  /** The minute in progress (live only). */
  liveBar(key: InstrumentKey): MinuteRecord | null;
  /** Last completed minute at or before ts. */
  at(key: InstrumentKey, ts: number): MinuteRecord | undefined;
  /** As-of chain (premium/OI per strike) at a past minute, from recorded data. */
  chainAt(symbol: string, expiry: string, ts: number): RawChain | undefined;
  chainSeries(symbol: string, expiry: string, date: string): ChainMinute[];
  /** Dates with recorded data, ascending. */
  sessions(): string[];
  /** Instruments with records on a date. */
  recordedKeys(date: string): InstrumentKey[];
}

/* ------------------------------------------------------------------------------------------ */
/* End-of-day / multi-day history (official sources)                                           */
/* ------------------------------------------------------------------------------------------ */

export interface DailyBar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  turnover?: number;
}

export interface DailyFuture {
  date: string;
  expiry: string;
  close: number;
  settle?: number;
  /** Units. */
  oi: number;
  oiChange?: number;
  /** Units. */
  volume: number;
  /** Market lot of the contract that day (bhavcopy `NewBrdLotQty`), so past contracts can be valued. */
  lotSize?: number;
}

export interface DailyOption {
  date: string;
  expiry: string;
  strike: number;
  type: OptKind;
  close: number;
  settle?: number;
  /** Units. */
  oi: number;
  oiChange?: number;
  /** Units. */
  volume: number;
  underlying?: number;
  /** Market lot of the contract that day (bhavcopy `NewBrdLotQty`), so past contracts can be valued. */
  lotSize?: number;
}

export interface HistoryStore {
  dailyBars(symbol: string, from: string, to: string): DailyBar[];
  dailyFutures(symbol: string, from: string, to: string): DailyFuture[];
  dailyOptions(symbol: string, date: string, expiry?: string): DailyOption[];
  /** ATM IV per day solved from official closing premiums (decimal). */
  dailyAtmIv(symbol: string, from: string, to: string): { date: string; iv: number; expiry: string }[];
  fiiDii(from: string, to: string): FiiDiiDay[];
  participantOi(from: string, to: string): ParticipantDay[];
  /** Final settlement price of an expired contract, when published. */
  settlement(key: InstrumentKey): number | undefined;
  /** Dates for which EOD files were loaded. */
  loadedDates(kind: 'fo' | 'cm' | 'index' | 'participants' | 'fiidii'): string[];
}

/* ------------------------------------------------------------------------------------------ */
/* Pricing (IV and Greeks derived from market premiums, in one place)                           */
/* ------------------------------------------------------------------------------------------ */

export interface ForwardEstimate {
  forward: number;
  /** Continuous carry yield implied by the forward (r − q). */
  carry: number;
  source: 'future' | 'parity' | 'spot';
}

export interface Pricing {
  /** Risk-free rate (config input, not market data). */
  r: number;
  /**
   * The time premiums are valued at, i.e. time to expiry is measured from it: `ts` (default now)
   * while the session is open, otherwise the close (15:30 IST) of the last session before it, whose
   * premiums are the last ones (they do not decay overnight or over a weekend). With `ltt`, the
   * last-trade time of an LTP premium: that trade's time when it is of a live session, capped by the
   * former. Callers report this time next to the IV/Greeks they show. `symbol` picks its exchange's
   * session (MCX closes at 23:30/23:55); default NSE/BSE.
   */
  valuationTs(ts?: number, ltt?: number, symbol?: string): number;
  /**
   * Throws NoLiveData when neither a future, a put-call pair nor a spot price is live, when no live
   * spot is there to imply the carry from, or once the expiry has passed (carry is never NaN).
   * Valued at valuationTs().
   */
  forward(symbol: string, expiry: string): ForwardEstimate;
  /**
   * Implied vol (decimal) of a market premium; null when it cannot be solved. `ts` (default now) is
   * taken to its valuation time (valuationTs); `ltt` is the last-trade time of an LTP premium (omit it
   * for the mid of a live book). Without `forward` the forward comes from the live quotes (no spot
   * needed when a future or a put-call pair is live); a `ts` before the valuation time of now then
   * gives null (no look-ahead), so as-of callers pass the forward of that time.
   */
  iv(input: { symbol: string; expiry: string; type: OptKind; strike: number; premium: number; ts?: number; forward?: number; ltt?: number }): number | null;
  /** Black-76 Greeks at the same time rules as iv(). */
  greeks(input: { symbol: string; expiry: string; type: OptKind; strike: number; iv: number; ts?: number; forward?: number; ltt?: number }): Greeks | null;
  /** ATM IV of an expiry (nearest when omitted) from live premiums, valued at valuationTs(); null when unavailable. */
  atmIv(symbol: string, expiry?: string): number | null;
}

/* ------------------------------------------------------------------------------------------ */
/* Facade                                                                                       */
/* ------------------------------------------------------------------------------------------ */

export type CandleInterval = '1min' | '3min' | '5min' | '10min' | '15min' | '30min' | '60min' | 'D';

/**
 * One bar of MarketDataProvider.candles(). Intraday bars always carry OHLC. Daily bars of contracts
 * come from the official closes (DailyFuture/DailyOption), which publish no open/high/low: those
 * fields are then absent rather than copied from the close.
 */
export interface Candle {
  /** Start of the bar (epoch ms); daily bars: 09:15 IST of the date. */
  ts: number;
  open?: number;
  high?: number;
  low?: number;
  close: number;
  /** Units traded in the bar; absent when the source reports no volume (index spots). */
  volume?: number;
  /** Recorded bars: units reported after a feed gap that ended in the bar (MinuteRecord.gapVolume); not in `volume`. */
  gapVolume?: number;
  /** Recorded bars: some minute's volume is a lower bound (MinuteRecord.partial). */
  partial?: true;
}

/** How a quote update arrived. Only stream ticks are tick-by-tick; REST quotes are snapshots. */
export interface TickMeta {
  stream: boolean;
}

/** Read side of the one-second store (live/store/seconds.ts). */
export type SecondReader = Pick<import('./store/seconds').SecondStore, 'read' | 'has' | 'keys' | 'dates' | 'coverage' | 'usage'>;

export interface MarketDataProvider {
  ref: ReferenceData;
  /** NSE/BSE calendar (the app clock, EOD files, indices and stocks). */
  calendar: TradingCalendar;
  /** Calendar of the exchange `symbol` trades on (MCX for commodities, else `calendar`). */
  calendarOf(symbol: string): TradingCalendar;
  clock: SessionClock;
  live: LiveMarket;
  intraday: IntradayStore;
  history: HistoryStore;
  pricing: Pricing;
  /**
   * Candles of [from, to] (inclusive dates). Intraday intervals: recorded minutes (traded ones only),
   * else Kotak historical for ACTIVE contracts (expired ones are not served), resampled from real
   * minutes. 'D': official end-of-day history. Throws NoLiveData when nothing is available.
   */
  candles(key: InstrumentKey, interval: CandleInterval, from: string, to: string): Promise<Candle[]>;
  /**
   * The contracts the user holds or looks at, read on every universe update (about once a minute):
   * they are streamed in the 'user' tier, above the index chains and ad-hoc watches. Null clears it.
   */
  setUserContracts(fn: (() => Iterable<UserContract>) | null): void;
  /** One-second snapshots recorded from the live feed (second-level backtests); absent when not recorded. */
  seconds?: SecondReader;
  start(): Promise<void>;
  stop(): Promise<void>;
}
