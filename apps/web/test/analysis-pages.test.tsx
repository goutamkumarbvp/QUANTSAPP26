import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ORDER_FLOW_METHOD,
  type BreadthResponse,
  type ExpectedRangeRow,
  type FiiDiiDay,
  type FuturesBuildUpRow,
  type MarketClockInfo,
  type MaxPainResponse,
  type MultiStrikeResponse,
  type OptionChain,
  type OrbHistoryResponse,
  type OrbResponse,
  type OrbScanRow,
  type OrderFlowResponse,
  type ParticipantDay,
  type PcrResponse,
  type ScannerDef,
  type ScannerResponse,
  type StraddleResponse,
  type StrategyChartPoint,
  type StrikeOiResponse,
  type SynopsisResponse,
  type UnusualResponse,
} from '@q26/core';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { hasChartData } from '../src/components/Chart';
import { ApiError } from '../src/lib/api';
import { useBuilder, useTicks, type BuilderLeg } from '../src/lib/store';
import ExpectedRange, { IntradayCard, VixCard } from '../src/pages/ExpectedRange';
import Breadth from '../src/pages/oi/Breadth';
import FuturesOI from '../src/pages/oi/FuturesOI';
import MaxPain from '../src/pages/oi/MaxPain';
import MultiStrike from '../src/pages/oi/MultiStrike';
import Pcr from '../src/pages/oi/Pcr';
import StrikeOI from '../src/pages/oi/StrikeOI';
import FiiDii from '../src/pages/FiiDii';
import Orb from '../src/pages/Orb';
import OrderBook from '../src/pages/OrderBook';
import { OrderTradeChart } from '../src/components/OrderTradeChart';
import Participants from '../src/pages/Participants';
import Recap from '../src/pages/Recap';
import Scanners from '../src/pages/Scanners';
import Straddle from '../src/pages/Straddle';
import StrategyChart from '../src/pages/StrategyChart';
import Synopsis from '../src/pages/Synopsis';
import Unusual from '../src/pages/Unusual';

// Every <Chart> the pages render is captured so its option can be drawn by real ECharts (SVG, server side).
const charts: { option: Parameters<typeof hasChartData>[0]; blank: unknown }[] = [];
vi.mock('../src/components/Chart', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/components/Chart')>();
  return { ...mod, Chart: (props: Parameters<typeof mod.Chart>[0]) => { charts.push({ option: props.option, blank: props.blank }); return mod.Chart(props); } };
});
echarts.use([SVGRenderer]);

/** Draws a chart option with ECharts; a bad option (an unknown series, a malformed data point) throws here, as it would in the browser. */
function draw(option: Parameters<typeof hasChartData>[0]): string {
  // Without a `document` zrender measures text with its built-in width table (no canvas needed).
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

// ECharts colours read CSS variables from the document; there is no DOM here.
beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.document = { documentElement: { classList: { contains: () => true, toggle: () => undefined } }, querySelector: () => null };
  g.getComputedStyle = () => ({ getPropertyValue: () => '10 20 30' });
  const error = console.error;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (!String(args[0]).includes('useLayoutEffect does nothing on the server')) error(...args);
  });
});

const ts = Date.UTC(2026, 9, 19, 5, 12, 5); // 19 Oct 2026 10:42:05 IST
const T0 = Date.UTC(2026, 9, 19, 3, 45); // 09:15 IST
const clock: MarketClockInfo = {
  ts,
  date: '2026-10-19',
  time: '10:42:05',
  status: 'open',
  sessionMinute: 87,
  feed: { loggedIn: true, connected: true, lastTickTs: ts, subscribed: 100, refdataReady: true, recordingSince: '2026-10-14', eod: { fo: '2026-10-16', cm: '2026-10-16', index: '2026-10-16', participants: '2026-10-16', fiidii: '2026-10-16' } },
};

type Seed = [unknown[], unknown];

function render(node: ReactElement, seeds: Seed[]): string {
  charts.length = 0;
  // retryOnMount off: the server-side render must show the cached state, not start a fetch.
  const qc = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  for (const [key, data] of seeds) {
    if (data instanceof ApiError) qc.getQueryCache().build(qc, { queryKey: key }).setState({ status: 'error', error: data, fetchStatus: 'idle', errorUpdateCount: 1, errorUpdatedAt: 1 });
    else qc.setQueryData(key, data);
  }
  const html = renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
  // The charts that are shown (not blanked) must draw.
  for (const c of charts) if (c.blank === undefined && hasChartData(c.option)) expect(draw(c.option)).toContain('<svg');
  drawn += charts.filter((c) => c.blank === undefined && hasChartData(c.option)).length;
  return html;
}
let drawn = 0;

const BAD = /NaN|undefined|Infinity|>null<|\bnull\b/;
const noLive = (reason: string) => new ApiError(reason, 503, 'NO_LIVE_DATA');
const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

// zustand 5 renders the server snapshot (the store's initial state) on the server: seed that object in place.
function seed(clockValue: MarketClockInfo | null, legs: BuilderLeg[] = []) {
  Object.assign(useTicks.getInitialState(), { clock: clockValue, quotes: {}, connected: true });
  Object.assign(useBuilder.getInitialState(), { symbol: 'NIFTY', legs });
}

beforeEach(() => seed(clock));

/** Every page: a 503 NO_LIVE_DATA is the blank state with the server's reason (not the red error box). */
function expectBlank(html: string, reason: string) {
  const out = decode(html);
  expect(out).toContain(reason);
  expect(out).toContain('role="status"');
  expect(out).not.toMatch(BAD);
  expect(out).not.toContain('border-down/40');
}

/* ------------------------------------------------------------------ OI tools */

