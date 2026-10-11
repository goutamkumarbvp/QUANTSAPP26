/** Number formatting in the Indian style (lakh / crore grouping). */

export function formatIndian(x: number, decimals = 2): string {
  if (!Number.isFinite(x)) return '—';
  const neg = x < 0 && Number(Math.abs(x).toFixed(decimals)) !== 0;
  const fixed = Math.abs(x).toFixed(decimals);
  const [intPart, dec] = fixed.split('.');
  let grouped = intPart;
  if (intPart.length > 3) {
    const last3 = intPart.slice(-3);
    const rest = intPart.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    grouped = `${rest},${last3}`;
  }
  return `${neg ? '-' : ''}${grouped}${dec ? `.${dec}` : ''}`;
}

export function formatINR(x: number, decimals = 0): string {
  if (!Number.isFinite(x)) return '—';
  const neg = x < 0 && Number(Math.abs(x).toFixed(decimals)) !== 0;
  return `${neg ? '-' : ''}₹${formatIndian(Math.abs(x), decimals)}`;
}

/** 1.2K, 3.45L, 12.3Cr */
export function formatCompact(x: number, decimals = 2): string {
  if (!Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  const s = x < 0 ? '-' : '';
  if (a >= 1e7) return `${s}${(a / 1e7).toFixed(decimals)}Cr`;
  if (a >= 1e5) return `${s}${(a / 1e5).toFixed(decimals)}L`;
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(decimals > 1 ? 1 : decimals)}K`;
  return `${s}${a.toFixed(a % 1 === 0 ? 0 : Math.min(decimals, 2))}`;
}

export function formatSigned(x: number, decimals = 2): string {
  if (!Number.isFinite(x)) return '—';
  return `${x > 0 ? '+' : ''}${formatIndian(x, decimals)}`;
}

export function formatPct(x: number, decimals = 2, signed = true): string {
  if (!Number.isFinite(x)) return '—';
  return `${signed && x > 0 ? '+' : ''}${x.toFixed(decimals)}%`;
}

export function formatPrice(x: number): string {
  return formatIndian(x, 2);
}
