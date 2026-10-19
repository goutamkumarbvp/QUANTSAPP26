import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ORDER_FLOW_METHOD,
  type AlertDef,
  type AlgoCatalog,
  type AlgoRunView,
  type Funds,
  type FuturesQuote,
  type MarketClockInfo,
  type MetaResponse,
  type OptionChain,
  type OptionQuote,
  type OrderBookResponse,
  type OrderFlowResponse,
  type OrderFlowSummary,
  type Position,
  type SavedStrategy,
  type WatchQuote,
} from '@q26/core';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { hasChartData } from '../src/components/Chart';
import { FlowSplit } from '../src/components/trend';
import { ApiError } from '../src/lib/api';
import { useBuilder, useTicks, type BuilderLeg } from '../src/lib/store';
import Algo from '../src/pages/Algo';
import Alerts from '../src/pages/Alerts';
import Builder from '../src/pages/Builder';
import Calculators from '../src/pages/Calculators';
import OptionChainPage from '../src/pages/OptionChain';
import Optimizer from '../src/pages/Optimizer';
import OrderBook from '../src/pages/OrderBook';
import Positions from '../src/pages/Positions';
import Strategies from '../src/pages/Strategies';
import Templates from '../src/pages/Templates';
import Watchlist from '../src/pages/Watchlist';

// Every <Chart> the pages render is captured so its option can be drawn by real ECharts (SVG, server side).
const charts: { option: Parameters<typeof hasChartData>[0]; blank: unknown }[] = [];
vi.mock('../src/components/Chart', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/components/Chart')>();
  return { ...mod, Chart: (props: Parameters<typeof mod.Chart>[0]) => { charts.push({ option: props.option, blank: props.blank }); return mod.Chart(props); } };
});
echarts.use([SVGRenderer]);

/** Draws a chart option with ECharts; a bad option throws here, as it would in the browser. */
function draw(option: Parameters<typeof hasChartData>[0]): string {
  const g = globalThis as Record<string, unknown>;
  const doc = g.document;
  g.document = undefined;
  const chart = echarts.init(null as unknown as HTMLElement, undefined, { renderer: 'svg', ssr: true, width: 800, height: 420 });
  try {
    chart.setOption(option);
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
    g.document = doc;
  }
}

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.document = { documentElement: { classList: { contains: () => true, toggle: () => undefined } }, querySelector: () => null };
  g.getComputedStyle = () => ({ getPropertyValue: () => '10 20 30' });
  const error = console.error;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (!String(args[0]).includes('useLayoutEffect does nothing on the server')) error(...args);
  });
});

const ts = Date.UTC(2026, 9, 19, 5, 12, 5); // Mon 19 Oct 2026 10:42:05 IST
const friClose = Date.UTC(2026, 9, 16, 10, 0, 0); // Fri 16 Oct 2026 15:30 IST
const clock = (status: MarketClockInfo['status']): MarketClockInfo => ({ ts, date: '2026-10-19', time: '10:42:05', status, sessionMinute: 87 });

type Seed = [unknown[], unknown];
const BAD = /NaN|undefined|Infinity|>null<|\bnull\b/;
const noLive = (reason: string) => new ApiError(reason, 503, 'NO_LIVE_DATA');
const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<');

function render(node: ReactElement, seeds: Seed[], url = '/'): string {
  charts.length = 0;
  const qc = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  for (const [key, data] of seeds) {
    if (data instanceof ApiError) qc.getQueryCache().build(qc, { queryKey: key }).setState({ status: 'error', error: data, fetchStatus: 'idle', errorUpdateCount: 1, errorUpdatedAt: 1 });
    else qc.setQueryData(key, data);
  }
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
  for (const c of charts) if (c.blank === undefined && hasChartData(c.option)) expect(draw(c.option)).toContain('<svg');
  return decode(html);
}

// zustand 5 renders the server snapshot (the store's initial state) on the server: seed that object in place.
function seed(status: MarketClockInfo['status'] = 'open', legs: BuilderLeg[] = []) {
  Object.assign(useTicks.getInitialState(), { clock: clock(status), quotes: {}, connected: true });
  Object.assign(useBuilder.getInitialState(), { symbol: 'NIFTY', legs });
}
beforeEach(() => seed());

