/**
 * Exchange trading holidays from NSE's website API `GET /api/holiday-master?type=trading`
 * (nse-bse-public-data.md §6.1; critic.md R11: Kotak has no holiday API, the official source is the
 * yearly NSE circular PDF, this JSON is unofficial). The response is keyed by segment
 * (CBM, CD, CM, CMOT, COM, EGR, FO, IRD, MF, NDM, NTRP, SLBS); FO is equity derivatives, CM equities.
 * Entry: {"Sr_no":1,"tradingDate":"26-Jan-2026","weekDay":"Monday","description":"Republic Day",…}.
 * Muhurat-session days are listed as holidays; they are kept as holidays and also reported apart.
 * Best-effort: unavailable → `data: null` with the reason. Fetch rarely (weekly), store the result.
 */
import { NSE_WWW, NseError, parseDate, type Fetched, type NseHttp } from './http';

export const HOLIDAY_MASTER_URL = `${NSE_WWW}/api/holiday-master?type=trading`;
/** nselib warms cookies on the home page for this API; no dedicated page is documented (§6.1). */
export const HOLIDAY_WARMUP_URL = `${NSE_WWW}/`;

export interface HolidayEntry {
  segment: string;
  /** 'YYYY-MM-DD'. */
  date: string;
  description?: string;
  weekDay?: string;
  muhurat: boolean;
}

export interface HolidayCalendar {
  /** Equity-derivatives (FO) holidays; null when the segment is absent from the response. */
  fo: Set<string> | null;
  /** Equities (CM) holidays; null when absent. */
  cm: Set<string> | null;
  /** Days listed as holidays that have a Muhurat session (FO or CM). */
  muhurat: Set<string>;
  /** Every parsed entry of every segment. */
  entries: HolidayEntry[];
  /** Calendar years covered by the FO/CM entries. */
  years: number[];
  /** Entries dropped for an unreadable date. */
  skipped: number;
}

function segmentEntries(segment: string, list: unknown, out: HolidayEntry[]): { dates: Set<string>; skipped: number } {
  const dates = new Set<string>();
  let skipped = 0;
  if (!Array.isArray(list)) return { dates, skipped };
  for (const item of list) {
    if (!item || typeof item !== 'object') {
      skipped++;
      continue;
    }
    const e = item as Record<string, unknown>;
    const date = parseDate(typeof e.tradingDate === 'string' ? e.tradingDate : undefined);
    if (!date) {
      skipped++;
      continue;
    }
    const description = typeof e.description === 'string' ? e.description.trim() : undefined;
    dates.add(date);
    out.push({
      segment,
      date,
      description,
      weekDay: typeof e.weekDay === 'string' ? e.weekDay.trim() : undefined,
      muhurat: !!description && /muhurat/i.test(description),
    });
  }
  return { dates, skipped };
}

/** Parse the holiday-master JSON. Throws (format) when neither FO nor CM has a usable entry. */
export function parseHolidayMaster(json: unknown): HolidayCalendar {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new NseError('holiday-master: response is not an object keyed by segment', 'format');
  const bySegment = new Map<string, unknown>();
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) bySegment.set(k.trim().toUpperCase(), v);
  const entries: HolidayEntry[] = [];
  let skipped = 0;
  const sets = new Map<string, Set<string>>();
  for (const [seg, list] of bySegment) {
    const r = segmentEntries(seg, list, entries);
    skipped += r.skipped;
    if (Array.isArray(list)) sets.set(seg, r.dates);
  }
  const fo = sets.get('FO') ?? null;
  const cm = sets.get('CM') ?? null;
  if (!fo?.size && !cm?.size) throw new NseError('holiday-master: no FO or CM holidays in the response', 'format');
  const relevant = entries.filter((e) => e.segment === 'FO' || e.segment === 'CM');
  const muhurat = new Set(relevant.filter((e) => e.muhurat).map((e) => e.date));
  const years = [...new Set(relevant.map((e) => Number(e.date.slice(0, 4))))].sort((a, b) => a - b);
  return { fo, cm, muhurat, entries, years, skipped };
}

/** The current holiday list, or null with the reason (blocked, empty, changed format). */
export async function fetchHolidays(http: NseHttp): Promise<Fetched<HolidayCalendar>> {
  try {
    const res = await http.getJson({ url: HOLIDAY_MASTER_URL, warmupUrl: HOLIDAY_WARMUP_URL });
    if (res.status !== 'ok') return { data: null, reason: `holiday-master: not found (HTTP ${res.httpStatus})` };
    return { data: parseHolidayMaster(res.data) };
  } catch (e) {
    if (!(e instanceof NseError)) throw e;
    return { data: null, reason: e.message };
  }
}

/**
 * Manual holiday list (e.g. a HOLIDAYS env value 'YYYY-MM-DD,YYYY-MM-DD', DESIGN.md §2) for ad-hoc
 * closures announced by circular. Invalid entries are returned, not dropped silently.
 */
export function parseHolidayList(raw: string | undefined): { dates: Set<string>; invalid: string[] } {
  const dates = new Set<string>();
  const invalid: string[] = [];
  for (const part of (raw ?? '').split(/[\s,;]+/)) {
    if (!part) continue;
    const d = /^\d{4}-\d{2}-\d{2}$/.test(part) ? parseDate(part) : undefined;
    if (d) dates.add(d);
    else invalid.push(part);
  }
  return { dates, invalid };
}
