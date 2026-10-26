import { useMemo, useState } from 'react';
import type { MaxPainResponse } from '@q26/core';
import { Chart, axis, baseOption, gapLine, timeAxis, useChartColors } from '../../components/Chart';
import { ExpirySelect, SymbolSelect } from '../../components/pickers';
import { Card, Coverage, Gaps, Loadable, PageHeader, Stat } from '../../components/ui';
import { qs } from '../../lib/api';
import { formatCompact, formatFixed, formatIndian, isNum } from '../../lib/format';
import { useLive } from '../../lib/hooks';
import { useApp } from '../../lib/store';

/** The history is recorded in 15-minute windows (the server's `oiTrend(…, 15)`). */
const HISTORY_STEP = 15 * 60_000;

type Point = MaxPainResponse['history'][number];

export default function MaxPain() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const [expiry, setExpiry] = useState<string>();
  const q = useLive<MaxPainResponse>(['max-pain', symbol, expiry], `/oi/max-pain/${symbol}${qs({ expiry })}`, 15000);
  const c = useChartColors();
  const bars = useMemo(() => {
    const d = q.data;
    if (!d || d.maxPain === null) return {};
    // Strikes within ±7 % of the spot (of max pain when there is no live spot).
    const ref = d.spot ?? d.maxPain;
    const lo = ref * 0.93;
    const hi = ref * 1.07;
    const rows = d.pain.filter((p) => p.strike >= lo && p.strike <= hi);
    const mp = d.maxPain;
    const mpIdx = rows.findIndex((r) => r.strike === mp);
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), axisPointer: { type: 'shadow' }, valueFormatter: (v: number | null) => `₹${formatCompact(v)}` },
      xAxis: { type: 'category', data: rows.map((r) => String(r.strike)), ...axis(c, { splitLine: { show: false } }) },
      yAxis: { type: 'value', ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => formatCompact(v) } },
      series: [
        { name: 'Call writers pay', type: 'bar', stack: 'p', itemStyle: { color: c.down }, data: rows.map((r) => r.callPain) },
        {
          name: 'Put writers pay', type: 'bar', stack: 'p', itemStyle: { color: c.up }, data: rows.map((r) => r.putPain),
          markLine: mpIdx >= 0 ? { symbol: 'none', lineStyle: { color: c.warn, width: 2 }, label: { formatter: `Max pain ${mp}`, color: c.warn }, data: [{ xAxis: mpIdx }] } : undefined,
        },
      ],
    };
  }, [q.data, c]);
  const hist = useMemo(() => {
    const h = q.data?.history ?? [];
    // Plain lines between recorded points (no step/fill-forward: the value between two points is not known).
    return {
      ...baseOption(c),
      xAxis: timeAxis(c),
      yAxis: { type: 'value', scale: true, ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      series: [
        { name: 'Max pain', type: 'line', symbol: 'none', itemStyle: { color: c.warn }, data: gapLine(h, HISTORY_STEP, (p) => p.maxPain) },
        { name: 'Spot', type: 'line', symbol: 'none', itemStyle: { color: c.accent }, data: gapLine(h, HISTORY_STEP, (p) => p.spot) },
      ],
    };
  }, [q.data, c]);
  return (
    <div className="space-y-3">
      <PageHeader title="Max Pain" subtitle="The expiry price at which option buyers collectively lose the most (writers pay the least)">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setExpiry(undefined); }} />
        <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} />
      </PageHeader>
      <Loadable q={q} hint="The history comes from the chain minutes this app recorded; nothing is back-filled.">
        {(d) => {
          const distance = isNum(d.maxPain) && isNum(d.spot) ? d.maxPain - d.spot : null;
          const painWhy = d.gaps?.pain ?? 'No strike has open interest on both sides';
          return (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Stat label="Max pain" value={d.maxPain === null ? null : formatIndian(d.maxPain, 0)} reason={painWhy} tone="warn" sub="Over strikes with OI on both sides" />
                <Stat label="Spot" value={d.spot === null ? null : formatIndian(d.spot)} reason="No live spot price" />
                <Stat label="Distance" value={distance === null ? null : `${formatFixed(distance, 0)} pts`} reason={d.spot === null ? 'Needs the live spot price' : painWhy} sub={distance !== null && d.spot ? `${formatFixed((distance / d.spot) * 100, 2)}%` : undefined} />
              </div>
              <Card title="Option pain by expiry price">
                <Chart option={bars} height={380} blank={d.maxPain === null ? painWhy : undefined} />
                <div className="mt-2">
                  <Coverage text={d.coverage} label="Covers" />
                </div>
              </Card>
              <Card title="Max pain vs spot through the session">
                <Chart option={hist} height={280} blank={d.history.some((p) => isNum(p.maxPain) || isNum(p.spot)) ? undefined : d.gaps?.history ?? 'No recorded chain minutes for this session'} />
                <div className="mt-2 space-y-1">
                  <Coverage text="Recorded chain minutes, 15-minute windows, streamed strikes only (±8 %) — not the whole chain" />
                  <Gaps gaps={d.gaps} omit={['pain', 'history']} />
                </div>
              </Card>
            </>
          );
        }}
      </Loadable>
    </div>
  );
}
