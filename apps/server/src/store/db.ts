/**
 * Small JSON document store with atomic, debounced writes. Good enough for a single-node
 * deployment; swap for Postgres/SQLite behind the same methods when scaling out.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AlertDef, Notification, Order, SavedStrategy, Trade, UserSettings, Watchlist } from '@q26/core';

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
});

export class Db {
  data: DbShape;
  private timer: NodeJS.Timeout | null = null;
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
      }
    }
  }

  /** Mark dirty; flushes within 300 ms. */
  save(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 300);
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

  list<K extends Exclude<keyof DbShape, 'version' | 'users' | 'emailIndex'>>(key: K, userId: string): DbShape[K][string] {
    const bucket = this.data[key] as Record<string, unknown[]>;
    if (!bucket[userId]) bucket[userId] = [];
    return bucket[userId] as DbShape[K][string];
  }
}
