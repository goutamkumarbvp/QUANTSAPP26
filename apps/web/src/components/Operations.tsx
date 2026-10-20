import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
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
import { formatAge, formatAsOf, formatDate, formatDateTime, isNum } from '../lib/format';
import { useApp, useTicks } from '../lib/store';
import { Card, cx, Dash, ErrorBox, Modal, NoData, Pill, Spinner } from './ui';

/**
 * Operations (Model F) on the dashboard: the Kotak login monitor, the 24×7 watchdog and the weekly
 * audit, each with its button. Status is GET /api/ops (public). The server decides, per request, whether
 * the caller may run the three actions (`operator.canOperate`, with the reason when not: signed out, a
 * guest, or a registered account that is not an operator) and withholds the details from non-operators
 * (`restricted`: journal events, check details, process figures, audit items) — only the states are
 * shown then. A status the browser has not refreshed for three polls (browser clock), or whose refresh
 * failed, is shown as STATUS UNKNOWN, never in its last green tones. Only a 404 means the server runs no
 * operations (e.g. the test fixture server): a neutral note.
 */

type Tone = 'muted' | 'up' | 'down' | 'accent' | 'warn';

export type OpsAction = 'login' | 'watchdog' | 'audit';

export const OPS_ACTIONS: Record<OpsAction, { path: string; label: string; busy: string }> = {
  login: { path: '/ops/login/relogin', label: 'Re-login now', busy: 'Logging in…' },
  watchdog: { path: '/ops/watchdog/run', label: 'Run health check', busy: 'Checking…' },
  audit: { path: '/ops/audit/run', label: 'Run audit now', busy: 'Starting…' },
};

/** GET /api/ops polling interval (every 3 s while an audit runs). */
export const OPS_POLL_MS = 10_000;
/** A status not refreshed for three polls (browser clock) is no longer vouched for: STATUS UNKNOWN. */
export const OPS_UNKNOWN_AFTER_MS = 3 * OPS_POLL_MS;
/** GET /api/ops is aborted after this long: a hung server must not leave the request pending. */
export const OPS_TIMEOUT_MS = 10_000;
/** The one line shown in place of what the server withholds from non-operators. */
export const OPS_WITHHELD = 'Details are shown to the operator account';

/** The answer to a button press: the server's message (or its error text) and the new status when it sent one. */
export interface OpsActionResult {
  ok: boolean;
  message: string;
  status?: OpsStatusResponse;
  /** The call itself was refused or failed (HTTP error, network): red. An answer with ok=false (the action ran and found a problem) is amber. */
  failed?: boolean;
}

/** GET /api/ops, cancelled with `signal` (React Query's) and aborted after OPS_TIMEOUT_MS. */
export function fetchOpsStatus(signal?: AbortSignal): Promise<OpsStatusResponse> {
  return api<OpsStatusResponse>('/ops', { signal, timeoutMs: OPS_TIMEOUT_MS });
}

/** What a button press does: POST the action with the session's token; a refused or failed call is a result with the server's reason. */
export async function runOpsAction(action: OpsAction): Promise<OpsActionResult> {
  try {
    const r = await api<OpsActionResponse>(OPS_ACTIONS[action].path, { method: 'POST' });
    return { ok: r.ok, message: r.message, status: r.status };
  } catch (e) {
    return { ok: false, failed: true, message: errorText(e) };
  }
}

/**
 * GET /api/ops answers 404 ("… are not running on this server") when operations do not run in that
 * server. Any other failure (503, 500, a timeout, the network) is a failed refresh, not this state.
 */
