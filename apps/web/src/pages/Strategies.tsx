import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { describeStrategy, formatExpiry, formatINR, type Leg, type SavedStrategy } from '@q26/core';
import { PayoffChart, StrategySummary, useStrategyView } from '../components/Payoff';
import { AsOf, Card, cx, Empty, ErrorBox, Field, Gaps, Loadable, Modal, NoData, PageHeader, Pill, Spinner, Val } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime, isNum, pnlClass } from '../lib/format';
import { useBuilder } from '../lib/store';

/** The label the server names a leg by in `live.gaps`. */
const gapKey = (symbol: string, l: Leg) => (l.type === 'FUT' ? `${symbol} ${formatExpiry(l.expiry)} FUT` : `${symbol} ${formatExpiry(l.expiry)} ${l.strike} ${l.type}`);

/** Colour class of an MTM that may be unknown. */
const tone = (x: number | null | undefined) => pnlClass(x ?? null);

function Detail({ s, onClose }: { s: SavedStrategy; onClose: () => void }) {
  const qc = useQueryClient();
  const builder = useBuilder();
  const navigate = useNavigate();
  const [target, setTarget] = useState(s.targetMtm?.toString() ?? '');
  const [sl, setSl] = useState(s.stopLossMtm?.toString() ?? '');
  const [error, setError] = useState<unknown>(null);
  const view = useStrategyView(s.symbol, s.legs);
  const refresh = () => qc.invalidateQueries({ queryKey: ['strategies'] });
  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(e);
    }
  };
  const live = s.live;
  return (
    <Modal open onClose={onClose} title={s.name} wide>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
          <span>MTM <b className={cx('text-sm tabular-nums', tone(live?.mtm))}><Val value={live?.mtm} format={(x) => formatINR(x)} reason={live ? Object.values(live.gaps ?? {})[0] ?? 'A leg has no live price' : 'No live valuation yet'} /></b></span>
          <AsOf ts={live?.ts} label="valued" />
        </div>
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Leg</th><th className="num">Lots</th><th className="num">Entry</th><th className="num">LTP</th><th className="num">Exit</th><th className="num">P&L</th><th></th></tr></thead>
            <tbody>
              {s.legs.map((l, i) => {
                // The live price comes from the server's valuation; a leg without one has no P&L (never an LTP of 0).
                const ltp = live?.legsLtp[i] ?? null;
                const exit = l.exitPrice ?? ltp;
                const pnl = exit === null ? null : (l.side === 'BUY' ? 1 : -1) * l.lots * l.lotSize * (exit - l.price);
                const why = l.active === false ? 'Leg is switched off' : live?.gaps?.[gapKey(s.symbol, l)] ?? (live ? 'No live price' : 'No live valuation yet');
                return (
                  <tr key={l.id ?? i}>
                    <td className={l.side === 'BUY' ? 'text-up' : 'text-down'}>{l.side} {l.type === 'FUT' ? 'FUT' : `${l.strike} ${l.type}`} · {formatExpiry(l.expiry)}</td>
                    <td className="num">{l.lots}</td>
                    <td className="num">{l.price.toFixed(2)}</td>
                    <td className="num"><Val value={ltp} format={(x) => x.toFixed(2)} reason={why} /></td>
                    <td className="num">{l.exitPrice != null ? l.exitPrice.toFixed(2) : '—'}</td>
                    <td className={cx('num', tone(pnl))}><Val value={pnl} format={(x) => formatINR(x)} reason={why} /></td>
                    <td>{l.exitPrice == null && s.status === 'open' && <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => act(() => api(`/strategies/${s.id}/exit`, { body: { legIds: [l.id] } }))}>Exit leg</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <Gaps gaps={live?.gaps} />
        {view.analysis ? <PayoffChart view={view} height={260} /> : view.loading || !view.blank ? <Spinner /> : <NoData compact title="No payoff available" reason={view.blank} />}
        {view.analysis && <StrategySummary view={view} />}
        {s.status === 'open' && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="MTM target (₹)"><input className="input w-32" type="number" value={target} onChange={(e) => setTarget(e.target.value)} /></Field>
            <Field label="MTM stop-loss (₹)"><input className="input w-32" type="number" value={sl} onChange={(e) => setSl(e.target.value)} /></Field>
            <button className="btn-ghost" onClick={() => act(() => api(`/strategies/${s.id}`, { method: 'PUT', body: { targetMtm: target ? Number(target) : null, stopLossMtm: sl ? Math.abs(Number(sl)) : null } }))}>Save alerts</button>
            <button className="btn-sell" onClick={() => act(() => api(`/strategies/${s.id}/exit`, { body: {} }))}>Exit all legs</button>
          </div>
        )}
        {s.status === 'open' && <p className="text-2xs text-muted">Target and stop-loss are checked against the live MTM; while a leg has no live price the MTM is unknown and the check is skipped.</p>}
        {error ? <ErrorBox error={error} /> : null}
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost" onClick={() => { builder.setLegs(s.symbol, s.legs.filter((l) => l.exitPrice == null).map((l) => ({ ...l }))); navigate('/builder'); }}>Open in builder</button>
          <button className="btn-ghost text-down" onClick={() => confirm('Delete this strategy?') && act(async () => { await api(`/strategies/${s.id}`, { method: 'DELETE' }); onClose(); })}>Delete</button>
        </div>
      </div>
    </Modal>
  );
}

export default function Strategies() {
  const q = useQuery({ queryKey: ['strategies'], queryFn: () => api<SavedStrategy[]>('/strategies'), refetchInterval: 3000 });
  const [openId, setOpenId] = useState<string | null>(null);
  const selected = q.data?.find((s) => s.id === openId);
  // The open MTM adds up only when every open strategy has one: a partial sum would look like the whole.
  const openOnes = (q.data ?? []).filter((s) => s.status === 'open');
  const unknown = openOnes.filter((s) => !isNum(s.live?.mtm));
  const total = unknown.length || !q.data ? null : openOnes.reduce((a, s) => a + (s.live?.mtm ?? 0), 0);
  return (
    <div className="space-y-3">
      <PageHeader title="Strategy Manager" subtitle="Virtual (paper) strategies tracked live — MTM, Greeks, payoff, leg-wise exits and MTM target / stop-loss alerts">
        <span className={cx('text-sm font-semibold', tone(total))} title={total === null && unknown.length ? `No live MTM for ${unknown.map((s) => s.name).join(', ')}` : undefined}>Open MTM <Val value={total} format={(x) => formatINR(x)} reason={unknown.length ? `No live MTM for ${unknown.length} open strateg${unknown.length === 1 ? 'y' : 'ies'}` : 'Strategies have not loaded'} /></span>
      </PageHeader>
      <Loadable q={q}>
        {(list) =>
          !list.length ? (
            <Card><Empty>No saved strategies. Build one in the Strategy Builder and click “Save virtual”.</Empty></Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((s) => {
                const why = s.live ? Object.values(s.live.gaps ?? {})[0] ?? 'A leg has no live price' : 'No live valuation yet';
                return (
                  <button key={s.id} className="card card-pad text-left hover:border-accent/60" onClick={() => setOpenId(s.id)}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-semibold">{s.name}</span>
                      <Pill tone={s.status === 'open' ? 'accent' : 'muted'}>{s.status}</Pill>
                    </div>
                    <div className="text-xs text-muted">{s.symbol} · {describeStrategy(s.legs)} · {s.legs.length} legs</div>
                    <div className={cx('mt-2 text-xl font-bold tabular-nums', tone(s.live?.mtm))}><Val value={s.live?.mtm} format={(x) => formatINR(x)} reason={why} /></div>
                    {s.status === 'open' && !isNum(s.live?.mtm) && <div className="truncate text-2xs text-muted" title={why}>{why}</div>}
                    <div className="mt-1 flex flex-wrap gap-2 text-2xs text-muted">
                      <span>Created {formatDateTime(s.createdAt)}</span>
                      {s.live && <AsOf ts={s.live.ts} label="valued" />}
                      {s.targetMtm != null && <span className="text-up">🎯 {formatINR(s.targetMtm)}</span>}
                      {s.stopLossMtm != null && <span className="text-down">🛑 −{formatINR(Math.abs(s.stopLossMtm))}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          )
        }
      </Loadable>
      {selected && <Detail s={selected} onClose={() => setOpenId(null)} />}
    </div>
  );
}
