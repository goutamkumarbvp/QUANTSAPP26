import { useEffect, useMemo, useState } from 'react';
import { bsGreeks, formatINR, impliedVol, probAbove, type OptionType } from '@q26/core';
import { ExpirySelect, pickStrike, StrikeSelect, SymbolSelect } from '../components/pickers';
import { Card, Field, PageHeader, Segmented, Stat } from '../components/ui';
import { isNoLiveData } from '../lib/api';
import { formatAsOf, isNum } from '../lib/format';
import { useChain, useMeta } from '../lib/hooks';
import { useApp, useTicks } from '../lib/store';

/** A number typed by the user; null for an empty or invalid box. A blank input is never read as 0. */
function num(v: string): number | null {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const ENTER = 'Enter every input to get a result';

type Fields = 'spot' | 'strike' | 'days' | 'iv' | 'price' | 'carry';

/**
 * Optional helper: copies the inputs the live option chain has (spot, strike, days to expiry, the strike's IV, its last traded price,
 * the carry) into the calculator. An input the market does not give is left as it is and named — nothing is filled with a stand-in.
 */
function LiveFill({ type, onFill }: { type: OptionType; onFill: (f: Partial<Record<Fields, string>>) => void }) {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const serverNow = useTicks((s) => s.clock?.ts);
  const [expiry, setExpiry] = useState<string>();
  const [strike, setStrike] = useState<number>();
  const [note, setNote] = useState<string | null>(null);
  const chain = useChain(symbol, expiry, { refetch: false, enabled: !!expiry });
  const data = !isNoLiveData(chain.error) && chain.data?.symbol === symbol && chain.data.expiry === expiry ? chain.data : undefined;
  const k = pickStrike(data, strike);
  const fill = () => {
    const row = data?.rows.find((r) => r.strike === k);
    if (!data || !row || k === undefined) return;
    const q = type === 'CE' ? row.ce : row.pe;
    const out: Partial<Record<Fields, string>> = { strike: String(k), days: data.daysToExpiry.toFixed(2) };
    const skipped: string[] = [];
    if (isNum(data.spot)) out.spot = String(data.spot);
    else skipped.push(`spot (${data.gaps?.spot ?? 'not live'})`);
    if (isNum(q.iv)) out.iv = q.iv.toFixed(2);
    else skipped.push(`IV (${data.gaps?.iv ?? 'no usable live premium'})`);
    if (isNum(q.ltp)) out.price = q.ltp.toFixed(2);
    else skipped.push('premium (not traded in the live session)');
    if (isNum(data.carry)) out.carry = (data.carry * 100).toFixed(3);
    else skipped.push(`carry (${data.gaps?.carry ?? 'not available'})`);
    onFill(out);
    setNote(`${skipped.length ? `Not filled: ${skipped.join('; ')}. ` : ''}Days to expiry are measured from ${formatAsOf(data.valuationTs, serverNow ?? Date.now())}.`);
  };
  return (
    <div className="mb-3 space-y-1 rounded-lg border border-line bg-panel2/60 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted">Fill from the live chain:</span>
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setStrike(undefined); }} />
        <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} />
        <StrikeSelect chain={data} value={k} onChange={setStrike} error={chain.error} loading={chain.isLoading} />
        <button className="btn-ghost px-2 py-1 text-xs" disabled={!data || k === undefined} title={data ? undefined : 'The live option chain is not available'} onClick={fill}>
          Fill inputs
        </button>
      </div>
      {note && <div className="text-2xs text-muted" role="status">{note}</div>}
    </div>
  );
}

/** Starts the rate box on the server's risk-free-rate setting (a configured parameter, not a market value); the user can change it. */
function useRateText(): [string, (v: string) => void] {
  const meta = useMeta();
  const [rate, setRate] = useState('');
  const [touched, setTouched] = useState(false);
  const setting = meta.data?.riskFreeRate;
  useEffect(() => {
    if (!touched && typeof setting === 'number') setRate(String(+(setting * 100).toFixed(3)));
  }, [setting, touched]);
  return [rate, (v) => { setTouched(true); setRate(v); }];
}

