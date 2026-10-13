import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ExchangeCalendar } from '../../src/live/calendar';
import { KotakRest, type KotakRequester } from '../../src/live/kotak/rest';
import type { ScripMaster } from '../../src/live/kotak/scripmaster';
import type { KotakRequestOptions } from '../../src/live/kotak/session';
import type { LiveQuotePatch } from '../../src/live/kotak/sfeed/client';
import { KotakLiveMarket, mergeCell, type KotakLiveMarketOptions, type MergeRules, type QuoteCell, type WatchEntry } from '../../src/live/live-market';
import { NoLiveData, keyId, type InstrumentKey, type LiveQuote } from '../../src/live/types';
import { fakeSockets, type FakeSocket } from '../support/fake-sfeed';
import { ManualTimers, flush } from '../support/manual-timers';
import { AUTH_1117, MP_L4_FIELDS, encodeIndex, encodeMarketPicture } from './fixtures/sfeed';
import { DAY, MONTHLY, NIFTY_W1, NIFTY_W2, loadScripMaster } from './kotak-universe';

/** 10:00 IST on the fixture day (session open). */
const T0 = Date.parse(`${DAY}T04:30:00Z`);
const SEC = (ms: number) => Math.floor(ms / 1000);

let dir = '';
let sm: ScripMaster;
const live: KotakLiveMarket[] = [];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q26-live-'));
  sm = await loadScripMaster(dir);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
afterEach(async () => {
  for (const m of live.splice(0)) await m.close();
});

const tok = (key: InstrumentKey): string => {
  const l = sm.listing(key);
  if (!l) throw new Error(`fixture has no ${keyId(key)}`);
  return l.token;
};
const ce = (strike: number, expiry = NIFTY_W1): InstrumentKey => ({ symbol: 'NIFTY', kind: 'CE', expiry, strike });
const pe = (strike: number, expiry = NIFTY_W1): InstrumentKey => ({ symbol: 'NIFTY', kind: 'PE', expiry, strike });
const SPOT: InstrumentKey = { symbol: 'NIFTY', kind: 'SPOT' };
const FUT: InstrumentKey = { symbol: 'NIFTY', kind: 'FUT', expiry: MONTHLY };

interface RestCall {
  path: string;
  query?: KotakRequestOptions['query'];
  lane?: string;
  at: number;
}

/** KotakRest over a scripted requester: the documented response bodies, no network. */
function fakeRest(timers: ManualTimers, handler: (path: string, opts: KotakRequestOptions) => unknown) {
  const calls: RestCall[] = [];
  const requester: KotakRequester = {
    request: async <T,>(p: string, opts: KotakRequestOptions): Promise<T> => {
      calls.push({ path: p, query: opts.query, lane: opts.lane, at: timers.now() });
      return (await handler(p, opts)) as T;
    },
  };
  return { rest: new KotakRest(requester), calls };
}

/** One quotes-array element in the documented shape (quotes.md). */
function quoteRow(seg: string, token: string, ltp: number, ts: number, extra: Record<string, unknown> = {}) {
  return {
    exchange_token: token,
    exchange: seg,
    lstup_time: String(SEC(ts)),
    ltp: ltp.toFixed(4),
    last_traded_quantity: '75',
    total_buy: '1000',
    total_sell: '2000',
    last_volume: '50000',
    open_int: '0',
    ohlc: { open: ltp.toFixed(2), high: ltp.toFixed(2), low: ltp.toFixed(2), close: ltp.toFixed(2) },
    depth: { buy: [{ price: (ltp - 0.05).toFixed(2), quantity: '75', orders: '1' }], sell: [{ price: (ltp + 0.05).toFixed(2), quantity: '150', orders: '2' }] },
    ...extra,
  };
}

