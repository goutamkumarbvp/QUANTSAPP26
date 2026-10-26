/**
 * Live market over Kotak Neo (DESIGN.md §2–§3): LiveMarket on the scrip master (reference data),
 * Kotak REST and the SFeed websocket.
 *
 *  - Quote cache, merged from SFeed patches and REST (quotes, option-chain legs). A patch sets only
 *    the fields it carries. An update that reports the order book (SFeed market picture, REST quote)
 *    replaces the whole book, so a bid/ask the exchange has cleared never survives; the book of an
 *    update that does not carry one (index, mini, chain leg) is dropped once it is older than
 *    `bookMaxAgeMs`. A patch older than the cached quote, or REST data while the stream is fresh,
 *    only fills fields the quote does not have. A new session date starts the quote afresh
 *    (yesterday's prevOi/book never leaks into today). A quote exists once a real LTP is known, and
 *    is served only while it is dated a live session (today; outside hours also the last session).
 *  - watch(): desired subscriptions over SFeedClient.setDesired with a hard token budget and
 *    priority tiers: index > user > underlying > chain > ad-hoc. Ad-hoc watches expire after their
 *    TTL and are evicted least-recently-used first when over budget. Dropped keys and keys the
 *    instrument master does not list are reported in details(), never guessed.
 *  - chain(): built from the cache when the chain's legs are streamed and fresh, else one REST
 *    option-chain call (slow lane); cached per (symbol, expiry). Nothing live → NoLiveData.
 *  - Stock-option sweep: one REST option chain per stock (nearest expiry) after another at
 *    ≥ `sweepSpacingMs`, paused outside the session except for one pass after start (prev OI, last
 *    prices).
 */
import { ScripMaster } from './kotak/scripmaster';
import { quoteToLive, type KotakChainLeg, type KotakRest } from './kotak/rest';
import {
  SFeedClient,
  type LiveQuotePatch,
  type SFeedAuthError,
  type SFeedClientOptions,
  type SFeedHealth,
  type SFeedLogger,
  type SFeedQuoteMeta,
  type SFeedSocketFactory,
  type SFeedSub,
} from './kotak/sfeed/client';
import { NoLiveData, keyId } from './types';
import type { ChainRowLive, FeedHealth, InstrumentKey, Listing, LiveMarket, LiveQuote, RawChain, ReferenceData, Segment, TickMeta, TradingCalendar, WatchLevel } from './types';

/* ------------------------------------------------------------------------------------------ */
/* Types                                                                                        */
/* ------------------------------------------------------------------------------------------ */

/** Subscription priority, highest first. 'adhoc' = LiveMarket.watch() callers. */
export type WatchTier = 'index' | 'user' | 'underlying' | 'chain' | 'adhoc';

/** A pinned (universe) subscription; ad-hoc ones go through watch(). */
export interface WatchEntry {
  key: InstrumentKey;
  tier: Exclude<WatchTier, 'adhoc'>;
  /** Default 'quote'. */
  level?: WatchLevel;
}

/** What the live market needs from the scrip master. */
export type LiveRef = ReferenceData & Pick<ScripMaster, 'chain' | 'kotakUnderlying'>;
export type LiveRest = Pick<KotakRest, 'quotes' | 'optionChain'>;

