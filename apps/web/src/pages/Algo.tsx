import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatDate,
  formatExpiry,
  formatINR,
  formatIndian,
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
import { Card, cx, Empty, ErrorBox, Field, Loadable, PageHeader, Pill, Segmented, Select, Spinner, Stat, Toggle } from '../components/ui';
import { api, qs } from '../lib/api';
import { formatDateTime, formatSessionTime, pnlClass } from '../lib/format';
import { useLive } from '../lib/hooks';
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

const rupee = (x: number) => formatINR(x, 0);
const signed = (x: number) => `${x > 0 ? '+' : ''}${formatINR(x, 0)}`;

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
        return { coord: [pt.ts, pt.mtm], value: EVENT_LABEL[e.kind][0], itemStyle: { color } };
      });
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
  if (!series.length) return <Empty>No data yet for this session.</Empty>;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <div>
        <div className="mb-1 text-xs font-medium text-muted">Day P&L (₹, before charges) and spot</div>
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
  if (!events.length) return <Empty>No events yet.</Empty>;
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
            <tr key={i}>
              <td className="whitespace-nowrap tabular-nums">{formatSessionTime(e.ts)}</td>
              <td><Pill tone={EVENT_TONE[e.kind]}>{EVENT_LABEL[e.kind]}</Pill></td>
              <td className="min-w-[16rem] whitespace-normal text-xs">{e.message}</td>
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