/** Option-chain body (option-chain.md) for the given legs. */
function chainBody(expiry: string, legs: { key: InstrumentKey; ltp?: number; oi?: number; prevOi?: number }[]) {
  const leg = (l: (typeof legs)[number]) => ({
    instrument: { neoSymbol: `nse_fo|${tok(l.key)}`, symbol: `NIFTY${l.key.strike}${l.key.kind}`, optionType: l.key.kind, strikePrice: String(l.key.strike) },
    quote: { ltp: l.ltp === undefined ? '0' : l.ltp.toFixed(2), prevClose: '100.00', close: null, volume: 1000 },
    openInterest: { current: l.oi ?? 0, previous: l.prevOi ?? 0 },
  });
  return { data: { common_data: { mktLot: '75', unlSymbol: 'NIFTY', exSeg: 'nse_fo', expiryDt: expiry }, call: legs.filter((l) => l.key.kind === 'CE').map(leg), put: legs.filter((l) => l.key.kind === 'PE').map(leg) } };
}

function harness(over: Partial<KotakLiveMarketOptions> = {}, handler: (path: string, opts: KotakRequestOptions) => unknown = () => { throw new Error('unexpected REST call'); }, start = T0) {
  const timers = new ManualTimers(start);
  const sf = fakeSockets();
  const fr = fakeRest(timers, handler);
  const market = new KotakLiveMarket({
    ref: sm,
    rest: fr.rest,
    calendar: new ExchangeCalendar(),
    now: timers.now,
    timers,
    wsFactory: sf.factory,
    sessionStatus: () => ({ loggedIn: true }),
    feedOptions: { random: () => 0 },
    ...over,
  });
  live.push(market);
  return { market, timers, sf, fr };
}

async function connect(h: ReturnType<typeof harness>): Promise<FakeSocket> {
  h.market.startFeed({ url: 'wss://feed.test/apifeed', sid: 'sid-0123456789-secret', ucc: 'UCC9X' });
  const s = h.sf.last();
  s.open();
  s.text(AUTH_1117);
  await flush(2);
  return s;
}

/** A level-4 market picture of an nse_fo token at `ts` (prices in rupees). */
function mp(token: string, p: { ltp: number; ts: number; bid?: number; ask?: number; oi?: number; vol?: number }): Uint8Array {
  const paise = (v: number) => Math.round(v * 100);
  return encodeMarketPicture({
    ...MP_L4_FIELDS,
    exch: 2,
    token: Number(token),
    ltp: paise(p.ltp),
    ltt: SEC(p.ts),
    lut: SEC(p.ts),
    open: paise(p.ltp),
    high: paise(p.ltp),
    low: paise(p.ltp),
    close: paise(p.ltp),
    oi: p.oi ?? 1000,
    vol: p.vol ?? 5000,
    rows: [
      [p.bid ? 75 : 0, p.bid ? paise(p.bid) : 0, p.bid ? 1 : 0],
      [p.ask ? 150 : 0, p.ask ? paise(p.ask) : 0, p.ask ? 2 : 0],
    ],
  });
}

const subs = (s: FakeSocket) => s.subscribed();

/* ------------------------------------------------------------------------------------------ */