const meta = {
  appName: 'q26', dataSource: 'live', riskFreeRate: 0.065, clock: clock('open'),
  symbols: [{ symbol: 'NIFTY', name: 'Nifty 50', kind: 'index', exchange: 'NSE', sector: '', lotSize: 75, strikeStep: 50, expiryCycle: 'weekly' }],
} as unknown as MetaResponse;
const expiries = { options: ['2026-10-20', '2026-10-27'], futures: ['2026-10-27'] };

/* ------------------------------------------------------------------ fixtures */

const leg = (over: Partial<OptionQuote> = {}): OptionQuote => ({
  ltp: 100.5, change: 5, changePct: 5.2, prevClose: 95.5, oi: 120_000, prevOi: 100_000, oiChange: 20_000, oiChangePct: 20, volume: 50_000,
  iv: 13.2, delta: 0.52, gamma: 0.0004, theta: -12.3, vega: 8.1, bid: 100, ask: 101, bidQty: 75, askQty: 150, buildUp: 'Long Build-up',
  intrinsic: 10, timeValue: 90.5, ivSource: 'mid', ivTs: ts, ts, ...over,
});
const blankLeg = (over: Partial<OptionQuote> = {}): OptionQuote =>
  leg({ ltp: null, change: null, changePct: null, prevClose: null, oi: null, prevOi: null, oiChange: null, oiChangePct: null, volume: null, iv: null, delta: null, gamma: null, theta: null, vega: null, bid: null, ask: null, bidQty: null, askQty: null, buildUp: null, intrinsic: null, timeValue: null, ivSource: null, ivTs: null, ts: null, ...over });

const STRIKES = [24000, 24050, 24100, 24150, 24200];
const chainOf = (over: Partial<OptionChain> = {}, rows?: OptionChain['rows']): OptionChain => ({
  symbol: 'NIFTY', expiry: '2026-10-27', expiries: expiries.options, ts, valuationTs: ts,
  spot: 24100.5, spotChange: 120.5, spotChangePct: 0.5, spotTs: ts, future: 24130, futureExpiry: '2026-10-27', forward: 24131, forwardSource: 'future', carry: 0.011,
  lotSize: 75, strikeStep: 50, daysToExpiry: 8.2, atm: 24100, atmIv: 13.4, ivChange: -0.3, pcr: 1.12, pcrVolume: 0.9, maxPain: 24100,
  totalCeOi: 1_000_000, totalPeOi: 1_200_000, totalCeOiChange: 50_000, totalPeOiChange: -20_000, support: 24000, resistance: 24300,
  coverage: 'PCR, max pain and totals over strikes with OI on both sides',
  rows: rows ?? STRIKES.map((strike) => ({ strike, ce: leg(), pe: leg() })),
  ...over,
});
/** A chain with no live spot, a future-less forward from parity, no carry, and a leg that never traded. */
const noSpotChain = (): OptionChain =>
  chainOf(
    { spot: null, spotChange: null, spotChangePct: null, spotTs: null, atm: null, future: null, forward: 24131, forwardSource: 'parity', carry: null, atmIv: null, ivChange: null, maxPain: null, pcr: null, pcrVolume: null,
      gaps: { spot: 'No live NIFTY price', carry: 'No live spot to imply the carry from', atmIv: 'ATM IV could not be solved from the available premiums' } },
    STRIKES.map((strike) => ({ strike, ce: strike === 24200 ? blankLeg({ oi: 90_000 }) : leg({ ivSource: 'ltp' }), pe: leg() })),
  );

const clk = (k: string) => [k];

/* ------------------------------------------------------------------ option chain */

