/**
 * Operations journal: what the login monitor, the watchdog and the weekly audit saw and did, one
 * JSON line per event in DATA_DIR/ops/journal/<IST date>.jsonl (memory only when persistence is
 * off). The weekly audit reads a Saturday-to-Saturday window back from it. Every message passes
 * through `scrub` (the Kotak credential values are replaced) before it is kept or written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { istParts, type OpsEvent } from '@q26/core';

export interface OpsJournalOptions {
  /** DATA_DIR, or null to keep events in memory only. */
  dataDir: string | null;
  scrub?: (text: string) => string;
  now?: () => number;
  /** Events kept in memory (default 1000). */
  memory?: number;
}

export type OpsEventInput = Omit<OpsEvent, 'ts'> & { ts?: number };

const LEVEL_RANK: Record<OpsEvent['level'], number> = { info: 0, warn: 1, error: 2 };

export class OpsJournal {
  readonly dir: string | null;
  private readonly scrub: (text: string) => string;
  private readonly now: () => number;
  private readonly max: number;
  private readonly recent: OpsEvent[] = [];
  private writeError: string | undefined;

  constructor(opts: OpsJournalOptions) {
    this.dir = opts.dataDir ? path.join(opts.dataDir, 'ops', 'journal') : null;
    this.scrub = opts.scrub ?? ((t) => t);
    this.now = opts.now ?? Date.now;
    this.max = opts.memory ?? 1000;
  }

  add(e: OpsEventInput): OpsEvent {
    const ev: OpsEvent = { ts: e.ts ?? this.now(), source: e.source, level: e.level, type: e.type, message: this.scrub(e.message).slice(0, 1000) };
    this.recent.push(ev);
    if (this.recent.length > this.max) this.recent.splice(0, this.recent.length - this.max);
    if (this.dir) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        fs.appendFileSync(this.fileOf(ev.ts), `${JSON.stringify(ev)}\n`);
        this.writeError = undefined;
      } catch (err) {
        this.writeError = err instanceof Error ? err.message : String(err);
      }
    }
    return ev;
  }

  /** Events kept in memory, most recent first. */
  list(filter: { source?: OpsEvent['source']; minLevel?: OpsEvent['level']; limit?: number } = {}): OpsEvent[] {
    const min = LEVEL_RANK[filter.minLevel ?? 'info'];
    const out: OpsEvent[] = [];
    for (let i = this.recent.length - 1; i >= 0 && out.length < (filter.limit ?? 50); i--) {
      const e = this.recent[i];
      if ((!filter.source || e.source === filter.source) && LEVEL_RANK[e.level] >= min) out.push(e);
    }
    return out;
  }

  /** Events with from <= ts < to, oldest first (from the files when persisted; unreadable lines are skipped). */
  read(from: number, to: number): OpsEvent[] {
    if (!this.dir) return this.recent.filter((e) => e.ts >= from && e.ts < to);
    const out: OpsEvent[] = [];
    const first = istParts(from).date;
    const last = istParts(to).date;
    for (const f of this.files()) {
      const date = f.slice(0, 10);
      if (date < first || date > last) continue;
      let text: string;
      try {
        text = fs.readFileSync(path.join(this.dir, f), 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as OpsEvent;
          if (typeof e.ts === 'number' && e.ts >= from && e.ts < to) out.push(e);
        } catch {
          /* a torn last line after a crash */
        }
      }
    }
    return out.sort((a, b) => a.ts - b.ts);
  }

  /** Journal files (YYYY-MM-DD.jsonl), oldest first. */
  files(): string[] {
    if (!this.dir) return [];
    try {
      return fs
        .readdirSync(this.dir)
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
        .sort();
    } catch {
      return [];
    }
  }

  /** Delete journal files older than `days` days. Returns how many were deleted. */
  prune(days: number): number {
    if (!this.dir) return 0;
    const cutoff = istParts(this.now() - days * 86_400_000).date;
    let n = 0;
    for (const f of this.files()) {
      if (f.slice(0, 10) >= cutoff) continue;
      try {
        fs.rmSync(path.join(this.dir, f), { force: true });
        n++;
      } catch {
        /* retried at the next prune */
      }
    }
    return n;
  }

  /** The last write failure (cleared by the next successful write). */
  lastWriteError(): string | undefined {
    return this.writeError;
  }

  private fileOf(ts: number): string {
    return path.join(this.dir!, `${istParts(ts).date}.jsonl`);
  }
}