describe('mergeCell (quote merge rules)', () => {
  const rules = (o: Partial<MergeRules> = {}): MergeRules => ({ book: false, stream: true, sameDay: (a, b) => new Date(a + 19_800_000).toISOString().slice(0, 10) === new Date(b + 19_800_000).toISOString().slice(0, 10), bookMaxAgeMs: 10_000, streamFreshMs: 10_000, ...o });
  const key = ce(25000);
  const cell = (q: Partial<LiveQuote>, extra: Partial<QuoteCell> = {}): QuoteCell => ({ q: { key, ts: T0, ...q } as LiveQuotePatch, ...extra });

  it('a patch overwrites only the fields it carries', () => {
    const prev = cell({ ltp: 100, oi: 5000, prevOi: 4000, volume: 10 }, { streamTs: T0 });
    const next = mergeCell(prev, { key, ts: T0 + 1000, ltp: 101, ltt: T0 + 900 }, rules());
    expect(next.q).toMatchObject({ ltp: 101, ltt: T0 + 900, oi: 5000, prevOi: 4000, volume: 10, ts: T0 + 1000 });
  });

  it('a book-carrying update clears a side the exchange emptied and drops depth it no longer sends', () => {
    const prev = cell({ ltp: 100, bid: 99.95, ask: 100.05, bidQty: 75, askQty: 150, depth: { bids: [{ price: 99.95, qty: 75 }], asks: [{ price: 100.05, qty: 150 }] } }, { bookTs: T0 });
    // SFeed market picture: bid keys present but undefined (side empty), no depth (level 4).
    const next = mergeCell(prev, { key, ts: T0 + 500, ltp: 100.1, bid: undefined, bidQty: undefined, ask: 100.15, askQty: 300 }, rules({ book: true }));
    expect(next.q.bid).toBeUndefined();
    expect('bid' in next.q).toBe(false);
    expect(next.q.bidQty).toBeUndefined();
    expect(next.q.ask).toBe(100.15);
    expect(next.q.depth).toBeUndefined();
    expect(next.bookTs).toBe(T0 + 500);
  });

  it('a REST quote with an empty book clears the cached book (book fields absent = empty)', () => {
    const prev = cell({ ltp: 100, bid: 99.95, ask: 100.05 }, { bookTs: T0 });
    const next = mergeCell(prev, { key, ts: T0 + 20_000, ltp: 100.2 }, rules({ book: true, stream: false }));
    expect(next.q.bid).toBeUndefined();
    expect(next.q.ask).toBeUndefined();
  });

  it('an update without a book keeps a fresh book and drops one older than bookMaxAgeMs', () => {
    const prev = cell({ ltp: 100, bid: 99.95, ask: 100.05 }, { bookTs: T0 });
    expect(mergeCell(prev, { key, ts: T0 + 5_000, ltp: 100.1 }, rules()).q.bid).toBe(99.95);
    const late = mergeCell(prev, { key, ts: T0 + 11_000, ltp: 100.1 }, rules());
    expect(late.q.bid).toBeUndefined();
    expect(late.q.ask).toBeUndefined();
    expect(late.q.ltp).toBe(100.1);
  });

  it('an older patch only fills fields the quote does not have', () => {
    const prev = cell({ ltp: 100, oi: 5000 }, { streamTs: T0 });
    const next = mergeCell(prev, { key, ts: T0 - 5_000, ltp: 98, oi: 4800, prevOi: 4000 }, rules());
    expect(next.q).toMatchObject({ ltp: 100, oi: 5000, prevOi: 4000, ts: T0 });
  });

  it('REST data while the stream is fresh only fills gaps (prevOi), never the streamed price', () => {
    const prev = cell({ ltp: 100, oi: 5000, bid: 99.95 }, { streamTs: T0, bookTs: T0 });
    const next = mergeCell(prev, { key, ts: T0 + 2_000, ltp: 99, oi: 4900, prevOi: 4500 }, rules({ stream: false, book: false }));
    expect(next.q).toMatchObject({ ltp: 100, oi: 5000, prevOi: 4500, bid: 99.95 });
  });

  it("a new session date starts the quote afresh (no yesterday's prevOi or book)", () => {
    const prev = cell({ ltp: 100, prevOi: 4000, bid: 99.9 }, { bookTs: T0, streamTs: T0 });
    const next = mergeCell(prev, { key, ts: T0 + 86_400_000, ltp: 105 }, rules());
    expect(next.q).toEqual({ key, ts: T0 + 86_400_000, ltp: 105 });
    // ... and an older-day patch after today's quote changes nothing.
    expect(mergeCell(next, { key, ts: T0, ltp: 1, prevOi: 1 }, rules())).toBe(next);
  });
});

