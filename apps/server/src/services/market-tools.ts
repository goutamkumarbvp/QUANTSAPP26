/**
 * Market-wide tools: F&O scanners, unusual option activity, synopsis heat-map,
 * order-book (market depth) analytics.
 */
import {
  classifyBuildUp,
  formatCompact,
  formatExpiry,
  formatTimeIST,
  summariseFlow,
  type FlowMinute,
  type OrderFlowMinute,
  type OrderFlowResponse,
  ivPercentile,
  roundTick,
  SESSION_MINUTES,
  type DepthLevel,
  type OrderBookResponse,
  type ScannerDef,
  type ScannerRow,
  type SynopsisRow,
  type UnusualActivityRow,
} from '@q26/core';
import { hashU } from '../market/hash';
import type { MarketEngine } from '../market/engine';
import type { Analytics, OptionSnapshotRow } from './analytics';

const M = SESSION_MINUTES;

export const SCANNERS: ScannerDef[] = [
  { id: 'long-buildup', name: 'Long Build-up', category: 'Build-up', description: 'Futures with price ↑ and OI ↑ — fresh longs.' },
  { id: 'short-buildup', name: 'Short Build-up', category: 'Build-up', description: 'Futures with price ↓ and OI ↑ — fresh shorts.' },
  { id: 'short-covering', name: 'Short Covering', category: 'Build-up', description: 'Futures with price ↑ and OI ↓ — shorts exiting.' },
  { id: 'long-unwinding', name: 'Long Unwinding', category: 'Build-up', description: 'Futures with price ↓ and OI ↓ — longs exiting.' },
  { id: 'oi-gainers', name: 'OI Gainers', category: 'OI', description: 'Largest % increase in futures open interest.' },
  { id: 'oi-losers', name: 'OI Losers', category: 'OI', description: 'Largest % decrease in futures open interest.' },
  { id: 'price-gainers', name: 'Top Gainers', category: 'Price', description: 'F&O stocks with the highest % gain.' },
  { id: 'price-losers', name: 'Top Losers', category: 'Price', description: 'F&O stocks with the largest % fall.' },
  { id: 'iv-gainers', name: 'IV Gainers', category: 'IV', description: 'Largest rise in ATM implied volatility.' },
  { id: 'iv-losers', name: 'IV Losers', category: 'IV', description: 'Largest fall in ATM implied volatility.' },
  { id: 'high-ivp', name: 'High IV Percentile', category: 'IV', description: 'IV in the top of its 1-year range — premium selling candidates.' },
  { id: 'low-ivp', name: 'Low IV Percentile', category: 'IV', description: 'IV near its 1-year low — premium buying candidates.' },
  { id: 'most-active-calls', name: 'Most Active Calls', category: 'Options', description: 'Call options with the highest traded volume.' },
  { id: 'most-active-puts', name: 'Most Active Puts', category: 'Options', description: 'Put options with the highest traded volume.' },
  { id: 'call-writing', name: 'Call Writing', category: 'Options', description: 'Calls with the largest OI addition while premium falls.' },
  { id: 'put-writing', name: 'Put Writing', category: 'Options', description: 'Puts with the largest OI addition while premium falls.' },
  { id: 'highest-call-oi', name: 'Highest Call OI', category: 'Options', description: 'Call strikes with the most open interest.' },
  { id: 'highest-put-oi', name: 'Highest Put OI', category: 'Options', description: 'Put strikes with the most open interest.' },
  { id: 'volume-oi-spike', name: 'Volume / OI Spike', category: 'Volume', description: 'Options trading far more than their open interest.' },
  { id: 'premium-gainers', name: 'Option Premium Gainers', category: 'Options', description: 'Options with the largest % premium gain.' },
  { id: 'orb-up', name: '15-min Range Breakout ↑', category: 'Trend', description: 'Broke above the first 15-minute candle high (1-min close) — trending up.' },
  { id: 'orb-down', name: '15-min Range Breakdown ↓', category: 'Trend', description: 'Broke below the first 15-minute candle low (1-min close) — trending down.' },
  { id: 'orb-inside', name: 'Inside 15-min Range', category: 'Trend', description: 'Still inside the opening 15-minute range — not trending yet.' },
];

