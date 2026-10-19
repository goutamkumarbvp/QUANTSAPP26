import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type AlertDef, type AlertKind, type Notification, type OrbResponse, type OrderFlowResponse, type SavedStrategy } from '@q26/core';
import { pickStrike, StrikeSelect, SymbolSelect } from '../components/pickers';
import { AsOf, Card, Empty, ErrorBox, Field, Loadable, PageHeader, Pill, Segmented } from '../components/ui';
import { api, isNoLiveData, qs } from '../lib/api';
import { formatDateTime, formatExpiry as fmtExpiry, isNum } from '../lib/format';
import { useChain, useExpiries, useLive } from '../lib/hooks';
import { useApp } from '../lib/store';

const KINDS: { value: AlertKind; label: string; unit: string }[] = [
  { value: 'PRICE', label: 'Underlying price', unit: '₹' },
  { value: 'OPTION_PRICE', label: 'Option premium', unit: '₹' },
  { value: 'IV', label: 'ATM IV', unit: '%' },
  { value: 'PCR', label: 'PCR', unit: '' },
  { value: 'OI_CHANGE', label: 'Option OI change', unit: '%' },
  { value: 'MTM', label: 'Strategy MTM', unit: '₹' },
  { value: 'ORB_BREAK', label: 'Opening range breakout', unit: 'min' },
  { value: 'ORDER_FLOW', label: '1-min buy volume % (futures)', unit: '%' },
];

function describe(a: AlertDef, strategies: SavedStrategy[]): string {
  const k = KINDS.find((x) => x.value === a.kind)!;
  if (a.kind === 'ORB_BREAK') return `${a.symbol} breaks ${a.condition === 'above' ? 'above' : 'below'} its ${a.value}-min opening range`;
  const what =
    a.kind === 'MTM'
      ? `MTM of “${strategies.find((s) => s.id === a.strategyId)?.name ?? 'strategy'}”`
      : a.kind === 'OPTION_PRICE' || a.kind === 'OI_CHANGE'
        ? `${a.symbol} ${fmtExpiry(a.expiry)} ${a.strike} ${a.optionType} ${a.kind === 'OI_CHANGE' ? 'OI change' : 'premium'}`
        : `${a.symbol} ${k.label}`;
  return `${what} ${a.condition} ${k.unit === '₹' ? '₹' : ''}${a.value}${k.unit === '%' ? '%' : ''}`;
}

