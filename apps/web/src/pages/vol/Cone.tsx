import { useMemo } from 'react';
import type { ConeResponse } from '@q26/core';
import { Chart, axis, baseOption, LINE_GAPS, useChartColors } from '../../components/Chart';
import { SymbolSelect } from '../../components/pickers';
import { Card, Coverage, Gaps, Loadable, PageHeader, Stat } from '../../components/ui';
import { isNoLiveData } from '../../lib/api';
import { formatDate, formatFixed, isNum } from '../../lib/format';
import { useLive } from '../../lib/hooks';
import { useApp } from '../../lib/store';

type Row = ConeResponse['rows'][number];

export default function Cone() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const q = useLive<ConeResponse>(['cone', symbol], `/vol/cone/${symbol}`, 60000);
  const c = useChartColors();
  const option = useMemo(() => {
    const d = q.data;
    const r = d?.rows ?? [];
    const x = r.map((v) => `${v.window}D`);
    // A window the history is too short for is null: a gap in the line, not a guess.
    const line = (name: string, k: Exclude<keyof Row, 'window'>, color: string, type = 'solid', width = 1.5) => ({ name, type: 'line', symbol: 'circle', symbolSize: 5, ...LINE_GAPS, lineStyle: { color, type, width }, itemStyle: { color }, data: r.map((v) => v[k]) });
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), valueFormatter: (v: number | null) => (typeof v === 'number' ? `${v.toFixed(2)}%` : '—') },
      xAxis: { type: 'category', data: x, ...axis(c, { splitLine: { show: false } }) },
      yAxis: { type: 'value', scale: true, ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => `${v}%` } },
      series: [
        line('Max', 'max', c.down, 'dashed', 1),
        line('75th pct', 'p75', c.warn, 'dotted'),
        line('Median', 'median', c.muted),
        line('25th pct', 'p25', c.up, 'dotted'),
        line('Min', 'min', c.up, 'dashed', 1),
        line('Current HV', 'current', c.accent, 'solid', 2.5),
        // The live ATM IV (solved from premiums) as one level across the windows; absent without a live IV.
        ...(d && isNum(d.atmIv) ? [{ name: 'ATM IV (live)', type: 'line', symbol: 'none', ...LINE_GAPS, lineStyle: { color: c.series[4], width: 2 }, itemStyle: { color: c.series[4] }, data: r.map(() => d.atmIv) }] : []),
      ],
    };
  }, [q.data, c]);
  // A 503 replaces the cone with its reason: the stats must not keep showing the previous answer.
  const d = isNoLiveData(q.error) ? undefined : q.data;
  const r20 = d?.rows.find((r) => r.window === 20);
  const rowsWhy = d?.gaps?.rows ?? 'The official history is too short for this window';
  const ivVsMedian = d && r20 && isNum(d.atmIv) && isNum(r20.median) ? d.atmIv - r20.median : null;
  return (
    <div className="space-y-3">
      <PageHeader title="Volatility Cone" subtitle="Distribution of realised volatility for each look-back window (official daily closes) vs current HV and implied vol">
        <SymbolSelect value={symbol} onChange={setSymbol} />
      </PageHeader>
      {d && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="ATM IV" value={isNum(d.atmIv) ? `${formatFixed(d.atmIv, 2)}%` : null} reason={d.gaps?.atmIv ?? 'No live ATM IV'} tone="accent" sub="solved from live premiums" />
          <Stat label="HV 20D" value={r20 && isNum(r20.current) ? `${formatFixed(r20.current, 2)}%` : null} reason={rowsWhy} />
          <Stat label="HV 20D median" value={r20 && isNum(r20.median) ? `${formatFixed(r20.median, 2)}%` : null} reason={rowsWhy} />
          <Stat
            label="IV vs median HV"
            value={ivVsMedian === null ? null : formatFixed(ivVsMedian, 2)}
            reason="Needs a live ATM IV and the 20-day HV median"
            tone={ivVsMedian === null ? undefined : ivVsMedian > 0 ? 'warn' : 'up'}
            sub={ivVsMedian === null ? undefined : ivVsMedian > 0 ? 'IV rich' : 'IV cheap'}
          />
        </div>
      )}
      <Card title={`${symbol} realised volatility cone`}>
        <Loadable q={q}>
          {(res) => (
            <>
              <Chart option={option} height={380} blank={res.rows.some((r) => isNum(r.median) || isNum(r.current)) ? undefined : res.gaps?.rows ?? 'The official history is too short for any window'} />
              <div className="mt-2 space-y-1">
                <Coverage text={`Built from ${res.closes} consecutive official daily closes${res.from && res.to ? ` (${formatDate(res.from, true)} – ${formatDate(res.to, true)})` : ''}; a window longer than that history is blank.`} />
                <Gaps gaps={res.gaps} />
              </div>
            </>
          )}
        </Loadable>
      </Card>
    </div>
  );
}
