import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatIndian, type BuildUp, type FuturesBuildUpRow } from '@q26/core';
import { DataTable } from '../../components/DataTable';
import { BuildUpBadge, Card, Chg, Loadable, PageHeader, Segmented } from '../../components/ui';
import { formatCompact } from '../../lib/format';
import { useLive } from '../../lib/hooks';
import { useApp } from '../../lib/store';

type Filter = 'all' | BuildUp;

export default function FuturesOI() {
  const q = useLive<FuturesBuildUpRow[]>(['futures-oi'], '/oi/futures', 10000);
  const [filter, setFilter] = useState<Filter>('all');
  const [kind, setKind] = useState<'all' | 'index' | 'stock'>('all');
  const [search, setSearch] = useState('');
  const setSymbol = useApp((s) => s.setSymbol);
  const navigate = useNavigate();
  const rows = useMemo(
    () => (q.data ?? []).filter((r) => (filter === 'all' || r.buildUp === filter) && (kind === 'all' || r.kind === kind) && (!search || r.symbol.includes(search.toUpperCase()))),
    [q.data, filter, kind, search],
  );
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of q.data ?? []) m[r.buildUp] = (m[r.buildUp] ?? 0) + 1;
    return m;
  }, [q.data]);
  return (
    <div className="space-y-3">
      <PageHeader title="Futures OI & Build-up" subtitle="Near-month futures of every F&O underlying: price change vs OI change">
        <input className="input w-40" placeholder="Search symbol" value={search} onChange={(e) => setSearch(e.target.value)} />
      </PageHeader>
      <div className="flex flex-wrap gap-2">
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: `All (${q.data?.length ?? 0})` }, ...(['Long Build-up', 'Short Build-up', 'Short Covering', 'Long Unwinding'] as BuildUp[]).map((b) => ({ value: b as Filter, label: `${b} (${counts[b] ?? 0})` }))]} />
        <Segmented value={kind} onChange={setKind} options={[{ value: 'all', label: 'All' }, { value: 'index', label: 'Indices' }, { value: 'stock', label: 'Stocks' }]} />
      </div>
      <Card pad={false}>
        <Loadable q={q}>
          {() => (
            <DataTable
              rows={rows}
              rowKey={(r) => r.symbol}
              initialSort={{ key: 'oiChg', dir: 'desc' }}
              onRowClick={(r) => { setSymbol(r.symbol); navigate('/option-chain'); }}
              columns={[
                { key: 'symbol', label: 'Symbol', value: (r) => r.symbol, render: (r) => <span className="font-semibold">{r.symbol}</span> },
                { key: 'sector', label: 'Sector', value: (r) => r.sector, hideSm: true },
                { key: 'ltp', label: 'Fut LTP', num: true, value: (r) => r.ltp, render: (r) => formatIndian(r.ltp) },
                { key: 'chg', label: '% Chg', num: true, value: (r) => r.changePct, render: (r) => <Chg value={r.changePct} pct /> },
                { key: 'oi', label: 'OI', num: true, value: (r) => r.oi, render: (r) => formatCompact(r.oi), hideSm: true },
                { key: 'oiChg', label: 'OI Chg %', num: true, value: (r) => r.oiChangePct, render: (r) => <Chg value={r.oiChangePct} pct /> },
                { key: 'vol', label: 'Volume', num: true, value: (r) => r.volume, render: (r) => formatCompact(r.volume), hideSm: true },
                { key: 'bu', label: 'Build-up', value: (r) => r.buildUp, render: (r) => <BuildUpBadge value={r.buildUp} /> },
              ]}
            />
          )}
        </Loadable>
      </Card>
    </div>
  );
}
