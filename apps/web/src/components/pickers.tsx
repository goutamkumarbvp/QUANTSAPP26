import { useEffect, useMemo, useRef, useState } from 'react';
import { formatExpiry, type OptionChain } from '@q26/core';
import { errorText } from '../lib/api';
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
            {!list.length && (
              <li className="px-3 py-2 text-sm text-muted">
                {meta.error ? errorText(meta.error) : meta.data && !meta.data.symbols.length ? meta.data.gaps?.symbols ?? 'No instruments are loaded yet' : meta.isLoading ? 'Loading…' : 'No match'}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}

/** `at`: list the expiries that were recorded at that time (a recorded view) instead of the listed ones. */
export function ExpirySelect({ symbol, value, onChange, futures, at }: { symbol: string; value: string | undefined; onChange: (e: string) => void; futures?: boolean; at?: number }) {
  const q = useExpiries(symbol, { at });
  const list = (futures ? q.data?.futures : q.data?.options) ?? [];
  const current = value && list.includes(value) ? value : list[0] ?? '';
  useEffect(() => {
    if (list.length && current !== value) onChange(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, list.length]);
  // No expiry to choose from: say why (the server's reason, or that none is listed) instead of an empty box.
  if (!list.length) {
    return (
      <select aria-label="Expiry" className="input w-auto" disabled value="" title={q.error ? errorText(q.error) : q.isLoading ? 'Loading expiries…' : `No listed ${futures ? 'future' : 'option'} expiry`}>
        <option value="">{q.isLoading ? 'Loading…' : 'No expiry'}</option>
      </select>
    );
  }
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

type StrikeSource = Pick<OptionChain, 'atm' | 'forward' | 'rows'>;

/**
 * The strike a picker starts on: the ATM strike, else the listed strike nearest the forward, else the
 * middle listed strike. It only picks a listed contract to look at; no price is derived from it, and
 * without a live spot nothing is labelled ATM.
 */
export function defaultStrike(chain: StrikeSource | undefined): number | undefined {
  const rows = chain?.rows ?? [];
  if (!chain || !rows.length) return undefined;
  if (chain.atm !== null && rows.some((r) => r.strike === chain.atm)) return chain.atm;
  if (chain.forward !== null) {
    const fwd = chain.forward;
    return rows.reduce((best, r) => (Math.abs(r.strike - fwd) < Math.abs(best.strike - fwd) ? r : best), rows[0]).strike;
  }
  return rows[Math.floor(rows.length / 2)].strike;
}

/** The wanted strike when it is listed in the chain, else the default one. */
export function pickStrike(chain: StrikeSource | undefined, wanted?: number): number | undefined {
  return wanted !== undefined && chain?.rows.some((r) => r.strike === wanted) ? wanted : defaultStrike(chain);
}

/** Strike picker over a chain's listed strikes; without a chain it is a disabled box that says why. */
export function StrikeSelect({ chain, value, onChange, error, loading }: { chain: OptionChain | undefined; value: number | undefined; onChange: (k: number) => void; error?: unknown; loading?: boolean }) {
  if (!chain?.rows.length) {
    return (
      <select aria-label="Strike" className="input w-auto" disabled value="" title={error ? errorText(error) : loading ? 'Loading strikes…' : 'No strikes: the option chain is not available'}>
        <option value="">{loading ? 'Loading…' : 'No strikes'}</option>
      </select>
    );
  }
  return (
    <select aria-label="Strike" className="input w-auto" value={value ?? ''} onChange={(e) => onChange(Number(e.target.value))}>
      {chain.rows.map((r) => (
        <option key={r.strike} value={r.strike}>
          {r.strike}
          {r.strike === chain.atm ? ' (ATM)' : ''}
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
