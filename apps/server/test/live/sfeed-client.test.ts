import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import type { InstrumentKey } from '../../src/live/types';
import {
  SFeedClient,
  type LiveQuotePatch,
  type SFeedAuthError,
  type SFeedClientOptions,
  type SFeedHandlers,
  type SFeedMarketStatus,
  type SFeedQuoteMeta,
  type SFeedSocket,
  type SFeedSocketEvents,
  type SFeedSub,
} from '../../src/live/kotak/sfeed/client';
import {
  ACK_DOC,
  AUTH_1117,
  AUTH_1119,
  AUTH_1120,
  AUTH_FALLBACK,
  MP_L4_FIELDS,
  VEC_INDEX,
  VEC_MINI,
  VEC_MP_L4,
  VEC_STATUS,
  concat,
  encodeHeaderOnly,
  encodeIndex,
  encodeMarketPicture,
} from './fixtures/sfeed';

const SID = 'sid-5f1c2a77-secret';
const UCC = 'UCC9X';
const T0 = Date.parse('2026-10-12T04:00:00Z');

class FakeSocket implements SFeedSocket {
  sent: string[] = [];
  pings = 0;
  closeCalls: [number | undefined, string | undefined][] = [];
  terminated = false;
  constructor(
    readonly url: string,
    readonly on: SFeedSocketEvents,
  ) {}
  send(data: string): void {
    this.sent.push(data);
  }
  ping(): void {
    this.pings++;
  }
  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason]);
    this.on.close(code ?? 1005, reason ?? '');
  }
  terminate(): void {
    this.terminated = true;
  }
  /* server side */
  open(): void {
    this.on.open();
  }
  text(o: unknown): void {
    this.on.message(typeof o === 'string' ? o : JSON.stringify(o), false);
  }
  bin(b: Uint8Array): void {
    this.on.message(b, true);
  }
  drop(code = 1006, reason = ''): void {
    this.on.close(code, reason);
  }
  pong(): void {
    this.on.pong();
  }
  frames(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
  /** Control frames after the auth frame. */
  control(): Record<string, unknown>[] {
    return this.frames().slice(1);
  }
}

const NIFTY_CE: InstrumentKey = { symbol: 'NIFTY', kind: 'CE', expiry: '2026-10-20', strike: 25000 };
const NIFTY_SPOT: InstrumentKey = { symbol: 'NIFTY', kind: 'SPOT' };
const TCS: InstrumentKey = { symbol: 'TCS', kind: 'SPOT' };

function harness(over: Partial<SFeedClientOptions> = {}, handlerOver: Partial<SFeedHandlers> = {}) {
  const sockets: FakeSocket[] = [];
  const quotes: [LiveQuotePatch, SFeedQuoteMeta][] = [];
  const statuses: SFeedMarketStatus[] = [];
  const authErrors: SFeedAuthError[] = [];
  const logs: string[] = [];
  const keys = new Map<string, InstrumentKey>([
    ['nse_fo|44498', NIFTY_CE],
    ['nse_cm|Nifty 50', NIFTY_SPOT],
    ['nse_cm|11536', TCS],
    ['nse_cm|Nifty Bank', { symbol: 'BANKNIFTY', kind: 'SPOT' }],
    ['nse_cm|Nifty Fin Service', { symbol: 'FINNIFTY', kind: 'SPOT' }],
  ]);
  const log = (m: string) => logs.push(m);
  const client = new SFeedClient(
    {
      url: 'wss://feed.test/apifeed',
      sid: SID,
      ucc: UCC,
      resolve: (seg, tok) => keys.get(`${seg}|${tok}`),
      wsFactory: (url, on) => {
        const s = new FakeSocket(url, on);
        sockets.push(s);
        return s;
      },
      now: () => Date.now(),
      random: () => 0,
      logger: { debug: log, info: log, warn: log, error: log },
      ...over,
    },
    {
      onQuote: (p, m) => quotes.push([p, m]),
      onStatus: (s) => statuses.push(s),
      onAuthError: (e) => authErrors.push(e),
      ...handlerOver,
    },
  );
  const last = () => sockets[sockets.length - 1];
  return { client, sockets, last, quotes, statuses, authErrors, logs, keys };
}

const flush = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

async function connectAuthed(h: ReturnType<typeof harness>, auth: unknown = AUTH_1117) {
  h.client.connect();
  h.last().open();
  h.last().text(auth);
  await flush();
  return h.last();
}

