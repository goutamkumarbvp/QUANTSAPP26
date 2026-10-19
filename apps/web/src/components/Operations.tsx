import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  istParts,
  type AuditItemStatus,
  type AuditReport,
  type AuditReportSummary,
  type FeedState,
  type LoginMonitorState,
  type OpsActionResponse,
  type OpsEvent,
  type OpsStatusResponse,
  type UserProfile,
  type WatchdogCheckResult,
  type WatchdogStatus,
  type WeeklyAuditStatus,
} from '@q26/core';
import { api, ApiError, errorText } from '../lib/api';
import { formatAsOf, formatDate, formatDateTime, isNum } from '../lib/format';
import { useApp, useTicks } from '../lib/store';
import { Card, cx, Dash, ErrorBox, Modal, NoData, Pill, Spinner } from './ui';

/**
 * Operations (Model F) on the dashboard: the Kotak login monitor, the 24×7 watchdog and the weekly
 * audit, each with its button. Status is GET /api/ops (public); the three actions need a registered
 * account. A server without operations (e.g. the test fixture server) answers 404: a neutral note.
 */

type Tone = 'muted' | 'up' | 'down' | 'accent' | 'warn';

export type OpsAction = 'login' | 'watchdog' | 'audit';

export const OPS_ACTIONS: Record<OpsAction, { path: string; label: string; busy: string }> = {
  login: { path: '/ops/login/relogin', label: 'Re-login now', busy: 'Logging in…' },
  watchdog: { path: '/ops/watchdog/run', label: 'Run health check', busy: 'Checking…' },
  audit: { path: '/ops/audit/run', label: 'Run audit now', busy: 'Starting…' },
};

/** The answer to a button press: the server's message (or its error text) and the new status when it sent one. */
export interface OpsActionResult {
  ok: boolean;
  message: string;
  status?: OpsStatusResponse;
}

/** What a button press does: POST the action with the session's token; a refused or failed call is a result with the server's reason. */
export async function runOpsAction(action: OpsAction): Promise<OpsActionResult> {
  try {
    const r = await api<OpsActionResponse>(OPS_ACTIONS[action].path, { method: 'POST' });
    return { ok: r.ok, message: r.message, status: r.status };
  } catch (e) {
    return { ok: false, message: errorText(e) };
  }
}

/** GET /api/ops answers 404 (503 on older servers) when operations do not run in that server. */
export function opsNotRunning(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 503);
}

/** Why the current user cannot run operations (null: a registered account can). */
export function opsBlockedReason(user: UserProfile | null): string | null {
  if (!user) return 'Please sign in to run operations';
  if (user.guest) return 'Sign in with a registered account to run operations';
  return null;
}

const FEED_TONE: Record<FeedState, Tone> = { LIVE: 'up', 'FEED STALE': 'warn', 'DATA UNAVAILABLE': 'down', 'MARKET CLOSED': 'muted' };
const LOGIN_TONE: Record<LoginMonitorState, Tone> = { LOGGED_IN: 'up', LOGGING_IN: 'accent', WAITING: 'warn', PAUSED: 'down', DISCONNECTED: 'down', NO_CREDENTIALS: 'warn', STOPPED: 'muted' };
const WATCHDOG_TONE: Record<WatchdogStatus['state'], Tone> = { HEALTHY: 'up', DEGRADED: 'warn', CRITICAL: 'down', STARTING: 'muted' };
const CHECK_TONE: Record<WatchdogCheckResult, Tone> = { ok: 'up', warn: 'warn', fail: 'down', fixed: 'accent', skipped: 'muted' };
const AUDIT_TONE: Record<AuditItemStatus, Tone> = { PASS: 'up', FIXED: 'accent', WARN: 'warn', FAIL: 'down', SKIPPED: 'muted' };
const VERDICT_TONE: Record<AuditReport['verdict'], Tone> = { HEALTHY: 'up', ATTENTION: 'warn', FAILING: 'down' };
const LEVEL_TONE: Record<OpsEvent['level'], string> = { info: 'text-muted', warn: 'text-warn', error: 'text-down' };
const AUDIT_ORDER: AuditItemStatus[] = ['PASS', 'FIXED', 'WARN', 'FAIL', 'SKIPPED'];