export interface LiveMarketTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface LiveMarketLogger {
  debug?(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error?(msg: string): void;
}

export interface KotakLiveMarketOptions {
  ref: LiveRef;
  /** Null when Kotak REST is unavailable (no credentials); REST paths then throw `restUnavailable`. */
  rest: LiveRest | null;
  restUnavailable?: string;
  calendar: TradingCalendar;
  /** Calendar of a symbol's exchange (MCX for commodities); default `calendar`. */
  calendarOf?: (symbol: string) => TradingCalendar;
  now?: () => number;
  timers?: LiveMarketTimers;
  logger?: LiveMarketLogger;
  /** Broker login state for health() (no secrets). */
  sessionStatus?: () => { loggedIn: boolean; error?: string };
  wsFactory?: SFeedSocketFactory;
  /** Extra SFeed client settings (timeouts, backoff, jitter source). */
  feedOptions?: Partial<Omit<SFeedClientOptions, 'url' | 'sid' | 'ucc' | 'resolve' | 'wsFactory' | 'logger' | 'maxSubscriptions' | 'now'>>;
  /** The feed refused the session (the provider decides whether to log in again). */
  onFeedAuthError?: (err: SFeedAuthError) => void;
  /** Hard cap of (token, intent) subscriptions, default 2,700 (server limit 3,000). */
  tokenBudget?: number;
  /** TTL of a watch() without one, default 2 min. */
  adhocTtlMs?: number;
  /** A chain counts as streamed-and-fresh when one of its subscribed legs ticked this recently, default 10 s. */
  streamFreshMs?: number;
  /** Cache TTL of a chain built from the stream, default 3 s. */
  streamChainTtlMs?: number;
  /** Cache TTL of a chain fetched over REST (on demand or by the sweep), default 90 s. */
  restChainTtlMs?: number;
  /** Strikes per REST option-chain call (a multiple of 10), default 40. */
  chainStrikeCount?: number;
  /** A book not refreshed for this long is dropped when a book-less update arrives, default 10 s. */
  bookMaxAgeMs?: number;
  /** Gap between two sweep calls, default 1,500 ms. */
  sweepSpacingMs?: number;
  /** Re-check interval while the sweep is paused, default 60 s. */
  sweepIdlePollMs?: number;
  /** Cap of the back-off after consecutive sweep failures, default 60 s. */
  sweepMaxBackoffMs?: number;
}

export interface SweepFailure {
  symbol: string;
  expiry: string;
  error: string;
  at: number;
}

export interface SweepStatus {
  running: boolean;
  /** Why the sweep is waiting (outside session hours, master not loaded, no credentials …). */
  paused: string | null;
  /** Complete passes since startSweep(). */
  passes: number;
  lastFullPassAt: number | null;
  lastPassDurationMs: number | null;
  /** The pass in progress. */
  current: { done: number; total: number; failures: number; startedAt: number } | null;
  recentFailures: SweepFailure[];
}

export interface LiveMarketDetails {
  feed: SFeedHealth | null;
  feedError?: string;
  subscriptions: {
    budget: number;
    /** (token, intent) pairs wanted, after the budget cut. */
    desired: number;
    pinned: number;
    adhoc: number;
    /** Wanted but over budget (lowest priority first out). */
    dropped: { count: number; examples: string[] };
    /** Not listed in the instrument master (or master not loaded): not subscribed. */
    unresolved: { count: number; examples: string[] };
  };
  /** Instruments with a live quote in the cache. */
  quotes: number;
  chainsCached: number;
  restError?: { message: string; at: number };
  sweep: SweepStatus;
}

/* ------------------------------------------------------------------------------------------ */
/* Quote merging (pure)                                                                         */
/* ------------------------------------------------------------------------------------------ */

/** Cached state of one instrument: the fields known so far (a LiveQuote once `q.ltp` is set). */
export interface QuoteCell {
  q: LiveQuotePatch;
  /** ts of the update that last set the order book. */
  bookTs?: number;
  /** ts of the last SFeed update. */
  streamTs?: number;
}

export interface MergeRules {
  /** The patch reports the whole order book (absent book fields mean "empty"). */
  book: boolean;
  /** The patch comes from the SFeed stream. */
  stream: boolean;
  /** Same session date (IST) for two timestamps. */
  sameDay: (a: number, b: number) => boolean;
  bookMaxAgeMs: number;
  streamFreshMs: number;
}

const PLAUSIBLE_FROM_MS = Date.UTC(2000, 0, 1);
const DAY_AHEAD_MS = 86_400_000;

/** Order-book fields: replaced together by a book-carrying update. */
export const BOOK_FIELDS = ['bid', 'ask', 'bidQty', 'askQty', 'depth', 'totalBuyQty', 'totalSellQty'] as const;
const BOOK = new Set<string>(BOOK_FIELDS);

type PatchFields = Record<string, unknown>;

/** Merge one update into a cached cell (see the module comment for the rules). Never invents a field. */
export function mergeCell(prev: QuoteCell | undefined, patch: LiveQuotePatch, rules: MergeRules): QuoteCell {
  let base = prev;
  if (base && !rules.sameDay(base.q.ts, patch.ts)) {
    // Another session: an older-day patch is stale; a newer day starts the quote afresh.
    if (patch.ts < base.q.ts) return base;
    base = undefined;
  }
  const src = patch as unknown as PatchFields;
  if (base && (patch.ts < base.q.ts || (!rules.stream && base.streamTs !== undefined && patch.ts - base.streamTs <= rules.streamFreshMs))) {
    // Older than what we have, or REST while the stream is live: fill gaps only (e.g. prevOi).
    const q = { ...base.q } as unknown as PatchFields;
    let changed = false;
    for (const [k, v] of Object.entries(src)) {
      if (k === 'key' || k === 'ts' || BOOK.has(k) || v === undefined || q[k] !== undefined) continue;
      q[k] = v;
      changed = true;
    }
    return changed ? { ...base, q: q as unknown as LiveQuotePatch } : base;
  }
  const q = (base ? { ...base.q } : {}) as unknown as PatchFields;
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) delete q[k];
    else q[k] = v;
  }
  const next: QuoteCell = { q: q as unknown as LiveQuotePatch, streamTs: rules.stream ? patch.ts : base?.streamTs };
  if (rules.book) {
    for (const f of BOOK_FIELDS) if (!(f in src) || src[f] === undefined) delete q[f];
    next.bookTs = patch.ts;
  } else if (base?.bookTs !== undefined) {
    if (patch.ts - base.bookTs > rules.bookMaxAgeMs) for (const f of BOOK_FIELDS) delete q[f];
    else next.bookTs = base.bookTs;
  }
  if (next.streamTs === undefined) delete next.streamTs;
  if (next.bookTs === undefined) delete next.bookTs;
  return next;
}

/* ------------------------------------------------------------------------------------------ */
/* Helpers                                                                                      */
/* ------------------------------------------------------------------------------------------ */

const TIER_RANK: Record<WatchTier, number> = { index: 0, user: 1, underlying: 2, chain: 3, adhoc: 4 };
const LEVEL_RANK: Record<WatchLevel, number> = { ltp: 0, quote: 1, depth: 2 };
const INTENT: Record<WatchLevel, SFeedSub['intent']> = { ltp: 'lite', quote: 'scrips', depth: 'depth' };

