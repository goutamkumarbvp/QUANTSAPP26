import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type Funds, type FuturesQuote, type InstrumentType, type Order, type Position, type Trade } from '@q26/core';
import { OrderTicket, type TicketSpec } from '../components/OrderTicket';
import { pickStrike, StrikeSelect, SymbolSelect } from '../components/pickers';
import { AsOf, Card, cx, Empty, ErrorBox, ErrorState, Field, Gaps, Loadable, PageHeader, Pill, Segmented, Stat, Val } from '../components/ui';
import { api, errorText } from '../lib/api';
import { formatDateTime, formatExpiry, formatINR, formatIndian, formatPrice, isNum, pnlClass } from '../lib/format';
import { useChain, useExpiries, useLive } from '../lib/hooks';
import { useApp } from '../lib/store';

type Tab = 'positions' | 'orders' | 'trades' | 'funds';

/** A rupee figure coloured by sign; a missing one is a muted "—" with its reason. */
function Money({ value, reason, className }: { value: number | null; reason?: string | null; className?: string }) {
  return <span className={cx(pnlClass(value), className)}><Val value={value} format={(x) => formatINR(x)} reason={reason} /></span>;
}

function NewOrder({ onTicket }: { onTicket: (t: TicketSpec) => void }) {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const [type, setType] = useState<InstrumentType>('CE');
  const [expiry, setExpiry] = useState<string>();
  const [strike, setStrike] = useState<number>();
  const exp = useExpiries(symbol);
  const isFut = type === 'FUT';
  const list = (isFut ? exp.data?.futures : exp.data?.options) ?? [];
  const e = expiry && list.includes(expiry) ? expiry : list[0];
  const chain = useChain(symbol, e, { refetch: 10000, enabled: !isFut && !!e });
  const futs = useLive<FuturesQuote[]>(['futures', symbol], `/futures/${encodeURIComponent(symbol)}`, 5000, isFut);
  const chainData = chain.data?.symbol === symbol && chain.data.expiry === e ? chain.data : undefined;
  const k = isFut ? undefined : pickStrike(chainData, strike);
  // The price shown is the live LTP of the chosen contract itself (a future's own expiry, not the nearest).
  const row = chainData?.rows.find((r) => r.strike === k);
  const optQuote = row ? (type === 'CE' ? row.ce : row.pe) : undefined;
  const price = isFut ? futs.data?.find((x) => x.expiry === e)?.ltp ?? null : optQuote?.ltp ?? null;
  // After a symbol / expiry change the previous answer stays on as placeholder while the new one loads:
  // that is loading, not "not available".
  const expLoading = exp.isLoading || (exp.isFetching && !exp.data);
  const chainLoading = chain.isLoading || chain.isPlaceholderData || (chain.isFetching && !chainData);
  const priceWhy = !e
    ? expLoading ? 'Loading the listed expiries…' : 'No listed expiry'
    : !isFut && k === undefined
      ? chainLoading ? 'Loading the strikes…' : 'No strikes: the option chain is not available'
      : 'Not traded in the live session; the order ticket shows the live bid / ask';
  // No contract chosen (no expiry, or an option without a strike): Buy / Sell are disabled and say why.
  const blocked = !e
    ? `${isFut ? 'Select an expiry' : 'Select an expiry and strike'}: ${expLoading ? 'loading the listed expiries…' : exp.error ? errorText(exp.error) : 'no expiry is listed'}`
    : !isFut && k === undefined
      ? `Select a strike: ${chainLoading ? 'loading the strikes…' : chain.error ? errorText(chain.error) : 'the option chain is not available'}`
      : null;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <SymbolSelect value={symbol} onChange={setSymbol} />
      <Segmented value={type} onChange={setType} options={[{ value: 'CE', label: 'Call' }, { value: 'PE', label: 'Put' }, { value: 'FUT', label: 'Future' }]} />
      <Field label="Expiry">
        <select className="input w-auto" value={e ?? ''} disabled={!list.length} title={list.length ? undefined : exp.error ? errorText(exp.error) : 'No listed expiry'} onChange={(ev) => setExpiry(ev.target.value)}>
          {list.map((x) => <option key={x} value={x}>{formatExpiry(x)}</option>)}
          {!list.length && <option value="">{expLoading ? 'Loading…' : 'No expiry'}</option>}
        </select>
      </Field>
      {!isFut && (
        <Field label="Strike">
          <StrikeSelect chain={chainData} value={k} onChange={setStrike} error={chainLoading ? undefined : chain.error} loading={chainLoading} />
        </Field>
      )}
      <span className="pb-2 text-sm text-muted">LTP <b className="text-ink"><Val value={price} format={formatPrice} reason={priceWhy} /></b></span>
      <button className="btn-buy" disabled={!!blocked} title={blocked ?? undefined} onClick={() => !blocked && e && onTicket({ symbol, type, strike: isFut ? undefined : k, expiry: e, side: 'BUY', price })}>Buy</button>
      <button className="btn-sell" disabled={!!blocked} title={blocked ?? undefined} onClick={() => !blocked && e && onTicket({ symbol, type, strike: isFut ? undefined : k, expiry: e, side: 'SELL', price })}>Sell</button>
      {blocked && <p className="w-full text-2xs text-muted">{blocked}</p>}
    </div>
  );
}

