import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { UserProfile, UserSettings } from '@q26/core';
import type { Db, StoredUser } from './store/db';

const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
export const DEFAULT_BALANCE = 1_000_000;

export function defaultSettings(): UserSettings {
  return { theme: 'dark', defaultSymbol: 'NIFTY', strikesAround: 15, showGreeks: false, oiUnit: 'qty', riskFreeRate: 0.065 };
}

function httpError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}

export class Auth {
  constructor(private readonly db: Db, private readonly secret: string) {}

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  issue(userId: string): string {
    const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  verify(token: string | undefined): StoredUser | null {
    if (!token) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = this.sign(payload);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const { uid, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { uid: string; exp: number };
      if (typeof exp !== 'number' || exp < Date.now()) return null;
      return this.db.data.users[uid] ?? null;
    } catch {
      return null;
    }
  }

  private hash(password: string, salt: string): string {
    return scryptSync(password, salt, 64).toString('hex');
  }

  register(name: string, email: string, password: string): StoredUser {
    const key = email.trim().toLowerCase();
    if (this.db.data.emailIndex[key]) throw httpError(409, 'An account with this email already exists');
    if (password.length < 6) throw httpError(400, 'Password must be at least 6 characters');
    const salt = randomBytes(16).toString('hex');
    const user: StoredUser = {
      id: randomUUID(),
      name: name.trim() || key.split('@')[0],
      email: key,
      guest: false,
      salt,
      passwordHash: this.hash(password, salt),
      createdAt: Date.now(),
      settings: defaultSettings(),
      openingBalance: DEFAULT_BALANCE,
    };
    this.db.data.users[user.id] = user;
    this.db.data.emailIndex[key] = user.id;
    this.db.save();
    return user;
  }

  login(email: string, password: string): StoredUser {
    const id = this.db.data.emailIndex[email.trim().toLowerCase()];
    const user = id ? this.db.data.users[id] : undefined;
    if (!user || !user.salt || !user.passwordHash) throw httpError(401, 'Invalid email or password');
    const a = Buffer.from(this.hash(password, user.salt), 'hex');
    const b = Buffer.from(user.passwordHash, 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw httpError(401, 'Invalid email or password');
    return user;
  }

  guest(): StoredUser {
    const user: StoredUser = {
      id: randomUUID(),
      name: 'Guest Trader',
      email: '',
      guest: true,
      createdAt: Date.now(),
      settings: defaultSettings(),
      openingBalance: DEFAULT_BALANCE,
    };
    this.db.data.users[user.id] = user;
    this.db.save();
    return user;
  }

  /** Convert a guest account into a registered one, keeping its data. */
  upgrade(user: StoredUser, name: string, email: string, password: string): StoredUser {
    const key = email.trim().toLowerCase();
    if (this.db.data.emailIndex[key]) throw httpError(409, 'An account with this email already exists');
    if (password.length < 6) throw httpError(400, 'Password must be at least 6 characters');
    user.salt = randomBytes(16).toString('hex');
    user.passwordHash = this.hash(password, user.salt);
    user.email = key;
    user.name = name.trim() || user.name;
    user.guest = false;
    this.db.data.emailIndex[key] = user.id;
    this.db.save();
    return user;
  }
}

export function profile(u: StoredUser): UserProfile {
  return { id: u.id, name: u.name, email: u.email, guest: u.guest, createdAt: u.createdAt, settings: u.settings };
}
