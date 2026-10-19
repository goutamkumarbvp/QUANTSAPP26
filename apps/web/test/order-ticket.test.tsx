import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarketClockInfo, MetaResponse, OptionChain, OptionQuote } from '@q26/core';
import { OrderTicket, suggestedPrice, type TicketSpec } from '../src/components/OrderTicket';
import { useTicks } from '../src/lib/store';

const ts = Date.UTC(2026, 9, 19, 5, 12, 5);

beforeAll(() => {
  const error = console.error;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (!String(args[0]).includes('useLayoutEffect does nothing on the server')) error(...args);
  });
});

const leg = (over: Partial<OptionQuote> = {}): OptionQuote =>
  ({ ltp: 100.5, bid: 100, ask: 101, bidQty: 75, askQty: 150, ts, ...over }) as OptionQuote;
const chain = (ce: OptionQuote, pe: OptionQuote): OptionChain =>
  ({ symbol: 'NIFTY', expiry: '2026-10-20', lotSize: 75, rows: [{ strike: 24100, ce, pe }] }) as unknown as OptionChain;
const meta = { symbols: [{ symbol: 'NIFTY', name: 'Nifty 50', kind: 'index', exchange: 'NSE', sector: '', lotSize: 75, strikeStep: 50, expiryCycle: 'weekly' }] } as unknown as MetaResponse;
const clock = (status: MarketClockInfo['status']): MarketClockInfo => ({ ts, date: '2026-10-19', time: '10:42:05', status, sessionMinute: 87 });

function setStore(patch: Partial<ReturnType<typeof useTicks.getState>>) {
  Object.assign(useTicks.getInitialState(), patch);
  useTicks.setState(patch);
}

function render(spec: TicketSpec, c: OptionChain | null, status: MarketClockInfo['status'] = 'open'): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  qc.setQueryData(['meta'], meta);
  if (c) qc.setQueryData(['chain', 'NIFTY', '2026-10-20', 'live'], c);
  setStore({ clock: clock(status) });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <OrderTicket spec={spec} onClose={() => undefined} />
    </QueryClientProvider>,
  );
}

const spec = (over: Partial<TicketSpec> = {}): TicketSpec => ({ symbol: 'NIFTY', type: 'CE', strike: 24100, expiry: '2026-10-20', side: 'BUY', ...over });
/** The submit button: its attributes and label. */
const submit = (html: string) => /<button class="w-full btn-(?:buy|sell)"([^>]*)>([^<]*)<\/button>/.exec(html);

describe('OrderTicket: no price, no order', () => {
  beforeEach(() => setStore({ clock: null }));

  it('a market buy needs a live ask: enabled with one', () => {
    const html = render(spec(), chain(leg(), leg()));
    const m = submit(html)!;
    expect(m[1]).not.toContain('disabled');
    expect(m[2]).toBe('Buy 1 lot');
    expect(html).toContain('101.00'); // the live ask is shown
  });

  it('disabled with the reason when the live ask is missing; a sell needs the bid', () => {
    const noAsk = render(spec(), chain(leg({ ask: null }), leg()));
    expect(submit(noAsk)![1]).toContain('disabled');
    expect(noAsk).toContain('No live ask for NIFTY');
    const sellNoBid = render(spec({ side: 'SELL' }), chain(leg({ bid: null }), leg()));
    expect(submit(sellNoBid)![2]).toBe('Sell 1 lot');
    expect(submit(sellNoBid)![1]).toContain('disabled');
    expect(sellNoBid).toContain('No live bid for NIFTY');
    const sellOk = render(spec({ side: 'SELL' }), chain(leg({ ask: null }), leg()));
    expect(submit(sellOk)![1]).not.toContain('disabled');
  });

  it('no chain loaded yet: disabled with the reason, never a guessed price', () => {
    const html = render(spec(), null);
    expect(submit(html)![1]).toContain('disabled');
    expect(html).toContain('Loading the live quote');
    expect(html).toContain('No live ask for NIFTY');
    expect(html).toMatch(/Lots \(lot = 75\)/); // the lot size is the instrument master's
  });

  it('without the instrument master and without a chain the lot size is unknown (a dash, not 1) and the order is blocked', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
    setStore({ clock: clock('open') });
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <OrderTicket spec={spec()} onClose={() => undefined} />
      </QueryClientProvider>,
    );
    expect(html).toContain('Lots (lot = —)');
    expect(submit(html)![1]).toContain('disabled');
    expect(html).toContain('Lot size unknown');
  });

  it('market closed: market orders are blocked with that reason', () => {
    const html = render(spec(), chain(leg(), leg()), 'closed');
    expect(submit(html)![1]).toContain('disabled');
    expect(html).toContain('The market is closed');
  });

  it('blank quote values show a dash, never NaN / null / 0', () => {
    const html = render(spec({ price: null }), chain(leg({ ltp: null, bid: null, ask: null, ts: null }), leg()));
    expect(html).not.toMatch(/NaN|undefined|Infinity|>null</);
    expect(html).toContain('—');
    expect(html).toContain('Not traded in the live session');
  });

  it('a limit price is suggested only from a real positive live price', () => {
    expect(suggestedPrice(null, undefined)).toBe('');
    expect(suggestedPrice(Number.NaN)).toBe('');
    expect(suggestedPrice(0)).toBe('');
    expect(suggestedPrice(-3)).toBe('');
    expect(suggestedPrice(null, 101.5)).toBe('101.50');
    expect(suggestedPrice(100.25, 101.5)).toBe('100.25');
  });

  it('says it is paper trading, never "simulated"', () => {
    const html = render(spec(), chain(leg(), leg()));
    expect(html).toContain('Paper trading only');
    expect(html).not.toMatch(/simulat/i);
  });
});
