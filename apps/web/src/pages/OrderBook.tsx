import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { type OrderBookResponse, type OrderFlowResponse } from '@q26/core';
import { FlowSplit } from '../components/trend';
import { OrderTradeChart } from '../components/OrderTradeChart';
import { Chart, axis, baseOption, timeAxis, useChartColors } from '../components/Chart';
import { OrderTicket, type TicketSpec } from '../components/OrderTicket';
import { ExpirySelect, pickStrike, StrikeSelect, SymbolSelect } from '../components/pickers';
import { AsOf, Card, Chg, Coverage, cx, Dash, ErrorState, flowTone, Gaps, Loadable, PageHeader, Segmented, Stat, Val } from '../components/ui';
import { isNoLiveData, qs } from '../lib/api';
import { formatCompact, formatIndian, formatSessionTime, isNum } from '../lib/format';
import { useChain, useLive } from '../lib/hooks';
import { useApp } from '../lib/store';

/** "a / b" of two figures, each "—" when missing; null when both are. */
function pair(a: number | null, b: number | null, f: (x: number) => string = (x) => x.toFixed(2)): string | null {
  return isNum(a) || isNum(b) ? `${isNum(a) ? f(a) : '—'} / ${isNum(b) ? f(b) : '—'}` : null;
}

export default function OrderBook() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const [type, setType] = useState<'FUT' | 'CE' | 'PE'>('FUT');
  const [expiry, setExpiry] = useState<string>();
  const [strike, setStrike] = useState<number>();
  const [ticket, setTicket] = useState<TicketSpec | null>(null);
  // The chain only lists the strikes to choose from.
  const chain = useChain(symbol, expiry, { refetch: 30000, enabled: type !== 'FUT' });
  const chainData = chain.data?.symbol === symbol ? chain.data : undefined;
  const k = type === 'FUT' ? undefined : pickStrike(chainData, strike);
  // For options wait for the strike, so the book and the flow are for the same contract.
  const ready = type === 'FUT' || k !== undefined;
  const q = useLive<OrderBookResponse>(['order-book', symbol, type, expiry, k], `/order-book/${symbol}${qs({ type, expiry, strike: k })}`, 1000, ready);
  const flow = useLive<OrderFlowResponse>(['order-flow', symbol, type, expiry, k, '', 5], `/order-flow/${symbol}${qs({ type, expiry, strike: k, limit: 5 })}`, 2000, ready);
  // The whole session, minute by minute, for the Order & Trade chart.
  const trade = useLive<OrderFlowResponse>(['order-trade', symbol, type, expiry, k], `/order-flow/${symbol}${qs({ type, expiry, strike: k, limit: 375 })}`, 5000, ready);
  const tradeData = trade.isPlaceholderData || isNoLiveData(trade.error) ? undefined : trade.data;
  const c = useChartColors();
  // Depth of another contract (kept while the new one loads) is never shown as this one's.
  const d = q.isPlaceholderData || isNoLiveData(q.error) ? undefined : q.data;
  const f = flow.isPlaceholderData || isNoLiveData(flow.error) ? undefined : flow.data;
  const option = useMemo(() => {
    const h = d?.history ?? [];
    return {
      ...baseOption(c),
      xAxis: timeAxis(c),
      yAxis: [
        { type: 'value', ...axis(c), axisLabel: { color: c.muted, formatter: (v: number) => formatCompact(v) } },
        { type: 'value', scale: true, ...axis(c, { splitLine: { show: false } }) },
      ],
      series: [
        { name: 'Bid qty', type: 'line', symbol: 'none', itemStyle: { color: c.up }, areaStyle: { opacity: 0.08 }, data: h.map((p) => [p.ts, p.bidQty]) },
        { name: 'Ask qty', type: 'line', symbol: 'none', itemStyle: { color: c.down }, areaStyle: { opacity: 0.08 }, data: h.map((p) => [p.ts, p.askQty]) },
        { name: 'LTP', type: 'line', yAxisIndex: 1, symbol: 'none', itemStyle: { color: c.accent }, data: h.map((p) => [p.ts, p.ltp]) },
        { name: 'VWAP', type: 'line', yAxisIndex: 1, symbol: 'none', lineStyle: { type: 'dashed' }, itemStyle: { color: c.warn }, data: h.map((p) => [p.ts, p.vwap]) },
      ],
    };
  }, [d, c]);
  const levels = d ? Math.max(d.bids.length, d.asks.length) : 0;
  const maxQty = d ? Math.max(0, ...d.bids.map((b) => b.qty), ...d.asks.map((a) => a.qty)) : 0;
  const width = (qty: number) => (maxQty > 0 ? `${(qty / maxQty) * 100}%` : '0%');
  const spec = (side: 'BUY' | 'SELL'): TicketSpec | null =>
    d ? { symbol, type: d.type, strike: d.strike, expiry: d.expiry, side, price: side === 'BUY' ? d.asks[0]?.price ?? null : d.bids[0]?.price ?? null } : null;
  const why = {
    ltp: 'Not traded in the live session',
    prev: 'The previous close is not available',
    ohlc: 'Day open / high / low are not reported by the feed yet',
    vwap: 'The exchange average traded price is not reported yet',
    circuit: 'The circuit limits are not reported by the feed',
    volOi: 'Volume / open interest are not reported by the feed yet',
  };
  return (
    <div className="space-y-3">
      <PageHeader title="Order Book Analytics" subtitle="Five-level market depth with order-flow metrics, and the Order & Trade chart: buyer vs seller initiated quantity per minute against the price">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setStrike(undefined); }} />
        <Segmented value={type} onChange={setType} options={[{ value: 'FUT', label: 'Future' }, { value: 'CE', label: 'Call' }, { value: 'PE', label: 'Put' }]} />
        <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} futures={type === 'FUT'} />
        {type !== 'FUT' && <StrikeSelect chain={chainData} value={k} onChange={setStrike} error={chain.error} loading={chain.isLoading} />}
      </PageHeader>
      <Loadable q={{ data: d, isLoading: q.isLoading || (q.isPlaceholderData && !isNoLiveData(q.error)), error: q.error }} hint="The depth stream for this contract is requested from the feed when the page opens; the first book can take a few seconds. Nothing is shown until the feed has sent real depth.">
        {(d) => (
          <>
            {!d.bookLive && (
              <div className="rounded-lg border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-warn" role="status">
                This is the last book the feed sent (<AsOf ts={d.bookTs} label="as of" />), not a live one: the session is closed or the book is older than 10 s.
              </div>
            )}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-6">
              <Stat label={d.instrument} value={isNum(d.ltp) ? formatIndian(d.ltp) : null} reason={why.ltp} sub={<span><Chg value={d.changePct} pct reason={why.prev} /> <AsOf ts={d.bookTs} label="book" /></span>} />
              <Stat label="Open / Prev close" value={pair(d.open, d.prevClose)} reason={d.open === null ? why.ohlc : why.prev} />
              <Stat label="High / Low" value={pair(d.high, d.low)} reason={why.ohlc} />
              <Stat label="VWAP" value={isNum(d.vwap) ? d.vwap.toFixed(2) : null} reason={why.vwap} tone={isNum(d.vwap) && isNum(d.ltp) ? (d.ltp >= d.vwap ? 'up' : 'down') : undefined} sub="exchange average traded price" />
              <Stat label="Circuit (L / U)" value={pair(d.lowerCircuit, d.upperCircuit, (x) => x.toFixed(1))} reason={why.circuit} />
              <Stat label="Volume / OI" value={pair(d.volume, d.oi, formatCompact)} reason={why.volOi} />
            </div>
            <div className="grid gap-3 lg:grid-cols-3">
              <Card title="Market depth" pad={false}>
                <table className="tbl">
                  <thead><tr><th className="num">Orders</th><th className="num">Bid qty</th><th className="num">Bid</th><th className="num">Ask</th><th className="num">Ask qty</th><th className="num">Orders</th></tr></thead>
                  <tbody>
                    {Array.from({ length: levels }, (_, i) => {
                      // The levels as the feed sent them: a missing level stays empty, never padded.
                      const b = d.bids[i];
                      const a = d.asks[i];
                      return (
                        <tr key={i}>
                          <td className="num text-muted">{b ? <Val value={b.orders} reason="The feed did not send the order count" /> : <Dash />}</td>
                          <td className="num relative">{b ? <><span className="absolute inset-y-1 right-0 bg-up/15" style={{ width: width(b.qty) }} /><span className="relative">{formatCompact(b.qty)}</span></> : <Dash />}</td>
                          <td className="num font-semibold text-up">{b ? b.price.toFixed(2) : <Dash />}</td>
                          <td className="num font-semibold text-down">{a ? a.price.toFixed(2) : <Dash />}</td>
                          <td className="num relative">{a ? <><span className="absolute inset-y-1 left-0 bg-down/15" style={{ width: width(a.qty) }} /><span className="relative">{formatCompact(a.qty)}</span></> : <Dash />}</td>
                          <td className="num text-muted">{a ? <Val value={a.orders} reason="The feed did not send the order count" /> : <Dash />}</td>
                        </tr>
                      );
                    })}
                    {!levels && <tr><td colSpan={6} className="py-4 text-center text-muted">The feed sent no depth levels for this contract</td></tr>}
                    <tr className="font-semibold">
                      <td colSpan={2} className="num text-up" title="Total pending buy quantity reported by the exchange">Total <Val value={d.totalBidQty} format={formatCompact} reason="The feed did not send the total bid quantity" /></td>
                      <td colSpan={2} className="text-center text-2xs text-muted">spread <Val value={d.spread} format={(x) => x.toFixed(2)} reason="Needs a best bid and a best ask" /></td>
                      <td colSpan={2} className="num text-down" title="Total pending sell quantity reported by the exchange">Total <Val value={d.totalAskQty} format={formatCompact} reason="The feed did not send the total ask quantity" /></td>
                    </tr>
                  </tbody>
                </table>
                <div className="flex gap-2 p-3">
                  <button className="btn-buy flex-1" onClick={() => setTicket(spec('BUY'))}>Buy</button>
                  <button className="btn-sell flex-1" onClick={() => setTicket(spec('SELL'))}>Sell</button>
                </div>
              </Card>
              <Card title="Order-flow analytics" className="lg:col-span-2" pad={false}>
                {d.analytics.length ? (
                  <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3">
                    {d.analytics.map((a) => (
                      <div key={a.label} className="bg-panel px-3 py-2" title={a.hint}>
                        <div className="text-2xs text-muted">{a.label}</div>
                        <div className={cx('text-sm font-semibold tabular-nums', a.tone === 'up' && 'text-up', a.tone === 'down' && 'text-down')}><Val value={a.value} reason={a.hint ?? 'An input of this figure is not available'} /></div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="p-3 text-xs text-muted">No derived figure is available for this contract yet.</div>
                )}
                <div className="space-y-0.5 border-t border-line px-3 py-2">
                  <div className="text-2xs text-muted">Derived from the live depth; a figure is blank when one of its inputs is missing.</div>
                  <Gaps gaps={d.gaps} omit={['history']} />
                </div>
              </Card>
            </div>
            {f ? (
              <Card title={`1-minute order flow — ${f.instrument}`} actions={<Link to="/order-flow" className="text-xs text-accent">Full order flow →</Link>}>
                <div className="grid gap-4 md:grid-cols-3">
                  <div>
                    <div className="mb-1 flex justify-between text-2xs text-muted">
                      <span>Last minute {f.lastMinute ? `${formatSessionTime(f.lastMinute.ts)}–${formatSessionTime(f.lastMinute.ts + 60_000)}` : ''}</span>
                      {f.lastMinute && <span className={flowTone(f.lastMinute.sentiment)}>{f.lastMinute.sentiment}</span>}
                    </div>
                    {f.lastMinute ? <FlowSplit flow={f.lastMinute} /> : <div className="text-xs text-muted">No completed recorded minute yet</div>}
                  </div>
                  <div>
                    <div className="mb-1 text-2xs text-muted">Current minute {f.currentMinute ? `(${f.currentMinute.elapsedSec}s)` : ''}</div>
                    {f.currentMinute ? <FlowSplit flow={f.currentMinute} /> : <div className="text-xs text-muted">—</div>}
                  </div>
                  <div>
                    <div className="mb-1 flex justify-between text-2xs text-muted"><span>Last 5 minutes</span>{f.last5 && <span className={flowTone(f.last5.sentiment)}>{f.last5.sentiment}</span>}</div>
                    {f.last5 ? <FlowSplit flow={f.last5} /> : <div className="text-xs text-muted">No recorded minute yet</div>}
                  </div>
                </div>
                <div className="mt-3 space-y-0.5">
                  <div className="text-2xs text-muted">Buyers / sellers are {f.method}; trades that cannot be classified are shown apart.</div>
                  <Coverage text={f.coverage} label="Covers" />
                  <Gaps gaps={f.gaps} />
                </div>
              </Card>
            ) : flow.error ? (
              <Card title="1-minute order flow"><ErrorState error={flow.error} compact title="No order flow" /></Card>
            ) : null}
            <Card title="Depth & price through the session">
              <Chart option={option} height={300} blank={d.history.length ? undefined : d.gaps?.history ?? 'Nothing is recorded for this contract yet. The history is built from the recorder\'s minutes only (one point per 5 minutes), never filled in.'} />
              {d.history.length > 0 && <div className="mt-1 text-2xs text-muted">Recorded minutes only (one point per 5 minutes); a minute without a record is a gap in the line.</div>}
            </Card>
          </>
        )}
      </Loadable>
      <div className="mt-3">
        {tradeData ? (
          <OrderTradeChart d={tradeData} />
        ) : trade.error ? (
          <Card title="Order & Trade chart"><ErrorState error={trade.error} compact title="No order & trade data" /></Card>
        ) : null}
      </div>
      <OrderTicket spec={ticket} onClose={() => setTicket(null)} />
    </div>
  );
}
