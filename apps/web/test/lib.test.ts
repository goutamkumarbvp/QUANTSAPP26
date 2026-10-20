import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEED_STALE_MS, type FeedStatus, type MarketClockInfo } from '@q26/core';
import { ApiError, api, errorText, isClientError, isNoLiveData, RequestTimeoutError } from '../src/lib/api';
import { feedView, STALE_TICK_MS } from '../src/lib/feed';
import * as fmt from '../src/lib/format';
import { shouldRetry } from '../src/lib/query';

/** The error a call rejects with. */
const failure = (p: Promise<unknown>): Promise<ApiError> =>
  p.then(
    () => {
      throw new Error('expected the call to fail');
    },
    (e: unknown) => e as ApiError,
  );

const NOT_AVAILABLE = [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

describe('format: a missing value is "—", never 0 / NaN / undefined', () => {
  it('every numeric formatter', () => {
    for (const x of NOT_AVAILABLE) {
      expect(fmt.formatIndian(x)).toBe('—');
      expect(fmt.formatINR(x)).toBe('—');
      expect(fmt.formatCompact(x)).toBe('—');
      expect(fmt.formatSigned(x)).toBe('—');
      expect(fmt.formatPct(x)).toBe('—');
      expect(fmt.formatPrice(x)).toBe('—');
      expect(fmt.formatFixed(x, 2, '%')).toBe('—');
      expect(fmt.formatSessionTime(x)).toBe('—');
      expect(fmt.formatDateTime(x)).toBe('—');
      expect(fmt.formatAge(x)).toBe('—');
      expect(fmt.formatAsOf(x)).toBe('—');
      expect(fmt.formatOi(x, 75, 'qty')).toBe('—');
      expect(fmt.formatOi(x, 75, 'lots')).toBe('—');
      expect(fmt.pnlClass(x)).toBe('text-muted');
    }
    expect(fmt.formatExpiry(null)).toBe('—');
    expect(fmt.formatExpiry(undefined)).toBe('—');
    expect(fmt.formatDate(null)).toBe('—');
  });

  it('a real zero is still a number', () => {
    expect(fmt.formatIndian(0)).toBe('0.00');
    expect(fmt.formatPct(0)).toBe('0.00%');
    expect(fmt.formatFixed(0, 1, 'x')).toBe('0.0x');
    expect(fmt.formatSigned(0)).toBe('0.00');
    expect(fmt.pnlClass(0)).toBe('text-muted');
  });

  it('formats real values like the core formatters', () => {
    expect(fmt.formatIndian(1234567.891)).toBe('12,34,567.89');
    expect(fmt.formatINR(-2500)).toBe('-₹2,500');
    expect(fmt.formatCompact(250_000)).toBe('2.50L');
    expect(fmt.formatPct(1.234)).toBe('+1.23%');
    expect(fmt.formatExpiry('2026-10-27')).toBe('27-Oct-26');
    expect(fmt.formatOi(7500, 75, 'lots')).toBe('100');
    expect(fmt.formatOi(7500, null, 'lots')).toBe('—');
    expect(fmt.formatOi(7500, 0, 'lots')).toBe('—');
    expect(fmt.pnlClass(5)).toBe('text-up');
    expect(fmt.pnlClass(-5)).toBe('text-down');
  });

  it('ages and "as of" stamps', () => {
    expect(fmt.formatAge(8_000)).toBe('8s');
    expect(fmt.formatAge(3 * 60_000)).toBe('3m');
    expect(fmt.formatAge(2 * 3_600_000)).toBe('2h');
    expect(fmt.formatAge(3 * 86_400_000)).toBe('3d');
    const ts = Date.UTC(2026, 9, 14, 5, 12, 5); // 10:42:05 IST
    expect(fmt.formatAsOf(ts, ts + 60_000)).toBe('10:42:05');
    expect(fmt.formatAsOf(ts, ts + 86_400_000)).toBe('yesterday 10:42');
    expect(fmt.formatAsOf(ts, ts + 5 * 86_400_000)).toBe('14 Oct 10:42');
  });
});

describe('api errors', () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (status: number, body: string, statusText = '') => vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status, statusText })));

  it('carries the server code and reason of a 503 NO_LIVE_DATA', async () => {
    respond(503, JSON.stringify({ error: 'No live NIFTY price', code: 'NO_LIVE_DATA' }));
    const e = await failure(api('/quotes'));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(503);
    expect(e.code).toBe('NO_LIVE_DATA');
    expect(e.message).toBe('No live NIFTY price');
    expect(isNoLiveData(e)).toBe(true);
    expect(isClientError(e)).toBe(false);
    expect(errorText(e)).toBe('No live NIFTY price');
  });

  it('a 4xx is a client error and not NO_LIVE_DATA', async () => {
    respond(400, JSON.stringify({ error: 'expiry is not listed' }));
    const e = await failure(api('/chain/NIFTY'));
    expect(e.code).toBeUndefined();
    expect(isNoLiveData(e)).toBe(false);
    expect(isClientError(e)).toBe(true);
  });

  it('a non-JSON error body keeps the status (proxy error page)', async () => {
    respond(502, '<html>Bad gateway</html>', 'Bad Gateway');
    const e = await failure(api('/meta'));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(502);
    expect(e.message).toBe('Bad Gateway');
    expect(isNoLiveData(e)).toBe(false);
    respond(504, '');
    expect((await failure(api('/meta'))).message).toBe('HTTP 504');
  });

  it('returns parsed JSON, and null for an empty body', async () => {
    respond(200, JSON.stringify({ quotes: [], gaps: { X: 'unknown' } }));
    expect(await api('/quotes')).toEqual({ quotes: [], gaps: { X: 'unknown' } });
    respond(200, '');
    expect(await api('/x')).toBeNull();
  });

  it('timeoutMs aborts a request the server does not answer (RequestTimeoutError); the caller\'s signal still cancels it', async () => {
    // Like fetch: never answers, rejects with an AbortError once its signal is aborted (or already is).
    const hang = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      const abort = () => reject(new DOMException('aborted', 'AbortError'));
      if (init.signal!.aborted) abort();
      else init.signal!.addEventListener('abort', abort);
    }));
    vi.stubGlobal('fetch', hang);
    const e = await failure(api('/ops', { timeoutMs: 20 }));
    expect(e).toBeInstanceOf(RequestTimeoutError);
    expect(e.message).toBe('The server did not answer within 0 s');
    expect(isClientError(e)).toBe(false); // retried like a network failure
    expect(shouldRetry(0, e)).toBe(true);

    const ctl = new AbortController();
    const p = failure(api('/ops', { signal: ctl.signal, timeoutMs: 60_000 }));
    ctl.abort();
    const cancelled = await p;
    expect(cancelled).not.toBeInstanceOf(RequestTimeoutError);
    expect((cancelled as unknown as DOMException).name).toBe('AbortError');

    // Already aborted: no request goes unanswered.
    const done = new AbortController();
    done.abort();
    expect(await failure(api('/ops', { signal: done.signal, timeoutMs: 60_000 }))).not.toBeInstanceOf(RequestTimeoutError);
  });

  it('without timeoutMs the caller\'s signal is passed as is; an answer in time clears the timer', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const ctl = new AbortController();
    await api('/x', { signal: ctl.signal });
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(ctl.signal);
    vi.useFakeTimers();
    try {
      expect(await api('/x', { timeoutMs: 10_000 })).toEqual({ ok: true });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('isNoLiveData is false for anything that is not an ApiError', () => {
    expect(isNoLiveData(new Error('NO_LIVE_DATA'))).toBe(false);
    expect(isNoLiveData(null)).toBe(false);
    expect(isNoLiveData({ code: 'NO_LIVE_DATA' })).toBe(false);
  });
});

