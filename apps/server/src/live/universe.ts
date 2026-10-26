/**
 * Streaming universe (DESIGN.md §3 "Capacity plan"): which instruments the SFeed websocket carries,
 * in priority order, inside the token budget.
 *
 *   index      the index spots and India VIX
 *   user       contracts the user holds or looks at (orders, positions, strategy legs, alerts,
 *              watchlists, running algos), supplied by a callback (Phase C)
 *   underlying near-month future of every underlying, and the stock spots (the chain spot of the
 *              stock-option sweep and the forward of stock options without a live future)
 *   chain      index option chains: the 2 nearest expiries, strikes within ±8 % of the centre,
 *              nearest strikes first so a budget cut drops the far wings; then the MCX commodities'
 *              nearest chains within ±6 %; then the focus stocks' (NIFTY heavyweights) nearest
 *              chains within ±5 %
 * MCX commodities (GOLD, SILVER, CRUDEOIL …) have no cash market: their price is the near-month
 * future, streamed in the 'index' tier with the indices (the ticker and every commodity tab read it).
 *   (ad-hoc watches are added by KotakLiveMarket.watch, below all of these)
 *
 * The chain centre is the live spot (else the live near future) and moves only when the price has
 * moved more than 2 % from it, so the subscription set does not churn every tick. The centre only
 * picks which listed strikes to stream; it is never shown as a price. Strikes come from the
 * instrument master; nothing is generated.
 */
import type { WatchEntry } from './live-market';
import { keyId, NoLiveData, type InstrumentKey, type ReferenceData, type UserContract, type WatchLevel } from './types';

export interface UniverseOptions {
  /** Option expiries streamed per index (nearest first), default 2. */
  indexExpiries?: number;
  /** Half-width of the streamed strike band as a fraction of the centre, default 0.08. */
  strikeBandPct?: number;
  /** Re-centre a chain once the price is this far (fraction) from its centre, default 0.02. */
  recentrePct?: number;
  /** Stream the stock spots in the 'underlying' tier, default true. */
  stockSpots?: boolean;
  /** Stocks whose nearest option chain is streamed too, after the index chains (the NIFTY heavyweights desk). */
  focusStocks?: readonly string[];
  /** Half-width of a focus stock's streamed strike band, default 0.05. */
  focusBandPct?: number;
  /** Half-width of an MCX commodity's streamed strike band (nearest expiry), default 0.06. */
  commodityBandPct?: number;
}

export type { UserContract } from './types';

export interface UniverseChain {
  symbol: string;
  expiry: string;
  centre: number;
  /** Listed strikes inside the band (subscribed when the budget allows). */
  strikes: number[];
}

export interface UniverseResult {
  /** Priority order: index, user, underlying, chain. */
  entries: WatchEntry[];
  /** Chains in the universe (the recorder aggregates these every minute). */
  chains: UniverseChain[];
  /** Why something is not in the universe (no price to centre a chain on, master not loaded, …). */
  notes: string[];
}

/** Spot-only listings streamed with the indices. */
export const EXTRA_INDEX_SPOTS: readonly string[] = ['INDIAVIX'];

const DEFAULTS = { indexExpiries: 2, strikeBandPct: 0.08, recentrePct: 0.02, stockSpots: true, focusBandPct: 0.05, commodityBandPct: 0.06 } as const;

const isPos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

function asUserEntry(c: UserContract): { key: InstrumentKey; level: WatchLevel } {
  return 'key' in c ? { key: c.key, level: c.level ?? 'quote' } : { key: c, level: 'quote' };
}

/**
 * The streaming universe for the given chain centres (pure). `centres` maps an index symbol to the
 * price its option band is centred on; an index without a centre gets no chain (noted).
 */
