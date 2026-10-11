import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { describeStrategy, formatExpiry, formatINR, type SavedStrategy } from '@q26/core';
import { PayoffChart, StrategySummary, useStrategyView } from '../components/Payoff';
import { Card, cx, Empty, ErrorBox, Field, Loadable, Modal, PageHeader, Pill, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime, pnlClass } from '../lib/format';
import { useBuilder } from '../lib/store';

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
  return (
    <Modal open onClose={onClose} title={s.name} wide>
      <div className="space-y-3">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead><tr><th>Leg</th><th className="num">Lots</th><th className="num">Entry</th><th className="num">LTP</th><th className="num">Exit</th><th className="num">P&L</th><th></th></tr></thead>
            <tbody>
              {s.legs.map((l, i) => {
                const ltp = s.live?.legsLtp[i] ?? 0;
                const pnl = (l.side === 'BUY' ? 1 : -1) * l.lots * l.lotSize * ((l.exitPrice ?? ltp) - l.price);
                return (
                  <tr key={l.id ?? i}>
                    <td className={l.side === 'BUY' ? 'text-up' : 'text-down'}>{l.side} {l.type === 'FUT' ? 'FUT' : `${l.strike} ${l.type}`} · {formatExpiry(l.expiry)}</td>
                    <td className="num">{l.lots}</td>
                    <td className="num">{l.price.toFixed(2)}</td>
                    <td className="num">{ltp.toFixed(2)}</td>
                    <td className="num">{l.exitPrice != null ? l.exitPrice.toFixed(2) : '—'}</td>
                    <td className={cx('num', pnlClass(pnl))}>{formatINR(pnl)}</td>
                    <td>{l.exitPrice == null && s.status === 'open' && <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => act(() => api(`/strategies/${s.id}/exit`, { body: { legIds: [l.id] } }))}>Exit leg</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {view.analysis ? <PayoffChart view={view} height={260} /> : <Spinner />}
        {view.analysis && <StrategySummary view={view} />}
        {s.status === 'open' && (
          <div className="flex flex-wrap items-end gap-2">
            <Field label="MTM target (₹)"><input className="input w-32" type="number" value={target} onChange={(e) => setTarget(e.target.value)} /></Field>
            <Field label="MTM stop-loss (₹)"><input className="input w-32" type="number" value={sl} onChange={(e) => setSl(e.target.value)} /></Field>
            <button className="btn-ghost" onClick={() => act(() => api(`/strategies/${s.id}`, { method: 'PUT', body: { targetMtm: target ? Number(target) : null, stopLossMtm: sl ? Math.abs(Number(sl)) : null } }))}>Save alerts</button>
            <button className="btn-sell" onClick={() => act(() => api(`/strategies/${s.id}/exit`, { body: {} }))}>Exit all legs</button>
          </div>
        )}
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
  const total = (q.data ?? []).filter((s) => s.status === 'open').reduce((a, s) => a + (s.live?.mtm ?? 0), 0);
  return (
    <div className="space-y-3">
      <PageHeader title="Strategy Manager" subtitle="Virtual (paper) strategies tracked live — MTM, Greeks, payoff, leg-wise exits and MTM target / stop-loss alerts">
        <span className={cx('text-sm font-semibold', pnlClass(total))}>Open MTM {formatINR(total)}</span>
      </PageHeader>
      <Loadable q={q}>
        {(list) =>
          !list.length ? (
            <Card><Empty>No saved strategies. Build one in the Strategy Builder and click “Save virtual”.</Empty></Card>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {list.map((s) => (
                <button key={s.id} className="card card-pad text-left hover:border-accent/60" onClick={() => setOpenId(s.id)}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-semibold">{s.name}</span>
                    <Pill tone={s.status === 'open' ? 'accent' : 'muted'}>{s.status}</Pill>
                  </div>
                  <div className="text-xs text-muted">{s.symbol} · {describeStrategy(s.legs)} · {s.legs.length} legs</div>
                  <div className={cx('mt-2 text-xl font-bold tabular-nums', pnlClass(s.live?.mtm ?? 0))}>{formatINR(s.live?.mtm ?? 0)}</div>
                  <div className="mt-1 flex flex-wrap gap-2 text-2xs text-muted">
                    <span>Created {formatDateTime(s.createdAt)}</span>
                    {s.targetMtm != null && <span className="text-up">🎯 {formatINR(s.targetMtm)}</span>}
                    {s.stopLossMtm != null && <span className="text-down">🛑 −{formatINR(Math.abs(s.stopLossMtm))}</span>}
                  </div>
                </button>
              ))}
            </div>
          )
        }
      </Loadable>
      {selected && <Detail s={selected} onClose={() => setOpenId(null)} />}
    </div>
  );
}
