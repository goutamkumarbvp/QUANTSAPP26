/**
 * Market-wide tools on live data: F&O scanners, unusual option activity, the synopsis heat-map, the
 * order book (exchange market depth) and order flow. Nothing here is synthesised:
 *  - near futures and spots: live quotes through services/live (a price only when it is a trade of
 *    the live session; previous close/OI from the quote, else the previous session's official files);
 *  - options: Analytics.optionSnapshot() (live premiums, IV solved from them by md.pricing, previous
 *    values from quotes / official files); turnover = session volume × the exchange's average traded
 *    price (ATP), null when the feed sent no ATP;
 *  - IV scanners and the ORB scan: Analytics.ivTable() / orbScan() (IV solved from premiums,
 *    recorded 1-minute bars);
 *  - order book: the 5-level depth the feed streams for the contract (it is watched at level
 *    'depth' on request; 503 until a depth packet arrives); its history only from recorded minutes;
 *  - order flow: the recorder's quote-rule classification of live ticks: an ESTIMATE, labelled as
 *    such, with the unclassified volume always reported (never a 50/50 split).
 * Rows without live inputs are left out and every market-wide response says how much was live
 * (`coverage`); a response with nothing live is NoLiveData (HTTP 503).
 */
import {
  classifyBuildUp,
  expiryTs,
  formatCompact,
  formatExpiry,
  formatTimeIST,
  ORDER_FLOW_METHOD,
  SESSION_MINUTES,
  type BuildUp,
  type DepthLevel,
  type OrderBookResponse,
  type OrderFlowMinute,
  type OrderFlowResponse,
  type OrderFlowSummary,
  type ScannerDef,
  type ScannerResponse,
  type ScannerRow,
  type SynopsisResponse,
  type SynopsisRow,
  type UnusualActivityRow,
  type UnusualResponse,
} from '@q26/core';
import { NoLiveData } from '../live/types';
import type { DepthLevel as LiveDepthLevel, InstrumentKey, LiveQuote, MarketDataProvider, MinuteRecord, OptKind, WatchLevel } from '../live/types';
import type { Analytics } from './analytics';
import {
  BOOK_MAX_AGE_MS,
  changeOf,
  currentSession,
  futKey,
  futuresQuotes,
  Gaps,
  httpError,
  liveOptionExpiries,
  livePrice,
  nearFuture,
  optKey,
  r2,
  requireDate,
  requireRecorded,
  sessionDateOf,
  spotKey,
  underlyingQuote,
} from './live';

const MINUTE = 60_000;
/** Order-book history: one point per block of this many recorded minutes (the block's last minute). */
const BOOK_HISTORY_STEP_MIN = 5;
/** Balanced band of the order-flow sentiment: buy share of the classified volume within 50 ± this. */
const FLOW_BALANCED_BAND = 5;

export const SCANNERS: ScannerDef[] = [
  { id: 'long-buildup', name: 'Long Build-up', category: 'Build-up', description: 'Near-month futures with price ↑ and OI ↑ vs the previous session — fresh longs.' },
  { id: 'short-buildup', name: 'Short Build-up', category: 'Build-up', description: 'Near-month futures with price ↓ and OI ↑ vs the previous session — fresh shorts.' },
  { id: 'short-covering', name: 'Short Covering', category: 'Build-up', description: 'Near-month futures with price ↑ and OI ↓ vs the previous session — shorts exiting.' },
  { id: 'long-unwinding', name: 'Long Unwinding', category: 'Build-up', description: 'Near-month futures with price ↓ and OI ↓ vs the previous session — longs exiting.' },
  { id: 'oi-gainers', name: 'OI Gainers', category: 'OI', description: 'Largest % increase in near-month futures open interest.' },
  { id: 'oi-losers', name: 'OI Losers', category: 'OI', description: 'Largest % decrease in near-month futures open interest.' },
  { id: 'price-gainers', name: 'Top Gainers', category: 'Price', description: 'F&O stocks with the highest % gain.' },
  { id: 'price-losers', name: 'Top Losers', category: 'Price', description: 'F&O stocks with the largest % fall.' },
  { id: 'iv-gainers', name: 'IV Gainers', category: 'IV', description: 'Largest rise in ATM implied volatility (solved from live premiums) vs the previous close.' },
  { id: 'iv-losers', name: 'IV Losers', category: 'IV', description: 'Largest fall in ATM implied volatility (solved from live premiums) vs the previous close.' },
  { id: 'high-ivp', name: 'High IV Percentile', category: 'IV', description: 'IV in the top of its 1-year range (official closing premiums) — premium selling candidates.' },
  { id: 'low-ivp', name: 'Low IV Percentile', category: 'IV', description: 'IV near its 1-year low (official closing premiums) — premium buying candidates.' },
  { id: 'most-active-calls', name: 'Most Active Calls', category: 'Options', description: 'Call options with the highest traded value (volume × average traded price).' },
  { id: 'most-active-puts', name: 'Most Active Puts', category: 'Options', description: 'Put options with the highest traded value (volume × average traded price).' },
  { id: 'call-writing', name: 'Call Writing', category: 'Options', description: 'Calls with the largest OI addition while premium falls.' },
  { id: 'put-writing', name: 'Put Writing', category: 'Options', description: 'Puts with the largest OI addition while premium falls.' },
  { id: 'highest-call-oi', name: 'Highest Call OI', category: 'Options', description: 'Call strikes with the most open interest.' },
  { id: 'highest-put-oi', name: 'Highest Put OI', category: 'Options', description: 'Put strikes with the most open interest.' },
  { id: 'volume-oi-spike', name: 'Volume / OI Spike', category: 'Volume', description: 'Options trading far more than their open interest.' },
  { id: 'premium-gainers', name: 'Option Premium Gainers', category: 'Options', description: 'Options with the largest % premium gain.' },
  { id: 'orb-up', name: '15-min Range Breakout ↑', category: 'Trend', description: 'Broke above the first 15-minute candle high (recorded 1-min close) — trending up.' },
  { id: 'orb-down', name: '15-min Range Breakdown ↓', category: 'Trend', description: 'Broke below the first 15-minute candle low (recorded 1-min close) — trending down.' },
  { id: 'orb-inside', name: 'Inside 15-min Range', category: 'Trend', description: 'Still inside the opening 15-minute range (recorded 1-min bars) — not trending yet.' },
];

/* ------------------------------------------------------------------------------------------ */
/* Small helpers                                                                                */
/* ------------------------------------------------------------------------------------------ */

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isPos = (v: unknown): v is number => isNum(v) && v > 0;
/** A finite number, else null (the analytics rows may carry nulls for values that are not live). */
const num = (v: unknown): number | null => (isNum(v) ? v : null);
const r1 = (v: number): number => Math.round(v * 10) / 10;
const fix = (v: number, d = 2): number => +v.toFixed(d);

/** Rows of an analytics result: an array, or an object holding `rows`. */
function rowsOf(x: unknown): Record<string, unknown>[] {
  const arr: unknown = Array.isArray(x) ? x : x && typeof x === 'object' ? (x as { rows?: unknown }).rows : undefined;
  return Array.isArray(arr) ? arr.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object') : [];
}

export interface ContractSpec {
  type: 'FUT' | 'CE' | 'PE';
  strike?: number;
  expiry?: string;
}

