/**
 * Small JSON document store with atomic, debounced writes. Good enough for a single-node
 * deployment; swap for Postgres/SQLite behind the same methods when scaling out.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AlertDef, Notification, Order, SavedStrategy, Trade, UserSettings, Watchlist } from '@q26/core';
import type { StoredAlgoRun } from '../services/algo';

export interface StoredUser {
  id: string;
  name: string;
  email: string;
  guest: boolean;
  passwordHash?: string;
  salt?: string;
  createdAt: number;
  settings: UserSettings;
  openingBalance: number;
}

export interface DbShape {
  version: 1;
  users: Record<string, StoredUser>;
  emailIndex: Record<string, string>;
  strategies: Record<string, SavedStrategy[]>;
  orders: Record<string, Order[]>;
  trades: Record<string, Trade[]>;
  alerts: Record<string, AlertDef[]>;
  notifications: Record<string, Notification[]>;
  watchlists: Record<string, Watchlist[]>;
  algoRuns: Record<string, StoredAlgoRun[]>;
  /**
   * The server's owner: the first account given a password (register, or a guest upgraded), recorded
   * once. With OPS_ADMIN_EMAILS empty it is the only operations operator.
   */
  ownerId?: string;
}

const empty = (): DbShape => ({
  version: 1,
  users: {},
  emailIndex: {},
  strategies: {},
  orders: {},
  trades: {},
  alerts: {},
  notifications: {},
  watchlists: {},
  algoRuns: {},
});

export class Db {
  data: DbShape;
  /** Set when db.json could not be read at start: the file it was moved to (the app started empty). */
  readonly recoveredFrom: string | undefined;
  private timer: NodeJS.Timeout | null = null;
  private lastWriteError: string | undefined;
  private readonly file: string | null;

  constructor(dir: string | null) {
    this.file = dir ? path.join(dir, 'db.json') : null;
    this.data = empty();
    if (this.file && fs.existsSync(this.file)) {
      try {
        this.data = { ...empty(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
      } catch {
        const backup = `${this.file}.corrupt-${Date.now()}`;
        fs.renameSync(this.file, backup);
        this.data = empty();
        this.recoveredFrom = backup;
      }
    }
  }

  /** Mark dirty; flushes within 300 ms. A failed write is kept (writeError) and retried in 30 s, never thrown from the timer. */
  save(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.flush();
        this.lastWriteError = undefined;
      } catch (e) {
        this.lastWriteError = e instanceof Error ? e.message : String(e);
        this.timer = setTimeout(() => {
          this.timer = null;
          this.save();
        }, 30_000);
        this.timer.unref?.();
      }
    }, 300);
  }

  /** Why the latest write of db.json failed (cleared by the next successful one). */
  writeError(): string | undefined {
    return this.lastWriteError;
  }

  flush(): void {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  list<K extends Exclude<keyof DbShape, 'version' | 'users' | 'emailIndex' | 'ownerId'>>(key: K, userId: string): DbShape[K][string] {
    const bucket = this.data[key] as Record<string, unknown[]>;
    if (!bucket[userId]) bucket[userId] = [];
    return bucket[userId] as DbShape[K][string];
  }
}
