/**
 * Wire types shared by the API server and the web client.
 */
import type { BuildUp } from './oi';
import type { InstrumentType, Leg, Side } from './payoff';
import type { FlowSummary, MinuteBar, OrbEvaluation, OrbRule, OrbTrend } from './orb';

/*
 * Live-data rule: every market value comes from a live (Kotak Neo) or official (NSE/BSE end-of-day)
 * source, or is derived from such values (IV/Greeks solved from premiums, PCR, max pain …). A value
 * that is not available is `null` (shown blank); a response that is only partly available names the
 * missing sections in `gaps` (section → reason). A response with nothing available is HTTP 503
 * `{ error, code: 'NO_LIVE_DATA' }`.
 */

/** Sections of a response that could not be filled from live/official data: section → reason. */
export interface DataGaps {
  gaps?: Record<string, string>;
}

export type MarketStatusCode = 'open' | 'pre-open' | 'closed';

/** Connection and data-health summary for the web (no credentials or tokens, ever). */
export interface FeedStatus {
  /** Logged in to the broker (Kotak Neo). */
  loggedIn: boolean;
  /** Live market-data socket connected and authenticated. */
  connected: boolean;
  /** Time of the last live update received (epoch ms), null before any. */
  lastTickTs: number | null;
  /** Instruments currently subscribed on the live socket. */
  subscribed: number;
  /** Why something is down (e.g. "Kotak login failed: …"), absent when all is well. */
  error?: string;
  /** The day's instrument master (listings, lot sizes, expiries, strikes) is loaded. */
  refdataReady: boolean;
  /** First session the recorder holds minute data for ('YYYY-MM-DD'), null before any recording. */
  recordingSince: string | null;
  /** Last date loaded per official end-of-day source, null when none is loaded. */
  eod: { fo: string | null; cm: string | null; index: string | null; participants: string | null; fiidii: string | null };
}

export interface MarketClockInfo {
  /** Real time (epoch ms); the app runs on the real IST clock only. */
  ts: number;
  date: string;
  time: string;
  status: MarketStatusCode;
  /** Minutes since 09:15 (0..375). */
  sessionMinute: number;
  /** Live data health (sent by /api/clock, /api/meta, /api/health and the websocket). */
  feed?: FeedStatus;
}

export interface SymbolInfo {
  symbol: string;
  name: string;
  kind: 'index' | 'stock';
  exchange: 'NSE' | 'BSE';
  sector: string;
  /** Current lot size from the instrument master. */
  lotSize: number;
  /** Most common gap between listed strikes (instrument master). */
  strikeStep: number;
  /** Option expiry cycle seen in the listed expiries (consecutive expiries ≤ 8 days apart → weekly); null with fewer than two listed. */
  expiryCycle: 'weekly' | 'monthly' | null;
}

export interface MetaResponse extends DataGaps {
  appName: string;
  dataSource: 'live';
  riskFreeRate: number;
  clock: MarketClockInfo;
  /** Empty (with `gaps.symbols`) while the instrument master is not loaded. */
  symbols: SymbolInfo[];
}

/** Underlying quote: live spot LTP (required) plus whatever else is live; absent values are null. */
export interface Quote {
  symbol: string;
  ltp: number;
  change: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  /** Near-month future's live price. */
  future: number | null;
  futureExpiry: string | null;
  futureChange: number | null;
  /** ATM IV (percent) solved from live premiums. */
  atmIv: number | null;
  ts: number;
}

/**
 * GET /api/quotes: quotes of the requested underlyings that have one (live, or recorded at `?at=`);
 * every symbol left out (unknown, or without a price) is named in `gaps` (symbol → reason).
 */
export interface QuotesResponse extends DataGaps {
  quotes: Quote[];
}

/** Candle; daily bars of contracts carry the official close only (no open/high/low), index bars no volume. */
export interface Candle {
  ts: number;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  /** Units traded in the bar (recorded bars: excludes `gapVolume`; a lower bound when `partial`). */
  volume: number | null;
  /** Recorded bars: units reported by the first tick after a feed gap that ended in the bar (traded at an unknown time during the gap); not in `volume`. */
  gapVolume?: number | null;
  /** Recorded bars: true when the volume of some minute of the bar is a lower bound (the recording or its subscription started inside it). */
  partial?: boolean;
}

export interface OptionQuote {
  /** Last traded price of the live session; null when the leg has not traded in it (its OI is still shown). */
  ltp: number | null;
  change: number | null;
  changePct: number | null;
  prevClose: number | null;
  oi: number | null;
  prevOi: number | null;
  oiChange: number | null;
  oiChangePct: number | null;
  volume: number | null;
  /** Percent, solved (Black-76) from the premium named by `ivSource`. */
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  /** Live best bid/ask (open session, fresh book); null otherwise. */
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  buildUp: BuildUp | null;
  intrinsic: number | null;
  timeValue: number | null;
  /** Premium the IV/Greeks are solved from: 'mid' of a live two-sided book, else the session 'ltp'; null = no usable premium. */
  ivSource: 'mid' | 'ltp' | null;
  /**
   * Time the IV/Greeks are valued at (epoch ms; time to expiry is measured from it): the chain's
   * `valuationTs` for a mid; for an 'ltp' premium the LTP's own trade time when the feed reports one
   * (capped by `valuationTs`), else `valuationTs`; null without a premium.
   */
  ivTs: number | null;
  /** Time of the leg's quote (epoch ms); null when there is no quote. */
  ts: number | null;
}

export interface ChainRow {
  strike: number;
  ce: OptionQuote;
  pe: OptionQuote;
}

