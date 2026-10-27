import { useId, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  analyzeStrategy,
  buildFromTemplate,
  defaultUnit,
  legLabel,
  payoffCurve,
  STRATEGY_TEMPLATES,
  type InstrumentType,
  type Leg,
  type MarketView,
  type OptionChain,
  type StrategyAnalysis,
  type StrategyTemplate,
  type PayoffCurve,
  type ValuationContext,
} from '@q26/core';
import { ExpirySelect, SymbolSelect } from '../components/pickers';
import { AsOf, Card, Dash, ErrorState, Field, NoData, PageHeader, Pill, Segmented, Spinner, Val } from '../components/ui';
import { formatINR, isNum } from '../lib/format';
import { useChain, useExpiries, useMeta } from '../lib/hooks';
import { useApp, useBuilder } from '../lib/store';

const VIEWS: { value: MarketView | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'bullish', label: '📈 Bullish' },
  { value: 'bearish', label: '📉 Bearish' },
  { value: 'neutral', label: '↔ Neutral' },
  { value: 'volatile', label: '⚡ Volatile' },
];

/**
 * Payoff at expiry of one card as an inline SVG: profit green above the zero line, loss red below. The wizard
 * shows up to 49 of these at once, so they are plain SVG paths, not 49 chart engines.
 */
export function MiniPayoff({ prices, values }: { prices: number[]; values: number[] }) {
  const id = `mp${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const g = useMemo(() => {
    const pts = prices.map((p, i) => [p, values[i]] as const).filter(([p, v]) => Number.isFinite(p) && Number.isFinite(v));
    if (pts.length < 2) return null;
    const W = 100;
    const H = 90;
    const pad = 4;
    const x0 = pts[0][0];
    const x1 = pts[pts.length - 1][0];
    const lo = Math.min(0, ...pts.map(([, v]) => v));
    const hi = Math.max(0, ...pts.map(([, v]) => v));
    const span = hi - lo || 1;
    const X = (p: number) => ((p - x0) / (x1 - x0 || 1)) * W;
    const Y = (v: number) => pad + ((hi - v) / span) * (H - 2 * pad);
    const line = pts.map(([p, v], i) => `${i ? 'L' : 'M'}${X(p).toFixed(2)},${Y(v).toFixed(2)}`).join('');
    const zero = Y(0);
    return { W, H, line, zero, area: `${line}L${W},${zero.toFixed(2)}L0,${zero.toFixed(2)}Z` };
  }, [prices, values]);
  if (!g) return <div style={{ height: 90 }} />;
  const up = `${id}-up`;
  const down = `${id}-down`;
  return (
    <svg viewBox={`0 0 ${g.W} ${g.H}`} preserveAspectRatio="none" className="block h-[90px] w-full" role="img" aria-label="Payoff at expiry">
      <defs>
        <clipPath id={up}><rect x="0" y="0" width={g.W} height={g.zero} /></clipPath>
        <clipPath id={down}><rect x="0" y={g.zero} width={g.W} height={g.H - g.zero} /></clipPath>
      </defs>
      <line x1="0" x2={g.W} y1={g.zero} y2={g.zero} stroke="currentColor" className="text-muted" strokeOpacity="0.5" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      {[[up, 'text-up'], [down, 'text-down']].map(([clip, tone]) => (
        <g key={clip} clipPath={`url(#${clip})`} className={tone}>
          <path d={g.area} fill="currentColor" fillOpacity="0.18" />
          <path d={g.line} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </g>
      ))}
    </svg>
  );
}

/**
 * The live premium a template leg is entered at: the contract's last traded price (a future's own expiry).
 * A contract without one gets NaN, which marks the leg as unpriced (the card then says so) — never a made-up price.
 */
function quoteFrom(chains: Record<string, OptionChain>) {
  return (type: InstrumentType, strike: number, expiry: string): { price: number; iv?: number } => {
    if (type === 'FUT') {
      const ch = Object.values(chains).find((c) => c.futureExpiry === expiry && isNum(c.future));
      return { price: ch?.future ?? NaN };
    }
    const row = chains[expiry]?.rows.find((r) => r.strike === strike);
    const q = row ? (type === 'CE' ? row.ce : row.pe) : undefined;
    return { price: q && isNum(q.ltp) ? q.ltp : NaN, iv: q && isNum(q.iv) ? q.iv / 100 : undefined };
  };
}

