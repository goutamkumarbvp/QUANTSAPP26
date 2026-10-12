import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatINR, formatIndian, type Funds, type InstrumentType, type Order, type Position, type Trade } from '@q26/core';
import { OrderTicket, type TicketSpec } from '../components/OrderTicket';
import { SymbolSelect } from '../components/pickers';
import { Card, cx, Empty, ErrorBox, Field, Loadable, PageHeader, Pill, Segmented, Stat } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime, pnlClass } from '../lib/format';
import { useChain, useExpiries } from '../lib/hooks';
import { useApp } from '../lib/store';

type Tab = 'positions' | 'orders' | 'trades' | 'funds';

function NewOrder({ onTicket }: { onTicket: (t: TicketSpec) => void }) {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const [type, setType] = useState<InstrumentType>('CE');
  const [expiry, setExpiry] = useState<string>();
  const [strike, setStrike] = useState<number>();
  const exp = useExpiries(symbol);
  const list = (type === 'FUT' ? exp.data?.futures : exp.data?.options) ?? [];
  const e = expiry && list.includes(expiry) ? expiry : list[0];
  const chain = useChain(symbol, type === 'FUT' ? undefined : e, { refetch: 10000 });
  const strikes = chain.data?.rows.map((r) => r.strike) ?? [];
  const k = strike && strikes.includes(strike) ? strike : chain.data?.atm;
  const price = type === 'FUT' ? chain.data?.future : chain.data?.rows.find((r) => r.strike === k)?.[type === 'CE' ? 'ce' : 'pe'].ltp;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <SymbolSelect value={symbol} onChange={setSymbol} />
      <Segmented value={type} onChange={setType} options={[{ value: 'CE', label: 'Call' }, { value: 'PE', label: 'Put' }, { value: 'FUT', label: 'Future' }]} />
      <Field label="Expiry">
        <select className="input w-auto" value={e ?? ''} onChange={(ev) => setExpiry(ev.target.value)}>
          {list.map((x) => <option key={x} value={x}>{x}</option>)}
        </select>
      </Field>
      {type !== 'FUT' && (
        <Field label="Strike">
          <select className="input w-auto" value={k ?? ''} onChange={(ev) => setStrike(Number(ev.target.value))}>
            {strikes.map((x) => <option key={x} value={x}>{x}{x === chain.data?.atm ? ' (ATM)' : ''}</option>)}
          </select>
        </Field>
      )}
      <span className="pb-2 text-sm text-muted">LTP <b className="text-ink">{price?.toFixed(2) ?? '—'}</b></span>
      <button className="btn-buy" disabled={!e} onClick={() => e && onTicket({ symbol, type, strike: type === 'FUT' ? undefined : k, expiry: e, side: 'BUY', price })}>Buy</button>
      <button className="btn-sell" disabled={!e} onClick={() => e && onTicket({ symbol, type, strike: type === 'FUT' ? undefined : k, expiry: e, side: 'SELL', price })}>Sell</button>
    </div>
  );
}

