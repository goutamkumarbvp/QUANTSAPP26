import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/live/kotak/ratelimit';
import {
  KotakRest,
  chainLegToLive,
  parseCandles,
  parseExpiries,
  parseFuturesChain,
  parseKotakTimestamp,
  parseOptionChain,
  parseQuote,
  parseScripMasterPaths,
  quoteToLive,
  quotesPath,
  splitDateRange,
  type KotakRequester,
} from '../../src/live/kotak/rest';
import { KotakError, KotakSession, type KotakRequestOptions } from '../../src/live/kotak/session';
import { pickScripFile } from '../../src/live/kotak/scripmaster';
import {
  CREDS,
  EXPIRIES,
  FUTURES_CHAIN,
  HISTORICAL,
  HISTORICAL_ERROR,
  INVALID_INSTRUMENT,
  OPTION_CHAIN,
  QUOTE_EQUITY,
  QUOTE_INDEX_SENSEX,
  QUOTE_OPTION,
  fakeFetch,
  filePaths,
  loginOk,
  validateOk,
  fakeClock,
} from './kotak-fixtures';

/** Records every request and answers from `reply`. */
function stub(reply: (path: string, opts: KotakRequestOptions, n: number) => unknown) {
  const calls: { path: string; opts: KotakRequestOptions }[] = [];
  const requester: KotakRequester = {
    async request<T>(path: string, opts: KotakRequestOptions): Promise<T> {
      calls.push({ path, opts });
      const r = reply(path, opts, calls.length - 1);
      if (r instanceof Error) throw r;
      return r as T;
    },
  };
  return { rest: new KotakRest(requester), calls };
}

