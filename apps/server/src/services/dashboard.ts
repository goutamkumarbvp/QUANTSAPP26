/**
 * Home page (/api/dashboard). Every card is filled on its own from live/official data and is blank
 * (empty list / null) with its reason in `gaps` when it cannot be — one card that fails never fails
 * the response:
 *  - indices: live-session index quotes (underlyingQuote);
 *  - gainers / losers: stocks by live spot change vs the previous close (quote, else the official close);
 *  - oiGainers / buildUpCounts: the stocks' near futures (Analytics.futuresBuildUp: live OI vs the
 *    previous session's OI, build-up from price and OI change);
 *  - chains: NIFTY, BANKNIFTY, SENSEX — live chain aggregates (buildOptionChain), the opening range
 *    (Analytics.orb, recorded/Kotak 1-minute bars) and the near future's last recorded minute of
 *    order flow (MarketTools.lastMinuteFlow, a labelled quote-rule estimate), each part separately;
 *  - fiiDii: the latest official FII/DII days.
 */
import type { BuildUpCounts, DashboardChain, DashboardMover, DashboardResponse, FiiDiiDay, FuturesBuildUpRow, Quote } from '@q26/core';
import { NoLiveData, type MarketDataProvider } from '../live/types';
import { emptyCounts, type Analytics } from './analytics';
import { buildOptionChain, changeOf, clockInfo, eodClose, Gaps, liveDates, livePrice, sessionDateOf, spotKey, underlyingQuote } from './live';
import type { MarketTools } from './market-tools';

/** Index cards with an option-chain summary on the dashboard. */
export const DASHBOARD_CHAINS = ['NIFTY', 'BANKNIFTY', 'SENSEX'] as const;
/** Rows per mover table. */
export const DASHBOARD_MOVERS = 6;
/** Official FII/DII days shown. */
export const DASHBOARD_FII_DII_DAYS = 5;

export interface DashboardOptions {
  /** Index underlyings for the quote cards. */
  indices: string[];
  /** Unexpected (non-data) errors of a card: reported here; the card reads "Internal error". */
  onError?: (where: string, e: unknown) => void;
}

const isPos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Reason of an expected failure (NoLiveData, HTTP 4xx); anything else is reported and reads "Internal error". */
function reasonOf(e: unknown, where: string, onError?: (where: string, e: unknown) => void): string {
  if (e instanceof NoLiveData) return e.message;
  const code = (e as { statusCode?: number } | null)?.statusCode;
  if (typeof code === 'number' && code >= 400 && code < 500) return (e as Error).message;
  onError?.(where, e);
  return 'Internal error';
}

const blankChain = (symbol: string): DashboardChain => ({
  symbol,
  expiry: null,
  spot: null,
  pcr: null,
  maxPain: null,
  atmIv: null,
  ivChange: null,
  support: null,
  resistance: null,
  daysToExpiry: null,
  coverage: null,
  orb: null,
  flow: null,
});

async function chainCard(md: MarketDataProvider, analytics: Analytics, tools: MarketTools, symbol: string, ts: number, onError?: DashboardOptions['onError']): Promise<DashboardChain> {
  const card = blankChain(symbol);
  const gaps = new Gaps();
  try {
    md.ref.underlying(symbol);
  } catch (e) {
    gaps.add('chain', reasonOf(e, `dashboard.${symbol}`, onError));
    return { ...card, ...gaps.out() };
  }
  try {
    const c = await buildOptionChain(md, symbol);
    Object.assign(card, {
      expiry: c.expiry,
      spot: c.spot,
      pcr: c.pcr,
      maxPain: c.maxPain,
      atmIv: c.atmIv,
      ivChange: c.ivChange,
      support: c.support,
      resistance: c.resistance,
      daysToExpiry: c.daysToExpiry,
      coverage: c.coverage,
    });
  } catch (e) {
    gaps.add('chain', reasonOf(e, `dashboard.${symbol}.chain`, onError));
  }
  try {
    const o = await analytics.orb(symbol, ts);
    const ev = o.evaluation;
    card.orb = { high: ev.high, low: ev.low, trend: ev.trend, whipsaw: ev.whipsaw, reentered: ev.reentered, summary: o.summary };
  } catch (e) {
    gaps.add('orb', reasonOf(e, `dashboard.${symbol}.orb`, onError));
  }
  try {
    const f = tools.lastMinuteFlow(symbol, ts, (why) => gaps.add('flow', why));
    if (f) card.flow = { buyPct: f.buyPct, unclassifiedPct: f.unclassifiedPct, delta: f.delta, sentiment: f.sentiment, method: f.method, ts: f.ts };
  } catch (e) {
    gaps.add('flow', reasonOf(e, `dashboard.${symbol}.flow`, onError));
  }
  return { ...card, ...gaps.out() };
}

