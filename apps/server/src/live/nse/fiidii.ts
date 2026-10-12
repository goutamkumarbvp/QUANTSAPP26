/**
 * FII/DII cash-market activity of the latest session from NSE's website API (nse-bse-public-data.md §5):
 * `GET /api/fiidiiTradeReact` after the cookie warm-up of /reports/fii-dii. Unofficial endpoint
 * (Akamai, NSE ToU, critic U11/U12), so it is best-effort: when blocked or gone the result is
 * `data: null` with the reason, never a filler value. Figures are provisional ₹ crore, combined
 * across exchanges; `fiidiiTradeNse` (NSE-only subset) is tried when the main path is 404 (§5
 * "Conflicting report") and labelled `scope: 'nse'`. The endpoint has no history: record daily.
 */
import type { FiiDiiDay } from '@q26/core';
import { NSE_WWW, NseError, parseDate, parseNum, type Fetched, type NseHttp } from './http';

export const FIIDII_URL = `${NSE_WWW}/api/fiidiiTradeReact`;
export const FIIDII_NSE_URL = `${NSE_WWW}/api/fiidiiTradeNse`;
export const FIIDII_WARMUP_URL = `${NSE_WWW}/reports/fii-dii`;

/** FiiDiiDay without the NIFTY fields (those come from the index closes). */
export interface FiiDiiFlows {
  date: string;
  fiiBuy: number;
  fiiSell: number;
  fiiNet: number;
  diiBuy: number;
  diiSell: number;
  diiNet: number;
  /** 'combined' = NSE+BSE+MSEI (fiidiiTradeReact); 'nse' = NSE-only (fiidiiTradeNse). */
  scope: 'combined' | 'nse';
}

type Side = { buy: number; sell: number; net: number; date: string };

/** Reads one category row: values may be numbers or strings with thousands separators (§5). */
function side(row: Record<string, unknown>, label: string): Side {
  const num = (k: string): number | undefined => {
    const v = row[k];
    return typeof v === 'number' ? (Number.isFinite(v) ? v : undefined) : typeof v === 'string' ? parseNum(v) : undefined;
  };
  const buy = num('buyValue');
  const sell = num('sellValue');
  let net = num('netValue');
  const date = parseDate(typeof row.date === 'string' ? row.date : undefined);
  if (buy === undefined || sell === undefined) throw new NseError(`fiidii: ${label} row has no buyValue/sellValue`, 'format');
  if (!date) throw new NseError(`fiidii: ${label} row has no valid date`, 'format');
  // Net is published; when absent it is the exact difference of the two published figures.
  net ??= Math.round((buy - sell) * 100) / 100;
  return { buy, sell, net, date };
}

/** Parse the fiidiiTradeReact array (`[{category:"DII",date:"DD-Mon-YYYY",buyValue,sellValue,netValue}, {category:"FII/FPI",…}]`). */
export function parseFiiDii(json: unknown, scope: FiiDiiFlows['scope'] = 'combined'): FiiDiiFlows {
  if (!Array.isArray(json)) throw new NseError('fiidii: response is not an array', 'format');
  let fii: Side | undefined;
  let dii: Side | undefined;
  for (const item of json) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    // Labels carry footnote marks on the web page ("FII/FPI *"), so match the leading word.
    const cat = typeof row.category === 'string' ? row.category.trim().toUpperCase() : '';
    if (/^FII\b|^FPI\b/.test(cat) && !fii) fii = side(row, 'FII/FPI');
    else if (/^DII\b/.test(cat) && !dii) dii = side(row, 'DII');
  }
  if (!fii || !dii) throw new NseError(`fiidii: ${!fii ? 'FII/FPI' : 'DII'} row missing`, 'format');
  if (fii.date !== dii.date) throw new NseError(`fiidii: FII date ${fii.date} differs from DII date ${dii.date}`, 'format');
  return { date: fii.date, fiiBuy: fii.buy, fiiSell: fii.sell, fiiNet: fii.net, diiBuy: dii.buy, diiSell: dii.sell, diiNet: dii.net, scope };
}

/** Latest-session FII/DII flows, or null with the reason when unavailable (never throws for HTTP/format problems). */
export async function fetchFiiDii(http: NseHttp, opts: { nseOnlyFallback?: boolean } = {}): Promise<Fetched<FiiDiiFlows>> {
  const attempts: { url: string; scope: FiiDiiFlows['scope'] }[] = [{ url: FIIDII_URL, scope: 'combined' }];
  if (opts.nseOnlyFallback !== false) attempts.push({ url: FIIDII_NSE_URL, scope: 'nse' });
  const reasons: string[] = [];
  for (const a of attempts) {
    try {
      const res = await http.getJson({ url: a.url, warmupUrl: FIIDII_WARMUP_URL });
      if (res.status !== 'ok') {
        reasons.push(`${new URL(a.url).pathname}: not found (HTTP ${res.httpStatus})`);
        continue;
      }
      return { data: parseFiiDii(res.data, a.scope) };
    } catch (e) {
      if (!(e instanceof NseError)) throw e;
      reasons.push(e.message);
      // A changed payload may still be served by the other path; a block or network failure would not be.
      if (e.kind !== 'format') break;
    }
  }
  return { data: null, reason: `FII/DII unavailable: ${reasons.join('; ')}` };
}

/**
 * The app's FiiDiiDay; null when the NIFTY close/change of the same date is not known (the caller
 * then leaves the day out instead of showing a made-up NIFTY value). The endpoint serves only the
 * latest session, so a NIFTY close of another date is refused rather than joined.
 */
export function toFiiDiiDay(flows: FiiDiiFlows, nifty: { date: string; close: number; changePct?: number } | undefined): FiiDiiDay | null {
  if (!nifty || nifty.date !== flows.date) return null;
  if (!Number.isFinite(nifty.close) || nifty.close <= 0) return null;
  if (nifty.changePct === undefined || !Number.isFinite(nifty.changePct)) return null;
  const { scope: _scope, ...v } = flows;
  return { ...v, niftyClose: nifty.close, niftyChangePct: nifty.changePct };
}