/** Canonical key: upper-case symbol, strike rounded to the paisa (as the scrip master stores it). */
export function canonicalKey(k: InstrumentKey): InstrumentKey {
  const key: InstrumentKey = { symbol: k.symbol.trim().toUpperCase(), kind: k.kind };
  if (k.expiry !== undefined) key.expiry = k.expiry;
  if (k.strike !== undefined) key.strike = Math.round(k.strike * 100) / 100;
  return key;
}

const keyOfListing = (l: Listing): InstrumentKey => canonicalKey({ symbol: l.symbol, kind: l.kind, expiry: l.expiry, strike: l.strike });

/** Index spots are listed (and streamed) by name, never by a numeric token. */
export const isIndexSpot = (l: Listing): boolean => l.kind === 'SPOT' && !/^\d+$/.test(l.token);

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function copyQuote(q: LiveQuotePatch): LiveQuote {
  const out = { ...q, key: { ...q.key } } as LiveQuote;
  if (q.depth) out.depth = { bids: q.depth.bids.map((l) => ({ ...l })), asks: q.depth.asks.map((l) => ({ ...l })) };
  return out;
}

function copyChain(c: RawChain): RawChain {
  const out: RawChain = { symbol: c.symbol, expiry: c.expiry, ts: c.ts, rows: c.rows.map((r) => ({ strike: r.strike, ...(r.ce ? { ce: copyQuote(r.ce) } : {}), ...(r.pe ? { pe: copyQuote(r.pe) } : {}) })) };
  if (c.spot) out.spot = copyQuote(c.spot);
  if (c.future) out.future = copyQuote(c.future);
  return out;
}

/** Option-chain leg → patch with the fields the leg carries (also without an LTP: OI/prevOi are real). */
function legPatch(leg: KotakChainLeg, key: InstrumentKey, ts: number): LiveQuotePatch {
  const p: LiveQuotePatch = { key, ts };
  const set = <K extends keyof LiveQuotePatch>(k: K, v: LiveQuotePatch[K] | undefined) => {
    if (v !== undefined) p[k] = v;
  };
  set('ltp', leg.ltp);
  set('open', leg.open);
  set('high', leg.high);
  set('low', leg.low);
  set('prevClose', leg.prevClose);
  set('volume', leg.volume);
  set('oi', leg.oi);
  set('prevOi', leg.prevOi);
  return p;
}

const realTimers: LiveMarketTimers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

const noopLogger: LiveMarketLogger = { info: () => {}, warn: () => {} };

interface AdhocWatch {
  key: InstrumentKey;
  level: WatchLevel;
  expiresAt: number;
  touchedAt: number;
}

interface CachedChain {
  chain: RawChain;
  builtAt: number;
  source: 'stream' | 'rest';
}

/* ------------------------------------------------------------------------------------------ */
/* KotakLiveMarket                                                                              */
/* ------------------------------------------------------------------------------------------ */

export class KotakLiveMarket implements LiveMarket {
  private readonly ref: LiveRef;
  private readonly now: () => number;
  private readonly timers: LiveMarketTimers;
  private readonly log: LiveMarketLogger;
  readonly budget: number;
  private readonly adhocTtlMs: number;
  private readonly streamFreshMs: number;
  private readonly streamChainTtlMs: number;
  private readonly restChainTtlMs: number;
  private readonly chainCount: number;
  private readonly bookMaxAgeMs: number;
  private readonly restUnavailable: string;

  private readonly cells = new Map<string, QuoteCell>();
  private readonly listeners = new Set<(q: LiveQuote, meta?: TickMeta) => void>();

  // Subscriptions
  private feed: SFeedClient | null = null;
  private feedError: string | undefined;
  private pinned: WatchEntry[] = [];
  private readonly adhoc = new Map<string, AdhocWatch>();
  private desiredSubs: SFeedSub[] = [];
  private subscribedIds = new Set<string>();
  private dropped = { count: 0, examples: [] as string[] };
  private unresolved = { count: 0, examples: [] as string[] };
  private syncQueued = false;
  private expiryTimer: unknown = null;
  private closed = false;

  // Chains and REST
  private readonly chains = new Map<string, CachedChain>();
  private readonly chainInflight = new Map<string, Promise<void>>();
  private restError: { message: string; at: number } | undefined;

  // Sweep
  private sweepTimer: unknown = null;
  private readonly sweep = {
    running: false,
    paused: null as string | null,
    passes: 0,
    lastFullPassAt: null as number | null,
    lastPassDurationMs: null as number | null,
    queue: [] as { symbol: string; expiry: string }[],
    current: null as SweepStatus['current'],
    consecutiveFailures: 0,
    recentFailures: [] as SweepFailure[],
  };

  constructor(private readonly opts: KotakLiveMarketOptions) {
    this.ref = opts.ref;
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? realTimers;
    this.log = opts.logger ?? noopLogger;
    this.budget = Math.max(1, Math.min(3000, Math.floor(opts.tokenBudget ?? 2700)));
    this.adhocTtlMs = opts.adhocTtlMs ?? 120_000;
    this.streamFreshMs = opts.streamFreshMs ?? 10_000;
    this.streamChainTtlMs = opts.streamChainTtlMs ?? 3_000;
    this.restChainTtlMs = opts.restChainTtlMs ?? 90_000;
    this.chainCount = opts.chainStrikeCount ?? 40;
    this.bookMaxAgeMs = opts.bookMaxAgeMs ?? 10_000;
    this.restUnavailable = opts.restUnavailable ?? 'Kotak REST is not available';
  }