/** Options of the live views (order book, order flow). */
export interface ToolViewOptions {
  /** Called with the contract before anything can fail, so the route can stream it in the provider's 'user' tier (services.userWatches.touch). */
  touch?: (key: InstrumentKey, level: WatchLevel) => void;
}

interface Contract {
  key: InstrumentKey;
  symbol: string;
  expiry: string;
  strike?: number;
  label: string;
  expiries: string[];
  strikes: number[];
}

/** One option of the market-wide snapshot, normalised (null = not live / not available). */
interface SnapRow {
  symbol: string;
  type: OptKind;
  strike: number;
  expiry: string;
  spot: number | null;
  ltp: number | null;
  prevLtp: number | null;
  changePct: number | null;
  oi: number | null;
  prevOi: number | null;
  oiChange: number | null;
  oiChangePct: number | null;
  volume: number | null;
  iv: number | null;
  prevIv: number | null;
  /** volume × ATP (₹); null without an ATP. */
  turnover: number | null;
}

interface NearFutureRow {
  symbol: string;
  kind: 'index' | 'stock';
  expiry: string;
  ltp: number | null;
  changePct: number | null;
  oi: number | null;
  oiChangePct: number | null;
  volume: number | null;
  buildUp: BuildUp | null;
}

/** Flow of one recorded minute (volume = buy + sell + unclassified). */
interface FlowMin {
  ts: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
  unclassified: number;
  close: number | null;
}

/** Last completed recorded minute of an underlying's near-month future (dashboard, alerts). */
export type LastMinuteFlow = OrderFlowSummary & { ts: number; close: number | null; expiry: string; method: typeof ORDER_FLOW_METHOD };

/**
 * A recorded minute as order flow. The recorder classifies every unit of Δvolume (buy / sell /
 * unclassified); a record without the split is counted as unclassified, never divided up.
 */
function flowOf(r: MinuteRecord): FlowMin {
  const buy = isNum(r.buyVolume) && r.buyVolume > 0 ? r.buyVolume : 0;
  const sell = isNum(r.sellVolume) && r.sellVolume > 0 ? r.sellVolume : 0;
  const unclassified = Math.max(0, (r.volume as number) - buy - sell);
  return { ts: r.ts, volume: buy + sell + unclassified, buyVolume: buy, sellVolume: sell, unclassified, close: r.traded ? r.close : null };
}

/** Totals over minutes; shares are of the classified volume, the unclassified share is reported beside them. */
export function summariseOrderFlow(minutes: readonly { volume: number; buyVolume: number; sellVolume: number; unclassified: number }[]): OrderFlowSummary {
  let buy = 0;
  let sell = 0;
  let uncl = 0;
  for (const m of minutes) {
    buy += m.buyVolume;
    sell += m.sellVolume;
    uncl += m.unclassified;
  }
  const classified = buy + sell;
  const volume = classified + uncl;
  const buyPct = classified > 0 ? r1((buy / classified) * 100) : null;
  let sentiment: OrderFlowSummary['sentiment'];
  if (volume === 0) sentiment = 'No trades';
  else if (buyPct === null) sentiment = 'Not classified';
  else if (buyPct >= 50 + FLOW_BALANCED_BAND) sentiment = 'Buyers dominant';
  else if (buyPct <= 50 - FLOW_BALANCED_BAND) sentiment = 'Sellers dominant';
  else sentiment = 'Balanced';
  return { buyVolume: buy, sellVolume: sell, unclassified: uncl, volume, delta: buy - sell, buyPct, unclassifiedPct: volume > 0 ? r1((uncl / volume) * 100) : null, sentiment };
}

function signalFor(type: OptKind, bu: BuildUp | null): string {
  const call = type === 'CE';
  switch (bu) {
    case 'Short Build-up':
      return call ? 'Call writing — bearish' : 'Put writing — bullish';
    case 'Long Build-up':
      return call ? 'Call buying — bullish' : 'Put buying — bearish';
    case 'Short Covering':
      return call ? 'Call short covering — bullish' : 'Put short covering — bearish';
    case 'Long Unwinding':
      return call ? 'Call long unwinding — bearish' : 'Put long unwinding — bullish';
    case null:
      return 'Build-up unknown (no previous close)';
    default:
      return 'Neutral';
  }
}

const tone = (x: number) => (x > 0 ? 'up' : x < 0 ? 'down' : 'neutral') as 'up' | 'down' | 'neutral';

/* ------------------------------------------------------------------------------------------ */
/* Service                                                                                      */
/* ------------------------------------------------------------------------------------------ */

export class MarketTools {
  constructor(
    private readonly md: MarketDataProvider,
    private readonly analytics: Analytics,
  ) {}

  /* ------------------------------- market-wide inputs ------------------------------- */

  /** The option snapshot, normalised; turnover from the row's ATP or the live quote's. */
  private async snapshot(ts: number): Promise<SnapRow[]> {
    const md = this.md;
    const raw = rowsOf(await this.analytics.optionSnapshot(ts));
    const out: SnapRow[] = [];
    const spots = new Map<string, number | null>();
    const liveSpot = (symbol: string): number | null => {
      if (!spots.has(symbol)) spots.set(symbol, livePrice(md, md.live.quote(spotKey(symbol))));
      return spots.get(symbol) ?? null;
    };
    for (const r of raw) {
      const type = r.type === 'CE' || r.type === 'PE' ? r.type : null;
      const strike = num(r.strike);
      const expiry = typeof r.expiry === 'string' ? r.expiry : null;
      if (typeof r.symbol !== 'string' || !type || strike === null || !expiry) continue;
      const ltp = isPos(r.ltp) ? r.ltp : null;
      const prevLtp = isPos(r.prevLtp) ? r.prevLtp : null;
      const oi = num(r.oi);
      const prevOi = num(r.prevOi);
      const volume = num(r.volume);
      const oiChange = num(r.oiChange) ?? (oi !== null && prevOi !== null ? oi - prevOi : null);
      let atp = isPos(r.atp) ? r.atp : null;
      if (atp === null && ltp !== null) {
        const q = md.live.quote(optKey(r.symbol, expiry, type, strike));
        if (q && isPos(q.atp) && livePrice(md, q) !== null) atp = q.atp;
      }
      out.push({
        symbol: r.symbol,
        type,
        strike,
        expiry,
        spot: isPos(r.spot) ? r.spot : liveSpot(r.symbol),
        ltp,
        prevLtp,
        changePct: num(r.changePct) ?? changeOf(ltp, prevLtp).changePct,
        oi,
        prevOi,
        oiChange,
        oiChangePct: num(r.oiChangePct) ?? (oiChange !== null && prevOi ? r2((oiChange / prevOi) * 100) : null),
        volume,
        iv: num(r.iv),
        prevIv: num(r.prevIv),
        turnover: ltp !== null && atp !== null && volume !== null ? Math.round(volume * atp) : null,
      });
    }
    return out;
  }

  /** "N of M underlyings with live option prices …" for responses built on the snapshot. */
  private snapshotCoverage(rows: readonly SnapRow[]): string {
    const unds = this.md.ref.underlyings();
    const live = rows.filter((r) => r.ltp !== null);
    const syms = new Set(live.map((r) => r.symbol));
    const stocks = unds.some((u) => u.kind === 'stock');
    return `${syms.size} of ${unds.length} underlyings with live option prices (${live.length} contracts, nearest expiry)${stocks ? '; stock options refresh about every 90 s' : ''}`;
  }