const scrip = (token: string, intent: SFeedSub['intent'] = 'scrips', segment: SFeedSub['segment'] = 'nse_fo'): SFeedSub => ({ segment, token, intent });

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SFeedClient authentication', () => {
  it('sends the auth frame first and authenticates on 1117', async () => {
    const h = harness();
    h.client.connect();
    expect(h.sockets).toHaveLength(1);
    expect(h.last().url).toBe('wss://feed.test/apifeed');
    expect(h.last().sent).toEqual([]);
    h.last().open();
    expect(h.last().frames()[0]).toEqual({
      user: UCC,
      auth: SID,
      format: 'native_batch',
      source: 'NEOTRADEAPI',
      platform: 'Web',
      version: '1.2.3',
      sdk_version: 2,
      sdk_date: '2026-08-07T09:41:17.667Z',
      conn_req_time: T0,
      sessionValidation: false,
    });
    expect(h.client.health()).toEqual({ connected: true, authenticated: false, lastPacketTs: null, subscribed: 0, desired: 0 });
    h.last().text(AUTH_1117);
    expect(h.client.health()).toEqual({ connected: true, authenticated: true, lastPacketTs: null, subscribed: 0, desired: 0 });
    expect(Object.fromEntries(h.client.dividers())).toEqual({ 1: 100, 2: 100, 3: 10_000_000 });
  });

  it('treats 1119 as success only after the grace period (critic C9)', () => {
    const h = harness();
    h.client.connect();
    h.last().open();
    h.last().text(AUTH_1119);
    expect(h.client.health().authenticated).toBe(false);
    expect(Object.fromEntries(h.client.dividers())).toEqual({ 1: 100, 2: 100, 3: 10_000_000, 7: 10_000_000 });
    vi.advanceTimersByTime(2999);
    expect(h.client.health().authenticated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(h.client.health().authenticated).toBe(true);
    expect(h.authErrors).toEqual([]);
  });

  it('a late 1119 is an auth response: the 15 s timeout does not cut its grace short', () => {
    const h = harness();
    h.client.connect();
    h.last().open();
    vi.advanceTimersByTime(13_000);
    h.last().text(AUTH_1119);
    vi.advanceTimersByTime(2_999);
    expect(h.authErrors).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.client.health().authenticated).toBe(true);
    expect(h.authErrors).toEqual([]);
  });

  it('authenticates at once when 1117 follows 1119', () => {
    const h = harness();
    h.client.connect();
    h.last().open();
    h.last().text(AUTH_1119);
    h.last().text(AUTH_1117);
    expect(h.client.health().authenticated).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(h.client.health().authenticated).toBe(true);
  });

  it('fails on 1120 after 1119, drops the socket and retries with backoff', () => {
    const h = harness();
    h.client.connect();
    const s = h.last();
    s.open();
    s.text(AUTH_1119);
    s.text(AUTH_1120);
    expect(h.authErrors).toEqual([{ kind: 'rejected', message: 'Auth failed ...' }]);
    expect(s.terminated).toBe(true);
    vi.advanceTimersByTime(3000);
    const health = h.client.health();
    expect(health.authenticated).toBe(false);
    expect(health.connected).toBe(false);
    expect(health.error).toBe('SFeed auth failed (rejected): Auth failed ...');
    // random() = 0 → first delay is half of 1 s; 3 s have already passed so a new socket exists.
    expect(h.sockets).toHaveLength(2);
  });

  it('fails when the socket closes inside the 1119 grace window', () => {
    const h = harness();
    h.client.connect();
    h.last().open();
    h.last().text(AUTH_1119);
    h.last().drop(1008, 'policy');
    expect(h.authErrors).toEqual([{ kind: 'closed', message: 'socket closed before authentication (code 1008: policy)' }]);
    vi.advanceTimersByTime(3000);
    expect(h.sockets[0].terminated).toBe(true);
    expect(h.client.health().authenticated).toBe(false);
  });

  it('times out after 15 s without an auth response', () => {
    const h = harness();
    h.client.connect();
    h.last().open();
    vi.advanceTimersByTime(14_999);
    expect(h.authErrors).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.authErrors).toEqual([{ kind: 'timeout', message: 'no auth response within 15000 ms' }]);
    expect(h.sockets[0].terminated).toBe(true);
  });

  it('rejects a native_fallback downgrade', () => {
    const h = harness();
    h.client.connect();
    h.last().open();
    h.last().text(AUTH_FALLBACK);
    expect(h.authErrors.map((e) => e.kind)).toEqual(['fallback']);
    expect(h.client.health().authenticated).toBe(false);
  });

  it('treats an error frame before auth as a rejection', () => {
    const h = harness();
    h.client.connect();
    h.last().open();
    h.last().text({ stat: 'Not_Ok', emsg: 'Invalid session' });
    expect(h.authErrors).toEqual([{ kind: 'rejected', message: 'Invalid session' }]);
  });

  it('reconnects at once with fresh credentials supplied from onAuthError', () => {
    let client: SFeedClient | null = null;
    const h = harness({}, { onAuthError: () => client?.updateSession({ sid: 'sid-new', ucc: UCC }) });
    client = h.client;
    h.client.connect();
    h.last().open();
    h.last().text(AUTH_1120);
    expect(h.sockets).toHaveLength(2);
    h.last().open();
    expect(h.last().frames()[0]).toMatchObject({ user: UCC, auth: 'sid-new' });
    h.last().text(AUTH_1117);
    expect(h.client.health()).toMatchObject({ authenticated: true });
    expect(h.client.health().error).toBeUndefined();
  });

  it('paces reconnects when every fresh session is rejected too (no re-login loop)', () => {
    let n = 0;
    let client: SFeedClient | null = null;
    const h = harness({}, { onAuthError: () => client?.updateSession({ sid: `sid-${++n}`, ucc: UCC }) });
    client = h.client;
    h.client.connect();
    h.last().open();
    h.last().text(AUTH_1120);
    // First failure: immediate reconnect with the new sid.
    expect(h.sockets).toHaveLength(2);
    h.last().open();
    h.last().text(AUTH_1120);
    // Second failure in a row: the new sid waits for the backoff (random 0 → 1 s), no tight loop.
    expect(h.sockets).toHaveLength(2);
    vi.advanceTimersByTime(999);
    expect(h.sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(h.sockets).toHaveLength(3);
    h.last().open();
    expect(h.last().frames()[0]).toMatchObject({ auth: 'sid-2' });
    h.last().text(AUTH_1120);
    vi.advanceTimersByTime(1999);
    expect(h.sockets).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(h.sockets).toHaveLength(4);
    expect(n).toBe(3);
  });

  it('keeps an authenticated feed when the session is refreshed, unless asked to reconnect', async () => {
    const h = harness();
    await connectAuthed(h);
    h.client.updateSession({ sid: 'sid-2', ucc: UCC });
    expect(h.sockets).toHaveLength(1);
    h.client.updateSession({ sid: 'sid-3', ucc: UCC }, { reconnect: true });
    expect(h.sockets).toHaveLength(2);
    h.last().open();
    expect(h.last().frames()[0]).toMatchObject({ auth: 'sid-3' });
  });

  it('never writes the sid or the UCC to the log', async () => {
    const h = harness();
    h.client.connect();
    h.last().open();
    h.last().text({ message_code: 1120, message: `Auth failed for ${UCC} / ${SID}` });
    vi.advanceTimersByTime(1000);
    h.last().open();
    h.last().text(AUTH_1117);
    h.client.subscribe([scrip('44498')]);
    await flush();
    // Server close reasons are redacted too (they reach the log and health().error).
    h.last().drop(4001, `session ${SID} of ${UCC} expired`);
    expect(h.authErrors[0].message).toBe('Auth failed for *** / ***');
    expect(h.client.health().error).toBe('SFeed disconnected (code 4001: session *** of *** expired)');
    expect(h.logs.length).toBeGreaterThan(3);
    for (const line of h.logs) {
      expect(line).not.toContain(SID);
      expect(line).not.toContain(UCC);
    }
  });

  it('requires credentials', () => {
    expect(() => new SFeedClient({ url: 'wss://x', sid: '', ucc: UCC, resolve: () => undefined }, { onQuote: () => {} })).toThrow();
  });
});