function optInstrument(r: OptionSnapshotRow): string {
  return `${r.symbol} ${formatExpiry(r.expiry)} ${r.strike} ${r.type}`;
}

export class MarketTools {
  constructor(private readonly engine: MarketEngine, private readonly analytics: Analytics) {}

  scanner(id: string, ts: number, limit = 25): ScannerRow[] {
    const e = this.engine;
    const a = this.analytics;
    const fut = () => a.futuresBuildUp(ts);
    const futRow = (r: ReturnType<typeof fut>[number], metric: number, label: string): ScannerRow => ({
      symbol: r.symbol, instrument: `${r.symbol} FUT`, type: 'FUT', ltp: r.ltp, changePct: r.changePct, oi: r.oi, oiChangePct: r.oiChangePct, volume: r.volume, buildUp: r.buildUp, metric, metricLabel: label,
    });
    const optRow = (r: OptionSnapshotRow, metric: number, label: string): ScannerRow => ({
      symbol: r.symbol, instrument: optInstrument(r), type: r.type, strike: r.strike, expiry: r.expiry, ltp: r.ltp, changePct: r.changePct, oi: r.oi, oiChangePct: r.oiChangePct, volume: r.volume, iv: r.iv, ivChange: +(r.iv - r.prevIv).toFixed(2), buildUp: a.optionBuildUp(r), metric, metricLabel: label,
    });
    const top = <T,>(rows: T[], key: (r: T) => number) => [...rows].sort((x, y) => key(y) - key(x)).slice(0, limit);
    switch (id) {
      case 'long-buildup':
      case 'short-buildup':
      case 'short-covering':
      case 'long-unwinding': {
        const want = { 'long-buildup': 'Long Build-up', 'short-buildup': 'Short Build-up', 'short-covering': 'Short Covering', 'long-unwinding': 'Long Unwinding' }[id];
        return top(fut().filter((r) => r.buildUp === want), (r) => Math.abs(r.oiChangePct)).map((r) => futRow(r, r.oiChangePct, 'OI Chg %'));
      }
      case 'oi-gainers':
        return top(fut(), (r) => r.oiChangePct).map((r) => futRow(r, r.oiChangePct, 'OI Chg %'));
      case 'oi-losers':
        return top(fut(), (r) => -r.oiChangePct).map((r) => futRow(r, r.oiChangePct, 'OI Chg %'));
      case 'price-gainers':
      case 'price-losers': {
        const sign = id === 'price-gainers' ? 1 : -1;
        return top(fut().filter((r) => r.kind === 'stock'), (r) => sign * r.changePct).map((r) => {
          const q = e.quote(r.symbol, ts);
          return { ...futRow(r, q.changePct, '% Chg'), instrument: r.symbol, type: 'EQ' as const, ltp: q.ltp, changePct: q.changePct };
        });
      }
      case 'iv-gainers':
      case 'iv-losers':
      case 'high-ivp':
      case 'low-ivp': {
        const rows = a.ivTable(ts);
        const key = id === 'iv-gainers' ? (r: (typeof rows)[number]) => r.ivChange : id === 'iv-losers' ? (r: (typeof rows)[number]) => -r.ivChange : id === 'high-ivp' ? (r: (typeof rows)[number]) => r.ivp : (r: (typeof rows)[number]) => -r.ivp;
        const label = id.startsWith('iv') ? 'IV Chg' : 'IVP';
        return top(rows, key).map((r) => ({
          symbol: r.symbol, instrument: r.symbol, type: 'EQ' as const, ltp: r.ltp, changePct: r.changePct, oi: 0, oiChangePct: 0, volume: 0, iv: r.iv, ivChange: r.ivChange, ivp: r.ivp, metric: id.startsWith('iv') ? r.ivChange : r.ivp, metricLabel: label,
        }));
      }
      case 'most-active-calls':
      case 'most-active-puts': {
        const type = id === 'most-active-calls' ? 'CE' : 'PE';
        return top(a.optionSnapshot(ts).filter((r) => r.type === type), (r) => r.volume * r.ltp).map((r) => optRow(r, r.volume * r.ltp, 'Turnover ₹'));
      }
      case 'call-writing':
      case 'put-writing': {
        const type = id === 'call-writing' ? 'CE' : 'PE';
        return top(a.optionSnapshot(ts).filter((r) => r.type === type && r.ltp < r.prevLtp && r.oiChange > 0), (r) => r.oiChange * r.ltp).map((r) => optRow(r, r.oiChange, 'OI Added'));
      }
      case 'highest-call-oi':
      case 'highest-put-oi': {
        const type = id === 'highest-call-oi' ? 'CE' : 'PE';
        return top(a.optionSnapshot(ts).filter((r) => r.type === type), (r) => r.oi * r.spot).map((r) => optRow(r, r.oi, 'OI'));
      }
      case 'volume-oi-spike':
        return top(a.optionSnapshot(ts).filter((r) => r.oi > 0 && r.volume > 0), (r) => r.volume / r.oi).map((r) => optRow(r, +(r.volume / r.oi).toFixed(2), 'Vol / OI'));
      case 'orb-up':
      case 'orb-down':
      case 'orb-inside': {
        const want = id === 'orb-up' ? 'up' : id === 'orb-down' ? 'down' : 'sideways';
        const rows = a.orbScan(ts).filter((r) => r.trend === want);
        const key = (r: (typeof rows)[number]) => (want === 'sideways' ? -r.widthPct : r.beyondPct ?? 0);
        return top(rows, key).map((r) => ({
          symbol: r.symbol, instrument: r.symbol, type: 'EQ' as const, ltp: r.ltp, changePct: r.changePct, oi: 0, oiChangePct: 0, volume: 0,
          metric: want === 'sideways' ? r.widthPct : r.beyondPct ?? 0,
          metricLabel: want === 'sideways' ? 'Range width %' : want === 'up' ? '% above OR high' : '% below OR low',
        }));
      }
      case 'premium-gainers':
        return top(a.optionSnapshot(ts).filter((r) => r.prevLtp >= 2), (r) => r.changePct).map((r) => optRow(r, r.changePct, 'Prem Chg %'));
      default:
        throw Object.assign(new Error(`Unknown scanner ${id}`), { statusCode: 404 });
    }
  }

