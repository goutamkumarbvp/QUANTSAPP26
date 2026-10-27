import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { BuildUp, FuturesBuildUpRow } from '@q26/core';
import { DataTable } from '../../components/DataTable';
import { AsOf, BuildUpBadge, Card, Chg, Coverage, Dash, Loadable, PageHeader, Segmented, Val } from '../../components/ui';
import { formatCompact, formatExpiry, formatIndian } from '../../lib/format';
import { useLive } from '../../lib/hooks';
import { useApp } from '../../lib/store';

type Filter = 'all' | BuildUp;

export default function FuturesOI() {
  const q = useLive<FuturesBuildUpRow[]>(['futures-oi'], '/oi/futures', 10000);
  const [filter, setFilter] = useState<Filter>('all');
  const [kind, setKind] = useState<'all' | 'index' | 'stock' | 'commodity'>('all');
  const [search, setSearch] = useState('');
  const setSymbol = useApp((s) => s.setSymbol);
  const navigate = useNavigate();
  const rows = useMemo(
    () => (q.data ?? []).filter((r) => (filter === 'all' || r.buildUp === filter) && (kind === 'all' || r.kind === kind) && (!search || r.symbol.includes(search.toUpperCase()))),
    [q.data, filter, kind, search],
  );
  // Build-up needs a live price AND OI change vs the previous session: rows without one are counted apart.
  const counts = useMemo(() => {
    const m: Partial<Record<BuildUp, number>> = {};
    for (const r of q.data ?? []) if (r.buildUp) m[r.buildUp] = (m[r.buildUp] ?? 0) + 1;
    return m;
  }, [q.data]);
  const classified = (q.data ?? []).filter((r) => r.buildUp).length;
  return (
    <div className="space-y-3">
      <PageHeader title="Futures OI & Build-up" subtitle="Near-month futures of every underlying (indices, NIFTY top 10 stocks, MCX): price change vs OI change">
        <input className="input w-40" placeholder="Search symbol" value={search} onChange={(e) => setSearch(e.target.value)} />
      </PageHeader>
      <div className="flex flex-wrap gap-2">
        <Segmented value={filter} onChange={setFilter} options={[{ value: 'all', label: `All (${q.data?.length ?? 0})` }, ...(['Long Build-up', 'Short Build-up', 'Short Covering', 'Long Unwinding'] as BuildUp[]).map((b) => ({ value: b as Filter, label: `${b} (${counts[b] ?? 0})` }))]} />
        <Segmented value={kind} onChange={setKind} options={[{ value: 'all', label: 'All' }, { value: 'index', label: 'Indices' }, { value: 'commodity', label: 'MCX' }, { value: 'stock', label: 'Stocks' }]} />
      </div>
      <Card pad={false}>
        <Loadable q={q}>
          {(all) => (
            <>
              <DataTable
                rows={rows}
                rowKey={(r) => r.symbol}
                initialSort={{ key: 'oiChg', dir: 'desc' }}
                onRowClick={(r) => { setSymbol(r.symbol); navigate('/option-chain'); }}
                empty="No future matches"
                columns={[
                  { key: 'symbol', label: 'Symbol', value: (r) => r.symbol, render: (r) => <span className="font-semibold">{r.symbol}</span> },
                  { key: 'sector', label: 'Sector', value: (r) => r.sector, hideSm: true },
                  { key: 'exp', label: 'Expiry', value: (r) => r.expiry, render: (r) => formatExpiry(r.expiry), hideSm: true },
                  { key: 'ltp', label: 'Fut LTP', num: true, value: (r) => r.ltp, render: (r) => <Val value={r.ltp} format={(x) => formatIndian(x)} reason="The future has not traded in the live session" /> },
                  { key: 'chg', label: '% Chg', num: true, value: (r) => r.changePct, render: (r) => <Chg value={r.changePct} pct reason="Needs a live price and the previous close" /> },
                  { key: 'oi', label: 'OI', num: true, value: (r) => r.oi, render: (r) => <Val value={r.oi} format={(x) => formatCompact(x)} reason="No live open interest" />, hideSm: true },
                  { key: 'oiChg', label: 'OI Chg %', num: true, value: (r) => r.oiChangePct, render: (r) => <Chg value={r.oiChangePct} pct reason="Needs live OI and the previous session's OI" /> },
                  { key: 'vol', label: 'Volume', num: true, value: (r) => r.volume, render: (r) => <Val value={r.volume} format={(x) => formatCompact(x)} reason="No volume reported" />, hideSm: true },
                  { key: 'bu', label: 'Build-up', value: (r) => r.buildUp, render: (r) => <BuildUpBadge value={r.buildUp} reason="Needs a live price and OI change vs the previous session" /> },
                  { key: 'ts', label: 'Quote', value: (r) => r.ts, render: (r) => (r.ts === null ? <Dash reason="No quote received for this future" /> : <AsOf ts={r.ts} label="" />), hideSm: true },
                ]}
              />
              <div className="border-t border-line px-3 py-2">
                <Coverage text={`${classified} of ${all.length} near-month futures have a build-up (live price and OI change vs the previous session); the others are blank where an input is missing.`} />
              </div>
            </>
          )}
        </Loadable>
      </Card>
    </div>
  );
}
