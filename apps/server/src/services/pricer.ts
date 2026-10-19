/**
 * Prices any instrument (spot, future, option) from the live market, and validates contracts against
 * the instrument master. Nothing is synthesised: no spreads around the LTP, no model premium. Blank
 * rules (see services/live.ts): ltp only when it is a trade of the live session; bid/ask only from a
 * live book (open session, quote ≤ 10 s old); previous close/OI from the quote, else the previous
 * session's official files; IV solved from the premium by md.pricing (at its valuation time: outside the
 * session the close of the last session; an LTP at its own trade time). An expired contract is valued
 * at the exchange's final settlement (md.history.settlement), else NoLiveData until it is published.
 */
import { expiryTs, formatExpiry, type InstrumentType } from '@q26/core';
import { NoLiveData } from '../live/types';
import type { InstrumentKey, Listing, MarketDataProvider } from '../live/types';
import { changeOf, eodClose, futKey, httpError, liveBook, liveDates, livePrice, optKey, pct, saneMid, sessionDateOf, spotKey } from './live';

export interface InstrumentSpec {
  symbol: string;
  type: InstrumentType | 'EQ';
  strike?: number;
  expiry?: string;
}

export interface PricedInstrument {
  label: string;
  key: InstrumentKey;
  /** Live-session trade price; an expired contract's settlement value; null when not live. */
  ltp: number | null;
  /** Live best bid/ask (open session, fresh book); null otherwise. */
  bid: number | null;
  ask: number | null;
  bidQty: number | null;
  askQty: number | null;
  prevClose: number | null;
  change: number | null;
  changePct: number | null;
  oi: number | null;
  prevOi: number | null;
  oiChangePct: number | null;
  /** Percent. Options: solved from the live premium (mid of a sane live book, else the LTP); EQ: the ATM IV; FUT: null. */
  iv: number | null;
  /** Contract lot size (instrument master; for an expired contract the official file of its last day), null when unknown. */
  lotSize: number | null;
  /** Price step of the listing; null for index spots (not traded). */
  tickSize: number | null;
  expired: boolean;
  /** Quote time (epoch ms), null without a quote. */
  ts: number | null;
  /** Why ltp/bid/ask are blank. */
  reason?: string;
}

export function instrumentLabel(spec: InstrumentSpec): string {
  if (spec.type === 'EQ') return spec.symbol;
  if (spec.type === 'FUT') return `${spec.symbol} ${formatExpiry(spec.expiry!)} FUT`;
  return `${spec.symbol} ${formatExpiry(spec.expiry!)} ${spec.strike} ${spec.type}`;
}

export function instrumentKey(spec: InstrumentSpec & { product?: string }): string {
  return [spec.symbol, spec.type, spec.strike ?? 0, spec.expiry ?? '', spec.product ?? ''].join('|');
}

/** Provider key of a spec (EQ → the underlying's SPOT listing). */
export function specKey(spec: InstrumentSpec): InstrumentKey {
  if (spec.type === 'EQ') return spotKey(spec.symbol);
  if (spec.type === 'FUT') return futKey(spec.symbol, spec.expiry!);
  return optKey(spec.symbol, spec.expiry!, spec.type, Number(spec.strike));
}

export interface ValidateOptions {
  /** Validating for an order: index spots are not tradable. */
  trade?: boolean;
}

export class Pricer {
  constructor(private readonly md: MarketDataProvider) {}

