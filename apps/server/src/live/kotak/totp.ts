/**
 * RFC 6238 TOTP as Kotak's login expects it: HMAC-SHA1, 30 s period, 6 digits, base32 secret
 * (pyotp defaults used by Kotak's own e2e test; kotak-rest-auth.md §1.5).
 */
import { createHmac } from 'node:crypto';

export const TOTP_PERIOD_MS = 30_000;
/** Do not start a login with a code that expires within this many ms (it may die in flight). */
export const TOTP_MIN_REMAINING_MS = 3_000;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Base32 (RFC 4648) decode, tolerant of lowercase, missing/extra '=' padding, spaces and dashes. */
export function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  if (!clean) throw new Error('TOTP secret is empty');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    // Never echo the secret (or the offending character) in the error.
    if (i < 0) throw new Error('TOTP secret is not valid base32');
    value = ((value << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Time-step counter of a Unix-ms timestamp. */
export function totpCounter(unixMs: number, periodMs = TOTP_PERIOD_MS): number {
  return Math.floor(unixMs / periodMs);
}

/** HOTP value of one counter (RFC 4226 dynamic truncation). */
export function hotp(key: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

export function totp(secret: string, unixMs: number, digits = 6, periodMs = TOTP_PERIOD_MS): string {
  return hotp(base32Decode(secret), totpCounter(unixMs, periodMs), digits);
}

/**
 * Milliseconds to wait before generating a code at `unixMs`: until the next window when fewer
 * than `minRemainingMs` are left in the current one, and (for a re-login) until a window later
 * than `afterCounter`, so the same code is never sent twice. 0 when a code can be used now.
 */
export function totpWaitMs(unixMs: number, opts: { minRemainingMs?: number; afterCounter?: number } = {}): number {
  const minRemaining = opts.minRemainingMs ?? TOTP_MIN_REMAINING_MS;
  const counter = totpCounter(unixMs);
  if (opts.afterCounter !== undefined && counter <= opts.afterCounter) {
    return (opts.afterCounter + 1) * TOTP_PERIOD_MS - unixMs;
  }
  const remaining = (counter + 1) * TOTP_PERIOD_MS - unixMs;
  return remaining < minRemaining ? remaining : 0;
}

export interface FreshTotp {
  code: string;
  counter: number;
}

/** Waits (via the injected sleep) as `totpWaitMs` says, then returns the code and its counter. */
export async function freshTotp(
  secret: string,
  deps: { now: () => number; sleep: (ms: number) => Promise<void> },
  opts: { minRemainingMs?: number; afterCounter?: number } = {},
): Promise<FreshTotp> {
  const key = base32Decode(secret);
  // At most a few rounds: a sleep that wakes slightly early is re-checked, never looped forever.
  for (let i = 0; i < 4; i++) {
    const t = deps.now();
    const wait = totpWaitMs(t, opts);
    if (wait <= 0) {
      const counter = totpCounter(t);
      return { code: hotp(key, counter), counter };
    }
    await deps.sleep(wait + 5);
  }
  throw new Error('Clock did not advance while waiting for a new TOTP window');
}
