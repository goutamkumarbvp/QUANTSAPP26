import { useMemo, useState } from 'react';
import { formatIndian, type IvChartResponse } from '@q26/core';
import { Chart, axis, baseOption, timeAxis, useChartColors } from '../../components/Chart';
import { ExpirySelect, IntervalSelect, SessionDate, SymbolSelect } from '../../components/pickers';
import { Card, Loadable, PageHeader, Segmented, Stat } from '../../components/ui';
import { qs } from '../../lib/api';
import { useLive } from '../../lib/hooks';
import { useApp, useTicks } from '../../lib/store';

export default function IvChart() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const today = useTicks((s) => s.clock?.date);
  const [expiry, setExpiry] = useState<string>();
  const [interval, setIntervalMin] = useState(5);
  const [date, setDate] = useState('');
  const [days, setDays] = useState(120);
  const q = useLive<IvChartResponse>(['iv-chart', symbol, expiry, interval, date, days], `/vol/iv-chart/${symbol}${qs({ expiry, interval, date, days })}`, date ? false : 10000);
  const c = useChartColors();
  const intraday = useMemo(() => {
    const pts = q.data?.intraday ?? [];
    return {
      ...baseOption(c),
      xAxis: timeAxis(c),
      yAxis: [
        { type: 'value', scale: true, ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => `${v.toFixed(1)}%` } },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      dataZoom: [{ type: 'inside' }],
      series: [
        { name: 'ATM IV', type: 'line', symbol: 'none', lineStyle: { width: 2 }, itemStyle: { color: c.accent }, data: pts.map((p) => [p.ts, p.atmIv]) },
        { name: 'Call IV', type: 'line', symbol: 'none', lineStyle: { width: 1, type: 'dashed' }, itemStyle: { color: c.down }, data: pts.map((p) => [p.ts, p.ceIv]) },
        { name: 'Put IV', type: 'line', symbol: 'none', lineStyle: { width: 1, type: 'dashed' }, itemStyle: { color: c.up }, data: pts.map((p) => [p.ts, p.peIv]) },
        { name: 'Spot', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1 }, itemStyle: { color: c.muted }, data: pts.map((p) => [p.ts, p.spot]) },
      ],
    };
  }, [q.data, c]);
  const daily = useMemo(() => {
    const d = q.data?.daily ?? [];
    return {
      ...baseOption(c),
      xAxis: { type: 'category', data: d.map((x) => x.date), ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: string) => v.slice(5) } },
      yAxis: [
        { type: 'value', scale: true, ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => `${v.toFixed(0)}%` } },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      dataZoom: [{ type: 'inside' }],
      series: [
        { name: 'IV (ATM)', type: 'line', symbol: 'none', lineStyle: { width: 2 }, itemStyle: { color: c.accent }, data: d.map((x) => x.iv) },
        { name: 'HV (20D)', type: 'line', symbol: 'none', lineStyle: { width: 1.5 }, itemStyle: { color: c.warn }, data: d.map((x) => x.hv) },
        { name: 'Close', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1 }, itemStyle: { color: c.muted }, data: d.map((x) => x.close) },
      ],
    };
  }, [q.data, c]);
  const last = q.data?.intraday[q.data.intraday.length - 1];
  const lastDaily = q.data?.daily[q.data.daily.length - 1];
  return (
    <div className="space-y-3">
      <PageHeader title="IV Chart" subtitle="At-the-money implied volatility through the day, and IV vs realised (historical) volatility over time">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setExpiry(undefined); }} />
        <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} />
        <SessionDate value={date} onChange={setDate} max={today} />
        <IntervalSelect value={interval} onChange={setIntervalMin} />
      </PageHeader>
      {q.data && last && lastDaily && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Stat label="ATM IV" value={`${last.atmIv.toFixed(2)}%`} tone="accent" />
          <Stat label="IV Rank (1Y)" value={q.data.ivr.toFixed(0)} hint="Where today's IV sits between its 1-year low (0) and high (100)" />
          <Stat label="IV Percentile (1Y)" value={`${q.data.ivp.toFixed(0)}%`} hint="% of days in the last year with lower IV" />
          <Stat label="HV 20D" value={`${lastDaily.hv.toFixed(2)}%`} />
          <Stat label="IV − HV" value={`${(lastDaily.iv - lastDaily.hv).toFixed(2)}`} tone={lastDaily.iv > lastDaily.hv ? 'warn' : 'up'} sub={lastDaily.iv > lastDaily.hv ? 'Options rich vs realised' : 'Options cheap vs realised'} />
        </div>
      )}
      <Card title="Intraday ATM IV">
        <Loadable q={q}>{() => <Chart option={intraday} height={340} />}</Loadable>
      </Card>
      <Card title="IV vs HV history" actions={<Segmented size="xs" value={days} onChange={setDays} options={[{ value: 60, label: '3M' }, { value: 120, label: '6M' }, { value: 250, label: '1Y' }]} />}>
        <Loadable q={q}>{() => <Chart option={daily} height={320} />}</Loadable>
      </Card>
    </div>
  );
}