describe('SFeedClient subscriptions', () => {
  it('replays the desired set after auth, grouped by intent and batched, with ack_symbol', async () => {
    const h = harness({ batchSize: 2 });
    h.client.subscribe([scrip('1'), scrip('2'), scrip('Nifty 50', 'index', 'nse_cm'), scrip('3'), scrip('9', 'depth')]);
    const s = await connectAuthed(h);
    expect(s.control()).toEqual([
      { event: 'subscribeIndices', inputtoken: 'nse_cm|Nifty 50', ack_symbol: true },
      { event: 'subscribeScrips', inputtoken: 'nse_fo|1,nse_fo|2', ack_symbol: true },
      { event: 'subscribeScrips', inputtoken: 'nse_fo|3', ack_symbol: true },
      { event: 'subscribeDepth', inputtoken: 'nse_fo|9', ack_symbol: true },
    ]);
    expect(h.client.health()).toMatchObject({ subscribed: 5, desired: 5 });
  });

  it('coalesces changes made in the same tick into one frame', async () => {
    const h = harness();
    const s = await connectAuthed(h);
    h.client.subscribe([scrip('1')]);
    h.client.subscribe([scrip('2')]);
    h.client.unsubscribe([scrip('1')]);
    h.client.subscribe([scrip('3')]);
    expect(s.control()).toEqual([]);
    await flush();
    expect(s.control()).toEqual([{ event: 'subscribeScrips', inputtoken: 'nse_fo|2,nse_fo|3', ack_symbol: true }]);
  });

  it('enforces the budget per (token, intent) and frees it on unsubscribe (critic C8)', async () => {
    const h = harness({ maxSubscriptions: 3 });
    const s = await connectAuthed(h);
    const r = h.client.subscribe([scrip('1'), scrip('1', 'depth'), scrip('2'), scrip('3')]);
    expect(r.accepted).toEqual([scrip('1'), scrip('1', 'depth'), scrip('2')]);
    expect(r.rejected).toEqual([{ sub: scrip('3'), reason: 'budget' }]);
    // Re-subscribing a held pair does not count twice.
    expect(h.client.subscribe([scrip('2')]).rejected).toEqual([]);
    await flush();
    expect(h.client.health()).toMatchObject({ subscribed: 3, desired: 3 });
    h.client.unsubscribe([scrip('1', 'depth')]);
    expect(h.client.subscribe([scrip('3')]).accepted).toEqual([scrip('3')]);
    await flush();
    expect(s.control().slice(-2)).toEqual([
      { event: 'unsubscribeDepth', inputtoken: 'nse_fo|1' },
      { event: 'subscribeScrips', inputtoken: 'nse_fo|3', ack_symbol: true },
    ]);
    expect(h.logs.some((l) => l.includes('budget of 3 reached'))).toBe(true);
  });

  it('defaults the budget to 2700 pairs', () => {
    const h = harness();
    const subs = Array.from({ length: 2701 }, (_, i) => scrip(String(10_000 + i)));
    const r = h.client.subscribe(subs);
    expect(r.accepted).toHaveLength(2700);
    expect(r.rejected).toEqual([{ sub: subs[2700], reason: 'budget' }]);
  });

  it('never lets the budget exceed the 3000-token server limit', () => {
    const h = harness({ maxSubscriptions: 5000 });
    const r = h.client.subscribe(Array.from({ length: 3001 }, (_, i) => scrip(String(10_000 + i))));
    expect(r.accepted).toHaveLength(3000);
    expect(r.rejected.map((x) => x.reason)).toEqual(['budget']);
  });

  it('rejects invalid subscriptions', () => {
    const h = harness();
    const bad = [scrip('1,2'), scrip('a|b'), { segment: 'cde_fo', token: '1', intent: 'scrips' } as unknown as SFeedSub, { segment: 'nse_fo', token: '1', intent: 'full' } as unknown as SFeedSub];
    const r = h.client.subscribe(bad);
    expect(r.accepted).toEqual([]);
    expect(r.rejected.map((x) => x.reason)).toEqual(['invalid', 'invalid', 'invalid', 'invalid']);
    expect(h.client.health().desired).toBe(0);
  });

  it('setDesired sends only the diff, unsubscribes first', async () => {
    const h = harness();
    h.client.setDesired([scrip('1'), scrip('2'), scrip('3')]);
    const s = await connectAuthed(h);
    const before = s.sent.length;
    h.client.setDesired([scrip('2'), scrip('3'), scrip('4')]);
    await flush();
    expect(s.frames().slice(before)).toEqual([
      { event: 'unsubscribeScrips', inputtoken: 'nse_fo|1' },
      { event: 'subscribeScrips', inputtoken: 'nse_fo|4', ack_symbol: true },
    ]);
    expect(h.client.desired()).toEqual([scrip('2'), scrip('3'), scrip('4')]);
    expect(h.client.setDesired([scrip('5'), scrip('6')]).accepted).toHaveLength(2);
  });

  it('setDesired keeps the first entries within the budget', () => {
    const h = harness({ maxSubscriptions: 2 });
    const r = h.client.setDesired([scrip('1'), scrip('1'), scrip('2'), scrip('3')]);
    expect(r.accepted).toEqual([scrip('1'), scrip('1'), scrip('2')]);
    expect(r.rejected).toEqual([{ sub: scrip('3'), reason: 'budget' }]);
  });

  it('resubscribes everything (and market status) after a reconnect', async () => {
    const h = harness({ marketStatus: true });
    h.client.subscribe([scrip('1'), scrip('Nifty 50', 'index', 'nse_cm')]);
    const s1 = await connectAuthed(h);
    expect(s1.control()).toEqual([
      { event: 'subscribeIndices', inputtoken: 'nse_cm|Nifty 50', ack_symbol: true },
      { event: 'subscribeScrips', inputtoken: 'nse_fo|1', ack_symbol: true },
      { event: 'subscribeExchange' },
    ]);
    s1.drop(1006);
    expect(h.client.health()).toEqual({ connected: false, authenticated: false, lastPacketTs: null, subscribed: 0, desired: 2, error: 'SFeed disconnected (code 1006)' });
    vi.advanceTimersByTime(500);
    expect(h.sockets).toHaveLength(2);
    const s2 = h.last();
    s2.open();
    s2.text(AUTH_1117);
    expect(s2.control()).toEqual(s1.control());
    expect(h.client.health()).toEqual({ connected: true, authenticated: true, lastPacketTs: null, subscribed: 2, desired: 2 });
  });

  it('toggles the market-status stream', async () => {
    const h = harness();
    const s = await connectAuthed(h);
    h.client.setMarketStatus(true);
    await flush();
    h.client.setMarketStatus(false);
    await flush();
    expect(s.control()).toEqual([{ event: 'subscribeExchange' }, { event: 'unsubscribeExchange' }]);
  });

  it('sends snapshots only when authenticated and outside the budget', async () => {
    const h = harness({ maxSubscriptions: 1 });
    expect(h.client.snapshot([scrip('11536', 'scrips', 'nse_cm')])).toBe(false);
    const s = await connectAuthed(h);
    expect(h.client.snapshot([scrip('11536', 'scrips', 'nse_cm'), scrip('26000', 'index', 'nse_cm')])).toBe(true);
    expect(s.control()).toEqual([
      { event: 'snapshotIndices', inputtoken: 'nse_cm|26000', ack_symbol: true },
      { event: 'snapshotScrips', inputtoken: 'nse_cm|11536', ack_symbol: true },
    ]);
    expect(h.client.health().subscribed).toBe(0);
    expect(h.client.snapshot([scrip('a,b')])).toBe(false);
  });

  it('records trading symbols from both 1109 ack shapes', async () => {
    const h = harness();
    const s = await connectAuthed(h);
    s.text(ACK_DOC);
    s.text({ message_code: 1109, trading_symbols: { 'nse_fo|44498': 'NIFTY20OCT2625000CE' } });
    expect(h.client.tradingSymbol('nse_cm', '1333')).toBe('HDFCBANK-EQ');
    expect(h.client.tradingSymbol('nse_fo', '44498')).toBe('NIFTY20OCT2625000CE');
  });
});