  /**
   * The listing of a live contract: 404 for an unknown symbol, 503 while the instrument master is
   * not loaded, 400 when the expiry/strike is not listed or has expired, and (for orders) when the
   * instrument is an index spot.
   */
  validate(spec: InstrumentSpec, ts: number = this.md.clock.now(), opts: ValidateOptions = {}): Listing {
    const u = this.md.ref.underlying(spec.symbol);
    const symbol = u.symbol;
    if (spec.type === 'EQ') {
      if (opts.trade && u.kind === 'index') throw httpError(400, `${symbol} is an index and cannot be traded: trade its futures or options`);
      const l = this.md.ref.listing(spotKey(symbol));
      if (!l) throw httpError(400, `${symbol} has no cash listing`);
      return l;
    }
    if (!spec.expiry) throw httpError(400, 'Expiry is required');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(spec.expiry)) throw httpError(400, `Invalid expiry '${spec.expiry}'`);
    if (expiryTs(spec.expiry) < ts) throw httpError(400, 'Contract has expired');
    if (spec.type === 'FUT') {
      if (!this.md.ref.expiries(symbol, 'FUT').includes(spec.expiry)) throw httpError(400, `${symbol} future ${spec.expiry} is not listed`);
    } else {
      if (!this.md.ref.expiries(symbol, 'OPT').includes(spec.expiry)) throw httpError(400, `${symbol} expiry ${spec.expiry} is not listed`);
      if (!this.md.ref.strikes(symbol, spec.expiry).includes(Number(spec.strike))) throw httpError(400, `Strike ${spec.strike} is not available for ${symbol} ${spec.expiry}`);
    }
    const l = this.md.ref.listing(specKey({ ...spec, symbol }));
    if (!l) throw httpError(400, `${instrumentLabel({ ...spec, symbol })} is not listed`);
    return l;
  }

  /** Lot size of a contract on its last listed day (its expiry), from the official files (expired contracts); null when not loaded. */
  pastLotSize(key: InstrumentKey): number | null {
    if (!key.expiry) return null;
    try {
      if (key.kind === 'FUT') return this.md.history.dailyFutures(key.symbol, key.expiry, key.expiry).find((f) => f.expiry === key.expiry)?.lotSize ?? null;
      return this.md.history.dailyOptions(key.symbol, key.expiry, key.expiry).find((o) => o.type === key.kind && o.strike === key.strike)?.lotSize ?? null;
    } catch {
      return null;
    }
  }

  price(spec: InstrumentSpec, ts: number = this.md.clock.now()): PricedInstrument {
    const md = this.md;
    const u = md.ref.underlying(spec.symbol);
    const s = { ...spec, symbol: u.symbol, ...(spec.type !== 'EQ' && spec.type !== 'FUT' ? { strike: Number(spec.strike) } : {}) };
    const label = instrumentLabel(s);
    const key = specKey(s);
    const blank = { bid: null, ask: null, bidQty: null, askQty: null, prevClose: null, change: null, changePct: null, oi: null, prevOi: null, oiChangePct: null, iv: null };

    if (s.type !== 'EQ') {
      if (!s.expiry) throw httpError(400, 'Expiry is required');
      if (expiryTs(s.expiry) < ts) {
        const settle = md.history.settlement(key);
        if (settle === undefined) throw new NoLiveData(`Awaiting the exchange settlement price for ${label}`);
        let lot: number | null = null;
        try {
          lot = md.ref.listing(key)?.lotSize ?? null;
        } catch {
          lot = null;
        }
        return { label, key, ltp: settle, ...blank, lotSize: lot ?? this.pastLotSize(key), tickSize: null, expired: true, ts: null };
      }
    }

    const listing = md.ref.listing(key);
    if (!listing) throw httpError(400, `${label} is not listed`);
    const base = { label, key, lotSize: listing.lotSize, tickSize: listing.tickSize ?? null, expired: false };
    const q = md.live.quote(key);
    if (!q) {
      md.live.watch([key], 'quote');
      return { ...base, ltp: null, ...blank, ts: null, reason: `No live quote for ${label} yet` };
    }
    const now = md.clock.now();
    const dates = liveDates(md);
    const ltp = livePrice(md, q, dates);
    const book = liveBook(md, q, now);
    const prevDate = md.calendar.prev(sessionDateOf(md, q.ts));
    let prevClose: number | null = q.prevClose !== undefined && q.prevClose > 0 ? q.prevClose : null;
    let prevOi: number | null = q.prevOi !== undefined && Number.isFinite(q.prevOi) ? q.prevOi : null;
    if (prevClose === null || (prevOi === null && s.type !== 'EQ')) {
      if (s.type === 'EQ') prevClose ??= eodClose(md, u.symbol, prevDate);
      else if (s.type === 'FUT') {
        const row = md.history.dailyFutures(u.symbol, prevDate, prevDate).find((f) => f.expiry === s.expiry);
        if (row) {
          prevClose ??= row.volume > 0 && row.close > 0 ? row.close : null;
          prevOi ??= row.oi;
        }
      } else {
        const row = md.history.dailyOptions(u.symbol, prevDate, s.expiry).find((o) => o.type === s.type && o.strike === s.strike);
        if (row) {
          prevClose ??= row.volume > 0 && row.close > 0 ? row.close : null;
          prevOi ??= row.oi;
        }
      }
    }
    const oi = q.oi !== undefined && Number.isFinite(q.oi) ? q.oi : null;
    let iv: number | null = null;
    if (s.type === 'EQ') iv = pct(md.pricing.atmIv(u.symbol));
    else if (s.type !== 'FUT') {
      // Valued at md.pricing's valuation time; an LTP (no sane live book) at its own trade time.
      const mid = saneMid(book);
      const premium = mid ?? ltp;
      if (premium !== null) iv = pct(md.pricing.iv({ symbol: u.symbol, expiry: s.expiry!, type: s.type, strike: s.strike as number, premium, ...(mid === null ? { ltt: q.ltt } : {}) }));
    }
    const reasons: string[] = [];
    if (ltp === null) reasons.push(`${label} has not traded in the live session`);
    if (!book && s.type !== 'EQ') reasons.push(md.calendar.session(now).status === 'open' ? `no live bid/ask for ${label}` : 'market closed: no live bid/ask');
    return {
      ...base,
      ltp,
      bid: book?.bid ?? null,
      ask: book?.ask ?? null,
      bidQty: book?.bidQty ?? null,
      askQty: book?.askQty ?? null,
      prevClose,
      ...changeOf(ltp, prevClose),
      oi,
      prevOi,
      oiChangePct: oi !== null && prevOi ? +(((oi - prevOi) / prevOi) * 100).toFixed(2) : null,
      iv,
      ts: q.ts,
      ...(reasons.length ? { reason: reasons.join('; ') } : {}),
    };
  }
}
