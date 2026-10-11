/**
 * Wire types shared by the API server and the web client.
 */
import type { BuildUp } from './oi';
import type { InstrumentType, Leg, Side } from './payoff';
import type { ExpiryRule } from './dates';

export type MarketStatusCode = 'open' | 'pre-open' | 'closed';

export interface MarketClockInfo {
  ts: number;
  date: string;
  time: string;
  status: MarketStatusCode;
  /** Minutes since 09:15 (0..375). */
  sessionMinute: number;
  mode: 'demo' | 'live';
  speed: number;
}

export interface SymbolInfo {
  symbol: string;
  name: string;
  kind: 'index' | 'stock';
  exchange: 'NSE' | 'BSE';
  sector: string;
  lotSize: number;
  strikeStep: number;
  expiryRule: ExpiryRule;
}

export interface MetaResponse {
  appName: string;
  dataSource: 'simulated' | 'live';
  riskFreeRate: number;
  clock: MarketClockInfo;
  symbols: SymbolInfo[];
}

export interface Quote {
  symbol: string;
  ltp: number;
  change: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  future: number;
  futureChange: number;
  atmIv: number;
  ts: number;
}

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OptionQuote {
  ltp: number;
  change: number;
  changePct: number;
  prevClose: number;
  oi: number;
  prevOi: number;
  oiChange: number;
  oiChangePct: number;
  volume: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  buildUp: BuildUp;
  intrinsic: number;
  timeValue: number;
}

export interface ChainRow {
  strike: number;
  ce: OptionQuote;
  pe: OptionQuote;
}

export interface OptionChain {
  symbol: string;
  expiry: string;
  expiries: string[];
  ts: number;
  spot: number;
  spotChange: number;
  spotChangePct: number;
  future: number;
  futureExpiry: string;
  /** Carry yield implied by this expiry's synthetic forward. */
  carry: number;
  lotSize: number;
  strikeStep: number;
  daysToExpiry: number;
  atm: number;
  atmIv: number;
  ivChange: number;
  pcr: number;
  pcrVolume: number;
  maxPain: number;
  totalCeOi: number;
  totalPeOi: number;
  totalCeOiChange: number;
  totalPeOiChange: number;
  support: number;
  resistance: number;
  rows: ChainRow[];
}

export interface FuturesQuote {
  symbol: string;
  expiry: string;
  ltp: number;
  change: number;
  changePct: number;
  oi: number;
  oiChange: number;
  oiChangePct: number;
  volume: number;
  basis: number;
  buildUp: BuildUp;
}

export interface TimePoint {
  ts: number;
}

export interface StrikeOiRow {
  strike: number;
  ceOi: number;
  peOi: number;
  ceChange: number;
  peChange: number;
  ceVolume: number;
  peVolume: number;
}

export interface StrikeOiResponse {
  symbol: string;
  expiry: string;
  spot: number;
  fromTs: number;
  toTs: number;
  rows: StrikeOiRow[];
  maxPain: number;
  pcr: number;
}

export interface MultiStrikeSeries {
  strike: number;
  type: 'CE' | 'PE';
  oi: number[];
  ltp: number[];
  iv: number[];
}

export interface MultiStrikeResponse {
  symbol: string;
  expiry: string;
  times: number[];
  spot: number[];
  series: MultiStrikeSeries[];
}

export interface OiTrendPoint extends TimePoint {
  spot: number;
  ceOi: number;
  peOi: number;
  ceChange: number;
  peChange: number;
  pcr: number;
  maxPain: number;
  atmIv: number;
}

export interface DailyPcrPoint {
  date: string;
  pcr: number;
  close: number;
}

export interface FuturesBuildUpRow {
  symbol: string;
  name: string;
  sector: string;
  kind: 'index' | 'stock';
  ltp: number;
  changePct: number;
  oi: number;
  oiChangePct: number;
  volume: number;
  buildUp: BuildUp;
  lotSize: number;
}

export type BuildUpCounts = Record<BuildUp, number>;

export interface BreadthResponse {
  overall: BuildUpCounts;
  sectors: { sector: string; counts: BuildUpCounts; symbols: FuturesBuildUpRow[] }[];
  history: { date: string; counts: BuildUpCounts }[];
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
}

export interface IvChartResponse {
  symbol: string;
  intraday: { ts: number; atmIv: number; spot: number; ceIv: number; peIv: number }[];
  daily: { date: string; iv: number; hv: number; close: number }[];
  ivr: number;
  ivp: number;
}

export interface IvTableRow {
  symbol: string;
  kind: 'index' | 'stock';
  sector: string;
  ltp: number;
  changePct: number;
  iv: number;
  ivChange: number;
  ivr: number;
  ivp: number;
  hv: number;
  ivHvSpread: number;
}

