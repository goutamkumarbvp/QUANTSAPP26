import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { DAY_MS, describeStrategy, formatExpiry, formatINR, type InstrumentType, type Leg, type Order, type SavedStrategy } from '@q26/core';
import { PayoffChart, ScenarioTable, StrategySummary, useStrategyView } from '../components/Payoff';
import { SymbolSelect } from '../components/pickers';
import { Card, cx, ErrorBox, Field, Modal, PageHeader, Segmented } from '../components/ui';
import { api } from '../lib/api';
import { useExpiries } from '../lib/hooks';
import { useBuilder, type BuilderLeg } from '../lib/store';

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

export default function Builder() {
  const b = useBuilder();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const exp = useExpiries(b.symbol);
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
  const view = useStrategyView(b.symbol, b.legs, { targetDays, ivShift, extraExpiry: newLegExpiry });
  const chain = newLegExpiry ? view.chains[newLegExpiry] : undefined;
  const maxDays = view.expiryTs && view.nowTs ? Math.max(0, Math.floor((view.expiryTs - view.nowTs) / DAY_MS)) : 0;
  useEffect(() => {
    if (targetDays > maxDays) setTargetDays(maxDays);
  }, [maxDays, targetDays]);

  const [newSide, setNewSide] = useState<'BUY' | 'SELL'>('BUY');
  const [newType, setNewType] = useState<InstrumentType>('CE');
  const [newStrike, setNewStrike] = useState<number>(0);
  const [newLots, setNewLots] = useState(1);
  const strikes = chain?.rows.map((r) => r.strike) ?? [];
  const strikeValue = strikes.includes(newStrike) ? newStrike : chain?.atm ?? 0;

  const quoteFor = (type: InstrumentType, strike: number, expiry: string) => {
    const c = view.chains[expiry];
    if (type === 'FUT') return { price: view.nearestChain?.future ?? 0, iv: undefined };
    const row = c?.rows.find((r) => r.strike === strike);
    const q = row ? (type === 'CE' ? row.ce : row.pe) : undefined;
    return { price: q?.ltp ?? 0, iv: q ? q.iv / 100 : undefined };
  };

  const addLeg = () => {
    if (!chain || !newLegExpiry) return;
    const futExp = exp.data?.futures[0] ?? newLegExpiry;
    const expiry = newType === 'FUT' ? futExp : newLegExpiry;
    const q = quoteFor(newType, strikeValue, newLegExpiry);
    b.add({ symbol: b.symbol, side: newSide, type: newType, strike: newType === 'FUT' ? 0 : strikeValue, expiry, lots: newLots, lotSize: chain.lotSize, price: q.price, iv: q.iv });
  };

  const updateContract = (l: BuilderLeg, patch: Partial<BuilderLeg>) => {
    const next = { ...l, ...patch };
    const q = quoteFor(next.type, next.strike, next.expiry);
    b.update(l.id, { ...patch, price: q.price || l.price });
  };

  const name0 = useMemo(() => describeStrategy(b.legs), [b.legs]);

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
        body: { orders: b.legs.filter((l) => l.active !== false && l.exitPrice == null).map((l) => ({ symbol: b.symbol, type: l.type, strike: l.type === 'FUT' ? undefined : l.strike, expiry: l.expiry, side: l.side, lots: l.lots, orderType: 'MARKET', product: 'NRML', tag: 'builder' })) },
      });
      const ok = res.filter((r) => 'status' in r && r.status === 'COMPLETE').length;
      const failed = res.filter((r) => 'error' in r || ('status' in r && r.status === 'REJECTED'));
      qc.invalidateQueries({ queryKey: ['broker'] });
      setMsg({ tone: failed.length ? 'down' : 'up', text: `${ok}/${res.length} legs executed in paper account${failed.length ? ` — ${failed.map((f) => ('error' in f ? f.error : (f as Order).message)).join('; ')}` : ''}` });
    } catch (e) {
      setMsg({ tone: 'down', text: e instanceof Error ? e.message : String(e) });
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
            <select className="input w-auto" value={newLegExpiry ?? ''} onChange={(e) => setAddExpiry(e.target.value)}>
              {options.map((e) => <option key={e} value={e}>{formatExpiry(e)}</option>)}
            </select>
          </Field>
          {newType !== 'FUT' && (
            <Field label="Strike">
              <select className="input w-auto" value={strikeValue} onChange={(e) => setNewStrike(Number(e.target.value))}>
                {strikes.map((k) => (
                  <option key={k} value={k}>{k}{k === chain?.atm ? ' (ATM)' : ''}</option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Lots">
            <input className="input w-20" type="number" min={1} value={newLots} onChange={(e) => setNewLots(Math.max(1, Number(e.target.value) || 1))} />
          </Field>
          <div className="text-xs text-muted">
            Premium <b className="text-ink">{chain ? quoteFor(newType, strikeValue, newLegExpiry!).price.toFixed(2) : '—'}</b>
          </div>
          <button className={newSide === 'BUY' ? 'btn-buy' : 'btn-sell'} onClick={addLeg} disabled={!chain}>
            + Add {newSide === 'BUY' ? 'Buy' : 'Sell'} {newType}
          </button>
        </div>
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
              <button className="btn-primary px-2 py-1 text-xs" onClick={execute}>⚡ Execute (paper)</button>
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
                            {options.map((e) => <option key={e} value={e}>{formatExpiry(e)}</option>)}
                          </select>
                        )}
                      </td>
                      <td>
                        {l.type === 'FUT' ? '—' : (
                          <select className="input w-auto py-0.5 text-xs" value={l.strike} onChange={(e) => updateContract(l, { strike: Number(e.target.value) })}>
                            {(legChain?.rows.map((r) => r.strike) ?? [l.strike]).map((k) => <option key={k} value={k}>{k}</option>)}
                          </select>
                        )}
                      </td>
                      <td>
                        {l.type === 'FUT' ? 'FUT' : (
                          <button className="chip cursor-pointer bg-panel2" onClick={() => updateContract(l, { type: l.type === 'CE' ? 'PE' : 'CE' })}>{l.type}</button>
                        )}
                      </td>
                      <td className="num">
                        <input className="input w-16 py-0.5 text-right text-xs" type="number" min={1} value={l.lots} onChange={(e) => b.update(l.id, { lots: Math.max(1, Number(e.target.value) || 1) })} />
                      </td>
                      <td className="num">
                        <input className="input w-20 py-0.5 text-right text-xs" type="number" step="0.05" value={l.price} onChange={(e) => b.update(l.id, { price: Math.max(0, Number(e.target.value) || 0) })} />
                      </td>
                      <td className="num">{m ? m.ltp.toFixed(2) : '—'}</td>
                      <td className="num">{m && l.type !== 'FUT' ? (m.marketIv * 100).toFixed(1) : '—'}</td>
                      <td className="num">{m ? m.delta.toFixed(1) : '—'}</td>
                      <td className="num">{m ? m.theta.toFixed(0) : '—'}</td>
                      <td className={cx('num font-medium', (m?.pnl ?? 0) >= 0 ? 'text-up' : 'text-down')}>{m ? formatINR(m.pnl) : '—'}</td>
                      <td>
                        <button className="text-muted hover:text-down" onClick={() => b.remove(l.id)} aria-label="Remove leg">✕</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
