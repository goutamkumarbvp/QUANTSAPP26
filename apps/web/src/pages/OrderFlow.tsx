import { useMemo, useState } from 'react';
import { formatIndian, type OrderFlowResponse } from '@q26/core';
import { Chart, axis, baseOption, timeAxis, useChartColors } from '../components/Chart';
import { ExpirySelect, SessionDate, SymbolSelect } from '../components/pickers';
import { FlowSplit, sentimentTone } from '../components/trend';
import { Card, Chg, cx, Loadable, PageHeader, Segmented } from '../components/ui';
import { qs } from '../lib/api';
import { formatCompact, formatSessionTime } from '../lib/format';
import { useChain, useLive } from '../lib/hooks';
import { useApp, useTicks } from '../lib/store';

export default function OrderFlow() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const today = useTicks((s) => s.clock?.date);
  const [type, setType] = useState<'FUT' | 'CE' | 'PE'>('FUT');
  const [expiry, setExpiry] = useState<string>();
  const [strike, setStrike] = useState<number>();
  const [date, setDate] = useState('');
  const [limit, setLimit] = useState(60);
  const [unit, setUnit] = useState<'qty' | 'lots'>('qty');
  const chain = useChain(symbol, type === 'FUT' ? undefined : expiry, { refetch: 30000 });
  const k = type === 'FUT' ? undefined : strike && chain.data?.rows.some((r) => r.strike === strike) ? strike : chain.data?.atm;
  const q = useLive<OrderFlowResponse>(['order-flow', symbol, type, expiry, k, date, limit], `/order-flow/${symbol}${qs({ type, expiry, strike: k, date, limit })}`, date ? false : 2000);
  const c = useChartColors();
  const d = q.data;
  const lot = d?.lotSize ?? 1;
  const u = (x: number) => (unit === 'lots' ? x / lot : x);

  const bars = useMemo(() => {
    const m = d?.minutes ?? [];
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), valueFormatter: (v: number) => formatCompact(Math.abs(v)) },
      xAxis: timeAxis(c),
      yAxis: [
        { type: 'value', ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => formatCompact(Math.abs(v)) } },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, v > 1000 ? 0 : 2) } },
      ],
      dataZoom: [{ type: 'inside' }],
      series: [
        { name: 'Buy volume', type: 'bar', stack: 'flow', itemStyle: { color: c.up }, data: m.map((x) => [x.ts, u(x.buyVolume)]) },
        { name: 'Sell volume', type: 'bar', stack: 'flow', itemStyle: { color: c.down }, data: m.map((x) => [x.ts, -u(x.sellVolume)]) },
        { name: 'Price', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { width: 1.5 }, itemStyle: { color: c.accent }, data: m.map((x) => [x.ts + 60_000, x.close]) },
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, unit, c]);

  const cum = useMemo(() => {
    const m = d?.minutes ?? [];
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), valueFormatter: (v: number) => formatCompact(v) },
      xAxis: timeAxis(c),
      yAxis: { type: 'value', scale: true, ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => formatCompact(v) } },
      dataZoom: [{ type: 'inside' }],
      series: [
        { name: 'Delta (buy − sell)', type: 'bar', itemStyle: { color: c.muted, opacity: 0.5 }, data: m.map((x) => ({ value: [x.ts, u(x.delta)], itemStyle: { color: x.delta >= 0 ? c.up : c.down, opacity: 0.5 } })) },
        { name: 'Cumulative delta (session)', type: 'line', symbol: 'none', lineStyle: { width: 2 }, itemStyle: { color: c.accent }, data: m.map((x) => [x.ts, u(x.cumDelta)]) },
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, unit, c]);

  const strikes = chain.data?.rows.map((r) => r.strike) ?? [];
  return (
    <div className="space-y-3">
      <PageHeader title="Order Flow (1-minute)" subtitle="How much volume aggressive buyers vs sellers traded in the last minute — per minute, last 5 minutes and the whole session">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setStrike(undefined); }} />
        <Segmented value={type} onChange={setType} options={[{ value: 'FUT', label: 'Future' }, { value: 'CE', label: 'Call' }, { value: 'PE', label: 'Put' }]} />
        <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} futures={type === 'FUT'} />
        {type !== 'FUT' && (
          <select aria-label="Strike" className="input w-auto" value={k ?? ''} onChange={(e) => setStrike(Number(e.target.value))}>
            {strikes.map((x) => <option key={x} value={x}>{x}{x === chain.data?.atm ? ' (ATM)' : ''}</option>)}
          </select>
        )}
        <SessionDate value={date} onChange={setDate} max={today} />
      </PageHeader>

      <Loadable q={q}>
        {() =>
          d ? (
            <>
              <div className="grid gap-3 lg:grid-cols-3">
                <Card title={d.lastMinute ? `Last 1 minute · ${formatSessionTime(d.lastMinute.ts)}–${formatSessionTime(d.lastMinute.ts + 60_000)}` : 'Last 1 minute'} className="lg:col-span-2">
                  {d.lastMinute ? (
                    <div className="space-y-3">
                      <FlowSplit flow={d.lastMinute} unit={unit} lotSize={lot} />
                      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                        <div><div className="text-2xs text-muted">Buy volume</div><div className="font-semibold text-up tabular-nums">{formatCompact(u(d.lastMinute.buyVolume))}</div></div>
                        <div><div className="text-2xs text-muted">Sell volume</div><div className="font-semibold text-down tabular-nums">{formatCompact(u(d.lastMinute.sellVolume))}</div></div>
                        <div><div className="text-2xs text-muted">Delta (buy − sell)</div><div className="font-semibold"><Chg value={u(d.lastMinute.delta)} decimals={0} /></div></div>
                        <div><div className="text-2xs text-muted">Verdict</div><div className={cx('font-semibold', sentimentTone(d.lastMinute.sentiment))}>{d.lastMinute.sentiment}</div></div>
                      </div>
                      <p className="text-sm text-muted">{d.signal}</p>
                    </div>
                  ) : (
                    <div className="py-6 text-center text-sm text-muted">The first 1-minute candle of the session hasn't completed yet.</div>
                  )}
                </Card>
                <Card title={d.instrument} actions={<Segmented size="xs" value={unit} onChange={setUnit} options={[{ value: 'qty', label: 'Qty' }, { value: 'lots', label: 'Lots' }]} />}>
                  <div className="space-y-3">
                    {d.currentMinute && (
                      <div>
                        <div className="mb-1 text-2xs text-muted">Current minute {formatSessionTime(d.currentMinute.ts)} · {d.currentMinute.elapsedSec}s so far</div>
                        <FlowSplit flow={d.currentMinute} unit={unit} lotSize={lot} compact />
                      </div>
                    )}
                    <div>
                      <div className="mb-1 flex justify-between text-2xs text-muted"><span>Last 5 minutes</span><span className={sentimentTone(d.last5.sentiment)}>{d.last5.sentiment}</span></div>
                      <FlowSplit flow={d.last5} unit={unit} lotSize={lot} compact />
                    </div>
                    <div>
                      <div className="mb-1 flex justify-between text-2xs text-muted"><span>Session ({d.date})</span><span className={sentimentTone(d.session.sentiment)}>{d.session.sentiment}</span></div>
                      <FlowSplit flow={d.session} unit={unit} lotSize={lot} compact />
                      <div className="mt-1 text-2xs text-muted">Cumulative delta <Chg value={u(d.session.delta)} decimals={0} /> · total {formatCompact(u(d.session.volume))}</div>
                    </div>
                  </div>
                </Card>
              </div>

              <Card title="Buy vs sell volume per minute" actions={<Segmented size="xs" value={limit} onChange={setLimit} options={[{ value: 30, label: '30m' }, { value: 60, label: '1h' }, { value: 120, label: '2h' }, { value: 375, label: 'Day' }]} />}>
                <Chart option={bars} height={340} />
              </Card>
              <Card title="Delta & cumulative delta">
                <Chart option={cum} height={260} />
              </Card>
              <Card title="Minute-by-minute (latest first)" pad={false}>
                <div className="max-h-[50vh] overflow-auto">
                  <table className="tbl">
                    <thead><tr><th>Minute</th><th className="num">Buy</th><th className="num">Sell</th><th className="num">Total</th><th className="num">Delta</th><th>Buy %</th><th className="num hidden sm:table-cell">Cum. delta</th><th className="num">Close</th></tr></thead>
                    <tbody>
                      {[...d.minutes].reverse().slice(0, 60).map((m) => (
                        <tr key={m.ts}>
                          <td>{formatSessionTime(m.ts)}</td>
                          <td className="num text-up">{formatCompact(u(m.buyVolume))}</td>
                          <td className="num text-down">{formatCompact(u(m.sellVolume))}</td>
                          <td className="num">{formatCompact(u(m.volume))}</td>
                          <td className="num"><Chg value={u(m.delta)} decimals={0} /></td>
                          <td>
                            <div className="flex items-center gap-2">
                              <span className="relative h-1.5 w-16 overflow-hidden rounded bg-down/60"><span className="absolute inset-y-0 left-0 bg-up" style={{ width: `${m.buyPct}%` }} /></span>
                              <span className="tabular-nums">{m.buyPct.toFixed(0)}%</span>
                            </div>
                          </td>
                          <td className="num hidden sm:table-cell"><Chg value={u(m.cumDelta)} decimals={0} /></td>
                          <td className="num">{formatIndian(m.close)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              <p className="text-2xs text-muted">Buy volume = trades that lifted the offer (aggressive buyers); sell volume = trades that hit the bid. Indices are measured on their futures. Simulated data.</p>
            </>
          ) : null
        }
      </Loadable>
    </div>
  );
}