export interface OptionChain extends DataGaps {
  symbol: string;
  expiry: string;
  expiries: string[];
  /** Evaluation time (now, or the ?at= time of a recorded chain). */
  ts: number;
  /**
   * Time IV, Greeks, forward, carry and daysToExpiry are valued at: `ts` while the session is open,
   * otherwise the close (15:30 IST) of the last session before it (its premiums are the last ones).
   */
  valuationTs: number;
  spot: number | null;
  spotChange: number | null;
  spotChangePct: number | null;
  /** Time of `spot` (epoch ms): the live quote's, or the start of the recorded minute of an as-of chain; null without a spot. */
  spotTs: number | null;
  /** Same-expiry future when listed, else the nearest future (live price). */
  future: number | null;
  futureExpiry: string | null;
  /** Forward of this expiry (Black-76 input) and where it came from. */
  forward: number | null;
  forwardSource: 'future' | 'parity' | 'spot' | null;
  /**
   * Carry yield q such that spot·e^{(r−q)T} = this expiry's forward; null without a live spot, and
   * when the forward is taken from spot (forwardSource 'spot': no dividend yield is implied, `gaps.carry`).
   */
  carry: number | null;
  lotSize: number;
  strikeStep: number;
  daysToExpiry: number;
  atm: number | null;
  atmIv: number | null;
  ivChange: number | null;
  pcr: number | null;
  pcrVolume: number | null;
  maxPain: number | null;
  totalCeOi: number | null;
  totalPeOi: number | null;
  totalCeOiChange: number | null;
  totalPeOiChange: number | null;
  support: number | null;
  resistance: number | null;
  /** Strikes the OI aggregates (PCR, max pain, totals, support/resistance) cover. */
  coverage: string;
  rows: ChainRow[];
}

export interface FuturesQuote {
  symbol: string;
  expiry: string;
  ltp: number | null;
  change: number | null;
  changePct: number | null;
  oi: number | null;
  oiChange: number | null;
  oiChangePct: number | null;
  volume: number | null;
  basis: number | null;
  buildUp: BuildUp | null;
  ts: number | null;
}

export interface TimePoint {
  ts: number;
}

/**
 * Strike-wise OI (live chain, or the recorded chain at ?at=). Values are null where the leg has no
 * quote / no OI; changes are null where the baseline OI of that leg is not known.
 */
export interface StrikeOiRow {
  strike: number;
  ceOi: number | null;
  peOi: number | null;
  ceChange: number | null;
  peChange: number | null;
  /** Session volume (units); null when not reported (recorded chains carry no cumulative volume). */
  ceVolume: number | null;
  peVolume: number | null;
}

export interface StrikeOiResponse extends DataGaps {
  symbol: string;
  expiry: string;
  spot: number | null;
  /** Time the change is measured from: 15:30 of the previous session ('prev-close') or the recorded minute ('recorded'). */
  fromTs: number;
  from: 'prev-close' | 'recorded';
  toTs: number;
  rows: StrikeOiRow[];
  /** Over the strikes with OI on both sides (`coverage`). */
  maxPain: number | null;
  pcr: number | null;
  coverage: string;
}

/** Values at each of `times`: null where the window before that time has no recorded value (nothing carried forward). */
export interface MultiStrikeSeries {
  strike: number;
  type: 'CE' | 'PE';
  oi: (number | null)[];
  /** Close of the last traded minute in the window. */
  ltp: (number | null)[];
  /** Percent, solved (Black-76) from `ltp` with the recorded forward of that time. */
  iv: (number | null)[];
}

export interface MultiStrikeResponse extends DataGaps {
  symbol: string;
  expiry: string;
  /** Session the series are recorded on. */
  date: string;
  /** As-of times (end of each window). */
  times: number[];
  spot: (number | null)[];
  series: MultiStrikeSeries[];
}

/** One recorded chain minute (the last one in the window ending at `ts`). */
export interface OiTrendPoint extends TimePoint {
  spot: number | null;
  /** Recorded totals of the streamed strikes (see the response's `coverage`). */
  ceOi: number | null;
  peOi: number | null;
  /** Σ (OI − previous-close OI) over recorded strikes that have an official previous-close OI; null when none has. */
  ceChange: number | null;
  peChange: number | null;
  pcr: number | null;
  maxPain: number | null;
  /** Percent, solved from the recorded ATM premiums. */
  atmIv: number | null;
}

export interface OiTrendResponse extends DataGaps {
  symbol: string;
  expiry: string;
  date: string;
  points: OiTrendPoint[];
  /** What the recorded totals cover (streamed strikes ±8 %, not the whole chain). */
  coverage: string;
}

/** PCR of one session from the official F&O bhavcopy (every strike of the nearest expiry, real OI only). */
export interface DailyPcrPoint {
  date: string;
  pcr: number;
  /** Official close of the underlying; null when the index/CM file of that date is not loaded. */
  close: number | null;
  expiry: string;
}

export interface PcrResponse extends DataGaps {
  symbol: string;
  expiry: string | null;
  intraday: { ts: number; pcr: number | null; spot: number | null; ceOi: number | null; peOi: number | null }[];
  daily: DailyPcrPoint[];
  coverage: { intraday: string; daily: string };
}

export interface MaxPainResponse extends DataGaps {
  symbol: string;
  expiry: string;
  spot: number | null;
  maxPain: number | null;
  pain: { strike: number; callPain: number; putPain: number; total: number }[];
  history: { ts: number; maxPain: number | null; spot: number | null }[];
  coverage: string;
}

