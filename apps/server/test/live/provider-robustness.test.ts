/**
 * LiveProvider failure sequences (re-login watchdog, feed refusals, shutdown, combined REST load):
 * fake fetch, fake sockets, no network. The feed tests run the real SFeedClient, whose reconnect
 * back-off uses the global timers, so they move one fake clock (vi fake timers) for the provider and
 * the client alike.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KOTAK_LOGIN_URL } from '../../src/live/kotak/session';
import { LiveProvider, type LiveProviderConfig, type LiveProviderDeps } from '../../src/live/provider';
import { fakeSockets } from '../support/fake-sfeed';
import { ManualTimers, flush } from '../support/manual-timers';
import { AUTH_1117, AUTH_1120 } from './fixtures/sfeed';
import { CREDS, INVALID_SESSION, fakeFetch, filePaths, loginOk, validateOk, type FetchCall, type Reply } from './kotak-fixtures';
import { DAY, scripReply, universeFiles } from './kotak-universe';

const ist = (hhmm: string) => Date.parse(`${DAY}T${hhmm}+05:30`);

let dir = '';
const providers: LiveProvider[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q26-provider-rb-'));
});
afterEach(async () => {
  for (const p of providers.splice(0)) await p.stop();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

const config: () => LiveProviderConfig = () => ({ dataDir: dir, riskFreeRate: 0.065, holidays: [], neo: CREDS, eodBackfillDays: 0, sfeedTokenBudget: 2700 });

/** Kotak with a new sid per login; index quotes so the chains have a centre. `own` answers first. */
function kotak(own?: (c: FetchCall) => Reply | undefined) {
  const files = universeFiles();
  let sid = 0;
  const kf = fakeFetch((c) => {
    const r = own?.(c);
    if (r) return r;
    if (c.url === `${KOTAK_LOGIN_URL}tradeApiLogin`) return { body: loginOk() };
    if (c.url === `${KOTAK_LOGIN_URL}tradeApiValidate`) return { body: validateOk({ baseUrl: 'https://neo-gw.test/xyz', sid: `trade-sid-${++sid}-aaaa-bbbb-cccc` }) };
    if (c.url.includes('masterscrip/file-paths')) return { body: filePaths(DAY) };
    const scrip = scripReply(c.url, files);
    if (scrip) return scrip;
    if (c.url.includes('/quotes/neosymbol/')) {
      const ltp: Record<string, number> = { 'nse_cm|Nifty 50': 25010.5, 'nse_cm|Nifty Bank': 56020.25, 'bse_cm|SENSEX': 82015.75 };
      const asked = decodeURIComponent(c.url).split('/neosymbol/')[1]?.split('/all')[0]?.split(',') ?? [];
      const ts = String(Math.floor(Date.parse(`${DAY}T04:30:00Z`) / 1000));
      const rows = asked.filter((n) => ltp[n] !== undefined).map((n) => ({ exchange: n.split('|')[0], exchange_token: n.split('|')[1], lstup_time: ts, ltp: ltp[n].toFixed(4), ohlc: { open: '1', high: '1', low: '1', close: '1' } }));
      return { body: rows };
    }
    if (c.url.includes('watchlist/option-chain')) return { body: { data: { common_data: { exSeg: 'nse_fo' }, call: [], put: [] } } };
    throw new Error(`unexpected Kotak call ${c.url}`);
  });
  return { kf, logins: () => kf.calls.filter((c) => c.url.endsWith('tradeApiLogin')).length };
}

function provider(deps: LiveProviderDeps) {
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  const p = new LiveProvider(config(), { nseFetch: fakeFetch(() => ({ status: 404, text: '' })).fn, logger: { info: log, warn: log, error: log, debug: () => {} }, ...deps });
  providers.push(p);
  return { p, logs };
}