describe('KotakLiveMarket quotes', () => {
  it('stream patches merge into one quote; a cleared bid never survives; listeners get every update', async () => {
    const h = harness();
    const s = await connect(h);
    h.market.watch([ce(25000)]);
    await flush(2);
    const ticks: LiveQuote[] = [];
    h.market.onTick((q) => ticks.push(q));
    h.market.onTick(() => {
      throw new Error('a broken listener');
    });
    s.bin(mp(tok(ce(25000)), { ltp: 120.5, ts: T0, bid: 120.45, ask: 120.55, oi: 90_000 }));
    expect(h.market.quote(ce(25000))).toMatchObject({ ltp: 120.5, bid: 120.45, ask: 120.55, oi: 90_000 });
    s.bin(mp(tok(ce(25000)), { ltp: 120.6, ts: T0 + 1000, ask: 120.65 }));
    const q = h.market.quote(ce(25000))!;
    expect(q.ltp).toBe(120.6);
    expect(q.bid).toBeUndefined();
    expect(q.bidQty).toBeUndefined();
    expect(q.ask).toBe(120.65);
    expect(ticks.map((t) => t.ltp)).toEqual([120.5, 120.6]);
    // lastTickTs is the local receive time of the last packet.
    expect(h.market.health()).toMatchObject({ loggedIn: true, connected: true, lastTickTs: T0 });
  });

  it('keeps no quote until a real LTP is known (OI from REST first, LTP from the stream later)', async () => {
    const h = harness({}, (p) => {
      if (p.includes('option-chain')) return chainBody(NIFTY_W1, [{ key: ce(26000), oi: 1500, prevOi: 1200 }]);
      if (p.includes('quotes')) return [quoteRow('nse_cm', 'Nifty 50', 25000, T0)];
      throw new Error(p);
    });
    await expect(h.market.chain('NIFTY', NIFTY_W1)).rejects.toThrow(NoLiveData);
    expect(h.market.quote(ce(26000))).toBeUndefined();
    const s = await connect(h);
    h.market.watch([ce(26000)]);
    await flush(2);
    s.bin(mp(tok(ce(26000)), { ltp: 3.2, ts: T0 + 2000, oi: 1600 }));
    expect(h.market.quote(ce(26000))).toMatchObject({ ltp: 3.2, oi: 1600, prevOi: 1200 });
  });

  it('refresh(): REST quotes merged, an index answered by its numeric token mapped back, placeholders dropped', async () => {
    const h = harness({}, (p) => {
      expect(p).toContain('script-details/1.0/quotes/neosymbol/');
      expect(decodeURIComponent(p)).toContain('nse_cm|Nifty 50');
      return [
        { ...quoteRow('nse_cm', '26000', 25010.5, T0), last_volume: '0', total_buy: '0', total_sell: '0', depth: { buy: [], sell: [] } },
        quoteRow('nse_cm', '2885', 1402.3, T0, { open_int: '0' }),
      ];
    });
    const ticks: LiveQuote[] = [];
    h.market.onTick((q) => ticks.push(q));
    const got = await h.market.refresh([SPOT, { symbol: 'reliance', kind: 'SPOT' }]);
    expect([...got.keys()].sort()).toEqual([keyId(SPOT), keyId({ symbol: 'RELIANCE', kind: 'SPOT' })].sort());
    const n = got.get(keyId(SPOT))!;
    expect(n.ltp).toBe(25010.5);
    expect(n.volume).toBeUndefined();
    expect(n.totalBuyQty).toBeUndefined();
    expect(n.bid).toBeUndefined();
    expect(got.get(keyId({ symbol: 'RELIANCE', kind: 'SPOT' }))).toMatchObject({ ltp: 1402.3, bid: 1402.25, ask: 1402.35, volume: 50000 });
    expect(ticks).toHaveLength(2);
  });

  it('refresh() of keys the master does not list fails with NoLiveData and makes no call', async () => {
    const h = harness();
    await expect(h.market.refresh([ce(25025)])).rejects.toThrow(/Not in the instrument master/);
    expect(h.fr.calls).toHaveLength(0);
  });

  it('without REST every REST path says why', async () => {
    const h = harness({ rest: null, restUnavailable: 'Kotak credentials missing in .env: NEO_MPIN' });
    await expect(h.market.refresh([SPOT])).rejects.toThrow('Kotak credentials missing in .env: NEO_MPIN');
    await expect(h.market.chain('NIFTY', NIFTY_W1)).rejects.toThrow('Kotak credentials missing in .env: NEO_MPIN');
  });
});