describe('Option chain', () => {
  const seeds = (c: OptionChain | ApiError, at: number | 'live' = 'live'): Seed[] => [[['meta'], meta], [['expiries', 'NIFTY', at], expiries], [['chain', 'NIFTY', '', at], c]];

  it('live chain: spot line, ATM strike and ITM shading, IV source marker, bid/ask', () => {
    const html = render(<OptionChainPage />, seeds(chainOf({ coverage: 'PCR over 5 strikes' })));
    expect(html).toContain('NIFTY 24,100.50');
    expect(html).toContain('bg-accent/15 text-accent'); // ATM strike
    expect(html).toContain('bg-itm');
    expect(html).toContain('same-expiry future');
    expect(html).toContain('PCR over 5 strikes');
    expect(html).toContain('valued at 10:42:05');
    expect(html).not.toMatch(BAD);
  });

  it('no live spot: no ATM, no ITM shading, no spot line; the reasons are shown; blank legs are dashes', () => {
    const html = render(<OptionChainPage />, seeds(noSpotChain()));
    expect(html).not.toContain('bg-itm');
    expect(html).not.toContain('bg-accent/15 text-accent');
    expect(html).not.toContain('!border-accent/70'); // the spot divider row
    expect(html).toContain('No live NIFTY price');
    expect(html).toContain('No live spot to imply the carry from');
    expect(html).toContain('put-call parity');
    expect(html).toContain('ATM, in-the-money shading and the spot line are not shown');
    expect(html).toContain('Not traded in the live session');
    expect(html).toContain('>L</sup>'); // an IV solved from the last traded price
    expect(html).not.toMatch(BAD);
  });

  it('a 503 is the blank state with the server reason, not the red box', () => {
    const html = render(<OptionChainPage />, seeds(noLive('NIFTY has no live option quotes yet')));
    expect(html).toContain('NIFTY has no live option quotes yet');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('border-down/40');
  });

  it('?at= opens a recorded chain: the recorded time is shown and trading is off', () => {
    const at = ts - 3_600_000;
    const html = render(<OptionChainPage />, seeds(chainOf({ ts: at, valuationTs: at, spotTs: at }), at), `/option-chain?at=${at}`);
    expect(html).toContain('Recorded chain as of');
    expect(html).toContain('not live');
    expect(html).not.toContain('Place a paper order');
    expect(html).not.toContain('Add BUY leg to strategy builder');
    const refused = render(<OptionChainPage />, seeds(noLive('Nothing recorded for NIFTY at 09:30 (last recorded minute 09:15): the recorder was not running'), at), `/option-chain?at=${at}`);
    expect(refused).toContain('the recorder was not running');
  });
});

/* ------------------------------------------------------------------ order book */

describe('Order book', () => {
  const book = (over: Partial<OrderBookResponse> = {}): OrderBookResponse => ({
    symbol: 'NIFTY', instrument: 'NIFTY 27-Oct-26 FUT', type: 'FUT', expiry: '2026-10-27', bookTs: ts, bookLive: true,
    ltp: 24130, change: 110, changePct: 0.46, open: null, high: null, low: null, prevClose: 24020, vwap: null, volume: 1_200_000, oi: null,
    bids: [{ price: 24129.9, qty: 150, orders: 3 }, { price: 24129.85, qty: 300, orders: null }],
    asks: [{ price: 24130.1, qty: 75, orders: 2 }, { price: 24130.15, qty: 225, orders: 4 }, { price: 24130.2, qty: 150, orders: 1 }],
    totalBidQty: null, totalAskQty: 5000, spread: 0.2, spreadPct: 0.0008, imbalance: null, lastTradeQty: null, upperCircuit: null, lowerCircuit: null,
    history: [], analytics: [{ label: 'Imbalance', value: null, hint: 'Needs the total bid and ask quantity' }, { label: 'Spread', value: '0.20' }],
    gaps: { history: 'Nothing recorded for this contract yet' },
    ...over,
  });
  const key = ['order-book', 'NIFTY', 'FUT', undefined, undefined];
  const seeds = (b: OrderBookResponse | ApiError, flow?: OrderFlowResponse | ApiError): Seed[] => [[['meta'], meta], [['expiries', 'NIFTY', 'live'], expiries], [key, b], ...(flow ? ([[['order-flow', 'NIFTY', 'FUT', undefined, undefined, '', 5], flow]] as Seed[]) : [])];

  it('shows only the levels the feed sent, blanks what it did not, and never invents totals', () => {
    const html = render(<OrderBook />, seeds(book()));
    expect(html).toContain('24129.90');
    expect(html).toContain('24130.20');
    expect(html).toContain('The feed did not send the total bid quantity');
    expect(html).toContain('Needs the total bid and ask quantity');
    // 3 ask levels, 2 bid levels: the third bid row is empty (a dash), not padded with a price
    expect((html.match(/<tbody>[\s\S]*?<\/tbody>/)?.[0].match(/<tr/g) ?? []).length).toBe(3 + 1); // levels + totals row
    expect(html).not.toMatch(BAD);
  });

  it('a book that is not live is labelled with its time', () => {
    const html = render(<OrderBook />, seeds(book({ bookLive: false })));
    expect(html).toContain('not a live one');
  });

  it('503 until depth arrives: the blank state with the reason and the hint', () => {
    const html = render(<OrderBook />, seeds(noLive('No market depth received yet for NIFTY 27-Oct-26 FUT')));
    expect(html).toContain('No market depth received yet for NIFTY 27-Oct-26 FUT');
    expect(html).toContain('Nothing is shown until the feed has sent real depth');
    expect(html).not.toContain('border-down/40');
  });

  it('order flow: feed gaps and partial minutes are labelled, unclassified is not split', () => {
    const sum = (over: Partial<OrderFlowSummary> = {}): OrderFlowSummary => ({ buyVolume: 150, sellVolume: 75, unclassified: 75, volume: 300, gapVolume: 1500, partialMinutes: 1, delta: 75, buyPct: 66.7, unclassifiedPct: 25, sentiment: 'Feed gap', ...over });
    const flow = {
      symbol: 'NIFTY', instrument: 'NIFTY 27-Oct-26 FUT', type: 'FUT', expiry: '2026-10-27', date: '2026-10-19', live: true, lotSize: 75, method: ORDER_FLOW_METHOD,
      lastMinute: { ...sum(), ts: ts - 60_000, close: 24130 }, currentMinute: null, last5: null, session: sum(), minutes: [], signal: '', coverage: '10:30–10:41 recorded', expiries: [], strikes: [],
    } as unknown as OrderFlowResponse;
    const html = render(<OrderBook />, seeds(book(), flow));
    expect(html).toContain('feed gap: 1.5K not counted');
    expect(html).toContain('partial (lower bound)');
    expect(html).toContain('unclassified 75');
    expect(html).toContain('estimated from live ticks (quote rule)');
    expect(html).toContain('No recorded minute yet'); // last5 is null
    expect(html).not.toMatch(BAD);
  });
});

