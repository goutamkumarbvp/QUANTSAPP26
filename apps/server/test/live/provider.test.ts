import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExchangeCalendar } from '../../src/live/calendar';
import { KOTAK_LOGIN_URL } from '../../src/live/kotak/session';
import { LiveProvider, resampleMinutes, type LiveProviderConfig, type MinuteCandle } from '../../src/live/provider';
import { NoLiveData, keyId, type InstrumentKey } from '../../src/live/types';
import { fakeSockets } from '../support/fake-sfeed';
import { ManualTimers, flush } from '../support/manual-timers';
import { AUTH_1117, AUTH_1120, AUTH_FALLBACK, MP_L4_FIELDS, encodeMarketPicture } from './fixtures/sfeed';
import { CREDS, HISTORICAL, fakeFetch, filePaths, loginOk, validateOk, type FetchCall, type Reply } from './kotak-fixtures';
import { DAY, MONTHLY, NIFTY_W1, scripReply, universeFiles } from './kotak-universe';

/** 10:00:10 IST on the fixture day (session open; 20 s left in the TOTP window). */
const T0 = Date.parse(`${DAY}T04:30:10Z`);
const SEC = (ms: number) => Math.floor(ms / 1000);
const ist = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`);

let dir = '';
const providers: LiveProvider[] = [];
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q26-provider-'));
});
afterEach(async () => {
  for (const p of providers.splice(0)) await p.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

const config = (over: Partial<LiveProviderConfig> = {}): LiveProviderConfig => ({
  dataDir: dir,
  riskFreeRate: 0.065,
  holidays: [],
  neo: CREDS,
  eodBackfillDays: 0,
  sfeedTokenBudget: 2700,
  ...over,
});

/** NSE/BSE: nothing published (the EOD jobs have their own tests). */
const nseFetch = fakeFetch(() => ({ status: 404, text: '' }));

function quoteRows(call: FetchCall): unknown[] {
  const ltp: Record<string, number> = { 'nse_cm|Nifty 50': 25010.5, 'nse_cm|Nifty Bank': 56020.25, 'bse_cm|SENSEX': 82015.75 };
  const asked = decodeURIComponent(call.url).split('/neosymbol/')[1]?.split('/all')[0]?.split(',') ?? [];
  return asked
    .filter((n) => ltp[n] !== undefined)
    .map((n) => {
      const [seg, token] = n.split('|');
      return { exchange: seg, exchange_token: token, lstup_time: String(SEC(T0)), ltp: ltp[n].toFixed(4), last_volume: '0', total_buy: '0', total_sell: '0', ohlc: { open: '1', high: '1', low: '1', close: '1' } };
    });
}

function kotak(handler: (call: FetchCall) => Reply | undefined = () => undefined) {
  const files = universeFiles();
  return fakeFetch((c) => {
    const own = handler(c);
    if (own) return own;
    if (c.url === `${KOTAK_LOGIN_URL}tradeApiLogin`) return { body: loginOk() };
    if (c.url === `${KOTAK_LOGIN_URL}tradeApiValidate`) return { body: validateOk({ baseUrl: 'https://neo-gw.test/xyz' }) };
    if (c.url.includes('masterscrip/file-paths')) return { body: filePaths(DAY) };
    const scrip = scripReply(c.url, files);
    if (scrip) return scrip;
    if (c.url.includes('/quotes/neosymbol/')) return { body: quoteRows(c) };
    if (c.url.includes('watchlist/option-chain')) return { body: { data: { common_data: { exSeg: 'nse_fo' }, call: [], put: [] } } };
    throw new Error(`unexpected Kotak call ${c.url}`);
  });
}

function harness(over: Partial<LiveProviderConfig> = {}, kotakHandler?: (call: FetchCall) => Reply | undefined, start = T0) {
  const timers = new ManualTimers(start);
  const kf = kotak(kotakHandler);
  const sf = fakeSockets();
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  const p = new LiveProvider(config(over), {
    kotakFetch: kf.fn,
    nseFetch: nseFetch.fn,
    wsFactory: sf.factory,
    now: timers.now,
    sleep: timers.sleep,
    timers,
    logger: { info: log, warn: log, error: log, debug: () => {} },
    live: { feedOptions: { random: () => 0 } },
  });
  providers.push(p);
  return { p, timers, kf, sf, logs };
}

const ce = (strike: number, expiry = NIFTY_W1): InstrumentKey => ({ symbol: 'NIFTY', kind: 'CE', expiry, strike });

describe('LiveProvider without credentials', () => {
  it('starts without throwing or touching Kotak, and reports which variables are missing', async () => {
    const h = harness({ neo: null, neoError: 'Kotak credentials missing in .env: NEO_MPIN, NEO_TOTP_SECRET' });
    await expect(h.p.start()).resolves.toBeUndefined();
    await h.p.whenStarted();
    expect(h.kf.calls).toHaveLength(0);
    const r = h.p.healthReport();
    expect(r.kotak).toEqual({ loggedIn: false, error: 'Kotak credentials missing in .env: NEO_MPIN, NEO_TOTP_SECRET', feedUrlKnown: false });
    expect(r.feed).toMatchObject({ loggedIn: false, connected: false, error: 'Kotak credentials missing in .env: NEO_MPIN, NEO_TOTP_SECRET' });
    expect(r.refdata.ready).toBe(false);
    expect(r.jobs.refdata.lastError).toMatch(/Kotak credentials missing/);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r); // JSON-safe
    expect(h.p.healthLine()).toMatch(/^live data: Kotak not logged in \(Kotak credentials missing in \.env: NEO_MPIN, NEO_TOTP_SECRET\)/);
    await expect(h.p.live.refresh([{ symbol: 'NIFTY', kind: 'SPOT' }])).rejects.toThrow(NoLiveData);
    await expect(h.p.candles({ symbol: 'NIFTY', kind: 'SPOT' }, '5min', DAY, DAY)).rejects.toThrow(/not recorded, and Kotak historical: Kotak credentials missing/);
    // No retry loop: nothing changes until a restart with credentials.
    await h.timers.advance(60 * 60_000);
    expect(h.kf.calls).toHaveLength(0);
    expect(h.p.healthReport().jobs.refdata.attempts).toBe(1);
  });

  it('keeps no secret in the health report', async () => {
    const h = harness();
    await h.p.start();
    await h.p.whenStarted();
    const text = JSON.stringify(h.p.healthReport());
    for (const secret of [CREDS.consumerKey, CREDS.mpin, CREDS.totpSecret, CREDS.ucc, CREDS.mobileNumber, 'trade-sid-aaaa-bbbb-cccc-dddddddddddd']) expect(text).not.toContain(secret);
  });
});

describe('LiveProvider end to end (fake fetch + fake socket)', () => {
  it('login → scrip master → subscribe → binary tick → quote → recorder minute → candles', async () => {
    const h = harness();
    await h.p.start();
    await h.p.whenStarted();
    // Login, then the instrument master over the file-paths API, then index spots for the chain centres.
    const urls = h.kf.calls.map((c) => c.url);
    expect(urls[0]).toBe(`${KOTAK_LOGIN_URL}tradeApiLogin`);
    expect(urls[1]).toBe(`${KOTAK_LOGIN_URL}tradeApiValidate`);
    expect(urls).toContain('https://neo-gw.test/xyz/script-details/1.0/masterscrip/file-paths');
    expect(urls.some((u) => u.includes('/quotes/neosymbol/'))).toBe(true);
    expect(h.p.ref.ready()).toBe(true);
    expect(h.p.live.quote({ symbol: 'NIFTY', kind: 'SPOT' })?.ltp).toBe(25010.5);
    expect(h.p.universe.centreOf('NIFTY')).toBe(25010.5);

    // The websocket authenticates and gets the universe.
    const sock = h.sf.last();
    expect(sock.url).toBe('wss://sfeed.kotaksecurities.com/apifeed');
    sock.open();
    sock.text(AUTH_1117);
    await flush(2);
    expect(JSON.parse(sock.sent[0])).toMatchObject({ user: CREDS.ucc, auth: 'trade-sid-aaaa-bbbb-cccc-dddddddddddd' });
    const subs = sock.subscribed();
    expect(subs.index.has('nse_cm|Nifty 50')).toBe(true);
    expect(subs.index.has('nse_cm|INDIA VIX')).toBe(true);
    expect(subs.scrips.has('nse_fo|52010')).toBe(true); // NIFTY near future
    const ceTok = h.p.ref.listing(ce(25000))!.token;
    expect(subs.scrips.has(`nse_fo|${ceTok}`)).toBe(true);
    expect(h.p.health()).toMatchObject({ loggedIn: true, connected: true });

    // Two ticks in the 10:00 minute: 600 units traded.
    const tick = (ts: number, ltp: number, vol: number) =>
      encodeMarketPicture({ ...MP_L4_FIELDS, exch: 2, token: Number(ceTok), ltp: Math.round(ltp * 100), ltt: SEC(ts), lut: SEC(ts), vol, oi: 90_000, rows: [[75, Math.round((ltp - 0.05) * 100), 1], [75, Math.round((ltp + 0.05) * 100), 1]] });
    sock.bin(tick(T0, 120.5, 5000));
    await h.timers.advance(20_000);
    sock.bin(tick(T0 + 20_000, 121.25, 5600));
    expect(h.p.live.quote(ce(25000))).toMatchObject({ ltp: 121.25, bid: 121.2, ask: 121.3, oi: 90_000, volume: 5600 });
    expect(h.p.pricing.iv({ symbol: 'NIFTY', expiry: NIFTY_W1, type: 'CE', strike: 25000, premium: 121.25 })).toBeGreaterThan(0);

    // The recorder writes the minute once it is over (+ grace).
    await h.timers.advance(40_000);
    const minute = Date.parse(`${DAY}T04:30:00Z`);
    expect(h.p.intraday.bars(ce(25000), DAY)).toEqual([expect.objectContaining({ ts: minute, open: 120.5, high: 121.25, low: 120.5, close: 121.25, traded: true, volume: 600 })]);
    expect(h.p.intraday.sessions()).toEqual([DAY]);

    const c1 = await h.p.candles(ce(25000), '1min', DAY, DAY);
    expect(c1).toEqual([{ ts: minute, open: 120.5, high: 121.25, low: 120.5, close: 121.25, volume: 600 }]);
    const c5 = await h.p.candles(ce(25000), '5min', DAY, DAY);
    expect(c5).toEqual([{ ts: Date.parse(`${DAY}T04:30:00Z`), open: 120.5, high: 121.25, low: 120.5, close: 121.25, volume: 600 }]);

    const r = h.p.healthReport();
    expect(r.kotak.loggedIn).toBe(true);
    expect(r.refdata).toMatchObject({ ready: true, date: DAY });
    expect(r.recorder.minutesWritten).toBeGreaterThanOrEqual(1);
    expect(r.recorder.firstRecordedSession).toBe(DAY);
    expect(r.feed.details.subscriptions.desired).toBeGreaterThan(300);
    expect(r.sweep.running).toBe(true);
    expect(h.p.healthLine()).toMatch(/^live data: Kotak logged in; feed connected \(\d+ subscribed\); instrument master 2026-10-12/);
  });

  it('dates the recorder does not have come from Kotak historical (active contracts only)', async () => {
    const hist = { ...HISTORICAL, data: { candles: [['2026-10-09T09:15:00+0530', 25100, 25120, 25090, 25110, 1500], ['2026-10-09T09:16:00+0530', 25110, 25130, 25100, 25125, 900], ['2026-10-09T09:17:00+0530', 25125, 25126, 25080, 25090, 300]] } };
    const asked: string[] = [];
    const h = harness({}, (c) => {
      if (!c.url.includes('historical/details')) return undefined;
      asked.push(decodeURIComponent(c.url));
      return { body: hist };
    });
    await h.p.start();
    await h.p.whenStarted();
    const fut: InstrumentKey = { symbol: 'NIFTY', kind: 'FUT', expiry: MONTHLY };
    const pending = h.p.candles(fut, '3min', '2026-10-09', '2026-10-09');
    await h.timers.advance(3_000); // the slow lane may wait for the sweep's spacing
    expect(await pending).toEqual([{ ts: ist('2026-10-09', '09:15'), open: 25100, high: 25130, low: 25080, close: 25090, volume: 2700 }]);
    expect(asked[0]).toContain('neosymbol=nse_fo|52010');
    expect(asked[0]).toContain('interval=1min');
    expect(asked[0]).toContain('fromdate=2026-10-09');
    // An expired (unlisted) contract is not served.
    await expect(h.p.candles({ ...fut, expiry: '2026-09-29' }, '1min', '2026-09-15', '2026-09-15')).rejects.toThrow(/not listed today \(expired contracts are not served/);
  });

  it('a failed login is recorded and retried with back-off, never in a tight loop', async () => {
    let fail = true;
    const h = harness({}, (c) => (fail && c.url.endsWith('tradeApiLogin') ? { status: 401, body: { status: 'error', message: 'Invalid credentials or TOTP.' } } : undefined));
    await h.p.start();
    await h.p.whenStarted();
    expect(h.p.healthReport().jobs.login).toMatchObject({ attempts: 1, lastError: expect.stringMatching(/Invalid credentials or TOTP/) });
    expect(h.p.health().error).toMatch(/Invalid credentials or TOTP/);
    const logins = () => h.kf.calls.filter((c) => c.url.endsWith('tradeApiLogin')).length;
    await h.timers.advance(30_000);
    expect(logins()).toBe(1);
    fail = false;
    await h.timers.advance(40_000); // 60 s back-off (the session's own hold)
    await flush();
    expect(logins()).toBe(2);
    expect(h.p.health().loggedIn).toBe(true);
  });

  it('feed auth failure → one re-login and the new session on the feed; native_fallback stops the stream', async () => {
    let sid = 0;
    const h = harness({}, (c) => (c.url.endsWith('tradeApiValidate') ? { body: validateOk({ baseUrl: 'https://neo-gw.test/xyz', sid: `trade-sid-${++sid}-aaaa-bbbb-cccc` }) } : undefined));
    await h.p.start();
    await h.p.whenStarted();
    const logins = () => h.kf.calls.filter((c) => c.url.endsWith('tradeApiLogin')).length;
    const s1 = h.sf.last();
    s1.open();
    s1.text(AUTH_1120);
    await h.timers.advance(31_000); // the re-login waits for a fresh TOTP window
    expect(logins()).toBe(2);
    const s2 = h.sf.last();
    expect(s2).not.toBe(s1);
    expect(JSON.parse(s2.sent[0] ?? 'null')).toBeNull(); // not open yet: nothing sent
    s2.open();
    expect(JSON.parse(s2.sent[0])).toMatchObject({ auth: 'trade-sid-2-aaaa-bbbb-cccc' });
    s2.text(AUTH_1117);
    await flush(2);
    expect(h.p.health()).toMatchObject({ loggedIn: true, connected: true });
    s2.text(AUTH_FALLBACK);
    await flush(5);
    const health = h.p.health();
    expect(health.connected).toBe(false);
    expect(health.error).toMatch(/native_fallback/);
    expect(logins()).toBe(2); // logging in again would not help
    expect(h.p.healthReport().jobs.feed.nextAt).toBeGreaterThan(h.timers.now() + 29 * 60_000);
  });

  it('starts the recorder session after a restart mid-session and ends it after 15:30', async () => {
    const h = harness({}, undefined, ist(DAY, '15:29'));
    await h.p.start();
    expect(h.p.recorder.stats().date).toBe(DAY);
    await h.p.whenStarted();
    await h.timers.advance(2 * 60_000);
    expect(h.p.recorder.stats().date).toBeNull();
  });
});

describe('resampleMinutes', () => {
  const cal = new ExchangeCalendar();
  const m = (hhmm: string, o: number, hi: number, lo: number, c: number, volume?: number): MinuteCandle => ({ ts: ist(DAY, hhmm), open: o, high: hi, low: lo, close: c, ...(volume !== undefined ? { volume } : {}) });

  it('buckets from 09:15, OHLC of the minutes present, volume summed, empty buckets not produced', () => {
    const out = resampleMinutes([m('09:16', 10, 12, 9, 11, 100), m('09:15', 9, 10, 8, 10, 50), m('09:21', 11, 11, 10, 10.5, 30), m('09:40', 12, 13, 12, 13, 5)], 5, cal);
    expect(out).toEqual([
      { ts: ist(DAY, '09:15'), open: 9, high: 12, low: 8, close: 11, volume: 150 },
      { ts: ist(DAY, '09:20'), open: 11, high: 11, low: 10, close: 10.5, volume: 30 },
      { ts: ist(DAY, '09:40'), open: 12, high: 13, low: 12, close: 13, volume: 5 },
    ]);
  });

  it('keeps volume absent when no minute reports one (index spots), and keeps days apart', () => {
    const next = '2026-10-13';
    const out = resampleMinutes([m('15:29', 1, 2, 1, 2), { ts: ist(next, '09:15'), open: 3, high: 3, low: 3, close: 3 }], 60, cal);
    expect(out).toEqual([
      { ts: ist(DAY, '15:15'), open: 1, high: 2, low: 1, close: 2 },
      { ts: ist(next, '09:15'), open: 3, high: 3, low: 3, close: 3 },
    ]);
    expect(keyId({ symbol: 'NIFTY', kind: 'SPOT' })).toBe('NIFTY|SPOT||');
  });
});

describe('LiveProvider candles from Kotak historical (review)', () => {
  it("a contract's zero-volume minute (no trade, carried-forward price) is not a candle", async () => {
    const hist = { ...HISTORICAL, data: { candles: [['2026-10-09T09:15:00+0530', 25100, 25120, 25090, 25110, 1500], ['2026-10-09T09:16:00+0530', 25110, 25110, 25110, 25110, 0], ['2026-10-09T09:17:00+0530', 25125, 25126, 25080, 25090, 300]] } };
    const h = harness({}, (c) => (c.url.includes('historical/details') ? { body: hist } : undefined));
    await h.p.start();
    await h.p.whenStarted();
    const pending = h.p.candles({ symbol: 'NIFTY', kind: 'FUT', expiry: MONTHLY }, '1min', '2026-10-09', '2026-10-09');
    await h.timers.advance(3_000);
    expect((await pending).map((c) => [c.ts, c.volume])).toEqual([
      [ist('2026-10-09', '09:15'), 1500],
      [ist('2026-10-09', '09:17'), 300],
    ]);
  });
});
