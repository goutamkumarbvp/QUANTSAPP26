import { useMemo, useState } from 'react';
import { formatExpiry, type SkewResponse } from '@q26/core';
import { Chart, axis, baseOption, useChartColors } from '../../components/Chart';
import { SymbolSelect } from '../../components/pickers';
import { Card, cx, Loadable, PageHeader, Segmented, Toggle } from '../../components/ui';
import { qs } from '../../lib/api';
import { useExpiries, useLive } from '../../lib/hooks';
import { useApp } from '../../lib/store';

export default function Skew() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const exp = useExpiries(symbol);
  const [picked, setPicked] = useState<string[]>([]);
  const [x, setX] = useState<'strike' | 'moneyness'>('strike');
  const [split, setSplit] = useState(false);
  const [compare, setCompare] = useState(false);
  const all = exp.data?.options ?? [];
  const chosen = picked.filter((p) => all.includes(p));
  const list = chosen.length ? chosen : all.slice(0, 3);
  const q = useLive<SkewResponse>(['skew', symbol, list.join(','), compare], `/vol/skew/${symbol}${qs({ expiries: list.join(','), compare: compare ? 'prev' : undefined })}`, 15000, list.length > 0);
  const c = useChartColors();
  const option = useMemo(() => {
    const d = q.data;
    if (!d) return {};
    const series = d.curves.flatMap((cv, i) => {
      const color = c.series[Math.floor(compare ? i / 2 : i) % c.series.length];
      const dashed = cv.label.includes('prev');
      const pt = (p: (typeof cv.points)[number], v: number) => [x === 'strike' ? p.strike : p.moneyness, v];
      if (!split) return [{ name: cv.label, type: 'line', symbol: 'none', smooth: true, lineStyle: { width: 2, type: dashed ? 'dashed' : 'solid' }, itemStyle: { color }, data: cv.points.map((p) => pt(p, p.iv)) }];
      return [
        { name: `${cv.label} CE`, type: 'line', symbol: 'none', smooth: true, lineStyle: { width: 1.5, type: dashed ? 'dashed' : 'solid' }, itemStyle: { color }, data: cv.points.map((p) => pt(p, p.ceIv)) },
        { name: `${cv.label} PE`, type: 'line', symbol: 'none', smooth: true, lineStyle: { width: 1.5, type: 'dotted' }, itemStyle: { color }, data: cv.points.map((p) => pt(p, p.peIv)) },
      ];
    });
    (series[0] as Record<string, unknown>).markLine = { symbol: 'none', silent: true, label: { formatter: 'Spot', color: c.accent }, lineStyle: { color: c.accent }, data: [{ xAxis: x === 'strike' ? d.spot : 0 }] };
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), valueFormatter: (v: number) => `${v.toFixed(2)}%` },
      xAxis: { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => (x === 'strike' ? String(v) : `${v}%`) } },
      yAxis: { type: 'value', scale: true, ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => `${v.toFixed(0)}%` } },
      dataZoom: [{ type: 'inside' }],
      series,
    };
  }, [q.data, x, split, compare, c]);
  return (
    <div className="space-y-3">
      <PageHeader title="Volatility Skew" subtitle="Implied volatility across strikes (OTM options) — compare expiries and against the previous close">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setPicked([]); }} />
      </PageHeader>
      <Card title="Expiries (up to 5)">
        <div className="flex flex-wrap gap-1">
          {all.map((e) => (
            <button key={e} onClick={() => setPicked((p) => { const base = p.length ? p : list; return base.includes(e) ? base.filter((y) => y !== e) : [...base, e].slice(-5); })} className={cx('chip cursor-pointer px-2 py-1 text-xs', list.includes(e) ? 'bg-accent text-white' : 'bg-panel2 text-muted')}>
              {formatExpiry(e)}
            </button>
          ))}
        </div>
      </Card>
      <Card
        title={`${symbol} IV smile`}
        actions={
          <>
            <Segmented size="xs" value={x} onChange={setX} options={[{ value: 'strike', label: 'Strike' }, { value: 'moneyness', label: 'Moneyness %' }]} />
            <Toggle checked={split} onChange={setSplit} label="CE / PE separately" />
            <Toggle checked={compare} onChange={setCompare} label="vs prev close" />
          </>
        }
      >
        <Loadable q={q}>{() => <Chart option={option} height={420} />}</Loadable>
      </Card>
      {q.data && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {q.data.curves.map((cv) => (
            <div key={cv.label} className="card card-pad">
              <div className="text-2xs text-muted">{cv.label}</div>
              <div className="text-base font-semibold">ATM IV {cv.atmIv.toFixed(2)}%</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
