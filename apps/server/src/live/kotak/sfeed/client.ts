/**
 * Kotak Neo SFeed websocket client ('native_batch').
 *
 * Connects, authenticates, keeps a budgeted desired-subscription set in sync with the server
 * (diff-based, batched), replays everything after a reconnect, reconnects with exponential
 * backoff + jitter, keeps the socket alive with websocket ping/pong, and emits decoded packets
 * as partial LiveQuote updates through a caller-supplied (segment, token) → InstrumentKey resolver.
 *
 * Protocol facts: docs/live-data/research/kotak-sfeed-websocket.md ("WS") §3–§8 and critic.md
 * C7–C9. Every network dependency (socket factory, clock, randomness) is injectable.
 */
import WebSocket from 'ws';
import type { InstrumentKey, LiveQuote, Segment } from '../../types';
import {
  MSG,
  SFEED_INTENTS,
  buildAuthFrame,
  buildMarketStatusFrame,
  buildSnapshotFrame,
  buildSubscribeFrame,
  buildUnsubscribeFrame,
  decodePacket,
  isKnownPacketCode,
  isValidToken,
  parseControlFrame,
  readHeader,
  splitBatch,
  type SFeedIndexPacket,
  type SFeedIntent,
  type SFeedMarketPicturePacket,
  type SFeedMiniPacket,
  type SFeedPacket,
} from './protocol';

export { resolveFeedUrl, SFEED_DEFAULT_URL } from './protocol';

/* ------------------------------------------------------------------------------------------ */
/* Socket abstraction                                                                           */
/* ------------------------------------------------------------------------------------------ */

export interface SFeedSocket {
  send(data: string): void;
  /** Websocket-level ping (the protocol has no application heartbeat, official §8). */
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}

export interface SFeedSocketEvents {
  open(): void;
  /** Binary frames as bytes, text frames as strings. */
  message(data: Uint8Array | string, isBinary: boolean): void;
  pong(): void;
  close(code: number, reason: string): void;
  error(err: Error): void;
}

/** Opens a socket to `url` and reports its events. It must not call `on.*` synchronously. */
export type SFeedSocketFactory = (url: string, on: SFeedSocketEvents) => SFeedSocket;

const toBytes = (data: WebSocket.RawData): Buffer => (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data));

/**
 * Default factory on the `ws` package. Node `ws` delivers text and binary as Buffers, so the
 * `isBinary` flag decides (WS §6). TLS verification and permessage-deflate stay at defaults.
 */
export const wsSocketFactory: SFeedSocketFactory = (url, on) => {
  const ws = new WebSocket(url, { handshakeTimeout: 15_000 });
  ws.on('open', () => on.open());
  ws.on('message', (data, isBinary) => {
    const b = toBytes(data);
    on.message(isBinary ? b : b.toString('utf8'), isBinary);
  });
  ws.on('pong', () => on.pong());
  ws.on('close', (code, reason) => on.close(code, reason.toString('utf8')));
  ws.on('error', (err) => on.error(err));
  return {
    send: (data) => ws.send(data),
    ping: () => {
      if (ws.readyState === WebSocket.OPEN) ws.ping();
    },
    close: (code, reason) => ws.close(code, reason),
    terminate: () => ws.terminate(),
  };
};

/* ------------------------------------------------------------------------------------------ */
/* Public types                                                                                 */
/* ------------------------------------------------------------------------------------------ */

export interface SFeedLogger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** One subscription; the budget counts each (token, intent) pair separately (critic C8). */
export interface SFeedSub {
  segment: Segment;
  /** Numeric scrip token, or an index name such as "Nifty 50" (critic C5/C7). */
  token: string;
  intent: SFeedIntent;
}

export interface SFeedSubscribeResult {
  accepted: SFeedSub[];
  rejected: { sub: SFeedSub; reason: 'budget' | 'invalid' }[];
}

/**
 * A partial LiveQuote: only the fields present in one packet (each packet is a full record of its
 * type). A key that is present with the value `undefined` (bid/ask/bidQty/askQty of a market
 * picture) means "now empty": merge with `{ ...old, ...patch }` / Object.assign so it clears.
 */
export type LiveQuotePatch = Pick<LiveQuote, 'key' | 'ts'> & Partial<Omit<LiveQuote, 'key' | 'ts'>>;

export interface SFeedQuoteMeta {
  segment: Segment;
  /** Numeric token from the packet. */
  token: string;
  packet: 'index' | 'marketPicture' | 'mini';
  level?: number;
  /** Local receive time (epoch ms). */
  receivedAt: number;
}

export interface SFeedMarketStatus {
  exchange: string;
  segment?: Segment;
  statusCode: number;
  /** Official status name ('OpenMessage', 'CloseMessage', …), null for an unknown code. */
  name: string | null;
  receivedAt: number;
}

