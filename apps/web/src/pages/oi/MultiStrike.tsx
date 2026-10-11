import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { formatIndian, type MultiStrikeResponse } from '@q26/core';
import { Chart, axis, baseOption, timeAxis, useChartColors } from '../../components/Chart';
import { ExpirySelect, IntervalSelect, SessionDate, SymbolSelect } from '../../components/pickers';
import { Card, cx, Loadable, PageHeader, Segmented } from '../../components/ui';
import { qs } from '../../lib/api';
import { formatCompact, formatSessionTime } from '../../lib/format';
import { useChain, useLive } from '../../lib/hooks';
import { useApp, useTicks } from '../../lib/store';

export default function MultiStrike() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const today = useTicks((s) => s.clock?.date);
  const [params] = useSearchParams();
  const [expiry, setExpiry] = useState<string>();
  const [picked, setPicked] = useState<number[]>(() => (params.get('strikes') ?? '').split(',').map(Number).filter((x) => x > 0));
  const [type, setType] = useState<'CE' | 'PE' | 'both'>('both');
  const [metric, setMetric] = useState<'oi' | 'ltp' | 'iv'>('oi');
  const [interval, setIntervalMin] = useState(5);
  const [date, setDate] = useState('');
  const chain = useChain(symbol, expiry, { refetch: 30000 });
  const strikes = chain.data?.rows.map((r) => r.strike) ?? [];
  const atm = chain.data?.atm;
  const active = picked.length ? picked.filter((k) => !strikes.length || strikes.includes(k)) : atm ? [atm - (chain.data!.strikeStep * 2), atm, atm + chain.data!.strikeStep * 2] : [];
  const q = useLive<MultiStrikeResponse>(['multi-strike', symbol, expiry, active.join(','), interval, date], `/oi/multi-strike/${symbol}${qs({ expiry, strikes: active.join(','), interval, date })}`, date ? false : 15000, active.length > 0);
  const c = useChartColors();

  const option = useMemo(() => {
    const d = q.data;
    if (!d) return {};
    const series = d.series
      .filter((s) => type === 'both' || s.type === type)
      .map((s, i) => ({
        name: `${s.strike} ${s.type}`,
        type: 'line',
        symbol: 'none',
        smooth: false,
        lineStyle: { width: 1.8, type: s.type === 'PE' ? 'dashed' : 'solid' },
        itemStyle: { color: c.series[(i >> (type === 'both' ? 1 : 0)) % c.series.length] },
        data: d.times.map((t, j) => [t, s[metric][j]]),
      }));
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), valueFormatter: (v: number) => (metric === 'oi' ? formatCompact(v) : formatIndian(v)) },
      xAxis: timeAxis(c),
      yAxis: [
        { type: 'value', scale: true, ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => (metric === 'oi' ? formatCompact(v) : v.toFixed(metric === 'iv' ? 1 : 0)) } },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      dataZoom: [{ type: 'inside' }],
      series: [...series, { name: 'Spot', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1, color: c.muted }, itemStyle: { color: c.muted }, data: d.times.map((t, j) => [t, d.spot[j]]) }],
    };
  }, [q.data, type, metric, c]);

  const toggle = (k: number) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...(p.length ? p : active), k].slice(-6)));
  const near = atm ? strikes.filter((k) => Math.abs(k - atm) <= chain.data!.strikeStep * 6) : [];

  return (
    <div className="space-y-3">
      <PageHeader title="Multi-Strike OI" subtitle="How OI, premium and IV of selected strikes evolved through the session">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setExpiry(undefined); setPicked([]); }} />
        <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} />
        <SessionDate value={date} onChange={setDate} max={today} />
        <IntervalSelect value={interval} onChange={setIntervalMin} />
      </PageHeader>
      <Card title="Strikes (max 6)">
        <div className="flex flex-wrap gap-1">
          {near.map((k) => (
            <button key={k} onClick={() => toggle(k)} className={cx('chip cursor-pointer px-2 py-1 text-xs', active.includes(k) ? 'bg-accent text-white' : 'bg-panel2 text-muted hover:text-ink', k === atm && !active.includes(k) && 'ring-1 ring-accent')}>
              {k}
            </button>
          ))}
        </div>
      </Card>
      <Card
        title={`${symbol} · ${active.join(', ')}`}
        actions={
          <>
            <Segmented size="xs" value={type} onChange={setType} options={[{ value: 'both', label: 'CE+PE' }, { value: 'CE', label: 'CE' }, { value: 'PE', label: 'PE' }]} />
            <Segmented size="xs" value={metric} onChange={setMetric} options={[{ value: 'oi', label: 'OI' }, { value: 'ltp', label: 'Premium' }, { value: 'iv', label: 'IV' }]} />
          </>
        }
      >
        <Loadable q={q}>{() => <Chart option={option} height={420} />}</Loadable>
      </Card>
      {q.data && (
        <Card title="Latest values" pad={false}>
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Contract</th>
                  <th className="num">OI</th>
                  <th className="num">OI chg (session)</th>
                  <th className="num">Premium</th>
                  <th className="num">IV</th>
                  <th className="num">As of</th>
                </tr>
              </thead>
              <tbody>
                {q.data.series.map((s) => {
                  const n = s.oi.length - 1;
                  return (
                    <tr key={`${s.strike}${s.type}`}>
                      <td className="font-medium">{s.strike} {s.type}</td>
                      <td className="num">{formatCompact(s.oi[n])}</td>
                      <td className={cx('num', s.oi[n] - s.oi[0] >= 0 ? 'text-up' : 'text-down')}>{formatCompact(s.oi[n] - s.oi[0])}</td>
                      <td className="num">{s.ltp[n].toFixed(2)}</td>
                      <td className="num">{s.iv[n].toFixed(2)}</td>
                      <td className="num">{formatSessionTime(q.data!.times[n])}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
