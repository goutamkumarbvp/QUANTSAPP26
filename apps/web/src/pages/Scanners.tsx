import { useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ScannerDef, ScannerResponse } from '@q26/core';
import { DataTable } from '../components/DataTable';
import { BuildUpBadge, Card, Chg, Coverage, cx, ErrorState, Gaps, Loadable, PageHeader, Val } from '../components/ui';
import { api } from '../lib/api';
import { formatCompact, formatFixed, formatIndian } from '../lib/format';
import { useLive } from '../lib/hooks';
import { useApp } from '../lib/store';

export default function Scanners() {
  const defs = useQuery({ queryKey: ['scanner-defs'], queryFn: () => api<ScannerDef[]>('/scanners'), staleTime: Infinity });
  const [params, setParams] = useSearchParams();
  const id = params.get('id') ?? 'long-buildup';
  const q = useLive<ScannerResponse>(['scanner', id], `/scanners/${id}?limit=40`, 10000);
  const setSymbol = useApp((s) => s.setSymbol);
  const navigate = useNavigate();
  const groups = useMemo(() => {
    const m = new Map<string, ScannerDef[]>();
    for (const d of defs.data ?? []) m.set(d.category, [...(m.get(d.category) ?? []), d]);
    return [...m.entries()];
  }, [defs.data]);
  const def = defs.data?.find((d) => d.id === id);
  const label = q.data?.rows[0]?.metricLabel ?? 'Metric';
  return (
    <div className="space-y-3">
      <PageHeader title="F&O Scanners" subtitle="Pre-built scans across every F&O future and near-expiry option — refreshed live" />
      <div className="grid gap-3 lg:grid-cols-4">
        <Card title="Scans" pad={false}>
          {defs.error ? <div className="p-2"><ErrorState error={defs.error} compact title="The scan list is not available" /></div> : null}
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
          <Loadable q={q} hint="Futures scans need the live OI and the previous session's OI; stock options refresh about every 90 seconds.">
            {(d) => (
              <>
                <DataTable
                  rows={d.rows}
                  rowKey={(r) => r.instrument}
                  onRowClick={(r) => { setSymbol(r.symbol); navigate('/option-chain'); }}
                  empty="Nothing matches this scan right now"
                  columns={[
                    { key: 'instrument', label: 'Instrument', value: (r) => r.instrument, render: (r) => <span className="font-medium">{r.instrument}</span> },
                    { key: 'ltp', label: 'LTP', num: true, value: (r) => r.ltp, render: (r) => <Val value={r.ltp} format={(x) => formatIndian(x)} reason="No trade in the live session" /> },
                    { key: 'chg', label: '% Chg', num: true, value: (r) => r.changePct, render: (r) => <Chg value={r.changePct} pct reason="Needs the previous close" /> },
                    { key: 'oi', label: 'OI', num: true, value: (r) => r.oi, render: (r) => <Val value={r.oi} format={(x) => formatCompact(x)} reason={r.type === 'EQ' ? 'A stock has no open interest' : 'No live open interest'} />, hideSm: true },
                    { key: 'oic', label: 'OI Chg %', num: true, value: (r) => r.oiChangePct, render: (r) => <Chg value={r.oiChangePct} pct reason={r.type === 'EQ' ? 'A stock has no open interest' : "Needs live OI and the previous session's OI"} /> },
                    { key: 'vol', label: 'Volume', num: true, value: (r) => r.volume, render: (r) => <Val value={r.volume} format={(x) => formatCompact(x)} reason="No volume reported" />, hideSm: true },
                    { key: 'iv', label: <span title="Solved from the live premium">IV</span>, num: true, value: (r) => r.iv, render: (r) => <Val value={r.iv} format={(x) => formatFixed(x, 2)} reason={r.type === 'FUT' || r.type === 'EQ' ? 'Not an option' : 'IV could not be solved from a live premium'} />, hideSm: true },
                    { key: 'metric', label, num: true, value: (r) => r.metric, render: (r) => <b>{Math.abs(r.metric) >= 1e4 ? formatCompact(r.metric) : formatFixed(r.metric, 2)}</b> },
                    { key: 'bu', label: 'Build-up', value: (r) => r.buildUp ?? null, render: (r) => <BuildUpBadge value={r.buildUp ?? null} short reason={r.type === 'EQ' ? 'A stock has no open interest' : 'Needs a live price and OI change vs the previous session'} /> },
                  ]}
                />
                <div className="space-y-1 border-t border-line px-3 py-2">
                  <Coverage text={d.coverage} />
                  <Gaps gaps={d.gaps} />
                </div>
              </>
            )}
          </Loadable>
        </Card>
      </div>
    </div>
  );
}
