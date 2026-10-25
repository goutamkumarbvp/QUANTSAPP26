/**
 * Kotak scrip master (instrument master) → ReferenceData.
 *
 * Daily: resolve the file URLs (file-paths API), download nse_cm, bse_cm, nse_fo, bse_fo with a
 * plain unauthenticated GET, cache them under <dataDir>/refdata/<date>/ (a restart the same day
 * reads the cache), parse by TRIMMED header name and build the app's universe from them
 * (kotak-rest-auth.md §3, official instruments.md, critic.md C5/C6/R8).
 *
 * CSV facts this relies on:
 *  - headers carry trailing spaces and one is literally 'dStrikePrice;' (trimmed before lookup);
 *  - strikes and ticks are in paise (×100); strikes may be in scientific notation ('1.75e+06');
 *  - lExpiryDate: nse_fo/cde_fo = seconds since the NSE epoch → add 315511200 (official); bse_fo =
 *    plain Unix seconds. Only the IST calendar date is used;
 *  - calendar-spread rows have two tokens in pSymbol ('53032 72263') and an empty pSegment: dropped;
 *  - indices are quoted/streamed by their official NAME ('Nifty 50'), not a token (quotes.md §7).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { NoLiveData, type InstrumentKey, type Listing, type OptKind, type ReferenceData, type Segment, type Underlying } from '../types';
import type { FetchLike, KotakLogger } from './session';

export const SCRIP_SEGMENTS: readonly Segment[] = ['nse_cm', 'bse_cm', 'nse_fo', 'bse_fo'];

/** Added to nse_fo/cde_fo lExpiryDate to get Unix seconds (official instruments.md §6). */
export const NSE_EPOCH_OFFSET_S = 315_511_200;

export interface StockRef {
  symbol: string;
  name?: string;
  /** Hand-maintained reference label ('' when unknown). */
  sector?: string;
}

/** Default stock universe and sector labels: reference metadata carried over from market/universe.ts. */
export const REFERENCE_STOCKS: readonly StockRef[] = [
  { symbol: 'RELIANCE', name: 'Reliance Industries', sector: 'Energy' },
  { symbol: 'HDFCBANK', name: 'HDFC Bank', sector: 'Banks' },
  { symbol: 'ICICIBANK', name: 'ICICI Bank', sector: 'Banks' },
  { symbol: 'INFY', name: 'Infosys', sector: 'IT' },
  { symbol: 'TCS', name: 'Tata Consultancy Services', sector: 'IT' },
  { symbol: 'SBIN', name: 'State Bank of India', sector: 'Banks' },
  { symbol: 'AXISBANK', name: 'Axis Bank', sector: 'Banks' },
  { symbol: 'KOTAKBANK', name: 'Kotak Mahindra Bank', sector: 'Banks' },
  { symbol: 'LT', name: 'Larsen & Toubro', sector: 'Capital Goods' },
  { symbol: 'ITC', name: 'ITC', sector: 'FMCG' },
  { symbol: 'BHARTIARTL', name: 'Bharti Airtel', sector: 'Telecom' },
  { symbol: 'HINDUNILVR', name: 'Hindustan Unilever', sector: 'FMCG' },
  { symbol: 'BAJFINANCE', name: 'Bajaj Finance', sector: 'Financials' },
  { symbol: 'MARUTI', name: 'Maruti Suzuki', sector: 'Auto' },
  { symbol: 'M&M', name: 'Mahindra & Mahindra', sector: 'Auto' },
  { symbol: 'SUNPHARMA', name: 'Sun Pharmaceutical', sector: 'Pharma' },
  { symbol: 'TITAN', name: 'Titan Company', sector: 'Consumer' },
  { symbol: 'ASIANPAINT', name: 'Asian Paints', sector: 'Consumer' },
  { symbol: 'WIPRO', name: 'Wipro', sector: 'IT' },
  { symbol: 'HCLTECH', name: 'HCL Technologies', sector: 'IT' },
  { symbol: 'TECHM', name: 'Tech Mahindra', sector: 'IT' },
  { symbol: 'ULTRACEMCO', name: 'UltraTech Cement', sector: 'Cement' },
  { symbol: 'NTPC', name: 'NTPC', sector: 'Power' },
  { symbol: 'POWERGRID', name: 'Power Grid Corp', sector: 'Power' },
  { symbol: 'ONGC', name: 'Oil & Natural Gas Corp', sector: 'Energy' },
  { symbol: 'COALINDIA', name: 'Coal India', sector: 'Metals' },
  { symbol: 'TATASTEEL', name: 'Tata Steel', sector: 'Metals' },
  { symbol: 'JSWSTEEL', name: 'JSW Steel', sector: 'Metals' },
  { symbol: 'HINDALCO', name: 'Hindalco Industries', sector: 'Metals' },
  { symbol: 'ADANIENT', name: 'Adani Enterprises', sector: 'Infra' },
  { symbol: 'ADANIPORTS', name: 'Adani Ports & SEZ', sector: 'Infra' },
  { symbol: 'BAJAJ-AUTO', name: 'Bajaj Auto', sector: 'Auto' },
  { symbol: 'HEROMOTOCO', name: 'Hero MotoCorp', sector: 'Auto' },
  { symbol: 'EICHERMOT', name: 'Eicher Motors', sector: 'Auto' },
  { symbol: 'DRREDDY', name: "Dr. Reddy's Laboratories", sector: 'Pharma' },
  { symbol: 'CIPLA', name: 'Cipla', sector: 'Pharma' },
  { symbol: 'DIVISLAB', name: "Divi's Laboratories", sector: 'Pharma' },
  { symbol: 'NESTLEIND', name: 'Nestle India', sector: 'FMCG' },
  { symbol: 'BRITANNIA', name: 'Britannia Industries', sector: 'FMCG' },
  { symbol: 'INDUSINDBK', name: 'IndusInd Bank', sector: 'Banks' },
  { symbol: 'BANKBARODA', name: 'Bank of Baroda', sector: 'Banks' },
  { symbol: 'PNB', name: 'Punjab National Bank', sector: 'Banks' },
  { symbol: 'CANBK', name: 'Canara Bank', sector: 'Banks' },
  { symbol: 'DLF', name: 'DLF', sector: 'Realty' },
  { symbol: 'VEDL', name: 'Vedanta', sector: 'Metals' },
  { symbol: 'BPCL', name: 'Bharat Petroleum', sector: 'Energy' },
  { symbol: 'IOC', name: 'Indian Oil Corp', sector: 'Energy' },
  { symbol: 'GRASIM', name: 'Grasim Industries', sector: 'Cement' },
  { symbol: 'TATAPOWER', name: 'Tata Power', sector: 'Power' },
  { symbol: 'ETERNAL', name: 'Eternal (Zomato)', sector: 'Consumer' },
  { symbol: 'TRENT', name: 'Trent', sector: 'Consumer' },
  { symbol: 'HAL', name: 'Hindustan Aeronautics', sector: 'Capital Goods' },
  { symbol: 'BEL', name: 'Bharat Electronics', sector: 'Capital Goods' },
  { symbol: 'IRCTC', name: 'IRCTC', sector: 'Consumer' },
  { symbol: 'SBILIFE', name: 'SBI Life Insurance', sector: 'Financials' },
  { symbol: 'HDFCLIFE', name: 'HDFC Life Insurance', sector: 'Financials' },
  { symbol: 'BAJAJFINSV', name: 'Bajaj Finserv', sector: 'Financials' },
  { symbol: 'SHRIRAMFIN', name: 'Shriram Finance', sector: 'Financials' },
];