describe('SFeedClient reconnect and keepalive', () => {
  /** A connection attempt that fails before opening (e.g. ECONNREFUSED). */
  const failConnect = (s: FakeSocket) => {
    s.on.error(new Error('connect ECONNREFUSED'));
    s.drop(1006);
  };

  it('backs off exponentially with jitter up to the 60 s cap', () => {
    const h = harness();
    h.client.connect();
    const delays = [500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000];
    for (const d of delays) {
      const n = h.sockets.length;
      failConnect(h.last());
      expect(h.client.health().error).toBe('SFeed socket error: connect ECONNREFUSED');
      vi.advanceTimersByTime(d - 1);
      expect(h.sockets).toHaveLength(n);
      vi.advanceTimersByTime(1);
      expect(h.sockets).toHaveLength(n + 1);
    }
  });

  it('jitter tops out at the cap', () => {
    const h = harness({ random: () => 0.999999 });
    h.client.connect();
    for (let i = 0; i < 9; i++) {
      failConnect(h.last());
      vi.advanceTimersByTime(60_000);
    }
    const n = h.sockets.length;
    failConnect(h.last());
    vi.advanceTimersByTime(59_999);
    expect(h.sockets).toHaveLength(n);
    vi.advanceTimersByTime(1);
    expect(h.sockets).toHaveLength(n + 1);
  });

  it('resets the backoff only after a stable connection', () => {
    const h = harness();
    h.client.connect();
    failConnect(h.last());
    vi.advanceTimersByTime(500);
    failConnect(h.last());
    vi.advanceTimersByTime(1000);
    // Authenticated but dropped at once (flapping): the backoff keeps growing.
    h.last().open();
    h.last().text(AUTH_1117);
    h.last().drop();
    vi.advanceTimersByTime(1999);
    expect(h.sockets).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(h.sockets).toHaveLength(4);
    // Stable for 30 s: the next delay starts again at 500 ms.
    h.last().open();
    h.last().text(AUTH_1117);
    vi.advanceTimersByTime(30_000);
    h.last().pong();
    h.last().drop();
    vi.advanceTimersByTime(500);
    expect(h.sockets).toHaveLength(5);
  });

  it('pings every 20 s and drops a socket that stops answering', async () => {
    const h = harness();
    const s = await connectAuthed(h);
    vi.advanceTimersByTime(20_000);
    expect(s.pings).toBe(1);
    s.pong();
    vi.advanceTimersByTime(20_000);
    expect(s.pings).toBe(2);
    expect(s.terminated).toBe(false);
    vi.advanceTimersByTime(20_000);
    expect(s.terminated).toBe(true);
    expect(h.client.health()).toMatchObject({ connected: false, error: 'SFeed keepalive: no pong within 20000 ms' });
    vi.advanceTimersByTime(500);
    expect(h.sockets).toHaveLength(2);
  });

  it('counts incoming data as liveness', async () => {
    const h = harness();
    const s = await connectAuthed(h);
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(20_000);
      s.bin(VEC_STATUS);
    }
    expect(s.pings).toBe(5);
    expect(s.terminated).toBe(false);
  });

  it('gives up a handshake that never opens', () => {
    const h = harness();
    h.client.connect();
    vi.advanceTimersByTime(15_000);
    expect(h.sockets[0].terminated).toBe(true);
    expect(h.client.health().error).toBe('SFeed connect timeout after 15000 ms');
    vi.advanceTimersByTime(500);
    expect(h.sockets).toHaveLength(2);
  });

  it('records a throwing socket factory and retries', () => {
    let calls = 0;
    const h = harness({
      wsFactory: () => {
        calls++;
        throw new Error('Invalid URL');
      },
    });
    h.client.connect();
    expect(h.client.health().error).toBe('SFeed connect failed: Invalid URL');
    vi.advanceTimersByTime(500);
    expect(calls).toBe(2);
  });

  it('closes cleanly and stays closed', async () => {
    const h = harness();
    const s = await connectAuthed(h);
    await h.client.close();
    expect(s.closeCalls).toEqual([[1000, 'client closing']]);
    expect(h.client.health()).toEqual({ connected: false, authenticated: false, lastPacketTs: null, subscribed: 0, desired: 0 });
    vi.advanceTimersByTime(120_000);
    expect(h.sockets).toHaveLength(1);
    expect(h.authErrors).toEqual([]);
    // It can be started again.
    h.client.connect();
    expect(h.sockets).toHaveLength(2);
  });

  it('close() during the handshake does not report an auth failure', async () => {
    const h = harness();
    h.client.connect();
    h.last().open();
    await h.client.close();
    expect(h.authErrors).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(h.sockets).toHaveLength(1);
  });

  it('close() falls back to terminate when no close event arrives', async () => {
    const h = harness();
    await connectAuthed(h);
    const s = h.last();
    s.close = (code, reason) => {
      s.closeCalls.push([code, reason]);
    };
    const done = h.client.close();
    vi.advanceTimersByTime(2000);
    await done;
    expect(s.terminated).toBe(true);
    expect(h.client.health().connected).toBe(false);
  });

  it('close() during the handshake ignores late auth frames and timers while the close is in flight', async () => {
    // A real `ws` socket reports its close event asynchronously; frames and timers can fire meanwhile.
    for (const late of ['1120', 'timeout', '1119'] as const) {
      const h = harness();
      h.client.subscribe([scrip('1')]);
      h.client.connect();
      const s = h.last();
      s.close = (code, reason) => {
        s.closeCalls.push([code, reason]);
      };
      s.open();
      // 1119 grace ends at 3 s and the auth timeout at 15 s: both fall inside the 2 s close window.
      if (late === '1119') s.text(AUTH_1119);
      vi.advanceTimersByTime(late === '1119' ? 2_500 : 14_000);
      const done = h.client.close();
      if (late === '1120') s.text(AUTH_1120);
      vi.advanceTimersByTime(1_999);
      expect(h.authErrors).toEqual([]);
      expect(h.client.health().authenticated).toBe(false);
      expect(s.control()).toEqual([]);
      vi.advanceTimersByTime(1);
      await done;
      vi.advanceTimersByTime(60_000);
      expect(h.authErrors).toEqual([]);
      expect(h.sockets).toHaveLength(1);
    }
  });

  it('connect() right after an un-awaited close() finishes that close first', async () => {
    const h = harness();
    const s1 = await connectAuthed(h);
    s1.close = (code, reason) => {
      s1.closeCalls.push([code, reason]);
    };
    let closed = false;
    void h.client.close().then(() => (closed = true));
    h.client.connect();
    await flush();
    expect(closed).toBe(true);
    expect(s1.terminated).toBe(true);
    expect(h.sockets).toHaveLength(2);
    h.last().open();
    h.last().text(AUTH_1117);
    expect(h.client.health()).toMatchObject({ connected: true, authenticated: true });
  });

  it('ignores events from a replaced socket', async () => {
    const h = harness();
    const s1 = await connectAuthed(h);
    s1.drop();
    vi.advanceTimersByTime(500);
    s1.text(AUTH_1117);
    s1.bin(VEC_MINI);
    s1.drop();
    expect(h.quotes).toEqual([]);
    expect(h.sockets).toHaveLength(2);
    expect(h.client.health().authenticated).toBe(false);
  });
});