/** Near-month future of one underlying: live quote vs the previous close / previous OI. */
export interface FuturesBuildUpRow {
  symbol: string;
  name: string;
  sector: string;
  kind: 'index' | 'stock';
  expiry: string;
  ltp: number | null;
  changePct: number | null;
  oi: number | null;
  oiChangePct: number | null;
  volume: number | null;
  buildUp: BuildUp | null;
  lotSize: number;
  /** Quote time (epoch ms); null without a quote. */
  ts: number | null;
}

export type BuildUpCounts = Record<BuildUp, number>;

export interface BreadthResponse extends DataGaps {
  /** Live build-up of the stock futures that have one (`classified` of `total`); null when none has. */
  overall: BuildUpCounts | null;
  classified: number;
  total: number;
  /** `counts` is null for a sector none of whose futures has a live build-up yet (its symbols are still listed). */
  sectors: { sector: string; counts: BuildUpCounts | null; symbols: FuturesBuildUpRow[] }[];
  /**
   * Past sessions from the official files (spot close change vs total futures OI change of the same
   * contracts), then today's live counts ('live').
   */
  history: { date: string; counts: BuildUpCounts; classified: number; source: 'eod' | 'live' }[];
}

export interface ParticipantRow {
  participant: 'Client' | 'DII' | 'FII' | 'Pro';
  futIndexLong: number;
  futIndexShort: number;
  futStockLong: number;
  futStockShort: number;
  optIndexCallLong: number;
  optIndexCallShort: number;
  optIndexPutLong: number;
  optIndexPutShort: number;
  optStockCallLong: number;
  optStockCallShort: number;
  optStockPutLong: number;
  optStockPutShort: number;
}

export interface ParticipantDay {
  date: string;
  niftyClose: number;
  rows: ParticipantRow[];
}

export interface FiiDiiDay {
  date: string;
  fiiBuy: number;
  fiiSell: number;
  fiiNet: number;
  diiBuy: number;
  diiSell: number;
  diiNet: number;
  niftyClose: number;
  niftyChangePct: number;
  /**
   * Coverage of the flow figures: 'combined' = NSE+BSE+MSEI (NSE fiidiiTradeReact), 'nse' = NSE-only
   * (fiidiiTradeNse). Days of different scope must not be summed together.
   */
  scope?: 'combined' | 'nse';
}

export interface IvChartResponse extends DataGaps {
  symbol: string;
  /** Expiry of the intraday series (recorded chain), null when there is none. */
  expiry: string | null;
  /** Session of the intraday series. */
  date: string;
  /** Recorded chain minutes: ATM IV (percent) and the ATM strike's CE/PE IV solved from their traded premiums. */
  intraday: { ts: number; atmIv: number | null; spot: number | null; ceIv: number | null; peIv: number | null }[];
  /** Official end-of-day: ATM IV solved from the bhavcopy closes (nearest expiry with ≥ 1 day left), HV 20D of official closes. */
  daily: { date: string; iv: number | null; hv: number | null; close: number | null; expiry: string | null }[];
  /** ATM IV now (live premiums), else the latest official one (percent). */
  currentIv: number | null;
  /** IV rank / percentile of `currentIv` over the last 252 sessions of official ATM IV; null while that history is shorter. */
  ivr: number | null;
  ivp: number | null;
}

export interface IvTableRow extends DataGaps {
  symbol: string;
  kind: 'index' | 'stock';
  sector: string;
  ltp: number | null;
  changePct: number | null;
  /** ATM IV (percent) of `expiry` from live premiums. */
  iv: number | null;
  /** vs the same expiry's ATM IV solved from the previous session's official closes. */
  ivChange: number | null;
  ivr: number | null;
  ivp: number | null;
  /** HV 20D (percent) of official daily closes. */
  hv: number | null;
  ivHvSpread: number | null;
  /** Nearest listed option expiry with at least one day left. */
  expiry: string | null;
}

export interface SkewPoint {
  strike: number;
  /** (strike / reference − 1) × 100; reference = spot, else the forward. */
  moneyness: number;
  ceIv: number | null;
  peIv: number | null;
  /** Out-of-the-money side (CE at/above the forward, PE below). */
  iv: number | null;
}

export interface SkewResponse extends DataGaps {
  symbol: string;
  spot: number | null;
  curves: {
    expiry: string;
    label: string;
    /** 'live' = solved from live premiums; 'eod' = from the previous session's official traded closes. */
    source: 'live' | 'eod';
    /** Session of the premiums. */
    date: string;
    atmIv: number | null;
    forward: number | null;
    points: SkewPoint[];
  }[];
}

export interface SurfaceResponse extends DataGaps {
  symbol: string;
  spot: number | null;
  expiries: string[];
  daysToExpiry: number[];
  /** Bucket centres (K / reference − 1, %). */
  moneyness: number[];
  /**
   * iv[expiryIdx][moneynessIdx] in percent: the solved IV of the listed strike nearest the bucket
   * centre within the bucket; null when no listed strike there has a live premium (no smile fill-in).
   */
  iv: (number | null)[][];
  /** The listed strike behind each cell (null with the cell). */
  strikes: (number | null)[][];
}

export interface StraddlePoint extends TimePoint {
  spot: number | null;
  /** Centre strike (rolling: nearest the recorded forward of that time). */
  strike: number;
  ceStrike: number;
  peStrike: number;
  /** Close of each leg's last traded minute in the window; null when it did not trade. */
  ce: number | null;
  pe: number | null;
  straddle: number | null;
  /** Average of the legs' IVs (percent) solved from those premiums. */
  iv: number | null;
}

export interface StraddleResponse extends DataGaps {
  symbol: string;
  expiry: string;
  date: string;
  /** Where the premiums come from. */
  source: 'recorded' | 'kotak' | 'mixed';
  points: StraddlePoint[];
}