interface IndexSpec {
  symbol: string;
  name: string;
  exchange: 'NSE' | 'BSE';
  spotSegment: 'nse_cm' | 'bse_cm';
  /** Exact, case-sensitive index name used in place of a token (official quotes.md §7). */
  spotName: string;
  foSegment: 'nse_fo' | 'bse_fo';
  /** pSymbolName values accepted for its F&O rows (first = documented/expected one). */
  foNames: string[];
}

export const INDEX_SPECS: readonly IndexSpec[] = [
  { symbol: 'NIFTY', name: 'Nifty 50', exchange: 'NSE', spotSegment: 'nse_cm', spotName: 'Nifty 50', foSegment: 'nse_fo', foNames: ['NIFTY'] },
  { symbol: 'BANKNIFTY', name: 'Nifty Bank', exchange: 'NSE', spotSegment: 'nse_cm', spotName: 'Nifty Bank', foSegment: 'nse_fo', foNames: ['BANKNIFTY'] },
  { symbol: 'FINNIFTY', name: 'Nifty Financial Services', exchange: 'NSE', spotSegment: 'nse_cm', spotName: 'Nifty Fin Service', foSegment: 'nse_fo', foNames: ['FINNIFTY'] },
  { symbol: 'MIDCPNIFTY', name: 'Nifty Midcap Select', exchange: 'NSE', spotSegment: 'nse_cm', spotName: 'NIFTY MID SELECT', foSegment: 'nse_fo', foNames: ['MIDCPNIFTY'] },
  // bse_fo pSymbolName is UNCONFIRMED (critic.md U10): accept BSE's own derivative codes too.
  { symbol: 'SENSEX', name: 'BSE Sensex', exchange: 'BSE', spotSegment: 'bse_cm', spotName: 'SENSEX', foSegment: 'bse_fo', foNames: ['SENSEX', 'BSX'] },
  { symbol: 'BANKEX', name: 'BSE Bankex', exchange: 'BSE', spotSegment: 'bse_cm', spotName: 'BANKEX', foSegment: 'bse_fo', foNames: ['BANKEX', 'BKX'] },
];

/** Spot-only listings (no F&O): India VIX, quoted by name. */
const EXTRA_SPOTS = [{ symbol: 'INDIAVIX', exchange: 'NSE' as const, segment: 'nse_cm' as const, spotName: 'INDIA VIX', cmNames: ['INDIA VIX', 'INDIAVIX'] }];

export interface ScripMasterOptions {
  /** App data directory; files are cached under <dataDir>/refdata/<date>/. */
  dataDir: string;
  /** Today's scrip-master file URLs (KotakRest.scripMasterPaths().files). */
  filePaths: () => Promise<string[]>;
  fetch?: FetchLike;
  logger?: KotakLogger;
  /** Stock underlyings to offer (kept only when nse_fo lists OPTSTK rows for them). */
  stocks?: ReadonlyArray<string | StockRef>;
  /** Share of malformed rows tolerated per file before it is rejected (default 1 %). */
  maxBadRowShare?: number;
  timeoutMs?: number;
  /** Cached refdata days kept on disk (default 5). */
  keepDays?: number;
}

export interface ScripMasterStatus {
  ready: boolean;
  /** Date the loaded master was refreshed for. */
  date?: string;
  /** Date folder of the Kotak files it came from (may lag `date` before Kotak publishes). */
  sourceDate?: string | null;
  source?: 'cache' | 'download';
  underlyings: number;
  listings: number;
  warnings: string[];
  error?: string;
}

