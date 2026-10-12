import type { FlowSummary, OrbTrend } from '@q26/core';
import { formatCompact } from '../lib/format';
import { cx } from './ui';

const TREND_STYLE: Record<OrbTrend, { label: string; cls: string }> = {
  up: { label: 'Trending ↑', cls: 'bg-up/15 text-up' },
  down: { label: 'Trending ↓', cls: 'bg-down/15 text-down' },
  sideways: { label: 'Sideways', cls: 'bg-line text-muted' },
  forming: { label: 'Forming', cls: 'bg-warn/15 text-warn' },
};

/** Opening-range trend state: up / down / sideways / still forming. */
export function TrendBadge({ trend, whipsaw, reentered, pending, large }: { trend: OrbTrend; whipsaw?: boolean; reentered?: boolean; pending?: 'up' | 'down' | null; large?: boolean }) {
  const s = TREND_STYLE[trend];
  return (
    <span className="inline-flex items-center gap-1">
      <span className={cx('chip', s.cls, large && 'px-2.5 py-1 text-sm')}>{s.label}</span>
      {whipsaw && <span className="chip bg-warn/15 text-warn" title="Both the range high and low were broken today">whipsaw</span>}
      {reentered && <span className="chip bg-line text-muted" title="Price is back inside the opening range">back inside</span>}
      {pending && (
        <span className="chip bg-line text-muted" title="The minute in progress is beyond this level, but no 1-minute candle has closed there yet">
          testing {pending === 'up' ? 'high' : 'low'}
        </span>
      )}
    </span>
  );
}

/** Horizontal buyers-vs-sellers split bar with quantities. */
export function FlowSplit({ flow, unit = 'qty', lotSize = 1, compact }: { flow: FlowSummary; unit?: 'qty' | 'lots'; lotSize?: number; compact?: boolean }) {
  const buyPct = flow.volume > 0 ? flow.buyPct : 50;
  const q = (x: number) => formatCompact(unit === 'lots' ? x / lotSize : x);
  if (flow.volume === 0) {
    return (
      <div className="w-full">
        <div className={cx('text-center font-semibold text-muted', compact ? 'text-2xs' : 'text-xs')}>No trades yet</div>
        <div className={cx('mt-1 rounded-full bg-line', compact ? 'h-1.5' : 'h-3')} role="img" aria-label="No trades" />
      </div>
    );
  }
  return (
    <div className="w-full">
      <div className={cx('flex justify-between font-semibold tabular-nums', compact ? 'text-2xs' : 'text-xs')}>
        <span className="text-up">Buyers {q(flow.buyVolume)} · {buyPct.toFixed(0)}%</span>
        <span className="text-down">{(100 - buyPct).toFixed(0)}% · {q(flow.sellVolume)} Sellers</span>
      </div>
      <div className={cx('mt-1 flex overflow-hidden rounded-full bg-line', compact ? 'h-1.5' : 'h-3')} role="img" aria-label={`Buy volume ${buyPct.toFixed(0)} percent`}>
        <div className="bg-up transition-all" style={{ width: `${buyPct}%` }} />
        <div className="bg-down transition-all" style={{ width: `${100 - buyPct}%` }} />
      </div>
    </div>
  );
}

export function sentimentTone(s: FlowSummary['sentiment']): string {
  return s === 'Buyers dominant' ? 'text-up' : s === 'Sellers dominant' ? 'text-down' : 'text-muted';
}