describe('query retry policy', () => {
  it('never retries NO_LIVE_DATA or a 4xx', () => {
    expect(shouldRetry(0, new ApiError('no data', 503, 'NO_LIVE_DATA'))).toBe(false);
    expect(shouldRetry(0, new ApiError('bad', 400))).toBe(false);
    expect(shouldRetry(0, new ApiError('unauthorised', 401))).toBe(false);
    expect(shouldRetry(0, new ApiError('missing', 404))).toBe(false);
  });
  it('retries a network error or a plain 5xx once', () => {
    expect(shouldRetry(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetry(1, new TypeError('Failed to fetch'))).toBe(false);
    expect(shouldRetry(0, new ApiError('boom', 500))).toBe(true);
    expect(shouldRetry(0, new ApiError('unavailable', 503))).toBe(true); // a 503 without the NO_LIVE_DATA code is an outage
  });
});

describe('feed state (clock chip)', () => {
  const feed = (over: Partial<FeedStatus> = {}): FeedStatus => ({
    loggedIn: true, connected: true, lastTickTs: 1_000_000, subscribed: 800, refdataReady: true, recordingSince: '2026-10-13',
    eod: { fo: null, cm: null, index: null, participants: null, fiidii: null }, ...over,
  });
  const clock = (over: Partial<MarketClockInfo> = {}, f?: Partial<FeedStatus> | null): MarketClockInfo => ({
    ts: 1_005_000, date: '2026-10-19', time: '10:00:00', status: 'open', sessionMinute: 45, ...(f === null ? {} : { feed: feed(f) }), ...over,
  });

  it('CONNECTING before the first status, OFFLINE when the browser lost the server', () => {
    expect(feedView(null, false).state).toBe('CONNECTING');
    expect(feedView(null, true).state).toBe('CONNECTING');
    const lost = feedView(clock(), false);
    expect(lost.state).toBe('OFFLINE');
    expect(lost.reason).toMatch(/connection to the server lost/i);
  });

  it('LIVE with recent ticks', () => {
    const v = feedView(clock(), true);
    expect(v.state).toBe('LIVE');
    expect(v.stale).toBe(false);
    expect(v.lastTickAgeMs).toBe(5000);
    expect(v.reason).toMatch(/receiving live ticks/i);
  });

  it('uses the server\'s one stale-feed threshold (FEED_STALE_MS)', () => {
    expect(STALE_TICK_MS).toBe(FEED_STALE_MS);
    expect(feedView(clock({ ts: 1_000_000 + FEED_STALE_MS }), true).stale).toBe(false);
    expect(feedView(clock({ ts: 1_000_000 + FEED_STALE_MS + 1 }), true).stale).toBe(true);
  });

  it('flags a connected feed without recent ticks while the market is open (not outside the session)', () => {
    const old = feedView(clock({ ts: 1_000_000 + STALE_TICK_MS + 1 }), true);
    expect(old.state).toBe('LIVE');
    expect(old.stale).toBe(true);
    expect(old.reason).toMatch(/last live tick was 1m ago/);
    expect(feedView(clock({}, { lastTickTs: null }), true).stale).toBe(true);
    expect(feedView(clock({ ts: 1_000_000 + 10 * STALE_TICK_MS, status: 'closed' }), true).stale).toBe(false);
  });

  it('shows the login / socket error as the reason when the feed is down', () => {
    const down = feedView(clock({}, { loggedIn: false, connected: false, error: 'Kotak TOTP login failed: invalid code' }), true);
    expect(down.state).toBe('OFFLINE');
    expect(down.reason).toBe('Kotak TOTP login failed: invalid code');
    expect(feedView(clock({}, { loggedIn: false, connected: false }), true)).toMatchObject({ state: 'CONNECTING', reason: 'Logging in to Kotak Neo…' });
    expect(feedView(clock({}, { loggedIn: true, connected: false }), true).state).toBe('CONNECTING');
    expect(feedView(clock({}, null), true).state).toBe('CONNECTING');
  });
});
