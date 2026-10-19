import { useMemo, useState } from 'react';
import type { IvChartResponse } from '@q26/core';
import { Chart, axis, baseOption, timeAxis, useChartColors } from '../../components/Chart';
import { ExpirySelect, IntervalSelect, SessionDate, SymbolSelect } from '../../components/pickers';
import { Card, Coverage, Gaps, Loadable, PageHeader, Segmented, Stat } from '../../components/ui';
import { qs } from '../../lib/api';
import { formatDate, formatFixed, formatIndian, isNum } from '../../lib/format';
import { useLive } from '../../lib/hooks';
import { useApp, useTicks } from '../../lib/store';

const MIN = 60_000;

type Intraday = IvChartResponse['intraday'][number];

/** `[ts, value]` pairs of the recorded points; a null breaks the line where more than a step of recording is missing. */
function line(pts: Intraday[], stepMs: number, pick: (p: Intraday) => number | null): [number, number | null][] {
  const out: [number, number | null][] = [];
  pts.forEach((p, i) => {
    if (i > 0 && p.ts - pts[i - 1].ts > stepMs * 1.5) out.push([pts[i - 1].ts + stepMs, null]);
    out.push([p.ts, pick(p)]);
  });
  return out;
}

export default function IvChart() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const today = useTicks((s) => s.clock?.date);
  const [expiry, setExpiry] = useState<string>();
  const [interval, setIntervalMin] = useState(5);
  const [date, setDate] = useState('');
  const [days, setDays] = useState(120);
  const q = useLive<IvChartResponse>(['iv-chart', symbol, expiry, interval, date, days], `/vol/iv-chart/${symbol}${qs({ expiry, interval, date, days })}`, date ? false : 10000);
  const c = useChartColors();
  const intraday = useMemo(() => {
    const pts = q.data?.intraday ?? [];
    const step = interval * MIN;
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), valueFormatter: (v: number | null) => formatFixed(v, 2) },
      xAxis: timeAxis(c),
      yAxis: [
        { type: 'value', scale: true, ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => `${v.toFixed(1)}%` } },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      dataZoom: [{ type: 'inside' }],
      series: [
        { name: 'ATM IV', type: 'line', symbol: 'none', lineStyle: { width: 2 }, itemStyle: { color: c.accent }, data: line(pts, step, (p) => p.atmIv) },
        { name: 'Call IV', type: 'line', symbol: 'none', lineStyle: { width: 1, type: 'dashed' }, itemStyle: { color: c.down }, data: line(pts, step, (p) => p.ceIv) },
        { name: 'Put IV', type: 'line', symbol: 'none', lineStyle: { width: 1, type: 'dashed' }, itemStyle: { color: c.up }, data: line(pts, step, (p) => p.peIv) },
        { name: 'Spot', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1 }, itemStyle: { color: c.muted }, data: line(pts, step, (p) => p.spot) },
      ],
    };
  }, [q.data, interval, c]);
  const daily = useMemo(() => {
    const d = q.data?.daily ?? [];
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), valueFormatter: (v: number | null) => formatFixed(v, 2) },
      xAxis: { type: 'category', data: d.map((x) => x.date), ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: string) => v.slice(5) } },
      yAxis: [
        { type: 'value', scale: true, ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => `${v.toFixed(0)}%` } },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      dataZoom: [{ type: 'inside' }],
      series: [
        { name: 'IV (ATM)', type: 'line', symbol: 'none', lineStyle: { width: 2 }, itemStyle: { color: c.accent }, data: d.map((x) => x.iv) },
        { name: 'HV (20D)', type: 'line', symbol: 'none', lineStyle: { width: 1.5 }, itemStyle: { color: c.warn }, data: d.map((x) => x.hv) },
        { name: 'Close', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1 }, itemStyle: { color: c.muted }, data: d.map((x) => x.close) },
      ],
    };
  }, [q.data, c]);
  const dailyRows = q.data?.daily ?? [];
  const lastHv = [...dailyRows].reverse().find((x) => isNum(x.hv));
  const lastBoth = [...dailyRows].reverse().find((x) => isNum(x.iv) && isNum(x.hv));
  const spread = lastBoth ? (lastBoth.iv as number) - (lastBoth.hv as number) : null;
  const liveNow = q.data?.gaps?.currentIv === undefined;
  return (
    <div className="space-y-3">
      <PageHeader title="IV Chart" subtitle="At-the-money implied volatility through the day, and IV vs realised (historical) volatility over time — IV solved from premiums, never assumed">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setExpiry(undefined); }} />
        <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} />
        <SessionDate value={date} onChange={setDate} max={today} />
        <IntervalSelect value={interval} onChange={setIntervalMin} />
      </PageHeader>
      <Loadable q={q} hint="Intraday IV is solved from the premiums this app recorded; daily IV from the official end-of-day option closes.">
        {(d) => (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Stat
                label="ATM IV"
                value={isNum(d.currentIv) ? `${formatFixed(d.currentIv, 2)}%` : null}
                reason={d.gaps?.currentIv ?? 'No live or official ATM IV'}
                tone="accent"
                sub={isNum(d.currentIv) ? (liveNow ? 'solved from live premiums' : 'latest official close-based IV (not live)') : undefined}
                hint={d.gaps?.currentIv}
              />
              <Stat label="IV Rank (1Y)" value={isNum(d.ivr) ? formatFixed(d.ivr, 0) : null} reason={d.gaps?.ivr ?? 'IV rank needs a year of official ATM IV'} hint="Where today's IV sits between its 1-year low (0) and high (100)" />
              <Stat label="IV Percentile (1Y)" value={isNum(d.ivp) ? `${formatFixed(d.ivp, 0)}%` : null} reason={d.gaps?.ivr ?? 'IV percentile needs a year of official ATM IV'} hint="% of days in the last year with lower IV" />
              <Stat label="HV 20D" value={lastHv ? `${formatFixed(lastHv.hv, 2)}%` : null} reason="HV 20D needs 21 consecutive official closes" sub={lastHv ? `official closes to ${formatDate(lastHv.date)}` : undefined} />
              <Stat
                label="IV − HV"
                value={spread === null ? null : formatFixed(spread, 2)}
                reason="Needs an official ATM IV and an HV on the same day"
                tone={spread === null ? undefined : spread > 0 ? 'warn' : 'up'}
                sub={spread === null ? undefined : `${spread > 0 ? 'Options rich vs realised' : 'Options cheap vs realised'} · ${formatDate(lastBoth!.date)}`}
              />
            </div>
            {d.gaps?.ivr && <Coverage text={d.gaps.ivr} label="IV rank / percentile" />}
            <Card title={`Intraday ATM IV${d.expiry ? ` · ${d.expiry}` : ''} (solved from recorded premiums)`}>
              <Chart option={intraday} height={340} blank={d.intraday.some((p) => isNum(p.atmIv) || isNum(p.ceIv) || isNum(p.peIv)) ? undefined : d.gaps?.intraday ?? 'No recorded chain minutes for this session'} />
              <div className="mt-2">
                <Coverage text={`Session ${formatDate(d.date, true)}; the ATM IV of each point uses the premiums traded in its window.`} />
              </div>
            </Card>
            <Card title="IV vs HV history" actions={<Segmented size="xs" value={days} onChange={setDays} options={[{ value: 60, label: '3M' }, { value: 120, label: '6M' }, { value: 250, label: '1Y' }]} />}>
              <Chart option={daily} height={320} blank={dailyRows.some((x) => isNum(x.iv) || isNum(x.hv)) ? undefined : d.gaps?.daily ?? 'No official ATM IV or daily closes are loaded'} />
              <div className="mt-2 space-y-1">
                <Coverage text="IV: ATM IV solved from the official end-of-day option closes (nearest expiry with at least a day left). HV: 20-day realised volatility of official closes. A day without its official file is blank." />
                <Gaps gaps={d.gaps} omit={['currentIv', 'ivr', 'intraday', 'daily']} />
              </div>
            </Card>
          </>
        )}
      </Loadable>
    </div>
  );
}
