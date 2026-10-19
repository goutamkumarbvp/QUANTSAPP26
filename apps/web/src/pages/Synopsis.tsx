import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SynopsisResponse, SynopsisRow } from '@q26/core';
import { Chart, useChartColors } from '../components/Chart';
import { DataTable } from '../components/DataTable';
import { BuildUpBadge, Card, Chg, Coverage, Dash, Gaps, Loadable, PageHeader, Segmented, Val } from '../components/ui';
import { formatCompact, formatFixed, formatIndian, formatPct, formatSigned, isNum } from '../lib/format';
import { useLive } from '../lib/hooks';
import { useApp } from '../lib/store';

type Metric = 'changePct' | 'oiChangePct' | 'ivChange';
const LABEL: Record<Metric, string> = { changePct: 'Price % chg', oiChangePct: 'Futures OI % chg', ivChange: 'IV chg' };

/** Heat-map members: a stock needs a turnover (its size) and the chosen change (its colour); the others are listed in the table. */
function mappable(r: SynopsisRow, metric: Metric): r is SynopsisRow & { turnover: number } {
  return isNum(r.turnover) && r.turnover > 0 && isNum(r[metric]);
}

export default function Synopsis() {
  const q = useLive<SynopsisResponse>(['synopsis'], '/synopsis', 10000);
  const [metric, setMetric] = useState<Metric>('changePct');
  const [mode, setMode] = useState<'map' | 'table'>('map');
  const setSymbol = useApp((s) => s.setSymbol);
  const navigate = useNavigate();
  const c = useChartColors();
  const mapped = useMemo(() => (q.data?.rows ?? []).filter((r) => mappable(r, metric)), [q.data, metric]);
  const option = useMemo(() => {
    const bySector = new Map<string, SynopsisRow[]>();
    for (const r of mapped) bySector.set(r.sector, [...(bySector.get(r.sector) ?? []), r]);
    const lim = metric === 'ivChange' ? 3 : metric === 'oiChangePct' ? 8 : 3;
    const data = [...bySector.entries()].map(([sector, list]) => ({
      name: sector,
      children: list.map((r) => ({ name: r.symbol, value: [r.turnover as number, r[metric] as number], row: r })),
    }));
    return {
      tooltip: {
        backgroundColor: c.panel, borderColor: c.line, textStyle: { color: c.ink },
        formatter: (p: { data: { row?: SynopsisRow }; name: string }) => {
          const r = p.data.row;
          if (!r) return p.name;
          return `<b>${r.symbol}</b> · ${r.sector}<br/>LTP ${formatIndian(r.ltp)} (${formatPct(r.changePct)})<br/>OI chg ${formatPct(r.oiChangePct)} · ${r.buildUp ?? 'no build-up yet'}<br/>IV ${formatFixed(r.iv, 2)} (${formatSigned(r.ivChange)}) · PCR ${formatFixed(r.pcr, 2)}<br/>Turnover ₹${formatCompact(r.turnover)}`;
        },
      },
      visualMap: { type: 'continuous', show: false, dimension: 1, min: -lim, max: lim, inRange: { color: [c.down, c.panel2, c.up] } },
      series: [{
        type: 'treemap', roam: false, nodeClick: false, breadcrumb: { show: false }, width: '100%', height: '100%', top: 0, left: 0,
        visualDimension: 1, data,
        label: { show: true, formatter: (p: { name: string; value: number | number[] }) => (Array.isArray(p.value) ? `${p.name}\n${p.value[1] > 0 ? '+' : ''}${p.value[1].toFixed(2)}${metric === 'ivChange' ? '' : '%'}` : p.name), color: c.ink, fontSize: 11 },
        upperLabel: { show: true, height: 18, color: c.muted, fontSize: 10 },
        itemStyle: { borderColor: c.panel, borderWidth: 1, gapWidth: 1 },
        levels: [{ itemStyle: { borderColor: c.line, borderWidth: 2, gapWidth: 2 }, upperLabel: { show: true } }, { colorMappingBy: 'value' }],
      }],
    };
  }, [mapped, metric, c]);
  return (
    <div className="space-y-3">
      <PageHeader title="Synopsis" subtitle="The F&O stock universe in one heat-map — sized by turnover, coloured by price, OI or IV change">
        <Segmented value={metric} onChange={setMetric} options={(Object.keys(LABEL) as Metric[]).map((m) => ({ value: m, label: LABEL[m] }))} />
        <Segmented value={mode} onChange={setMode} options={[{ value: 'map', label: 'Heat-map' }, { value: 'table', label: 'Table' }]} />
      </PageHeader>
      <Loadable q={q} hint="Needs live stock prices and the near-month futures; stock options refresh about every 90 seconds.">
        {(d) => (
          <>
            <div className="space-y-1">
              <Coverage text={d.coverage} />
              {mode === 'map' && d.rows.length > mapped.length && (
                <Coverage text={`${d.rows.length - mapped.length} of ${d.rows.length} stocks are not on the map: no turnover (size) or no ${LABEL[metric]} (colour) yet. They are in the table.`} />
              )}
              <Gaps gaps={d.gaps} />
            </div>
            {mode === 'map' ? (
              <Card pad={false}>
                <Chart
                  option={option}
                  height="70vh"
                  blank={mapped.length ? undefined : d.rows.length ? `No stock has both a turnover and ${LABEL[metric]} yet` : 'No stock has a live price yet'}
                  onEvents={{ click: (p: unknown) => { const r = (p as { data?: { row?: SynopsisRow } }).data?.row; if (r) { setSymbol(r.symbol); navigate('/option-chain'); } } }}
                />
              </Card>
            ) : (
              <Card pad={false}>
                <DataTable
                  rows={d.rows}
                  rowKey={(r) => r.symbol}
                  initialSort={{ key: metric, dir: 'desc' }}
                  onRowClick={(r) => { setSymbol(r.symbol); navigate('/option-chain'); }}
                  empty="No stock has a live price yet"
                  columns={[
                    { key: 'symbol', label: 'Symbol', value: (r) => r.symbol, render: (r) => <span className="font-semibold">{r.symbol}</span> },
                    { key: 'sector', label: 'Sector', value: (r) => r.sector, hideSm: true },
                    { key: 'ltp', label: 'LTP', num: true, value: (r) => r.ltp, render: (r) => formatIndian(r.ltp) },
                    { key: 'changePct', label: '% Chg', num: true, value: (r) => r.changePct, render: (r) => <Chg value={r.changePct} pct reason="Needs the previous close" /> },
                    { key: 'oiChangePct', label: 'OI % Chg', num: true, value: (r) => r.oiChangePct, render: (r) => <Chg value={r.oiChangePct} pct reason="Needs live futures OI and the previous session's OI" /> },
                    { key: 'iv', label: <span title="ATM IV solved from live option premiums">IV</span>, num: true, value: (r) => r.iv, render: (r) => <Val value={r.iv} format={(x) => formatFixed(x, 2)} reason="ATM IV needs live option premiums" />, hideSm: true },
                    { key: 'ivChange', label: 'IV Chg', num: true, value: (r) => r.ivChange, render: (r) => <Chg value={r.ivChange} reason="Needs the previous session's official option closes" /> },
                    { key: 'pcr', label: <span title="Put/call OI over strikes with OI on both sides">PCR</span>, num: true, value: (r) => r.pcr, render: (r) => <Val value={r.pcr} format={(x) => formatFixed(x, 2)} reason={d.gaps?.pcr ?? 'Needs strikes with OI on both sides'} />, hideSm: true },
                    { key: 'turnover', label: 'Turnover', num: true, value: (r) => r.turnover, render: (r) => (r.turnover === null ? <Dash reason={d.gaps?.turnover ?? 'Needs the session volume and the exchange’s average traded price'} /> : `₹${formatCompact(r.turnover)}`), hideSm: true },
                    { key: 'bu', label: 'Build-up', value: (r) => r.buildUp, render: (r) => <BuildUpBadge value={r.buildUp} short reason="Needs a live price and OI change vs the previous session" /> },
                  ]}
                />
              </Card>
            )}
          </>
        )}
      </Loadable>
    </div>
  );
}
