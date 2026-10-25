/**
 * EodJobs over the real NSE sample rows (test/live/fixtures/nse) and a scripted NseHttp. Files for
 * the test date are CONSTRUCTED from those samples by changing only their date (title line, Index
 * Date column, TradDt); the FII/DII and holiday payloads are CONSTRUCTED in the documented shapes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExchangeCalendar } from '../../src/live/calendar';
import { EodJobs, type EodJobsOptions, type EodResult } from '../../src/live/eod';
import { bseFoBhavcopyUrl, nseCmBhavcopyUrl, nseFoBhavcopyUrl } from '../../src/live/nse/bhavcopy';
import { FIIDII_NSE_URL, FIIDII_URL, FIIDII_WARMUP_URL } from '../../src/live/nse/fiidii';
import { HOLIDAY_MASTER_URL, HOLIDAY_WARMUP_URL } from '../../src/live/nse/holidays';
import { legacyArchiveUrl } from '../../src/live/nse/http';
import { indCloseAllUrl } from '../../src/live/nse/indices';
import { participantUrls } from '../../src/live/nse/participants';
import { HistoryFiles } from '../../src/live/store/history';
import { ManualTimers, flush } from '../support/manual-timers';
import { fixture, html, json, testHttp, text } from './nse-fake';

/** Tuesday; the NSE F&O sample is of this date. */
const D = '2026-09-15';
const PREV = '2026-09-14';
const ist = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`);

const NSE_FO = fixture('nse-fo-20260915.csv');
const FO_HEADER = NSE_FO.split('\n')[0];
const indexCsv = (date: string) => fixture('ind_close_all_14102025.csv').replaceAll('14-10-2025', `${date.slice(8, 10)}-${date.slice(5, 7)}-${date.slice(0, 4)}`);
const participantsCsv = (title: string) => fixture('fao_participant_oi_22072026.csv').replace('Jul 22, 2026', title);
/** CONSTRUCTED CM row in the UDiFF layout (as in nse-bhavcopy.test.ts). */
const cmCsv = (date: string) => `${FO_HEADER}\n${date},${date},CM,NSE,STK,2885,INE002A01018,RELIANCE,EQ,,,,,RELIANCE INDUSTRIES LTD,1390.00,1410.00,1385.00,1402.30,1402.00,1391.00,,,,,5123456,7180000000.00,123456,F1,1,,,,,\n`;
const zip = (name: string, csv: string) => text(zipSync({ [name]: strToU8(csv) }));
const fiidii = (date: string) => [
  { category: 'DII', date, buyValue: '12,345.67', sellValue: '10,000.00', netValue: '2,345.67' },
  { category: 'FII/FPI', date, buyValue: 9876.5, sellValue: 11000, netValue: -1123.5 },
];
const HOLIDAYS = {
  CM: [{ Sr_no: 1, tradingDate: '02-Oct-2026', weekDay: 'Friday', description: 'Gandhi Jayanti' }],
  FO: [{ Sr_no: 1, tradingDate: '02-Oct-2026', weekDay: 'Friday', description: 'Gandhi Jayanti' }],
};

type Routes = Parameters<typeof testHttp>[0];
const notFound = () => text('', 404);

/** Every source of date D published (BSE not, to show the sources are independent). */
function publishedRoutes(over: Routes = {}): Routes {
  const [p1, p2] = participantUrls(D, 'oi');
  return {
    [indCloseAllUrl(D)]: text(indexCsv(D)),
    [nseFoBhavcopyUrl(D)]: zip('BhavCopy_NSE_FO_0_0_0_20260915_F_0000.csv', NSE_FO),
    [nseCmBhavcopyUrl(D)]: zip('BhavCopy_NSE_CM_0_0_0_20260915_F_0000.csv', cmCsv(D)),
    [bseFoBhavcopyUrl(D)]: notFound(),
    [p1]: text(participantsCsv('Sep 15, 2026')),
    [p2]: notFound(),
    [FIIDII_WARMUP_URL]: html(200, ['nsit=1']),
    [FIIDII_URL]: json(fiidii('15-Sep-2026')),
    [HOLIDAY_WARMUP_URL]: html(200),
    [HOLIDAY_MASTER_URL]: json(HOLIDAYS),
    ...over,
  };
}

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q26-eod-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function harness(routes: Routes, opts: Partial<EodJobsOptions> = {}, start = ist(D, '17:00')) {
  const t = testHttp(routes, { retries: 0 });
  const timers = new ManualTimers(start);
  const history = new HistoryFiles({ dataDir: dir, r: 0.065 });
  const calendar = new ExchangeCalendar();
  const logs: string[] = [];
  const eod = new EodJobs({
    http: t.http,
    history,
    calendar,
    now: timers.now,
    timers,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    backfillDays: 0,
    ...opts,
  });
  return { eod, history, calendar, timers, calls: t.calls, logs };
}

const outcomes = (rs: EodResult[]) => Object.fromEntries(rs.map((r) => [r.source, r.outcome]));

describe('EodJobs.loadDate', () => {
  it('loads every published source of a date, each on its own, joined with the same day NIFTY close', async () => {
    const h = harness(publishedRoutes());
    const res = await h.eod.loadDate(D);
    expect(outcomes(res)).toEqual({ index: 'loaded', nseFo: 'loaded', nseCm: 'loaded', bseFo: 'not-published', participants: 'loaded', fiidii: 'loaded' });

    expect(h.history.dailyBars('NIFTY', D, D)).toEqual([{ date: D, open: 25277.55, high: 25310.35, low: 25060.55, close: 25145.5, volume: 292129083, turnover: 24151.97e7 }]);
    expect(h.history.dailyBars('RELIANCE', D, D)[0]).toMatchObject({ close: 1402.3, volume: 5123456 });
    const opts = h.history.dailyOptions('NIFTY', D);
    expect(opts.map((o) => [o.expiry, o.strike, o.type])).toEqual([
      ['2026-09-15', 25900, 'PE'],
      ['2026-09-29', 26500, 'PE'],
    ]);
    expect(h.history.settlement({ symbol: 'NIFTY', kind: 'FUT', expiry: D })).toBe(23118.6);
    const part = h.history.participantOi(D, D);
    expect(part).toHaveLength(1);
    expect(part[0]).toMatchObject({ date: D, niftyClose: 25145.5 });
    expect(part[0].rows[0]).toMatchObject({ participant: 'Client', futIndexLong: 227949 });
    expect(h.history.fiiDii(D, D)).toEqual([
      { date: D, fiiBuy: 9876.5, fiiSell: 11000, fiiNet: -1123.5, diiBuy: 12345.67, diiSell: 10000, diiNet: 2345.67, scope: 'combined', niftyClose: 25145.5, niftyChangePct: -0.32 },
    ]);
    const st = h.eod.status();
    expect(st.kinds).toMatchObject({ fo: D, cm: D, index: D, participants: D, fiidii: D });
    expect(st.sources.bseFo.last).toMatchObject({ date: D, outcome: 'not-published' });
    expect(st.sources.nseFo.lastLoaded).toBe(D);

    // Again: nothing reloaded; only the unpublished BSE file is asked for again.
    const n = h.calls.length;
    const again = await h.eod.loadDate(D);
    expect(outcomes(again)).toEqual({ index: 'already-loaded', nseFo: 'already-loaded', nseCm: 'already-loaded', bseFo: 'not-published', participants: 'already-loaded', fiidii: 'already-loaded' });
    expect(h.calls.slice(n).map((c) => c.url)).toEqual([bseFoBhavcopyUrl(D)]);
  });

  it('not published yet → retried later; participants and FII/DII wait for the NIFTY close', async () => {
    let indexOut = true;
    const h = harness(publishedRoutes({ [indCloseAllUrl(D)]: () => (indexOut ? text(indexCsv(D)) : notFound()) }));
    indexOut = false;
    const first = await h.eod.loadDate(D);
    expect(outcomes(first)).toMatchObject({ index: 'not-published', participants: 'waiting', fiidii: 'waiting' });
    expect(first.find((r) => r.source === 'participants')?.reason).toMatch(/NIFTY close of 2026-09-15 not loaded yet/);
    expect(h.history.participantOi(D, D)).toEqual([]);
    expect(h.history.fiiDii(D, D)).toEqual([]); // never stored without the real NIFTY close
    indexOut = true;
    const second = await h.eod.loadDate(D);
    expect(outcomes(second)).toMatchObject({ index: 'loaded', participants: 'loaded', fiidii: 'loaded', nseFo: 'already-loaded' });
  });

  it('a blocked or malformed file is recorded with its reason, the other sources still load', async () => {
    const denied = () => text('denied', 403);
    const h = harness(
      publishedRoutes({
        [nseFoBhavcopyUrl(D)]: text('<!DOCTYPE html><html>Access Denied</html>', 200, [['content-type', 'text/html']]),
        // A block on nsearchives falls back to the legacy archives host, blocked as well.
        [nseCmBhavcopyUrl(D)]: denied,
        [legacyArchiveUrl(nseCmBhavcopyUrl(D))!]: denied,
        'https://www.nseindia.com/': html(200),
      }),
    );
    const res = await h.eod.loadDate(D);
    expect(outcomes(res)).toMatchObject({ index: 'loaded', nseFo: 'failed', nseCm: 'failed', participants: 'loaded' });
    const st = h.eod.status().sources;
    expect(st.nseFo.lastError).toMatch(/HTML|zip/i);
    expect(st.nseCm.lastError).toMatch(/403|blocked/i);
    expect(h.history.loadedDates('fo')).toEqual([]);
  });

  it('FII/DII: the endpoint has no history; NSE-only figures never replace combined ones', async () => {
    // Asked for PREV, the endpoint serves D: D is stored, PREV cannot be served.
    const h = harness(publishedRoutes({ [indCloseAllUrl(PREV)]: notFound() }));
    await h.eod.loadDate(D, ['index']);
    const r = await h.eod.loadDate(PREV, ['fiidii']);
    expect(r[0]).toMatchObject({ outcome: 'unavailable', reason: 'the FII/DII source serves only the latest session (2026-09-15)' });
    expect(h.history.fiiDii(D, D)[0].scope).toBe('combined');

    // A fresh store where only the NSE-only fallback answers: stored as 'nse', not counted as loaded.
    fs.rmSync(dir, { recursive: true, force: true });
    const g = harness(publishedRoutes({ [FIIDII_URL]: notFound(), [FIIDII_NSE_URL]: json(fiidii('15-Sep-2026')) }));
    await g.eod.loadDate(D, ['index']);
    const nse = await g.eod.loadDate(D, ['fiidii']);
    expect(nse[0]).toMatchObject({ outcome: 'not-published', reason: 'only the NSE-only figures (fiidiiTradeNse) are available so far' });
    expect(g.history.fiiDii(D, D)[0].scope).toBe('nse');
    expect(g.eod.isLoaded('fiidii', D)).toBe(false);
  });
});

describe('EodJobs schedule, holidays and backfill', () => {
  it('first attempt 18:30 IST, hourly retries while something is missing, then the next session', async () => {
    let indexOut = false;
    const h = harness(publishedRoutes({ [indCloseAllUrl(D)]: () => (indexOut ? text(indexCsv(D)) : notFound()), [bseFoBhavcopyUrl(D)]: notFound() }));
    h.eod.start();
    await h.eod.idle();
    await flush();
    expect(h.eod.status().next).toEqual({ at: ist(D, '18:30'), date: D });
    expect(h.calendar.holidays().has('2026-10-02')).toBe(true);

    await h.timers.advance(ist(D, '18:30') - h.timers.now());
    await h.eod.idle();
    await flush();
    expect(h.eod.status().sources.index.last).toMatchObject({ date: D, outcome: 'not-published' });
    expect(h.eod.status().next).toEqual({ at: ist(D, '19:30'), date: D });

    indexOut = true;
    await h.timers.advance(60 * 60_000);
    await h.eod.idle();
    await flush();
    expect(h.history.loadedDates('index')).toEqual([D]);
    // BSE is still missing: next try 20:30, the last one at 23:30, then the next session's 18:30.
    expect(h.eod.status().next).toEqual({ at: ist(D, '20:30'), date: D });
    await h.timers.advance(ist(D, '23:31') - h.timers.now());
    await h.eod.idle();
    await flush();
    expect(h.eod.status().next).toEqual({ at: ist('2026-09-16', '18:30'), date: '2026-09-16' });
    h.eod.stop();
  });

  it('a holiday master failure keeps the HOLIDAYS env list and says why', async () => {
    const h = harness(publishedRoutes({ [HOLIDAY_MASTER_URL]: text('denied', 403) }), { envHolidays: ['2026-09-17'] });
    await h.eod.refreshHolidays();
    expect([...h.calendar.holidays()]).toEqual(['2026-09-17']);
    expect(h.eod.status().holidays).toMatchObject({ source: 'env', count: 1 });
    expect(h.eod.status().holidays.error).toMatch(/HOLIDAYS env list only/);
    const ok = harness(publishedRoutes(), { envHolidays: ['2026-09-17'] });
    await ok.eod.refreshHolidays();
    expect([...ok.calendar.holidays()].sort()).toEqual(['2026-09-17', '2026-10-02']);
    expect(ok.eod.status().holidays).toMatchObject({ source: 'nse+env', count: 2 });
  });

  it('backfill loads only what is missing over the last N sessions (FII/DII: the latest session once)', async () => {
    const PREV2 = '2026-09-11'; // Friday
    const routes = publishedRoutes({
      [indCloseAllUrl(PREV)]: text(indexCsv(PREV)),
      [indCloseAllUrl(PREV2)]: text(indexCsv(PREV2)),
      [nseFoBhavcopyUrl(PREV)]: notFound(),
      [nseFoBhavcopyUrl(PREV2)]: notFound(),
      [nseCmBhavcopyUrl(PREV)]: zip('BhavCopy_NSE_CM_0_0_0_20260914_F_0000.csv', cmCsv(PREV)),
      [nseCmBhavcopyUrl(PREV2)]: notFound(),
      [bseFoBhavcopyUrl(PREV)]: notFound(),
      [bseFoBhavcopyUrl(PREV2)]: notFound(),
      [participantUrls(PREV)[0]]: notFound(),
      [participantUrls(PREV)[1]]: notFound(),
      [participantUrls(PREV2)[0]]: notFound(),
      [participantUrls(PREV2)[1]]: notFound(),
      [FIIDII_URL]: json(fiidii('14-Sep-2026')),
    });
    // 2026-09-15 09:00 IST: the last two sessions are 09-14 (Mon) and 09-11 (Fri).
    const h = harness(routes, { backfillDays: 2 }, ist(D, '09:00'));
    const first = await h.eod.backfill();
    expect(new Set(first.map((r) => r.date))).toEqual(new Set([PREV, PREV2]));
    expect(h.history.loadedDates('index')).toEqual([PREV2, PREV]);
    expect(h.history.loadedDates('cm')).toEqual([PREV]);
    expect(h.history.fiiDii(PREV, PREV)).toHaveLength(1);
    expect(h.eod.status().backfill).toMatchObject({ running: false, days: 2, datesMissing: 2 });
    // Second run: index/cm/fiidii are not asked for again.
    const n = h.calls.length;
    await h.eod.backfill();
    const urls = h.calls.slice(n).map((c) => c.url);
    expect(urls).not.toContain(indCloseAllUrl(PREV));
    expect(urls).not.toContain(nseCmBhavcopyUrl(PREV));
    expect(urls).not.toContain(FIIDII_URL);
    expect(urls).toContain(nseFoBhavcopyUrl(PREV));
    expect(legacyArchiveUrl(nseFoBhavcopyUrl(PREV))).toBeDefined(); // 404 never falls back to the legacy host
    expect(urls.some((u) => u.startsWith('https://archives.nseindia.com'))).toBe(false);
  });

  it('backfill counts only the dates still incomplete after it ran; a date filled later drops out', async () => {
    // Owner's PC: "30 session(s) still missing files" right after all 30 had been downloaded.
    const routes = publishedRoutes({ [participantUrls(D, 'oi')[1]]: notFound() });
    const h = harness(routes, { backfillDays: 1 }, ist('2026-09-16', '09:00'));
    await h.eod.backfill();
    expect(h.eod.status().backfill.datesMissing).toBe(1); // BSE F&O for D not published yet
    const bse = fixture('bse-fo-20260430.csv').replaceAll('2026-04-30', D).replaceAll('2026-06-25', '2026-12-24');
    routes[bseFoBhavcopyUrl(D)] = text(bse);
    expect(outcomes(await h.eod.loadDateQueued(D, ['bseFo']))).toEqual({ bseFo: 'loaded' });
    expect(h.eod.status().backfill.datesMissing).toBe(0);
    await h.eod.backfill();
    expect(h.eod.status().backfill.datesMissing).toBe(0);
  });

  it('stops the backfill after the first date when NSE/BSE cannot be reached at all, with one warning', async () => {
    const down = () => new TypeError('fetch failed');
    const routes: Routes = {};
    for (const d of [PREV, '2026-09-11', '2026-09-10']) {
      for (const u of [indCloseAllUrl(d), nseFoBhavcopyUrl(d), nseCmBhavcopyUrl(d), bseFoBhavcopyUrl(d), ...participantUrls(d)]) routes[u] = down;
    }
    const h = harness(routes, { backfillDays: 3 }, ist(D, '09:00'));
    await h.eod.backfill();
    const asked = new Set(h.calls.map((c) => c.url));
    expect(asked.has(indCloseAllUrl(PREV))).toBe(true);
    expect(asked.has(indCloseAllUrl('2026-09-11'))).toBe(false); // not tried: the network is down
    expect(h.eod.status().backfill.stoppedOffline).toMatch(/unexpected request|fetch failed/);
    expect(asked.has(FIIDII_URL)).toBe(false); // FII/DII is skipped too
    const warns = h.logs.filter((l) => /unreachable/.test(l));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/end-of-day backfill stopped — next attempt .* IST/);
    // Per-file failures of a down network are not logged one by one.
    expect(h.logs.filter((l) => /failed/.test(l) && !/unreachable/.test(l))).toEqual([]);
  });

  it('a store that cannot be read (disk error) is logged and the schedule stays armed, never an unhandled rejection', async () => {
    fs.mkdirSync(path.join(dir, 'eod'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'eod', 'index'), 'not a directory'); // readdir → ENOTDIR
    const h = harness(publishedRoutes(), { backfillDays: 2 });
    h.eod.start();
    await h.timers.advance(60_000);
    await h.eod.idle();
    expect(h.logs.some((l) => /EOD: start-up backfill failed: ENOTDIR/.test(l))).toBe(true);
    expect(h.logs.some((l) => /EOD: scheduling failed: ENOTDIR/.test(l))).toBe(true);
    // Retried an hour later (still failing, still armed).
    expect(h.timers.pending().length).toBe(1);
    await h.timers.advance(3_600_000);
    await h.eod.idle();
    expect(h.logs.filter((l) => /EOD: .*ENOTDIR/.test(l)).length).toBeGreaterThan(2);
    expect(h.timers.pending().length).toBe(1);
    h.eod.stop();
    expect(h.timers.pending()).toEqual([]);
  });
});
