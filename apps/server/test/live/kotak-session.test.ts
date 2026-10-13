import { describe, expect, it } from 'vitest';
import { NoLiveData } from '../../src/live/types';
import { RateLimiter, type LimiterTimers } from '../../src/live/kotak/ratelimit';
import { KotakError, KotakSession, buildQuery, decodeJwtPayload, joinUrl, nextIstTime, type KotakSessionDeps } from '../../src/live/kotak/session';
import { totp, totpCounter } from '../../src/live/kotak/totp';
import {
  CREDS,
  INVALID_SESSION,
  LOGIN_ERROR,
  LOGIN_MISSING_FIELD,
  QUOTE_EQUITY,
  VALIDATE_ERROR,
  fakeFetch,
  fakeJwt,
  loginOk,
  validateOk,
  type FetchCall,
  type Reply,
} from './kotak-fixtures';

/** 2026-10-12 08:30:05 IST: 5 s into a TOTP window. */
const T0 = Date.UTC(2026, 9, 12, 3, 0, 5);
const LOGIN_URL = 'https://mis.kotaksecurities.com/login/1.0/tradeApiLogin';
const VALIDATE_URL = 'https://mis.kotaksecurities.com/login/1.0/tradeApiValidate';

const isLogin = (c: FetchCall) => c.url === LOGIN_URL;
const isValidate = (c: FetchCall) => c.url === VALIDATE_URL;

