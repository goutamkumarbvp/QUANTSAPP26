import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { FuturesQuote, InstrumentType, Order, OrderType, ProductType, Side } from '@q26/core';
import { api } from '../lib/api';
import { formatExpiry, formatINR, formatPrice, isNum } from '../lib/format';
import { useChain, useLive, useSymbolInfo } from '../lib/hooks';
import { useTicks } from '../lib/store';
import { AsOf, cx, ErrorState, Field, Modal, Segmented, Val } from './ui';

export interface TicketSpec {
  symbol: string;
  type: InstrumentType;
  strike?: number;
  expiry: string;
  side: Side;
  /** Last live price the caller already has (e.g. the chain row's LTP); never an invented one. */
  price?: number | null;
}

interface TicketQuote {
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  ts: number | null;
}

/** Live quote of the ticket's contract: the option chain row, or the future's row. Null values stay null. */
function useTicketQuote(spec: TicketSpec): { quote: TicketQuote | null; lotSize: number | null; error: unknown; loading: boolean } {
  const isFut = spec.type === 'FUT';
  const chain = useChain(spec.symbol, spec.expiry, { enabled: !isFut });
  const futs = useLive<FuturesQuote[]>(['futures', spec.symbol], `/futures/${encodeURIComponent(spec.symbol)}`, 3000, isFut);
  if (isFut) {
    const f = futs.data?.find((x) => x.expiry === spec.expiry);
    return { quote: f ? { ltp: f.ltp, bid: null, ask: null, ts: f.ts } : null, lotSize: null, error: futs.error, loading: futs.isLoading };
  }
  // keepPreviousData can still hold another symbol's / expiry's chain while this one loads: ignore it.
  const row = chain.data && chain.data.symbol === spec.symbol && chain.data.expiry === spec.expiry ? chain.data.rows.find((r) => r.strike === spec.strike) : undefined;
  const q = row ? (spec.type === 'CE' ? row.ce : row.pe) : null;
  return { quote: q ? { ltp: q.ltp, bid: q.bid, ask: q.ask, ts: q.ts } : null, lotSize: chain.data && chain.data.symbol === spec.symbol ? chain.data.lotSize : null, error: chain.error, loading: chain.isLoading };
}

/** A starting limit price: a real, positive live price as text, else empty — never an invented one. */
export function suggestedPrice(...candidates: Array<number | null | undefined>): string {
  const px = candidates.find((c): c is number => isNum(c) && c > 0);
  return px === undefined ? '' : px.toFixed(2);
}

/** Order ticket for one contract. The form starts fresh for every contract / side it is opened for. */
export function OrderTicket({ spec, onClose, onAddToBuilder }: { spec: TicketSpec | null; onClose: () => void; onAddToBuilder?: (side: Side, lots: number) => void }) {
  if (!spec) return null;
  return <TicketForm key={`${spec.symbol}|${spec.type}|${spec.strike ?? ''}|${spec.expiry}|${spec.side}`} spec={spec} onClose={onClose} onAddToBuilder={onAddToBuilder} />;
}