export function opsNotRunning(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/** Fallback for a server whose status has no `operator`: a guess from the session (null: may try). */
export function opsBlockedReason(user: UserProfile | null): string | null {
  if (!user) return 'Please sign in to run operations';
  if (user.guest) return 'Sign in with a registered account to run operations';
  return null;
}

/**
 * Whether the caller may run the actions: the server's answer (`status.operator`, the reason as the
 * visible text when not), or the session guess when the server does not send it. `signIn`: offer the
 * Settings link (signed out, a guest, or a reason asking to sign in).
 */
export function opsGate(status: OpsStatusResponse | undefined, user: UserProfile | null): { blocked: string | null; signIn: boolean } {
  const op = status?.operator;
  const blocked = op && typeof op.canOperate === 'boolean' ? (op.canOperate ? null : op.reason?.trim() || 'This account cannot run operations') : opsBlockedReason(user);
  return { blocked, signIn: !!blocked && (!user || user.guest || /sign in/i.test(blocked)) };
}

const FEED_TONE: Record<FeedState, Tone> = { LIVE: 'up', 'FEED STALE': 'warn', 'DATA UNAVAILABLE': 'down', 'MARKET CLOSED': 'muted' };
const LOGIN_TONE: Record<LoginMonitorState, Tone> = { LOGGED_IN: 'up', LOGGING_IN: 'accent', WAITING: 'warn', PAUSED: 'down', DISCONNECTED: 'down', NO_CREDENTIALS: 'warn', STOPPED: 'muted' };
const RESULT_CLASS = { ok: 'text-up', problem: 'text-warn', failed: 'text-down' } as const;
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

/** A state chip, or a grey STATUS UNKNOWN (the last state in its tooltip) when the status is not current. */
function StatePill({ state, tone, unknown }: { state: string; tone: Tone; unknown: boolean }) {
  if (!unknown) return <Pill tone={tone}>{state}</Pill>;
  return (
    <span title={`Last reported: ${state}`}>
      <Pill tone="muted">STATUS UNKNOWN</Pill>
    </span>
  );
}

/** The one muted line in place of the details the server withholds from non-operators. */
function Withheld() {
  return <p className="text-muted">{OPS_WITHHELD}</p>;
}

/** One of the three blocks: title and state, the details, and the button row. */
function OpsCard({ title, state, tone, unknown, children, footer }: { title: string; state: string; tone: Tone; unknown: boolean; children: ReactNode; footer: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col rounded-lg border border-line bg-panel2/40 p-3" aria-label={title}>
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <StatePill state={state} tone={tone} unknown={unknown} />
      </header>
      <div className="min-w-0 flex-1 space-y-2 text-xs">{children}</div>
      <footer className="mt-3 space-y-1 border-t border-line pt-2">{footer}</footer>
    </section>
  );
}

/** The action button with, under it, why it cannot be pressed and the answer of the last press. */
function ActionRow({ action, blocked, busy, result, onRun, signIn, extra }: { action: OpsAction; blocked: string | null; busy: boolean; result?: OpsActionResult; onRun: (a: OpsAction) => void; signIn: boolean; extra?: ReactNode }) {
  const a = OPS_ACTIONS[action];
  const reasonId = useId();
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary px-2.5 py-1 text-xs" disabled={busy || !!blocked} title={blocked ?? undefined} aria-describedby={blocked ? reasonId : undefined} onClick={() => !blocked && !busy && onRun(action)}>
          {busy ? a.busy : a.label}
        </button>
        {extra}
      </div>
      {blocked && (
        <p id={reasonId} className="text-2xs text-muted">
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
        <p role="status" aria-live="polite" className={cx('break-words text-2xs', RESULT_CLASS[result.ok ? 'ok' : result.failed ? 'failed' : 'problem'])}>
          {result.message}
        </p>
      )}
    </>
  );
}

/* --------------------------------------------------------------------------------------------- */

function LoginCard({ s, now, footer, unknown, restricted }: { s: OpsStatusResponse['login']; now: number; footer: ReactNode; unknown: boolean; restricted: boolean }) {
  // PAUSED stops the automatic logins only: a still-valid session keeps working (not "disconnected").
  const pausedWithSession = s.state === 'PAUSED' && s.sessionValid === true;
  return (
    <OpsCard title="Login Monitor" state={s.state} tone={pausedWithSession ? 'warn' : LOGIN_TONE[s.state] ?? 'muted'} unknown={unknown} footer={footer}>
      <p className="break-words">{s.detail}</p>
      {pausedWithSession && (
        <p className="break-words text-accent">
          Current session still valid: only the automatic logins are paused
          {isNum(s.tokenExpiresAt) && (
            <>
              {' '}· it expires <When ts={s.tokenExpiresAt} now={now} />
            </>
          )}
        </p>
      )}
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
        {s.lastFailure ? (
          <Row label="Last failure">
            <When ts={s.lastFailure.at} now={now} /> · {s.lastFailure.reason}
          </Row>
        ) : restricted ? null : (
          <Row label="Last failure"><span className="text-muted">none recorded</span></Row>
        )}
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
      {restricted ? (
        <Withheld />
      ) : (
        <Section title="Recent events">
          <Events events={s.events} now={now} none="No login events yet" />
        </Section>
      )}
    </OpsCard>
  );
}

