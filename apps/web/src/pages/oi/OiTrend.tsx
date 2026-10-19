import { useMemo, useState } from 'react';
import type { OiTrendPoint, OiTrendResponse } from '@q26/core';
import { Chart, axis, baseOption, timeAxis, useChartColors } from '../../components/Chart';
import { ExpirySelect, IntervalSelect, SessionDate, SymbolSelect } from '../../components/pickers';
import { Card, Chg, Coverage, Gaps, Loadable, PageHeader, Segmented, Stat } from '../../components/ui';
import { qs } from '../../lib/api';
import { formatCompact, formatFixed, formatIndian, isNum } from '../../lib/format';
import { useLive } from '../../lib/hooks';
import { useApp, useTicks } from '../../lib/store';

const MIN = 60_000;

/**
 * `[ts, value]` pairs of the recorded points. Where more than one step is missing between two recorded
 * points a null is put in, so the line breaks there instead of bridging a stretch nothing was recorded for.
 */
function line(pts: OiTrendPoint[], stepMs: number, pick: (p: OiTrendPoint) => number | null): [number, number | null][] {
  const out: [number, number | null][] = [];
  pts.forEach((p, i) => {
    if (i > 0 && p.ts - pts[i - 1].ts > stepMs * 1.5) out.push([pts[i - 1].ts + stepMs, null]);
    out.push([p.ts, pick(p)]);
  });
  return out;
}

export default function OiTrend() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const today = useTicks((s) => s.clock?.date);
  const [expiry, setExpiry] = useState<string>();
  const [interval, setIntervalMin] = useState(5);
  const [date, setDate] = useState('');
  const [view, setView] = useState<'change' | 'total'>('change');
  const q = useLive<OiTrendResponse>(['oi-trend', symbol, expiry, interval, date], `/oi/trend/${symbol}${qs({ expiry, interval, date })}`, date ? false : 10000);
  const c = useChartColors();
  const pts = q.data?.points;
  const option = useMemo(() => {
    const p = pts ?? [];
    const step = interval * MIN;
    const k = view === 'change' ? (['ceChange', 'peChange'] as const) : (['ceOi', 'peOi'] as const);
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), valueFormatter: (v: number | null) => formatCompact(v) },
      xAxis: timeAxis(c),
      yAxis: [
        { type: 'value', scale: view === 'total', ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => formatCompact(v) } },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      dataZoom: [{ type: 'inside' }],
      series: [
        { name: view === 'change' ? 'Call OI change' : 'Call OI', type: 'line', symbol: 'none', areaStyle: { opacity: 0.08 }, itemStyle: { color: c.down }, data: line(p, step, (x) => x[k[0]]) },
        { name: view === 'change' ? 'Put OI change' : 'Put OI', type: 'line', symbol: 'none', areaStyle: { opacity: 0.08 }, itemStyle: { color: c.up }, data: line(p, step, (x) => x[k[1]]) },
        { name: 'Spot', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1 }, itemStyle: { color: c.muted }, data: line(p, step, (x) => x.spot) },
      ],
    };
  }, [pts, view, interval, c]);
  // The change view with no OI change at all (previous-close OI missing): blank with the reason, not a spot-only chart.
  const blank = view === 'change' && q.data && !q.data.points.some((p) => isNum(p.ceChange) || isNum(p.peChange)) ? q.data.gaps?.change ?? 'OI change needs the previous session’s official OI' : undefined;
  const last = q.data?.points[q.data.points.length - 1];
  const changeWhy = q.data?.gaps?.change ?? 'OI change needs the previous session’s official OI';
  const netAdd = last && isNum(last.peChange) && isNum(last.ceChange) ? last.peChange - last.ceChange : null;
  return (
    <div className="space-y-3">
      <PageHeader title="OI Trend" subtitle="Call vs put open interest (and its change) through the session — who is adding positions?">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setExpiry(undefined); }} />
        <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} />
        <SessionDate value={date} onChange={setDate} max={today} />
        <IntervalSelect value={interval} onChange={setIntervalMin} />
      </PageHeader>
      {last && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Call OI (streamed strikes ±8 %)" value={isNum(last.ceOi) ? formatCompact(last.ceOi) : null} reason="No recorded call OI" sub={<span>Chg <Chg value={isNum(last.ceChange) ? last.ceChange / 1e5 : null} reason={changeWhy} /> L</span>} />
          <Stat label="Put OI (streamed strikes ±8 %)" value={isNum(last.peOi) ? formatCompact(last.peOi) : null} reason="No recorded put OI" sub={<span>Chg <Chg value={isNum(last.peChange) ? last.peChange / 1e5 : null} reason={changeWhy} /> L</span>} />
          <Stat label="PCR (streamed strikes ±8 %)" value={isNum(last.pcr) ? formatFixed(last.pcr, 2) : null} reason="No recorded OI on both sides" tone={isNum(last.pcr) ? (last.pcr >= 1 ? 'up' : 'down') : undefined} />
          <Stat
            label="Net put − call addition"
            value={netAdd === null ? null : formatCompact(netAdd)}
            reason={changeWhy}
            tone={netAdd === null ? undefined : netAdd >= 0 ? 'up' : 'down'}
            sub={netAdd === null ? undefined : netAdd >= 0 ? 'Put writers dominant (bullish)' : 'Call writers dominant (bearish)'}
          />
        </div>
      )}
      <Card title={`${symbol} OI through the day`} actions={<Segmented size="xs" value={view} onChange={setView} options={[{ value: 'change', label: 'Change in OI' }, { value: 'total', label: 'Total OI' }]} />}>
        <Loadable q={q} hint="Intraday series come from the minutes this app recorded for that session; nothing is back-filled.">
          {(d) => (
            <>
              <Chart option={option} height={420} blank={blank} />
              <div className="mt-2 space-y-1">
                <Coverage text={d.coverage} />
                <Gaps gaps={d.gaps} />
              </div>
            </>
          )}
        </Loadable>
      </Card>
    </div>
  );
}