describe('Open Interest Analysis', () => {
  const rows: StrikeOiResponse['rows'] = [
    { strike: 24000, ceOi: 1_200_000, peOi: 2_000_000, ceChange: null, peChange: null, ceVolume: null, peVolume: null },
    { strike: 24050, ceOi: null, peOi: 900_000, ceChange: null, peChange: null, ceVolume: null, peVolume: null },
    { strike: 24100, ceOi: 3_000_000, peOi: 2_500_000, ceChange: null, peChange: null, ceVolume: 100, peVolume: 90 },
  ];
  const base: StrikeOiResponse = {
    symbol: 'NIFTY', expiry: '2026-10-20', spot: 24100.5, fromTs: ts - 18 * 3_600_000, from: 'prev-close', toTs: ts, rows, maxPain: 24100, pcr: 1.05,
    coverage: '2 live strikes with OI on both sides (24000–24100) of 81 listed', gaps: { change: 'Previous-close OI missing for 2 of 2 strikes (official F&O file for 2026-10-16 not loaded)' },
  };
  const key = ['strike-oi', 'NIFTY', undefined, undefined];
  it('blank cells and reasons where the previous OI is unknown; no zeros invented', () => {
    const out = decode(render(<StrikeOI />, [[key, base]]));
    expect(out).not.toMatch(BAD);
    expect(out).toContain('Previous close');
    expect(out).toContain('2 live strikes with OI on both sides');
    expect(out).toContain('Previous-close OI missing for 2 of 2 strikes');
    expect(out).toContain('Open Interest Analysis');
  });
  it('without a spot the window is centred on max pain and says so', () => {
    const out = render(<StrikeOI />, [[key, { ...base, spot: null, maxPain: null, gaps: { spot: 'No live NIFTY price' } }]]);
    expect(out).not.toMatch(BAD);
    expect(out).toContain('spot not available');
  });
  it('503 is the blank state', () => expectBlank(render(<StrikeOI />, [[key, noLive('No open interest in the NIFTY 2026-10-20 chain')]]), 'No open interest in the NIFTY 2026-10-20 chain'));
});

describe('Multi-Strike OI', () => {
  const key = ['multi-strike', 'NIFTY', undefined, '', 5, ''];
  const times = [T0 + 5 * 60_000, T0 + 10 * 60_000, T0 + 15 * 60_000];
  const data: MultiStrikeResponse = {
    symbol: 'NIFTY', expiry: '2026-10-20', date: '2026-10-19', times, spot: [24100, null, 24120],
    series: [
      { strike: 24100, type: 'CE', oi: [100, null, 300], ltp: [50, null, null], iv: [12.5, null, null] },
      { strike: 24100, type: 'PE', oi: [null, null, null], ltp: [null, null, null], iv: [null, null, null] },
    ],
    gaps: { strikes: 'Not recorded on 2026-10-19: 24300 (only streamed strikes are recorded)' },
  };
  it('latest values per series with their own times, dashes where nothing was recorded', () => {
    const out = decode(render(<MultiStrike />, [[key, data]]));
    expect(out).not.toMatch(BAD);
    expect(out).toContain('Latest values');
    expect(out).toContain('Not recorded on 2026-10-19: 24300');
    expect(out).toContain('title="Needs two recorded OI points"');
  });
  it('503 shows the reason (recording started …)', () => expectBlank(render(<MultiStrike />, [[key, noLive('No recorded data for 2026-10-12 — recording started 2026-10-14')]]), 'recording started 2026-10-14'));
});

describe('Put-Call Ratio', () => {
  const key = ['pcr', 'NIFTY', undefined, 5, ''];
  const data: PcrResponse = {
    symbol: 'NIFTY', expiry: '2026-10-20',
    intraday: [{ ts: T0 + 5 * 60_000, pcr: 1.1, spot: 24100, ceOi: 1, peOi: 2, ceChange: 40_000, peChange: 98_000, changePcr: 2.45 }, { ts: T0 + 10 * 60_000, pcr: null, spot: null, ceOi: null, peOi: null, ceChange: null, peChange: null, changePcr: null }],
    daily: [{ date: '2026-10-15', pcr: 0.9, close: null, expiry: '2026-10-20' }, { date: '2026-10-16', pcr: 1.2, close: 24000, expiry: '2026-10-20' }],
    coverage: { intraday: 'Recorded chain totals: streamed strikes (±8 %)', daily: 'Official F&O bhavcopy: every strike of the nearest expiry' },
  };
  it('one tab for the OI trend: PCR / total OI views, and the net put − call addition (OI Trend merged here)', () => {
    const out = decode(render(<Pcr />, [[key, data]]));
    expect(out).toContain('PCR &amp; OI Trend'.replace('&amp;', '&'));
    expect(out).toMatch(/role="tab"[^>]*>PCR</);
    expect(out).toMatch(/role="tab"[^>]*>Total OI</);
    expect(out).toContain('Net put − call added');
    expect(out).toContain('58.0K'); // 98,000 − 40,000
  });
  it('daily PCR is labelled as official; a day without a close is a gap', () => {
    const out = decode(render(<Pcr />, [[key, data]]));
    expect(out).not.toMatch(BAD);
    expect(out).toContain('official F&amp;O files'.replace('&amp;', '&'));
    expect(out).toContain('Official F&O bhavcopy: every strike of the nearest expiry');
    expect(out).toContain('2 official sessions loaded');
  });
  it("change-in-OI PCR (today only): the ratio and both OI changes; blank with the reason without the previous close", () => {
    const out = decode(render(<Pcr />, [[key, data]]));
    expect(out).not.toMatch(BAD);
    expect(out).toContain('Change-in-OI PCR — today only');
    expect(out).toContain('2.45');
    expect(out).toContain('more puts written');
    const none = { ...data, intraday: data.intraday.map((p) => ({ ...p, ceChange: null, peChange: null, changePcr: null })), gaps: { 'intraday.change': 'Official F&O file for 2026-10-16 not loaded (or has no NIFTY 2026-10-20 rows): OI change vs the previous close is blank' } };
    const blank = decode(render(<Pcr />, [[key, none]]));
    expect(blank).toContain('OI change vs the previous close is blank');
    expect(blank).not.toContain('more puts written');
  });
  it('intraday blank with the recording reason while the daily part still shows', () => {
    const out = decode(render(<Pcr />, [[key, { ...data, intraday: [], gaps: { intraday: 'No recorded data for 2026-10-12 — recording started 2026-10-14' } }]]));
    expect(out).not.toMatch(BAD);
    expect(out).toContain('recording started 2026-10-14');
    expect(out).toContain('2 official sessions loaded');
  });
  it('503', () => expectBlank(render(<Pcr />, [[key, noLive('No official F&O bhavcopy with NIFTY options loaded')]]), 'No official F&O bhavcopy with NIFTY options loaded'));
});