describe('quotes', () => {
  it('keeps | and , literal and URL-encodes index names', () => {
    expect(quotesPath(['nse_cm|1333', 'nse_fo|71472', 'nse_cm|Nifty 50', 'bse_cm|SENSEX'])).toBe(
      'script-details/1.0/quotes/neosymbol/nse_cm|1333,nse_fo|71472,nse_cm|Nifty%2050,bse_cm|SENSEX/all',
    );
    expect(() => quotesPath(['Nifty 50'])).toThrow(/Invalid neosymbol/);
    expect(() => quotesPath(['nse_cm|a,b'])).toThrow(/Invalid neosymbol/);
  });

  it('parses the documented equity quote (strings → numbers, ohlc.close = previous close)', () => {
    const q = parseQuote(QUOTE_EQUITY)!;
    expect(q).toEqual({
      neosymbol: 'nse_cm|1333',
      segment: 'nse_cm',
      token: '1333',
      displaySymbol: 'HDFCBANK-EQ',
      ts: 1782374657000,
      ltp: 801.6,
      ltq: 550,
      open: 798.5,
      high: 804.45,
      low: 796,
      prevClose: 793.2,
      change: 8.4,
      changePct: 1.06,
      volume: 30043533, // last_volume = day volume (critic.md C3)
      atp: 799.89,
      totalBuyQty: 907335,
      totalSellQty: 2883870,
      upperCircuit: 872.5,
      lowerCircuit: 713.9,
      yearHigh: 2037.7,
      yearLow: 726.65,
      depth: {
        bids: [
          { price: 801.6, qty: 1733, orders: 4 },
          { price: 801.55, qty: 1200, orders: 3 },
          { price: 801.5, qty: 900, orders: 2 },
          { price: 801.45, qty: 450, orders: 1 },
        ],
        asks: [
          { price: 801.65, qty: 550, orders: 1 },
          { price: 801.7, qty: 800, orders: 2 },
          { price: 801.75, qty: 1000, orders: 3 },
          { price: 801.8, qty: 1500, orders: 5 },
          { price: 801.85, qty: 2000, orders: 6 },
        ],
      },
    });
    // Cash instruments have no OI: open_int "0" is a placeholder, not a value.
    expect(q.oi).toBeUndefined();
    expect(parseQuote(QUOTE_OPTION)!.oi).toBe(10715645);
  });

  it('parses an index quote as sent; empty depth levels and zero prices are absent', () => {
    const q = parseQuote(QUOTE_INDEX_SENSEX)!;
    expect(q).toEqual({
      neosymbol: 'bse_cm|SENSEX',
      segment: 'bse_cm',
      token: 'SENSEX',
      displaySymbol: 'SENSEX-IN',
      ts: 1757915078000,
      ltp: 81809.34,
      open: 81925.51,
      high: 81998.51,
      low: 81779.82,
      prevClose: 81904.7,
      change: -95.36,
      changePct: -0.12,
      // Whether these "0"s are placeholders depends on the instrument: quoteToLive decides by key.
      volume: 0,
      totalBuyQty: 0,
      totalSellQty: 0,
    });
  });

  it('quoteToLive maps to LiveQuote with best bid/ask from depth', () => {
    const key = { symbol: 'HDFCBANK', kind: 'SPOT' as const };
    const lq = quoteToLive(parseQuote(QUOTE_EQUITY)!, key, 1, 'stock')!;
    expect(lq).toMatchObject({ key, ts: 1782374657000, ltp: 801.6, prevClose: 793.2, volume: 30043533, bid: 801.6, ask: 801.65, bidQty: 1733, askQty: 550, atp: 799.89 });
    expect(lq.oi).toBeUndefined();
    expect(quoteToLive({ ...parseQuote(QUOTE_EQUITY)!, ltp: undefined }, key, 1, 'stock')).toBeUndefined();
  });

  it('quoteToLive drops the index placeholders by instrument key, whether the index came back by name or number', () => {
    const sensex = { symbol: 'SENSEX', kind: 'SPOT' as const };
    const byName = quoteToLive(parseQuote(QUOTE_INDEX_SENSEX)!, sensex, 1, 'index')!;
    expect(byName).toEqual({ key: sensex, ts: 1757915078000, ltp: 81809.34, open: 81925.51, high: 81998.51, low: 81779.82, prevClose: 81904.7 });
    // CONSTRUCTED: NIFTY addressed by its numeric cash token 26000, with a (non-empty) book that an
    // index cannot have.
    const nifty = { symbol: 'NIFTY', kind: 'SPOT' as const };
    const numeric = parseQuote({ ...QUOTE_EQUITY, exchange_token: '26000', exchange: 'nse_cm', last_volume: '0', total_buy: '0', total_sell: '0' })!;
    const lq = quoteToLive(numeric, nifty, 1, 'index')!;
    expect(lq.ltp).toBe(801.6);
    for (const f of ['volume', 'totalBuyQty', 'totalSellQty', 'bid', 'ask', 'bidQty', 'askQty', 'depth'] as const) expect(lq[f]).toBeUndefined();
    // The same zeros are real for a stock (no trade yet) and for an index option (untraded strike).
    const stock = quoteToLive(numeric, { symbol: 'X', kind: 'SPOT' }, 1, 'stock')!;
    expect([stock.volume, stock.totalBuyQty, stock.totalSellQty, stock.bid]).toEqual([0, 0, 0, 801.6]);
    const opt = { symbol: 'NIFTY', kind: 'CE' as const, expiry: '2026-06-23', strike: 22250 };
    expect(quoteToLive({ ...parseQuote(QUOTE_OPTION)!, volume: 0 }, opt, 1, 'index')!.volume).toBe(0);
  });

  it('keeps a depth level without an order count, with orders absent (never 0)', () => {
    const q = parseQuote({ ...QUOTE_EQUITY, depth: { buy: [{ price: '801.6', quantity: '1733' }], sell: [{ price: '801.65', quantity: '550', orders: '1' }] } })!;
    expect(q.depth).toEqual({ bids: [{ price: 801.6, qty: 1733 }], asks: [{ price: 801.65, qty: 550, orders: 1 }] });
  });

  it('chunks ≤50 per call on the general lane and reports failed chunks', async () => {
    const syms = Array.from({ length: 120 }, (_, i) => `nse_fo|${1000 + i}`);
    const { rest, calls } = stub((path, _o, n) => {
      if (n === 1) return new KotakError('Kotak quotes failed: Invalid instrument/code', 'api', 200, 1009);
      const toks = path.split('/')[4].split(',').map((s) => s.split('|')[1]);
      return toks.map((t) => ({ ...QUOTE_OPTION, exchange_token: t }));
    });
    const r = await rest.quotes([...syms, syms[0]]);
    expect(calls.map((c) => c.path.split('/')[4].split(',').length)).toEqual([50, 50, 20]);
    expect(calls.every((c) => c.opts.kind === 'market' && c.opts.lane === 'general' && c.opts.endpoint === 'quotes nse_fo')).toBe(true);
    expect(r.quotes.size).toBe(70);
    expect(r.quotes.get('nse_fo|1000')?.ltp).toBe(801.6);
    expect(r.errors).toEqual([{ neosymbols: syms.slice(50, 100), error: expect.stringContaining('Invalid instrument') }]);
  });

  it('throws when every chunk fails, and accepts a {data:[...]} envelope', async () => {
    const failing = stub(() => new KotakError('down', 'network'));
    await expect(failing.rest.quotes(['nse_cm|1333'])).rejects.toThrow('down');
    const wrapped = stub(() => ({ data: [QUOTE_EQUITY] }));
    expect((await wrapped.rest.quotes(['nse_cm|1333'])).quotes.get('nse_cm|1333')?.ltp).toBe(801.6);
  });

  it('goes over the session with Authorization only and literal delimiters', async () => {
    const ff = fakeFetch((c) =>
      c.url.endsWith('tradeApiLogin') ? { body: loginOk() } : c.url.endsWith('tradeApiValidate') ? { body: validateOk() } : c.url.includes('/quotes/') ? { body: [QUOTE_INDEX_SENSEX] } : { status: 200, body: INVALID_INSTRUMENT },
    );
    const session = new KotakSession(CREDS, { fetch: ff.fn, limiter: new RateLimiter(), ...fakeClock() });
    const rest = new KotakRest(session);
    const r = await rest.quotes(['bse_cm|SENSEX', 'nse_cm|Nifty 50']);
    const call = ff.calls[2];
    expect(call.url).toBe('https://neo-gw.kotaksecurities.com/xyz/script-details/1.0/quotes/neosymbol/bse_cm|SENSEX,nse_cm|Nifty%2050/all');
    expect(call.headers).toEqual({ authorization: CREDS.consumerKey });
    expect(r.quotes.get('bse_cm|SENSEX')?.ltp).toBe(81809.34);
    await expect(rest.expiries({ exchange: 'nse_fo', underlying: 'NOPE' })).rejects.toMatchObject({ kind: 'api', stCode: 1009 });
  });
});