describe('LiveProvider session watchdog', () => {
  it('logs in again within a minute when the session is lost, although the next 08:30 re-login is already scheduled', async () => {
    // 20:00 IST: the sweep has paused after its first pass and nothing else calls Kotak REST.
    const timers = new ManualTimers(ist('20:00'));
    const k = kotak();
    const { p } = provider({ kotakFetch: k.kf.fn, wsFactory: fakeSockets().factory, now: timers.now, sleep: timers.sleep, timers });
    await p.start();
    await p.whenStarted();
    await timers.advance(5 * 60_000);
    expect(p.healthReport().jobs.relogin.nextAt).toBeGreaterThan(timers.now() + 10 * 3_600_000);
    expect(k.logins()).toBe(1);

    p.session!.logout(); // the session is gone (e.g. dropped after a rejected request)
    expect(p.health().loggedIn).toBe(false);
    await timers.advance(61_000);
    expect(k.logins()).toBe(2);
    expect(p.health().loggedIn).toBe(true);
  });
});

describe('LiveProvider feed refusals', () => {
  it('re-dials with the old sid while the re-login is in flight do not use up the hourly re-login cap', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(ist('10:00:10'));
    const step = async (ms: number) => {
      for (let t = 0; t < ms; t += 250) {
        vi.advanceTimersByTime(250);
        await flush(3);
      }
    };
    const k = kotak();
    const sf = fakeSockets();
    const { p } = provider({ kotakFetch: k.kf.fn, wsFactory: sf.factory, live: { feedOptions: { random: () => 0, pingIntervalMs: 3_600_000 } } });
    // The feed accepts the sids in `good` and refuses every other one; each socket is answered once.
    const good = new Set<string>();
    let answered = 0;
    const serve = () => {
      for (const s of sf.sockets.slice(answered)) {
        if (s.closed) continue;
        s.open();
        s.text(good.has(JSON.parse(s.sent[0]).auth as string) ? AUTH_1117 : AUTH_1120);
      }
      answered = sf.sockets.length;
    };
    const run = async (ms: number) => {
      for (let t = 0; t < ms; t += 500) {
        serve();
        await step(500);
      }
    };
    await p.start();
    await p.whenStarted(); // login and the instrument master (real file I/O) before the clock moves
    good.add('trade-sid-1-aaaa-bbbb-cccc');
    await run(5_000);
    expect(p.health().connected).toBe(true);

    // Four sid expiries 6 minutes apart (past the session's re-login cooldown): four re-logins, within
    // the cap of 6 an hour. The first falls in the TOTP window of the boot login: the re-login waits
    // ~15 s for a new window while the client re-dials with the expired sid (refused 4 times).
    for (let n = 1; n <= 4; n++) {
      good.clear();
      good.add(`trade-sid-${n + 1}-aaaa-bbbb-cccc`);
      sf.last().on.close(1006, 'session expired');
      await run(60_000);
      expect(k.logins()).toBe(n + 1);
      expect(p.health()).toMatchObject({ loggedIn: true, connected: true });
      await run(5 * 60_000);
    }
    expect(p.healthReport().feed.error ?? '').not.toMatch(/times within an hour/);
  }, 30_000);
});

describe('LiveProvider login job', () => {
  it('a login armed for the end of a hold does not replace the session a REST caller restored meanwhile', async () => {
    let refuse = 0;
    const timers = new ManualTimers(ist('10:00:10'));
    const k = kotak((c) => (refuse > 0 && c.url.includes('/quotes/') ? (refuse--, { status: 401, body: INVALID_SESSION }) : undefined));
    const { p } = provider({ kotakFetch: k.kf.fn, wsFactory: fakeSockets().factory, now: timers.now, sleep: timers.sleep, timers });
    await p.start();
    await p.whenStarted();
    const spot = [{ symbol: 'NIFTY', kind: 'SPOT' as const }];

    // A quote call and its retry after a fresh login are refused: the session holds logins for 5 min.
    refuse = 2;
    const failed = p.live.refresh(spot).catch((e: unknown) => e);
    await timers.advance(30_000); // the re-login waits for a new TOTP window
    expect(await failed).toMatchObject({ kind: 'auth' });
    expect(k.logins()).toBe(2);
    const hold = p.session!.status().loginBlockedUntil!;
    await timers.advance(70_000); // the watchdog arms the login job for the end of the hold
    expect(p.healthReport().jobs.login.nextAt).toBe(hold + 1000);

    // A REST caller logs in first, just after the hold ends; the armed job must not log in again.
    await timers.advance(hold + 200 - timers.now());
    await expect(p.live.refresh(spot)).resolves.toBeInstanceOf(Map);
    expect(k.logins()).toBe(3);
    await timers.advance(60_000);
    expect(k.logins()).toBe(3);
    expect(p.health().loggedIn).toBe(true);
  });
});