  /** Near-month future of every underlying that lists one (services/live futuresQuotes: nulls where not live). */
  private nearFutures(): { rows: NearFutureRow[]; listed: number } {
    const md = this.md;
    const rows: NearFutureRow[] = [];
    let listed = 0;
    for (const u of md.ref.underlyings()) {
      const fe = nearFuture(md, u.symbol);
      if (!fe) continue;
      listed++;
      let q: ReturnType<typeof futuresQuotes>[number] | undefined;
      try {
        q = futuresQuotes(md, u.symbol).find((f) => f.expiry === fe);
      } catch (e) {
        if (e instanceof NoLiveData) continue;
        throw e;
      }
      if (!q) continue;
      rows.push({ symbol: u.symbol, kind: u.kind, expiry: fe, ltp: q.ltp, changePct: q.changePct, oi: q.oi, oiChangePct: q.oiChangePct, volume: q.volume, buildUp: q.buildUp });
    }
    return { rows, listed };
  }

  /* ------------------------------------ scanners ------------------------------------ */

  async scanner(id: string, ts: number, limit = 25): Promise<ScannerResponse> {
    const def = SCANNERS.find((s) => s.id === id);
    if (!def) throw httpError(404, `Unknown scanner ${id}`);
    const md = this.md;
    const lim = Math.max(1, Math.min(100, Math.floor(Number.isFinite(limit) ? limit : 25)));
    const top = <T>(rows: T[], key: (r: T) => number) => [...rows].sort((x, y) => key(y) - key(x)).slice(0, lim);
    const gaps = new Gaps();
    const done = (rows: ScannerRow[], coverage: string): ScannerResponse => ({ id, rows, coverage, ...gaps.out() });

    const futRow = (r: NearFutureRow, metric: number, label: string): ScannerRow => ({
      symbol: r.symbol,
      instrument: `${r.symbol} ${formatExpiry(r.expiry)} FUT`,
      type: 'FUT',
      expiry: r.expiry,
      ltp: r.ltp,
      changePct: r.changePct,
      oi: r.oi,
      oiChangePct: r.oiChangePct,
      volume: r.volume,
      buildUp: r.buildUp,
      metric: fix(metric),
      metricLabel: label,
    });
    const optRow = (r: SnapRow, metric: number, label: string): ScannerRow => ({
      symbol: r.symbol,
      instrument: `${r.symbol} ${formatExpiry(r.expiry)} ${r.strike} ${r.type}`,
      type: r.type,
      strike: r.strike,
      expiry: r.expiry,
      ltp: r.ltp,
      changePct: r.changePct,
      oi: r.oi,
      oiChangePct: r.oiChangePct,
      volume: r.volume,
      iv: r.iv,
      ivChange: r.iv !== null && r.prevIv !== null ? fix(r.iv - r.prevIv) : null,
      buildUp: r.ltp !== null && r.prevLtp !== null && r.oiChange !== null ? classifyBuildUp(r.ltp - r.prevLtp, r.oiChange) : null,
      metric: fix(metric),
      metricLabel: label,
    });
    const eqRow = (symbol: string, v: { ltp: number | null; changePct: number | null }, metric: number, label: string, extra: Partial<ScannerRow> = {}): ScannerRow => ({
      symbol,
      instrument: symbol,
      type: 'EQ',
      ltp: v.ltp,
      changePct: v.changePct,
      oi: null,
      oiChangePct: null,
      volume: null,
      ...extra,
      metric: fix(metric),
      metricLabel: label,
    });

    switch (id) {
      case 'long-buildup':
      case 'short-buildup':
      case 'short-covering':
      case 'long-unwinding':
      case 'oi-gainers':
      case 'oi-losers': {
        const { rows, listed } = this.nearFutures();
        const usable = rows.filter((r) => r.oiChangePct !== null && (def.category !== 'Build-up' || r.buildUp !== null));
        const live = rows.filter((r) => r.ltp !== null || r.oi !== null).length;
        if (!usable.length) {
          throw new NoLiveData(
            live
              ? `${live} of ${listed} near-month futures are live, but none has both its live OI and the previous session's OI${def.category === 'Build-up' ? ' and close' : ''} (official F&O file not loaded yet?)`
              : 'No live near-month futures quotes',
          );
        }
        const coverage = `${usable.length} of ${listed} near-month futures with live ${def.category === 'Build-up' ? 'price and ' : ''}OI vs the previous session`;
        if (def.category === 'Build-up') {
          const want = ({ 'long-buildup': 'Long Build-up', 'short-buildup': 'Short Build-up', 'short-covering': 'Short Covering', 'long-unwinding': 'Long Unwinding' } as const)[id as 'long-buildup'];
          return done(
            top(usable.filter((r) => r.buildUp === want), (r) => Math.abs(r.oiChangePct as number)).map((r) => futRow(r, r.oiChangePct as number, 'OI Chg %')),
            coverage,
          );
        }
        const sign = id === 'oi-gainers' ? 1 : -1;
        return done(top(usable, (r) => sign * (r.oiChangePct as number)).map((r) => futRow(r, r.oiChangePct as number, 'OI Chg %')), coverage);
      }

      case 'price-gainers':
      case 'price-losers': {
        const sign = id === 'price-gainers' ? 1 : -1;
        const stocks = md.ref.underlyings().filter((u) => u.kind === 'stock');
        const futs = new Map(this.nearFutures().rows.map((r) => [r.symbol, r]));
        const quotes: { symbol: string; ltp: number; changePct: number }[] = [];
        let noPrev = 0;
        for (const u of stocks) {
          try {
            const q = underlyingQuote(md, u.symbol);
            if (q.changePct === null) noPrev++;
            else quotes.push({ symbol: u.symbol, ltp: q.ltp, changePct: q.changePct });
          } catch (e) {
            if (!(e instanceof NoLiveData)) throw e;
          }
        }
        if (!quotes.length) throw new NoLiveData(noPrev ? `${noPrev} stocks are live but their previous close is not available` : 'No live F&O stock prices');
        if (noPrev) gaps.add('changePct', `${noPrev} live stocks have no previous close (left out)`);
        const rows = top(quotes, (q) => sign * q.changePct).map((q) => {
          const f = futs.get(q.symbol);
          return eqRow(q.symbol, q, q.changePct, '% Chg', f ? { oi: f.oi, oiChangePct: f.oiChangePct, volume: f.volume, buildUp: f.buildUp } : {});
        });
        return done(rows, `${quotes.length} of ${stocks.length} F&O stocks with a live price and the previous close`);
      }

      case 'iv-gainers':
      case 'iv-losers':
      case 'high-ivp':
      case 'low-ivp': {
        const all = rowsOf(await this.analytics.ivTable(ts)).map((r) => ({
          symbol: String(r.symbol),
          ltp: num(r.ltp),
          changePct: num(r.changePct),
          iv: num(r.iv),
          ivChange: num(r.ivChange),
          ivp: num(r.ivp),
        }));
        const byChange = id === 'iv-gainers' || id === 'iv-losers';
        const metricOf = (r: (typeof all)[number]) => (byChange ? r.ivChange : r.ivp);
        const usable = all.filter((r) => r.iv !== null && metricOf(r) !== null);
        const total = md.ref.underlyings().length;
        if (!usable.length) {
          const withIv = all.filter((r) => r.iv !== null).length;
          throw new NoLiveData(
            withIv
              ? `${withIv} underlyings have a live ATM IV, but none has ${byChange ? "the previous session's IV (official option closes)" : 'a 1-year IV history (official option closes)'} yet`
              : 'No ATM IV could be solved from live premiums',
          );
        }
        const sign = id === 'iv-gainers' || id === 'high-ivp' ? 1 : -1;
        const label = byChange ? 'IV Chg' : 'IVP';
        const rows = top(usable, (r) => sign * (metricOf(r) as number)).map((r) => eqRow(r.symbol, r, metricOf(r) as number, label, { iv: r.iv, ivChange: r.ivChange, ivp: r.ivp }));
        return done(rows, `${usable.length} of ${total} underlyings with a live ATM IV and ${byChange ? 'the previous close IV' : 'an IV history'}`);
      }

      case 'most-active-calls':
      case 'most-active-puts':
      case 'call-writing':
      case 'put-writing':
      case 'highest-call-oi':
      case 'highest-put-oi':
      case 'volume-oi-spike':
      case 'premium-gainers': {
        const snap = await this.snapshot(ts);
        if (!snap.some((r) => r.ltp !== null || r.oi !== null)) throw new NoLiveData('No live option quotes in the market-wide snapshot');
        const coverage = this.snapshotCoverage(snap);
        const type: OptKind = /call/.test(id) ? 'CE' : 'PE';
        switch (id) {
          case 'most-active-calls':
          case 'most-active-puts': {
            const traded = snap.filter((r) => r.type === type && r.ltp !== null && r.volume !== null && r.volume > 0);
            const usable = traded.filter((r) => r.turnover !== null);
            if (usable.length < traded.length) gaps.add('turnover', `${traded.length - usable.length} traded contracts have no average traded price from the feed: left out`);
            return done(top(usable, (r) => r.turnover as number).map((r) => optRow(r, r.turnover as number, 'Turnover ₹')), coverage);
          }
          case 'call-writing':
          case 'put-writing': {
            const usable = snap.filter((r) => r.type === type && r.ltp !== null && r.prevLtp !== null && r.oiChange !== null);
            if (!usable.length) gaps.add('oiChange', "No live contract has both the previous session's close and OI (official F&O file not loaded yet?)");
            const hits = usable.filter((r) => (r.ltp as number) < (r.prevLtp as number) && (r.oiChange as number) > 0);
            return done(top(hits, (r) => (r.oiChange as number) * (r.ltp as number)).map((r) => optRow(r, r.oiChange as number, 'OI Added')), coverage);
          }
          case 'highest-call-oi':
          case 'highest-put-oi': {
            const usable = snap.filter((r) => r.type === type && r.oi !== null && r.oi > 0 && r.spot !== null);
            return done(top(usable, (r) => (r.oi as number) * (r.spot as number)).map((r) => optRow(r, r.oi as number, 'OI')), coverage);
          }
          case 'volume-oi-spike': {
            const usable = snap.filter((r) => r.ltp !== null && r.oi !== null && r.oi > 0 && r.volume !== null && r.volume > 0);
            return done(top(usable, (r) => (r.volume as number) / (r.oi as number)).map((r) => optRow(r, (r.volume as number) / (r.oi as number), 'Vol / OI')), coverage);
          }
          default: {
            const usable = snap.filter((r) => r.prevLtp !== null && r.prevLtp >= 2 && r.changePct !== null && r.ltp !== null);
            if (!usable.length) gaps.add('changePct', "No live contract has the previous session's traded close");
            return done(top(usable, (r) => r.changePct as number).map((r) => optRow(r, r.changePct as number, 'Prem Chg %')), coverage);
          }
        }
      }

      default: {
        // orb-up / orb-down / orb-inside: the opening-range scan on recorded 1-minute bars.
        const want = id === 'orb-up' ? 'up' : id === 'orb-down' ? 'down' : 'sideways';
        const all = rowsOf(await this.analytics.orbScan(ts)).map((r) => ({
          symbol: String(r.symbol),
          ltp: num(r.ltp),
          changePct: num(r.changePct),
          trend: r.trend,
          pending: r.pending ?? null,
          widthPct: num(r.widthPct),
          beyondPct: num(r.beyondPct),
        }));
        const total = md.ref.underlyings().length;
        if (!all.length) throw new NoLiveData('No recorded 1-minute bars of this session yet for the opening-range scan');
        // Skip symbols whose live price contradicts the label (an unconfirmed move to the other side).
        const hits = all.filter((r) => r.trend === want && (want === 'sideways' ? r.pending === null : r.pending !== (want === 'up' ? 'down' : 'up')));
        const metricOf = (r: (typeof all)[number]) => (want === 'sideways' ? r.widthPct : r.beyondPct);
        const usable = hits.filter((r) => metricOf(r) !== null);
        const label = want === 'sideways' ? 'Range width %' : want === 'up' ? '% above OR high' : '% below OR low';
        const rows = top(usable, (r) => (want === 'sideways' ? -(r.widthPct as number) : (r.beyondPct as number))).map((r) => eqRow(r.symbol, r, metricOf(r) as number, label));
        return done(rows, `${all.length} of ${total} underlyings with recorded 1-minute bars this session`);
      }
    }
  }

