import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { DAY_MS, describeStrategy, legLabel, type InstrumentType, type Leg, type Order, type SavedStrategy } from '@q26/core';
import { PayoffChart, ScenarioTable, StrategySummary, useStrategyView } from '../components/Payoff';
import { defaultStrike, SymbolSelect } from '../components/pickers';
import { Card, cx, Dash, ErrorBox, Field, Modal, NoData, PageHeader, Segmented, Spinner, Val } from '../components/ui';
import { api, errorText } from '../lib/api';
import { formatDateTime, formatExpiry, formatINR, formatPrice, isNum, pnlClass } from '../lib/format';
import { useExpiries } from '../lib/hooks';
import { useBuilder, useTicks, type BuilderLeg } from '../lib/store';

function encodeLegs(symbol: string, legs: Leg[]): string {
  const compact = legs.map((l) => [l.side[0], l.type, l.strike, l.expiry, l.lots, +l.price.toFixed(2)]);
  return btoa(JSON.stringify({ s: symbol, l: compact }));
}

function decodeLegs(code: string): { symbol: string; legs: Leg[] } | null {
  try {
    const { s, l } = JSON.parse(atob(code)) as { s: string; l: [string, InstrumentType, number, string, number, number][] };
    return { symbol: s, legs: l.map(([side, type, strike, expiry, lots, price]) => ({ side: side === 'B' ? 'BUY' : 'SELL', type, strike, expiry, lots, lotSize: 1, price })) };
  } catch {
    return null;
  }
}

/** Entry price typed by the user; it only changes while the text is a positive number (an empty box never becomes 0). */
function PriceInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      className="input w-20 py-0.5 text-right text-xs"
      type="number"
      step="0.05"
      min="0"
      aria-label="Entry price"
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== '' && Number.isFinite(n) && n > 0) onCommit(n);
      }}
    />
  );
}

