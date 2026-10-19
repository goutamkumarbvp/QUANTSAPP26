import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FeedStatus, MarketClockInfo, Quote } from '@q26/core';
import { Layout } from '../src/components/Layout';
import { useTicks } from '../src/lib/store';

beforeAll(() => {
  const g = globalThis as Record<string, unknown>;
  g.document = { documentElement: { classList: { contains: () => true, toggle: () => undefined } }, querySelector: () => null };
  const error = console.error;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (!String(args[0]).includes('useLayoutEffect does nothing on the server')) error(...args);
  });
});

const ts = Date.UTC(2026, 9, 19, 5, 12, 5); // 10:42:05 IST, a Monday
const feed = (over: Partial<FeedStatus> = {}): FeedStatus => ({
  loggedIn: true, connected: true, lastTickTs: ts - 2000, subscribed: 812, refdataReady: true, recordingSince: '2026-10-13',
  eod: { fo: '2026-10-16', cm: '2026-10-16', index: '2026-10-16', participants: '2026-10-16', fiidii: '2026-10-16' }, ...over,
});
const clock = (f?: FeedStatus, over: Partial<MarketClockInfo> = {}): MarketClockInfo => ({ ts, date: '2026-10-19', time: '10:42:05', status: 'open', sessionMinute: 87, ...(f ? { feed: f } : {}), ...over });
const nifty: Quote = { symbol: 'NIFTY', ltp: 24100.5, change: null, changePct: null, open: null, high: null, low: null, prevClose: null, future: null, futureExpiry: null, futureChange: null, atmIv: null, ts: ts - 2000 };

/** A server render reads zustand's *initial* state: patch it in place (and the live state) so the tests can set the store. */
function setStore(patch: Partial<ReturnType<typeof useTicks.getState>>) {
  Object.assign(useTicks.getInitialState(), patch);
  useTicks.setState(patch);
}

function render(): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <Layout>
          <div>page</div>
        </Layout>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('Layout: feed status chip and banner', () => {
  beforeEach(() => setStore({ clock: null, connected: false, quotes: {}, prev: {} }));

  it('says CONNECTING before the first status', () => {
    const html = render();
    expect(html).toContain('CONNECTING');
    expect(html).toContain('Connecting to the live feed');
  });

  it('LIVE with ticks flowing: no warning banner, the market clock beside it', () => {
    setStore({ clock: clock(feed()), connected: true });
    const html = render();
    expect(html).toContain('LIVE');
    expect(html).toContain('Open');
    expect(html).not.toContain('Live feed offline');
    expect(html).not.toContain('Connecting to the live feed');
  });

  it('OFFLINE shows the server-reported reason in a banner and in the chip tooltip', () => {
    setStore({ clock: clock(feed({ loggedIn: false, connected: false, lastTickTs: null, error: 'Kotak TOTP login failed: invalid code' })), connected: true });
    const html = render();
    expect(html).toContain('OFFLINE');
    expect(html).toContain('Live feed offline — Kotak TOTP login failed: invalid code');
    expect(html).toContain('title="OFFLINE — Kotak TOTP login failed: invalid code');
  });

  it('OFFLINE when this browser lost the server', () => {
    setStore({ clock: clock(feed()), connected: false });
    expect(render()).toContain('Connection to the server lost');
  });

  it('LIVE but quiet (no tick for a minute while the market is open) is flagged', () => {
    setStore({ clock: clock(feed({ lastTickTs: ts - 5 * 60_000 })), connected: true });
    const html = render();
    expect(html).toContain('Live feed is quiet');
    expect(html).toContain('last live tick was 5m ago');
  });

  it('never claims the data is simulated; says what it is', () => {
    setStore({ clock: clock(feed()), connected: true });
    const html = render();
    expect(html).not.toMatch(/simulat|demo|\bSIM\b/i);
    expect(html).toContain('Live Kotak Neo data and official NSE/BSE');
  });

  it('ticker: a quote without change shows the price and a dash, never NaN', () => {
    setStore({ clock: clock(feed()), connected: true, quotes: { NIFTY: nifty } });
    const html = render();
    expect(html).toContain('24,100.50');
    expect(html).not.toMatch(/NaN|undefined|Infinity/);
    expect(html).toContain('no live price yet'); // the other indices have no quote yet
  });
});
