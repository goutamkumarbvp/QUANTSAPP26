import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  algoById,
  type AlgoBacktestDay,
  type AlgoBacktestRange,
  type AlgoCatalog,
  type AlgoDaySummary,
  type AlgoEvent,
  type AlgoParamSpec,
  type AlgoPreset,
  type AlgoRunView,
  type AlgoSeriesPoint,
} from '@q26/core';
import { Chart, axis, baseOption, pnlVisualMap, timeAxis, useChartColors } from '../components/Chart';
import { DataTable } from '../components/DataTable';
import { SessionDate } from '../components/pickers';
import { Card, cx, Dash, ErrorBox, ErrorState, Field, Gaps, Loadable, NoData, PageHeader, Pill, Segmented, Select, Spinner, Stat, Toggle, Val } from '../components/ui';
import { api, qs } from '../lib/api';
import { formatDate, formatDateTime, formatExpiry, formatINR, formatIndian, formatSessionTime, isNum, pnlClass } from '../lib/format';
import { adaptivePoll, useLive } from '../lib/hooks';
import { useTicks } from '../lib/store';

type Params = Record<string, string | number | boolean>;
type Tab = 'live' | 'day' | 'range';

const EVENT_TONE: Record<AlgoEvent['kind'], 'accent' | 'warn' | 'down' | 'up' | 'muted'> = {
  ENTRY: 'accent',
  ADJUSTMENT: 'warn',
  STOP: 'down',
  EXIT: 'up',
  MANUAL_STOP: 'down',
  ERROR: 'down',
  INFO: 'muted',
};
const EVENT_LABEL: Record<AlgoEvent['kind'], string> = { ENTRY: 'Entry', ADJUSTMENT: 'Adjust', STOP: 'Stop', EXIT: 'Exit', MANUAL_STOP: 'Manual stop', ERROR: 'Error', INFO: 'Info' };
const EXIT_LABEL: Record<AlgoDaySummary['exitKind'], string> = { EXIT: 'Time exit', STOP: 'No OTM strike', ERROR: 'Order error', MANUAL_STOP: 'Stopped', NONE: '—' };

/** Rupees; a missing figure is "—" (never 0). */
const rupee = (x: number | null) => formatINR(x, 0);
const signed = (x: number | null) => (isNum(x) ? `${x > 0 ? '+' : ''}${formatINR(x, 0)}` : '—');
const toneOf = (x: number | null) => (isNum(x) ? (x > 0 ? 'up' : x < 0 ? 'down' : undefined) : undefined);

/* ----------------------------------- charts ----------------------------------- */

