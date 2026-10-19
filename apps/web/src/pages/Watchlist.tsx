import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type WatchItem, type Watchlist as WL, type WatchQuote } from '@q26/core';
import { OrderTicket, type TicketSpec } from '../components/OrderTicket';
import { pickStrike, StrikeSelect, SymbolSelect } from '../components/pickers';
import { AsOf, Card, Chg, Dash, Empty, ErrorBox, ErrorState, Field, Loadable, PageHeader, Segmented, Val } from '../components/ui';
import { api, isNoLiveData } from '../lib/api';
import { formatCompact, formatExpiry, formatIndian } from '../lib/format';
import { useChain, useExpiries } from '../lib/hooks';
import { useApp } from '../lib/store';

/** Row label before (or without) a priced quote: the instrument itself. */
function itemLabel(it: WatchItem): string {
  if (it.type === 'EQ') return it.symbol;
  if (it.type === 'FUT') return `${it.symbol} ${formatExpiry(it.expiry)} FUT`;
  return `${it.symbol} ${formatExpiry(it.expiry)} ${it.strike} ${it.type}`;
}

function AddItem({ onAdd }: { onAdd: (it: WatchItem) => void }) {
  const [symbol, setSymbol] = useState('RELIANCE');
  const [type, setType] = useState<WatchItem['type']>('EQ');
  const [expiry, setExpiry] = useState<string>();
  const [strike, setStrike] = useState<number>();
  const exp = useExpiries(symbol);
  const isOpt = type === 'CE' || type === 'PE';
  const list = (type === 'FUT' ? exp.data?.futures : exp.data?.options) ?? [];
  const e = expiry && list.includes(expiry) ? expiry : list[0];
  const chain = useChain(symbol, isOpt ? e : undefined, { refetch: false, enabled: isOpt && !!e });
  const chainData = chain.data?.symbol === symbol && chain.data.expiry === e ? chain.data : undefined;
  const k = isOpt ? pickStrike(chainData, strike) : undefined;
  const blocked = type !== 'EQ' && !e ? 'No listed expiry' : isOpt && k === undefined ? 'No strike: the option chain is not available' : null;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <SymbolSelect value={symbol} onChange={setSymbol} />
      <Segmented value={type} onChange={setType} options={[{ value: 'EQ', label: 'Spot' }, { value: 'FUT', label: 'Fut' }, { value: 'CE', label: 'CE' }, { value: 'PE', label: 'PE' }]} />
      {type !== 'EQ' && (
        <Field label="Expiry">
          <select className="input w-auto" value={e ?? ''} disabled={!list.length} title={list.length ? undefined : 'No listed expiry'} onChange={(ev) => setExpiry(ev.target.value)}>
            {list.map((x) => <option key={x} value={x}>{formatExpiry(x)}</option>)}
            {!list.length && <option value="">{exp.isLoading ? 'Loading…' : 'No expiry'}</option>}
          </select>
        </Field>
      )}
      {isOpt && (
        <Field label="Strike">
          <StrikeSelect chain={chainData} value={k} onChange={setStrike} error={chain.error} loading={chain.isLoading} />
        </Field>
      )}
      <button className="btn-primary" disabled={!!blocked} title={blocked ?? undefined} onClick={() => onAdd({ symbol, type, expiry: type === 'EQ' ? undefined : e, strike: isOpt ? k : undefined })}>+ Add</button>
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
  // The server says nothing is live: the last prices are not kept on screen.
  const priced = isNoLiveData(quotes.error) ? undefined : quotes.data;
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
            {quotes.error && !priced ? <ErrorState error={quotes.error} compact title="No live prices" /> : null}
            <Card pad={false}>
              {!active?.items.length ? <Empty>This watchlist is empty.</Empty> : (
                <div className="overflow-x-auto">
                  <table className="tbl">
                    <thead><tr><th>Instrument</th><th className="num">LTP</th><th className="num">Chg</th><th className="num">% Chg</th><th className="num hidden sm:table-cell">OI</th><th className="num hidden sm:table-cell">OI Chg %</th><th className="num hidden sm:table-cell">IV</th><th></th></tr></thead>
                    <tbody>
                      {/* One row per saved instrument, so it can always be removed; its quote (when the server priced it) is matched by position. */}
                      {active.items.map((it, i) => {
                        const q = priced?.[i];
                        const why = q?.reason ?? (priced ? 'No live price' : quotes.isLoading ? 'Loading the live price…' : 'Prices are not available');
                        const label = q?.label ?? itemLabel(it);
                        return (
                          <tr key={`${label}-${i}`}>
                            <td>
                              <button className="font-medium hover:underline" onClick={() => { setSymbol(it.symbol); navigate('/option-chain'); }}>{label}</button>
                              {q?.reason && q.ltp === null && <div className="max-w-[18rem] whitespace-normal text-2xs text-muted">{q.reason}</div>}
                            </td>
                            <td className="num font-semibold">
                              <Val value={q?.ltp} format={formatIndian} reason={why} />
                              <div className="font-normal"><AsOf ts={q?.ts} label="" /></div>
                            </td>
                            <td className="num"><Chg value={q?.change} reason={why} /></td>
                            <td className="num"><Chg value={q?.changePct} pct reason={why} /></td>
                            <td className="num hidden sm:table-cell"><Val value={q?.oi} format={formatCompact} reason={it.type === 'EQ' ? 'Spot has no open interest' : why} /></td>
                            <td className="num hidden sm:table-cell">{it.type === 'EQ' ? <Dash reason="Spot has no open interest" /> : <Chg value={q?.oiChangePct} pct reason={why} />}</td>
                            <td className="num hidden sm:table-cell"><Val value={q?.iv} format={(x) => x.toFixed(2)} reason={q?.ltp ? 'IV is solved from a live premium' : why} /></td>
                            <td className="whitespace-nowrap">
                              {it.type !== 'EQ' && it.expiry && (
                                <>
                                  <button className="rounded bg-up px-1.5 text-2xs font-bold text-white" onClick={() => setTicket({ symbol: it.symbol, type: it.type as 'CE' | 'PE' | 'FUT', strike: it.strike, expiry: it.expiry!, side: 'BUY', price: q?.ltp ?? null })}>B</button>{' '}
                                  <button className="rounded bg-down px-1.5 text-2xs font-bold text-white" onClick={() => setTicket({ symbol: it.symbol, type: it.type as 'CE' | 'PE' | 'FUT', strike: it.strike, expiry: it.expiry!, side: 'SELL', price: q?.ltp ?? null })}>S</button>{' '}
                                </>
                              )}
                              <button className="text-muted hover:text-down" aria-label="Remove" onClick={() => save(active.items.filter((_, j) => j !== i))}>✕</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
            <p className="text-2xs text-muted">LTP is the last trade of the live session with the time of the quote beneath it; a blank value means the contract has no live price (the reason is on hover).</p>
          </>
        )}
      </Loadable>
      <OrderTicket spec={ticket} onClose={() => setTicket(null)} />
    </div>
  );
}
