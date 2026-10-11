import { useMemo, useState } from 'react';
import { formatIndian, type OrderBookResponse } from '@q26/core';
import { Chart, axis, baseOption, timeAxis, useChartColors } from '../components/Chart';
import { OrderTicket, type TicketSpec } from '../components/OrderTicket';
import { ExpirySelect, SymbolSelect } from '../components/pickers';
import { Card, Chg, cx, Loadable, PageHeader, Segmented, Stat } from '../components/ui';
import { qs } from '../lib/api';
import { formatCompact } from '../lib/format';
import { useChain, useLive } from '../lib/hooks';
import { useApp } from '../lib/store';

export default function OrderBook() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const [type, setType] = useState<'FUT' | 'CE' | 'PE'>('FUT');
  const [expiry, setExpiry] = useState<string>();
  const [strike, setStrike] = useState<number>();
  const [ticket, setTicket] = useState<TicketSpec | null>(null);
  const chain = useChain(symbol, type === 'FUT' ? undefined : expiry, { refetch: 30000 });
  const k = type === 'FUT' ? undefined : strike && chain.data?.rows.some((r) => r.strike === strike) ? strike : chain.data?.atm;
  const q = useLive<OrderBookResponse>(['order-book', symbol, type, expiry, k], `/order-book/${symbol}${qs({ type, expiry, strike: k })}`, 1000);
  const c = useChartColors();
  const option = useMemo(() => {
    const h = q.data?.history ?? [];
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
  }, [q.data, c]);
  const d = q.data;
  const maxQty = d ? Math.max(...d.bids.map((b) => b.qty), ...d.asks.map((a) => a.qty)) : 1;
  return (
    <div className="space-y-3">
      <PageHeader title="Order Book Analytics" subtitle="Five-level market depth with order-flow metrics — imbalance, micro-price, VWAP, spread">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setStrike(undefined); }} />
        <Segmented value={type} onChange={setType} options={[{ value: 'FUT', label: 'Future' }, { value: 'CE', label: 'Call' }, { value: 'PE', label: 'Put' }]} />
        <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} futures={type === 'FUT'} />
        {type !== 'FUT' && (
          <select aria-label="Strike" className="input w-auto" value={k ?? ''} onChange={(e) => setStrike(Number(e.target.value))}>
            {(chain.data?.rows ?? []).map((r) => <option key={r.strike} value={r.strike}>{r.strike}</option>)}
          </select>
        )}
      </PageHeader>
      <Loadable q={q}>
        {(d) => (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-6">
              <Stat label={d.instrument} value={formatIndian(d.ltp)} sub={<Chg value={d.changePct} pct />} />
              <Stat label="Open / Prev close" value={`${d.open.toFixed(2)} / ${d.prevClose.toFixed(2)}`} />
              <Stat label="High / Low" value={`${d.high.toFixed(2)} / ${d.low.toFixed(2)}`} />
              <Stat label="VWAP" value={d.vwap.toFixed(2)} tone={d.ltp >= d.vwap ? 'up' : 'down'} />
              <Stat label="Circuit (L / U)" value={`${d.lowerCircuit.toFixed(1)} / ${d.upperCircuit.toFixed(1)}`} />
              <Stat label="Volume / OI" value={`${formatCompact(d.volume)} / ${formatCompact(d.oi)}`} />
            </div>
            <div className="grid gap-3 lg:grid-cols-3">
              <Card title="Market depth" pad={false}>
                <table className="tbl">
                  <thead><tr><th className="num">Orders</th><th className="num">Bid qty</th><th className="num">Bid</th><th className="num">Ask</th><th className="num">Ask qty</th><th className="num">Orders</th></tr></thead>
                  <tbody>
                    {d.bids.map((b, i) => {
                      const a = d.asks[i];
                      return (
                        <tr key={i}>
                          <td className="num text-muted">{b.orders}</td>
                          <td className="num relative"><span className="absolute inset-y-1 right-0 bg-up/15" style={{ width: `${(b.qty / maxQty) * 100}%` }} /><span className="relative">{formatCompact(b.qty)}</span></td>
                          <td className="num font-semibold text-up">{b.price.toFixed(2)}</td>
                          <td className="num font-semibold text-down">{a.price.toFixed(2)}</td>
                          <td className="num relative"><span className="absolute inset-y-1 left-0 bg-down/15" style={{ width: `${(a.qty / maxQty) * 100}%` }} /><span className="relative">{formatCompact(a.qty)}</span></td>
                          <td className="num text-muted">{a.orders}</td>
                        </tr>
                      );
                    })}
                    <tr className="font-semibold">
                      <td colSpan={2} className="num text-up">Total {formatCompact(d.totalBidQty)}</td>
                      <td colSpan={2} className="text-center text-2xs text-muted">spread {d.spread.toFixed(2)}</td>
                      <td colSpan={2} className="num text-down">Total {formatCompact(d.totalAskQty)}</td>
                    </tr>
                  </tbody>
                </table>
                <div className="flex gap-2 p-3">
                  <button className="btn-buy flex-1" onClick={() => setTicket({ symbol, type, strike: k, expiry: type === 'FUT' ? (expiry ?? '') : chain.data?.expiry ?? '', side: 'BUY', price: d.asks[0].price })}>Buy</button>
                  <button className="btn-sell flex-1" onClick={() => setTicket({ symbol, type, strike: k, expiry: type === 'FUT' ? (expiry ?? '') : chain.data?.expiry ?? '', side: 'SELL', price: d.bids[0].price })}>Sell</button>
                </div>
              </Card>
              <Card title="Order-flow analytics" className="lg:col-span-2" pad={false}>
                <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-3">
                  {d.analytics.map((a) => (
                    <div key={a.label} className="bg-panel px-3 py-2" title={a.hint}>
                      <div className="text-2xs text-muted">{a.label}</div>
                      <div className={cx('text-sm font-semibold tabular-nums', a.tone === 'up' && 'text-up', a.tone === 'down' && 'text-down')}>{a.value}</div>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
            <Card title="Depth & price through the session"><Chart option={option} height={300} /></Card>
          </>
        )}
      </Loadable>
      <OrderTicket spec={ticket} onClose={() => setTicket(null)} />
    </div>
  );
}