describe('Max Pain', () => {
  const key = ['max-pain', 'NIFTY', undefined];
  const data: MaxPainResponse = {
    symbol: 'NIFTY', expiry: '2026-10-20', spot: null, maxPain: 24100,
    pain: [{ strike: 24000, callPain: 5, putPain: 7, total: 12 }, { strike: 24100, callPain: 3, putPain: 4, total: 7 }],
    history: [{ ts: T0 + 15 * 60_000, maxPain: 24100, spot: null }], coverage: '2 live strikes with OI on both sides (24000–24100)',
  };
  it('no spot: distance is blank, max pain still shown', () => {
    const out = decode(render(<MaxPain />, [[key, data]]));
    expect(out).not.toMatch(BAD);
    expect(out).toContain('Needs the live spot price');
    expect(out).toContain('2 live strikes with OI on both sides');
  });
  it('no strike with OI on both sides', () => {
    const out = decode(render(<MaxPain />, [[key, { ...data, maxPain: null, pain: [], history: [], gaps: { pain: 'No strike has open interest on both sides', history: 'No recorded NIFTY chain minutes' } }]]));
    expect(out).not.toMatch(BAD);
    expect(out).toContain('No strike has open interest on both sides');
    expect(out).toContain('No recorded NIFTY chain minutes');
  });
  it('503', () => expectBlank(render(<MaxPain />, [[key, noLive('No open interest in the NIFTY chain')]]), 'No open interest in the NIFTY chain'));
});

describe('Futures OI & Build-up', () => {
  const row = (symbol: string, over: Partial<FuturesBuildUpRow> = {}): FuturesBuildUpRow => ({ symbol, name: symbol, sector: 'Banks', kind: 'stock', expiry: '2026-10-27', ltp: 100, changePct: 1, oi: 1e6, oiChangePct: 2, volume: 5e5, buildUp: 'Long Build-up', lotSize: 500, ts, ...over });
  const data = [row('HDFCBANK'), row('SBIN', { ltp: null, changePct: null, oiChangePct: null, buildUp: null, ts: null, volume: null })];
  it('rows without a live input are dashes and the coverage counts the classified ones', () => {
    const out = decode(render(<FuturesOI />, [[['futures-oi'], data]]));
    expect(out).not.toMatch(BAD);
    expect(out).toContain('1 of 2 near-month futures have a build-up');
    expect(out).toContain('Needs a live price and OI change vs the previous session');
  });
  it('503', () => expectBlank(render(<FuturesOI />, [[['futures-oi'], noLive('No live futures quotes yet')]]), 'No live futures quotes yet'));
});

describe('Build-up Breadth', () => {
  const counts = { 'Long Build-up': 3, 'Short Build-up': 1, 'Short Covering': 2, 'Long Unwinding': 0, Neutral: 0 };
  const sym = (symbol: string): FuturesBuildUpRow => ({ symbol, name: symbol, sector: 'Banks', kind: 'stock', expiry: '2026-10-27', ltp: null, changePct: null, oi: null, oiChangePct: null, volume: null, buildUp: null, lotSize: 1, ts: null });
  it('counts only over classified stocks; a sector without any is listed apart, not drawn as zeros', () => {
    const data: BreadthResponse = {
      overall: counts, classified: 6, total: 58,
      sectors: [{ sector: 'Banks', counts, symbols: [{ ...sym('HDFCBANK'), buildUp: 'Long Build-up', changePct: 1, oiChangePct: 2 }] }, { sector: 'IT', counts: null, symbols: [sym('TCS')] }],
      history: [{ date: '2026-10-16', counts, classified: 50, source: 'eod' }, { date: '2026-10-19', counts, classified: 6, source: 'live' }],
      gaps: { overall: '52 of 58 stock futures have no live price/OI change vs the previous close yet' },
    };
    const out = decode(render(<Breadth />, [[['breadth'], data]]));
    expect(out).not.toMatch(BAD);
    expect(out).toContain('Live build-up for 6 of 58 F&O stocks');
    expect(out).toContain('52 of 58 stock futures have no live price');
    expect(out).toContain('No live build-up yet in: IT');
    expect(out).toContain('of classified stocks');
  });
  it('nothing classified: dashes with the reason, history empty with its reason', () => {
    const data: BreadthResponse = { overall: null, classified: 0, total: 58, sectors: [], history: [], gaps: { overall: 'No stock future has a live price yet', history: 'No two consecutive sessions of official F&O and CM files loaded' } };
    const out = decode(render(<Breadth />, [[['breadth'], data]]));
    expect(out).not.toMatch(BAD);
    expect(out).toContain('No two consecutive sessions of official F&O and CM files loaded');
    expect(out).not.toMatch(/>0<\/div>/);
  });
  it('503', () => expectBlank(render(<Breadth />, [[['breadth'], noLive('No live stock futures and no official F&O history loaded')]]), 'No live stock futures and no official F&O history loaded'));
});

/* ------------------------------------------------------------------ strategy tools */