  /* ------------------------------------ unusual ------------------------------------- */

  /**
   * Unusual option activity: contracts whose volume/OI, OI change and IV change stand out from the
   * rest of the live snapshot (z-scores). Contracts need a live trade, live OI and the previous
   * session's OI; the IV term is used where the previous IV is known, the turnover weight where the
   * feed sent an ATP (both reported in `gaps` otherwise).
   */
  async unusual(ts: number, symbol?: string, limit = 60): Promise<UnusualResponse> {
    const md = this.md;
    const s = symbol ? md.ref.underlying(symbol).symbol : undefined;
    const snap = (await this.snapshot(ts)).filter((r) => !s || r.symbol === s);
    const rows = snap.filter((r) => r.ltp !== null && r.oi !== null && r.oi > 0 && r.prevOi !== null && r.prevOi > 0 && r.oiChange !== null && r.volume !== null);
    if (!rows.length) {
      const live = snap.filter((r) => r.ltp !== null).length;
      throw new NoLiveData(
        live
          ? `${live} ${s ? `${s} ` : ''}option contracts are live, but none has the previous session's OI (official F&O file not loaded yet?)`
          : `No live option quotes${s ? ` for ${s}` : ''} in the market-wide snapshot`,
      );
    }
    const gaps = new Gaps();
    const stat = (xs: number[]) => {
      if (!xs.length) return { m: 0, sd: 1 };
      const m = xs.reduce((a, x) => a + x, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length) || 1;
      return { m, sd };
    };
    const ivChangeOf = (r: SnapRow) => (r.iv !== null && r.prevIv !== null ? r.iv - r.prevIv : null);
    const vo = rows.map((r) => Math.log1p((r.volume as number) / (r.oi as number)));
    const oc = rows.map((r) => Math.abs(((r.oiChange as number) / (r.prevOi as number)) * 100));
    const ivc = rows.map((r) => {
      const c = ivChangeOf(r);
      return c === null ? null : Math.abs(c);
    });
    const sVo = stat(vo);
    const sOc = stat(oc);
    const sIv = stat(ivc.filter((x): x is number => x !== null));
    const noIv = ivc.filter((x) => x === null).length;
    if (noIv) gaps.add('ivChange', `${noIv} of ${rows.length} contracts have no IV change (previous session's official close not traded or not loaded): scored on volume and OI only`);
    const noTurnover = rows.filter((r) => r.turnover === null).length;
    if (noTurnover) gaps.add('premiumTurnover', `${noTurnover} of ${rows.length} contracts have no average traded price from the feed: turnover blank and not weighted`);

    const scored = rows.map((r, i): UnusualActivityRow => {
      const ivz = ivc[i] === null ? 0 : 0.5 * Math.max(0, ((ivc[i] as number) - sIv.m) / sIv.sd);
      const z = Math.max(0, (vo[i] - sVo.m) / sVo.sd) + Math.max(0, (oc[i] - sOc.m) / sOc.sd) + ivz;
      const weight = r.turnover !== null ? Math.log10(10 + r.turnover / 1e5) : 1;
      const bu = r.prevLtp !== null ? classifyBuildUp((r.ltp as number) - r.prevLtp, r.oiChange as number) : null;
      const ivChange = ivChangeOf(r);
      return {
        symbol: r.symbol,
        type: r.type,
        strike: r.strike,
        expiry: r.expiry,
        ltp: r.ltp as number,
        changePct: r.changePct,
        oi: r.oi as number,
        oiChange: r.oiChange as number,
        oiChangePct: fix(oc[i] * Math.sign(r.oiChange as number)),
        volume: r.volume as number,
        volumeOiRatio: fix((r.volume as number) / (r.oi as number)),
        iv: r.iv,
        ivChange: ivChange === null ? null : fix(ivChange),
        premiumTurnover: r.turnover,
        score: fix(z * weight),
        signal: signalFor(r.type, bu),
        buildUp: bu,
      };
    });
    const lim = Math.max(1, Math.min(200, Math.floor(limit) || 60));
    return {
      rows: scored.filter((r) => r.score > 1.5).sort((a, b) => b.score - a.score).slice(0, lim),
      coverage: `${this.snapshotCoverage(snap)}; ${rows.length} contracts with live OI vs the previous session scored`,
      ...gaps.out(),
    };
  }

