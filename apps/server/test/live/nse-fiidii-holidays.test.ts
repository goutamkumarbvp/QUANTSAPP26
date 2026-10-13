/**
 * FII/DII and holiday-master payloads follow the shapes documented in nse-bse-public-data.md §5 and
 * §6.1. The research quotes no FII/DII figures, so those numbers are CONSTRUCTED; the Republic Day
 * holiday entry is the real one quoted in §6.1, the others are CONSTRUCTED.
 */
import { describe, expect, it } from 'vitest';
import { FIIDII_NSE_URL, FIIDII_URL, FIIDII_WARMUP_URL, fetchFiiDii, parseFiiDii, toFiiDiiDay } from '../../src/live/nse/fiidii';
import { HOLIDAY_MASTER_URL, HOLIDAY_WARMUP_URL, fetchHolidays, parseHolidayList, parseHolidayMaster } from '../../src/live/nse/holidays';
import { html, json, testHttp, text } from './nse-fake';

// CONSTRUCTED values in the documented shape (strings with thousands separators, or numbers).
const FIIDII = [
  { category: 'DII', date: '09-Oct-2026', buyValue: '12,345.67', sellValue: '10,000.00', netValue: '2,345.67' },
  { category: 'FII/FPI', date: '09-Oct-2026', buyValue: 9876.5, sellValue: 11000, netValue: -1123.5 },
];

describe('FII/DII', () => {
  it('parses both categories, stripping commas', () => {
    expect(parseFiiDii(FIIDII)).toEqual({ date: '2026-10-09', fiiBuy: 9876.5, fiiSell: 11000, fiiNet: -1123.5, diiBuy: 12345.67, diiSell: 10000, diiNet: 2345.67, scope: 'combined' });
  });

  it('accepts footnote marks in labels and derives a missing net from the published buy/sell', () => {
    const rows = [
      { category: 'DII **', date: '09-Oct-2026', buyValue: '100.10', sellValue: '50.05' },
      { category: 'FII/FPI *', date: '09-Oct-2026', buyValue: '10', sellValue: '20', netValue: '-10' },
    ];
    expect(parseFiiDii(rows)).toMatchObject({ diiNet: 50.05, fiiNet: -10 });
  });

  it('throws on a missing category, missing values or mismatched dates', () => {
    expect(() => parseFiiDii([FIIDII[0]])).toThrow(/FII\/FPI row missing/);
    expect(() => parseFiiDii([{ ...FIIDII[0], buyValue: '-' }, FIIDII[1]])).toThrow(/DII row has no buyValue/);
    expect(() => parseFiiDii([{ ...FIIDII[0], date: '08-Oct-2026' }, FIIDII[1]])).toThrow(/differs/);
    expect(() => parseFiiDii({})).toThrow(/not an array/);
  });

  it('fetches after the /reports/fii-dii warm-up', async () => {
    const t = testHttp({ [FIIDII_WARMUP_URL]: html(200, ['nsit=1']), [FIIDII_URL]: json(FIIDII) });
    const res = await fetchFiiDii(t.http);
    expect(res.data).toMatchObject({ date: '2026-10-09', scope: 'combined' });
    expect(t.calls.map((c) => c.url)).toEqual([FIIDII_WARMUP_URL, FIIDII_URL]);
    expect(t.calls[1].headers).toMatchObject({ Referer: FIIDII_WARMUP_URL, Cookie: 'nsit=1' });
  });

  it('falls back to the NSE-only endpoint on 404 and labels it', async () => {
    const t = testHttp({ [FIIDII_WARMUP_URL]: html(200), [FIIDII_URL]: text('', 404), [FIIDII_NSE_URL]: json(FIIDII) });
    expect((await fetchFiiDii(t.http)).data).toMatchObject({ scope: 'nse' });
    const off = testHttp({ [FIIDII_WARMUP_URL]: html(200), [FIIDII_URL]: text('', 404) });
    expect(await fetchFiiDii(off.http, { nseOnlyFallback: false })).toEqual({ data: null, reason: 'FII/DII unavailable: /api/fiidiiTradeReact: not found (HTTP 404)' });
  });

  it('returns null with a reason (never throws) when blocked', async () => {
    const t = testHttp({ [FIIDII_WARMUP_URL]: html(200), [FIIDII_URL]: text('denied', 403) });
    const res = await fetchFiiDii(t.http);
    expect(res.data).toBeNull();
    expect(res.reason).toMatch(/blocked \(HTTP 403\)/);
    // A block is not retried on the sibling endpoint.
    expect(t.calls.some((c) => c.url === FIIDII_NSE_URL)).toBe(false);
    const w = testHttp({ [FIIDII_WARMUP_URL]: html(403) });
    expect((await fetchFiiDii(w.http)).reason).toMatch(/warm-up/);
  });

  it('builds FiiDiiDay only with the same day\'s real NIFTY close and change', () => {
    const flows = parseFiiDii(FIIDII);
    expect(toFiiDiiDay(flows, { date: '2026-10-09', close: 25145.5, changePct: -0.32 })).toEqual({
      date: '2026-10-09',
      fiiBuy: 9876.5,
      fiiSell: 11000,
      fiiNet: -1123.5,
      diiBuy: 12345.67,
      diiSell: 10000,
      diiNet: 2345.67,
      niftyClose: 25145.5,
      niftyChangePct: -0.32,
      scope: 'combined',
    });
    // NSE-only figures (fallback endpoint) keep their scope: they must never be summed with combined days.
    expect(toFiiDiiDay({ ...flows, scope: 'nse' }, { date: '2026-10-09', close: 25145.5, changePct: -0.32 })?.scope).toBe('nse');
    expect(toFiiDiiDay(flows, undefined)).toBeNull();
    expect(toFiiDiiDay(flows, { date: '2026-10-09', close: 25145.5 })).toBeNull();
    expect(toFiiDiiDay(flows, { date: '2026-10-09', close: Number.NaN, changePct: 1 })).toBeNull();
    // A NIFTY close of another session is never joined (the endpoint serves only the latest day).
    expect(toFiiDiiDay(flows, { date: '2026-10-08', close: 25145.5, changePct: -0.32 })).toBeNull();
  });
});

