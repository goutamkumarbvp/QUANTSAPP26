/**
 * Weekly deep audit (Model F #3): every Saturday at 10:00 IST (market closed) it audits the week
 * since the previous Saturday, applies the fixes that are safe to apply automatically, and keeps a
 * report (DATA_DIR/ops/audits/<id>.json and .md; the dashboard shows the latest). A server that was
 * down on Saturday runs the missed audit a few minutes after it starts. "Run audit now" runs it on
 * demand over the last seven days.
 *
 * Automatic fixes: missing end-of-day files are downloaded again; corrupt EOD files are moved to
 * DATA_DIR/ops/quarantine and downloaded again; a stale instrument master is downloaded again; the
 * paper-trading email index is rebuilt from the users; credential values found in the operations
 * journal or reports are redacted; old journals, quarantine folders, reports and expired cached
 * answers are removed. Everything else is reported, not changed: market minutes that were not
 * recorded cannot be recovered (those times stay blank, never synthesised), user orders are never
 * edited or cancelled, configuration is never rewritten, and code defects are left to a developer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { istParts, istTs, type AuditItem, type AuditItemStatus, type AuditReport, type AuditReportSummary, type LoginMonitorStatus, type WeeklyAuditStatus } from '@q26/core';
import { BACKFILL_SOURCES, offlineReason, type EodJobs, type EodSource } from '../live/eod';
import type { ScripMasterStatus } from '../live/kotak/scripmaster';
import type { EodKind, HistoryFiles } from '../live/store/history';
import { istWhen } from '../log';
import { ORDER_METHOD_PATTERN, SAFETY } from '../safety';
import type { Db } from '../store/db';
import type { OpsJournal } from './journal';

export interface AuditTarget {
  dataDir: string | null;
  calendar: { sessions(from: string, to: string): string[]; session(ts: number): { date: string; status: string } };
  eod: Pick<EodJobs, 'isLoaded' | 'loadDateQueued' | 'forget' | 'wasUnavailable' | 'status'> | null;
  history: Pick<HistoryFiles, 'forgetDate' | 'dir'> | null;
  intradaySessions(): string[];
  refdata(): ScripMasterStatus;
  refreshInstrumentMaster(): Promise<void>;
  login(): LoginMonitorStatus;
  /** Credential values, used only to look for leaks (never written or returned). */
  secrets(): string[];
  db: Db | null;
  config: { host: string; authSecretSet: boolean; persist: boolean; invalidHolidays: string[] };
  journal: OpsJournal;
  clearCaches(opts: { all?: boolean }): number;
  /** Method names of the Kotak REST client (checked for order placement). */
  brokerClientMethods(): string[];
}

export interface WeeklyAuditOptions {
  now?: () => number;
  timers?: { setTimeout(fn: () => void, ms: number): unknown; clearTimeout(h: unknown): void };
  /** Delay of the catch-up run after start (default 3 min, so the first login and loads finish). */
  catchUpDelayMs?: number;
  /** Minimum time between two manual runs (default 2 min). */
  manualCooldownMs?: number;
  log?: { info(m: string): void; warn(m: string): void };
}

const DAY = 86_400_000;
const WEEK = 7 * DAY;
/** Saturday 10:00 IST. */
const RUN_MINUTE = 10 * 60;
const SATURDAY = 6;
const REPORTS_KEPT = 52;
const QUARANTINE_DAYS = 30;
const JOURNAL_DAYS = 90;
const MAX_SECRET_SCAN_BYTES = 50 * 1024 * 1024;
const KIND_SOURCES: Record<EodKind, EodSource[]> = {
  fo: ['nseFo', 'bseFo'],
  cm: ['nseCm'],
  index: ['index'],
  participants: ['participants'],
  fiidii: ['fiidii'],
};

/** The most recent Saturday 10:00 IST at or before `now`. */
export function lastScheduledRun(now: number): number {
  const { date, minuteOfDay } = istParts(now);
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  let back = (dow - SATURDAY + 7) % 7;
  if (back === 0 && minuteOfDay < RUN_MINUTE) back = 7;
  const d = new Date(Date.parse(`${date}T00:00:00Z`) - back * DAY).toISOString().slice(0, 10);
  return istTs(d, RUN_MINUTE);
}

