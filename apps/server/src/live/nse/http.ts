/**
 * HTTP access to the official NSE/BSE end-of-day files and the few unofficial NSE JSON endpoints
 * (nse-bse-public-data.md §1, §12; critic.md U11), plus the CSV/date helpers every parser shares.
 *
 *  - Browser-like headers (§1.2). Archive files usually work without cookies; on 401/403 the site's
 *    home page is loaded once to collect cookies (Akamai, §1.1) and the request is retried once.
 *  - www.nseindia.com/api/* always gets the cookie warm-up of the HTML page that hosts the widget,
 *    sent as Referer (§1.2 table); re-warmed once on 401/403/429.
 *  - One serial queue per host: archives ≥500 ms apart, www.nseindia.com ≥3 s apart (§1.3, §12.1).
 *  - 404 means "not published yet" (or a holiday): a result, not an error (§1.4, §2 "Publication").
 *  - A 200 alone is never trusted: zip magic, CSV header and JSON are sniffed (§1.4).
 *  - Host fallback nsearchives → archives on network errors, 5xx or a block; never for
 *    fo_mktlots.csv, whose archives path redirects to an unrelated PDF (§1.1, critic §5).
 * Cookie values are never logged.
 */
import { unzipSync } from 'fflate';
import { NoLiveData } from '../types';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface NseLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

const noopLogger: NseLogger = { info: () => {}, warn: () => {} };

export const NSE_ARCHIVES = 'https://nsearchives.nseindia.com';
/** Legacy mirror, often byte-identical (§1.1). */
export const NSE_ARCHIVES_LEGACY = 'https://archives.nseindia.com';
export const NSE_WWW = 'https://www.nseindia.com';
export const BSE_WWW = 'https://www.bseindia.com';

/** §1.2 (UNCONFIRMED which subset NSE actually requires). */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------------------------------ */
/* Errors and results                                                                           */
/* ------------------------------------------------------------------------------------------ */

/**
 * blocked: 401/403/429 or a bot-protection page; network: DNS/TLS/timeout; http: other status;
 * format: the body is not the expected file; unsupported: a request this client does not serve.
 */
export type NseErrorKind = 'blocked' | 'network' | 'http' | 'format' | 'unsupported';

/** An official file or endpoint that produced no data. It is a NoLiveData (HTTP 503 with the reason). */
export class NseError extends NoLiveData {
  constructor(
    reason: string,
    readonly kind: NseErrorKind,
    readonly url?: string,
    readonly httpStatus?: number,
  ) {
    super(reason);
    this.name = 'NseError';
  }
}

/** HTTP 404: the file is not published yet (or the date was a holiday). Not an error. */
export interface NotPublished {
  status: 'not-published';
  url: string;
  httpStatus: number;
}

export interface FileOk {
  status: 'ok';
  /** Final URL (after redirects). */
  url: string;
  body: Uint8Array;
  contentType: string;
}

export type FileResult = FileOk | NotPublished;

export type Published<T> = { status: 'ok'; url: string; data: T } | NotPublished;

/** Result of a best-effort source (unofficial JSON): the data, or null with the reason. */
export type Fetched<T> = { data: T; reason?: undefined } | { data: null; reason: string };

/* ------------------------------------------------------------------------------------------ */
/* Client                                                                                       */
/* ------------------------------------------------------------------------------------------ */

export interface NseHttpOptions {
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: NseLogger;
  /** Per-request timeout including the body (ms). */
  timeoutMs?: number;
  /** Extra attempts after a network error, 5xx or 429 (per host). */
  retries?: number;
  /** First backoff (ms); doubles per attempt up to maxBackoffMs. */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Minimum gap between two requests to an archive host (ms). */
  archiveSpacingMs?: number;
  /** Minimum gap between two requests to www.nseindia.com (ms). */
  apiSpacingMs?: number;
  /** Cookies older than this are re-warmed before a JSON call (ms). */
  cookieTtlMs?: number;
}

export interface FileRequest {
  url: string;
  /** 'zip' requires the PK magic; 'csv' rejects HTML/PDF/empty bodies. */
  expect: 'zip' | 'csv';
  /** nsearchives → archives on network error, 5xx or block (default true; never for fo_mktlots.csv). */
  hostFallback?: boolean;
  /** Page loaded for cookies after a 401/403 (default: the site's home page). */
  warmupUrl?: string;
  referer?: string;
}