function ParamInput({ spec, value, onChange, symbols }: { spec: AlgoParamSpec; value: string | number | boolean | undefined; onChange: (v: string | number | boolean) => void; symbols: AlgoCatalog['symbols'] }) {
  if (spec.type === 'boolean') return <Toggle checked={Boolean(value)} onChange={onChange} label={spec.label} />;
  let input;
  if (spec.type === 'symbol') input = <Select label={spec.label} className="w-full" value={String(value ?? 'NIFTY')} onChange={onChange} options={symbols.map((s) => ({ value: s.symbol, label: `${s.symbol} (lot ${s.lotSize})` }))} />;
  else if (spec.type === 'select') input = <Select label={spec.label} className="w-full" value={String(value ?? spec.options?.[0]?.value ?? '')} onChange={onChange} options={spec.options ?? []} />;
  else if (spec.type === 'time') input = <input aria-label={spec.label} className="input" type="time" min="09:15" max="15:30" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
  else input = <input aria-label={spec.label} className="input" type="number" min={spec.min} max={spec.max} step={spec.step} value={value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />;
  return (
    <Field label={spec.label}>
      {input}
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
  const net = t ? t.mtm - t.charges : 0;
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
          <span className={cx('text-sm font-semibold tabular-nums', pnlClass(net))} title="Today, after charges">{signed(net)}</span>
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
      {error != null && <ErrorBox error={error} />}
      {run.error && <ErrorBox error={run.error} />}
      <div className="text-xs text-muted">
        {String(run.params.symbol)} · {String(run.params.lots)} lot(s)/leg · start ₹{String(run.params.startPremium)} · step {String(run.params.stepPct)}% · strikes ×{String(run.params.strikeMultiple)} · {String(run.params.entryTime)}–{String(run.params.exitTime)} · deployed {formatDateTime(run.createdAt)}
      </div>
      {open && (
        <div className="mt-3 space-y-3">
          {t ? (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-6">
                <Stat label="Session" value={formatDate(t.date)} sub={`Expiry ${formatExpiry(t.expiry)}`} />
                <Stat label="Realised" value={rupee(t.realized)} tone={t.realized > 0 ? 'up' : t.realized < 0 ? 'down' : undefined} />
                <Stat label="Unrealised" value={rupee(t.unrealized)} tone={t.unrealized > 0 ? 'up' : t.unrealized < 0 ? 'down' : undefined} />
                <Stat label="Charges" value={rupee(t.charges)} tone="warn" />
                <Stat label="Net today" value={signed(net)} tone={net > 0 ? 'up' : net < 0 ? 'down' : undefined} />
                <Stat label="All days (net)" value={signed(run.totalNet)} tone={run.totalNet > 0 ? 'up' : run.totalNet < 0 ? 'down' : undefined} sub={`${run.history.length} finished day(s)`} />
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
                            <td className="num">{l.ltp?.toFixed(2) ?? '—'}</td>
                            <td className={cx('num', pnlClass(l.pnl))}>{rupee(l.pnl)}</td>
                          </tr>
                        ))
                      ) : (
                        <tr><td colSpan={5} className="text-center text-muted">No open legs</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
              <DayCharts series={t.series} events={t.events} stepPct={Number(run.params.stepPct ?? 50)} height={220} />
              <div>
                <div className="mb-1 text-xs font-medium text-muted">Today's events</div>
                <EventLog events={t.events} />
              </div>
            </>
          ) : (
            <Empty>Waiting for the market to open.</Empty>
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
        { key: 'exit', label: 'Exit', value: (d) => d.exitKind, render: (d) => <span title={d.exitReason}>{d.entered ? EXIT_LABEL[d.exitKind] : 'No trade'}</span> },
        { key: 'low', label: 'Worst', num: true, value: (d) => d.maxLoss, render: (d) => <span className={pnlClass(d.maxLoss)}>{rupee(d.maxLoss)}</span>, hideSm: true },
        { key: 'chg', label: 'Charges', num: true, value: (d) => d.charges, render: (d) => rupee(d.charges), hideSm: true },
        { key: 'net', label: 'Net P&L', num: true, value: (d) => d.net, render: (d) => <span className={cx('font-medium', pnlClass(d.net))}>{signed(d.net)}</span> },
      ]}
    />
  );
}

/* ----------------------------------- backtests ----------------------------------- */

function DayBacktest({ algoId, params, date, setDate }: { algoId: string; params: Params; date: string; setDate: (d: string) => void }) {
  const today = useTicks((s) => s.clock?.date);
  const key = JSON.stringify(params);
  const q = useQuery({
    queryKey: ['algo-bt-day', algoId, key, date],
    queryFn: () => api<AlgoBacktestDay>(`/algos/${algoId}/backtest`, { body: { params, date: date || undefined } }),
    refetchInterval: date ? false : 15_000,
    retry: false,
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SessionDate value={date} onChange={setDate} max={today} />
        <span className="text-xs text-muted">Minute-by-minute replay on the simulated history; fills at the minute's last price.</span>
      </div>
      <Loadable q={q}>
        {(d) => (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 2xl:grid-cols-8">
              <Stat label="Session" value={formatDate(d.date)} sub={d.partial ? 'in progress' : `Expiry ${formatExpiry(d.expiry)}`} />
              <Stat label="Net P&L" value={signed(d.net)} tone={d.net > 0 ? 'up' : d.net < 0 ? 'down' : undefined} sub={`Gross ${rupee(d.pnl)}`} />
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

function RangeBacktest({ algoId, params, onPickDay }: { algoId: string; params: Params; onPickDay: (date: string) => void }) {
  const [days, setDays] = useState(60);
  const c = useChartColors();
  const key = JSON.stringify(params);
  const q = useQuery({
    queryKey: ['algo-bt-range', algoId, key, days],
    queryFn: () => api<AlgoBacktestRange>(`/algos/${algoId}/backtest-range`, { body: { params, days } }),
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
        <span className="text-xs text-muted">Each completed session replayed independently (entry 09:20, exit 15:25). Click a day to open it.</span>
      </div>
      {q.isFetching && !q.data ? (
        <Spinner label="Running backtest…" />
      ) : (
        <Loadable q={q}>
          {(r) => (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 2xl:grid-cols-8">
                <Stat label="Period" value={`${r.stats.days} days`} sub={r.from ? `${formatDate(r.from)} → ${formatDate(r.to)}` : undefined} />
                <Stat label="Total net" value={signed(r.stats.totalNet)} tone={r.stats.totalNet > 0 ? 'up' : r.stats.totalNet < 0 ? 'down' : undefined} sub={`charges ${rupee(r.stats.totalCharges)}`} />
                <Stat label="Win rate" value={`${r.stats.winRate}%`} sub={`${r.stats.winDays}W · ${r.stats.lossDays}L · ${r.stats.tradedDays} traded`} />
                <Stat label="Avg / day" value={signed(r.stats.avgNet)} tone={r.stats.avgNet > 0 ? 'up' : r.stats.avgNet < 0 ? 'down' : undefined} />
                <Stat label="Best day" value={signed(r.stats.bestDay)} tone="up" />
                <Stat label="Worst day" value={signed(r.stats.worstDay)} tone="down" />
                <Stat label="Max drawdown" value={rupee(r.stats.maxDrawdown)} tone="down" />
                <Stat label="Adjustments" value={`${r.stats.avgAdjustments} avg`} sub={`max ${r.stats.maxAdjustments} · ${r.stats.stoppedDays} stop days`} />
              </div>
              <Card title="Daily net P&L and equity curve">
                <Chart option={option} height={280} />
              </Card>
              <Card title="Day by day" pad={false}>
                <DaysTable days={r.days} onPick={(d) => onPickDay(d.date)} />
              </Card>
            </>
          )}
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
      <PageHeader title="Algo Strategies" subtitle="Rule-based strategies that trade your paper account automatically. Backtest them on history, then deploy. New algos appear here as they are added.">
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
                    {algo.rules.map((r, i) => (
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
                        <ParamInput key={s.key} spec={s} value={params[s.key]} onChange={(v) => setParam(s.key, v)} symbols={cat.symbols} />
                      ))}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    {algo.params
                      .filter((s) => s.type === 'boolean')
                      .map((s) => (
                        <ParamInput key={s.key} spec={s} value={params[s.key]} onChange={(v) => setParam(s.key, v)} symbols={cat.symbols} />
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
                  {error != null && <div className="mt-2"><ErrorBox error={error} /></div>}
                  <p className="mt-2 text-2xs text-muted">
                    Deployed algos place MARKET orders (MIS, tagged <code>algo:&lt;id&gt;</code>) through the paper broker every couple of seconds, run every trading day until stopped, and show up in Positions & Orders. Don't exit an algo's positions by hand — use Stop. Simulated data; not investment advice.
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
                        <Empty>No algo deployed yet. Choose a strategy, check its backtest and press “Deploy on paper account”.</Empty>
                      </Card>
                    )
                  }
                </Loadable>
              )}
              {tab === 'day' && algo && <DayBacktest algoId={algo.id} params={applied} date={btDate} setDate={setBtDate} />}
              {tab === 'range' && algo && (
                <RangeBacktest
                  algoId={algo.id}
                  params={applied}
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
