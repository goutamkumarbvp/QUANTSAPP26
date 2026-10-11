/** Prices any tradable instrument (spot, future, option) incl. expiry settlement. */
import { expiryTs, formatExpiry, roundTick, type InstrumentType } from '@q26/core';
import type { MarketEngine } from '../market/engine';

export interface InstrumentSpec {
  symbol: string;
  type: InstrumentType | 'EQ';
  strike?: number;
  expiry?: string;
}

export interface PricedInstrument {
  label: string;
  ltp: number;
  bid: number;
  ask: number;
  prevClose: number;
  change: number;
  changePct: number;
  oi?: number;
  oiChangePct?: number;
  iv?: number;
  lotSize: number;
  expired: boolean;
}

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

export function instrumentLabel(spec: InstrumentSpec): string {
  if (spec.type === 'EQ') return spec.symbol;
  if (spec.type === 'FUT') return `${spec.symbol} ${formatExpiry(spec.expiry!)} FUT`;
  return `${spec.symbol} ${formatExpiry(spec.expiry!)} ${spec.strike} ${spec.type}`;
}

export function instrumentKey(spec: InstrumentSpec & { product?: string }): string {
  return [spec.symbol, spec.type, spec.strike ?? 0, spec.expiry ?? '', spec.product ?? ''].join('|');
}

export class Pricer {
  constructor(private readonly engine: MarketEngine) {}

  /** Throws 400 unless the contract is currently listed and tradable. */
  validate(spec: InstrumentSpec, ts: number): void {
    const e = this.engine;
    e.inst(spec.symbol);
    if (spec.type === 'EQ') return;
    if (!spec.expiry) throw httpError(400, 'Expiry is required');
    if (spec.type === 'FUT') {
      if (!e.futureExpiries(spec.symbol, ts).includes(spec.expiry)) throw httpError(400, `${spec.symbol} future ${spec.expiry} is not listed`);
      return;
    }
    if (!e.expiries(spec.symbol, ts).includes(spec.expiry)) throw httpError(400, `${spec.symbol} expiry ${spec.expiry} is not listed`);
    const ctx = e.contract(spec.symbol, spec.expiry);
    const strikes = e.strikes(ctx, e.parts(ts).dayIdx);
    if (!strikes.includes(Number(spec.strike))) throw httpError(400, `Strike ${spec.strike} is not available for ${spec.symbol} ${spec.expiry}`);
    if (expiryTs(spec.expiry) < ts) throw httpError(400, 'Contract has expired');
  }

  price(spec: InstrumentSpec, ts: number): PricedInstrument {
    const e = this.engine;
    const inst = e.inst(spec.symbol);
    const label = instrumentLabel(spec);
    if (spec.type === 'EQ') {
      const q = e.quote(spec.symbol, ts);
      return { label, ltp: q.ltp, bid: roundTick(q.ltp - 0.05), ask: roundTick(q.ltp + 0.05), prevClose: q.prevClose, change: q.change, changePct: q.changePct, iv: q.atmIv, lotSize: inst.lotSize, expired: false };
    }
    const expiry = spec.expiry!;
    const expTs = expiryTs(expiry);
    if (expTs < ts) {
      // Settled at the underlying's close on expiry day.
      const settleSpot = e.spot(spec.symbol, expTs);
      const settle = spec.type === 'FUT' ? settleSpot : spec.type === 'CE' ? Math.max(0, settleSpot - spec.strike!) : Math.max(0, spec.strike! - settleSpot);
      const v = roundTick(settle);
      return { label, ltp: v, bid: v, ask: v, prevClose: v, change: 0, changePct: 0, lotSize: inst.lotSize, expired: true };
    }
    const p = e.parts(ts);
    const prevIdx = Math.max(0, p.dayIdx - 1);
    if (spec.type === 'FUT') {
      const ltp = e.futurePrice(spec.symbol, expiry, ts);
      const prev = e.futurePrice(spec.symbol, expiry, 0, { dayIdx: prevIdx, m: 375 });
      const oi = e.futureOi(spec.symbol, expiry, p.dayIdx, p.m);
      const prevOi = e.futureOi(spec.symbol, expiry, prevIdx, 375);
      return {
        label, ltp, bid: roundTick(ltp - 0.05), ask: roundTick(ltp + 0.05), prevClose: prev, change: +(ltp - prev).toFixed(2), changePct: +(((ltp - prev) / prev) * 100).toFixed(2),
        oi, oiChangePct: prevOi ? +(((oi - prevOi) / prevOi) * 100).toFixed(2) : 0, lotSize: inst.lotSize, expired: false,
      };
    }
    const ctx = e.contract(spec.symbol, expiry);
    const q = e.optionQuote(ctx, spec.type, Number(spec.strike), ts);
    return { label, ltp: q.ltp, bid: q.bid, ask: q.ask, prevClose: q.prevClose, change: q.change, changePct: q.changePct, oi: q.oi, oiChangePct: q.oiChangePct, iv: q.iv, lotSize: inst.lotSize, expired: false };
  }
}