describe('FlowSplit', () => {
  const base: OrderFlowSummary = { buyVolume: 0, sellVolume: 0, unclassified: 0, volume: 0, gapVolume: 0, partialMinutes: 0, delta: 0, buyPct: null, unclassifiedPct: null, sentiment: 'No trades' };
  const show = (f: OrderFlowSummary) => decode(renderToStaticMarkup(<FlowSplit flow={f} />));
  it('no trades, a feed gap only, and nothing classified are three different statements', () => {
    expect(show(base)).toContain('No trades yet');
    expect(show({ ...base, gapVolume: 900, sentiment: 'Feed gap' })).toContain('Feed gap — nothing classified');
    const none = show({ ...base, volume: 300, unclassified: 300, unclassifiedPct: 100, sentiment: 'Not classified' });
    expect(none).toContain('Not classified — 300 traded');
    expect(none).not.toContain('50%');
    expect(none).not.toMatch(BAD);
  });
});

/* ------------------------------------------------------------------ positions */

describe('Positions', () => {
  const pos = (over: Partial<Position> = {}): Position => ({
    key: 'k1', instrument: 'NIFTY 27-Oct-26 24100 CE', symbol: 'NIFTY', type: 'CE', strike: 24100, expiry: '2026-10-27', product: 'NRML', netQty: 75, lotSize: 75, avgPrice: 100, buyQty: 75, sellQty: 0, buyValue: 7500, sellValue: 0,
    ltp: 105, ltpTs: ts - 4000, realized: 0, unrealized: 375, pnl: 375, status: 'open', ...over,
  });
  const funds = (over: Partial<Funds> = {}): Funds => ({ openingBalance: 1_000_000, available: 900_000, usedMargin: 80_000, realizedPnl: 0, unrealizedPnl: 375, premiumPaid: 7500, premiumReceived: 0, ...over });
  const seeds = (positions: Position[], f: Funds): Seed[] => [
    [['meta'], meta], [['expiries', 'NIFTY', 'live'], expiries], [['broker', 'positions'], positions], [['broker', 'funds'], f], [['broker', 'orders'], []], [['broker', 'trades'], []],
  ];

  it('priced positions show LTP with its age and a real total', () => {
    const html = render(<Positions />, seeds([pos()], funds()));
    expect(html).toContain('105.00');
    expect(html).toContain('LTP 10:42:01');
    expect(html).toContain('₹375');
    expect(html).not.toMatch(BAD);
  });

  it('an unpriced position: dashes with the reason, no total, awaiting settlement is labelled', () => {
    const blank = pos({ key: 'k2', instrument: 'NIFTY 20-Oct-26 24000 PE', type: 'PE', strike: 24000, expiry: '2026-10-20', ltp: null, ltpTs: null, unrealized: null, pnl: null, status: 'awaiting settlement', reason: 'Awaiting the exchange settlement price for NIFTY 20-Oct-26 24000 PE' });
    const html = render(<Positions />, seeds([pos(), blank], funds({ available: null, usedMargin: null, unrealizedPnl: null, gaps: { available: 'Margin cannot be estimated', unrealizedPnl: 'No live price for NIFTY 20-Oct-26 24000 PE' } })));
    expect(html).toContain('awaiting settlement');
    expect(html).toContain('Awaiting the exchange settlement price');
    expect(html).toContain('Margin cannot be estimated');
    expect(html).toContain('No live price for NIFTY 20-Oct-26 24000 PE'); // the total's reason
    expect(html).not.toContain('Total P&L</div><div class="truncate text-base font-semibold tabular-nums">₹');
    expect(html).not.toMatch(BAD);
  });

  it('an empty account: P&L totals are dashes with "No open positions", never ₹0', () => {
    const html = render(<Positions />, seeds([], funds({ unrealizedPnl: 0, usedMargin: 0, available: 1_000_000, premiumPaid: 0 })));
    expect(html).toContain('No open positions');
    expect(html).not.toMatch(/P&amp;L<\/div><div[^>]*>₹0/);
    expect(html).not.toMatch(BAD);
  });
});