export interface SFeedAuthError {
  /** rejected = 1120 or an error frame; closed = socket closed before auth; fallback = native_fallback. */
  kind: 'rejected' | 'timeout' | 'closed' | 'fallback';
  message: string;
}

export interface SFeedHealth {
  /** Socket open. */
  connected: boolean;
  authenticated: boolean;
  /** Local receive time of the last decoded binary packet. */
  lastPacketTs: number | null;
  /** (token, intent) pairs subscribed on the current connection. */
  subscribed: number;
  /** (token, intent) pairs wanted (replayed on every reconnect). */
  desired: number;
  error?: string;
}

export interface SFeedClientOptions {
  /** wss:// URL (see resolveFeedUrl). */
  url: string;
  /** Session id from tradeApiValidate — sent as `auth` (not the JWT, WS §3.2). */
  sid: string;
  /** Unique client code — sent as `user`. */
  ucc: string;
  /** Maps a packet's (segment, token) to an instrument; undefined drops the packet. */
  resolve: (segment: Segment, token: string) => InstrumentKey | undefined;
  wsFactory?: SFeedSocketFactory;
  now?: () => number;
  /** [0, 1) source for backoff jitter. */
  random?: () => number;
  logger?: SFeedLogger;
  /** Client-side cap of (token, intent) pairs; the server allows 3000 (official §4). */
  maxSubscriptions?: number;
  /** Tokens per subscribe/unsubscribe frame (no documented cap; WS §4.1 suggests ≤ 500). */
  batchSize?: number;
  pingIntervalMs?: number;
  connectTimeoutMs?: number;
  authTimeoutMs?: number;
  /** After 1119 without 1117, wait this long for 1120/close before treating it as success (critic C9). */
  authGraceMs?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  /** A connection authenticated at least this long resets the backoff. */
  stableMs?: number;
  closeTimeoutMs?: number;
  /** Subscribe to segment market status (code 105). */
  marketStatus?: boolean;
  /** 'seg|numericToken' → index name, used only when that name is subscribed (critic C7). */
  indexTokens?: Readonly<Record<string, string>>;
}

export interface SFeedHandlers {
  onQuote(patch: LiveQuotePatch, meta: SFeedQuoteMeta): void;
  /** Segment market status (code 105 / legacy 6511, 6521). */
  onStatus?(status: SFeedMarketStatus): void;
  /** Feed auth failed; the likely cause is an expired sid: re-login and call updateSession(). */
  onAuthError?(err: SFeedAuthError): void;
  onHealth?(health: SFeedHealth): void;
  /** Every decoded packet, before mapping (diagnostics, CAS). */
  onPacket?(packet: SFeedPacket): void;
}

/** Per-client cap of the server (official §4 "Subscription limit"); maxSubscriptions never exceeds it. */
const SERVER_MAX_SUBSCRIPTIONS = 3000;

export const SFEED_DEFAULTS = {
  maxSubscriptions: 2700,
  batchSize: 200,
  pingIntervalMs: 20_000,
  connectTimeoutMs: 15_000,
  authTimeoutMs: 15_000,
  authGraceMs: 3_000,
  backoffInitialMs: 1_000,
  backoffMaxMs: 60_000,
  stableMs: 30_000,
  closeTimeoutMs: 2_000,
} as const;

/** NSE index tokens from the legacy scrip master `nse_cm.csv` (research kotak-rest-auth §3.2, critic C7). */
export const KNOWN_INDEX_TOKENS: Readonly<Record<string, string>> = {
  'nse_cm|26000': 'Nifty 50',
  'nse_cm|26009': 'Nifty Bank',
  'nse_cm|26037': 'Nifty Fin Service',
  'nse_cm|26074': 'NIFTY MID SELECT',
};

const SEGMENTS = new Set<string>(['nse_cm', 'bse_cm', 'nse_fo', 'bse_fo', 'mcx_fo']);
const asSegment = (s: string): Segment | undefined => (SEGMENTS.has(s) ? (s as Segment) : undefined);
const subKey = (s: SFeedSub): string => `${s.intent}|${s.segment}|${s.token}`;
const isValidSub = (s: SFeedSub): boolean =>
  !!s && SEGMENTS.has(s.segment) && SFEED_INTENTS.includes(s.intent) && isValidToken({ segment: s.segment, token: s.token });
const normName = (s: string): string => s.replace(/\s+/g, ' ').trim().toUpperCase();
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** Host and path only: a query string or userinfo never reaches the log. */
const safeUrl = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '(invalid url)';
  }
};

