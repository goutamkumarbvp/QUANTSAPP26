import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { describeStrategy, formatINR, formatIndian, type StrategyChartPoint } from '@q26/core';
import { Chart, axis, baseOption, timeAxis, useChartColors } from '../components/Chart';
import { IntervalSelect, SessionDate } from '../components/pickers';
import { Card, Empty, Loadable, PageHeader, Segmented, Stat } from '../components/ui';
import { api } from '../lib/api';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useBuilder, useTicks } from '../lib/store';

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
    const main =
      metric === 'greeks'
        ? [
            { name: 'Delta', type: 'line', symbol: 'none', itemStyle: { color: c.series[0] }, data: pts.map((p) => [p.ts, p.delta]) },
            { name: 'Theta (₹/day)', type: 'line', symbol: 'none', itemStyle: { color: c.series[1] }, data: pts.map((p) => [p.ts, p.theta]) },
            { name: 'Vega (₹/1%)', type: 'line', symbol: 'none', itemStyle: { color: c.series[4] }, data: pts.map((p) => [p.ts, p.vega]) },
          ]
        : [{ name: metric === 'pnl' ? 'P&L (₹)' : 'Net premium (pts)', type: 'line', symbol: 'none', lineStyle: { width: 2 }, itemStyle: { color: c.accent }, areaStyle: { opacity: 0.06 }, data: pts.map((p) => [p.ts, metric === 'pnl' ? p.pnl : p.premium]) }];
    return {
      ...baseOption(c),
      xAxis: timeAxis(c),
      yAxis: [
        { type: 'value', scale: true, ...axis(c) },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      dataZoom: [{ type: 'inside' }],
      series: [...main, { name: 'Spot', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1 }, itemStyle: { color: c.muted }, data: pts.map((p) => [p.ts, p.spot]) }],
    };
  }, [q.data, metric, c]);
  const last = q.data?.[q.data.length - 1];
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
              <Stat label="P&L" value={formatINR(last.pnl)} tone={last.pnl >= 0 ? 'up' : 'down'} sub={date ? 'vs first candle' : 'vs your entry prices'} />
              <Stat label="Net premium" value={last.premium.toFixed(2)} sub="+ = net long, − = net short" />
              <Stat label="Delta" value={last.delta.toFixed(1)} />
              <Stat label="Theta / Vega" value={`${formatINR(last.theta)} / ${formatINR(last.vega)}`} />
            </div>
          )}
          <Card title="Intraday" actions={<Segmented size="xs" value={metric} onChange={setMetric} options={[{ value: 'pnl', label: 'P&L' }, { value: 'premium', label: 'Premium' }, { value: 'greeks', label: 'Greeks' }]} />}>
            <Loadable q={q}>{() => <Chart option={option} height={420} />}</Loadable>
          </Card>
        </>
      )}
    </div>
  );
}
