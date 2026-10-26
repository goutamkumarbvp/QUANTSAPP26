import { useMemo, useState } from 'react';
import { formatTimeIST, pcrSentiment, type PcrResponse } from '@q26/core';
import { Chart, axis, baseOption, timeAxis, useChartColors } from '../../components/Chart';
import { ExpirySelect, IntervalSelect, SessionDate, SymbolSelect } from '../../components/pickers';
import { Card, Coverage, Gaps, Loadable, PageHeader, Stat } from '../../components/ui';
import { qs } from '../../lib/api';
import { formatCompact, formatDate, formatFixed, formatIndian, isNum } from '../../lib/format';
import { useLive } from '../../lib/hooks';
import { useApp, useTicks } from '../../lib/store';

const MIN = 60_000;

/** The gaps whose section passes `keep` (the blank state of a card already says why it is empty). */
const subset = (gaps: Record<string, string> | undefined, keep: (section: string) => boolean) => Object.fromEntries(Object.entries(gaps ?? {}).filter(([k]) => keep(k)));

type Intraday = PcrResponse['intraday'][number];

/** `[ts, value]` pairs of the recorded points; a null breaks the line where more than a step of recording is missing. */
function line(pts: Intraday[], stepMs: number, pick: (p: Intraday) => number | null): [number, number | null][] {
  const out: [number, number | null][] = [];
  pts.forEach((p, i) => {
    if (i > 0 && p.ts - pts[i - 1].ts > stepMs * 1.5) out.push([pts[i - 1].ts + stepMs, null]);
    out.push([p.ts, pick(p)]);
  });
  return out;
}