  /* ------------------------------------ synopsis ------------------------------------ */

  /**
   * F&O stock heat-map: live spot price/change, near future OI change and build-up, ATM IV and its
   * change (Analytics.ivTable), cash turnover (volume × ATP) and the snapshot PCR (strikes with live
   * OI on both sides). Stocks without a live price are left out (`coverage`).
   */
  async synopsis(ts: number): Promise<SynopsisResponse> {
    const md = this.md;
    const gaps = new Gaps();
    const stocks = md.ref.underlyings().filter((u) => u.kind === 'stock');
    const futs = new Map(this.nearFutures().rows.map((r) => [r.symbol, r]));

    const ivs = new Map<string, { iv: number | null; ivChange: number | null }>();
    try {
      for (const r of rowsOf(await this.analytics.ivTable(ts))) ivs.set(String(r.symbol), { iv: num(r.iv), ivChange: num(r.ivChange) });
    } catch (e) {
      if (!(e instanceof NoLiveData)) throw e;
      gaps.add('iv', e.message);
    }

    const pcrBy = new Map<string, number>();
    try {
      const sides = new Map<string, { symbol: string; ce?: number; pe?: number }>();
      for (const r of await this.snapshot(ts)) {
        if (r.oi === null) continue;
        const k = `${r.symbol}|${r.expiry}|${r.strike}`;
        const v = sides.get(k) ?? { symbol: r.symbol };
        v[r.type === 'CE' ? 'ce' : 'pe'] = r.oi;
        sides.set(k, v);
      }
      const sums = new Map<string, { ce: number; pe: number }>();
      for (const v of sides.values()) {
        if (v.ce === undefined || v.pe === undefined) continue;
        const t = sums.get(v.symbol) ?? { ce: 0, pe: 0 };
        t.ce += v.ce;
        t.pe += v.pe;
        sums.set(v.symbol, t);
      }
      for (const [symbol, t] of sums) if (t.ce > 0) pcrBy.set(symbol, fix(t.pe / t.ce));
    } catch (e) {
      if (!(e instanceof NoLiveData)) throw e;
      gaps.add('pcr', e.message);
    }

    const rows: SynopsisRow[] = [];
    for (const u of stocks) {
      let q: ReturnType<typeof underlyingQuote>;
      try {
        q = underlyingQuote(md, u.symbol);
      } catch (e) {
        if (e instanceof NoLiveData) continue;
        throw e;
      }
      const sq = md.live.quote(spotKey(u.symbol));
      const turnover = sq && isPos(sq.atp) && isNum(sq.volume) && livePrice(md, sq) !== null ? Math.round(sq.volume * sq.atp) : null;
      const f = futs.get(u.symbol);
      const iv = ivs.get(u.symbol);
      rows.push({
        symbol: u.symbol,
        name: u.name,
        sector: u.sector,
        ltp: q.ltp,
        changePct: q.changePct,
        oiChangePct: f?.oiChangePct ?? null,
        ivChange: iv?.ivChange ?? null,
        iv: iv?.iv ?? null,
        turnover,
        buildUp: f?.buildUp ?? null,
        pcr: pcrBy.get(u.symbol) ?? null,
      });
    }
    if (!rows.length) throw new NoLiveData(stocks.length ? 'No live F&O stock prices' : 'No F&O stocks in the instrument master');
    const noTurnover = rows.filter((r) => r.turnover === null).length;
    if (noTurnover) gaps.add('turnover', `${noTurnover} stocks have no session volume or average traded price from the feed`);
    return { rows, coverage: `${rows.length} of ${stocks.length} F&O stocks with a live price; PCR over the snapshot's strikes with live OI on both sides`, ...gaps.out() };
  }

  /* ---------------------------------- contracts ---------------------------------- */

  /** Live reference price of an underlying: spot, else the same-expiry future, else the near future. */
  private refPrice(symbol: string, expiry?: string): number | null {
    const md = this.md;
    const spot = livePrice(md, md.live.quote(spotKey(symbol)));
    if (spot !== null) return spot;
    for (const fe of [expiry, nearFuture(md, symbol)]) {
      if (!fe || !md.ref.listing(futKey(symbol, fe))) continue;
      const p = livePrice(md, md.live.quote(futKey(symbol, fe)));
      if (p !== null) return p;
    }
    return null;
  }

  /** A contract listed now (400 when unlisted); the default option strike is the one nearest the live price. */
  private resolveListed(symbol: string, spec: ContractSpec, now: number): Contract {
    const md = this.md;
    const s = md.ref.underlying(symbol).symbol;
    if (spec.type === 'FUT') {
      const list = [...md.ref.expiries(s, 'FUT')].sort().filter((e) => expiryTs(e) > now);
      if (spec.expiry && !list.includes(spec.expiry)) throw httpError(400, `${s} future ${spec.expiry} is not listed`);
      const expiry = spec.expiry || list[0];
      if (!expiry) throw httpError(400, `${s} has no listed future`);
      return { key: futKey(s, expiry), symbol: s, expiry, label: `${s} ${formatExpiry(expiry)} FUT`, expiries: list, strikes: [] };
    }
    const list = liveOptionExpiries(md, s, now);
    if (spec.expiry && !list.includes(spec.expiry)) throw httpError(400, `${spec.expiry} is not a listed ${s} option expiry`);
    const expiry = spec.expiry || list[0];
    if (!expiry) throw httpError(400, `${s} has no listed options`);
    const strikes = md.ref.strikes(s, expiry);
    let strike: number;
    if (spec.strike !== undefined) {
      if (!strikes.includes(Number(spec.strike))) throw httpError(400, `Strike ${spec.strike} is not listed for ${s} ${expiry}`);
      strike = Number(spec.strike);
    } else {
      const ref = this.refPrice(s, expiry);
      if (ref === null) throw new NoLiveData(`No live ${s} price to pick the ATM strike: choose a strike`);
      strike = strikes.reduce((a, k) => (Math.abs(k - ref) < Math.abs(a - ref) ? k : a));
    }
    return { key: optKey(s, expiry, spec.type, strike), symbol: s, expiry, strike, label: `${s} ${formatExpiry(expiry)} ${strike} ${spec.type}`, expiries: list, strikes };
  }