/** "45 s", "12 min", "3 h 05 min", "2 d 4 h" (no thousands separators: these are not prices). */
export function formatUptime(sec: number | null | undefined): string | null {
  if (!isNum(sec) || sec < 0) return null;
  const s = Math.floor(sec);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')} min`;
  return `${Math.floor(s / 86_400)} d ${Math.floor((s % 86_400) / 3600)} h`;
}

const istDate = (ts: number) => formatDate(istParts(ts).date, true);

/** An IST time ("10:42:05" today, "yesterday 15:30", "24 Oct 10:00"); full date and time as tooltip. */
function When({ ts, now }: { ts: number | null | undefined; now: number }) {
  if (!isNum(ts)) return <Dash />;
  return (
    <span className="tabular-nums" title={`${formatDateTime(ts)} IST`}>
      {formatAsOf(ts, now)}
    </span>
  );
}

/** A label and its value on one line. */
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-wrap gap-x-1.5">
      <span className="text-muted">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-0.5 text-2xs font-semibold uppercase tracking-wide text-muted">{title}</div>
      {children}
    </div>
  );
}

function Events({ events, now, none }: { events: OpsEvent[]; now: number; none: string }) {
  if (!events.length) return <div className="text-muted">{none}</div>;
  return (
    <ul className="space-y-0.5">
      {events.slice(0, 3).map((e, i) => (
        <li key={`${e.ts}-${i}`} className="break-words">
          <span className="text-muted"><When ts={e.ts} now={now} /></span> <span className={cx('font-medium', LEVEL_TONE[e.level])}>{e.type}</span> {e.message}
        </li>
      ))}
    </ul>
  );
}

/** Small "PASS 12 · FIXED 1 …" counts of an audit. */
function AuditCounts({ summary }: { summary: AuditReport['summary'] }) {
  return (
    <span className="inline-flex flex-wrap gap-1">
      {AUDIT_ORDER.map((k) => (
        <Pill key={k} tone={(summary[k] ?? 0) > 0 ? AUDIT_TONE[k] : 'muted'}>
          {k} {summary[k] ?? 0}
        </Pill>
      ))}
    </span>
  );
}

/** One of the three blocks: title and state, the details, and the button row. */
function OpsCard({ title, state, tone, children, footer }: { title: string; state: string; tone: Tone; children: ReactNode; footer: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col rounded-lg border border-line bg-panel2/40 p-3" aria-label={title}>
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Pill tone={tone}>{state}</Pill>
      </header>
      <div className="min-w-0 flex-1 space-y-2 text-xs">{children}</div>
      <footer className="mt-3 space-y-1 border-t border-line pt-2">{footer}</footer>
    </section>
  );
}

/** The action button with, under it, why it cannot be pressed and the answer of the last press. */
function ActionRow({ action, blocked, busy, result, onRun, signIn, extra }: { action: OpsAction; blocked: string | null; busy: boolean; result?: OpsActionResult; onRun: (a: OpsAction) => void; signIn: boolean; extra?: ReactNode }) {
  const a = OPS_ACTIONS[action];
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary px-2.5 py-1 text-xs" disabled={busy || !!blocked} title={blocked ?? undefined} onClick={() => !blocked && !busy && onRun(action)}>
          {busy ? a.busy : a.label}
        </button>
        {extra}
      </div>
      {blocked && (
        <p className="text-2xs text-muted">
          {blocked}
          {signIn && (
            <>
              {' · '}
              <Link to="/settings" className="text-accent hover:underline">Settings</Link>
            </>
          )}
        </p>
      )}
      {result && (
        <p role="status" aria-live="polite" className={cx('break-words text-2xs', result.ok ? 'text-up' : 'text-down')}>
          {result.message}
        </p>
      )}
    </>
  );
}

/* --------------------------------------------------------------------------------------------- */