export interface StrategyChartPoint extends TimePoint {
  spot: number | null;
  /** Null when a leg did not trade in the window. */
  premium: number | null;
  pnl: number | null;
  delta: number | null;
  theta: number | null;
  vega: number | null;
  gamma: number | null;
}

/** Realised-vol cone of official daily closes; a window is null when the history is too short. */
export interface ConeResponse extends DataGaps {
  symbol: string;
  /** Live ATM IV (percent), null when not live. */
  atmIv: number | null;
  /** Consecutive official closes used. */
  closes: number;
  from: string | null;
  to: string | null;
  rows: { window: number; min: number | null; p25: number | null; median: number | null; p75: number | null; max: number | null; current: number | null }[];
}

/**
 * One scanner hit. Values come from live quotes (near futures, spots), the market-wide option
 * snapshot (IV solved from live premiums) or recorded 1-minute bars (ORB); a value that is not
 * live/official is null. Rows without the value the scanner ranks by are not listed.
 */
export interface ScannerRow {
  symbol: string;
  instrument: string;
  type: InstrumentType | 'EQ';
  strike?: number;
  expiry?: string;
  ltp: number | null;
  changePct: number | null;
  oi: number | null;
  oiChangePct: number | null;
  /** Session volume (units). */
  volume: number | null;
  iv?: number | null;
  ivChange?: number | null;
  ivp?: number | null;
  buildUp?: BuildUp | null;
  /** The value the scanner ranks by. */
  metric: number;
  metricLabel: string;
}

/** GET /api/scanners/:id: the hits plus how much of the market was live (`coverage`); missing inputs in `gaps`. */
export interface ScannerResponse extends DataGaps {
  id: string;
  rows: ScannerRow[];
  coverage: string;
}

export interface ScannerDef {
  id: string;
  name: string;
  category: 'OI' | 'Price' | 'IV' | 'Build-up' | 'Volume' | 'Options' | 'Trend';
  description: string;
}

export interface UnusualActivityRow {
  symbol: string;
  type: 'CE' | 'PE';
  strike: number;
  expiry: string;
  /** Live-session trade price (contracts without one are not listed). */
  ltp: number;
  changePct: number | null;
  oi: number;
  oiChange: number;
  oiChangePct: number;
  volume: number;
  volumeOiRatio: number;
  /** Percent, solved from the live premium; null when it cannot be solved. */
  iv: number | null;
  /** IV now − IV solved from the previous session's official close; null when either is missing. */
  ivChange: number | null;
  /** Volume × average traded price (₹); null when the feed reported no ATP. */
  premiumTurnover: number | null;
  score: number;
  signal: string;
  buildUp: BuildUp | null;
}

/** GET /api/unusual. */
export interface UnusualResponse extends DataGaps {
  rows: UnusualActivityRow[];
  coverage: string;
}

export interface SynopsisRow {
  symbol: string;
  name: string;
  sector: string;
  /** Live spot price (stocks without one are not listed). */
  ltp: number;
  changePct: number | null;
  /** Near-month future's OI change vs the previous session (%). */
  oiChangePct: number | null;
  ivChange: number | null;
  /** ATM IV (percent) solved from live premiums. */
  iv: number | null;
  /** Cash-market session turnover = volume × average traded price (₹); null when either is not reported. */
  turnover: number | null;
  buildUp: BuildUp | null;
  /** Put/call OI ratio over the snapshot strikes (nearest expiry) that have live OI on both sides. */
  pcr: number | null;
}

/** GET /api/synopsis. */
export interface SynopsisResponse extends DataGaps {
  rows: SynopsisRow[];
  coverage: string;
}

/** One level of the exchange's market depth as the feed sent it. */
export interface DepthLevel {
  price: number;
  qty: number;
  /** Number of orders at the level; null when the feed did not send it. */
  orders: number | null;
}

/**
 * GET /api/order-book/:symbol: the live 5-level depth of one contract (Kotak market-depth stream)
 * and analytics derived from it. Without a depth packet for the contract the answer is 503. Values
 * the feed did not send are null. `history` comes from the recorder's minutes only.
 */
export interface OrderBookResponse extends DataGaps {
  symbol: string;
  instrument: string;
  type: 'FUT' | 'CE' | 'PE';
  expiry: string;
  strike?: number;
  /** Time of the book the levels come from (epoch ms). */
  bookTs: number;
  /** True while the session is open and the book is at most 10 s old; otherwise it is the last book received, as of `bookTs`. */
  bookLive: boolean;
  /** Live-session trade price; null when the contract has not traded in the session. */
  ltp: number | null;
  change: number | null;
  changePct: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  /** Average traded price of the session (exchange ATP). */
  vwap: number | null;
  volume: number | null;
  oi: number | null;
  /** The levels as sent (up to 5; fewer when the book is thinner, never padded). */
  bids: DepthLevel[];
  asks: DepthLevel[];
  /** Total pending buy / sell quantity reported by the exchange. */
  totalBidQty: number | null;
  totalAskQty: number | null;
  spread: number | null;
  spreadPct: number | null;
  /** (total bid − total ask) / (total bid + total ask). */
  imbalance: number | null;
  lastTradeQty: number | null;
  upperCircuit: number | null;
  lowerCircuit: number | null;
  /**
   * Recorded minutes of the session (the last minute of each 5-minute block): level-1 quantities,
   * totals, spread and ATP as recorded at that minute's close. Empty when the contract was not recorded.
   */
  history: { ts: number; ltp: number | null; bidQty: number | null; askQty: number | null; totalBidQty: number | null; totalAskQty: number | null; ratio: number | null; spread: number | null; vwap: number | null }[];
  /** Derived figures; `value` null (with the reason in `hint`) when an input is missing. */
  analytics: { label: string; value: string | null; hint?: string; tone?: 'up' | 'down' | 'neutral' }[];
}

