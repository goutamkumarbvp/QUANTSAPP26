import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { formatIndian, type ScannerDef, type ScannerRow } from '@q26/core';
import { DataTable } from '../components/DataTable';
import { BuildUpBadge, Card, Chg, cx, Loadable, PageHeader } from '../components/ui';
import { api } from '../lib/api';
import { formatCompact } from '../lib/format';
import { useLive } from '../lib/hooks';
import { useApp } from '../lib/store';

export default function Scanners() {
  const defs = useQuery({ queryKey: ['scanner-defs'], queryFn: () => api<ScannerDef[]>('/scanners'), staleTime: Infinity });
  const [params, setParams] = useSearchParams();
  const id = params.get('id') ?? 'long-buildup';
  const q = useLive<ScannerRow[]>(['scanner', id], `/scanners/${id}?limit=40`, 10000);
  const setSymbol = useApp((s) => s.setSymbol);
  const navigate = useNavigate();
  const groups = useMemo(() => {
    const m = new Map<string, ScannerDef[]>();
    for (const d of defs.data ?? []) m.set(d.category, [...(m.get(d.category) ?? []), d]);
    return [...m.entries()];
  }, [defs.data]);
  const def = defs.data?.find((d) => d.id === id);
  const label = q.data?.[0]?.metricLabel ?? 'Metric';
  return (
    <div className="space-y-3">
      <PageHeader title="F&O Scanners" subtitle="Pre-built scans across every F&O future and near-expiry option — refreshed live" />
      <div className="grid gap-3 lg:grid-cols-4">
        <Card title="Scans" pad={false}>
          <nav className="max-h-[70vh] overflow-y-auto py-1">
            {groups.map(([cat, list]) => (
              <div key={cat} className="px-2 py-1">
                <div className="px-1 text-2xs font-semibold uppercase tracking-wider text-muted">{cat}</div>
                {list.map((d) => (
                  <button key={d.id} onClick={() => setParams({ id: d.id })} className={cx('block w-full rounded px-2 py-1 text-left text-sm', d.id === id ? 'bg-accent/15 font-semibold text-accent' : 'hover:bg-panel2')}>
                    {d.name}
                  </button>
                ))}
              </div>
            ))}
          </nav>
        </Card>
        <Card title={def?.name ?? id} className="lg:col-span-3" pad={false} actions={<span className="text-xs text-muted">{def?.description}</span>}>
          <Loadable q={q}>
            {(rows) => (
              <DataTable
                rows={rows}
                rowKey={(r) => r.instrument}
                onRowClick={(r) => { setSymbol(r.symbol); navigate('/option-chain'); }}
                columns={[
                  { key: 'instrument', label: 'Instrument', value: (r) => r.instrument, render: (r) => <span className="font-medium">{r.instrument}</span> },
                  { key: 'ltp', label: 'LTP', num: true, value: (r) => r.ltp, render: (r) => formatIndian(r.ltp) },
                  { key: 'chg', label: '% Chg', num: true, value: (r) => r.changePct, render: (r) => <Chg value={r.changePct} pct /> },
                  { key: 'oi', label: 'OI', num: true, value: (r) => r.oi, render: (r) => (r.oi ? formatCompact(r.oi) : '—'), hideSm: true },
                  { key: 'oic', label: 'OI Chg %', num: true, value: (r) => r.oiChangePct, render: (r) => (r.oi ? <Chg value={r.oiChangePct} pct /> : '—') },
                  { key: 'vol', label: 'Volume', num: true, value: (r) => r.volume, render: (r) => (r.volume ? formatCompact(r.volume) : '—'), hideSm: true },
                  { key: 'iv', label: 'IV', num: true, value: (r) => r.iv ?? 0, render: (r) => (r.iv !== undefined ? r.iv.toFixed(2) : '—'), hideSm: true },
                  { key: 'metric', label, num: true, value: (r) => r.metric, render: (r) => <b>{Math.abs(r.metric) >= 1e4 ? formatCompact(r.metric) : r.metric.toFixed(2)}</b> },
                  { key: 'bu', label: 'Build-up', value: (r) => r.buildUp ?? '', render: (r) => (r.buildUp ? <BuildUpBadge value={r.buildUp} short /> : null) },
                ]}
              />
            )}
          </Loadable>
        </Card>
      </div>
    </div>
  );
}