function DayCharts({ series, events, stepPct, height = 260 }: { series: AlgoSeriesPoint[]; events: AlgoEvent[]; stepPct: number; height?: number }) {
  const c = useChartColors();
  const pnl = useMemo(() => {
    if (!series.length) return {};
    const marks = events
      .filter((e) => e.kind !== 'INFO')
      .map((e) => {
        const pt = series.reduce((best, p) => (Math.abs(p.ts - e.ts) < Math.abs(best.ts - e.ts) ? p : best), series[0]);
        const color = { accent: c.accent, warn: c.warn, down: c.down, up: c.up, muted: c.muted }[EVENT_TONE[e.kind]];
        // The marker sits on the P&L line, so an event at a minute where the P&L is unknown has no marker.
        return pt.mtm === null ? null : { coord: [pt.ts, pt.mtm], value: EVENT_LABEL[e.kind][0], itemStyle: { color } };
      })
      .filter((m): m is NonNullable<typeof m> => m !== null);
    return {
      ...baseOption(c),
      legend: { ...(baseOption(c).legend as object), data: ['Day P&L', 'Spot'] },
      xAxis: timeAxis(c),
      yAxis: [
        { type: 'value', ...axis(c), axisLabel: { color: c.muted, fontSize: 11, formatter: (v: number) => formatIndian(v, 0) } },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, fontSize: 11, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      visualMap: pnlVisualMap(c, 0),
      series: [
        { name: 'Day P&L', type: 'line', showSymbol: false, data: series.map((p) => [p.ts, p.mtm]), areaStyle: { opacity: 0.12 }, markPoint: { symbol: 'pin', symbolSize: 30, label: { color: '#fff', fontSize: 10 }, data: marks } },
        { name: 'Spot', type: 'line', yAxisIndex: 1, showSymbol: false, data: series.map((p) => [p.ts, p.spot]), lineStyle: { width: 1, color: c.muted }, itemStyle: { color: c.muted } },
      ],
    };
  }, [series, events, c]);
  const prem = useMemo(() => {
    if (!series.length) return {};
    return {
      ...baseOption(c),
      xAxis: timeAxis(c),
      yAxis: { type: 'value', ...axis(c), axisLabel: { color: c.muted, fontSize: 11, formatter: (v: number) => `₹${v}` } },
      series: [
        { name: 'CE', type: 'line', showSymbol: false, connectNulls: false, data: series.map((p) => [p.ts, p.ce]), itemStyle: { color: c.up }, lineStyle: { color: c.up } },
        { name: 'PE', type: 'line', showSymbol: false, connectNulls: false, data: series.map((p) => [p.ts, p.pe]), itemStyle: { color: c.down }, lineStyle: { color: c.down } },
        { name: 'Level', type: 'line', step: 'end', showSymbol: false, data: series.map((p) => [p.ts, p.level || null]), lineStyle: { type: 'dashed', color: c.accent }, itemStyle: { color: c.accent } },
        { name: 'Next trigger', type: 'line', step: 'end', showSymbol: false, data: series.map((p) => [p.ts, p.level && (p.ce != null || p.pe != null) ? +(p.level * (1 + stepPct / 100)).toFixed(2) : null]), lineStyle: { type: 'dotted', color: c.warn }, itemStyle: { color: c.warn } },
      ],
    };
  }, [series, stepPct, c]);
  if (!series.length) return <NoData compact title="No data for this session yet" reason="Charts are drawn from real prices only: minutes without a recorded or live price are not drawn." />;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div>
        <div className="mb-1 text-xs font-medium text-muted">Day P&L (₹, before charges) and spot; a gap = no price for an open leg</div>
        <Chart option={pnl} height={height} />
      </div>
      <div>
        <div className="mb-1 text-xs font-medium text-muted">Sold-leg premiums vs ladder level</div>
        <Chart option={prem} height={height} />
      </div>
    </div>
  );
}

