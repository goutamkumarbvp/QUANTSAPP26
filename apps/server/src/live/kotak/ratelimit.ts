/**
 * One shared limiter for every Kotak REST call (DESIGN.md §1.5, critic.md C2):
 *  - 'general': ≤10 req/s, ≤300/min, ≤5000/h (the stricter of the official FAQ and the SDK defaults);
 *  - 'slow' (historical, option-chain, expiries): ≤1 call per 1.5 s, and also counted in 'general'
 *    (community reports of multi-hour 429 lockouts, kotak-rest-auth.md §5).
 * Windows are rolling (never more than N grants in any window), FIFO across lanes by arrival, and a
 * lane that waits for its spacing never blocks the other lane. A 429 pauses a lane; `abort()`
 * rejects everything queued at shutdown. Timers and clock are injectable for tests.
 */

export type Lane = 'general' | 'slow';

export interface LimiterTimers {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RateLimiterOptions {
  perSecond?: number;
  perMinute?: number;
  perHour?: number;
  /** Minimum spacing between two 'slow' calls (ms). */
  slowSpacingMs?: number;
  /** Pause applied on a 429 without a usable Retry-After (ms). */
  defaultPauseMs?: number;
  /** Upper bound for any single pause (guards against absurd Retry-After values). */
  maxPauseMs?: number;
  timers?: LimiterTimers;
}

export class RateLimitAborted extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RateLimitAborted';
  }
}

