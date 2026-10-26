import { useMemo, useState } from 'react';
import { flowDirection, flowSpikes, formatTimeIST, type FlowSpike, type OrderFlowResponse } from '@q26/core';
import { Chart, axis, baseOption, useChartColors } from './Chart';
import { Card, Coverage, cx, Segmented, Stat } from './ui';
import { formatCompact, formatIndian, formatSessionTime, isNum } from '../lib/format';

/**
 * Order & Trade chart (as on Quantsapp): 1-minute candles of the contract with volume, and below them the
 * buyer-initiated and seller-initiated quantity of every minute since the open, on one time axis.
 * Spikes (≥ 3× the median of the previous 30 minutes) mark large aggressive orders; the direction read
 * compares who initiated more quantity with what the price did. Recorded minutes only: a minute without
 * a record is a gap, never filled.
 */

const MIN = 60_000;
type Layout = 'overlay' | 'separate';
type Unit = 'qty' | 'lots';

/** `[ts, v]` pairs with a null where whole minutes are missing, so a line never bridges a gap. */
function gapped<T extends { ts: number }>(rows: readonly T[], pick: (r: T) => number | null): [number, number | null][] {
  const out: [number, number | null][] = [];
  rows.forEach((r, i) => {
    if (i > 0 && r.ts - rows[i - 1].ts > MIN * 1.5) out.push([rows[i - 1].ts + MIN, null]);
    out.push([r.ts, pick(r)]);
  });
  return out;
}

const TONE: Record<string, 'up' | 'down' | 'warn' | undefined> = { buyers: 'up', sellers: 'down', 'buying-absorbed': 'warn', 'selling-absorbed': 'warn', balanced: undefined };
const LABEL: Record<string, string> = { buyers: 'Buyers in control', sellers: 'Sellers in control', 'buying-absorbed': 'Buying absorbed', 'selling-absorbed': 'Selling absorbed', balanced: 'Balanced' };

