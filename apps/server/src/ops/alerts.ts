/**
 * Alerts: an operations event that needs a person (level 'error': watchdog CRITICAL, automatic
 * login PAUSED, a weekly audit with FAIL items, a restart loop) reaches the operator accounts as an
 * in-app notification (the bell, pushed live over the websocket) and, when ALERT_WEBHOOK_URL is
 * set, as a POST to that webhook (Slack / Discord / ntfy-compatible JSON: `text` and `content`).
 * The same kind of alert is sent at most once per 15 min, and at most 30 alerts per hour.
 */
import type { OpsEvent } from '@q26/core';

export interface AlertSinkOptions {
  /** In-app notification for every operator account. */
  notifyOperators: (title: string, body: string) => void;
  /** ALERT_WEBHOOK_URL (optional). */
  webhookUrl?: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  log?: { warn(m: string): void };
}

const REPEAT_MS = 15 * 60_000;
const HOUR = 60 * 60_000;
const MAX_PER_HOUR = 30;

export class AlertSink {
  private readonly now: () => number;
  private readonly fetchFn: NonNullable<AlertSinkOptions['fetch']>;
  private readonly lastByType = new Map<string, number>();
  private sent: number[] = [];
  private webhookFailing = false;

  constructor(private readonly o: AlertSinkOptions) {
    this.now = o.now ?? Date.now;
    this.fetchFn = o.fetch ?? ((url, init) => fetch(url, init));
  }

  /** Called with every journal event; only 'error' events become alerts. */
  handle(e: OpsEvent): void {
    if (e.level !== 'error') return;
    const t = this.now();
    const key = `${e.source}:${e.type}`;
    if (t - (this.lastByType.get(key) ?? Number.NEGATIVE_INFINITY) < REPEAT_MS) return;
    this.sent = this.sent.filter((x) => t - x < HOUR);
    if (this.sent.length >= MAX_PER_HOUR) return;
    this.lastByType.set(key, t);
    this.sent.push(t);
    const title = `Q26 ${e.source === 'login' ? 'login' : e.source === 'audit' ? 'weekly audit' : e.source === 'server' ? 'server' : 'watchdog'}: needs attention`;
    try {
      this.o.notifyOperators(title, e.message);
    } catch {
      /* a notification failure must not break the journal */
    }
    if (this.o.webhookUrl) void this.post(title, e);
  }

  private async post(title: string, e: OpsEvent): Promise<void> {
    const text = `${title} — ${e.message}`;
    try {
      const res = await this.fetchFn(this.o.webhookUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, content: text, level: e.level, type: e.type, source: e.source, ts: e.ts }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.webhookFailing = false;
    } catch (err) {
      // One warning per failing period, not one per alert.
      if (!this.webhookFailing) this.o.log?.warn(`alert webhook failed: ${err instanceof Error ? err.message : String(err)}`);
      this.webhookFailing = true;
    }
  }
}