describe('SFeedClient packets → LiveQuote patches', () => {
  it('maps a level-4 option packet', async () => {
    const h = harness();
    const s = await connectAuthed(h);
    s.bin(VEC_MP_L4);
    expect(h.quotes).toEqual([
      [
        {
          key: NIFTY_CE,
          ts: 1234567891_000,
          ltp: 1500.5,
          ltt: 1234567890_000,
          prevClose: 1490,
          open: 1500,
          high: 1510,
          low: 1480,
          ltq: 10,
          atp: 1500.25,
          volume: 50000,
          totalBuyQty: 1000,
          totalSellQty: 2000,
          oi: 500,
          turnover: 12345.67,
          upperCircuit: 1650,
          lowerCircuit: 1350,
          bid: 1500,
          bidQty: 100,
          ask: 1501,
          askQty: 101,
        },
        { segment: 'nse_fo', token: '44498', packet: 'marketPicture', level: 4, receivedAt: T0 },
      ],
    ]);
    expect(h.client.health().lastPacketTs).toBe(T0);
  });

  it('maps level-8 depth and leaves out empty levels', async () => {
    const h = harness();
    const s = await connectAuthed(h);
    s.bin(
      encodeMarketPicture({
        ...MP_L4_FIELDS,
        level: 8,
        buyCount: 3,
        sellCount: 3,
        rows: [[100, 150000, 5], [50, 149995, 2], [0, 0, 0], [101, 150100, 6], [0, 0, 0], [0, 0, 0]],
      }),
    );
    const [patch] = h.quotes[0];
    expect(patch.depth).toEqual({
      bids: [
        { qty: 100, price: 1500, orders: 5 },
        { qty: 50, price: 1499.95, orders: 2 },
      ],
      asks: [{ qty: 101, price: 1501, orders: 6 }],
    });
    expect([patch.bid, patch.ask]).toEqual([1500, 1501]);
  });

  it('leaves out zero prices instead of reporting ₹0, keeps real zero quantities', async () => {
    const h = harness();
    const s = await connectAuthed(h);
    s.bin(encodeMarketPicture({ ...MP_L4_FIELDS, ltp: 0, open: 0, high: 0, low: 0, atp: 0, ltq: 0, vol: 0, ttv: 0, oi: 0, ltt: 0, lut: -2209008600, rows: [[0, 0, 0], [0, 0, 0]] }));
    const [patch] = h.quotes[0];
    expect(patch).toEqual({ key: NIFTY_CE, ts: T0, prevClose: 1490, volume: 0, totalBuyQty: 1000, totalSellQty: 2000, oi: 0, upperCircuit: 1650, lowerCircuit: 1350 });
  });

  it('clears the best bid/ask when that side of the book empties (no stale quote on merge)', async () => {
    const h = harness();
    const s = await connectAuthed(h);
    s.bin(VEC_MP_L4);
    s.bin(encodeMarketPicture({ ...MP_L4_FIELDS, rows: [[0, 0, 0], [101, 150100, 6]] }));
    const [first] = h.quotes[0];
    const [second] = h.quotes[1];
    expect(Object.keys(second)).toEqual(expect.arrayContaining(['bid', 'bidQty', 'ask', 'askQty']));
    const merged = { ...first, ...second };
    expect([merged.bid, merged.bidQty, merged.ask, merged.askQty]).toEqual([undefined, undefined, 1501, 101]);
    // Mini and index packets carry no book: they must not clear it.
    s.bin(VEC_MINI);
    expect(Object.keys(h.quotes[2][0])).not.toContain('bid');
  });

  it('has no OI for the cash segment', async () => {
    const h = harness();
    const s = await connectAuthed(h);
    s.bin(encodeMarketPicture({ ...MP_L4_FIELDS, exch: 1, token: 11536 }));
    const [patch, meta] = h.quotes[0];
    expect(patch.key).toEqual(TCS);
    expect(patch.oi).toBeUndefined();
    expect(meta.segment).toBe('nse_cm');
  });

  it('maps a mini touch-line packet', async () => {
    const h = harness();
    const s = await connectAuthed(h);
    s.bin(VEC_MINI);
    expect(h.quotes).toEqual([
      [
        { key: TCS, ts: 1756636800_000, ltp: 1234.56, ltt: 1756636800_000, prevClose: 1220, ltq: 50 },
        { segment: 'nse_cm', token: '11536', packet: 'mini', receivedAt: T0 },
      ],
    ]);
  });

  it('resolves an index subscribed by name through the packet name (critic C7)', async () => {
    const h = harness();
    h.client.subscribe([scrip('Nifty 50', 'index', 'nse_cm')]);
    const s = await connectAuthed(h);
    s.bin(VEC_INDEX);
    expect(h.quotes).toEqual([
      [
        { key: NIFTY_SPOT, ts: 1234567890_000, ltp: 20050, ltt: 1234567890_000, prevClose: 19900, open: 20000, high: 20100, low: 19800 },
        { segment: 'nse_cm', token: '26000', packet: 'index', receivedAt: T0 },
      ],
    ]);
    expect(h.client.indexName('nse_cm', '26000')).toBe('Nifty 50');
  });

  it('learns an index from the 1109 ack symbol when the names differ', async () => {
    const h = harness();
    h.client.subscribe([scrip('Nifty Fin Service', 'index', 'nse_cm'), scrip('Nifty 50', 'index', 'nse_cm')]);
    const s = await connectAuthed(h);
    s.text({ message_code: 1109, data: { 'nse_cm|Nifty Fin Service': { trading_symbols: 'FINNIFTY' } } });
    s.bin(encodeIndex({ token: 26037, name: 'FINNIFTY', value: 2_400_000 }));
    expect(h.quotes[0][0]).toMatchObject({ key: { symbol: 'FINNIFTY', kind: 'SPOT' }, ltp: 24000 });
  });

  it('falls back to the known NSE index tokens only for subscribed names', async () => {
    const h = harness();
    h.client.subscribe([scrip('Nifty Bank', 'index', 'nse_cm')]);
    const s = await connectAuthed(h);
    s.bin(encodeIndex({ token: 26009, name: '', value: 5_100_000 }));
    expect(h.quotes[0][0]).toMatchObject({ key: { symbol: 'BANKNIFTY', kind: 'SPOT' }, ltp: 51000 });
    // 26000 → "Nifty 50" is in the seed, but "Nifty 50" is not subscribed: dropped.
    s.bin(encodeIndex({ token: 26000, name: '', value: 2_000_000 }));
    expect(h.quotes).toHaveLength(1);
  });

  it('skips unknown packets, unresolved tokens and other exchanges', async () => {
    const h = harness();
    const s = await connectAuthed(h);
    s.bin(concat(encodeHeaderOnly(9999, 4, 40), encodeMarketPicture({ ...MP_L4_FIELDS, token: 777 }), encodeMarketPicture({ ...MP_L4_FIELDS, exch: 3 }), VEC_MINI));
    expect(h.quotes.map(([p]) => p.key)).toEqual([TCS]);
    expect(h.logs.some((l) => l.includes('unknown packet code 9999'))).toBe(true);
  });

  it('does not throw or emit on garbage frames', async () => {
    const h = harness();
    const s = await connectAuthed(h);
    expect(() => s.bin(new Uint8Array([0xff, 0xff, 1, 2, 3]))).not.toThrow();
    expect(() => s.bin(new Uint8Array(0))).not.toThrow();
    expect(() => s.bin(VEC_MP_L4.subarray(0, 100))).not.toThrow();
    expect(() => s.text('}{')).not.toThrow();
    expect(h.quotes).toEqual([]);
    expect(h.client.health()).toMatchObject({ authenticated: true, lastPacketTs: null });
  });

  it('drops binary frames that arrive before authentication', () => {
    const h = harness();
    h.client.connect();
    h.last().open();
    h.last().bin(VEC_MINI);
    h.last().text(AUTH_1119);
    h.last().bin(VEC_MINI);
    expect(h.quotes).toEqual([]);
    vi.advanceTimersByTime(3000);
    h.last().bin(VEC_MINI);
    expect(h.quotes).toHaveLength(1);
  });

  it('scales by the dividers of the auth response', () => {
    const h = harness();
    h.client.connect();
    h.last().open();
    h.last().text({ ...AUTH_1119, exchanges: { nse_fo: { value: 2, divider: 10_000 } } });
    vi.advanceTimersByTime(3000);
    h.last().bin(VEC_MP_L4);
    expect(h.quotes[0][0]).toMatchObject({ ltp: 15.005, bid: 15, ask: 15.01, turnover: 123.4567 });
  });

  it('forwards market status packets', async () => {
    const h = harness();
    const s = await connectAuthed(h);
    s.bin(VEC_STATUS);
    expect(h.statuses).toEqual([{ exchange: 'nse_cm', segment: 'nse_cm', statusCode: 1, name: 'OpenMessage', receivedAt: T0 }]);
    expect(h.quotes).toEqual([]);
  });

  it('survives a throwing handler and resolver', async () => {
    let n = 0;
    const h = harness(
      {
        resolve: (seg, tok) => {
          if (tok === '777') throw new Error('resolver bug');
          return seg === 'nse_cm' ? TCS : NIFTY_CE;
        },
      },
      {
        onQuote: () => {
          n++;
          throw new Error('consumer bug');
        },
      },
    );
    const s = await connectAuthed(h);
    s.bin(concat(VEC_MINI, encodeMarketPicture({ ...MP_L4_FIELDS, token: 777 }), VEC_MP_L4));
    expect(n).toBe(2);
    expect(h.logs.some((l) => l.includes('onQuote handler threw: consumer bug'))).toBe(true);
    expect(h.logs.some((l) => l.includes('resolver failed: resolver bug'))).toBe(true);
    expect(h.client.health().authenticated).toBe(true);
  });
});

