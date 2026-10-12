import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  CsvTable,
  NseError,
  csvRecords,
  ddmmyyyy,
  legacyArchiveUrl,
  parseDate,
  parseNum,
  unzipCsv,
  ymdCompact,
} from '../../src/live/nse/http';
import { NoLiveData } from '../../src/live/types';
import { fixture, html, json, testHttp, text } from './nse-fake';

const IND = 'https://nsearchives.nseindia.com/content/indices/ind_close_all_14102025.csv';
const IND_LEGACY = 'https://archives.nseindia.com/content/indices/ind_close_all_14102025.csv';
const HOME = 'https://www.nseindia.com/';
const CSV = fixture('ind_close_all_14102025.csv');

describe('NseHttp files', () => {
  it('GETs an archive CSV with browser-like headers and no cookies', async () => {
    const { http, calls } = testHttp({ [IND]: text(CSV, 200, [['content-type', 'text/csv']]) });
    const res = await http.getCsv({ url: IND, header: 'Index Name' });
    expect(res).toEqual({ status: 'ok', url: IND, data: CSV });
    expect(calls).toHaveLength(1);
    const h = calls[0].headers;
    expect(h['User-Agent']).toMatch(/Mozilla\/5\.0 .*Chrome\/\d+/);
    expect(h.Accept).toBe('*/*');
    expect(h['Accept-Language']).toBe('en-US,en;q=0.9');
    expect(h['Accept-Encoding']).toBe('gzip, deflate');
    expect(h.Referer).toBe(HOME);
    expect(h.Cookie).toBeUndefined();
  });

  it('treats 404 as "not published yet", without trying the fallback host', async () => {
    const { http, calls } = testHttp({ [IND]: text('<html>Not Found</html>', 404) });
    const res = await http.getFile({ url: IND, expect: 'csv' });
    expect(res).toEqual({ status: 'not-published', url: IND, httpStatus: 404 });
    expect(calls.map((c) => c.url)).toEqual([IND]);
  });

  it('on 403 warms cookies on the NSE home page and retries once with them', async () => {
    const { http, calls } = testHttp({
      [IND]: [text('denied', 403), text(CSV)],
      [HOME]: html(200, ['nsit=abc123; Path=/; Domain=.nseindia.com; Secure', 'bm_sv=xyz; Max-Age=7200; Path=/']),
    });
    const res = await http.getCsv({ url: IND, header: 'Index Name' });
    expect(res.status).toBe('ok');
    expect(calls.map((c) => c.url)).toEqual([IND, HOME, IND]);
    expect(calls[0].headers.Cookie).toBeUndefined();
    expect(calls[1].headers.Accept).toMatch(/^text\/html/);
    expect(calls[1].headers.Referer).toBeUndefined();
    expect(calls[2].headers.Cookie).toBe('nsit=abc123; bm_sv=xyz');
  });

  it('falls back nsearchives → archives when still blocked after the warm-up', async () => {
    const { http, calls } = testHttp({
      [IND]: text('denied', 403),
      [HOME]: html(200, ['nsit=1']),
      [IND_LEGACY]: text(CSV),
    });
    const res = await http.getCsv({ url: IND, header: 'Index Name' });
    expect(res).toMatchObject({ status: 'ok', url: IND_LEGACY });
    expect(calls.map((c) => c.url)).toEqual([IND, HOME, IND, IND_LEGACY]);
  });

  it('throws a blocked NoLiveData when the fallback is disabled', async () => {
    const { http } = testHttp({ [IND]: text('denied', 403), [HOME]: html(200) });
    const err = await http.getFile({ url: IND, expect: 'csv', hostFallback: false }).catch((e) => e);
    expect(err).toBeInstanceOf(NseError);
    expect(err).toBeInstanceOf(NoLiveData);
    expect(err).toMatchObject({ kind: 'blocked', httpStatus: 403, statusCode: 503, code: 'NO_LIVE_DATA' });
  });

  it('a failed warm-up is reported as blocked', async () => {
    const { http } = testHttp({ [IND]: text('denied', 403), [HOME]: html(403) });
    await expect(http.getFile({ url: IND, expect: 'csv', hostFallback: false })).rejects.toMatchObject({ kind: 'blocked', message: expect.stringContaining('warm-up') });
  });

  it('retries 5xx with exponential backoff, then uses the fallback host', async () => {
    const { http, calls, clock } = testHttp({ [IND]: text('busy', 503), [IND_LEGACY]: text(CSV) });
    const res = await http.getCsv({ url: IND, header: 'Index Name' });
    expect(res.status).toBe('ok');
    expect(calls.map((c) => c.url)).toEqual([IND, IND, IND, IND_LEGACY]);
    expect(clock.sleeps.filter((s) => s >= 2000)).toEqual([2000, 4000]);
  });

  it('retries network errors and reports a network NoLiveData when every host fails', async () => {
    const boom = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    const { http, calls } = testHttp({ [IND]: boom, [IND_LEGACY]: boom }, { retries: 1 });
    const err = await http.getFile({ url: IND, expect: 'csv' }).catch((e) => e);
    expect(err).toMatchObject({ kind: 'network', message: expect.stringContaining('ENOTFOUND') });
    expect(calls).toHaveLength(4);
  });

  it('reports a timeout', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const { http } = testHttp({ [IND]: timeout }, { retries: 0 });
    await expect(http.getFile({ url: IND, expect: 'csv', hostFallback: false })).rejects.toMatchObject({ kind: 'network', message: expect.stringContaining('timed out after 30 s') });
  });

  it('extracts the CSV of a zip (fflate)', async () => {
    const url = 'https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_20260915_F_0000.csv.zip';
    const zip = zipSync({ 'BhavCopy_NSE_FO_0_0_0_20260915_F_0000.csv': strToU8(fixture('nse-fo-20260915.csv')) });
    const { http } = testHttp({ [url]: text(zip, 200, [['content-type', 'application/zip']]) });
    const res = await http.getCsv({ url, zipped: true, entry: /BhavCopy_NSE_FO_.*\.csv$/i, header: 'TradDt' });
    expect(res).toMatchObject({ status: 'ok', data: fixture('nse-fo-20260915.csv') });
  });

  it('never trusts a 200 alone: an HTML page instead of a zip is a format error', async () => {
    const url = 'https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_20260915_F_0000.csv.zip';
    const { http } = testHttp({ [url]: html(200) });
    await expect(http.getFile({ url, expect: 'zip', hostFallback: false })).rejects.toMatchObject({ kind: 'format', message: expect.stringContaining('HTML page') });
  });

  it('rejects a CSV whose header is not the expected one', async () => {
    const { http } = testHttp({ [IND]: text('Symbol,Series\nX,EQ\n') });
    await expect(http.getCsv({ url: IND, header: 'Index Name', hostFallback: false })).rejects.toMatchObject({ kind: 'format' });
  });

  it('keeps ≥500 ms between two archive requests', async () => {
    const { http, clock } = testHttp({ [IND]: text(CSV) });
    await http.getFile({ url: IND, expect: 'csv' });
    await http.getFile({ url: IND, expect: 'csv' });
    expect(clock.sleeps).toEqual([500]);
  });

  it('never falls back to archives for fo_mktlots.csv', () => {
    expect(legacyArchiveUrl('https://nsearchives.nseindia.com/content/fo/fo_mktlots.csv')).toBeUndefined();
    expect(legacyArchiveUrl(IND)).toBe(IND_LEGACY);
    expect(legacyArchiveUrl('https://www.bseindia.com/x.csv')).toBeUndefined();
  });

  it('sends Referer and Origin of www.bseindia.com for BSE files', async () => {
    const url = 'https://www.bseindia.com/download/Bhavcopy/Derivative/BhavCopy_BSE_FO_0_0_0_20260430_F_0000.CSV';
    const { http, calls } = testHttp({ [url]: text(fixture('bse-fo-20260430.csv')) });
    await http.getCsv({ url, header: 'TradDt', hostFallback: false });
    expect(calls[0].headers).toMatchObject({ Referer: 'https://www.bseindia.com/', Origin: 'https://www.bseindia.com' });
  });
});