describe('option chain, futures chain, expiries', () => {
  it('parses the documented option chain incl. OI current/previous/change', () => {
    const c = parseOptionChain(OPTION_CHAIN);
    expect(c).toMatchObject({ exchange: 'nse_fo', underlying: 'NIFTY', expiry: '2026-06-23', lotSize: 65, multiplier: 1 });
    expect(c.calls).toEqual([
      {
        neosymbol: 'nse_fo|71472',
        segment: 'nse_fo',
        token: '71472',
        tradingSymbol: 'NIFTY26JUN22250CE',
        type: 'CE',
        strike: 22250,
        moneyness: 'ATM',
        ltp: 166.75,
        open: 89.8,
        high: 214,
        low: 77.1,
        prevClose: 99.7,
        volume: 225431505,
        oi: 10715645,
        prevOi: 13647630,
        oiChange: -2931985,
        oiChangePct: -21.48,
      },
    ]);
    // close: null intraday → absent; an untraded leg has no LTP/OHLC but real zero volume/OI.
    expect(c.calls[0].close).toBeUndefined();
    expect(c.puts[0]).toMatchObject({ type: 'PE', strike: 22250, prevClose: 120.05, volume: 0, oi: 0, prevOi: 150 });
    expect(c.puts[0].ltp).toBeUndefined();
    const key = { symbol: 'NIFTY', kind: 'CE' as const, expiry: '2026-06-23', strike: 22250 };
    expect(chainLegToLive(c.calls[0], key, 42)).toEqual({ key, ts: 42, ltp: 166.75, open: 89.8, high: 214, low: 77.1, prevClose: 99.7, volume: 225431505, oi: 10715645, prevOi: 13647630 });
    expect(chainLegToLive(c.puts[0], { ...key, kind: 'PE' }, 42)).toBeUndefined();
  });

  it('parses the futures chain with abbreviated keys', () => {
    expect(parseFuturesChain(FUTURES_CHAIN)).toEqual({
      exchange: 'nse_fo',
      underlying: 'NIFTY',
      lotSize: 65,
      multiplier: 1,
      futures: [
        {
          neosymbol: 'nse_fo|53001',
          segment: 'nse_fo',
          token: '53001',
          tradingSymbol: 'NIFTY26JULFUT',
          expiry: '2026-07-31',
          ltp: 24485.2,
          open: 24455,
          high: 24512,
          low: 24428,
          prevClose: 24322.1,
          volume: 9852340,
          oi: 13930930,
          prevOi: 13801200,
          oiChange: 129730,
          oiChangePct: 0.94,
        },
      ],
    });
    // quote.c equals ltp intraday in the sample: it is not a close and is not carried anywhere.
    const row = parseFuturesChain(FUTURES_CHAIN).futures[0];
    expect('close' in row).toBe(false);
    const fut = chainLegToLive(row, { symbol: 'NIFTY', kind: 'FUT', expiry: '2026-07-31' }, 7)!;
    expect(fut.prevClose).toBe(24322.1);
    expect('close' in fut).toBe(false);
  });

  it('calls option-chain / futures chain / expiries on the slow lane with the documented params', async () => {
    const { rest, calls } = stub((path, opts) =>
      path.endsWith('expiries') ? EXPIRIES : opts.query?.instrument_type === 'fut' ? FUTURES_CHAIN : OPTION_CHAIN,
    );
    await rest.optionChain({ exchange: 'nse_fo', underlying: 'NIFTY', expiry: '2026-06-23', count: 40 });
    await rest.futuresChain({ exchange: 'nse_fo', underlying: 'NIFTY' });
    expect(await rest.expiries({ exchange: 'nse_fo', underlying: 'RELIANCE' })).toEqual(['2026-06-25', '2026-06-30', '2026-07-31']);
    expect(calls.map((c) => [c.path, c.opts.lane, c.opts.kind, c.opts.query])).toEqual([
      ['market-data/1.0/watchlist/option-chain', 'slow', 'market', { exchange: 'nse_fo', underlying: 'NIFTY', expiry: '2026-06-23', instrument_type: 'option', count: 40 }],
      ['market-data/1.0/watchlist/option-chain', 'slow', 'market', { exchange: 'nse_fo', underlying: 'NIFTY', expiry: undefined, instrument_type: 'fut' }],
      ['market-data/1.0/watchlist/expiries', 'slow', 'market', { exchange: 'nse_fo', underlying: 'RELIANCE', instrument_type: 'option' }],
    ]);
    // 403 holds are per endpoint: one key per endpoint and exchange.
    expect(calls.map((c) => c.opts.endpoint)).toEqual(['option-chain nse_fo', 'futures-chain nse_fo', 'expiries nse_fo']);
    await expect(rest.optionChain({ exchange: 'nse_fo', underlying: 'NIFTY', count: 45 })).rejects.toThrow(/multiple of 10/);
    expect(calls.length).toBe(3);
  });

  it('sorts, validates and de-duplicates expiries', () => {
    expect(parseExpiries({ expiries: ['2026-07-31', '2026-06-25', 'bad', '2026-06-25'] })).toEqual(['2026-06-25', '2026-07-31']);
    expect(() => parseExpiries({ stat: 'Ok' })).toThrow(/unexpected response shape/);
  });
});