interface Card_ {
  t: StrategyTemplate;
  legs: Leg[];
  a: StrategyAnalysis | null;
  curve: PayoffCurve | null;
  /** Why there is no payoff for this strategy. */
  why: string | null;
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
  const c0 = useChain(symbol, e0, { refetch: 10000, enabled: !!e0 });
  const c1 = useChain(symbol, e1, { refetch: 10000, enabled: !!e1 });
  const r = meta.data?.riskFreeRate;
  const ch0 = c0.data && c0.data.symbol === symbol && c0.data.expiry === e0 ? c0.data : undefined;

  const cards = useMemo<Card_[]>(() => {
    if (!ch0 || r === undefined || !isNum(ch0.spot)) return [];
    const spot = ch0.spot;
    const chains: Record<string, OptionChain> = { [ch0.expiry]: ch0 };
    if (c1.data && c1.data.symbol === symbol && c1.data.expiry === e1) chains[c1.data.expiry] = c1.data;
    const expiries = [ch0.expiry, ...(e1 && chains[e1] ? [e1] : [])];
    const unit = defaultUnit(spot, ch0.strikeStep) * width;
    const ctx: ValuationContext = { r, carry: (e) => chains[e]?.carry ?? null };
    const sigma = isNum(ch0.atmIv) ? ch0.atmIv / 100 : undefined;
    return STRATEGY_TEMPLATES.filter((t) => view === 'all' || t.view === view).map((t): Card_ => {
      const needsNext = t.legs.some((l) => l.expiry === 1);
      if (needsNext && expiries.length < 2) return { t, legs: [], a: null, curve: null, why: 'Needs two listed expiries.' };
      const legs = buildFromTemplate(t, {
        spot,
        strikes: (e) => (chains[e] ?? ch0).rows.map((x) => x.strike),
        expiries,
        lotSize: ch0.lotSize,
        lots,
        unit,
        quote: quoteFrom(chains),
        futureExpiry: ch0.futureExpiry ?? undefined,
      });
      const unpriced = legs.filter((l) => !Number.isFinite(l.price));
      if (unpriced.length) return { t, legs, a: null, curve: null, why: `No live premium for ${unpriced.map(legLabel).join(', ')}: a leg is entered at its last traded price, none is made up.` };
      const a = analyzeStrategy(legs, spot, ch0.valuationTs, ctx, { sigma });
      if (a.missingAtExpiry.length) return { t, legs, a: null, curve: null, why: `Needs a live IV: ${a.missingAtExpiry.map((g) => `${g.label} (${g.reason})`).join('; ')}` };
      const curve = payoffCurve(legs, ctx, { lo: spot * 0.94, hi: spot * 1.06, points: 81, targetTs: ch0.valuationTs });
      return { t, legs, a, curve, why: null };
    });
  }, [ch0, c1.data, view, lots, width, r, symbol, e1]);

  const use = (legs: Leg[]) => {
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
      {c0.error && !ch0 ? (
        <ErrorState error={c0.error} />
      ) : ch0 && !isNum(ch0.spot) ? (
        <NoData title="No strategies to show" reason={ch0.gaps?.spot ?? `No live ${symbol} price: the strikes are chosen around the spot`} />
      ) : r === undefined && ch0 ? (
        <NoData compact title="Waiting" reason="The risk-free rate has not arrived from the server yet" />
      ) : !cards.length ? (
        exp.error ? <ErrorState error={exp.error} /> : !e0 && exp.data ? <NoData title="No strategies to show" reason={`No listed option expiry for ${symbol}`} /> : <Spinner />
      ) : null}
      {ch0 && cards.length > 0 && (
        <div className="text-2xs text-muted">
          Legs are entered at their live last traded price and valued with IVs solved from live premiums, <AsOf ts={ch0.valuationTs} label="valued at" />. A strategy whose legs have no live premium or IV is not drawn.
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {cards.map(({ t, legs, a, curve, why }) => (
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
                  <div><div className="text-muted">POP</div><div className="font-semibold text-accent"><Val value={a.pop === null ? null : a.pop * 100} format={(x) => `${x.toFixed(0)}%`} reason="No volatility: the ATM IV could not be solved from live premiums" /></div></div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1 text-2xs">
                  {legs.map((l, i) => (
                    <span key={i} className={l.side === 'BUY' ? 'chip bg-up/15 text-up' : 'chip bg-down/15 text-down'} title={`Entry ${l.price.toFixed(2)}`}>
                      {l.side === 'BUY' ? 'B' : 'S'} {l.lots}× {l.type === 'FUT' ? 'FUT' : `${l.strike} ${l.type}`}
                    </span>
                  ))}
                </div>
                <button className="btn-primary mt-3 w-full" onClick={() => use(legs)}>Open in builder</button>
              </>
            ) : (
              <div className="py-6 text-center text-xs text-muted"><Dash /> {why ?? 'Not available'}</div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
