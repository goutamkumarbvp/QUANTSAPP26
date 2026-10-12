/**
 * Kotak Neo Trade API v2 session: TOTP login → MPIN validate, then every REST call on the
 * per-account `baseUrl` with the header set of its call class (kotak-rest-auth.md §1–§2,
 * official authentication.md, troubleshooting.md Q3/Q7/Q8, critic.md C10/C12/C16).
 *
 * Secrets (consumer key, MPIN, TOTP secret, tokens, sids) never reach logs, errors or status().
 * Re-login policy: on 401/403/stCode 1003 one re-login with a NEW TOTP window, then one retry;
 * never a loop. Failed logins back off (60 s doubling to 30 min; a 429 holds for Retry-After, or
 * 5 min without one).
 */
import type { NeoEnv } from '../env';
import { scrubSecrets } from '../env';
import { NoLiveData } from '../types';
import { RateLimiter, retryAfterMs, type Lane } from './ratelimit';
import { freshTotp } from './totp';

export const KOTAK_LOGIN_URL = 'https://mis.kotaksecurities.com/login/1.0/';
/** SDK fallback when validate returns no baseUrl (NeoUtility.get_domain(), kotak-rest-auth.md §2). */
export const KOTAK_DEFAULT_BASE_URL = 'https://mis.kotaksecurities.com';
export const NEO_FIN_KEY = 'neotradeapi';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface KotakLogger {
  info(msg: string): void;
  warn(msg: string): void;
}

const noopLogger: KotakLogger = { info: () => {}, warn: () => {} };

export type KotakErrorKind = 'auth' | 'login' | 'not-logged-in' | 'rate-limit' | 'api' | 'network' | 'protocol';

/** A Kotak call that produced no data. It is a NoLiveData (HTTP 503 with the reason). */
export class KotakError extends NoLiveData {
  constructor(
    reason: string,
    readonly kind: KotakErrorKind,
    readonly httpStatus?: number,
    readonly stCode?: number,
    readonly retryAfterMs?: number,
  ) {
    super(reason);
    this.name = 'KotakError';
  }
}

export interface KotakSessionDeps {
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  limiter?: RateLimiter;
  logger?: KotakLogger;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  /** Daily proactive re-login time, minutes after IST midnight (default 08:30, before pre-open). */
  dailyReloginIstMinute?: number;
  /** Minimum gap between two re-logins triggered by a rejected session (ms). */
  authReloginCooldownMs?: number;
  /** A 429 whose pause is at most this long is retried once inline (ms). */
  maxInlineRetryWaitMs?: number;
}

export interface KotakRequestOptions {
  /** 'market' = quotes/scrip master/option-chain/expiries/historical (Authorization only);
   *  'session' = orders/reports/portfolio/limits (Auth + Sid + neo-fin-key). */
  kind: 'market' | 'session';
  method?: 'GET' | 'POST';
  query?: Record<string, string | number | undefined>;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  lane?: Lane;
  signal?: AbortSignal;
}

export interface KotakSessionStatus {
  loggedIn: boolean;
  error?: string;
  baseUrl?: string;
  baseUrlSource?: 'validate' | 'default';
  dataCenter?: string;
  loggedInAt?: number;
  /** JWT `exp` of the trade token (ms) when the token carries one. */
  tokenExpiresAt?: number;
  nextReloginAt?: number;
  /** Automatic logins are held until this time after failures / 429. */
  loginBlockedUntil?: number;
  feedUrlKnown: boolean;
  /** Last X-RateLimit-* / Retry-After headers seen (for checking the real quotas). */
  rateLimitHeaders?: Record<string, string>;
}

/** What the SFeed client needs. Carries secrets: never log or return it from an API. */
export interface FeedCredentials {
  /** UCC (the websocket `user`). */
  user: string;
  /** Trade session sid (the websocket `auth`, websocket.md §3). */
  sid: string;
  token: string;
  baseUrl: string;
  feedUrl?: string;
  rtUrl?: string;
  generation: number;
}

