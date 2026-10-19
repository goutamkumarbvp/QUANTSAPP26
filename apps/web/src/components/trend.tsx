import { ORDER_FLOW_METHOD, type OrbTrend, type OrderFlowSummary } from '@q26/core';
import { formatCompact, isNum } from '../lib/format';
import { cx, flowTone } from './ui';

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

/**
 * Buyers-vs-sellers split bar of an order-flow summary. The split is an ESTIMATE from live ticks (quote rule):
 * the percentages are shares of the classified volume, units that could not be classified are shown apart
 * (grey) and never split 50/50, units reported after a feed gap are listed but not counted, and a partial minute
 * is marked as a lower bound.
 */
export function FlowSplit({ flow, unit = 'qty', lotSize, compact }: { flow: OrderFlowSummary; unit?: 'qty' | 'lots'; lotSize?: number | null; compact?: boolean }) {
  const lot = unit === 'lots' && isNum(lotSize) && lotSize > 0 ? lotSize : null;
  const q = (x: number) => formatCompact(lot ? x / lot : x);
  const small = compact ? 'text-2xs' : 'text-xs';
  const notes = (
    <>
      {flow.gapVolume > 0 && <div className="text-2xs text-warn" title="Units reported by the first tick after a feed gap: they traded at an unknown time during the gap, so they are not counted as buy or sell">feed gap: {q(flow.gapVolume)} not counted</div>}
      {flow.partialMinutes > 0 && <div className="text-2xs text-warn" title="Recording of this contract started or restarted inside the minute: its volume is a lower bound">partial (lower bound){flow.partialMinutes > 1 ? ` · ${flow.partialMinutes} minutes` : ''}</div>}
    </>
  );
  if (flow.volume === 0) {
    return (
      <div className="w-full" title={ORDER_FLOW_METHOD}>
        <div className={cx('text-center font-semibold', flow.gapVolume > 0 ? 'text-warn' : 'text-muted', small)}>{flow.gapVolume > 0 ? 'Feed gap — nothing classified' : 'No trades yet'}</div>
        <div className={cx('mt-1 rounded-full bg-line', compact ? 'h-1.5' : 'h-3')} role="img" aria-label={flow.gapVolume > 0 ? 'Feed gap' : 'No trades'} />
        {notes}
      </div>
    );
  }
  const buyPct = flow.buyPct;
  const pctOfVolume = (x: number) => `${(x / flow.volume) * 100}%`;
  return (
    <div className="w-full" title={`${ORDER_FLOW_METHOD}; percentages are of the classified volume`}>
      {buyPct === null ? (
        <div className={cx('text-center font-semibold text-muted', small)}>Not classified — {q(flow.volume)} traded</div>
      ) : (
        <div className={cx('flex justify-between font-semibold tabular-nums', small)}>
          <span className="text-up">Buyers {q(flow.buyVolume)} · {buyPct.toFixed(0)}%</span>
          <span className="text-down">{(100 - buyPct).toFixed(0)}% · {q(flow.sellVolume)} Sellers</span>
        </div>
      )}
      <div className={cx('mt-1 flex overflow-hidden rounded-full bg-line', compact ? 'h-1.5' : 'h-3')} role="img" aria-label={buyPct === null ? 'Volume not classified' : `Buy volume ${buyPct.toFixed(0)} percent of classified`}>
        <div className="bg-up transition-all" style={{ width: pctOfVolume(flow.buyVolume) }} />
        <div className="bg-muted/40 transition-all" style={{ width: pctOfVolume(flow.unclassified) }} />
        <div className="bg-down transition-all" style={{ width: pctOfVolume(flow.sellVolume) }} />
      </div>
      {flow.unclassified > 0 && (
        <div className="text-2xs text-muted tabular-nums">
          unclassified {q(flow.unclassified)}{isNum(flow.unclassifiedPct) ? ` (${flow.unclassifiedPct.toFixed(0)}% of volume)` : ''}
        </div>
      )}
      {notes}
    </div>
  );
}

/** Text colour of an estimated order-flow sentiment ("Feed gap" included). */
export function sentimentTone(s: OrderFlowSummary['sentiment'] | null | undefined): string {
  return flowTone(s);
}
