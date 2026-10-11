import { useMemo, useState } from 'react';
import { formatIndian } from '@q26/core';
import { Chart, axis, baseOption, timeAxis, useChartColors } from '../../components/Chart';
import { ExpirySelect, SymbolSelect } from '../../components/pickers';
import { Card, Loadable, PageHeader, Stat } from '../../components/ui';
import { qs } from '../../lib/api';
import { formatCompact } from '../../lib/format';
import { useLive } from '../../lib/hooks';
import { useApp } from '../../lib/store';

interface MaxPainResponse {
  symbol: string;
  expiry: string;
  spot: number;
  maxPain: number;
  pain: { strike: number; callPain: number; putPain: number; total: number }[];
  history: { ts: number; maxPain: number; spot: number }[];
}

export default function MaxPain() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const [expiry, setExpiry] = useState<string>();
  const q = useLive<MaxPainResponse>(['max-pain', symbol, expiry], `/oi/max-pain/${symbol}${qs({ expiry })}`, 15000);
  const c = useChartColors();
  const bars = useMemo(() => {
    const d = q.data;
    if (!d) return {};
    const lo = d.spot * 0.93;
    const hi = d.spot * 1.07;
    const rows = d.pain.filter((p) => p.strike >= lo && p.strike <= hi);
    const mpIdx = rows.findIndex((r) => r.strike === d.maxPain);
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => `₹${formatCompact(v)}` },
      xAxis: { type: 'category', data: rows.map((r) => String(r.strike)), ...axis(c, { splitLine: { show: false } }) },
      yAxis: { type: 'value', ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => formatCompact(v) } },
      series: [
        { name: 'Call writers pay', type: 'bar', stack: 'p', itemStyle: { color: c.down }, data: rows.map((r) => r.callPain) },
        {
          name: 'Put writers pay', type: 'bar', stack: 'p', itemStyle: { color: c.up }, data: rows.map((r) => r.putPain),
          markLine: mpIdx >= 0 ? { symbol: 'none', lineStyle: { color: c.warn, width: 2 }, label: { formatter: `Max pain ${d.maxPain}`, color: c.warn }, data: [{ xAxis: mpIdx }] } : undefined,
        },
      ],
    };
  }, [q.data, c]);
  const hist = useMemo(() => {
    const h = q.data?.history ?? [];
    return {
      ...baseOption(c),
      xAxis: timeAxis(c),
      yAxis: { type: 'value', scale: true, ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      series: [
        { name: 'Max pain', type: 'line', step: 'end', symbol: 'none', itemStyle: { color: c.warn }, data: h.map((p) => [p.ts, p.maxPain]) },
        { name: 'Spot', type: 'line', symbol: 'none', itemStyle: { color: c.accent }, data: h.map((p) => [p.ts, p.spot]) },
      ],
    };
  }, [q.data, c]);
  const d = q.data;
  return (
    <div className="space-y-3">
      <PageHeader title="Max Pain" subtitle="The expiry price at which option buyers collectively lose the most (writers pay the least)">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setExpiry(undefined); }} />
        <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} />
      </PageHeader>
      {d && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat label="Max pain" value={formatIndian(d.maxPain, 0)} tone="warn" />
          <Stat label="Spot" value={formatIndian(d.spot)} />
          <Stat label="Distance" value={`${(d.maxPain - d.spot).toFixed(0)} pts`} sub={`${(((d.maxPain - d.spot) / d.spot) * 100).toFixed(2)}%`} />
        </div>
      )}
      <Card title="Option pain by expiry price">
        <Loadable q={q}>{() => <Chart option={bars} height={380} />}</Loadable>
      </Card>
      <Card title="Max pain vs spot through the session">
        <Loadable q={q}>{() => <Chart option={hist} height={280} />}</Loadable>
      </Card>
    </div>
  );
}