/** Builds the dashboard; never throws for missing data (each card carries its own gap). */
export async function buildDashboard(md: MarketDataProvider, analytics: Analytics, tools: MarketTools, opts: DashboardOptions): Promise<DashboardResponse> {
  const ts = md.clock.now();
  const gaps = new Gaps();
  const onError = opts.onError;

  // Index quote cards: live-session prices only.
  const indices: Quote[] = [];
  const missing: string[] = [];
  for (const s of opts.indices) {
    try {
      indices.push(underlyingQuote(md, s));
    } catch (e) {
      missing.push(reasonOf(e, `dashboard.indices.${s}`, onError));
    }
  }
  if (missing.length) gaps.add('indices', missing.slice(0, 4).join('; ') + (missing.length > 4 ? ` (+${missing.length - 4} more)` : ''));

  // Stock movers: live spot change; near-future OI change and build-up.
  let gainers: DashboardMover[] = [];
  let losers: DashboardMover[] = [];
  let oiGainers: DashboardMover[] = [];
  let buildUpCounts: BuildUpCounts | null = null;
  let classified = 0;
  let total = 0;
  if (!md.ref.ready()) {
    for (const s of ['movers', 'oiGainers', 'buildUpCounts']) gaps.add(s, 'Instrument master not loaded yet');
  } else {
    const stocks = md.ref.underlyings().filter((u) => u.kind === 'stock');
    total = stocks.length;
    const fut = new Map<string, FuturesBuildUpRow>();
    try {
      for (const r of analytics.futuresBuildUp(ts)) if (r.kind === 'stock') fut.set(r.symbol, r);
    } catch (e) {
      const why = reasonOf(e, 'dashboard.futures', onError);
      gaps.add('oiGainers', why);
      gaps.add('buildUpCounts', why);
    }
    const dates = liveDates(md);
    const movers: DashboardMover[] = stocks.map((u) => {
      const q = md.live.quote(spotKey(u.symbol));
      const ltp = livePrice(md, q, dates);
      let changePct: number | null = null;
      if (q && ltp !== null) {
        const prev = isPos(q.prevClose) ? q.prevClose : eodClose(md, u.symbol, md.calendar.prev(sessionDateOf(md, q.ts)));
        changePct = changeOf(ltp, prev).changePct;
      }
      const f = fut.get(u.symbol);
      return { symbol: u.symbol, ltp, changePct, oiChangePct: f?.oiChangePct ?? null, buildUp: f?.buildUp ?? null };
    });
    const priced = movers.filter((m): m is DashboardMover & { changePct: number } => m.changePct !== null);
    if (!priced.length) gaps.add('movers', 'No stock has a live-session price and a previous close yet');
    gainers = priced.filter((m) => m.changePct > 0).sort((a, b) => b.changePct - a.changePct).slice(0, DASHBOARD_MOVERS);
    losers = priced.filter((m) => m.changePct < 0).sort((a, b) => a.changePct - b.changePct).slice(0, DASHBOARD_MOVERS);
    const withOi = movers.filter((m): m is DashboardMover & { oiChangePct: number } => m.oiChangePct !== null);
    if (!withOi.length) gaps.add('oiGainers', 'No stock future has live OI and the previous session\'s OI yet');
    oiGainers = withOi.filter((m) => m.oiChangePct > 0).sort((a, b) => b.oiChangePct - a.oiChangePct).slice(0, DASHBOARD_MOVERS);

    const counts = emptyCounts();
    for (const r of fut.values()) {
      if (!r.buildUp) continue;
      counts[r.buildUp]++;
      classified++;
    }
    if (classified) {
      buildUpCounts = counts;
      if (classified < total) gaps.add('buildUpCounts', `${total - classified} of ${total} stock futures have no live price/OI change vs the previous session yet`);
    } else gaps.add('buildUpCounts', 'No stock future has a live price and OI change vs the previous session yet');
  }

  // Index chain cards, each part on its own.
  const chains: DashboardChain[] = [];
  for (const s of DASHBOARD_CHAINS) chains.push(await chainCard(md, analytics, tools, s, ts, onError));

  // Official FII/DII (published after the close): the latest days loaded.
  let fiiDii: FiiDiiDay[] = [];
  try {
    const { from, to } = analytics.rangeOf(DASHBOARD_FII_DII_DAYS * 2);
    fiiDii = analytics.fiiDii(from, to).slice(-DASHBOARD_FII_DII_DAYS);
  } catch (e) {
    gaps.add('fiiDii', reasonOf(e, 'dashboard.fiiDii', onError));
  }

  return {
    clock: clockInfo(md),
    indices,
    gainers,
    losers,
    oiGainers,
    buildUpCounts,
    buildUpClassified: classified,
    buildUpTotal: total,
    chains,
    fiiDii,
    ...gaps.out(),
  };
}
