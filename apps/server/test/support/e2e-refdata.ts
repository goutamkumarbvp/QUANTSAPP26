/**
 * TEST-ONLY (Playwright, LIVE-EMPTY + cached instrument master). Writes a small same-day Kotak scrip
 * master cache under <dataDir>/refdata/<today IST>/ — exactly what the live provider writes after a
 * download — so the production bundle can start with no credentials and no network and still know
 * the NIFTY contracts. It then has a master but no live quote at all: a paper market order must be
 * rejected with "No live bid/ask", and every price stays blank.
 *
 * The rows are built with the documented 78-column CSV builders of the scrip-master tests; tokens
 * are arbitrary test numbers. Expiries are relative to today so the contracts are always live.
 *
 * Usage: tsx apps/server/test/support/e2e-refdata.ts <dataDir>
 */
import { addDays, istParts, weekday } from '@q26/core';
import { ScripMaster } from '../../src/live/kotak/scripmaster';
import { LEGACY_CM_ROWS, fakeFetch, filePaths, foRow, nseExpiry, scripCsv } from '../live/kotak-fixtures';
import { scripReply, type ScripFiles } from '../live/kotak-universe';

const dataDir = process.argv[2];
if (!dataDir) throw new Error('usage: e2e-refdata.ts <dataDir>');

const today = istParts(Date.now()).date;

/** First Tuesday strictly after `date`. */
function nextTuesday(date: string): string {
  let d = addDays(date, 1);
  while (weekday(d) !== 2) d = addDays(d, 1);
  return d;
}
/** Last Tuesday of `date`'s month. */
function lastTuesday(date: string): string {
  let d = `${date.slice(0, 7)}-28`;
  while (addDays(d, 1).slice(5, 7) === date.slice(5, 7)) d = addDays(d, 1);
  while (weekday(d) !== 2) d = addDays(d, -1);
  return d;
}

const weekly = nextTuesday(today);
let monthly = lastTuesday(today);
if (monthly <= weekly) monthly = lastTuesday(addDays(`${today.slice(0, 7)}-01`, 32));

const rows: string[] = [];
let token = 40000;
for (const expiry of [weekly, monthly]) {
  const tag = expiry.replace(/-/g, '').slice(2);
  for (let k = 23000; k <= 27000; k += 100) {
    for (const t of ['CE', 'PE'] as const) rows.push(foRow({ token: token++, inst: 'OPTIDX', name: 'NIFTY', trd: `NIFTY${tag}${k}${t}`, opt: t, expiry: nseExpiry(expiry), strike: k * 100, lot: 75 }));
  }
}
rows.push(foRow({ token: 52010, inst: 'FUTIDX', name: 'NIFTY', trd: `NIFTY${monthly.replace(/-/g, '').slice(2)}FUT`, opt: 'XX', expiry: nseExpiry(monthly), strike: -1, lot: 75, tick: 10 }));

const files: ScripFiles = {
  nse_fo: scripCsv(rows),
  bse_fo: scripCsv([]),
  nse_cm: scripCsv([LEGACY_CM_ROWS[0]]), // 26000 NIFTY index row (official 2023 sample)
  bse_cm: scripCsv([]),
};

const ff = fakeFetch((c) => {
  const r = scripReply(c.url, files);
  if (!r) throw new Error(`unexpected download ${c.url}`);
  return r;
});
const sm = new ScripMaster({ dataDir, fetch: ff.fn, filePaths: async () => filePaths(today).data.filesPaths });
await sm.refresh(today);
if (!sm.ready()) throw new Error('e2e-refdata: the test scrip master did not load');
console.log(`e2e-refdata: test scrip master cached for ${today} (NIFTY ${weekly}, ${monthly}) in ${dataDir}`);
