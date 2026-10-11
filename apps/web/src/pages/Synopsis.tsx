import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SynopsisRow } from '@q26/core';
import { Chart, useChartColors } from '../components/Chart';
import { DataTable } from '../components/DataTable';
import { BuildUpBadge, Card, Chg, Loadable, PageHeader, Segmented } from '../components/ui';
import { formatCompact } from '../lib/format';
import { useLive } from '../lib/hooks';
import { useApp } from '../lib/store';

type Metric = 'changePct' | 'oiChangePct' | 'ivChange';
const LABEL: Record<Metric, string> = { changePct: 'Price % chg', oiChangePct: 'Futures OI % chg', ivChange: 'IV chg' };

export default function Synopsis() {
  const q = useLive<SynopsisRow[]>(['synopsis'], '/synopsis', 10000);
  const [metric, setMetric] = useState<Metric>('changePct');
  const [mode, setMode] = useState<'map' | 'table'>('map');
  const setSymbol = useApp((s) => s.setSymbol);
  const navigate = useNavigate();
  const c = useChartColors();
  const option = useMemo(() => {
    const rows = q.data ?? [];
    const bySector = new Map<string, SynopsisRow[]>();
    for (const r of rows) bySector.set(r.sector, [...(bySector.get(r.sector) ?? []), r]);
    const lim = metric === 'ivChange' ? 3 : metric === 'oiChangePct' ? 8 : 3;
    const data = [...bySector.entries()].map(([sector, list]) => ({
      name: sector,
      children: list.map((r) => ({ name: r.symbol, value: [Math.max(1, r.turnover), r[metric]], row: r })),
    }));
    return {
      tooltip: {
        backgroundColor: c.panel, borderColor: c.line, textStyle: { color: c.ink },
        formatter: (p: { data: { row?: SynopsisRow }; name: string }) => {
          const r = p.data.row;
          if (!r) return p.name;
          return `<b>${r.symbol}</b> · ${r.sector}<br/>LTP ${r.ltp} (${r.changePct}%)<br/>OI chg ${r.oiChangePct}% · ${r.buildUp}<br/>IV ${r.iv} (${r.ivChange >= 0 ? '+' : ''}${r.ivChange}) · PCR ${r.pcr}<br/>Turnover ₹${formatCompact(r.turnover)}`;
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
  }, [q.data, metric, c]);
  return (
    <div className="space-y-3">
      <PageHeader title="Synopsis" subtitle="The entire F&O stock universe in one heat-map — sized by turnover, coloured by price, OI or IV change">
        <Segmented value={metric} onChange={setMetric} options={(Object.keys(LABEL) as Metric[]).map((m) => ({ value: m, label: LABEL[m] }))} />
        <Segmented value={mode} onChange={setMode} options={[{ value: 'map', label: 'Heat-map' }, { value: 'table', label: 'Table' }]} />
      </PageHeader>
      <Loadable q={q}>
        {(rows) =>
          mode === 'map' ? (
            <Card pad={false}>
              <Chart option={option} height="70vh" onEvents={{ click: (p: unknown) => { const r = (p as { data?: { row?: SynopsisRow } }).data?.row; if (r) { setSymbol(r.symbol); navigate('/option-chain'); } } }} />
            </Card>
          ) : (
            <Card pad={false}>
              <DataTable
                rows={rows}
                rowKey={(r) => r.symbol}
                initialSort={{ key: metric, dir: 'desc' }}
                onRowClick={(r) => { setSymbol(r.symbol); navigate('/option-chain'); }}
                columns={[
                  { key: 'symbol', label: 'Symbol', value: (r) => r.symbol, render: (r) => <span className="font-semibold">{r.symbol}</span> },
                  { key: 'sector', label: 'Sector', value: (r) => r.sector, hideSm: true },
                  { key: 'ltp', label: 'LTP', num: true, value: (r) => r.ltp },
                  { key: 'changePct', label: '% Chg', num: true, value: (r) => r.changePct, render: (r) => <Chg value={r.changePct} pct /> },
                  { key: 'oiChangePct', label: 'OI % Chg', num: true, value: (r) => r.oiChangePct, render: (r) => <Chg value={r.oiChangePct} pct /> },
                  { key: 'iv', label: 'IV', num: true, value: (r) => r.iv, hideSm: true },
                  { key: 'ivChange', label: 'IV Chg', num: true, value: (r) => r.ivChange, render: (r) => <Chg value={r.ivChange} /> },
                  { key: 'pcr', label: 'PCR', num: true, value: (r) => r.pcr, hideSm: true },
                  { key: 'turnover', label: 'Turnover', num: true, value: (r) => r.turnover, render: (r) => `₹${formatCompact(r.turnover)}`, hideSm: true },
                  { key: 'bu', label: 'Build-up', value: (r) => r.buildUp, render: (r) => <BuildUpBadge value={r.buildUp} short /> },
                ]}
              />
            </Card>
          )
        }
      </Loadable>
    </div>
  );
}
