/**
 * Login monitor (Model F #1): watches the Kotak Neo session every few seconds and logs in again as
 * soon as it is lost or a login failed — the moment the session's own hold allows it.
 *
 * How fast "immediately" is depends on why the login failed (the session enforces it, see
 * live/kotak/session.ts):
 *   - no answer from Kotak (DNS, refused, timeout): the request reached no account check, so the
 *     next attempt follows at once with a short back-off (5 s doubling to 1 min);
 *   - refused by Kotak (wrong TOTP/MPIN, account problem): 60 s doubling to 30 min, because
 *     repeated wrong credentials can lock the trading account; a 429 waits for Retry-After;
 *   - session lost (token expired, REST 401, feed refused the session): a new login within one check.
 * After five refusals in a row automatic logins pause (PAUSED) until "Re-login now" or a restart.
 * The proactive re-login (before the token expiry, and daily at 08:30 IST) is re-armed if missing.
 * "Re-login now" (dashboard) skips the failure back-off and the pause for one attempt, never a 429
 * hold; presses are at least 20 s apart, 2 min once Kotak has refused three logins in a row.
 */
import { istParts, type LoginMonitorState, type LoginMonitorStatus, type OpsEvent } from '@q26/core';
import type { KotakSessionStatus } from '../live/kotak/session';
import { istWhen } from '../log';
import type { OpsJournal } from './journal';

/** What the monitor needs from the live provider (LiveProvider implements it). */
export interface LoginTarget {
  credentials(): { ok: true } | { ok: false; error: string };
  /** Session status; only called when credentials are configured. */
  status(): KotakSessionStatus;
  loginPending(): boolean;
  /** The armed / running login job (nextAt = when it runs). */
  loginJob(): { running: boolean; nextAt?: number } | undefined;
  /** Arm a login at the end of any hold when not logged in and none is pending; true when armed. */
  ensureLogin(): boolean;
  /** Re-arm the proactive re-login when missing; true when it re-armed it. */
  ensureRelogin(): boolean;
  /** `fresh`: log in again even while the current session is still valid (its re-login keeps failing). */
  loginNow(opts: { force?: boolean; fresh?: boolean }): Promise<'logged-in' | 'already-logged-in' | 'in-progress'>;
  onLoginChange(fn: (s: KotakSessionStatus) => void): () => void;
}

export interface LoginMonitorOptions {
  now?: () => number;
  timers?: { setInterval(fn: () => void, ms: number): unknown; clearInterval(h: unknown): void };
  /** Default 5 s. */
  intervalMs?: number;
  /** Minimum time between two "Re-login now" presses (default 20 s). */
  manualCooldownMs?: number;
  log?: { info(m: string): void; warn(m: string): void };
}

export interface ReloginResult {
  ok: boolean;
  message: string;
}

/** Refusals in a row after which "Re-login now" presses must be 2 min apart. */
export const MANUAL_SLOW_AFTER_REJECTIONS = 3;
const SLOW_MANUAL_COOLDOWN_MS = 2 * 60_000;
/** While automatic logins are paused, one forced attempt per 15 min at most (account lock-out). */
const PAUSED_MANUAL_COOLDOWN_MS = 15 * 60_000;

/** Finished failed login attempts recorded by the session (refused + transient). */
const failedAttempts = (st: KotakSessionStatus): number => (st.loginFailures?.rejected ?? 0) + (st.loginFailures?.transient ?? 0);

