import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ORDER_FLOW_METHOD, type OrderFlowMinute, type OrderFlowResponse } from '@q26/core';
import { MinuteTable } from '../src/components/FlowDetails';
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

const html = (node: ReactElement) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

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
    const out = html(<OrderTradeChart d={D} />).replaceAll('&amp;', '&');
    expect(out).toContain('Order & Trade chart — NIFTY 27-Oct-26 FUT');
    expect(out).toContain('Buyers in control');
    expect(out).toContain('1 buy · 0 sell');
    expect(out).toMatch(/Latest spikes:.*BUY 900 \(9×\)/);
    expect(out).toContain('Spike = at least 3× the median');
    expect(out).not.toContain('Two panes'); // superimposed, one scale
    expect(out).not.toMatch(/NaN|undefined|Infinity/);
  });

  it('the security itself on top (its candles and live price); the contract\'s order flow below', () => {
    const candles = minutes.map((m) => ({ ts: m.ts, open: 24_990, high: 25_000, low: 24_980, close: 24_995, volume: null }));
    const out = html(<OrderTradeChart d={D} price={{ label: 'NIFTY', candles, live: { ltp: 24_996, ts: T0 + 21 * 60_000 } }} />).replaceAll('&amp;', '&');
    expect(out).toContain('Order & Trade chart — NIFTY price · NIFTY 27-Oct-26 FUT order flow (1-minute)');
    expect(out).toContain('Price change (future)');
  });

  it('no recorded minute: the chart is blank with the reason, no read', () => {
    const out = html(<OrderTradeChart d={{ ...D, minutes: [] }} />);
    expect(out).toContain('No recorded minute of this contract yet this session');
    expect(out).not.toContain('Buyers in control');
  });
});

describe('minutes the recorder did not see (Kotak 1-minute candles)', () => {
  const kotak: OrderFlowMinute = { ts: T0 - 60_000, volume: 5000, buyVolume: 0, sellVolume: 0, unclassified: 5000, gapVolume: null, partial: false, delta: 0, cumDelta: 0, buyPct: null, open: 24_990, high: 25_000, low: 24_980, close: 24_995, source: 'kotak' };
  const d: OrderFlowResponse = { ...D, minutes: [kotak, ...minutes] };

  it('the chart says how many came from Kotak and that they have no buyer / seller split', () => {
    expect(html(<OrderTradeChart d={d} />)).toContain('1 minute the recorder did not see (before it started, or during a restart) are drawn from Kotak 1-minute candles');
    expect(html(<OrderTradeChart d={D} />)).not.toContain('Kotak 1-minute candles');
  });

  it('the minute table shows its volume and price, with the split left blank and the source named', () => {
    const out = html(<MinuteTable d={d} unit="qty" />);
    expect(out).toContain('Kotak 1-min candle (not recorded: no buy / sell split)');
    expect(out).toContain('Not recorded: this minute is a Kotak 1-minute candle');
    expect(out).toContain('24,995');
  });
});