  /* ---------------------------------- quotes ---------------------------------- */

  /** The cached quote when it has an LTP and is dated a live session (see liveDates); else undefined. */
  quote(key: InstrumentKey): LiveQuote | undefined {
    return this.liveQuote(key, this.liveDates(this.now(), key.symbol));
  }

  quotes(keys: InstrumentKey[]): Map<string, LiveQuote> {
    const out = new Map<string, LiveQuote>();
    const now = this.now();
    const bySymbol = new Map<string, Set<string>>();
    for (const k of keys) {
      let dates = bySymbol.get(k.symbol);
      if (!dates) bySymbol.set(k.symbol, (dates = this.liveDates(now, k.symbol)));
      const q = this.liveQuote(k, dates);
      if (q) out.set(keyId(q.key), q);
    }
    return out;
  }

  /**
   * The instrument whose quotes stand for `key` (ReferenceData.quoteKey: an MCX commodity's SPOT is
   * its near-month future), canonical. Identity while the master is not loaded.
   */
  private alias(key: InstrumentKey): InstrumentKey {
    const k = canonicalKey(key);
    try {
      return canonicalKey(this.ref.quoteKey(k));
    } catch {
      return k;
    }
  }

  /** The live quote of `key` (through its alias), reported under the key asked for. */
  private liveQuote(key: InstrumentKey, dates: Set<string>): LiveQuote | undefined {
    const c = this.cells.get(keyId(this.alias(key)));
    if (!c || c.q.ltp === undefined || !dates.has(this.dayOf(c.q.ts))) return undefined;
    const q = copyQuote(c.q);
    q.key = canonicalKey(key);
    return q;
  }