export interface CsvRequest extends Omit<FileRequest, 'expect'> {
  /** The file is a zip holding the CSV. A plain-CSV request also accepts a zipped body. */
  zipped?: boolean;
  /** Zip entry to use when the zip holds several CSVs. */
  entry?: RegExp;
  /** Expected start of the file (after BOM, quotes and spaces), case-insensitive (§1.4). */
  header: string | RegExp;
}

export interface JsonRequest {
  url: string;
  /** HTML page that hosts the widget: loaded first for cookies and sent as Referer (§1.2). */
  warmupUrl: string;
}

interface RawResponse {
  status: number;
  url: string;
  headers: Headers;
  body: Uint8Array;
}

interface Lane {
  tail: Promise<void>;
  lastEnd?: number;
  spacing: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class NseHttp {
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: NseLogger;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly archiveSpacingMs: number;
  private readonly apiSpacingMs: number;
  private readonly cookieTtlMs: number;
  private readonly lanes = new Map<string, Lane>();
  private readonly jar = new CookieJar();

  constructor(opts: NseHttpOptions = {}) {
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? (() => Date.now());
    this.sleep = opts.sleep ?? realSleep;
    this.log = opts.logger ?? noopLogger;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.retries = opts.retries ?? 2;
    this.backoffMs = opts.backoffMs ?? 2_000;
    this.maxBackoffMs = opts.maxBackoffMs ?? 30_000;
    this.archiveSpacingMs = opts.archiveSpacingMs ?? 500;
    this.apiSpacingMs = opts.apiSpacingMs ?? 3_000;
    this.cookieTtlMs = opts.cookieTtlMs ?? 10 * 60_000;
  }

  /** GET an official file. 404 → not-published; anything unusable → NseError. */
  async getFile(req: FileRequest): Promise<FileResult> {
    const urls = [req.url];
    const alt = req.hostFallback === false ? undefined : legacyArchiveUrl(req.url);
    if (alt) urls.push(alt);
    for (let i = 0; ; i++) {
      try {
        return await this.getFileFrom(urls[i], req);
      } catch (e) {
        const last = i === urls.length - 1;
        if (last || !(e instanceof NseError) || !fallbackWorthy(e)) throw e;
        this.log.warn(`${e.message}; trying ${new URL(urls[i + 1]).host}`);
      }
    }
  }

  /** GET an official CSV (plain or zipped) and check that it starts with the expected header. */
  async getCsv(req: CsvRequest): Promise<Published<string>> {
    const res = await this.getFile({ ...req, expect: req.zipped ? 'zip' : 'csv' });
    if (res.status !== 'ok') return res;
    const label = fileLabel(res.url);
    const text = isZip(res.body) ? unzipCsv(res.body, req.entry, label).text : decodeText(res.body);
    if (!startsWithHeader(text, req.header)) {
      throw new NseError(`${label}: unexpected content (expected a CSV starting with ${String(req.header)})`, 'format', res.url);
    }
    return { status: 'ok', url: res.url, data: text };
  }

  /** GET an unofficial www.nseindia.com JSON API after the cookie warm-up of its page. */
  async getJson(req: JsonRequest): Promise<Published<unknown>> {
    const label = new URL(req.url).pathname;
    if (!this.jar.isFresh(req.url, this.now(), this.cookieTtlMs)) await this.warmUp(req.warmupUrl);
    let rewarmed = false;
    for (;;) {
      const res = await this.sendWithRetry(req.url, this.headers(req.url, 'json', req.warmupUrl));
      if (res.status === 404) return { status: 'not-published', url: req.url, httpStatus: 404 };
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        // A 429 asking for a longer pause than we back off is a rate limit, not a cookie problem.
        const ra = res.status === 429 ? retryAfterMs(res.headers.get('retry-after'), this.now()) : undefined;
        if (ra !== undefined && ra > this.maxBackoffMs) {
          throw new NseError(`${label}: rate limited (HTTP 429, Retry-After ${Math.round(ra / 1000)} s)`, 'blocked', req.url, res.status);
        }
        if (!rewarmed) {
          rewarmed = true;
          this.log.info(`${label}: HTTP ${res.status}, re-warming cookies once`);
          this.jar.clear(req.url);
          await this.warmUp(req.warmupUrl);
          continue;
        }
        throw new NseError(`${label}: blocked (HTTP ${res.status}) after cookie warm-up`, 'blocked', req.url, res.status);
      }
      if (res.status < 200 || res.status >= 300) throw new NseError(`${label}: HTTP ${res.status}`, 'http', req.url, res.status);
      const text = decodeText(res.body).trim();
      if (!text) throw new NseError(`${label}: empty response`, 'format', req.url, res.status);
      if (text.startsWith('<')) throw new NseError(`${label}: returned an HTML page instead of JSON (bot protection?)`, 'blocked', req.url, res.status);
      try {
        return { status: 'ok', url: req.url, data: JSON.parse(text) as unknown };
      } catch {
        throw new NseError(`${label}: invalid JSON`, 'format', req.url, res.status);
      }
    }
  }

