import { useMemo, useState } from 'react';
import type { FiiDiiDay } from '@q26/core';
import { Chart, axis, baseOption, LINE_GAPS, useChartColors } from '../components/Chart';
import { Card, Chg, Coverage, Loadable, PageHeader, Segmented, Stat } from '../components/ui';
import { formatDate, formatIndian } from '../lib/format';
import { useLive } from '../lib/hooks';
import { useTicks } from '../lib/store';

type Scope = NonNullable<FiiDiiDay['scope']> | 'unknown';

/** What each stored day covers: its figures of different scopes must never be added together. */
const SCOPE: Record<Scope, string> = { combined: 'NSE + BSE + MSEI', nse: 'NSE only', unknown: 'scope not recorded' };
const scopeOf = (x: FiiDiiDay): Scope => x.scope ?? 'unknown';

export default function FiiDii() {
  const [days, setDays] = useState(30);
  const today = useTicks((s) => s.clock?.date);
  const q = useLive<FiiDiiDay[]>(['fii-dii', days], `/fii-dii?days=${days}`, 60000);
  const c = useChartColors();
  const d = q.data ?? [];
  const last = d[d.length - 1];
  // Sums and cumulative lines cover only the days of the latest day's scope.
  const scope = last ? scopeOf(last) : undefined;
  const same = d.filter((x) => scopeOf(x) === scope);
  const other = d.length - same.length;
  const sumF = same.reduce((a, x) => a + x.fiiNet, 0);
  const sumD = same.reduce((a, x) => a + x.diiNet, 0);
  const option = useMemo(() => {
    let cf = 0, cd = 0;
    const cum = d.map((x) => (scopeOf(x) === scope ? { f: (cf += x.fiiNet), d: (cd += x.diiNet) } : null));
    return {
      ...baseOption(c),
      tooltip: {
        ...(baseOption(c).tooltip as object),
        axisPointer: { type: 'shadow' },
        valueFormatter: (v: number | null) => (v === null ? '—' : `₹${formatIndian(v, 0)} Cr`),
      },
      xAxis: { type: 'category', data: d.map((x) => x.date.slice(5)), ...axis(c, { splitLine: { show: false } }) },
      yAxis: [
        { type: 'value', ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => `${(v / 1000).toFixed(0)}k` } },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      series: [
        // NSE-only days are drawn lighter: a different (narrower) coverage than the combined figures.
        { name: 'FII net', type: 'bar', itemStyle: { color: c.series[0] }, data: d.map((x) => ({ value: x.fiiNet, itemStyle: { opacity: scopeOf(x) === 'nse' ? 0.45 : 1 } })) },
        { name: 'DII net', type: 'bar', itemStyle: { color: c.series[1] }, data: d.map((x) => ({ value: x.diiNet, itemStyle: { opacity: scopeOf(x) === 'nse' ? 0.45 : 1 } })) },
        { name: 'FII cumulative', type: 'line', symbol: 'none', ...LINE_GAPS, lineStyle: { type: 'dashed' }, itemStyle: { color: c.series[0] }, data: cum.map((x) => x?.f ?? null) },
        { name: 'DII cumulative', type: 'line', symbol: 'none', ...LINE_GAPS, lineStyle: { type: 'dashed' }, itemStyle: { color: c.series[1] }, data: cum.map((x) => x?.d ?? null) },
        { name: 'NIFTY', type: 'line', yAxisIndex: 1, symbol: 'none', ...LINE_GAPS, lineStyle: { width: 1 }, itemStyle: { color: c.muted }, data: d.map((x) => x.niftyClose) },
      ],
    };
  }, [d, scope, c]);
  const notYet = last && today && last.date < today;
  return (
    <div className="space-y-3">
      <PageHeader title="FII / DII Activity" subtitle="Foreign and domestic institutional net buying in the cash market (₹ crore) — official NSE end-of-day figures">
        <Segmented value={days} onChange={setDays} options={[{ value: 10, label: '10D' }, { value: 30, label: '1M' }, { value: 60, label: '3M' }, { value: 120, label: '6M' }]} />
      </PageHeader>
      <Loadable q={q} hint="Published by NSE after the close; the figures appear here once the app has loaded them.">
        {() => (
          <>
            {last && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label={`FII net (${formatDate(last.date)})`} value={<Chg value={last.fiiNet} decimals={0} />} sub={`₹ crore · ${SCOPE[scopeOf(last)]}`} />
                <Stat label={`DII net (${formatDate(last.date)})`} value={<Chg value={last.diiNet} decimals={0} />} sub={`₹ crore · ${SCOPE[scopeOf(last)]}`} />
                <Stat label={`FII net (${same.length} days)`} value={<Chg value={sumF} decimals={0} />} sub={`₹ crore · ${SCOPE[scope as Scope]} days`} />
                <Stat label={`DII net (${same.length} days)`} value={<Chg value={sumD} decimals={0} />} sub={`₹ crore · ${SCOPE[scope as Scope]} days`} />
              </div>
            )}
            {last && (
              <div className="space-y-1">
                <Coverage text={`${d.length} official day${d.length === 1 ? '' : 's'} loaded (${formatDate(d[0].date, true)} – ${formatDate(last.date, true)}); the latest official day is ${formatDate(last.date, true)}${notYet ? ' — later days are not published or not loaded yet' : ''}. NSE serves the latest session only, so the history builds up day by day.`} />
                {other > 0 && <Coverage text={`${other} day${other === 1 ? '' : 's'} of another scope (${[...new Set(d.filter((x) => scopeOf(x) !== scope).map((x) => SCOPE[scopeOf(x)]))].join(', ')}) are listed and drawn lighter but are not added into the sums or the cumulative lines.`} />}
              </div>
            )}
            <Card title="Net flows"><Chart option={option} height={380} blank={d.length ? undefined : 'No official FII/DII day is loaded'} /></Card>
            <Card title="Daily data" pad={false}>
              <div className="max-h-[50vh] overflow-auto">
                <table className="tbl">
                  <thead><tr><th>Date</th><th>Scope</th><th className="num">FII buy</th><th className="num">FII sell</th><th className="num">FII net</th><th className="num">DII buy</th><th className="num">DII sell</th><th className="num">DII net</th><th className="num">NIFTY</th></tr></thead>
                  <tbody>
                    {[...d].reverse().map((x) => (
                      <tr key={x.date}>
                        <td>{x.date}</td>
                        <td className="text-2xs text-muted">{SCOPE[scopeOf(x)]}</td>
                        <td className="num">{formatIndian(x.fiiBuy, 0)}</td>
                        <td className="num">{formatIndian(x.fiiSell, 0)}</td>
                        <td className="num"><Chg value={x.fiiNet} decimals={0} /></td>
                        <td className="num">{formatIndian(x.diiBuy, 0)}</td>
                        <td className="num">{formatIndian(x.diiSell, 0)}</td>
                        <td className="num"><Chg value={x.diiNet} decimals={0} /></td>
                        <td className="num">{formatIndian(x.niftyClose)} <Chg value={x.niftyChangePct} pct className="text-2xs" /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}
      </Loadable>
    </div>
  );
}
