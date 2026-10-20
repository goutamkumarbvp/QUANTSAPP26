/**
 * Operations journal: what the login monitor, the watchdog and the weekly audit saw and did, one
 * JSON line per event in DATA_DIR/ops/journal/<IST date>.jsonl (memory only when persistence is
 * off). The weekly audit reads a Saturday-to-Saturday window back from it. Every message passes
 * through `scrub` (the Kotak credential values are replaced) before it is kept or written.
 *
 * Tamper-evident: every line carries `prev`, the SHA-256 of the line before it in the same file ('' for
 * the first). Editing or deleting a line breaks the chain at the next one; verify() reports where.
 * (Deleting the LAST lines of a file cannot be detected this way: there is no outside anchor.)
 */
import { createHash } from 'node:crypto';
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

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export interface JournalVerification {
  files: number;
  lines: number;
  /** "<file>:<line>" where the chain breaks (a line edited, removed or inserted before it). */
  broken: string[];
  /** Lines that are not JSON (a write torn by a crash); the chain continues across them. */
  torn: number;
}

export class OpsJournal {
  readonly dir: string | null;
  private readonly scrub: (text: string) => string;
  private readonly now: () => number;
  private readonly max: number;
  private readonly recent: OpsEvent[] = [];
  /** Events whose write to disk failed (merged into read(); lost at restart). */
  private readonly failed: OpsEvent[] = [];
  private writeError: string | undefined;
  /** File → SHA-256 of its last line (the next line's `prev`). */
  private readonly tails = new Map<string, string>();
  private readonly listeners = new Set<(e: OpsEvent) => void>();

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
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {
        /* a listener must not break the journal */
      }
    }
    if (this.dir) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        const file = this.fileOf(ev.ts);
        const line = JSON.stringify({ ...ev, prev: this.tailOf(file) });
        fs.appendFileSync(file, `${line}\n`);
        this.tails.set(file, sha256(line));
        this.writeError = undefined;
      } catch (err) {
        this.writeError = err instanceof Error ? err.message : String(err);
        this.failed.push(ev);
        if (this.failed.length > this.max) this.failed.splice(0, this.failed.length - this.max);
      }
    }
    return ev;
  }

  /** Called with every event as it is added (alerts). */
  onEvent(fn: (e: OpsEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
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
    // Events that could not be written still count (until a restart).
    const out: OpsEvent[] = this.failed.filter((e) => e.ts >= from && e.ts < to);
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
          const { prev: _prev, ...e } = JSON.parse(line) as OpsEvent & { prev?: string };
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

  /**
   * Check the hash chain of the journal files (all, or those of the IST dates from..to). Lines written
   * before the chain existed (no `prev`) are accepted only before the first chained line of a file.
   */
  verify(from?: number, to?: number): JournalVerification {
    const out: JournalVerification = { files: 0, lines: 0, broken: [], torn: 0 };
    if (!this.dir) return out;
    const first = from === undefined ? '' : istParts(from).date;
    const last = to === undefined ? '9999' : istParts(to).date;
    for (const f of this.files()) {
      const date = f.slice(0, 10);
      if (date < first || date > last) continue;
      let text: string;
      try {
        text = fs.readFileSync(path.join(this.dir, f), 'utf8');
      } catch {
        continue;
      }
      out.files++;
      let prevHash = '';
      let chained = false;
      text.split('\n').forEach((line, i) => {
        if (!line) return;
        out.lines++;
        let rec: { prev?: unknown };
        try {
          rec = JSON.parse(line) as { prev?: unknown };
        } catch {
          out.torn++;
          prevHash = sha256(line);
          return;
        }
        if (typeof rec.prev === 'string') {
          chained = true;
          if (rec.prev !== prevHash) out.broken.push(`${f}:${i + 1}`);
        } else if (chained) out.broken.push(`${f}:${i + 1}`);
        prevHash = sha256(line);
      });
    }
    return out;
  }

  /** Rebuild the chain of one journal file after an authorised rewrite (e.g. the audit's secret redaction). */
  rechain(file: string): void {
    const text = fs.readFileSync(file, 'utf8');
    let prev = '';
    const lines = text.split('\n').map((line) => {
      if (!line) return line;
      let out = line;
      try {
        const { prev: _p, ...rec } = JSON.parse(line) as { prev?: string };
        out = JSON.stringify({ ...rec, prev });
      } catch {
        /* a torn line stays as it is */
      }
      prev = sha256(out);
      return out;
    });
    fs.writeFileSync(file, lines.join('\n'));
    this.tails.set(file, prev);
  }

  /** Events of [from, to) that could not be written to disk. */
  unpersisted(from: number, to: number): number {
    return this.failed.filter((e) => e.ts >= from && e.ts < to).length;
  }

  /** The last write failure (cleared by the next successful write). */
  lastWriteError(): string | undefined {
    return this.writeError;
  }

  /** The hash of a file's last line (read once per file and start, then kept). */
  private tailOf(file: string): string {
    const known = this.tails.get(file);
    if (known !== undefined) return known;
    let last = '';
    try {
      const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
      last = lines.at(-1) ?? '';
    } catch {
      /* a new file */
    }
    const h = last ? sha256(last) : '';
    this.tails.set(file, h);
    return h;
  }

  private fileOf(ts: number): string {
    return path.join(this.dir!, `${istParts(ts).date}.jsonl`);
  }
}