describe('NseHttp JSON API', () => {
  const API = 'https://www.nseindia.com/api/fiidiiTradeReact';
  const PAGE = 'https://www.nseindia.com/reports/fii-dii';

  it('warms cookies on the widget page first and sends it as Referer', async () => {
    const { http, calls, clock } = testHttp({ [PAGE]: html(200, ['nsit=n1', 'nseappid=a1']), [API]: json([{ ok: 1 }]) });
    const res = await http.getJson({ url: API, warmupUrl: PAGE });
    expect(res).toEqual({ status: 'ok', url: API, data: [{ ok: 1 }] });
    expect(calls.map((c) => c.url)).toEqual([PAGE, API]);
    expect(calls[1].headers).toMatchObject({ Referer: PAGE, Accept: 'application/json, text/plain, */*', Cookie: 'nsit=n1; nseappid=a1' });
    // www.nseindia.com calls are ≥3 s apart.
    expect(clock.sleeps).toEqual([3000]);
    // Fresh cookies are reused.
    await http.getJson({ url: API, warmupUrl: PAGE });
    expect(calls.map((c) => c.url)).toEqual([PAGE, API, API]);
  });

  it('re-warms once on 403 and retries', async () => {
    const { http, calls } = testHttp({ [PAGE]: [html(200, ['nsit=old']), html(200, ['nsit=new'])], [API]: [text('no', 403), json([])] });
    const res = await http.getJson({ url: API, warmupUrl: PAGE });
    expect(res.status).toBe('ok');
    expect(calls.map((c) => c.url)).toEqual([PAGE, API, PAGE, API]);
    expect(calls[3].headers.Cookie).toBe('nsit=new');
  });

  it('is blocked after the second 403, and an HTML body is a block too', async () => {
    const a = testHttp({ [PAGE]: html(200), [API]: text('no', 403) });
    await expect(a.http.getJson({ url: API, warmupUrl: PAGE })).rejects.toMatchObject({ kind: 'blocked', httpStatus: 403 });
    const b = testHttp({ [PAGE]: html(200), [API]: html(200) });
    await expect(b.http.getJson({ url: API, warmupUrl: PAGE })).rejects.toMatchObject({ kind: 'blocked' });
  });

  it('404 is not-published, an empty body is a format error', async () => {
    const a = testHttp({ [PAGE]: html(200), [API]: text('', 404) });
    expect(await a.http.getJson({ url: API, warmupUrl: PAGE })).toMatchObject({ status: 'not-published', httpStatus: 404 });
    const b = testHttp({ [PAGE]: html(200), [API]: text('') });
    await expect(b.http.getJson({ url: API, warmupUrl: PAGE })).rejects.toMatchObject({ kind: 'format' });
  });

  it('honours a Retry-After longer than the backoff cap: no early retries, no re-warm', async () => {
    const slow = () => new Response('slow', { status: 429, headers: { 'retry-after': '600' } });
    const { http, calls } = testHttp({ [PAGE]: html(200), [API]: slow });
    await expect(http.getJson({ url: API, warmupUrl: PAGE })).rejects.toMatchObject({ kind: 'blocked', httpStatus: 429, message: expect.stringContaining('Retry-After 600 s') });
    expect(calls.map((c) => c.url)).toEqual([PAGE, API]);
  });

  it('a short Retry-After is waited out', async () => {
    const { http, calls, clock } = testHttp({ [PAGE]: html(200), [API]: [text('slow', 429, [['retry-after', '5']]), json([])] });
    expect((await http.getJson({ url: API, warmupUrl: PAGE })).status).toBe('ok');
    expect(calls.map((c) => c.url)).toEqual([PAGE, API, API]);
    expect(clock.sleeps).toContain(5000);
  });

  it('drops a cookie the server expires', async () => {
    const { http, calls } = testHttp({ [PAGE]: [html(200, ['a=1', 'b=2']), html(200, ['a=; Max-Age=0'])], [API]: json({}) });
    await http.warmUp(PAGE);
    await http.warmUp(PAGE);
    await http.getJson({ url: API, warmupUrl: PAGE });
    expect(calls.map((c) => c.url)).toEqual([PAGE, PAGE, API]);
    expect(calls[2].headers.Cookie).toBe('b=2');
  });
});

