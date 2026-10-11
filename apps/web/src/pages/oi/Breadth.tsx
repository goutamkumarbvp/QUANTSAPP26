import { useMemo } from 'react';
import type { BreadthResponse, BuildUp } from '@q26/core';
import { Chart, axis, baseOption, useChartColors } from '../../components/Chart';
import { BuildUpBadge, Card, Chg, Loadable, PageHeader } from '../../components/ui';
import { useLive } from '../../lib/hooks';

const ORDER: BuildUp[] = ['Long Build-up', 'Short Covering', 'Short Build-up', 'Long Unwinding'];

export default function Breadth() {
  const q = useLive<BreadthResponse>(['breadth'], '/oi/breadth', 15000);
  const c = useChartColors();
  const colors: Record<BuildUp, string> = { 'Long Build-up': c.up, 'Short Covering': c.accent, 'Short Build-up': c.down, 'Long Unwinding': c.warn, Neutral: c.muted };
  const sectorChart = useMemo(() => {
    const s = q.data?.sectors ?? [];
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), axisPointer: { type: 'shadow' } },
      grid: { left: 8, right: 12, top: 30, bottom: 8, containLabel: true },
      xAxis: { type: 'value', ...axis(c) },
      yAxis: { type: 'category', data: s.map((x) => x.sector), ...axis(c, { splitLine: { show: false } }) },
      series: ORDER.map((b) => ({ name: b, type: 'bar', stack: 's', itemStyle: { color: colors[b] }, data: s.map((x) => x.counts[b]) })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, c]);
  const history = useMemo(() => {
    const h = q.data?.history ?? [];
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), axisPointer: { type: 'shadow' } },
      xAxis: { type: 'category', data: h.map((x) => x.date.slice(5)), ...axis(c, { splitLine: { show: false } }) },
      yAxis: { type: 'value', ...axis(c) },
      series: ORDER.map((b) => ({ name: b, type: 'bar', stack: 'h', itemStyle: { color: colors[b] }, data: h.map((x) => x.counts[b]) })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, c]);
  return (
    <div className="space-y-3">
      <PageHeader title="Build-up Breadth" subtitle="How many F&O stocks are seeing long build-up, short build-up, short covering or long unwinding — overall and by sector" />
      <Loadable q={q}>
        {(d) => {
          const total = ORDER.reduce((a, b) => a + d.overall[b], 0) || 1;
          const bullish = d.overall['Long Build-up'] + d.overall['Short Covering'];
          return (
            <>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
                {ORDER.map((b) => (
                  <div key={b} className="card card-pad">
                    <BuildUpBadge value={b} />
                    <div className="mt-1 text-2xl font-bold tabular-nums">{d.overall[b]}</div>
                    <div className="text-2xs text-muted">{((d.overall[b] / total) * 100).toFixed(0)}% of stocks</div>
                  </div>
                ))}
                <div className="card card-pad">
                  <div className="text-2xs uppercase text-muted">Breadth (bullish − bearish)</div>
                  <div className="mt-1 text-2xl font-bold"><Chg value={bullish - (total - bullish)} decimals={0} /></div>
                  <div className="text-2xs text-muted">{bullish} bullish vs {total - bullish} bearish</div>
                </div>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <Card title="By sector"><Chart option={sectorChart} height={Math.max(280, d.sectors.length * 28)} /></Card>
                <Card title="Daily breadth history"><Chart option={history} height={Math.max(280, d.sectors.length * 28)} /></Card>
              </div>
              <Card title="Sector constituents" pad={false}>
                <div className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-3">
                  {d.sectors.map((s) => (
                    <div key={s.sector} className="bg-panel p-3">
                      <div className="mb-1 text-sm font-semibold">{s.sector}</div>
                      <div className="flex flex-wrap gap-1">
                        {s.symbols.map((x) => (
                          <span key={x.symbol} title={`${x.buildUp} · ${x.changePct}% · OI ${x.oiChangePct}%`}>
                            <BuildUpBadge value={x.buildUp} short /> <span className="text-xs">{x.symbol}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
            </>
          );
        }}
      </Loadable>
    </div>
  );
}