export function computeUniverse(
  ref: ReferenceData,
  centres: ReadonlyMap<string, number>,
  opts: UniverseOptions = {},
  userContracts: readonly UserContract[] = [],
): UniverseResult {
  const o = { ...DEFAULTS, ...opts };
  const notes: string[] = [];
  if (!ref.ready()) return { entries: [], chains: [], notes: ['instrument master not loaded yet'] };

  const entries: WatchEntry[] = [];
  const seen = new Set<string>();
  const add = (key: InstrumentKey, tier: WatchEntry['tier'], level: WatchLevel = 'quote') => {
    const id = keyId(key);
    if (seen.has(id)) return;
    seen.add(id);
    entries.push({ key, tier, level });
  };

  const underlyings = ref.underlyings();
  const indices = underlyings.filter((u) => u.kind === 'index');
  const commodities = underlyings.filter((u) => u.kind === 'commodity');

  // 1. Index spots and India VIX, then the commodities' price (their near-month future).
  for (const u of indices) add({ symbol: u.symbol, kind: 'SPOT' }, 'index');
  for (const u of commodities) add({ symbol: u.symbol, kind: 'FUT', expiry: u.spot.expiry ?? ref.expiries(u.symbol, 'FUT')[0] }, 'index');
  for (const symbol of EXTRA_INDEX_SPOTS) {
    if (ref.listing({ symbol, kind: 'SPOT' })) add({ symbol, kind: 'SPOT' }, 'index');
    else notes.push(`${symbol}: not in the instrument master`);
  }

  // 2. User contracts (only listed ones; an unknown key is reported, never guessed).
  for (const c of userContracts) {
    const { key, level } = asUserEntry(c);
    let listed = false;
    try {
      listed = !!ref.listing(key);
    } catch (e) {
      if (!(e instanceof NoLiveData)) throw e;
    }
    if (listed) add(key, 'user', level);
    else notes.push(`user contract ${keyId(key)} is not listed in the instrument master`);
  }

  // 3. Near-month futures of every underlying, then the stock spots.
  for (const u of underlyings) {
    const near = ref.expiries(u.symbol, 'FUT')[0];
    if (near) add({ symbol: u.symbol, kind: 'FUT', expiry: near }, 'underlying');
    else notes.push(`${u.symbol}: no future listed`);
  }
  if (o.stockSpots) for (const u of underlyings) if (u.kind === 'stock') add({ symbol: u.symbol, kind: 'SPOT' }, 'underlying');

  // 4. Index option chains around the centre, nearest strikes first across every chain.
  const chains: UniverseChain[] = [];
  const legs: { key: InstrumentKey; dist: number; order: number }[] = [];
  for (const u of indices) {
    const centre = centres.get(u.symbol);
    if (!isPos(centre)) {
      notes.push(`${u.symbol}: no live price to centre the option chain on yet`);
      continue;
    }
    const lo = centre * (1 - o.strikeBandPct);
    const hi = centre * (1 + o.strikeBandPct);
    for (const expiry of ref.expiries(u.symbol, 'OPT').slice(0, o.indexExpiries)) {
      const strikes = ref.strikes(u.symbol, expiry).filter((k) => k >= lo && k <= hi);
      chains.push({ symbol: u.symbol, expiry, centre, strikes });
      for (const strike of strikes) {
        const dist = Math.abs(strike / centre - 1);
        for (const kind of ['CE', 'PE'] as const) legs.push({ key: { symbol: u.symbol, kind, expiry, strike }, dist, order: legs.length });
      }
    }
  }
  legs.sort((a, b) => a.dist - b.dist || a.order - b.order);
  for (const l of legs) add(l.key, 'chain');

  // 4b. MCX commodity option chains: the nearest expiry, after every index leg.
  const cmdLegs: typeof legs = [];
  for (const u of commodities) {
    const centre = centres.get(u.symbol);
    if (!isPos(centre)) {
      notes.push(`${u.symbol}: no live price to centre the option chain on yet`);
      continue;
    }
    const expiry = ref.expiries(u.symbol, 'OPT')[0];
    if (!expiry) continue;
    const strikes = ref.strikes(u.symbol, expiry).filter((k) => k >= centre * (1 - o.commodityBandPct) && k <= centre * (1 + o.commodityBandPct));
    chains.push({ symbol: u.symbol, expiry, centre, strikes });
    for (const strike of strikes) {
      const dist = Math.abs(strike / centre - 1);
      for (const kind of ['CE', 'PE'] as const) cmdLegs.push({ key: { symbol: u.symbol, kind, expiry, strike }, dist, order: cmdLegs.length });
    }
  }
  cmdLegs.sort((a, b) => a.dist - b.dist || a.order - b.order);
  for (const l of cmdLegs) add(l.key, 'chain');

  // 5. Focus stocks (NIFTY heavyweights): the nearest expiry, a narrower band, after every index leg.
  const focusLegs: typeof legs = [];
  for (const symbol of o.focusStocks ?? []) {
    let u;
    try {
      u = ref.underlying(symbol);
    } catch {
      notes.push(`${symbol}: focus stock not in the instrument master`);
      continue;
    }
    const centre = centres.get(u.symbol);
    if (!isPos(centre)) {
      notes.push(`${u.symbol}: no live price to centre its option chain on yet`);
      continue;
    }
    const expiry = ref.expiries(u.symbol, 'OPT')[0];
    if (!expiry) continue;
    const strikes = ref.strikes(u.symbol, expiry).filter((k) => k >= centre * (1 - o.focusBandPct) && k <= centre * (1 + o.focusBandPct));
    chains.push({ symbol: u.symbol, expiry, centre, strikes });
    for (const strike of strikes) {
      const dist = Math.abs(strike / centre - 1);
      for (const kind of ['CE', 'PE'] as const) focusLegs.push({ key: { symbol: u.symbol, kind, expiry, strike }, dist, order: focusLegs.length });
    }
  }
  focusLegs.sort((a, b) => a.dist - b.dist || a.order - b.order);
  for (const l of focusLegs) add(l.key, 'chain');

  return { entries, chains, notes };
}