interface Legs {
  CE?: Listing;
  PE?: Listing;
}

interface UState {
  symbol: string;
  name: string;
  kind: 'index' | 'stock';
  exchange: 'NSE' | 'BSE';
  sector: string;
  foSegment: 'nse_fo' | 'bse_fo';
  foName?: string;
  spot?: Listing;
  hasOptStk: boolean;
  futs: Map<string, Listing>;
  opts: Map<string, Map<number, Legs>>;
}

interface LoadedState {
  date: string;
  sourceDate: string | null;
  source: 'cache' | 'download';
  list: Underlying[];
  bySymbol: Map<string, { u: Underlying; st: UState }>;
  spots: Map<string, Listing>;
  byToken: Map<string, Listing>;
  listings: number;
  warnings: string[];
}

interface Manifest {
  date: string;
  sourceDate: string | null;
  urls: Partial<Record<Segment, string>>;
  savedAt: string;
}

type Texts = Record<Segment, string>;

const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

/** IST calendar date of an epoch-ms instant. */
const istDate = (ms: number) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

/** lExpiryDate → IST 'YYYY-MM-DD' (undefined for -1/blank/garbage). */
export function decodeExpiry(raw: string, segment: string): string | undefined {
  const v = Number(raw.trim());
  if (!raw.trim() || !Number.isFinite(v) || v <= 0) return undefined;
  const unix = segment === 'nse_fo' || segment === 'cde_fo' ? v + NSE_EPOCH_OFFSET_S : v;
  const d = istDate(unix * 1000);
  const y = Number(d.slice(0, 4));
  return y >= 2000 && y <= 2100 ? d : undefined;
}

/** 'dStrikePrice;' (paise, maybe scientific) → rupees rounded to the paisa; undefined if not > 0. */
export function decodeStrike(raw: string): number | undefined {
  const v = Number.parseFloat(raw.trim());
  if (!Number.isFinite(v) || v <= 0) return undefined;
  return Math.round(v) / 100;
}

/** File URL of one segment: basename contains the segment name ('nse_cm' ≠ 'nse_com'); the
 *  highest '-vN' variant wins (nse_cm/bse_cm come as 'transformed-v1/*-v1.csv'). */