describe('LiveProvider login job and the instrument master', () => {
  it('a feed refusal while the instrument master is still downloading gets its re-login at once', async () => {
    const timers = new ManualTimers(ist('10:00:10'));
    let release: () => void = () => {};
    const downloading = new Promise<void>((r) => (release = r));
    const files = universeFiles();
    const k = kotak((c) => {
      const scrip = scripReply(c.url, files);
      return scrip ? (downloading.then(() => scrip) as unknown as Reply) : undefined;
    });
    const sf = fakeSockets();
    const { p } = provider({ kotakFetch: k.kf.fn, wsFactory: sf.factory, now: timers.now, sleep: timers.sleep, timers });
    await p.start();
    await flush();
    expect(k.logins()).toBe(1);
    expect(p.ref.ready()).toBe(false); // the CSV downloads hang

    sf.last().open();
    sf.last().text(AUTH_1120); // the first sid is refused
    await timers.advance(31_000); // the re-login waits for a new TOTP window
    expect(k.logins()).toBe(2);
    expect(JSON.parse(sf.last().sent[0] ?? '{}')).toEqual({}); // a new socket, not open yet
    sf.last().open();
    expect(JSON.parse(sf.last().sent[0])).toMatchObject({ auth: 'trade-sid-2-aaaa-bbbb-cccc' });

    release();
    await p.whenStarted(); // includes the instrument master's first attempt
    expect(p.ref.ready()).toBe(true);
  });
});

describe('LiveProvider start and stop', () => {
  it('start() returns at once when Kotak never answers, and stop() still completes', async () => {
    const timers = new ManualTimers(ist('10:00:10'));
    const hung = fakeFetch(() => new Promise<Reply>(() => {}));
    const { p } = provider({ kotakFetch: hung.fn, wsFactory: fakeSockets().factory, now: timers.now, sleep: timers.sleep, timers });
    await expect(p.start()).resolves.toBeUndefined();
    await flush();
    expect(hung.calls.map((c) => c.url)).toEqual([`${KOTAK_LOGIN_URL}tradeApiLogin`]);
    expect(p.health()).toMatchObject({ loggedIn: false, connected: false });
    expect(p.recorder.stats().date).toBe(DAY); // started mid-session without waiting for Kotak
    await p.stop();
    expect(timers.pending()).toEqual([]);
  });

  it('stop() leaves no timer of the provider or the feed (sweep, watch expiry, reconnect, ping) and no Kotak call', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(ist('10:00:10'));
    const k = kotak();
    const sf = fakeSockets();
    const { p } = provider({ kotakFetch: k.kf.fn, wsFactory: sf.factory, live: { feedOptions: { random: () => 0 } } });
    await p.start();
    await p.whenStarted();
    sf.last().open();
    sf.last().text(AUTH_1117);
    await flush(3);
    expect(p.health().connected).toBe(true);
    expect(p.live.sweepStatus().running).toBe(true);
    p.live.watch([{ symbol: 'RELIANCE', kind: 'SPOT' }]); // an ad-hoc watch with its expiry timer
    sf.last().on.close(1006, 'dropped'); // and a reconnect pending
    const calls = k.kf.calls.length;
    await p.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3_600_000);
    await flush(5);
    expect(k.kf.calls.length).toBe(calls);
    expect(sf.sockets.every((s) => s.closed)).toBe(true);
  });

  it('a login caught by stop() in its TOTP wait never reaches Kotak afterwards', async () => {
    const timers = new ManualTimers(ist('10:00:10'));
    const k = kotak();
    const { p } = provider({ kotakFetch: k.kf.fn, wsFactory: fakeSockets().factory, now: timers.now, sleep: timers.sleep, timers });
    await p.start();
    await p.whenStarted();
    p.session!.logout();
    const pending = p.live.refresh([{ symbol: 'NIFTY', kind: 'SPOT' }]).catch((e: unknown) => e); // logs in: same TOTP window → waits
    await flush();
    const calls = k.kf.calls.length;
    await p.stop();
    expect(timers.pending()).toHaveLength(1); // only that TOTP wait (unref'd with the real timers)
    await timers.advance(60_000);
    expect(await pending).toBeInstanceOf(Error);
    expect(k.kf.calls.length).toBe(calls);
    expect(timers.pending()).toEqual([]);
  });
});

