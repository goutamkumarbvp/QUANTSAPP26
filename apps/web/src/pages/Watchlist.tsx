import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatExpiry, formatIndian, type WatchItem, type Watchlist as WL, type WatchQuote } from '@q26/core';
import { OrderTicket, type TicketSpec } from '../components/OrderTicket';
import { SymbolSelect } from '../components/pickers';
import { Card, Chg, cx, Empty, ErrorBox, Field, Loadable, PageHeader, Segmented } from '../components/ui';
import { api } from '../lib/api';
import { formatCompact } from '../lib/format';
import { useChain, useExpiries } from '../lib/hooks';
import { useApp } from '../lib/store';

function AddItem({ onAdd }: { onAdd: (it: WatchItem) => void }) {
  const [symbol, setSymbol] = useState('RELIANCE');
  const [type, setType] = useState<WatchItem['type']>('EQ');
  const [expiry, setExpiry] = useState<string>();
  const [strike, setStrike] = useState<number>();
  const exp = useExpiries(symbol);
  const list = (type === 'FUT' ? exp.data?.futures : exp.data?.options) ?? [];
  const e = expiry && list.includes(expiry) ? expiry : list[0];
  const chain = useChain(symbol, type === 'CE' || type === 'PE' ? e : undefined, { refetch: false });
  const k = strike && chain.data?.rows.some((r) => r.strike === strike) ? strike : chain.data?.atm;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <SymbolSelect value={symbol} onChange={setSymbol} />
      <Segmented value={type} onChange={setType} options={[{ value: 'EQ', label: 'Spot' }, { value: 'FUT', label: 'Fut' }, { value: 'CE', label: 'CE' }, { value: 'PE', label: 'PE' }]} />
      {type !== 'EQ' && (
        <Field label="Expiry">
          <select className="input w-auto" value={e ?? ''} onChange={(ev) => setExpiry(ev.target.value)}>
            {list.map((x) => <option key={x} value={x}>{formatExpiry(x)}</option>)}
          </select>
        </Field>
      )}
      {(type === 'CE' || type === 'PE') && (
        <Field label="Strike">
          <select className="input w-auto" value={k ?? ''} onChange={(ev) => setStrike(Number(ev.target.value))}>
            {(chain.data?.rows ?? []).map((r) => <option key={r.strike} value={r.strike}>{r.strike}</option>)}
          </select>
        </Field>
      )}
      <button className="btn-primary" onClick={() => onAdd({ symbol, type, expiry: type === 'EQ' ? undefined : e, strike: type === 'CE' || type === 'PE' ? k : undefined })}>+ Add</button>
    </div>
  );
}

export default function Watchlist() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const setSymbol = useApp((s) => s.setSymbol);
  const lists = useQuery({ queryKey: ['watchlists'], queryFn: () => api<WL[]>('/watchlists') });
  const [activeId, setActiveId] = useState<string>();
  const [ticket, setTicket] = useState<TicketSpec | null>(null);
  const [error, setError] = useState<unknown>(null);
  const active = lists.data?.find((w) => w.id === activeId) ?? lists.data?.[0];
  const quotes = useQuery({ queryKey: ['watch-quotes', active?.id, active?.items.length], queryFn: () => api<WatchQuote[]>(`/watchlists/${active!.id}/quotes`), enabled: !!active, refetchInterval: 2000 });
  const save = async (items: WatchItem[]) => {
    setError(null);
    try {
      await api(`/watchlists/${active!.id}`, { method: 'PUT', body: { items } });
      qc.invalidateQueries({ queryKey: ['watchlists'] });
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="space-y-3">
      <PageHeader title="Watchlist" subtitle="Underlyings, futures and option contracts — live">
        <button className="btn-ghost" onClick={async () => { const name = prompt('Watchlist name'); if (name !== null) { const w = await api<WL>('/watchlists', { body: { name } }); await qc.invalidateQueries({ queryKey: ['watchlists'] }); setActiveId(w.id); } }}>+ New list</button>
      </PageHeader>
      <Loadable q={lists}>
        {(ls) => (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Segmented value={active?.id ?? ''} onChange={setActiveId} options={ls.map((w) => ({ value: w.id, label: `${w.name} (${w.items.length})` }))} />
              {active && ls.length > 1 && (
                <button className="text-xs text-down" onClick={async () => { if (confirm(`Delete “${active.name}”?`)) { await api(`/watchlists/${active.id}`, { method: 'DELETE' }); setActiveId(undefined); qc.invalidateQueries({ queryKey: ['watchlists'] }); } }}>Delete list</button>
              )}
            </div>
            {active && (
              <Card title="Add instrument">
                <AddItem onAdd={(it) => save([...active.items, it])} />
                {error ? <div className="mt-2"><ErrorBox error={error} /></div> : null}
              </Card>
            )}
            <Card pad={false}>
              {!active?.items.length ? <Empty>This watchlist is empty.</Empty> : (
                <div className="overflow-x-auto">
                  <table className="tbl">
                    <thead><tr><th>Instrument</th><th className="num">LTP</th><th className="num">Chg</th><th className="num">% Chg</th><th className="num hidden sm:table-cell">OI</th><th className="num hidden sm:table-cell">OI Chg %</th><th className="num hidden sm:table-cell">IV</th><th></th></tr></thead>
                    <tbody>
                      {(quotes.data ?? []).map((q, i) => (
                        <tr key={`${q.label}-${i}`}>
                          <td>
                            <button className="font-medium hover:underline" onClick={() => { setSymbol(q.symbol); navigate('/option-chain'); }}>{q.label}</button>
                          </td>
                          <td className="num font-semibold">{formatIndian(q.ltp)}</td>
                          <td className="num"><Chg value={q.change} /></td>
                          <td className="num"><Chg value={q.changePct} pct /></td>
                          <td className="num hidden sm:table-cell">{q.oi !== undefined ? formatCompact(q.oi) : '—'}</td>
                          <td className={cx('num hidden sm:table-cell')}>{q.oiChangePct !== undefined ? <Chg value={q.oiChangePct} pct /> : '—'}</td>
                          <td className="num hidden sm:table-cell">{q.iv !== undefined ? q.iv.toFixed(2) : '—'}</td>
                          <td className="whitespace-nowrap">
                            {q.type !== 'EQ' && q.expiry && (
                              <>
                                <button className="rounded bg-up px-1.5 text-2xs font-bold text-white" onClick={() => setTicket({ symbol: q.symbol, type: q.type as 'CE' | 'PE' | 'FUT', strike: q.strike, expiry: q.expiry!, side: 'BUY', price: q.ltp })}>B</button>{' '}
                                <button className="rounded bg-down px-1.5 text-2xs font-bold text-white" onClick={() => setTicket({ symbol: q.symbol, type: q.type as 'CE' | 'PE' | 'FUT', strike: q.strike, expiry: q.expiry!, side: 'SELL', price: q.ltp })}>S</button>{' '}
                              </>
                            )}
                            <button className="text-muted hover:text-down" aria-label="Remove" onClick={() => save(active.items.filter((_, j) => j !== i))}>✕</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </>
        )}
      </Loadable>
      <OrderTicket spec={ticket} onClose={() => setTicket(null)} />
    </div>
  );
}
