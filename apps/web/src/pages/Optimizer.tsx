import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { formatExpiry, formatINR, formatIndian, type OptimizerCandidate } from '@q26/core';
import { PayoffChart, StrategySummary, useStrategyView } from '../components/Payoff';
import { ExpirySelect, SymbolSelect } from '../components/pickers';
import { AsOf, Card, Coverage, cx, ErrorState, Field, NoData, PageHeader, Segmented, Spinner, Toggle } from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime, isNum } from '../lib/format';
import { useChain } from '../lib/hooks';
import { useApp, useBuilder } from '../lib/store';

interface OptimizerResponse {
  scanned: number;
  results: OptimizerCandidate[];
  expiry: string;
  spot: number;
  forward: number;
  tookMs: number;
  /** The target date the strategies were valued at (epoch ms). */
  targetTs: number;
  /** How many strikes had a live premium (the rest were skipped). */
  coverage: string;
}

function Detail({ symbol, cand }: { symbol: string; cand: OptimizerCandidate }) {
  const view = useStrategyView(symbol, cand.legs);
  if (!view.analysis) return view.loading || !view.blank ? <Spinner /> : <NoData compact title="No payoff available" reason={view.blank} />;
  return (
    <div className="space-y-3">
      <PayoffChart view={view} height={300} />
      <StrategySummary view={view} />
    </div>
  );
}