describe('CSV and date helpers', () => {
  it('parses quoted fields, doubled quotes, CRLF, BOM and blank lines', () => {
    const recs = csvRecords('﻿a,"b,c","say ""hi"""\r\n\r\n1,,3\r\n');
    expect(recs).toEqual([
      ['a', 'b,c', 'say "hi"'],
      ['1', '', '3'],
    ]);
  });

  it('reads NSE\'s malformed ""title"" line without losing the following rows', () => {
    const recs = csvRecords(fixture('fao_participant_oi_22072026.csv'));
    expect(recs[0][0]).toContain('Participant wise Open Interest');
    expect(recs[1][0]).toBe('Client Type');
    expect(recs[2][0]).toBe('Client');
  });

  it('maps columns by trimmed, case-insensitive header and names a missing required column', () => {
    const recs = csvRecords(' Close \t,SYMBOL\n10,X\n');
    const t = new CsvTable(recs, 0, 'f.csv', ['close', 'Symbol']);
    expect(t.num(t.rows[0], 'CLOSE')).toBe(10);
    expect(t.str(t.rows[0], 'symbol')).toBe('X');
    expect(t.str(t.rows[0], 'unknown')).toBeUndefined();
    expect(() => new CsvTable(recs, 0, 'f.csv', ['OpnIntrst'])).toThrow(/f\.csv: required column "OpnIntrst" is missing/);
  });

  it('parses exchange numbers without inventing values', () => {
    expect(parseNum('-.32')).toBe(-0.32);
    expect(parseNum('1,234.50')).toBe(1234.5);
    expect(parseNum('-')).toBeUndefined();
    expect(parseNum(' ')).toBeUndefined();
    expect(parseNum('0x10')).toBeUndefined();
    expect(parseNum('NaN')).toBeUndefined();
  });

  it('parses the exchange date formats', () => {
    expect(parseDate('2026-09-15')).toBe('2026-09-15');
    expect(parseDate('14-10-2025')).toBe('2025-10-14');
    expect(parseDate('26-Jan-2026')).toBe('2026-01-26');
    expect(parseDate('15-DEC-2025')).toBe('2025-12-15');
    expect(parseDate('Jul 22, 2026')).toBe('2026-07-22');
    expect(parseDate('31-02-2026')).toBeUndefined();
    expect(ymdCompact('2026-09-15')).toBe('20260915');
    expect(ddmmyyyy('2025-10-14')).toBe('14102025');
    expect(() => ymdCompact('2026-9-15')).toThrow(/Invalid date/);
  });

  it('unzipCsv picks the requested entry and rejects non-zips', () => {
    const zip = zipSync({ 'readme.txt': strToU8('x'), 'a.csv': strToU8('A\n1\n'), 'b.CSV': strToU8('B\n2\n') });
    expect(unzipCsv(zip, /^b\./i)).toEqual({ name: 'b.CSV', text: 'B\n2\n' });
    expect(() => unzipCsv(zip)).toThrow(/2 CSV entries/);
    expect(() => unzipCsv(strToU8('<html>'))).toThrow(/not a zip/);
  });
});
