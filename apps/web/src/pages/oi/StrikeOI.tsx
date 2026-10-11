import { useMemo, useState } from 'react';
import { formatIndian, MARKET_OPEN_MIN, istTs, type StrikeOiResponse } from '@q26/core';
import { Chart, axis, baseOption, useChartColors } from '../../components/Chart';
import { ExpirySelect, SymbolSelect } from '../../components/pickers';
import { Card, Chg, Loadable, PageHeader, Segmented, Stat } from '../../components/ui';
import { formatCompact, formatSessionTime } from '../../lib/format';
import { useLive } from '../../lib/hooks';
import { qs } from '../../lib/api';
import { useApp, useTicks } from '../../lib/store';

type Since = 'prev' | 'open' | '60' | '30' | '15';

export default function StrikeOI() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const clock = useTicks((s) => s.clock);
  const [expiry, setExpiry] = useState<string>();
  const [mode, setMode] = useState<'oi' | 'chg' | 'both'>('both');
  const [since, setSince] = useState<Since>('prev');
  const [around, setAround] = useState(15);
  // Rolling windows re-anchor once a minute; 'open' is fixed for the session.
  const minute = clock ? Math.floor(clock.ts / 60_000) : 0;
  const date = clock?.date;
  const from = useMemo(() => {
    if (!date || since === 'prev') return undefined;
    if (since === 'open') return istTs(date, MARKET_OPEN_MIN);
    return minute * 60_000 - Number(since) * 60_000;
  }, [since, date, since === 'prev' || since === 'open' ? 0 : minute]);
  const q = useLive<StrikeOiResponse>(['strike-oi', symbol, expiry, from], `/oi/strikes/${symbol}${qs({ expiry, from })}`, 5000);
  const c = useChartColors();

  const view = useMemo(() => {
    const d = q.data;
    if (!d) return null;
    const idx = d.rows.reduce((bi, r, i) => (Math.abs(r.strike - d.spot) < Math.abs(d.rows[bi].strike - d.spot) ? i : bi), 0);
    const rows = d.rows.slice(Math.max(0, idx - around), idx + around + 1);
    const cats = rows.map((r) => String(r.strike));
    const spotIdx = rows.findIndex((r, i) => i < rows.length - 1 && r.strike <= d.spot && rows[i + 1].strike > d.spot);
    const series: unknown[] = [];
    if (mode !== 'chg') {
      series.push({ name: 'Call OI', type: 'bar', data: rows.map((r) => r.ceOi), itemStyle: { color: c.down }, barGap: '10%' });
      series.push({ name: 'Put OI', type: 'bar', data: rows.map((r) => r.peOi), itemStyle: { color: c.up } });
    }
    if (mode !== 'oi') {
      series.push({ name: 'Call OI Chg', type: 'bar', data: rows.map((r) => r.ceChange), itemStyle: { color: c.down, opacity: mode === 'both' ? 0.45 : 1 } });
      series.push({ name: 'Put OI Chg', type: 'bar', data: rows.map((r) => r.peChange), itemStyle: { color: c.up, opacity: mode === 'both' ? 0.45 : 1 } });
    }
    (series[0] as Record<string, unknown>).markLine = {
      symbol: 'none',
      label: { formatter: `Spot ${formatIndian(d.spot)}`, color: c.accent, fontSize: 10 },
      lineStyle: { color: c.accent, width: 1.5 },
      data: [{ xAxis: spotIdx >= 0 ? spotIdx + (d.spot - rows[spotIdx].strike) / (rows[spotIdx + 1].strike - rows[spotIdx].strike) : cats.length / 2 }],
    };
    const option = {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), axisPointer: { type: 'shadow' }, valueFormatter: (v: number) => formatCompact(v) },
      xAxis: { type: 'category', data: cats, ...axis(c, { splitLine: { show: false } }) },
      yAxis: { type: 'value', ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => formatCompact(v) } },
      dataZoom: [{ type: 'inside' }],
      series,
    };
    const ce = rows.reduce((a, r) => a + r.ceOi, 0);
    const pe = rows.reduce((a, r) => a + r.peOi, 0);
    const ceChg = rows.reduce((a, r) => a + r.ceChange, 0);
    const peChg = rows.reduce((a, r) => a + r.peChange, 0);
    const maxCe = rows.reduce((a, r) => (r.ceOi > a.ceOi ? r : a));
    const maxPe = rows.reduce((a, r) => (r.peOi > a.peOi ? r : a));
    const maxCeChg = rows.reduce((a, r) => (r.ceChange > a.ceChange ? r : a));
    const maxPeChg = rows.reduce((a, r) => (r.peChange > a.peChange ? r : a));
    return { option, ce, pe, ceChg, peChg, maxCe, maxPe, maxCeChg, maxPeChg, d };
  }, [q.data, mode, around, c]);

  return (
    <div className="space-y-3">
      <PageHeader title="Open Interest Analysis" subtitle="Strike-wise call & put OI and change in OI — read support/resistance and fresh writing">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setExpiry(undefined); }} />
        <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} />
      </PageHeader>
      <Loadable q={q}>
        {() =>
          view && (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label="Total Call OI" value={formatCompact(view.ce)} sub={<Chg value={view.ceChg / 1e5} decimals={2} />} />
                <Stat label="Total Put OI" value={formatCompact(view.pe)} sub={<Chg value={view.peChg / 1e5} decimals={2} />} />
                <Stat label="PCR (shown strikes)" value={(view.pe / view.ce).toFixed(2)} tone={view.pe >= view.ce ? 'up' : 'down'} sub={`Max pain ${formatIndian(view.d.maxPain, 0)}`} />
                <Stat label="Change measured from" value={formatSessionTime(view.d.fromTs)} sub={new Date(view.d.fromTs).toISOString().slice(0, 10)} />
                <Stat label="Resistance (max CE OI)" value={formatIndian(view.maxCe.strike, 0)} tone="down" sub={formatCompact(view.maxCe.ceOi)} />
                <Stat label="Support (max PE OI)" value={formatIndian(view.maxPe.strike, 0)} tone="up" sub={formatCompact(view.maxPe.peOi)} />
                <Stat label="Max call writing" value={formatIndian(view.maxCeChg.strike, 0)} sub={`+${formatCompact(view.maxCeChg.ceChange)}`} />
                <Stat label="Max put writing" value={formatIndian(view.maxPeChg.strike, 0)} sub={`+${formatCompact(view.maxPeChg.peChange)}`} />
              </div>
              <Card
                title={`${symbol} strike-wise OI`}
                actions={
                  <>
                    <Segmented size="xs" value={mode} onChange={setMode} options={[{ value: 'oi', label: 'OI' }, { value: 'chg', label: 'Change' }, { value: 'both', label: 'Both' }]} />
                    <Segmented size="xs" value={since} onChange={setSince} options={[{ value: 'prev', label: 'vs Prev close' }, { value: 'open', label: 'Since open' }, { value: '60', label: '60m' }, { value: '30', label: '30m' }, { value: '15', label: '15m' }]} />
                    <Segmented size="xs" value={around} onChange={setAround} options={[{ value: 10, label: '±10' }, { value: 15, label: '±15' }, { value: 25, label: '±25' }]} />
                  </>
                }
              >
                <Chart option={view.option} height={420} />
              </Card>
            </>
          )
        }
      </Loadable>
    </div>
  );
}