function LoginCard({ s, now, footer }: { s: OpsStatusResponse['login']; now: number; footer: ReactNode }) {
  return (
    <OpsCard title="Login Monitor" state={s.state} tone={LOGIN_TONE[s.state] ?? 'muted'} footer={footer}>
      <p className="break-words">{s.detail}</p>
      <div className="text-muted">
        Checks every {Math.round(s.checkEveryMs / 1000)} s · last check <When ts={s.lastCheckAt} now={now} />
      </div>
      <Section title="Today">
        <div className="flex flex-wrap gap-x-3">
          <span>Logins <b className="tabular-nums">{s.today.logins}</b></span>
          <span>Failures <b className={cx('tabular-nums', s.today.failures > 0 && 'text-warn')}>{s.today.failures}</b></span>
          <span>Session losses <b className={cx('tabular-nums', s.today.sessionLosses > 0 && 'text-warn')}>{s.today.sessionLosses}</b></span>
        </div>
      </Section>
      <div className="space-y-0.5">
        <Row label="Last failure">
          {s.lastFailure ? (
            <>
              <When ts={s.lastFailure.at} now={now} /> · {s.lastFailure.reason}
            </>
          ) : (
            <span className="text-muted">none recorded</span>
          )}
        </Row>
        {s.consecutiveFailures > 0 && <Row label="Failed attempts since the last login">{s.consecutiveFailures}</Row>}
        {s.state === 'LOGGED_IN' ? (
          <>
            {isNum(s.loggedInAt) && <Row label="Logged in"><When ts={s.loggedInAt} now={now} /></Row>}
            {isNum(s.nextReloginAt) && <Row label="Next scheduled re-login"><When ts={s.nextReloginAt} now={now} /></Row>}
          </>
        ) : (
          <Row label="Next attempt">
            {isNum(s.nextAttemptAt) ? <When ts={s.nextAttemptAt} now={now} /> : <span className="text-muted">{s.state === 'NO_CREDENTIALS' ? 'none: credentials missing' : s.state === 'PAUSED' ? 'paused: waits for Re-login now' : 'not armed'}</span>}
          </Row>
        )}
      </div>
      <Section title="Recent events">
        <Events events={s.events} now={now} none="No login events yet" />
      </Section>
    </OpsCard>
  );
}