  /** A contract recorded on a past (or finished) session; NoLiveData when it was not recorded. */
  private resolveRecorded(symbol: string, spec: ContractSpec, date: string): Contract {
    const md = this.md;
    const s = md.ref.underlying(symbol).symbol;
    requireRecorded(md, date, 'order flow');
    const keys = md.intraday.recordedKeys(date).filter((k) => k.symbol === s && k.kind === spec.type && !!k.expiry && k.expiry >= date);
    const what = spec.type === 'FUT' ? 'futures' : `${spec.type} options`;
    if (!keys.length) throw new NoLiveData(`No ${s} ${what} were recorded on ${date}`);
    const expiries = [...new Set(keys.map((k) => k.expiry as string))].sort();
    if (spec.expiry && !expiries.includes(spec.expiry)) throw new NoLiveData(`${s} ${what} of ${spec.expiry} were not recorded on ${date} (recorded: ${expiries.join(', ')})`);
    const expiry = spec.expiry || expiries[0];
    if (spec.type === 'FUT') return { key: futKey(s, expiry), symbol: s, expiry, label: `${s} ${formatExpiry(expiry)} FUT`, expiries, strikes: [] };
    const strikes = [...new Set(keys.filter((k) => k.expiry === expiry && k.strike !== undefined).map((k) => k.strike as number))].sort((a, b) => a - b);
    let strike: number;
    if (spec.strike !== undefined) {
      if (!strikes.includes(Number(spec.strike))) throw new NoLiveData(`${s} ${formatExpiry(expiry)} ${spec.strike} ${spec.type} was not recorded on ${date}`);
      strike = Number(spec.strike);
    } else {
      const fut = md.intraday.recordedKeys(date).find((k) => k.symbol === s && k.kind === 'FUT' && k.expiry === expiry);
      const ref = md.intraday.bars(spotKey(s), date).filter((r) => r.traded).at(-1)?.close ?? (fut ? md.intraday.bars(fut, date).filter((r) => r.traded).at(-1)?.close : undefined);
      if (ref === undefined) throw new NoLiveData(`No recorded ${s} price on ${date} to pick the ATM strike: choose a strike`);
      strike = strikes.reduce((a, k) => (Math.abs(k - ref) < Math.abs(a - ref) ? k : a));
    }
    return { key: optKey(s, expiry, spec.type, strike), symbol: s, expiry, strike, label: `${s} ${formatExpiry(expiry)} ${strike} ${spec.type}`, expiries, strikes };
  }

  /** Lot size of a contract: instrument master, else the official file of `date`; null when unknown. */
  private lotSizeOf(key: InstrumentKey, date: string): number | null {
    const md = this.md;
    const l = md.ref.listing(key);
    if (l) return l.lotSize;
    if (key.kind === 'FUT') return md.history.dailyFutures(key.symbol, date, date).find((f) => f.expiry === key.expiry)?.lotSize ?? null;
    if (key.kind === 'CE' || key.kind === 'PE') return md.history.dailyOptions(key.symbol, date, key.expiry).find((o) => o.type === key.kind && o.strike === key.strike)?.lotSize ?? null;
    return null;
  }

  /** Previous-session close of a contract: the quote's, else the official close when it traded that day. */
  private prevCloseOf(key: InstrumentKey, q: LiveQuote): number | null {
    if (isPos(q.prevClose)) return q.prevClose;
    const md = this.md;
    const prevDate = md.calendar.prev(sessionDateOf(md, q.ts));
    if (key.kind === 'FUT') {
      const row = md.history.dailyFutures(key.symbol, prevDate, prevDate).find((f) => f.expiry === key.expiry);
      return row && row.volume > 0 && isPos(row.close) ? row.close : null;
    }
    const row = md.history.dailyOptions(key.symbol, prevDate, key.expiry).find((o) => o.type === key.kind && o.strike === key.strike);
    return row && row.volume > 0 && isPos(row.close) ? row.close : null;
  }

  /* ----------------------------------- order book ----------------------------------- */