/* ---------------------------- user data ---------------------------- */

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  guest: boolean;
  createdAt: number;
  settings: UserSettings;
}

export interface UserSettings {
  theme: 'dark' | 'light';
  defaultSymbol: string;
  strikesAround: number;
  showGreeks: boolean;
  oiUnit: 'qty' | 'lots';
  riskFreeRate: number;
}

export interface AuthResponse {
  token: string;
  user: UserProfile;
}

export interface SavedStrategy {
  id: string;
  name: string;
  symbol: string;
  legs: Leg[];
  notes?: string;
  createdAt: number;
  updatedAt: number;
  targetMtm?: number | null;
  stopLossMtm?: number | null;
  status: 'open' | 'closed' | 'expired';
  /** Computed by the server on read; null values are not live (reasons in `gaps`). */
  live?: { mtm: number | null; realized: number; spot: number | null; legsLtp: (number | null)[]; ts: number; gaps?: Record<string, string> };
}

export type OrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
export type ProductType = 'NRML' | 'MIS';
export type OrderStatus = 'OPEN' | 'COMPLETE' | 'CANCELLED' | 'REJECTED' | 'TRIGGER_PENDING';

export interface OrderRequest {
  symbol: string;
  type: InstrumentType;
  strike?: number;
  expiry: string;
  side: Side;
  lots: number;
  orderType: OrderType;
  price?: number;
  triggerPrice?: number;
  product: ProductType;
  tag?: string;
}

export interface Order extends OrderRequest {
  id: string;
  instrument: string;
  quantity: number;
  status: OrderStatus;
  avgPrice: number;
  filledQty: number;
  createdAt: number;
  updatedAt: number;
  message?: string;
}

export interface Trade {
  id: string;
  orderId: string;
  instrument: string;
  symbol: string;
  side: Side;
  quantity: number;
  price: number;
  ts: number;
}

export interface Position {
  key: string;
  instrument: string;
  symbol: string;
  type: InstrumentType;
  strike?: number;
  expiry: string;
  product: ProductType;
  netQty: number;
  /** Lot size the contract traded with (from the orders). */
  lotSize: number;
  avgPrice: number;
  buyQty: number;
  sellQty: number;
  buyValue: number;
  sellValue: number;
  /** Live LTP of the session (expired: the exchange settlement value); null when not live. */
  ltp: number | null;
  /** Time of that price (epoch ms), null with it. */
  ltpTs: number | null;
  realized: number;
  unrealized: number | null;
  pnl: number | null;
  /** 'awaiting settlement' = expired, the exchange settlement price is not loaded yet (position stays open). */
  status: 'open' | 'closed' | 'expired' | 'awaiting settlement';
  /** Why `ltp`/`unrealized` are blank. */
  reason?: string;
}

/** Paper account. Margin is a SPAN-style estimate on live spot, IV and forward (null when those are not live). */
export interface Funds extends DataGaps {
  openingBalance: number;
  available: number | null;
  usedMargin: number | null;
  realizedPnl: number;
  unrealizedPnl: number | null;
  premiumPaid: number;
  premiumReceived: number;
}

export type AlertKind = 'PRICE' | 'OPTION_PRICE' | 'IV' | 'PCR' | 'OI_CHANGE' | 'MTM' | 'ORB_BREAK' | 'ORDER_FLOW';

export interface AlertDef {
  id: string;
  kind: AlertKind;
  symbol: string;
  condition: 'above' | 'below';
  value: number;
  /** Option contract for OPTION_PRICE / OI_CHANGE. */
  optionType?: 'CE' | 'PE';
  strike?: number;
  expiry?: string;
  strategyId?: string;
  note?: string;
  status: 'active' | 'triggered' | 'disabled';
  createdAt: number;
  /** Market time the alert was last (re-)armed; ORB and order-flow alerts only fire on minutes completed after this. */
  armedAt?: number;
  triggeredAt?: number;
  triggeredValue?: number;
  /** Value seen at the last evaluation; null when its input was not live (the alert was skipped). */
  lastValue?: number | null;
  /** When the alert was last evaluated (epoch ms). */
  checkedAt?: number;
  /** Why the last evaluation was skipped (input not live) or why the alert was disabled; absent once it is evaluated. */
  statusNote?: string;
}

export interface Notification {
  id: string;
  title: string;
  body: string;
  ts: number;
  read: boolean;
  kind: 'alert' | 'order' | 'system';
}

export interface Watchlist {
  id: string;
  name: string;
  items: WatchItem[];
}

export interface WatchItem {
  symbol: string;
  type: InstrumentType | 'EQ';
  strike?: number;
  expiry?: string;
}

/** A watchlist row priced from the live market; values that are not live are null (reason in `reason`). */
export interface WatchQuote extends WatchItem {
  label: string;
  /** Live-session trade price (an expired contract: its settlement price); null when not live. */
  ltp: number | null;
  change: number | null;
  changePct: number | null;
  /** Live best bid/ask (open session, book ≤ 10 s old). */
  bid: number | null;
  ask: number | null;
  oi: number | null;
  oiChangePct: number | null;
  /** Percent: options solved from the live premium, EQ the ATM IV; null otherwise. */
  iv: number | null;
  /** Time of the quote the values come from (epoch ms) and its age when served (s); null without a quote. */
  ts: number | null;
  ageSec: number | null;
  /** Why values are blank. */
  reason?: string;
}

export interface RecapRequest {
  symbol: string;
  legs: Leg[];
  fromTs: number;
  toTs?: number;
  intervalMin?: number;
}