describe('Straddle Chart', () => {
  const key = ['straddle', 'NIFTY', undefined, 'rolling', 'atm', 0, 1, ''];
  const pt = (m: number, over: Partial<StraddleResponse['points'][number]> = {}) => ({ ts: T0 + m * 60_000, spot: 24100, strike: 24100, ceStrike: 24100, peStrike: 24100, ce: 50, pe: 40, straddle: 90, iv: 13, ...over });
  const data: StraddleResponse = {
    symbol: 'NIFTY', expiry: '2026-10-20', date: '2026-10-19', source: 'recorded',
    points: [pt(1), pt(2, { ce: null, straddle: null, iv: null }), pt(5, { spot: null, iv: null })], gaps: { points: 'Windows where a leg did not trade are blank' },
  };
  it('a window where a leg did not trade is blank; implied move needs the recorded spot', () => {
    const out = decode(render(<Straddle />, [[key, data]]));
    expect(out).not.toMatch(BAD);
    expect(out).toContain('source: recorded 1-minute data');
    expect(out).toContain('Windows where a leg did not trade are blank');
    expect(out).toContain('Needs the recorded spot of that window');
  });
  it('503 (expired / unrecorded contract)', () => expectBlank(render(<Straddle />, [[key, noLive('No recorded or listed NIFTY 2026-10-20 options for 2026-10-12 (recording started 2026-10-14)')]]), 'recording started 2026-10-14'));
});

describe('Strategy Chart', () => {
  const legs = [{ id: 'a', side: 'SELL' as const, type: 'CE' as const, strike: 24100, expiry: '2026-10-20', lots: 1, lotSize: 75, price: 50, active: true }];
  const body = { symbol: 'NIFTY', legs: [{ side: 'SELL', type: 'CE', strike: 24100, expiry: '2026-10-20', lots: 1, price: 50 }], interval: 5 };
  const key = ['strategy-chart', JSON.stringify(body)];
  const pt = (m: number, over: Partial<StrategyChartPoint> = {}): StrategyChartPoint => ({ ts: T0 + m * 60_000, spot: 24100, premium: -50, pnl: 100, delta: -0.5, theta: 1, vega: 2, gamma: 0.01, ...over });
  it('blank values where a leg did not trade or an IV could not be solved', () => {
    seed(clock, legs);
    const out = decode(render(<StrategyChart />, [[key, [pt(5), pt(10, { premium: null, pnl: null, delta: null, theta: null, vega: null })]]]));
    expect(out).not.toMatch(BAD);
    expect(out).toContain('a window where a leg did not trade has no premium');
  });
  it('lot size unknown → 503 reason', () => {
    seed(clock, legs);
    expectBlank(render(<StrategyChart />, [[key, noLive('Lot size of NIFTY 20 Oct 24100 CE is unknown (not listed and no official file of its last day)')]]), 'Lot size of NIFTY 20 Oct 24100 CE is unknown');
  });
  it('no legs: points to the builder', () => expect(render(<StrategyChart />, [])).toContain('No open legs in the strategy builder'));
});

describe('Trade Recap', () => {
  const chain = (over: Partial<OptionChain> = {}): OptionChain => {
    const q = (ltp: number | null) => ({ ltp, change: null, changePct: null, prevClose: null, oi: null, prevOi: null, oiChange: null, oiChangePct: null, volume: null, iv: null, delta: null, gamma: null, theta: null, vega: null, bid: null, ask: null, bidQty: null, askQty: null, buildUp: null, intrinsic: null, timeValue: null, ivSource: null, ivTs: null, ts: null });
    return {
      symbol: 'NIFTY', expiry: '2026-10-20', expiries: ['2026-10-20'], ts, valuationTs: ts, spot: 24100, spotChange: null, spotChangePct: null, spotTs: ts, future: null, futureExpiry: null, forward: null, forwardSource: null, carry: null,
      lotSize: 75, strikeStep: 50, daysToExpiry: 1, atm: 24100, atmIv: null, ivChange: null, pcr: null, pcrVolume: null, maxPain: null, totalCeOi: null, totalPeOi: null, totalCeOiChange: null, totalPeOiChange: null, support: null, resistance: null,
      coverage: 'no strike with OI on both sides', rows: [{ strike: 24050, ce: q(120), pe: q(null) }, { strike: 24100, ce: q(null), pe: q(70) }], gaps: { atmIv: 'ATM IV could not be solved from the available premiums' }, ...over,
    };
  };
  const at = Date.UTC(2026, 9, 16, 4, 0); // 16 Oct 09:30 IST: the previous trading day of the 19th at 09:30
  it('a contract that had not traded at that moment has a dash and a disabled B/S; nothing is priced at 0', () => {
    const out = decode(render(<Recap />, [[['chain', 'NIFTY', '', at], chain()]]));
    expect(out).not.toMatch(BAD);
    expect(out).toContain('This put had not traded at that moment');
    expect(out).toContain('disabled=""');
    expect(out).toContain('ATM IV could not be solved from the available premiums');
    expect(out).toContain('Recorded sessions only');
  });
  it('a date before the first recorded session is blank with the first recorded session', () => {
    seed({ ...clock, feed: { ...clock.feed!, recordingSince: '2026-10-19' } });
    const out = decode(render(<Recap />, []));
    expect(out).toContain('The first recorded session is 19 Oct 2026');
    expect(out).toContain('role="status"');
    expect(out).not.toMatch(BAD);
  });
  it('nothing recorded yet', () => {
    seed({ ...clock, feed: { ...clock.feed!, recordingSince: null } });
    const out = decode(render(<Recap />, []));
    expect(out).toContain('no session has been recorded yet');
  });
  it('as-of 503 shows the server reason', () => expectBlank(render(<Recap />, [[['chain', 'NIFTY', '', at], noLive('Nothing recorded for NIFTY at 09:30 on 2026-10-16 (last recorded minute 09:12): the recorder was not running')]]), 'the recorder was not running'));
});