/** One line on the result of an exit: the orders (a position above the freeze quantity goes out in several slices) and why any was not filled. */
function exitSummary(label: string, orders: Order[]): string {
  const done = orders.filter((o) => o.status === 'COMPLETE').length;
  const bad = orders.filter((o) => o.status === 'REJECTED' || o.status === 'CANCELLED');
  const open = orders.length - done - bad.length;
  return `${label}: ${orders.length} order${orders.length === 1 ? '' : 's'}${orders.length > 1 ? ' (freeze-quantity slices)' : ''} — ${done} filled${open ? `, ${open} working` : ''}${bad.length ? `, ${bad.length} not filled: ${[...new Set(bad.map((o) => o.message ?? o.status))].join('; ')}` : ''}`;
}

export default function Positions() {
  const [tab, setTab] = useState<Tab>('positions');
  const [ticket, setTicket] = useState<TicketSpec | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<{ tone: 'up' | 'down'; text: string } | null>(null);
  const qc = useQueryClient();
  const positions = useQuery({ queryKey: ['broker', 'positions'], queryFn: () => api<Position[]>('/broker/positions'), refetchInterval: 3000 });
  const orders = useQuery({ queryKey: ['broker', 'orders'], queryFn: () => api<Order[]>('/broker/orders'), refetchInterval: 5000 });
  const trades = useQuery({ queryKey: ['broker', 'trades'], queryFn: () => api<Trade[]>('/broker/trades'), refetchInterval: 10000 });
  const funds = useQuery({ queryKey: ['broker', 'funds'], queryFn: () => api<Funds>('/broker/funds'), refetchInterval: 5000 });
  const refresh = () => qc.invalidateQueries({ queryKey: ['broker'] });
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    }
    refresh();
  };
  /** Exit positions one after the other; every answer (and every failure) is reported, none is dropped. */
  const exitPositions = (list: Position[]) =>
    act(async () => {
      const lines: string[] = [];
      let failed = false;
      for (const p of list) {
        try {
          const res = await api<Order[] | Order>('/broker/positions/exit', { body: { key: p.key } });
          const placed = Array.isArray(res) ? res : [res];
          if (placed.some((o) => o.status === 'REJECTED' || o.status === 'CANCELLED')) failed = true;
          lines.push(exitSummary(p.instrument, placed));
        } catch (e) {
          failed = true;
          lines.push(`${p.instrument}: ${errorText(e)}`);
        }
      }
      setNotice({ tone: failed ? 'down' : 'up', text: lines.join(' · ') });
    });
  const open = (positions.data ?? []).filter((p) => p.netQty !== 0);
  const exitable = open.filter((p) => p.status !== 'awaiting settlement' && p.status !== 'expired');
  const working = (orders.data ?? []).filter((o) => o.status === 'OPEN' || o.status === 'TRIGGER_PENDING');
  // Total P&L needs every position priced; one without a live price makes the total unknown (it is never partial).
  const unpriced = (positions.data ?? []).filter((p) => p.pnl === null);
  // An account with no position at all has no P&L to total: a dash with the reason, never ₹0.
  const noPositions = !!positions.data && !positions.data.length;
  const totalPnl = positions.data && !unpriced.length && !noPositions ? positions.data.reduce((a, p) => a + (p.pnl ?? 0), 0) : null;
  const totalWhy = noPositions ? 'No open positions' : unpriced.length ? `No live price for ${unpriced.map((p) => p.instrument).join(', ')}` : 'Positions have not loaded';
  const fd = funds.data;

  return (
    <div className="space-y-3">
      <PageHeader title="Positions & Orders" subtitle="Your paper-trading account — market orders fill at the live bid / ask, margin is a SPAN-style estimate on live prices" />
      <Card title="Place order"><NewOrder onTicket={setTicket} /></Card>
      {fd ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
          <Stat label="Total P&L" value={totalPnl === null ? null : formatINR(totalPnl)} reason={totalWhy} tone={totalPnl === null ? undefined : totalPnl >= 0 ? 'up' : 'down'} />
          <Stat label="Available funds" value={isNum(fd.available) ? formatINR(fd.available) : null} reason={fd.gaps?.available} />
          <Stat label="Margin used" value={isNum(fd.usedMargin) ? formatINR(fd.usedMargin) : null} reason={fd.gaps?.margin} hint="Margin estimate (SPAN-style)" />
          <Stat label="Realised P&L" value={noPositions ? null : formatINR(fd.realizedPnl)} reason="No open positions" tone={fd.realizedPnl >= 0 ? 'up' : 'down'} />
          <Stat
            label="Unrealised P&L"
            value={!open.length && positions.data ? null : isNum(fd.unrealizedPnl) ? formatINR(fd.unrealizedPnl) : null}
            reason={!open.length && positions.data ? 'No open positions' : fd.gaps?.unrealizedPnl}
            tone={isNum(fd.unrealizedPnl) ? (fd.unrealizedPnl >= 0 ? 'up' : 'down') : undefined}
          />
          <Stat label="Open positions" value={open.length} sub={`${working.length} working orders`} />
        </div>
      ) : funds.error ? (
        <ErrorState error={funds.error} compact title="Funds not available" />
      ) : null}
      {fd && <Gaps gaps={fd.gaps} />}
      {error ? <ErrorBox error={error} /> : null}
      {notice && <div className={cx('rounded-lg border px-3 py-2 text-sm', notice.tone === 'up' ? 'border-up/40 bg-up/10 text-up' : 'border-down/40 bg-down/10 text-down')} role="status">{notice.text}</div>}
      <Segmented value={tab} onChange={setTab} options={[{ value: 'positions', label: `Positions (${open.length})` }, { value: 'orders', label: `Orders (${orders.data?.length ?? 0})` }, { value: 'trades', label: `Trades (${trades.data?.length ?? 0})` }, { value: 'funds', label: 'Funds' }]} />

      {tab === 'positions' && (
        <Card pad={false} actions={exitable.length > 0 && <button className="btn-sell px-2 py-1 text-xs" onClick={() => exitPositions(exitable)}>Exit all</button>} title="Positions">
          <Loadable q={positions}>
            {(rows) => !rows.length ? <Empty>No positions yet. Trade from the option chain or the form above.</Empty> : (
              <div className="overflow-x-auto">
                <table className="tbl">
                  <thead><tr><th>Instrument</th><th>Product</th><th className="num">Net qty</th><th className="num">Avg</th><th className="num">LTP</th><th className="num">Realised</th><th className="num">Unrealised</th><th className="num">P&L</th><th></th></tr></thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr key={p.key} className={cx(p.netQty === 0 && 'opacity-60')}>
                        <td className="font-medium">
                          {p.instrument} {p.status !== 'open' && <Pill tone={p.status === 'awaiting settlement' ? 'warn' : 'muted'}>{p.status}</Pill>}
                          {p.reason && p.netQty !== 0 && <div className="max-w-[20rem] whitespace-normal text-2xs font-normal text-muted">{p.reason}</div>}
                        </td>
                        <td>{p.product}</td>
                        <td className={cx('num font-semibold', p.netQty > 0 ? 'text-up' : p.netQty < 0 ? 'text-down' : '')}>{p.netQty}</td>
                        <td className="num">{p.avgPrice.toFixed(2)}</td>
                        <td className="num">
                          <Val value={p.ltp} format={(x) => x.toFixed(2)} reason={p.reason ?? 'No live price'} />
                          <div><AsOf ts={p.ltpTs} label={p.status === 'expired' ? 'settlement' : 'LTP'} /></div>
                        </td>
                        <td className={cx('num', pnlClass(p.realized))}>{formatINR(p.realized)}</td>
                        <td className="num"><Money value={p.unrealized} reason={p.reason ?? 'No live price'} /></td>
                        <td className="num font-semibold"><Money value={p.pnl} reason={p.reason ?? 'No live price'} /></td>
                        <td>
                          {p.netQty !== 0 && (
                            <div className="flex gap-1">
                              <button className="btn-ghost px-2 py-0.5 text-xs" disabled={p.status !== 'open'} title={p.status === 'open' ? undefined : 'Expired contract'} onClick={() => setTicket({ symbol: p.symbol, type: p.type, strike: p.strike, expiry: p.expiry, side: p.netQty > 0 ? 'BUY' : 'SELL', price: p.ltp })}>Add</button>
                              <button className="btn-sell px-2 py-0.5 text-xs" disabled={p.status !== 'open'} title={p.status === 'open' ? undefined : p.status === 'awaiting settlement' ? 'Awaiting the exchange settlement price: the position closes at it' : 'Expired contract: it is settled, not exited'} onClick={() => exitPositions([p])}>Exit</button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr className="font-semibold"><td colSpan={7}>Total</td><td className="num"><Money value={totalPnl} reason={totalWhy} /></td><td></td></tr>
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
                        <td title={o.message}>
                          <Pill tone={o.status === 'COMPLETE' ? 'up' : o.status === 'REJECTED' ? 'down' : o.status === 'CANCELLED' ? 'muted' : 'accent'}>{o.status.replace('_', ' ')}</Pill>
                          {o.message && <div className="max-w-[22rem] whitespace-normal text-2xs text-muted">{o.message}</div>}
                          {(o.status === 'OPEN' || o.status === 'TRIGGER_PENDING') && o.orderType !== 'MARKET' && <div className="max-w-[22rem] whitespace-normal text-2xs text-muted">Day order: fills only while a live price allows it, cancelled at 15:30</div>}
                        </td>
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

      {tab === 'funds' && fd && (
        <Card title="Funds">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Opening balance" value={formatINR(fd.openingBalance)} />
            <Stat label="Available" value={isNum(fd.available) ? formatINR(fd.available) : null} reason={fd.gaps?.available} />
            <Stat label="Margin used" value={isNum(fd.usedMargin) ? formatINR(fd.usedMargin) : null} reason={fd.gaps?.margin} hint="Margin estimate (SPAN-style)" />
            <Stat label="Premium paid (longs)" value={formatINR(fd.premiumPaid)} />
            <Stat label="Premium received (shorts)" value={formatINR(fd.premiumReceived)} />
            <Stat label="Realised P&L" value={formatINR(fd.realizedPnl)} />
            <Stat label="Unrealised P&L" value={isNum(fd.unrealizedPnl) ? formatINR(fd.unrealizedPnl) : null} reason={fd.gaps?.unrealizedPnl} />
          </div>
          <p className="mt-2 text-2xs text-muted">Margin is an estimate (SPAN-style) on the live spot, each leg's IV solved from its live premium and the forward; it is blank while one of those is not live.</p>
          <Gaps gaps={fd.gaps} className="mt-1" />
          <button className="btn-ghost mt-4" onClick={() => confirm('Reset paper account? All orders, trades and positions will be cleared.') && act(() => api('/broker/reset', { body: {} }))}>Reset paper account</button>
        </Card>
      )}
      <OrderTicket spec={ticket} onClose={() => setTicket(null)} />
    </div>
  );
}
