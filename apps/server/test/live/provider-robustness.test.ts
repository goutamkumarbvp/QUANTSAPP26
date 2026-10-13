/**
 * LiveProvider failure sequences (re-login watchdog, feed refusals): fake fetch, fake sockets, no
 * network. The feed test runs the real SFeedClient, whose reconnect back-off uses the global timers,
 * so it moves one fake clock (vi fake timers) for the provider and the client alike.
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
import { CREDS, fakeFetch, filePaths, loginOk, validateOk } from './kotak-fixtures';
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

/** Kotak with a new sid per login; index quotes so the chains have a centre. */
function kotak() {
  const files = universeFiles();
  let sid = 0;
  const kf = fakeFetch((c) => {
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