  unusual(ts: number, symbol?: string, limit = 60): UnusualActivityRow[] {
    const rows = this.analytics.optionSnapshot(ts).filter((r) => (!symbol || r.symbol === symbol) && r.oi > 0 && r.prevOi > 0);
    if (!rows.length) return [];
    const stat = (xs: number[]) => {
      const m = xs.reduce((s, x) => s + x, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / xs.length) || 1;
      return { m, sd };
    };
    const vo = rows.map((r) => Math.log1p(r.volume / r.oi));
    const oc = rows.map((r) => Math.abs(r.oiChangePct));
    const ivc = rows.map((r) => Math.abs(r.iv - r.prevIv));
    const sVo = stat(vo);
    const sOc = stat(oc);
    const sIv = stat(ivc);
    const scored = rows.map((r, i) => {
      const z = Math.max(0, (vo[i] - sVo.m) / sVo.sd) + Math.max(0, (oc[i] - sOc.m) / sOc.sd) + 0.5 * Math.max(0, (ivc[i] - sIv.m) / sIv.sd);
      const turnover = r.volume * r.ltp;
      const bu = classifyBuildUp(r.ltp - r.prevLtp, r.oiChange);
      const signal = signalFor(r.type, bu);
      return {
        symbol: r.symbol, type: r.type, strike: r.strike, expiry: r.expiry, ltp: r.ltp, changePct: r.changePct, oi: r.oi, oiChange: r.oiChange, oiChangePct: r.oiChangePct,
        volume: r.volume, volumeOiRatio: +(r.volume / r.oi).toFixed(2), iv: r.iv, ivChange: +(r.iv - r.prevIv).toFixed(2), premiumTurnover: turnover, score: +(z * Math.log10(10 + turnover / 1e5)).toFixed(2), signal, buildUp: bu,
      } satisfies UnusualActivityRow;
    });
    return scored.filter((r) => r.score > 1.5).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  synopsis(ts: number): SynopsisRow[] {
    const e = this.engine;
    const a = this.analytics;
    const fut = new Map(a.futuresBuildUp(ts).map((r) => [r.symbol, r]));
    const ivs = new Map(a.ivTable(ts).map((r) => [r.symbol, r]));
    const snap = a.optionSnapshot(ts);
    const pcrBy = new Map<string, { ce: number; pe: number }>();
    for (const r of snap) {
      const v = pcrBy.get(r.symbol) ?? { ce: 0, pe: 0 };
      if (r.type === 'CE') v.ce += r.oi;
      else v.pe += r.oi;
      pcrBy.set(r.symbol, v);
    }
    const p = e.parts(ts);
    return [...e.instruments.values()]
      .filter((i) => i.kind === 'stock')
      .map((inst) => {
        const q = e.quote(inst.symbol, ts);
        const f = fut.get(inst.symbol)!;
        const iv = ivs.get(inst.symbol)!;
        const pc = pcrBy.get(inst.symbol);
        const bar = e.bar(inst.symbol, p.dayIdx);
        return {
          symbol: inst.symbol, name: inst.name, sector: inst.sector, ltp: q.ltp, changePct: q.changePct, oiChangePct: f.oiChangePct, ivChange: iv.ivChange, iv: iv.iv,
          turnover: Math.round(bar.volume * p.f * q.ltp), buildUp: f.buildUp, pcr: pc && pc.ce ? +(pc.pe / pc.ce).toFixed(2) : 0,
        };
      });
  }

  orderBook(symbol: string, spec: { type: 'FUT' | 'CE' | 'PE'; strike?: number; expiry?: string }, ts: number): OrderBookResponse {
    const e = this.engine;
    const inst = e.inst(symbol);
    const p = e.parts(ts);
    const prevIdx = Math.max(0, p.dayIdx - 1);
    let expiry: string;
    let ltpAt: (dayIdx: number, m: number) => number;
    let live: number;
    let oi: number;
    let volume: number;
    let label: string;
    if (spec.type === 'FUT') {
      const list = e.futureExpiries(symbol, ts);
      expiry = spec.expiry && list.includes(spec.expiry) ? spec.expiry : list[0];
      ltpAt = (d, m) => e.futurePrice(symbol, expiry, 0, { dayIdx: d, m });
      live = e.futurePrice(symbol, expiry, ts);
      oi = e.futureOi(symbol, expiry, p.dayIdx, p.m);
      volume = e.futureVolume(symbol, expiry, p.dayIdx, p.m);
      label = `${symbol} ${formatExpiry(expiry)} FUT`;
    } else {
      const list = e.expiries(symbol, ts);
      expiry = spec.expiry && list.includes(spec.expiry) ? spec.expiry : list[0];
      const ctx = e.contract(symbol, expiry);
      const strikes = e.strikes(ctx, p.dayIdx);
      const spot = e.spot(symbol, ts);
      const strike = spec.strike && strikes.includes(spec.strike) ? spec.strike : strikes.reduce((a, k) => (Math.abs(k - spot) < Math.abs(a - spot) ? k : a));
      const type = spec.type;
      ltpAt = (d, m) => e.optionAt(ctx, type, strike, 0, { minute: { dayIdx: d, m } }).ltp;
      live = e.optionAt(ctx, type, strike, ts).ltp;
      oi = e.oiAt(ctx, type, strike, p.dayIdx, p.m);
      volume = e.volumeAt(ctx, type, strike, p.dayIdx, p.m);
      label = `${symbol} ${formatExpiry(expiry)} ${strike} ${type}`;
    }
    const lot = inst.lotSize;
    const tick = 0.05;
    const idSeed = Math.floor(live * 100) ^ (spec.strike ?? 0);
    const sec = Math.floor(ts / 1000);
    const spreadTicks = Math.max(1, Math.round((live * (spec.type === 'FUT' ? 0.000012 / inst.liquidity : 0.002 + 0.01 / inst.liquidity)) / tick));
    const bestBid = roundTick(live - Math.floor(spreadTicks / 2) * tick);
    const bestAsk = roundTick(Math.max(bestBid + tick, live + Math.ceil(spreadTicks / 2) * tick));
    const baseQty = Math.max(1, Math.round(inst.liquidity * (spec.type === 'FUT' ? 25 : 60)));
    const tilt = e.bookTilt(symbol, p.dayIdx, p.m);
    const level = (side: 'b' | 'a', i: number): DepthLevel => {
      const u = hashU(e.symId(symbol), sec, i + (side === 'a' ? 10 : 0), idSeed);
      const lots = 1 + Math.floor(u * baseQty * (1 + i * 0.35) * Math.exp(side === 'b' ? tilt : -tilt));
      return { price: roundTick(side === 'b' ? bestBid - i * tick * (1 + Math.floor(u * 2)) : bestAsk + i * tick * (1 + Math.floor(u * 2))), qty: lots * lot, orders: 1 + Math.floor(lots / (2 + u * 4)) };
    };
    const bids = [0, 1, 2, 3, 4].map((i) => level('b', i));
    const asks = [0, 1, 2, 3, 4].map((i) => level('a', i));
    // keep levels strictly ordered
    for (let i = 1; i < 5; i++) {
      if (bids[i].price >= bids[i - 1].price) bids[i].price = roundTick(bids[i - 1].price - tick);
      if (asks[i].price <= asks[i - 1].price) asks[i].price = roundTick(asks[i - 1].price + tick);
    }
    const totalBidQty = Math.round(bids.reduce((s, l) => s + l.qty, 0) * (8 + 4 * hashU(sec, 1, idSeed)));
    const totalAskQty = Math.round(asks.reduce((s, l) => s + l.qty, 0) * (8 + 4 * hashU(sec, 2, idSeed)));
    const marks = e.minuteMarks(p.m, 5);
    const prices = marks.map((m) => ltpAt(p.dayIdx, m));
    let pv = 0;
    let vv = 0;
    const history = marks.map((m, i) => {
      const w = 1 + 0.8 * Math.exp(-m / 30) + 0.5 * Math.exp(-(M - m) / 30);
      pv += prices[i] * w;
      vv += w;
      const t2 = e.bookTilt(symbol, p.dayIdx, m);
      const bq = Math.round(baseQty * lot * 40 * Math.exp(t2));
      const aq = Math.round(baseQty * lot * 40 * Math.exp(-t2));
      return { ts: e.tsOf(p.dayIdx, m), ltp: prices[i], bidQty: bq, askQty: aq, ratio: +(bq / aq).toFixed(2), spread: +(spreadTicks * tick).toFixed(2), vwap: +(pv / vv).toFixed(2) };
    });
    const vwap = history.length ? history[history.length - 1].vwap : live;
    const open = prices[0] ?? live;
    const high = Math.max(live, ...prices);
    const low = Math.min(live, ...prices);
    const prevClose = ltpAt(prevIdx, M);
    const change = live - prevClose;
    const spread = bestAsk - bestBid;
    const mid = (bestAsk + bestBid) / 2;
    const imbalance = (totalBidQty - totalAskQty) / (totalBidQty + totalAskQty);
    const micro = (bestBid * asks[0].qty + bestAsk * bids[0].qty) / (asks[0].qty + bids[0].qty);
    const fiveAgo = prices.length > 1 ? prices[prices.length - 2] : open;
    const rangePos = high > low ? ((live - low) / (high - low)) * 100 : 50;
    const band = spec.type === 'FUT' ? 0.1 : 0.4;
    const tone = (x: number) => (x > 0 ? 'up' : x < 0 ? 'down' : 'neutral') as 'up' | 'down' | 'neutral';
    const lastTradeQty = lot * (1 + Math.floor(hashU(sec, 5, idSeed) * 10));
    const analytics: OrderBookResponse['analytics'] = [
      { label: 'Buy / Sell Qty Ratio', value: (totalBidQty / totalAskQty).toFixed(2), tone: tone(totalBidQty - totalAskQty), hint: '>1 means more resting buy interest' },
      { label: 'Order Imbalance', value: `${(imbalance * 100).toFixed(1)}%`, tone: tone(imbalance) },
      { label: 'Best Bid / Ask Qty', value: `${formatCompact(bids[0].qty)} / ${formatCompact(asks[0].qty)}`, tone: tone(bids[0].qty - asks[0].qty) },
      { label: 'Bid-Ask Spread', value: `${spread.toFixed(2)} (${((spread / mid) * 100).toFixed(3)}%)` },
      { label: 'Mid Price', value: mid.toFixed(2) },
      { label: 'Micro Price', value: micro.toFixed(2), hint: 'Size-weighted fair price from top of book', tone: tone(micro - mid) },
      { label: 'VWAP / ATP', value: vwap.toFixed(2), tone: tone(live - vwap) },
      { label: 'LTP vs VWAP', value: `${(((live - vwap) / vwap) * 100).toFixed(2)}%`, tone: tone(live - vwap) },
      { label: 'Day Range Position', value: `${rangePos.toFixed(0)}%`, hint: '0% = day low, 100% = day high' },
      { label: '5-min Momentum', value: `${(((live - fiveAgo) / fiveAgo) * 100).toFixed(2)}%`, tone: tone(live - fiveAgo) },
      { label: 'Avg Bid Order Size', value: formatCompact(bids.reduce((s, l) => s + l.qty, 0) / bids.reduce((s, l) => s + l.orders, 0)) },
      { label: 'Avg Ask Order Size', value: formatCompact(asks.reduce((s, l) => s + l.qty, 0) / asks.reduce((s, l) => s + l.orders, 0)) },
      { label: 'Depth (top 5) Buy Value', value: `₹${formatCompact(bids.reduce((s, l) => s + l.qty * l.price, 0))}` },
      { label: 'Depth (top 5) Sell Value', value: `₹${formatCompact(asks.reduce((s, l) => s + l.qty * l.price, 0))}` },
      { label: 'Volume', value: formatCompact(volume) },
      { label: 'Turnover', value: `₹${formatCompact(volume * vwap)}` },
      { label: 'Open Interest', value: formatCompact(oi) },
      { label: 'Last Trade Qty', value: formatCompact(lastTradeQty) },
    ];
    return {
      instrument: label,
      ltp: live,
      change: +change.toFixed(2),
      changePct: prevClose ? +((change / prevClose) * 100).toFixed(2) : 0,
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
      spread: +spread.toFixed(2),
      spreadPct: +((spread / mid) * 100).toFixed(3),
      imbalance: +imbalance.toFixed(3),
      lastTradeQty,
      upperCircuit: roundTick(prevClose * (1 + band)),
      lowerCircuit: Math.max(0.05, roundTick(prevClose * (1 - band))),
      history,
      analytics,
    };
  }

  /**
   * 1-minute order flow: aggressive buy vs sell volume per minute for a future or option,
   * with the last completed minute, the minute in progress, last-5-minute and session totals.
   */
  orderFlow(
    symbol: string,
    spec: { type: 'FUT' | 'CE' | 'PE'; strike?: number; expiry?: string },
    ts: number,
    opts: { date?: string; limit?: number } = {},
  ): OrderFlowResponse {
    const e = this.engine;
    const inst = e.inst(symbol);
    const now = e.parts(ts);
    let dayIdx = now.dayIdx;
    let upto = now.m;
    if (opts.date && opts.date < now.date) {
      const idx = e.dayIndex.get(opts.date);
      if (idx === undefined) throw Object.assign(new Error(`${opts.date} is not a trading day`), { statusCode: 400 });
      dayIdx = idx;
      upto = M;
    }
    const live = dayIdx === now.dayIdx && upto < M;
    const at = live ? ts : e.tsOf(dayIdx, Math.min(upto, M - 1));
    let expiry: string;
    let strike: number | undefined;
    if (spec.type === 'FUT') {
      const list = e.futureExpiries(symbol, at);
      expiry = spec.expiry && list.includes(spec.expiry) ? spec.expiry : list[0];
    } else {
      const list = e.expiries(symbol, at);
      expiry = spec.expiry && list.includes(spec.expiry) ? spec.expiry : list[0];
      const ctx = e.contract(symbol, expiry);
      const strikes = e.strikes(ctx, dayIdx);
      const ref = e.spotAt(symbol, dayIdx, upto);
      strike = spec.strike && strikes.includes(spec.strike) ? spec.strike : strikes.reduce((a, k) => (Math.abs(k - ref) < Math.abs(a - ref) ? k : a));
    }
    const fspec = { type: spec.type, expiry, strike };
    const completed = Math.floor(upto);
    const all: OrderFlowMinute[] = [];
    let cum = 0;
    for (let j = 0; j < completed; j++) {
      const f = e.minuteFlow(symbol, fspec, dayIdx, j);
      const delta = f.buyVolume - f.sellVolume;
      cum += delta;
      all.push({ ts: e.tsOf(dayIdx, j), volume: f.volume, buyVolume: f.buyVolume, sellVolume: f.sellVolume, delta, cumDelta: cum, buyPct: f.volume ? +((f.buyVolume / f.volume) * 100).toFixed(1) : 50, close: f.close });
    }
    const asFlow = (m: OrderFlowMinute): FlowMinute => ({ ts: m.ts, volume: m.volume, buyVolume: m.buyVolume, sellVolume: m.sellVolume });
    const lastM = all[all.length - 1];
    const lastMinute = lastM ? { ...summariseFlow([asFlow(lastM)]), ts: lastM.ts, close: lastM.close } : null;
    let currentMinute: OrderFlowResponse['currentMinute'] = null;
    if (live && upto > completed) {
      const f = e.minuteFlow(symbol, fspec, dayIdx, completed, upto);
      currentMinute = { ...summariseFlow([{ ts: e.tsOf(dayIdx, completed), volume: f.volume, buyVolume: f.buyVolume, sellVolume: f.sellVolume }]), ts: e.tsOf(dayIdx, completed), elapsedSec: Math.round((upto - completed) * 60) };
    }
    const last5 = summariseFlow(all.slice(-5).map(asFlow));
    const session = summariseFlow(all.map(asFlow));
    const label = spec.type === 'FUT' ? `${symbol} ${formatExpiry(expiry)} FUT` : `${symbol} ${formatExpiry(expiry)} ${strike} ${spec.type}`;
    let signal = 'Waiting for the first completed minute';
    if (lastMinute) {
      const who = lastMinute.sentiment === 'Buyers dominant' ? 'buyers' : lastMinute.sentiment === 'Sellers dominant' ? 'sellers' : null;
      const trend5 = last5.sentiment === lastMinute.sentiment && who ? ` and over the last 5 minutes` : '';
      signal = who
        ? `${formatTimeIST(lastMinute.ts)}–${formatTimeIST(lastMinute.ts + 60_000)}: ${who} were more aggressive (${lastMinute.buyPct.toFixed(0)}% buy volume)${trend5}`
        : `${formatTimeIST(lastMinute.ts)}–${formatTimeIST(lastMinute.ts + 60_000)}: buying and selling balanced (${lastMinute.buyPct.toFixed(0)}% buy volume)`;
    }
    const limit = Math.max(1, Math.min(375, opts.limit ?? 60));
    return {
      symbol,
      instrument: label,
      type: spec.type,
      expiry,
      strike,
      date: e.days[dayIdx],
      live,
      lotSize: inst.lotSize,
      lastMinute,
      currentMinute,
      last5,
      session,
      minutes: all.slice(-limit),
      signal,
    };
  }

  /** IV percentile for every symbol (used by watchlist & dashboard). */
  ivp(symbol: string, ts: number): number {
    const e = this.engine;
    const p = e.parts(ts);
    const hist = e.bars(symbol).slice(Math.max(0, p.dayIdx - 252), p.dayIdx).map((b) => b.iv);
    return ivPercentile(e.atmIvAt(symbol, p.dayIdx, p.m), hist);
  }
}

function signalFor(type: 'CE' | 'PE', bu: string): string {
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
    default:
      return 'Neutral';
  }
}
