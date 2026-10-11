import { formatCompact, formatDate, formatTimeIST, istParts } from '@q26/core';

export { formatCompact, formatIndian, formatINR, formatPct, formatPrice, formatSigned, formatExpiry, formatDate } from '@q26/core';

export function formatSessionTime(ts: number): string {
  return formatTimeIST(ts);
}

export function formatDateTime(ts: number): string {
  const p = istParts(ts);
  return `${formatDate(p.date, true)} ${formatTimeIST(ts)}`;
}

/** OI shown in quantity or lots depending on user preference. */
export function formatOi(qty: number, lotSize: number, unit: 'qty' | 'lots'): string {
  return unit === 'lots' ? formatCompact(qty / lotSize) : formatCompact(qty);
}

export function pnlClass(x: number): string {
  return x > 0 ? 'text-up' : x < 0 ? 'text-down' : 'text-muted';
}