/** Replay of recorded sessions only: a leg's price is the close of its last traded minute in the window. */
export interface RecapPoint {
  ts: number;
  spot: number | null;
  /** Null when a leg without an exit price did not trade in the window. */
  pnl: number | null;
  legLtp: (number | null)[];
}

export interface RecapResponse extends DataGaps {
  points: RecapPoint[];
  maxPnl: number | null;
  minPnl: number | null;
  finalPnl: number | null;
  endTs: number;
  expired: boolean;
  /** Recorded sessions the replay covers. */
  sessions: string[];
}

export interface OptimizerRequest {
  symbol: string;
  expiry: string;
  targetPrice: number;
  targetDate: string;
  stopLoss?: number;
  maxLegs?: 1 | 2 | 3 | 4;
  allowUnlimitedRisk?: boolean;
  maxCapital?: number;
  sortBy?: 'rr' | 'profit' | 'pop';
}

/* ------------------------- opening range & order flow ------------------------- */

/**
 * Opening range of one session. A completed session's ltp/changePct/dayHigh/dayLow are null (with
 * `gaps.day`) when its 1-minute bars do not reach the close: the last bar is not the session's close.
 */
export interface OrbResponse extends DataGaps {
  symbol: string;
  date: string;
  rangeMinutes: number;
  rule: OrbRule;
  rangeStartTs: number;
  rangeEndTs: number;
  live: boolean;
  /** Live price of the underlying (live session), else the session's last bar close (null when the bars stop before the close). */
  ltp: number | null;
  /** vs the previous session's close (quote, else the official close); null when unknown. */
  changePct: number | null;
  /** High/low of the bars so far (live session), else of the whole session (null when the bars stop before the close). */
  dayHigh: number | null;
  dayLow: number | null;
  /** Price vs range (`evaluation.position`, `toHighPct`, `toLowPct`) is taken at this price: the live LTP ('ltp'), else the last recorded 1-minute close ('close'). */
  evaluation: OrbEvaluation;
  /** Which price `evaluation` and `ltp` use: 'ltp' = the live LTP; 'close' = the close of the last recorded 1-minute bar (at `priceTs`). */
  priceSource: 'ltp' | 'close';
  /** Time of that price: the LTP quote's time, else the start of the last recorded 1-minute bar. */
  priceTs: number;
  summary: string;
  /** Traded 1-minute candles from 09:15 (minutes without a trade are absent); the last one may still be forming when `live`. */
  bars: MinuteBar[];
  /** 'recorded' = the app's recorder; 'kotak' = Kotak historical 1-minute candles. */
  source: 'recorded' | 'kotak';
}

export interface OrbScanRow {
  symbol: string;
  name: string;
  kind: 'index' | 'stock';
  sector: string;
  ltp: number;
  changePct: number | null;
  high: number;
  low: number;
  widthPct: number;
  trend: OrbTrend;
  whipsaw: boolean;
  reentered: boolean;
  position: 'above' | 'inside' | 'below';
  /** Live price beyond a level without a confirmed break yet. */
  pending: 'up' | 'down' | null;
  /** Latest break (start of the confirming 1-minute candle). */
  breakTs: number | null;
  breakPrice: number | null;
  /** % beyond the broken level in the trend direction (negative = back inside). */
  beyondPct: number | null;
  toHighPct: number;
  toLowPct: number;
  summary: string;
}

export interface OrbHistoryRow {
  date: string;
  high: number;
  low: number;
  widthPct: number;
  trend: OrbTrend;
  whipsaw: boolean;
  firstBreak: { direction: 'up' | 'down'; ts: number } | null;
  close: number;
  closeVsRange: 'above' | 'inside' | 'below';
  /** Close beyond the first broken level, in the break direction, % (null if never broken). */
  followThroughPct: number | null;
  dayRangePct: number;
  source: 'recorded' | 'kotak';
}

/** Sessions without recorded (or Kotak) 1-minute bars covering the whole day are left out (`gaps.sessions`). */
export interface OrbHistoryResponse extends DataGaps {
  symbol: string;
  rangeMinutes: number;
  rule: OrbRule;
  /** Sessions asked for. */
  sessions: number;
  rows: OrbHistoryRow[];
  /** avgFollowThroughPct: over the days that broke; null when none did. */
  stats: { days: number; brokeUp: number; brokeDown: number; sideways: number; whipsaw: number; trendDays: number; avgFollowThroughPct: number | null };
}

/**
 * Order flow is an ESTIMATE from live ticks (quote rule): each rise of the session volume is
 * classified against the bid/ask seen just before it — at or above the ask = buyer-initiated, at or
 * below the bid = seller-initiated, anything else (or no usable book) = unclassified. It is never
 * split 50/50; the unclassified share is always reported.
 */
export const ORDER_FLOW_METHOD = 'estimated from live ticks (quote rule)' as const;

/** One recorded minute of order flow. volume = buyVolume + sellVolume + unclassified (Δ cumulative volume). */
export interface OrderFlowMinute {
  ts: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  unclassified: number;
  /**
   * Units reported by the first tick after a feed gap that ended in this minute (no tick of the
   * contract for a whole minute or more: a dropped feed, a reconnect): they traded at an unknown time
   * during the gap, so they are not in `volume` and never classified. Null when no gap ended here.
   */
  gapVolume: number | null;
  /** `volume` is a lower bound: recording of the contract started (or restarted) inside this minute. */
  partial: boolean;
  /** buyVolume − sellVolume. */
  delta: number;
  cumDelta: number;
  /** Buy share of the classified volume (%); null when nothing was classified. */
  buyPct: number | null;
  /** Last trade price of the minute; null when the minute had no trade. */
  close: number | null;
}