// The FO Republic Day entry is the real one quoted in §6.1; the rest is CONSTRUCTED.
const HOLIDAYS = {
  CM: [
    { Sr_no: 1, tradingDate: '26-Jan-2026', weekDay: 'Monday', description: 'Republic Day', morning_session: null, evening_session: null },
    { Sr_no: 2, tradingDate: '08-Nov-2026', weekDay: 'Sunday', description: 'Diwali Laxmi Pujan (Muhurat Trading)', morning_session: null, evening_session: null },
  ],
  FO: [
    { Sr_no: 1, tradingDate: '26-Jan-2026', weekDay: 'Monday', description: 'Republic Day', morning_session: null, evening_session: null },
    { Sr_no: 2, tradingDate: 'not a date', weekDay: '', description: 'broken' },
  ],
  COM: [{ Sr_no: 1, tradingDate: '01-May-2026', weekDay: 'Friday', description: 'x', morning_session: 'Closed', evening_session: 'Open' }],
};

describe('holiday-master', () => {
  it('parses FO and CM into date sets, flags Muhurat days and skips unreadable dates', () => {
    const c = parseHolidayMaster(HOLIDAYS);
    expect([...c.fo!]).toEqual(['2026-01-26']);
    expect([...c.cm!]).toEqual(['2026-01-26', '2026-11-08']);
    expect([...c.muhurat]).toEqual(['2026-11-08']);
    expect(c.years).toEqual([2026]);
    expect(c.skipped).toBe(1);
    expect(c.entries.find((e) => e.segment === 'COM')?.date).toBe('2026-05-01');
  });

  it('a missing segment is null, not empty; nothing usable throws', () => {
    expect(parseHolidayMaster({ CM: HOLIDAYS.CM }).fo).toBeNull();
    expect(() => parseHolidayMaster({ CD: [] })).toThrow(/no FO or CM/);
    expect(() => parseHolidayMaster([])).toThrow(/not an object/);
  });

  it('fetches after a home-page warm-up; unavailable → null with a reason', async () => {
    const ok = testHttp({ [HOLIDAY_WARMUP_URL]: html(200), [HOLIDAY_MASTER_URL]: json(HOLIDAYS) });
    expect((await fetchHolidays(ok.http)).data?.fo?.has('2026-01-26')).toBe(true);
    // An invalid `type` answers 200 with an empty body (§6.1).
    const empty = testHttp({ [HOLIDAY_WARMUP_URL]: html(200), [HOLIDAY_MASTER_URL]: text('') });
    expect(await fetchHolidays(empty.http)).toEqual({ data: null, reason: '/api/holiday-master: empty response' });
    const blocked = testHttp({ [HOLIDAY_WARMUP_URL]: html(200), [HOLIDAY_MASTER_URL]: html(200) });
    expect((await fetchHolidays(blocked.http)).reason).toMatch(/HTML page instead of JSON/);
  });

  it('parses a manual holiday list and reports bad entries', () => {
    const r = parseHolidayList(' 2026-01-26, 2026-11-08;2026-02-30 26-01-2026 ');
    expect([...r.dates]).toEqual(['2026-01-26', '2026-11-08']);
    expect(r.invalid).toEqual(['2026-02-30', '26-01-2026']);
    expect(parseHolidayList(undefined).dates.size).toBe(0);
  });
});