/* ------------------------------------------------------------------ market-wide tools */

describe('Synopsis', () => {
  const row = (symbol: string, over: Partial<SynopsisResponse['rows'][number]> = {}): SynopsisResponse['rows'][number] => ({ symbol, name: symbol, sector: 'IT', ltp: 4100, changePct: 1.2, oiChangePct: null, ivChange: null, iv: 25, turnover: 5e8, buildUp: null, pcr: null, ...over });
  it('stocks without a turnover or the chosen change stay off the map and are counted', () => {
    const data: SynopsisResponse = { rows: [row('TCS'), row('INFY', { turnover: null }), row('WIPRO', { changePct: null })], coverage: '3 of 58 F&O stocks have a live price', gaps: { turnover: '1 stocks have no session volume or average traded price from the feed' } };
    const out = decode(render(<Synopsis />, [[['synopsis'], data]]));
    expect(out).not.toMatch(BAD);
    expect(out).toContain('3 of 58 F&O stocks have a live price');
    expect(out).toContain('2 of 3 stocks are not on the map');
    expect(out).toContain('1 stocks have no session volume');
  });
  it('503', () => expectBlank(render(<Synopsis />, [[['synopsis'], noLive('No live stock price yet')]]), 'No live stock price yet'));
});

describe('F&O Scanners', () => {
  const defs: ScannerDef[] = [{ id: 'long-buildup', name: 'Long build-up', category: 'Build-up', description: 'Price up, OI up' }];
  const data: ScannerResponse = {
    id: 'long-buildup', coverage: '58 of 64 near-month futures with live OI vs the previous session',
    rows: [
      { symbol: 'TCS', instrument: 'TCS 27 Oct FUT', type: 'FUT', ltp: 4100, changePct: 1, oi: 1e6, oiChangePct: 3, volume: 5e5, buildUp: 'Long Build-up', metric: 3, metricLabel: 'OI chg %' },
      { symbol: 'INFY', instrument: 'INFY', type: 'EQ', ltp: 1500, changePct: null, oi: null, oiChangePct: null, volume: 9e5, metric: 2, metricLabel: 'OI chg %' },
    ],
    gaps: { turnover: '3 traded contracts have no average traded price from the feed: left out' },
  };
  it('coverage and gaps are shown; null OI and IV are dashes', () => {
    const out = decode(render(<Scanners />, [[['scanner-defs'], defs], [['scanner', 'long-buildup'], data]]));
    expect(out).not.toMatch(BAD);
    expect(out).toContain('58 of 64 near-month futures with live OI vs the previous session');
    expect(out).toContain('have no average traded price');
    expect(out).toContain('A stock has no open interest');
  });
  it('503', () => expectBlank(render(<Scanners />, [[['scanner-defs'], defs], [['scanner', 'long-buildup'], noLive("No near-month future has the previous session's OI yet")]]), "No near-month future has the previous session's OI yet"));
});

describe('Unusual Option Activity', () => {
  const data: UnusualResponse = {
    coverage: '120 of 400 contracts traded with live OI', gaps: { premiumTurnover: '1 of 1 contracts have no average traded price from the feed: turnover blank and not weighted' },
    rows: [{ symbol: 'NIFTY', type: 'CE', strike: 24100, expiry: '2026-10-20', ltp: 50, changePct: null, oi: 1e6, oiChange: 1e5, oiChangePct: 10, volume: 1e6, volumeOiRatio: 1, iv: null, ivChange: null, premiumTurnover: null, score: 3.1, signal: 'Call writing — bearish', buildUp: null }],
  };
  it('turnover and IV change are blank with the reason when the inputs are missing', () => {
    const out = decode(render(<Unusual />, [[['unusual', ''], data]]));
    expect(out).not.toMatch(BAD);
    expect(out).toContain('turnover blank and not weighted');
    expect(out).toContain('120 of 400 contracts traded with live OI');
  });
  it('503', () => expectBlank(render(<Unusual />, [[['unusual', ''], noLive("Needs a live trade, live OI and the previous session's OI")]]), "Needs a live trade, live OI and the previous session's OI"));
});

/* ------------------------------------------------------------------ order flow / ORB */

