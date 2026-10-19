import { useMemo, useState } from 'react';
import { formatExpiry, ORDER_FLOW_METHOD, type OrderFlowMinute, type OrderFlowResponse, type OrderFlowSummary } from '@q26/core';
import { Chart, axis, baseOption, LINE_GAPS, timeAxis, useChartColors } from '../components/Chart';
import { ExpirySelect, SessionDate, SymbolSelect } from '../components/pickers';
import { Card, Chg, Coverage, cx, Dash, flowTone, Gaps, Loadable, PageHeader, Segmented } from '../components/ui';
import { qs } from '../lib/api';
import { formatCompact, formatFixed, formatIndian, formatSessionTime, isNum } from '../lib/format';
import { useChain, useLive } from '../lib/hooks';
import { useApp, useTicks } from '../lib/store';

type Unit = 'qty' | 'lots';

/** `[x, value]` line points of the recorded minutes; a null breaks the line where whole minutes have no record. */
function minuteLine(m: OrderFlowMinute[], pick: (x: OrderFlowMinute) => number | null, shift = 0): [number, number | null][] {
  const out: [number, number | null][] = [];
  m.forEach((x, i) => {
    if (i > 0 && x.ts - m[i - 1].ts > 60_000) out.push([m[i - 1].ts + 60_000 + shift, null]);
    out.push([x.ts + shift, pick(x)]);
  });
  return out;
}

/**
 * Buyers / sellers / unclassified split of a window of recorded minutes (an estimate from live ticks, quote rule).
 * Bar widths are shares of the window's volume; unclassified volume is its own grey segment and the buy share
 * quoted beside the buyers is of the classified volume. A window with no volume is never drawn as a split.
 */
function FlowBar({ flow, q, compact }: { flow: OrderFlowSummary; q: (x: number) => string; compact?: boolean }) {
  const h = compact ? 'h-1.5' : 'h-3';
  const txt = compact ? 'text-2xs' : 'text-xs';
  if (flow.volume === 0) {
    return (
      <div className="w-full">
        <div className={cx('text-center font-semibold', txt, flowTone(flow.sentiment))}>
          {flow.sentiment === 'Feed gap' ? `Feed gap — ${q(flow.gapVolume)} traded at unknown times, not classified` : 'No trades'}
        </div>
        <div className={cx('mt-1 rounded-full bg-line', h)} role="img" aria-label={flow.sentiment === 'Feed gap' ? 'Volume traded during a feed gap' : 'No trades'} />
      </div>
    );
  }
  const share = (x: number) => (x / flow.volume) * 100;
  const buyOfClassified = flow.buyPct;
  return (
    <div className="w-full">
      <div className={cx('flex justify-between font-semibold tabular-nums', txt)}>
        <span className="text-up">Buyers {q(flow.buyVolume)}{buyOfClassified !== null ? ` · ${formatFixed(buyOfClassified, 0)}%` : ''}</span>
        <span className="text-down">{buyOfClassified !== null ? `${formatFixed(100 - buyOfClassified, 0)}% · ` : ''}{q(flow.sellVolume)} Sellers</span>
      </div>
      <div className={cx('mt-1 flex overflow-hidden rounded-full bg-line', h)} role="img" aria-label={`Buy ${formatFixed(share(flow.buyVolume), 0)} percent, sell ${formatFixed(share(flow.sellVolume), 0)} percent, unclassified ${formatFixed(share(flow.unclassified), 0)} percent of the volume`}>
        <div className="bg-up transition-all" style={{ width: `${share(flow.buyVolume)}%` }} />
        <div className="bg-muted/40 transition-all" style={{ width: `${share(flow.unclassified)}%` }} title="Unclassified: no usable bid/ask before the trade" />
        <div className="bg-down transition-all" style={{ width: `${share(flow.sellVolume)}%` }} />
      </div>
      <div className="mt-1 flex flex-wrap justify-between gap-x-3 text-2xs text-muted">
        <span>
          Unclassified {q(flow.unclassified)}{flow.unclassifiedPct !== null ? ` · ${formatFixed(flow.unclassifiedPct, 0)}%` : ''}
          {buyOfClassified === null ? ' — nothing could be classified' : ''}
        </span>
        <span>
          {flow.gapVolume > 0 ? `Feed gap +${q(flow.gapVolume)} (not in the split)` : ''}
          {flow.gapVolume > 0 && flow.partialMinutes > 0 ? ' · ' : ''}
          {flow.partialMinutes > 0 ? `partial (lower bound) ${flow.partialMinutes} min` : ''}
        </span>
      </div>
    </div>
  );
}

