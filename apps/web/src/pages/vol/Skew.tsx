import { useMemo, useState } from 'react';
import { formatExpiry, type SkewResponse } from '@q26/core';
import { Chart, axis, baseOption, LINE_GAPS, useChartColors } from '../../components/Chart';
import { SymbolSelect } from '../../components/pickers';
import { Card, Coverage, cx, Gaps, Loadable, NoData, PageHeader, Segmented, Toggle, Val } from '../../components/ui';
import { errorText, isNoLiveData, qs } from '../../lib/api';
import { formatDate, formatFixed, formatIndian } from '../../lib/format';
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
    const series = d.curves.flatMap((cv) => {
      // One colour per expiry: the live curve and its previous-close curve share it (the latter dashed).
      const color = c.series[Math.max(0, list.indexOf(cv.expiry)) % c.series.length];
      const dashed = cv.source === 'eod';
      const tag = dashed ? cv.label : `${cv.label} · live`;
      const pt = (p: (typeof cv.points)[number], v: number | null) => [x === 'strike' ? p.strike : p.moneyness, v];
      // A strike without a solved IV stays a gap in the curve (no smoothing, no interpolation).
      if (!split) return [{ name: tag, type: 'line', symbol: 'none', ...LINE_GAPS, lineStyle: { width: 2, type: dashed ? 'dashed' : 'solid' }, itemStyle: { color }, data: cv.points.map((p) => pt(p, p.iv)) }];
      return [
        { name: `${tag} CE`, type: 'line', symbol: 'none', ...LINE_GAPS, lineStyle: { width: 1.5, type: dashed ? 'dashed' : 'solid' }, itemStyle: { color }, data: cv.points.map((p) => pt(p, p.ceIv)) },
        { name: `${tag} PE`, type: 'line', symbol: 'none', ...LINE_GAPS, lineStyle: { width: 1.5, type: 'dotted' }, itemStyle: { color }, data: cv.points.map((p) => pt(p, p.peIv)) },
      ];
    });
    // Tick decimals from the IV span shown: a narrow smile (e.g. 13.8–14.6 %) must not label every tick "14%".
    const ivs = d.curves.flatMap((cv) => cv.points.flatMap((p) => [p.iv, p.ceIv, p.peIv])).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const span = ivs.length ? Math.max(...ivs) - Math.min(...ivs) : 0;
    const ivDec = span < 2 ? 2 : span < 10 ? 1 : 0;
    const spotX = x === 'strike' ? d.spot : 0;
    if (series.length && spotX !== null) (series[0] as Record<string, unknown>).markLine = { symbol: 'none', silent: true, label: { formatter: 'Spot', color: c.accent }, lineStyle: { color: c.accent }, data: [{ xAxis: spotX }] };
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), valueFormatter: (v: number | null) => (typeof v === 'number' ? `${v.toFixed(2)}%` : '—') },
      xAxis: { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => (x === 'strike' ? String(v) : `${v}%`) } },
      yAxis: { type: 'value', scale: true, ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => `${v.toFixed(ivDec)}%` } },
      dataZoom: [{ type: 'inside' }],
      series,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, x, split, compare, c]);
  return (
    <div className="space-y-3">
      <PageHeader title="Volatility Skew" subtitle="Implied volatility across strikes (OTM options) — solved from live premiums; compare expiries and the previous close">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setPicked([]); }} />
      </PageHeader>
      <Card title="Expiries (up to 5)">
        {all.length ? (
          <div className="flex flex-wrap gap-1">
            {all.map((e) => (
              <button key={e} onClick={() => setPicked((p) => { const base = p.length ? p : list; return base.includes(e) ? base.filter((y) => y !== e) : [...base, e].slice(-5); })} className={cx('chip cursor-pointer px-2 py-1 text-xs', list.includes(e) ? 'bg-accent text-white' : 'bg-panel2 text-muted')}>
                {formatExpiry(e)}
              </button>
            ))}
          </div>
        ) : (
          <div className="text-sm text-muted">{exp.error ? errorText(exp.error) : exp.isLoading ? 'Loading the listed expiries…' : `No option expiry is listed for ${symbol}`}</div>
        )}
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
        {list.length === 0 ? (
          <NoData compact title="No expiry to chart" reason={exp.error ? errorText(exp.error) : exp.isLoading ? 'Loading the listed expiries…' : `No option expiry is listed for ${symbol}`} />
        ) : (
          <Loadable q={q}>
            {(d) => (
              <>
                <Chart option={option} height={420} blank={d.curves.some((cv) => cv.points.length) ? undefined : 'No strike has a solvable premium'} />
                <div className="mt-2 space-y-1">
                  <Coverage text="IV is solved from live option premiums on the listed strikes (OTM side: calls at/above the forward, puts below). A strike without a live premium is a gap in the curve — nothing is interpolated. “Prev close” curves use the previous session’s official traded closes." />
                  <Gaps gaps={d.gaps} />
                </div>
              </>
            )}
          </Loadable>
        )}
      </Card>
      {q.data && list.length > 0 && !isNoLiveData(q.error) && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {q.data.curves.map((cv) => (
            <div key={`${cv.expiry}${cv.source}`} className="card card-pad" title={cv.source === 'eod' ? `Solved from the official closes of ${formatDate(cv.date, true)}` : 'Solved from live premiums'}>
              <div className="text-2xs text-muted">{cv.label}{cv.source === 'live' ? ' · live' : ` · close of ${formatDate(cv.date)}`}</div>
              <div className="text-base font-semibold">ATM IV <Val value={cv.atmIv} format={(v) => `${formatFixed(v, 2)}%`} reason="ATM IV could not be solved from the available premiums" /></div>
              <div className="text-2xs text-muted">Forward <Val value={cv.forward} format={(v) => formatIndian(v)} reason="No forward" /></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
