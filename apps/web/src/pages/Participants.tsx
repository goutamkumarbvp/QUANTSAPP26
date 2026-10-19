import { useMemo, useState } from 'react';
import type { ParticipantDay, ParticipantRow } from '@q26/core';
import { Chart, axis, baseOption, LINE_GAPS, useChartColors } from '../components/Chart';
import { Card, Chg, Coverage, Dash, Loadable, PageHeader, Segmented } from '../components/ui';
import { formatCompact, formatDate, formatFixed, formatIndian } from '../lib/format';
import { useLive } from '../lib/hooks';
import { useTicks } from '../lib/store';

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
/** Net contracts of a participant on a day; null when the day's file has no row for that participant. */
const netOf = (day: ParticipantDay | undefined, p: ParticipantRow['participant'], cat: Cat): number | null => {
  const r = day?.rows.find((x) => x.participant === p);
  return r ? val(r, cat, 'Long') - val(r, cat, 'Short') : null;
};

export default function Participants() {
  const [days, setDays] = useState(30);
  const [cat, setCat] = useState<Cat>('futIndex');
  const today = useTicks((s) => s.clock?.date);
  const q = useLive<ParticipantDay[]>(['participants', days], `/participants?days=${days}`, 60000);
  const c = useChartColors();
  const option = useMemo(() => {
    const d = q.data ?? [];
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), valueFormatter: (v: number | null) => formatCompact(v) },
      xAxis: { type: 'category', data: d.map((x) => x.date.slice(5)), ...axis(c, { splitLine: { show: false } }) },
      yAxis: [
        { type: 'value', ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => formatCompact(v) } },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      series: [
        ...P.map((p, i) => ({ name: `${p} net`, type: 'line', symbol: 'none', ...LINE_GAPS, lineStyle: { width: p === 'FII' ? 2.5 : 1.5 }, itemStyle: { color: c.series[i] }, data: d.map((x) => netOf(x, p, cat)) })),
        { name: 'NIFTY', type: 'line', yAxisIndex: 1, symbol: 'none', ...LINE_GAPS, lineStyle: { width: 1, type: 'dotted' }, itemStyle: { color: c.muted }, data: d.map((x) => x.niftyClose) },
      ],
    };
  }, [q.data, cat, c]);
  const last = q.data?.[q.data.length - 1];
  const prev = q.data?.[q.data.length - 2];
  const notYet = last && today && last.date < today;
  return (
    <div className="space-y-3">
      <PageHeader title="Participant-wise OI" subtitle="Net long/short contracts held by FIIs, Pros (prop desks), Clients (retail/HNI) and DIIs — official NSE files published after each session">
        <Segmented value={days} onChange={setDays} options={[{ value: 10, label: '10D' }, { value: 30, label: '1M' }, { value: 60, label: '3M' }]} />
      </PageHeader>
      <Segmented value={cat} onChange={setCat} options={CATS} />
      <Loadable q={q} hint="Published by NSE after the close; each day appears here once its file has been loaded.">
        {(d) => (
          <>
            {last && (
              <Card title={`${CATS.find((x) => x.value === cat)!.label} — official file of ${formatDate(last.date, true)}`} pad={false}>
                <div className="overflow-x-auto">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Participant</th>
                        <th className="num">Long</th>
                        <th className="num">Short</th>
                        <th className="num">Net</th>
                        <th className="num">{prev ? `Net chg vs ${formatDate(prev.date)}` : 'Net chg'}</th>
                        <th className="num">Long %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {P.map((p) => {
                        const r = last.rows.find((x) => x.participant === p);
                        if (!r) {
                          return (
                            <tr key={p}>
                              <td className="font-semibold">{p}</td>
                              <td className="num" colSpan={5}><Dash reason={`The official file of ${last.date} has no complete ${p} row`} /></td>
                            </tr>
                          );
                        }
                        const L = val(r, cat, 'Long');
                        const S = val(r, cat, 'Short');
                        const net = L - S;
                        const pnet = netOf(prev, p, cat);
                        return (
                          <tr key={p}>
                            <td className="font-semibold">{p}</td>
                            <td className="num">{formatIndian(L, 0)}</td>
                            <td className="num">{formatIndian(S, 0)}</td>
                            <td className="num"><Chg value={net} decimals={0} /></td>
                            <td className="num"><Chg value={pnet === null ? null : net - pnet} decimals={0} reason={prev ? `No ${p} row in the file of ${prev.date}` : 'Only one official day is loaded'} /></td>
                            <td className="num">{L + S > 0 ? `${formatFixed((L / (L + S)) * 100, 1)}%` : <Dash reason="No open positions in this category" />}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="border-t border-line px-3 py-2">
                  <Coverage text={`Latest official file: ${formatDate(last.date, true)}${notYet ? ' (later days are not published or not loaded yet)' : ''}. Figures are contracts as published by NSE (participant-wise open interest).`} />
                </div>
              </Card>
            )}
            <Card title="Net position trend (contracts)">
              <Chart option={option} height={360} blank={d.length ? undefined : 'No official participant file is loaded'} />
              <Coverage className="mt-2" text={`${d.length} official day${d.length === 1 ? '' : 's'} loaded${d.length ? ` (${formatDate(d[0].date, true)} – ${formatDate(d[d.length - 1].date, true)})` : ''}; a day without a file is simply absent, never filled.`} />
            </Card>
          </>
        )}
      </Loadable>
    </div>
  );
}
