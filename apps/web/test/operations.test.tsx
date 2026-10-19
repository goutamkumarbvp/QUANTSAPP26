import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditReport, MarketClockInfo, OpsActionResponse, OpsStatusResponse, UserProfile } from '@q26/core';
import { AuditReportView, formatUptime, OperationsPanel, OperationsView, runOpsAction, type OpsActionResult } from '../src/components/Operations';
import { ApiError } from '../src/lib/api';
import { useApp, useTicks } from '../src/lib/store';

beforeAll(() => {
  const error = console.error;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    if (!String(args[0]).includes('useLayoutEffect does nothing on the server')) error(...args);
  });
});

const ts = Date.UTC(2026, 9, 19, 5, 12, 5); // Mon 19 Oct 2026 10:42:05 IST
const IST = (d: number, h: number, m: number) => Date.UTC(2026, 9, d, h, m) - 330 * 60_000;
const clock: MarketClockInfo = { ts, date: '2026-10-19', time: '10:42:05', status: 'open', sessionMinute: 87 };

const registered: UserProfile = { id: 'u1', name: 'Ops', email: 'ops@example.com', guest: false, createdAt: ts, settings: {} as UserProfile['settings'] };
const guest: UserProfile = { ...registered, id: 'g1', name: 'Guest', email: '', guest: true };

// zustand renders the store's initial state on the server: seed that object in place.
function setUser(user: UserProfile | null) {
  Object.assign(useApp.getInitialState(), { user });
  useApp.setState({ user });
}
beforeEach(() => {
  Object.assign(useTicks.getInitialState(), { clock });
  useTicks.setState({ clock });
  setUser(registered);
});

const report: AuditReport = {
  id: 'audit-20261017',
  trigger: 'schedule',
  window: { from: IST(10, 10, 0), to: IST(17, 10, 0) },
  startedAt: IST(17, 10, 0),
  finishedAt: IST(17, 10, 2),
  summary: { PASS: 20, FIXED: 1, WARN: 2, FAIL: 0, SKIPPED: 3 },
  verdict: 'ATTENTION',
  items: [
    { id: 'A01', area: 'Data', title: 'EOD files complete for the week', status: 'WARN', detail: '1 session missing the F&O file' },
    { id: 'A02', area: 'Cache', title: 'Expired cached answers', status: 'FIXED', detail: '14 expired answers held', fix: 'dropped 14 cached answers' },
    { id: 'A03', area: 'Security', title: 'No credential in logs', status: 'PASS', detail: 'no NEO_* value in the journals' },
  ],
};
const older = { id: 'audit-20261010', trigger: 'schedule' as const, finishedAt: IST(10, 10, 2), verdict: 'HEALTHY' as const, summary: { PASS: 24, FIXED: 0, WARN: 0, FAIL: 0, SKIPPED: 2 } };

const status = (over: Partial<OpsStatusResponse> = {}): OpsStatusResponse => ({
  login: {
    state: 'WAITING',
    detail: 'Not logged in: Kotak refused the TOTP. Next automatic attempt 10:45:00',
    checkEveryMs: 30_000,
    lastCheckAt: ts - 5000,
    nextAttemptAt: ts + 175_000,
    lastFailure: { at: ts - 60_000, reason: 'Kotak refused the TOTP' },
    consecutiveFailures: 2,
    today: { logins: 1, failures: 2, sessionLosses: 1 },
    events: [
      { ts: ts - 60_000, source: 'login', level: 'warn', type: 'LOGIN_FAILED', message: 'Kotak refused the TOTP' },
      { ts: ts - 120_000, source: 'login', level: 'warn', type: 'SESSION_LOST', message: 'Kotak session lost: token expired; logging in again' },
      { ts: ts - 3_600_000, source: 'login', level: 'info', type: 'LOGIN_OK', message: 'Logged in to Kotak Neo' },
      { ts: ts - 7_200_000, source: 'login', level: 'info', type: 'OLDEST_EVENT', message: 'not shown: only the last three' },
    ],
  },
  watchdog: {
    state: 'DEGRADED',
    intervalMs: 30_000,
    lastRunAt: ts - 10_000,
    runs: 42,
    supervised: true,
    process: { pid: 4242, uptimeSec: 7_500, rssMb: 180.4, heapUsedMb: 95.6, heapLimitMb: 4144, eventLoopP99Ms: 12.4 },
    checks: [
      { id: 'memory', title: 'Memory', result: 'ok', detail: 'heap 96 MB of 4144 MB (2%), RSS 180 MB' },
      { id: 'feed', title: 'Market feed', result: 'fixed', detail: 'FEED STALE: no tick for 95 s during market hours', action: 'market-data socket restarted with the current session' },
      { id: 'login', title: 'Broker login', result: 'warn', detail: 'Not logged in (the login monitor is handling it)' },
      { id: 'instruments', title: 'Instrument master', result: 'fail', detail: 'not loaded; needs a Kotak login to download' },
      { id: 'storage', title: 'Disk and storage', result: 'skipped', detail: 'persistence off (PERSIST=false)' },
    ],
    incidents: [{ ts: ts - 20_000, source: 'watchdog', level: 'warn', type: 'FEED_RESTARTED', message: 'Market feed: no tick for 95 s' }],
  },
  audit: { running: false, schedule: 'Every Saturday 10:00 IST (covers Saturday to Saturday)', nextRunAt: IST(24, 10, 0), last: report, history: [{ ...report }, older] },
  broker: 'DISCONNECTED',
  feed: 'FEED STALE',
  safety: { mode: 'paper', autoExecutionToBroker: false, liveOrderAuthority: false, brokerSubmission: false },
  liveTrading: 'NOT READY',
  ...over,
});