describe('KotakLiveMarket subscriptions', () => {
  const pinned = (): WatchEntry[] => [
    { key: SPOT, tier: 'index' },
    { key: { symbol: 'INDIAVIX', kind: 'SPOT' }, tier: 'index' },
    { key: FUT, tier: 'underlying' },
    { key: { symbol: 'RELIANCE', kind: 'SPOT' }, tier: 'underlying', level: 'depth' },
    ...[25000, 25050, 24950, 25100].flatMap((k) => [
      { key: ce(k), tier: 'chain' as const },
      { key: pe(k), tier: 'chain' as const },
    ]),
  ];

  it('maps keys to (segment, token, intent): indices by name, the level picks the intent', async () => {
    const h = harness();
    const s = await connect(h);
    h.market.setPinned(pinned().slice(0, 4));
    h.market.watch([{ symbol: 'INFY', kind: 'SPOT' }], 'ltp');
    await flush(2);
    const sub = subs(s);
    expect([...sub.index].sort()).toEqual(['nse_cm|INDIA VIX', 'nse_cm|Nifty 50']);
    expect([...sub.scrips]).toEqual(['nse_fo|52010']);
    expect([...sub.depth]).toEqual(['nse_cm|2885']);
    expect([...sub.lite]).toEqual(['nse_cm|1594']);
  });

  it('cuts at the budget by priority: index > user > underlying > chain (nearest first) > ad-hoc', async () => {
    const h = harness({ tokenBudget: 8 });
    const s = await connect(h);
    h.market.watch([{ symbol: 'INFY', kind: 'SPOT' }]);
    h.market.setPinned([...pinned(), { key: ce(25000, NIFTY_W2), tier: 'user' }]);
    await flush(2);
    const all = Object.values(subs(s)).flatMap((x) => [...x]);
    expect(all).toHaveLength(8);
    expect(all).toContain('nse_cm|Nifty 50');
    expect(all).toContain(`nse_fo|${tok(ce(25000, NIFTY_W2))}`); // user tier
    expect(all).toContain(`nse_fo|${tok(ce(25000))}`); // nearest chain strikes stay
    expect(all).not.toContain(`nse_fo|${tok(ce(25100))}`); // far chain strikes go first
    expect(all).not.toContain('nse_cm|1594'); // ad-hoc last
    const d = h.market.details().subscriptions;
    expect(d.dropped.count).toBe(6); // 25050 PE, 24950 CE/PE, 25100 CE/PE, INFY
    expect(d.dropped.examples).toHaveLength(5);
    expect(d.dropped.examples[0]).toBe(`${keyId(pe(25050))} (chain)`);
    expect(h.market.isStreamed(ce(25000))).toBe(true);
    expect(h.market.isStreamed(ce(25100))).toBe(false);
  });

  it('ad-hoc watches: least recently used evicted over budget, released after their TTL', async () => {
    const h = harness({ tokenBudget: 4 });
    const s = await connect(h);
    h.market.setPinned(pinned().slice(0, 2));
    const A: InstrumentKey = { symbol: 'RELIANCE', kind: 'SPOT' };
    const B: InstrumentKey = { symbol: 'INFY', kind: 'SPOT' };
    const C = FUT;
    h.market.watch([A]);
    await h.timers.advance(1000);
    h.market.watch([B]);
    await h.timers.advance(1000);
    h.market.watch([C], 'quote', 10_000);
    await flush(2);
    let all = Object.values(subs(s)).flatMap((x) => [...x]);
    expect(all).toContain('nse_cm|1594'); // B
    expect(all).toContain('nse_fo|52010'); // C
    expect(all).not.toContain('nse_cm|2885'); // A: least recently used
    h.market.watch([A]); // touched again
    await flush(2);
    all = Object.values(subs(s)).flatMap((x) => [...x]);
    expect(all).toContain('nse_cm|2885');
    expect(all).not.toContain('nse_cm|1594');
    await h.timers.advance(11_000); // C's 10 s TTL
    all = Object.values(subs(s)).flatMap((x) => [...x]);
    expect(all).not.toContain('nse_fo|52010');
    expect(all).toContain('nse_cm|1594'); // B is back within the budget
    await h.timers.advance(120_000); // default 2 min TTL
    all = Object.values(subs(s)).flatMap((x) => [...x]);
    expect(all.sort()).toEqual(['nse_cm|INDIA VIX', 'nse_cm|Nifty 50']);
    expect(h.market.details().subscriptions.adhoc).toBe(0);
  });

  it('a key the instrument master does not list is reported, never subscribed', async () => {
    const h = harness();
    const s = await connect(h);
    h.market.watch([ce(25025), { symbol: 'NOSUCH', kind: 'SPOT' }]);
    await flush(2);
    expect(Object.values(subs(s)).every((x) => x.size === 0)).toBe(true);
    expect(h.market.details().subscriptions.unresolved).toEqual({ count: 2, examples: [keyId(ce(25025)), keyId({ symbol: 'NOSUCH', kind: 'SPOT' })] });
  });

  it('health(): not logged in → the session error; logged in without a feed → says so', () => {
    expect(harness({ sessionStatus: () => ({ loggedIn: false, error: 'Kotak login failed: Invalid TOTP' }) }).market.health()).toEqual({
      loggedIn: false,
      connected: false,
      lastTickTs: null,
      subscribed: 0,
      error: 'Kotak login failed: Invalid TOTP',
    });
    expect(harness().market.health().error).toBe('Live feed not started');
  });
});

