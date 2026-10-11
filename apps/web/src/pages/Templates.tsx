import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  analyzeStrategy,
  buildFromTemplate,
  defaultUnit,
  formatINR,
  payoffCurve,
  STRATEGY_TEMPLATES,
  type InstrumentType,
  type MarketView,
  type OptionChain,
  type StrategyTemplate,
} from '@q26/core';
import { Chart, useChartColors, pnlVisualMap } from '../components/Chart';
import { ExpirySelect, SymbolSelect } from '../components/pickers';
import { Card, ErrorBox, Field, PageHeader, Pill, Segmented, Spinner } from '../components/ui';
import { useChain, useExpiries, useMeta } from '../lib/hooks';
import { useApp, useBuilder } from '../lib/store';

const VIEWS: { value: MarketView | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'bullish', label: '📈 Bullish' },
  { value: 'bearish', label: '📉 Bearish' },
  { value: 'neutral', label: '↔ Neutral' },
  { value: 'volatile', label: '⚡ Volatile' },
];

function MiniPayoff({ prices, values }: { prices: number[]; values: number[] }) {
  const c = useChartColors();
  const option = useMemo(
    () => ({
      animation: false,
      grid: { left: 0, right: 0, top: 4, bottom: 4 },
      xAxis: { type: 'value', show: false, min: prices[0], max: prices[prices.length - 1] },
      yAxis: { type: 'value', show: false },
      visualMap: pnlVisualMap(c),
      series: [
        { type: 'line', symbol: 'none', data: prices.map((p, i) => [p, values[i]]), areaStyle: { opacity: 0.18 }, lineStyle: { width: 1.5 } },
        // Markers must not live on the visualMap-coloured series (ECharts throws on 'coord').
        { type: 'line', symbol: 'none', silent: true, lineStyle: { color: c.muted, opacity: 0.5, width: 1 }, data: [[prices[0], 0], [prices[prices.length - 1], 0]] },
      ],
    }),
    [prices, values, c],
  );
  return <Chart option={option} height={90} />;
}

function quoteFrom(chains: Record<string, OptionChain>) {
  return (type: InstrumentType, strike: number, expiry: string) => {
    const ch = chains[expiry];
    if (!ch) return { price: 0 };
    if (type === 'FUT') return { price: ch.future };
    const row = ch.rows.find((r) => r.strike === strike);
    const q = row ? (type === 'CE' ? row.ce : row.pe) : undefined;
    return { price: q?.ltp ?? 0, iv: q ? q.iv / 100 : undefined };
  };
}