interface ActiveSession {
  token: string;
  sid: string;
  baseUrl: string;
  baseUrlSource: 'validate' | 'default';
  feedUrl?: string;
  rtUrl?: string;
  dataCenter?: string;
  loggedInAt: number;
  expiresAt?: number;
  generation: number;
}

type Json = Record<string, unknown>;

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const IST_OFFSET_MS = 330 * MINUTE;
const RATE_HEADERS = ['retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];

/** Joins baseUrl (which may carry a path prefix, critic.md C12) and a path with exactly one '/'. */
export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

/** Query string; '|' stays literal (documented for neosymbol), everything else percent-encoded. */
export function buildQuery(query: Record<string, string | number | undefined> | undefined): string {
  if (!query) return '';
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v)).replace(/%7C/gi, '|')}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Payload of a JWT without verifying it (only to read `exp`). */
export function decodeJwtPayload(token: string): Json | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const v: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}

/** First time strictly after `after` at which the IST wall clock shows `minuteOfDay`. */
export function nextIstTime(after: number, minuteOfDay: number): number {
  const istDayStart = Math.floor((after + IST_OFFSET_MS) / DAY) * DAY;
  let t = istDayStart + minuteOfDay * MINUTE - IST_OFFSET_MS;
  if (t <= after) t += DAY;
  return t;
}

const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined);