export class LoginMonitor {
  readonly intervalMs: number;
  private readonly now: () => number;
  private readonly timers: NonNullable<LoginMonitorOptions['timers']>;
  private readonly manualCooldownMs: number;
  private readonly log: NonNullable<LoginMonitorOptions['log']>;
  private timer: unknown = null;
  private unsubscribe: (() => void) | null = null;
  private stopped = false;
  private lastCheckAt: number | null = null;
  private wasLoggedIn = false;
  private lastLoggedInAt: number | undefined;
  /** failedAttempts() at the last status seen: a failure is counted only when an attempt finished. */
  private seenFailures = 0;
  private consecutiveFailures = 0;
  private lastFailure: { at: number; reason: string } | undefined;
  private day = '';
  private today = { logins: 0, failures: 0, sessionLosses: 0 };
  private lastManualAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly target: LoginTarget,
    private readonly journal: OpsJournal,
    opts: LoginMonitorOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? { setInterval: (fn, ms) => setInterval(fn, ms).unref(), clearInterval: (h) => clearInterval(h as NodeJS.Timeout) };
    this.intervalMs = opts.intervalMs ?? 5_000;
    this.manualCooldownMs = opts.manualCooldownMs ?? 20_000;
    this.log = opts.log ?? { info: () => undefined, warn: () => undefined };
  }

  start(): void {
    if (this.timer !== null || this.stopped) return;
    if (this.target.credentials().ok) {
      const st = this.target.status();
      this.wasLoggedIn = st.loggedIn;
      this.lastLoggedInAt = st.loggedInAt;
      this.seenFailures = failedAttempts(st);
      this.unsubscribe = this.target.onLoginChange((s) => this.onChange(s));
    }
    this.timer = this.timers.setInterval(() => this.check(), this.intervalMs);
    this.check();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** One check: log in again when the session is lost and nothing is armed. */
  check(): void {
    if (this.stopped) return;
    this.lastCheckAt = this.now();
    this.rollDay();
    if (!this.target.credentials().ok) return;
    const st = this.target.status();
    if (st.loggedIn) {
      this.wasLoggedIn = true;
      if (this.target.ensureRelogin()) this.event('info', 'RELOGIN_REARMED', 'Proactive re-login was not armed: armed it again');
      return;
    }
    // The token expired without any session event (expiry is computed, not announced): a loss too.
    if (this.wasLoggedIn) {
      this.wasLoggedIn = false;
      this.today.sessionLosses++;
      this.event('warn', 'SESSION_LOST', `Kotak session lost: ${st.error ?? 'trade token expired'}; logging in again`);
    }
    if (this.target.ensureLogin()) {
      const at = st.loginBlockedUntil;
      this.event('info', 'LOGIN_ARMED', `Not logged in (${st.error ?? 'no session'}): ${at && at > this.now() ? `login at ${istWhen(at, this.now())}` : 'logging in now'}`);
    }
  }

  /** "Re-login now" from the dashboard. */
  async relogin(): Promise<ReloginResult> {
    const cred = this.target.credentials();
    if (!cred.ok) return { ok: false, message: `${cred.error}. Add them to .env and restart the server.` };
    const st = this.target.status();
    // Logged in and its re-logins are fine: nothing to do. Logged in but the re-login keeps failing
    // (or automatic logins are paused): log in afresh before the current token runs out.
    const fresh = st.loggedIn && (!!st.loginPaused || failedAttempts(st) > 0);
    if (st.loggedIn && !fresh) return { ok: true, message: `Already logged in to Kotak Neo${st.loggedInAt ? ` since ${istWhen(st.loggedInAt, this.now())}` : ''}` };
    const t = this.now();
    const rejected = st.loginFailures?.rejected ?? 0;
    const cooldown = st.loginPaused
      ? Math.max(this.manualCooldownMs, PAUSED_MANUAL_COOLDOWN_MS)
      : rejected >= MANUAL_SLOW_AFTER_REJECTIONS
        ? Math.max(this.manualCooldownMs, SLOW_MANUAL_COOLDOWN_MS)
        : this.manualCooldownMs;
    if (t - this.lastManualAt < cooldown) {
      const why = rejected >= MANUAL_SLOW_AFTER_REJECTIONS ? ` (Kotak refused the last ${rejected} logins: repeated wrong logins can lock the account)` : '';
      return { ok: false, message: `A re-login was requested ${Math.round((t - this.lastManualAt) / 1000)} s ago; try again in ${Math.ceil((this.lastManualAt + cooldown - t) / 1000)} s${why}` };
    }
    this.lastManualAt = t;
    this.event('info', 'MANUAL_RELOGIN', `Re-login requested from the dashboard${rejected ? ` (${rejected} refused login(s) in a row so far)` : ''}`);
    try {
      const r = await this.target.loginNow({ force: true, fresh });
      if (r === 'in-progress') return { ok: true, message: 'A login is already in progress' };
      if (r === 'already-logged-in') return { ok: true, message: 'Already logged in to Kotak Neo' };
      return { ok: true, message: 'Logged in to Kotak Neo' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const after = this.target.status().loginFailures?.rejected ?? 0;
      const hint = after >= MANUAL_SLOW_AFTER_REJECTIONS ? ' Check the NEO_* values in .env (then restart the server): repeated wrong logins can lock the Kotak account.' : '';
      return { ok: false, message: `${msg}${hint}` };
    }
  }

  status(): LoginMonitorStatus {
    this.rollDay();
    const base = {
      sessionValid: false,
      checkEveryMs: this.intervalMs,
      lastCheckAt: this.lastCheckAt,
      consecutiveFailures: this.consecutiveFailures,
      today: { ...this.today },
      events: this.journal.list({ source: 'login', limit: 20 }),
      ...(this.lastFailure ? { lastFailure: { ...this.lastFailure } } : {}),
    };
    if (this.stopped) return { state: 'STOPPED', detail: 'Login monitor stopped', ...base };
    const cred = this.target.credentials();
    if (!cred.ok) return { state: 'NO_CREDENTIALS', detail: `${cred.error}: live data and login are off`, ...base };
    const st = this.target.status();
    const t = this.now();
    base.sessionValid = st.loggedIn;
    if (st.loggedIn) {
      const until = st.tokenExpiresAt ? ` (the current session stays valid until ${istWhen(st.tokenExpiresAt, t)})` : '';
      // A paused re-login is an outage waiting for the token to run out: shown, not hidden behind LOGGED_IN.
      if (st.loginPaused) return { state: 'PAUSED', detail: `Automatic login paused: ${st.loginPaused}${until}`, ...base, ...(st.loggedInAt ? { loggedInAt: st.loggedInAt } : {}), ...(st.tokenExpiresAt ? { tokenExpiresAt: st.tokenExpiresAt } : {}) };
      const parts = [`Logged in${st.loggedInAt ? ` since ${istWhen(st.loggedInAt, t)}` : ''}`];
      if (failedAttempts(st) > 0) parts.push(`the last re-login failed (${st.loginFailures?.lastError ?? 'unknown'}): retrying${until}`);
      else if (st.nextReloginAt) parts.push(st.nextReloginAt > t ? `next scheduled re-login ${istWhen(st.nextReloginAt, t)}` : 're-login due now');
      return {
        state: 'LOGGED_IN',
        detail: parts.join('; '),
        ...base,
        ...(st.loggedInAt ? { loggedInAt: st.loggedInAt } : {}),
        ...(st.tokenExpiresAt ? { tokenExpiresAt: st.tokenExpiresAt } : {}),
        ...(st.nextReloginAt ? { nextReloginAt: st.nextReloginAt } : {}),
      };
    }
    if (st.loginPaused) return { state: 'PAUSED', detail: `Automatic login paused: ${st.loginPaused}`, ...base };
    const job = this.target.loginJob();
    const next = job?.running ? t : job?.nextAt;
    let state: LoginMonitorState;
    if (job?.running || (next !== undefined && next <= t + 1_000)) state = 'LOGGING_IN';
    else if (next !== undefined) state = 'WAITING';
    else state = 'DISCONNECTED';
    const why = st.error ?? 'no session yet';
    const detail =
      state === 'LOGGING_IN'
        ? `Logging in to Kotak Neo (last problem: ${why})`
        : state === 'WAITING'
          ? `Not logged in: ${why}. Next automatic attempt ${istWhen(next!, t)}`
          : `Not logged in: ${why}. A login is armed at the next check`;
    return { state, detail, ...base, ...(next !== undefined ? { nextAttemptAt: next } : {}) };
  }

  private onChange(st: KotakSessionStatus): void {
    this.rollDay();
    const failures = failedAttempts(st);
    // A login attempt finished and failed (the session counted it): also when the old session is still
    // valid (a failed proactive re-login). Emits without an attempt (a rejected request) are not failures.
    if (failures > this.seenFailures) {
      const reason = st.loginFailures?.lastError ?? st.error ?? 'login failed';
      this.today.failures++;
      this.consecutiveFailures++;
      this.lastFailure = { at: this.now(), reason };
      const next = st.loginBlockedUntil;
      const what = st.loginPaused ? '; automatic login PAUSED' : next ? `; next automatic attempt ${istWhen(next, this.now())}` : '';
      // A pause needs a person: level 'error' (an alert to the operator).
      this.event(st.loginPaused ? 'error' : 'warn', st.loggedIn ? 'RELOGIN_FAILED' : 'LOGIN_FAILED', `${reason}${st.loggedIn ? ' (the current session is still valid)' : ''}${what}`);
    }
    this.seenFailures = failures;
    if (st.loggedIn) {
      if (st.loggedInAt !== this.lastLoggedInAt) {
        this.today.logins++;
        this.consecutiveFailures = 0;
        this.event('info', 'LOGIN_OK', `Logged in to Kotak Neo${st.tokenExpiresAt ? `; token expires ${istWhen(st.tokenExpiresAt, this.now())}` : ''}`);
      }
      this.lastLoggedInAt = st.loggedInAt;
      this.wasLoggedIn = true;
    } else if (this.wasLoggedIn) {
      this.wasLoggedIn = false;
      this.today.sessionLosses++;
      this.event('warn', 'SESSION_LOST', `Kotak session lost: ${st.error ?? 'logged out'}; logging in again`);
      // Re-login at once (within the session's own hold), not at the next check.
      this.check();
    }
  }

  private event(level: OpsEvent['level'], type: string, message: string): void {
    this.journal.add({ source: 'login', level, type, message });
    // The session already writes its own failure line to the terminal: only the monitor's own actions here.
    if (type === 'LOGIN_ARMED' || type === 'MANUAL_RELOGIN' || type === 'RELOGIN_REARMED') this.log.info(`login monitor: ${message}`);
  }

  private rollDay(): void {
    const d = istParts(this.now()).date;
    if (d !== this.day) {
      this.day = d;
      this.today = { logins: 0, failures: 0, sessionLosses: 0 };
    }
  }
}
