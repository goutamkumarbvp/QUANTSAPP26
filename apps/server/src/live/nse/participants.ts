/**
 * NSE Clearing participant-wise OI / trading volume (Client, DII, FII, Pro) from
 * `fao_participant_oi_DDMMYYYY.csv` / `fao_participant_vol_DDMMYYYY.csv` (nse-bse-public-data.md §4).
 *
 * Layout: a title line (`""Participant wise Open Interest (no. of contracts) … as on Jul 22, 2026""`),
 * then the header, then Client/DII/FII/Pro/TOTAL. Values are NUMBER OF CONTRACTS, kept as such: the
 * rows aggregate instruments of different lot sizes, so they cannot be converted to units.
 * Columns run Call Long, Put Long, Call Short, Put Short — positional reading swaps Put Long and
 * Call Short (§4), so every value is mapped by header name. A blank cell is missing data, never 0.
 */
import type { ParticipantDay, ParticipantRow } from '@q26/core';
import { NoLiveData } from '../types';
import { CsvTable, NSE_ARCHIVES, NseError, assertYmd, csvRecords, ddmmyyyy, findHeaderRow, parseDate, type NseHttp, type Published } from './http';

export type ParticipantFileKind = 'oi' | 'vol';
export type Participant = ParticipantRow['participant'];
type Field = Exclude<keyof ParticipantRow, 'participant'>;

/** Plain name first, then the `_b` variant some 2026 scrapers try (meaning UNCONFIRMED, §4). */
export function participantUrls(date: string, kind: ParticipantFileKind = 'oi'): string[] {
  const base = `${NSE_ARCHIVES}/content/nsccl/fao_participant_${kind}_${ddmmyyyy(date)}`;
  return [`${base}.csv`, `${base}_b.csv`];
}

/** File header → ParticipantRow field. */
export const PARTICIPANT_COLUMNS: Readonly<Record<Field, string>> = {
  futIndexLong: 'Future Index Long',
  futIndexShort: 'Future Index Short',
  futStockLong: 'Future Stock Long',
  futStockShort: 'Future Stock Short',
  optIndexCallLong: 'Option Index Call Long',
  optIndexPutLong: 'Option Index Put Long',
  optIndexCallShort: 'Option Index Call Short',
  optIndexPutShort: 'Option Index Put Short',
  optStockCallLong: 'Option Stock Call Long',
  optStockPutLong: 'Option Stock Put Long',
  optStockCallShort: 'Option Stock Call Short',
  optStockPutShort: 'Option Stock Put Short',
};

const FIELDS = Object.keys(PARTICIPANT_COLUMNS) as Field[];
const PARTICIPANTS: Record<string, Participant> = { client: 'Client', dii: 'DII', fii: 'FII', pro: 'Pro' };

export interface ParticipantFile {
  kind: ParticipantFileKind;
  /** From the title line ("as on Jul 22, 2026"), else the requested date. */
  date: string;
  unit: 'contracts';
  /** Complete rows only, in file order. */
  rows: ParticipantRow[];
  /** Rows with blank/invalid cells (not returned in `rows`, never zero-filled). */
  incomplete: { participant: Participant; missing: string[] }[];
  /** Participants absent from the file. */
  absent: Participant[];
  /** TOTAL row's `Total Long Contracts` / `Total Short Contracts`, when present. */
  totals?: { long?: number; short?: number };
}

const TITLE_DATE = /as on\s+([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/i;

/** Parse one participant file. Every failure is an NseError (a NoLiveData): the file is not used. */
export function parseParticipantCsv(text: string, opts: { kind?: ParticipantFileKind; expectedDate?: string; file?: string } = {}): ParticipantFile {
  const file = opts.file ?? `fao_participant_${opts.kind ?? 'oi'}`;
  try {
    return parseParticipants(text, opts.kind ?? 'oi', file, opts.expectedDate);
  } catch (e) {
    if (e instanceof NoLiveData) throw e;
    throw new NseError(`${file}: unreadable (${e instanceof Error ? e.message : String(e)})`, 'format');
  }
}

function parseParticipants(text: string, kind: ParticipantFileKind, file: string, expectedDate: string | undefined): ParticipantFile {
  const records = csvRecords(text);
  const headerRow = findHeaderRow(records, 'Client Type', file);
  const t = new CsvTable(records, headerRow, file, ['Client Type', ...Object.values(PARTICIPANT_COLUMNS)]);

  // The title is malformed CSV (doubled quotes around a field holding a comma), so read it raw.
  const m = TITLE_DATE.exec(text.slice(0, 600));
  const titleDate = m ? parseDate(`${m[1]} ${m[2]}, ${m[3]}`) : undefined;
  if (titleDate && expectedDate && titleDate !== expectedDate) {
    throw new NseError(`${file}: file is dated ${titleDate}, expected ${expectedDate}`, 'format');
  }
  const date = titleDate ?? expectedDate;
  if (!date) throw new NseError(`${file}: no date in the title line and none expected`, 'format');

  const rows: ParticipantRow[] = [];
  const incomplete: ParticipantFile['incomplete'] = [];
  const found = new Set<Participant>();
  let totals: ParticipantFile['totals'];
  for (const r of t.rows) {
    const who = t.str(r, 'Client Type')?.toLowerCase();
    if (!who) continue;
    if (who === 'total') {
      totals = { long: t.num(r, 'Total Long Contracts'), short: t.num(r, 'Total Short Contracts') };
      continue;
    }
    const participant = PARTICIPANTS[who];
    if (!participant || found.has(participant)) continue;
    found.add(participant);
    const row = { participant } as ParticipantRow;
    const missing: string[] = [];
    for (const f of FIELDS) {
      const v = t.num(r, PARTICIPANT_COLUMNS[f]);
      if (v === undefined || v < 0) missing.push(PARTICIPANT_COLUMNS[f]);
      else row[f] = v;
    }
    if (missing.length) incomplete.push({ participant, missing });
    else rows.push(row);
  }
  const absent = Object.values(PARTICIPANTS).filter((p) => !found.has(p));
  if (found.size === 0) throw new NseError(`${file}: no participant rows`, 'format');
  return { kind, date, unit: 'contracts', rows, incomplete, absent, totals };
}

/**
 * The app's ParticipantDay, joined with the NIFTY close of the SAME date from the index closes
 * (§5 "Mapping", indices.niftyCloseOf). Null when that close is unknown, not positive or of another
 * date: the caller leaves the day out instead of showing a NIFTY value from a different session.
 */
export function toParticipantDay(file: Pick<ParticipantFile, 'date' | 'rows'>, nifty: { date: string; close: number } | undefined): ParticipantDay | null {
  if (!nifty || nifty.date !== file.date) return null;
  if (!Number.isFinite(nifty.close) || nifty.close <= 0) return null;
  return { date: file.date, niftyClose: nifty.close, rows: file.rows.map((r) => ({ ...r })) };
}

/** The participant file of a date (published ≈19:00–23:30 IST, §4). 404 on both names → not-published. */
export async function fetchParticipants(http: NseHttp, date: string, kind: ParticipantFileKind = 'oi'): Promise<Published<ParticipantFile>> {
  assertYmd(date);
  let last: Published<ParticipantFile> | undefined;
  for (const url of participantUrls(date, kind)) {
    const res = await http.getCsv({ url, header: /^(participant wise|client type)/i });
    if (res.status !== 'ok') {
      last = res;
      continue;
    }
    return { status: 'ok', url: res.url, data: parseParticipantCsv(res.data, { kind, expectedDate: date, file: `fao_participant_${kind} ${date}` }) };
  }
  return last!;
}