function WatchdogCard({ s, now, footer, unknown, restricted }: { s: WatchdogStatus; now: number; footer: ReactNode; unknown: boolean; restricted: boolean }) {
  const p = s.process;
  const uptime = p ? formatUptime(p.uptimeSec) : null;
  return (
    <OpsCard title="24×7 Watchdog" state={s.state} tone={WATCHDOG_TONE[s.state] ?? 'muted'} unknown={unknown} footer={footer}>
      <div className="text-muted">
        Last run {s.lastRunAt === null ? 'not yet' : <When ts={s.lastRunAt} now={now} />} · every {Math.round(s.intervalMs / 1000)} s{s.supervised ? ' · supervised (restarts after a crash)' : ''}
      </div>
      {p && !restricted && (
        <Section title="Process">
          <div className="flex flex-wrap gap-x-3">
            <span>Uptime <b className="tabular-nums">{uptime ?? <Dash reason="Not reported" />}</b></span>
            <span>Heap <b className="tabular-nums">{Math.round(p.heapUsedMb)} / {Math.round(p.heapLimitMb)} MB</b></span>
            <span>
              Event-loop p99 <b className="tabular-nums">{isNum(p.eventLoopP99Ms) ? `${Math.round(p.eventLoopP99Ms)} ms` : <Dash reason="Not measured yet" />}</b>
            </span>
          </div>
        </Section>
      )}
      <Section title="Checks">
        {s.checks.length ? (
          <ul className="space-y-1">
            {s.checks.map((c) => (
              <li key={c.id} className="flex min-w-0 gap-1.5">
                {/* A result is only vouched for while the status is current. */}
                <span className="shrink-0"><Pill tone={unknown ? 'muted' : CHECK_TONE[c.result] ?? 'muted'}>{c.result}</Pill></span>
                <span className="min-w-0 break-words">
                  <span className="font-medium">{c.title}</span>
                  {!restricted && c.detail && <> <span className="text-muted">{c.detail}</span></>}
                  {!restricted && c.action && <span className="block text-accent">→ {c.action}</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <div className="text-muted">The first round of checks runs within {Math.round(s.intervalMs / 1000)} s of the start</div>
        )}
      </Section>
      {restricted ? (
        <Withheld />
      ) : (
        <Section title="Recent incidents">
          <Events events={s.incidents} now={now} none="No incidents" />
        </Section>
      )}
    </OpsCard>
  );
}

function AuditCard({ s, now, footer, onView, unknown, restricted }: { s: WeeklyAuditStatus; now: number; footer: ReactNode; onView: ((id: string) => void) | null; unknown: boolean; restricted: boolean }) {
  const last = s.last;
  const state = s.running ? 'RUNNING' : last ? last.verdict : 'NO REPORT';
  const tone: Tone = s.running ? 'accent' : last ? VERDICT_TONE[last.verdict] : 'muted';
  const history = s.history.filter((h) => h.id !== last?.id).slice(0, 3);
  return (
    <OpsCard title="Weekly Audit" state={state} tone={tone} unknown={unknown} footer={footer}>
      <div className="text-muted">{s.schedule}</div>
      <Row label="Next run">{isNum(s.nextRunAt) ? <When ts={s.nextRunAt} now={now} /> : <span className="text-muted">not scheduled</span>}</Row>
      {s.running && !unknown && (
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
                {onView && <button type="button" className="text-accent hover:underline" onClick={() => onView(h.id)}>View</button>}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {restricted && last && <Withheld />}
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
  /** When `status` was fetched (browser clock, React Query's dataUpdatedAt); 0 / absent: not known. */
  updatedAt?: number;
  /** The signed-in user (null: signed out): the fallback when the server sends no `operator`, and the Settings link. */
  user: UserProfile | null;
  busy?: Partial<Record<OpsAction, boolean>>;
  results?: Partial<Record<OpsAction, OpsActionResult>>;
  onRun: (a: OpsAction) => void;
}

/** Re-renders every `ms` so ages measured on the browser clock keep moving when nothing else changes (a hung server). */
function useTick(ms: number): void {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/** The panel from a status answer (or its error): chips, the three cards and their buttons. */
export function OperationsView({ status, error, loading, updatedAt, user, busy = {}, results = {}, onRun }: OperationsViewProps) {
  const serverNow = useTicks((st) => st.clock?.ts);
  const now = serverNow ?? Date.now();
  const [reportId, setReportId] = useState<string | null>(null);
  useTick(5000);
  // Freshness is measured on the browser clock: the server's websocket clock stops when the server hangs.
  const browserNow = Date.now();

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
  const restricted = s.restricted === true;
  const { blocked, signIn } = opsGate(s, user);
  // Audit reports (GET /api/ops/audit/reports/:id) are for the operator account only.
  const canView = !blocked && !restricted;
  const age = isNum(updatedAt) && updatedAt > 0 ? Math.max(0, browserNow - updatedAt) : null;
  const unknown = !!error || (age !== null && age > OPS_UNKNOWN_AFTER_MS);
  const row = (action: OpsAction, extraBlocked: string | null, extra?: ReactNode) => (
    <ActionRow action={action} blocked={blocked ?? extraBlocked} signIn={signIn} busy={!!busy[action]} result={results[action]} onRun={onRun} extra={extra} />
  );
  const chips = (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-2xs">
      <span className="inline-flex items-center gap-1">
        <span className="text-muted">Broker</span>
        <StatePill state={s.broker} tone={s.broker === 'CONNECTED' ? 'accent' : 'down'} unknown={unknown} />
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="text-muted">Market data</span>
        <StatePill state={s.feed} tone={FEED_TONE[s.feed] ?? 'muted'} unknown={unknown} />
      </span>
      {s.safety.mode === 'paper' && <Pill tone="accent">PAPER TRADING</Pill>}
      <span className="inline-flex items-center gap-1">
        <span className="text-muted">Live trading</span>
        <Pill tone="muted">{s.liveTrading}</Pill>
      </span>
    </div>
  );
  const fetched = age === null ? null : age < 5000 ? 'just now' : `${formatAge(age)} ago`;
  const notes = [
    fetched && `Status last fetched ${fetched}`,
    unknown && (error ? `STATUS UNKNOWN: could not refresh (${errorText(error)}) — showing the last status` : 'STATUS UNKNOWN: no answer from the server since — showing the last status'),
  ].filter(Boolean);
  return (
    <Card title="Operations" actions={chips}>
      {notes.length > 0 && (
        <div className={cx('mb-2 text-2xs', unknown ? 'text-warn' : 'text-muted')} title={isNum(updatedAt) && updatedAt > 0 ? `Fetched ${formatDateTime(updatedAt)} IST (this browser's clock)` : undefined}>
          {notes.join(' · ')}
        </div>
      )}
      <div className="grid gap-3 lg:grid-cols-3">
        <LoginCard s={s.login} now={now} unknown={unknown} restricted={restricted} footer={row('login', null)} />
        <WatchdogCard s={s.watchdog} now={now} unknown={unknown} restricted={restricted} footer={row('watchdog', null)} />
        <AuditCard
          s={s.audit}
          now={now}
          unknown={unknown}
          restricted={restricted}
          onView={canView ? setReportId : null}
          footer={row(
            'audit',
            s.audit.running ? 'An audit is running: wait for its report' : null,
            canView ? (
              <button type="button" className="btn-ghost px-2.5 py-1 text-xs" disabled={!s.audit.last} title={s.audit.last ? undefined : 'No audit report yet'} onClick={() => s.audit.last && setReportId(s.audit.last.id)}>
                View report
              </button>
            ) : undefined,
          )}
        />
      </div>
      {canView && <ReportModal id={reportId} last={s.audit.last} now={now} onClose={() => setReportId(null)} />}
    </Card>
  );
}

/**
 * The dashboard panel: polls GET /api/ops every 10 s (every 3 s while an audit runs) while the page is
 * visible; each request is cancelled with the query and aborted after OPS_TIMEOUT_MS.
 */
export function OperationsPanel() {
  const user = useApp((st) => st.user);
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['ops'],
    queryFn: ({ signal }) => fetchOpsStatus(signal),
    // Background tabs do not poll (refetchIntervalInBackground is off).
    refetchInterval: (query) => (opsNotRunning(query.state.error) ? 60_000 : query.state.data?.audit.running ? 3000 : OPS_POLL_MS),
  });
  // Who may operate is decided per request: ask again when the account changes (sign in / out).
  const uid = user?.id ?? null;
  const seenUid = useRef(uid);
  useEffect(() => {
    if (seenUid.current === uid) return;
    seenUid.current = uid;
    void qc.invalidateQueries({ queryKey: ['ops'] });
  }, [uid, qc]);
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
  return <OperationsView status={q.data} error={q.error} loading={q.isLoading} updatedAt={q.dataUpdatedAt} user={user} busy={busy} results={results} onRun={(a) => void run(a)} />;
}
