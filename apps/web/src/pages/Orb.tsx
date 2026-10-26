import { useMemo, useState } from 'react';
import type { MinuteBar, OrbHistoryResponse, OrbResponse, OrbScanRow, OrbTrend } from '@q26/core';
import { Chart, axis, baseOption, useChartColors } from '../components/Chart';
import { DataTable } from '../components/DataTable';
import { SessionDate, SymbolSelect } from '../components/pickers';
import { TrendBadge } from '../components/trend';
import { Card, Chg, Coverage, cx, Dash, Gaps, Loadable, PageHeader, Segmented, Stat, Val } from '../components/ui';
import { qs } from '../lib/api';
import { DASH, formatDate, formatFixed, formatIndian, formatPct, formatSessionTime, isNum } from '../lib/format';
import { useLive, useMeta } from '../lib/hooks';
import { useApp, useTicks } from '../lib/store';

type Filter = 'all' | OrbTrend | 'whipsaw';

const MIN = 60_000;

/** Decimals for a price: whole rupees for index-sized prices, paise for low-priced stocks. */
const dec = (v: number | null) => (v !== null && Math.abs(v) >= 1000 ? 0 : 2);
const price = (v: number | null | undefined) => formatIndian(v ?? null, dec(v ?? null));

/**
 * n-minute candles aligned to the session open, built from the traded minutes that exist: a bucket takes
 * only the minutes that really traded in it, and a bucket with none has no candle (it is not filled).
 */
function aggregate(bars: MinuteBar[], n: number, startTs: number): Map<number, MinuteBar> {
  const w = n * MIN;
  const out = new Map<number, MinuteBar>();
  for (const b of bars) {
    const key = startTs + Math.floor((b.ts - startTs) / w) * w;
    const cur = out.get(key);
    if (!cur) out.set(key, { ts: key, open: b.open, high: b.high, low: b.low, close: b.close });
    else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
    }
  }
  return out;
}

