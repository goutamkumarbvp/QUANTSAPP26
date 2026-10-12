import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitAborted, RateLimiter, retryAfterMs, type Lane } from '../../src/live/kotak/ratelimit';

/** Queue `n` acquisitions and record the (fake) time each one is granted. */
function track(l: RateLimiter, lane: Lane, n: number, grants: { lane: Lane; t: number }[]) {
  return Array.from({ length: n }, () => l.acquire(lane).then(() => void grants.push({ lane, t: Date.now() })));
}

describe('RateLimiter', () => {
  const T0 = Date.UTC(2026, 9, 12, 4, 0, 0);
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => vi.useRealTimers());

  it('allows at most 10 per rolling second', async () => {
    const l = new RateLimiter();
    const grants: { lane: Lane; t: number }[] = [];
    const all = track(l, 'general', 25, grants);
    await vi.advanceTimersByTimeAsync(0);
    expect(grants.length).toBe(10);
    await vi.advanceTimersByTimeAsync(999);
    expect(grants.length).toBe(10);
    await vi.advanceTimersByTimeAsync(1);
    expect(grants.length).toBe(20);
    await vi.advanceTimersByTimeAsync(1000);
    await Promise.all(all);
    expect(grants.map((g) => g.t - T0)).toEqual([...Array(10).fill(0), ...Array(10).fill(1000), ...Array(5).fill(2000)]);
  });

  it('enforces the per-minute and per-hour budgets', async () => {
    const l = new RateLimiter({ perSecond: 1000, perMinute: 300, perHour: 400 });
    const grants: { lane: Lane; t: number }[] = [];
    void track(l, 'general', 450, grants);
    await vi.advanceTimersByTimeAsync(0);
    expect(grants.length).toBe(300);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(grants.length).toBe(300);
    await vi.advanceTimersByTimeAsync(1);
    expect(grants.length).toBe(400); // hourly cap reached
    await vi.advanceTimersByTimeAsync(60 * 60_000 - 60_001);
    expect(grants.length).toBe(400);
    await vi.advanceTimersByTimeAsync(1);
    expect(grants.length).toBe(450);
    expect(l.stats().lastHour).toBe(150); // the 300 grants at t=0 left the hour window; 100 (t=60 s) + 50 remain
  });

  it("spaces 'slow' calls 1.5 s apart and counts them in 'general'", async () => {
    const l = new RateLimiter();
    const grants: { lane: Lane; t: number }[] = [];
    const slow = track(l, 'slow', 3, grants);
    const general = track(l, 'general', 10, grants);
    await vi.advanceTimersByTimeAsync(0);
    // 1 slow + 9 general fill the first second; the slow lane never blocks general calls.
    expect(grants.filter((g) => g.lane === 'slow').length).toBe(1);
    expect(grants.filter((g) => g.lane === 'general').length).toBe(9);
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([...slow, ...general]);
    expect(grants.filter((g) => g.lane === 'slow').map((g) => g.t - T0)).toEqual([0, 1500, 3000]);
    expect(grants.filter((g) => g.lane === 'general').map((g) => g.t - T0)).toEqual([...Array(9).fill(0), 1000]);
  });

  it('grants the oldest eligible request first across lanes', async () => {
    const l = new RateLimiter({ perSecond: 1 });
    const order: string[] = [];
    const a = l.acquire('general').then(() => order.push('g1'));
    const b = l.acquire('slow').then(() => order.push('s1'));
    const c = l.acquire('general').then(() => order.push('g2'));
    await vi.advanceTimersByTimeAsync(3000);
    await Promise.all([a, b, c]);
    expect(order).toEqual(['g1', 's1', 'g2']);
  });

  it('pauses a lane for Retry-After; a general pause also holds the slow lane', async () => {
    const l = new RateLimiter();
    const grants: { lane: Lane; t: number }[] = [];
    l.pause('slow', retryAfterMs({ 'Retry-After': '4' }, Date.now())!);
    const s = track(l, 'slow', 1, grants);
    const g = track(l, 'general', 1, grants);
    await vi.advanceTimersByTimeAsync(0);
    expect(grants.map((x) => x.lane)).toEqual(['general']);
    await vi.advanceTimersByTimeAsync(4000);
    await Promise.all(s);
    expect(grants.at(-1)).toEqual({ lane: 'slow', t: T0 + 4000 });

    l.pause('general', 2000);
    const s2 = track(l, 'slow', 1, grants);
    const g2 = track(l, 'general', 1, grants);
    await vi.advanceTimersByTimeAsync(1999);
    expect(grants.length).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([...g, ...g2, ...s2]);
    expect(grants.slice(2).map((x) => x.t - T0)).toEqual([6000, 6000]);
  });

  it('parses Retry-After as seconds or an HTTP date', () => {
    const now = Date.UTC(2026, 9, 12, 4, 0, 0);
    expect(retryAfterMs(new Headers({ 'retry-after': '3' }), now)).toBe(3000);
    expect(retryAfterMs({ 'RETRY-AFTER': '1.5' }, now)).toBe(1500);
    expect(retryAfterMs(new Headers({ 'retry-after': new Date(now + 10_000).toUTCString() }), now)).toBe(10_000);
    expect(retryAfterMs(new Headers({}), now)).toBeUndefined();
    expect(retryAfterMs({ 'retry-after': 'soon' }, now)).toBeUndefined();
  });

  it('abort() rejects queued and future requests; an AbortSignal removes one waiter', async () => {
    const l = new RateLimiter({ perSecond: 1 });
    await l.acquire('general');
    const ac = new AbortController();
    const cancelled = l.acquire('general', ac.signal);
    const queued = l.acquire('slow');
    ac.abort(new Error('client went away'));
    await expect(cancelled).rejects.toThrow('client went away');
    expect(l.stats().queued).toEqual({ general: 0, slow: 1 });
    l.abort('shutting down');
    await expect(queued).rejects.toBeInstanceOf(RateLimitAborted);
    await expect(l.acquire('general')).rejects.toThrow('shutting down');
    expect(vi.getTimerCount()).toBe(0);
  });
});