describe('historical', () => {
  it("normalises '+0530' timestamps and parses positional rows", () => {
    expect(parseKotakTimestamp('2026-08-20T09:15:00+0530')).toBe(Date.UTC(2026, 7, 20, 3, 45));
    expect(parseKotakTimestamp('2026-08-20T09:15:00+05:30')).toBe(Date.UTC(2026, 7, 20, 3, 45));
    expect(parseKotakTimestamp('2026-08-20 09:15:00')).toBe(Date.UTC(2026, 7, 20, 3, 45)); // zone-less = IST
    expect(parseKotakTimestamp('2026-08-20')).toBe(Date.UTC(2026, 7, 19, 18, 30));
    expect(parseKotakTimestamp(1787197500)).toBe(1787197500000);
    // The sample's 7th column (13667775 on a cash stock) is the unpopulated "Phase 1" OI slot: ignored.
    expect(parseCandles(HISTORICAL)).toEqual([
      { ts: Date.UTC(2026, 7, 20, 3, 45), open: 12009.9, high: 12019.35, low: 12001.25, close: 12001.5, volume: 163275 },
      { ts: Date.UTC(2026, 7, 20, 3, 46), open: 12001, high: 12003, low: 11998.25, close: 12001, volume: 105750 },
    ]);
  });

  it('never reports candle OI, drops malformed rows; accepts the legacy parallel-array shape', () => {
    const rows = parseCandles({ data: { candles: [['2026-08-20T09:15:00+0530', 1, 2, 0.5, 1.5, 10, 0], ['bad', 1, 1, 1, 1, 1, null], ['2026-08-20T09:16:00+0530', 1, 2, 0.5, null, 10, null]] } });
    expect(rows).toEqual([{ ts: Date.UTC(2026, 7, 20, 3, 45), open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }]);
    const legacy = parseCandles({ data: { t: ['2026-08-20T09:16:00+0530', '2026-08-20T09:15:00+0530'], o: [2, 1], h: [3, 2], l: [1, 0.5], c: [2.5, 1.5], v: [5, 10] } });
    expect(legacy.map((c) => [c.ts, c.close, c.volume])).toEqual([
      [Date.UTC(2026, 7, 20, 3, 45), 1.5, 10],
      [Date.UTC(2026, 7, 20, 3, 46), 2.5, 5],
    ]);
    expect(() => parseCandles({ data: { t: [1], o: [1, 2], h: [1], l: [1], c: [1], v: [1] } })).toThrow(/different lengths/);
  });

  it('splits ranges by the per-interval maximum', () => {
    expect(splitDateRange('2026-07-01', '2026-09-13', 30)).toEqual([
      { from: '2026-07-01', to: '2026-07-30' },
      { from: '2026-07-31', to: '2026-08-29' },
      { from: '2026-08-30', to: '2026-09-13' },
    ]);
    expect(splitDateRange('2026-01-01', '2026-01-01', 180)).toEqual([{ from: '2026-01-01', to: '2026-01-01' }]);
    expect(() => splitDateRange('2026-02-01', '2026-01-01', 30)).toThrow(/after/);
  });

  it('fetches each window on the slow lane and merges the candles', async () => {
    const { rest, calls } = stub(() => HISTORICAL);
    const out = await rest.historical({ neosymbol: 'nse_fo|71472', interval: '1min', from: '2026-07-01', to: '2026-09-13' });
    expect(calls.map((c) => [c.opts.lane, c.opts.query?.fromdate, c.opts.query?.todate, c.opts.query?.interval, c.opts.query?.neosymbol])).toEqual([
      ['slow', '2026-07-01', '2026-07-30', '1min', 'nse_fo|71472'],
      ['slow', '2026-07-31', '2026-08-29', '1min', 'nse_fo|71472'],
      ['slow', '2026-08-30', '2026-09-13', '1min', 'nse_fo|71472'],
    ]);
    expect(out.length).toBe(2); // identical candles across windows are merged
    expect(calls.every((c) => c.opts.endpoint === 'historical nse_fo')).toBe(true);
    const daily = stub(() => HISTORICAL);
    await daily.rest.historical({ neosymbol: 'nse_cm|1333', interval: 'D', from: '2026-01-01', to: '2026-09-30' });
    expect(daily.calls.length).toBe(2);
    await expect(rest.historical({ neosymbol: 'nse_cm|1333', interval: '2min' as never, from: '2026-01-01', to: '2026-01-02' })).rejects.toThrow(/Unsupported/);
  });

  it('surfaces the historical error envelope through the session', async () => {
    const ff = fakeFetch((c) => (c.url.endsWith('tradeApiLogin') ? { body: loginOk() } : c.url.endsWith('tradeApiValidate') ? { body: validateOk() } : { status: 400, body: HISTORICAL_ERROR }));
    const rest = new KotakRest(new KotakSession(CREDS, { fetch: ff.fn, ...fakeClock() }));
    await expect(rest.historical({ neosymbol: 'nse_cm|1333', interval: '1min', from: '2026-08-20', to: '2026-08-21' })).rejects.toThrow(/Invalid interval value/);
    expect(ff.calls[2].url).toBe('https://neo-gw.kotaksecurities.com/xyz/market-data/1.0/historical/details?neosymbol=nse_cm|1333&interval=1min&fromdate=2026-08-20&todate=2026-08-21');
  });
});