const decode = (html: string) => html.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<');
const wrap = (node: React.ReactElement, qc = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } })) =>
  decode(
    renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <MemoryRouter>{node}</MemoryRouter>
      </QueryClientProvider>,
    ),
  );

/** The panel as the dashboard renders it, from a cached GET /api/ops answer (or its error). */
function panel(answer: OpsStatusResponse | ApiError): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  if (answer instanceof ApiError) qc.getQueryCache().build(qc, { queryKey: ['ops'] }).setState({ status: 'error', error: answer, fetchStatus: 'idle', errorUpdateCount: 1, errorUpdatedAt: 1 });
  else qc.setQueryData(['ops'], answer);
  return wrap(<OperationsPanel />, qc);
}

/** The <button> whose label is `label`: its attributes. */
const button = (html: string, label: string) => new RegExp(`<button([^>]*)>${label}</button>`).exec(html)?.[1];
/** The HTML of one of the three cards. */
const card = (html: string, title: string) => {
  const start = html.indexOf(`aria-label="${title}"`);
  const end = html.indexOf('</section>', start);
  return start < 0 ? '' : html.slice(start, end);
};
const chip = (tone: string, text: string) => `<span class="chip ${tone === 'muted' ? 'bg-line text-muted' : `bg-${tone}/15 text-${tone}`}">${text}</span>`;
const BAD = /NaN|undefined|Infinity|>null<|\bnull\b/;

