import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  buildFromTemplate,
  defaultUnit,
  formatExpiry,
  formatINR,
  formatIndian,
  istTs,
  prevTradingDay,
  STRATEGY_TEMPLATES,
  type Leg,
  type RecapResponse,
} from '@q26/core';
import { Chart, axis, baseOption, useChartColors, pnlVisualMap } from '../components/Chart';
import { PayoffChart, StrategySummary, useStrategyView } from '../components/Payoff';
import { SymbolSelect } from '../components/pickers';
import { Card, cx, ErrorBox, Field, PageHeader, Spinner, Stat } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useChain } from '../lib/hooks';
import { useApp, useTicks } from '../lib/store';

const QUICK = ['short-straddle', 'short-strangle', 'iron-condor', 'long-straddle', 'bull-call-spread', 'bear-put-spread'];

export default function Recap() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const clockDate = useTicks((s) => s.clock?.date);
  const [date, setDate] = useState<string>(() => (clockDate ? prevTradingDay(clockDate) : ''));
  const [time, setTime] = useState('09:30');
  const [expiry, setExpiry] = useState<string>();
  const [legs, setLegs] = useState<Leg[]>([]);
  const [interval, setIntervalMin] = useState(5);
  const effDate = date || (clockDate ? prevTradingDay(clockDate) : '');
  const [hh, mm] = time.split(':').map(Number);
  const at = effDate ? istTs(effDate, Math.min(15 * 60 + 29, Math.max(9 * 60 + 15, hh * 60 + mm))) : undefined;
  const chain = useChain(symbol, expiry, { at });
  const ch = chain.data && chain.data.symbol === symbol ? chain.data : undefined;
  const view = useStrategyView(symbol, legs, { at });
  const c = useChartColors();

  const replay = useMutation({
    mutationFn: () => api<RecapResponse>('/recap', { body: { symbol, legs, fromTs: at, intervalMin: interval } }),
  });

  const rows = useMemo(() => {
    if (!ch) return [];
    const i = ch.rows.findIndex((r) => r.strike === ch.atm);
    return ch.rows.slice(Math.max(0, i - 10), i + 11);
  }, [ch]);

  const add = (type: 'CE' | 'PE', strike: number, side: 'BUY' | 'SELL', price: number, iv: number) => {
    if (!ch) return;
    setLegs((l) => [...l, { side, type, strike, expiry: ch.expiry, lots: 1, lotSize: ch.lotSize, price, iv: iv / 100 }]);
    replay.reset();
  };

  const quick = (id: string) => {
    if (!ch) return;
    const t = STRATEGY_TEMPLATES.find((x) => x.id === id)!;
    const built = buildFromTemplate(t, {
      spot: ch.spot,
      strikes: () => ch.rows.map((r) => r.strike),
      expiries: [ch.expiry],
      lotSize: ch.lotSize,
      unit: defaultUnit(ch.spot, ch.strikeStep),
      quote: (type, strike) => {
        const r = ch.rows.find((x) => x.strike === strike);
        const q = r ? (type === 'CE' ? r.ce : r.pe) : undefined;
        return { price: type === 'FUT' ? ch.future : q?.ltp ?? 0, iv: q ? q.iv / 100 : undefined };
      },
      futureExpiry: ch.futureExpiry,
    });
    setLegs(built);
    replay.reset();
  };

  const option = useMemo(() => {
    const pts = replay.data?.points ?? [];
    return {
      ...baseOption(c),
      xAxis: { type: 'category', data: pts.map((p) => formatDateTime(p.ts)), ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, fontSize: 10, formatter: (v: string) => v.slice(0, 6) + v.slice(-6) } },
      yAxis: [
        { type: 'value', ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => formatINR(v) } },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, 0) } },
      ],
      visualMap: pnlVisualMap(c),
      dataZoom: [{ type: 'inside' }, { type: 'slider', height: 18, bottom: 0, borderColor: c.line, textStyle: { color: c.muted } }],
      grid: { left: 8, right: 12, top: 36, bottom: 30, containLabel: true },
      series: [
        { name: 'P&L', type: 'line', symbol: 'none', areaStyle: { opacity: 0.12 }, data: pts.map((p) => p.pnl) },
        { name: 'Break-even', type: 'line', symbol: 'none', silent: true, tooltip: { show: false }, lineStyle: { color: c.muted, width: 1 }, itemStyle: { color: c.muted }, data: pts.map(() => 0) },
        { name: 'Spot', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1 }, itemStyle: { color: c.muted }, data: pts.map((p) => p.spot) },
      ],
    };
  }, [replay.data, c]);

  return (
    <div className="space-y-3">
      <PageHeader title="Trade Recap" subtitle="Go back to any past date & time, take a position at that moment's prices, and replay how it would have played out until expiry">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setLegs([]); setExpiry(undefined); replay.reset(); }} />
      </PageHeader>
      <Card title="1 · Pick the moment">
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Date">
            <input className="input w-auto" type="date" value={effDate} max={clockDate} onChange={(e) => { setDate(e.target.value); setLegs([]); replay.reset(); }} />
          </Field>
          <Field label="Time (IST)">
            <input className="input w-auto" type="time" min="09:15" max="15:29" value={time} onChange={(e) => { setTime(e.target.value); setLegs([]); replay.reset(); }} />
          </Field>
          <Field label="Expiry (as listed then)">
            <select className="input w-auto" value={ch?.expiry ?? ''} onChange={(e) => { setExpiry(e.target.value); setLegs([]); }}>
              {(ch?.expiries ?? []).map((e) => <option key={e} value={e}>{formatExpiry(e)}</option>)}
            </select>
          </Field>
          {ch && <div className="text-sm">Spot then: <b>{formatIndian(ch.spot)}</b> · ATM IV {ch.atmIv.toFixed(2)}% · PCR {ch.pcr.toFixed(2)}</div>}
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-5">
        <Card title="2 · Build the position (prices at that moment)" pad={false} className="lg:col-span-2">
          <div className="flex flex-wrap gap-1 border-b border-line p-2">
            {QUICK.map((id) => (
              <button key={id} className="btn-ghost px-2 py-1 text-xs" onClick={() => quick(id)} disabled={!ch}>{STRATEGY_TEMPLATES.find((t) => t.id === id)!.name}</button>
            ))}
          </div>
          {chain.error ? <div className="p-3"><ErrorBox error={chain.error} /></div> : !ch ? <Spinner /> : (
            <div className="max-h-[420px] overflow-auto">
              <table className="tbl">
                <thead>
                  <tr><th className="num">Call</th><th></th><th className="text-center">Strike</th><th></th><th className="num">Put</th></tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.strike}>
                      <td className="num">{r.ce.ltp.toFixed(2)}</td>
                      <td className="whitespace-nowrap">
                        <button className="rounded bg-up px-1.5 text-2xs font-bold text-white" onClick={() => add('CE', r.strike, 'BUY', r.ce.ltp, r.ce.iv)}>B</button>{' '}
                        <button className="rounded bg-down px-1.5 text-2xs font-bold text-white" onClick={() => add('CE', r.strike, 'SELL', r.ce.ltp, r.ce.iv)}>S</button>
                      </td>
                      <td className={cx('text-center font-semibold', r.strike === ch.atm && 'text-accent')}>{r.strike}</td>
                      <td className="whitespace-nowrap">
                        <button className="rounded bg-up px-1.5 text-2xs font-bold text-white" onClick={() => add('PE', r.strike, 'BUY', r.pe.ltp, r.pe.iv)}>B</button>{' '}
                        <button className="rounded bg-down px-1.5 text-2xs font-bold text-white" onClick={() => add('PE', r.strike, 'SELL', r.pe.ltp, r.pe.iv)}>S</button>
                      </td>
                      <td className="num">{r.pe.ltp.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <Card title={`3 · Position (${legs.length} legs)`} className="lg:col-span-3" actions={legs.length > 0 && <button className="btn-ghost px-2 py-1 text-xs" onClick={() => { setLegs([]); replay.reset(); }}>Clear</button>}>
          {!legs.length ? (
            <div className="py-8 text-center text-sm text-muted">Use B / S on the chain or a quick strategy to add legs.</div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-1">
                {legs.map((l, i) => (
                  <span key={i} className={cx('chip gap-1 px-2 py-1 text-xs', l.side === 'BUY' ? 'bg-up/15 text-up' : 'bg-down/15 text-down')}>
                    {l.side === 'BUY' ? 'B' : 'S'}
                    <input aria-label="Lots" className="w-8 rounded bg-transparent text-center" type="number" min={1} value={l.lots} onChange={(e) => setLegs((ls) => ls.map((x, j) => (j === i ? { ...x, lots: Math.max(1, Number(e.target.value) || 1) } : x)))} />
                    × {l.type === 'FUT' ? 'FUT' : `${l.strike} ${l.type}`} @ {l.price.toFixed(2)}
                    <button onClick={() => setLegs((ls) => ls.filter((_, j) => j !== i))} aria-label="Remove">✕</button>
                  </span>
                ))}
              </div>
              {view.analysis && <PayoffChart view={view} height={240} />}
              {view.analysis && <StrategySummary view={view} />}
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Replay step">
                  <select className="input w-auto" value={interval} onChange={(e) => setIntervalMin(Number(e.target.value))}>
                    {[1, 5, 15, 30, 75].map((m) => <option key={m} value={m}>{m} min</option>)}
                  </select>
                </Field>
                <button className="btn-primary" disabled={replay.isPending} onClick={() => replay.mutate()}>{replay.isPending ? 'Replaying…' : '⏵ Replay to expiry'}</button>
              </div>
            </div>
          )}
        </Card>
      </div>

      {replay.error ? <ErrorBox error={replay.error} /> : null}
      {replay.data && (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label={replay.data.expired ? 'Final P&L (at expiry)' : 'P&L now'} value={formatINR(replay.data.finalPnl)} tone={replay.data.finalPnl >= 0 ? 'up' : 'down'} sub={formatDateTime(replay.data.endTs)} />
            <Stat label="Best point" value={formatINR(replay.data.maxPnl)} tone="up" />
            <Stat label="Worst point (max drawdown)" value={formatINR(replay.data.minPnl)} tone="down" />
            <Stat label="Data points" value={replay.data.points.length} sub={replay.data.expired ? 'Held to expiry' : 'Still open — up to now'} />
          </div>
          <Card title="P&L replay"><Chart option={option} height={380} /></Card>
        </>
      )}
    </div>
  );
}
