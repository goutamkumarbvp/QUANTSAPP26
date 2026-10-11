import { useEffect, type ReactNode } from 'react';
import type { BuildUp } from '@q26/core';
import { formatIndian, formatPct } from '@q26/core';

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

export function Stat({ label, value, sub, tone, hint }: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'up' | 'down' | 'warn' | 'accent'; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-panel2/60 px-3 py-2" title={hint}>
      <div className="truncate text-2xs uppercase tracking-wide text-muted">{label}</div>
      <div className={cx('truncate text-base font-semibold tabular-nums', tone === 'up' && 'text-up', tone === 'down' && 'text-down', tone === 'warn' && 'text-warn', tone === 'accent' && 'text-accent')}>{value}</div>
      {sub && <div className="truncate text-2xs text-muted">{sub}</div>}
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

export function Loadable<T>({ q, children }: { q: { data?: T; isLoading: boolean; error: unknown }; children: (d: T) => ReactNode }) {
  if (q.error && !q.data) return <ErrorBox error={q.error} />;
  if (q.isLoading || q.data === undefined) return <Spinner />;
  return <>{children(q.data)}</>;
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

export function BuildUpBadge({ value, short }: { value: BuildUp; short?: boolean }) {
  return (
    <span className={cx('chip', BUILDUP_STYLE[value])} title={value}>
      {short ? BUILDUP_SHORT[value] : value}
    </span>
  );
}

export function Chg({ value, pct, decimals = 2, className }: { value: number; pct?: boolean; decimals?: number; className?: string }) {
  const tone = value > 0 ? 'text-up' : value < 0 ? 'text-down' : 'text-muted';
  return <span className={cx('tabular-nums', tone, className)}>{pct ? formatPct(value, decimals) : `${value > 0 ? '+' : ''}${formatIndian(value, decimals)}`}</span>;
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