  /**
   * Live market depth of one future/option. The contract is watched at level 'depth' (and handed to
   * `opts.touch` for the 'user' tier); NoLiveData until the feed has sent its depth. The levels are
   * the feed's, never padded or invented; a book older than 10 s (or outside the session) is shown as
   * of its time with `bookLive: false`. History: the recorder's minutes of the session.
   */
  orderBook(symbol: string, spec: ContractSpec, ts: number, opts: ToolViewOptions = {}): OrderBookResponse {
    const md = this.md;
    const now = ts;
    const c = this.resolveListed(symbol, spec, now);
    opts.touch?.(c.key, 'depth');
    md.live.watch([c.key], 'depth');
    const q = md.live.quote(c.key);
    if (!q) throw new NoLiveData(`No live quote for ${c.label} yet: its market depth has been requested from the feed`);
    const levels = (xs: readonly LiveDepthLevel[] | undefined, side: 'bid' | 'ask'): DepthLevel[] =>
      (xs ?? [])
        .filter((l) => isPos(l.price) && isNum(l.qty) && l.qty >= 0)
        .map((l) => ({ price: l.price, qty: l.qty, orders: isNum(l.orders) ? l.orders : null }))
        .sort((a, b) => (side === 'bid' ? b.price - a.price : a.price - b.price))
        .slice(0, 5);
    const bids = levels(q.depth?.bids, 'bid');
    const asks = levels(q.depth?.asks, 'ask');
    if (!bids.length && !asks.length) throw new NoLiveData(`No market depth for ${c.label} yet: depth has been requested from the feed and appears once it streams`);

    const gaps = new Gaps();
    const session = md.calendar.session(now);
    const bookLive = session.status === 'open' && now - q.ts <= BOOK_MAX_AGE_MS && q.ts <= now + BOOK_MAX_AGE_MS;
    if (!bookLive) gaps.add('book', `Book as of ${formatTimeIST(q.ts)}${session.status === 'open' ? ` (${Math.round((now - q.ts) / 1000)} s old)` : session.status === 'pre-open' ? ' (pre-open)' : ' (market closed)'}: not live`);

    const ltp = livePrice(md, q);
    const prevClose = this.prevCloseOf(c.key, q);
    const ch = changeOf(ltp, prevClose);
    // Session OHLC/ATP/last trade only once the contract has traded in the session.
    const traded = ltp !== null;
    const open = traded && isPos(q.open) ? q.open : null;
    const high = traded && isPos(q.high) ? q.high : null;
    const low = traded && isPos(q.low) ? q.low : null;
    const vwap = traded && isPos(q.atp) ? q.atp : null;
    const volume = isNum(q.volume) ? q.volume : null;
    const oi = isNum(q.oi) ? q.oi : null;
    const totalBidQty = isNum(q.totalBuyQty) ? q.totalBuyQty : null;
    const totalAskQty = isNum(q.totalSellQty) ? q.totalSellQty : null;
    const b0 = bids[0];
    const a0 = asks[0];
    const spread = b0 && a0 ? a0.price - b0.price : null;
    const mid = b0 && a0 ? (a0.price + b0.price) / 2 : null;
    const imbalance = totalBidQty !== null && totalAskQty !== null && totalBidQty + totalAskQty > 0 ? (totalBidQty - totalAskQty) / (totalBidQty + totalAskQty) : null;
    if (totalBidQty === null || totalAskQty === null) gaps.add('totals', 'The feed sent no total buy/sell quantity for this contract');

    // History: recorded minutes of the session, the last minute of each 5-minute block.
    const date = currentSession(md, now);
    const recs = md.intraday.bars(c.key, date);
    if (!recs.length) gaps.add('history', `No recorded minutes of ${c.label} on ${date}: the recorder keeps the book of streamed contracts from the first time they are watched`);
    const open0 = md.calendar.ts(date, 0);
    const blocks = new Map<number, MinuteRecord>();
    for (const r of recs) blocks.set(Math.floor((r.ts - open0) / (BOOK_HISTORY_STEP_MIN * MINUTE)), r);
    const lastTradeAt = (t: number): number | null => {
      for (let i = recs.length - 1; i >= 0; i--) if (recs[i].ts <= t && recs[i].traded) return recs[i].close;
      return null;
    };
    const history: OrderBookResponse['history'] = [...blocks.values()].map((r) => {
      const tb = num(r.totalBuyQty);
      const ta = num(r.totalSellQty);
      return {
        ts: r.ts,
        ltp: lastTradeAt(r.ts),
        bidQty: num(r.bidQty),
        askQty: num(r.askQty),
        totalBidQty: tb,
        totalAskQty: ta,
        ratio: tb !== null && ta !== null && ta > 0 ? fix(tb / ta) : null,
        spread: isPos(r.bid) && isPos(r.ask) && r.ask >= r.bid ? fix(r.ask - r.bid) : null,
        vwap: isPos(r.atp) ? r.atp : null,
      };
    });

    // Derived figures (null with the reason when an input is missing).
    type Row = OrderBookResponse['analytics'][number];
    const row = (label: string, value: string | null, why: string, extra: Omit<Row, 'label' | 'value'> = {}): Row => (value === null ? { label, value: null, hint: why } : { label, value, ...extra });
    const sum = (xs: DepthLevel[], f: (l: DepthLevel) => number) => xs.reduce((a, l) => a + f(l), 0);
    const avgOrder = (xs: DepthLevel[]) => (xs.length && xs.every((l) => l.orders !== null) && sum(xs, (l) => l.orders as number) > 0 ? formatCompact(sum(xs, (l) => l.qty) / sum(xs, (l) => l.orders as number)) : null);
    const micro = b0 && a0 && b0.qty + a0.qty > 0 ? (b0.price * a0.qty + a0.price * b0.qty) / (a0.qty + b0.qty) : null;
    const fiveAgo = ltp !== null ? lastTradeAt(now - 5 * MINUTE - MINUTE) : null;
    const noTrade = `${c.label} has not traded in the session`;
    const analytics: OrderBookResponse['analytics'] = [
      row('Buy / Sell Qty Ratio', totalBidQty !== null && totalAskQty !== null && totalAskQty > 0 ? (totalBidQty / totalAskQty).toFixed(2) : null, 'No total buy/sell quantity from the feed', { tone: tone((totalBidQty ?? 0) - (totalAskQty ?? 0)), hint: '>1 means more resting buy interest' }),
      row('Order Imbalance', imbalance !== null ? `${(imbalance * 100).toFixed(1)}%` : null, 'No total buy/sell quantity from the feed', { tone: tone(imbalance ?? 0) }),
      row('Best Bid / Ask Qty', b0 && a0 ? `${formatCompact(b0.qty)} / ${formatCompact(a0.qty)}` : null, 'One side of the book is empty', { tone: tone((b0?.qty ?? 0) - (a0?.qty ?? 0)) }),
      row('Bid-Ask Spread', spread !== null && mid ? `${spread.toFixed(2)} (${((spread / mid) * 100).toFixed(3)}%)` : null, 'One side of the book is empty'),
      row('Mid Price', mid !== null ? mid.toFixed(2) : null, 'One side of the book is empty'),
      row('Micro Price', micro !== null ? micro.toFixed(2) : null, 'One side of the book is empty', { hint: 'Size-weighted fair price from top of book', tone: tone(micro !== null && mid !== null ? micro - mid : 0) }),
      row('VWAP / ATP', vwap !== null ? vwap.toFixed(2) : null, traded ? 'The feed sent no average traded price' : noTrade, { tone: tone(ltp !== null && vwap !== null ? ltp - vwap : 0) }),
      row('LTP vs VWAP', ltp !== null && vwap !== null ? `${(((ltp - vwap) / vwap) * 100).toFixed(2)}%` : null, traded ? 'The feed sent no average traded price' : noTrade, { tone: tone(ltp !== null && vwap !== null ? ltp - vwap : 0) }),
      row('Day Range Position', ltp !== null && high !== null && low !== null && high > low ? `${(((ltp - low) / (high - low)) * 100).toFixed(0)}%` : null, traded ? 'No day range yet' : noTrade, { hint: '0% = day low, 100% = day high' }),
      row('5-min Momentum', ltp !== null && fiveAgo !== null ? `${(((ltp - fiveAgo) / fiveAgo) * 100).toFixed(2)}%` : null, traded ? 'No recorded trade 5 minutes ago' : noTrade, { tone: tone(ltp !== null && fiveAgo !== null ? ltp - fiveAgo : 0) }),
      row('Avg Bid Order Size', avgOrder(bids), 'The feed sent no order counts'),
      row('Avg Ask Order Size', avgOrder(asks), 'The feed sent no order counts'),
      row('Depth (top 5) Buy Value', bids.length ? `₹${formatCompact(sum(bids, (l) => l.qty * l.price))}` : null, 'No bids in the book'),
      row('Depth (top 5) Sell Value', asks.length ? `₹${formatCompact(sum(asks, (l) => l.qty * l.price))}` : null, 'No asks in the book'),
      row('Volume', volume !== null ? formatCompact(volume) : null, 'The feed sent no session volume'),
      row('Turnover', volume !== null && vwap !== null ? `₹${formatCompact(volume * vwap)}` : null, 'Needs the session volume and the average traded price'),
      row('Open Interest', oi !== null ? formatCompact(oi) : null, 'The feed sent no open interest'),
      row('Last Trade Qty', traded && isPos(q.ltq) ? formatCompact(q.ltq) : null, traded ? 'The feed sent no last traded quantity' : noTrade),
    ];

    return {
      symbol: c.symbol,
      instrument: c.label,
      type: spec.type,
      expiry: c.expiry,
      ...(c.strike !== undefined ? { strike: c.strike } : {}),
      bookTs: q.ts,
      bookLive,
      ltp,
      change: ch.change,
      changePct: ch.changePct,
      open,
      high,
      low,
      prevClose,
      vwap,
      volume,
      oi,
      bids,
      asks,
      totalBidQty,
      totalAskQty,
      spread: spread !== null ? fix(spread) : null,
      spreadPct: spread !== null && mid ? fix((spread / mid) * 100, 3) : null,
      imbalance: imbalance !== null ? fix(imbalance, 3) : null,
      lastTradeQty: traded && isPos(q.ltq) ? q.ltq : null,
      upperCircuit: isPos(q.upperCircuit) ? q.upperCircuit : null,
      lowerCircuit: isPos(q.lowerCircuit) ? q.lowerCircuit : null,
      history,
      analytics,
      ...gaps.out(),
    };
  }

