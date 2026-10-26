import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ORDER_FLOW_METHOD, type OrderFlowMinute, type OrderFlowResponse } from '@q26/core';
import { OrderTradeChart } from '../src/components/OrderTradeChart';

// Test data (not market data): 20 quiet minutes, then a buyer spike while the price rises.
const T0 = Date.UTC(2026, 9, 26, 3, 45);
function minute(i: number, buy: number, sell: number, px: number): OrderFlowMinute {
  return { ts: T0 + i * 60_000, volume: buy + sell, buyVolume: buy, sellVolume: sell, unclassified: 0, gapVolume: null, partial: false, delta: buy - sell, cumDelta: 0, buyPct: null, open: px - 1, high: px + 1, low: px - 2, close: px };
}
const minutes = Array.from({ length: 20 }, (_, i) => minute(i, 100, 100, 25_000 + i));
minutes.push(minute(20, 900, 150, 25_030));
const summary = { buyVolume: 0, sellVolume: 0, unclassified: 0, volume: 0, gapVolume: 0, partialMinutes: 0, delta: 0, buyPct: null, unclassifiedPct: null, sentiment: 'Balanced' } as unknown as OrderFlowResponse['session'];
const D: OrderFlowResponse = {
  symbol: 'NIFTY', instrument: 'NIFTY 27-Oct-26 FUT', type: 'FUT', expiry: '2026-10-27', date: '2026-10-26', live: true, lotSize: 75,
  method: ORDER_FLOW_METHOD, lastMinute: null, currentMinute: null, last5: null, session: summary, minutes, signal: '', coverage: '21 recorded minutes 09:15–09:36', expiries: [], strikes: [],
};

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.document ??= { documentElement: { classList: { contains: () => true, toggle: () => undefined } }, querySelector: () => null };
  g.getComputedStyle ??= () => ({ getPropertyValue: () => '10 20 30' });
  const error = console.error;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (!String(args[0]).includes('useLayoutEffect does nothing on the server')) error(...args);
  });
});

describe('Order & Trade chart', () => {
  it('names the contract, reads the direction from buyer vs seller initiated quantity and the price, and lists spikes', () => {
    const html = renderToStaticMarkup(<OrderTradeChart d={D} />).replaceAll('&amp;', '&');
    expect(html).toContain('Order & Trade chart — NIFTY 27-Oct-26 FUT');
    expect(html).toContain('Buyers in control');
    expect(html).toContain('1 buy · 0 sell');
    expect(html).toMatch(/Latest spikes:.*BUY 900 \(9×\)/);
    expect(html).toContain('Spike = at least 3× the median');
    expect(html).not.toContain('Two panes'); // superimposed, one scale
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('no recorded minute: the chart is blank with the reason, no read', () => {
    const html = renderToStaticMarkup(<OrderTradeChart d={{ ...D, minutes: [] }} />);
    expect(html).toContain('No recorded minute of this contract yet this session');
    expect(html).not.toContain('Buyers in control');
  });
});
