import { useMemo, useState } from 'react';
import { bsGreeks, formatINR, impliedVol, probAbove, type OptionType } from '@q26/core';
import { Card, Field, PageHeader, Segmented, Stat } from '../components/ui';

function num(v: string, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function PricingCalc() {
  const [type, setType] = useState<OptionType>('CE');
  const [spot, setSpot] = useState('25000');
  const [strike, setStrike] = useState('25000');
  const [days, setDays] = useState('7');
  const [iv, setIv] = useState('12');
  const [rate, setRate] = useState('6.5');
  const [div, setDiv] = useState('1.2');
  const r = useMemo(() => {
    const S = num(spot), K = num(strike), T = num(days) / 365, v = num(iv) / 100, rr = num(rate) / 100, q = num(div) / 100;
    const g = bsGreeks(type, S, K, T, rr, v, q);
    const intrinsic = type === 'CE' ? Math.max(0, S - K) : Math.max(0, K - S);
    const pItm = type === 'CE' ? probAbove(S, K, T, v, rr, q) : 1 - probAbove(S, K, T, v, rr, q);
    return { ...g, intrinsic, timeValue: g.price - intrinsic, pItm };
  }, [type, spot, strike, days, iv, rate, div]);
  return (
    <Card title="Option price & Greeks (Black-Scholes)">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Field label="Type"><Segmented value={type} onChange={setType} options={[{ value: 'CE', label: 'Call' }, { value: 'PE', label: 'Put' }]} /></Field>
        <Field label="Spot"><input className="input" type="number" value={spot} onChange={(e) => setSpot(e.target.value)} /></Field>
        <Field label="Strike"><input className="input" type="number" value={strike} onChange={(e) => setStrike(e.target.value)} /></Field>
        <Field label="Days to expiry"><input className="input" type="number" step="0.25" value={days} onChange={(e) => setDays(e.target.value)} /></Field>
        <Field label="Implied volatility %"><input className="input" type="number" step="0.1" value={iv} onChange={(e) => setIv(e.target.value)} /></Field>
        <Field label="Risk-free rate %"><input className="input" type="number" step="0.1" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
        <Field label="Dividend / carry yield %"><input className="input" type="number" step="0.1" value={div} onChange={(e) => setDiv(e.target.value)} /></Field>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
        <Stat label="Theoretical price" value={r.price.toFixed(2)} tone="accent" />
        <Stat label="Intrinsic / time value" value={`${r.intrinsic.toFixed(2)} / ${r.timeValue.toFixed(2)}`} />
        <Stat label="Delta" value={r.delta.toFixed(4)} />
        <Stat label="Gamma" value={r.gamma.toFixed(6)} />
        <Stat label="Theta (per day)" value={r.theta.toFixed(2)} />
        <Stat label="Vega (per 1% IV)" value={r.vega.toFixed(2)} />
        <Stat label="Rho (per 1%)" value={r.rho.toFixed(2)} />
        <Stat label="Probability ITM" value={`${(r.pItm * 100).toFixed(1)}%`} />
      </div>
    </Card>
  );
}

function IvCalc() {
  const [type, setType] = useState<OptionType>('CE');
  const [spot, setSpot] = useState('25000');
  const [strike, setStrike] = useState('25200');
  const [days, setDays] = useState('7');
  const [price, setPrice] = useState('60');
  const [rate, setRate] = useState('6.5');
  const iv = useMemo(() => impliedVol(type, num(price), num(spot), num(strike), num(days) / 365, num(rate) / 100), [type, price, spot, strike, days, rate]);
  return (
    <Card title="Implied volatility from premium">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Field label="Type"><Segmented value={type} onChange={setType} options={[{ value: 'CE', label: 'Call' }, { value: 'PE', label: 'Put' }]} /></Field>
        <Field label="Spot"><input className="input" type="number" value={spot} onChange={(e) => setSpot(e.target.value)} /></Field>
        <Field label="Strike"><input className="input" type="number" value={strike} onChange={(e) => setStrike(e.target.value)} /></Field>
        <Field label="Days to expiry"><input className="input" type="number" value={days} onChange={(e) => setDays(e.target.value)} /></Field>
        <Field label="Option premium"><input className="input" type="number" step="0.05" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
        <Field label="Rate %"><input className="input" type="number" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
      </div>
      <div className="mt-3 max-w-xs">
        <Stat label="Implied volatility" value={Number.isFinite(iv) ? `${(iv * 100).toFixed(2)}%` : 'Premium outside arbitrage bounds'} tone="accent" />
      </div>
    </Card>
  );
}

function ChargesCalc() {
  const [kind, setKind] = useState<'options' | 'futures'>('options');
  const [buy, setBuy] = useState('100');
  const [sell, setSell] = useState('120');
  const [qty, setQty] = useState('65');
  const [brokerage, setBrokerage] = useState('20');
  const [stt, setStt] = useState(kind === 'options' ? '0.1' : '0.02');
  const [txn, setTxn] = useState(kind === 'options' ? '0.03503' : '0.00173');
  const [stamp, setStamp] = useState(kind === 'options' ? '0.003' : '0.002');
  const switchKind = (k: 'options' | 'futures') => {
    setKind(k);
    setStt(k === 'options' ? '0.1' : '0.02');
    setTxn(k === 'options' ? '0.03503' : '0.00173');
    setStamp(k === 'options' ? '0.003' : '0.002');
    if (k === 'futures') { setBuy('25000'); setSell('25100'); } else { setBuy('100'); setSell('120'); }
  };
  const r = useMemo(() => {
    const q = num(qty);
    const bv = num(buy) * q;
    const sv = num(sell) * q;
    const turnover = bv + sv;
    const brk = num(brokerage) * 2;
    const sttAmt = (sv * num(stt)) / 100;
    const txnAmt = (turnover * num(txn)) / 100;
    const sebi = (turnover * 10) / 1e7;
    const stampAmt = (bv * num(stamp)) / 100;
    const gst = 0.18 * (brk + txnAmt + sebi);
    const total = brk + sttAmt + txnAmt + sebi + stampAmt + gst;
    return { gross: sv - bv, brk, sttAmt, txnAmt, sebi, stampAmt, gst, total, net: sv - bv - total, breakevenPts: q ? total / q : 0 };
  }, [qty, buy, sell, brokerage, stt, txn, stamp]);
  return (
    <Card title="Brokerage & charges (round trip)">
      <div className="mb-2"><Segmented value={kind} onChange={switchKind} options={[{ value: 'options', label: 'Options' }, { value: 'futures', label: 'Futures' }]} /></div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        <Field label="Buy price"><input className="input" type="number" value={buy} onChange={(e) => setBuy(e.target.value)} /></Field>
        <Field label="Sell price"><input className="input" type="number" value={sell} onChange={(e) => setSell(e.target.value)} /></Field>
        <Field label="Quantity"><input className="input" type="number" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
        <Field label="Brokerage / order ₹"><input className="input" type="number" value={brokerage} onChange={(e) => setBrokerage(e.target.value)} /></Field>
        <Field label="STT % (sell)"><input className="input" type="number" step="0.001" value={stt} onChange={(e) => setStt(e.target.value)} /></Field>
        <Field label="Exchange txn %"><input className="input" type="number" step="0.00001" value={txn} onChange={(e) => setTxn(e.target.value)} /></Field>
        <Field label="Stamp duty % (buy)"><input className="input" type="number" step="0.001" value={stamp} onChange={(e) => setStamp(e.target.value)} /></Field>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
        <Stat label="Gross P&L" value={formatINR(r.gross, 2)} tone={r.gross >= 0 ? 'up' : 'down'} />
        <Stat label="Total charges" value={formatINR(r.total, 2)} tone="warn" />
        <Stat label="Net P&L" value={formatINR(r.net, 2)} tone={r.net >= 0 ? 'up' : 'down'} />
        <Stat label="Points to breakeven" value={r.breakevenPts.toFixed(2)} />
        <Stat label="STT / Txn / GST" value={`${r.sttAmt.toFixed(0)} / ${r.txnAmt.toFixed(0)} / ${r.gst.toFixed(0)}`} sub={`Stamp ${r.stampAmt.toFixed(0)} · SEBI ${r.sebi.toFixed(2)}`} />
      </div>
      <p className="mt-2 text-2xs text-muted">Statutory rates change with budgets and exchange circulars — defaults are editable; verify with your broker's current charge sheet.</p>
    </Card>
  );
}

export default function Calculators() {
  return (
    <div className="space-y-3">
      <PageHeader title="Calculators" subtitle="Option pricing, Greeks, implied volatility and trading charges" />
      <PricingCalc />
      <IvCalc />
      <ChargesCalc />
      <p className="text-xs text-muted">Margin for any multi-leg position (SPAN + exposure with hedge benefit) is shown live in the Strategy Builder.</p>
    </div>
  );
}