export default function Alerts() {
  const qc = useQueryClient();
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const [kind, setKind] = useState<AlertKind>('PRICE');
  const [condition, setCondition] = useState<'above' | 'below'>('above');
  const [value, setValue] = useState('');
  const [optionType, setOptionType] = useState<'CE' | 'PE'>('CE');
  const [expiry, setExpiry] = useState<string>();
  const [strike, setStrike] = useState<number>();
  const [strategyId, setStrategyId] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  const alerts = useQuery({ queryKey: ['alerts'], queryFn: () => api<AlertDef[]>('/alerts'), refetchInterval: 5000 });
  const notes = useQuery({ queryKey: ['notifications'], queryFn: () => api<Notification[]>('/notifications'), refetchInterval: 10000 });
  const strategies = useQuery({ queryKey: ['strategies'], queryFn: () => api<SavedStrategy[]>('/strategies') });
  const exp = useExpiries(symbol);
  const e = expiry && exp.data?.options.includes(expiry) ? expiry : exp.data?.options[0];
  const chain = useChain(symbol, e, { refetch: 10000, enabled: !!e });
  // The server says nothing is live: the last answer is not used for the "now" figure.
  const chainData = !isNoLiveData(chain.error) && chain.data?.symbol === symbol && chain.data.expiry === e ? chain.data : undefined;
  const k = pickStrike(chainData, strike);
  const needsOption = kind === 'OPTION_PRICE' || kind === 'OI_CHANGE';
  const isOrb = kind === 'ORB_BREAK';
  // The opening-range length shown, queried and submitted is always one of the offered values.
  const orbMinutes = ['5', '15', '30'].includes(value) ? Number(value) : 15;
  const orb = useLive<OrbResponse>(['orb', symbol, '', orbMinutes, 'close'], `/orb/${symbol}${qs({ minutes: orbMinutes })}`, 10000, isOrb);
  const flow = useLive<OrderFlowResponse>(['order-flow', symbol, 'FUT', undefined, undefined, '', 1], `/order-flow/${symbol}${qs({ type: 'FUT', limit: 1 })}`, 5000, kind === 'ORDER_FLOW');
  const orbData = isNoLiveData(orb.error) ? undefined : orb.data;
  const flowData = isNoLiveData(flow.error) ? undefined : flow.data;
  const optQuote = needsOption ? (() => { const r = chainData?.rows.find((x) => x.strike === k); return r ? (optionType === 'CE' ? r.ce : r.pe) : undefined; })() : undefined;
  // The value the alert would be checked against right now; null when its input is not live.
  const current: number | null | undefined =
    kind === 'PRICE' ? chainData?.spot : kind === 'IV' ? chainData?.atmIv : kind === 'PCR' ? chainData?.pcr
      : needsOption ? (kind === 'OI_CHANGE' ? optQuote?.oiChangePct : optQuote?.ltp)
        : kind === 'ORDER_FLOW' ? (flowData?.lastMinute?.volume ? flowData.lastMinute.buyPct : null)
          : kind === 'MTM' ? strategies.data?.find((s) => s.id === strategyId)?.live?.mtm
            : undefined;

  const create = async () => {
    setError(null);
    try {
      await api('/alerts', { body: { kind, symbol: kind === 'MTM' ? strategies.data?.find((s) => s.id === strategyId)?.symbol ?? symbol : symbol, condition, value: isOrb ? orbMinutes : Number(value), optionType: needsOption ? optionType : undefined, strike: needsOption ? k : undefined, expiry: needsOption ? e : undefined, strategyId: kind === 'MTM' ? strategyId : undefined, note: note || undefined } });
      setValue('');
      setNote('');
      qc.invalidateQueries({ queryKey: ['alerts'] });
    } catch (err) {
      setError(err);
    }
  };
  const act = async (fn: () => Promise<unknown>) => {
    await fn();
    qc.invalidateQueries({ queryKey: ['alerts'] });
  };

  return (
    <div className="space-y-3">
      <PageHeader title="Alerts" subtitle="Get notified (in-app, live) when price, premium, IV, PCR, OI or your strategy MTM crosses a level" />
      <Card title="New alert">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Alert on">
            <select
              className="input w-auto"
              value={kind}
              onChange={(ev) => {
                // A value typed for another kind (a price, a PCR…) means nothing for this one.
                setKind(ev.target.value as AlertKind);
                setValue('');
              }}
            >
              {KINDS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
            </select>
          </Field>
          {kind !== 'MTM' ? <SymbolSelect value={symbol} onChange={setSymbol} /> : (
            <Field label="Strategy">
              <select className="input w-auto" value={strategyId} onChange={(ev) => setStrategyId(ev.target.value)}>
                <option value="">Select…</option>
                {(strategies.data ?? []).filter((s) => s.status === 'open').map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
          )}
          {needsOption && (
            <>
              <Segmented value={optionType} onChange={setOptionType} options={[{ value: 'CE', label: 'CE' }, { value: 'PE', label: 'PE' }]} />
              <Field label="Expiry">
                <select className="input w-auto" value={e ?? ''} disabled={!exp.data?.options.length} title={exp.data?.options.length ? undefined : 'No listed option expiry'} onChange={(ev) => setExpiry(ev.target.value)}>
                  {(exp.data?.options ?? []).map((x) => <option key={x} value={x}>{fmtExpiry(x)}</option>)}
                  {!exp.data?.options.length && <option value="">{exp.isLoading ? 'Loading…' : 'No expiry'}</option>}
                </select>
              </Field>
              <Field label="Strike">
                <StrikeSelect chain={chainData} value={k} onChange={setStrike} error={chain.error} loading={chain.isLoading} />
              </Field>
            </>
          )}
          <Segmented value={condition} onChange={setCondition} options={isOrb ? [{ value: 'above', label: '↑ Breaks above high' }, { value: 'below', label: '↓ Breaks below low' }] : [{ value: 'above', label: '≥ Above' }, { value: 'below', label: '≤ Below' }]} />
          {isOrb ? (
            <Field label={orbData ? `Range minutes (now: H ${orbData.evaluation.high.toFixed(1)} / L ${orbData.evaluation.low.toFixed(1)}, ${orbData.evaluation.trend})` : `Range minutes${orb.error ? ' (opening range not available)' : ''}`}>
              <select className="input w-auto" value={String(orbMinutes)} onChange={(ev) => setValue(ev.target.value)}>
                {[5, 15, 30].map((m) => <option key={m} value={m}>{m} min</option>)}
              </select>
            </Field>
          ) : (
            <Field label={`Value${current === undefined ? '' : isNum(current) ? ` (now ${current.toFixed(2)})` : ' (now: not live)'}`}>
              <input className="input w-32" type="number" value={value} onChange={(ev) => setValue(ev.target.value)} />
            </Field>
          )}
          <Field label="Note (optional)">
            <input className="input w-48" value={note} maxLength={200} onChange={(ev) => setNote(ev.target.value)} />
          </Field>
          <button className="btn-primary" disabled={(!value && !isOrb) || (kind === 'MTM' && !strategyId) || (needsOption && k === undefined)} title={needsOption && k === undefined ? 'No strike: the option chain is not available' : undefined} onClick={create}>Create alert</button>
        </div>
        {error ? <div className="mt-2"><ErrorBox error={error} /></div> : null}
        <p className="mt-2 text-2xs text-muted">
          Alerts are checked against live data every few seconds. When an input is not live (no price, a premium that has not traded, no previous-session OI) the check is skipped and the reason is shown on the alert; an alert on an expired or unlisted contract is disabled.
          {(isOrb || kind === 'ORDER_FLOW') && ' Opening-range and order-flow alerts look only at minutes completed after the alert was armed; order-flow alerts also need at least half of the volume classified (estimated from live ticks).'}
        </p>
      </Card>
      <div className="grid gap-3 lg:grid-cols-2">
        <Card title="Your alerts" pad={false}>
          <Loadable q={alerts}>
            {(list) => !list.length ? <Empty>No alerts yet.</Empty> : (
              <ul className="divide-y divide-line">
                {list.map((a) => (
                  <li key={a.id} className="flex items-center justify-between gap-2 px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{describe(a, strategies.data ?? [])}</div>
                      <div className="text-2xs text-muted">
                        {a.status === 'triggered' ? `Triggered ${formatDateTime(a.triggeredAt)} at ${a.triggeredValue ?? '—'}` : `Created ${formatDateTime(a.createdAt)}`}
                        {a.note ? ` · ${a.note}` : ''}
                      </div>
                      {a.status === 'active' && (
                        <div className="text-2xs text-muted">
                          {a.statusNote ? (
                            <span className="text-warn" title="The last check was skipped because an input is not live">Skipped, not live: {a.statusNote}</span>
                          ) : isNum(a.lastValue) ? (
                            <>Last value {a.lastValue} <AsOf ts={a.checkedAt} label="checked" /></>
                          ) : (
                            'Not checked yet'
                          )}
                        </div>
                      )}
                      {a.status === 'disabled' && a.statusNote && <div className="text-2xs text-down">{a.statusNote}</div>}
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <Pill tone={a.status === 'active' ? (a.statusNote ? 'warn' : 'accent') : a.status === 'triggered' ? 'up' : 'muted'}>{a.status === 'active' && a.statusNote ? 'waiting for data' : a.status}</Pill>
                      {a.status !== 'active' ? (
                        <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => act(() => api(`/alerts/${a.id}`, { method: 'PATCH', body: { status: 'active' } }))}>Re-arm</button>
                      ) : (
                        <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => act(() => api(`/alerts/${a.id}`, { method: 'PATCH', body: { status: 'disabled' } }))}>Pause</button>
                      )}
                      <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => act(() => api(`/alerts/${a.id}`, { method: 'DELETE' }))} aria-label="Delete alert">✕</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Loadable>
        </Card>
        <Card title="Notification history" pad={false}>
          <Loadable q={notes}>
            {(list) => !list.length ? <Empty>Nothing yet.</Empty> : (
              <ul className="max-h-[60vh] divide-y divide-line overflow-y-auto">
                {list.map((n) => (
                  <li key={n.id} className="px-3 py-2">
                    <div className="text-sm font-medium">{n.title}</div>
                    <div className="text-xs text-muted">{n.body}</div>
                    <div className="text-2xs text-muted">{formatDateTime(n.ts)} · {n.kind}</div>
                  </li>
                ))}
              </ul>
            )}
          </Loadable>
        </Card>
      </div>
    </div>
  );
}
