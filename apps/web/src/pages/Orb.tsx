import { useMemo, useState } from 'react';
import { formatIndian, type MinuteBar, type OrbHistoryResponse, type OrbResponse, type OrbScanRow, type OrbTrend } from '@q26/core';
import { Chart, axis, baseOption, useChartColors } from '../components/Chart';
import { DataTable } from '../components/DataTable';
import { SessionDate, SymbolSelect } from '../components/pickers';
import { TrendBadge } from '../components/trend';
import { Card, Chg, cx, Loadable, PageHeader, Segmented, Stat } from '../components/ui';
import { qs } from '../lib/api';
import { formatSessionTime } from '../lib/format';
import { useLive } from '../lib/hooks';
import { useApp, useTicks } from '../lib/store';

type Filter = 'all' | OrbTrend | 'whipsaw';

/** Decimals for a price: whole rupees for index-sized prices, paise for low-priced stocks. */
const dec = (v: number) => (Math.abs(v) >= 1000 ? 0 : 2);

/** Aggregate 1-minute candles into n-minute candles aligned to 09:15. */
function aggregate(bars: MinuteBar[], n: number): MinuteBar[] {
  if (n <= 1) return bars;
  const out: MinuteBar[] = [];
  for (let i = 0; i < bars.length; i += n) {
    const g = bars.slice(i, i + n);
    out.push({ ts: g[0].ts, open: g[0].open, close: g[g.length - 1].close, high: Math.max(...g.map((b) => b.high)), low: Math.min(...g.map((b) => b.low)) });
  }
  return out;
}

