import { useMemo } from 'react';
import { formatExpiry, formatIndian, type SurfaceResponse } from '@q26/core';
import { Chart, axis, baseOption, useChartColors } from '../../components/Chart';
import { SymbolSelect } from '../../components/pickers';
import { Card, Loadable, PageHeader } from '../../components/ui';
import { useLive } from '../../lib/hooks';
import { useApp } from '../../lib/store';

export default function Surface() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const q = useLive<SurfaceResponse>(['surface', symbol], `/vol/surface/${symbol}`, 20000);
  const c = useChartColors();
  const option = useMemo(() => {
    const d = q.data;
    if (!d) return {};
    const data: [number, number, number][] = [];
    d.iv.forEach((row, i) => row.forEach((v, j) => data.push([j, i, v])));
    const vals = data.map((x) => x[2]);
    return {
      ...baseOption(c),
      tooltip: { trigger: 'item', backgroundColor: c.panel, borderColor: c.line, textStyle: { color: c.ink }, formatter: (p: { value: [number, number, number] }) => `${formatExpiry(d.expiries[p.value[1]])} · ${d.moneyness[p.value[0]]}%<br/>IV <b>${p.value[2].toFixed(2)}%</b>` },
      grid: { left: 8, right: 12, top: 10, bottom: 60, containLabel: true },
      xAxis: { type: 'category', name: 'Moneyness (K/S − 1)', nameLocation: 'middle', nameGap: 28, nameTextStyle: { color: c.muted }, data: d.moneyness.map((m) => `${m}%`), ...axis(c, { splitLine: { show: false } }) },
      yAxis: { type: 'category', data: d.expiries.map((e, i) => `${formatExpiry(e)} (${d.daysToExpiry[i]}d)`), ...axis(c, { splitLine: { show: false } }) },
      visualMap: { min: Math.min(...vals), max: Math.max(...vals), calculable: true, orient: 'horizontal', left: 'center', bottom: 0, textStyle: { color: c.muted }, inRange: { color: ['#1d4ed8', '#22d3ee', '#a3e635', '#facc15', '#f97316', '#dc2626'] } },
      series: [{ type: 'heatmap', data, label: { show: true, color: '#0b1220', fontSize: 9, formatter: (p: { value: [number, number, number] }) => p.value[2].toFixed(1) } }],
    };
  }, [q.data, c]);
  return (
    <div className="space-y-3">
      <PageHeader title="Volatility Surface" subtitle="Implied volatility by moneyness and expiry — skew across strikes, term structure across expiries">
        <SymbolSelect value={symbol} onChange={setSymbol} />
      </PageHeader>
      <Card title={q.data ? `${symbol} · spot ${formatIndian(q.data.spot)}` : symbol}>
        <Loadable q={q}>{(d) => <Chart option={option} height={Math.max(320, d.expiries.length * 46 + 90)} />}</Loadable>
      </Card>
    </div>
  );
}