// Order Flow was merged into the Order Flow & Book page: the same checks, on that page.
describe('Order Flow & Book (order flow)', () => {
  const key = ['order-trade', 'NIFTY', 'FUT', undefined, undefined];
  const sum = (over: Partial<OrderFlowResponse['session']> = {}): OrderFlowResponse['session'] => ({ buyVolume: 600, sellVolume: 200, unclassified: 200, volume: 1000, gapVolume: 0, partialMinutes: 0, delta: 400, buyPct: 75, unclassifiedPct: 20, sentiment: 'Buyers dominant', ...over });
  const data: OrderFlowResponse = {
    symbol: 'NIFTY', instrument: 'NIFTY 27 Oct FUT', type: 'FUT', expiry: '2026-10-27', date: '2026-10-19', live: true, lotSize: null, method: ORDER_FLOW_METHOD,
    lastMinute: { ...sum({ buyVolume: 0, sellVolume: 0, unclassified: 0, volume: 0, gapVolume: 1500, partialMinutes: 1, delta: 0, buyPct: null, unclassifiedPct: null, sentiment: 'Feed gap' }), ts: T0, close: null },
    currentMinute: null, last5: sum({ gapVolume: 1500 }), session: sum({ partialMinutes: 2 }),
    minutes: [
      { ts: T0, volume: 0, buyVolume: 0, sellVolume: 0, unclassified: 0, gapVolume: 1500, partial: true, delta: 0, cumDelta: 0, buyPct: null, open: null, high: null, low: null, close: null },
      { ts: T0 + 60_000, volume: 300, buyVolume: 100, sellVolume: 100, unclassified: 100, gapVolume: null, partial: false, delta: 0, cumDelta: 0, buyPct: 50, open: 24100, high: 24100, low: 24100, close: 24100 },
    ],
    signal: '09:15–09:16: the feed had a gap before this minute', coverage: '2 recorded minutes 09:15–09:17', expiries: ['2026-10-27'], strikes: [],
    gaps: { feedGaps: '1 minute (09:15) follow a feed gap: 1.50K traded during the gaps', partial: 'Recording of NIFTY 27 Oct FUT started inside 09:15' },
  };
  it('labelled as an estimate; unclassified share shown; a feed gap is never a buy/sell split; unknown lot size is stated', () => {
    const out = decode(render(<OrderBook />, [[key, data]]));
    expect(out).not.toMatch(BAD);
    expect(out).toContain(ORDER_FLOW_METHOD);
    expect(out).toContain('Unclassified');
    expect(out).toContain('Feed gap');
    expect(out).toContain('partial (lower bound)');
    expect(out).toContain('Lot size of this contract is not known');
    expect(out).toContain('Nothing in this minute could be classified as buy or sell');
    expect(out).not.toContain('Simulated');
  });
  type OtOption = { yAxis: unknown[]; xAxis: { max: number }[]; series: { name: string; type: string; yAxisIndex: number; xAxisIndex: number }[] };
  it('Order & Trade chart, Line (Quantsapp) layout by default: price as a thin line over volume, buyer and seller initiated on ONE axis below; the x axis runs to the last minute', () => {
    render(<OrderBook />, [[key, data]]);
    const ot = charts.find((c) => JSON.stringify(c.option).includes('Buyer initiated'))!.option as OtOption;
    const axisOf = (name: string) => ot.series.find((x) => x.name === name)!.yAxisIndex;
    expect(ot.series.find((x) => x.name === 'Price')!.type).toBe('line');
    expect(axisOf('Buyer initiated')).toBe(axisOf('Seller initiated'));
    expect(ot.series.some((x) => x.name === 'Cumulative delta')).toBe(false);
    expect(ot.xAxis[0].max).toBeGreaterThanOrEqual(data.minutes.at(-1)!.ts);
  });
  it('Order & Trade chart, Candles + delta layout: candles, and the cumulative delta on its own pane', () => {
    render(<OrderTradeChart d={data} initialStyle="detailed" />, []);
    const ot = charts.find((c) => JSON.stringify(c.option).includes('Cumulative delta'))!.option as OtOption;
    const axisOf = (name: string) => ot.series.find((x) => x.name === name)!.yAxisIndex;
    expect(ot.series.find((x) => x.name === 'Price')!.type).toBe('candlestick');
    expect(axisOf('Buyer initiated')).toBe(axisOf('Seller initiated'));
    expect(axisOf('Cumulative delta')).not.toBe(axisOf('Buyer initiated'));
  });
  it('a window with no trades is "No trades", not a 50/50 bar', () => {
    const none = sum({ volume: 0, buyVolume: 0, sellVolume: 0, unclassified: 0, delta: 0, buyPct: null, unclassifiedPct: null, sentiment: 'No trades' });
    const out = decode(render(<OrderBook />, [[key, { ...data, lotSize: 75, minutes: [], lastMinute: { ...none, ts: T0, close: null }, last5: none, session: none }]]));
    expect(out).toContain('aria-label="No trades"');
    expect(out).not.toContain('Buyers ');
  });
  it('503: contract not recorded', () => expectBlank(render(<OrderBook />, [[key, noLive('NIFTY 27 Oct FUT has no recorded minutes yet this session')]]), 'has no recorded minutes yet this session'));
});

