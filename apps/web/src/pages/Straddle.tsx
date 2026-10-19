import { useMemo, useState } from 'react';
import type { StraddlePoint, StraddleResponse } from '@q26/core';
import { Chart, axis, baseOption, timeAxis, useChartColors } from '../components/Chart';
import { ExpirySelect, IntervalSelect, SessionDate, SymbolSelect } from '../components/pickers';
import { Card, Coverage, Field, Gaps, Loadable, PageHeader, Segmented, Stat, Toggle } from '../components/ui';
import { isNoLiveData, qs } from '../lib/api';
import { formatDate, formatFixed, formatIndian, formatSessionTime, isNum } from '../lib/format';
import { useChain, useLive, useSymbolInfo } from '../lib/hooks';
import { useApp, useTicks } from '../lib/store';

const MIN = 60_000;

const SOURCE: Record<StraddleResponse['source'], string> = {
  recorded: 'recorded 1-minute data',
  kotak: 'Kotak 1-minute history',
  mixed: 'recorded data and Kotak 1-minute history',
};

/** `[ts, value]` pairs of the points; a null breaks the line where more than a step of data is missing. */
function line(pts: StraddlePoint[], stepMs: number, pick: (p: StraddlePoint) => number | null): [number, number | null][] {
  const out: [number, number | null][] = [];
  pts.forEach((p, i) => {
    if (i > 0 && p.ts - pts[i - 1].ts > stepMs * 1.5) out.push([pts[i - 1].ts + stepMs, null]);
    out.push([p.ts, pick(p)]);
  });
  return out;
}

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
  // Strangle widths are multiples of the strike step of the instrument master (none known: straddle only).
  const info = useSymbolInfo(symbol);
  const step = chain.data?.strikeStep ?? info?.strikeStep;
  const q = useLive<StraddleResponse>(
    ['straddle', symbol, expiry, mode, strike, width, interval, date],
    `/straddle/${symbol}${qs({ expiry, mode, strike, width, interval, date })}`,
    date ? false : 5000,
  );
  const c = useChartColors();
  const option = useMemo(() => {
    const pts = q.data?.points ?? [];
    const stepMs = interval * MIN;
    const series: unknown[] = [
      { name: width ? 'Strangle premium' : 'Straddle premium', type: 'line', symbol: 'none', lineStyle: { width: 2 }, itemStyle: { color: c.accent }, areaStyle: { opacity: 0.06 }, data: line(pts, stepMs, (p) => p.straddle) },
      { name: 'Spot', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1 }, itemStyle: { color: c.muted }, data: line(pts, stepMs, (p) => p.spot) },
    ];
    if (legsShown) {
      series.push({ name: 'Call', type: 'line', symbol: 'none', lineStyle: { width: 1, type: 'dashed' }, itemStyle: { color: c.down }, data: line(pts, stepMs, (p) => p.ce) });
      series.push({ name: 'Put', type: 'line', symbol: 'none', lineStyle: { width: 1, type: 'dashed' }, itemStyle: { color: c.up }, data: line(pts, stepMs, (p) => p.pe) });
    }
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), valueFormatter: (v: number | null) => formatFixed(v, 2) },
      xAxis: timeAxis(c),
      yAxis: [
        { type: 'value', scale: true, ...axis(c) },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      dataZoom: [{ type: 'inside' }],
      series,
    };
  }, [q.data, legsShown, width, interval, c]);
  // Only the windows in which both legs traded have a premium.
  // A 503 replaces the chart with its reason: the stats must not keep showing the previous answer.
  const priced = (isNoLiveData(q.error) ? [] : q.data?.points ?? []).filter((p): p is StraddlePoint & { straddle: number } => isNum(p.straddle));
  const last = priced[priced.length - 1];
  const first = priced[0];
  const hi = priced.length ? Math.max(...priced.map((p) => p.straddle)) : null;
  const lo = priced.length ? Math.min(...priced.map((p) => p.straddle)) : null;
  const strikes = chain.data?.rows.map((r) => r.strike) ?? [];
  const label = width ? 'Strangle' : 'Straddle';
  return (
    <div className="space-y-3">
      <PageHeader title="Straddle Chart" subtitle="Combined ATM call + put premium through the day — the market's priced-in move and how fast time value decays">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setExpiry(undefined); setStrike('atm'); setWidth(0); }} />
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
            <select className="input w-auto" value={width} onChange={(e) => setWidth(Number(e.target.value))} title={step ? undefined : 'The strike step is not known yet (instrument master / option chain not loaded)'}>
              {step ? [0, 1, 2, 3, 4, 6, 8].map((n) => <option key={n} value={n * step}>{n === 0 ? 'Straddle' : `±${n * step}`}</option>) : <option value={0}>Straddle</option>}
            </select>
          </Field>
          <Toggle checked={legsShown} onChange={setLegsShown} label="Show call & put" />
        </div>
      </Card>
      {last && first && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          <Stat label={label} value={formatFixed(last.straddle, 2)} sub={width ? `${last.ceStrike} CE + ${last.peStrike} PE · ${formatSessionTime(last.ts)}` : `Strike ${last.strike} · ${formatSessionTime(last.ts)}`} tone="accent" />
          <Stat label="Since first traded point" value={formatFixed(last.straddle - first.straddle, 2)} tone={last.straddle >= first.straddle ? 'up' : 'down'} sub={first.straddle > 0 ? `${formatFixed(((last.straddle - first.straddle) / first.straddle) * 100, 2)}% from ${formatSessionTime(first.ts)}` : `from ${formatSessionTime(first.ts)}`} />
          <Stat label="High / low of the day so far" value={hi === null || lo === null ? null : `${formatFixed(hi, 1)} / ${formatFixed(lo, 1)}`} />
          <Stat
            label="Implied move"
            value={isNum(last.spot) && last.spot > 0 ? `±${formatFixed((last.straddle / last.spot) * 100, 2)}%` : null}
            reason="Needs the recorded spot of that window"
            sub={`±${formatFixed(last.straddle, 0)} pts by expiry`}
          />
          <Stat label="Avg IV" value={isNum(last.iv) ? `${formatFixed(last.iv, 2)}%` : null} reason="Needs a recorded forward and both traded premiums" sub="solved from the traded premiums" />
        </div>
      )}
      <Card title={`${symbol} ${width ? 'strangle' : 'straddle'} premium`}>
        <Loadable q={q} hint="Straddle history comes from the minutes this app recorded (or Kotak 1-minute history for contracts still listed); nothing is back-filled.">
          {(d) => (
            <>
              <Chart option={option} height={420} blank={priced.length || d.points.some((p) => isNum(p.ce) || isNum(p.pe)) ? undefined : d.gaps?.points ?? 'No window had a traded premium on both legs'} />
              <div className="mt-2 space-y-1">
                <Coverage text={`${formatDate(d.date, true)} · expiry ${d.expiry} · source: ${SOURCE[d.source]}. A window is blank when a leg did not trade in it.`} />
                <Gaps gaps={d.gaps} />
              </div>
            </>
          )}
        </Loadable>
      </Card>
    </div>
  );
}