/** Session on a virtual clock: sleeps and limiter timers advance it instantly. */
function setup(api: (c: FetchCall, n: number) => Reply, opts: { validate?: (k: number) => Reply; login?: (k: number) => Reply; deps?: KotakSessionDeps } = {}) {
  const env = { clock: T0, logins: 0, validates: 0 };
  const timers: LimiterTimers = {
    now: () => env.clock,
    setTimeout: (fn, ms) => {
      const at = env.clock + ms;
      return setTimeout(() => {
        env.clock = Math.max(env.clock, at);
        fn();
      }, 0);
    },
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const ff = fakeFetch((c, n) => {
    if (isLogin(c)) return opts.login ? opts.login(++env.logins) : (++env.logins, { body: loginOk() });
    if (isValidate(c)) {
      const k = ++env.validates;
      return opts.validate ? opts.validate(k) : { body: validateOk({ token: fakeJwt({ sub: 'u', n: k }), sid: `trade-sid-${k}` }) };
    }
    return api(c, n);
  });
  const session = new KotakSession(CREDS, {
    fetch: ff.fn,
    now: () => env.clock,
    sleep: async (ms) => void (env.clock += ms),
    limiter: new RateLimiter({ timers }),
    ...opts.deps,
  });
  const apiCalls = () => ff.calls.filter((c) => !isLogin(c) && !isValidate(c));
  return { env, ff, session, apiCalls };
}

describe('KotakSession login', () => {
  it('runs tradeApiLogin then tradeApiValidate with the documented headers and bodies', async () => {
    const tradeToken = fakeJwt({ sub: 'u', exp: Math.floor(T0 / 1000) + 8 * 3600 });
    const { ff, session } = setup(() => ({ body: [] }), {
      validate: () => ({ body: validateOk({ token: tradeToken, sid: 'trade-sid-1', feedUrl: 'https://sfeed.kotaksecurities.com/apifeed' }) }),
    });
    await session.login();
    const [login, validate] = ff.calls;
    expect(login.url).toBe(LOGIN_URL);
    expect(login.method).toBe('POST');
    expect(login.headers).toEqual({ authorization: CREDS.consumerKey, 'neo-fin-key': 'neotradeapi', 'content-type': 'application/json' });
    expect(JSON.parse(login.body!)).toEqual({ mobileNumber: '+919876543210', ucc: 'ABC12', totp: totp(CREDS.totpSecret, T0) });

    const view = loginOk().data;
    expect(validate.url).toBe(VALIDATE_URL);
    expect(validate.headers).toEqual({
      authorization: CREDS.consumerKey,
      'neo-fin-key': 'neotradeapi',
      sid: view.sid,
      auth: view.token,
      'content-type': 'application/json',
    });
    expect(JSON.parse(validate.body!)).toEqual({ mpin: CREDS.mpin });

    const st = session.status();
    expect(st).toMatchObject({ loggedIn: true, baseUrl: 'https://neo-gw.kotaksecurities.com/xyz', baseUrlSource: 'validate', dataCenter: 'E43', feedUrlKnown: true });
    expect(st.tokenExpiresAt).toBe((Math.floor(T0 / 1000) + 8 * 3600) * 1000);
    expect(session.feedCredentials()).toMatchObject({ user: 'ABC12', sid: 'trade-sid-1', token: tradeToken, feedUrl: 'https://sfeed.kotaksecurities.com/apifeed' });
  });

  it('waits for a fresh TOTP window when fewer than 3 s remain', async () => {
    const { env, ff, session } = setup(() => ({ body: [] }));
    env.clock = T0 + 23_500; // 28.5 s into the window
    await session.login();
    expect(env.clock).toBeGreaterThanOrEqual(T0 - 5_000 + 30_000);
    expect(JSON.parse(ff.calls[0].body!).totp).toBe(totp(CREDS.totpSecret, env.clock));
  });

  it('treats a 2xx body without data.token/sid as a failure and backs off', async () => {
    const { env, ff, session } = setup(() => ({ body: [] }), { login: () => ({ status: 200, body: LOGIN_ERROR }) });
    const err = await session.login().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KotakError);
    expect(err).toBeInstanceOf(NoLiveData);
    expect((err as KotakError).kind).toBe('login');
    expect((err as Error).message).toContain('Invalid credentials or TOTP.');
    expect(ff.calls.length).toBe(1); // no validate after a failed login
    expect(session.status()).toMatchObject({ loggedIn: false, loginBlockedUntil: T0 + 60_000 });
    expect(session.status().error).toContain('Invalid credentials or TOTP.');

    // Held: no network call until the back-off expires, then exactly one new attempt.
    await expect(session.login()).rejects.toThrow(/on hold/);
    await expect(session.request('x', { kind: 'market' })).rejects.toMatchObject({ kind: 'not-logged-in' });
    expect(ff.calls.length).toBe(1);
    env.clock += 60_000;
    await expect(session.login()).rejects.toThrow(/Invalid credentials/);
    expect(ff.calls.length).toBe(2);
    expect(session.status().loginBlockedUntil).toBe(env.clock + 120_000); // doubled
  });

  it('reports MPIN-validate and validation errors', async () => {
    const a = setup(() => ({ body: [] }), { validate: () => ({ status: 401, body: VALIDATE_ERROR }) });
    await expect(a.session.login()).rejects.toThrow(/MPIN validate failed: Invalid MPIN\. \(HTTP 401\)/);
    const b = setup(() => ({ body: [] }), { login: () => ({ status: 400, body: LOGIN_MISSING_FIELD }) });
    await expect(b.session.login()).rejects.toThrow(/Missing required field 'MobileNumber'/);
  });

  it('backs off on a login 429 for Retry-After, even when forced', async () => {
    const { env, ff, session } = setup(() => ({ body: [] }), { login: (k) => (k === 1 ? { status: 429, headers: { 'Retry-After': '600' }, body: {} } : { body: loginOk() }) });
    await expect(session.login()).rejects.toMatchObject({ httpStatus: 429 });
    expect(session.status().loginBlockedUntil).toBe(T0 + 600_000);
    await expect(session.login({ force: true })).rejects.toThrow(/on hold/);
    env.clock += 600_000;
    await session.login();
    expect(session.status().loggedIn).toBe(true);
    expect(ff.calls.filter(isLogin).length).toBe(2);
  });

  it('a forced login skips a failure back-off (not a 429 one)', async () => {
    const { session } = setup(() => ({ body: [] }), { login: (k) => (k === 1 ? { status: 401, body: LOGIN_ERROR } : { body: loginOk() }) });
    await expect(session.login()).rejects.toThrow();
    await session.login({ force: true });
    expect(session.status().loggedIn).toBe(true);
  });

  it('falls back to the default host when validate has no baseUrl', async () => {
    const { session, apiCalls } = setup(() => ({ body: {} }), { validate: () => ({ body: validateOk({ baseUrl: null }) }) });
    await session.request('script-details/1.0/masterscrip/file-paths', { kind: 'market' });
    expect(session.status()).toMatchObject({ baseUrl: 'https://mis.kotaksecurities.com', baseUrlSource: 'default' });
    expect(apiCalls()[0].url).toBe('https://mis.kotaksecurities.com/script-details/1.0/masterscrip/file-paths');
  });

  it('never exposes secrets in status() or error messages', async () => {
    const echo = { status: 'error', message: `Bad request for ${CREDS.mobileNumber} (${CREDS.mobileNumber.slice(3)}, UCC ${CREDS.ucc}) with key ${CREDS.consumerKey}` };
    const { session } = setup(() => ({ body: [] }), { login: () => ({ status: 400, body: echo }) });
    const err = (await session.login().catch((e: unknown) => e)) as Error;
    const ok = setup(() => ({ body: [] }));
    await ok.session.login();
    const creds = ok.session.feedCredentials()!;
    for (const text of [err.message, JSON.stringify(session.status()), JSON.stringify(ok.session.status())]) {
      for (const secret of [CREDS.consumerKey, CREDS.mpin, CREDS.totpSecret, CREDS.mobileNumber, CREDS.mobileNumber.slice(3), CREDS.ucc, creds.token, creds.sid]) expect(text).not.toContain(secret);
    }
  });
});

