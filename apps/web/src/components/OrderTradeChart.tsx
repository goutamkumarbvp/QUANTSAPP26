import { useMemo, useRef, useState } from 'react';
import { flowDirection, flowSpikes, formatTimeIST, type Candle, type OrderFlowResponse } from '@q26/core';
import { Chart, axis, baseOption, gapLine, useChartColors } from './Chart';
import { Card, Coverage, cx, Segmented, Stat } from './ui';
import { formatCompact, formatIndian, formatSessionTime, isNum } from '../lib/format';

/**
 * Order & Trade chart. Two layouts of the same data:
 *  - 'line' (as on Quantsapp's Order & Trade Chart): the price as a thin 1-minute close line with the volume
 *    bars at the foot of its pane, and below them buyer and seller initiated quantity per minute as thin
 *    lines on one scale, for the whole session;
 *  - 'detailed': 1-minute candles, volume, buyer/seller initiated quantity and the cumulative delta.
 * Detailed: 1-minute candles of the contract with volume, and below them the
 * buyer-initiated (green) and seller-initiated (red) quantity of every minute since the open, superimposed on
 * one scale, on one time axis.
 * Spikes (≥ 3× the median of the previous 30 minutes) mark large aggressive orders; the direction read
 * compares who initiated more quantity with what the price did. Recorded minutes only: a minute without
 * a record is a gap, never filled.
 */

const MIN = 60_000;
/** Buyer initiated = green, seller initiated = red (fixed, the same in light and dark theme). */
const GREEN = '#16a34a';
const RED = '#dc2626';

const TONE: Record<string, 'up' | 'down' | 'warn' | undefined> = { buyers: 'up', sellers: 'down', 'buying-absorbed': 'warn', 'selling-absorbed': 'warn', balanced: undefined };
const LABEL: Record<string, string> = { buyers: 'Buyers in control', sellers: 'Sellers in control', 'buying-absorbed': 'Buying absorbed', 'selling-absorbed': 'Selling absorbed', balanced: 'Balanced' };

/** The security itself on top: its 1-minute candles, and its live price for the minute in progress. */
export interface PriceSource {
  /** e.g. "NIFTY (index)". */
  label: string;
  /** Recorded 1-minute candles of today (oldest first); undefined while loading or unavailable. */
  candles?: readonly Candle[];
  /** Why the candles are unavailable (then the contract's own candles are drawn instead). */
  error?: string;
  /** Live price and its time (WebSocket ticks). */
  live?: { ltp: number; ts: number } | null;
}

/** OHLC of the minute in progress, built from the live ticks seen in this browser (open = first tick seen). */
function useFormingCandle(live: PriceSource['live'], lastTs: number | null): [number, number, number, number, number] | null {
  const ref = useRef<{ ts: number; o: number; h: number; l: number; c: number } | null>(null);
  if (live && isNum(live.ltp)) {
    const ts = Math.floor(live.ts / MIN) * MIN;
    const cur = ref.current;
    if (!cur || cur.ts !== ts) ref.current = { ts, o: live.ltp, h: live.ltp, l: live.ltp, c: live.ltp };
    else ref.current = { ...cur, h: Math.max(cur.h, live.ltp), l: Math.min(cur.l, live.ltp), c: live.ltp };
  }
  const f = ref.current;
  // Once the minute is recorded on the server, the recorded candle is drawn instead.
  if (!f || (lastTs !== null && f.ts <= lastTs)) return null;
  return [f.ts, f.o, f.c, f.l, f.h];
}

/** `unit`: quantities in units or in lots (lots only when the contract's lot size is known). */
export type TradeChartStyle = 'line' | 'detailed';
const STYLE_KEY = 'q26-order-trade-style';

function savedStyle(): TradeChartStyle {
  try {
    return localStorage.getItem(STYLE_KEY) === 'detailed' ? 'detailed' : 'line';
  } catch {
    return 'line';
  }
}

