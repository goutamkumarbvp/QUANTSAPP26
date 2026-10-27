/**
 * NIFTY heavyweights desk (GET /api/top10): for each configured stock (NIFTY_TOP10), its live spot,
 * near-month future (basis, OI change, build-up), nearest option chain (ATM IV and its change, PCR,
 * change-in-OI PCR, max pain, put / call walls, ATM straddle = the move the market prices to expiry),
 * the future's buyer vs seller initiated quantity over the last minutes, the opening-range trend, and a
 * transparent bias from those readings (core `biasOf`). Every figure comes from live ticks, the
 * recorder's minutes of those ticks, or the official previous-session files; a figure that is not
 * available is null with the reason in the row's gaps.
 */
import { biasOf, flowDirection, type FlowRead, type Top10Response, type Top10Row } from '@q26/core';
import { NoLiveData, type MarketDataProvider } from '../live/types';
import { changePcrOf, type Analytics } from './analytics';
import { buildOptionChain, futuresQuotes, Gaps } from './live';
import type { MarketTools } from './market-tools';

/** Flow window of the read, in minutes. */
export const TOP10_FLOW_WINDOW = 15;

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const r2 = (x: number) => Math.round(x * 100) / 100;

async function row(md: MarketDataProvider, analytics: Analytics, tools: MarketTools, symbol: string, rank: number, ts: number): Promise<Top10Row> {
  const gaps = new Gaps();
  const u = md.ref.underlying(symbol);
  const out: Top10Row = {
    rank,
    symbol: u.symbol,
    name: u.name,
    sector: u.sector,
    lotSize: null,
    spot: { ltp: null, changePct: null, ts: null },
    future: null,
    options: null,
    flow: null,
    orbTrend: null,
    bias: biasOf({ buildUp: null, flowRead: null, changePcr: null, orbTrend: null }),
  };

  // Options chain (also the spot, which the chain reads live).
  try {
    const c = await buildOptionChain(md, u.symbol);
    out.lotSize = c.lotSize;
    out.spot = { ltp: c.spot, changePct: c.spotChangePct, ts: c.spotTs };
    const atmRow = c.atm !== null ? c.rows.find((r) => r.strike === c.atm) : undefined;
    const ce = atmRow?.ce?.ltp;
    const pe = atmRow?.pe?.ltp;
    const straddle = isNum(ce) && isNum(pe) ? r2(ce + pe) : null;
    if (straddle === null) gaps.add('straddle', 'The ATM call or put has no live premium');
    out.options = {
      expiry: c.expiry,
      daysToExpiry: c.daysToExpiry,
      atm: c.atm,
      atmIv: c.atmIv,
      ivChange: c.ivChange,
      pcr: c.pcr,
      changePcr: changePcrOf(c.totalCeOiChange, c.totalPeOiChange, c.totalCeOi),
      maxPain: c.maxPain,
      support: c.support,
      resistance: c.resistance,
      straddle,
      straddlePct: straddle !== null && isNum(c.spot) && c.spot > 0 ? r2((straddle / c.spot) * 100) : null,
    };
  } catch (e) {
    if (!(e instanceof NoLiveData)) throw e;
    gaps.add('options', e.message);
  }

  // Near-month future.
  try {
    const f = futuresQuotes(md, u.symbol)[0];
    if (f) {
      const spot = out.spot.ltp;
      out.future = {
        expiry: f.expiry,
        ltp: f.ltp,
        changePct: f.changePct,
        basis: f.basis,
        basisPct: isNum(f.basis) && isNum(spot) && spot > 0 ? r2((f.basis / spot) * 100) : null,
        oi: f.oi,
        oiChangePct: f.oiChangePct,
        buildUp: f.buildUp,
      };
    } else gaps.add('future', `${u.symbol}: no future listed`);
  } catch (e) {
    if (!(e instanceof NoLiveData)) throw e;
    gaps.add('future', e.message);
  }

  // Order flow of the future (recorded minutes of its live ticks).
  try {
    const of = tools.orderFlow(u.symbol, { type: 'FUT' }, ts, { limit: 375 });
    const dir = flowDirection(of.minutes, { lookback: TOP10_FLOW_WINDOW });
    if (dir) {
      const last = of.minutes[of.minutes.length - 1];
      out.flow = { window: dir.minutes, buyPct: dir.buyPct, read: dir.read as FlowRead, sessionDelta: last ? last.cumDelta : null, spikes: dir.buySpikes + dir.sellSpikes };
    }
  } catch (e) {
    if (!(e instanceof NoLiveData)) throw e;
    gaps.add('flow', e.message);
  }

  // Opening-range trend (today's, once the session has opened).
  try {
    const o = await analytics.orb(u.symbol, ts);
    if (o.date === md.calendar.session(ts).date) out.orbTrend = o.evaluation.trend;
    else gaps.add('trend', `Opening range of ${o.date}, not today's`);
  } catch (e) {
    if (!(e instanceof NoLiveData)) throw e;
    gaps.add('trend', e.message);
  }

  out.bias = biasOf({ buildUp: out.future?.buildUp ?? null, flowRead: out.flow?.read ?? null, flowBuyPct: out.flow?.buyPct ?? null, changePcr: out.options?.changePcr ?? null, orbTrend: out.orbTrend });
  return { ...out, ...gaps.out() };
}