describe('KotakSession requests', () => {
  it('builds URLs on baseUrl by concatenation and applies the header set per call class', async () => {
    const { session, apiCalls } = setup(() => ({ body: { stat: 'Ok', data: [] } }), {
      validate: () => ({ body: validateOk({ baseUrl: 'https://neo-gw.kotaksecurities.com/xyz/', token: 'trade.tok.en', sid: 'trade-sid-9' }) }),
    });
    // No explicit login: the first request logs in.
    await session.request('/script-details/1.0/quotes/neosymbol/nse_cm|1333,nse_cm|Nifty%2050/all', { kind: 'market' });
    await session.request('market-data/1.0/historical/details', { kind: 'market', lane: 'slow', query: { neosymbol: 'nse_cm|1333', interval: '1min', fromdate: '2026-08-20', todate: '2026-09-01', skip: undefined } });
    await session.request('quick/user/positions', { kind: 'session' });
    const [q, h, p] = apiCalls();
    expect(q.url).toBe('https://neo-gw.kotaksecurities.com/xyz/script-details/1.0/quotes/neosymbol/nse_cm|1333,nse_cm|Nifty%2050/all');
    expect(q.headers).toEqual({ authorization: CREDS.consumerKey });
    expect(h.url).toBe('https://neo-gw.kotaksecurities.com/xyz/market-data/1.0/historical/details?neosymbol=nse_cm|1333&interval=1min&fromdate=2026-08-20&todate=2026-09-01');
    expect(p.headers).toEqual({ auth: 'trade.tok.en', sid: 'trade-sid-9', 'neo-fin-key': 'neotradeapi', accept: 'application/json' });
  });

  it('on HTTP 401: one re-login with a NEW TOTP window, then one retry', async () => {
    const { env, ff, session } = setup((c, n) => (n === 2 ? { status: 401, body: INVALID_SESSION } : { body: [QUOTE_EQUITY] }));
    await session.login();
    const firstCounter = totpCounter(env.clock);
    const out = await session.request('script-details/1.0/quotes/neosymbol/nse_cm|1333/all', { kind: 'market' });
    expect(out).toEqual([QUOTE_EQUITY]);
    expect(ff.calls.map((c) => (isLogin(c) ? 'login' : isValidate(c) ? 'validate' : 'api'))).toEqual(['login', 'validate', 'api', 'login', 'validate', 'api']);
    const codes = ff.calls.filter(isLogin).map((c) => JSON.parse(c.body!).totp as string);
    expect(totpCounter(env.clock)).toBeGreaterThan(firstCounter);
    expect(codes[1]).toBe(totp(CREDS.totpSecret, env.clock));
    expect(codes[1]).not.toBe(codes[0]);
  });

  it('on stCode 1003 in a 2xx body: re-login and retry with the new Auth/Sid', async () => {
    let n = 0;
    const { session, apiCalls } = setup(() => (++n === 1 ? { status: 200, body: INVALID_SESSION } : { body: { stat: 'Ok', stCode: 200, data: [] } }));
    const out = await session.request('quick/user/positions', { kind: 'session' });
    expect(out).toEqual({ stat: 'Ok', stCode: 200, data: [] });
    const [first, retry] = apiCalls();
    expect(first.headers.sid).toBe('trade-sid-1');
    expect(retry.headers.sid).toBe('trade-sid-2');
    expect(retry.headers.auth).not.toBe(first.headers.auth);
  });

  it('never loops: a second rejection fails and further requests do not log in again', async () => {
    const { ff, session, apiCalls } = setup(() => ({ status: 401, body: { message: 'Invalid session, please re-login' } }));
    const err = await session.request('quick/user/orders', { kind: 'session' }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'auth', httpStatus: 401 });
    expect(ff.calls.filter(isLogin).length).toBe(2);
    expect(apiCalls().length).toBe(2);
    const before = ff.calls.length;
    await expect(session.request('quick/user/orders', { kind: 'session' })).rejects.toMatchObject({ kind: 'not-logged-in' });
    expect(ff.calls.length).toBe(before);
    expect(session.status().loggedIn).toBe(false);
    expect(session.status().error).toContain('Invalid session');
  });

  it('a login that works on sessions every request refuses holds longer each round (5, 10, 20, 30 min) until a request is served', async () => {
    let refuse = true;
    const { env, ff, session } = setup(() => (refuse ? { status: 401, body: INVALID_SESSION } : { body: [] }));
    const logins = () => ff.calls.filter(isLogin).length;
    const holds: number[] = [];
    for (let round = 0; round < 5; round++) {
      await expect(session.request('a', { kind: 'market' })).rejects.toMatchObject({ kind: 'auth' });
      expect(logins()).toBe(2 * (round + 1)); // the login and the one re-login of each round
      const until = session.status().loginBlockedUntil!;
      holds.push(Math.round((until - env.clock) / 60_000));
      // Nothing logs in during the hold (fails fast, no network call).
      await expect(session.request('a', { kind: 'market' })).rejects.toMatchObject({ kind: 'not-logged-in' });
      expect(logins()).toBe(2 * (round + 1));
      env.clock = until + 1;
    }
    expect(holds).toEqual([5, 10, 20, 30, 30]);
    // A served request ends the streak: the next double rejection holds for the cooldown again.
    refuse = false;
    await session.request('a', { kind: 'market' });
    refuse = true;
    await expect(session.request('a', { kind: 'market' })).rejects.toMatchObject({ kind: 'auth' });
    expect(Math.round((session.status().loginBlockedUntil! - env.clock) / 60_000)).toBe(5);
  });

  it('concurrent rejections share one re-login', async () => {
    let n = 0;
    const { ff, session } = setup(() => (++n <= 2 ? { status: 401, body: INVALID_SESSION } : { body: [] }));
    await session.login();
    await Promise.all([session.request('a', { kind: 'market' }), session.request('b', { kind: 'market' })]);
    expect(ff.calls.filter(isLogin).length).toBe(2);
  });

  it('maps 2xx error envelopes and non-JSON bodies to KotakError', async () => {
    const replies: Reply[] = [
      { status: 200, body: { stat: 'Not_Ok', emsg: 'Invalid instrument/code', stCode: 1009 } },
      { status: 200, body: { status: 'ERROR', fault: { code: 400, message: 'Invalid interval value' } } },
      { status: 500, body: { message: 'Internal' } },
      { status: 200, text: '<html>gateway</html>' },
    ];
    let i = 0;
    const { session } = setup(() => replies[i++]);
    await expect(session.request('a', { kind: 'market' })).rejects.toMatchObject({ kind: 'api', stCode: 1009, message: expect.stringContaining('Invalid instrument/code') });
    await expect(session.request('b', { kind: 'market' })).rejects.toMatchObject({ kind: 'api', message: expect.stringContaining('Invalid interval value') });
    await expect(session.request('c', { kind: 'market' })).rejects.toMatchObject({ kind: 'api', httpStatus: 500 });
    await expect(session.request('d', { kind: 'market' })).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('honours 429 Retry-After: short pauses are retried once, long ones fail and pause the lane', async () => {
    let n = 0;
    const { env, session } = setup(() => (++n === 1 ? { status: 429, headers: { 'Retry-After': '2' }, body: {} } : { body: { ok: 1 } }));
    await session.login();
    const t = env.clock;
    await expect(session.request('a', { kind: 'market' })).resolves.toEqual({ ok: 1 });
    expect(env.clock - t).toBeGreaterThanOrEqual(2000);

    const long = setup(() => ({ status: 429, headers: { 'Retry-After': '600' }, body: { code: 429, error: 'Rate limit exceeded' } }));
    await long.session.login();
    await expect(long.session.request('h', { kind: 'market', lane: 'slow' })).rejects.toMatchObject({ kind: 'rate-limit', retryAfterMs: 600_000 });
    expect(long.session.limiter.stats().pausedUntil.slow).toBe(long.env.clock + 600_000);
    expect(long.apiCalls().length).toBe(1);

    // While the lane is held, further calls fail fast (no queue that would hang for the whole
    // pause and burst afterwards). A slow pause does not hold 'general'; a general pause holds both.
    await expect(long.session.request('h2', { kind: 'market', lane: 'slow' })).rejects.toMatchObject({ kind: 'rate-limit', message: expect.stringContaining('paused 600 s') });
    expect(long.apiCalls().length).toBe(1);
    expect(long.session.limiter.pausedMs('general')).toBe(0);
    long.session.limiter.pause('general', 60_000);
    await expect(long.session.request('g', { kind: 'market' })).rejects.toMatchObject({ kind: 'rate-limit' });
    expect(long.apiCalls().length).toBe(1);
  });

  it('a long general pause also holds logins (fails fast instead of parking every caller)', async () => {
    const { ff, session } = setup(() => ({ body: {} }));
    session.limiter.pause('general', 10 * 60_000);
    await expect(session.request('a', { kind: 'market' })).rejects.toMatchObject({ kind: 'rate-limit' });
    expect(ff.calls.length).toBe(0);
    expect(session.status().loginBlockedUntil).toBeUndefined(); // not counted as a login failure
  });

  it('maps a body that fails mid-read to a network KotakError (a NoLiveData)', async () => {
    const { session } = setup(() => ({ body: {} }), {
      deps: {
        fetch: async (url: string) => {
          if (url.endsWith('tradeApiLogin')) return new Response(JSON.stringify(loginOk()));
          if (url.endsWith('tradeApiValidate')) return new Response(JSON.stringify(validateOk()));
          const body = new ReadableStream({ pull: (c) => c.error(new Error('socket hang up')) });
          return new Response(body, { status: 200 });
        },
      },
    });
    const err = await session.request('a', { kind: 'market' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoLiveData);
    expect(err).toMatchObject({ kind: 'network', message: expect.stringContaining('socket hang up') });
  });
});

describe('KotakSession 403 (not enough privileges vs dead session)', () => {
  const MIN = 60_000;
  const QUOTES = 'script-details/1.0/quotes/neosymbol/nse_cm|1333/all';
  const HIST = 'market-data/1.0/historical/details';
  const FORBIDDEN: Reply = { status: 403, body: { message: 'Not enough privileges' } };
  const kinds = (calls: FetchCall[]) => calls.map((c) => (isLogin(c) ? 'login' : isValidate(c) ? 'validate' : c.url.includes('/quotes/') ? 'quotes' : c.url.includes('/historical/') ? 'hist' : 'other'));

  it('after the session has served: a 403 is per endpoint, no re-login, fails fast for the cooldown', async () => {
    const { env, ff, session, apiCalls } = setup((c) => (c.url.includes('/historical/') ? FORBIDDEN : { body: [QUOTE_EQUITY] }));
    await session.request(QUOTES, { kind: 'market' });
    const err = await session.request(HIST, { kind: 'market', lane: 'slow', endpoint: 'historical nse_cm' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoLiveData);
    expect(err).toMatchObject({ kind: 'api', httpStatus: 403, message: expect.stringContaining('not permitted for this account') });
    expect(env.logins).toBe(1);
    expect(session.status()).toMatchObject({ loggedIn: true, endpointsOnHold: { 'historical nse_cm': env.clock + 10 * MIN } });

    // Held: no network call for that endpoint; the others keep working on the same session.
    const before = apiCalls().length;
    await expect(session.request(HIST, { kind: 'market', lane: 'slow', endpoint: 'historical nse_cm' })).rejects.toMatchObject({ kind: 'api', httpStatus: 403 });
    expect(apiCalls().length).toBe(before);
    await expect(session.request(QUOTES, { kind: 'market' })).resolves.toEqual([QUOTE_EQUITY]);
    expect(env.logins).toBe(1);

    // After the cooldown it is asked again (and held again).
    env.clock += 10 * MIN;
    await expect(session.request(HIST, { kind: 'market', lane: 'slow', endpoint: 'historical nse_cm' })).rejects.toMatchObject({ kind: 'api', httpStatus: 403 });
    expect(kinds(ff.calls)).toEqual(['login', 'validate', 'quotes', 'hist', 'quotes', 'hist']);
    expect(env.logins).toBe(1);
  });

  it('a 403 on the first call after login re-logs in once; a dead session recovers', async () => {
    let n = 0;
    const { env, session } = setup(() => (++n === 1 ? FORBIDDEN : { body: [QUOTE_EQUITY] }));
    await session.login();
    await expect(session.request(QUOTES, { kind: 'market' })).resolves.toEqual([QUOTE_EQUITY]);
    expect(env.logins).toBe(2);
    expect(session.status().endpointsOnHold).toBeUndefined();
  });

  it('a 403 on the first call that persists after the re-login holds that endpoint only, the session stays', async () => {
    const { env, ff, session } = setup((c) => (c.url.includes('/historical/') || c.url.endsWith('/oc') ? FORBIDDEN : { body: [QUOTE_EQUITY] }));
    await session.login();
    await expect(session.request(HIST, { kind: 'market', endpoint: 'historical nse_fo' })).rejects.toMatchObject({ kind: 'api', httpStatus: 403 });
    expect(env.logins).toBe(2); // the one re-login
    expect(session.status().loggedIn).toBe(true);
    // Another refused endpoint on the fresh (not yet served) session: no second re-login.
    await expect(session.request('oc', { kind: 'market' })).rejects.toMatchObject({ kind: 'api', httpStatus: 403 });
    expect(env.logins).toBe(2);
    expect(Object.keys(session.status().endpointsOnHold ?? {}).sort()).toEqual(['historical nse_fo', 'oc']);
    await expect(session.request(QUOTES, { kind: 'market' })).resolves.toEqual([QUOTE_EQUITY]);
    expect(kinds(ff.calls)).toEqual(['login', 'validate', 'hist', 'login', 'validate', 'hist', 'other', 'quotes']);
  });

  it('a 403 on an endpoint that already served this session is a dead session: one re-login and retry', async () => {
    let n = 0;
    const { env, session } = setup(() => (++n === 2 ? FORBIDDEN : { body: [QUOTE_EQUITY] }));
    await session.request(QUOTES, { kind: 'market' });
    await expect(session.request(QUOTES, { kind: 'market' })).resolves.toEqual([QUOTE_EQUITY]);
    expect(env.logins).toBe(2);
    expect(session.status().endpointsOnHold).toBeUndefined();
  });
});

describe('KotakSession invalidate()', () => {
  it('allows one re-login per authReloginCooldownMs; a repeat holds logins (even forced) until it ends', async () => {
    const { env, ff, session } = setup(() => ({ body: [] }), { deps: { authReloginCooldownMs: 5 * 60_000 } });
    await session.login();
    const t1 = env.clock;
    session.invalidate('feed: session rejected');
    expect(session.status()).toMatchObject({ loggedIn: false, error: 'feed: session rejected' });
    await session.request('a', { kind: 'market' }); // the one re-login
    expect(env.logins).toBe(2);

    env.clock += 60_000;
    session.invalidate('feed: session rejected');
    expect(session.status().loginBlockedUntil).toBe(t1 + 5 * 60_000);
    const before = ff.calls.length;
    await expect(session.request('a', { kind: 'market' })).rejects.toMatchObject({ kind: 'not-logged-in' });
    await expect(session.login({ force: true })).rejects.toMatchObject({ kind: 'login', message: expect.stringContaining('on hold') });
    expect(ff.calls.length).toBe(before);

    env.clock = t1 + 5 * 60_000;
    await session.request('a', { kind: 'market' });
    expect(env.logins).toBe(3);
    expect(session.status().loggedIn).toBe(true);
  });

  it('forgets the 403 holds taken on the invalidated session (they may have been the dead session)', async () => {
    let refuse = true;
    const { session } = setup((c) => (c.url.endsWith('/h') && refuse ? { status: 403, body: { message: 'Not enough privileges' } } : { body: [] }));
    await session.request('q', { kind: 'market' });
    await expect(session.request('h', { kind: 'market' })).rejects.toMatchObject({ kind: 'api', httpStatus: 403 });
    expect(Object.keys(session.status().endpointsOnHold ?? {})).toEqual(['h']);
    session.invalidate('feed: session rejected');
    expect(session.status().endpointsOnHold).toBeUndefined();
    refuse = false;
    await expect(session.request('h', { kind: 'market' })).resolves.toEqual([]);
  });

  it('shares the budget with rejected requests: a 401 soon after an invalidate-triggered login does not log in again', async () => {
    let n = 0;
    const { env, session } = setup(() => (++n === 1 ? { body: [] } : { status: 401, body: INVALID_SESSION }));
    await session.request('a', { kind: 'market' });
    session.invalidate('feed: session rejected');
    await expect(session.request('b', { kind: 'market' })).rejects.toMatchObject({ kind: 'auth' });
    expect(env.logins).toBe(2);
    await expect(session.request('c', { kind: 'market' })).rejects.toMatchObject({ kind: 'not-logged-in' });
    expect(env.logins).toBe(2);
  });
});

describe('KotakSession proactive re-login', () => {
  it('schedules at token exp − 5 min when the JWT has exp, else daily at 08:30 IST', async () => {
    const exp = Math.floor(T0 / 1000) + 8 * 3600;
    const a = setup(() => ({ body: [] }), { validate: () => ({ body: validateOk({ token: fakeJwt({ exp }) }) }) });
    await a.session.login();
    expect(a.session.nextReloginAt()).toBe(exp * 1000 - 5 * 60_000);
    expect(await a.session.refreshIfDue()).toBe(false);
    a.env.clock = exp * 1000 - 5 * 60_000;
    expect(a.session.reloginDue()).toBe(true);
    expect(await a.session.refreshIfDue()).toBe(true);
    expect(a.env.logins).toBe(2);

    const b = setup(() => ({ body: [] }));
    await b.session.login();
    expect(b.session.nextReloginAt()).toBe(Date.UTC(2026, 9, 13, 3, 0, 0)); // next 08:30 IST
  });

  it('logs in again before sending when the token has expired', async () => {
    const exp = Math.floor(T0 / 1000) + 3600;
    const { env, session } = setup(() => ({ body: {} }), { validate: (k) => ({ body: validateOk({ token: fakeJwt({ exp: exp + (k - 1) * 3600 }) }) }) });
    await session.login();
    env.clock = exp * 1000 + 1;
    expect(session.status().loggedIn).toBe(false);
    await session.request('a', { kind: 'market' });
    expect(env.logins).toBe(2);
    expect(session.status().loggedIn).toBe(true);
  });
});

describe('session helpers', () => {
  it('joinUrl keeps a baseUrl path prefix', () => {
    expect(joinUrl('https://neo-gw.kotaksecurities.com/xyz', 'quick/order/cancel')).toBe('https://neo-gw.kotaksecurities.com/xyz/quick/order/cancel');
    expect(joinUrl('https://e21.kotaksecurities.com/', '/a/b')).toBe('https://e21.kotaksecurities.com/a/b');
  });
  it('buildQuery keeps | literal and encodes the rest', () => {
    expect(buildQuery({ neosymbol: 'nse_cm|Nifty 50', a: undefined, n: 40 })).toBe('?neosymbol=nse_cm|Nifty%2050&n=40');
    expect(buildQuery({})).toBe('');
  });
  it('decodeJwtPayload reads the payload without verifying', () => {
    expect(decodeJwtPayload(fakeJwt({ exp: 123, sub: 'x' }))).toEqual({ exp: 123, sub: 'x' });
    expect(decodeJwtPayload('not-a-jwt')).toBeNull();
  });
  it('nextIstTime finds the next IST wall-clock time', () => {
    expect(nextIstTime(Date.UTC(2026, 9, 12, 2, 0), 510)).toBe(Date.UTC(2026, 9, 12, 3, 0));
    expect(nextIstTime(Date.UTC(2026, 9, 12, 3, 0), 510)).toBe(Date.UTC(2026, 9, 13, 3, 0));
    expect(nextIstTime(Date.UTC(2026, 9, 11, 20, 0), 510)).toBe(Date.UTC(2026, 9, 12, 3, 0)); // 01:30 IST
  });
});
