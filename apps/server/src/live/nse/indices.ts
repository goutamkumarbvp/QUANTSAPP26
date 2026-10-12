/**
 * NSE index daily closes from `ind_close_all_DDMMYYYY.csv` (nse-bse-public-data.md §3; India VIX §7.1):
 * one official file per trading day, about 150 indices, published in the evening. Only the indices
 * the app trades (plus NIFTYNXT50 and India VIX) are mapped; names are matched exactly
 * (case-insensitive) so "Nifty Financial Services 25/50" never becomes FINNIFTY.
 */
import type { DailyBar } from '../types';
import { CsvTable, NSE_ARCHIVES, NseError, assertYmd, csvRecords, ddmmyyyy, findHeaderRow, normHeader, parseDate, type NseHttp, type Published } from './http';

export const indCloseAllUrl = (date: string): string => `${NSE_ARCHIVES}/content/indices/ind_close_all_${ddmmyyyy(date)}.csv`;

/** Official index name (normalised) → app symbol. "CNX Nifty" is the pre-Nov-2015 name of Nifty 50 (§3). */
export const INDEX_NAME_TO_SYMBOL: Readonly<Record<string, string>> = {
  'nifty 50': 'NIFTY',
  'cnx nifty': 'NIFTY',
  'nifty bank': 'BANKNIFTY',
  'nifty financial services': 'FINNIFTY',
  'nifty midcap select': 'MIDCPNIFTY',
  'nifty next 50': 'NIFTYNXT50',
  'india vix': 'INDIAVIX',
};

export interface IndexClose extends DailyBar {
  symbol: string;
  /** Name as printed in the file. */
  name: string;
  pointsChange?: number;
  /** `Change(%)`, percent. */
  changePct?: number;
  pe?: number;
  pb?: number;
  divYield?: number;
}

export interface IndexCloseFile {
  date: string;
  /** Mapped indices only. volume = `Volume` (shares of constituents); turnover = `Turnover (Rs. Cr.)` × 1e7 (₹). */
  closes: IndexClose[];
  skipped: Record<string, number>;
}

const REQUIRED = ['Index Name', 'Index Date', 'Open Index Value', 'High Index Value', 'Low Index Value', 'Closing Index Value'] as const;

const pos = (v: number | undefined): number | undefined => (v !== undefined && v > 0 ? v : undefined);

export function parseIndCloseAll(text: string, opts: { expectedDate?: string; file?: string } = {}): IndexCloseFile {
  const file = opts.file ?? 'ind_close_all';
  const records = csvRecords(text);
  const t = new CsvTable(records, findHeaderRow(records, 'Index Name', file), file, REQUIRED);
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => (skipped[reason] = (skipped[reason] ?? 0) + 1);
  const closes: IndexClose[] = [];
  const seen = new Set<string>();
  let fileDate: string | undefined;
  for (const r of t.rows) {
    const name = t.str(r, 'Index Name');
    const date = parseDate(t.str(r, 'Index Date'));
    if (!name || !date) {
      skip('missing name or date');
      continue;
    }
    fileDate ??= date;
    if (date !== fileDate) {
      skip('date differs from the file date');
      continue;
    }
    const symbol = INDEX_NAME_TO_SYMBOL[normHeader(name)];
    if (!symbol) continue;
    const open = pos(t.num(r, 'Open Index Value'));
    const high = pos(t.num(r, 'High Index Value'));
    const low = pos(t.num(r, 'Low Index Value'));
    const close = pos(t.num(r, 'Closing Index Value'));
    if (open === undefined || high === undefined || low === undefined || close === undefined) {
      skip('missing OHLC');
      continue;
    }
    if (seen.has(symbol)) {
      skip('duplicate index');
      continue;
    }
    seen.add(symbol);
    const vol = t.num(r, 'Volume');
    const turnoverCr = t.num(r, 'Turnover (Rs. Cr.)');
    closes.push({
      date,
      open,
      high,
      low,
      close,
      // '-' placeholders (India VIX) parse as undefined.
      volume: vol !== undefined && vol >= 0 ? vol : undefined,
      turnover: turnoverCr !== undefined && turnoverCr >= 0 ? Math.round(turnoverCr * 1e7) : undefined,
      symbol,
      name,
      pointsChange: t.num(r, 'Points Change'),
      changePct: t.num(r, 'Change(%)'),
      pe: t.num(r, 'P/E'),
      pb: t.num(r, 'P/B'),
      divYield: t.num(r, 'Div Yield'),
    });
  }
  if (!fileDate) throw new NseError(`${file}: no usable data rows`, 'format');
  if (opts.expectedDate && fileDate !== opts.expectedDate) {
    throw new NseError(`${file}: file is dated ${fileDate}, expected ${opts.expectedDate}`, 'format');
  }
  return { date: fileDate, closes, skipped };
}

/** The close of one app symbol in a parsed file. */
export function indexClose(file: IndexCloseFile, symbol: string): IndexClose | undefined {
  return file.closes.find((c) => c.symbol === symbol.toUpperCase());
}

/** NIFTY close and change % (with their date) for FiiDiiDay / ParticipantDay (§5 "Mapping"); undefined when not in the file. */
export function niftyCloseOf(file: IndexCloseFile): { date: string; close: number; changePct?: number } | undefined {
  const n = indexClose(file, 'NIFTY');
  return n ? { date: n.date, close: n.close, changePct: n.changePct } : undefined;
}

/** Plain DailyBar of one index (drops the extra file columns). */
export function toDailyBar(c: IndexClose): DailyBar {
  const bar: DailyBar = { date: c.date, open: c.open, high: c.high, low: c.low, close: c.close };
  if (c.volume !== undefined) bar.volume = c.volume;
  if (c.turnover !== undefined) bar.turnover = c.turnover;
  return bar;
}

/** `ind_close_all` of a date (plain CSV; archives fallback). 404 → not-published (or a holiday). */
export async function fetchIndexCloses(http: NseHttp, date: string): Promise<Published<IndexCloseFile>> {
  assertYmd(date);
  const res = await http.getCsv({ url: indCloseAllUrl(date), header: 'Index Name' });
  if (res.status !== 'ok') return res;
  return { status: 'ok', url: res.url, data: parseIndCloseAll(res.data, { expectedDate: date, file: `ind_close_all ${date}` }) };
}