export default function Optimizer() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const builder = useBuilder();
  const navigate = useNavigate();
  const [expiry, setExpiry] = useState<string>();
  const chain = useChain(symbol, expiry, { refetch: 15000 });
  const spot = chain.data?.symbol === symbol && isNum(chain.data.spot) ? chain.data.spot : undefined;
  const [direction, setDirection] = useState<'up' | 'down'>('up');
  const [targetPct, setTargetPct] = useState(2);
  const [target, setTarget] = useState('');
  const [stop, setStop] = useState('');
  const [targetDate, setTargetDate] = useState('');
  const [maxLegs, setMaxLegs] = useState<1 | 2 | 3 | 4>(4);
  const [unlimited, setUnlimited] = useState(false);
  const [capital, setCapital] = useState('');
  const [sortBy, setSortBy] = useState<'rr' | 'profit' | 'pop'>('rr');
  const [selected, setSelected] = useState(0);

  // Pre-fill target/stop from the live spot and the chosen move when the underlying changes (never without a live spot).
  useEffect(() => {
    if (!spot) return;
    const t = direction === 'up' ? spot * (1 + targetPct / 100) : spot * (1 - targetPct / 100);
    const s = direction === 'up' ? spot * (1 - targetPct / 200) : spot * (1 + targetPct / 200);
    setTarget(String(Math.round(t)));
    setStop(String(Math.round(s)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, direction, targetPct, spot !== undefined]);

  const run = useMutation({
    mutationFn: () =>
      api<OptimizerResponse>('/optimizer', {
        body: {
          symbol,
          expiry: chain.data?.expiry,
          targetPrice: Number(target),
          targetDate: targetDate || chain.data?.expiry,
          stopLoss: stop ? Number(stop) : undefined,
          maxLegs,
          allowUnlimitedRisk: unlimited,
          maxCapital: capital ? Number(capital) : undefined,
          sortBy,
        },
      }),
    onSuccess: () => setSelected(0),
  });
  const res = run.data;
  const chosen = res?.results[selected];

  return (
    <div className="space-y-3">
      <PageHeader title="Strategy Optimizer" subtitle="Tell us your view — target, date and stop-loss. We scan hundreds of thousands of 1–4 leg combinations and rank the best reward-to-risk trades.">
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setExpiry(undefined); run.reset(); }} />
        <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} />
      </PageHeader>
      <Card title="Your view">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
          <Field label="Direction">
            <Segmented value={direction} onChange={setDirection} options={[{ value: 'up', label: '↑ Up' }, { value: 'down', label: '↓ Down' }]} />
          </Field>
          <Field label="Move %">
            <select className="input" value={targetPct} onChange={(e) => setTargetPct(Number(e.target.value))}>
              {[0.5, 1, 1.5, 2, 3, 4, 5, 7.5, 10].map((p) => <option key={p} value={p}>{p}%</option>)}
            </select>
          </Field>
          <Field label={`Target price${spot ? ` (spot ${formatIndian(spot, 0)})` : ''}`}>
            <input className="input" type="number" value={target} onChange={(e) => setTarget(e.target.value)} />
          </Field>
          <Field label="Stop-loss (view wrong at)">
            <input className="input" type="number" value={stop} onChange={(e) => setStop(e.target.value)} />
          </Field>
          <Field label="Target date">
            <input className="input" type="date" value={targetDate || chain.data?.expiry || ''} max={chain.data?.expiry} onChange={(e) => setTargetDate(e.target.value)} />
          </Field>
          <Field label="Max legs">
            <select className="input" value={maxLegs} onChange={(e) => setMaxLegs(Number(e.target.value) as 1 | 2 | 3 | 4)}>
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </Field>
          <Field label="Max capital (₹)">
            <input className="input" type="number" placeholder="No limit" value={capital} onChange={(e) => setCapital(e.target.value)} />
          </Field>
          <Field label="Rank by">
            <select className="input" value={sortBy} onChange={(e) => setSortBy(e.target.value as 'rr' | 'profit' | 'pop')}>
              <option value="rr">Reward : Risk</option>
              <option value="profit">Profit at target</option>
              <option value="pop">Probability of profit</option>
            </select>
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Toggle checked={unlimited} onChange={setUnlimited} label="Allow unlimited-risk strategies" />
          <button className="btn-primary" disabled={!chain.data || !target || run.isPending} title={!chain.data ? 'The live option chain has not loaded' : !target ? 'Enter a target price' : undefined} onClick={() => run.mutate()}>
            {run.isPending ? 'Scanning combinations…' : '⚙ Find best strategies'}
          </button>
          {res && <span className="text-xs text-muted">Scanned <b className="text-ink">{res.scanned.toLocaleString('en-IN')}</b> combinations in {res.tookMs} ms · expiry {formatExpiry(res.expiry)}</span>}
        </div>
      </Card>
      {run.error ? <ErrorState error={run.error} title="No strategies can be ranked" hint="The optimizer prices every candidate from the live chain: it needs a live spot, forward, ATM IV and strikes with a live premium." /> : null}
      {res && (
        <div className="space-y-0.5 text-2xs text-muted">
          <Coverage text={res.coverage} label="Coverage" />
          <div>Premiums are the mid of the live bid / ask (else the last traded price); IV is solved from them. Forward {formatIndian(res.forward, 1)} · target date {formatDateTime(res.targetTs)}. <AsOf ts={chain.data?.valuationTs} label="Chain valued at" /></div>
        </div>
      )}
      {res && !res.results.length && <Card><div className="py-6 text-center text-sm text-muted">No strategy makes money at your target with the given constraints. Try a bigger move, later date, more legs or allow unlimited risk.</div></Card>}
      {res && res.results.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-5">
          <Card title={`Top ${res.results.length} strategies`} pad={false} className="lg:col-span-2">
            <ul className="max-h-[70vh] divide-y divide-line overflow-y-auto">
              {res.results.map((r, i) => (
                <li key={i}>
                  <button className={cx('w-full px-3 py-2 text-left hover:bg-panel2', i === selected && 'bg-accent/10')} onClick={() => setSelected(i)}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{i + 1}. {r.name}</span>
                      <span className="chip bg-accent/15 text-accent">R:R {r.rewardRisk.toFixed(1)}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1 text-2xs">
                      {r.legs.map((l, j) => (
                        <span key={j} className={l.side === 'BUY' ? 'chip bg-up/15 text-up' : 'chip bg-down/15 text-down'}>{l.side === 'BUY' ? 'B' : 'S'} {l.lots}× {l.strike} {l.type}</span>
                      ))}
                    </div>
                    <div className="mt-1 grid grid-cols-4 gap-1 text-2xs text-muted">
                      <span>At target <b className="text-up">{formatINR(r.targetPnl)}</b></span>
                      <span>At SL <b className={r.stopPnl >= 0 ? 'text-up' : 'text-down'}>{formatINR(r.stopPnl)}</b></span>
                      <span>POP <b className="text-ink">{(r.pop * 100).toFixed(0)}%</b></span>
                      <span title="Margin estimate (SPAN-style) on live prices">Margin est. <b className="text-ink">{formatINR(r.margin)}</b></span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          <Card
            className="lg:col-span-3"
            title={chosen ? chosen.name : ''}
            actions={chosen && <button className="btn-primary px-2 py-1 text-xs" onClick={() => { builder.setLegs(symbol, chosen.legs); navigate('/builder'); }}>Open in builder →</button>}
          >
            {chosen && <Detail symbol={symbol} cand={chosen} />}
          </Card>
        </div>
      )}
    </div>
  );
}
