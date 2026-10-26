import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { biasOf, type Top10Response, type Top10Row } from '@q26/core';
import { ApiError } from '../src/lib/api';
import Top10 from '../src/pages/Top10';

// Test data (not market data).
const row = (rank: number, symbol: string, over: Partial<Top10Row> = {}): Top10Row => ({
  rank,
  symbol,
  name: symbol,
  sector: 'Banks',
  lotSize: 550,
  spot: { ltp: 1650, changePct: -1.2, ts: 1 },
  future: { expiry: '2026-10-27', ltp: 1656.6, changePct: -1.1, basis: 6.6, basisPct: 0.4, oi: 950_000, oiChangePct: -5, buildUp: 'Long Unwinding' },
  options: { expiry: '2026-10-27', daysToExpiry: 15.2, atm: 1660, atmIv: 18, ivChange: 0.03, pcr: 0.95, changePcr: 0.7, maxPain: 1650, support: 1600, resistance: 1700, straddle: 48.5, straddlePct: 2.94 },
  flow: { window: 15, buyPct: 35, read: 'selling-absorbed', sessionDelta: -25_655, spikes: 0 },
  orbTrend: 'up',
  bias: biasOf({ buildUp: 'Long Unwinding', flowRead: 'selling-absorbed', flowBuyPct: 35, changePcr: 0.7, orbTrend: 'up' }),
  ...over,
});
const DATA: Top10Response = {
  ts: 1,
  listSource: 'NIFTY_TOP10 in .env (default: the NIFTY heavyweights).',
  rows: [row(1, 'HDFCBANK'), row(2, 'RELIANCE', { flow: null, options: null, gaps: { flow: 'RELIANCE 27-Oct-26 FUT has no recorded minutes yet this session', options: 'No live option quotes for RELIANCE yet' }, bias: biasOf({ buildUp: 'Long Build-up', flowRead: null, changePcr: null, orbTrend: null }) })],
  basket: { bullish: 1, bearish: 1, neutral: 0, buyPct: 35, medianIv: 18, advancing: 0, declining: 2 },
};

function render(data: unknown): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  if (data instanceof ApiError) qc.getQueryCache().build(qc, { queryKey: ['top10'] }).setState({ status: 'error', error: data, fetchStatus: 'idle', errorUpdateCount: 1, errorUpdatedAt: 1 });
  else qc.setQueryData(['top10'], data);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Top10 />
      </MemoryRouter>
    </QueryClientProvider>,
  ).replaceAll('&amp;', '&');
}

beforeAll(() => {
  const error = console.error;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (!String(args[0]).includes('useLayoutEffect does nothing on the server')) error(...args);
  });
});

describe('NIFTY Top 10 desk', () => {
  it('one row per stock: spot, future, options, flow and a bias pill with its score; missing readings are dashes with reasons', () => {
    const html = render(DATA);
    expect(html).toContain('NIFTY Top 10 — F&O Desk');
    expect(html).toContain('HDFCBANK');
    expect(html).toContain('1,650.00');
    expect(html).toContain('±2.94%'); // implied move
    expect(html).toContain('Selling absorbed');
    expect(html).toContain('Mild bearish');
    expect(html).toContain('RELIANCE 27-Oct-26 FUT has no recorded minutes yet this session'); // flow blank, with the reason
    expect(html).toContain('Mild bullish'); // RELIANCE: one available reading
    expect(html).toContain('NIFTY_TOP10');
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('no Kotak login: the reason, nothing else', () => {
    const html = render(new ApiError('Instrument master not loaded yet: the stocks and their contracts are not known', 503, 'NO_LIVE_DATA'));
    expect(html).toContain('Instrument master not loaded yet');
    expect(html).not.toContain('HDFCBANK');
  });
});
