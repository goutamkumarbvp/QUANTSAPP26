/**
 * Model F operations: terminal log format, operations journal, login monitor, watchdog, weekly
 * audit and the /api/ops routes. Every broker/exchange interaction is a fake (no network, no
 * credentials); the "secret" values below are test strings.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { istTs, type LoginMonitorStatus, type OpsStatusResponse } from '@q26/core';
import { buildApp } from '../src/app';
import { authSecretFrom, loadConfig } from '../src/config';
import type { KotakSessionStatus } from '../src/live/kotak/session';
import type { FeedHealth } from '../src/live/types';
import { formatLogLine, istWhen, serverLoggerOptions } from '../src/log';
import type { Operations } from '../src/ops';
import { OpsJournal } from '../src/ops/journal';
import { LoginMonitor, MANUAL_SLOW_AFTER_REJECTIONS, type LoginTarget } from '../src/ops/login-monitor';
import { Watchdog, type WatchdogTarget } from '../src/ops/watchdog';
import { WeeklyAudit, lastScheduledRun, nextScheduledRun, type AuditTarget } from '../src/ops/weekly-audit';
import { createServices } from '../src/services';
import { Db } from '../src/store/db';
import { FakeProvider, loadSampleBook } from './support/fake-provider';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

function tmpDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'q26-ops-'));
  cleanup.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Saturday 2026-10-17 10:00 IST and Monday 2026-10-19 11:00 IST. */
const SAT_10 = istTs('2026-10-17', 600);
const MON_11 = istTs('2026-10-19', 660);
const manualTimers = () => {
  const armed: { fn: () => void; ms: number }[] = [];
  return {
    armed,
    setInterval: (fn: () => void, ms: number) => (armed.push({ fn, ms }), armed.length),
    clearInterval: () => undefined,
    setTimeout: (fn: () => void, ms: number) => (armed.push({ fn, ms }), armed.length),
    clearTimeout: () => undefined,
  };
};

/* ------------------------------------------------------------------------------------------ */