function PricingCalc() {
  const [type, setType] = useState<OptionType>('CE');
  const [spot, setSpot] = useState('');
  const [strike, setStrike] = useState('');
  const [days, setDays] = useState('');
  const [iv, setIv] = useState('');
  const [rate, setRate] = useRateText();
  const [div, setDiv] = useState('');
  const r = useMemo(() => {
    const S = num(spot), K = num(strike), D = num(days), v = num(iv), rr = num(rate), q = num(div);
    if (S === null || K === null || D === null || v === null || rr === null || q === null || !(S > 0 && K > 0 && D > 0 && v > 0)) return null;
    const T = D / 365;
    const g = bsGreeks(type, S, K, T, rr / 100, v / 100, q / 100);
    const intrinsic = type === 'CE' ? Math.max(0, S - K) : Math.max(0, K - S);
    const pItm = type === 'CE' ? probAbove(S, K, T, v / 100, rr / 100, q / 100) : 1 - probAbove(S, K, T, v / 100, rr / 100, q / 100);
    return { ...g, intrinsic, timeValue: g.price - intrinsic, pItm };
  }, [type, spot, strike, days, iv, rate, div]);
  const fill = (f: Partial<Record<Fields, string>>) => {
    if (f.spot !== undefined) setSpot(f.spot);
    if (f.strike !== undefined) setStrike(f.strike);
    if (f.days !== undefined) setDays(f.days);
    if (f.iv !== undefined) setIv(f.iv);
    if (f.carry !== undefined) setDiv(f.carry);
  };
  return (
    <Card title="Option price & Greeks (Black-Scholes)">
      <LiveFill type={type} onFill={fill} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Field label="Type"><Segmented value={type} onChange={setType} options={[{ value: 'CE', label: 'Call' }, { value: 'PE', label: 'Put' }]} /></Field>
        <Field label="Spot"><input className="input" type="number" value={spot} onChange={(e) => setSpot(e.target.value)} /></Field>
        <Field label="Strike"><input className="input" type="number" value={strike} onChange={(e) => setStrike(e.target.value)} /></Field>
        <Field label="Days to expiry"><input className="input" type="number" step="0.25" value={days} onChange={(e) => setDays(e.target.value)} /></Field>
        <Field label="Implied volatility %"><input className="input" type="number" step="0.1" value={iv} onChange={(e) => setIv(e.target.value)} /></Field>
        <Field label="Risk-free rate %"><input className="input" type="number" step="0.1" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
        <Field label="Dividend / carry yield % (0 if none)"><input className="input" type="number" step="0.1" value={div} onChange={(e) => setDiv(e.target.value)} /></Field>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-5">
        <Stat label="Theoretical price" value={r ? r.price.toFixed(2) : null} reason={ENTER} tone="accent" />
        <Stat label="Intrinsic / time value" value={r ? `${r.intrinsic.toFixed(2)} / ${r.timeValue.toFixed(2)}` : null} reason={ENTER} />
        <Stat label="Delta" value={r ? r.delta.toFixed(4) : null} reason={ENTER} />
        <Stat label="Gamma" value={r ? r.gamma.toFixed(6) : null} reason={ENTER} />
        <Stat label="Theta (per day)" value={r ? r.theta.toFixed(2) : null} reason={ENTER} />
        <Stat label="Vega (per 1% IV)" value={r ? r.vega.toFixed(2) : null} reason={ENTER} />
        <Stat label="Rho (per 1%)" value={r ? r.rho.toFixed(2) : null} reason={ENTER} />
        <Stat label="Probability ITM" value={r ? `${(r.pItm * 100).toFixed(1)}%` : null} reason={ENTER} />
      </div>
    </Card>
  );
}

function IvCalc() {
  const [type, setType] = useState<OptionType>('CE');
  const [spot, setSpot] = useState('');
  const [strike, setStrike] = useState('');
  const [days, setDays] = useState('');
  const [price, setPrice] = useState('');
  const [rate, setRate] = useRateText();
  const [div, setDiv] = useState('');
  const iv = useMemo(() => {
    const p = num(price), S = num(spot), K = num(strike), D = num(days), rr = num(rate), q = num(div);
    if (p === null || S === null || K === null || D === null || rr === null || q === null || !(D > 0)) return null;
    return impliedVol(type, p, S, K, D / 365, rr / 100, q / 100);
  }, [type, price, spot, strike, days, rate, div]);
  const fill = (f: Partial<Record<Fields, string>>) => {
    if (f.spot !== undefined) setSpot(f.spot);
    if (f.strike !== undefined) setStrike(f.strike);
    if (f.days !== undefined) setDays(f.days);
    if (f.price !== undefined) setPrice(f.price);
    if (f.carry !== undefined) setDiv(f.carry);
  };
  return (
    <Card title="Implied volatility from premium">
      <LiveFill type={type} onFill={fill} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-7">
        <Field label="Type"><Segmented value={type} onChange={setType} options={[{ value: 'CE', label: 'Call' }, { value: 'PE', label: 'Put' }]} /></Field>
        <Field label="Spot"><input className="input" type="number" value={spot} onChange={(e) => setSpot(e.target.value)} /></Field>
        <Field label="Strike"><input className="input" type="number" value={strike} onChange={(e) => setStrike(e.target.value)} /></Field>
        <Field label="Days to expiry"><input className="input" type="number" value={days} onChange={(e) => setDays(e.target.value)} /></Field>
        <Field label="Option premium"><input className="input" type="number" step="0.05" value={price} onChange={(e) => setPrice(e.target.value)} /></Field>
        <Field label="Rate %"><input className="input" type="number" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
        <Field label="Carry yield % (0 if none)"><input className="input" type="number" step="0.1" value={div} onChange={(e) => setDiv(e.target.value)} /></Field>
      </div>
      <div className="mt-3 max-w-xs">
        <Stat label="Implied volatility" value={iv === null ? null : Number.isFinite(iv) ? `${(iv * 100).toFixed(2)}%` : 'Premium outside arbitrage bounds'} reason={ENTER} tone="accent" />
      </div>
    </Card>
  );
}