describe('SFeedClient over a real ws socket (localhost)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('authenticates, subscribes and decodes through the default ws factory', async () => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const port = (wss.address() as { port: number }).port;
    const received: Record<string, unknown>[] = [];
    const serverClosed = new Promise<number>((resolve) => {
      wss.on('connection', (sock: ServerSocket) => {
        sock.on('message', (data, isBinary) => {
          expect(isBinary).toBe(false);
          const frame = JSON.parse(String(data)) as Record<string, unknown>;
          received.push(frame);
          if (frame.format === 'native_batch') sock.send(JSON.stringify(AUTH_1117));
          if (frame.event === 'subscribeScrips') sock.send(Buffer.from(concat(VEC_MP_L4, VEC_STATUS)));
        });
        sock.on('close', (code) => resolve(code));
      });
    });
    const quotes: LiveQuotePatch[] = [];
    const statuses: SFeedMarketStatus[] = [];
    let gotQuote: () => void = () => {};
    const quoted = new Promise<void>((r) => (gotQuote = r));
    const client = new SFeedClient(
      { url: `ws://127.0.0.1:${port}`, sid: SID, ucc: UCC, resolve: (seg, tok) => (seg === 'nse_fo' && tok === '44498' ? NIFTY_CE : undefined), logger: { debug() {}, info() {}, warn() {}, error() {} } },
      {
        onQuote: (p) => {
          quotes.push(p);
          gotQuote();
        },
        onStatus: (s) => statuses.push(s),
      },
    );
    try {
      client.subscribe([scrip('44498')]);
      client.connect();
      await quoted;
      expect(received[0]).toMatchObject({ user: UCC, auth: SID, format: 'native_batch' });
      expect(received[1]).toEqual({ event: 'subscribeScrips', inputtoken: 'nse_fo|44498', ack_symbol: true });
      expect(quotes[0]).toMatchObject({ key: NIFTY_CE, ltp: 1500.5, bid: 1500, ask: 1501, oi: 500 });
      expect(statuses.map((s) => s.statusCode)).toEqual([1]);
      expect(client.health()).toMatchObject({ connected: true, authenticated: true, subscribed: 1 });
      await client.close();
      expect(await serverClosed).toBe(1000);
      expect(client.health().connected).toBe(false);
    } finally {
      await client.close();
      await new Promise<void>((r) => wss.close(() => r()));
    }
  });
});
