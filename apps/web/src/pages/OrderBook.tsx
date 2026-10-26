import { useMemo, useState } from 'react';
import { formatExpiry, type Candle, type OrderBookResponse, type OrderFlowResponse } from '@q26/core';
import { FlowMethodNote, FlowSummary, MinuteTable, type FlowUnit } from '../components/FlowDetails';
import { OrderTradeChart, type PriceSource } from '../components/OrderTradeChart';
import { Chart, axis, baseOption, timeAxis, useChartColors } from '../components/Chart';
import { OrderTicket, type TicketSpec } from '../components/OrderTicket';
import { ExpirySelect, pickStrike, SessionDate, StrikeSelect, SymbolSelect } from '../components/pickers';
import { AsOf, Card, Chg, cx, Dash, ErrorState, Gaps, Loadable, PageHeader, Segmented, Stat, Val } from '../components/ui';
import { errorText, isNoLiveData, qs } from '../lib/api';
import { formatCompact, formatIndian, isNum } from '../lib/format';
import { useChain, useLive } from '../lib/hooks';
import { useApp, useTicks } from '../lib/store';
import { useSubscribe } from '../lib/ws';

/** "a / b" of two figures, each "—" when missing; null when both are. */
function pair(a: number | null, b: number | null, f: (x: number) => string = (x) => x.toFixed(2)): string | null {
  return isNum(a) || isNum(b) ? `${isNum(a) ? f(a) : '—'} / ${isNum(b) ? f(b) : '—'}` : null;
}

/**
 * Order Flow & Book: one page per contract for everything built from its live ticks — the Order & Trade
 * chart (the security's price, buyer vs seller initiated quantity per minute, cumulative delta), the
 * last-minute / session split, five-level market depth (live only) and the minute table. A past session
 * (date picker) replays its recorded minutes; depth exists only live.
 */
