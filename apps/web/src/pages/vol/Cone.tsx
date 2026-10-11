import { useMemo } from 'react';
import { Chart, axis, baseOption, useChartColors } from '../../components/Chart';
import { SymbolSelect } from '../../components/pickers';
import { Card, Loadable, PageHeader, Stat } from '../../components/ui';
import { useLive } from '../../lib/hooks';
import { useApp } from '../../lib/store';

interface ConeResponse {
  symbol: string;
  atmIv: number;
  rows: { window: number; min: number; p25: number; median: number; p75: number; max: number; current: number }[];
}

export default function Cone() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const q = useLive<ConeResponse>(['cone', symbol], `/vol/cone/${symbol}`, 60000);
  const c = useChartColors();
  const option = useMemo(() => {
    const r = q.data?.rows ?? [];
    const x = r.map((v) => `${v.window}D`);
    const line = (name: string, k: keyof ConeResponse['rows'][number], color: string, type = 'solid', width = 1.5) => ({ name, type: 'line', symbol: 'circle', symbolSize: 5, lineStyle: { color, type, width }, itemStyle: { color }, data: r.map((v) => v[k]) });
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), valueFormatter: (v: number) => `${v.toFixed(2)}%` },
      xAxis: { type: 'category', data: x, ...axis(c, { splitLine: { show: false } }) },
      yAxis: { type: 'value', scale: true, ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => `${v}%` } },
      series: [
        line('Max', 'max', c.down, 'dashed', 1),
        line('75th pct', 'p75', c.warn, 'dotted'),
        line('Median', 'median', c.muted),
        line('25th pct', 'p25', c.up, 'dotted'),
        line('Min', 'min', c.up, 'dashed', 1),
        line('Current HV', 'current', c.accent, 'solid', 2.5),
        { name: 'ATM IV', type: 'line', symbol: 'none', lineStyle: { color: c.series[4], width: 2 }, itemStyle: { color: c.series[4] }, data: r.map(() => q.data!.atmIv) },
      ],
    };
  }, [q.data, c]);
  const r20 = q.data?.rows.find((r) => r.window === 20);
  return (
    <div className="space-y-3">
      <PageHeader title="Volatility Cone" subtitle="Distribution of realised volatility for each look-back window (2 years) vs current HV and implied vol">
        <SymbolSelect value={symbol} onChange={setSymbol} />
      </PageHeader>
      {q.data && r20 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="ATM IV" value={`${q.data.atmIv.toFixed(2)}%`} tone="accent" />
          <Stat label="HV 20D" value={`${r20.current.toFixed(2)}%`} />
          <Stat label="HV 20D median" value={`${r20.median.toFixed(2)}%`} />
          <Stat label="IV vs median HV" value={`${(q.data.atmIv - r20.median).toFixed(2)}`} tone={q.data.atmIv > r20.median ? 'warn' : 'up'} sub={q.data.atmIv > r20.median ? 'IV rich' : 'IV cheap'} />
        </div>
      )}
      <Card title={`${symbol} realised volatility cone`}>
        <Loadable q={q}>{() => <Chart option={option} height={380} />}</Loadable>
      </Card>
    </div>
  );
}
