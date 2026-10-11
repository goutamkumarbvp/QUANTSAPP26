import { useEffect, useMemo, useRef, useState } from 'react';
import { formatExpiry } from '@q26/core';
import { useExpiries, useMeta } from '../lib/hooks';
import { cx } from './ui';

/** Searchable underlying picker (indices first, then stocks). */
export function SymbolSelect({ value, onChange, kind, className }: { value: string; onChange: (s: string) => void; kind?: 'index' | 'stock'; className?: string }) {
  const meta = useMeta();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const list = useMemo(() => {
    const all = (meta.data?.symbols ?? []).filter((s) => !kind || s.kind === kind);
    const qq = q.trim().toUpperCase();
    return qq ? all.filter((s) => s.symbol.includes(qq) || s.name.toUpperCase().includes(qq)) : all;
  }, [meta.data, q, kind]);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  return (
    <div ref={box} className={cx('relative', className)}>
      <button type="button" className="input flex w-auto min-w-[9rem] items-center justify-between gap-2 font-semibold" onClick={() => setOpen((o) => !o)} aria-haspopup="listbox" aria-label="Select symbol">
        <span>{value}</span>
        <span className="text-muted">▾</span>
      </button>
      {open && (
        <div className="absolute left-0 z-40 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-line bg-panel shadow-xl">
          <input autoFocus className="input rounded-b-none border-0 border-b" placeholder="Search NIFTY, RELIANCE…" value={q} onChange={(e) => setQ(e.target.value)} />
          <ul role="listbox" className="max-h-72 overflow-y-auto py-1">
            {list.map((s) => (
              <li key={s.symbol}>
                <button
                  className={cx('flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-panel2', s.symbol === value && 'text-accent')}
                  onClick={() => {
                    onChange(s.symbol);
                    setOpen(false);
                    setQ('');
                  }}
                >
                  <span className="font-medium">{s.symbol}</span>
                  <span className="ml-2 truncate text-2xs text-muted">{s.kind === 'index' ? `${s.exchange} index` : s.sector}</span>
                </button>
              </li>
            ))}
            {!list.length && <li className="px-3 py-2 text-sm text-muted">No match</li>}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ExpirySelect({ symbol, value, onChange, futures }: { symbol: string; value: string | undefined; onChange: (e: string) => void; futures?: boolean }) {
  const q = useExpiries(symbol);
  const list = (futures ? q.data?.futures : q.data?.options) ?? [];
  const current = value && list.includes(value) ? value : list[0] ?? '';
  useEffect(() => {
    if (list.length && current !== value) onChange(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, list.length]);
  return (
    <select aria-label="Expiry" className="input w-auto" value={current} onChange={(e) => onChange(e.target.value)}>
      {list.map((e) => (
        <option key={e} value={e}>
          {formatExpiry(e)}
        </option>
      ))}
    </select>
  );
}

export function IntervalSelect({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <select aria-label="Interval" className="input w-auto" value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {[1, 3, 5, 15, 30].map((m) => (
        <option key={m} value={m}>
          {m} min
        </option>
      ))}
    </select>
  );
}

/** Session date: empty = today's (live) session, otherwise a past trading day. */
export function SessionDate({ value, onChange, max }: { value: string; onChange: (d: string) => void; max?: string }) {
  return (
    <div className="flex items-center gap-1">
      <input aria-label="Session date" type="date" className="input w-auto" value={value} max={max} onChange={(e) => onChange(e.target.value)} />
      {value && (
        <button className="btn-ghost px-2 py-1 text-xs" onClick={() => onChange('')}>
          Today
        </button>
      )}
    </div>
  );
}