/* ------------------------------------------------------------------ watchlist */

describe('Watchlist', () => {
  it('a quote the market did not give is a dash with its reason and age', () => {
    const items = [{ symbol: 'RELIANCE', type: 'EQ' as const }, { symbol: 'NIFTY', type: 'CE' as const, strike: 24100, expiry: '2026-10-27' }];
    const quotes: WatchQuote[] = [
      { ...items[0], label: 'RELIANCE', ltp: 2950.5, change: 12, changePct: 0.4, bid: null, ask: null, oi: null, oiChangePct: null, iv: null, ts: ts - 2000, ageSec: 2 },
      { ...items[1], label: 'NIFTY 27-Oct-26 24100 CE', ltp: null, change: null, changePct: null, bid: null, ask: null, oi: 120_000, oiChangePct: null, iv: null, ts: null, ageSec: null, reason: 'Not traded in the live session' },
    ];
    const html = render(<Watchlist />, [[['meta'], meta], [['expiries', 'RELIANCE', 'live'], expiries], [['watchlists'], [{ id: 'w1', name: 'Default', items }]], [['watch-quotes', 'w1', 2], quotes]]);
    expect(html).toContain('2,950.50');
    expect(html).toContain('Not traded in the live session');
    expect(html).toContain('NIFTY 27-Oct-26 24100 CE');
    expect(html).not.toMatch(BAD);
  });
});

/* ------------------------------------------------------------------ strategies & alerts */

describe('Strategy Manager', () => {
  it('an MTM that is not live is blank with the reason; the open total is blank too', () => {
    const base = { symbol: 'NIFTY', legs: [], createdAt: ts, updatedAt: ts, status: 'open' as const };
    const list = [
      { ...base, id: 's1', name: 'Priced', live: { mtm: 1250, realized: 0, spot: 24100, legsLtp: [100], ts } },
      { ...base, id: 's2', name: 'Unpriced', live: { mtm: null, realized: 0, spot: null, legsLtp: [null], ts, gaps: { spot: 'No live NIFTY price' } } },
    ] as unknown as SavedStrategy[];
    const html = render(<Strategies />, [[['strategies'], list]]);
    expect(html).toContain('₹1,250');
    expect(html).toContain('No live NIFTY price');
    expect(html).toMatch(/Open MTM <span[^>]*aria-label="Not available: No live MTM for 1 open strategy"/);
    expect(html).not.toMatch(BAD);
  });

  it('no strategy at all: the open MTM is a dash with "No open positions", not ₹0', () => {
    const html = render(<Strategies />, [[['strategies'], []]]);
    expect(html).toMatch(/Open MTM <span[^>]*aria-label="Not available: No open positions"/);
    expect(html).toContain('No open positions</span>');
    expect(html).not.toContain('₹0');
  });
});