export interface SkewPoint {
  strike: number;
  moneyness: number;
  ceIv: number;
  peIv: number;
  iv: number;
}

export interface SkewResponse {
  symbol: string;
  spot: number;
  curves: { expiry: string; label: string; atmIv: number; points: SkewPoint[] }[];
}

export interface SurfaceResponse {
  symbol: string;
  spot: number;
  expiries: string[];
  daysToExpiry: number[];
  moneyness: number[];
  /** iv[expiryIdx][moneynessIdx] in percent */
  iv: number[][];
}

export interface StraddlePoint extends TimePoint {
  spot: number;
  strike: number;
  ce: number;
  pe: number;
  straddle: number;
  iv: number;
}

export interface StrategyChartPoint extends TimePoint {
  spot: number;
  premium: number;
  pnl: number;
  delta: number;
  theta: number;
  vega: number;
  gamma: number;
}

export interface ScannerRow {
  symbol: string;
  instrument: string;
  type: InstrumentType | 'EQ';
  strike?: number;
  expiry?: string;
  ltp: number;
  changePct: number;
  oi: number;
  oiChangePct: number;
  volume: number;
  iv?: number;
  ivChange?: number;
  ivp?: number;
  buildUp?: BuildUp;
  metric: number;
  metricLabel: string;
}

export interface ScannerDef {
  id: string;
  name: string;
  category: 'OI' | 'Price' | 'IV' | 'Build-up' | 'Volume' | 'Options';
  description: string;
}

export interface UnusualActivityRow {
  symbol: string;
  type: 'CE' | 'PE';
  strike: number;
  expiry: string;
  ltp: number;
  changePct: number;
  oi: number;
  oiChange: number;
  oiChangePct: number;
  volume: number;
  volumeOiRatio: number;
  iv: number;
  ivChange: number;
  premiumTurnover: number;
  score: number;
  signal: string;
  buildUp: BuildUp;
}

export interface SynopsisRow {
  symbol: string;
  name: string;
  sector: string;
  ltp: number;
  changePct: number;
  oiChangePct: number;
  ivChange: number;
  iv: number;
  turnover: number;
  buildUp: BuildUp;
  pcr: number;
}

export interface DepthLevel {
  price: number;
  qty: number;
  orders: number;
}

export interface OrderBookResponse {
  instrument: string;
  ltp: number;
  change: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  vwap: number;
  volume: number;
  oi: number;
  bids: DepthLevel[];
  asks: DepthLevel[];
  totalBidQty: number;
  totalAskQty: number;
  spread: number;
  spreadPct: number;
  imbalance: number;
  lastTradeQty: number;
  upperCircuit: number;
  lowerCircuit: number;
  history: { ts: number; ltp: number; bidQty: number; askQty: number; ratio: number; spread: number; vwap: number }[];
  analytics: { label: string; value: string; hint?: string; tone?: 'up' | 'down' | 'neutral' }[];
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
  /** Computed by the server on read. */
  live?: { mtm: number; realized: number; spot: number; legsLtp: number[]; ts: number };
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
  lotSize: number;
  avgPrice: number;
  buyQty: number;
  sellQty: number;
  buyValue: number;
  sellValue: number;
  ltp: number;
  realized: number;
  unrealized: number;
  pnl: number;
  status: 'open' | 'closed' | 'expired';
}

export interface Funds {
  openingBalance: number;
  available: number;
  usedMargin: number;
  realizedPnl: number;
  unrealizedPnl: number;
  premiumPaid: number;
  premiumReceived: number;
}

export type AlertKind = 'PRICE' | 'OPTION_PRICE' | 'IV' | 'PCR' | 'OI_CHANGE' | 'MTM';

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
  triggeredAt?: number;
  triggeredValue?: number;
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

export interface WatchQuote extends WatchItem {
  label: string;
  ltp: number;
  change: number;
  changePct: number;
  oi?: number;
  oiChangePct?: number;
  iv?: number;
}

export interface RecapRequest {
  symbol: string;
  legs: Leg[];
  fromTs: number;
  toTs?: number;
  intervalMin?: number;
}

export interface RecapPoint {
  ts: number;
  spot: number;
  pnl: number;
  legLtp: number[];
}

export interface RecapResponse {
  points: RecapPoint[];
  maxPnl: number;
  minPnl: number;
  finalPnl: number;
  endTs: number;
  expired: boolean;
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

/* ------------------------------- websocket ------------------------------- */

export type ServerMessage =
  | { type: 'hello'; clock: MarketClockInfo }
  | { type: 'ticks'; clock: MarketClockInfo; quotes: Quote[] }
  | { type: 'notification'; notification: Notification }
  | { type: 'order'; order: Order };

export type ClientMessage = { type: 'auth'; token: string } | { type: 'subscribe'; symbols: string[] };