interface Waiter {
  lane: Lane;
  seq: number;
  resolve: () => void;
  reject: (e: Error) => void;
  cleanup?: () => void;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

const realTimers: LimiterTimers = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Retry-After (seconds or HTTP date) in ms, or undefined when absent/unparseable. */
export function retryAfterMs(headers: Headers | Record<string, string | undefined> | undefined, nowMs: number): number | undefined {
  if (!headers) return undefined;
  let raw: string | null | undefined;
  if (typeof (headers as Headers).get === 'function') raw = (headers as Headers).get('retry-after');
  else {
    const rec = headers as Record<string, string | undefined>;
    const k = Object.keys(rec).find((h) => h.toLowerCase() === 'retry-after');
    raw = k ? rec[k] : undefined;
  }
  if (raw == null || raw.trim() === '') return undefined;
  const v = raw.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

export interface LimiterStats {
  queued: Record<Lane, number>;
  pausedUntil: Record<Lane, number>;
  lastSecond: number;
  lastMinute: number;
  lastHour: number;
  closed: boolean;
}

export class RateLimiter {
  private readonly perSecond: number;
  private readonly perMinute: number;
  private readonly perHour: number;
  private readonly slowSpacingMs: number;
  readonly defaultPauseMs: number;
  private readonly maxPauseMs: number;
  private readonly timers: LimiterTimers;

  /** Grant times (ascending) of every call within the last hour; slow calls included. */
  private grants: number[] = [];
  private lastSlow = Number.NEGATIVE_INFINITY;
  private readonly pausedUntil: Record<Lane, number> = { general: 0, slow: 0 };
  private readonly queues: Record<Lane, Waiter[]> = { general: [], slow: [] };
  private timer: unknown = null;
  private seq = 0;
  private closed: string | null = null;

  constructor(opts: RateLimiterOptions = {}) {
    this.perSecond = opts.perSecond ?? 10;
    this.perMinute = opts.perMinute ?? 300;
    this.perHour = opts.perHour ?? 5000;
    this.slowSpacingMs = opts.slowSpacingMs ?? 1500;
    this.defaultPauseMs = opts.defaultPauseMs ?? 3000;
    this.maxPauseMs = opts.maxPauseMs ?? 6 * HOUR;
    this.timers = opts.timers ?? realTimers;
  }

  /** Resolves when the caller may send one request on `lane`. */
  acquire(lane: Lane = 'general', signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new RateLimitAborted(this.closed));
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise<void>((resolve, reject) => {
      const w: Waiter = { lane, seq: this.seq++, resolve, reject };
      if (signal) {
        const onAbort = () => {
          const q = this.queues[lane];
          const i = q.indexOf(w);
          if (i >= 0) q.splice(i, 1);
          reject(abortError(signal));
          this.pump();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        w.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      this.queues[lane].push(w);
      this.pump();
    });
  }

  /** Acquire a slot, then run `fn`. */
  async run<T>(lane: Lane, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(lane, signal);
    return fn();
  }

  /**
   * Stop granting on a lane for `ms` (429 / Retry-After). Pausing 'general' also holds 'slow',
   * because slow calls are counted against the general budget. Pauses only ever extend.
   */
  pause(lane: Lane, ms: number): void {
    const until = this.timers.now() + Math.min(Math.max(0, ms), this.maxPauseMs);
    if (until > this.pausedUntil[lane]) this.pausedUntil[lane] = until;
    this.pump();
  }

  /** Remaining pause (ms) a new request on `lane` would wait for ('general' holds both lanes). */
  pausedMs(lane: Lane = 'general'): number {
    const until = Math.max(this.pausedUntil.general, lane === 'slow' ? this.pausedUntil.slow : 0);
    return Math.max(0, until - this.timers.now());
  }

  /** Reject every queued and future request (server shutdown). */
  abort(reason = 'Kotak REST limiter shut down'): void {
    this.closed = reason;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
    for (const lane of ['general', 'slow'] as const) {
      const q = this.queues[lane].splice(0);
      for (const w of q) {
        w.cleanup?.();
        w.reject(new RateLimitAborted(reason));
      }
    }
  }

  stats(): LimiterStats {
    const t = this.timers.now();
    this.prune(t);
    const count = (w: number) => this.grants.filter((g) => g > t - w).length;
    return {
      queued: { general: this.queues.general.length, slow: this.queues.slow.length },
      pausedUntil: { ...this.pausedUntil },
      lastSecond: count(SECOND),
      lastMinute: count(MINUTE),
      lastHour: this.grants.length,
      closed: this.closed !== null,
    };
  }

  private prune(t: number) {
    let i = 0;
    while (i < this.grants.length && this.grants[i] <= t - HOUR) i++;
    if (i) this.grants = this.grants.slice(i);
  }

  /** Earliest time ≥ t at which the rolling windows admit one more grant. */
  private windowsFreeAt(t: number): number {
    let at = t;
    const n = this.grants.length;
    for (const [w, limit] of [[SECOND, this.perSecond], [MINUTE, this.perMinute], [HOUR, this.perHour]] as const) {
      if (n >= limit) {
        const g = this.grants[n - limit];
        if (g > t - w) at = Math.max(at, g + w);
      }
    }
    return at;
  }

  /** Earliest time a waiter of `lane` could be granted (ignoring other waiters). */
  private eligibleAt(lane: Lane, t: number): number {
    let at = Math.max(t, this.pausedUntil.general, this.windowsFreeAt(t));
    if (lane === 'slow') at = Math.max(at, this.pausedUntil.slow, this.lastSlow + this.slowSpacingMs);
    return at;
  }

  private pump(): void {
    if (this.closed) return;
    if (this.timer !== null) {
      this.timers.clearTimeout(this.timer);
      this.timer = null;
    }
    for (;;) {
      const t = this.timers.now();
      this.prune(t);
      let pick: Waiter | null = null;
      let next = Number.POSITIVE_INFINITY;
      for (const lane of ['general', 'slow'] as const) {
        const head = this.queues[lane][0];
        if (!head) continue;
        const at = this.eligibleAt(lane, t);
        if (at <= t) {
          if (!pick || head.seq < pick.seq) pick = head;
        } else next = Math.min(next, at);
      }
      if (!pick) {
        if (Number.isFinite(next)) this.timer = this.timers.setTimeout(() => this.pump(), Math.max(1, next - t));
        return;
      }
      this.queues[pick.lane].shift();
      this.grants.push(t);
      if (pick.lane === 'slow') this.lastSlow = t;
      pick.cleanup?.();
      pick.resolve();
    }
  }
}

function abortError(signal: AbortSignal): Error {
  const r: unknown = signal.reason;
  return r instanceof Error ? r : new RateLimitAborted('Request aborted');
}