export default function OrderFlow() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const today = useTicks((s) => s.clock?.date);
  const [type, setType] = useState<'FUT' | 'CE' | 'PE'>('FUT');
  const [expiry, setExpiry] = useState<string>();
  const [strike, setStrike] = useState<number>();
  const [date, setDate] = useState('');
  const [limit, setLimit] = useState(60);
  const [unit, setUnit] = useState<Unit>('qty');
  // Past sessions list their own contracts (from the response); today's come from the live chain.
  const [pastExpiry, setPastExpiry] = useState<string>();
  const [pastStrike, setPastStrike] = useState<number>();
  const isPast = !!date && !!today && date < today;
  const chain = useChain(symbol, type === 'FUT' ? undefined : expiry, { refetch: 30000 });
  const k = type === 'FUT' ? undefined : strike && chain.data?.rows.some((r) => r.strike === strike) ? strike : chain.data?.atm ?? undefined;
  const reqExpiry = isPast ? pastExpiry : expiry;
  const reqStrike = type === 'FUT' ? undefined : isPast ? pastStrike : k;
  const q = useLive<OrderFlowResponse>(
    ['order-flow', symbol, type, reqExpiry, reqStrike, isPast ? date : '', limit],
    `/order-flow/${symbol}${qs({ type, expiry: reqExpiry, strike: reqStrike, date: isPast ? date : undefined, limit })}`,
    isPast ? false : 2000,
  );
  const changeDate = (v: string) => {
    setDate(v);
    setPastExpiry(undefined);
    setPastStrike(undefined);
  };
  const changeType = (t: 'FUT' | 'CE' | 'PE') => {
    // Futures and options list different expiries: start each from its own nearest one.
    if ((t === 'FUT') !== (type === 'FUT')) {
      setExpiry(undefined);
      setStrike(undefined);
      setPastExpiry(undefined);
      setPastStrike(undefined);
    }
    setType(t);
  };
  const c = useChartColors();
  const d = q.data;
  // Lots need the contract's lot size; without it the figures stay in units.
  const lot = d?.lotSize ?? null;
  const eff: Unit = unit === 'lots' && lot ? 'lots' : 'qty';
  const u = (x: number | null): number | null => (x === null ? null : eff === 'lots' && lot ? x / lot : x);
  const fmt = (x: number) => formatCompact(u(x));

  const bars = useMemo(() => {
    const m = d?.minutes ?? [];
    return {
      ...baseOption(c),
      xAxis: timeAxis(c),
      yAxis: [
        { type: 'value', ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => formatCompact(Math.abs(v)) } },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, formatter: (v: number) => formatIndian(v, v > 1000 ? 0 : 2) } },
      ],
      dataZoom: [{ type: 'inside' }],
      series: [
        // A faded bar is a partial minute: recording of the contract started inside it, so its volume is a lower bound.
        { name: 'Buy volume', type: 'bar', stack: 'flow', itemStyle: { color: c.up }, tooltip: { valueFormatter: (v: number | null) => formatCompact(v === null ? null : Math.abs(v)) }, data: m.map((x) => ({ value: [x.ts, u(x.buyVolume)], itemStyle: { opacity: x.partial ? 0.45 : 1 } })) },
        { name: 'Sell volume', type: 'bar', stack: 'flow', itemStyle: { color: c.down }, tooltip: { valueFormatter: (v: number | null) => formatCompact(v === null ? null : Math.abs(v)) }, data: m.map((x) => ({ value: [x.ts, u(-x.sellVolume)], itemStyle: { opacity: x.partial ? 0.45 : 1 } })) },
        { name: 'Unclassified (not buy or sell)', type: 'line', symbol: 'none', ...LINE_GAPS, lineStyle: { width: 1, type: 'dotted', color: c.muted }, itemStyle: { color: c.muted }, tooltip: { valueFormatter: (v: number | null) => formatCompact(v) }, data: minuteLine(m, (x) => u(x.unclassified)) },
        { name: 'Price', type: 'line', yAxisIndex: 1, symbol: 'none', ...LINE_GAPS, lineStyle: { width: 1.5 }, itemStyle: { color: c.accent }, tooltip: { valueFormatter: (v: number | null) => formatIndian(v, 2) }, data: minuteLine(m, (x) => x.close, 60_000) },
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, eff, c]);

  const cum = useMemo(() => {
    const m = d?.minutes ?? [];
    return {
      ...baseOption(c),
      tooltip: { ...(baseOption(c).tooltip as object), valueFormatter: (v: number | null) => formatCompact(v) },
      xAxis: timeAxis(c),
      yAxis: { type: 'value', scale: true, ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => formatCompact(v) } },
      dataZoom: [{ type: 'inside' }],
      series: [
        { name: 'Delta (buy − sell)', type: 'bar', itemStyle: { color: c.muted, opacity: 0.5 }, data: m.map((x) => ({ value: [x.ts, u(x.delta)], itemStyle: { color: x.delta >= 0 ? c.up : c.down, opacity: 0.5 } })) },
        { name: 'Cumulative delta (classified volume)', type: 'line', symbol: 'none', ...LINE_GAPS, lineStyle: { width: 2 }, itemStyle: { color: c.accent }, data: minuteLine(m, (x) => u(x.cumDelta)) },
      ],
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d, eff, c]);

  const strikes = chain.data?.rows.map((r) => r.strike) ?? [];
  const noteOf = (m: OrderFlowMinute) => [m.gapVolume ? `feed gap +${formatCompact(u(m.gapVolume))}` : '', m.partial ? 'partial (lower bound)' : ''].filter(Boolean).join(' · ');
  return (
    <div className="space-y-3">
      <PageHeader title="Order Flow (1-minute)" subtitle="How much volume aggressive buyers vs sellers traded in the last minute — per minute, last 5 minutes and the whole session">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setStrike(undefined); setPastExpiry(undefined); setPastStrike(undefined); }} />
        <Segmented value={type} onChange={changeType} options={[{ value: 'FUT', label: 'Future' }, { value: 'CE', label: 'Call' }, { value: 'PE', label: 'Put' }]} />
        {isPast ? (
          <>
            <select aria-label="Expiry" className="input w-auto" value={d?.expiry ?? ''} onChange={(e) => { setPastExpiry(e.target.value); setPastStrike(undefined); }}>
              {(d?.expiries ?? []).map((x) => <option key={x} value={x}>{formatExpiry(x)}</option>)}
            </select>
            {type !== 'FUT' && (
              <select aria-label="Strike" className="input w-auto" value={d?.strike ?? ''} onChange={(e) => setPastStrike(Number(e.target.value))}>
                {(d?.strikes ?? []).map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            )}
          </>
        ) : (
          <>
            <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} futures={type === 'FUT'} />
            {type !== 'FUT' && (
              <select aria-label="Strike" className="input w-auto" value={k ?? ''} onChange={(e) => setStrike(Number(e.target.value))} disabled={!strikes.length} title={strikes.length ? undefined : 'The strike list needs the option chain'}>
                {strikes.map((x) => <option key={x} value={x}>{x}{x === chain.data?.atm ? ' (ATM)' : ''}</option>)}
              </select>
            )}
          </>
        )}
        <SessionDate value={date} onChange={changeDate} max={today} />
      </PageHeader>
      <p className="text-xs text-muted">
        Buyer / seller volume is <b>{ORDER_FLOW_METHOD}</b>: each rise of the session volume is compared with the bid/ask seen just before it — at or above the ask counts as a buyer, at or below the bid as a seller, anything else is shown as unclassified (never split 50/50).
      </p>

      <Loadable q={q} hint="Order flow is built from the minutes this app recorded; a contract starts being recorded when it is first watched.">
        {() =>
          d ? (
            <>
              <div className="grid gap-3 lg:grid-cols-3">
                <Card title={d.lastMinute ? `Last 1 minute · ${formatSessionTime(d.lastMinute.ts)}–${formatSessionTime(d.lastMinute.ts + 60_000)}` : 'Last 1 minute'} className="lg:col-span-2">
                  {d.lastMinute ? (
                    <div className="space-y-3">
                      <FlowBar flow={d.lastMinute} q={fmt} />
                      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
                        <div><div className="text-2xs text-muted">Buy volume</div><div className="font-semibold text-up tabular-nums">{fmt(d.lastMinute.buyVolume)}</div></div>
                        <div><div className="text-2xs text-muted">Sell volume</div><div className="font-semibold text-down tabular-nums">{fmt(d.lastMinute.sellVolume)}</div></div>
                        <div><div className="text-2xs text-muted">Unclassified</div><div className="font-semibold tabular-nums">{fmt(d.lastMinute.unclassified)}{d.lastMinute.unclassifiedPct !== null && <span className="ml-1 text-2xs font-normal text-muted">{formatFixed(d.lastMinute.unclassifiedPct, 0)}%</span>}</div></div>
                        <div><div className="text-2xs text-muted">Delta (buy − sell)</div><div className="font-semibold"><Chg value={u(d.lastMinute.delta)} decimals={0} /></div></div>
                        <div><div className="text-2xs text-muted">Verdict</div><div className={cx('font-semibold', flowTone(d.lastMinute.sentiment))}>{d.lastMinute.sentiment}</div></div>
                      </div>
                      <p className="text-sm text-muted">{d.signal}</p>
                    </div>
                  ) : (
                    <div className="py-6 text-center text-sm text-muted">No completed recorded minute yet for this contract.</div>
                  )}
                </Card>
                <Card
                  title={d.instrument}
                  actions={
                    <Segmented
                      size="xs"
                      value={eff}
                      onChange={setUnit}
                      options={lot ? [{ value: 'qty', label: 'Qty' }, { value: 'lots', label: 'Lots' }] : [{ value: 'qty', label: 'Qty' }]}
                    />
                  }
                >
                  <div className="space-y-3">
                    {d.currentMinute && (
                      <div>
                        <div className="mb-1 text-2xs text-muted">Current minute {formatSessionTime(d.currentMinute.ts)} · {d.currentMinute.elapsedSec}s so far (still forming)</div>
                        <FlowBar flow={d.currentMinute} q={fmt} compact />
                      </div>
                    )}
                    <div>
                      <div className="mb-1 flex justify-between text-2xs text-muted"><span>Last 5 minutes</span>{d.last5 && <span className={flowTone(d.last5.sentiment)}>{d.last5.sentiment}</span>}</div>
                      {d.last5 ? <FlowBar flow={d.last5} q={fmt} compact /> : <div className="text-2xs text-muted">No completed recorded minute yet</div>}
                    </div>
                    <div>
                      <div className="mb-1 flex justify-between text-2xs text-muted"><span>Recorded session ({d.date})</span><span className={flowTone(d.session.sentiment)}>{d.session.sentiment}</span></div>
                      <FlowBar flow={d.session} q={fmt} compact />
                      <div className="mt-1 text-2xs text-muted">Cumulative delta <Chg value={u(d.session.delta)} decimals={0} /> · total {fmt(d.session.volume)}</div>
                    </div>
                    {!lot && <div className="text-2xs text-muted">Lot size of this contract is not known: quantities are shown in units.</div>}
                  </div>
                </Card>
              </div>

              <Card title="Buy vs sell volume per minute" actions={<Segmented size="xs" value={limit} onChange={setLimit} options={[{ value: 30, label: '30m' }, { value: 60, label: '1h' }, { value: 120, label: '2h' }, { value: 375, label: 'Day' }]} />}>
                <Chart option={bars} height={340} blank={d.minutes.length ? undefined : 'No recorded minute in this window'} />
                <div className="mt-2 space-y-1">
                  <Coverage text={`${d.coverage}. Faded bars are partial minutes (recording started inside them: lower bound). Minutes without a record are absent, never filled.`} />
                  <Gaps gaps={d.gaps} />
                </div>
              </Card>
              <Card title="Delta & cumulative delta">
                <Chart option={cum} height={260} blank={d.minutes.length ? undefined : 'No recorded minute in this window'} />
              </Card>
              <Card title="Minute-by-minute (latest first)" pad={false}>
                <div className="max-h-[50vh] overflow-auto">
                  <table className="tbl">
                    <thead><tr><th>Minute</th><th className="num">Buy</th><th className="num">Sell</th><th className="num">Unclass.</th><th className="num">Total</th><th className="num">Delta</th><th>Buy % (of classified)</th><th className="num hidden sm:table-cell">Cum. delta</th><th className="num">Close</th><th className="hidden md:table-cell">Note</th></tr></thead>
                    <tbody>
                      {[...d.minutes].reverse().slice(0, 60).map((m) => (
                        <tr key={m.ts}>
                          <td>{formatSessionTime(m.ts)}</td>
                          <td className="num text-up">{fmt(m.buyVolume)}</td>
                          <td className="num text-down">{fmt(m.sellVolume)}</td>
                          <td className="num text-muted">{fmt(m.unclassified)}</td>
                          <td className="num">{fmt(m.volume)}</td>
                          <td className="num"><Chg value={u(m.delta)} decimals={0} /></td>
                          <td>
                            {m.buyPct === null ? (
                              <Dash reason="Nothing in this minute could be classified as buy or sell" />
                            ) : (
                              <div className="flex items-center gap-2">
                                <span className="relative h-1.5 w-16 overflow-hidden rounded bg-down/60"><span className="absolute inset-y-0 left-0 bg-up" style={{ width: `${m.buyPct}%` }} /></span>
                                <span className="tabular-nums">{formatFixed(m.buyPct, 0)}%</span>
                              </div>
                            )}
                          </td>
                          <td className="num hidden sm:table-cell"><Chg value={u(m.cumDelta)} decimals={0} /></td>
                          <td className="num">{isNum(m.close) ? formatIndian(m.close) : <Dash reason="No trade in this minute" />}</td>
                          <td className="hidden text-2xs text-muted md:table-cell">{noteOf(m)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
              <p className="text-2xs text-muted">Buy volume = trades at or above the ask (aggressive buyers); sell volume = trades at or below the bid; the rest is unclassified. Indices are measured on their futures.</p>
            </>
          ) : null
        }
      </Loadable>
    </div>
  );
}
