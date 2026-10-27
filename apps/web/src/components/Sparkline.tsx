import { useMemo } from 'react';
import { cx } from './ui';

/**
 * A small line + area of a series as inline SVG (no chart engine): the Home index cards draw several at
 * once and the page can show them before the charting library has loaded. A null value is a gap in the line.
 */
export function Sparkline({ values, height = 44, className }: { values: readonly (number | null)[]; height?: number; className?: string }) {
  const paths = useMemo(() => {
    const finite = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    if (finite.length < 2) return null;
    const W = 100;
    const pad = 2;
    const lo = Math.min(...finite);
    const hi = Math.max(...finite);
    const span = hi - lo || 1;
    const X = (i: number) => (values.length > 1 ? (i / (values.length - 1)) * W : 0);
    const Y = (v: number) => pad + ((hi - v) / span) * (height - 2 * pad);
    // One sub-path per run of values (a null breaks the line, nothing is drawn across it).
    const runs: [number, number][][] = [];
    let run: [number, number][] = [];
    values.forEach((v, i) => {
      if (typeof v === 'number' && Number.isFinite(v)) run.push([X(i), Y(v)]);
      else if (run.length) {
        runs.push(run);
        run = [];
      }
    });
    if (run.length) runs.push(run);
    const line = runs.map((r) => r.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join('')).join('');
    const area = runs
      .filter((r) => r.length > 1)
      .map((r) => `M${r[0][0].toFixed(2)},${height}${r.map(([x, y]) => `L${x.toFixed(2)},${y.toFixed(2)}`).join('')}L${r[r.length - 1][0].toFixed(2)},${height}Z`)
      .join('');
    return { W, line, area };
  }, [values, height]);
  if (!paths) return <div style={{ height }} />;
  return (
    <svg viewBox={`0 0 ${paths.W} ${height}`} preserveAspectRatio="none" className={cx('block w-full', className)} style={{ height }} aria-hidden="true">
      <path d={paths.area} fill="currentColor" fillOpacity="0.08" />
      <path d={paths.line} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}
