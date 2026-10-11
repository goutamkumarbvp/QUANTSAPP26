import { useMemo, useState } from 'react';
import { formatIndian, type StraddlePoint } from '@q26/core';
import { Chart, axis, baseOption, timeAxis, useChartColors } from '../components/Chart';
import { ExpirySelect, IntervalSelect, SessionDate, SymbolSelect } from '../components/pickers';
import { Card, Field, Loadable, PageHeader, Segmented, Stat, Toggle } from '../components/ui';
import { qs } from '../lib/api';
import { useChain, useLive } from '../lib/hooks';
import { useApp, useTicks } from '../lib/store';

export default function Straddle() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const today = useTicks((s) => s.clock?.date);
  const [expiry, setExpiry] = useState<string>();
  const [mode, setMode] = useState<'rolling' | 'fixed'>('rolling');
  const [strike, setStrike] = useState<number | 'atm'>('atm');
  const [width, setWidth] = useState(0);
  const [interval, setIntervalMin] = useState(1);
  const [date, setDate] = useState('');
  const [legsShown, setLegsShown] = useState(false);
  const chain = useChain(symbol, expiry, { refetch: 30000 });
  const step = chain.data?.strikeStep ?? 50;
  const q = useLive<{ expiry: string; points: StraddlePoint[] }>(
    ['straddle', symbol, expiry, mode, strike, width, interval, date],
    `/straddle/${symbol}${qs({ expiry, mode, strike, width, interval, date })}`,
    date ? false : 5000,
  );
  const c = useChartColors();
  const option = useMemo(() => {
    const pts = q.data?.points ?? [];
    const series: unknown[] = [
      { name: width ? 'Strangle premium' : 'Straddle premium', type: 'line', symbol: 'none', lineStyle: { width: 2 }, itemStyle: { color: c.accent }, areaStyle: { opacity: 0.06 }, data: pts.map((p) => [p.ts, p.straddle]) },
      { name: 'Spot', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1 }, itemStyle: { color: c.muted }, data: pts.map((p) => [p.ts, p.spot]) },
    ];
    if (legsShown) {
      series.push({ name: 'Call', type: 'line', symbol: 'none', lineStyle: { width: 1, type: 'dashed' }, itemStyle: { color: c.down }, data: pts.map((p) => [p.ts, p.ce]) });
      series.push({ name: 'Put', type: 'line', symbol: 'none', lineStyle: { width: 1, type: 'dashed' }, itemStyle: { color: c.up }, data: pts.map((p) => [p.ts, p.pe]) });
    }
    return {
      ...baseOption(c),
      xAxis: timeAxis(c),
      yAxis: [
        { type: 'value', scale: true, ...axis(c) },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      dataZoom: [{ type: 'inside' }],
      series,
    };
  }, [q.data, legsShown, width, c]);
  const pts = q.data?.points ?? [];
  const last = pts[pts.length - 1];
  const first = pts[0];
  const hi = pts.length ? Math.max(...pts.map((p) => p.straddle)) : 0;
  const lo = pts.length ? Math.min(...pts.map((p) => p.straddle)) : 0;
  const strikes = chain.data?.rows.map((r) => r.strike) ?? [];
  return (
    <div className="space-y-3">
      <PageHeader title="Straddle Chart" subtitle="Combined ATM call + put premium through the day — the market's priced-in move and how fast time value decays">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setExpiry(undefined); setStrike('atm'); }} />
        <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} />
        <SessionDate value={date} onChange={setDate} max={today} />
        <IntervalSelect value={interval} onChange={setIntervalMin} />
      </PageHeader>
      <Card>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Strike selection">
            <Segmented value={mode} onChange={(m) => { setMode(m); if (m === 'rolling') setStrike('atm'); }} options={[{ value: 'rolling', label: 'Rolling ATM' }, { value: 'fixed', label: 'Fixed strike' }]} />
          </Field>
          {mode === 'fixed' && (
            <Field label="Strike">
              <select className="input w-auto" value={strike} onChange={(e) => setStrike(e.target.value === 'atm' ? 'atm' : Number(e.target.value))}>
                <option value="atm">ATM at open</option>
                {strikes.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </Field>
          )}
          <Field label="Strangle width (each side)">
            <select className="input w-auto" value={width} onChange={(e) => setWidth(Number(e.target.value))}>
              {[0, 1, 2, 3, 4, 6, 8].map((n) => <option key={n} value={n * step}>{n === 0 ? 'Straddle' : `±${n * step}`}</option>)}
            </select>
          </Field>
          <Toggle checked={legsShown} onChange={setLegsShown} label="Show call & put" />
        </div>
      </Card>
      {last && first && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Stat label={width ? 'Strangle' : 'Straddle'} value={last.straddle.toFixed(2)} sub={`Strike ${last.strike}`} tone="accent" />
          <Stat label="Since open" value={(last.straddle - first.straddle).toFixed(2)} tone={last.straddle >= first.straddle ? 'up' : 'down'} sub={`${(((last.straddle - first.straddle) / first.straddle) * 100).toFixed(2)}%`} />
          <Stat label="Day high / low" value={`${hi.toFixed(1)} / ${lo.toFixed(1)}`} />
          <Stat label="Implied move" value={`±${((last.straddle / last.spot) * 100).toFixed(2)}%`} sub={`±${last.straddle.toFixed(0)} pts by expiry`} />
          <Stat label="Avg IV" value={`${last.iv.toFixed(2)}%`} />
        </div>
      )}
      <Card title={`${symbol} ${width ? 'strangle' : 'straddle'} premium`}>
        <Loadable q={q}>{() => <Chart option={option} height={420} />}</Loadable>
      </Card>
    </div>
  );
}