export default function Orb() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const today = useTicks((s) => s.clock?.date);
  const [date, setDate] = useState('');
  const [minutes, setMinutes] = useState(15);
  const [rule, setRule] = useState<'close' | 'touch'>('close');
  const [tf, setTf] = useState(1);
  const [filter, setFilter] = useState<Filter>('all');
  // Today's date (the picker's max) is still the live session — keep polling it.
  const isPast = !!date && !!today && date < today;
  const q = useLive<OrbResponse>(['orb', symbol, isPast ? date : '', minutes, rule], `/orb/${symbol}${qs({ date: isPast ? date : undefined, minutes, rule })}`, isPast ? false : 5000);
  const scan = useLive<OrbScanRow[]>(['orb-scan', minutes, rule], `/orb${qs({ minutes, rule })}`, 10000);
  const hist = useLive<OrbHistoryResponse>(['orb-hist', symbol, minutes, rule], `/orb/${symbol}/history${qs({ days: 20, minutes, rule })}`, 60000);
  const c = useChartColors();
  const openDay = (d: string) => {
    setDate(d);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const option = useMemo(() => {
    const d = q.data;
    if (!d || !d.bars.length) return {};
    const e = d.evaluation;
    const bars = aggregate(d.bars, tf);
    const cats = bars.map((b) => formatSessionTime(b.ts));
    const rangeEndIdx = Math.max(0, Math.ceil(d.rangeMinutes / tf) - 1);
    const label = (ts: number) => formatSessionTime(ts - ((ts - d.rangeStartTs) % (tf * 60_000)));
    return {
      ...baseOption(c),
      legend: { show: false },
      tooltip: { ...(baseOption(c).tooltip as object), axisPointer: { type: 'cross' } },
      xAxis: { type: 'category', data: cats, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, fontSize: 11, hideOverlap: true } },
      yAxis: [
        { type: 'value', scale: true, ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, dec(v)) } },
        { type: 'value', min: 0, max: 1, show: false },
      ],
      dataZoom: [{ type: 'inside' }],
      series: [
        // Opening-range band: full-width background behind every candle of the range.
        {
          name: 'range',
          type: 'bar',
          yAxisIndex: 1,
          silent: true,
          barWidth: '100%',
          barGap: '-100%',
          itemStyle: { color: c.warn, opacity: 0.1 },
          tooltip: { show: false },
          data: cats.map((_, i) => (i <= rangeEndIdx ? 1 : 0)),
          z: 0,
        },
        {
          name: d.symbol,
          type: 'candlestick',
          data: bars.map((b) => [b.open, b.close, b.low, b.high]),
          itemStyle: { color: c.up, color0: c.down, borderColor: c.up, borderColor0: c.down },
          markLine: Number.isFinite(e.high)
            ? {
                symbol: 'none',
                silent: true,
                label: { color: c.ink, fontSize: 10, formatter: '{b}', position: 'insideEndTop' },
                data: [
                  { name: `${d.rangeMinutes}-min range high ${formatIndian(e.high, dec(e.high))}`, yAxis: e.high, lineStyle: { color: c.up, type: 'dashed', width: 1.5 } },
                  { name: `${d.rangeMinutes}-min range low ${formatIndian(e.low, dec(e.low))}`, yAxis: e.low, lineStyle: { color: c.down, type: 'dashed', width: 1.5 } },
                ],
              }
            : undefined,
          markPoint: {
            symbolSize: 34,
            label: { fontSize: 10, color: '#fff', formatter: (p: { data: { dir: string } }) => (p.data.dir === 'up' ? '▲' : '▼') },
            data: e.crossings.map((b) => ({
              dir: b.direction,
              coord: [label(b.ts), b.direction === 'up' ? b.price : b.price],
              symbol: 'pin',
              symbolRotate: b.direction === 'up' ? 0 : 180,
              itemStyle: { color: b.direction === 'up' ? c.up : c.down },
            })),
          },
        },
      ],
    };
  }, [q.data, tf, c]);

  const rows = useMemo(() => (scan.data ?? []).filter((r) => (filter === 'all' ? true : filter === 'whipsaw' ? r.whipsaw : r.trend === filter)), [scan.data, filter]);
  const counts = useMemo(() => {
    const m: Record<string, number> = { up: 0, down: 0, sideways: 0, forming: 0, whipsaw: 0 };
    for (const r of scan.data ?? []) {
      m[r.trend]++;
      if (r.whipsaw) m.whipsaw++;
    }
    return m;
  }, [scan.data]);

  const d = q.data;
  const e = d?.evaluation;
  const first = e?.breaks[0];
  return (
    <div className="space-y-3">
      <PageHeader title="Opening Range Breakout" subtitle="The first 15-minute candle's high & low are noted every day. A break of either level means the market is trending in that direction; staying inside means range-bound.">
        <SymbolSelect value={symbol} onChange={setSymbol} />
        <SessionDate value={date} onChange={setDate} max={today} />
      </PageHeader>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={minutes} onChange={setMinutes} options={[{ value: 5, label: '5 min' }, { value: 15, label: '15 min' }, { value: 30, label: '30 min' }]} />
        <Segmented value={rule} onChange={setRule} options={[{ value: 'close', label: '1-min close beyond' }, { value: 'touch', label: 'Any touch' }]} />
      </div>

      <Loadable q={q}>
        {() =>
          d && e ? (
            <>
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-muted">{d.symbol} · {d.date} · {d.live ? 'live' : 'full session'}</div>
                    <div className="mt-1"><TrendBadge trend={e.trend} whipsaw={e.whipsaw} reentered={e.reentered} pending={e.pending} large /></div>
                    <div className={cx('mt-1 text-sm font-medium', e.trend === 'up' ? 'text-up' : e.trend === 'down' ? 'text-down' : 'text-muted')}>{d.summary}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xl font-bold tabular-nums">{formatIndian(d.ltp)}</div>
                    <Chg value={d.changePct} pct />
                  </div>
                </div>
              </Card>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <Stat label={`Range high (${formatSessionTime(d.rangeStartTs)}–${formatSessionTime(d.rangeEndTs)})`} value={formatIndian(e.high)} tone="up" sub={e.complete ? `${e.toHighPct >= 0 ? '+' : ''}${e.toHighPct.toFixed(2)}% from price` : 'so far'} />
                <Stat label="Range low" value={formatIndian(e.low)} tone="down" sub={e.complete ? `${e.toLowPct >= 0 ? '+' : ''}${e.toLowPct.toFixed(2)}% from price` : 'so far'} />
                <Stat label="Range width" value={`${formatIndian(e.width)} pts`} sub={`${e.widthPct.toFixed(2)}%`} />
                <Stat label="Price vs range" value={e.position === 'above' ? 'Above high' : e.position === 'below' ? 'Below low' : 'Inside'} tone={e.position === 'above' ? 'up' : e.position === 'below' ? 'down' : undefined} />
                <Stat label="First break" value={first ? `${first.direction === 'up' ? '▲ Up' : '▼ Down'} ${formatSessionTime(first.ts)}` : e.complete ? 'None yet' : '—'} sub={first ? `at ${formatIndian(first.price)}` : undefined} tone={first ? (first.direction === 'up' ? 'up' : 'down') : undefined} />
                <Stat label="Day high / low" value={`${formatIndian(d.dayHigh, dec(d.dayHigh))} / ${formatIndian(d.dayLow, dec(d.dayLow))}`} sub={`${e.crossings.length} range exits`} />
              </div>
              <Card title={`${d.symbol} candles with opening range`} actions={<Segmented size="xs" value={tf} onChange={setTf} options={[{ value: 1, label: '1m' }, { value: 3, label: '3m' }, { value: 5, label: '5m' }, { value: 15, label: '15m' }]} />}>
                <Chart option={option} height={420} />
              </Card>
            </>
          ) : null
        }
      </Loadable>

      <Card
        title="All F&O — opening range status (today)"
        pad={false}
        actions={
          <Segmented
            size="xs"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'all', label: `All (${scan.data?.length ?? 0})` },
              { value: 'up', label: `Trending ↑ (${counts.up})` },
              { value: 'down', label: `Trending ↓ (${counts.down})` },
              { value: 'sideways', label: `Sideways (${counts.sideways})` },
              { value: 'whipsaw', label: `Whipsaw (${counts.whipsaw})` },
            ]}
          />
        }
      >
        <Loadable q={scan}>
          {() => (
            <DataTable
              rows={rows}
              rowKey={(r) => r.symbol}
              maxHeight="60vh"
              initialSort={{ key: 'beyond', dir: 'desc' }}
              onRowClick={(r) => { setSymbol(r.symbol); setDate(''); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
              empty="No symbols in this state."
              columns={[
                { key: 'symbol', label: 'Symbol', value: (r) => r.symbol, render: (r) => <span className="font-semibold">{r.symbol}</span> },
                { key: 'ltp', label: 'LTP', num: true, value: (r) => r.ltp, render: (r) => formatIndian(r.ltp) },
                { key: 'chg', label: '% Chg', num: true, value: (r) => r.changePct, render: (r) => <Chg value={r.changePct} pct />, hideSm: true },
                { key: 'high', label: 'Range high', num: true, value: (r) => r.high, render: (r) => formatIndian(r.high), hideSm: true },
                { key: 'low', label: 'Range low', num: true, value: (r) => r.low, render: (r) => formatIndian(r.low), hideSm: true },
                { key: 'width', label: 'Width %', num: true, value: (r) => r.widthPct, render: (r) => r.widthPct.toFixed(2), hideSm: true },
                { key: 'trend', label: 'Status', value: (r) => r.trend, render: (r) => <TrendBadge trend={r.trend} whipsaw={r.whipsaw} reentered={r.reentered} pending={r.pending} /> },
                { key: 'break', label: 'Last break', num: true, value: (r) => r.breakTs ?? 0, render: (r) => (r.breakTs ? formatSessionTime(r.breakTs) : '—') },
                { key: 'beyond', label: 'Beyond level', num: true, value: (r) => r.beyondPct ?? -999, render: (r) => (r.beyondPct === null ? '—' : <Chg value={r.beyondPct} pct />) },
              ]}
            />
          )}
        </Loadable>
      </Card>

      <Card title={`${symbol} — opening range record (last 20 sessions)`} pad={false}>
        <Loadable q={hist}>
          {(h) => (
            <>
              <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-5">
                <Stat label="Broke up first" value={`${h.stats.brokeUp}/${h.stats.days}`} tone="up" />
                <Stat label="Broke down first" value={`${h.stats.brokeDown}/${h.stats.days}`} tone="down" />
                <Stat label="Stayed inside" value={`${h.stats.sideways}/${h.stats.days}`} />
                <Stat label="Whipsaw days" value={`${h.stats.whipsaw}/${h.stats.days}`} tone="warn" />
                <Stat label="Trend days" value={`${h.stats.trendDays}/${h.stats.days}`} sub={`Avg follow-through ${h.stats.avgFollowThroughPct.toFixed(2)}%`} hint="Closed beyond the range on the side it first broke" />
              </div>
              <div className="max-h-[50vh] overflow-auto">
                <table className="tbl">
                  <thead>
                    <tr><th>Date</th><th className="num">Range high</th><th className="num">Range low</th><th className="num">Width %</th><th>First break</th><th>Status at close</th><th className="num">Close</th><th className="num">Follow-through</th></tr>
                  </thead>
                  <tbody>
                    {h.rows.map((r) => (
                      <tr
                        key={r.date}
                        tabIndex={0}
                        aria-selected={r.date === date}
                        className={cx('cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-accent', r.date === date && 'bg-accent/10')}
                        onClick={() => openDay(r.date)}
                        onKeyDown={(ev) => {
                          if (ev.key === 'Enter' || ev.key === ' ') {
                            ev.preventDefault();
                            openDay(r.date);
                          }
                        }}
                      >
                        <td>{r.date}</td>
                        <td className="num">{formatIndian(r.high)}</td>
                        <td className="num">{formatIndian(r.low)}</td>
                        <td className="num">{r.widthPct.toFixed(2)}</td>
                        <td className={r.firstBreak ? (r.firstBreak.direction === 'up' ? 'text-up' : 'text-down') : 'text-muted'}>{r.firstBreak ? `${r.firstBreak.direction === 'up' ? '▲ Up' : '▼ Down'} ${formatSessionTime(r.firstBreak.ts)}` : 'No break'}</td>
                        <td><TrendBadge trend={r.trend} whipsaw={r.whipsaw} /></td>
                        <td className="num">{formatIndian(r.close)} <span className="text-2xs text-muted">({r.closeVsRange})</span></td>
                        <td className="num">{r.followThroughPct === null ? '—' : <Chg value={r.followThroughPct} pct />}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Loadable>
      </Card>
    </div>
  );
}
