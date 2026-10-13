/**
 * TEST FIXTURE: a small but realistic scrip master (built with the documented 78-column CSV builders
 * of kotak-fixtures.ts) for the live-market, universe and provider tests. Strike grids follow the
 * exchanges' usual spacing; tokens are arbitrary test numbers (the verbatim NIFTY index row 26000
 * comes from the official 2023 sample).
 */
import { ScripMaster } from '../../src/live/kotak/scripmaster';
import { LEGACY_CM_ROWS, bseExpiry, cmRow, fakeFetch, filePaths, foRow, nseExpiry, scripCsv, type Reply } from './kotak-fixtures';

/** Monday; the fixture's nearest NIFTY weekly expires the next day. */
export const DAY = '2026-10-12';
export const NIFTY_W1 = '2026-10-13';
export const NIFTY_W2 = '2026-10-20';
export const MONTHLY = '2026-10-27';
export const SENSEX_W1 = '2026-10-15';
export const SENSEX_FUT = '2026-10-29';

const range = (lo: number, hi: number, step: number): number[] => {
  const out: number[] = [];
  for (let k = lo; k <= hi + 1e-9; k += step) out.push(Math.round(k * 100) / 100);
  return out;
};

export type ScripFiles = Record<'nse_cm' | 'bse_cm' | 'nse_fo' | 'bse_fo', string>;

export function universeFiles(): ScripFiles {
  let tok = 40000;
  const nseFo: string[] = [];
  const opts = (name: string, inst: string, expiry: string, strikes: number[], lot: number, trd: (k: number, t: string) => string) => {
    for (const k of strikes) for (const t of ['CE', 'PE'] as const) nseFo.push(foRow({ token: tok++, inst, name, trd: trd(k, t), opt: t, expiry: nseExpiry(expiry), strike: Math.round(k * 100), lot }));
  };
  opts('NIFTY', 'OPTIDX', NIFTY_W1, range(23000, 27000, 50), 75, (k, t) => `NIFTY26O13${k}${t}`);
  opts('NIFTY', 'OPTIDX', NIFTY_W2, range(23000, 27000, 50), 75, (k, t) => `NIFTY26O20${k}${t}`);
  opts('NIFTY', 'OPTIDX', MONTHLY, range(22000, 28000, 100), 75, (k, t) => `NIFTY26OCT${k}${t}`);
  nseFo.push(foRow({ token: 52010, inst: 'FUTIDX', name: 'NIFTY', trd: 'NIFTY26OCTFUT', opt: 'XX', expiry: nseExpiry(MONTHLY), strike: -1, lot: 75, tick: 10 }));
  opts('BANKNIFTY', 'OPTIDX', MONTHLY, range(52000, 60000, 100), 35, (k, t) => `BANKNIFTY26OCT${k}${t}`);
  nseFo.push(foRow({ token: 60100, inst: 'FUTIDX', name: 'BANKNIFTY', trd: 'BANKNIFTY26OCTFUT', opt: 'XX', expiry: nseExpiry(MONTHLY), strike: -1, lot: 35 }));
  opts('RELIANCE', 'OPTSTK', MONTHLY, range(1300, 1500, 20), 500, (k, t) => `RELIANCE26OCT${k}${t}`);
  nseFo.push(foRow({ token: 70100, inst: 'FUTSTK', name: 'RELIANCE', trd: 'RELIANCE26OCTFUT', opt: 'XX', expiry: nseExpiry(MONTHLY), strike: -1, lot: 500 }));
  opts('INFY', 'OPTSTK', MONTHLY, range(1400, 1600, 20), 400, (k, t) => `INFY26OCT${k}${t}`);
  nseFo.push(foRow({ token: 70200, inst: 'FUTSTK', name: 'INFY', trd: 'INFY26OCTFUT', opt: 'XX', expiry: nseExpiry(MONTHLY), strike: -1, lot: 400 }));

  let btok = 800000;
  const bseFo: string[] = [];
  for (const k of range(80000, 84000, 100)) {
    for (const t of ['CE', 'PE'] as const) bseFo.push(foRow({ seg: 'bse_fo', token: btok++, inst: 'OPTIDX', name: 'SENSEX', trd: `SENSEX26O15${k}${t}`, opt: t, expiry: bseExpiry(SENSEX_W1), strike: k * 100, lot: 20 }));
  }
  bseFo.push(foRow({ seg: 'bse_fo', token: 800900, inst: 'FUTIDX', name: 'SENSEX', trd: 'SENSEX26OCTFUT', opt: 'XX', expiry: bseExpiry(SENSEX_FUT), strike: -1, lot: 20 }));

  return {
    nse_fo: scripCsv(nseFo),
    bse_fo: scripCsv(bseFo),
    nse_cm: scripCsv([
      LEGACY_CM_ROWS[0], // 26000 NIFTY index row (official 2023 sample)
      LEGACY_CM_ROWS[2], // 2885 RELIANCE-EQ (official 2023 sample)
      cmRow({ token: 1594, group: 'EQ', name: 'INFY', trd: 'INFY-EQ', desc: 'INFOSYS LIMITED' }),
    ]),
    bse_cm: scripCsv([cmRow({ seg: 'bse_cm', token: 500325, group: 'A', name: 'RELIANCE', trd: 'RELIANCE', desc: 'RELIANCE INDUSTRIES LTD.' })]),
  };
}

/** Answers the four scrip-master downloads of filePaths(day) (any other URL is unexpected). */
export function scripReply(url: string, files: ScripFiles): Reply | undefined {
  if (!url.includes('wso2-scripmaster') || url.includes('nse_com')) return undefined;
  const seg = (['nse_cm', 'bse_cm', 'nse_fo', 'bse_fo'] as const).find((s) => url.includes(`/${s}`));
  return seg ? { text: files[seg] } : undefined;
}

/** A loaded ScripMaster over the fixture files (cached under dataDir/refdata). */
export async function loadScripMaster(dataDir: string, files: ScripFiles = universeFiles(), day = DAY): Promise<ScripMaster> {
  const ff = fakeFetch((c) => {
    const r = scripReply(c.url, files);
    if (!r) throw new Error(`unexpected download ${c.url}`);
    return r;
  });
  const sm = new ScripMaster({ dataDir, fetch: ff.fn, filePaths: async () => filePaths(day).data.filesPaths });
  await sm.refresh(day);
  return sm;
}