function EventLog({ events }: { events: AlgoEvent[] }) {
  if (!events.length) return <div className="py-6 text-center text-sm text-muted">No events yet.</div>;
  return (
    <div className="max-h-96 overflow-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>Time</th>
            <th>Event</th>
            <th>Details</th>
            <th>Orders</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e, i) => (
            <tr key={i} className={cx(e.kind === 'ERROR' && 'bg-down/5')}>
              <td className="whitespace-nowrap tabular-nums">{formatSessionTime(e.ts)}</td>
              <td><Pill tone={EVENT_TONE[e.kind]}>{EVENT_LABEL[e.kind]}</Pill></td>
              <td className={cx('min-w-[16rem] whitespace-normal text-xs', e.kind === 'ERROR' && 'text-down')}>{e.message}</td>
              <td className="whitespace-nowrap text-xs tabular-nums">
                {e.fills.map((f, j) => (
                  <div key={j} className={f.side === 'SELL' ? 'text-down' : 'text-up'}>
                    {f.side} {f.lots}× {f.strike} {f.type} @ {f.price.toFixed(2)}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* --------------------------------- params form --------------------------------- */

function ParamInput({ spec, value, onChange, symbols, symbolsWhy }: { spec: AlgoParamSpec; value: string | number | boolean | undefined; onChange: (v: string | number | boolean) => void; symbols: AlgoCatalog['symbols']; symbolsWhy?: string }) {
  if (spec.type === 'boolean') return <Toggle checked={Boolean(value)} onChange={onChange} label={spec.label} />;
  let input;
  if (spec.type === 'symbol') {
    input = symbols.length ? (
      <Select label={spec.label} className="w-full" value={String(value ?? '')} onChange={onChange} options={symbols.map((s) => ({ value: s.symbol, label: `${s.symbol} (lot ${s.lotSize})` }))} />
    ) : (
      <select aria-label={spec.label} className="input w-full" disabled value="" title={symbolsWhy ?? 'No underlyings are listed yet'}>
        <option value="">No underlyings</option>
      </select>
    );
  }
  else if (spec.type === 'select') input = <Select label={spec.label} className="w-full" value={String(value ?? spec.options?.[0]?.value ?? '')} onChange={onChange} options={spec.options ?? []} />;
  else if (spec.type === 'time') input = <input aria-label={spec.label} className="input" type="time" min="09:15" max="15:30" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
  else input = <input aria-label={spec.label} className="input" type="number" min={spec.min} max={spec.max} step={spec.step} value={value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
  return (
    <Field label={spec.label}>
      {input}
      {spec.type === 'symbol' && !symbols.length && symbolsWhy && <span className="mt-0.5 block text-2xs text-muted">{symbolsWhy}</span>}
      {spec.help && <span className="mt-0.5 block text-2xs text-muted">{spec.help}</span>}
    </Field>
  );
}

/* ---------------------------------- live runs ---------------------------------- */

function RunCard({ run, onChanged }: { run: AlgoRunView; onChanged: () => void }) {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const t = run.today;
  // Net today needs the day's MTM, which needs every open leg priced live; otherwise it is unknown (never 0).
  const net = t && isNum(t.mtm) ? t.mtm - t.charges : null;
  const rejected = (t?.events ?? []).filter((e) => e.kind === 'ERROR');
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const phaseTone = !t ? 'muted' : t.phase === 'active' ? 'up' : t.phase === 'waiting' ? 'accent' : t.phase === 'stopped' ? 'down' : 'muted';
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          <button className="text-left font-semibold hover:text-accent" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? '▾' : '▸'} {run.name}
          </button>
          <Pill tone={run.status === 'running' ? 'up' : 'muted'}>{run.status === 'running' ? '● Running' : 'Stopped'}</Pill>
          {t && <Pill tone={phaseTone}>{t.phase}</Pill>}
        </span>
      }
      actions={
        <>
          <span className={cx('text-sm font-semibold tabular-nums', pnlClass(net))} title={net === null ? run.gaps?.today ?? 'No live price for an open leg' : 'Today, after charges'}>{signed(net)}</span>
          {run.status === 'running' ? (
            <button className="btn-sell px-2 py-1 text-xs" disabled={busy} onClick={() => confirm(`Stop "${run.name}" and square off its open positions?`) && act(() => api(`/algo-runs/${run.id}/stop`, { method: 'POST', body: {} }))}>
              Stop & square off
            </button>
          ) : (
            <button className="btn-ghost px-2 py-1 text-xs" disabled={busy} onClick={() => act(() => api(`/algo-runs/${run.id}`, { method: 'DELETE' }))}>
              Delete
            </button>
          )}
        </>
      }
    >
      {error != null && <ErrorState error={error} compact />}
      {run.error && <ErrorBox error={run.error} />}
      {run.status === 'running' && run.gaps?.liveData && (
        <div className="mb-2 rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn" role="status">Waiting for live data: {run.gaps.liveData}</div>
      )}
      <div className="text-xs text-muted">
        {String(run.params.symbol)} · {String(run.params.lots)} lot(s)/leg · start ₹{String(run.params.startPremium)} · step {String(run.params.stepPct)}% · strikes ×{String(run.params.strikeMultiple)} · {String(run.params.entryTime)}–{String(run.params.exitTime)} · deployed {formatDateTime(run.createdAt)}
      </div>
      {open && (
        <div className="mt-3 space-y-3">
          {t ? (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-6">
                <Stat label="Session" value={formatDate(t.date)} sub={`Expiry ${formatExpiry(t.expiry)}`} />
                <Stat label="Realised" value={rupee(t.realized)} tone={toneOf(t.realized)} />
                <Stat label="Unrealised" value={isNum(t.unrealized) ? rupee(t.unrealized) : null} reason={run.gaps?.today ?? 'An open leg has no live price'} tone={toneOf(t.unrealized)} />
                <Stat label="Charges" value={rupee(t.charges)} tone="warn" />
                <Stat label="Net today" value={net === null ? null : signed(net)} reason={run.gaps?.today ?? 'An open leg has no live price'} tone={toneOf(net)} />
                <Stat label="All days (net)" value={isNum(run.totalNet) ? signed(run.totalNet) : null} reason={run.gaps?.totalNet ?? 'A finished day\'s result is not known yet'} tone={toneOf(run.totalNet)} sub={`${run.history.length} finished day(s)`} />
              </div>
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                <div className="space-y-1 rounded-lg border border-line p-3 text-sm">
                  {t.status.map((s) => (
                    <div key={s.label} className="flex justify-between gap-3">
                      <span className="text-muted">{s.label}</span>
                      <span className="text-right font-medium">{s.value}</span>
                    </div>
                  ))}
                </div>
                <div className="overflow-x-auto">
                  <table className="tbl">
                    <thead>
                      <tr><th>Open leg</th><th className="num">Lots</th><th className="num">Sold at</th><th className="num">LTP</th><th className="num">P&L</th></tr>
                    </thead>
                    <tbody>
                      {t.legs.length ? (
                        t.legs.map((l) => (
                          <tr key={`${l.type}${l.strike}`}>
                            <td className={l.side === 'SELL' ? 'text-down' : 'text-up'}>{l.side} {l.strike} {l.type}</td>
                            <td className="num">{l.lots}</td>
                            <td className="num">{l.entryPrice.toFixed(2)}</td>
                            <td className="num"><Val value={l.ltp} format={(x) => x.toFixed(2)} reason="Not traded in the live session" /></td>
                            <td className={cx('num', pnlClass(l.pnl))}><Val value={l.pnl} format={rupee} reason="Needs the leg's live price" /></td>
                          </tr>
                        ))
                      ) : (
                        <tr><td colSpan={5} className="text-center text-muted">No open legs</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
              <Gaps gaps={run.gaps} omit={['liveData']} />
              {rejected.length > 0 && (
                <div className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-xs text-down" role="status">
                  {rejected.length} order{rejected.length > 1 ? 's' : ''} rejected or failed today (never counted as filled), last: {rejected[rejected.length - 1].message}
                </div>
              )}
              <DayCharts series={t.series} events={t.events} stepPct={Number(run.params.stepPct ?? 50)} height={220} />
              <div>
                <div className="mb-1 text-xs font-medium text-muted">Today's events</div>
                <EventLog events={t.events} />
              </div>
            </>
          ) : (
            <div className="py-6 text-center text-sm text-muted">Waiting for the market to open.</div>
          )}
          {run.history.length > 0 && (
            <div>
              <div className="mb-1 text-xs font-medium text-muted">Finished days</div>
              <DaysTable days={run.history} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function DaysTable({ days, onPick }: { days: AlgoDaySummary[]; onPick?: (d: AlgoDaySummary) => void }) {
  return (
    <DataTable
      rows={days}
      rowKey={(d) => d.date}
      maxHeight="420px"
      onRowClick={onPick}
      initialSort={{ key: 'date', dir: 'desc' }}
      columns={[
        { key: 'date', label: 'Date', value: (d) => d.date },
        { key: 'expiry', label: 'Expiry', value: (d) => d.expiry, render: (d) => formatExpiry(d.expiry), hideSm: true },
        { key: 'adj', label: 'Adj.', num: true, value: (d) => d.adjustments },
        { key: 'lvl', label: 'Max level', num: true, value: (d) => d.maxLevel, render: (d) => (d.maxLevel ? `₹${+d.maxLevel.toFixed(2)}` : '—'), hideSm: true },
        { key: 'exit', label: 'Exit', value: (d) => d.exitKind, render: (d) => <span title={d.exitReason}>{d.entered ? EXIT_LABEL[d.exitKind] : 'No trade'}{d.incomplete && <> <Pill tone="warn">incomplete</Pill></>}</span> },
        { key: 'low', label: 'Worst', num: true, value: (d) => d.maxLoss, render: (d) => <span className={pnlClass(d.maxLoss)}>{rupee(d.maxLoss)}</span>, hideSm: true },
        { key: 'chg', label: 'Charges', num: true, value: (d) => d.charges, render: (d) => rupee(d.charges), hideSm: true },
        { key: 'net', label: 'Net P&L', num: true, value: (d) => d.net, render: (d) => <span className={cx('font-medium', pnlClass(d.net))}>{isNum(d.net) ? signed(d.net) : <Dash reason={d.incomplete ?? 'The result of this day is not known'} />}</span> },
      ]}
    />
  );
}

/* ----------------------------------- backtests ----------------------------------- */

/** Data a backtest replays: recorded one-minute bars or one-second snapshots. */
type Resolution = '1m' | '1s';

const RESOLUTION_NOTE: Record<Resolution, string> = {
  '1m': 'A minute-by-minute replay of what the recorder saw, filling at the recorded last traded price of the minute. A minute without a recorded price is not replayed.',
  '1s': 'A second-by-second replay of the one-second snapshots: a buy fills at the recorded ask and a sell at the recorded bid (a book at most 10 s old, else the last traded price). Seconds the recorder did not cover are not replayed.',
};

function DayBacktest({ algoId, params, date, setDate, resolution }: { algoId: string; params: Params; date: string; setDate: (d: string) => void; resolution: Resolution }) {
  const today = useTicks((s) => s.clock?.date);
  const key = JSON.stringify(params);
  const q = useQuery({
    queryKey: ['algo-bt-day', algoId, key, date, resolution],
    queryFn: () => api<AlgoBacktestDay>(`/algos/${algoId}/backtest`, { body: { params, date: date || undefined, resolution } }),
    refetchInterval: adaptivePoll(date ? false : 15_000),
    retry: false,
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SessionDate value={date} onChange={setDate} max={today} />
        <span className="text-xs text-muted">Recorded sessions only. {RESOLUTION_NOTE[resolution]}</span>
      </div>
      <Loadable q={q} hint="Backtests replay only the sessions the app recorded (it records while it runs): pick a date the recorder was running.">
        {(d) => (
          <>
            {d.incomplete && <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn" role="status">This day is not final: {d.incomplete}</div>}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 2xl:grid-cols-8">
              <Stat label="Session" value={formatDate(d.date)} sub={d.partial ? 'in progress' : `Expiry ${formatExpiry(d.expiry)}`} />
              <Stat label="Net P&L" value={isNum(d.net) ? signed(d.net) : null} reason={d.incomplete ?? 'The result of this day is not known'} tone={toneOf(d.net)} sub={`Gross ${rupee(d.pnl)}`} />
              <Stat label="Charges" value={rupee(d.charges)} tone="warn" sub={`${d.orders} orders`} />
              <Stat label="Adjustments" value={d.adjustments} />
              <Stat label="Max level" value={d.maxLevel ? `₹${+d.maxLevel.toFixed(2)}` : '—'} />
              <Stat label="Best intraday" value={rupee(d.maxProfit)} tone="up" />
              <Stat label="Worst intraday" value={rupee(d.maxLoss)} tone="down" />
              <Stat label="Exit" value={d.entered ? EXIT_LABEL[d.exitKind] : 'No trade'} hint={d.exitReason} sub={d.exitTs ? formatSessionTime(d.exitTs) : undefined} />
            </div>
            {d.exitReason && <div className="rounded-lg border border-line bg-panel2/60 px-3 py-2 text-xs">{d.exitReason}</div>}
            <DayCharts series={d.series} events={d.events} stepPct={Number(params.stepPct ?? 50)} />
            <Card title="Trade log" pad={false}>
              <EventLog events={d.events} />
            </Card>
          </>
        )}
      </Loadable>
    </div>
  );
}

function RangeBacktest({ algoId, params, onPickDay, resolution }: { algoId: string; params: Params; onPickDay: (date: string) => void; resolution: Resolution }) {
  const [days, setDays] = useState(60);
  const c = useChartColors();
  const key = JSON.stringify(params);
  const q = useQuery({
    queryKey: ['algo-bt-range', algoId, key, days, resolution],
    queryFn: () => api<AlgoBacktestRange>(`/algos/${algoId}/backtest-range`, { body: { params, days, resolution } }),
    staleTime: 60_000,
    retry: false,
  });
  const option = useMemo(() => {
    const r = q.data;
    if (!r?.equity.length) return {};
    return {
      ...baseOption(c),
      xAxis: { type: 'category', data: r.equity.map((x) => x.date.slice(5)), ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, fontSize: 11, hideOverlap: true } },
      yAxis: [
        { type: 'value', ...axis(c), axisLabel: { color: c.muted, fontSize: 11, formatter: (v: number) => formatIndian(v, 0) } },
        { type: 'value', ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, fontSize: 11, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      series: [
        { name: 'Day net', type: 'bar', data: r.equity.map((x) => ({ value: x.net, itemStyle: { color: x.net >= 0 ? c.up : c.down } })) },
        { name: 'Cumulative', type: 'line', yAxisIndex: 1, showSymbol: false, data: r.equity.map((x) => x.cum), lineStyle: { color: c.accent, width: 2 }, itemStyle: { color: c.accent } },
      ],
    };
  }, [q.data, c]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={days} onChange={setDays} options={[{ value: 20, label: '20 days' }, { value: 60, label: '60 days' }, { value: 120, label: '120 days' }, { value: 250, label: '1 year' }]} />
        <span className="text-xs text-muted">Recorded sessions only, each replayed independently with the settings above. Days that cannot be replayed are listed with the reason. Click a day to open it.</span>
      </div>
      {q.isFetching && !q.data ? (
        <Spinner label="Running backtest…" />
      ) : (
        <Loadable q={q} hint="Backtests replay only the sessions the app recorded (it records while it runs).">
          {(r) => {
            const none = 'No traded day among the replayed ones';
            return (
              <>
                <div className="rounded-lg border border-line bg-panel2/60 px-3 py-2 text-xs" role="note">
                  Recorded sessions only{r.recordedFrom ? <> — the app has recorded since <b>{formatDate(r.recordedFrom, true)}</b></> : null}.{' '}
                  {r.stats.days} complete day{r.stats.days === 1 ? '' : 's'} replayed
                  {r.stats.incompleteDays > 0 ? `, ${r.stats.incompleteDays} incomplete (left out of the statistics)` : ''}
                  {r.stats.skippedDays > 0 ? `, ${r.stats.skippedDays} not replayed (listed below)` : ''}.
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 2xl:grid-cols-8">
                  <Stat label="Period" value={`${r.stats.days} days`} sub={r.from ? `${formatDate(r.from)} → ${formatDate(r.to)}` : undefined} />
                  <Stat label="Total net" value={signed(r.stats.totalNet)} tone={toneOf(r.stats.totalNet)} sub={`charges ${rupee(r.stats.totalCharges)}`} />
                  <Stat label="Win rate" value={isNum(r.stats.winRate) ? `${r.stats.winRate}%` : null} reason={none} sub={`${r.stats.winDays}W · ${r.stats.lossDays}L · ${r.stats.tradedDays} traded`} />
                  <Stat label="Avg / day" value={isNum(r.stats.avgNet) ? signed(r.stats.avgNet) : null} reason={none} tone={toneOf(r.stats.avgNet)} />
                  <Stat label="Best day" value={isNum(r.stats.bestDay) ? signed(r.stats.bestDay) : null} reason={none} tone="up" />
                  <Stat label="Worst day" value={isNum(r.stats.worstDay) ? signed(r.stats.worstDay) : null} reason={none} tone="down" />
                  <Stat label="Max drawdown" value={rupee(r.stats.maxDrawdown)} tone="down" />
                  <Stat label="Adjustments" value={isNum(r.stats.avgAdjustments) ? `${r.stats.avgAdjustments} avg` : null} reason={none} sub={`max ${isNum(r.stats.maxAdjustments) ? r.stats.maxAdjustments : '—'} · ${r.stats.stoppedDays} stop days`} />
                </div>
                <Card title="Daily net P&L and equity curve">
                  <Chart option={option} height={280} blank={r.equity.length ? undefined : 'No complete replayed day: the curve is drawn from replayed days only.'} />
                </Card>
                <Card title="Day by day" pad={false}>
                  {r.days.length ? <DaysTable days={r.days} onPick={(d) => onPickDay(d.date)} /> : <div className="py-6 text-center text-sm text-muted">No day could be replayed.</div>}
                </Card>
                {r.skipped.length > 0 && (
                  <Card title={`Not replayed (${r.skipped.length})`} pad={false}>
                    <div className="max-h-64 overflow-auto">
                      <table className="tbl">
                        <thead><tr><th>Date</th><th>Why</th></tr></thead>
                        <tbody>
                          {r.skipped.map((d) => (
                            <tr key={d.date}>
                              <td className="whitespace-nowrap tabular-nums">{formatDate(d.date, true)}</td>
                              <td className="whitespace-normal text-xs text-muted">{d.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                )}
              </>
            );
          }}
        </Loadable>
      )}
    </div>
  );
}

/* ------------------------------------- page ------------------------------------- */

export default function Algo() {
  const qc = useQueryClient();
  const catalog = useQuery({ queryKey: ['algos'], queryFn: () => api<AlgoCatalog>('/algos'), staleTime: 300_000 });
  const runs = useLive<AlgoRunView[]>(['algo-runs'], '/algo-runs', 3000);
  const [presetId, setPresetId] = useState<string>('');
  const [params, setParams] = useState<Params>({});
  const [applied, setApplied] = useState<Params>({});
  const [tab, setTab] = useState<Tab>('live');
  const [btDate, setBtDate] = useState('');
  const [resolution, setResolution] = useState<Resolution>('1m');
  const [name, setName] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const presets = catalog.data?.presets ?? [];
  const preset: AlgoPreset | undefined = presets.find((p) => p.id === presetId) ?? presets[0];
  const algo = catalog.data?.algos.find((a) => a.id === preset?.algoId);

  useEffect(() => {
    if (preset && !presetId) {
      setPresetId(preset.id);
      setParams(preset.params as Params);
      setApplied(preset.params as Params);
    }
  }, [preset, presetId]);

  const pick = (p: AlgoPreset) => {
    setPresetId(p.id);
    setParams(p.params as Params);
    setApplied(p.params as Params);
  };
  const setParam = async (key: string, v: string | number | boolean) => {
    if (key === 'symbol' && algo) {
      // Re-default the instrument-specific settings (strike multiple) for the new underlying.
      try {
        const d = await api<Params>(`/algos/${algo.id}/defaults${qs({ symbol: String(v) })}`);
        setParams((p) => ({ ...p, symbol: String(v), strikeMultiple: d.strikeMultiple }));
        return;
      } catch {
        /* fall through */
      }
    }
    setParams((p) => ({ ...p, [key]: v }));
  };
  const dirty = JSON.stringify(params) !== JSON.stringify(applied);
  const running = (runs.data ?? []).filter((r) => r.status === 'running').length;

  const deploy = async () => {
    if (!algo) return;
    setDeploying(true);
    setError(null);
    try {
      await api(`/algo-runs`, { body: { algoId: algo.id, presetId: preset?.id, name: name || undefined, params } });
      setApplied(params);
      setTab('live');
      await qc.invalidateQueries({ queryKey: ['algo-runs'] });
    } catch (e) {
      setError(e);
    } finally {
      setDeploying(false);
    }
  };

  return (
    <div className="space-y-3">
      <PageHeader title="Algo Strategies" subtitle="Rule-based strategies that trade your paper account automatically. Backtest them on recorded sessions, then deploy. New algos appear here as they are added.">
        <Pill tone={running ? 'up' : 'muted'}>{running} running</Pill>
      </PageHeader>

      <Loadable q={catalog}>
        {(cat) => (
          <div className="grid gap-3 xl:grid-cols-[22rem_minmax(0,1fr)]">
            <div className="space-y-3">
              <Card title="Algo library">
                <div className="space-y-2">
                  {cat.presets.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => pick(p)}
                      className={cx('w-full rounded-lg border px-3 py-2 text-left transition-colors', p.id === preset?.id ? 'border-accent bg-accent/10' : 'border-line hover:border-accent/60')}
                    >
                      <div className="text-sm font-semibold">{p.name}</div>
                      <div className="mt-0.5 text-2xs text-muted">{p.summary}</div>
                    </button>
                  ))}
                  <div className="rounded-lg border border-dashed border-line px-3 py-2 text-2xs text-muted">More algos will be added to this library.</div>
                </div>
              </Card>
              {algo && (
                <Card title="Rules">
                  <ol className="list-decimal space-y-1.5 pl-4 text-xs">
                    {(algoById(algo.id)?.describeRules?.(params) ?? algo.rules).map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ol>
                </Card>
              )}
            </div>

            <div className="min-w-0 space-y-3">
              {algo && (
                <Card title={`${preset?.name ?? algo.name} · settings`} actions={dirty ? <Pill tone="warn">changed — re-run backtest</Pill> : undefined}>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                    {algo.params
                      .filter((s) => s.type !== 'boolean')
                      .map((s) => (
                        <ParamInput key={s.key} spec={s} value={params[s.key]} onChange={(v) => setParam(s.key, v)} symbols={cat.symbols} symbolsWhy={cat.gaps?.symbols} />
                      ))}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    {algo.params
                      .filter((s) => s.type === 'boolean')
                      .map((s) => (
                        <ParamInput key={s.key} spec={s} value={params[s.key]} onChange={(v) => setParam(s.key, v)} symbols={cat.symbols} symbolsWhy={cat.gaps?.symbols} />
                      ))}
                  </div>
                  <div className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3">
                    <Field label="Run name (optional)" className="w-56">
                      <input className="input" value={name} maxLength={60} placeholder={preset?.name} onChange={(e) => setName(e.target.value)} />
                    </Field>
                    <button className="btn-ghost" onClick={() => setApplied(params)} disabled={!dirty}>
                      Apply to backtests
                    </button>
                    <button className="btn-primary" disabled={deploying} onClick={deploy}>
                      {deploying ? 'Deploying…' : 'Deploy on paper account'}
                    </button>
                  </div>
                  {error != null && <div className="mt-2"><ErrorState error={error} compact title="Not deployed" /></div>}
                  <p className="mt-2 text-2xs text-muted">
                    Deployed algos place MARKET orders (MIS, tagged <code>algo:&lt;id&gt;</code>) through the paper broker every couple of seconds, run every trading day until stopped, and show up in Positions & Orders. Orders fill only at the live bid / ask: an order the broker rejects is logged on the run and never counted as filled, and a run with no live price waits instead of guessing one. Don't exit an algo's positions by hand — use Stop. Paper trading only; not investment advice.
                  </p>
                </Card>
              )}

              <Segmented
                value={tab}
                onChange={setTab}
                options={[
                  { value: 'live', label: `Deployed (${runs.data?.length ?? 0})` },
                  { value: 'day', label: 'Backtest · one day' },
                  { value: 'range', label: 'Backtest · many days' },
                ]}
              />

              {tab === 'live' && (
                <Loadable q={runs}>
                  {(list) =>
                    list.length ? (
                      <div className="space-y-3">
                        {list.map((r) => (
                          <RunCard key={r.id} run={r} onChanged={() => qc.invalidateQueries({ queryKey: ['algo-runs'] })} />
                        ))}
                      </div>
                    ) : (
                      <Card>
                        <div className="py-10 text-center text-sm text-muted">No algo deployed yet. Choose a strategy, check its backtest and press “Deploy on paper account”.</div>
                      </Card>
                    )
                  }
                </Loadable>
              )}
              {(tab === 'day' || tab === 'range') && (
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="text-muted">Data</span>
                  <Segmented size="xs" value={resolution} onChange={setResolution} options={[{ value: '1m', label: '1 minute' }, { value: '1s', label: '1 second (bid/ask fills)' }]} />
                </div>
              )}
              {tab === 'day' && algo && <DayBacktest algoId={algo.id} params={applied} date={btDate} setDate={setBtDate} resolution={resolution} />}
              {tab === 'range' && algo && (
                <RangeBacktest
                  algoId={algo.id}
                  params={applied}
                  resolution={resolution}
                  onPickDay={(d) => {
                    setBtDate(d);
                    setTab('day');
                  }}
                />
              )}
            </div>
          </div>
        )}
      </Loadable>
    </div>
  );
}