export function OrderTradeChart({ d, price, unit = 'qty', initialStyle }: { d: OrderFlowResponse; price?: PriceSource; unit?: 'qty' | 'lots'; initialStyle?: TradeChartStyle }) {
  const c = useChartColors();
  const [lookback, setLookback] = useState(15);
  const [style, setStyleState] = useState<TradeChartStyle>(() => initialStyle ?? savedStyle());
  const setStyle = (v: TradeChartStyle) => {
    setStyleState(v);
    try {
      localStorage.setItem(STYLE_KEY, v);
    } catch {
      /* storage unavailable: the choice lasts for this page only */
    }
  };
  const lineStyle = style === 'line';
  const lot = d.lotSize && d.lotSize > 0 ? d.lotSize : null;
  const u = unit === 'lots' && lot ? lot : 1;
  const unitLabel = unit === 'lots' && lot ? 'lots' : 'qty';

  const spikes = useMemo(() => flowSpikes(d.minutes), [d.minutes]);
  const dir = useMemo(() => flowDirection(d.minutes, { lookback, spikes }), [d.minutes, lookback, spikes]);
  const sessionBuySpikes = spikes.filter((s) => s.side === 'buy').length;
  const sessionSellSpikes = spikes.length - sessionBuySpikes;

  // Top pane: the security itself (e.g. the index); the contract's own candles only when it is unavailable.
  const spotCandles = useMemo(
    () => (price?.candles ?? []).filter((x) => isNum(x.open) && isNum(x.high) && isNum(x.low) && isNum(x.close)).map((x) => [x.ts, x.open, x.close, x.low, x.high] as [number, number, number, number, number]),
    [price?.candles],
  );
  const useSpot = !!price && (spotCandles.length > 0 || !!price.live);
  const lastSpotTs = spotCandles.length ? spotCandles[spotCandles.length - 1][0] : null;
  const forming = useFormingCandle(useSpot ? price?.live : null, lastSpotTs);
  const topCaption = useSpot
    ? `${price!.label} · 1-minute · live`
    : `${d.instrument} · 1-minute${price?.error ? ` (${price.label} not available: ${price.error})` : ''}`;
  const option = useMemo(() => {
    const m = d.minutes;
    const sc = spotCandles;
    // Pixel layout of the panes (the chart is 760 px high): price, volume, buyer vs seller initiated
    // quantity SUPERIMPOSED on ONE scale (sizes compare at a glance), and the cumulative delta.
    // 'line' (Quantsapp layout): price line with the volume bars overlaid at the foot of its pane, then
    // the superimposed buyer / seller lines; no cumulative-delta pane.
    const grids = lineStyle
      ? [{ top: 34, height: 300 }, { top: 274, height: 60 }, { top: 362, height: 300 }]
      : [{ top: 34, height: 250 }, { top: 290, height: 50 }, { top: 362, height: 240 }, { top: 622, height: 100 }];
    const n = grids.length;
    const times = [...m.map((x) => x.ts), ...sc.map((x) => x[0] as number), ...(forming ? [forming[0]] : [])];
    const xMin = times.length ? Math.min(...times) - MIN / 2 : undefined;
    const xMax = times.length ? Math.max(...times) + MIN / 2 : undefined;
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
    const captionTexts = [topCaption, lineStyle ? '' : `Volume — ${d.instrument}`, `Buyer (green) vs seller (red) initiated — ${d.instrument}, same scale (${unitLabel})`, `Cumulative delta (buyer − seller initiated since the open, ${unitLabel})`].slice(0, n);
    const captions = captionTexts.map((text, i) => ({ text, left: 14, top: i === 0 ? grids[0].top - 2 : grids[i].top - 2, textStyle: { color: c.muted, fontSize: 10, fontWeight: 'normal' } }));
    const yAxis: Record<string, unknown>[] = [
      { type: 'value', gridIndex: 0, scale: true, ...axis(c), axisLabel: { color: c.muted, fontSize: 11, formatter: (v: number) => formatIndian(v, 0) } },
      // Line layout: the volume bars stay low at the foot of the price pane (the tallest bar is 40 % of its strip).
      { type: 'value', gridIndex: 1, min: 0, ...(lineStyle ? { max: (v: { max: number }) => v.max * 2.5 } : {}), ...axis(c, { splitLine: { show: false } }), axisLabel: { show: false } },
      qtyAxis(2),
      { type: 'value', gridIndex: 3, scale: true, ...axis(c), axisLabel: { color: c.muted, fontSize: 10, formatter: (v: number) => formatCompact(v, 1) }, splitNumber: 2 },
    ].slice(0, n);
    const own = m.filter((x) => isNum(x.open) && isNum(x.close) && isNum(x.low) && isNum(x.high)).map((x) => [x.ts, x.open, x.close, x.low, x.high]);
    const candles = useSpot ? [...sc, ...(forming ? [forming] : [])] : own;
    const liveLine = useSpot && price?.live && isNum(price.live.ltp)
      ? { symbol: 'none', silent: true, lineStyle: { color: c.accent, type: 'dashed', width: 1 }, label: { position: 'end', color: '#fff', backgroundColor: c.accent, padding: [2, 4], fontSize: 10, formatter: () => formatIndian(price.live!.ltp, 2) }, data: [{ yAxis: price.live.ltp }] }
      : undefined;
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
        lineStyle
          ? // Close of every minute as a thin line (a gap where a minute has no candle).
            { name: 'Price', type: 'line', xAxisIndex: 0, yAxisIndex: 0, symbol: 'none', lineStyle: { width: 1, color: c.ink }, itemStyle: { color: c.ink }, data: gapLine(candles.map((k) => ({ ts: k[0] as number, close: k[2] as number })), MIN, (k) => k.close), ...(liveLine ? { markLine: liveLine } : {}) }
          : { name: 'Price', type: 'candlestick', xAxisIndex: 0, yAxisIndex: 0, barMaxWidth: 8, itemStyle: { color: c.up, color0: c.down, borderColor: c.up, borderColor0: c.down }, data: candles, ...(liveLine ? { markLine: liveLine } : {}) },
        {
          name: 'Volume',
          type: 'bar',
          xAxisIndex: 1,
          yAxisIndex: 1,
          barMaxWidth: 6,
          data: m.map((x) => ({ value: [x.ts, x.volume / u], itemStyle: { color: lineStyle ? c.muted : x.delta >= 0 ? c.up : c.down, opacity: x.partial ? 0.25 : lineStyle ? 0.5 : 0.7 } })),
        },
        { name: 'Buyer initiated', type: 'line', xAxisIndex: 2, yAxisIndex: 2, symbol: 'none', lineStyle: { width: 1, color: GREEN }, itemStyle: { color: GREEN }, data: gapLine(m, MIN, (x) => x.buyVolume / u) },
        { name: 'Seller initiated', type: 'line', xAxisIndex: 2, yAxisIndex: 2, symbol: 'none', lineStyle: { width: 1, color: RED }, itemStyle: { color: RED }, data: gapLine(m, MIN, (x) => x.sellVolume / u) },
        ...(lineStyle ? [] : [{
          name: 'Cumulative delta',
          type: 'line',
          xAxisIndex: 3,
          yAxisIndex: 3,
          symbol: 'none',
          lineStyle: { width: 1.5, color: c.accent },
          itemStyle: { color: c.accent },
          areaStyle: { color: c.accent, opacity: 0.08 },
          markLine: { symbol: 'none', silent: true, label: { show: false }, lineStyle: { color: c.muted, type: 'dashed' }, data: [{ yAxis: 0 }] },
          data: gapLine(m, MIN, (x) => x.cumDelta / u),
        }]),
      ],
    };
  }, [d.minutes, d.instrument, c, spikes, u, unitLabel, spotCandles, forming, useSpot, topCaption, price?.live, lineStyle]);

  const recent = [...spikes].reverse().slice(0, 8);
  return (
    <Card
      title={`Order & Trade chart — ${price && useSpot ? `${price.label} price · ` : ''}${d.instrument} order flow (1-minute)`}
      actions={
        <>
          <Segmented size="xs" value={style} onChange={setStyle} options={[{ value: 'line', label: 'Line (Quantsapp)' }, { value: 'detailed', label: 'Candles + delta' }]} />
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
            <Stat label={`Price change (${d.type === 'FUT' ? 'future' : 'contract'})`} value={isNum(dir.priceChange) ? (dir.priceChange > 0 ? `+${dir.priceChange}` : String(dir.priceChange)) : '—'} reason="No traded minute" tone={isNum(dir.priceChange) ? (dir.priceChange > 0 ? 'up' : dir.priceChange < 0 ? 'down' : undefined) : undefined} />
            <Stat label="Spikes today" value={`${sessionBuySpikes} buy · ${sessionSellSpikes} sell`} sub={`${dir.buySpikes} buy · ${dir.sellSpikes} sell in the window`} />
          </div>
          <p className={cx('text-sm', TONE[dir.read] === 'up' && 'text-up', TONE[dir.read] === 'down' && 'text-down', TONE[dir.read] === 'warn' && 'text-warn')}>{dir.text}</p>
        </div>
      )}
      <Chart option={option} height={lineStyle ? 690 : 760} blank={d.minutes.length ? undefined : 'No recorded minute of this contract yet this session'} />
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
        <Coverage text={`Each minute counts the quantity actually traded in that minute (the rise in cumulative volume, trade by trade): a trade at or above the ask is buyer initiated, at or below the bid seller initiated, inside the spread unclassified (estimated from live ticks). Spike = at least 3× the median of the previous 30 minutes and larger than the other side. ${d.coverage}`} />
        <Coverage text="Read: aggressive side ≥ 55% with the price moving its way = in control; moving the other way = absorbed (the passive side is soaking it up). An estimate to support a view, not a trading signal." />
      </div>
    </Card>
  );
}
