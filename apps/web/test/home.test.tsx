import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ORDER_FLOW_METHOD, type DashboardChain, type DashboardResponse, type Quote } from '@q26/core';
import Home from '../src/pages/Home';
import { ApiError } from '../src/lib/api';

// ECharts colours read CSS variables from the document; there is no DOM here.
beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.document = { documentElement: { classList: { contains: () => true, toggle: () => undefined } }, querySelector: () => null };
  g.getComputedStyle = () => ({ getPropertyValue: () => '10 20 30' });
  // react-router's MemoryRouter warns that useLayoutEffect does nothing in a server render.
  const error = console.error;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (!String(args[0]).includes('useLayoutEffect does nothing on the server')) error(...args);
  });
});

const ts = Date.UTC(2026, 9, 19, 5, 12, 5);
const quote = (symbol: string, over: Partial<Quote> = {}): Quote => ({
  symbol, ltp: 24100.5, change: 120.25, changePct: 0.5, open: 24000, high: 24150, low: 23980, prevClose: 23980.25, future: 24130, futureExpiry: '2026-10-27', futureChange: 110, atmIv: 13.4, ts, ...over,
});
const blankChain = (symbol: string, gaps: Record<string, string>): DashboardChain => ({
  symbol, expiry: null, spot: null, pcr: null, maxPain: null, atmIv: null, ivChange: null, support: null, resistance: null, daysToExpiry: null, coverage: null, orb: null, flow: null, gaps,
});

const populated: DashboardResponse = {
  clock: { ts, date: '2026-10-19', time: '10:42:05', status: 'open', sessionMinute: 87 },
  indices: [quote('NIFTY'), quote('BANKNIFTY', { change: null, changePct: null, atmIv: null, future: null, high: null })],
  gainers: [{ symbol: 'TCS', ltp: 4100, changePct: 2.1, oiChangePct: 4.2, buildUp: 'Long Build-up' }],
  losers: [{ symbol: 'INFY', ltp: null, changePct: -1.4, oiChangePct: null, buildUp: null }],
  oiGainers: [],
  buildUpCounts: { 'Long Build-up': 10, 'Short Build-up': 0, 'Short Covering': 3, 'Long Unwinding': 2, Neutral: 1 },
  buildUpClassified: 16,
  buildUpTotal: 58,
  chains: [
    {
      symbol: 'NIFTY', expiry: '2026-10-20', spot: 24100.5, pcr: 1.12, maxPain: 24100, atmIv: 13.4, ivChange: null, support: 24000, resistance: 24300, daysToExpiry: 0.9,
      coverage: 'PCR over strikes with OI on both sides (±8 %)',
      orb: { date: '2026-10-16', live: false, note: "Previous session (2026-10-16): today's session opens at 09:15", high: 24200, low: 24100, trend: 'up', whipsaw: false, reentered: false, summary: 'Trending up' },
      flow: { buyPct: null, unclassifiedPct: 100, delta: 0, sentiment: 'Feed gap', method: ORDER_FLOW_METHOD, ts, gapVolume: 1500, partial: true, note: '10:41: a feed gap ended in this minute' },
    },
    blankChain('BANKNIFTY', { chain: 'No BANKNIFTY option expiry is listed', orb: 'Recording started after 09:17', flow: 'No completed recorded minute' }),
    blankChain('SENSEX', { chain: 'Instrument master not loaded yet' }),
  ],
  fiiDii: [
    { date: '2026-10-15', fiiBuy: 9000, fiiSell: 9500, fiiNet: -500, diiBuy: 8000, diiSell: 7000, diiNet: 1000, niftyClose: 24000, niftyChangePct: 0.2, scope: 'nse' },
  ],
  gaps: { movers: 'No stock has a live-session price and a previous close yet', oiGainers: "No stock future has live OI and the previous session's OI yet" },
};

const blank: DashboardResponse = {
  clock: populated.clock, indices: [], gainers: [], losers: [], oiGainers: [], buildUpCounts: null, buildUpClassified: 0, buildUpTotal: 0,
  chains: ['NIFTY', 'BANKNIFTY', 'SENSEX'].map((s) => blankChain(s, { chain: 'Instrument master not loaded yet' })), fiiDii: [],
  gaps: {
    indices: 'Instrument master not loaded yet', movers: 'Instrument master not loaded yet', oiGainers: 'Instrument master not loaded yet',
    buildUpCounts: 'Instrument master not loaded yet', fiiDii: 'No official FII/DII day is loaded yet',
  },
};

function render(data: DashboardResponse | ApiError): string {
  // retryOnMount off: the server-side render must show the cached error state, not start a fetch.
  const qc = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  if (data instanceof ApiError) qc.getQueryCache().build(qc, { queryKey: ['dashboard'] }).setState({ status: 'error', error: data, fetchStatus: 'idle', errorUpdateCount: 1, errorUpdatedAt: 1 });
  else qc.setQueryData(['dashboard'], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const BAD = /NaN|undefined|Infinity|>null<|\bnull\b/;

describe('Home dashboard, card by card', () => {
  it('fills the cards that have data and blanks the others with their own reasons', () => {
    const html = render(populated);
    expect(html).not.toMatch(BAD);
    expect(html).toContain('Market Overview');
    // index cards: BANKNIFTY has no change / IV / future: dashes, not zeros
    expect(html).toContain('24,100.50');
    // chains: NIFTY filled; the ORB is the previous session's and says so
    expect(html).toContain('previous session');
    expect(html).toContain('PCR over strikes with OI on both sides');
    expect(html).toContain('1.12');
    // BANKNIFTY / SENSEX rows are blank, each with its reason shown (not only as a tooltip)
    expect(html).toContain('No BANKNIFTY option expiry is listed');
    expect(html).toContain('Recording started after 09:17');
    expect(html).toContain('Instrument master not loaded yet');
    // flow: a feed gap is labelled, never shown as a buy share; partial minutes are a lower bound
    expect(html).toContain('feed gap');
    expect(html).toContain('partial (lower bound)');
    expect(html).toContain(ORDER_FLOW_METHOD);
    // build-up counts with their coverage
    expect(html).toContain('16 of 58 stock futures');
    // movers: gainers filled, losers has an unknown LTP, OI gainers blank with the gap reason
    expect(html).toContain('TCS');
    expect(html).toContain("No stock future has live OI and the previous session&#x27;s OI yet");
    // FII/DII: official figures with their scope
    expect(html).toContain('NSE only');
  });

  it('every card is blank with its reason when nothing is available (no zeros, no empty axes)', () => {
    const html = render(blank);
    expect(html).not.toMatch(BAD);
    expect(html).toContain('No live index prices');
    expect(html).toContain('No official FII / DII data');
    expect(html).toContain('No official FII/DII day is loaded yet');
    expect(html).toContain('Instrument master not loaded yet');
    expect(html).not.toContain('Fut ');
    expect(html).not.toMatch(/>0<\/span>/);
  });

  it('a 503 NO_LIVE_DATA for the whole page renders the blank state with the server reason', () => {
    const html = render(new ApiError('Kotak feed is not connected', 503, 'NO_LIVE_DATA'));
    expect(html).toContain('Kotak feed is not connected');
    expect(html).toContain('role="status"');
    expect(html).not.toContain('text-down');
  });
});