describe('Alerts', () => {
  it('an alert skipped for lack of live input says so; a disabled one shows why', () => {
    const base = { kind: 'PRICE', symbol: 'NIFTY', condition: 'above', value: 25000, createdAt: ts } as const;
    const list: AlertDef[] = [
      { ...base, id: 'a1', status: 'active', lastValue: 24100, checkedAt: ts - 3000 },
      { ...base, id: 'a2', status: 'active', lastValue: null, checkedAt: ts - 3000, statusNote: 'No live NIFTY price' },
      { ...base, id: 'a3', status: 'disabled', statusNote: 'The contract has expired' },
    ];
    const html = render(<Alerts />, [[['meta'], meta], [['expiries', 'NIFTY', 'live'], expiries], [['chain', 'NIFTY', '2026-10-20', 'live'], chainOf({ expiry: '2026-10-20' })], [['alerts'], list], [['notifications'], []], [['strategies'], []]]);
    expect(html).toContain('Skipped, not live: No live NIFTY price');
    expect(html).toContain('waiting for data');
    expect(html).toContain('The contract has expired');
    expect(html).toContain('Last value 24100');
    expect(html).not.toMatch(BAD);
  });
});

/* ------------------------------------------------------------------ builder, payoff, templates, optimizer */

describe('Strategy Builder and payoff', () => {
  const legs = (): BuilderLeg[] => [
    { id: 'L1', side: 'BUY', type: 'CE', strike: 24100, expiry: '2026-10-27', lots: 1, lotSize: 75, price: 100 },
    { id: 'L2', side: 'SELL', type: 'CE', strike: 24200, expiry: '2026-10-27', lots: 1, lotSize: 75, price: 60 },
  ];
  const chainWith = (o: Partial<OptionChain> = {}, noIv = false) =>
    chainOf(o, STRIKES.map((strike) => ({ strike, ce: strike === 24200 ? (noIv ? blankLeg({ oi: 90_000, bid: null, ask: null }) : leg({ ltp: 60.5, iv: 12.8 })) : leg({ iv: 13.2 }), pe: leg() })));
  const seeds = (c: OptionChain): Seed[] => [[['meta'], meta], [['expiries', 'NIFTY', 'live'], expiries], [['chain', 'NIFTY', '2026-10-27', 'live'], c], [['futures', 'NIFTY'], [] as FuturesQuote[]]];

  it('fully live: summary, payoff and what-if render; no leg is flagged', () => {
    seed('open', legs());
    const html = render(<Builder />, seeds(chainWith()));
    expect(html).toContain('Probability of profit');
    expect(html).toContain('Approx. margin');
    expect(html).toContain('valued at 10:42:05');
    expect(html).not.toContain('Left out of today');
    expect(html).not.toMatch(BAD);
    expect(charts.some((c) => hasChartData(c.option))).toBe(true);
  });

  it('a leg IV solved from the LTP carries the chain\'s "L" marker; a mid-solved one does not; the BE labels sit apart from the spot label', () => {
    seed('open', legs());
    const html = render(<Builder />, seeds(chainOf({}, STRIKES.map((strike) => ({ strike, ce: strike === 24200 ? leg({ ltp: 60.5, iv: 12.8, ivSource: 'ltp' }) : leg({ iv: 13.2 }), pe: leg() })))));
    expect(html.match(/title="Solved from the last traded price \(no fresh two-sided book\)">L<\/sup>/g)).toHaveLength(1);
    const payoff = charts.find((c) => JSON.stringify(c.option).includes('"BE ')) as { option: { series: { markLine?: { data: { name: string; label?: { position: string } }[] } }[] } } | undefined;
    const marks = payoff?.option.series.flatMap((x) => x.markLine?.data ?? []) ?? [];
    const spotMark = marks.find((m) => m.name.startsWith('Spot'));
    const be = marks.filter((m) => m.name.startsWith('BE'));
    expect(be.length).toBeGreaterThan(0);
    for (const m of be) expect(m.label?.position).not.toBe(spotMark?.label?.position);
    expect(html).not.toMatch(BAD);
  });

  it('a leg without a premium / IV is flagged, left out of T+0 and of the margin, and its P&L is blank', () => {
    seed('open', legs());
    const html = render(<Builder />, seeds(chainWith({}, true)));
    expect(html).toContain("Left out of today's (T+0) curve, Greeks and margin");
    expect(html).toContain('Sell 24200 CE');
    expect(html).toContain('no implied volatility');
    expect(html).toContain('Margin cannot be estimated');
    expect(html).toContain('Not traded in the live session');
    expect(html).toContain('Today (T+0) — excl. 1 leg');
    expect(html).toContain('disabled=""'); // Execute: no live bid for the sold leg
    expect(html).toContain('No live bid for Sell 24200 CE');
    expect(html).not.toMatch(BAD);
  });

  it('outside the session the figures are valued at the last close, and Execute says the market is closed', () => {
    seed('closed', legs());
    const html = render(<Builder />, seeds(chainWith({ ts, valuationTs: friClose })));
    expect(html).toContain('valued at yesterday 15:30'.replace('yesterday', 'Oct').replace('Oct 15:30', '16 Oct 15:30'));
    expect(html).toContain('The market is closed');
  });

  it('no live spot: no payoff, the reason instead', () => {
    seed('open', legs());
    const html = render(<Builder />, seeds(chainWith({ spot: null, atm: null, gaps: { spot: 'No live NIFTY price' } })));
    expect(html).toContain('No live NIFTY price');
    expect(html).not.toContain('Probability of profit');
    expect(html).not.toMatch(BAD);
  });

  it('adding a leg needs a live premium: without one the button is off with the reason', () => {
    seed('open', []);
    // The add-leg form starts on the nearest listed expiry (20 Oct): seed that chain.
    const blank = chainOf({ expiry: '2026-10-20' }, STRIKES.map((strike) => ({ strike, ce: blankLeg(), pe: blankLeg() })));
    const html = render(<Builder />, [...seeds(chainOf()), [['chain', 'NIFTY', '2026-10-20', 'live'], blank]]);
    expect(html).toMatch(/<button class="[^"]*btn-buy"[^>]*disabled=""/);
    expect(html).toContain('Not traded in the live session');
    expect(html).not.toMatch(BAD);
  });
});