export default function Orb() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const today = useTicks((s) => s.clock?.date);
  const meta = useMeta();
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
    const w = tf * MIN;
    const byBucket = aggregate(d.bars, tf, d.rangeStartTs);
    const lastKey = Math.max(...byBucket.keys());
    // One slot per bucket from the open to the last traded one; a slot with no trade stays empty.
    const slots: number[] = [];
    for (let t = d.rangeStartTs; t <= lastKey; t += w) slots.push(t);
    const cats = slots.map((t) => formatSessionTime(t));
    const label = (ts: number) => formatSessionTime(ts - ((ts - d.rangeStartTs) % w));
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
        // Opening-range band: full-width background behind every slot that starts inside the range.
        {
          name: 'range',
          type: 'bar',
          yAxisIndex: 1,
          silent: true,
          barWidth: '100%',
          barGap: '-100%',
          itemStyle: { color: c.warn, opacity: 0.1 },
          tooltip: { show: false },
          data: slots.map((t) => (t < d.rangeEndTs ? 1 : 0)),
          z: 0,
        },
        {
          name: d.symbol,
          type: 'candlestick',
          data: slots.map((t) => {
            const b = byBucket.get(t);
            return b ? [b.open, b.close, b.low, b.high] : '-';
          }),
          itemStyle: { color: c.up, color0: c.down, borderColor: c.up, borderColor0: c.down },
          markLine: Number.isFinite(e.high) && Number.isFinite(e.low)
            ? {
                symbol: 'none',
                silent: true,
                label: { color: c.ink, fontSize: 10, formatter: '{b}', position: 'insideEndTop' },
                data: [
                  { name: `${d.rangeMinutes}-min range high ${price(e.high)}`, yAxis: e.high, lineStyle: { color: c.up, type: 'dashed', width: 1.5 } },
                  { name: `${d.rangeMinutes}-min range low ${price(e.low)}`, yAxis: e.low, lineStyle: { color: c.down, type: 'dashed', width: 1.5 } },
                ],
              }
            : undefined,
          markPoint: {
            symbolSize: 34,
            label: { fontSize: 10, color: '#fff', formatter: (p: { data: { dir: string } }) => (p.data.dir === 'up' ? '▲' : '▼') },
            data: e.crossings.map((b) => ({
              dir: b.direction,
              coord: [label(b.ts), b.price],
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

  const universe = meta.data?.symbols.length;
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

      <Loadable q={q} hint="The opening range is built from the 1-minute bars this app recorded from the open — 09:15 (MCX 09:00) — (or Kotak 1-minute history for the last sessions); nothing is guessed when they are missing.">
        {(d) => {
          const e = d.evaluation;
          const first = e.breaks[0];
          // Minutes of the range that really traded (a minute without a trade has no bar).
          const traded = d.bars.filter((b) => b.ts < d.rangeEndTs).length;
          // Price vs range and the % distances are taken at the price the server names (priceSource).
          const ref = d.priceSource === 'ltp' ? 'LTP' : `last recorded 1-min close at ${formatSessionTime(d.priceTs)}`;
          const dayWhy = d.gaps?.day ?? 'Not available';
          return (
            <>
              <Card>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs text-muted">{d.symbol} · {formatDate(d.date, true)} · {d.live ? 'live session' : 'completed session'} · {d.source === 'recorded' ? 'recorded 1-minute bars' : 'Kotak 1-minute history'}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <TrendBadge trend={e.trend} whipsaw={e.whipsaw} reentered={e.reentered} pending={e.pending} large />
                      <span className={cx('chip', e.complete ? 'bg-line text-muted' : 'bg-warn/15 text-warn')} title="Minutes of the range that traded: a minute without a trade has no bar">
                        {e.complete ? `Range complete · ${traded} of ${d.rangeMinutes} minutes traded` : `Range forming · ${traded} of ${d.rangeMinutes} minutes so far`}
                      </span>
                    </div>
                    <div className={cx('mt-1 text-sm font-medium', e.trend === 'up' ? 'text-up' : e.trend === 'down' ? 'text-down' : 'text-muted')}>{d.summary}</div>
                  </div>
                  <div className="text-right">
                    <div className="text-2xs text-muted">{d.priceSource === 'ltp' ? 'LTP' : isNum(d.ltp) ? `Last recorded 1-min close at ${formatSessionTime(d.priceTs)}` : 'Close'}</div>
                    <div className="text-2xl font-bold tabular-nums"><Val value={d.ltp} format={(x) => formatIndian(x, dec(x))} reason={dayWhy} /></div>
                    <Chg value={d.changePct} pct reason={isNum(d.ltp) ? 'Needs the previous session’s close' : dayWhy} />
                  </div>
                </div>
              </Card>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                <Stat
                  label={`Range high (${formatSessionTime(d.rangeStartTs)}–${formatSessionTime(d.rangeEndTs)})`}
                  value={isNum(e.high) ? price(e.high) : null}
                  reason="No trade in the range yet"
                  tone="up"
                  sub={e.complete && isNum(e.toHighPct) ? `${formatPct(e.toHighPct)} from ${ref}` : 'so far'}
                />
                <Stat label="Range low" value={isNum(e.low) ? price(e.low) : null} reason="No trade in the range yet" tone="down" sub={e.complete && isNum(e.toLowPct) ? `${formatPct(e.toLowPct)} from ${ref}` : 'so far'} />
                <Stat label="Range width" value={isNum(e.width) ? `${formatIndian(e.width)} pts` : null} reason="No trade in the range yet" sub={isNum(e.widthPct) ? `${formatFixed(e.widthPct, 2)}%` : undefined} />
                <Stat
                  label="Price vs range"
                  value={!e.complete ? null : e.position === 'above' ? 'Above high' : e.position === 'below' ? 'Below low' : 'Inside'}
                  reason="The opening range is still forming"
                  tone={e.position === 'above' ? 'up' : e.position === 'below' ? 'down' : undefined}
                  sub={e.complete ? `${price(e.last)} (${ref})` : undefined}
                />
                <Stat
                  label="First break"
                  value={first ? `${first.direction === 'up' ? '▲ Up' : '▼ Down'} ${formatSessionTime(first.ts)}` : e.complete ? 'None yet' : null}
                  reason="The opening range is still forming"
                  sub={first ? `at ${price(first.price)}` : undefined}
                  tone={first ? (first.direction === 'up' ? 'up' : 'down') : undefined}
                />
                <Stat
                  label="Day high / low"
                  value={isNum(d.dayHigh) && isNum(d.dayLow) ? `${price(d.dayHigh)} / ${price(d.dayLow)}` : null}
                  reason={dayWhy}
                  sub={`${e.crossings.length} range exits`}
                />
              </div>
              <Card title={`${d.symbol} candles with opening range`} actions={<Segmented size="xs" value={tf} onChange={setTf} options={[{ value: 1, label: '1m' }, { value: 3, label: '3m' }, { value: 5, label: '5m' }, { value: 15, label: '15m' }]} />}>
                <Chart option={option} height={420} blank={d.bars.length ? undefined : 'No traded minute is recorded for this session'} />
                <div className="mt-2 space-y-1">
                  <Coverage text={`${d.bars.length} traded 1-minute bars${d.live ? ' (the last one may still be forming)' : ''}; a minute without a trade is an empty slot, not a candle.`} />
                  <Gaps gaps={d.gaps} />
                </div>
              </Card>
            </>
          );
        }}
      </Loadable>

      <Card
        title="All F&O — opening range status (current session)"
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
        <Loadable q={scan} hint="Only underlyings with recorded 1-minute bars covering the opening range are listed.">
          {(all) => (
            <>
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
                  { key: 'chg', label: '% Chg', num: true, value: (r) => r.changePct, render: (r) => <Chg value={r.changePct} pct reason="Needs the previous close" />, hideSm: true },
                  { key: 'high', label: 'Range high', num: true, value: (r) => r.high, render: (r) => formatIndian(r.high), hideSm: true },
                  { key: 'low', label: 'Range low', num: true, value: (r) => r.low, render: (r) => formatIndian(r.low), hideSm: true },
                  { key: 'width', label: 'Width %', num: true, value: (r) => r.widthPct, render: (r) => formatFixed(r.widthPct, 2), hideSm: true },
                  { key: 'trend', label: 'Status', value: (r) => r.trend, render: (r) => <TrendBadge trend={r.trend} whipsaw={r.whipsaw} reentered={r.reentered} pending={r.pending} /> },
                  { key: 'break', label: 'Last break', num: true, value: (r) => r.breakTs, render: (r) => (r.breakTs === null ? <Dash reason="No confirmed break yet" /> : formatSessionTime(r.breakTs)) },
                  { key: 'beyond', label: 'Beyond level', num: true, value: (r) => r.beyondPct, render: (r) => <Chg value={r.beyondPct} pct reason="No confirmed break yet" /> },
                ]}
              />
              <div className="border-t border-line px-3 py-2">
                <Coverage text={`${all.length}${universe ? ` of ${universe}` : ''} underlyings have recorded 1-minute bars covering the opening range; the others are left out.`} />
              </div>
            </>
          )}
        </Loadable>
      </Card>

      <Card title={`${symbol} — opening range record (recorded sessions among the last 20)`} pad={false}>
        <Loadable q={hist} hint="Sessions need recorded (or Kotak) 1-minute bars covering the whole day.">
          {(h) => (
            <>
              <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-5">
                <Stat label="Broke up first" value={`${h.stats.brokeUp}/${h.stats.days}`} tone="up" />
                <Stat label="Broke down first" value={`${h.stats.brokeDown}/${h.stats.days}`} tone="down" />
                <Stat label="Stayed inside" value={`${h.stats.sideways}/${h.stats.days}`} />
                <Stat label="Whipsaw days" value={`${h.stats.whipsaw}/${h.stats.days}`} tone="warn" />
                <Stat
                  label="Trend days"
                  value={`${h.stats.trendDays}/${h.stats.days}`}
                  sub={`Avg follow-through ${isNum(h.stats.avgFollowThroughPct) ? `${formatFixed(h.stats.avgFollowThroughPct, 2)}%` : DASH}`}
                  hint={isNum(h.stats.avgFollowThroughPct) ? 'Closed beyond the range on the side it first broke' : 'No day broke the range, so there is no follow-through to average'}
                />
              </div>
              <div className="space-y-1 px-3 pb-2">
                <Coverage text={`${h.rows.length} of ${h.sessions} sessions are covered (recorded 1-minute bars, or Kotak 1-minute history, over the whole day).`} />
                <Gaps gaps={h.gaps} />
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
                        <td>{r.date} <span className="text-2xs text-muted" title={r.source === 'recorded' ? 'Recorded by this app' : 'Kotak 1-minute history'}>{r.source === 'recorded' ? '' : 'kotak'}</span></td>
                        <td className="num">{formatIndian(r.high)}</td>
                        <td className="num">{formatIndian(r.low)}</td>
                        <td className="num">{formatFixed(r.widthPct, 2)}</td>
                        <td className={r.firstBreak ? (r.firstBreak.direction === 'up' ? 'text-up' : 'text-down') : 'text-muted'}>{r.firstBreak ? `${r.firstBreak.direction === 'up' ? '▲ Up' : '▼ Down'} ${formatSessionTime(r.firstBreak.ts)}` : 'No break'}</td>
                        <td><TrendBadge trend={r.trend} whipsaw={r.whipsaw} /></td>
                        <td className="num">{formatIndian(r.close)} <span className="text-2xs text-muted">({r.closeVsRange})</span></td>
                        <td className="num">{r.followThroughPct === null ? <Dash reason="The range was not broken" /> : <Chg value={r.followThroughPct} pct />}</td>
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