export interface LiveUniverseOptions {
  ref: ReferenceData;
  /** Live price an index chain is centred on: the spot LTP, else the near-future LTP; undefined when neither is live. */
  priceOf: (symbol: string) => number | undefined;
  options?: UniverseOptions;
}

/**
 * Keeps the chain centres between updates (re-centred only after a > 2 % move) and the user-contract
 * callback; update() returns the current universe.
 */
export class LiveUniverse {
  private readonly centres = new Map<string, number>();
  private userFn: (() => Iterable<UserContract>) | null = null;
  private lastUserError: string | undefined;

  constructor(private readonly opts: LiveUniverseOptions) {}

  /** Phase C hook: the contracts the user holds or watches. Called on every update(). */
  setUserContracts(fn: (() => Iterable<UserContract>) | null): void {
    this.userFn = fn;
  }

  update(): UniverseResult {
    const { ref, priceOf } = this.opts;
    const pct = this.opts.options?.recentrePct ?? DEFAULTS.recentrePct;
    if (ref.ready()) {
      const focus = new Set(this.opts.options?.focusStocks ?? []);
      for (const u of ref.underlyings()) {
        if (u.kind === 'stock' && !focus.has(u.symbol)) continue;
        const p = priceOf(u.symbol);
        if (!isPos(p)) continue;
        const c = this.centres.get(u.symbol);
        if (c === undefined || Math.abs(p / c - 1) > pct) this.centres.set(u.symbol, p);
      }
    }
    let user: UserContract[] = [];
    try {
      user = this.userFn ? [...this.userFn()] : [];
      this.lastUserError = undefined;
    } catch (e) {
      // A failing Phase C callback must not take the market data down with it.
      this.lastUserError = `user contracts callback failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    const res = computeUniverse(ref, this.centres, this.opts.options, user);
    if (this.lastUserError) res.notes.push(this.lastUserError);
    return res;
  }

  /** Current chain centres (diagnostics). */
  centreOf(symbol: string): number | undefined {
    return this.centres.get(symbol);
  }
}
