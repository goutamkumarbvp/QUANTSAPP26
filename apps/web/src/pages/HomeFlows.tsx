import { useMemo } from 'react';
import type { FiiDiiDay } from '@q26/core';
import { Chart, axis, baseOption, useChartColors } from '../components/Chart';

/** Home's FII / DII net flows bar chart (its own chunk, so Home shows before the charting library loads). */
export default function FlowsChart({ days }: { days: FiiDiiDay[] }) {
  const c = useChartColors();
  const option = useMemo(
    () => ({
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), axisPointer: { type: 'shadow' } },
      xAxis: { type: 'category', data: days.map((d) => d.date.slice(5)), ...axis(c) },
      yAxis: { type: 'value', ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => `${(v / 1000).toFixed(1)}k` } },
      series: [
        { name: 'FII net (₹ Cr)', type: 'bar', data: days.map((d) => d.fiiNet), itemStyle: { color: c.series[0] } },
        { name: 'DII net (₹ Cr)', type: 'bar', data: days.map((d) => d.diiNet), itemStyle: { color: c.series[1] } },
      ],
    }),
    [days, c],
  );
  return <Chart option={option} height={200} />;
}