describe('Opening Range Breakout', () => {
  const bar = (m: number, o: number) => ({ ts: T0 + m * 60_000, open: o, high: o + 5, low: o - 5, close: o + 1 });
  const orb = (over: Partial<OrbResponse> = {}): OrbResponse => ({
    symbol: 'NIFTY', date: '2026-10-19', rangeMinutes: 15, rule: 'close', rangeStartTs: T0, rangeEndTs: T0 + 15 * 60_000, live: false, ltp: null, changePct: null, dayHigh: null, dayLow: null, priceSource: 'close', priceTs: T0 + 4 * 60_000,
    evaluation: {
      rangeMinutes: 15, rule: 'close', complete: true, high: 24105, low: 24095, width: 10, widthPct: 0.04, breaks: [], crossings: [], firstUp: null, firstDown: null, trend: 'sideways', whipsaw: false, position: 'inside', reentered: false, pending: null, last: 24101, toHighPct: 0.01, toLowPct: -0.02,
    },
    summary: 'Sideways', bars: [bar(0, 24100), bar(1, 24101), bar(4, 24100)], source: 'recorded', gaps: { day: 'Recording of NIFTY on 2026-10-19 ends at 11:00: the session’s last price and day high/low are not known' }, ...over,
  });
  const scan: OrbScanRow[] = [{ symbol: 'TCS', name: 'TCS', kind: 'stock', sector: 'IT', ltp: 4100, changePct: null, high: 4110, low: 4090, widthPct: 0.5, trend: 'forming', whipsaw: false, reentered: false, position: 'inside', pending: null, breakTs: null, breakPrice: null, beyondPct: null, toHighPct: 0.2, toLowPct: -0.3, summary: 'forming' }];
  const hist: OrbHistoryResponse = {
    symbol: 'NIFTY', rangeMinutes: 15, rule: 'close', sessions: 20, rows: [], stats: { days: 0, brokeUp: 0, brokeDown: 0, sideways: 0, whipsaw: 0, trendDays: 0, avgFollowThroughPct: null }, gaps: { sessions: '20 of 20 sessions have no recorded or Kotak 1-minute bars covering the whole day' },
  };
  const keys = (r: unknown, s: unknown, h: unknown): Seed[] => [[['orb', 'NIFTY', '', 15, 'close'], r], [['orb-scan', 15, 'close'], s], [['orb-hist', 'NIFTY', 15, 'close'], h]];
  it('a completed session whose bars stop early has no close / day high-low; untraded minutes are empty slots', () => {
    const out = decode(render(<Orb />, keys(orb(), scan, hist)));
    expect(out).not.toMatch(BAD);
    expect(out).toContain('Range complete · 3 of 15 minutes traded');
    expect(out).toContain('ends at 11:00');
    expect(out).toContain('an empty slot, not a candle');
    expect(out).toContain('Avg follow-through —');
    // Price vs range names the price it is taken at (no live LTP here).
    expect(out).toMatch(/24,101 \(last recorded 1-min close at \d\d:\d\d\)/);
  });
  it('a live session takes price vs range and % from price at the LTP shown', () => {
    const live = orb({ live: true, ltp: 24120, priceSource: 'ltp', priceTs: T0 + 5 * 60_000, gaps: undefined, evaluation: { ...orb().evaluation, position: 'above', last: 24120, toHighPct: -0.06, toLowPct: -0.1 } });
    const out = decode(render(<Orb />, keys(live, scan, hist)));
    expect(out).not.toMatch(BAD);
    expect(out).toContain('24,120 (LTP)');
    expect(out).toContain('from LTP');
    expect(out).not.toContain('last recorded 1-min close');
  });
  it('a forming range shows no position or break, from the bars that exist', () => {
    const forming = orb({ live: true, evaluation: { ...orb().evaluation, complete: false, trend: 'forming', position: 'inside', toHighPct: Number.NaN, toLowPct: Number.NaN, widthPct: Number.NaN }, gaps: undefined, ltp: 24101 });
    const out = decode(render(<Orb />, keys(forming, scan, hist)));
    expect(out).not.toMatch(BAD);
    expect(out).toContain('Range forming · 3 of 15 minutes so far');
    expect(out).toContain('The opening range is still forming');
  });
  it('503: recording started after the open', () => {
    const out = decode(render(<Orb />, keys(noLive('Recording of NIFTY on 2026-10-19 starts at 10:02: the opening range from 09:15 was not recorded'), noLive('No underlying has recorded 1-minute bars'), noLive('No NIFTY session of the last 20 has recorded bars'))));
    expect(out).toContain('the opening range from 09:15 was not recorded');
    expect(out).toContain('No underlying has recorded 1-minute bars');
    expect(out).not.toMatch(BAD);
  });
});

/* ------------------------------------------------------------------ official flows */

describe('FII / DII Activity', () => {
  const day = (date: string, scope: FiiDiiDay['scope'], f: number): FiiDiiDay => ({ date, fiiBuy: 9000, fiiSell: 9000 - f, fiiNet: f, diiBuy: 8000, diiSell: 7000, diiNet: 1000, niftyClose: 24000, niftyChangePct: 0.3, scope });
  it('official days with their scope; days of another scope are not summed', () => {
    const out = decode(render(<FiiDii />, [[['fii-dii', 30], [day('2026-10-14', 'nse', -300), day('2026-10-15', 'combined', 500), day('2026-10-16', 'combined', 700)]]]));
    expect(out).not.toMatch(BAD);
    expect(out).toContain('NSE + BSE + MSEI');
    expect(out).toContain('NSE only');
    expect(out).toContain('1 day of another scope');
    expect(out).toContain('latest official day is 16 Oct 2026');
    expect(out).toContain('later days are not published or not loaded yet');
    expect(out).toContain('FII net (2 days)');
  });
  it('503: nothing published / loaded', () => expectBlank(render(<FiiDii />, [[['fii-dii', 30], noLive('FII/DII figures are not loaded for 2026-09-01..2026-10-19 (none loaded yet)')]]), 'FII/DII figures are not loaded'));
});

describe('Participant-wise OI', () => {
  const row = (participant: 'FII' | 'DII' | 'Pro' | 'Client', n: number) => ({ participant, futIndexLong: n, futIndexShort: n / 2, futStockLong: 1, futStockShort: 1, optIndexCallLong: 1, optIndexCallShort: 1, optIndexPutLong: 1, optIndexPutShort: 1, optStockCallLong: 1, optStockCallShort: 1, optStockPutLong: 1, optStockPutShort: 1 });
  const days: ParticipantDay[] = [
    { date: '2026-10-15', niftyClose: 24000, rows: [row('FII', 100), row('Pro', 50), row('Client', 40), row('DII', 10)] },
    { date: '2026-10-16', niftyClose: 24100, rows: [row('FII', 120), row('Pro', 50), row('Client', 40)] },
  ];
  it('shows the source date; a participant missing in the file is a dash, not zero or a made-up change', () => {
    const out = decode(render(<Participants />, [[['participants', 30], days]]));
    expect(out).not.toMatch(BAD);
    expect(out).toContain('official file of 16 Oct 2026');
    expect(out).toContain('has no complete DII row');
    expect(out).toContain('Net chg vs 15 Oct');
  });
  it('503', () => expectBlank(render(<Participants />, [[['participants', 30], noLive('NSE participant-wise OI is not loaded for 2026-09-01..2026-10-19 (none loaded yet)')]]), 'participant-wise OI is not loaded'));
});