  /** Load an HTML page to collect the site's cookies (Akamai `nsit`, `nseappid`, `ak_bmsc`, `bm_sv` …). */
  async warmUp(pageUrl: string): Promise<void> {
    const res = await this.sendWithRetry(pageUrl, this.headers(pageUrl, 'html'));
    if (res.status >= 200 && res.status < 400) {
      this.jar.markWarm(pageUrl, this.now());
      this.log.info(`cookie warm-up ${new URL(pageUrl).pathname}: HTTP ${res.status}, ${this.jar.count(pageUrl)} cookies`);
      return;
    }
    const blocked = res.status === 401 || res.status === 403 || res.status === 429;
    throw new NseError(`cookie warm-up ${pageUrl} returned HTTP ${res.status}`, blocked ? 'blocked' : 'http', pageUrl, res.status);
  }

  private async getFileFrom(url: string, req: FileRequest): Promise<FileResult> {
    const label = fileLabel(url);
    let warmed = false;
    for (;;) {
      const res = await this.sendWithRetry(url, this.headers(url, 'file', req.referer));
      if (res.status === 404) return { status: 'not-published', url, httpStatus: 404 };
      if ((res.status === 401 || res.status === 403) && !warmed) {
        warmed = true;
        this.log.info(`${label}: HTTP ${res.status}, warming cookies and retrying once`);
        this.jar.clear(url);
        await this.warmUp(req.warmupUrl ?? siteHome(url));
        continue;
      }
      if (res.status === 401 || res.status === 403 || res.status === 429) {
        throw new NseError(`${label}: blocked (HTTP ${res.status})`, 'blocked', url, res.status);
      }
      if (res.status < 200 || res.status >= 300) throw new NseError(`${label}: HTTP ${res.status}`, 'http', url, res.status);
      const kind = sniff(res.body);
      if (req.expect === 'zip' ? kind !== 'zip' : kind !== 'text' && kind !== 'zip') {
        throw new NseError(`${label}: got ${describeKind(kind)} instead of the ${req.expect} file (not published or moved)`, 'format', res.url, res.status);
      }
      return { status: 'ok', url: res.url, body: res.body, contentType: res.headers.get('content-type') ?? '' };
    }
  }

  /** One logical request: retries network errors, 5xx and 429 with exponential backoff. */
  private async sendWithRetry(url: string, headers: Record<string, string>): Promise<RawResponse> {
    for (let attempt = 0; ; attempt++) {
      let res: RawResponse | undefined;
      let err: NseError | undefined;
      try {
        res = await this.send(url, headers);
      } catch (e) {
        if (!(e instanceof NseError)) throw e;
        err = e;
      }
      const retryable = err !== undefined || (res !== undefined && (res.status >= 500 || res.status === 429));
      if (!retryable || attempt >= this.retries) {
        if (err) throw err;
        return res!;
      }
      let wait = Math.min(this.maxBackoffMs, this.backoffMs * 2 ** attempt);
      const ra = res ? retryAfterMs(res.headers.get('retry-after'), this.now()) : undefined;
      // Honour Retry-After (DESIGN.md §1.5): when it asks for more than maxBackoffMs, stop instead of retrying early.
      if (ra !== undefined && ra > this.maxBackoffMs) return res!;
      if (ra !== undefined) wait = Math.max(wait, ra);
      this.log.warn(`${fileLabel(url)}: ${err ? err.message : `HTTP ${res!.status}`}; retry ${attempt + 1}/${this.retries} in ${Math.round(wait / 1000)} s`);
      await this.sleep(wait);
    }
  }

