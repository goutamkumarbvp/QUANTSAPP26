import { useMemo, useState } from 'react';
import { formatIndian, type FiiDiiDay } from '@q26/core';
import { Chart, axis, baseOption, useChartColors } from '../components/Chart';
import { Card, Chg, Loadable, PageHeader, Segmented, Stat } from '../components/ui';
import { useLive } from '../lib/hooks';

export default function FiiDii() {
  const [days, setDays] = useState(30);
  const q = useLive<FiiDiiDay[]>(['fii-dii', days], `/fii-dii?days=${days}`, 60000);
  const c = useChartColors();
  const option = useMemo(() => {
    const d = q.data ?? [];
    let cf = 0, cd = 0;
    const cumF = d.map((x) => (cf += x.fiiNet));
    const cumD = d.map((x) => (cd += x.diiNet));
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => `₹${formatIndian(v, 0)} Cr` },
      xAxis: { type: 'category', data: d.map((x) => x.date.slice(5)), ...axis(c, { splitLine: { show: false } }) },
      yAxis: [
        { type: 'value', ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => `${(v / 1000).toFixed(0)}k` } },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      series: [
        { name: 'FII net', type: 'bar', itemStyle: { color: c.series[0] }, data: d.map((x) => x.fiiNet) },
        { name: 'DII net', type: 'bar', itemStyle: { color: c.series[1] }, data: d.map((x) => x.diiNet) },
        { name: 'FII cumulative', type: 'line', symbol: 'none', lineStyle: { type: 'dashed' }, itemStyle: { color: c.series[0] }, data: cumF },
        { name: 'DII cumulative', type: 'line', symbol: 'none', lineStyle: { type: 'dashed' }, itemStyle: { color: c.series[1] }, data: cumD },
        { name: 'NIFTY', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1 }, itemStyle: { color: c.muted }, data: d.map((x) => x.niftyClose) },
      ],
    };
  }, [q.data, c]);
  const d = q.data ?? [];
  const sumF = d.reduce((a, x) => a + x.fiiNet, 0);
  const sumD = d.reduce((a, x) => a + x.diiNet, 0);
  const last = d[d.length - 1];
  return (
    <div className="space-y-3">
      <PageHeader title="FII / DII Activity" subtitle="Foreign and domestic institutional net buying in the cash market (₹ crore)">
        <Segmented value={days} onChange={setDays} options={[{ value: 10, label: '10D' }, { value: 30, label: '1M' }, { value: 60, label: '3M' }, { value: 120, label: '6M' }]} />
      </PageHeader>
      {last && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label={`FII net (${last.date})`} value={<Chg value={last.fiiNet} decimals={0} />} sub="₹ crore" />
          <Stat label={`DII net (${last.date})`} value={<Chg value={last.diiNet} decimals={0} />} sub="₹ crore" />
          <Stat label={`FII net (${days}D)`} value={<Chg value={sumF} decimals={0} />} sub="₹ crore" />
          <Stat label={`DII net (${days}D)`} value={<Chg value={sumD} decimals={0} />} sub="₹ crore" />
        </div>
      )}
      <Card title="Net flows"><Loadable q={q}>{() => <Chart option={option} height={380} />}</Loadable></Card>
      <Card title="Daily data" pad={false}>
        <div className="max-h-[50vh] overflow-auto">
          <table className="tbl">
            <thead><tr><th>Date</th><th className="num">FII buy</th><th className="num">FII sell</th><th className="num">FII net</th><th className="num">DII buy</th><th className="num">DII sell</th><th className="num">DII net</th><th className="num">NIFTY</th></tr></thead>
            <tbody>
              {[...d].reverse().map((x) => (
                <tr key={x.date}>
                  <td>{x.date}</td>
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
    </div>
  );
}