describe('Operations panel', () => {
  it('renders the status chips and the three cards from GET /api/ops', () => {
    const html = panel(status());
    expect(html).not.toMatch(BAD);
    expect(html).toContain('>Operations</h2>');
    // Header chips with their exact labels; nothing looks live (green) while the feed is not LIVE.
    expect(html).toContain(chip('down', 'DISCONNECTED'));
    expect(html).toContain(chip('warn', 'FEED STALE'));
    expect(html).toContain(chip('accent', 'PAPER TRADING'));
    expect(html).toContain(chip('muted', 'NOT READY'));
    expect(html).not.toMatch(/text-up">(LIVE|CONNECTED|FEED STALE|DATA UNAVAILABLE|MARKET CLOSED)</);

    const login = card(html, 'Login Monitor');
    expect(login).toContain(chip('warn', 'WAITING'));
    expect(login).toContain('Not logged in: Kotak refused the TOTP');
    expect(login).toContain('Checks every 30 s');
    expect(login).toMatch(/Logins <b[^>]*>1<\/b>/);
    expect(login).toMatch(/Failures <b[^>]*>2<\/b>/);
    expect(login).toMatch(/Session losses <b[^>]*>1<\/b>/);
    expect(login).toContain('10:41:05</span> · Kotak refused the TOTP'); // last failure, IST
    expect(login).toContain('10:45:00'); // next attempt, IST
    expect(login).toContain('SESSION_LOST');
    expect(login).not.toContain('OLDEST_EVENT'); // the last three events only

    const dog = card(html, '24×7 Watchdog');
    expect(dog).toContain(chip('warn', 'DEGRADED'));
    expect(dog).toContain('2 h 05 min');
    expect(dog).toContain('96 / 4144 MB');
    expect(dog).toContain('12 ms');
    for (const [tone, r] of [['up', 'ok'], ['accent', 'fixed'], ['warn', 'warn'], ['down', 'fail'], ['muted', 'skipped']]) expect(dog).toContain(chip(tone, r));
    expect(dog).toContain('→ market-data socket restarted with the current session');
    expect(dog).toContain('FEED_RESTARTED');

    const audit = card(html, 'Weekly Audit');
    expect(audit).toContain('Every Saturday 10:00 IST');
    expect(audit).toContain('24 Oct 10:00'); // next run
    expect(audit).toContain(chip('warn', 'ATTENTION'));
    for (const c of ['PASS 20', 'FIXED 1', 'WARN 2', 'FAIL 0', 'SKIPPED 3']) expect(audit).toContain(c);
    expect(audit).toContain('Window 10 Oct 2026 – 17 Oct 2026');
    expect(audit).toContain(chip('up', 'HEALTHY')); // the older report in the history
    expect(audit).not.toContain('Audit running');

    // A registered user can press every button.
    for (const b of ['Re-login now', 'Run health check', 'Run audit now', 'View report']) expect(button(html, b)).not.toContain('disabled');
    expect(html).not.toContain('Sign in with a registered account');
    // Process figures are not prices: no thousands separators.
    expect(html).not.toMatch(/\d,\d{3}/);
  });

  it('a LIVE feed is the only green market-data chip; CONNECTED is not green', () => {
    const html = panel(status({ broker: 'CONNECTED', feed: 'LIVE' }));
    expect(html).toContain(chip('up', 'LIVE'));
    expect(html).toContain(chip('accent', 'CONNECTED'));
    expect(panel(status({ feed: 'DATA UNAVAILABLE' }))).toContain(chip('down', 'DATA UNAVAILABLE'));
    expect(panel(status({ feed: 'MARKET CLOSED' }))).toContain(chip('muted', 'MARKET CLOSED'));
  });

  it('a guest sees the buttons disabled with the reason as visible text', () => {
    setUser(guest);
    const html = panel(status());
    for (const b of ['Re-login now', 'Run health check', 'Run audit now']) expect(button(html, b)).toContain('disabled=""');
    // Shown under each button (not only as a tooltip), with the way to sign in.
    expect(html.match(/<p class="text-2xs text-muted">Sign in with a registered account to run operations/g)).toHaveLength(3);
    expect(html).toContain('href="/settings"');
    // Reading the status stays available.
    expect(html).toContain(chip('warn', 'WAITING'));

    setUser(null);
    const out = panel(status());
    expect(button(out, 'Run health check')).toContain('disabled=""');
    expect(out).toContain('Please sign in to run operations');
  });

  it('PAUSED logins look like a failure and Re-login stays available to a registered user', () => {
    const html = panel(status({ login: { ...status().login, state: 'PAUSED', detail: 'Automatic login paused: Kotak refused 5 logins in a row. Check NEO_* and press Re-login now', nextAttemptAt: undefined } }));
    const login = card(html, 'Login Monitor');
    expect(login).toContain(chip('down', 'PAUSED'));
    expect(login).toContain('Automatic login paused');
    expect(button(html, 'Re-login now')).not.toContain('disabled');
  });

  it('while an audit runs: running indicator, "Run audit now" disabled with the reason', () => {
    const html = panel(status({ audit: { ...status().audit, running: true } }));
    const audit = card(html, 'Weekly Audit');
    expect(audit).toContain('Audit running…');
    expect(audit).toContain(chip('accent', 'RUNNING'));
    expect(button(html, 'Run audit now')).toContain('disabled=""');
    expect(audit).toContain('An audit is running: wait for its report');
    expect(button(html, 'Run health check')).not.toContain('disabled');
  });

  it('before the first audit and the first watchdog round: blanks with the reason, no zeros made up', () => {
    const s = status();
    const html = panel({
      ...s,
      watchdog: { ...s.watchdog, state: 'STARTING', lastRunAt: null, checks: [], incidents: [], process: { ...s.watchdog.process, eventLoopP99Ms: null } },
      audit: { ...s.audit, last: null, history: [], nextRunAt: null },
      login: { ...s.login, events: [], lastFailure: undefined },
    });
    expect(html).not.toMatch(BAD);
    expect(html).toContain('Last run not yet');
    expect(html).toContain('The first round of checks runs within 30 s');
    expect(html).toContain('No incidents');
    expect(html).toContain('No audit has run yet');
    expect(html).toContain('No login events yet');
    expect(html).toContain('aria-label="Not available: Not measured yet"');
    expect(button(html, 'View report')).toContain('disabled=""');
  });

  it('404 (and 503) from GET /api/ops: the neutral "not running" state, not an error', () => {
    for (const err of [
      new ApiError('Operations (login monitor, watchdog, weekly audit) are not running on this server', 404),
      new ApiError('Internal error', 503),
    ]) {
      const html = panel(err);
      expect(html).toContain('Operations are not running on this server');
      expect(html).toContain('role="status"');
      expect(html).not.toContain('text-down'); // not the red error box
      expect(html).not.toContain('Run health check');
      expect(html).not.toMatch(BAD);
    }
  });

  it('any other failure before a first answer is shown as an error, without crashing', () => {
    const html = panel(new ApiError('Internal error', 500));
    expect(html).toContain('Operations status not available: Internal error');
  });

  it('the full audit report lists every item (ID, area, check, status, detail, automatic fix)', () => {
    const html = wrap(<AuditReportView report={report} now={ts} />);
    for (const h of ['ID', 'Area', 'Check', 'Status', 'Detail', 'Automatic fix']) expect(html).toContain(`<th>${h}</th>`);
    expect(html).toContain('A02');
    expect(html).toContain('Expired cached answers');
    expect(html).toContain(chip('accent', 'FIXED'));
    expect(html).toContain('dropped 14 cached answers');
    expect(html).toContain('aria-label="Not available: No automatic fix for this check"');
    expect(html).not.toMatch(BAD);
  });

  it('formatUptime', () => {
    expect(formatUptime(45)).toBe('45 s');
    expect(formatUptime(720)).toBe('12 min');
    expect(formatUptime(7_500)).toBe('2 h 05 min');
    expect(formatUptime(3 * 86_400 + 4 * 3600)).toBe('3 d 4 h');
    expect(formatUptime(null)).toBeNull();
  });
});

describe('Operations buttons', () => {
  afterEach(() => vi.unstubAllGlobals());
  const store: Record<string, string> = { 'q26-token': 'tok-123' };
  const stubStorage = () => vi.stubGlobal('localStorage', { getItem: (k: string) => store[k] ?? null, setItem: () => undefined, removeItem: () => undefined });

  /** The view as the panel renders it after a press: the status and message the server returned. */
  const after = (action: 'login' | 'watchdog' | 'audit', r: OpsActionResult, s = status()) =>
    wrap(<OperationsView status={r.status ?? s} blocked={null} results={{ [action]: r }} onRun={() => undefined} />);

  it('a press POSTs the action with the bearer token and shows the returned message next to the button', async () => {
    stubStorage();
    const fresh = status({ watchdog: { ...status().watchdog, state: 'HEALTHY', runs: 43 } });
    const body: OpsActionResponse = { ok: true, message: 'Health check done: 9 checks, 1 fixed, 0 need attention', status: fresh };
    const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    const r = await runOpsAction('watchdog');
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/ops/watchdog/run');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-123');
    expect(r).toEqual({ ok: true, message: body.message, status: fresh });

    const html = after('watchdog', r);
    const dog = card(html, '24×7 Watchdog');
    expect(dog).toMatch(/Run health check<\/button>[\s\S]*<p role="status" aria-live="polite" class="break-words text-2xs text-up">Health check done: 9 checks, 1 fixed, 0 need attention<\/p>/);
    expect(dog).toContain(chip('up', 'HEALTHY')); // refreshed from the returned status
    expect(card(html, 'Login Monitor')).not.toContain('Health check done');
  });

  it('a refused press shows the server error text (403 for a guest, 401 signed out) in red', async () => {
    stubStorage();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Sign in with a registered account to run operations' }), { status: 403 })));
    const r = await runOpsAction('audit');
    expect(r).toEqual({ ok: false, message: 'Sign in with a registered account to run operations' });
    const audit = card(after('audit', r), 'Weekly Audit');
    expect(audit).toContain('class="break-words text-2xs text-down">Sign in with a registered account to run operations</p>');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Please sign in' }), { status: 401 })));
    expect(await runOpsAction('login')).toEqual({ ok: false, message: 'Please sign in' });
  });

  it('an answer with ok=false (e.g. no credentials) is shown as a failure with its message', async () => {
    stubStorage();
    const body: OpsActionResponse = { ok: false, message: 'Kotak credentials missing in .env: NEO_CONSUMER_KEY. Add them to .env and restart the server.', status: status() };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
    const r = await runOpsAction('login');
    const login = card(after('login', r), 'Login Monitor');
    expect(login).toMatch(/Re-login now<\/button>[\s\S]*text-down">Kotak credentials missing in \.env: NEO_CONSUMER_KEY/);
  });
});