describe('LiveProvider combined Kotak REST load (worst case)', () => {
  it('sweep + its spot/future quotes + index spots + feed re-logins stay inside 10/s, 300/min and 5,000/h', async () => {
    // Worst case for the background load: the feed refuses every session (nothing is streamed, a
    // re-login every 10 min) and the stock spot/future quotes come back without an LTP, so every
    // sweep step is one option-chain call (slow lane) plus one quotes call.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(ist('10:00:10'));
    const k = kotak();
    const sf = fakeSockets();
    const { p, logs } = provider({ kotakFetch: k.kf.fn, wsFactory: sf.factory, live: { feedOptions: { random: () => 0, pingIntervalMs: 3_600_000 } } });
    await p.start();
    await p.whenStarted();
    let answered = 0;
    let worst = { second: 0, minute: 0, hour: 0 };
    for (let t = 0; t < 3_600_000; t += 500) {
      for (const s of sf.sockets.slice(answered)) {
        if (s.closed) continue;
        s.open();
        s.text(AUTH_1120);
      }
      answered = sf.sockets.length;
      vi.advanceTimersByTime(500);
      await flush(3);
      const st = p.session!.limiter.stats();
      worst = { second: Math.max(worst.second, st.lastSecond), minute: Math.max(worst.minute, st.lastMinute), hour: Math.max(worst.hour, st.lastHour) };
    }
    const api = k.kf.calls.filter((c) => !c.url.includes('wso2-scripmaster')); // CSV downloads are not API calls
    const chains = api.filter((c) => c.url.includes('option-chain')).length;
    const quotes = api.filter((c) => c.url.includes('/quotes/')).length;
    expect(worst.second).toBeLessThanOrEqual(10);
    expect(worst.minute).toBeLessThanOrEqual(300);
    expect(worst.hour).toBeLessThanOrEqual(5000);
    expect(api.length).toBeLessThanOrEqual(5000);
    expect(chains).toBeGreaterThan(1000); // the sweep runs the whole hour …
    expect(chains).toBeLessThanOrEqual(2400); // … on the slow lane (≥ 1.5 s apart)
    expect(quotes).toBeLessThanOrEqual(chains + 61); // ≤ 1 spot/future call per chain + the index spots once a minute
    expect(k.logins()).toBeLessThanOrEqual(1 + 6); // the boot login + the hourly cap of feed re-logins

    // No credential, sid or token in any log line or in the health report.
    const text = [...logs, JSON.stringify(p.healthReport()), p.healthLine()].join('\n');
    for (const secret of [CREDS.consumerKey, CREDS.mpin, CREDS.totpSecret, CREDS.ucc, CREDS.mobileNumber, CREDS.mobileNumber.slice(3), 'trade-sid-', 'view-sid-', validateOk().data.token as string, loginOk().data.token]) {
      expect(text).not.toContain(secret);
    }
  }, 60_000);
});

describe('LiveProvider forced login ("Re-login now", review fix)', () => {
  it('a failed forced login is retried as a normal login: while paused, no further login reaches Kotak', async () => {
    const timers = new ManualTimers(ist('20:00'));
    // Wrong credentials: every TOTP login is refused.
    const k = kotak((c) => (c.url === `${KOTAK_LOGIN_URL}tradeApiLogin` ? { status: 401, body: { stat: 'Not_Ok', emsg: 'Invalid credentials or TOTP.' } } : undefined));
    const { p } = provider({ kotakFetch: k.kf.fn, wsFactory: fakeSockets().factory, now: timers.now, sleep: timers.sleep, timers });
    await p.start();
    await timers.advance(3 * 3_600_000); // 60 s, 2, 4, 8 min … → 5 refusals, then the pause
    expect(p.session!.status().loginPaused).toMatch(/refused 5 logins/);
    expect(k.logins()).toBe(5);
    await expect(p.loginNow({ force: true })).rejects.toThrow(/Invalid credentials/);
    expect(k.logins()).toBe(6); // the one forced attempt
    await timers.advance(24 * 3_600_000);
    expect(k.logins()).toBe(6); // its retries are normal logins: the pause holds
    expect(p.session!.status().loginPaused).toBeDefined();
  });
});