describe('KotakLiveMarket chains', () => {
  const legs = [
    { key: ce(25000), ltp: 120.5, oi: 90_000, prevOi: 80_000 },
    { key: pe(25000), ltp: 110.25, oi: 85_000, prevOi: 70_000 },
    { key: ce(25050), ltp: 95.1, oi: 60_000, prevOi: 61_000 },
  ];
  const restHandler = (expiry: string, l = legs) => (p: string, opts: KotakRequestOptions) => {
    if (p.includes('option-chain')) {
      expect(opts.lane).toBe('slow');
      expect(opts.query).toMatchObject({ exchange: 'nse_fo', underlying: 'NIFTY', expiry, instrument_type: 'option', count: 40 });
      return chainBody(expiry, l.map((x) => ({ ...x, key: { ...x.key, expiry } })));
    }
    if (p.includes('quotes')) {
      const out: unknown[] = [quoteRow('nse_cm', 'Nifty 50', 25012.4, T0, { last_volume: '0', total_buy: '0', total_sell: '0' })];
      if (decodeURIComponent(p).includes('nse_fo|52010')) out.push(quoteRow('nse_fo', '52010', 25101.0, T0, { open_int: '1300000' }));
      return out;
    }
    throw new Error(p);
  };

  it('REST when not streamed: one option-chain call, spot over REST, no future for a weekly; cached', async () => {
    const h = harness({}, restHandler(NIFTY_W1));
    const c = await h.market.chain('nifty', NIFTY_W1);
    expect(c.symbol).toBe('NIFTY');
    expect(c.rows.map((r) => r.strike)).toEqual([25000, 25050]);
    expect(c.rows[0].ce).toMatchObject({ ltp: 120.5, oi: 90_000, prevOi: 80_000, prevClose: 100 });
    expect(c.rows[0].pe?.ltp).toBe(110.25);
    expect(c.rows[1].pe).toBeUndefined();
    expect(c.spot?.ltp).toBe(25012.4);
    expect(c.future).toBeUndefined(); // weekly: no same-expiry future listed
    expect(h.fr.calls.filter((x) => x.path.includes('option-chain'))).toHaveLength(1);
    await h.timers.advance(60_000);
    await h.market.chain('NIFTY', NIFTY_W1);
    expect(h.fr.calls.filter((x) => x.path.includes('option-chain'))).toHaveLength(1); // within the 90 s TTL
    await h.timers.advance(31_000);
    await h.market.chain('NIFTY', NIFTY_W1);
    expect(h.fr.calls.filter((x) => x.path.includes('option-chain'))).toHaveLength(2);
  });

  it('a monthly chain carries the same-expiry future', async () => {
    const h = harness({}, restHandler(MONTHLY, [{ key: ce(25000, MONTHLY), ltp: 300, oi: 1, prevOi: 1 }]));
    const c = await h.market.chain('NIFTY', MONTHLY);
    expect(c.future).toMatchObject({ key: FUT, ltp: 25101, oi: 1_300_000 });
  });

  it('streamed and fresh → built from the stream without REST; stale stream → REST', async () => {
    const h = harness({}, restHandler(NIFTY_W1));
    const s = await connect(h);
    h.market.setPinned([{ key: SPOT, tier: 'index' }, ...[ce(25000), pe(25000), ce(25050), pe(25050)].map((key) => ({ key, tier: 'chain' as const }))]);
    await flush(2);
    s.bin(encodeIndex({ exch: 1, token: 26000, name: 'NIFTY 50', value: 2_501_000, ltt: SEC(T0) }));
    s.bin(mp(tok(ce(25000)), { ltp: 121, ts: T0, bid: 120.95, ask: 121.05, oi: 91_000 }));
    s.bin(mp(tok(pe(25050)), { ltp: 140, ts: T0, bid: 139.9, ask: 140.1, oi: 50_000 }));
    const c = await h.market.chain('NIFTY', NIFTY_W1);
    expect(h.fr.calls).toHaveLength(0);
    expect(c.spot?.ltp).toBe(25010);
    expect(c.rows).toEqual([
      expect.objectContaining({ strike: 25000, ce: expect.objectContaining({ ltp: 121, bid: 120.95, oi: 91_000 }) }),
      expect.objectContaining({ strike: 25050, pe: expect.objectContaining({ ltp: 140 }) }),
    ]);
    expect(c.ts).toBe(T0);
    // No tick for longer than the freshness window: the next build goes to REST.
    await h.timers.advance(15_000);
    await h.market.chain('NIFTY', NIFTY_W1);
    expect(h.fr.calls.filter((x) => x.path.includes('option-chain'))).toHaveLength(1);
  });

  it('nothing live → NoLiveData; an unlisted expiry → 404', async () => {
    const h = harness({}, restHandler(NIFTY_W1, []));
    await expect(h.market.chain('NIFTY', NIFTY_W1)).rejects.toThrow(/No live quotes for the NIFTY 2026-10-13 option chain/);
    await expect(h.market.chain('NIFTY', '2026-10-14')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a REST failure still serves today\'s streamed legs; with none it is NoLiveData', async () => {
    const h = harness({}, () => {
      throw new NoLiveData('Kotak rate limit on option-chain; paused 60 s');
    });
    await expect(h.market.chain('NIFTY', NIFTY_W1)).rejects.toThrow(/rate limit/);
    const s = await connect(h);
    h.market.watch([ce(25000)]);
    await flush(2);
    s.bin(mp(tok(ce(25000)), { ltp: 121, ts: T0 }));
    await h.timers.advance(20_000); // the stream is no longer fresh
    const c = await h.market.chain('NIFTY', NIFTY_W1);
    expect(c.rows).toHaveLength(1);
    expect(c.rows[0].ce?.ltp).toBe(121);
  });
});

describe('KotakLiveMarket stock-option sweep', () => {
  const sweepRest = (calls: { symbol: string; at: number }[], timers: () => ManualTimers, fail?: string) => (p: string, opts: KotakRequestOptions) => {
    if (p.includes('option-chain')) {
      const underlying = String(opts.query?.underlying);
      calls.push({ symbol: underlying, at: timers().now() });
      if (underlying === fail) throw new NoLiveData(`Kotak option-chain failed for ${underlying}`);
      const k = underlying === 'RELIANCE' ? 1400 : 1500;
      const key = { symbol: underlying, kind: 'CE' as const, expiry: MONTHLY, strike: k };
      return {
        data: {
          common_data: { exSeg: 'nse_fo', unlSymbol: underlying, expiryDt: MONTHLY },
          call: [{ instrument: { neoSymbol: `nse_fo|${tok(key)}`, optionType: 'CE', strikePrice: String(k) }, quote: { ltp: '25.50', prevClose: '24' }, openInterest: { current: 500, previous: 450 } }],
          put: [],
        },
      };
    }
    if (p.includes('quotes')) return [];
    throw new Error(p);
  };

  it('one stock at a time, ≥ 1.5 s apart, sweeps continuously during the session', async () => {
    const calls: { symbol: string; at: number }[] = [];
    let timers!: ManualTimers;
    const h = harness({}, sweepRest(calls, () => timers));
    timers = h.timers;
    h.market.startSweep();
    await h.timers.advance(10_000);
    expect(calls.map((c) => c.symbol).slice(0, 4)).toEqual(['RELIANCE', 'INFY', 'RELIANCE', 'INFY']);
    for (let i = 1; i < calls.length; i++) expect(calls[i].at - calls[i - 1].at).toBeGreaterThanOrEqual(1500);
    const st = h.market.sweepStatus();
    expect(st.passes).toBeGreaterThanOrEqual(2);
    expect(st.lastFullPassAt).not.toBeNull();
    expect(st.paused).toBeNull();
    // The swept chain is served from the cache (no extra call).
    const n = calls.length;
    const c = await h.market.chain('RELIANCE', MONTHLY);
    expect(c.rows[0].ce).toMatchObject({ ltp: 25.5, oi: 500, prevOi: 450 });
    expect(calls).toHaveLength(n);
  });

  it('outside session hours: one pass after start, then paused', async () => {
    const calls: { symbol: string; at: number }[] = [];
    let timers!: ManualTimers;
    const h = harness({}, sweepRest(calls, () => timers), Date.parse(`${DAY}T14:30:00Z`)); // 20:00 IST
    timers = h.timers;
    h.market.startSweep();
    await h.timers.advance(10 * 60_000);
    expect(calls.map((c) => c.symbol)).toEqual(['RELIANCE', 'INFY']);
    expect(h.market.sweepStatus()).toMatchObject({ running: true, passes: 1, paused: 'outside session hours' });
  });

  it('failures are recorded and back off', async () => {
    const calls: { symbol: string; at: number }[] = [];
    let timers!: ManualTimers;
    const h = harness({}, sweepRest(calls, () => timers, 'INFY'));
    timers = h.timers;
    h.market.startSweep();
    await h.timers.advance(5_000);
    const st = h.market.sweepStatus();
    expect(st.recentFailures[0]).toMatchObject({ symbol: 'INFY', expiry: MONTHLY, error: 'Kotak option-chain failed for INFY' });
    // RELIANCE at 0, INFY at 1.5 s (fails) → next call 3 s later (2× spacing).
    expect(calls[2].at - calls[1].at).toBe(3000);
    h.market.stopSweep();
    const n = calls.length;
    await h.timers.advance(60_000);
    expect(calls).toHaveLength(n);
  });
});

describe('KotakLiveMarket: no quote of an older session is served as live (review)', () => {
  const REL: InstrumentKey = { symbol: 'RELIANCE', kind: 'SPOT' };
  /** 15:29 IST of the previous trading day (Friday). */
  const PREV = Date.parse('2026-10-09T09:59:00Z');

  it('during the session a quote last updated in an earlier session is hidden (quote, quotes, refresh)', async () => {
    const h = harness({}, () => [quoteRow('nse_cm', '2885', 1402.3, PREV)]);
    const got = await h.market.refresh([REL]);
    expect(got.size).toBe(0);
    expect(h.market.quote(REL)).toBeUndefined();
    expect(h.market.quotes([REL]).size).toBe(0);
  });

  it("outside market hours the last session's quote is served; from the open only today's", async () => {
    // Monday 08:30 IST (before pre-open): Friday's quote is the latest session.
    const h = harness({}, () => [quoteRow('nse_cm', '2885', 1402.3, PREV)], Date.parse(`${DAY}T03:00:00Z`));
    const got = await h.market.refresh([REL]);
    expect(got.get(keyId(REL))).toMatchObject({ ltp: 1402.3, ts: PREV, bid: 1402.25 });
    expect(h.market.quote(REL)).toMatchObject({ ltp: 1402.3, ts: PREV });
    await h.timers.advance(50 * 60_000); // 09:20 IST, no update today
    expect(h.market.quote(REL)).toBeUndefined();
  });
});