function TicketForm({ spec, onClose, onAddToBuilder }: { spec: TicketSpec; onClose: () => void; onAddToBuilder?: (side: Side, lots: number) => void }) {
  const qc = useQueryClient();
  const info = useSymbolInfo(spec.symbol);
  const clock = useTicks((s) => s.clock);
  const live = useTicketQuote(spec);
  const [side, setSide] = useState<Side>(spec.side);
  const [lots, setLots] = useState(1);
  const [orderType, setOrderType] = useState<OrderType>('MARKET');
  const [product, setProduct] = useState<ProductType>('NRML');
  const [price, setPrice] = useState(suggestedPrice(spec.price));
  const [trigger, setTrigger] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<Order | null>(null);
  const priceTouched = useRef(false);

  // The caller had no price: suggest the contract's live LTP once it arrives (unless the user already typed).
  const liveLtp = live.quote?.ltp ?? null;
  useEffect(() => {
    if (!priceTouched.current && isNum(liveLtp) && liveLtp > 0) setPrice((p) => (p === '' ? suggestedPrice(liveLtp) : p));
  }, [liveLtp]);

  const title = `${spec.symbol} ${formatExpiry(spec.expiry)} ${spec.type === 'FUT' ? 'FUT' : `${spec.strike} ${spec.type}`}`;
  const lotSize = info?.lotSize ?? live.lotSize;
  const q = live.quote;
  const open = clock?.status === 'open';
  const limitPx = Number(price);
  const triggerPx = Number(trigger);

  /** Why the order cannot be sent right now (null = it can). */
  const blocked: string | null = (() => {
    if (!isNum(lotSize) || lotSize <= 0) return 'Lot size unknown — the instrument master has not loaded yet';
    if (!Number.isInteger(lots) || lots < 1) return 'Enter at least 1 lot';
    if (orderType === 'MARKET') {
      if (clock && !open) return 'The market is closed — market orders fill only at the live bid/ask while the session is open';
      if (spec.type === 'FUT') return q && isNum(q.ltp) ? null : `No live price for ${title}${live.error instanceof Error ? ` (${live.error.message})` : ''}`;
      const px = side === 'BUY' ? q?.ask : q?.bid;
      if (!isNum(px)) return `No live ${side === 'BUY' ? 'ask' : 'bid'} for ${title} — a market order fills at the live book${live.error instanceof Error ? ` (${live.error.message})` : ''}`;
    }
    if ((orderType === 'LIMIT' || orderType === 'SL') && !(limitPx > 0)) return 'Enter a limit price';
    if ((orderType === 'SL' || orderType === 'SL-M') && !(triggerPx > 0)) return 'Enter a trigger price';
    return null;
  })();

  const submit = async () => {
    if (blocked) return;
    setBusy(true);
    setError(null);
    try {
      const o = await api<Order>('/broker/orders', {
        body: {
          symbol: spec.symbol, type: spec.type, strike: spec.strike, expiry: spec.expiry, side, lots, orderType, product,
          price: orderType === 'LIMIT' || orderType === 'SL' ? limitPx : undefined,
          triggerPrice: orderType === 'SL' || orderType === 'SL-M' ? triggerPx : undefined,
        },
      });
      setResult(o);
      qc.invalidateQueries({ queryKey: ['broker'] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const bookReason = !q ? (live.loading ? 'Loading the live quote…' : 'No live quote for this contract') : !open ? 'Market closed: no live bid/ask' : 'No fresh bid/ask for this contract';
  const dayOrder = orderType !== 'MARKET';

  return (
    <Modal open onClose={onClose} title={<span>Paper order · <span className="text-accent">{title}</span></span>}>
      <div className="space-y-3">
        <Segmented value={side} onChange={setSide} options={[{ value: 'BUY', label: 'Buy' }, { value: 'SELL', label: 'Sell' }]} />
        <div className="rounded-lg border border-line bg-panel2/60 px-3 py-2 text-xs" aria-label="Live quote">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
            <span>Bid <Val value={q?.bid} format={formatPrice} reason={bookReason} className="font-semibold" /></span>
            <span>Ask <Val value={q?.ask} format={formatPrice} reason={bookReason} className="font-semibold" /></span>
            <span>LTP <Val value={q?.ltp} format={formatPrice} reason={q ? 'Not traded in the live session' : bookReason} className="font-semibold" /> <AsOf ts={q?.ts} label="" /></span>
          </div>
          {spec.type === 'FUT' && <div className="mt-1 text-2xs text-muted">Bid/ask of a future are checked by the broker when the order is placed.</div>}
          {live.error ? <div className="mt-1 text-2xs text-muted">{live.error instanceof Error ? live.error.message : String(live.error)}</div> : null}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Lots (lot = ${isNum(lotSize) ? lotSize : '—'})`}>
            <div className="flex items-center gap-1">
              <button className="btn-ghost px-2" onClick={() => setLots(Math.max(1, lots - 1))} aria-label="Decrease lots">−</button>
              <input className="input text-center" type="number" min={1} max={50} value={lots} onChange={(e) => setLots(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
              <button className="btn-ghost px-2" onClick={() => setLots(Math.min(50, lots + 1))} aria-label="Increase lots">+</button>
            </div>
          </Field>
          <Field label="Quantity">
            <div className="input bg-transparent tabular-nums">{isNum(lotSize) ? lots * lotSize : '—'}</div>
          </Field>
          <Field label="Order type">
            <select className="input" value={orderType} onChange={(e) => setOrderType(e.target.value as OrderType)}>
              <option value="MARKET">Market</option>
              <option value="LIMIT">Limit</option>
              <option value="SL">Stop-loss limit</option>
              <option value="SL-M">Stop-loss market</option>
            </select>
          </Field>
          <Field label="Product">
            <select className="input" value={product} onChange={(e) => setProduct(e.target.value as ProductType)}>
              <option value="NRML">NRML (carry forward)</option>
              <option value="MIS">MIS (intraday)</option>
            </select>
          </Field>
          {(orderType === 'LIMIT' || orderType === 'SL') && (
            <Field label="Limit price">
              <input className="input" type="number" step="0.05" min="0" value={price} onChange={(e) => { priceTouched.current = true; setPrice(e.target.value); }} />
            </Field>
          )}
          {(orderType === 'SL' || orderType === 'SL-M') && (
            <Field label="Trigger price">
              <input className="input" type="number" step="0.05" min="0" value={trigger} onChange={(e) => setTrigger(e.target.value)} />
            </Field>
          )}
        </div>
        {isNum(q?.ltp) && isNum(lotSize) ? <div className="text-xs text-muted">Value at LTP ≈ {formatINR(q.ltp * lots * lotSize)}</div> : null}
        {dayOrder && <div className="text-2xs text-muted">Limit and stop orders are day orders: they work only while a live price allows a fill and are cancelled (“Day order expired”) at the session close (15:30; MCX 23:30/23:55).</div>}
        {error ? <ErrorState error={error} compact title="Order not placed" /> : null}
        {result && (
          <div className={cx('rounded-lg px-3 py-2 text-sm', result.status === 'COMPLETE' ? 'bg-up/10 text-up' : result.status === 'REJECTED' ? 'bg-down/10 text-down' : 'bg-accent/10 text-accent')}>
            {result.status === 'COMPLETE'
              ? `Executed ${result.quantity} @ ₹${result.avgPrice.toFixed(2)}`
              : result.status === 'REJECTED' || result.status === 'CANCELLED'
                ? result.message ?? `Order ${result.id} is ${result.status.toLowerCase()}`
                : `Order ${result.id} is ${result.status.replace('_', ' ').toLowerCase()}${result.message ? ` — ${result.message}` : ''}`}
          </div>
        )}
        <button className={cx('w-full', side === 'BUY' ? 'btn-buy' : 'btn-sell')} disabled={busy || !!blocked} onClick={submit} title={blocked ?? undefined}>
          {busy ? 'Placing…' : `${side === 'BUY' ? 'Buy' : 'Sell'} ${lots} lot${lots > 1 ? 's' : ''}`}
        </button>
        {blocked && <p className="text-center text-2xs text-muted" role="status">{blocked}</p>}
        {onAddToBuilder && (
          <button className="btn-ghost w-full" onClick={() => onAddToBuilder(side, lots)}>
            + Add {side === 'BUY' ? 'buy' : 'sell'} leg to strategy builder
          </button>
        )}
        <p className="text-center text-2xs text-muted">Paper trading only: orders are never sent to an exchange or broker. Fills are recorded at the live bid/ask.</p>
      </div>
    </Modal>
  );
}