  /** A single GET through the host's serial queue; the body is read inside the timeout. */
  private send(url: string, headers: Record<string, string>): Promise<RawResponse> {
    return this.inLane(new URL(url).host, async () => {
      // Cookies may have changed while queued (a warm-up ahead of us).
      const h = { ...headers };
      const cookie = this.jar.header(url);
      if (cookie) h.Cookie = cookie;
      else delete h.Cookie;
      try {
        const res = await this.fetchFn(url, { method: 'GET', headers: h, redirect: 'follow', signal: AbortSignal.timeout(this.timeoutMs) });
        const body = new Uint8Array(await res.arrayBuffer());
        const finalUrl = res.url || url;
        this.jar.store(finalUrl, res.headers, this.now());
        return { status: res.status, url: finalUrl, headers: res.headers, body };
      } catch (e) {
        throw new NseError(`${fileLabel(url)}: ${networkReason(e, this.timeoutMs)}`, 'network', url);
      }
    });
  }

  private async inLane<T>(host: string, fn: () => Promise<T>): Promise<T> {
    let lane = this.lanes.get(host);
    if (!lane) {
      lane = { tail: Promise.resolve(), spacing: host === 'www.nseindia.com' || host === 'nseindia.com' ? this.apiSpacingMs : this.archiveSpacingMs };
      this.lanes.set(host, lane);
    }
    const prev = lane.tail;
    let done!: () => void;
    lane.tail = new Promise<void>((r) => (done = r));
    try {
      await prev;
      if (lane.lastEnd !== undefined) {
        const gap = lane.lastEnd + lane.spacing - this.now();
        if (gap > 0) await this.sleep(gap);
      }
      return await fn();
    } finally {
      lane.lastEnd = this.now();
      done();
    }
  }

