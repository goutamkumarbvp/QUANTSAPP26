import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { IvTableRow } from '@q26/core';
import { DataTable } from '../../components/DataTable';
import { Card, Chg, Coverage, cx, Dash, Loadable, PageHeader, Segmented, Val } from '../../components/ui';
import { formatExpiry, formatFixed, formatIndian } from '../../lib/format';
import { useLive } from '../../lib/hooks';
import { useApp } from '../../lib/store';

function Bar({ v }: { v: number }) {
  return (
    <div className="flex items-center justify-end gap-2">
      <span className="tabular-nums">{v.toFixed(0)}</span>
      <span className="relative h-1.5 w-16 overflow-hidden rounded bg-line">
        <span className={cx('absolute inset-y-0 left-0', v > 70 ? 'bg-down' : v < 30 ? 'bg-up' : 'bg-accent')} style={{ width: `${Math.max(2, v)}%` }} />
      </span>
    </div>
  );
}

export default function IvTable() {
  const q = useLive<IvTableRow[]>(['iv-table'], '/vol/table', 15000);
  const [kind, setKind] = useState<'all' | 'index' | 'stock'>('all');
  const [search, setSearch] = useState('');
  const setSymbol = useApp((s) => s.setSymbol);
  const navigate = useNavigate();
  const rows = useMemo(() => (q.data ?? []).filter((r) => (kind === 'all' || r.kind === kind) && (!search || r.symbol.includes(search.toUpperCase()))), [q.data, kind, search]);
  return (
    <div className="space-y-3">
      <PageHeader title="IV Rank & IV Percentile" subtitle="High IVP → options expensive (favour selling); low IVP → options cheap (favour buying)">
        <input className="input w-40" placeholder="Search symbol" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Segmented value={kind} onChange={setKind} options={[{ value: 'all', label: 'All' }, { value: 'index', label: 'Indices' }, { value: 'stock', label: 'Stocks' }]} />
      </PageHeader>
      <Card pad={false}>
        <Loadable q={q}>
          {(all) => {
            // IVR/IVP share one reason for every row (the official history is short for all of them).
            const rankWhy = all.find((r) => r.gaps?.ivr)?.gaps?.ivr;
            const withIv = all.filter((r) => r.iv !== null).length;
            const withRank = all.filter((r) => r.ivr !== null).length;
            return (
              <>
                <DataTable
                  rows={rows}
                  rowKey={(r) => r.symbol}
                  initialSort={{ key: 'ivp', dir: 'desc' }}
                  onRowClick={(r) => { setSymbol(r.symbol); navigate('/vol/iv-chart'); }}
                  empty="No underlying matches"
                  columns={[
                    { key: 'symbol', label: 'Symbol', value: (r) => r.symbol, render: (r) => <span className="font-semibold">{r.symbol}</span> },
                    { key: 'ltp', label: 'LTP', num: true, value: (r) => r.ltp, render: (r) => <Val value={r.ltp} format={(x) => formatIndian(x)} reason={r.gaps?.quote ?? 'No live price'} />, hideSm: true },
                    { key: 'chg', label: '% Chg', num: true, value: (r) => r.changePct, render: (r) => <Chg value={r.changePct} pct reason={r.gaps?.quote ?? 'Needs a live price and the previous close'} />, hideSm: true },
                    { key: 'exp', label: 'Expiry', value: (r) => r.expiry, render: (r) => (r.expiry ? formatExpiry(r.expiry) : <Dash reason={r.gaps?.iv ?? 'No listed option expiry'} />), hideSm: true },
                    { key: 'iv', label: <span title="ATM IV of that expiry, solved from live option premiums">ATM IV</span>, num: true, value: (r) => r.iv, render: (r) => <Val value={r.iv} format={(x) => formatFixed(x, 2)} reason={r.gaps?.iv ?? 'ATM IV needs live option premiums'} /> },
                    { key: 'ivc', label: <span title="Versus the same expiry's ATM IV solved from the previous session's official closes">IV Chg</span>, num: true, value: (r) => r.ivChange, render: (r) => <Chg value={r.ivChange} reason={r.gaps?.ivChange ?? 'Needs a live ATM IV and the previous session’s official closes'} /> },
                    { key: 'ivr', label: <span title="Where the ATM IV sits between its 1-year low and high (official ATM IV history)">IVR</span>, num: true, value: (r) => r.ivr, render: (r) => (r.ivr === null ? <Dash reason={r.gaps?.ivr ?? 'Needs the official ATM IV history'} /> : <Bar v={r.ivr} />) },
                    { key: 'ivp', label: <span title="Share of the last year's sessions with a lower ATM IV (official ATM IV history)">IVP</span>, num: true, value: (r) => r.ivp, render: (r) => (r.ivp === null ? <Dash reason={r.gaps?.ivr ?? 'Needs the official ATM IV history'} /> : <Bar v={r.ivp} />) },
                    { key: 'hv', label: <span title="20-day realised volatility of official closes">HV 20D</span>, num: true, value: (r) => r.hv, render: (r) => <Val value={r.hv} format={(x) => formatFixed(x, 2)} reason={r.gaps?.hv ?? 'HV 20D needs 21 consecutive official closes'} />, hideSm: true },
                    { key: 'spr', label: 'IV − HV', num: true, value: (r) => r.ivHvSpread, render: (r) => <Chg value={r.ivHvSpread} reason="Needs both an ATM IV and an HV" />, hideSm: true },
                  ]}
                />
                <div className="space-y-1 border-t border-line px-3 py-2">
                  <Coverage text={`${withIv} of ${all.length} underlyings have an ATM IV solved from live premiums; ${withRank} have an IV rank / percentile.`} />
                  {rankWhy && <Coverage label="IVR / IVP" text={rankWhy} />}
                </div>
              </>
            );
          }}
        </Loadable>
      </Card>
    </div>
  );
}