describe('scrip master file paths', () => {
  it('parses file-paths and picks one file per segment by substring', async () => {
    const { rest, calls } = stub(() => filePaths('2026-07-14'));
    const p = await rest.scripMasterPaths();
    expect(calls[0]).toMatchObject({ path: 'script-details/1.0/masterscrip/file-paths', opts: { kind: 'market', lane: 'general' } });
    expect(p.baseFolder).toBe('https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod');
    expect(p.files.length).toBe(7);
    const base = 'https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/2026-07-14';
    expect(pickScripFile(p.files, 'nse_cm')).toBe(`${base}/transformed-v1/nse_cm-v1.csv`); // not nse_com.csv
    expect(pickScripFile(p.files, 'bse_cm')).toBe(`${base}/transformed-v1/bse_cm-v1.csv`);
    expect(pickScripFile(p.files, 'nse_fo')).toBe(`${base}/transformed/nse_fo.csv`);
    expect(pickScripFile(p.files, 'bse_fo')).toBe(`${base}/transformed/bse_fo.csv`);
    expect(pickScripFile([`${base}/transformed/nse_cm.csv`, `${base}/transformed-v1/nse_cm-v1.csv`], 'nse_cm')).toBe(`${base}/transformed-v1/nse_cm-v1.csv`);
    expect(() => parseScripMasterPaths({ data: {} })).toThrow(/unexpected response shape/);
  });
});