export function nextScheduledRun(now: number): number {
  return lastScheduledRun(now) + WEEK;
}

export class WeeklyAudit {
  private readonly now: () => number;
  private readonly timers: NonNullable<WeeklyAuditOptions['timers']>;
  private readonly log: NonNullable<WeeklyAuditOptions['log']>;
  private readonly dir: string | null;
  private timer: unknown = null;
  private nextRunAt: number | null = null;
  private running: Promise<AuditReport> | null = null;
  private last: AuditReport | null = null;
  private readonly memory: AuditReport[] = [];
  private stopped = false;

  constructor(
    private readonly t: AuditTarget,
    private readonly opts: WeeklyAuditOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.timers = opts.timers ?? { setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout) };
    this.log = opts.log ?? { info: () => undefined, warn: () => undefined };
    this.dir = t.dataDir ? path.join(t.dataDir, 'ops', 'audits') : null;
    this.last = this.readReports(1)[0] ?? null;
  }

  /** Arms the Saturday schedule, and a catch-up run when the last scheduled audit was missed. */
  start(): void {
    if (this.stopped) return;
    const missed = !this.last || this.last.finishedAt < lastScheduledRun(this.now());
    if (missed) this.arm(this.now() + (this.opts.catchUpDelayMs ?? 3 * 60_000), 'catch-up');
    else this.arm(nextScheduledRun(this.now()), 'schedule');
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  /** "Run audit now": starts a run (resolves with its report); refused while one runs or right after one. */
  runNow(): { started: boolean; message: string; done?: Promise<AuditReport> } {
    if (this.running) return { started: false, message: 'The audit is already running', done: this.running };
    const cool = this.opts.manualCooldownMs ?? 2 * 60_000;
    if (this.last && this.now() - this.last.finishedAt < cool) {
      return { started: false, message: `The last audit finished ${Math.round((this.now() - this.last.finishedAt) / 1000)} s ago; run it again in ${Math.ceil((this.last.finishedAt + cool - this.now()) / 1000)} s` };
    }
    const done = this.run('manual');
    return { started: true, message: 'Audit started', done };
  }

  status(): WeeklyAuditStatus {
    return {
      running: !!this.running,
      schedule: 'Every Saturday 10:00 IST (covers Saturday to Saturday)',
      nextRunAt: this.nextRunAt,
      last: this.last,
      history: this.readReports(12).map(summaryOf),
    };
  }

  report(id: string): AuditReport | null {
    if (!/^[\w-]{1,40}$/.test(id)) return null;
    if (this.last?.id === id) return this.last;
    const mem = this.memory.find((r) => r.id === id);
    if (mem) return mem;
    if (!this.dir) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, `${id}.json`), 'utf8')) as AuditReport;
    } catch {
      return null;
    }
  }

  /** Run the audit (shared while one is running). */
  run(trigger: AuditReport['trigger']): Promise<AuditReport> {
    if (!this.running) {
      this.running = this.audit(trigger).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  /* ---------------------------------- schedule ---------------------------------- */

  private arm(at: number, trigger: AuditReport['trigger']): void {
    if (this.stopped) return;
    if (this.timer !== null) this.timers.clearTimeout(this.timer);
    this.nextRunAt = at;
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      void this.run(trigger)
        .catch((e) => this.log.warn(`weekly audit failed: ${e instanceof Error ? e.message : String(e)}`))
        .finally(() => this.arm(nextScheduledRun(this.now()), 'schedule'));
    }, Math.max(0, at - this.now()));
  }

  /* ---------------------------------- the audit ---------------------------------- */

  private async audit(trigger: AuditReport['trigger']): Promise<AuditReport> {
    const startedAt = this.now();
    const to = trigger === 'schedule' ? Math.min(startedAt, lastScheduledRun(startedAt)) : startedAt;
    const from = to - WEEK;
    const id = reportId(startedAt);
    this.t.journal.add({ source: 'audit', level: 'info', type: 'AUDIT_STARTED', message: `Weekly audit (${trigger}) of ${istWhen(from, startedAt)} → ${istWhen(to, startedAt)}` });
    this.log.info(`weekly audit (${trigger}) started`);
    const items: AuditItem[] = [];
    const step = async (id: string, area: string, title: string, fn: () => Promise<Omit<AuditItem, 'id' | 'area' | 'title'>> | Omit<AuditItem, 'id' | 'area' | 'title'>) => {
      try {
        items.push({ id, area, title, ...(await fn()) });
      } catch (e) {
        items.push({ id, area, title, status: 'FAIL', detail: `check failed: ${e instanceof Error ? e.message : String(e)}` });
      }
    };
    await step('SAFE-1', 'Safety', 'Paper-trading only (no broker order path)', () => this.safety());
    await step('SEC-1', 'Security', 'No credential values in stored files', () => this.secretScan());
    await step('CFG-1', 'Configuration', 'Kotak credentials configured', () => this.credentials());
    await step('CFG-2', 'Configuration', 'Server exposure and sign-in sessions', () => this.exposure());
    await step('CFG-3', 'Configuration', 'Holiday list', () => this.holidays());
    await step('CFG-4', 'Configuration', 'Data directory writable', () => this.writable());
    await step('DATA-1', 'Data', 'End-of-day files for every session of the week', () => this.eodCompleteness(from, to));
    await step('DATA-2', 'Data', 'End-of-day files readable (not corrupt)', () => this.eodIntegrity(from, to, id));
    await step('DATA-3', 'Data', 'Market sessions recorded', () => this.recorded(from, to));
    await step('DATA-4', 'Data', 'Instrument master current', () => this.instruments());
    await step('LEDGER-1', 'Paper trading', 'Paper-trading ledger consistent', () => this.ledger());
    await step('OPS-1', 'Operations', 'Broker login during the week', () => this.loginWeek(from, to));
    await step('OPS-2', 'Operations', 'Watchdog incidents during the week', () => this.watchdogWeek(from, to));
    await step('OPS-3', 'Operations', 'Server restarts during the week', () => this.restarts(from, to));
    await step('RUN-1', 'Runtime', 'Node.js runtime', () => this.runtime());
    await step('HOUSE-1', 'Housekeeping', 'Old journals, quarantine, reports and caches', () => this.housekeeping());
    await step('DEP-1', 'Dependencies', 'Known vulnerabilities in dependencies', () => ({
      status: 'SKIPPED',
      detail: 'npm audit needs the package registry and runs before deploying (CI / TEST_EXECUTION_REPORT.md), not inside the trading server',
    }));

    const summary: Record<AuditItemStatus, number> = { PASS: 0, WARN: 0, FAIL: 0, FIXED: 0, SKIPPED: 0 };
    for (const i of items) summary[i.status]++;
    const report: AuditReport = {
      id,
      trigger,
      window: { from, to },
      startedAt,
      finishedAt: this.now(),
      summary,
      verdict: summary.FAIL ? 'FAILING' : summary.WARN ? 'ATTENTION' : 'HEALTHY',
      items,
    };
    this.save(report);
    this.last = report;
    const line = `Weekly audit ${report.verdict}: ${summary.PASS} pass, ${summary.FIXED} fixed, ${summary.WARN} warn, ${summary.FAIL} fail, ${summary.SKIPPED} skipped`;
    this.t.journal.add({ source: 'audit', level: summary.FAIL ? 'error' : summary.WARN ? 'warn' : 'info', type: 'AUDIT_FINISHED', message: line });
    (summary.FAIL || summary.WARN ? this.log.warn : this.log.info)(`weekly audit: ${line}`);
    return report;
  }

  private safety(): Omit<AuditItem, 'id' | 'area' | 'title'> {
    const flags = [SAFETY.autoExecutionToBroker, SAFETY.liveOrderAuthority, SAFETY.brokerSubmission] as boolean[];
    const orderMethods = this.t.brokerClientMethods().filter((m) => ORDER_METHOD_PATTERN.test(m));
    if (flags.some(Boolean) || SAFETY.mode !== 'paper') return { status: 'FAIL', detail: 'a safety flag is on: live orders could be possible' };
    if (orderMethods.length) return { status: 'FAIL', detail: `the Kotak client has order-like methods: ${orderMethods.join(', ')}` };
    return { status: 'PASS', detail: 'mode paper; automatic execution to a broker, live-order authority and broker submission are off (constants); the Kotak client has market-data methods only' };
  }

  private secretScan(): Omit<AuditItem, 'id' | 'area' | 'title'> {
    const secrets = this.t.secrets().filter((s) => s.length >= 6);
    if (!secrets.length) return { status: 'SKIPPED', detail: 'no Kotak credentials configured: nothing to look for' };
    const root = this.t.dataDir;
    if (!root) return { status: 'SKIPPED', detail: 'persistence off: nothing stored' };
    const files = [...walk(path.join(root, 'ops')), path.join(root, 'db.json'), ...listFiles(root).filter((f) => f.endsWith('.log'))].filter((f) => fs.existsSync(f));
    const redacted: string[] = [];
    const leaked: string[] = [];
    let scanned = 0;
    for (const f of files) {
      let text: string;
      try {
        if (fs.statSync(f).size > MAX_SECRET_SCAN_BYTES) continue;
        text = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      scanned++;
      if (!secrets.some((s) => text.includes(s))) continue;
      const rel = path.relative(root, f);
      if (rel.startsWith(`ops${path.sep}`)) {
        let out = text;
        for (const s of secrets) out = out.split(s).join('[redacted]');
        fs.writeFileSync(f, out);
        redacted.push(rel);
      } else leaked.push(rel);
    }
    if (leaked.length) return { status: 'FAIL', detail: `a credential value is stored in: ${leaked.join(', ')} (not changed automatically: remove it and rotate that credential)`, ...(redacted.length ? { fix: `redacted ${redacted.join(', ')}` } : {}) };
    if (redacted.length) return { status: 'FIXED', detail: `a credential value was found in ${redacted.length} operations file(s)`, fix: `redacted: ${redacted.join(', ')}` };
    return { status: 'PASS', detail: `${scanned} stored file(s) checked; no credential value found` };
  }

  private credentials(): Omit<AuditItem, 'id' | 'area' | 'title'> {
    const l = this.t.login();
    if (l.state === 'NO_CREDENTIALS') return { status: 'WARN', detail: l.detail };
    return { status: 'PASS', detail: 'all NEO_* variables are set (values not shown)' };
  }

  private exposure(): Omit<AuditItem, 'id' | 'area' | 'title'> {
    const notes: string[] = [];
    if (!this.t.config.authSecretSet) notes.push('AUTH_SECRET is not set (or is a placeholder / too short and was ignored): a random one is made at each start, so every sign-in ends when the server restarts');
    if (this.t.config.host === '0.0.0.0' || this.t.config.host === '::') notes.push(`HOST ${this.t.config.host} serves every network interface: keep the port behind a firewall or a reverse proxy with TLS`);
    return notes.length ? { status: 'WARN', detail: notes.join('; ') } : { status: 'PASS', detail: `HOST ${this.t.config.host}; AUTH_SECRET set` };
  }

  private holidays(): Omit<AuditItem, 'id' | 'area' | 'title'> {
    const bad = this.t.config.invalidHolidays;
    return bad.length ? { status: 'WARN', detail: `HOLIDAYS has entries that are not dates (ignored): ${bad.slice(0, 5).join(', ')}` } : { status: 'PASS', detail: 'HOLIDAYS entries are valid dates' };
  }

  private writable(): Omit<AuditItem, 'id' | 'area' | 'title'> {
    const dir = this.t.dataDir;
    if (!dir || !this.t.config.persist) return { status: 'WARN', detail: 'persistence is off (PERSIST=false): users, paper trades and recorded data are lost at restart' };
    const probe = path.join(dir, `.audit-probe-${process.pid}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      return { status: 'PASS', detail: 'DATA_DIR is writable' };
    } catch (e) {
      return { status: 'FAIL', detail: `DATA_DIR is not writable: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  /** Trading days of the window whose session has closed (EOD files are published after the close). */
  private closedSessions(from: number, to: number): string[] {
    const today = this.t.calendar.session(this.now()).date;
    return this.t.calendar.sessions(istParts(from).date, istParts(to).date).filter((d) => d < today);
  }

  private async eodCompleteness(from: number, to: number): Promise<Omit<AuditItem, 'id' | 'area' | 'title'>> {
    const eod = this.t.eod;
    if (!eod) return { status: 'SKIPPED', detail: 'EOD jobs not running' };
    const dates = this.closedSessions(from, to);
    if (!dates.length) return { status: 'PASS', detail: 'no closed trading session in the window' };
    const missing = new Map<string, EodSource[]>();
    for (const d of dates) {
      const need = BACKFILL_SOURCES.filter((s) => !eod.isLoaded(s, d) && !eod.wasUnavailable(s, d));
      if (need.length) missing.set(d, need);
    }
    if (!missing.size) return { status: 'PASS', detail: `all ${dates.length} session(s) have their files (${dates[0]} → ${dates.at(-1)})` };
    // The last backfill found NSE/BSE unreachable: downloading now would only wait out the same retries.
    const offline = eod.status().backfill.stoppedOffline;
    if (offline) return { status: 'FAIL', detail: `${missing.size} session(s) missing files (${[...missing.keys()].join(', ')}); NSE/BSE were unreachable at the last backfill (${offline}): retried by the daily EOD job` };
    const failed: string[] = [];
    let fixed = 0;
    for (const [d, need] of missing) {
      const got = await eod.loadDateQueued(d, need);
      // NSE/BSE not reachable at all: the other dates would fail the same way.
      const offline = offlineReason(got);
      if (offline) {
        failed.push(`NSE/BSE unreachable (${offline}); not retried for the other dates`);
        break;
      }
      const bad = got.filter((r) => r.outcome === 'failed' || r.outcome === 'waiting');
      if (bad.length) failed.push(`${d}: ${bad.map((r) => `${r.source} (${r.reason ?? r.outcome})`).join(', ')}`);
      else fixed++;
    }
    if (failed.length) return { status: 'FAIL', detail: `${missing.size} session(s) were missing files; still missing: ${failed.slice(0, 5).join('; ')}`, fix: `download attempted; ${fixed} session(s) complete now` };
    return { status: 'FIXED', detail: `${missing.size} session(s) were missing files`, fix: `downloaded the missing files from NSE/BSE for ${[...missing.keys()].join(', ')}` };
  }

  private async eodIntegrity(from: number, to: number, runId: string): Promise<Omit<AuditItem, 'id' | 'area' | 'title'>> {
    const h = this.t.history;
    const root = h?.dir();
    if (!h || !root || !this.t.dataDir) return { status: 'SKIPPED', detail: 'no EOD store' };
    const dates = new Set(this.closedSessions(from, to));
    const corrupt: Array<{ file: string; kind: EodKind; date: string }> = [];
    let checked = 0;
    for (const kind of Object.keys(KIND_SOURCES) as EodKind[]) {
      const base = path.join(root, kind);
      for (const name of listNames(base)) {
        const date = name.slice(0, 10);
        if (!dates.has(date)) continue;
        const files = kind === 'fo' ? walk(path.join(base, name)) : [path.join(base, name)];
        for (const f of files) {
          if (!f.endsWith('.json')) continue;
          checked++;
          try {
            JSON.parse(fs.readFileSync(f, 'utf8'));
          } catch {
            corrupt.push({ file: f, kind, date });
          }
        }
      }
    }
    if (!corrupt.length) return { status: 'PASS', detail: `${checked} file(s) of the week's sessions read correctly` };
    const qdir = path.join(this.t.dataDir, 'ops', 'quarantine', runId);
    const redo = new Map<string, Set<EodSource>>();
    for (const c of corrupt) {
      const dest = path.join(qdir, path.relative(root, c.file));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(c.file, dest);
      h.forgetDate(c.kind, c.date);
      const set = redo.get(c.date) ?? new Set<EodSource>();
      for (const s of KIND_SOURCES[c.kind]) {
        this.t.eod?.forget(s, c.date);
        set.add(s);
      }
      redo.set(c.date, set);
    }
    const still: string[] = [];
    for (const [d, sources] of redo) {
      const got = (await this.t.eod?.loadDateQueued(d, [...sources])) ?? [];
      for (const r of got) if (r.outcome !== 'loaded' && r.outcome !== 'already-loaded') still.push(`${d} ${r.source} (${r.reason ?? r.outcome})`);
    }
    const fix = `moved ${corrupt.length} corrupt file(s) to ${path.relative(this.t.dataDir, qdir)}; downloaded again`;
    return still.length
      ? { status: 'FAIL', detail: `${corrupt.length} corrupt file(s); not downloaded again: ${still.slice(0, 5).join('; ')}`, fix }
      : { status: 'FIXED', detail: `${corrupt.length} corrupt file(s) in ${checked} checked`, fix };
  }

  private recorded(from: number, to: number): Omit<AuditItem, 'id' | 'area' | 'title'> {
    const dates = this.closedSessions(from, to);
    if (!dates.length) return { status: 'PASS', detail: 'no closed trading session in the window' };
    const have = new Set(this.t.intradaySessions());
    const missing = dates.filter((d) => !have.has(d));
    if (!missing.length) return { status: 'PASS', detail: `all ${dates.length} session(s) were recorded` };
    return {
      status: 'WARN',
      detail: `${missing.length} of ${dates.length} session(s) not recorded (${missing.join(', ')}): the server was down or not logged in during market hours. Live minutes cannot be recovered afterwards: those times stay blank (never synthesised)`,
    };
  }

  private async instruments(): Promise<Omit<AuditItem, 'id' | 'area' | 'title'>> {
    const r = this.t.refdata();
    const sess = this.t.calendar.session(this.now());
    const recent = this.t.calendar.sessions(istParts(this.now() - 7 * DAY).date, sess.date);
    const lastSession = recent.at(-1);
    if (r.ready && r.date && (r.date === sess.date || r.date === lastSession)) return { status: 'PASS', detail: `loaded for ${r.date}: ${r.underlyings} underlyings, ${r.listings} listings` };
    if (this.t.login().state !== 'LOGGED_IN') return { status: 'WARN', detail: `${r.ready ? `loaded for ${r.date}` : 'not loaded'}; downloading it needs a Kotak login` };
    await this.t.refreshInstrumentMaster();
    const after = this.t.refdata();
    return after.ready && after.date === sess.date
      ? { status: 'FIXED', detail: `was ${r.ready ? `for ${r.date}` : 'not loaded'}`, fix: `downloaded again: ${after.underlyings} underlyings, ${after.listings} listings` }
      : { status: 'FAIL', detail: `download failed${after.error ? `: ${after.error}` : ''}` };
  }

  private ledger(): Omit<AuditItem, 'id' | 'area' | 'title'> {
    const db = this.t.db;
    if (!db) return { status: 'SKIPPED', detail: 'no database' };
    const d = db.data;
    const notes: string[] = [];
    const fails: string[] = [];
    let fix: string | undefined;
    // Email index: rebuilt from the users when it does not match them (a derived lookup, safe to rebuild).
    const want: Record<string, string> = {};
    for (const u of Object.values(d.users)) if (!u.guest && u.email && u.passwordHash) want[u.email.trim().toLowerCase()] = u.id;
    const idx = d.emailIndex;
    const same = Object.keys(want).length === Object.keys(idx).length && Object.entries(want).every(([e, id]) => idx[e] === id);
    if (!same) {
      d.emailIndex = want;
      db.save();
      fix = `rebuilt the email index from ${Object.keys(want).length} registered user(s)`;
    }
    const users = new Set(Object.keys(d.users));
    const orphan = [d.orders, d.trades, d.strategies, d.alerts, d.watchlists].reduce((n, m) => n + Object.keys(m).filter((u) => !users.has(u)).length, 0);
    if (orphan) notes.push(`${orphan} record list(s) belong to no user (kept)`);
    let trades = 0;
    let badTrades = 0;
    let unmatched = 0;
    for (const [uid, list] of Object.entries(d.trades)) {
      const orderIds = new Set((d.orders[uid] ?? []).map((o) => o.id));
      for (const tr of list) {
        trades++;
        if (!(Number.isFinite(tr.price) && tr.price >= 0 && Number.isFinite(tr.quantity) && tr.quantity > 0)) badTrades++;
        if (!orderIds.has(tr.orderId)) unmatched++;
      }
    }
    if (badTrades) fails.push(`${badTrades} trade(s) with an invalid price or quantity`);
    if (unmatched) notes.push(`${unmatched} trade(s) whose order is no longer stored`);
    const today = istParts(this.now()).date;
    let stale = 0;
    let open = 0;
    for (const list of Object.values(d.orders)) {
      for (const o of list) {
        if (o.status !== 'OPEN' && o.status !== 'TRIGGER_PENDING') continue;
        open++;
        const exp = (o as { expiry?: string }).expiry;
        if (exp && exp < today) stale++;
      }
    }
    if (stale) notes.push(`${stale} working order(s) on expired contracts (left for the user to cancel)`);
    const corrupt = this.t.dataDir ? listNames(this.t.dataDir).filter((f) => f.startsWith('db.json.corrupt-')) : [];
    if (corrupt.length) fails.push(`db.json was unreadable at a start and the app started empty; the old file is kept as ${corrupt.sort().at(-1)} (restore it from a backup, then delete it)`);
    const detail = `${users.size} user(s), ${trades} paper trade(s), ${open} working order(s)`;
    if (fails.length) return { status: 'FAIL', detail: `${detail}; ${[...fails, ...notes].join('; ')}`, ...(fix ? { fix } : {}) };
    if (notes.length) return { status: 'WARN', detail: `${detail}; ${notes.join('; ')}`, ...(fix ? { fix } : {}) };
    return fix ? { status: 'FIXED', detail, fix } : { status: 'PASS', detail };
  }

  private loginWeek(from: number, to: number): Omit<AuditItem, 'id' | 'area' | 'title'> {
    const l = this.t.login();
    if (l.state === 'NO_CREDENTIALS') return { status: 'SKIPPED', detail: 'no Kotak credentials configured' };
    const ev = this.t.journal.read(from, to).filter((e) => e.source === 'login');
    const n = (type: string) => ev.filter((e) => e.type === type).length;
    const ok = n('LOGIN_OK');
    const failed = n('LOGIN_FAILED');
    const lost = n('SESSION_LOST');
    const detail = `${ok} login(s), ${failed} failed attempt(s), ${lost} session loss(es); now ${l.state}`;
    if (failed && !ok) return { status: 'FAIL', detail: `${detail}; no successful login this week (last problem: ${l.lastFailure?.reason ?? 'unknown'})` };
    if (failed > 20 || lost > 10) return { status: 'WARN', detail: `${detail}: unstable broker connection` };
    return { status: 'PASS', detail };
  }

  private watchdogWeek(from: number, to: number): Omit<AuditItem, 'id' | 'area' | 'title'> {
    const ev = this.t.journal.read(from, to).filter((e) => e.source === 'watchdog');
    const errors = ev.filter((e) => e.level === 'error');
    const fixes = ev.filter((e) => e.type.endsWith('_FIXED'));
    const byType = new Map<string, number>();
    for (const e of errors) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
    const top = [...byType].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ×${v}`);
    const detail = `${ev.length} watchdog event(s): ${fixes.length} automatic fix(es), ${errors.length} failure(s)`;
    return errors.length ? { status: 'WARN', detail: `${detail} (${top.join(', ')})` } : { status: 'PASS', detail };
  }

  private restarts(from: number, to: number): Omit<AuditItem, 'id' | 'area' | 'title'> {
    const starts = this.t.journal.read(from, to).filter((e) => e.type === 'SERVER_START').length;
    return starts > 3 ? { status: 'WARN', detail: `${starts} server starts this week: check the supervisor log for crashes` } : { status: 'PASS', detail: `${starts} server start(s) this week` };
  }

  private runtime(): Omit<AuditItem, 'id' | 'area' | 'title'> {
    const [maj, min] = process.versions.node.split('.').map(Number);
    const ok = maj > 20 || (maj === 20 && min >= 12);
    const mem = process.memoryUsage();
    const detail = `Node ${process.versions.node}; RSS ${Math.round(mem.rss / 1048576)} MB, heap ${Math.round(mem.heapUsed / 1048576)} MB`;
    return ok ? { status: 'PASS', detail } : { status: 'FAIL', detail: `${detail}: Node 20.12 or newer is required` };
  }

  private housekeeping(): Omit<AuditItem, 'id' | 'area' | 'title'> {
    const done: string[] = [];
    const journals = this.t.journal.prune(JOURNAL_DAYS);
    if (journals) done.push(`${journals} journal file(s) older than ${JOURNAL_DAYS} days`);
    if (this.t.dataDir) {
      const qroot = path.join(this.t.dataDir, 'ops', 'quarantine');
      let q = 0;
      for (const name of listNames(qroot)) {
        const p = path.join(qroot, name);
        try {
          if (this.now() - fs.statSync(p).mtimeMs > QUARANTINE_DAYS * DAY) {
            fs.rmSync(p, { recursive: true, force: true });
            q++;
          }
        } catch {
          /* next run */
        }
      }
      if (q) done.push(`${q} quarantine folder(s) older than ${QUARANTINE_DAYS} days`);
    }
    if (this.dir) {
      const old = listNames(this.dir)
        .filter((f) => f.endsWith('.json'))
        .sort()
        .reverse()
        .slice(REPORTS_KEPT);
      for (const f of old) {
        fs.rmSync(path.join(this.dir, f), { force: true });
        fs.rmSync(path.join(this.dir, f.replace(/\.json$/, '.md')), { force: true });
      }
      if (old.length) done.push(`${old.length} old audit report(s)`);
    }
    const caches = this.t.clearCaches({ all: false });
    if (caches) done.push(`${caches} expired cached answer(s)`);
    return done.length ? { status: 'FIXED', detail: 'housekeeping due', fix: `removed ${done.join(', ')}` } : { status: 'PASS', detail: 'nothing to remove' };
  }

  /* ---------------------------------- reports ---------------------------------- */

  private save(r: AuditReport): void {
    this.memory.unshift(r);
    if (this.memory.length > 12) this.memory.pop();
    if (!this.dir) return;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(path.join(this.dir, `${r.id}.json`), JSON.stringify(r, null, 2));
      fs.writeFileSync(path.join(this.dir, `${r.id}.md`), renderMarkdown(r));
    } catch (e) {
      this.log.warn(`weekly audit: report not saved: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private readReports(limit: number): AuditReport[] {
    if (!this.dir) return this.memory.slice(0, limit);
    const out: AuditReport[] = [];
    const files = listNames(this.dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .reverse();
    for (const f of files) {
      if (out.length >= limit) break;
      try {
        out.push(JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as AuditReport);
      } catch {
        /* a report that cannot be read is skipped */
      }
    }
    return out;
  }
}

function summaryOf(r: AuditReport): AuditReportSummary {
  return { id: r.id, trigger: r.trigger, finishedAt: r.finishedAt, verdict: r.verdict, summary: r.summary };
}

/** "2026-10-24_1000" (IST date and time of the start). */
function reportId(ts: number): string {
  const p = istParts(ts);
  const hh = String(Math.floor(p.minuteOfDay / 60)).padStart(2, '0');
  const mm = String(p.minuteOfDay % 60).padStart(2, '0');
  return `${p.date}_${hh}${mm}${String(p.second).padStart(2, '0')}`;
}

export function renderMarkdown(r: AuditReport): string {
  const lines = [
    `# Q26 weekly audit ${r.id}`,
    '',
    `- Trigger: ${r.trigger}`,
    `- Window: ${istWhen(r.window.from, r.window.to)} → ${istWhen(r.window.to, r.window.to)}`,
    `- Verdict: **${r.verdict}** — ${Object.entries(r.summary)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ')}`,
    '',
    '| ID | Area | Check | Status | Detail | Automatic fix |',
    '|---|---|---|---|---|---|',
    ...r.items.map((i) => `| ${i.id} | ${i.area} | ${i.title} | ${i.status} | ${esc(i.detail)} | ${esc(i.fix ?? '')} |`),
    '',
  ];
  return lines.join('\n');
}

function esc(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function listNames(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function listFiles(dir: string): string[] {
  return listNames(dir)
    .map((n) => path.join(dir, n))
    .filter((p) => {
      try {
        return fs.statSync(p).isFile();
      } catch {
        return false;
      }
    });
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const n of listNames(dir)) {
    const p = path.join(dir, n);
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}
