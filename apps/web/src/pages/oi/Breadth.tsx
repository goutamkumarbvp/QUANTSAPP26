import { useMemo } from 'react';
import type { BreadthResponse, BuildUp } from '@q26/core';
import { Chart, axis, baseOption, useChartColors } from '../../components/Chart';
import { BuildUpBadge, Card, Chg, Coverage, Dash, Gaps, Loadable, NoData, PageHeader } from '../../components/ui';
import { formatPct } from '../../lib/format';
import { useLive } from '../../lib/hooks';

const ORDER: BuildUp[] = ['Long Build-up', 'Short Covering', 'Short Build-up', 'Long Unwinding'];

export default function Breadth() {
  const q = useLive<BreadthResponse>(['breadth'], '/oi/breadth', 15000);
  const c = useChartColors();
  const colors: Record<BuildUp, string> = { 'Long Build-up': c.up, 'Short Covering': c.accent, 'Short Build-up': c.down, 'Long Unwinding': c.warn, Neutral: c.muted };
  // Sectors with no live build-up yet are left out of the chart (listed below with their reason), never drawn as zeros.
  const sectorChart = useMemo(() => {
    const s = (q.data?.sectors ?? []).filter((x) => x.counts !== null);
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), axisPointer: { type: 'shadow' } },
      grid: { left: 8, right: 12, top: 30, bottom: 8, containLabel: true },
      xAxis: { type: 'value', ...axis(c) },
      yAxis: { type: 'category', data: s.map((x) => x.sector), ...axis(c, { splitLine: { show: false } }) },
      series: ORDER.map((b) => ({ name: b, type: 'bar', stack: 's', itemStyle: { color: colors[b] }, data: s.map((x) => x.counts?.[b] ?? null) })),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, c]);
  const history = useMemo(() => {
    const h = q.data?.history ?? [];
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), axisPointer: { type: 'shadow' } },
      xAxis: { type: 'category', data: h.map((x) => `${x.date.slice(5)}${x.source === 'live' ? ' (live)' : ''}`), ...axis(c, { splitLine: { show: false } }) },
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
          const o = d.overall;
          const sum = o ? ORDER.reduce((a, b) => a + o[b], 0) : 0;
          const bullish = o ? o['Long Build-up'] + o['Short Covering'] : 0;
          const why = d.gaps?.overall ?? 'No stock future has a live price and OI change vs the previous session yet';
          const chartSectors = d.sectors.filter((x) => x.counts !== null);
          const pending = d.sectors.filter((x) => x.counts === null);
          const classifiedDays = d.history.map((h) => h.classified);
          return (
            <>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
                {ORDER.map((b) => (
                  <div key={b} className="card card-pad">
                    <BuildUpBadge value={b} />
                    <div className="mt-1 text-2xl font-bold tabular-nums">{o ? o[b] : <Dash reason={why} />}</div>
                    <div className="text-2xs text-muted">{o && d.classified > 0 ? `${formatPct(o[b] / d.classified * 100, 0, false)} of classified stocks` : 'not classified yet'}</div>
                  </div>
                ))}
                <div className="card card-pad">
                  <div className="text-2xs uppercase text-muted">Breadth (bullish − bearish)</div>
                  <div className="mt-1 text-2xl font-bold">{o ? <Chg value={bullish - (sum - bullish)} decimals={0} /> : <Dash reason={why} />}</div>
                  <div className="text-2xs text-muted">{o ? `${bullish} bullish vs ${sum - bullish} bearish` : 'needs live build-up'}</div>
                </div>
              </div>
              <div className="space-y-1">
                <Coverage text={`Live build-up for ${d.classified} of ${d.total} F&O stocks (stocks without a live price and OI change vs the previous session are not counted).`} />
                <Gaps gaps={d.gaps} />
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <Card title="By sector (live)">
                  {chartSectors.length ? <Chart option={sectorChart} height={Math.max(280, chartSectors.length * 28)} /> : <NoData compact title="No sector has a live build-up yet" reason={why} />}
                </Card>
                <Card title="Daily breadth history">
                  {d.history.length ? (
                    <>
                      <Chart option={history} height={Math.max(280, chartSectors.length * 28)} />
                      <Coverage className="mt-2" text={`Past sessions from the official F&O and cash files (spot close change vs the change of total futures OI of the same contracts), then today's live counts. Stocks counted per day: ${Math.min(...classifiedDays)}–${Math.max(...classifiedDays)}.`} />
                    </>
                  ) : (
                    <NoData compact title="No history yet" reason={d.gaps?.history ?? 'No two consecutive sessions of official F&O and cash files are loaded'} />
                  )}
                </Card>
              </div>
              <Card title="Sector constituents" pad={false}>
                <div className="grid gap-px bg-line sm:grid-cols-2 lg:grid-cols-3">
                  {d.sectors.map((s) => (
                    <div key={s.sector} className="bg-panel p-3">
                      <div className="mb-1 text-sm font-semibold">{s.sector}</div>
                      <div className="flex flex-wrap gap-1">
                        {s.symbols.map((x) => (
                          <span key={x.symbol} title={`${x.buildUp ?? 'No build-up yet'} · price ${formatPct(x.changePct)} · OI ${formatPct(x.oiChangePct)}`}>
                            <BuildUpBadge value={x.buildUp} short reason="Needs a live price and OI change vs the previous session" /> <span className="text-xs">{x.symbol}</span>
                          </span>
                        ))}
                      </div>
                    </div>
                  ))}
                  {!d.sectors.length && <div className="bg-panel p-3 text-sm text-muted">No stock future has a live quote yet.</div>}
                </div>
                {pending.length > 0 && <div className="border-t border-line px-3 py-2 text-2xs text-muted">No live build-up yet in: {pending.map((x) => x.sector).join(', ')}.</div>}
              </Card>
            </>
          );
        }}
      </Loadable>
    </div>
  );
}