function WatchdogCard({ s, now, footer }: { s: WatchdogStatus; now: number; footer: ReactNode }) {
  const p = s.process;
  const uptime = formatUptime(p.uptimeSec);
  return (
    <OpsCard title="24×7 Watchdog" state={s.state} tone={WATCHDOG_TONE[s.state]} footer={footer}>
      <div className="text-muted">
        Last run {s.lastRunAt === null ? 'not yet' : <When ts={s.lastRunAt} now={now} />} · every {Math.round(s.intervalMs / 1000)} s{s.supervised ? ' · supervised (restarts after a crash)' : ''}
      </div>
      <Section title="Process">
        <div className="flex flex-wrap gap-x-3">
          <span>Uptime <b className="tabular-nums">{uptime ?? <Dash reason="Not reported" />}</b></span>
          <span>Heap <b className="tabular-nums">{Math.round(p.heapUsedMb)} / {Math.round(p.heapLimitMb)} MB</b></span>
          <span>
            Event-loop p99 <b className="tabular-nums">{isNum(p.eventLoopP99Ms) ? `${Math.round(p.eventLoopP99Ms)} ms` : <Dash reason="Not measured yet" />}</b>
          </span>
        </div>
      </Section>
      <Section title="Checks">
        {s.checks.length ? (
          <ul className="space-y-1">
            {s.checks.map((c) => (
              <li key={c.id} className="flex min-w-0 gap-1.5">
                <span className="shrink-0"><Pill tone={CHECK_TONE[c.result]}>{c.result}</Pill></span>
                <span className="min-w-0 break-words">
                  <span className="font-medium">{c.title}</span> <span className="text-muted">{c.detail}</span>
                  {c.action && <span className="block text-accent">→ {c.action}</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-muted">The first round of checks runs within {Math.round(s.intervalMs / 1000)} s of the start</div>
        )}
      </Section>
      <Section title="Recent incidents">
        <Events events={s.incidents} now={now} none="No incidents" />
      </Section>
    </OpsCard>
  );
}

function AuditCard({ s, now, footer, onView }: { s: WeeklyAuditStatus; now: number; footer: ReactNode; onView: (id: string) => void }) {
  const last = s.last;
  const state = s.running ? 'RUNNING' : last ? last.verdict : 'NO REPORT';
  const tone: Tone = s.running ? 'accent' : last ? VERDICT_TONE[last.verdict] : 'muted';
  const history = s.history.filter((h) => h.id !== last?.id).slice(0, 3);
  return (
    <OpsCard title="Weekly Audit" state={state} tone={tone} footer={footer}>
      <div className="text-muted">{s.schedule}</div>
      <Row label="Next run">{isNum(s.nextRunAt) ? <When ts={s.nextRunAt} now={now} /> : <span className="text-muted">not scheduled</span>}</Row>
      {s.running && (
        <div className="flex items-center gap-2 text-accent">
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-accent border-t-transparent" aria-hidden />
          Audit running…
        </div>
      )}
      <Section title="Last report">
        {last ? (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Pill tone={VERDICT_TONE[last.verdict]}>{last.verdict}</Pill>
              <span className="text-muted">
                {last.trigger} · finished <When ts={last.finishedAt} now={now} />
              </span>
            </div>
            <AuditCounts summary={last.summary} />
            <div className="text-muted">
              Window {istDate(last.window.from)} – {istDate(last.window.to)}
            </div>
          </div>
        ) : (
          <div className="text-muted">No audit has run yet</div>
        )}
      </Section>
      {history.length > 0 && (
        <Section title="History">
          <ul className="space-y-1">
            {history.map((h: AuditReportSummary) => (
              <li key={h.id} className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted"><When ts={h.finishedAt} now={now} /></span>
                <Pill tone={VERDICT_TONE[h.verdict]}>{h.verdict}</Pill>
                <span className="text-muted">{h.trigger} · {h.summary.FAIL ?? 0} fail · {h.summary.WARN ?? 0} warn · {h.summary.FIXED ?? 0} fixed</span>
                <button type="button" className="text-accent hover:underline" onClick={() => onView(h.id)}>View</button>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </OpsCard>
  );
}

/** The full report: its items (ID, area, check, status, detail, automatic fix). */
export function AuditReportView({ report, now }: { report: AuditReport; now: number }) {
  return (
    <div className="space-y-3 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill tone={VERDICT_TONE[report.verdict]}>{report.verdict}</Pill>
        <AuditCounts summary={report.summary} />
      </div>
      <div className="space-y-0.5 text-muted">
        <div>
          Window {istDate(report.window.from)} – {istDate(report.window.to)} · {report.trigger}
        </div>
        <div>
          Started <When ts={report.startedAt} now={now} /> · finished <When ts={report.finishedAt} now={now} />
        </div>
      </div>
      {report.items.length ? (
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th>ID</th>
                <th>Area</th>
                <th>Check</th>
                <th>Status</th>
                <th>Detail</th>
                <th>Automatic fix</th>
              </tr>
            </thead>
            <tbody>
              {report.items.map((it) => (
                <tr key={it.id}>
                  <td className="text-muted">{it.id}</td>
                  <td>{it.area}</td>
                  <td className="min-w-[10rem] whitespace-normal font-medium">{it.title}</td>
                  <td><Pill tone={AUDIT_TONE[it.status]}>{it.status}</Pill></td>
                  <td className="min-w-[14rem] whitespace-normal">{it.detail}</td>
                  <td className="min-w-[10rem] whitespace-normal">{it.fix ?? <Dash reason="No automatic fix for this check" />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-muted">The report has no items</div>
      )}
    </div>
  );
}

function ReportModal({ id, last, now, onClose }: { id: string | null; last: AuditReport | null; now: number; onClose: () => void }) {
  const isLast = !!id && last?.id === id;
  const q = useQuery({
    queryKey: ['ops-report', id],
    queryFn: () => api<AuditReport>(`/ops/audit/reports/${encodeURIComponent(id!)}`),
    enabled: !!id && !isLast,
    staleTime: Infinity,
  });
  const report = isLast ? last : q.data;
  return (
    <Modal open={!!id} onClose={onClose} title="Weekly audit report" wide>
      {report ? <AuditReportView report={report} now={now} /> : q.error ? <ErrorBox error={q.error} /> : <Spinner />}
    </Modal>
  );
}

/* --------------------------------------------------------------------------------------------- */

export interface OperationsViewProps {
  status?: OpsStatusResponse;
  error?: unknown;
  loading?: boolean;
  /** Why the user cannot run operations (guest / signed out), null when they can. */
  blocked: string | null;
  busy?: Partial<Record<OpsAction, boolean>>;
  results?: Partial<Record<OpsAction, OpsActionResult>>;
  onRun: (a: OpsAction) => void;
}

/** The panel from a status answer (or its error): chips, the three cards and their buttons. */
export function OperationsView({ status, error, loading, blocked, busy = {}, results = {}, onRun }: OperationsViewProps) {
  const serverNow = useTicks((st) => st.clock?.ts);
  const now = serverNow ?? Date.now();
  const [reportId, setReportId] = useState<string | null>(null);

  if (opsNotRunning(error)) {
    const why = errorText(error);
    return (
      <Card title="Operations">
        <NoData compact title="Operations are not running on this server" reason={/not running/i.test(why) ? undefined : why} hint="The login monitor, the 24×7 watchdog and the weekly audit run in the production server (npm start)." />
      </Card>
    );
  }
  if (!status) {
    return <Card title="Operations">{error ? <ErrorBox error={`Operations status not available: ${errorText(error)}`} /> : loading !== false ? <Spinner label="Loading operations…" /> : null}</Card>;
  }

  const s = status;
  const row = (action: OpsAction, extraBlocked: string | null, extra?: ReactNode) => (
    <ActionRow action={action} blocked={blocked ?? extraBlocked} signIn={!!blocked} busy={!!busy[action]} result={results[action]} onRun={onRun} extra={extra} />
  );
  const chips = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs">
      <span className="inline-flex items-center gap-1">
        <span className="text-muted">Broker</span>
        <Pill tone={s.broker === 'CONNECTED' ? 'accent' : 'down'}>{s.broker}</Pill>
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="text-muted">Market data</span>
        <Pill tone={FEED_TONE[s.feed] ?? 'muted'}>{s.feed}</Pill>
      </span>
      {s.safety.mode === 'paper' && <Pill tone="accent">PAPER TRADING</Pill>}
      <span className="inline-flex items-center gap-1">
        <span className="text-muted">Live trading</span>
        <Pill tone="muted">{s.liveTrading}</Pill>
      </span>
    </div>
  );
  return (
    <Card title="Operations" actions={chips}>
      {error ? <div className="mb-2 text-2xs text-warn">Could not refresh — showing the last status ({errorText(error)})</div> : null}
      <div className="grid gap-3 lg:grid-cols-3">
        <LoginCard s={s.login} now={now} footer={row('login', null)} />
        <WatchdogCard s={s.watchdog} now={now} footer={row('watchdog', null)} />
        <AuditCard
          s={s.audit}
          now={now}
          onView={setReportId}
          footer={row(
            'audit',
            s.audit.running ? 'An audit is running: wait for its report' : null,
            <button type="button" className="btn-ghost px-2.5 py-1 text-xs" disabled={!s.audit.last} title={s.audit.last ? undefined : 'No audit report yet'} onClick={() => s.audit.last && setReportId(s.audit.last.id)}>
              View report
            </button>,
          )}
        />
      </div>
      <ReportModal id={reportId} last={s.audit.last} now={now} onClose={() => setReportId(null)} />
    </Card>
  );
}

/** The dashboard panel: polls GET /api/ops every 10 s (every 3 s while an audit runs) while the page is visible. */
export function OperationsPanel() {
  const user = useApp((st) => st.user);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['ops'],
    queryFn: () => api<OpsStatusResponse>('/ops'),
    // Background tabs do not poll (refetchIntervalInBackground is off).
    refetchInterval: (query) => (opsNotRunning(query.state.error) ? 60_000 : query.state.data?.audit.running ? 3000 : 10_000),
  });
  const [busy, setBusy] = useState<Partial<Record<OpsAction, boolean>>>({});
  const [results, setResults] = useState<Partial<Record<OpsAction, OpsActionResult>>>({});
  const run = async (a: OpsAction) => {
    setBusy((b) => ({ ...b, [a]: true }));
    setResults((r) => ({ ...r, [a]: undefined }));
    const r = await runOpsAction(a);
    if (r.status) qc.setQueryData(['ops'], r.status);
    setResults((x) => ({ ...x, [a]: r }));
    setBusy((b) => ({ ...b, [a]: false }));
  };
  return <OperationsView status={q.data} error={q.error} loading={q.isLoading} blocked={opsBlockedReason(user)} busy={busy} results={results} onRun={(a) => void run(a)} />;
}