export default function OrderBook() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const today = useTicks((s) => s.clock?.date);
  const [type, setTypeRaw] = useState<'FUT' | 'CE' | 'PE'>('FUT');
  const [expiry, setExpiry] = useState<string>();
  const [strike, setStrike] = useState<number>();
  const [date, setDate] = useState('');
  const [unit, setUnit] = useState<FlowUnit>('qty');
  // Past sessions list their own contracts (from the response); today's come from the live chain.
  const [pastExpiry, setPastExpiry] = useState<string>();
  const [pastStrike, setPastStrike] = useState<number>();
  const isPast = !!date && !!today && date < today;
  const [ticket, setTicket] = useState<TicketSpec | null>(null);
  const setType = (t: 'FUT' | 'CE' | 'PE') => {
    // Futures and options list different expiries: start each from its own nearest one.
    if ((t === 'FUT') !== (type === 'FUT')) {
      setExpiry(undefined);
      setStrike(undefined);
      setPastExpiry(undefined);
      setPastStrike(undefined);
    }
    setTypeRaw(t);
  };
  const changeDate = (v: string) => {
    setDate(v);
    setPastExpiry(undefined);
    setPastStrike(undefined);
  };
  // The chain only lists the strikes to choose from.
  const chain = useChain(symbol, expiry, { refetch: 30000, enabled: type !== 'FUT' });
  const chainData = chain.data?.symbol === symbol ? chain.data : undefined;
  const k = type === 'FUT' ? undefined : pickStrike(chainData, strike);
  // For options wait for the strike, so the book and the flow are for the same contract.
  const ready = type === 'FUT' || k !== undefined;
  // Market depth exists only live.
  const q = useLive<OrderBookResponse>(['order-book', symbol, type, expiry, k], `/order-book/${symbol}${qs({ type, expiry, strike: k })}`, 1000, ready && !isPast);
  // The whole session, minute by minute: the Order & Trade chart, the summary and the minute table.
  const reqExpiry = isPast ? pastExpiry : expiry;
  const reqStrike = type === 'FUT' ? undefined : isPast ? pastStrike : k;
  const trade = useLive<OrderFlowResponse>(
    ['order-trade', symbol, type, reqExpiry, reqStrike, ...(isPast ? [date] : [])],
    `/order-flow/${symbol}${qs({ type, expiry: reqExpiry, strike: reqStrike, date: isPast ? date : undefined, limit: 375 })}`,
    isPast ? false : 2000,
    isPast || ready,
  );
  const tradeData = trade.isPlaceholderData || isNoLiveData(trade.error) ? undefined : trade.data;
  // The security itself on top of the chart (today): its recorded 1-minute candles and its live price.
  const spot = useLive<Candle[]>(['order-trade-spot', symbol], `/candles/${symbol}${qs({ interval: '1', days: 1 })}`, 5000, !isPast);
  const spotLive = useTicks((s) => s.quotes[symbol]);
  useSubscribe([symbol]);
  const price: PriceSource | undefined = isPast ? undefined : {
    label: symbol,
    candles: spot.isPlaceholderData ? undefined : spot.data,
    error: spot.error ? errorText(spot.error) : undefined,
    live: spotLive && isNum(spotLive.ltp) ? { ltp: spotLive.ltp, ts: spotLive.ts } : null,
  };
  const c = useChartColors();
  // Depth of another contract (kept while the new one loads) is never shown as this one's.
  const d = q.isPlaceholderData || isNoLiveData(q.error) ? undefined : q.data;
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
      <PageHeader title="Order Flow & Book" subtitle="Every live tick of one contract: the Order & Trade chart (price, buyer vs seller initiated quantity per minute, cumulative delta), the session split, market depth and the minute table">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setStrike(undefined); setPastExpiry(undefined); setPastStrike(undefined); }} />
        <Segmented value={type} onChange={setType} options={[{ value: 'FUT', label: 'Future' }, { value: 'CE', label: 'Call' }, { value: 'PE', label: 'Put' }]} />
        {isPast ? (
          <>
            <select aria-label="Expiry" className="input w-auto" value={tradeData?.expiry ?? ''} onChange={(e) => { setPastExpiry(e.target.value); setPastStrike(undefined); }}>
              {(tradeData?.expiries ?? []).map((x) => <option key={x} value={x}>{formatExpiry(x)}</option>)}
            </select>
            {type !== 'FUT' && (
              <select aria-label="Strike" className="input w-auto" value={tradeData?.strike ?? ''} onChange={(e) => setPastStrike(Number(e.target.value))}>
                {(tradeData?.strikes ?? []).map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            )}
          </>
        ) : (
          <>
            <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} futures={type === 'FUT'} />
            {type !== 'FUT' && <StrikeSelect chain={chainData} value={k} onChange={setStrike} error={chain.error} loading={chain.isLoading} />}
          </>
        )}
        <SessionDate value={date} onChange={changeDate} max={today} />
        <Segmented value={unit} onChange={setUnit} options={tradeData?.lotSize ? [{ value: 'qty', label: 'Qty' }, { value: 'lots', label: 'Lots' }] : [{ value: 'qty', label: 'Qty' }]} />
      </PageHeader>
      <FlowMethodNote />
      {tradeData ? (
        <>
          <OrderTradeChart d={tradeData} price={price} unit={unit} />
          <FlowSummary d={tradeData} unit={unit} />
        </>
      ) : trade.error ? (
        <Card title="Order & Trade chart"><ErrorState error={trade.error} compact title="No order flow for this contract" /></Card>
      ) : null}
      {isPast ? (
        <div className="rounded-lg border border-line px-3 py-2 text-xs text-muted" role="status">Market depth is live only: it is not recorded, so a past session ({date}) shows its recorded minutes only.</div>
      ) : (
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
            <Card title="Depth & price through the session">
              <Chart option={option} height={300} blank={d.history.length ? undefined : d.gaps?.history ?? 'Nothing is recorded for this contract yet. The history is built from the recorder\'s minutes only (one point per 5 minutes), never filled in.'} />
              {d.history.length > 0 && <div className="mt-1 text-2xs text-muted">Recorded minutes only (one point per 5 minutes); a minute without a record is a gap in the line.</div>}
            </Card>
          </>
        )}
      </Loadable>
      )}
      {tradeData && <MinuteTable d={tradeData} unit={unit} />}
      <OrderTicket spec={ticket} onClose={() => setTicket(null)} />
    </div>
  );
}