  private headers(url: string, kind: 'file' | 'json' | 'html', referer?: string): Record<string, string> {
    const h: Record<string, string> = {
      'User-Agent': BROWSER_USER_AGENT,
      Accept: kind === 'json' ? 'application/json, text/plain, */*' : kind === 'html' ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' : '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate',
    };
    // A page navigation carries no Referer; files and APIs carry the page that links them.
    if (kind !== 'html') h.Referer = referer ?? siteHome(url);
    // BSE downloads succeed with Referer + Origin of www.bseindia.com (§9 "Access").
    if (siteOf(url) === 'bseindia.com' && kind !== 'html') h.Origin = BSE_WWW;
    return h;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Cookies                                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** Minimal per-site jar (nseindia.com cookies also serve nsearchives/archives). */
class CookieJar {
  private readonly sites = new Map<string, { cookies: Map<string, string>; warmedAt?: number }>();

  private site(url: string) {
    const key = siteOf(url);
    let s = this.sites.get(key);
    if (!s) {
      s = { cookies: new Map() };
      this.sites.set(key, s);
    }
    return s;
  }

  store(url: string, headers: Headers, now: number): void {
    const list = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : splitSetCookie(headers.get('set-cookie'));
    if (!list.length) return;
    const s = this.site(url);
    for (const line of list) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let expired = false;
      for (const a of attrs) {
        const [k, v = ''] = a.split('=');
        const key = k.trim().toLowerCase();
        if (key === 'max-age' && Number(v.trim()) <= 0) expired = true;
        if (key === 'expires') {
          const t = Date.parse(v.trim());
          if (Number.isFinite(t) && t <= now) expired = true;
        }
      }
      if (expired) s.cookies.delete(name);
      else s.cookies.set(name, value);
    }
  }

  header(url: string): string | undefined {
    const s = this.sites.get(siteOf(url));
    if (!s || s.cookies.size === 0) return undefined;
    return [...s.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  count(url: string): number {
    return this.sites.get(siteOf(url))?.cookies.size ?? 0;
  }

  markWarm(url: string, now: number): void {
    this.site(url).warmedAt = now;
  }

  isFresh(url: string, now: number, ttlMs: number): boolean {
    const w = this.sites.get(siteOf(url))?.warmedAt;
    return w !== undefined && now - w < ttlMs;
  }

  clear(url: string): void {
    this.sites.delete(siteOf(url));
  }
}

/** Fallback when Headers.getSetCookie is missing: split on commas that start a new cookie. */
function splitSetCookie(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(/,(?=\s*[A-Za-z0-9_.-]+=)/).map((s) => s.trim());
}

/* ------------------------------------------------------------------------------------------ */
/* URL / content helpers                                                                        */
/* ------------------------------------------------------------------------------------------ */

function siteOf(url: string): string {
  const host = new URL(url).hostname.toLowerCase();
  return host.split('.').slice(-2).join('.');
}

function siteHome(url: string): string {
  const site = siteOf(url);
  if (site === 'nseindia.com') return `${NSE_WWW}/`;
  if (site === 'bseindia.com') return `${BSE_WWW}/`;
  return `${new URL(url).origin}/`;
}

/** The archives.nseindia.com twin of an nsearchives URL; never for fo_mktlots.csv (§1.1). */
export function legacyArchiveUrl(url: string): string | undefined {
  const u = new URL(url);
  if (u.hostname !== 'nsearchives.nseindia.com') return undefined;
  if (/fo_mktlots\.csv$/i.test(u.pathname)) return undefined;
  return `${NSE_ARCHIVES_LEGACY}${u.pathname}${u.search}`;
}

function fallbackWorthy(e: NseError): boolean {
  return e.kind === 'network' || e.kind === 'blocked' || (e.kind === 'http' && (e.httpStatus ?? 0) >= 500);
}

function fileLabel(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

function networkReason(e: unknown, timeoutMs: number): string {
  const name = (e as { name?: string })?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return `timed out after ${Math.round(timeoutMs / 1000)} s`;
  const msg = e instanceof Error ? e.message : String(e);
  const cause = (e as { cause?: { code?: string; message?: string } })?.cause;
  return cause?.code ? `${msg} (${cause.code})` : msg;
}

/** Retry-After in ms (seconds or HTTP date), or undefined. */
function retryAfterMs(raw: string | null, now: number): number | undefined {
  if (!raw) return undefined;
  const s = Number(raw.trim());
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? Math.max(0, t - now) : undefined;
}

type BodyKind = 'zip' | 'html' | 'pdf' | 'empty' | 'text';

export function isZip(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
}

function sniff(b: Uint8Array): BodyKind {
  if (b.length === 0) return 'empty';
  if (isZip(b)) return 'zip';
  const head = decodeText(b.subarray(0, 64)).trimStart();
  if (head === '') return 'empty';
  if (head.startsWith('%PDF')) return 'pdf';
  if (head.startsWith('<')) return 'html';
  return 'text';
}

function describeKind(k: BodyKind): string {
  return k === 'html' ? 'an HTML page' : k === 'pdf' ? 'a PDF' : k === 'empty' ? 'an empty body' : k === 'zip' ? 'a zip' : 'text';
}

const utf8 = new TextDecoder('utf-8');

/** UTF-8 text without a BOM. */
export function decodeText(b: Uint8Array): string {
  const s = utf8.decode(b);
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/** The CSV inside an NSE zip (one entry expected; `entry` picks among several). */
export function unzipCsv(zip: Uint8Array, entry?: RegExp, label = 'zip'): { name: string; text: string } {
  if (!isZip(zip)) throw new NseError(`${label}: not a zip file`, 'format');
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(zip, { filter: (f) => /\.csv$/i.test(f.name) });
  } catch (e) {
    throw new NseError(`${label}: corrupt zip (${e instanceof Error ? e.message : String(e)})`, 'format');
  }
  const names = Object.keys(files);
  const name = (entry && names.find((n) => entry.test(n))) ?? (names.length === 1 ? names[0] : undefined);
  if (!name) throw new NseError(`${label}: ${names.length ? `${names.length} CSV entries and none matches ${String(entry)}` : 'no CSV entry in the zip'}`, 'format');
  return { name, text: decodeText(files[name]) };
}

function startsWithHeader(text: string, header: string | RegExp): boolean {
  const head = text.replace(/^﻿/, '').replace(/^[\s"']+/, '');
  if (typeof header === 'string') return head.slice(0, header.length).toLowerCase() === header.toLowerCase();
  return header.test(head.slice(0, 512));
}

/* ------------------------------------------------------------------------------------------ */
/* CSV                                                                                          */
/* ------------------------------------------------------------------------------------------ */

/** RFC 4180 records (quoted fields, doubled quotes, CRLF or LF, BOM). Blank lines are dropped. */
export function csvRecords(text: string): string[][] {
  const out: string[][] = [];
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  while (i < n) {
    const row: string[] = [];
    for (;;) {
      let field = '';
      if (text.charCodeAt(i) === 34) {
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
        // Text after a closing quote (malformed, e.g. NSE's `""Title""` lines) is kept verbatim.
        while (i < n) {
          const c = text.charCodeAt(i);
          if (c === 44 || c === 10 || c === 13) break;
          field += text[i++];
        }
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
        if (i >= n) {
          row.push('');
          break;
        }
        continue;
      }
      if (text.charCodeAt(i) === 13) i++;
      if (text.charCodeAt(i) === 10) i++;
      break;
    }
    if (row.every((f) => f.trim() === '')) continue;
    out.push(row);
  }
  return out;
}

/** Header names are matched trimmed (spaces/tabs), whitespace-collapsed and case-insensitive. */
export function normHeader(s: string): string {
  return s.replace(/^﻿/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

const NUMERIC = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** A number from an exchange file: commas stripped; '', '-' and non-numeric → undefined. */
export function parseNum(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const s = raw.trim().replace(/,/g, '');
  if (!NUMERIC.test(s)) return undefined;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
}

/** Index of the first record holding a cell named `column` (title lines may precede the header). */
export function findHeaderRow(records: string[][], column: string, file: string, maxScan = 10): number {
  const want = normHeader(column);
  for (let i = 0; i < Math.min(records.length, maxScan); i++) {
    if (records[i].some((c) => normHeader(c) === want)) return i;
  }
  throw new NseError(`${file}: header row not found (no "${column}" column)`, 'format');
}

/** Column access by header name over parsed records. */
export class CsvTable {
  readonly rows: string[][];
  private readonly index = new Map<string, number>();

  constructor(records: string[][], headerRow: number, readonly file: string, required: readonly string[]) {
    const header = records[headerRow] ?? [];
    header.forEach((h, i) => {
      const k = normHeader(h);
      if (k && !this.index.has(k)) this.index.set(k, i);
    });
    for (const col of required) {
      if (!this.index.has(normHeader(col))) throw new NseError(`${file}: required column "${col}" is missing`, 'format');
    }
    this.rows = records.slice(headerRow + 1);
  }

  has(col: string): boolean {
    return this.index.has(normHeader(col));
  }

  /** Trimmed cell, undefined when the column is absent or the cell blank. */
  str(row: string[], col: string): string | undefined {
    const i = this.index.get(normHeader(col));
    if (i === undefined) return undefined;
    const v = (row[i] ?? '').trim();
    return v === '' ? undefined : v;
  }

  num(row: string[], col: string): number | undefined {
    return parseNum(this.str(row, col));
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Dates                                                                                        */
/* ------------------------------------------------------------------------------------------ */

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function ymdOf(y: number, m: number, d: number): string | undefined {
  if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return undefined;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return undefined;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Exchange date → 'YYYY-MM-DD'. Accepts YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, DD-Mon-YYYY, 'Mon DD, YYYY'. */
export function parseDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) return ymdOf(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) return ymdOf(+m[3], +m[2], +m[1]);
  m = /^(\d{1,2})[- ]([A-Za-z]{3,9})[- ,]+(\d{4})$/.exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    return mi < 0 ? undefined : ymdOf(+m[3], mi + 1, +m[1]);
  }
  m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(s);
  if (m) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    return mi < 0 ? undefined : ymdOf(+m[3], mi + 1, +m[2]);
  }
  return undefined;
}

/** Validates a 'YYYY-MM-DD' argument. */
export function assertYmd(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || parseDate(date) !== date) throw new TypeError(`Invalid date "${date}" (expected YYYY-MM-DD)`);
  return date;
}

/** 'YYYY-MM-DD' → 'YYYYMMDD'. */
export const ymdCompact = (date: string): string => assertYmd(date).replace(/-/g, '');

/** 'YYYY-MM-DD' → 'DDMMYYYY'. */
export const ddmmyyyy = (date: string): string => {
  const [y, m, d] = assertYmd(date).split('-');
  return `${d}${m}${y}`;
};
