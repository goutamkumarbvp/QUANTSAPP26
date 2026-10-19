import * as core from '@q26/core';

/**
 * Display formatting. Every formatter takes null/undefined (and NaN/±Infinity) and returns the
 * em dash "—": a value that is not available is blank, never 0 or "NaN".
 */
export const DASH = '—';

type Num = number | null | undefined;

/** True for a real, finite number. */
export function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

export const formatIndian = (x: Num, decimals = 2): string => (isNum(x) ? core.formatIndian(x, decimals) : DASH);
export const formatINR = (x: Num, decimals = 0): string => (isNum(x) ? core.formatINR(x, decimals) : DASH);
export const formatCompact = (x: Num, decimals = 2): string => (isNum(x) ? core.formatCompact(x, decimals) : DASH);
export const formatSigned = (x: Num, decimals = 2): string => (isNum(x) ? core.formatSigned(x, decimals) : DASH);
export const formatPct = (x: Num, decimals = 2, signed = true): string => (isNum(x) ? core.formatPct(x, decimals, signed) : DASH);
export const formatPrice = (x: Num): string => (isNum(x) ? core.formatPrice(x) : DASH);

/** `x.toFixed(decimals)` (+ suffix, e.g. "%" or "x") — "—" without a value. */
export const formatFixed = (x: Num, decimals = 2, suffix = ''): string => (isNum(x) ? `${x.toFixed(decimals)}${suffix}` : DASH);

/** "25 Oct 26" style expiry; "—" without one. */
export const formatExpiry = (date: string | null | undefined): string => (date ? core.formatExpiry(date) : DASH);
export const formatDate = (date: string | null | undefined, withYear = false): string => (date ? core.formatDate(date, withYear) : DASH);

export function formatSessionTime(ts: Num, withSeconds = false): string {
  return isNum(ts) ? core.formatTimeIST(ts, withSeconds) : DASH;
}

export function formatDateTime(ts: Num): string {
  if (!isNum(ts)) return DASH;
  const p = core.istParts(ts);
  return `${core.formatDate(p.date, true)} ${core.formatTimeIST(ts)}`;
}

/** Compact age: 8s, 3m, 2h, 4d. */
export function formatAge(ms: Num): string {
  if (!isNum(ms)) return DASH;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/**
 * When a value was last updated, for values that can be old: "10:42:05" for today (IST), "yesterday
 * 15:30", else "12 Oct 15:30". Pass the server's `clock.ts` as `nowTs` to avoid client clock skew.
 */
export function formatAsOf(ts: Num, nowTs: number = Date.now()): string {
  if (!isNum(ts)) return DASH;
  const d = core.istParts(ts).date;
  const today = core.istParts(nowTs).date;
  if (d === today) return core.formatTimeIST(ts, true);
  if (d === core.addDays(today, -1)) return `yesterday ${core.formatTimeIST(ts)}`;
  return `${core.formatDate(d)} ${core.formatTimeIST(ts)}`;
}

/** OI shown in quantity or lots depending on user preference. */
export function formatOi(qty: Num, lotSize: Num, unit: 'qty' | 'lots'): string {
  if (!isNum(qty)) return DASH;
  if (unit === 'lots') return isNum(lotSize) && lotSize > 0 ? core.formatCompact(qty / lotSize) : DASH;
  return core.formatCompact(qty);
}

export function pnlClass(x: Num): string {
  return !isNum(x) ? 'text-muted' : x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-muted';
}
