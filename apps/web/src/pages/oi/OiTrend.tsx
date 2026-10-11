import { useMemo, useState } from 'react';
import { formatIndian, type OiTrendPoint } from '@q26/core';
import { Chart, axis, baseOption, timeAxis, useChartColors } from '../../components/Chart';
import { ExpirySelect, IntervalSelect, SessionDate, SymbolSelect } from '../../components/pickers';
import { Card, Chg, Loadable, PageHeader, Segmented, Stat } from '../../components/ui';
import { qs } from '../../lib/api';
import { formatCompact } from '../../lib/format';
import { useLive } from '../../lib/hooks';
import { useApp, useTicks } from '../../lib/store';

export default function OiTrend() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const today = useTicks((s) => s.clock?.date);
  const [expiry, setExpiry] = useState<string>();
  const [interval, setIntervalMin] = useState(5);
  const [date, setDate] = useState('');
  const [view, setView] = useState<'change' | 'total'>('change');
  const q = useLive<{ expiry: string; points: OiTrendPoint[] }>(['oi-trend', symbol, expiry, interval, date], `/oi/trend/${symbol}${qs({ expiry, interval, date })}`, date ? false : 10000);
  const c = useChartColors();
  const option = useMemo(() => {
    const pts = q.data?.points ?? [];
    const k = view === 'change' ? (['ceChange', 'peChange'] as const) : (['ceOi', 'peOi'] as const);
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), valueFormatter: (v: number) => formatCompact(v) },
      xAxis: timeAxis(c),
      yAxis: [
        { type: 'value', scale: view === 'total', ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => formatCompact(v) } },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      dataZoom: [{ type: 'inside' }],
      series: [
        { name: view === 'change' ? 'Call OI change' : 'Call OI', type: 'line', symbol: 'none', areaStyle: { opacity: 0.08 }, itemStyle: { color: c.down }, data: pts.map((p) => [p.ts, p[k[0]]]) },
        { name: view === 'change' ? 'Put OI change' : 'Put OI', type: 'line', symbol: 'none', areaStyle: { opacity: 0.08 }, itemStyle: { color: c.up }, data: pts.map((p) => [p.ts, p[k[1]]]) },
        { name: 'Spot', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1 }, itemStyle: { color: c.muted }, data: pts.map((p) => [p.ts, p.spot]) },
      ],
    };
  }, [q.data, view, c]);
  const last = q.data?.points[q.data.points.length - 1];
  return (
    <div className="space-y-3">
      <PageHeader title="OI Trend" subtitle="Cumulative call vs put open interest (and its change) through the session — who is adding positions?">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setExpiry(undefined); }} />
        <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} />
        <SessionDate value={date} onChange={setDate} max={today} />
        <IntervalSelect value={interval} onChange={setIntervalMin} />
      </PageHeader>
      {last && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Call OI" value={formatCompact(last.ceOi)} sub={<span>Chg <Chg value={last.ceChange / 1e5} /> L</span>} />
          <Stat label="Put OI" value={formatCompact(last.peOi)} sub={<span>Chg <Chg value={last.peChange / 1e5} /> L</span>} />
          <Stat label="PCR" value={last.pcr.toFixed(2)} tone={last.pcr >= 1 ? 'up' : 'down'} />
          <Stat label="Net put − call addition" value={formatCompact(last.peChange - last.ceChange)} tone={last.peChange >= last.ceChange ? 'up' : 'down'} sub={last.peChange >= last.ceChange ? 'Put writers dominant (bullish)' : 'Call writers dominant (bearish)'} />
        </div>
      )}
      <Card title={`${symbol} OI through the day`} actions={<Segmented size="xs" value={view} onChange={setView} options={[{ value: 'change', label: 'Change in OI' }, { value: 'total', label: 'Total OI' }]} />}>
        <Loadable q={q}>{() => <Chart option={option} height={420} />}</Loadable>
      </Card>
    </div>
  );
}