describe('Strategy Wizard', () => {
  const rows = (broken: number[]) => STRIKES.map((strike) => ({ strike, ce: broken.includes(strike) ? blankLeg() : leg(), pe: broken.includes(strike) ? blankLeg() : leg() }));
  const seeds = (c0: OptionChain, c1?: OptionChain): Seed[] => [
    [['meta'], meta], [['expiries', 'NIFTY', 'live'], expiries], [['chain', 'NIFTY', '2026-10-20', 'live'], c0], ...(c1 ? ([[['chain', 'NIFTY', '2026-10-27', 'live'], c1]] as Seed[]) : []),
  ];
  it('draws the strategies whose legs have a live premium and explains the others', () => {
    const c0 = chainOf({ expiry: '2026-10-20' }, rows([24200, 24150]));
    const html = render(<Templates />, seeds(c0));
    expect(html).toContain('Max profit');
    expect(html).toContain('No live premium for');
    expect(html).toContain('none is made up');
    expect(html).not.toMatch(BAD);
  });
  it('no live spot: no cards, the reason', () => {
    const html = render(<Templates />, seeds(chainOf({ expiry: '2026-10-20', spot: null, atm: null, gaps: { spot: 'No live NIFTY price' } })));
    expect(html).toContain('No live NIFTY price');
    expect(html).not.toContain('Open in builder');
  });
});

