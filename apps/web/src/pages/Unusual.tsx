import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { formatExpiry, type UnusualActivityRow } from '@q26/core';
import { DataTable } from '../components/DataTable';
import { SymbolSelect } from '../components/pickers';
import { BuildUpBadge, Card, Chg, Loadable, PageHeader, Toggle } from '../components/ui';
import { qs } from '../lib/api';
import { formatCompact } from '../lib/format';
import { useLive } from '../lib/hooks';
import { useApp } from '../lib/store';

export default function Unusual() {
  const [all, setAll] = useState(true);
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const navigate = useNavigate();
  const q = useLive<UnusualActivityRow[]>(['unusual', all ? '' : symbol], `/unusual${qs({ symbol: all ? undefined : symbol })}`, 10000);
  return (
    <div className="space-y-3">
      <PageHeader title="Unusual Option Activity" subtitle="Contracts where volume, OI change and IV change are abnormal relative to the rest of the market — follow the money">
        <Toggle checked={all} onChange={setAll} label="All F&O" />
        {!all && <SymbolSelect value={symbol} onChange={setSymbol} />}
      </PageHeader>
      <Card pad={false}>
        <Loadable q={q}>
          {(rows) => (
            <DataTable
              rows={rows}
              rowKey={(r) => `${r.symbol}${r.expiry}${r.strike}${r.type}`}
              initialSort={{ key: 'score', dir: 'desc' }}
              empty="Nothing unusual right now."
              onRowClick={(r) => { setSymbol(r.symbol); navigate(`/oi/multi-strike?strikes=${r.strike}`); }}
              columns={[
                { key: 'c', label: 'Contract', value: (r) => r.symbol, render: (r) => <span className="font-medium">{r.symbol} {formatExpiry(r.expiry)} {r.strike} <span className={r.type === 'CE' ? 'text-down' : 'text-up'}>{r.type}</span></span> },
                { key: 'signal', label: 'Signal', value: (r) => r.signal, render: (r) => <span className={r.signal.includes('bullish') ? 'text-up' : r.signal.includes('bearish') ? 'text-down' : ''}>{r.signal}</span> },
                { key: 'ltp', label: 'LTP', num: true, value: (r) => r.ltp, render: (r) => r.ltp.toFixed(2) },
                { key: 'chg', label: '% Chg', num: true, value: (r) => r.changePct, render: (r) => <Chg value={r.changePct} pct />, hideSm: true },
                { key: 'oic', label: 'OI Chg', num: true, value: (r) => r.oiChangePct, render: (r) => <span><Chg value={r.oiChangePct} pct /> <span className="text-2xs text-muted">({formatCompact(r.oiChange)})</span></span> },
                { key: 'vo', label: 'Vol / OI', num: true, value: (r) => r.volumeOiRatio, render: (r) => r.volumeOiRatio.toFixed(2) },
                { key: 'ivc', label: 'IV Chg', num: true, value: (r) => r.ivChange, render: (r) => <Chg value={r.ivChange} />, hideSm: true },
                { key: 'turn', label: 'Prem. turnover', num: true, value: (r) => r.premiumTurnover, render: (r) => `₹${formatCompact(r.premiumTurnover)}`, hideSm: true },
                { key: 'score', label: 'Score', num: true, value: (r) => r.score, render: (r) => <b>{r.score.toFixed(1)}</b> },
                { key: 'bu', label: '', render: (r) => <BuildUpBadge value={r.buildUp} short /> },
              ]}
            />
          )}
        </Loadable>
      </Card>
    </div>
  );
}