  onTick(listener: (q: LiveQuote, meta?: TickMeta) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private dayOf(ts: number): string {
    return this.opts.calendar.session(ts).date;
  }

  /** Merge an update into the cache and fan the merged quote out; returns it once it has an LTP. */
  private merge(patch: LiveQuotePatch, how: { book: boolean; stream: boolean }): LiveQuote | undefined {
    const key = canonicalKey(patch.key);
    const id = keyId(key);
    const prev = this.cells.get(id);
    // A source time we cannot place (not a number, before 2000, or more than a day ahead) would
    // break the session-date lookup: use the receive time instead.
    const now = this.now();
    const ts = Number.isFinite(patch.ts) && patch.ts >= PLAUSIBLE_FROM_MS && patch.ts <= now + DAY_AHEAD_MS ? patch.ts : now;
    const next = mergeCell(prev, { ...patch, key, ts }, { ...how, sameDay: (a, b) => this.dayOf(a) === this.dayOf(b), bookMaxAgeMs: this.bookMaxAgeMs, streamFreshMs: this.streamFreshMs });
    if (next === prev) return prev && prev.q.ltp !== undefined ? copyQuote(prev.q) : undefined;
    this.cells.set(id, next);
    if (next.q.ltp === undefined) return undefined;
    for (const fn of this.listeners) {
      try {
        fn(copyQuote(next.q), { stream: how.stream });
      } catch (e) {
        this.log.warn(`live: tick listener failed: ${errMsg(e)}`);
      }
    }
    return copyQuote(next.q);
  }

  private listingOf(key: InstrumentKey): Listing | undefined {
    try {
      return this.ref.listing(key);
    } catch {
      return undefined; // master not loaded yet
    }
  }

  /**
   * Session dates whose quotes are live now (as LivePricing: today; outside hours also the last
   * session). A quote of an older session is never served as live (quote(), quotes(), refresh(),
   * chain()), even while no update of today has replaced it in the cache yet.
   */
  private liveDates(now: number, symbol?: string): Set<string> {
    const cal = (symbol && this.opts.calendarOf?.(symbol)) || this.opts.calendar;
    const s = cal.session(now);
    const dates = new Set([s.date]);
    if (s.status !== 'open') dates.add(cal.isTradingDay(s.date) && now >= cal.ts(s.date, 0) ? s.date : cal.prev(s.date));
    return dates;
  }

  /** Fresh quotes over REST (≤ 50 per call, rate-limited by the session); merged into the cache. */
  async refresh(keys: InstrumentKey[]): Promise<Map<string, LiveQuote>> {
    const out = new Map<string, LiveQuote>();
    if (!this.opts.rest) throw new NoLiveData(this.restUnavailable);
    // Keys asked for, by the instrument whose quotes stand for them (a commodity SPOT: its future).
    const byNeo = new Map<string, { key: InstrumentKey; listing: Listing; asked: InstrumentKey[] }>();
    const unknown: string[] = [];
    for (const k of keys) {
      const asked = canonicalKey(k);
      const key = this.alias(asked);
      const l = this.listingOf(key);
      if (!l) unknown.push(keyId(asked));
      else {
        const neo = ScripMaster.neosymbol(l);
        const hit = byNeo.get(neo);
        if (hit) hit.asked.push(asked);
        else byNeo.set(neo, { key, listing: l, asked: [asked] });
      }
    }
    if (!byNeo.size) {
      if (unknown.length) throw new NoLiveData(`Not in the instrument master: ${unknown.slice(0, 5).join(', ')}${unknown.length > 5 ? ` (+${unknown.length - 5})` : ''}`);
      return out;
    }
    let res: Awaited<ReturnType<LiveRest['quotes']>>;
    try {
      res = await this.opts.rest.quotes([...byNeo.keys()]);
    } catch (e) {
      this.noteRestError(e);
      throw e;
    }
    if (res.errors.length) this.noteRestError(new Error(res.errors[0].error));
    const receivedAt = this.now();
    for (const kq of res.quotes.values()) {
      let hit = byNeo.get(kq.neosymbol);
      if (!hit) {
        // An index asked for by name can come back by its numeric token.
        const l = this.ref.byToken(kq.segment as Segment, kq.token);
        if (l) hit = byNeo.get(ScripMaster.neosymbol(l));
      }
      if (!hit) continue;
      const indexSpot = isIndexSpot(hit.listing);
      const q = quoteToLive(kq, hit.key, receivedAt, indexSpot ? 'index' : 'stock');
      if (!q) continue; // no LTP: nothing to report
      const merged = this.merge(q, { book: !indexSpot, stream: false });
      // An instrument whose latest update is of an older session (e.g. not traded today) is not live.
      if (merged && this.liveDates(receivedAt, hit.key.symbol).has(this.dayOf(merged.ts))) {
        for (const asked of hit.asked) out.set(keyId(asked), { ...merged, key: asked });
      }
    }
    return out;
  }

  private noteRestError(e: unknown): void {
    this.restError = { message: errMsg(e), at: this.now() };
  }

  /* ---------------------------------- subscriptions ---------------------------------- */

  /** Replace the pinned (universe) subscriptions; callers pass them in priority order. */
  setPinned(entries: readonly WatchEntry[]): void {
    this.pinned = entries.map((e) => ({ key: this.alias(e.key), tier: e.tier, level: e.level ?? 'quote' }));
    this.scheduleSync();
  }

  watch(keys: InstrumentKey[], level: WatchLevel = 'quote', ttlMs: number = this.adhocTtlMs): void {
    const now = this.now();
    for (const k of keys) {
      const key = this.alias(k);
      const id = keyId(key);
      const prev = this.adhoc.get(id);
      const keepLevel = prev && prev.expiresAt > now && LEVEL_RANK[prev.level] > LEVEL_RANK[level];
      this.adhoc.set(id, { key, level: keepLevel ? prev.level : level, expiresAt: Math.max(prev?.expiresAt ?? 0, now + Math.max(0, ttlMs)), touchedAt: now });
    }
    this.scheduleExpiry();
    this.scheduleSync();
  }

  /** Recompute the desired subscription set now (normally coalesced per tick). */
  syncSubscriptions(): void {
    const now = this.now();
    type Want = { key: InstrumentKey; tier: WatchTier; level: WatchLevel; order: number };
    const wants = new Map<string, Want>();
    let order = 0;
    const consider = (key: InstrumentKey, tier: WatchTier, level: WatchLevel) => {
      const id = keyId(key);
      const w = wants.get(id);
      if (!w) wants.set(id, { key, tier, level, order: order++ });
      else {
        if (TIER_RANK[tier] < TIER_RANK[w.tier]) w.tier = tier;
        if (LEVEL_RANK[level] > LEVEL_RANK[w.level]) w.level = level;
      }
    };
    // Stable sort: within a tier the caller's order (nearest strikes first) is kept.
    for (const e of [...this.pinned].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier])) consider(e.key, e.tier, e.level ?? 'quote');
    // Ad-hoc: most recently used first, so the least recently used are cut by the budget.
    for (const a of [...this.adhoc.values()].filter((a) => a.expiresAt > now).sort((a, b) => b.touchedAt - a.touchedAt)) consider(a.key, 'adhoc', a.level);