export function OrderTradeChart({ d }: { d: OrderFlowResponse }) {
  const c = useChartColors();
  const [layout, setLayout] = useState<Layout>('overlay');
  const [unit, setUnit] = useState<Unit>('qty');
  const [lookback, setLookback] = useState(15);
  const lot = d.lotSize && d.lotSize > 0 ? d.lotSize : null;
  const u = unit === 'lots' && lot ? lot : 1;
  const unitLabel = unit === 'lots' && lot ? 'lots' : 'qty';

  const spikes = useMemo(() => flowSpikes(d.minutes), [d.minutes]);
  const dir = useMemo(() => flowDirection(d.minutes, { lookback, spikes }), [d.minutes, lookback, spikes]);
  const sessionBuySpikes = spikes.filter((s) => s.side === 'buy').length;
  const sessionSellSpikes = spikes.length - sessionBuySpikes;

  const option = useMemo(() => {
    const m = d.minutes;
    const sep = layout === 'separate';
    // Pixel layout of the panes (the chart is 640 px high).
    const grids = sep
      ? [{ top: 34, height: 250 }, { top: 290, height: 50 }, { top: 362, height: 110 }, { top: 492, height: 110 }]
      : [{ top: 34, height: 270 }, { top: 310, height: 60 }, { top: 392, height: 210 }];
    const n = grids.length;
    const xMin = m.length ? m[0].ts - MIN / 2 : undefined;
    const xMax = m.length ? m[m.length - 1].ts + MIN / 2 : undefined;
    const xAxis = grids.map((_, i) => ({
      type: 'time',
      gridIndex: i,
      min: xMin,
      max: xMax,
      ...axis(c, { splitLine: { show: false } }),
      axisLabel: { show: i === n - 1, color: c.muted, fontSize: 11, formatter: (v: number) => formatSessionTime(v), hideOverlap: true },
    }));
    const qtyAxis = (i: number) => ({ type: 'value', gridIndex: i, scale: false, min: 0, ...axis(c), axisLabel: { color: c.muted, fontSize: 10, formatter: (v: number) => formatCompact(v, 1) }, splitNumber: 3 });
    // Pane captions in the top-left corner of each pane.
    const captions = (sep ? [`Volume`, `Buyer initiated (${unitLabel})`, `Seller initiated (${unitLabel})`] : [`Volume`, `Buyer vs seller initiated (${unitLabel})`]).map((text, i) => ({ text, left: 14, top: grids[i + 1].top - 2, textStyle: { color: c.muted, fontSize: 10, fontWeight: 'normal' } }));
    const yAxis: Record<string, unknown>[] = [
      { type: 'value', gridIndex: 0, scale: true, ...axis(c), axisLabel: { color: c.muted, fontSize: 11, formatter: (v: number) => formatIndian(v, 0) } },
      { type: 'value', gridIndex: 1, min: 0, ...axis(c, { splitLine: { show: false } }), axisLabel: { show: false } },
      ...(sep ? [qtyAxis(2), qtyAxis(3)] : [qtyAxis(2)]),
    ];
    const spikePoints = (side: FlowSpike['side']) =>
      spikes
        .filter((s) => s.side === side)
        .map((s) => ({ coord: [s.ts, s.qty / u], value: `${s.ratio}×`, itemStyle: { color: side === 'buy' ? c.up : c.down } }));
    const markPoint = (side: FlowSpike['side']) => ({ symbol: 'pin', symbolSize: 28, label: { fontSize: 9, color: '#fff' }, data: spikePoints(side) });
    const candles = m.filter((x) => isNum(x.open) && isNum(x.close) && isNum(x.low) && isNum(x.high)).map((x) => [x.ts, x.open, x.close, x.low, x.high]);
    return {
      ...baseOption(c, { grid: grids.map((g) => ({ left: 8, right: 64, top: g.top, height: g.height, containLabel: false })) }),
      // Refreshed every few seconds with a whole session of minutes: drawn at once, not animated.
      animation: false,
      title: captions,
      legend: { top: 0, textStyle: { color: c.muted, fontSize: 11 }, itemWidth: 14, itemHeight: 8, data: ['Price', 'Buyer initiated', 'Seller initiated'] },
      axisPointer: { link: [{ xAxisIndex: 'all' }] },
      xAxis,
      yAxis: yAxis.map((y) => ({ ...y, position: 'right' })),
      dataZoom: [{ type: 'inside', xAxisIndex: grids.map((_, i) => i) }],
      series: [
        { name: 'Price', type: 'candlestick', xAxisIndex: 0, yAxisIndex: 0, barMaxWidth: 8, itemStyle: { color: c.up, color0: c.down, borderColor: c.up, borderColor0: c.down }, data: candles },
        {
          name: 'Volume',
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 1,
          barMaxWidth: 6,
          data: m.map((x) => ({ value: [x.ts, x.volume / u], itemStyle: { color: x.delta >= 0 ? c.up : c.down, opacity: x.partial ? 0.35 : 0.7 } })),
        },
        { name: 'Buyer initiated', type: 'line', xAxisIndex: 2, yAxisIndex: 2, symbol: 'none', lineStyle: { width: 1.2 }, itemStyle: { color: c.up }, data: gapped(m, (x) => x.buyVolume / u), markPoint: markPoint('buy') },
        { name: 'Seller initiated', type: 'line', xAxisIndex: sep ? 3 : 2, yAxisIndex: sep ? 3 : 2, symbol: 'none', lineStyle: { width: 1.2 }, itemStyle: { color: c.down }, data: gapped(m, (x) => x.sellVolume / u), markPoint: markPoint('sell') },
      ],
    };
  }, [d.minutes, layout, c, spikes, u, unitLabel]);

  const recent = [...spikes].reverse().slice(0, 8);
  return (
    <Card
      title={`Order & Trade chart — ${d.instrument} (1-minute, buyer vs seller initiated quantity)`}
      actions={
        <>
          <Segmented size="xs" value={layout} onChange={setLayout} options={[{ value: 'overlay', label: 'One pane' }, { value: 'separate', label: 'Two panes' }]} />
          <Segmented size="xs" value={unit} onChange={setUnit} options={[{ value: 'qty', label: 'Qty' }, { value: 'lots', label: 'Lots' }]} />
          <Segmented size="xs" value={lookback} onChange={setLookback} options={[5, 15, 30].map((v) => ({ value: v, label: `${v}m` }))} />
        </>
      }
    >
      {dir && (
        <div className="mb-3 space-y-2">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <Stat label={`Read · last ${dir.minutes} min`} value={LABEL[dir.read]} tone={TONE[dir.read]} />
            <Stat label="Buyer initiated" value={formatCompact(dir.buy / u, 2)} tone="up" sub={unitLabel} />
            <Stat label="Seller initiated" value={formatCompact(dir.sell / u, 2)} tone="down" sub={unitLabel} />
            <Stat label="Buyer share" value={isNum(dir.buyPct) ? `${dir.buyPct}%` : '—'} reason="Nothing was initiated" tone={isNum(dir.buyPct) ? (dir.buyPct >= 55 ? 'up' : dir.buyPct <= 45 ? 'down' : undefined) : undefined} />
            <Stat label="Price change" value={isNum(dir.priceChange) ? (dir.priceChange > 0 ? `+${dir.priceChange}` : String(dir.priceChange)) : '—'} reason="No traded minute" tone={isNum(dir.priceChange) ? (dir.priceChange > 0 ? 'up' : dir.priceChange < 0 ? 'down' : undefined) : undefined} />
            <Stat label="Spikes today" value={`${sessionBuySpikes} buy · ${sessionSellSpikes} sell`} sub={`${dir.buySpikes} buy · ${dir.sellSpikes} sell in the window`} />
          </div>
          <p className={cx('text-sm', TONE[dir.read] === 'up' && 'text-up', TONE[dir.read] === 'down' && 'text-down', TONE[dir.read] === 'warn' && 'text-warn')}>{dir.text}</p>
        </div>
      )}
      <Chart option={option} height={640} blank={d.minutes.length ? undefined : 'No recorded minute of this contract yet this session'} />
      {recent.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1 text-2xs">
          <span className="text-muted">Latest spikes:</span>
          {recent.map((s) => (
            <span key={`${s.ts}-${s.side}`} className={cx('rounded px-1.5 py-0.5', s.side === 'buy' ? 'bg-up/15 text-up' : 'bg-down/15 text-down')}>
              {formatTimeIST(s.ts)} {s.side === 'buy' ? 'BUY' : 'SELL'} {formatCompact(s.qty / u, 1)} ({s.ratio}×)
            </span>
          ))}
        </div>
      )}
      <div className="mt-2 space-y-1">
        <Coverage text={`Buyer initiated = trades at or above the ask; seller initiated = at or below the bid (estimated from live ticks; the rest is unclassified). Spike = at least 3× the median of the previous 30 minutes and larger than the other side. ${d.coverage}`} />
        <Coverage text="Read: aggressive side ≥ 55% with the price moving its way = in control; moving the other way = absorbed (the passive side is soaking it up). An estimate to support a view, not a trading signal." />
      </div>
    </Card>
  );
}
