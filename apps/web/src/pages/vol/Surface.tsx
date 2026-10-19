import { useMemo } from 'react';
import { formatExpiry, type SurfaceResponse } from '@q26/core';
import { Chart, axis, baseOption, useChartColors } from '../../components/Chart';
import { SymbolSelect } from '../../components/pickers';
import { Card, Coverage, Gaps, Loadable, PageHeader } from '../../components/ui';
import { formatFixed, formatIndian } from '../../lib/format';
import { useLive } from '../../lib/hooks';
import { useApp } from '../../lib/store';

type Cell = [number, number, number];

export default function Surface() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const q = useLive<SurfaceResponse>(['surface', symbol], `/vol/surface/${symbol}`, 20000);
  const c = useChartColors();
  const option = useMemo(() => {
    const d = q.data;
    if (!d) return {};
    // Only cells whose IV was solved from a live premium are drawn; every other cell stays empty (no mesh, no fill-in).
    const data: Cell[] = [];
    d.iv.forEach((row, i) => row.forEach((v, j) => v !== null && data.push([j, i, v])));
    if (!data.length) return {};
    const vals = data.map((x) => x[2]);
    const rowLabels = d.expiries.map((e, i) => `${formatExpiry(e)} (${formatFixed(d.daysToExpiry[i], 1)}d)`);
    return {
      ...baseOption(c),
      tooltip: {
        trigger: 'item',
        backgroundColor: c.panel,
        borderColor: c.line,
        textStyle: { color: c.ink },
        formatter: (p: { value: Cell }) => {
          const k = d.strikes[p.value[1]]?.[p.value[0]];
          return `${formatExpiry(d.expiries[p.value[1]])} · ${d.moneyness[p.value[0]]}%${k ? ` · strike ${formatIndian(k, 0)}` : ''}<br/>IV <b>${formatFixed(p.value[2], 2)}%</b> (solved from the live premium)`;
        },
      },
      // Fixed margins (not containLabel, which clipped the first characters of the expiry labels): the left
      // margin fits the longest row label at 11 px; the bottom stacks x labels, the axis title and the colour scale
      // without overlap (labels ~16 px, title at 30 px below the axis, scale in the bottom 44 px).
      grid: { left: Math.max(...rowLabels.map((l) => l.length)) * 7 + 16, right: 16, top: 10, bottom: 104, containLabel: false },
      xAxis: { type: 'category', name: 'Moneyness (K/S − 1)', nameLocation: 'middle', nameGap: 30, nameTextStyle: { color: c.muted }, data: d.moneyness.map((m) => `${m}%`), ...axis(c, { splitLine: { show: false } }) },
      yAxis: { type: 'category', data: rowLabels, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, fontSize: 11, margin: 8 } },
      visualMap: {
        min: Math.min(...vals),
        max: Math.max(...vals),
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 6,
        itemWidth: 12,
        itemHeight: 220,
        text: ['high IV', 'low IV'],
        textGap: 10,
        textStyle: { color: c.muted, fontSize: 11 },
        formatter: (v: number) => `${formatFixed(v, 1)}%`,
        inRange: { color: ['#1d4ed8', '#22d3ee', '#a3e635', '#facc15', '#f97316', '#dc2626'] },
      },
      series: [{ type: 'heatmap', data, label: { show: true, color: '#0b1220', fontSize: 9, formatter: (p: { value: Cell }) => formatFixed(p.value[2], 1) } }],
    };
  }, [q.data, c]);
  return (
    <div className="space-y-3">
      <PageHeader title="Volatility Surface" subtitle="Implied volatility by moneyness and expiry — skew across strikes, term structure across expiries">
        <SymbolSelect value={symbol} onChange={setSymbol} />
      </PageHeader>
      <Card title={q.data ? `${symbol} · ${q.data.spot === null ? 'spot not available' : `spot ${formatIndian(q.data.spot)}`}` : symbol}>
        <Loadable q={q}>
          {(d) => {
            const cells = d.iv.reduce((a, row) => a + row.filter((v) => v !== null).length, 0);
            const total = d.iv.reduce((a, row) => a + row.length, 0);
            return (
              <>
                <Chart option={option} height={Math.max(340, d.expiries.length * 46 + 130)} blank={cells ? undefined : 'No listed strike has a live premium to solve an IV from'} />
                <div className="mt-2 space-y-1">
                  <Coverage text={`${cells} of ${total} cells have an IV solved from a live premium (the listed strike nearest each moneyness bucket, OTM side). Empty cells have no live premium there — the surface is not interpolated or smoothed.`} />
                  <Gaps gaps={d.gaps} />
                </div>
              </>
            );
          }}
        </Loadable>
      </Card>
    </div>
  );
}