export default function Templates() {
  const symbol = useApp((s) => s.symbol);
  const setSymbol = useApp((s) => s.setSymbol);
  const meta = useMeta();
  const exp = useExpiries(symbol);
  const [expiry, setExpiry] = useState<string>();
  const [view, setView] = useState<MarketView | 'all'>('all');
  const [lots, setLots] = useState(1);
  const [width, setWidth] = useState(1);
  const builder = useBuilder();
  const navigate = useNavigate();
  const options = exp.data?.options ?? [];
  const e0 = expiry && options.includes(expiry) ? expiry : options[0];
  const e1 = e0 ? options[options.indexOf(e0) + 1] : undefined;
  const c0 = useChain(symbol, e0, { refetch: 10000 });
  const c1 = useChain(symbol, e1, { refetch: 10000 });
  const r = meta.data?.riskFreeRate ?? 0.065;

  const cards = useMemo(() => {
    const ch0 = c0.data && c0.data.symbol === symbol ? c0.data : undefined;
    if (!ch0) return [];
    const chains: Record<string, OptionChain> = { [ch0.expiry]: ch0 };
    if (c1.data && c1.data.symbol === symbol) chains[c1.data.expiry] = c1.data;
    const expiries = [ch0.expiry, ...(chains[e1 ?? ''] ? [e1!] : [])];
    const unit = defaultUnit(ch0.spot, ch0.strikeStep) * width;
    const ctx = { r, carry: () => ch0.carry, defaultIv: ch0.atmIv / 100 };
    return STRATEGY_TEMPLATES.filter((t) => view === 'all' || t.view === view).map((t) => {
      const needsNext = t.legs.some((l) => l.expiry === 1);
      if (needsNext && expiries.length < 2) return { t, legs: [], a: null, curve: null };
      const legs = buildFromTemplate(t, {
        spot: ch0.spot,
        strikes: (e) => (chains[e] ?? ch0).rows.map((x) => x.strike),
        expiries,
        lotSize: ch0.lotSize,
        lots,
        unit,
        quote: quoteFrom(chains),
        futureExpiry: ch0.futureExpiry,
      });
      const a = analyzeStrategy(legs, ch0.spot, ch0.ts, ctx, { sigma: ch0.atmIv / 100 });
      const curve = payoffCurve(legs, ctx, { lo: ch0.spot * 0.94, hi: ch0.spot * 1.06, points: 81, targetTs: ch0.ts });
      return { t, legs, a, curve };
    });
  }, [c0.data, c1.data, view, lots, width, r, symbol, e1]);

  const use = (t: StrategyTemplate, legs: ReturnType<typeof buildFromTemplate>) => {
    builder.setLegs(symbol, legs);
    navigate('/builder');
  };

  return (
    <div className="space-y-3">
      <PageHeader title="Strategy Wizard" subtitle={`${STRATEGY_TEMPLATES.length} ready-made option strategies — pick your market view, see payoff and odds, then open in the builder`}>
        <SymbolSelect value={symbol} onChange={(s) => { setSymbol(s); setExpiry(undefined); }} />
        <ExpirySelect symbol={symbol} value={expiry} onChange={setExpiry} />
      </PageHeader>
      <div className="flex flex-wrap items-end gap-3">
        <Segmented value={view} onChange={setView} options={VIEWS} />
        <Field label="Lots">
          <input className="input w-20" type="number" min={1} value={lots} onChange={(e) => setLots(Math.max(1, Number(e.target.value) || 1))} />
        </Field>
        <Field label="Strike width">
          <Segmented size="xs" value={width} onChange={setWidth} options={[{ value: 0.5, label: 'Narrow' }, { value: 1, label: 'Normal' }, { value: 2, label: 'Wide' }]} />
        </Field>
      </div>
      {c0.error ? <ErrorBox error={c0.error} /> : !cards.length ? <Spinner /> : null}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map(({ t, legs, a, curve }) => (
          <Card
            key={t.id}
            title={t.name}
            actions={<Pill tone={t.view === 'bullish' ? 'up' : t.view === 'bearish' ? 'down' : t.view === 'volatile' ? 'warn' : 'accent'}>{t.view}</Pill>}
          >
            <p className="mb-2 min-h-[2.5rem] text-xs text-muted">{t.description}</p>
            {curve && a ? (
              <>
                <MiniPayoff prices={curve.prices} values={curve.expiry} />
                <div className="mt-2 grid grid-cols-3 gap-1 text-center text-2xs">
                  <div><div className="text-muted">Max profit</div><div className="font-semibold text-up">{a.maxProfit === null ? 'Unlimited' : formatINR(a.maxProfit)}</div></div>
                  <div><div className="text-muted">Max loss</div><div className="font-semibold text-down">{a.maxLoss === null ? 'Unlimited' : formatINR(a.maxLoss)}</div></div>
                  <div><div className="text-muted">POP</div><div className="font-semibold text-accent">{(a.pop * 100).toFixed(0)}%</div></div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1 text-2xs">
                  {legs.map((l, i) => (
                    <span key={i} className={l.side === 'BUY' ? 'chip bg-up/15 text-up' : 'chip bg-down/15 text-down'}>
                      {l.side === 'BUY' ? 'B' : 'S'} {l.lots}× {l.type === 'FUT' ? 'FUT' : `${l.strike} ${l.type}`}
                    </span>
                  ))}
                </div>
                <button className="btn-primary mt-3 w-full" onClick={() => use(t, legs)}>Open in builder</button>
              </>
            ) : (
              <div className="py-6 text-center text-xs text-muted">Needs two listed expiries.</div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
