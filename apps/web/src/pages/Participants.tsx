import { useMemo, useState } from 'react';
import { formatIndian, type ParticipantDay, type ParticipantRow } from '@q26/core';
import { Chart, axis, baseOption, useChartColors } from '../components/Chart';
import { Card, Chg, Loadable, PageHeader, Segmented } from '../components/ui';
import { formatCompact } from '../lib/format';
import { useLive } from '../lib/hooks';

type Cat = 'futIndex' | 'optIndexCall' | 'optIndexPut' | 'futStock' | 'optStockCall' | 'optStockPut';
const CATS: { value: Cat; label: string }[] = [
  { value: 'futIndex', label: 'Index Futures' },
  { value: 'optIndexCall', label: 'Index Calls' },
  { value: 'optIndexPut', label: 'Index Puts' },
  { value: 'futStock', label: 'Stock Futures' },
  { value: 'optStockCall', label: 'Stock Calls' },
  { value: 'optStockPut', label: 'Stock Puts' },
];
const P: ParticipantRow['participant'][] = ['FII', 'Pro', 'Client', 'DII'];
const val = (r: ParticipantRow, cat: Cat, side: 'Long' | 'Short') => (r as unknown as Record<string, number>)[`${cat}${side}`];

export default function Participants() {
  const [days, setDays] = useState(30);
  const [cat, setCat] = useState<Cat>('futIndex');
  const q = useLive<ParticipantDay[]>(['participants', days], `/participants?days=${days}`, 60000);
  const c = useChartColors();
  const option = useMemo(() => {
    const d = q.data ?? [];
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), valueFormatter: (v: number) => formatCompact(v) },
      xAxis: { type: 'category', data: d.map((x) => x.date.slice(5)), ...axis(c, { splitLine: { show: false } }) },
      yAxis: [
        { type: 'value', ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => formatCompact(v) } },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      series: [
        ...P.map((p, i) => ({ name: `${p} net`, type: 'line', symbol: 'none', lineStyle: { width: p === 'FII' ? 2.5 : 1.5 }, itemStyle: { color: c.series[i] }, data: d.map((x) => { const r = x.rows.find((y) => y.participant === p)!; return val(r, cat, 'Long') - val(r, cat, 'Short'); }) })),
        { name: 'NIFTY', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1, type: 'dotted' }, itemStyle: { color: c.muted }, data: d.map((x) => x.niftyClose) },
      ],
    };
  }, [q.data, cat, c]);
  const last = q.data?.[q.data.length - 1];
  const prev = q.data?.[q.data.length - 2];
  return (
    <div className="space-y-3">
      <PageHeader title="Participant-wise OI" subtitle="Net long/short contracts held by FIIs, Pros (prop desks), Clients (retail/HNI) and DIIs — published after each session">
        <Segmented value={days} onChange={setDays} options={[{ value: 10, label: '10D' }, { value: 30, label: '1M' }, { value: 60, label: '3M' }]} />
      </PageHeader>
      <Segmented value={cat} onChange={setCat} options={CATS} />
      {last && (
        <Card title={`${CATS.find((x) => x.value === cat)!.label} — ${last.date}`} pad={false}>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Participant</th><th className="num">Long</th><th className="num">Short</th><th className="num">Net</th><th className="num">Net chg (1D)</th><th className="num">Long %</th></tr></thead>
              <tbody>
                {P.map((p) => {
                  const r = last.rows.find((x) => x.participant === p)!;
                  const pr = prev?.rows.find((x) => x.participant === p);
                  const L = val(r, cat, 'Long');
                  const S = val(r, cat, 'Short');
                  const net = L - S;
                  const pnet = pr ? val(pr, cat, 'Long') - val(pr, cat, 'Short') : net;
                  return (
                    <tr key={p}>
                      <td className="font-semibold">{p}</td>
                      <td className="num">{formatIndian(L, 0)}</td>
                      <td className="num">{formatIndian(S, 0)}</td>
                      <td className="num"><Chg value={net} decimals={0} /></td>
                      <td className="num"><Chg value={net - pnet} decimals={0} /></td>
                      <td className="num">{((L / (L + S)) * 100).toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <Card title="Net position trend (contracts)"><Loadable q={q}>{() => <Chart option={option} height={360} />}</Loadable></Card>
    </div>
  );
}
