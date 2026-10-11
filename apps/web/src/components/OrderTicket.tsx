import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { formatExpiry, formatINR, type InstrumentType, type Order, type OrderType, type ProductType, type Side } from '@q26/core';
import { api } from '../lib/api';
import { useSymbolInfo } from '../lib/hooks';
import { cx, ErrorBox, Field, Modal, Segmented } from './ui';

export interface TicketSpec {
  symbol: string;
  type: InstrumentType;
  strike?: number;
  expiry: string;
  side: Side;
  price?: number;
}

export function OrderTicket({ spec, onClose, onAddToBuilder }: { spec: TicketSpec | null; onClose: () => void; onAddToBuilder?: (side: Side, lots: number) => void }) {
  const qc = useQueryClient();
  const info = useSymbolInfo(spec?.symbol ?? '');
  const [side, setSide] = useState<Side>('BUY');
  const [lots, setLots] = useState(1);
  const [orderType, setOrderType] = useState<OrderType>('MARKET');
  const [product, setProduct] = useState<ProductType>('NRML');
  const [price, setPrice] = useState('');
  const [trigger, setTrigger] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<Order | null>(null);

  useEffect(() => {
    if (!spec) return;
    setSide(spec.side);
    setLots(1);
    setOrderType('MARKET');
    setPrice(spec.price ? spec.price.toFixed(2) : '');
    setTrigger('');
    setError(null);
    setResult(null);
  }, [spec]);

  if (!spec) return null;
  const title = `${spec.symbol} ${formatExpiry(spec.expiry)} ${spec.type === 'FUT' ? 'FUT' : `${spec.strike} ${spec.type}`}`;
  const lotSize = info?.lotSize ?? 1;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const o = await api<Order>('/broker/orders', {
        body: {
          symbol: spec.symbol, type: spec.type, strike: spec.strike, expiry: spec.expiry, side, lots, orderType, product,
          price: orderType === 'LIMIT' || orderType === 'SL' ? Number(price) : undefined,
          triggerPrice: orderType === 'SL' || orderType === 'SL-M' ? Number(trigger) : undefined,
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

  return (
    <Modal open={!!spec} onClose={onClose} title={<span>Paper order · <span className="text-accent">{title}</span></span>}>
      <div className="space-y-3">
        <Segmented value={side} onChange={setSide} options={[{ value: 'BUY', label: 'Buy' }, { value: 'SELL', label: 'Sell' }]} />
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Lots (lot = ${lotSize})`}>
            <div className="flex items-center gap-1">
              <button className="btn-ghost px-2" onClick={() => setLots(Math.max(1, lots - 1))} aria-label="Decrease lots">−</button>
              <input className="input text-center" type="number" min={1} max={50} value={lots} onChange={(e) => setLots(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} />
              <button className="btn-ghost px-2" onClick={() => setLots(Math.min(50, lots + 1))} aria-label="Increase lots">+</button>
            </div>
          </Field>
          <Field label="Quantity">
            <div className="input bg-transparent tabular-nums">{lots * lotSize}</div>
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
              <input className="input" type="number" step="0.05" value={price} onChange={(e) => setPrice(e.target.value)} />
            </Field>
          )}
          {(orderType === 'SL' || orderType === 'SL-M') && (
            <Field label="Trigger price">
              <input className="input" type="number" step="0.05" value={trigger} onChange={(e) => setTrigger(e.target.value)} />
            </Field>
          )}
        </div>
        {spec.price ? <div className="text-xs text-muted">Last price ₹{spec.price.toFixed(2)} · value ≈ {formatINR(spec.price * lots * lotSize)}</div> : null}
        {error ? <ErrorBox error={error} /> : null}
        {result && (
          <div className={cx('rounded-lg px-3 py-2 text-sm', result.status === 'COMPLETE' ? 'bg-up/10 text-up' : result.status === 'REJECTED' ? 'bg-down/10 text-down' : 'bg-accent/10 text-accent')}>
            {result.status === 'COMPLETE' ? `Executed ${result.quantity} @ ₹${result.avgPrice.toFixed(2)}` : result.status === 'REJECTED' ? result.message : `Order ${result.id} is ${result.status.replace('_', ' ').toLowerCase()}`}
          </div>
        )}
        <button className={cx('w-full', side === 'BUY' ? 'btn-buy' : 'btn-sell')} disabled={busy} onClick={submit}>
          {busy ? 'Placing…' : `${side === 'BUY' ? 'Buy' : 'Sell'} ${lots} lot${lots > 1 ? 's' : ''}`}
        </button>
        {onAddToBuilder && (
          <button className="btn-ghost w-full" onClick={() => onAddToBuilder(side, lots)}>
            + Add {side === 'BUY' ? 'buy' : 'sell'} leg to strategy builder
          </button>
        )}
        <p className="text-center text-2xs text-muted">Paper trading on simulated prices. No real money is involved.</p>
      </div>
    </Modal>
  );
}
