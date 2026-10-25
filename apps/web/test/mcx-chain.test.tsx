import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { McxChainResponse, McxLeg, McxSymbolsResponse } from '@q26/core';
import { ApiError } from '../src/lib/api';
import McxChain from '../src/pages/McxChain';

const SYMBOLS: McxSymbolsResponse = { masterDate: '2026-10-26', symbols: [{ symbol: 'CRUDEOIL', lotSize: 100, optionExpiries: ['2026-11-16'], futureExpiries: ['2026-11-19'] }, { symbol: 'GOLD', lotSize: 1, optionExpiries: ['2026-11-25'], futureExpiries: ['2026-12-04'] }], warnings: [] };
const leg = (ltp: number | null, iv: number | null, oi: number | null): McxLeg => ({ token: '1', tradingSymbol: 'X', ltp, change: null, changePct: ltp === null ? null : 1.5, oi, volume: 10, bid: null, ask: null, iv, delta: null, ts: null });
const CHAIN: McxChainResponse = {
  symbol: 'CRUDEOIL',
  expiry: '2026-11-16',
  expiries: ['2026-11-16'],
  lotSize: 100,
  future: { expiry: '2026-11-19', tradingSymbol: 'CRUDEOIL26NOVFUT', ltp: 5480, changePct: 1.2, ts: Date.UTC(2026, 9, 26, 14, 30) },
  atmStrike: 5500,
  rows: [
    { strike: 5400, ce: leg(152.4, 0.41, 1200), pe: leg(70.1, 0.4, 3400) },
    { strike: 5500, ce: leg(98.5, 0.4, 5600), pe: leg(null, null, null) },
    { strike: 5600, ce: leg(60.2, 0.39, 7800), pe: null },
  ],
  totals: { ceOi: 14_600, peOi: 3_400, pcr: 0.23 },
  maxPain: 5500,
  asOf: Date.UTC(2026, 9, 26, 14, 30),
  market: { open: true, note: 'MCX trades 09:00–23:30 IST on weekdays (holidays not checked)' },
  masterDate: '2026-10-26',
  gaps: [],
};

beforeAll(() => {
  const error = console.error;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (!String(args[0]).includes('useLayoutEffect does nothing on the server')) error(...args);
  });
});

function render(seeds: [unknown[], unknown][]): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  for (const [key, data] of seeds) {
    if (data instanceof ApiError) qc.getQueryCache().build(qc, { queryKey: key }).setState({ status: 'error', error: data, fetchStatus: 'idle', errorUpdateCount: 1, errorUpdatedAt: 1 });
    else qc.setQueryData(key, data);
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <McxChain />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('MCX option chain page', () => {
  it('shows the commodities, the future it is priced on, and the chain; missing values are dashes, never 0', () => {
    const html = render([[['mcx-symbols'], SYMBOLS], [['mcx-chain', 'CRUDEOIL', ''], CHAIN]]);
    expect(html).toContain('MCX Option Chain');
    expect(html).toContain('<option value="CRUDEOIL" selected="">CRUDEOIL</option>');
    expect(html).toContain('<option value="GOLD">GOLD</option>');
    expect(html).toContain('CRUDEOIL options · expiry');
    expect(html).toContain('5,480');
    expect(html).toContain('152.40');
    expect(html).toContain('41.0'); // IV %
    expect(html).toContain('0.23'); // PCR
    expect(html).toContain('Open');
    expect(html).toContain('title="Not traded in this session"'); // 5500 PE has no LTP
    expect(html).toContain('title="No contract at this strike"'); // 5600 PE does not exist
    expect(html).not.toMatch(/>0\.00</);
  });

  it('no live data: the reason from the server, nothing else', () => {
    const err = new ApiError('No live price for CRUDEOIL26NOVFUT: the chain needs the future it settles into', 503, 'NO_LIVE_DATA');
    const html = render([[['mcx-symbols'], SYMBOLS], [['mcx-chain', 'CRUDEOIL', ''], err]]);
    expect(html).toContain('No live price for CRUDEOIL26NOVFUT');
    expect(html).not.toContain('CRUDEOIL options · expiry');
  });

  it('MCX contracts unavailable (no Kotak login) → says so', () => {
    const err = new ApiError('MCX contracts unavailable: Kotak credentials missing in .env', 503, 'NO_LIVE_DATA');
    const html = render([[['mcx-symbols'], err]]);
    expect(html).toContain('Kotak credentials missing');
  });
});