describe('terminal log format', () => {
  it('turns pino JSON into "HH:MM:SS LEVEL message" in IST, keeping error messages', () => {
    const t = istTs('2026-10-19', 9 * 60 + 15, 7);
    expect(formatLogLine(JSON.stringify({ level: 30, time: t, msg: 'hello' }))).toBe('09:15:07 INFO  hello');
    expect(formatLogLine(JSON.stringify({ level: 40, time: t, msg: 'feed down' }))).toBe('09:15:07 WARN  feed down');
    const err = formatLogLine(JSON.stringify({ level: 50, time: t, msg: 'boom', err: { message: 'bad', stack: 'Error: bad\n    at x (a.ts:1)' } }));
    expect(err.split('\n')[0]).toBe('09:15:07 ERROR boom: bad');
    expect(err).toContain('at x (a.ts:1)');
    expect(formatLogLine('not json')).toBe('not json');
    expect(formatLogLine(JSON.stringify({ level: 40, time: t, msg: 'x' }), { color: true })).toBe('\x1b[33m09:15:07 WARN  x\x1b[0m');
  });

  it('reads LOG_LEVEL / LOG_FORMAT / NO_COLOR and writes one line per record', () => {
    expect(serverLoggerOptions({ LOG_FORMAT: 'json', LOG_LEVEL: 'debug' }, { write: () => true })).toEqual({ level: 'debug' });
    expect(serverLoggerOptions({ LOG_LEVEL: 'nonsense' }, { write: () => true }).level).toBe('info');
    const out: string[] = [];
    const o = serverLoggerOptions({ NO_COLOR: '1' }, { write: (c: string) => out.push(c), isTTY: true });
    o.stream!.write(`${JSON.stringify({ level: 30, time: 0, msg: 'a' })}\n${JSON.stringify({ level: 30, time: 0, msg: 'b' })}\n`);
    expect(out).toEqual(['05:30:00 INFO  a\n', '05:30:00 INFO  b\n']);
  });

  it('shows times in IST: the clock on the same day, the date otherwise', () => {
    expect(istWhen(istTs('2026-10-19', 600, 30), istTs('2026-10-19', 60))).toBe('10:00:30 IST');
    expect(istWhen(istTs('2026-10-20', 525), istTs('2026-10-19', 60))).toBe('20 Oct 08:45 IST');
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('AUTH_SECRET', () => {
  it('ignores a missing, placeholder or short secret (a random one signs tokens instead)', () => {
    expect(authSecretFrom(undefined)).toMatchObject({ authSecretIssue: 'unset' });
    const weak = authSecretFrom('change-me');
    expect(weak.authSecretIssue).toBe('weak');
    expect(weak.authSecret).not.toBe('change-me');
    expect(weak.authSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(authSecretFrom('short-1234').authSecretIssue).toBe('weak');
    expect(authSecretFrom('a-long-random-value-0123456789')).toEqual({ authSecret: 'a-long-random-value-0123456789' });
  });
});

describe('operations journal', () => {
  it('writes scrubbed JSON lines per IST day, reads a window back, prunes old days', () => {
    const dir = tmpDir();
    let now = istTs('2026-10-01', 600);
    const j = new OpsJournal({ dataDir: dir, scrub: (t) => t.split('SECRET-123').join('[redacted]'), now: () => now });
    j.add({ source: 'login', level: 'warn', type: 'LOGIN_FAILED', message: 'bad SECRET-123 here' });
    now = istTs('2026-10-19', 600);
    j.add({ source: 'watchdog', level: 'info', type: 'X', message: 'ok' });
    const files = fs.readdirSync(path.join(dir, 'ops', 'journal')).sort();
    expect(files).toEqual(['2026-10-01.jsonl', '2026-10-19.jsonl']);
    const all = fs.readFileSync(path.join(dir, 'ops', 'journal', files[0]), 'utf8');
    expect(all).not.toContain('SECRET-123');
    expect(all).toContain('[redacted]');
    expect(j.read(istTs('2026-09-30', 0), now + 1).map((e) => e.type)).toEqual(['LOGIN_FAILED', 'X']);
    expect(j.list({ minLevel: 'warn' }).map((e) => e.type)).toEqual(['LOGIN_FAILED']);
    expect(j.prune(7)).toBe(1);
    expect(j.files()).toEqual(['2026-10-19.jsonl']);
  });
});

/* ------------------------------------------------------------------------------------------ */

function fakeLoginTarget(init: Partial<KotakSessionStatus> = {}) {
  const st: { s: KotakSessionStatus; job?: { running: boolean; nextAt?: number }; creds: boolean } = { s: { loggedIn: false, feedUrlKnown: false, ...init }, creds: true };
  const listeners = new Set<(s: KotakSessionStatus) => void>();
  const calls = { ensureLogin: 0, ensureRelogin: 0, loginNow: [] as { force?: boolean }[] };
  let loginNowResult: () => Promise<'logged-in' | 'already-logged-in' | 'in-progress'> = async () => 'logged-in';
  const target: LoginTarget = {
    credentials: () => (st.creds ? { ok: true } : { ok: false, error: 'Kotak credentials missing in .env: NEO_MPIN' }),
    status: () => st.s,
    loginPending: () => !!st.job,
    loginJob: () => st.job,
    ensureLogin: () => {
      calls.ensureLogin++;
      if (st.job || st.s.loggedIn) return false;
      st.job = { running: false, nextAt: Math.max(0, st.s.loginBlockedUntil ?? 0) };
      return true;
    },
    ensureRelogin: () => (calls.ensureRelogin++, false),
    loginNow: (opts) => (calls.loginNow.push(opts), loginNowResult()),
    onLoginChange: (fn) => (listeners.add(fn), () => listeners.delete(fn)),
  };
  const emit = (s: Partial<KotakSessionStatus>) => {
    st.s = { feedUrlKnown: false, ...s } as KotakSessionStatus;
    for (const fn of listeners) fn(st.s);
  };
  return { st, target, calls, emit, setLoginNow: (f: typeof loginNowResult) => (loginNowResult = f) };
}

describe('login monitor', () => {
  it('arms a login at once when the session is lost, and journals failures and successes', () => {
    let now = MON_11;
    const journal = new OpsJournal({ dataDir: null, now: () => now });
    const f = fakeLoginTarget({ loggedIn: true, loggedInAt: now - 3_600_000 });
    const m = new LoginMonitor(f.target, journal, { now: () => now, timers: manualTimers() });
    m.start();
    expect(m.status().state).toBe('LOGGED_IN');

    // Lost (token rejected): logs in again immediately, not at the next 5 s check.
    f.emit({ loggedIn: false, error: 'session rejected (401)' });
    expect(f.calls.ensureLogin).toBe(1);
    expect(f.st.job).toBeDefined();
    expect(journal.list().map((e) => e.type)).toEqual(['LOGIN_ARMED', 'SESSION_LOST']);
    expect(m.status().state).toBe('LOGGING_IN');

    // The attempt fails (network): WAITING with the next attempt time.
    now += 2_000;
    f.st.job = { running: false, nextAt: now + 5_000 };
    f.emit({ loggedIn: false, error: 'Kotak TOTP login failed: network error (fetch failed)', loginBlockedUntil: now + 5_000 });
    const s = m.status();
    expect(s.state).toBe('WAITING');
    expect(s.nextAttemptAt).toBe(now + 5_000);
    expect(s.consecutiveFailures).toBe(1);
    expect(s.today).toEqual({ logins: 0, failures: 1, sessionLosses: 1 });
    expect(s.lastFailure?.reason).toContain('network error');

    // Then it succeeds.
    f.st.job = undefined;
    f.emit({ loggedIn: true, loggedInAt: now + 5_000 });
    expect(m.status()).toMatchObject({ state: 'LOGGED_IN', consecutiveFailures: 0, today: { logins: 1, failures: 1, sessionLosses: 1 } });
    expect(m.status().events[0].type).toBe('LOGIN_OK');
  });

  it('checks every 5 s and arms a login when nothing is pending', () => {
    const timers = manualTimers();
    const f = fakeLoginTarget({ loggedIn: false, error: 'no session' });
    const m = new LoginMonitor(f.target, new OpsJournal({ dataDir: null }), { now: () => MON_11, timers });
    m.start();
    expect(timers.armed[0].ms).toBe(5_000);
    expect(f.calls.ensureLogin).toBe(1);
    timers.armed[0].fn();
    expect(f.calls.ensureLogin).toBe(2); // pending now: the fake does not arm twice
  });

  it('"Re-login now": skips the back-off; presses 20 s apart, 2 min apart after 3 refusals in a row', async () => {
    let now = MON_11;
    const f = fakeLoginTarget({ loggedIn: false, error: 'x', loginFailures: { rejected: 1, network: 0 } });
    const m = new LoginMonitor(f.target, new OpsJournal({ dataDir: null }), { now: () => now, timers: manualTimers() });
    expect(await m.relogin()).toEqual({ ok: true, message: 'Logged in to Kotak Neo' });
    expect(f.calls.loginNow).toEqual([{ force: true }]);
    expect((await m.relogin()).message).toMatch(/try again in \d+ s/);
    expect(f.calls.loginNow.length).toBe(1);

    now += 120_000;
    f.st.s = { loggedIn: false, feedUrlKnown: false, error: 'Invalid MPIN', loginFailures: { rejected: MANUAL_SLOW_AFTER_REJECTIONS, network: 0 } };
    f.setLoginNow(async () => {
      throw new Error('Kotak MPIN validate failed: Invalid MPIN (HTTP 401)');
    });
    const r = await m.relogin();
    expect(f.calls.loginNow[1]).toEqual({ force: true });
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Check the NEO_* values in .env');
    now += 60_000;
    expect((await m.relogin()).message).toMatch(/try again in 60 s .*can lock the account/);
    expect(f.calls.loginNow.length).toBe(2);
    now += 60_000;
    await m.relogin();
    expect(f.calls.loginNow.length).toBe(3);

    f.st.s = { ...f.st.s, loginPaused: 'Kotak refused 5 logins in a row (last: Invalid MPIN); fix the NEO_* values in .env and restart, or press Re-login now' };
    expect(m.status()).toMatchObject({ state: 'PAUSED' });
    expect(m.status().detail).toContain('Automatic login paused');

    f.st.creds = false;
    expect((await m.relogin()).message).toContain('NEO_MPIN');
    expect(m.status().state).toBe('NO_CREDENTIALS');
  });
});

/* ------------------------------------------------------------------------------------------ */

function fakeWatchdogTarget() {
  const s = {
    market: 'open',
    feed: { loggedIn: true, connected: true, lastTickTs: MON_11 - 1_000, subscribed: 100 } as FeedHealth,
    login: { state: 'LOGGED_IN', detail: 'Logged in' } as LoginMonitorStatus,
    restarts: [] as string[],
    restartOk: true,
    cleared: [] as boolean[],
    checkLogin: 0,
    pruned: 0,
    refdataDate: '2026-10-19',
  };
  const target: WatchdogTarget = {
    marketStatus: () => s.market,
    feed: () => s.feed,
    login: () => s.login,
    checkLogin: () => void s.checkLogin++,
    restartFeed: async (why) => (s.restarts.push(why), s.restartOk),
    clearCaches: (o) => (s.cleared.push(!!o.all), 7),
    jobs: () => ({ login: { attempts: 0, running: false } }),
    eod: () => null,
    refdata: () => ({ ready: true, date: s.refdataDate, underlyings: 200, listings: 90_000, warnings: [] }),
    refreshInstrumentMaster: async () => undefined,
    pruneJournal: () => (s.pruned++, 2),
  };
  return { s, target };
}

describe('watchdog', () => {
  it('restarts a feed that stopped ticking during market hours, at most once per 5 min', async () => {
    let now = MON_11;
    const { s, target } = fakeWatchdogTarget();
    const journal = new OpsJournal({ dataDir: null, now: () => now });
    const w = new Watchdog(target, journal, { dataDir: null, now: () => now, timers: manualTimers() });
    let feed = (await w.run()).find((c) => c.id === 'feed')!;
    expect(feed).toMatchObject({ result: 'ok' });
    expect(feed.detail).toContain('LIVE');

    s.feed = { ...s.feed, lastTickTs: now - 120_000 };
    feed = (await w.run()).find((c) => c.id === 'feed')!;
    expect(feed.result).toBe('fixed');
    expect(feed.detail).toContain('FEED STALE');
    expect(s.restarts.length).toBe(1);

    now += 60_000;
    feed = (await w.run()).find((c) => c.id === 'feed')!;
    expect(feed.result).toBe('fail');
    expect(s.restarts.length).toBe(1); // cooldown
    expect(w.status().state).toBe('CRITICAL');
    expect(journal.list({ source: 'watchdog' }).map((e) => e.type)).toEqual(['FEED_FAIL', 'FEED_FIXED']);

    s.market = 'closed';
    feed = (await w.run()).find((c) => c.id === 'feed')!;
    expect(feed.result).toBe('ok');
    expect(feed.detail).toContain('no ticks expected');
  });

  it('drops caches when the heap is high and asks the supervisor for a restart when it stays critical', async () => {
    const { s, target } = fakeWatchdogTarget();
    let heap = 0.8;
    const restarts: string[] = [];
    const w = new Watchdog(target, new OpsJournal({ dataDir: null }), {
      dataDir: null,
      now: () => MON_11,
      timers: manualTimers(),
      supervised: true,
      requestRestart: (why) => restarts.push(why),
      memory: () => ({ rss: 900e6, heapUsed: heap * 1e9, heapLimit: 1e9 }),
    });
    const mem = async () => (await w.run()).find((c) => c.id === 'memory')!;
    const first = await mem();
    expect(first.result).toBe('fixed');
    expect(s.cleared).toEqual([false]);
    heap = 0.95;
    expect((await mem()).result).toBe('fail');
    expect((await mem()).result).toBe('fail');
    expect(restarts).toEqual([]);
    const third = await mem();
    expect(third.action).toContain('restart requested');
    expect(restarts.length).toBe(1);
    expect(s.cleared.slice(1)).toEqual([true, true, true]);
  });

  it('arms a login when the session is lost with nothing armed; reports a missing instrument master', async () => {
    const { s, target } = fakeWatchdogTarget();
    s.login = { state: 'DISCONNECTED', detail: 'Not logged in' } as LoginMonitorStatus;
    s.feed = { loggedIn: false, connected: false, lastTickTs: null, subscribed: 0 };
    s.refdataDate = '2026-10-16';
    const w = new Watchdog(target, new OpsJournal({ dataDir: null }), { dataDir: null, now: () => MON_11, timers: manualTimers() });
    const checks = await w.run();
    expect(checks.find((c) => c.id === 'login')).toMatchObject({ result: 'fixed', action: 'login monitor armed a login' });
    expect(s.checkLogin).toBe(1);
    expect(checks.find((c) => c.id === 'feed')).toMatchObject({ result: 'skipped' });
    expect(checks.find((c) => c.id === 'feed')!.detail).toContain('DATA UNAVAILABLE');
    expect(checks.find((c) => c.id === 'instruments')).toMatchObject({ result: 'warn' });
  });

  it('checks DATA_DIR and frees space when the disk is low', async () => {
    const dir = tmpDir();
    const { s, target } = fakeWatchdogTarget();
    let free = 50e9;
    const w = new Watchdog(target, new OpsJournal({ dataDir: null }), { dataDir: dir, now: () => MON_11, timers: manualTimers(), freeDiskBytes: () => free });
    expect((await w.run()).find((c) => c.id === 'storage')).toMatchObject({ result: 'ok' });
    free = 100e6;
    const st = (await w.run()).find((c) => c.id === 'storage')!;
    expect(st.result).toBe('fail');
    expect(st.action).toContain('removed 2 old journal file(s)');
    expect(s.pruned).toBe(1);
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('weekly audit schedule', () => {
  it('runs Saturdays 10:00 IST', () => {
    expect(lastScheduledRun(SAT_10)).toBe(SAT_10);
    expect(lastScheduledRun(SAT_10 - 1)).toBe(SAT_10 - 7 * 86_400_000);
    expect(lastScheduledRun(MON_11)).toBe(SAT_10);
    expect(nextScheduledRun(MON_11)).toBe(SAT_10 + 7 * 86_400_000);
  });
});

const SECRET = 'TEST-MPIN-998877';

function auditSetup(opts: { dbLeak?: boolean; orderMethod?: boolean; offline?: boolean } = {}) {
  const dir = tmpDir();
  const now = MON_11;
  const journal = new OpsJournal({ dataDir: dir, now: () => now });
  // A credential value that reached the journal (e.g. an old version wrote it): must be redacted.
  fs.mkdirSync(path.join(dir, 'ops', 'journal'), { recursive: true });
  fs.appendFileSync(path.join(dir, 'ops', 'journal', '2026-10-15.jsonl'), `${JSON.stringify({ ts: istTs('2026-10-15', 600), source: 'login', level: 'warn', type: 'LOGIN_FAILED', message: `bad ${SECRET}` })}\n`);
  journal.add({ ts: istTs('2026-10-15', 610), source: 'login', level: 'info', type: 'LOGIN_OK', message: 'ok' });
  const db = new Db(dir);
  const loaded = new Set(['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'].flatMap((d) => ['index', 'nseFo', 'nseCm', 'bseFo', 'participants'].map((s) => `${s}|${d}`)));
  loaded.delete('nseCm|2026-10-14'); // one file missing
  const loads: string[] = [];
  const forgotten: string[] = [];
  // A corrupt EOD file of the week (cm 2026-10-15).
  fs.mkdirSync(path.join(dir, 'eod', 'cm'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'eod', 'cm', '2026-10-15.json'), '{"RELIANCE": {"close": 14');
  fs.writeFileSync(path.join(dir, 'eod', 'cm', '2026-10-16.json'), '{}');
  if (opts.dbLeak) fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ users: {}, note: SECRET }));
  const sessions = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-19'];
  const t: AuditTarget = {
    dataDir: dir,
    calendar: { sessions: (from, to) => sessions.filter((d) => d >= from && d <= to), session: (ts) => ({ date: ts >= istTs('2026-10-19', 0) ? '2026-10-19' : '2026-10-17', status: 'open' }) },
    eod: {
      isLoaded: (s, d) => loaded.has(`${s}|${d}`),
      wasUnavailable: () => false,
      status: () => ({ backfill: { running: false, days: 30, lastRunAt: null, datesMissing: 0 } }) as unknown as ReturnType<NonNullable<AuditTarget['eod']>['status']>,
      forget: (s, d) => (forgotten.push(`${s}|${d}`), loaded.delete(`${s}|${d}`)),
      loadDateQueued: async (d, need) =>
        need!.map((s) => {
          loads.push(`${s}|${d}`);
          if (opts.offline) return s === 'participants' ? { source: s, date: d, outcome: 'waiting' as const, reason: 'NIFTY close not loaded' } : { source: s, date: d, outcome: 'failed' as const, reason: 'x.csv: fetch failed', network: true };
          loaded.add(`${s}|${d}`);
          return { source: s, date: d, outcome: 'loaded' as const };
        }),
    },
    history: { forgetDate: (k, d) => void forgotten.push(`history:${k}|${d}`), dir: () => path.join(dir, 'eod') },
    intradaySessions: () => ['2026-10-13', '2026-10-14', '2026-10-16'],
    refdata: () => ({ ready: true, date: '2026-10-19', underlyings: 200, listings: 90_000, warnings: [] }),
    refreshInstrumentMaster: async () => undefined,
    login: () => ({ state: 'LOGGED_IN', detail: 'Logged in' }) as LoginMonitorStatus,
    secrets: () => [SECRET],
    db: opts.dbLeak ? null : db,
    config: { host: '0.0.0.0', authSecretSet: false, persist: true, invalidHolidays: [] },
    journal,
    clearCaches: () => 3,
    brokerClientMethods: () => ['constructor', 'quotes', 'optionChain', 'historical', ...(opts.orderMethod ? ['placeOrder'] : [])],
  };
  const audit = new WeeklyAudit(t, { now: () => now, timers: manualTimers(), log: { info: () => undefined, warn: () => undefined } });
  return { dir, audit, loads, forgotten, db, journal };
}

describe('weekly audit', () => {
  it('audits the week, applies the safe fixes and keeps a report', async () => {
    const { dir, audit, loads, forgotten } = auditSetup();
    const r = await audit.run('manual');
    const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
    expect(by['SAFE-1'].status).toBe('PASS');
    expect(by['SEC-1']).toMatchObject({ status: 'FIXED' });
    expect(fs.readFileSync(path.join(dir, 'ops', 'journal', '2026-10-15.jsonl'), 'utf8')).not.toContain(SECRET);
    expect(by['CFG-2'].status).toBe('WARN'); // HOST 0.0.0.0 and no AUTH_SECRET
    expect(by['DATA-1']).toMatchObject({ status: 'FIXED' });
    expect(loads).toContain('nseCm|2026-10-14');
    expect(by['DATA-2']).toMatchObject({ status: 'FIXED' });
    expect(forgotten).toEqual(expect.arrayContaining(['history:cm|2026-10-15', 'nseCm|2026-10-15']));
    expect(fs.existsSync(path.join(dir, 'eod', 'cm', '2026-10-15.json'))).toBe(false);
    expect(fs.readdirSync(path.join(dir, 'ops', 'quarantine')).length).toBe(1);
    expect(by['DATA-3'].status).toBe('WARN'); // 2026-10-12 and 2026-10-15 were not recorded
    expect(by['DATA-3'].detail).toContain('never synthesised');
    expect(by['DATA-4'].status).toBe('PASS');
    expect(by['LEDGER-1'].status).toBe('PASS');
    expect(by['OPS-1'].status).toBe('PASS');
    expect(by['DEP-1'].status).toBe('SKIPPED');
    expect(r.verdict).toBe('ATTENTION');
    expect(r.window.to - r.window.from).toBe(7 * 86_400_000);
    // Saved and listed.
    expect(fs.existsSync(path.join(dir, 'ops', 'audits', `${r.id}.json`))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'ops', 'audits', `${r.id}.md`), 'utf8')).toContain('| SAFE-1 | Safety |');
    expect(audit.status().history.map((h) => h.id)).toEqual([r.id]);
    expect(audit.report(r.id)?.items.length).toBe(r.items.length);
    expect(audit.report('../../etc')).toBeNull();
    // Nothing in the reports carries the credential value.
    for (const f of fs.readdirSync(path.join(dir, 'ops', 'audits'))) expect(fs.readFileSync(path.join(dir, 'ops', 'audits', f), 'utf8')).not.toContain(SECRET);
  });

  it('fails the safety check when the broker client gains an order method, and reports (does not edit) a leak in db.json', async () => {
    const { audit } = auditSetup({ orderMethod: true, dbLeak: true });
    const r = await audit.run('manual');
    const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
    expect(by['SAFE-1']).toMatchObject({ status: 'FAIL' });
    expect(by['SAFE-1'].detail).toContain('placeOrder');
    expect(by['SEC-1'].status).toBe('FAIL');
    expect(by['SEC-1'].detail).toContain('db.json');
    expect(by['SEC-1'].detail).not.toContain(SECRET);
    expect(r.verdict).toBe('FAILING');
  });

  it('fails the ledger check while a corrupt db.json copy is waiting to be restored', async () => {
    const { audit, dir } = auditSetup();
    fs.writeFileSync(path.join(dir, 'db.json.corrupt-1760000000000'), '{');
    const r = await audit.run('manual');
    const l = r.items.find((i) => i.id === 'LEDGER-1')!;
    expect(l.status).toBe('FAIL');
    expect(l.detail).toContain('db.json.corrupt-1760000000000');
  });

  it('does not wait on downloads when the last backfill found NSE/BSE unreachable', async () => {
    const { audit, loads } = auditSetup();
    const t = (audit as unknown as { t: AuditTarget }).t;
    t.eod!.status = () => ({ backfill: { running: false, days: 30, lastRunAt: 1, datesMissing: 5, stoppedOffline: 'fetch failed (ENOTFOUND)' } }) as unknown as ReturnType<NonNullable<AuditTarget['eod']>['status']>;
    const r = await audit.run('manual');
    const d1 = r.items.find((i) => i.id === 'DATA-1')!;
    expect(d1.status).toBe('FAIL');
    expect(d1.detail).toContain('unreachable at the last backfill');
    expect(loads.filter((l) => l.endsWith('2026-10-14'))).toEqual([]);
  });

  it('stops downloading after the first date when NSE/BSE cannot be reached', async () => {
    const { audit, loads } = auditSetup({ offline: true });
    const r = await audit.run('manual');
    const d1 = r.items.find((i) => i.id === 'DATA-1')!;
    expect(d1.status).toBe('FAIL');
    expect(d1.detail).toContain('NSE/BSE unreachable (fetch failed)');
    expect(new Set(loads.map((l) => l.split('|')[1])).size).toBeLessThanOrEqual(2); // DATA-1's first date (+ DATA-2's corrupt one)
  });

  it('rebuilds a broken email index from the users', async () => {
    const { audit, db } = auditSetup();
    db.data.users.u1 = { id: 'u1', name: 'A', email: ' A@Example.com', guest: false, passwordHash: 'h', salt: 's', createdAt: 0, settings: {} as never, openingBalance: 0 };
    db.data.emailIndex = { 'stale@example.com': 'gone' };
    const r = await audit.run('manual');
    expect(r.items.find((i) => i.id === 'LEDGER-1')).toMatchObject({ status: 'FIXED' });
    expect(db.data.emailIndex).toEqual({ 'a@example.com': 'u1' });
  });

  it('arms a catch-up run when the last Saturday audit was missed, the Saturday run otherwise; manual runs have a cooldown', async () => {
    const { audit } = auditSetup();
    audit.start();
    expect(audit.status().nextRunAt).toBe(MON_11 + 3 * 60_000);
    const first = audit.runNow();
    expect(first.started).toBe(true);
    await first.done;
    expect(audit.runNow()).toMatchObject({ started: false });
    audit.stop();
    const { audit: again } = auditSetup();
    await again.run('manual');
    again.start();
    expect(again.status().nextRunAt).toBe(nextScheduledRun(MON_11));
  });
});

/* ------------------------------------------------------------------------------------------ */

describe('/api/ops routes', () => {
  async function app(withOps: boolean) {
    const p = new FakeProvider();
    loadSampleBook(p);
    const svc = createServices(loadConfig({ persist: false, authSecret: 'test-secret' }), { provider: p });
    const relogin = vi.fn(async () => ({ ok: true, message: 'Logged in to Kotak Neo' }));
    const status = { broker: 'DISCONNECTED', feed: 'DATA UNAVAILABLE', liveTrading: 'NOT READY' } as unknown as OpsStatusResponse;
    const ops = {
      status: () => status,
      login: { relogin },
      watchdog: { run: async () => [{ id: 'memory', title: 'Memory', result: 'fixed', detail: 'x' }] },
      audit: { runNow: () => ({ started: true, message: 'Audit started', done: Promise.resolve() }), report: (id: string) => (id === 'r1' ? { id } : null) },
    } as unknown as Operations;
    const a = await buildApp(svc, { serveWeb: false, ...(withOps ? { ops } : {}) });
    cleanup.push(() => p.dispose(), () => svc.stop(), () => a.close());
    return { a, svc, relogin };
  }
  const token = (body: string) => (JSON.parse(body) as { token: string }).token;

  it('status is public; the actions need a registered account', async () => {
    const { a, relogin } = await app(true);
    expect((await a.inject({ method: 'GET', url: '/api/ops' })).json()).toMatchObject({ broker: 'DISCONNECTED', liveTrading: 'NOT READY' });
    expect((await a.inject({ method: 'POST', url: '/api/ops/login/relogin' })).statusCode).toBe(401);
    const guest = token((await a.inject({ method: 'POST', url: '/api/auth/guest' })).body);
    const g = await a.inject({ method: 'POST', url: '/api/ops/login/relogin', headers: { authorization: `Bearer ${guest}` } });
    expect(g.statusCode).toBe(403);
    expect(g.json().error).toContain('registered account');
    expect(relogin).not.toHaveBeenCalled();
    const reg = token((await a.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'Op', email: 'op@example.com', password: 'secret1' } })).body);
    const auth = { authorization: `Bearer ${reg}` };
    expect((await a.inject({ method: 'POST', url: '/api/ops/login/relogin', headers: auth })).json()).toMatchObject({ ok: true, message: 'Logged in to Kotak Neo' });
    expect((await a.inject({ method: 'POST', url: '/api/ops/watchdog/run', headers: auth })).json().message).toContain('1 fixed');
    expect((await a.inject({ method: 'POST', url: '/api/ops/audit/run', headers: auth })).json()).toMatchObject({ ok: true, message: 'Audit started' });
    expect((await a.inject({ method: 'GET', url: '/api/ops/audit/reports/r1' })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/api/ops/audit/reports/nope' })).statusCode).toBe(404);
  });

  it('limits sign-in attempts per client address (429 with Retry-After)', async () => {
    const { a } = await app(false);
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await a.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x@example.com', password: 'wrong-1' } })).statusCode);
    expect(codes.slice(0, 30).every((c) => c === 401)).toBe(true);
    expect(codes[30]).toBe(429);
    const r = await a.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x@example.com', password: 'wrong-1' } });
    expect(r.json().error).toMatch(/Too many requests/);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('answers 404 with the reason when operations are not running', async () => {
    const { a } = await app(false);
    const r = await a.inject({ method: 'GET', url: '/api/ops' });
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toContain('not running');
  });
});
