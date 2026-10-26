import { ORDER_FLOW_METHOD, type OrderFlowMinute, type OrderFlowResponse } from '@q26/core';
import { FlowSplit } from './trend';
import { Card, Chg, cx, Dash, flowTone } from './ui';
import { formatCompact, formatFixed, formatIndian, formatSessionTime, isNum } from '../lib/format';

/**
 * Order-flow details of one contract (recorded minutes; buyer / seller initiated by the quote rule on
 * live ticks): the last completed minute, the minute in progress and the whole session, and the
 * minute-by-minute table. Shown on the Order Flow & Book page beside the Order & Trade chart.
 */

export type FlowUnit = 'qty' | 'lots';

/** Quantity helpers for the unit chosen (lots only when the contract's lot size is known). */
export function flowUnits(d: Pick<OrderFlowResponse, 'lotSize'>, unit: FlowUnit) {
  const lot = d.lotSize ?? null;
  const eff: FlowUnit = unit === 'lots' && lot ? 'lots' : 'qty';
  const u = (x: number | null): number | null => (x === null ? null : eff === 'lots' && lot ? x / lot : x);
  const fmt = (x: number) => formatCompact(u(x));
  return { lot, eff, u, fmt };
}

/** Last completed minute (detail), the minute in progress and the recorded session. */
export function FlowSummary({ d, unit }: { d: OrderFlowResponse; unit: FlowUnit }) {
  const { lot, eff, u, fmt } = flowUnits(d, unit);
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Card title={d.lastMinute ? `Last 1 minute · ${formatSessionTime(d.lastMinute.ts)}–${formatSessionTime(d.lastMinute.ts + 60_000)}` : 'Last 1 minute'} className="lg:col-span-2">
        {d.lastMinute ? (
          <div className="space-y-3">
            <FlowSplit flow={d.lastMinute} unit={eff} lotSize={lot} />
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
              <div><div className="text-2xs text-muted">Buyer initiated</div><div className="font-semibold text-up tabular-nums">{fmt(d.lastMinute.buyVolume)}</div></div>
              <div><div className="text-2xs text-muted">Seller initiated</div><div className="font-semibold text-down tabular-nums">{fmt(d.lastMinute.sellVolume)}</div></div>
              <div><div className="text-2xs text-muted">Unclassified</div><div className="font-semibold tabular-nums">{fmt(d.lastMinute.unclassified)}{d.lastMinute.unclassifiedPct !== null && <span className="ml-1 text-2xs font-normal text-muted">{formatFixed(d.lastMinute.unclassifiedPct, 0)}%</span>}</div></div>
              <div><div className="text-2xs text-muted">Delta (buy − sell)</div><div className="font-semibold"><Chg value={u(d.lastMinute.delta)} decimals={0} /></div></div>
              <div><div className="text-2xs text-muted">Verdict</div><div className={cx('font-semibold', flowTone(d.lastMinute.sentiment))}>{d.lastMinute.sentiment}</div></div>
            </div>
            <p className="text-sm text-muted">{d.signal}</p>
          </div>
        ) : (
          <div className="py-6 text-center text-sm text-muted">No completed recorded minute yet for this contract.</div>
        )}
      </Card>
      <Card title={d.instrument}>
        <div className="space-y-3">
          {d.currentMinute && (
            <div>
              <div className="mb-1 text-2xs text-muted">Minute in progress {formatSessionTime(d.currentMinute.ts)} · {d.currentMinute.elapsedSec}s so far</div>
              <FlowSplit flow={d.currentMinute} unit={eff} lotSize={lot} compact />
            </div>
          )}
          <div>
            <div className="mb-1 flex justify-between text-2xs text-muted"><span>Recorded session ({d.date})</span><span className={flowTone(d.session.sentiment)}>{d.session.sentiment}</span></div>
            <FlowSplit flow={d.session} unit={eff} lotSize={lot} compact />
            <div className="mt-1 text-2xs text-muted">Cumulative delta <Chg value={u(d.session.delta)} decimals={0} /> · total {fmt(d.session.volume)}</div>
          </div>
          {!lot && <div className="text-2xs text-muted">Lot size of this contract is not known: quantities are shown in units.</div>}
        </div>
      </Card>
    </div>
  );
}

/** The recorded minutes, latest first (the last 60). */
export function MinuteTable({ d, unit }: { d: OrderFlowResponse; unit: FlowUnit }) {
  const { u, fmt } = flowUnits(d, unit);
  const noteOf = (m: OrderFlowMinute) => [m.gapVolume ? `feed gap +${formatCompact(u(m.gapVolume))}` : '', m.partial ? 'partial (lower bound)' : ''].filter(Boolean).join(' · ');
  return (
    <Card title="Minute-by-minute (latest first)" pad={false}>
      <div className="max-h-[50vh] overflow-auto">
        <table className="tbl">
          <thead><tr><th>Minute</th><th className="num">Buy</th><th className="num">Sell</th><th className="num">Unclass.</th><th className="num">Total</th><th className="num">Delta</th><th>Buy % (of classified)</th><th className="num hidden sm:table-cell">Cum. delta</th><th className="num">Close</th><th className="hidden md:table-cell">Note</th></tr></thead>
          <tbody>
            {[...d.minutes].reverse().slice(0, 60).map((m) => (
              <tr key={m.ts}>
                <td>{formatSessionTime(m.ts)}</td>
                <td className="num text-up">{fmt(m.buyVolume)}</td>
                <td className="num text-down">{fmt(m.sellVolume)}</td>
                <td className="num text-muted">{fmt(m.unclassified)}</td>
                <td className="num">{fmt(m.volume)}</td>
                <td className="num"><Chg value={u(m.delta)} decimals={0} /></td>
                <td>
                  {m.buyPct === null ? (
                    <Dash reason="Nothing in this minute could be classified as buy or sell" />
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="relative h-1.5 w-16 overflow-hidden rounded bg-down/60"><span className="absolute inset-y-0 left-0 bg-up" style={{ width: `${m.buyPct}%` }} /></span>
                      <span className="tabular-nums">{formatFixed(m.buyPct, 0)}%</span>
                    </div>
                  )}
                </td>
                <td className="num hidden sm:table-cell"><Chg value={u(m.cumDelta)} decimals={0} /></td>
                <td className="num">{isNum(m.close) ? formatIndian(m.close) : <Dash reason="No trade in this minute" />}</td>
                <td className="hidden text-2xs text-muted md:table-cell">{noteOf(m)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** How buyer / seller initiated quantity is counted. */
export function FlowMethodNote() {
  return (
    <p className="text-xs text-muted">
      Buyer / seller quantity is <b>{ORDER_FLOW_METHOD}</b>: every live tick that raises the session volume is compared with the bid/ask seen just before it — at or above the ask is buyer initiated, at or below the bid seller initiated, anything else unclassified (never split 50/50). Volume seen only in REST snapshots is never classified.
    </p>
  );
}