export default function Pcr() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const today = useTicks((s) => s.clock?.date);
  const [expiry, setExpiry] = useState<string>();
  const [interval, setIntervalMin] = useState(5);
  const [date, setDate] = useState('');
  const q = useLive<PcrResponse>(['pcr', symbol, expiry, interval, date], `/oi/pcr/${symbol}${qs({ expiry, interval, date, days: 60 })}`, date ? false : 10000);
  const c = useChartColors();
  const intraday = useMemo(() => {
    const pts = q.data?.intraday ?? [];
    const step = interval * MIN;
    return {
      ...baseOption(c),
      xAxis: timeAxis(c),
      yAxis: [
        { type: 'value', scale: true, ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => v.toFixed(2) } },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      dataZoom: [{ type: 'inside' }],
      series: [
        { name: 'PCR', type: 'line', symbol: 'none', itemStyle: { color: c.accent }, lineStyle: { width: 2 }, data: line(pts, step, (p) => p.pcr), markLine: { symbol: 'none', silent: true, lineStyle: { color: c.muted, type: 'dashed' }, data: [{ yAxis: 1 }] } },
        { name: 'Spot', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1 }, itemStyle: { color: c.muted }, data: line(pts, step, (p) => p.spot) },
      ],
    };
  }, [q.data, interval, c]);
  // Change-in-OI PCR: today's put OI added ÷ call OI added (vs the previous close), from 09:15.
  const changeChart = useMemo(() => {
    const pts = q.data?.intraday ?? [];
    const step = interval * MIN;
    return {
      ...baseOption(c),
      xAxis: timeAxis(c),
      yAxis: [
        { type: 'value', scale: true, ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => v.toFixed(2) } },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatCompact(v, 1) } },
      ],
      dataZoom: [{ type: 'inside' }],
      series: [
        { name: 'Change PCR', type: 'line', symbol: 'none', itemStyle: { color: c.accent }, lineStyle: { width: 2 }, data: line(pts, step, (p) => p.changePcr), markLine: { symbol: 'none', silent: true, lineStyle: { color: c.muted, type: 'dashed' }, data: [{ yAxis: 1 }] } },
        { name: 'Put OI added', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1 }, itemStyle: { color: c.up }, data: line(pts, step, (p) => p.peChange) },
        { name: 'Call OI added', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1 }, itemStyle: { color: c.down }, data: line(pts, step, (p) => p.ceChange) },
      ],
    };
  }, [q.data, interval, c]);
  const daily = useMemo(() => {
    const d = q.data?.daily ?? [];
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), axisPointer: { type: 'shadow' } },
      xAxis: { type: 'category', data: d.map((x) => x.date.slice(5)), ...axis(c, { splitLine: { show: false } }) },
      yAxis: [
        { type: 'value', ...axis(c), min: 0 },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      series: [
        { name: 'EOD PCR', type: 'bar', data: d.map((x) => ({ value: x.pcr, itemStyle: { color: x.pcr >= 1 ? c.up : c.down } })) },
        // The close is blank (a gap in the line) on days whose index/cash file is not loaded.
        { name: 'Close', type: 'line', yAxisIndex: 1, symbol: 'none', itemStyle: { color: c.accent }, data: d.map((x) => x.close) },
      ],
    };
  }, [q.data, c]);
  const withPcr = (q.data?.intraday ?? []).filter((p) => isNum(p.pcr));
  const last = withPcr[withPcr.length - 1];
  const first = withPcr[0];
  const pcrs = withPcr.map((p) => p.pcr as number);
  const withChange = (q.data?.intraday ?? []).filter((p) => isNum(p.ceChange) && isNum(p.peChange));
  const lastChange = withChange[withChange.length - 1];
  return (
    <div className="space-y-3">
      <PageHeader title="Put-Call Ratio" subtitle="PCR = total put OI ÷ total call OI; Change PCR = today's put OI added ÷ call OI added. Rising = put writing (support building); falling = call writing.">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setExpiry(undefined); }} />
        <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} />
        <SessionDate value={date} onChange={setDate} max={today} />
        <IntervalSelect value={interval} onChange={setIntervalMin} />
      </PageHeader>
      <Loadable q={q} hint="Intraday PCR comes from the minutes this app recorded; end-of-day PCR from the official F&O files.">
        {(d) => (
          <>
            {last && first && (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Current PCR (streamed strikes)" value={formatFixed(last.pcr, 3)} tone={(last.pcr as number) >= 1 ? 'up' : 'down'} sub={pcrSentiment(last.pcr as number)} />
                <Stat label="First recorded PCR" value={formatFixed(first.pcr, 3)} />
                <Stat label="Change since then" value={formatFixed((last.pcr as number) - (first.pcr as number), 3)} tone={(last.pcr as number) >= (first.pcr as number) ? 'up' : 'down'} />
                <Stat label="Recorded range" value={`${formatFixed(Math.min(...pcrs), 2)} – ${formatFixed(Math.max(...pcrs), 2)}`} />
              </div>
            )}
            <Card title="Intraday PCR vs spot">
              <Chart option={intraday} height={340} blank={withPcr.length ? undefined : d.gaps?.intraday ?? 'No recorded chain minutes for this session'} />
              <div className="mt-2 space-y-1">
                <Coverage text={d.coverage.intraday} />
                <Gaps gaps={subset(d.gaps, (k) => k.startsWith('intraday.'))} />
              </div>
            </Card>
            <Card title="Change-in-OI PCR — today only (put OI added ÷ call OI added, since the previous close)">
              {lastChange && (
                <div className="mb-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Stat label="Change PCR now" value={formatFixed(lastChange.changePcr, 2)} tone={isNum(lastChange.changePcr) ? (lastChange.changePcr >= 1 ? 'up' : 'down') : undefined} reason="Call OI change too small to divide by" sub={isNum(lastChange.changePcr) ? (lastChange.changePcr >= 1 ? 'more puts written' : 'more calls written') : undefined} />
                  <Stat label="Put OI added today" value={formatCompact(lastChange.peChange, 2)} tone={(lastChange.peChange as number) >= 0 ? 'up' : 'down'} />
                  <Stat label="Call OI added today" value={formatCompact(lastChange.ceChange, 2)} tone={(lastChange.ceChange as number) >= 0 ? 'down' : 'up'} />
                  <Stat label="As of" value={formatTimeIST(lastChange.ts)} />
                </div>
              )}
              <Chart option={changeChart} height={320} blank={withChange.length ? undefined : d.gaps?.['intraday.change'] ?? d.gaps?.intraday ?? 'No recorded chain minutes for this session'} />
              <div className="mt-2 space-y-1">
                <Coverage text="Same strikes on both sides of the ratio: the recorded strikes that also have an official previous-close OI. A negative value means one side's OI fell (unwinding). The ratio is blank while the call OI change is under 0.1% of call OI." />
              </div>
            </Card>
            <Card title="End-of-day PCR (nearest expiry) — official F&O files, last 60 sessions">
              <Chart option={daily} height={300} blank={d.daily.length ? undefined : d.gaps?.daily ?? 'No official F&O file is loaded'} />
              <div className="mt-2 space-y-1">
                <Coverage text={d.coverage.daily} />
                {d.daily.length > 0 && <Coverage text={`${d.daily.length} official sessions loaded, ${formatDate(d.daily[0].date)} – ${formatDate(d.daily[d.daily.length - 1].date)}; sessions without an official file are not shown`} />}
              </div>
            </Card>
          </>
        )}
      </Loadable>
    </div>
  );
}