function ChargesCalc() {
  const [kind, setKind] = useState<'options' | 'futures'>('options');
  const [buy, setBuy] = useState('');
  const [sell, setSell] = useState('');
  const [qty, setQty] = useState('');
  // Statutory rates and the brokerage per order are settings (not market data): editable defaults.
  const [brokerage, setBrokerage] = useState('20');
  const [stt, setStt] = useState(kind === 'options' ? '0.1' : '0.02');
  const [txn, setTxn] = useState(kind === 'options' ? '0.03503' : '0.00173');
  const [stamp, setStamp] = useState(kind === 'options' ? '0.003' : '0.002');
  const switchKind = (k: 'options' | 'futures') => {
    setKind(k);
    setStt(k === 'options' ? '0.1' : '0.02');
    setTxn(k === 'options' ? '0.03503' : '0.00173');
    setStamp(k === 'options' ? '0.003' : '0.002');
  };
  const r = useMemo(() => {
    const q = num(qty), b = num(buy), s = num(sell), brk1 = num(brokerage), sttP = num(stt), txnP = num(txn), stampP = num(stamp);
    if (q === null || b === null || s === null || brk1 === null || sttP === null || txnP === null || stampP === null || !(q > 0)) return null;
    const bv = b * q;
    const sv = s * q;
    const turnover = bv + sv;
    const brk = brk1 * 2;
    const sttAmt = (sv * sttP) / 100;
    const txnAmt = (turnover * txnP) / 100;
    const sebi = (turnover * 10) / 1e7;
    const stampAmt = (bv * stampP) / 100;
    const gst = 0.18 * (brk + txnAmt + sebi);
    const total = brk + sttAmt + txnAmt + sebi + stampAmt + gst;
    return { gross: sv - bv, brk, sttAmt, txnAmt, sebi, stampAmt, gst, total, net: sv - bv - total, breakevenPts: total / q };
  }, [qty, buy, sell, brokerage, stt, txn, stamp]);
  const why = 'Enter the buy price, sell price and quantity';
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
        <Stat label="Gross P&L" value={r ? formatINR(r.gross, 2) : null} reason={why} tone={r ? (r.gross >= 0 ? 'up' : 'down') : undefined} />
        <Stat label="Total charges" value={r ? formatINR(r.total, 2) : null} reason={why} tone="warn" />
        <Stat label="Net P&L" value={r ? formatINR(r.net, 2) : null} reason={why} tone={r ? (r.net >= 0 ? 'up' : 'down') : undefined} />
        <Stat label="Points to breakeven" value={r ? r.breakevenPts.toFixed(2) : null} reason={why} />
        <Stat label="STT / Txn / GST" value={r ? `${r.sttAmt.toFixed(0)} / ${r.txnAmt.toFixed(0)} / ${r.gst.toFixed(0)}` : null} reason={why} sub={r ? `Stamp ${r.stampAmt.toFixed(0)} · SEBI ${r.sebi.toFixed(2)}` : undefined} />
      </div>
      <p className="mt-2 text-2xs text-muted">Statutory rates change with budgets and exchange circulars — defaults are editable; verify with your broker's current charge sheet.</p>
    </Card>
  );
}

export default function Calculators() {
  return (
    <div className="space-y-3">
      <PageHeader title="Calculators" subtitle="Option pricing, Greeks, implied volatility and trading charges" />
      <p className="text-xs text-muted">The calculators start empty: type your own inputs, or copy the live ones from the option chain with “Fill inputs” (anything the market does not give stays blank).</p>
      <PricingCalc />
      <IvCalc />
      <ChargesCalc />
      <p className="text-xs text-muted">Margin for any multi-leg position (SPAN + exposure with hedge benefit) is shown live in the Strategy Builder.</p>
    </div>
  );
}