export async function buildTop10(md: MarketDataProvider, analytics: Analytics, tools: MarketTools, symbols: readonly string[], ts: number, onError?: (where: string, e: unknown) => void): Promise<Top10Response> {
  if (!md.ref.ready()) throw new NoLiveData('Instrument master not loaded yet: the stocks and their contracts are not known');
  const gaps = new Gaps();
  const rows: Top10Row[] = [];
  let rank = 0;
  for (const s of symbols) {
    rank++;
    try {
      rows.push(await row(md, analytics, tools, s, rank, ts));
    } catch (e) {
      // An unknown symbol (a typo in NIFTY_TOP10) is reported, never guessed; any other error is a bug.
      const code = (e as { statusCode?: number }).statusCode;
      if (e instanceof NoLiveData || (typeof code === 'number' && code < 500)) gaps.add(s, reason(e));
      else {
        onError?.(`top10.${s}`, e);
        gaps.add(s, 'Internal error');
      }
    }
  }
  if (!rows.length) throw new NoLiveData(Object.values(gaps.out().gaps ?? {}).join('; ') || 'No stock in the list');

  // Basket: only real readings are counted. Buyer share: the plain average of the stocks' shares
  // (each stock counts once, whatever its lot size or volume).
  const shares = rows.map((r) => r.flow?.buyPct).filter(isNum);
  const ivs = rows.map((r) => r.options?.atmIv).filter(isNum).sort((a, b) => a - b);
  const medianIv = ivs.length ? r2(ivs.length % 2 ? ivs[(ivs.length - 1) / 2] : (ivs[ivs.length / 2 - 1] + ivs[ivs.length / 2]) / 2) : null;
  const basket: Top10Response['basket'] = {
    bullish: rows.filter((r) => r.bias.score > 0).length,
    bearish: rows.filter((r) => r.bias.score < 0).length,
    neutral: rows.filter((r) => r.bias.score === 0).length,
    buyPct: shares.length ? r2(shares.reduce((a, b) => a + b, 0) / shares.length) : null,
    medianIv,
    advancing: rows.filter((r) => isNum(r.spot.changePct) && r.spot.changePct > 0).length,
    declining: rows.filter((r) => isNum(r.spot.changePct) && r.spot.changePct < 0).length,
  };
  return {
    ts,
    listSource: 'NIFTY_TOP10 in .env (default: the ten largest NIFTY 50 companies by market cap — the app’s only stocks). Market caps are not in any live feed, so the list is configuration; every figure below is live.',
    rows,
    basket,
    ...gaps.out(),
  };
}
