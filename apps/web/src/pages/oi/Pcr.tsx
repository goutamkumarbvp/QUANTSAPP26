import { useMemo, useState } from 'react';
import { formatIndian, pcrSentiment, type DailyPcrPoint } from '@q26/core';
import { Chart, axis, baseOption, timeAxis, useChartColors } from '../../components/Chart';
import { ExpirySelect, IntervalSelect, SessionDate, SymbolSelect } from '../../components/pickers';
import { Card, Loadable, PageHeader, Stat } from '../../components/ui';
import { qs } from '../../lib/api';
import { useLive } from '../../lib/hooks';
import { useApp, useTicks } from '../../lib/store';

interface PcrResponse {
  expiry: string;
  intraday: { ts: number; pcr: number; spot: number; ceOi: number; peOi: number }[];
  daily: DailyPcrPoint[];
}

export default function Pcr() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const today = useTicks((s) => s.clock?.date);
  const [expiry, setExpiry] = useState<string>();
  const [interval, setIntervalMin] = useState(5);
  const [date, setDate] = useState('');
  const q = useLive<PcrResponse>(['pcr', symbol, expiry, interval, date], `/oi/pcr/${symbol}${qs({ expiry, interval, date, days: 60 })}`, date ? false : 10000);
  const c = useChartColors();
  const intraday = useMemo(() => {
    const pts = q.data?.intraday ?? [];
    return {
      ...baseOption(c),
      xAxis: timeAxis(c),
      yAxis: [
        { type: 'value', scale: true, ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => v.toFixed(2) } },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      dataZoom: [{ type: 'inside' }],
      series: [
        { name: 'PCR', type: 'line', symbol: 'none', itemStyle: { color: c.accent }, lineStyle: { width: 2 }, data: pts.map((p) => [p.ts, p.pcr]), markLine: { symbol: 'none', silent: true, lineStyle: { color: c.muted, type: 'dashed' }, data: [{ yAxis: 1 }] } },
        { name: 'Spot', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1 }, itemStyle: { color: c.muted }, data: pts.map((p) => [p.ts, p.spot]) },
      ],
    };
  }, [q.data, c]);
  const daily = useMemo(() => {
    const d = q.data?.daily ?? [];
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), axisPointer: { type: 'shadow' } },
      xAxis: { type: 'category', data: d.map((x) => x.date.slice(5)), ...axis(c, { splitLine: { show: false } }) },
      yAxis: [
        { type: 'value', ...axis(c), min: 0 },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      series: [
        { name: 'EOD PCR', type: 'bar', data: d.map((x) => ({ value: x.pcr, itemStyle: { color: x.pcr >= 1 ? c.up : c.down } })) },
        { name: 'Close', type: 'line', yAxisIndex: 1, symbol: 'none', itemStyle: { color: c.accent }, data: d.map((x) => x.close) },
      ],
    };
  }, [q.data, c]);
  const last = q.data?.intraday[q.data.intraday.length - 1];
  const first = q.data?.intraday[0];
  return (
    <div className="space-y-3">
      <PageHeader title="Put-Call Ratio" subtitle="PCR = total put OI ÷ total call OI. Rising PCR = put writing (support building); falling = call writing.">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setExpiry(undefined); }} />
        <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} />
        <SessionDate value={date} onChange={setDate} max={today} />
        <IntervalSelect value={interval} onChange={setIntervalMin} />
      </PageHeader>
      {last && first && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Current PCR" value={last.pcr.toFixed(3)} tone={last.pcr >= 1 ? 'up' : 'down'} sub={pcrSentiment(last.pcr)} />
          <Stat label="Opening PCR" value={first.pcr.toFixed(3)} />
          <Stat label="Intraday change" value={(last.pcr - first.pcr).toFixed(3)} tone={last.pcr >= first.pcr ? 'up' : 'down'} />
          <Stat label="Day range" value={`${Math.min(...q.data!.intraday.map((p) => p.pcr)).toFixed(2)} – ${Math.max(...q.data!.intraday.map((p) => p.pcr)).toFixed(2)}`} />
        </div>
      )}
      <Card title="Intraday PCR vs spot">
        <Loadable q={q}>{() => <Chart option={intraday} height={340} />}</Loadable>
      </Card>
      <Card title="End-of-day PCR (nearest expiry) — last 60 sessions">
        <Loadable q={q}>{() => <Chart option={daily} height={300} />}</Loadable>
      </Card>
    </div>
  );
}