describe('Expected Range', () => {
  const row = (over: Partial<ExpectedRangeRow> = {}): ExpectedRangeRow => ({
    symbol: 'NIFTY',
    name: 'Nifty 50',
    kind: 'index',
    exchange: 'NSE',
    date: '2026-10-12',
    anchorDate: '2026-10-09',
    anchor: 24900,
    ltp: 25000,
    high: 25050,
    low: 24920,
    iv: 14,
    ivSource: 'live',
    expiry: '2026-10-13',
    days: 3,
    sigma: 316.04,
    sigmaPct: 1.27,
    band1: { low: 24583.96, high: 25216.04 },
    band2: { low: 24267.92, high: 25532.08 },
    intraday: {
      price: 25000,
      dayMove: 183.2,
      minutesLeft: 270,
      horizons: [
        { minutes: 15, label: '15 min', sigma: 36.64, low: 24963.36, high: 25036.64 },
        { minutes: 60, label: '1 hour', sigma: 73.28, low: 24926.72, high: 25073.28 },
        { minutes: 270, label: 'Rest of day', sigma: 155.45, low: 24844.55, high: 25155.45 },
      ],
      check: { horizon: 60, windows: 210, sessions: 19, inside: 71.43 },
    },
    vix: {
      vix: 12.5,
      price: 25057.3,
      priceOf: 'future',
      future: '2026-10-27',
      bands: [
        { label: 'Today', days: 1, move: 163.95, pct: 0.65, low: 24893.35, high: 25221.25 },
        { label: 'This week', days: 7, move: 433.77, pct: 1.73, low: 24623.53, high: 25491.07 },
        { label: 'This month', days: 30, move: 898.0, pct: 3.58, low: 24159.3, high: 25955.3 },
      ],
      check: { sessions: 60, closeIn: 61.67 },
    },
    position: 'inside',
    rangeUsedPct: 20.57,
    straddle: { expiry: '2026-10-13', strike: 25000, ce: 141.2, pe: 133.9, premium: 275.1, movePct: 1.1, low: 24724.9, high: 25275.1, days: 1.2, move: 275.1, band: { low: 24624.9, high: 25175.1 } },
    history: { sessions: 60, closeIn1: 70, closeIn2: 96.67, rangeIn1: 45, straddleSessions: 58, straddleCloseIn: 62.07, avgRange: 260.5, from: '2026-07-14', to: '2026-10-09' },
    ...over,
  });
  it('cards with ±1σ / ±2σ, the live position and the back-check', () => {
    const gold = row({ symbol: 'GOLD', name: 'Gold', kind: 'commodity', exchange: 'MCX', anchor: null, sigma: null, sigmaPct: null, band1: null, band2: null, intraday: { price: null, dayMove: null, minutesLeft: null, horizons: [], check: { horizon: 60, windows: 0, sessions: 0, inside: null } }, vix: null, position: null, rangeUsedPct: null, iv: null, ivSource: null, straddle: null, history: { sessions: 0, closeIn1: null, closeIn2: null, rangeIn1: null, straddleSessions: 0, straddleCloseIn: null, avgRange: null, from: null, to: null }, gaps: { anchor: 'No 2026-10-09 close of GOLD', iv: 'No listed GOLD option expiry', straddle: 'No listed GOLD option expiry', history: 'No past MCX sessions of GOLD with a recorded ATM IV' } });
    const out = decode(render(<ExpectedRange />, [[['expected-range'], [row(), gold]]]));
    expect(out).toContain('Expected Range');
    expect(out).toContain('±316.04');
    expect(out).toContain('24,583.96 – 25,216.04');
    expect(out).toContain('24,267.92 – 25,532.08');
    expect(out).toContain('Inside ±1σ');
    expect(out).toContain('Close stayed within ±1σ on 70% and within ±2σ on 97% of the last 60 sessions');
    expect(out).toContain('No past MCX sessions of GOLD with a recorded ATM IV');
    expect(out).toContain('±275.10');
    expect(out).toContain('24,724.90 – 25,275.10');
    expect(out).toContain('inside the straddle move on 62% of 58');
    expect(out).toContain('15 min ±36.64 · 1 hour ±73.28 · rest of day ±155.45');
    expect(out).toContain('24,893.35 – 25,221.25');
  });
  it('detail: intraday forecast, the India VIX method and an unlisted symbol kept with its reason', () => {
    const sensex = row({ symbol: 'SENSEX', exchange: 'BSE', anchor: null, sigma: null, band1: null, band2: null, straddle: null, vix: null, intraday: { price: null, dayMove: null, minutesLeft: null, horizons: [], check: { horizon: 60, windows: 0, sessions: 0, inside: null } }, gaps: { listed: 'SENSEX is not in the instrument master: the Kotak BSE F&O file (bse_fo) did not load' } });
    const all = decode(render(<ExpectedRange />, [[['expected-range'], [row(), sensex]]]));
    expect(all).toContain('SENSEX is not in the instrument master: the Kotak BSE F&O file (bse_fo) did not load');
    expect(all).toContain('BSE');
    const intra = decode(render(<IntradayCard r={row()} />, []));
    expect(intra).toContain('Next 15 min');
    expect(intra).toContain('Rest of day (270 min)');
    expect(intra).toContain('24,844.55 – 25,155.45');
    expect(intra).toContain('a 60-minute move stayed within ±1 SD in 71% of 210 windows over 19 recorded sessions');
    const vix = decode(render(<VixCard r={row()} />, []));
    expect(vix).toContain('India VIX 12.50');
    expect(vix).toContain('±433.77');
    expect(vix).toContain('24,159.30 – 25,955.30');
    expect(vix).toContain('on 62% of 60 sessions');
    expect(decode(render(<IntradayCard r={row({ intraday: { ...row().intraday, horizons: [] }, gaps: { intraday: 'The intraday forecast is shown while the session is open' } })} />, []))).toContain('The intraday forecast is shown while the session is open');
  });
  it('503', () => expectBlank(render(<ExpectedRange />, [[['expected-range'], noLive('Instrument master not loaded yet')]]), 'Instrument master not loaded yet'));
});

describe('every chart that is shown is a valid ECharts option', () => {
  it('drew charts across the suite', () => {
    // The tests above render ~25 pages with data; each non-blank chart was drawn by ECharts (SVG).
    expect(drawn).toBeGreaterThan(20);
  });
});
