import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { describeStrategy, type StrategyChartPoint } from '@q26/core';
import { Chart, axis, baseOption, timeAxis, useChartColors } from '../components/Chart';
import { IntervalSelect, SessionDate } from '../components/pickers';
import { Card, Coverage, Empty, Loadable, PageHeader, Segmented, Stat } from '../components/ui';
import { api, isNoLiveData } from '../lib/api';
import { formatFixed, formatINR, formatIndian, formatSessionTime, isNum } from '../lib/format';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useBuilder, useTicks } from '../lib/store';

const MIN = 60_000;

/** `[ts, value]` pairs of the points; a null breaks the line where more than a step of data is missing. */
function line(pts: StrategyChartPoint[], stepMs: number, pick: (p: StrategyChartPoint) => number | null): [number, number | null][] {
  const out: [number, number | null][] = [];
  pts.forEach((p, i) => {
    if (i > 0 && p.ts - pts[i - 1].ts > stepMs * 1.5) out.push([pts[i - 1].ts + stepMs, null]);
    out.push([p.ts, pick(p)]);
  });
  return out;
}

export default function StrategyChart() {
  const b = useBuilder();
  const today = useTicks((s) => s.clock?.date);
  const [date, setDate] = useState('');
  const [interval, setIntervalMin] = useState(5);
  const [metric, setMetric] = useState<'premium' | 'pnl' | 'greeks'>('pnl');
  const legs = b.legs.filter((l) => l.active !== false && l.exitPrice == null);
  const body = { symbol: b.symbol, legs: legs.map((l) => ({ side: l.side, type: l.type, strike: l.strike, expiry: l.expiry, lots: l.lots, price: date ? 0 : l.price })), date: date || undefined, interval };
  const q = useQuery({
    queryKey: ['strategy-chart', JSON.stringify(body)],
    queryFn: () => api<StrategyChartPoint[]>('/strategy-chart', { body }),
    enabled: legs.length > 0,
    refetchInterval: date ? false : 10000,
    placeholderData: keepPreviousData,
  });
  const c = useChartColors();
  const option = useMemo(() => {
    const pts = q.data ?? [];
    const step = interval * MIN;
    const main =
      metric === 'greeks'
        ? [
            { name: 'Delta', type: 'line', symbol: 'none', itemStyle: { color: c.series[0] }, data: line(pts, step, (p) => p.delta) },
            { name: 'Theta (₹/day)', type: 'line', symbol: 'none', itemStyle: { color: c.series[1] }, data: line(pts, step, (p) => p.theta) },
            { name: 'Vega (₹/1%)', type: 'line', symbol: 'none', itemStyle: { color: c.series[4] }, data: line(pts, step, (p) => p.vega) },
          ]
        : [{ name: metric === 'pnl' ? 'P&L (₹)' : 'Net premium (pts)', type: 'line', symbol: 'none', lineStyle: { width: 2 }, itemStyle: { color: c.accent }, areaStyle: { opacity: 0.06 }, data: line(pts, step, (p) => (metric === 'pnl' ? p.pnl : p.premium)) }];
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), valueFormatter: (v: number | null) => formatFixed(v, 2) },
      xAxis: timeAxis(c),
      yAxis: [
        { type: 'value', scale: true, ...axis(c) },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      dataZoom: [{ type: 'inside' }],
      series: [...main, { name: 'Spot', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1 }, itemStyle: { color: c.muted }, data: line(pts, step, (p) => p.spot) }],
    };
  }, [q.data, metric, interval, c]);
  // The latest window in which every leg traded (a window with a missing leg has no premium / P&L).
  // A 503 (lot size unknown, nothing recorded) replaces the chart with its reason: no stale stats above it.
  const priced = (isNoLiveData(q.error) ? [] : q.data ?? []).filter((p) => isNum(p.premium));
  const last = priced[priced.length - 1];
  const field = metric === 'greeks' ? (['delta', 'theta', 'vega'] as const) : metric === 'pnl' ? (['pnl'] as const) : (['premium'] as const);
  const blank = q.data && !q.data.some((p) => field.some((f) => isNum(p[f]))) ? 'No window has this value: a leg did not trade in it, or an IV could not be solved from its premium' : undefined;
  return (
    <div className="space-y-3">
      <PageHeader title="Strategy Chart" subtitle={legs.length ? `${b.symbol} · ${describeStrategy(legs)} — the whole position charted like a single instrument` : 'Chart any multi-leg position like a single instrument'}>
        <SessionDate value={date} onChange={setDate} max={today} />
        <IntervalSelect value={interval} onChange={setIntervalMin} />
        <Link to="/builder" className="btn-ghost">Edit legs</Link>
      </PageHeader>
      {!legs.length ? (
        <Card><Empty>No open legs in the strategy builder. <Link to="/templates" className="text-accent">Pick a template</Link> or <Link to="/builder" className="text-accent">build one</Link>.</Empty></Card>
      ) : (
        <>
          {last && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="P&L" value={isNum(last.pnl) ? formatINR(last.pnl) : null} reason="A leg did not trade in this window" tone={isNum(last.pnl) ? (last.pnl >= 0 ? 'up' : 'down') : undefined} sub={`${date ? 'vs first traded price' : legs.every((l) => l.price > 0) ? 'vs your entry prices' : 'vs your entry prices (first traded price where a leg has none)'} · ${formatSessionTime(last.ts)}`} />
              <Stat label="Net premium" value={isNum(last.premium) ? formatFixed(last.premium, 2) : null} sub="+ = net long, − = net short" />
              <Stat label="Delta" value={isNum(last.delta) ? formatFixed(last.delta, 1) : null} reason="An IV could not be solved from a leg’s traded premium" sub="solved from traded premiums" />
              <Stat label="Theta / Vega" value={isNum(last.theta) && isNum(last.vega) ? `${formatINR(last.theta)} / ${formatINR(last.vega)}` : null} reason="An IV could not be solved from a leg’s traded premium" />
            </div>
          )}
          <Card title="Intraday" actions={<Segmented size="xs" value={metric} onChange={setMetric} options={[{ value: 'pnl', label: 'P&L' }, { value: 'premium', label: 'Premium' }, { value: 'greeks', label: 'Greeks' }]} />}>
            <Loadable q={q} hint="Strategy history comes from the minutes this app recorded (or Kotak 1-minute history for contracts still listed); nothing is back-filled.">
              {() => (
                <>
                  <Chart option={option} height={420} blank={blank} />
                  <div className="mt-2">
                    <Coverage text="Each leg is priced at the close of its last traded minute in the window; a window where a leg did not trade has no premium / P&L / Greeks. Greeks are solved from those premiums with the recorded forward." />
                  </div>
                </>
              )}
            </Loadable>
          </Card>
        </>
      )}
    </div>
  );
}