    const ordered = [...wants.values()].sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.order - b.order);
    const subs: SFeedSub[] = [];
    const ids: string[] = [];
    const dropped: string[] = [];
    const unresolved: string[] = [];
    for (const w of ordered) {
      const listing = this.listingOf(w.key);
      if (!listing) {
        unresolved.push(keyId(w.key));
        continue;
      }
      if (subs.length >= this.budget) {
        dropped.push(`${keyId(w.key)} (${w.tier})`);
        continue;
      }
      subs.push({ segment: listing.segment, token: listing.token, intent: isIndexSpot(listing) ? 'index' : INTENT[w.level] });
      ids.push(keyId(w.key));
    }
    if (dropped.length && dropped.length !== this.dropped.count) {
      this.log.warn(`live: ${dropped.length} instrument(s) over the ${this.budget}-token budget not streamed (e.g. ${dropped.slice(0, 3).join(', ')})`);
    }
    this.dropped = { count: dropped.length, examples: dropped.slice(0, 5) };
    this.unresolved = { count: unresolved.length, examples: unresolved.slice(0, 5) };
    this.desiredSubs = subs;
    this.subscribedIds = new Set(ids);
    if (this.feed) {
      const res = this.feed.setDesired(subs);
      if (res.rejected.length) {
        // Only invalid tokens can be refused here (the list is already within the budget).
        const bad = new Set(res.rejected.map((r) => `${r.sub.segment}|${r.sub.token}|${r.sub.intent}`));
        this.subscribedIds = new Set(ids.filter((_, i) => !bad.has(`${subs[i].segment}|${subs[i].token}|${subs[i].intent}`)));
      }
    }
  }

  /** Whether an instrument is in the desired stream set (after the budget cut). */
  isStreamed(key: InstrumentKey): boolean {
    return this.subscribedIds.has(keyId(this.alias(key)));
  }

  private scheduleSync(): void {
    if (this.syncQueued || this.closed) return;
    this.syncQueued = true;
    queueMicrotask(() => {
      this.syncQueued = false;
      if (!this.closed) this.syncSubscriptions();
    });
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer !== null) this.timers.clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (!this.adhoc.size || this.closed) return;
    let next = Infinity;
    for (const a of this.adhoc.values()) next = Math.min(next, a.expiresAt);
    this.expiryTimer = this.timers.setTimeout(() => {
      this.expiryTimer = null;
      this.expireWatches();
    }, Math.max(0, next - this.now()) + 1);
  }

  private expireWatches(): void {
    const now = this.now();
    let changed = false;
    for (const [id, a] of this.adhoc) {
      if (a.expiresAt <= now) {
        this.adhoc.delete(id);
        changed = true;
      }
    }
    if (changed) this.syncSubscriptions();
    this.scheduleExpiry();
  }

  /* ---------------------------------- feed ---------------------------------- */

  /** Connect the SFeed websocket (after login), or hand a running one the new session. */
  startFeed(c: { url: string; sid: string; ucc: string }): void {
    if (this.closed) return;
    if (this.feed) {
      this.feed.updateSession({ sid: c.sid, ucc: c.ucc });
      return;
    }
    this.feedError = undefined;
    const log = this.log;
    const sfeedLog: SFeedLogger = {
      debug: (m) => log.debug?.(m),
      info: (m) => log.info(m),
      warn: (m) => log.warn(m),
      error: (m) => (log.error ?? log.warn)(m),
    };
    this.feed = new SFeedClient(
      {
        ...this.opts.feedOptions,
        url: c.url,
        sid: c.sid,
        ucc: c.ucc,
        resolve: (segment, token) => {
          const l = this.ref.byToken(segment, token);
          return l ? keyOfListing(l) : undefined;
        },
        wsFactory: this.opts.wsFactory,
        now: this.now,
        logger: sfeedLog,
        maxSubscriptions: this.budget,
      },
      {
        onQuote: (patch, meta) => this.onFeedQuote(patch, meta),
        onAuthError: (err) => {
          this.feedError = `SFeed auth failed (${err.kind}): ${err.message}`;
          this.opts.onFeedAuthError?.(err);
        },
      },
    );
    this.feed.setDesired(this.desiredSubs);
    this.feed.connect();
  }

  /**
   * Drop cached chains built longer than `maxAgeMs` ago (default: their TTL, i.e. only ones that
   * would be rebuilt anyway; 0 drops all). They are rebuilt on the next request. Returns how many.
   */
  pruneChains(maxAgeMs?: number): number {
    const now = this.now();
    let n = 0;
    for (const [id, c] of this.chains) {
      const age = maxAgeMs ?? (c.source === 'stream' ? this.streamChainTtlMs : this.restChainTtlMs);
      if (now - c.builtAt >= age) {
        this.chains.delete(id);
        n++;
      }
    }
    return n;
  }

  /** A websocket client exists (connecting, connected or reconnecting). */
  hasFeed(): boolean {
    return this.feed !== null;
  }

  /** New session credentials after a re-login. */
  updateFeedSession(c: { sid: string; ucc: string }): void {
    this.feed?.updateSession(c);
  }

  /** Stop the websocket (e.g. a fatal protocol fallback); `reason` is reported in health(). */
  async closeFeed(reason?: string): Promise<void> {
    const f = this.feed;
    this.feed = null;
    if (reason) this.feedError = reason;
    await f?.close();
  }

  private onFeedQuote(patch: LiveQuotePatch, meta: SFeedQuoteMeta): void {
    this.merge(patch, { book: meta.packet === 'marketPicture', stream: true });
  }

  /* ---------------------------------- chains ---------------------------------- */

  async chain(symbol: string, expiry: string): Promise<RawChain> {
    const sym = symbol.trim().toUpperCase();
    const listed = this.ref.chain(sym, expiry); // 404 for an unlisted expiry, NoLiveData before the master loads
    const id = `${sym}|${expiry}`;
    const now = this.now();
    const cached = this.chains.get(id);
    if (cached && now - cached.builtAt < (cached.source === 'stream' ? this.streamChainTtlMs : this.restChainTtlMs)) return copyChain(cached.chain);

    if (this.streamFresh(sym, expiry, listed, now)) {
      const c = this.buildChain(sym, expiry, now);
      if (c) {
        this.chains.set(id, { chain: c, builtAt: now, source: 'stream' });
        return copyChain(c);
      }
    }
    let restErr: unknown;
    try {
      await this.restChainOnce(sym, expiry);
    } catch (e) {
      restErr = e;
    }
    // A failed REST call still leaves the streamed quotes of today (each carries its own ts).
    const c = this.buildChain(sym, expiry, this.now());
    if (!c) {
      if (restErr instanceof NoLiveData) throw restErr;
      throw new NoLiveData(`No live quotes for the ${sym} ${expiry} option chain${restErr ? ` (${errMsg(restErr)})` : ''}`);
    }
    this.chains.set(id, { chain: c, builtAt: this.now(), source: restErr ? 'stream' : 'rest' });
    return copyChain(c);
  }

  /** One of the chain's subscribed legs ticked within `streamFreshMs`. */
  private streamFresh(symbol: string, expiry: string, listed: { strike: number }[], now: number): boolean {
    if (!this.feed || !this.feed.health().authenticated) return false;
    let latest = -Infinity;
    for (const { strike } of listed) {
      for (const kind of ['CE', 'PE'] as const) {
        const id = keyId(canonicalKey({ symbol, kind, expiry, strike }));
        if (!this.subscribedIds.has(id)) continue;
        const st = this.cells.get(id)?.streamTs;
        if (st !== undefined && st > latest) latest = st;
      }
    }
    return now - latest <= this.streamFreshMs;
  }

  /** RawChain from the cache (live-date quotes only); null when no leg has a quote. */
  /** Expiry of the future the options of `expiry` are written on (MCX: the one they settle into). */
  private futureExpiry(symbol: string, expiry: string): string {
    try {
      return this.ref.underlyingFuture(symbol, expiry) ?? expiry;
    } catch {
      return expiry;
    }
  }

  private buildChain(symbol: string, expiry: string, now: number): RawChain | null {
    const dates = this.liveDates(now, symbol);
    const live = (k: InstrumentKey): LiveQuote | undefined => this.liveQuote(k, dates);
    const rows: ChainRowLive[] = [];
    let ts = -Infinity;
    for (const { strike } of this.ref.chain(symbol, expiry)) {
      const ce = live({ symbol, kind: 'CE', expiry, strike });
      const pe = live({ symbol, kind: 'PE', expiry, strike });
      if (!ce && !pe) continue;
      const row: ChainRowLive = { strike };
      if (ce) row.ce = ce;
      if (pe) row.pe = pe;
      ts = Math.max(ts, ce?.ts ?? -Infinity, pe?.ts ?? -Infinity);
      rows.push(row);
    }
    if (!rows.length) return null;
    const chain: RawChain = { symbol, expiry, ts, rows };
    const spot = live({ symbol, kind: 'SPOT' });
    if (spot) chain.spot = spot;
    const futKey: InstrumentKey = { symbol, kind: 'FUT', expiry: this.futureExpiry(symbol, expiry) };
    const future = this.listingOf(futKey) ? live(futKey) : undefined;
    if (future) chain.future = future;
    return chain;
  }

  /** One REST option-chain call per (symbol, expiry) at a time; concurrent callers share it. */
  private restChainOnce(symbol: string, expiry: string): Promise<void> {
    const id = `${symbol}|${expiry}`;
    let p = this.chainInflight.get(id);
    if (!p) {
      p = this.restChain(symbol, expiry).finally(() => this.chainInflight.delete(id));
      this.chainInflight.set(id, p);
    }
    return p;
  }

  private async restChain(symbol: string, expiry: string): Promise<void> {
    const rest = this.opts.rest;
    if (!rest) throw new NoLiveData(this.restUnavailable);
    const { exchange, underlying } = this.ref.kotakUnderlying(symbol);
    let oc: Awaited<ReturnType<LiveRest['optionChain']>>;
    try {
      oc = await rest.optionChain({ exchange, underlying, expiry, count: this.chainCount });
    } catch (e) {
      this.noteRestError(e);
      throw e;
    }
    if (oc.expiry && oc.expiry !== expiry) {
      const e = new NoLiveData(`Kotak returned the ${oc.expiry} option chain when asked for ${symbol} ${expiry}`);
      this.noteRestError(e);
      throw e;
    }
    const at = this.now();
    for (const leg of [...oc.calls, ...oc.puts]) {
      const key = this.legKey(symbol, expiry, leg);
      if (key) this.merge(legPatch(leg, key, at), { book: false, stream: false });
    }
    // The chain's spot and future over REST when the stream does not carry them.
    const want: InstrumentKey[] = [{ symbol, kind: 'SPOT' }];
    const futKey: InstrumentKey = { symbol, kind: 'FUT', expiry: this.futureExpiry(symbol, expiry) };
    if (this.listingOf(futKey)) want.push(futKey);
    const missing = want.filter((k) => !this.isStreamed(k) || !this.quote(k));
    if (missing.length) await this.refresh(missing).catch((e) => this.noteRestError(e));
  }

  /** The leg's instrument: by token (checked against the chain asked for), else by strike/type. */
  private legKey(symbol: string, expiry: string, leg: KotakChainLeg): InstrumentKey | undefined {
    const l = this.ref.byToken(leg.segment as Segment, leg.token);
    if (l) return l.symbol === symbol && l.expiry === expiry && l.kind === leg.type ? keyOfListing(l) : undefined;
    const key = canonicalKey({ symbol, kind: leg.type, expiry, strike: leg.strike });
    return this.listingOf(key) ? key : undefined;
  }

  /* ---------------------------------- stock-option sweep ---------------------------------- */

  startSweep(): void {
    if (this.sweep.running || this.closed) return;
    this.sweep.running = true;
    this.sweep.passes = 0;
    this.sweep.queue = [];
    this.sweep.current = null;
    this.scheduleSweep(0);
  }

  stopSweep(): void {
    this.sweep.running = false;
    this.sweep.paused = null;
    if (this.sweepTimer !== null) this.timers.clearTimeout(this.sweepTimer);
    this.sweepTimer = null;
  }

  sweepStatus(): SweepStatus {
    const s = this.sweep;
    return {
      running: s.running,
      paused: s.paused,
      passes: s.passes,
      lastFullPassAt: s.lastFullPassAt,
      lastPassDurationMs: s.lastPassDurationMs,
      current: s.current ? { ...s.current } : null,
      recentFailures: s.recentFailures.map((f) => ({ ...f })),
    };
  }

  private scheduleSweep(ms: number): void {
    if (!this.sweep.running || this.closed) return;
    if (this.sweepTimer !== null) this.timers.clearTimeout(this.sweepTimer);
    this.sweepTimer = this.timers.setTimeout(() => {
      this.sweepTimer = null;
      void this.sweepStep();
    }, ms);
  }

  private stockChains(): { symbol: string; expiry: string }[] {
    const out: { symbol: string; expiry: string }[] = [];
    for (const u of this.ref.underlyings()) {
      if (u.kind !== 'stock') continue;
      const expiry = this.ref.expiries(u.symbol, 'OPT')[0];
      if (expiry) out.push({ symbol: u.symbol, expiry });
    }
    return out;
  }

  private async sweepStep(): Promise<void> {
    const s = this.sweep;
    if (!s.running) return;
    const spacing = this.opts.sweepSpacingMs ?? 1_500;
    const idle = this.opts.sweepIdlePollMs ?? 60_000;
    const now = this.now();
    if (!this.opts.rest) {
      s.paused = this.restUnavailable;
      return this.scheduleSweep(idle);
    }
    if (!this.ref.ready()) {
      s.paused = 'instrument master not loaded yet';
      return this.scheduleSweep(idle);
    }
    if (!s.queue.length) {
      if (s.current) {
        s.passes++;
        s.lastFullPassAt = now;
        s.lastPassDurationMs = now - s.current.startedAt;
        s.current = null;
      }
      // After the first pass only during the session (outside it nothing changes).
      if (s.passes >= 1 && this.opts.calendar.session(now).status !== 'open') {
        s.paused = 'outside session hours';
        return this.scheduleSweep(idle);
      }
      s.queue = this.stockChains();
      if (!s.queue.length) {
        s.paused = 'no stock options listed';
        return this.scheduleSweep(idle);
      }
      s.current = { done: 0, total: s.queue.length, failures: 0, startedAt: now };
    }
    s.paused = null;
    const item = s.queue.shift()!;
    let ok = true;
    try {
      await this.restChainOnce(item.symbol, item.expiry);
      const c = this.buildChain(item.symbol, item.expiry, this.now());
      if (c) this.chains.set(`${item.symbol}|${item.expiry}`, { chain: c, builtAt: this.now(), source: 'rest' });
      s.consecutiveFailures = 0;
    } catch (e) {
      ok = false;
      s.consecutiveFailures++;
      if (s.current) s.current.failures++;
      s.recentFailures.push({ ...item, error: errMsg(e), at: this.now() });
      if (s.recentFailures.length > 10) s.recentFailures.shift();
    }
    if (s.current) s.current.done++;
    if (!s.running) return;
    const maxBackoff = this.opts.sweepMaxBackoffMs ?? 60_000;
    this.scheduleSweep(ok ? spacing : Math.min(maxBackoff, spacing * 2 ** s.consecutiveFailures));
  }

  /* ---------------------------------- health ---------------------------------- */

  health(): FeedHealth {
    const s = this.opts.sessionStatus?.() ?? { loggedIn: false, error: this.restUnavailable };
    const f = this.feed?.health();
    const h: FeedHealth = {
      loggedIn: s.loggedIn,
      connected: !!f && f.connected && f.authenticated,
      lastTickTs: f?.lastPacketTs ?? null,
      subscribed: f?.subscribed ?? 0,
    };
    const error = !s.loggedIn ? (s.error ?? 'Not logged in to Kotak Neo') : this.feed ? (f?.error ?? (h.connected ? undefined : this.feedError)) : (this.feedError ?? 'Live feed not started');
    if (error) h.error = error;
    return h;
  }

  details(): LiveMarketDetails {
    let quotes = 0;
    for (const c of this.cells.values()) if (c.q.ltp !== undefined) quotes++;
    const now = this.now();
    let adhoc = 0;
    for (const a of this.adhoc.values()) if (a.expiresAt > now) adhoc++;
    const d: LiveMarketDetails = {
      feed: this.feed?.health() ?? null,
      subscriptions: {
        budget: this.budget,
        desired: this.desiredSubs.length,
        pinned: this.pinned.length,
        adhoc,
        dropped: { count: this.dropped.count, examples: [...this.dropped.examples] },
        unresolved: { count: this.unresolved.count, examples: [...this.unresolved.examples] },
      },
      quotes,
      chainsCached: this.chains.size,
      sweep: this.sweepStatus(),
    };
    if (this.feedError) d.feedError = this.feedError;
    if (this.restError) d.restError = { ...this.restError };
    return d;
  }

  /** Stop the sweep, timers and the websocket. */
  async close(): Promise<void> {
    this.closed = true;
    this.stopSweep();
    if (this.expiryTimer !== null) this.timers.clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    await this.closeFeed();
  }
}