describe('Strategy Optimizer', () => {
  it('renders without a result and without NaN', () => {
    const html = render(<Optimizer />, [[['meta'], meta], [['expiries', 'NIFTY', 'live'], expiries], [['chain', 'NIFTY', '', 'live'], chainOf()]]);
    expect(html).toContain('Find best strategies');
    expect(html).not.toMatch(BAD);
  });

  it('the disabled button says why, as text', () => {
    const noSpot = render(<Optimizer />, [[['meta'], meta], [['expiries', 'NIFTY', 'live'], expiries], [['chain', 'NIFTY', '', 'live'], chainOf({ spot: null })]]);
    expect(noSpot).toMatch(/<button class="btn-primary" disabled=""/);
    expect(noSpot).toContain('role="note">Enter a target price (there is no live NIFTY spot to pre-fill it from)</span>');
    const down = render(<Optimizer />, [[['meta'], meta], [['expiries', 'NIFTY', 'live'], expiries], [['chain', 'NIFTY', '', 'live'], new ApiError('No live NIFTY option chain', 503, 'NO_LIVE_DATA')]]);
    expect(down).toContain('The option chain is not available: No live NIFTY option chain');
  });
});

/* ------------------------------------------------------------------ algo */

describe('Algo', () => {
  const catalog = {
    algos: [{ id: 'premium-ladder', name: 'Premium ladder', description: '', rules: ['r1'], params: [{ key: 'symbol', label: 'Underlying', type: 'symbol' }] }],
    presets: [{ id: 'strategy-2-rs20', algoId: 'premium-ladder', name: 'Strategy 2 · Starting premium ₹20', summary: 's', params: { symbol: 'NIFTY', lots: 1, startPremium: 20, stepPct: 50, strikeMultiple: 3, entryTime: '09:20', exitTime: '15:25' } }],
    symbols: [], gaps: { symbols: 'Instrument master not loaded yet' },
  } as unknown as AlgoCatalog;
  const run = {
    id: 'r1', algoId: 'premium-ladder', name: 'Strategy 2', params: { symbol: 'NIFTY', lots: 1, startPremium: 20, stepPct: 50, strikeMultiple: 3, entryTime: '09:20', exitTime: '15:25' }, status: 'running', createdAt: ts, totalNet: null,
    gaps: { liveData: 'No live NIFTY price', today: 'No live price for NIFTY 27-Oct-26 24400 CE', totalNet: 'Today has no valuation' },
    today: {
      date: '2026-10-19', expiry: '2026-10-27', phase: 'active', status: [{ label: 'Level', value: '₹20' }], realized: 0, unrealized: null, charges: 40, mtm: null, series: [],
      legs: [{ type: 'CE', strike: 24400, side: 'SELL', lots: 1, entryPrice: 20, entryTs: ts, ltp: null, pnl: null }],
      events: [{ ts, kind: 'ERROR', message: 'Order rejected: No live bid/ask for NIFTY 27-Oct-26 24400 CE', fills: [] }],
    },
    history: [{ date: '2026-10-16', expiry: '2026-10-20', entered: true, pnl: null, charges: 40, net: null, adjustments: 1, maxLevel: 20, orders: 2, maxProfit: 0, maxLoss: 0, exitKind: 'NONE', exitReason: '', exitTs: null, incomplete: 'Awaiting the exchange settlement price' }],
  } as unknown as AlgoRunView;
  it('a run with no live prices: blank figures with reasons, the rejected order, the waiting banner, an incomplete day', () => {
    const html = render(<Algo />, [[['algos'], catalog], [['algo-runs'], [run]]]);
    expect(html).toContain('Waiting for live data: No live NIFTY price');
    expect(html).toContain('1 order rejected or failed today (never counted as filled)');
    expect(html).toContain('No live bid/ask for NIFTY 27-Oct-26 24400 CE');
    expect(html).toContain('No live price for NIFTY 27-Oct-26 24400 CE');
    expect(html).toContain('incomplete');
    expect(html).toContain('Instrument master not loaded yet');
    expect(html).not.toMatch(/imulated/);
    expect(html).not.toMatch(BAD);
  });
});

/* ------------------------------------------------------------------ calculators */

describe('Calculators', () => {
  it('start empty: every result is blank until the inputs are typed (no default spot, IV or premium)', () => {
    const html = render(<Calculators />, [[['meta'], meta]]);
    expect(html).toContain('Enter every input to get a result');
    expect(html).not.toContain('value="25000"');
    expect(html).not.toMatch(BAD);
    expect(clk('x')).toEqual(['x']);
  });
});