export function pickScripFile(urls: readonly string[], segment: Segment | 'mcx_fo'): string | undefined {
  const version = (base: string) => Number(/-v(\d+)\.csv$/i.exec(base)?.[1] ?? 0);
  const cands = urls
    .map((u) => ({ u, base: (u.split(/[?#]/)[0].split('/').pop() ?? '').toLowerCase() }))
    .filter((c) => c.base.endsWith('.csv') && c.base.includes(segment));
  cands.sort((a, b) => version(b.base) - version(a.base) || a.base.length - b.base.length);
  return cands[0]?.u;
}

/** Date folder ('/prod/2026-07-14/…') of a scrip-master URL. */
export function folderDate(url: string | undefined): string | null {
  return (url && /\/(\d{4}-\d{2}-\d{2})\//.exec(url)?.[1]) || null;
}

/** RFC 4180 records (quoted fields with commas/quotes/newlines; CRLF or LF). */
export function* csvRecords(text: string): Generator<string[]> {
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < n) {
    const row: string[] = [];
    for (;;) {
      let field: string;
      if (text.charCodeAt(i) === 34) {
        field = '';
        i++;
        for (;;) {
          const q = text.indexOf('"', i);
          if (q < 0) {
            field += text.slice(i);
            i = n;
            break;
          }
          field += text.slice(i, q);
          i = q + 1;
          if (text.charCodeAt(i) === 34) {
            field += '"';
            i++;
            continue;
          }
          break;
        }
        while (i < n && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') field += text[i++];
      } else {
        let j = i;
        while (j < n) {
          const c = text.charCodeAt(j);
          if (c === 44 || c === 10 || c === 13) break;
          j++;
        }
        field = text.slice(i, j);
        i = j;
      }
      row.push(field);
      if (i >= n) break;
      if (text.charCodeAt(i) === 44) {
        i++;
        continue;
      }
      if (text.charCodeAt(i) === 13) i++;
      if (text.charCodeAt(i) === 10) i++;
      break;
    }
    if (row.length === 1 && row[0].trim() === '') continue;
    yield row;
  }
}

/**
 * Most common gap between consecutive strikes, counted within each expiry and pooled over all of
 * them (ties → the smaller gap). Pooling matters after a corporate action: the adjusted strikes of
 * the older expiries sit off the grid (real 2023 data gives NTPC 1.75 on its nearest expiry while
 * the grid was 2.5), the newer expiries are listed on the regular grid.
 */
export function strikeStepOf(...expiryStrikes: readonly (readonly number[])[]): number | undefined {
  const counts = new Map<number, number>();
  for (const strikes of expiryStrikes) {
    const s = [...new Set(strikes)].sort((a, b) => a - b);
    for (let i = 1; i < s.length; i++) {
      const g = Math.round((s[i] - s[i - 1]) * 100) / 100;
      if (g > 0) counts.set(g, (counts.get(g) ?? 0) + 1);
    }
  }
  let best: number | undefined;
  let bestN = 0;
  for (const [g, n] of counts) if (n > bestN || (n === bestN && best !== undefined && g < best)) [best, bestN] = [g, n];
  return best;
}

const roundStrike = (k: number) => Math.round(k * 100) / 100;
const fmtStrike = (k: number) => (Number.isInteger(k) ? String(k) : String(roundStrike(k)));

/** A downloaded/cached file that failed validation (nothing from it is used). */
class FileRejected extends NoLiveData {}

export class ScripMaster implements ReferenceData {
  private state: LoadedState | null = null;
  private lastError: string | undefined;
  private refreshing: Promise<void> | null = null;
  private readonly fetchFn: FetchLike;
  private readonly log: KotakLogger;
  private readonly stockRefs: StockRef[];
  private readonly maxBadShare: number;
  private readonly timeoutMs: number;
  private readonly keepDays: number;

  constructor(private readonly opts: ScripMasterOptions) {
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.log = opts.logger ?? { info: () => {}, warn: () => {} };
    const refs = new Map(REFERENCE_STOCKS.map((s) => [s.symbol, s]));
    this.stockRefs = (opts.stocks ?? REFERENCE_STOCKS).map((s) => {
      const r = typeof s === 'string' ? { symbol: s } : s;
      const sym = r.symbol.trim().toUpperCase();
      return { symbol: sym, name: r.name ?? refs.get(sym)?.name, sector: r.sector ?? refs.get(sym)?.sector ?? '' };
    });
    this.maxBadShare = opts.maxBadRowShare ?? 0.01;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.keepDays = opts.keepDays ?? 5;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* ReferenceData                                                                             */
  /* ---------------------------------------------------------------------------------------- */

  ready(): boolean {
    return this.state !== null;
  }

  refresh(date: string): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Promise.reject(new Error(`Invalid date "${date}"`));
    const run = async () => {
      try {
        await this.doRefresh(date);
        this.lastError = undefined;
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        this.log.warn(`Instrument master refresh for ${date} failed: ${this.lastError}`);
        throw e;
      }
    };
    // Serialise refreshes; a second call waits for the first and then runs (cheap when cached).
    const p = this.refreshing ? this.refreshing.then(run) : run();
    const tail: Promise<void> = p.then(
      () => undefined,
      () => undefined,
    );
    this.refreshing = tail;
    void tail.then(() => {
      if (this.refreshing === tail) this.refreshing = null;
    });
    return p;
  }

  underlyings(): Underlying[] {
    return [...this.loaded().list];
  }

  underlying(symbol: string): Underlying {
    return this.entry(symbol).u;
  }

  expiries(symbol: string, kind: 'OPT' | 'FUT'): string[] {
    const { st } = this.entry(symbol);
    return [...(kind === 'OPT' ? st.opts : st.futs).keys()].sort();
  }

  strikes(symbol: string, expiry: string): number[] {
    const { st } = this.entry(symbol);
    const m = st.opts.get(expiry);
    if (!m) throw httpError(404, `${st.symbol} has no options listed for expiry ${expiry}`);
    return [...m.keys()].sort((a, b) => a - b);
  }

  listing(key: InstrumentKey): Listing | undefined {
    const s = this.loaded();
    const sym = key.symbol.trim().toUpperCase();
    if (key.kind === 'SPOT') return s.bySymbol.get(sym)?.u.spot ?? s.spots.get(sym);
    const st = s.bySymbol.get(sym)?.st;
    if (!st || !key.expiry) return undefined;
    if (key.kind === 'FUT') return st.futs.get(key.expiry);
    if (key.strike === undefined) return undefined;
    return st.opts.get(key.expiry)?.get(roundStrike(key.strike))?.[key.kind];
  }

  byToken(segment: Segment, token: string): Listing | undefined {
    return this.state?.byToken.get(`${segment}|${token}`);
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Extras for the provider                                                                   */
  /* ---------------------------------------------------------------------------------------- */

  /** Option listings of one expiry by strike, ascending. */
  chain(symbol: string, expiry: string): { strike: number; ce?: Listing; pe?: Listing }[] {
    const { st } = this.entry(symbol);
    const m = st.opts.get(expiry);
    if (!m) throw httpError(404, `${st.symbol} has no options listed for expiry ${expiry}`);
    return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([strike, l]) => ({ strike, ce: l.CE, pe: l.PE }));
  }

  /** `exchange`/`underlying` parameters for the option-chain and expiries APIs. */
  kotakUnderlying(symbol: string): { exchange: 'nse_fo' | 'bse_fo'; underlying: string } {
    const { st } = this.entry(symbol);
    return { exchange: st.foSegment, underlying: st.foName ?? st.symbol };
  }

  /** Quotes/websocket neosymbol of a listing ('nse_fo|71472', 'nse_cm|Nifty 50'). */
  static neosymbol(l: Pick<Listing, 'segment' | 'token'>): string {
    return `${l.segment}|${l.token}`;
  }

  status(): ScripMasterStatus {
    const s = this.state;
    return {
      ready: !!s,
      ...(s ? { date: s.date, sourceDate: s.sourceDate, source: s.source } : {}),
      underlyings: s?.list.length ?? 0,
      listings: s?.listings ?? 0,
      warnings: s ? [...s.warnings] : [],
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  private loaded(): LoadedState {
    if (!this.state) throw new NoLiveData(`Instrument master not loaded yet${this.lastError ? ` (${this.lastError})` : ''}`);
    return this.state;
  }

  private entry(symbol: string): { u: Underlying; st: UState } {
    const s = this.loaded();
    const e = s.bySymbol.get(symbol.trim().toUpperCase());
    if (!e) throw httpError(404, `Unknown symbol ${symbol}: not an F&O underlying in the ${s.date} instrument master`);
    return e;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Refresh: cache → download → parse                                                       */
  /* ---------------------------------------------------------------------------------------- */

  private async doRefresh(date: string): Promise<void> {
    const dir = path.join(this.opts.dataDir, 'refdata', date);
    const manifest = await readManifest(dir);

    // 1. Today's cache, built from today's Kotak folder: no network at all.
    if (manifest && manifest.date === date && (manifest.sourceDate === null || manifest.sourceDate >= date)) {
      if (await this.tryCache(dir, date, manifest)) return;
    }

    // 2. Ask Kotak which files are current.
    const urls = await this.opts.filePaths();
    const picked: Partial<Record<Segment, string>> = {};
    for (const seg of SCRIP_SEGMENTS) picked[seg] = pickScripFile(urls, seg);
    const missing = REQUIRED_SEGMENTS.filter((s) => !picked[s]);
    if (missing.length) throw new NoLiveData(`Kotak scrip-master file-paths lists no ${missing.join(', ')} file`);
    const sourceDate = folderDate(picked.nse_fo);

    // 3. The cache already holds that folder's files (Kotak has not published a newer one yet).
    if (manifest && manifest.date === date && sourceDate !== null && manifest.sourceDate === sourceDate) {
      if (await this.tryCache(dir, date, manifest)) return;
    }

    // 4. Download, validate, then cache (only a complete set, so a restart retries what failed).
    const texts: Partial<Texts> = {};
    const notes: string[] = [];
    await Promise.all(
      SCRIP_SEGMENTS.map(async (seg) => {
        const url = picked[seg];
        try {
          if (!url) throw new NoLiveData(`Kotak scrip-master file-paths lists no ${seg} file`);
          texts[seg] = await this.download(url, seg);
        } catch (e) {
          if (REQUIRED_SEGMENTS.includes(seg)) throw e;
          notes.push(`${e instanceof Error ? e.message : String(e)}; ${OPTIONAL_SEGMENT_IMPACT[seg]}`);
        }
      }),
    );
    this.state = this.build(texts, date, sourceDate, 'download', notes);
    if (SCRIP_SEGMENTS.every((s) => texts[s] !== undefined)) {
      try {
        await writeCache(dir, texts as Texts, { date, sourceDate, urls: picked, savedAt: new Date().toISOString() });
        await this.prune(date);
      } catch (e) {
        this.log.warn(`Could not cache the instrument master: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.logLoaded();
  }

  private async tryCache(dir: string, date: string, manifest: Manifest): Promise<boolean> {
    const texts = await readCache(dir);
    if (!texts) return false;
    try {
      this.state = this.build(texts, date, manifest.sourceDate, 'cache', []);
      this.logLoaded();
      return true;
    } catch (e) {
      this.log.warn(`Cached instrument master in ${dir} is unusable (${e instanceof Error ? e.message : String(e)}); downloading again`);
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      return false;
    }
  }

  private logLoaded() {
    const s = this.state!;
    this.log.info(`Instrument master ${s.date} loaded from ${s.source} (Kotak folder ${s.sourceDate ?? '?'}): ${s.list.length} underlyings, ${s.listings} listings`);
    for (const w of s.warnings) this.log.warn(`Instrument master: ${w}`);
  }

  private async download(url: string, seg: Segment): Promise<string> {
    let res: Response;
    try {
      // Plain unauthenticated GET, no headers (kotak-rest-auth.md §3.1).
      res = await this.fetchFn(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) {
      throw new NoLiveData(`Scrip master ${seg} download failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new NoLiveData(`Scrip master ${seg} download failed: HTTP ${res.status}`);
    try {
      return await res.text();
    } catch (e) {
      // A body cut off or timed out mid-download is a failed download, not a crash.
      throw new NoLiveData(`Scrip master ${seg} download failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async prune(current: string) {
    const root = path.join(this.opts.dataDir, 'refdata');
    const days = (await fs.readdir(root)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d !== current).sort();
    const drop = days.slice(0, Math.max(0, days.length - (this.keepDays - 1)));
    await Promise.all(drop.map((d) => fs.rm(path.join(root, d), { recursive: true, force: true })));
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Parsing                                                                                   */
  /* ---------------------------------------------------------------------------------------- */

  /** Universe targets: which CSV names feed which underlying. */
  private targets(): Targets {
    const states = new Map<string, UState>();
    const fo = new Map<string, UState>();
    const cmIndex = new Map<string, string>();
    for (const spec of INDEX_SPECS) {
      const st = newState(spec.symbol, spec.name, 'index', spec.exchange, 'Index', spec.foSegment);
      states.set(spec.symbol, st);
      for (const n of spec.foNames) fo.set(`${spec.foSegment}|${n}`, st);
      for (const n of [spec.spotName, ...spec.foNames]) cmIndex.set(`${spec.spotSegment}|${n.toUpperCase()}`, spec.symbol);
    }
    for (const x of EXTRA_SPOTS) for (const n of x.cmNames) cmIndex.set(`${x.segment}|${n.toUpperCase()}`, x.symbol);
    for (const r of this.stockRefs) {
      if (states.has(r.symbol)) continue;
      const st = newState(r.symbol, r.name ?? r.symbol, 'stock', 'NSE', r.sector ?? '', 'nse_fo');
      states.set(r.symbol, st);
      fo.set(`nse_fo|${r.symbol}`, st);
    }
    return { states, fo, cmIndex };
  }

  /**
   * Validates one file and collects what it contributes. Nothing is applied until the whole file
   * passed, so a rejected file leaves no partial listings behind.
   */
  private parseFile(seg: Segment, text: string, date: string, t: Targets): FileParse {
    const isFo = seg === 'nse_fo' || seg === 'bse_fo';
    const file = `${seg}.csv`;
    const out: FileParse = { listings: [], indexTokens: [], stockSpots: new Map(), optStk: new Set(), foNames: new Map(), warnings: [] };
    const it = csvRecords(text);
    const first = it.next();
    if (first.done) throw new FileRejected(`Scrip master ${file} rejected: empty file`);
    const header = first.value.map((h) => h.trim());
    const col = new Map(header.map((h, i) => [h, i]));
    const strikeCol = col.get('dStrikePrice;') ?? col.get('dStrikePrice');
    const required = ['pSymbol', 'pGroup', 'pExchSeg', 'pSymbolName', 'pTrdSymbol', 'dTickSize', 'lLotSize', 'pSegment', ...(isFo ? ['pInstType', 'pOptionType', 'lExpiryDate'] : [])];
    const miss = required.filter((h) => !col.has(h));
    if (isFo && strikeCol === undefined) miss.push('dStrikePrice;');
    if (miss.length) throw new FileRejected(`Scrip master ${file} rejected: missing columns ${miss.join(', ')}`);
    const c = (name: string) => col.get(name)!;
    const iSym = c('pSymbol'), iGroup = c('pGroup'), iSeg = c('pExchSeg'), iName = c('pSymbolName'), iTrd = c('pTrdSymbol');
    const iTick = c('dTickSize'), iLot = c('lLotSize'), iPSeg = c('pSegment');
    const iInst = col.get('pInstType'), iOpt = col.get('pOptionType'), iExp = col.get('lExpiryDate');
    const iFreeze = col.get('lFreezeQty'), iDesc = col.get('pDesc');

    let rows = 0, bad = 0, spreads = 0, past = 0, fo = 0, strikeChecked = 0, strikeMatched = 0;
    let firstBad = '';
    const pastLimit = istDate(Date.parse(`${date}T00:00:00Z`) - 7 * DAY_MS);
    const seen = new Set<string>();
    let line = 1;
    const fail = (why: string) => {
      bad++;
      if (!firstBad) firstBad = `line ${line}: ${why}`;
    };

    for (const r of it) {
      line++;
      rows++;
      if (r.length !== header.length) {
        fail(`${r.length} fields, header has ${header.length}`);
        continue;
      }
      const token = r[iSym].trim();
      if (isFo && (token.includes(' ') || r[iPSeg].trim() === '')) {
        spreads++; // calendar spread: two tokens, no segment (kotak-rest-auth.md §3.2)
        continue;
      }
      if (!/^\d+$/.test(token)) {
        fail(`pSymbol "${token.slice(0, 20)}" is not a token`);
        continue;
      }
      if (r[iSeg].trim().toLowerCase() !== seg) {
        fail(`pExchSeg "${r[iSeg].trim().slice(0, 12)}" in the ${seg} file`);
        continue;
      }
      const name = r[iName].trim().toUpperCase();
      const group = r[iGroup].trim();
      const lot = Number(r[iLot].trim());
      const tick = Number(r[iTick].trim()) / 100;
      const freeze = iFreeze !== undefined ? Number(r[iFreeze].trim()) : NaN;

      if (!isFo) {
        if (group === '') {
          // Index/non-equity rows (legacy: 26000 NIFTY, empty group and segment, tick -1).
          const sym = t.cmIndex.get(`${seg}|${name}`);
          if (sym) out.indexTokens.push([`${seg}|${token}`, sym]);
          continue;
        }
        if (!Number.isInteger(lot) || lot <= 0 || !(tick > 0)) {
          fail('invalid lLotSize/dTickSize');
          continue;
        }
        const st = seg === 'nse_cm' ? t.states.get(name) : undefined;
        const rank = group === 'EQ' ? 0 : group === 'BE' ? 1 : -1;
        if (st && st.kind === 'stock' && rank >= 0) {
          const prev = out.stockSpots.get(st.symbol);
          if (!prev || rank < prev.rank) {
            out.stockSpots.set(st.symbol, {
              rank,
              desc: iDesc !== undefined ? r[iDesc].trim() || undefined : undefined,
              l: withFreeze({ symbol: st.symbol, kind: 'SPOT', exchange: 'NSE', segment: seg, token, tradingSymbol: r[iTrd].trim(), lotSize: lot, tickSize: roundTick(tick) }, freeze),
            });
          }
        }
        continue;
      }

      // F&O row: validate every row (corruption check), keep only the universe's.
      fo++;
      const optRaw = r[iOpt!].trim().toUpperCase();
      const inst = r[iInst!].trim().toUpperCase();
      const strike = decodeStrike(r[strikeCol!]);
      const kind: 'FUT' | OptKind | null =
        optRaw === 'CE' || optRaw === 'PE' ? optRaw : inst.startsWith('FUT') || (!inst.startsWith('OPT') && strike === undefined) ? 'FUT' : null;
      const expiry = decodeExpiry(r[iExp!], seg);
      if (!Number.isInteger(lot) || lot <= 0 || !(tick > 0)) {
        fail('invalid lLotSize/dTickSize');
        continue;
      }
      if (!kind) {
        fail(`unknown pOptionType "${optRaw.slice(0, 6)}"`);
        continue;
      }
      if (!expiry) {
        fail('undecodable lExpiryDate');
        continue;
      }
      if (kind !== 'FUT' && strike === undefined) {
        fail('option without a strike');
        continue;
      }
      if (expiry < pastLimit) past++;
      const st = t.fo.get(`${seg}|${name}`);
      if (!st) continue;
      if (st.kind === 'stock' && inst !== 'OPTSTK' && inst !== 'FUTSTK') continue;
      if (st.kind === 'index' && (inst === 'OPTSTK' || inst === 'FUTSTK')) continue;
      if (inst === 'OPTSTK') out.optStk.add(st);
      if (expiry < date) continue; // expired: no longer listed
      if (!out.foNames.has(st)) out.foNames.set(st, r[iName].trim());
      const trd = r[iTrd].trim();
      const base = { symbol: st.symbol, exchange: st.exchange, segment: seg, token, tradingSymbol: trd, lotSize: lot, tickSize: roundTick(tick) };
      const id = kind === 'FUT' ? `${st.symbol}|FUT|${expiry}` : `${st.symbol}|${kind}|${expiry}|${strike}`;
      if (seen.has(id)) continue;
      seen.add(id);
      if (kind === 'FUT') out.listings.push({ st, l: withFreeze({ ...base, kind: 'FUT', expiry }, freeze) });
      else {
        strikeChecked++;
        if (trd.replace(/\s+/g, '').toUpperCase().endsWith(`${fmtStrike(strike!)}${kind}`)) strikeMatched++;
        out.listings.push({ st, l: withFreeze({ ...base, kind, expiry, strike: strike! }, freeze) });
      }
    }

    const usable = rows - bad - spreads;
    if (usable <= 0) throw new FileRejected(`Scrip master ${file} rejected: no usable rows${firstBad ? ` (first problem ${firstBad})` : ''}`);
    if (bad > this.maxBadShare * (rows - spreads)) {
      throw new FileRejected(`Scrip master ${file} rejected: ${bad} of ${rows - spreads} rows malformed (first problem ${firstBad})`);
    }
    if (bad) out.warnings.push(`${file}: skipped ${bad} malformed rows (first problem ${firstBad})`);
    if (isFo && fo > 0 && past > fo / 2) {
      throw new FileRejected(`Scrip master ${file} rejected: ${past} of ${fo} contracts decode to expiries before ${pastLimit} (expiry epoch mismatch?)`);
    }
    // Strike-scale guard: option trading symbols end with '<strike><CE|PE>' (NIFTY23DEC17500CE).
    if (strikeChecked >= 20 && strikeMatched < strikeChecked / 2) {
      throw new FileRejected(`Scrip master ${file} rejected: decoded strikes do not match trading symbols (${strikeMatched}/${strikeChecked}); strike scale changed?`);
    }
    return out;
  }

  private build(texts: Partial<Texts>, date: string, sourceDate: string | null, source: 'cache' | 'download', notes: string[]): LoadedState {
    const warnings = [...notes];
    const t = this.targets();
    const byToken = new Map<string, Listing>();
    const indexTokens = new Map<string, string>();
    const stockSpots = new Map<string, { l: Listing; rank: number; desc?: string }>();
    let listings = 0;

    for (const seg of SCRIP_SEGMENTS) {
      const text = texts[seg];
      if (text === undefined) continue; // optional file unavailable (already noted)
      let res: FileParse;
      try {
        res = this.parseFile(seg, text, date, t);
      } catch (e) {
        // NSE files are essential; a bad BSE file only removes SENSEX/BANKEX.
        if (REQUIRED_SEGMENTS.includes(seg) || !(e instanceof FileRejected)) throw e;
        warnings.push(`${e.message}; ${OPTIONAL_SEGMENT_IMPACT[seg]}`);
        continue;
      }
      warnings.push(...res.warnings);
      for (const [k, sym] of res.indexTokens) indexTokens.set(k, sym);
      for (const [sym, v] of res.stockSpots) stockSpots.set(sym, v);
      for (const st of res.optStk) st.hasOptStk = true;
      for (const [st, n] of res.foNames) st.foName ??= n;
      for (const { st, l } of res.listings) {
        if (l.kind === 'FUT') st.futs.set(l.expiry!, l);
        else {
          let m = st.opts.get(l.expiry!);
          if (!m) st.opts.set(l.expiry!, (m = new Map()));
          const legs = m.get(l.strike!) ?? {};
          legs[l.kind as OptKind] = l;
          m.set(l.strike!, legs);
        }
        byToken.set(`${l.segment}|${l.token}`, l);
        listings++;
      }
    }

    // Assemble underlyings.
    const list: Underlying[] = [];
    const bySymbol = new Map<string, { u: Underlying; st: UState }>();
    const spots = new Map<string, Listing>();
    const skippedStocks: string[] = [];
    for (const spec of INDEX_SPECS) {
      const st = t.states.get(spec.symbol)!;
      st.spot = { symbol: spec.symbol, kind: 'SPOT', exchange: spec.exchange, segment: spec.spotSegment, token: spec.spotName, tradingSymbol: spec.spotName, ...INDEX_SPOT_META };
    }
    for (const x of EXTRA_SPOTS) {
      spots.set(x.symbol, { symbol: x.symbol, kind: 'SPOT', exchange: x.exchange, segment: x.segment, token: x.spotName, tradingSymbol: x.spotName, ...INDEX_SPOT_META });
    }
    for (const st of t.states.values()) {
      if (st.kind === 'stock') {
        if (!st.hasOptStk) {
          skippedStocks.push(st.symbol);
          continue;
        }
        const sp = stockSpots.get(st.symbol);
        if (!sp) {
          warnings.push(`${st.symbol}: listed in nse_fo but no EQ row in nse_cm; skipped`);
          continue;
        }
        st.spot = sp.l;
        if (st.name === st.symbol && sp.desc) st.name = sp.desc;
      }
      const nearest = [...st.opts.keys()].sort()[0];
      if (!nearest) {
        const names = st.kind === 'index' ? INDEX_SPECS.find((s) => s.symbol === st.symbol)!.foNames.join('/') : st.symbol;
        warnings.push(`${st.symbol}: no live option contracts in ${st.foSegment} (pSymbolName ${names}); skipped`);
        continue;
      }
      const m = st.opts.get(nearest)!;
      const strikeStep = strikeStepOf(...[...st.opts.values()].map((byStrike) => [...byStrike.keys()]));
      if (strikeStep === undefined) {
        warnings.push(`${st.symbol}: fewer than two strikes in any live expiry; skipped`);
        continue;
      }
      const leg = [...m.values()].map((l) => l.CE ?? l.PE).find((l): l is Listing => !!l)!;
      const u: Underlying = { symbol: st.symbol, name: st.name, kind: st.kind, exchange: st.exchange, sector: st.sector, lotSize: leg.lotSize, strikeStep, spot: st.spot! };
      list.push(u);
      bySymbol.set(st.symbol, { u, st });
    }
    if (skippedStocks.length) warnings.push(`${skippedStocks.length} configured stocks have no OPTSTK rows in nse_fo; not offered: ${skippedStocks.slice(0, 10).join(', ')}${skippedStocks.length > 10 ? ', …' : ''}`);
    if (!list.length) throw new FileRejected('Instrument master has no usable underlyings');

    // Spot listings by name, plus numeric index tokens where a cm file has them (feed decoding).
    for (const { u } of bySymbol.values()) byToken.set(`${u.spot.segment}|${u.spot.token}`, u.spot);
    for (const l of spots.values()) byToken.set(`${l.segment}|${l.token}`, l);
    for (const [k, sym] of indexTokens) {
      const l = bySymbol.get(sym)?.u.spot ?? spots.get(sym);
      if (l && !byToken.has(k)) byToken.set(k, l);
    }
    return { date, sourceDate, source, list, bySymbol, spots, byToken, listings, warnings };
  }
}

/** NSE files are required; the BSE ones only feed SENSEX/BANKEX. */
const REQUIRED_SEGMENTS: readonly Segment[] = ['nse_cm', 'nse_fo'];
const OPTIONAL_SEGMENT_IMPACT: Record<Segment, string> = {
  nse_cm: '',
  nse_fo: '',
  bse_cm: 'BSE numeric index tokens unavailable',
  bse_fo: 'SENSEX/BANKEX F&O unavailable',
};

interface Targets {
  states: Map<string, UState>;
  /** `${segment}|${pSymbolName}` → underlying state. */
  fo: Map<string, UState>;
  /** `${segment}|${NAME}` of index rows in cm files → app symbol. */
  cmIndex: Map<string, string>;
}

interface FileParse {
  listings: { st: UState; l: Listing }[];
  indexTokens: [string, string][];
  stockSpots: Map<string, { l: Listing; rank: number; desc?: string }>;
  optStk: Set<UState>;
  foNames: Map<UState, string>;
  warnings: string[];
}

/**
 * Index spots are not tradable. Lot size 1 is what the cash master lists for index rows (lLotSize 1
 * on NSE token 26000 / NIFTY in the official nse_cm sample); their dTickSize is −1, i.e. there is no
 * tick size, so `tickSize` is left out rather than invented.
 */
const INDEX_SPOT_META = { lotSize: 1 } as const;

function newState(symbol: string, name: string, kind: 'index' | 'stock', exchange: 'NSE' | 'BSE', sector: string, foSegment: 'nse_fo' | 'bse_fo'): UState {
  return { symbol, name, kind, exchange, sector, foSegment, hasOptStk: false, futs: new Map(), opts: new Map() };
}

const roundTick = (t: number) => Math.round(t * 10_000) / 10_000;

/** lFreezeQty as published (the 2023 official sample has iMaxOrderSize = lFreezeQty = NSE freeze + 1). */
function withFreeze(l: Listing, freeze: number): Listing {
  if (Number.isInteger(freeze) && freeze > 0 && freeze < 99_999_999) l.freezeQty = freeze;
  return l;
}

async function readManifest(dir: string): Promise<Manifest | null> {
  try {
    const m = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')) as Partial<Manifest>;
    return typeof m.date === 'string' ? { date: m.date, sourceDate: m.sourceDate ?? null, urls: m.urls ?? {}, savedAt: m.savedAt ?? '' } : null;
  } catch {
    return null;
  }
}

async function readCache(dir: string): Promise<Texts | null> {
  try {
    const texts = {} as Texts;
    for (const seg of SCRIP_SEGMENTS) texts[seg] = await fs.readFile(path.join(dir, `${seg}.csv`), 'utf8');
    return texts;
  } catch {
    return null;
  }
}

/** Files first (atomic rename), manifest last: a manifest implies a complete set. */
async function writeCache(dir: string, texts: Texts, manifest: Manifest): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  for (const seg of SCRIP_SEGMENTS) {
    const f = path.join(dir, `${seg}.csv`);
    await fs.writeFile(`${f}.tmp`, texts[seg]);
    await fs.rename(`${f}.tmp`, f);
  }
  const mf = path.join(dir, 'manifest.json');
  await fs.writeFile(`${mf}.tmp`, JSON.stringify(manifest, null, 2));
  await fs.rename(`${mf}.tmp`, mf);
}
