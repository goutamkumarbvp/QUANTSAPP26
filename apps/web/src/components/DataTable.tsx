import { useMemo, useState, type ReactNode } from 'react';
import { DASH } from '../lib/format';
import { cx } from './ui';

export interface Column<T> {
  key: string;
  label: ReactNode;
  /** Sort / default-render value; null (not available) sorts last in either direction and shows "—". */
  value?: (r: T) => number | string | null | undefined;
  render?: (r: T) => ReactNode;
  num?: boolean;
  hideSm?: boolean;
  className?: string;
}

/** Default cell text: a missing value is the muted em dash, never "null" / "NaN" / 0. */
function cell(v: number | string | null | undefined): ReactNode {
  if (v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v))) return <span className="text-muted">{DASH}</span>;
  return String(v);
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  initialSort,
  onRowClick,
  maxHeight = '70vh',
  empty = 'No rows',
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T) => string;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  onRowClick?: (r: T) => void;
  maxHeight?: string;
  empty?: ReactNode;
}) {
  const [sort, setSort] = useState(initialSort);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.value) return rows;
    const v = col.value;
    const missing = (x: unknown) => x === null || x === undefined || (typeof x === 'number' && !Number.isFinite(x));
    return [...rows].sort((a, b) => {
      const x = v(a);
      const y = v(b);
      // Rows without a value stay at the bottom whichever way the column is sorted.
      if (missing(x) || missing(y)) return missing(x) && missing(y) ? 0 : missing(x) ? 1 : -1;
      const cmp = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [rows, sort, columns]);

  return (
    <div className="overflow-auto" style={{ maxHeight }}>
      <table className="tbl">
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                className={cx(c.num && 'num', c.hideSm && 'hidden sm:table-cell', c.value && 'cursor-pointer select-none hover:text-ink')}
                onClick={() => c.value && setSort((s) => ({ key: c.key, dir: s?.key === c.key && s.dir === 'desc' ? 'asc' : 'desc' }))}
                aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
              >
                {c.label}
                {sort?.key === c.key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr key={rowKey(r)} className={cx(onRowClick && 'cursor-pointer')} onClick={onRowClick ? () => onRowClick(r) : undefined}>
              {columns.map((c) => (
                <td key={c.key} className={cx(c.num && 'num', c.hideSm && 'hidden sm:table-cell', c.className)}>
                  {c.render ? c.render(r) : c.value ? cell(c.value(r)) : null}
                </td>
              ))}
            </tr>
          ))}
          {!sorted.length && (
            <tr>
              <td colSpan={columns.length} className="py-8 text-center text-muted">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