  /* ----------------------------------- order flow ----------------------------------- */

  /**
   * Flow of the underlying's near-month future in its last completed recorded minute (dashboard,
   * ORDER_FLOW alerts); null (reason to `why`) when that future was not recorded this session.
   */
  lastMinuteFlow(symbol: string, ts: number, why?: (reason: string) => void): LastMinuteFlow | null {
    const md = this.md;
    const fail = (reason: string): null => {
      why?.(reason);
      return null;
    };
    let s: string;
    try {
      s = md.ref.underlying(symbol).symbol;
    } catch (e) {
      if (e instanceof NoLiveData) return fail(e.message);
      throw e;
    }
    const fe = nearFuture(md, s, ts);
    if (!fe) return fail(`${s} has no listed future`);
    const date = currentSession(md, ts);
    const r = md.intraday
      .bars(futKey(s, fe), date)
      .filter((x) => isNum(x.volume) && x.ts + MINUTE <= ts)
      .at(-1);
    if (!r) return fail(`No recorded minute of the ${s} ${formatExpiry(fe)} future on ${date}`);
    const f = flowOf(r);
    return { ...summariseOrderFlow([f]), ts: r.ts, close: f.close, expiry: fe, method: ORDER_FLOW_METHOD };
  }

  /**
   * 1-minute order flow of a future or option from the recorder's minutes: per minute the traded
   * volume split into buyer-initiated, seller-initiated and unclassified (quote rule on live ticks —
   * an estimate, labelled), with the last completed minute, the minute in progress, the last 5
   * minutes and the session. Today: a listed contract (watched so it is recorded from now on);
   * a past session: a contract recorded that day. NoLiveData when nothing was recorded.
   */
  orderFlow(symbol: string, spec: ContractSpec, ts: number, opts: { date?: string; limit?: number } & ToolViewOptions = {}): OrderFlowResponse {
    const md = this.md;
    md.ref.underlying(symbol);
    const today = md.calendar.session(ts).date;
    const date = requireDate(md, opts.date || undefined);
    const live = date === today && md.calendar.isTradingDay(today) && ts < md.calendar.ts(date, SESSION_MINUTES);
    let c: Contract;
    if (live) {
      c = this.resolveListed(symbol, spec, ts);
      opts.touch?.(c.key, 'quote');
      md.live.watch([c.key], 'quote');
    } else c = this.resolveRecorded(symbol, spec, date);

    const all = md.intraday.bars(c.key, date);
    // Completed minutes only (live: ended by now); minutes without a volume (none for futures/options) carry no flow.
    const recs = all.filter((r) => isNum(r.volume) && (!live || r.ts + MINUTE <= ts));
    if (!recs.length) {
      throw new NoLiveData(
        all.length
          ? `${c.label}: the feed reports no traded volume, so its order flow cannot be estimated`
          : live
            ? `${c.label} has no recorded minutes yet this session: it is now streamed, and its order flow is estimated from live ticks from the next minute on`
            : `${c.label} was not recorded on ${date}`,
      );
    }

    const flows = recs.map(flowOf);
    let cum = 0;
    const minutes: OrderFlowMinute[] = flows.map((f) => {
      const delta = f.buyVolume - f.sellVolume;
      cum += delta;
      const classified = f.buyVolume + f.sellVolume;
      return {
        ts: f.ts,
        volume: f.volume,
        buyVolume: f.buyVolume,
        sellVolume: f.sellVolume,
        unclassified: f.unclassified,
        delta,
        cumDelta: cum,
        buyPct: classified > 0 ? r1((f.buyVolume / classified) * 100) : null,
        close: f.close,
      };
    });
    const last = flows[flows.length - 1];
    const lastMinute = { ...summariseOrderFlow([last]), ts: last.ts, close: last.close };
    const last5 = summariseOrderFlow(flows.filter((f) => f.ts > last.ts - 5 * MINUTE));
    const session = summariseOrderFlow(flows);

    let currentMinute: OrderFlowResponse['currentMinute'] = null;
    if (live) {
      const bar = md.intraday.liveBar(c.key);
      if (bar && isNum(bar.volume) && bar.ts > last.ts && bar.ts <= ts) currentMinute = { ...summariseOrderFlow([flowOf(bar)]), ts: bar.ts, elapsedSec: Math.min(60, Math.max(0, Math.round((ts - bar.ts) / 1000))) };
    }

    const span = `${formatTimeIST(lastMinute.ts)}–${formatTimeIST(lastMinute.ts + MINUTE)}`;
    const unclText = lastMinute.unclassifiedPct ? `, ${lastMinute.unclassifiedPct.toFixed(0)}% unclassified` : '';
    const who = lastMinute.sentiment === 'Buyers dominant' ? 'buyers' : lastMinute.sentiment === 'Sellers dominant' ? 'sellers' : null;
    const trend5 = who && last5.sentiment === lastMinute.sentiment ? ' and over the last 5 minutes' : '';
    let signal: string;
    switch (lastMinute.sentiment) {
      case 'No trades':
        signal = `${span}: no trades in this contract`;
        break;
      case 'Not classified':
        signal = `${span}: ${formatCompact(lastMinute.volume)} traded, none of it classifiable (no usable bid/ask before the trades)`;
        break;
      case 'Balanced':
        signal = `${span}: buying and selling balanced (${(lastMinute.buyPct as number).toFixed(0)}% of classified volume bought${unclText})`;
        break;
      default:
        signal = `${span}: ${who} were more aggressive (${(lastMinute.buyPct as number).toFixed(0)}% of classified volume bought${unclText})${trend5}`;
    }
    signal += ` — ${ORDER_FLOW_METHOD}`;

    const gaps = new Gaps();
    const first = recs[0].ts;
    const missing = Math.round((last.ts - first) / MINUTE) + 1 - recs.length;
    const open0 = md.calendar.ts(date, 0);
    if (first > open0) gaps.add('minutes', `Recording of ${c.label} on ${date} starts at ${formatTimeIST(first)}`);
    const coverage = `${recs.length} recorded minutes ${formatTimeIST(first)}–${formatTimeIST(last.ts + MINUTE)}${missing > 0 ? `; ${missing} minutes in between have no record (no ticks received)` : ''}`;

    const limit = Math.max(1, Math.min(SESSION_MINUTES, Math.floor(opts.limit ?? 60) || 60));
    return {
      symbol: c.symbol,
      instrument: c.label,
      type: spec.type,
      expiry: c.expiry,
      ...(c.strike !== undefined ? { strike: c.strike } : {}),
      date,
      live,
      lotSize: this.lotSizeOf(c.key, date),
      method: ORDER_FLOW_METHOD,
      lastMinute,
      currentMinute,
      last5,
      session,
      minutes: minutes.slice(-limit),
      signal,
      coverage,
      expiries: c.expiries,
      strikes: c.strikes,
      ...gaps.out(),
    };
  }
}