export default function Positions() {
  const [tab, setTab] = useState<Tab>('positions');
  const [ticket, setTicket] = useState<TicketSpec | null>(null);
  const [error, setError] = useState<unknown>(null);
  const qc = useQueryClient();
  const positions = useQuery({ queryKey: ['broker', 'positions'], queryFn: () => api<Position[]>('/broker/positions'), refetchInterval: 3000 });
  const orders = useQuery({ queryKey: ['broker', 'orders'], queryFn: () => api<Order[]>('/broker/orders'), refetchInterval: 5000 });
  const trades = useQuery({ queryKey: ['broker', 'trades'], queryFn: () => api<Trade[]>('/broker/trades'), refetchInterval: 10000 });
  const funds = useQuery({ queryKey: ['broker', 'funds'], queryFn: () => api<Funds>('/broker/funds'), refetchInterval: 5000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['broker'] });
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    }
    refresh();
  };
  const open = (positions.data ?? []).filter((p) => p.netQty !== 0);
  const totalPnl = (positions.data ?? []).reduce((a, p) => a + p.pnl, 0);
  const working = (orders.data ?? []).filter((o) => o.status === 'OPEN' || o.status === 'TRIGGER_PENDING');

  return (
    <div className="space-y-3">
      <PageHeader title="Positions & Orders" subtitle="Your paper-trading account — virtual ₹10 lakh capital, real-time simulated fills, SPAN-style margin" />
      <Card title="Place order"><NewOrder onTicket={setTicket} /></Card>
      {funds.data && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          <Stat label="Total P&L" value={formatINR(totalPnl)} tone={totalPnl >= 0 ? 'up' : 'down'} />
          <Stat label="Available funds" value={formatINR(funds.data.available)} />
          <Stat label="Margin used" value={formatINR(funds.data.usedMargin)} />
          <Stat label="Realised P&L" value={formatINR(funds.data.realizedPnl)} tone={funds.data.realizedPnl >= 0 ? 'up' : 'down'} />
          <Stat label="Unrealised P&L" value={formatINR(funds.data.unrealizedPnl)} tone={funds.data.unrealizedPnl >= 0 ? 'up' : 'down'} />
          <Stat label="Open positions" value={open.length} sub={`${working.length} working orders`} />
        </div>
      )}
      {error ? <ErrorBox error={error} /> : null}
      <Segmented value={tab} onChange={setTab} options={[{ value: 'positions', label: `Positions (${open.length})` }, { value: 'orders', label: `Orders (${orders.data?.length ?? 0})` }, { value: 'trades', label: `Trades (${trades.data?.length ?? 0})` }, { value: 'funds', label: 'Funds' }]} />

      {tab === 'positions' && (
        <Card pad={false} actions={open.length > 0 && <button className="btn-sell px-2 py-1 text-xs" onClick={() => act(async () => { for (const p of open) await api('/broker/positions/exit', { body: { key: p.key } }); })}>Exit all</button>} title="Positions">
          <Loadable q={positions}>
            {(rows) => !rows.length ? <Empty>No positions yet. Trade from the option chain or the form above.</Empty> : (
              <div className="overflow-x-auto">
                <table className="tbl">
                  <thead><tr><th>Instrument</th><th>Product</th><th className="num">Net qty</th><th className="num">Avg</th><th className="num">LTP</th><th className="num">Realised</th><th className="num">Unrealised</th><th className="num">P&L</th><th></th></tr></thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr key={p.key} className={cx(p.netQty === 0 && 'opacity-60')}>
                        <td className="font-medium">{p.instrument} {p.status !== 'open' && <Pill>{p.status}</Pill>}</td>
                        <td>{p.product}</td>
                        <td className={cx('num font-semibold', p.netQty > 0 ? 'text-up' : p.netQty < 0 ? 'text-down' : '')}>{p.netQty}</td>
                        <td className="num">{p.avgPrice.toFixed(2)}</td>
                        <td className="num">{p.ltp.toFixed(2)}</td>
                        <td className={cx('num', pnlClass(p.realized))}>{formatINR(p.realized)}</td>
                        <td className={cx('num', pnlClass(p.unrealized))}>{formatINR(p.unrealized)}</td>
                        <td className={cx('num font-semibold', pnlClass(p.pnl))}>{formatINR(p.pnl)}</td>
                        <td>
                          {p.netQty !== 0 && (
                            <div className="flex gap-1">
                              <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => setTicket({ symbol: p.symbol, type: p.type, strike: p.strike, expiry: p.expiry, side: p.netQty > 0 ? 'BUY' : 'SELL', price: p.ltp })}>Add</button>
                              <button className="btn-sell px-2 py-0.5 text-xs" onClick={() => act(() => api('/broker/positions/exit', { body: { key: p.key } }))}>Exit</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr className="font-semibold"><td colSpan={7}>Total</td><td className={cx('num', pnlClass(totalPnl))}>{formatINR(totalPnl)}</td><td></td></tr>
                  </tbody>
                </table>
              </div>
            )}
          </Loadable>
        </Card>
      )}

      {tab === 'orders' && (
        <Card pad={false} title="Order book">
          <Loadable q={orders}>
            {(rows) => !rows.length ? <Empty>No orders yet.</Empty> : (
              <div className="overflow-x-auto">
                <table className="tbl">
                  <thead><tr><th>Time</th><th>Instrument</th><th>Side</th><th className="num">Qty</th><th>Type</th><th className="num">Price</th><th className="num">Avg</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    {rows.map((o) => (
                      <tr key={o.id}>
                        <td className="text-muted">{formatDateTime(o.createdAt)}</td>
                        <td className="font-medium">{o.instrument}{o.tag?.startsWith('algo:') && <Link to="/algo" className="ml-1.5" title={`Placed by algo ${o.tag.slice(5)}`}><Pill tone="accent">Algo</Pill></Link>}</td>
                        <td className={o.side === 'BUY' ? 'text-up' : 'text-down'}>{o.side}</td>
                        <td className="num">{o.quantity}</td>
                        <td>{o.orderType} · {o.product}</td>
                        <td className="num">{o.price ? o.price.toFixed(2) : o.triggerPrice ? `trg ${o.triggerPrice.toFixed(2)}` : 'MKT'}</td>
                        <td className="num">{o.avgPrice ? o.avgPrice.toFixed(2) : '—'}</td>
                        <td title={o.message}><Pill tone={o.status === 'COMPLETE' ? 'up' : o.status === 'REJECTED' ? 'down' : o.status === 'CANCELLED' ? 'muted' : 'accent'}>{o.status.replace('_', ' ')}</Pill>{o.message && <div className="max-w-[18rem] truncate text-2xs text-muted">{o.message}</div>}</td>
                        <td>{(o.status === 'OPEN' || o.status === 'TRIGGER_PENDING') && <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => act(() => api(`/broker/orders/${o.id}`, { method: 'DELETE' }))}>Cancel</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Loadable>
        </Card>
      )}

      {tab === 'trades' && (
        <Card pad={false} title="Trade book">
          <Loadable q={trades}>
            {(rows) => !rows.length ? <Empty>No trades yet.</Empty> : (
              <div className="overflow-x-auto">
                <table className="tbl">
                  <thead><tr><th>Time</th><th>Trade ID</th><th>Instrument</th><th>Side</th><th className="num">Qty</th><th className="num">Price</th><th className="num">Value</th></tr></thead>
                  <tbody>
                    {rows.map((t) => (
                      <tr key={t.id}>
                        <td className="text-muted">{formatDateTime(t.ts)}</td>
                        <td className="text-muted">{t.id}</td>
                        <td className="font-medium">{t.instrument}</td>
                        <td className={t.side === 'BUY' ? 'text-up' : 'text-down'}>{t.side}</td>
                        <td className="num">{t.quantity}</td>
                        <td className="num">{t.price.toFixed(2)}</td>
                        <td className="num">{formatIndian(t.price * t.quantity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Loadable>
        </Card>
      )}

      {tab === 'funds' && funds.data && (
        <Card title="Funds">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Opening balance" value={formatINR(funds.data.openingBalance)} />
            <Stat label="Available" value={formatINR(funds.data.available)} />
            <Stat label="Margin used" value={formatINR(funds.data.usedMargin)} />
            <Stat label="Premium paid (longs)" value={formatINR(funds.data.premiumPaid)} />
            <Stat label="Premium received (shorts)" value={formatINR(funds.data.premiumReceived)} />
            <Stat label="Realised P&L" value={formatINR(funds.data.realizedPnl)} />
            <Stat label="Unrealised P&L" value={formatINR(funds.data.unrealizedPnl)} />
          </div>
          <button className="btn-ghost mt-4" onClick={() => confirm('Reset paper account? All orders, trades and positions will be cleared.') && act(() => api('/broker/reset', { body: {} }))}>Reset paper account</button>
        </Card>
      )}
      <OrderTicket spec={ticket} onClose={() => setTicket(null)} />
    </div>
  );
}
