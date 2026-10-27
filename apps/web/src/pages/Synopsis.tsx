import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SynopsisResponse, SynopsisRow } from '@q26/core';
import { Chart, useChartColors } from '../components/Chart';
import { Card, Coverage, Gaps, Loadable, PageHeader, Segmented } from '../components/ui';
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
      <PageHeader title="Synopsis" subtitle="The NIFTY top 10 stocks in one heat-map — sized by turnover, coloured by price, OI or IV change">
        <Segmented value={metric} onChange={setMetric} options={(Object.keys(LABEL) as Metric[]).map((m) => ({ value: m, label: LABEL[m] }))} />
      </PageHeader>
      <Loadable q={q} hint="Needs live stock prices and the near-month futures; stock options refresh about every 90 seconds.">
        {(d) => (
          <>
            <div className="space-y-1">
              <Coverage text={d.coverage} />
              {d.rows.length > mapped.length && (
                <Coverage text={`${d.rows.length - mapped.length} of ${d.rows.length} stocks are not on the map: no turnover (size) or no ${LABEL[metric]} (colour) yet. Their futures are in the Futures build-up view.`} />
              )}
              <Gaps gaps={d.gaps} />
            </div>
            <Card pad={false}>
              <Chart
                option={option}
                height="70vh"
                blank={mapped.length ? undefined : d.rows.length ? `No stock has both a turnover and ${LABEL[metric]} yet` : 'No stock has a live price yet'}
                onEvents={{ click: (p: unknown) => { const r = (p as { data?: { row?: SynopsisRow } }).data?.row; if (r) { setSymbol(r.symbol); navigate('/option-chain'); } } }}
              />
            </Card>
          </>
        )}
      </Loadable>
    </div>
  );
}