/** Totals over recorded minutes (see ORDER_FLOW_METHOD). */
export interface OrderFlowSummary {
  buyVolume: number;
  sellVolume: number;
  unclassified: number;
  /** All units traded in the minutes = buyVolume + sellVolume + unclassified (gapVolume excluded). */
  volume: number;
  /** Units reported after feed gaps (traded at an unknown time during the gap): not in `volume`, never classified. */
  gapVolume: number;
  /** Minutes whose volume is a lower bound (recording of the contract started or restarted inside them). */
  partialMinutes: number;
  /** buyVolume − sellVolume. */
  delta: number;
  /** Buy share of the classified volume (%); null when nothing was classified. */
  buyPct: number | null;
  /** Unclassified share of all volume (%); null when nothing traded. */
  unclassifiedPct: number | null;
  /**
   * On the classified volume (±5 points around 50 % = balanced); 'Not classified' when trades happened
   * but none could be classified; 'Feed gap' when the only volume is gapVolume (traded during a feed gap).
   */
  sentiment: 'Buyers dominant' | 'Sellers dominant' | 'Balanced' | 'No trades' | 'Not classified' | 'Feed gap';
}

/** GET /api/order-flow/:symbol — recorded minutes only (503 when the contract was not recorded that session). */
export interface OrderFlowResponse extends DataGaps {
  symbol: string;
  instrument: string;
  type: 'FUT' | 'CE' | 'PE';
  expiry: string;
  strike?: number;
  date: string;
  live: boolean;
  /** Lot size of the contract (instrument master, else the official file of that day); null when unknown. */
  lotSize: number | null;
  /** Always ORDER_FLOW_METHOD: the split is an estimate. */
  method: typeof ORDER_FLOW_METHOD;
  /** Last completed recorded minute. */
  lastMinute: (OrderFlowSummary & { ts: number; close: number | null }) | null;
  /** The minute in progress (live only, when it has a record so far). */
  currentMinute: (OrderFlowSummary & { ts: number; elapsedSec: number }) | null;
  /** Recorded minutes of the 5 minutes ending with `lastMinute`; null without one. */
  last5: OrderFlowSummary | null;
  /** All recorded minutes of the session. */
  session: OrderFlowSummary;
  /** Completed recorded minutes, oldest first (the most recent `limit`). Minutes without a record are absent, never filled. */
  minutes: OrderFlowMinute[];
  signal: string;
  /** Which minutes the figures cover (first–last recorded, minutes without a record). */
  coverage: string;
  /** Contracts listed (today) or recorded (a past session), for pickers. */
  expiries: string[];
  strikes: number[];
}

/* ------------------------------- dashboard ------------------------------- */

/** A stock on the dashboard: live spot price/change, its near future's OI change and build-up. */
export interface DashboardMover {
  symbol: string;
  /** Live-session spot price; null when the spot has no trade this session. */
  ltp: number | null;
  /** Spot change vs the previous close; null when either is unknown. */
  changePct: number | null;
  /** Near-month future OI change vs the previous session's OI; null when either is unknown. */
  oiChangePct: number | null;
  buildUp: BuildUp | null;
}

/** One index card: live chain aggregates, the opening range and the last recorded minute's flow; each part blank (with `gaps`) on its own. */
export interface DashboardChain extends DataGaps {
  symbol: string;
  expiry: string | null;
  spot: number | null;
  pcr: number | null;
  maxPain: number | null;
  atmIv: number | null;
  ivChange: number | null;
  support: number | null;
  resistance: number | null;
  daysToExpiry: number | null;
  /** Strikes the OI aggregates (PCR, max pain, support/resistance) cover. */
  coverage: string | null;
  /**
   * Opening range of session `date`: today's once it has opened (`live` while the session is open);
   * before 09:15 (and on holidays) the previous session's, which `note` says.
   */
  orb: { date: string; live: boolean; note: string | null; high: number; low: number; trend: OrbTrend; whipsaw: boolean; reentered: boolean; summary: string } | null;
  /**
   * Near future's last completed recorded minute (quote-rule estimate, see `method`). `gapVolume`: units
   * reported after a feed gap that ended in that minute (never classified); `partial`: its volume is a
   * lower bound (recording started inside it); `note` explains either.
   */
  flow: {
    buyPct: number | null;
    unclassifiedPct: number | null;
    delta: number;
    sentiment: OrderFlowSummary['sentiment'];
    method: typeof ORDER_FLOW_METHOD;
    ts: number;
    gapVolume: number;
    partial: boolean;
    note: string | null;
  } | null;
}

/**
 * Home page. Every card is filled on its own from live/official data; a card that cannot be filled
 * is empty/null with its reason in `gaps` (indices, movers, oiGainers, buildUpCounts, fiiDii) — one
 * missing card never fails the whole response.
 */
export interface DashboardResponse extends DataGaps {
  clock: MarketClockInfo;
  /** Index quotes with a live-session price (indices without one are listed in `gaps.indices`). */
  indices: Quote[];
  /** Stocks up the most / down the most today (live spot change; only stocks with one). */
  gainers: DashboardMover[];
  losers: DashboardMover[];
  /** Stocks whose near future added the most OI vs the previous session. */
  oiGainers: DashboardMover[];
  /** Live build-up of the stock near futures that have one (`buildUpClassified` of `buildUpTotal`); null when none has. */
  buildUpCounts: BuildUpCounts | null;
  buildUpClassified: number;
  buildUpTotal: number;
  chains: DashboardChain[];
  /** The latest official FII/DII days (up to 5), oldest first. */
  fiiDii: FiiDiiDay[];
}