function parseJson(text: string): unknown {
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Best-effort error text from any of Kotak's error envelopes (critic.md R14). */
export function kotakErrorMessage(body: unknown): string | undefined {
  if (!isObj(body)) return undefined;
  const errArr = Array.isArray(body.error) ? body.error : undefined;
  const first = errArr?.find(isObj);
  const fault = isObj(body.fault) ? body.fault : undefined;
  const data = isObj(body.data) ? body.data : undefined;
  return (
    str(body.emsg) ??
    str(body.message) ??
    (first ? str(first.message) : undefined) ??
    (fault ? str(fault.message) : undefined) ??
    str(body.errMsg) ??
    str(body['Error Message']) ??
    (typeof body.error === 'string' ? str(body.error) : undefined) ??
    (data ? str(data.message) ?? str(data.emsg) : undefined)
  );
}

function stCodeOf(body: unknown): number | undefined {
  if (!isObj(body)) return undefined;
  const n = Number(body.stCode);
  return Number.isFinite(n) ? n : undefined;
}

/** 2xx bodies that still report an error (`stat: Not_Ok`, `status: ERROR`, `error: [...]`). */
function isErrorBody(body: unknown): boolean {
  if (!isObj(body)) return false;
  if (typeof body.stat === 'string' && body.stat.toLowerCase() === 'not_ok') return true;
  if (typeof body.status === 'string' && body.status.toLowerCase() === 'error') return true;
  if (Array.isArray(body.error) && body.error.length > 0) return true;
  return false;
}

export class KotakSession {
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  readonly limiter: RateLimiter;
  private readonly log: KotakLogger;
  private readonly timeoutMs: number;
  private readonly dailyReloginMinute: number;
  private readonly authReloginCooldownMs: number;
  private readonly maxInlineRetryWaitMs: number;

  private session: ActiveSession | null = null;
  private generation = 0;
  private loginInFlight: Promise<void> | null = null;
  private lastTotpCounter: number | undefined;
  private failures = 0;
  private blockedUntil = 0;
  /** The last login failure was a 429 (its hold cannot be skipped with `force`). */
  private lastWasRateLimited = false;
  private lastError: string | undefined;
  private lastAuthRelogin = Number.NEGATIVE_INFINITY;
  private rateHeaders: Record<string, string> | undefined;
  private readonly listeners = new Set<(s: KotakSessionStatus) => void>();

  constructor(
    private readonly creds: NeoEnv,
    deps: KotakSessionDeps = {},
  ) {
    this.fetchFn = deps.fetch ?? ((url, init) => fetch(url, init));
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.limiter = deps.limiter ?? new RateLimiter();
    this.log = deps.logger ?? noopLogger;
    this.timeoutMs = deps.timeoutMs ?? 15_000;
    this.dailyReloginMinute = deps.dailyReloginIstMinute ?? 8 * 60 + 30;
    this.authReloginCooldownMs = deps.authReloginCooldownMs ?? 5 * MINUTE;
    this.maxInlineRetryWaitMs = deps.maxInlineRetryWaitMs ?? 5_000;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Login                                                                                     */
  /* ---------------------------------------------------------------------------------------- */

  /**
   * One TOTP login + MPIN validate attempt (shared by concurrent callers). Throws KotakError
   * kind 'login' on failure, or immediately while automatic logins are blocked after failures
   * (`force` skips the failure back-off but never a 429 back-off), and kind 'rate-limit' while
   * the shared limiter is paused for longer than `maxInlineRetryWaitMs`.
   */
  login(opts: { force?: boolean } = {}): Promise<void> {
    if (this.loginInFlight) return this.loginInFlight;
    const t = this.now();
    if (t < this.blockedUntil && (!opts.force || this.lastWasRateLimited)) {
      return Promise.reject(
        new KotakError(`Kotak login on hold until ${new Date(this.blockedUntil).toISOString()} after: ${this.lastError ?? 'previous failure'}`, 'login'),
      );
    }
    // A long 429 pause would otherwise park the login (and every caller waiting on it) for hours.
    const held = this.limiter.pausedMs('general');
    if (held > this.maxInlineRetryWaitMs) {
      return Promise.reject(new KotakError(`Kotak login held for ${Math.ceil(held / 1000)} s: Kotak REST is paused after a rate limit`, 'rate-limit', undefined, undefined, held));
    }
    this.loginInFlight = this.doLogin().finally(() => {
      this.loginInFlight = null;
    });
    return this.loginInFlight;
  }

  private async doLogin(): Promise<void> {
    try {
      // A fresh code from a window never used before (a rejected session must not reuse it).
      const { code, counter } = await freshTotp(this.creds.totpSecret, { now: this.now, sleep: this.sleep }, { afterCounter: this.lastTotpCounter });
      this.lastTotpCounter = counter;

      const view = await this.loginStep(
        'tradeApiLogin',
        { Authorization: this.creds.consumerKey, 'neo-fin-key': NEO_FIN_KEY, 'Content-Type': 'application/json' },
        { mobileNumber: this.creds.mobileNumber, ucc: this.creds.ucc, totp: code },
      );
      const trade = await this.loginStep(
        'tradeApiValidate',
        {
          Authorization: this.creds.consumerKey,
          'neo-fin-key': NEO_FIN_KEY,
          sid: view.sid as string,
          Auth: view.token as string,
          'Content-Type': 'application/json',
        },
        { mpin: this.creds.mpin },
      );

      let baseUrl = str(trade.baseUrl);
      let baseUrlSource: ActiveSession['baseUrlSource'] = 'validate';
      if (!baseUrl || !/^https:\/\//i.test(baseUrl)) {
        this.log.warn(`Kotak validate returned ${baseUrl ? 'a non-https' : 'no'} baseUrl; using ${KOTAK_DEFAULT_BASE_URL}`);
        baseUrl = KOTAK_DEFAULT_BASE_URL;
        baseUrlSource = 'default';
      }
      const token = trade.token as string;
      const exp = Number(decodeJwtPayload(token)?.exp);
      const t = this.now();
      this.session = {
        token,
        sid: trade.sid as string,
        baseUrl: baseUrl.replace(/\/+$/, ''),
        baseUrlSource,
        feedUrl: str(trade.feedUrl),
        rtUrl: str(trade.rtUrl),
        dataCenter: str(trade.dataCenter),
        loggedInAt: t,
        expiresAt: Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined,
        generation: ++this.generation,
      };
      this.failures = 0;
      this.blockedUntil = 0;
      this.lastError = undefined;
      this.lastWasRateLimited = false;
      const s = this.session;
      this.log.info(
        `Kotak Neo logged in (data centre ${s.dataCenter ?? '?'}, baseUrl ${s.baseUrl}${s.expiresAt ? `, token expires ${new Date(s.expiresAt).toISOString()}` : ''})`,
      );
    } catch (e) {
      const err = e instanceof KotakError ? e : new KotakError(`Kotak login failed: ${this.scrub(e instanceof Error ? e.message : String(e))}`, 'login');
      this.failures++;
      const t = this.now();
      let hold = Math.min(30 * MINUTE, MINUTE * 2 ** (this.failures - 1));
      this.lastWasRateLimited = err.httpStatus === 429;
      if (this.lastWasRateLimited) hold = Math.max(hold, err.retryAfterMs ?? 5 * MINUTE);
      this.blockedUntil = t + hold;
      this.lastError = err.message;
      this.log.warn(`${err.message}; next automatic login not before ${new Date(this.blockedUntil).toISOString()}`);
      throw err;
    } finally {
      this.emit();
    }
  }

  private async loginStep(step: 'tradeApiLogin' | 'tradeApiValidate', headers: Record<string, string>, body: Json): Promise<Json> {
    const label = step === 'tradeApiLogin' ? 'TOTP login' : 'MPIN validate';
    await this.limiter.acquire('general');
    let res: Response;
    try {
      res = await this.fetchFn(`${KOTAK_LOGIN_URL}${step}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new KotakError(`Kotak ${label} failed: network error (${this.scrub(e instanceof Error ? e.message : String(e))})`, 'login');
    }
    this.noteRateHeaders(res.headers);
    const parsed = parseJson(await res.text());
    if (res.status === 429) {
      throw new KotakError(`Kotak ${label} rate-limited (HTTP 429)`, 'login', 429, undefined, retryAfterMs(res.headers, this.now()));
    }
    // A 2xx can still carry an error body with no `data` (kotak-rest-auth.md §1.2).
    const data = isObj(parsed) && isObj(parsed.data) ? parsed.data : undefined;
    if (res.ok && data && str(data.token) && str(data.sid)) return data;
    const msg = this.scrub(kotakErrorMessage(parsed) ?? (res.ok ? 'response has no token/sid' : `HTTP ${res.status}`));
    throw new KotakError(`Kotak ${label} failed: ${msg} (HTTP ${res.status})`, 'login', res.status, stCodeOf(parsed));
  }

  /** Forget the session locally (Kotak v2 has no server-side logout call). */
  logout(): void {
    this.session = null;
    this.emit();
  }

  /** Mark the session dead (e.g. the feed reported auth failure); the next request re-logs in. */
  invalidate(reason: string): void {
    if (!this.session) return;
    this.session = null;
    this.lastError = this.scrub(reason);
    this.emit();
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Proactive re-login                                                                        */
  /* ---------------------------------------------------------------------------------------- */

  /** When the current session should be replaced: min(token exp − 5 min, next 08:30 IST). */
  nextReloginAt(): number | null {
    const s = this.session;
    if (!s) return null;
    let at = nextIstTime(s.loggedInAt, this.dailyReloginMinute);
    // Ignore an `exp` too close to the login time to schedule on (avoids a re-login storm).
    if (s.expiresAt !== undefined && s.expiresAt - 5 * MINUTE > s.loggedInAt + MINUTE) at = Math.min(at, s.expiresAt - 5 * MINUTE);
    return at;
  }

  reloginDue(now = this.now()): boolean {
    const at = this.nextReloginAt();
    return at !== null && now >= at;
  }

  /** Logs in again when due; returns whether it did. The provider schedules the calls. */
  async refreshIfDue(): Promise<boolean> {
    if (!this.reloginDue()) return false;
    await this.login();
    return true;
  }

  /* ---------------------------------------------------------------------------------------- */
  /* Requests                                                                                  */
  /* ---------------------------------------------------------------------------------------- */

  /** JSON of a REST call on baseUrl. Throws KotakError (a NoLiveData) when no data was obtained. */
  async request<T = unknown>(path: string, opts: KotakRequestOptions): Promise<T> {
    const used = await this.ensureSession();
    try {
      return await this.send<T>(used, path, opts);
    } catch (e) {
      if (!(e instanceof KotakError) || e.kind !== 'auth') throw e;
      const fresh = await this.recover(used, e);
      try {
        return await this.send<T>(fresh, path, opts);
      } catch (e2) {
        // Rejected again on a fresh session: one re-login, one retry, never a loop. Drop the
        // session and hold automatic logins so later requests fail fast without network calls.
        if (e2 instanceof KotakError && e2.kind === 'auth') this.rejectedAgain(fresh, e2);
        throw e2;
      }
    }
  }

  private rejectedAgain(s: ActiveSession, cause: KotakError) {
    if (this.session === s) this.session = null;
    this.lastError = `${cause.message} (again after a fresh login)`;
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + this.authReloginCooldownMs);
    this.emit();
  }

  private async ensureSession(): Promise<ActiveSession> {
    const s = this.session;
    if (s && (s.expiresAt === undefined || this.now() < s.expiresAt)) return s;
    if (s) {
      this.session = null;
      this.lastError = 'Kotak trade token expired';
    }
    if (!this.loginInFlight && this.now() < this.blockedUntil) {
      throw new KotakError(`Not logged in to Kotak Neo: ${this.lastError ?? 'login on hold'}`, 'not-logged-in');
    }
    await this.login();
    if (!this.session) throw new KotakError(`Not logged in to Kotak Neo: ${this.lastError ?? 'unknown error'}`, 'not-logged-in');
    return this.session;
  }

  private async recover(used: ActiveSession, cause: KotakError): Promise<ActiveSession> {
    // Someone already logged in again after this request was sent: just retry on that session.
    if (this.session && this.session.generation > used.generation) return this.session;
    if (this.loginInFlight) {
      await this.loginInFlight;
      if (this.session) return this.session;
    }
    const t = this.now();
    this.session = null;
    if (t - this.lastAuthRelogin < this.authReloginCooldownMs) {
      // Rejected again soon after an auth-triggered login: stop and hold automatic logins.
      this.lastError = `${cause.message} (again after a fresh login)`;
      this.blockedUntil = Math.max(this.blockedUntil, this.lastAuthRelogin + this.authReloginCooldownMs);
      this.emit();
      throw cause;
    }
    this.lastAuthRelogin = t;
    this.log.warn(`${cause.message}; logging in again`);
    await this.login();
    if (!this.session) throw cause;
    return this.session;
  }

  private async send<T>(s: ActiveSession, path: string, opts: KotakRequestOptions): Promise<T> {
    const url = joinUrl(s.baseUrl, path) + buildQuery(opts.query);
    const label = path.split('?')[0].replace(/^\/+/, '').slice(0, 80);
    const headers: Record<string, string> =
      opts.kind === 'market'
        ? { Authorization: this.creds.consumerKey }
        : { Auth: s.token, Sid: s.sid, 'neo-fin-key': NEO_FIN_KEY, accept: 'application/json' };
    Object.assign(headers, opts.headers);
    const lane = opts.lane ?? 'general';

    for (let attempt = 0; ; attempt++) {
      // Fail fast while a 429 holds the lane for long (multi-hour lockouts, kotak-rest-auth.md §5):
      // queuing would hang callers for the whole pause and release a burst of stale calls after it.
      const held = this.limiter.pausedMs(lane);
      if (held > this.maxInlineRetryWaitMs) {
        throw new KotakError(`Kotak rate limit on ${label}; paused ${Math.ceil(held / 1000)} s`, 'rate-limit', undefined, undefined, held);
      }
      await this.limiter.acquire(lane, opts.signal);
      let res: Response;
      let text: string;
      try {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        res = await this.fetchFn(url, {
          method: opts.method ?? 'GET',
          headers,
          body: opts.body,
          // AbortSignal.any needs Node ≥ 20.3; without it the caller's signal still stops the queue wait.
          signal: opts.signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([opts.signal, timeout]) : timeout,
        });
        // The body read can still time out or be cut off: that is a network error too, not a crash.
        text = await res.text();
      } catch (e) {
        throw new KotakError(`Kotak ${label}: network error (${this.scrub(e instanceof Error ? e.message : String(e))})`, 'network');
      }
      this.noteRateHeaders(res.headers);
      const body = parseJson(text);
      const stCode = stCodeOf(body);
      const msg = () => this.scrub(kotakErrorMessage(body) ?? `HTTP ${res.status}`);

      if (res.status === 429 || stCode === 429 || (isObj(body) && Number(body.code) === 429)) {
        const wait = retryAfterMs(res.headers, this.now()) ?? this.limiter.defaultPauseMs;
        this.limiter.pause(lane, wait);
        if (attempt === 0 && wait <= this.maxInlineRetryWaitMs) continue;
        throw new KotakError(`Kotak rate limit on ${label}; paused ${Math.ceil(wait / 1000)} s`, 'rate-limit', 429, stCode, wait);
      }
      if (res.status === 401 || res.status === 403 || stCode === 1003) {
        throw new KotakError(`Kotak session rejected on ${label}: ${msg()}`, 'auth', res.status, stCode);
      }
      if (!res.ok) throw new KotakError(`Kotak ${label} failed: ${msg()} (HTTP ${res.status})`, 'api', res.status, stCode);
      if (body === undefined) throw new KotakError(`Kotak ${label}: response is not JSON`, 'protocol', res.status);
      if (isErrorBody(body)) throw new KotakError(`Kotak ${label} failed: ${msg()}${stCode !== undefined ? ` (stCode ${stCode})` : ''}`, 'api', res.status, stCode);
      return body as T;
    }
  }

  /* ---------------------------------------------------------------------------------------- */
  /* State                                                                                     */
  /* ---------------------------------------------------------------------------------------- */

  status(): KotakSessionStatus {
    const s = this.session;
    const live = !!s && (s.expiresAt === undefined || this.now() < s.expiresAt);
    return {
      loggedIn: live,
      ...(this.lastError && !live ? { error: this.lastError } : {}),
      ...(s ? { baseUrl: s.baseUrl, baseUrlSource: s.baseUrlSource, dataCenter: s.dataCenter, loggedInAt: s.loggedInAt, tokenExpiresAt: s.expiresAt } : {}),
      ...(s ? { nextReloginAt: this.nextReloginAt() ?? undefined } : {}),
      ...(this.blockedUntil > this.now() ? { loginBlockedUntil: this.blockedUntil } : {}),
      feedUrlKnown: !!s?.feedUrl,
      ...(this.rateHeaders ? { rateLimitHeaders: { ...this.rateHeaders } } : {}),
    };
  }

  /** Credentials for the market-data websocket, or null when not logged in. Contains secrets. */
  feedCredentials(): FeedCredentials | null {
    const s = this.session;
    if (!s) return null;
    return { user: this.creds.ucc, sid: s.sid, token: s.token, baseUrl: s.baseUrl, feedUrl: s.feedUrl, rtUrl: s.rtUrl, generation: s.generation };
  }

  /** Called after every login attempt / logout / invalidation with the new status. */
  onChange(fn: (s: KotakSessionStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    const st = this.status();
    for (const fn of this.listeners) {
      try {
        fn(st);
      } catch {
        /* a listener must not break the session */
      }
    }
  }

  private noteRateHeaders(h: Headers) {
    const seen: Record<string, string> = {};
    for (const k of RATE_HEADERS) {
      const v = h.get(k);
      if (v !== null) seen[k] = v;
    }
    if (!Object.keys(seen).length) return;
    if (!this.rateHeaders) this.log.info(`Kotak rate-limit headers: ${JSON.stringify(seen)}`);
    this.rateHeaders = seen;
  }

  private scrub(text: string): string {
    const s = this.session;
    // The UCC is a credential too (DESIGN.md §1.4); servers may echo the mobile without its +91.
    const national = this.creds.mobileNumber.startsWith('+91') ? this.creds.mobileNumber.slice(3) : undefined;
    return scrubSecrets(text, [this.creds.consumerKey, this.creds.totpSecret, this.creds.mpin, this.creds.mobileNumber, national, this.creds.ucc, s?.token, s?.sid]);
  }
}
