/**
 * fao_participant_oi_22072026.csv holds the REAL title, header (with its trailing spaces), Client and
 * TOTAL rows quoted in nse-bse-public-data.md §4 (sahilempire/groww-market-data mirror); the DII,
 * FII and Pro rows were elided in the research. Rows built here are marked CONSTRUCTED.
 */
import { describe, expect, it } from 'vitest';
import { NoLiveData } from '../../src/live/types';
import { fetchParticipants, parseParticipantCsv, participantUrls, toParticipantDay } from '../../src/live/nse/participants';
import { fixture, testHttp, text } from './nse-fake';

const CSV = fixture('fao_participant_oi_22072026.csv');

const CLIENT = {
  participant: 'Client',
  futIndexLong: 227949,
  futIndexShort: 63366,
  futStockLong: 3224508,
  futStockShort: 333164,
  optIndexCallLong: 3016955,
  optIndexPutLong: 2004385,
  optIndexCallShort: 2844682,
  optIndexPutShort: 2696167,
  optStockCallLong: 2650670,
  optStockPutLong: 884283,
  optStockCallShort: 1450033,
  optStockPutShort: 1289420,
};

describe('participant-wise OI', () => {
  it('reads the date from the title and maps columns by name (Put Long ≠ Call Short)', () => {
    const f = parseParticipantCsv(CSV, { expectedDate: '2026-07-22' });
    expect(f.date).toBe('2026-07-22');
    expect(f.unit).toBe('contracts');
    expect(f.rows).toEqual([CLIENT]);
    expect(f.absent).toEqual(['DII', 'FII', 'Pro']);
    expect(f.incomplete).toEqual([]);
    expect(f.totals).toEqual({ long: 24455509, short: 24455509 });
  });

  it('tolerates BOM, CRLF, tab-padded header names and reordered columns', () => {
    const lines = CSV.trimEnd().split('\n');
    const swap = (l: string) => {
      const c = l.split(',');
      [c[6], c[7]] = [c[7], c[6]];
      return c.join(',');
    };
    const csv = '﻿' + [lines[0], swap(lines[1]).replace('Future Index Long', 'Future Index Long\t'), ...lines.slice(2).map(swap)].join('\r\n');
    expect(parseParticipantCsv(csv).rows).toEqual([CLIENT]);
  });

  it('keeps a row with a blank cell out of `rows` and reports it (never zero-filled)', () => {
    const csv = CSV.replace('Client,227949,63366', 'Client, ,63366');
    const f = parseParticipantCsv(csv);
    expect(f.rows).toEqual([]);
    expect(f.incomplete).toEqual([{ participant: 'Client', missing: ['Future Index Long'] }]);
  });

  it('all four participants (CONSTRUCTED values)', () => {
    const header = CSV.split('\n').slice(0, 2).join('\n');
    const row = (who: string, k: number) => [who, ...Array.from({ length: 14 }, (_, i) => k * 100 + i)].join(',');
    const f = parseParticipantCsv(`${header}\n${row('Client', 1)}\n${row('DII', 2)}\n${row('FII', 3)}\n${row('Pro', 4)}\n`);
    expect(f.rows.map((r) => r.participant)).toEqual(['Client', 'DII', 'FII', 'Pro']);
    expect(f.rows[2]).toMatchObject({ futIndexLong: 300, optIndexCallLong: 304, optIndexPutLong: 305, optIndexCallShort: 306, optStockPutShort: 311 });
    expect(f.absent).toEqual([]);
  });

  it('names a missing column and rejects a file of another date', () => {
    expect(() => parseParticipantCsv(CSV.replace('Option Stock Put Short', 'Option Stock Put Shrt'), { file: 'p.csv' })).toThrow('p.csv: required column "Option Stock Put Short" is missing');
    expect(() => parseParticipantCsv(CSV, { expectedDate: '2026-07-23' })).toThrow(/dated 2026-07-22, expected 2026-07-23/);
  });

  it('a file without a title uses the requested date', () => {
    const csv = CSV.split('\n').slice(1).join('\n');
    expect(parseParticipantCsv(csv, { expectedDate: '2026-07-22' }).date).toBe('2026-07-22');
    expect(() => parseParticipantCsv(csv)).toThrow(/no date/);
  });

  it('builds ParticipantDay only with a real NIFTY close of the same date', () => {
    const f = parseParticipantCsv(CSV);
    expect(toParticipantDay(f, { date: '2026-07-22', close: 25145.5 })).toEqual({ date: '2026-07-22', niftyClose: 25145.5, rows: [CLIENT] });
    expect(toParticipantDay(f, undefined)).toBeNull();
    expect(toParticipantDay(f, { date: '2026-07-22', close: Number.NaN })).toBeNull();
    expect(toParticipantDay(f, { date: '2026-07-22', close: 0 })).toBeNull();
    // The close of another session is never joined to this file's positions.
    expect(toParticipantDay(f, { date: '2026-07-21', close: 25145.5 })).toBeNull();
  });

  it('every parse failure is NoLiveData (the file is not used), never a crash', () => {
    for (const bad of ['<html>Not found</html>', '', 'Client Type\nClient,1,2\n', null as never]) {
      expect(() => parseParticipantCsv(bad, { file: 'p.csv' })).toThrow(NoLiveData);
    }
    expect(() => parseParticipantCsv(null as never, { file: 'p.csv' })).toThrow(/p\.csv: unreadable/);
  });

  it('fetch tries the plain name, then the _b variant', async () => {
    const [plain, b] = participantUrls('2026-07-22');
    expect(plain).toBe('https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_22072026.csv');
    expect(b).toBe('https://nsearchives.nseindia.com/content/nsccl/fao_participant_oi_22072026_b.csv');
    expect(participantUrls('2026-07-22', 'vol')[0]).toBe('https://nsearchives.nseindia.com/content/nsccl/fao_participant_vol_22072026.csv');
    const t = testHttp({ [plain]: text('', 404), [b]: text(CSV) });
    const res = await fetchParticipants(t.http, '2026-07-22');
    expect(res).toMatchObject({ status: 'ok', url: b });
    expect(t.calls.map((c) => c.url)).toEqual([plain, b]);
    const none = testHttp({ [plain]: text('', 404), [b]: text('', 404) });
    expect(await fetchParticipants(none.http, '2026-07-22')).toMatchObject({ status: 'not-published', url: b });
  });
});
