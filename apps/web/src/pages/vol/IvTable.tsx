import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatIndian, type IvTableRow } from '@q26/core';
import { DataTable } from '../../components/DataTable';
import { Card, Chg, cx, Loadable, PageHeader, Segmented } from '../../components/ui';
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
          {() => (
            <DataTable
              rows={rows}
              rowKey={(r) => r.symbol}
              initialSort={{ key: 'ivp', dir: 'desc' }}
              onRowClick={(r) => { setSymbol(r.symbol); navigate('/vol/iv-chart'); }}
              columns={[
                { key: 'symbol', label: 'Symbol', value: (r) => r.symbol, render: (r) => <span className="font-semibold">{r.symbol}</span> },
                { key: 'ltp', label: 'LTP', num: true, value: (r) => r.ltp, render: (r) => formatIndian(r.ltp), hideSm: true },
                { key: 'chg', label: '% Chg', num: true, value: (r) => r.changePct, render: (r) => <Chg value={r.changePct} pct />, hideSm: true },
                { key: 'iv', label: 'ATM IV', num: true, value: (r) => r.iv, render: (r) => r.iv.toFixed(2) },
                { key: 'ivc', label: 'IV Chg', num: true, value: (r) => r.ivChange, render: (r) => <Chg value={r.ivChange} /> },
                { key: 'ivr', label: 'IVR', num: true, value: (r) => r.ivr, render: (r) => <Bar v={r.ivr} /> },
                { key: 'ivp', label: 'IVP', num: true, value: (r) => r.ivp, render: (r) => <Bar v={r.ivp} /> },
                { key: 'hv', label: 'HV 20D', num: true, value: (r) => r.hv, render: (r) => r.hv.toFixed(2), hideSm: true },
                { key: 'spr', label: 'IV − HV', num: true, value: (r) => r.ivHvSpread, render: (r) => <Chg value={r.ivHvSpread} />, hideSm: true },
              ]}
            />
          )}
        </Loadable>
      </Card>
    </div>
  );
}