/* ------------------------------- websocket ------------------------------- */

/**
 * Server → client. 'ticks' carries the underlyings that changed since the last batch (at most one
 * batch per second); a batch with no quotes is the periodic clock/feed-status heartbeat.
 */
export type ServerMessage =
  | { type: 'hello'; clock: MarketClockInfo }
  | { type: 'ticks'; clock: MarketClockInfo; quotes: Quote[] }
  | { type: 'notification'; notification: Notification }
  | { type: 'order'; order: Order };

/** Client → server. `subscribe` lists underlying symbols (validated against the instrument master, at most 40). */
export type ClientMessage = { type: 'auth'; token: string } | { type: 'subscribe'; symbols: string[] };

/* ------------------------- operations (Model F) -------------------------- */

/** One entry of the operations journal (login monitor, watchdog, weekly audit). Never carries secrets. */
export interface OpsEvent {
  ts: number;
  source: 'login' | 'watchdog' | 'audit' | 'server';
  level: 'info' | 'warn' | 'error';
  /** Machine-readable kind, e.g. LOGIN_OK, LOGIN_FAILED, SESSION_LOST, FEED_RESTARTED. */
  type: string;
  message: string;
}

/**
 * LOGGED_IN: a Kotak session is live. LOGGING_IN: an attempt is running or due now. WAITING: the
 * last attempt failed and the next one is armed (nextAttemptAt). DISCONNECTED: no session and
 * nothing armed (the monitor arms one within seconds). PAUSED: Kotak refused several logins in a
 * row; automatic logins wait for "Re-login now" or a restart with fixed credentials (protects the
 * account from a lock-out). NO_CREDENTIALS: NEO_* variables missing.
 */
export type LoginMonitorState = 'LOGGED_IN' | 'LOGGING_IN' | 'WAITING' | 'PAUSED' | 'DISCONNECTED' | 'NO_CREDENTIALS' | 'STOPPED';

export interface LoginMonitorStatus {
  state: LoginMonitorState;
  /** One plain-language line for the dashboard. */
  detail: string;
  checkEveryMs: number;
  lastCheckAt: number | null;
  loggedInAt?: number;
  tokenExpiresAt?: number;
  nextReloginAt?: number;
  /** Next automatic login attempt while not logged in. */
  nextAttemptAt?: number;
  lastFailure?: { at: number; reason: string };
  /** Failed attempts since the last successful login. */
  consecutiveFailures: number;
  /** Counts for the current IST day. */
  today: { logins: number; failures: number; sessionLosses: number };
  /** Most recent first. */
  events: OpsEvent[];
}

export type WatchdogCheckResult = 'ok' | 'warn' | 'fail' | 'fixed' | 'skipped';

export interface WatchdogCheck {
  id: string;
  title: string;
  result: WatchdogCheckResult;
  detail: string;
  /** What the watchdog did about it (when result is 'fixed', or an attempted fix). */
  action?: string;
}

export interface WatchdogStatus {
  state: 'HEALTHY' | 'DEGRADED' | 'CRITICAL' | 'STARTING';
  intervalMs: number;
  lastRunAt: number | null;
  runs: number;
  /** Started by scripts/supervise.mjs (restarts the server after a crash or hang). */
  supervised: boolean;
  process: { pid: number; uptimeSec: number; rssMb: number; heapUsedMb: number; heapLimitMb: number; eventLoopP99Ms: number | null };
  checks: WatchdogCheck[];
  /** Recent warnings, failures and fixes, most recent first. */
  incidents: OpsEvent[];
}

export type AuditItemStatus = 'PASS' | 'WARN' | 'FAIL' | 'FIXED' | 'SKIPPED';

export interface AuditItem {
  id: string;
  area: string;
  title: string;
  status: AuditItemStatus;
  detail: string;
  /** The automatic fix applied (FIXED) or attempted. */
  fix?: string;
}

export interface AuditReport {
  id: string;
  trigger: 'schedule' | 'manual' | 'catch-up';
  /** Saturday-to-Saturday window the audit covers (epoch ms). */
  window: { from: number; to: number };
  startedAt: number;
  finishedAt: number;
  summary: Record<AuditItemStatus, number>;
  verdict: 'HEALTHY' | 'ATTENTION' | 'FAILING';
  items: AuditItem[];
}

export interface AuditReportSummary {
  id: string;
  trigger: AuditReport['trigger'];
  finishedAt: number;
  verdict: AuditReport['verdict'];
  summary: AuditReport['summary'];
}

export interface WeeklyAuditStatus {
  running: boolean;
  /** e.g. "Every Saturday 10:00 IST". */
  schedule: string;
  nextRunAt: number | null;
  last: AuditReport | null;
  history: AuditReportSummary[];
}

/** Market-data state as the dashboard must show it (never a green light without a fresh tick). */
export type FeedState = 'LIVE' | 'FEED STALE' | 'DATA UNAVAILABLE' | 'MARKET CLOSED';

export interface OpsStatusResponse {
  login: LoginMonitorStatus;
  watchdog: WatchdogStatus;
  audit: WeeklyAuditStatus;
  broker: 'CONNECTED' | 'DISCONNECTED';
  feed: FeedState;
  /** Paper trading only: no code path sends an order to a broker. */
  safety: { mode: 'paper'; autoExecutionToBroker: false; liveOrderAuthority: false; brokerSubmission: false };
  /** Live order placement is not part of this program: always NOT READY for live trading. */
  liveTrading: 'NOT READY';
}

export interface OpsActionResponse {
  ok: boolean;
  message: string;
  status: OpsStatusResponse;
}
