/**
 * TEST-ONLY MCX commodities for the e2e fixture server: CRUDEOIL and GOLD as ordinary underlyings of
 * the FakeProvider (kind 'commodity', exchange MCX: price = near-month future, options written on the
 * future they settle into), with quotes priced by Black-76 at a flat test volatility and the
 * previous MCX session's last minute recorded (OI change). Every contract and price here is test
 * data, never market data.
 */
import { addDays, bsPrice, YEAR_MS } from '@q26/core';
import type { FakeProvider } from './fake-provider';

interface Spec {
  name: string;
  label: string;
  sector: string;
  fut: number;
  prev: number;
  step: number;
  lot: number;
  vol: number;
}

const SPECS: Spec[] = [
  { name: 'CRUDEOIL', label: 'Crude Oil', sector: 'Energy', fut: 5480, prev: 5436, step: 50, lot: 100, vol: 0.38 },
  { name: 'GOLD', label: 'Gold', sector: 'Precious Metals', fut: 76_250, prev: 76_010, step: 500, lot: 100, vol: 0.16 },
];

export function addTestCommodities(p: FakeProvider, today: string, r = 0.065): void {
  const optExp = addDays(today, 21);
  const futExp = addDays(today, 24);
  const nextFut = addDays(today, 55);
  const now = p.now();
  const cal = p.mcxCalendar;
  const prevDay = cal.prev(today);
  const prevLast = cal.ts(prevDay, cal.sessionMinutes(prevDay) - 1);
  const T = Math.max(1e-4, (cal.expiryTs(optExp) - now) / YEAR_MS);
  for (const s of SPECS) {
    p.ref.setUnderlying({ symbol: s.name, kind: 'commodity', name: s.label, sector: s.sector, lotSize: s.lot, strikeStep: s.step });
    p.ref.setFutures(s.name, [futExp, nextFut]);
    const atm = Math.round(s.fut / s.step) * s.step;
    const strikes = Array.from({ length: 25 }, (_, i) => atm + (i - 12) * s.step);
    p.ref.setStrikes(s.name, optExp, strikes);
    p.setQuote({ symbol: s.name, kind: 'FUT', expiry: futExp }, { ltp: s.fut, prevClose: s.prev, open: s.prev, high: s.fut + s.step / 5, low: s.prev - s.step / 5, volume: 18_000, oi: 42_000, bid: s.fut - 1, ask: s.fut + 1, bidQty: s.lot, askQty: s.lot, ts: now - 2000 });
    p.intraday.addMinutes({ symbol: s.name, kind: 'FUT', expiry: futExp }, [{ ts: prevLast, open: s.prev, high: s.prev, low: s.prev, close: s.prev, traded: true, volume: 40, oi: 40_000 }]);
    for (const k of strikes) {
      for (const kind of ['CE', 'PE'] as const) {
        // A mild smile and an OI profile peaking away from the money (test values).
        const vol = s.vol * (1 + 30 * ((k - s.fut) / s.fut) ** 2);
        const ltp = Math.max(0.05, Math.round(bsPrice(kind, s.fut, k, T, r, vol, r) * 20) / 20);
        const dist = Math.abs(k - s.fut) / s.step;
        const oi = Math.round((kind === 'CE' ? (k > s.fut ? 4000 : 1500) : k < s.fut ? 3500 : 1200) * (1 + dist / 4));
        const key = { symbol: s.name, kind, expiry: optExp, strike: k };
        p.setQuote(key, { ltp, prevClose: Math.round(ltp * (kind === 'CE' ? 0.95 : 1.04) * 20) / 20, volume: Math.round(oi * 0.6), oi, bid: Math.max(0.05, ltp - 0.5), ask: ltp + 0.5, bidQty: s.lot, askQty: s.lot, ts: now - 2000 });
        p.intraday.addMinutes(key, [{ ts: prevLast, open: ltp, high: ltp, low: ltp, close: ltp, traded: true, volume: 5, oi: Math.round(oi * 0.85) }]);
      }
    }
  }
}