const defaultLogger: SFeedLogger = {
  debug: () => {},
  info: () => {},
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

/* ------------------------------------------------------------------------------------------ */
/* Packet → LiveQuote mapping                                                                   */
/* ------------------------------------------------------------------------------------------ */

const positive = (n: number): number | undefined => (Number.isFinite(n) && n > 0 ? n : undefined);
const nonNegative = (n: number): number | undefined => (Number.isFinite(n) && n >= 0 ? n : undefined);

/**
 * Map a decoded packet to the LiveQuote fields it actually carries. A zero price means "none"
 * on the wire (no trade yet, no bid) and is left out rather than reported as ₹0. Quantities,
 * volume and OI are exchange units (critic C13); OI only exists for derivatives. `ts` is the
 * exchange update time (LUT, else LTT), else the local receive time.
 */
export function toQuotePatch(p: SFeedIndexPacket | SFeedMarketPicturePacket | SFeedMiniPacket, key: InstrumentKey, segment: Segment, receivedAt: number): LiveQuotePatch {
  const q: LiveQuotePatch = { key, ts: receivedAt };
  const set = <K extends keyof LiveQuotePatch>(k: K, v: LiveQuotePatch[K] | undefined): void => {
    if (v !== undefined) q[k] = v;
  };
  set('ltp', positive(p.ltp));
  set('ltt', p.ltt ?? undefined);
  set('prevClose', positive(p.close));
  if (p.kind === 'mini') {
    q.ts = p.ltt ?? receivedAt;
    set('ltq', positive(p.ltq));
    return q;
  }
  set('open', positive(p.open));
  set('high', positive(p.high));
  set('low', positive(p.low));
  if (p.kind === 'index') {
    q.ts = p.ltt ?? receivedAt;
    return q;
  }
  q.ts = p.lut ?? p.ltt ?? receivedAt;
  set('ltq', positive(p.ltq));
  set('atp', positive(p.atp));
  set('volume', nonNegative(p.volume));
  set('totalBuyQty', nonNegative(p.totalBuyQty));
  set('totalSellQty', nonNegative(p.totalSellQty));
  if (segment === 'nse_fo' || segment === 'bse_fo' || segment === 'mcx_fo') set('oi', nonNegative(p.oi));
  set('turnover', p.turnover === null ? undefined : positive(p.turnover));
  set('upperCircuit', positive(p.upperCircuit));
  set('lowerCircuit', positive(p.lowerCircuit));
  // Best bid/ask keys are always written: an emptied side of the book must clear the previous
  // quote on merge, never leave a stale price that the paper broker could fill against.
  const bid = p.bids[0] && p.bids[0].price > 0 ? p.bids[0] : undefined;
  q.bid = bid?.price;
  q.bidQty = bid ? nonNegative(bid.qty) : undefined;
  const ask = p.asks[0] && p.asks[0].price > 0 ? p.asks[0] : undefined;
  q.ask = ask?.price;
  q.askQty = ask ? nonNegative(ask.qty) : undefined;
  if (p.level >= 8) q.depth = { bids: p.bids.filter((r) => r.price > 0), asks: p.asks.filter((r) => r.price > 0) };
  return q;
}

/* ------------------------------------------------------------------------------------------ */
/* Client                                                                                       */
/* ------------------------------------------------------------------------------------------ */

type Timer = ReturnType<typeof setTimeout>;
type Cfg = { -readonly [K in keyof typeof SFEED_DEFAULTS]: number };

export class SFeedClient {
  private readonly url: string;
  private readonly resolveFn: (segment: Segment, token: string) => InstrumentKey | undefined;
  private sid: string;
  private ucc: string;
  private readonly cfg: Cfg;
  private readonly factory: SFeedSocketFactory;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly log: SFeedLogger;
  private readonly indexTokens: Readonly<Record<string, string>>;

  private socket: SFeedSocket | null = null;
  /** Generation of the current socket; events from older sockets are ignored. */
  private gen = 0;
  private stopped = true;
  private connected = false;
  private authenticated = false;
  private authenticatedAt = 0;
  private alive = true;
  private attempts = 0;
  private dividerMap = new Map<number, number>();

  private desiredSubs = new Map<string, SFeedSub>();
  private readonly sentSubs = new Map<string, SFeedSub>();
  private wantStatus: boolean;
  private sentStatus = false;
  private flushQueued = false;

  private reconnectTimer: Timer | null = null;
  private phaseTimer: Timer | null = null;
  private graceTimer: Timer | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closeWaiters: (() => void)[] = [];

  private lastPacketTs: number | null = null;
  private lastError: string | undefined;
  /** First failure cause of the current connection attempt. */
  private cycleError: string | undefined;
  /** 'seg|token' as subscribed → trading symbol, from 1109 acks. */
  private readonly symbols = new Map<string, string>();
  /** 'seg|numericToken' → subscribed index name (critic C7). */
  private readonly indexNames = new Map<string, string>();
  private readonly noted = new Set<string>();

  constructor(
    opts: SFeedClientOptions,
    private readonly handlers: SFeedHandlers,
  ) {
    if (!opts.url) throw new Error('SFeed: url is required');
    if (!opts.sid || !opts.ucc) throw new Error('SFeed: sid and ucc are required (log in first)');
    this.url = opts.url;
    this.sid = opts.sid;
    this.ucc = opts.ucc;
    this.resolveFn = opts.resolve;
    this.factory = opts.wsFactory ?? wsSocketFactory;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.log = opts.logger ?? defaultLogger;
    this.indexTokens = opts.indexTokens ?? KNOWN_INDEX_TOKENS;
    this.wantStatus = opts.marketStatus ?? false;
    const cfg = { ...SFEED_DEFAULTS } as Cfg;
    for (const k of Object.keys(SFEED_DEFAULTS) as (keyof Cfg)[]) {
      const v = opts[k];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) cfg[k] = v;
    }
    cfg.batchSize = Math.max(1, Math.floor(cfg.batchSize));
    cfg.maxSubscriptions = Math.min(SERVER_MAX_SUBSCRIPTIONS, Math.floor(cfg.maxSubscriptions));
    this.cfg = cfg;
  }

  /* ---- lifecycle --------------------------------------------------------------------------- */

  /** Start connecting (idempotent). Reconnects forever until close(). */
  connect(): void {
    if (!this.stopped) return;
    // A close() still waiting for its close event: finish it now so its promise resolves.
    if (this.socket) this.teardown('restarted', 'backoff');
    this.stopped = false;
    this.attempts = 0;
    this.open();
  }

  /** Clean close: no reconnect afterwards. Resolves once the socket is gone. */
  async close(): Promise<void> {
    this.stopped = true;
    this.clearTimer('reconnectTimer');
    // A real socket reports its close asynchronously: no auth timeout, 1119 grace or late frame may
    // turn into an auth failure (and a re-login) or a subscribe while the close is in flight.
    this.clearTimer('phaseTimer');
    this.clearTimer('graceTimer');
    const s = this.socket;
    if (!s) {
      this.lastError = undefined;
      this.emitHealth();
      return;
    }
    const closed = new Promise<void>((resolve) => this.closeWaiters.push(resolve));
    const timer = setTimeout(() => {
      if (this.socket === s) this.teardown('close timeout', 'backoff');
    }, this.cfg.closeTimeoutMs);
    try {
      s.close(1000, 'client closing');
    } catch {
      this.teardown('client close', 'backoff');
    }
    await closed;
    clearTimeout(timer);
  }

  /**
   * New session credentials (after a re-login). Reconnects when the feed is not authenticated
   * (or when `reconnect` is true); otherwise they are used on the next connect. Only the first
   * failure in a row reconnects at once: after that the pending backoff dials with the new
   * session, so onAuthError → re-login → updateSession cannot become a tight login loop.
   */
  updateSession(creds: { sid: string; ucc: string }, opts: { reconnect?: boolean } = {}): void {
    if (!creds.sid || !creds.ucc) throw new Error('SFeed: sid and ucc are required');
    this.sid = creds.sid;
    this.ucc = creds.ucc;
    if (this.stopped) return;
    if (opts.reconnect ?? !this.authenticated) {
      if (this.socket) this.teardown('session updated', 'now');
      else if (this.attempts <= 1 || !this.reconnectTimer) this.open();
    }
  }

  health(): SFeedHealth {
    const h: SFeedHealth = {
      connected: this.connected,
      authenticated: this.authenticated,
      lastPacketTs: this.lastPacketTs,
      subscribed: this.sentSubs.size,
      desired: this.desiredSubs.size,
    };
    if (this.lastError) h.error = this.lastError;
    return h;
  }

  /* ---- subscriptions ----------------------------------------------------------------------- */

  /** Add to the desired set (in order) up to the budget; synced to the server in batches. */
  subscribe(subs: readonly SFeedSub[]): SFeedSubscribeResult {
    const res = this.admit(this.desiredSubs, subs);
    this.scheduleFlush();
    return res;
  }

  unsubscribe(subs: readonly SFeedSub[]): void {
    let changed = false;
    for (const s of subs) if (s && this.desiredSubs.delete(subKey(s))) changed = true;
    if (changed) this.scheduleFlush();
  }

  /** Replace the whole desired set (callers pass it in priority order; overflow is rejected). */
  setDesired(subs: readonly SFeedSub[]): SFeedSubscribeResult {
    const next = new Map<string, SFeedSub>();
    const res = this.admit(next, subs);
    this.desiredSubs = next;
    this.scheduleFlush();
    return res;
  }

  desired(): SFeedSub[] {
    return [...this.desiredSubs.values()].map((s) => ({ ...s }));
  }

  /** Segment market-status stream (code 105) on/off. */
  setMarketStatus(on: boolean): void {
    this.wantStatus = on;
    this.scheduleFlush();
  }

  /** One-off snapshot (not counted in the budget). False when not authenticated or nothing valid. */
  snapshot(subs: readonly SFeedSub[]): boolean {
    if (!this.authenticated || !this.socket) return false;
    const valid = subs.filter(isValidSub);
    if (!valid.length) return false;
    for (const [intent, group] of this.groupByIntent(valid)) {
      for (const chunk of this.chunks(group)) if (!this.send(buildSnapshotFrame(intent, chunk))) return false;
    }
    return true;
  }

  /** Trading symbol learned from the 1109 ack for a subscribed 'seg|token'. */
  tradingSymbol(segment: Segment, token: string): string | undefined {
    return this.symbols.get(`${segment}|${token}`);
  }

  /** Index name learned for a numeric index token (critic C7). */
  indexName(segment: Segment, token: string): string | undefined {
    return this.indexNames.get(`${segment}|${token}`);
  }

  /** Price dividers of the current connection, keyed by exchange id. */
  dividers(): ReadonlyMap<number, number> {
    return new Map(this.dividerMap);
  }

  private admit(target: Map<string, SFeedSub>, subs: readonly SFeedSub[]): SFeedSubscribeResult {
    const res: SFeedSubscribeResult = { accepted: [], rejected: [] };
    for (const s of subs) {
      if (!isValidSub(s)) {
        res.rejected.push({ sub: s, reason: 'invalid' });
        continue;
      }
      const k = subKey(s);
      if (!target.has(k)) {
        if (target.size >= this.cfg.maxSubscriptions) {
          res.rejected.push({ sub: s, reason: 'budget' });
          continue;
        }
        target.set(k, { segment: s.segment, token: s.token, intent: s.intent });
      }
      res.accepted.push(s);
    }
    const budget = res.rejected.filter((r) => r.reason === 'budget').length;
    if (budget) this.log.warn(`sfeed: subscription budget of ${this.cfg.maxSubscriptions} reached; ${budget} subscription(s) rejected`);
    const invalid = res.rejected.length - budget;
    if (invalid) this.log.warn(`sfeed: ${invalid} invalid subscription(s) rejected`);
    return res;
  }

  /** Coalesce changes made in the same tick into one diff. */
  private scheduleFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    void Promise.resolve().then(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  /** Send the diff between desired and subscribed: unsubscribes first (frees budget), then subscribes. */
  private flush(): void {
    if (!this.authenticated || !this.socket) return;
    const removed: SFeedSub[] = [];
    for (const [k, s] of this.sentSubs) if (!this.desiredSubs.has(k)) removed.push(s);
    const added: SFeedSub[] = [];
    for (const [k, s] of this.desiredSubs) if (!this.sentSubs.has(k)) added.push(s);

    for (const [intent, group] of this.groupByIntent(removed)) {
      for (const chunk of this.chunks(group)) {
        if (!this.send(buildUnsubscribeFrame(intent, chunk))) return;
        for (const s of chunk) this.sentSubs.delete(subKey(s));
      }
    }
    if (removed.length) {
      const still = new Set([...this.desiredSubs.values()].map((s) => `${s.segment}|${s.token}`));
      for (const s of removed) if (!still.has(`${s.segment}|${s.token}`)) this.symbols.delete(`${s.segment}|${s.token}`);
    }
    for (const [intent, group] of this.groupByIntent(added)) {
      for (const chunk of this.chunks(group)) {
        if (!this.send(buildSubscribeFrame(intent, chunk))) return;
        for (const s of chunk) this.sentSubs.set(subKey(s), s);
      }
    }
    if (this.wantStatus !== this.sentStatus && this.send(buildMarketStatusFrame(this.wantStatus))) this.sentStatus = this.wantStatus;
    if (removed.length || added.length) {
      this.log.debug(`sfeed: -${removed.length} +${added.length} subscriptions (${this.sentSubs.size} active)`);
      this.emitHealth();
    }
  }

  private groupByIntent(subs: readonly SFeedSub[]): [SFeedIntent, SFeedSub[]][] {
    const out: [SFeedIntent, SFeedSub[]][] = [];
    for (const intent of SFEED_INTENTS) {
      const g = subs.filter((s) => s.intent === intent);
      if (g.length) out.push([intent, g]);
    }
    return out;
  }

  private chunks(subs: SFeedSub[]): SFeedSub[][] {
    const out: SFeedSub[][] = [];
    for (let i = 0; i < subs.length; i += this.cfg.batchSize) out.push(subs.slice(i, i + this.cfg.batchSize));
    return out;
  }

  /* ---- connection state machine ------------------------------------------------------------ */

  private open(): void {
    this.clearTimer('reconnectTimer');
    const gen = ++this.gen;
    this.cycleError = undefined;
    const on: SFeedSocketEvents = {
      open: () => {
        if (gen === this.gen) this.onOpen();
      },
      message: (data, isBinary) => {
        if (gen === this.gen) this.onMessage(data, isBinary);
      },
      pong: () => {
        if (gen === this.gen) this.alive = true;
      },
      close: (code, reason) => {
        if (gen === this.gen) this.onSocketClose(code, reason);
      },
      error: (err) => {
        if (gen === this.gen) this.onSocketError(err);
      },
    };
    try {
      this.socket = this.factory(this.url, on);
    } catch (e) {
      this.cycleError = `SFeed connect failed: ${errMsg(e)}`;
      this.teardown('connect failed', 'backoff');
      return;
    }
    this.log.info(`sfeed: connecting to ${safeUrl(this.url)}`);
    this.phaseTimer = setTimeout(() => {
      this.cycleError ??= `SFeed connect timeout after ${this.cfg.connectTimeoutMs} ms`;
      this.teardown('connect timeout', 'backoff');
    }, this.cfg.connectTimeoutMs);
    this.emitHealth();
  }

  private onOpen(): void {
    this.connected = true;
    this.clearTimer('phaseTimer');
    // The auth frame carries the sid; it is never logged.
    if (!this.send(buildAuthFrame({ ucc: this.ucc, sid: this.sid, connReqTime: this.now() }))) {
      this.cycleError = 'SFeed: could not send the auth frame';
      this.teardown('auth send failed', 'backoff');
      return;
    }
    this.phaseTimer = setTimeout(() => this.authFail('timeout', `no auth response within ${this.cfg.authTimeoutMs} ms`), this.cfg.authTimeoutMs);
    this.alive = true;
    // Node `ws` does not ping as a client: ping every interval, drop the socket if the previous
    // ping got no pong (WS §6.1 step 6; there is no app-level heartbeat, official §8).
    this.pingTimer = setInterval(() => this.keepalive(), this.cfg.pingIntervalMs);
    this.emitHealth();
  }

  private keepalive(): void {
    if (!this.socket) return;
    if (!this.alive) {
      this.cycleError = `SFeed keepalive: no pong within ${this.cfg.pingIntervalMs} ms`;
      this.log.warn(this.cycleError);
      this.teardown('ping timeout', 'backoff');
      return;
    }
    this.alive = false;
    try {
      this.socket.ping();
    } catch (e) {
      this.log.debug(`sfeed: ping failed: ${errMsg(e)}`);
    }
  }

  private onMessage(data: Uint8Array | string, isBinary: boolean): void {
    if (this.stopped) return;
    this.alive = true;
    if (typeof data === 'string') this.onText(data);
    else if (isBinary) this.onBinary(data);
    else this.onText(Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8'));
  }

  private onText(raw: string): void {
    const c = parseControlFrame(raw);
    switch (c.kind) {
      case 'auth':
        if (c.fallback) {
          this.authFail('fallback', 'server switched to native_fallback (unsupported body layout)');
          return;
        }
        for (const [id, d] of c.dividers) this.dividerMap.set(id, d);
        if (c.code === MSG.AUTH_OK) this.markAuthenticated('1117');
        else if (!this.authenticated && !this.graceTimer) {
          // 1119 "does not by itself indicate success" (official §3) yet is what production sends
          // (SDK fixture): succeed unless 1120 or a close follows within the grace (critic C9).
          // It is an auth response, so the grace replaces the 15 s "no response" timeout.
          this.clearTimer('phaseTimer');
          this.graceTimer = setTimeout(() => {
            this.graceTimer = null;
            this.markAuthenticated('1119');
          }, this.cfg.authGraceMs);
        }
        return;
      case 'authFailed':
        this.authFail('rejected', c.message);
        return;
      case 'ack':
        for (const [k, v] of Object.entries(c.symbols)) this.symbols.set(k, v);
        if (!c.ok) this.log.warn(`sfeed: subscribe ack error ${c.errorCode ?? '?'}: ${this.redact(c.description ?? '')}`);
        return;
      case 'error':
        if (!this.authenticated) this.authFail('rejected', c.message);
        else this.log.warn(`sfeed: server error: ${this.redact(c.message)}`);
        return;
      case 'other':
        this.log.debug(`sfeed: ignoring control frame ${c.code ?? '(no code)'}`);
        return;
      case 'invalid':
        this.log.debug(`sfeed: ignoring text frame (${c.reason})`);
        return;
    }
  }

  private onBinary(bytes: Uint8Array): void {
    // Without the auth response there are no dividers; a mis-scaled price is worse than a late one.
    if (!this.authenticated) {
      this.noteOnce('preauth', 'debug', 'sfeed: dropping binary frames received before authentication');
      return;
    }
    const receivedAt = this.now();
    let decoded = false;
    for (const raw of splitBatch(bytes)) {
      let p: SFeedPacket | null = null;
      try {
        p = decodePacket(raw, this.dividerMap);
      } catch (e) {
        this.noteOnce(`throw:${errMsg(e)}`, 'warn', `sfeed: packet decode failed: ${errMsg(e)}`);
      }
      if (!p) {
        const h = readHeader(raw);
        if (h && h.code !== MSG.CAS) {
          const what = isKnownPacketCode(h.code) ? 'short or unsupported' : 'unknown';
          // warn, not info: market data under a code other than 7208 would otherwise vanish silently.
          this.noteOnce(`skip:${h.code}:${h.level}`, 'warn', `sfeed: skipping ${what} packet code ${h.code} level ${h.level} (${raw.byteLength} bytes)`);
        }
        continue;
      }
      decoded = true;
      this.route(p, receivedAt);
    }
    if (decoded) this.lastPacketTs = receivedAt;
  }

  private route(p: SFeedPacket, receivedAt: number): void {
    this.safe('onPacket', () => this.handlers.onPacket?.(p));
    if (p.kind === 'cas') return;
    if (p.kind === 'marketStatus') {
      const status: SFeedMarketStatus = { exchange: p.exchange, statusCode: p.statusCode, name: p.name, receivedAt };
      const seg = asSegment(p.exchange);
      if (seg) status.segment = seg;
      this.safe('onStatus', () => this.handlers.onStatus?.(status));
      return;
    }
    const segment = asSegment(p.exchange);
    if (!segment) {
      this.noteOnce(`exch:${p.exchange}`, 'debug', `sfeed: ignoring packets for exchange ${p.exchange}`);
      return;
    }
    const key = p.kind === 'index' ? this.resolveIndex(segment, p) : this.resolveSafe(segment, p.token);
    if (!key) {
      this.noteOnce(`unresolved:${segment}|${p.token}`, 'debug', `sfeed: no instrument for ${segment}|${p.token}; packet dropped`);
      return;
    }
    if (p.lttRaw > 0 && p.ltt === null) {
      this.noteOnce('ts', 'warn', `sfeed: last_trade_time ${p.lttRaw} is not epoch seconds; using receive time`);
    }
    const patch = toQuotePatch(p, key, segment, receivedAt);
    const meta: SFeedQuoteMeta = { segment, token: p.token, packet: p.kind, receivedAt };
    if (p.kind === 'marketPicture') meta.level = p.level;
    this.safe('onQuote', () => this.handlers.onQuote(patch, meta));
  }

  /**
   * Index packets carry the numeric token (26000) and the exchange's name ("NIFTY 50") even when
   * subscribed by name ("Nifty 50"); the 1109 ack is keyed by the subscribed name (WS §4.3,
   * critic C7). Learn numeric → subscribed name by (1) a case/space-insensitive match of the
   * packet name against subscribed names or their ack symbols, else (2) the known-token seed.
   */
  private resolveIndex(segment: Segment, p: SFeedIndexPacket): InstrumentKey | undefined {
    const direct = this.resolveSafe(segment, p.token);
    if (direct) return direct;
    const id = `${segment}|${p.token}`;
    let name = this.indexNames.get(id);
    if (name === undefined) {
      name = this.learnIndexName(segment, p);
      if (name === undefined) return undefined;
      this.indexNames.set(id, name);
      this.log.info(`sfeed: index token ${id} ("${p.name}") is "${name}"`);
    }
    return this.resolveSafe(segment, name);
  }

  private learnIndexName(segment: Segment, p: SFeedIndexPacket): string | undefined {
    const named = new Set<string>();
    for (const s of this.desiredSubs.values()) if (s.segment === segment && !/^\d+$/.test(s.token)) named.add(s.token);
    const target = normName(p.name);
    if (target) {
      const hits = [...named].filter((n) => normName(n) === target || normName(this.symbols.get(`${segment}|${n}`) ?? '') === target);
      if (hits.length === 1) return hits[0];
    }
    const seeded = this.indexTokens[`${segment}|${p.token}`];
    return seeded !== undefined && named.has(seeded) ? seeded : undefined;
  }

  private resolveSafe(segment: Segment, token: string): InstrumentKey | undefined {
    try {
      return this.resolveFn(segment, token);
    } catch (e) {
      this.noteOnce(`resolve:${errMsg(e)}`, 'warn', `sfeed: resolver failed: ${errMsg(e)}`);
      return undefined;
    }
  }

  private markAuthenticated(via: string): void {
    if (this.authenticated || !this.connected || !this.socket) return;
    this.clearTimer('phaseTimer');
    this.clearTimer('graceTimer');
    this.authenticated = true;
    this.authenticatedAt = this.now();
    this.lastError = undefined;
    this.cycleError = undefined;
    this.log.info(`sfeed: authenticated (${via}); subscribing ${this.desiredSubs.size}`);
    // The server forgets subscriptions across connections (official §8): replay everything.
    this.sentSubs.clear();
    this.sentStatus = false;
    this.flush();
    this.emitHealth();
  }

  private authFail(kind: SFeedAuthError['kind'], message: string): void {
    const msg = this.redact(message);
    this.cycleError = `SFeed auth failed (${kind}): ${msg}`;
    this.log.warn(this.cycleError);
    // Tear down first: the handler may call updateSession(), which reconnects at once.
    this.teardown(`auth ${kind}`, 'backoff');
    this.safe('onAuthError', () => this.handlers.onAuthError?.({ kind, message: msg }));
  }

  private onSocketClose(code: number, reason: string): void {
    // The close reason is server text: it reaches logs and health().error, so redact it too.
    const why = `code ${code}${reason ? `: ${this.redact(reason)}` : ''}`;
    if (this.stopped) {
      this.teardown(`closed (${why})`, 'backoff');
      return;
    }
    // A close right after the auth frame most likely means a rejected/expired sid (WS §3.3).
    if (this.connected && !this.authenticated) {
      this.authFail('closed', `socket closed before authentication (${why})`);
      return;
    }
    this.cycleError ??= `SFeed disconnected (${why})`;
    this.teardown(`closed (${why})`, 'backoff');
  }

  private onSocketError(err: Error): void {
    this.cycleError ??= `SFeed socket error: ${this.redact(err.message)}`;
    this.log.debug(`sfeed: socket error: ${this.redact(err.message)}`);
  }

  /** Drop the current socket and its state; reconnect now, after backoff, or not at all when stopped. */
  private teardown(reason: string, next: 'backoff' | 'now'): void {
    const stable = this.authenticated && this.now() - this.authenticatedAt >= this.cfg.stableMs;
    const s = this.socket;
    this.gen++;
    this.socket = null;
    this.clearTimer('phaseTimer');
    this.clearTimer('graceTimer');
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.connected = false;
    this.authenticated = false;
    this.alive = true;
    this.sentSubs.clear();
    this.sentStatus = false;
    this.dividerMap = new Map();
    if (s) {
      try {
        s.terminate();
      } catch {
        /* already gone */
      }
    }
    if (stable) this.attempts = 0;
    for (const w of this.closeWaiters.splice(0)) w();
    if (this.stopped) {
      this.lastError = undefined;
      this.log.info(`sfeed: closed (${reason})`);
    } else {
      this.lastError = this.cycleError ?? `SFeed disconnected (${reason})`;
      if (next === 'now') this.open();
      else this.scheduleReconnect(reason);
    }
    this.emitHealth();
  }

  private scheduleReconnect(reason: string): void {
    this.clearTimer('reconnectTimer');
    const base = Math.min(this.cfg.backoffMaxMs, this.cfg.backoffInitialMs * 2 ** Math.min(this.attempts, 30));
    // "Equal jitter": half fixed, half random, so the delay never collapses to zero.
    const delay = Math.round(base / 2 + this.random() * (base / 2));
    this.attempts++;
    this.log.info(`sfeed: ${reason}; reconnecting in ${delay} ms (attempt ${this.attempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped && !this.socket) this.open();
    }, delay);
  }

  /* ---- helpers ----------------------------------------------------------------------------- */

  private send(frame: string): boolean {
    if (!this.socket) return false;
    try {
      this.socket.send(frame);
      return true;
    } catch (e) {
      this.log.warn(`sfeed: send failed: ${errMsg(e)}`);
      return false;
    }
  }

  private clearTimer(name: 'reconnectTimer' | 'phaseTimer' | 'graceTimer'): void {
    const t = this[name];
    if (t) clearTimeout(t);
    this[name] = null;
  }

  /** Never let credentials reach a log line or an error string. */
  private redact(s: string): string {
    let out = s;
    for (const secret of [this.sid, this.ucc]) if (secret) out = out.split(secret).join('***');
    return out;
  }

  private noteOnce(key: string, level: keyof SFeedLogger, msg: string): void {
    if (this.noted.has(key)) return;
    if (this.noted.size > 1000) this.noted.clear();
    this.noted.add(key);
    this.log[level](msg);
  }

  private safe(name: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.log.error(`sfeed: ${name} handler threw: ${errMsg(e)}`);
    }
  }

  private emitHealth(): void {
    if (this.handlers.onHealth) this.safe('onHealth', () => this.handlers.onHealth?.(this.health()));
  }
}
