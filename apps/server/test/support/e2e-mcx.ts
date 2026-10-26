/**
 * TEST-ONLY MCX source for the e2e fixture server: the real McxService over a synthetic mcx_fo
 * instrument file (CRUDEOIL, GOLD) and fake Kotak quotes priced by Black-76 at a flat test volatility.
 * Every contract and price here is test data, never market data.
 */
import { bsPrice, YEAR_MS } from '@q26/core';
import { McxService } from '../../src/live/kotak/mcx';
import type { KotakQuote, KotakRest, QuotesResult } from '../../src/live/kotak/rest';

const HEADER = 'pSymbol,pGroup,pExchSeg,pInstType,pSymbolName,pTrdSymbol,pOptionType,pScripRefKey,lExpiryDate ,dStrikePrice;,lLotSize,dTickSize ,pSegment';
const epoch = (d: string) => String(Date.parse(`${d}T23:59:59+05:30`) / 1000);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

interface Spec { name: string; fut: number; step: number; lot: number; vol: number }
const SPECS: Spec[] = [
  { name: 'CRUDEOIL', fut: 5480, step: 50, lot: 100, vol: 0.38 },
  { name: 'GOLD', fut: 76_250, step: 500, lot: 1, vol: 0.16 },
];

export function testMcx(now: () => number, today: string, r = 0.065): McxService {
  const optExp = addDays(today, 21);
  const futExp = addDays(today, 24);
  const rows = [HEADER];
  const legs = new Map<string, { spec: Spec; k?: number; kind: 'FUT' | 'CE' | 'PE' }>();
  let t = 1000;
  for (const spec of SPECS) {
    const mon = 'TEST';
    const ft = String(t++);
    rows.push(`${ft},,mcx_fo,FUTCOM,${spec.name},${spec.name}${mon}FUT,XX,x,${epoch(futExp)},-1,${spec.lot},100,FO`);
    legs.set(ft, { spec, kind: 'FUT' });
    const atm = Math.round(spec.fut / spec.step) * spec.step;
    for (let i = -12; i <= 12; i++) {
      const k = atm + i * spec.step;
      for (const kind of ['CE', 'PE'] as const) {
        const tok = String(t++);
        rows.push(`${tok},,mcx_fo,OPTFUT,${spec.name},${spec.name}${mon}${k}${kind},${kind},x,${epoch(optExp)},${k * 100},${spec.lot},100,FO`);
        legs.set(tok, { spec, k, kind });
      }
    }
  }
  const csv = rows.join('\n') + '\n';
  const rest = {
    quotes: async (syms: string[]): Promise<QuotesResult> => {
      const quotes = new Map<string, KotakQuote>();
      const T = (Date.parse(`${optExp}T23:30:00+05:30`) - now()) / YEAR_MS;
      for (const s of syms) {
        const l = legs.get(s.split('|')[1]);
        if (!l) continue;
        const base = { neosymbol: s, segment: 'mcx_fo', token: s.split('|')[1], ts: now() - 2000 };
        if (l.kind === 'FUT') {
          quotes.set(s, { ...base, ltp: l.spec.fut, changePct: 0.8 });
          continue;
        }
        const k = l.k!;
        // A mild smile and an OI profile peaking away from the money (test values).
        const vol = l.spec.vol * (1 + 0.6 * ((k - l.spec.fut) / l.spec.fut) ** 2 * 50);
        const ltp = Math.max(0.05, Math.round(bsPrice(l.kind, l.spec.fut, k, T, r, vol, r) * 20) / 20);
        const dist = Math.abs(k - l.spec.fut) / l.spec.step;
        const oi = Math.round((l.kind === 'CE' ? (k > l.spec.fut ? 4000 : 1500) : k < l.spec.fut ? 3500 : 1200) * (1 + dist / 4));
        quotes.set(s, { ...base, ltp, changePct: l.kind === 'CE' ? 2.1 : -1.4, oi, volume: Math.round(oi * 0.6), depth: { bids: [{ price: Math.max(0.05, ltp - 0.5), qty: l.spec.lot }], asks: [{ price: ltp + 0.5, qty: l.spec.lot }] } });
      }
      return { quotes, errors: [] };
    },
  } as unknown as KotakRest;
  return new McxService({
    dataDir: null,
    rest,
    now,
    r,
    filePaths: async () => [`https://test.invalid/prod/${today}/transformed/mcx_fo.csv`],
    fetch: async () => new Response(csv),
  });
}