export default function Builder() {
  const b = useBuilder();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const exp = useExpiries(b.symbol);
  const marketStatus = useTicks((s) => s.clock?.status);
  const [addExpiry, setAddExpiry] = useState<string>();
  const [targetDays, setTargetDays] = useState(0);
  const [ivShift, setIvShift] = useState(0);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<{ tone: 'up' | 'down'; text: string } | null>(null);
  const [error, setError] = useState<unknown>(null);

  // Load a shared strategy from ?s=
  useEffect(() => {
    const code = params.get('s');
    if (!code) return;
    const d = decodeLegs(code);
    if (d) b.setLegs(d.symbol, d.legs);
    params.delete('s');
    setParams(params, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const options = exp.data?.options ?? [];
  const newLegExpiry = addExpiry && options.includes(addExpiry) ? addExpiry : options[0];
  const [newSide, setNewSide] = useState<'BUY' | 'SELL'>('BUY');
  const [newType, setNewType] = useState<InstrumentType>('CE');
  const [newStrike, setNewStrike] = useState<number>(0);
  const [newLots, setNewLots] = useState(1);
  const view = useStrategyView(b.symbol, b.legs, { targetDays, ivShift, extraExpiry: newLegExpiry, futures: newType === 'FUT' });
  const chain = newLegExpiry ? view.chains[newLegExpiry] : undefined;
  const maxDays = view.expiryTs !== null && view.nowTs !== null ? Math.max(0, Math.floor((view.expiryTs - view.nowTs) / DAY_MS)) : 0;
  useEffect(() => {
    if (targetDays > maxDays) setTargetDays(maxDays);
  }, [maxDays, targetDays]);

  const strikes = chain?.rows.map((r) => r.strike) ?? [];
  // The picker starts on the ATM strike; without a live spot, on the strike nearest the forward.
  const strikeValue = strikes.includes(newStrike) ? newStrike : defaultStrike(chain);

  /** Live price of a contract for a new / changed leg: its LTP (a future's own expiry), else null with the reason. Never a made-up premium. */
  const quoteFor = (type: InstrumentType, strike: number | undefined, expiry: string): { price: number | null; iv: number | undefined; why: string | null } => {
    if (type === 'FUT') {
      const f = view.futures.find((x) => x.expiry === expiry);
      return { price: f?.ltp ?? null, iv: undefined, why: f ? (isNum(f.ltp) ? null : 'The future has not traded in the live session') : 'No live quote for this future' };
    }
    const c = view.chains[expiry];
    if (!c) return { price: null, iv: undefined, why: 'The option chain is not available' };
    const row = c.rows.find((r) => r.strike === strike);
    const q = row ? (type === 'CE' ? row.ce : row.pe) : undefined;
    if (!q) return { price: null, iv: undefined, why: `${strike} is not a strike of this expiry` };
    return { price: q.ltp, iv: isNum(q.iv) ? q.iv / 100 : undefined, why: isNum(q.ltp) ? null : 'Not traded in the live session' };
  };

  const futExp = exp.data?.futures[0];
  const newQuote = newType === 'FUT' ? quoteFor('FUT', undefined, futExp ?? '') : newLegExpiry ? quoteFor(newType, strikeValue, newLegExpiry) : { price: null, iv: undefined, why: 'No listed expiry' };

  const addLeg = () => {
    if (!chain || !newLegExpiry || newQuote.price === null || (newType !== 'FUT' && strikeValue === undefined)) return;
    const expiry = newType === 'FUT' ? futExp ?? newLegExpiry : newLegExpiry;
    b.add({ symbol: b.symbol, side: newSide, type: newType, strike: newType === 'FUT' ? 0 : strikeValue!, expiry, lots: newLots, lotSize: chain.lotSize, price: newQuote.price, iv: newQuote.iv });
  };

  const updateContract = (l: BuilderLeg, patch: Partial<BuilderLeg>) => {
    setMsg(null);
    // Flipping buy / sell keeps the entry price; another contract is priced at its own live LTP, or not changed.
    if (!('type' in patch || 'strike' in patch || 'expiry' in patch)) {
      b.update(l.id, patch);
      return;
    }
    const next = { ...l, ...patch };
    const q = quoteFor(next.type, next.strike, next.expiry);
    if (q.price === null) {
      setMsg({ tone: 'down', text: `Not changed: no live LTP for ${legLabel(next)}${q.why ? ` (${q.why})` : ''}. A leg's entry price is never guessed.` });
      return;
    }
    b.update(l.id, { ...patch, price: q.price, iv: q.iv });
  };

  const name0 = useMemo(() => describeStrategy(b.legs), [b.legs]);

  // Market orders fill at the live bid (sell) / ask (buy): say why the basket cannot go out instead of sending it to be rejected.
  const toSend = b.legs.filter((l) => l.active !== false && l.exitPrice == null);
  const executeBlock: string | null = (() => {
    if (!toSend.length) return 'No active legs to send';
    if (marketStatus && marketStatus !== 'open') return 'The market is closed: market orders fill only at the live bid / ask while the session is open';
    const noBook = toSend.filter((l) => {
      if (l.type === 'FUT') return false;
      const row = view.chains[l.expiry]?.rows.find((r) => r.strike === l.strike);
      const q = row ? (l.type === 'CE' ? row.ce : row.pe) : undefined;
      return !isNum(l.side === 'BUY' ? q?.ask : q?.bid);
    });
    return noBook.length ? `No live ${noBook.map((l) => `${l.side === 'BUY' ? 'ask' : 'bid'} for ${legLabel(l)}`).join(', ')}` : null;
  })();

  const save = async () => {
    setError(null);
    try {
      const s = await api<SavedStrategy>('/strategies', { body: { name: name || `${b.symbol} ${name0}`, symbol: b.symbol, legs: b.legs.filter((l) => l.active !== false).map(({ id, ...l }) => ({ ...l, id })) } });
      qc.invalidateQueries({ queryKey: ['strategies'] });
      setSaveOpen(false);
      setMsg({ tone: 'up', text: `Saved “${s.name}” to Strategy Manager` });
    } catch (e) {
      setError(e);
    }
  };

  const execute = async () => {
    setMsg(null);
    try {
      const res = await api<(Order | { error: string })[]>('/broker/basket', {
        body: { orders: toSend.map((l) => ({ symbol: b.symbol, type: l.type, strike: l.type === 'FUT' ? undefined : l.strike, expiry: l.expiry, side: l.side, lots: l.lots, orderType: 'MARKET', product: 'NRML', tag: 'builder' })) },
      });
      const ok = res.filter((r) => 'status' in r && r.status === 'COMPLETE').length;
      const failed = res.filter((r) => 'error' in r || ('status' in r && r.status === 'REJECTED'));
      qc.invalidateQueries({ queryKey: ['broker'] });
      setMsg({ tone: failed.length ? 'down' : 'up', text: `${ok}/${res.length} legs executed in paper account${failed.length ? ` — ${failed.map((f) => ('error' in f ? f.error : (f as Order).message)).join('; ')}` : ''}` });
    } catch (e) {
      setMsg({ tone: 'down', text: errorText(e) });
    }
  };

  const share = async () => {
    const url = `${location.origin}/builder?s=${encodeURIComponent(encodeLegs(b.symbol, b.legs))}`;
    try {
      await navigator.clipboard.writeText(url);
      setMsg({ tone: 'up', text: 'Share link copied to clipboard' });
    } catch {
      setMsg({ tone: 'up', text: url });
    }
  };

  return (
    <div className="space-y-3">
      <PageHeader title="Strategy Builder" subtitle={b.legs.length ? `${b.symbol} · ${name0}` : 'Build any multi-leg F&O strategy and analyse payoff, Greeks, POP and margin'}>
        <SymbolSelect value={b.symbol} onChange={(s) => b.setSymbol(s)} />
        <Link to="/templates" className="btn-ghost">✦ Templates</Link>
        <Link to="/optimizer" className="btn-ghost">⚙ Optimizer</Link>
      </PageHeader>

      <Card title="Add leg">
        <div className="flex flex-wrap items-end gap-2">
          <Segmented value={newSide} onChange={setNewSide} options={[{ value: 'BUY', label: 'Buy' }, { value: 'SELL', label: 'Sell' }]} />
          <Segmented value={newType} onChange={setNewType} options={[{ value: 'CE', label: 'Call' }, { value: 'PE', label: 'Put' }, { value: 'FUT', label: 'Fut' }]} />
          <Field label="Expiry">
            <select className="input w-auto" value={newLegExpiry ?? ''} disabled={!options.length} title={options.length ? undefined : exp.error ? errorText(exp.error) : 'No listed option expiry'} onChange={(e) => setAddExpiry(e.target.value)}>
              {options.map((e) => <option key={e} value={e}>{formatExpiry(e)}</option>)}
              {!options.length && <option value="">{exp.isLoading ? 'Loading…' : 'No expiry'}</option>}
            </select>
          </Field>
          {newType !== 'FUT' && (
            <Field label="Strike">
              <select className="input w-auto" value={strikeValue ?? ''} disabled={!strikes.length} title={strikes.length ? undefined : 'No strikes: the option chain is not available'} onChange={(e) => setNewStrike(Number(e.target.value))}>
                {strikes.map((k) => (
                  <option key={k} value={k}>{k}{k === chain?.atm ? ' (ATM)' : ''}</option>
                ))}
                {!strikes.length && <option value="">No strikes</option>}
              </select>
            </Field>
          )}
          <Field label="Lots">
            <input className="input w-20" type="number" min={1} value={newLots} onChange={(e) => setNewLots(Math.max(1, Number(e.target.value) || 1))} />
          </Field>
          <div className="text-xs text-muted" title="Live last traded price of the contract: the leg's entry price">
            Live premium <b className="text-ink"><Val value={newQuote.price} format={formatPrice} reason={newQuote.why ?? 'No live premium'} /></b>
          </div>
          <button className={newSide === 'BUY' ? 'btn-buy' : 'btn-sell'} onClick={addLeg} disabled={!chain || newQuote.price === null} title={newQuote.price === null ? `Cannot add: ${newQuote.why ?? 'no live premium'}. The entry price is never guessed.` : undefined}>
            + Add {newSide === 'BUY' ? 'Buy' : 'Sell'} {newType}
          </button>
        </div>
        {newQuote.price === null && chain && <p className="mt-2 text-2xs text-muted">No live premium for this contract ({newQuote.why}): pick a traded strike, or wait for it to trade.</p>}
      </Card>

      {b.legs.length > 0 && (
        <Card
          pad={false}
          title={`Positions (${b.legs.length})`}
          actions={
            <>
              <button className="btn-ghost px-2 py-1 text-xs" onClick={share}>🔗 Share</button>
              <button className="btn-ghost px-2 py-1 text-xs" onClick={() => navigate('/strategy-chart')}>📈 Chart</button>
              <button className="btn-ghost px-2 py-1 text-xs" onClick={() => { setName(`${b.symbol} ${name0}`); setSaveOpen(true); }}>💾 Save virtual</button>
              <button className="btn-primary px-2 py-1 text-xs" onClick={execute} disabled={!!executeBlock} title={executeBlock ?? undefined}>⚡ Execute (paper)</button>
              <button className="btn-ghost px-2 py-1 text-xs" onClick={() => b.clear()}>Clear</button>
            </>
          }
        >
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th></th>
                  <th>B/S</th>
                  <th>Expiry</th>
                  <th>Strike</th>
                  <th>Type</th>
                  <th className="num">Lots</th>
                  <th className="num">Entry</th>
                  <th className="num">LTP</th>
                  <th className="num">IV</th>
                  <th className="num">Delta</th>
                  <th className="num">Theta</th>
                  <th className="num">P&L</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {b.legs.map((l) => {
                  const m = view.legs.find((x) => x.id === l.id);
                  const legChain = view.chains[l.expiry];
                  const pending = view.loading ? 'Loading the live chain…' : 'Not available';
                  const greekWhy = m?.excluded ?? m?.ivReason ?? (m?.exitPrice != null ? 'The leg is closed' : m && m.active === false ? 'Leg is switched off' : pending);
                  return (
                    <tr key={l.id} className={cx(l.active === false && 'opacity-50')}>
                      <td>
                        <input type="checkbox" aria-label="Include leg" checked={l.active !== false} onChange={(e) => b.update(l.id, { active: e.target.checked })} />
                      </td>
                      <td>
                        <button className={cx('chip cursor-pointer', l.side === 'BUY' ? 'bg-up/20 text-up' : 'bg-down/20 text-down')} onClick={() => updateContract(l, { side: l.side === 'BUY' ? 'SELL' : 'BUY' })}>
                          {l.side === 'BUY' ? 'B' : 'S'}
                        </button>
                      </td>
                      <td>
                        {l.type === 'FUT' ? (
                          formatExpiry(l.expiry)
                        ) : (
                          <select className="input w-auto py-0.5 text-xs" value={l.expiry} onChange={(e) => updateContract(l, { expiry: e.target.value })}>
                            {(options.includes(l.expiry) ? options : [l.expiry, ...options]).map((e) => <option key={e} value={e}>{formatExpiry(e)}</option>)}
                          </select>
                        )}
                      </td>
                      <td>
                        {l.type === 'FUT' ? <Dash reason="A future has no strike" /> : (
                          <select className="input w-auto py-0.5 text-xs" value={l.strike} onChange={(e) => updateContract(l, { strike: Number(e.target.value) })}>
                            {(legChain?.rows.map((r) => r.strike) ?? [l.strike]).map((k) => <option key={k} value={k}>{k}</option>)}
                          </select>
                        )}
                      </td>
                      <td>
                        {l.type === 'FUT' ? 'FUT' : (
                          <button className="chip cursor-pointer bg-panel2" onClick={() => updateContract(l, { type: l.type === 'CE' ? 'PE' : 'CE' })}>{l.type}</button>
                        )}
                        {m?.excluded && <span className="ml-1 text-warn" title={`Left out of today's curve, Greeks and margin: ${m.excluded}`}>⚠</span>}
                      </td>
                      <td className="num">
                        <input className="input w-16 py-0.5 text-right text-xs" type="number" min={1} value={l.lots} onChange={(e) => b.update(l.id, { lots: Math.max(1, Number(e.target.value) || 1) })} />
                      </td>
                      <td className="num">
                        <PriceInput value={l.price} onCommit={(v) => b.update(l.id, { price: v })} />
                      </td>
                      <td className="num" title={m?.ltpTs ? `Quote of ${formatDateTime(m.ltpTs)}` : undefined}><Val value={m?.ltp} format={(x) => x.toFixed(2)} reason={m?.ltpReason ?? pending} /></td>
                      <td className="num">{l.type === 'FUT' ? <Dash reason="A future has no IV" /> : <Val value={m && m.marketIv !== null ? m.marketIv * 100 : null} format={(x) => x.toFixed(1)} reason={m?.ivReason ?? pending} />}</td>
                      <td className="num"><Val value={m?.delta} format={(x) => x.toFixed(1)} reason={greekWhy} /></td>
                      <td className="num"><Val value={m?.theta} format={(x) => x.toFixed(0)} reason={greekWhy} /></td>
                      <td className={cx('num font-medium', pnlClass(m?.pnl))}><Val value={m?.pnl} format={(x) => formatINR(x)} reason={m?.pnlReason ?? pending} /></td>
                      <td>
                        <button className="text-muted hover:text-down" onClick={() => b.remove(l.id)} aria-label="Remove leg">✕</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {executeBlock && toSend.length > 0 && <div className="border-t border-line px-4 py-2 text-xs text-muted">Execute is off: {executeBlock}.</div>}
          {msg && <div className={cx('border-t border-line px-4 py-2 text-sm', msg.tone === 'up' ? 'text-up' : 'text-down')}>{msg.text}</div>}
        </Card>
      )}

      {b.legs.length > 0 && view.analysis && (
        <>
          <StrategySummary view={view} />
          <Card
            title="Payoff"
            actions={
              <div className="flex flex-wrap items-center gap-3 text-xs">
                <label className="flex items-center gap-2">
                  Target: <b>{targetDays === 0 ? 'Today' : `T+${targetDays}d`}</b>
                  <input type="range" min={0} max={maxDays} value={targetDays} onChange={(e) => setTargetDays(Number(e.target.value))} />
                </label>
                <label className="flex items-center gap-2">
                  IV {ivShift >= 0 ? '+' : ''}{ivShift}%
                  <input type="range" min={-10} max={10} step={0.5} value={ivShift} onChange={(e) => setIvShift(Number(e.target.value))} />
                </label>
                {(targetDays !== 0 || ivShift !== 0) && <button className="text-accent" onClick={() => { setTargetDays(0); setIvShift(0); }}>Reset</button>}
              </div>
            }
          >
            <PayoffChart view={view} height={380} />
          </Card>
          <Card title="What-if: P&L by spot move and date" pad={false}>
            <ScenarioTable view={view} />
          </Card>
        </>
      )}
      {b.legs.length > 0 && !view.analysis && (view.loading ? <Spinner label="Loading the live chain…" /> : <NoData title="No analysis available" reason={view.blank ?? 'Switch at least one leg on to analyse the strategy'} />)}

      {!b.legs.length && (
        <Card>
          <div className="py-8 text-center text-sm text-muted">
            No positions yet. Add a leg above, pick a ready-made <Link to="/templates" className="text-accent">strategy template</Link>, let the{' '}
            <Link to="/optimizer" className="text-accent">optimizer</Link> suggest one, or click B/S on the <Link to="/option-chain" className="text-accent">option chain</Link>.
          </div>
        </Card>
      )}

      <Modal open={saveOpen} onClose={() => setSaveOpen(false)} title="Save to Strategy Manager">
        <div className="space-y-3">
          <Field label="Strategy name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          </Field>
          <p className="text-xs text-muted">Legs are saved at their entry prices and tracked live as a virtual (paper) position with MTM, Greeks and alerts.</p>
          {error ? <ErrorBox error={error} /> : null}
          <button className="btn-primary w-full" onClick={save}>Save</button>
        </div>
      </Modal>
    </div>
  );
}
