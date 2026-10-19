import { useEffect, type ReactNode } from 'react';
import type { BuildUp, OrderFlowSummary } from '@q26/core';
import { errorText, isNoLiveData } from '../lib/api';
import { DASH, formatAsOf, formatDateTime, formatIndian, formatPct, isNum } from '../lib/format';
import { useTicks } from '../lib/store';

export function cx(...c: Array<string | false | null | undefined>): string {
  return c.filter(Boolean).join(' ');
}

export function PageHeader({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
      <div className="min-w-0">
        <h1 className="text-lg font-semibold sm:text-xl">{title}</h1>
        {subtitle && <p className="text-xs text-muted sm:text-sm">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className, pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cx('card min-w-0', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2 sm:px-4">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions && <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={pad ? 'card-pad' : ''}>{children}</div>
    </section>
  );
}

/**
 * A labelled figure. A missing value (null / undefined / NaN) shows a muted "—" whose tooltip is the
 * `reason` (when known) — never 0.
 */
export function Stat({ label, value, sub, tone, hint, reason }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'up' | 'down' | 'warn' | 'accent'; hint?: string; reason?: string | null }) {
  const missing = value === null || value === undefined || value === false || (typeof value === 'number' && !Number.isFinite(value));
  return (
    <div className="min-w-0 rounded-lg border border-line bg-panel2/60 px-3 py-2" title={missing ? reason ?? hint : hint}>
      <div className="truncate text-2xs uppercase tracking-wide text-muted">{label}</div>
      <div className={cx('truncate text-base font-semibold tabular-nums', !missing && tone === 'up' && 'text-up', !missing && tone === 'down' && 'text-down', !missing && tone === 'warn' && 'text-warn', !missing && tone === 'accent' && 'text-accent', missing && 'text-muted')}>{missing ? DASH : value}</div>
      {sub && <div className="truncate text-2xs text-muted">{sub}</div>}
      {missing && reason && <div className="truncate text-2xs text-muted">{reason}</div>}
    </div>
  );
}

export function Segmented<T extends string | number>({ value, onChange, options, size = 'sm' }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; size?: 'sm' | 'xs' }) {
  return (
    <div className="inline-flex max-w-full overflow-x-auto rounded-lg border border-line bg-panel2 p-0.5 no-scrollbar" role="tablist">
      {options.map((o) => (
        <button
          key={String(o.value)}
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
          className={cx(
            'whitespace-nowrap rounded-md font-medium transition-colors',
            size === 'sm' ? 'px-2.5 py-1 text-xs sm:text-sm' : 'px-2 py-0.5 text-2xs sm:text-xs',
            o.value === value ? 'bg-accent text-white shadow' : 'text-muted hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Select<T extends string | number>({ value, onChange, options, className, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; className?: string; label?: string }) {
  return (
    <select
      aria-label={label}
      className={cx('input w-auto pr-7', className)}
      value={String(value)}
      onChange={(e) => {
        const o = options.find((x) => String(x.value) === e.target.value);
        if (o) onChange(o.value);
      }}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block min-w-0', className)}>
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} className="inline-flex items-center gap-2 text-xs text-muted sm:text-sm">
      <span className={cx('relative h-5 w-9 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-line')}>
        <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all', checked ? 'left-[18px]' : 'left-0.5')} />
      </span>
      {label}
    </button>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      {label}
    </div>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  return <div className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-sm text-down">{error instanceof Error ? error.message : String(error)}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-10 text-center text-sm text-muted">{children}</div>;
}

/**
 * Blank state: the answer is not available, and why. Used instead of an empty chart / table / zeros when the
 * server has no live or official data for it (HTTP 503 NO_LIVE_DATA) or the response says so in `gaps`.
 * `reason` is the server's text; `hint` is an extra line such as "Recording started 2026-10-13".
 */
export function NoData({ reason, title = 'No data available', hint, compact, className }: { reason?: ReactNode; title?: ReactNode; hint?: ReactNode; compact?: boolean; className?: string }) {
  return (
    <div role="status" className={cx('flex flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line px-4 text-center', compact ? 'py-4' : 'py-10', className)}>
      <div className={cx('font-semibold text-muted', compact ? 'text-base' : 'text-2xl')} aria-hidden>
        {DASH}
      </div>
      <div className="text-sm font-medium">{title}</div>
      {reason ? <div className="max-w-xl text-sm text-muted">{reason}</div> : null}
      {hint ? <div className="max-w-xl text-xs text-muted">{hint}</div> : null}
    </div>
  );
}

/** A failed query: the blank state with the server's reason for NO_LIVE_DATA, the red box for any other error. */
export function ErrorState({ error, hint, compact, title }: { error: unknown; hint?: ReactNode; compact?: boolean; title?: ReactNode }) {
  if (isNoLiveData(error)) return <NoData title={title} reason={error.message} hint={hint} compact={compact} />;
  return <ErrorBox error={error} />;
}

/**
 * Query wrapper: spinner while loading, the blank state (server reason) for 503 NO_LIVE_DATA, the red box for
 * other errors. A NO_LIVE_DATA answer replaces older data on screen (the server says nothing is live now); after any
 * other failed refresh the last answer stays, with a note.
 */
export function Loadable<T>({ q, children, hint, compact, title }: { q: { data?: T; isLoading: boolean; error: unknown }; children: (d: T) => ReactNode; hint?: ReactNode; compact?: boolean; title?: ReactNode }) {
  if (isNoLiveData(q.error)) return <NoData title={title} reason={q.error.message} hint={hint} compact={compact} />;
  if (q.error && q.data === undefined) return <ErrorBox error={q.error} />;
  if (q.isLoading || q.data === undefined) return <Spinner />;
  return (
    <>
      {q.error ? <div className="mb-2 text-2xs text-warn">Could not refresh — showing the last answer ({errorText(q.error)})</div> : null}
      {children(q.data)}
    </>
  );
}

/** The blank marker: a muted em dash; its tooltip gives the reason when one is known. */
export function Dash({ reason, className }: { reason?: string | null; className?: string }) {
  return (
    <span className={cx('text-muted', reason && 'cursor-help', className)} title={reason ?? undefined} aria-label={reason ? `Not available: ${reason}` : 'Not available'}>
      {DASH}
    </span>
  );
}

/**
 * Null-safe value: `format(value)` for a real number (a string is shown as is), otherwise a muted "—" with the
 * `reason` as tooltip. `<Val value={row.ce.iv} format={(x) => x.toFixed(2)} reason={chain.gaps?.atmIv} />`
 */
export function Val({ value, format, reason, className }: { value: number | string | null | undefined; format?: (n: number) => string; reason?: string | null; className?: string }) {
  if (typeof value === 'string' && value !== '') return <span className={className}>{value}</span>;
  if (!isNum(value)) return <Dash reason={reason} className={className} />;
  return <span className={cx('tabular-nums', className)}>{format ? format(value) : formatIndian(value)}</span>;
}

/** Sections of a response that are not available, as a small muted notice: section → reason. */
export function Gaps({ gaps, only, omit, max = 6, className }: { gaps?: Record<string, string> | null; only?: string[]; omit?: string[]; max?: number; className?: string }) {
  const all = Object.entries(gaps ?? {}).filter(([k, why]) => why && (!only || only.includes(k)) && !omit?.includes(k));
  if (!all.length) return null;
  const shown = all.slice(0, max);
  return (
    <ul className={cx('space-y-0.5 text-2xs text-muted', className)} aria-label="Not available" title={all.length > shown.length ? all.map(([k, why]) => `${k} → ${why}`).join('\n') : undefined}>
      {shown.map(([k, why]) => (
        <li key={k}>
          <span className="font-medium">{k}</span> → {why}
        </li>
      ))}
      {all.length > shown.length && <li>+{all.length - shown.length} more</li>}
    </ul>
  );
}

/** What a value covers ("PCR over strikes with OI on both sides", "streamed strikes ±8 %"): a small note next to it. */
export function Coverage({ text, label, className }: { text?: string | null; label?: string; className?: string }) {
  if (!text) return null;
  return (
    <div className={cx('text-2xs text-muted', className)}>
      {label ? <span className="font-medium">{label}: </span> : null}
      {text}
    </div>
  );
}

/** When a value that can be old was last updated ("LTP 10:42:05", "as of yesterday 15:30"); tooltip = full date and time. */
export function AsOf({ ts, label = 'as of', className }: { ts: number | null | undefined; label?: string; className?: string }) {
  const serverNow = useTicks((s) => s.clock?.ts);
  if (!isNum(ts)) return null;
  return (
    <span className={cx('text-2xs tabular-nums text-muted', className)} title={formatDateTime(ts)}>
      {label} {formatAsOf(ts, serverNow ?? Date.now())}
    </span>
  );
}

const BUILDUP_STYLE: Record<BuildUp, string> = {
  'Long Build-up': 'bg-up/15 text-up',
  'Short Covering': 'bg-accent/15 text-accent',
  'Short Build-up': 'bg-down/15 text-down',
  'Long Unwinding': 'bg-warn/15 text-warn',
  Neutral: 'bg-line text-muted',
};

const BUILDUP_SHORT: Record<BuildUp, string> = {
  'Long Build-up': 'LB',
  'Short Covering': 'SC',
  'Short Build-up': 'SB',
  'Long Unwinding': 'LU',
  Neutral: '—',
};

export function BuildUpBadge({ value, short, reason }: { value: BuildUp | null | undefined; short?: boolean; reason?: string | null }) {
  if (!value) return <Dash reason={reason} />;
  return (
    <span className={cx('chip', BUILDUP_STYLE[value])} title={value}>
      {short ? BUILDUP_SHORT[value] : value}
    </span>
  );
}

/** Signed change, green / red; a missing value is a muted "—" (tooltip: `reason`). */
export function Chg({ value, pct, decimals = 2, className, reason }: { value: number | null | undefined; pct?: boolean; decimals?: number; className?: string; reason?: string | null }) {
  if (!isNum(value)) return <Dash reason={reason} className={className} />;
  const tone = value > 0 ? 'text-up' : value < 0 ? 'text-down' : 'text-muted';
  return <span className={cx('tabular-nums', tone, className)}>{pct ? formatPct(value, decimals) : `${value > 0 ? '+' : ''}${formatIndian(value, decimals)}`}</span>;
}

/** Text colour of an estimated order-flow sentiment (quote-rule estimate, see ORDER_FLOW_METHOD). */
export function flowTone(sentiment: OrderFlowSummary['sentiment'] | null | undefined): string {
  return sentiment === 'Buyers dominant' ? 'text-up' : sentiment === 'Sellers dominant' ? 'text-down' : sentiment === 'Feed gap' ? 'text-warn' : 'text-muted';
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" className={cx('card max-h-[92vh] w-full overflow-y-auto rounded-b-none sm:rounded-xl', wide ? 'sm:max-w-3xl' : 'sm:max-w-md')} onClick={(e) => e.stopPropagation()}>
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-panel px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="btn-ghost px-2 py-1" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Pill({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'up' | 'down' | 'accent' | 'warn' }) {
  const t = { muted: 'bg-line text-muted', up: 'bg-up/15 text-up', down: 'bg-down/15 text-down', accent: 'bg-accent/15 text-accent', warn: 'bg-warn/15 text-warn' }[tone];
  return <span className={cx('chip', t)}>{children}</span>;
}
