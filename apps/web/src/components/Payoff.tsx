import { useMemo, type ReactNode } from 'react';
import { keepPreviousData, useQueries } from '@tanstack/react-query';
import {
  analyzeStrategy,
  capitalRequired,
  DAY_MS,
  estimateMargin,
  expiryTs,
  formatExpiry,
  INDEX_MARGIN,
  legLabel,
  legQty,
  payoffCurve,
  scenarioGrid,
  sideSign,
  STOCK_MARGIN,
  strategyGreeks,
  type FuturesQuote,
  type Leg,
  type MarginEstimate,
  type OptionChain,
  type OptionQuote,
  type PayoffCurve,
  type StrategyAnalysis,
  type ValuationContext,
} from '@q26/core';
import { api, errorText, isNoLiveData, qs } from '../lib/api';
import { formatINR, formatIndian, formatFixed, isNum } from '../lib/format';
import { useExpiries, useLive, useMeta, useSymbolInfo } from '../lib/hooks';
import { Chart, axis, baseOption, useChartColors, pnlVisualMap } from './Chart';
import { AsOf, Gaps, NoData, Spinner, Stat } from './ui';

/**
 * A strategy leg marked to the live market. Nothing here is assumed: a premium, IV or Greek the market
 * does not give is null, with the reason in `ltpReason` / `ivReason` / `excluded`.
 */
export interface MarkedLeg extends Leg {
  /** Live-session premium (option LTP, or the live futures price); null when the contract has no live price. */
  ltp: number | null;
  /** Time of that price (epoch ms). */
  ltpTs: number | null;
  /** Why `ltp` is blank. */
  ltpReason: string | null;
  /** IV (decimal) solved from the live premium; null when none could be solved. */
  marketIv: number | null;
  /** Why `marketIv` is blank. */
  ivReason: string | null;
  /** Premium `marketIv` was solved from (the chain leg's ivSource): 'mid' of a fresh two-sided book, or 'ltp'; null without an IV. */
  ivSource: OptionQuote['ivSource'];
  /** Position Greeks (qty × per-unit); null for a closed / switched-off leg and for a leg with no IV or carry to value it with. */
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  /** MTM against the live price (or the exit price of a closed leg); null without one. */
  pnl: number | null;
  /** Why `pnl` is blank. */
  pnlReason: string | null;
  /** Why the leg is left out of today's (T+0) curve, Greeks and margin (no IV / carry before its expiry), else null. */
  excluded: string | null;
}

export interface StrategyView {
  /** A chain has loaded. */
  ready: boolean;
  /** A request is still in flight and nothing has loaded yet. */
  loading: boolean;
  /** Why there is no analysis (no chain, no live spot …); null while loading or when there is nothing to analyse. */
  blank: string | null;
  spot: number | null;
  /** Valuation time of the nearest chain (its `valuationTs`: now in the session, else the last close) — IV, Greeks and time to expiry are measured from it. */
  nowTs: number | null;
  /** ATM IV (decimal) of the nearest chain; null when not solvable. */
  atmIv: number | null;
  lotSize: number | null;
  chains: Record<string, OptionChain>;
  nearestChain?: OptionChain;
  futures: FuturesQuote[];
  legs: MarkedLeg[];
  /** Valuation inputs (the server's risk-free rate, per-expiry carry); null until there is a chain and the rate is known. */
  ctx: ValuationContext | null;
  analysis?: StrategyAnalysis;
  margin?: MarginEstimate;
  /** Σ MTM of the switched-on legs; null while any of them has no live price. */
  mtm: number | null;
  mtmReason: string | null;
  curve?: PayoffCurve;
  /** Every open leg is left out of the T+0 series (it is not drawn). */
  targetBlank: boolean;
  targetTs: number | null;
  expiryTs: number | null;
  scenario?: { spot: number; movePct: number; pnl: number[] }[];
  scenarioTs: number[];
  /** Gaps of the nearest chain that matter here (spot, carry, forward, ATM IV). */
  gaps: Record<string, string>;
}

const VALUATION_GAPS = ['spot', 'forward', 'carry', 'atmIv'];

export function useStrategyView(
  symbol: string,
  legsIn: Leg[],
  opts: { targetDays?: number; ivShift?: number; range?: number; at?: number; extraExpiry?: string; futures?: boolean } = {},
): StrategyView {
  const meta = useMeta();
  const info = useSymbolInfo(symbol);
  const exp = useExpiries(symbol, { at: opts.at });
  const listed = exp.data?.options ?? [];
  // A future's expiry also needs its own chain (forward / carry), when that expiry is a listed option expiry.
  const optionExpiries = [
    ...new Set([
      ...(opts.extraExpiry ? [opts.extraExpiry] : []),
      ...legsIn.filter((l) => l.type !== 'FUT').map((l) => l.expiry),
      ...legsIn.filter((l) => l.type === 'FUT' && listed.includes(l.expiry)).map((l) => l.expiry),
    ]),
  ].sort();
  const wanted = optionExpiries.length ? optionExpiries : [''];
  const results = useQueries({
    queries: wanted.map((e) => ({
      queryKey: ['chain', symbol, e, opts.at ?? 'live'],
      queryFn: () => api<OptionChain>(`/chain/${encodeURIComponent(symbol)}${qs({ expiry: e || undefined, at: opts.at })}`),
      refetchInterval: opts.at ? (false as const) : 3000,
      placeholderData: keepPreviousData,
    })),
  });
  const needFutures = !!opts.futures || legsIn.some((l) => l.type === 'FUT');
  const futs = useLive<FuturesQuote[]>(opts.at ? ['futures', symbol, opts.at] : ['futures', symbol], `/futures/${encodeURIComponent(symbol)}${qs({ at: opts.at })}`, opts.at ? false : 3000, needFutures);

  const chains: Record<string, OptionChain> = {};
  const errors: Record<string, string> = {};
  wanted.forEach((e, i) => {
    const r = results[i];
    // The server says nothing is live for this chain now: do not keep valuing on the last answer.
    if (r.error && (isNoLiveData(r.error) || !r.data)) errors[e] = errorText(r.error);
    if (isNoLiveData(r.error)) return;
    if (r.data && r.data.symbol === symbol) chains[r.data.expiry] = r.data;
  });
  const base = Object.values(chains).sort((a, b) => a.expiry.localeCompare(b.expiry))[0];
  const rate = meta.data?.riskFreeRate;
  const futuresOk = !isNoLiveData(futs.error) ? futs.data ?? [] : [];
  const futuresReason = futs.error ? errorText(futs.error) : null;
  const loading = !base && results.some((x) => x.isLoading);
  const dataKey = [...results.map((x) => x.dataUpdatedAt), futs.dataUpdatedAt, results.map((x) => (x.error ? 1 : 0)).join(''), futs.error ? 1 : 0, wanted.join('|')].join(',');

  return useMemo<StrategyView>(() => {
    const empty = (blank: string | null): StrategyView => ({
      ready: false, loading, blank, spot: null, nowTs: null, atmIv: null, lotSize: info?.lotSize ?? null, chains, nearestChain: base, futures: futuresOk,
      legs: [], ctx: null, mtm: null, mtmReason: null, targetBlank: false, targetTs: null, expiryTs: null, scenarioTs: [], gaps: {},
    });
    if (!base) {
      const why = Object.values(errors)[0];
      return empty(why ?? (loading || !legsIn.length ? null : `The ${symbol} option chain is not available`));
    }
    if (rate === undefined) return { ...empty('Waiting for the risk-free rate from the server'), ready: true, nearestChain: base };
    const spot = Object.values(chains).map((c) => c.spot).find(isNum) ?? null;
    const nowTs = base.valuationTs;
    const atmIv = isNum(base.atmIv) ? base.atmIv / 100 : null;
    const lotSize = info?.lotSize ?? base.lotSize;
    const gaps: Record<string, string> = {};
    for (const k of VALUATION_GAPS) if (base.gaps?.[k]) gaps[k] = base.gaps[k];
    const ctx: ValuationContext = { r: rate, carry: (e) => chains[e]?.carry ?? null, ivShift: (opts.ivShift ?? 0) / 100 };
    // The margin scan sizes its own volatility moves: the what-if IV shift is not part of it.
    const marginCtx: ValuationContext = { r: rate, carry: ctx.carry };

    const legs: MarkedLeg[] = legsIn.map((l0) => {
      // A contract's lot size is defined by the instrument; a stored lot size of 1 means "not known".
      const l: Leg = { ...l0, lotSize: l0.lotSize > 1 ? l0.lotSize : lotSize };
      const open = l.active !== false && l.lots !== 0;
      let ltp: number | null = null;
      let ltpTs: number | null = null;
      let ltpReason: string | null = null;
      let marketIv: number | null = null;
      let ivReason: string | null = null;
      let ivSource: OptionQuote['ivSource'] = null;
      if (l.type === 'FUT') {
        const f = futuresOk.find((x) => x.expiry === l.expiry);
        ltp = f?.ltp ?? null;
        ltpTs = f?.ts ?? null;
        if (ltp === null) ltpReason = f ? 'The future has not traded in the live session' : futuresReason ?? `No live quote for the ${formatExpiry(l.expiry)} future`;
      } else {
        const ch = chains[l.expiry];
        const row = ch?.rows.find((x) => x.strike === l.strike);
        const q = row ? (l.type === 'CE' ? row.ce : row.pe) : undefined;
        if (!ch) ltpReason = errors[l.expiry] ?? `The ${formatExpiry(l.expiry)} option chain is not available`;
        else if (!q) ltpReason = `${l.strike} is not a strike of the ${formatExpiry(l.expiry)} chain`;
        else {
          ltp = q.ltp;
          ltpTs = q.ts;
          if (ltp === null) ltpReason = 'Not traded in the live session';
          if (isNum(q.iv)) {
            marketIv = q.iv / 100;
            ivSource = q.ivSource;
          } else ivReason = ch.gaps?.iv ?? 'IV could not be solved: no usable live premium (neither a two-sided book nor a traded price)';
        }
      }
      const qty = legQty(l) * sideSign(l.side);
      const exit = l.exitPrice ?? ltp;
      return {
        ...l,
        iv: marketIv ?? undefined,
        ltp, ltpTs, ltpReason, marketIv, ivReason, ivSource,
        delta: null, gamma: null, theta: null, vega: null,
        pnl: open && exit !== null ? qty * (exit - l.price) : null,
        pnlReason: !open ? 'Leg is switched off' : exit === null ? ltpReason ?? 'No live price' : null,
        excluded: null,
      };
    });
    const activeLegs = legs.filter((l) => l.active !== false && l.lots !== 0);
    const openLegs = activeLegs.filter((l) => l.exitPrice == null);
    const mtmMissing = activeLegs.find((l) => l.pnl === null);
    const mtm = !activeLegs.length || mtmMissing ? null : activeLegs.reduce((a, l) => a + (l.pnl ?? 0), 0);
    const mtmReason = mtmMissing ? `${legLabel(mtmMissing)}: ${mtmMissing.pnlReason ?? 'no live price'}` : null;
    const common = { ready: true, loading: false, atmIv, lotSize, chains, nearestChain: base, futures: futuresOk, legs, ctx, gaps, nowTs, mtm, mtmReason, targetBlank: false, scenarioTs: [] as number[] };
    if (spot === null) {
      return { ...common, blank: base.gaps?.spot ?? `No live ${symbol} price`, spot: null, targetTs: null, expiryTs: null };
    }
    if (!activeLegs.length) return { ...common, blank: null, spot, targetTs: null, expiryTs: null };

    // Position Greeks per leg (a leg with no IV / carry has none; they are left out of the totals, never zeroed).
    for (const l of openLegs) {
      const g = strategyGreeks([l], spot, nowTs, ctx);
      if (!g.missing.length) Object.assign(l, { delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega });
    }
    const firstExp = openLegs.length ? Math.min(...openLegs.map((l) => expiryTs(l.expiry))) : nowTs;
    const maxDays = Math.max(0, (firstExp - nowTs) / DAY_MS);
    const targetTs = Math.min(firstExp, nowTs + Math.min(maxDays, opts.targetDays ?? 0) * DAY_MS);
    const analysis = analyzeStrategy(activeLegs, spot, nowTs, ctx, { sigma: atmIv ?? undefined });
    for (const g of analysis.missingNow) {
      const leg = activeLegs[g.index];
      if (leg && !leg.excluded) leg.excluded = g.reason;
    }
    const range = opts.range ?? (info?.kind === 'stock' ? 0.15 : 0.08);
    const strikes = activeLegs.filter((l) => l.type !== 'FUT').map((l) => l.strike);
    const lo = Math.min(spot * (1 - range), ...strikes.map((k) => k * 0.98));
    const hi = Math.max(spot * (1 + range), ...strikes.map((k) => k * 1.02));
    const curve = payoffCurve(activeLegs, ctx, { lo, hi, points: 241, targetTs, extraPrices: [spot, ...analysis.breakevens] });
    const margin = estimateMargin(openLegs, spot, nowTs, marginCtx, info?.kind === 'stock' ? STOCK_MARGIN : INDEX_MARGIN);
    const scenarioTs = [nowTs, nowTs + (firstExp - nowTs) / 2, firstExp];
    const scenario = scenarioGrid(activeLegs, spot, ctx, [-5, -3, -2, -1, -0.5, 0, 0.5, 1, 2, 3, 5], scenarioTs);
    const targetBlank = openLegs.length > 0 && curve.targetMissing.length >= openLegs.length;
    return { ...common, blank: null, spot, analysis, margin, curve, targetBlank, targetTs, expiryTs: firstExp, scenario, scenarioTs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, JSON.stringify(legsIn), opts.targetDays, opts.ivShift, opts.range, rate, info?.kind, info?.lotSize]);
}

/** Why the strategy view has nothing to draw: a spinner while it loads, the reason when it cannot. */
function NoPayoff({ view, height }: { view: StrategyView; height: number }) {
  if (view.loading) return <div style={{ minHeight: height / 2 }}><Spinner label="Loading the live chain…" /></div>;
  if (view.blank) return <NoData compact title="No payoff available" reason={view.blank} />;
  return <div className="flex items-center justify-center text-sm text-muted" style={{ height }}>Add legs to see the payoff</div>;
}

export function PayoffChart({ view, height = 340 }: { view: StrategyView; height?: number }) {
  const c = useChartColors();
  const option = useMemo(() => {
    if (!view.curve || !view.analysis || view.spot === null || view.nowTs === null || view.expiryTs === null || view.targetTs === null) return {};
    const spot = view.spot;
    const { prices, expiry, target, targetMissing } = view.curve;
    const sd = view.atmIv !== null ? spot * view.atmIv * Math.sqrt(Math.max(0, (view.expiryTs - view.nowTs) / (365 * DAY_MS))) : 0;
    // T+0 unless the target slider moved time forward from the valuation time.
    const showTarget = view.targetTs > view.nowTs;
    const base = showTarget ? 'On target date' : 'Today (T+0)';
    const targetName = view.targetBlank ? `${base} — not available` : targetMissing.length ? `${base} — excl. ${targetMissing.length} leg${targetMissing.length > 1 ? 's' : ''}` : base;
    return {
      ...baseOption(c),
      grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
      tooltip: {
        ...(baseOption(c).tooltip as object),
        formatter: (ps: { seriesName: string; value: [number, number | null] }[]) =>
          `<b>${formatIndian(ps[0].value[0])}</b> (${(((ps[0].value[0] - spot) / spot) * 100).toFixed(2)}%)<br/>` + ps.map((p) => `${p.seriesName}: <b>${formatINR(p.value[1])}</b>`).join('<br/>'),
      },
      xAxis: { type: 'value', min: prices[0], max: prices[prices.length - 1], ...axis(c, { splitLine: { show: false } }), axisLabel: { color: c.muted, fontSize: 11, formatter: (v: number) => formatIndian(v, 0) } },
      yAxis: { type: 'value', ...axis(c), axisLabel: { color: c.muted, fontSize: 11, formatter: (v: number) => formatINR(v) } },
      visualMap: pnlVisualMap(c),
      series: [
        {
          name: 'At expiry',
          type: 'line',
          symbol: 'none',
          data: prices.map((p, i) => [p, expiry[i]]),
          lineStyle: { width: 2 },
          areaStyle: { opacity: 0.15 },
        },
        {
          name: targetName,
          type: 'line',
          symbol: 'none',
          // With every open leg left out the line would be flat zero: draw nothing instead.
          data: prices.map((p, i) => [p, view.targetBlank ? null : target[i]]),
          lineStyle: { width: 1.5, type: 'dashed', color: c.accent },
          itemStyle: { color: c.accent },
          markLine: {
            symbol: 'none',
            silent: true,
            label: { color: c.ink, fontSize: 10, formatter: '{b}' },
            data: [
              // Spot is labelled above the plot, breakevens inside it along their line from the bottom: the labels never collide.
              { name: `Spot ${formatIndian(spot, 0)}`, xAxis: spot, label: { position: 'end' }, lineStyle: { color: c.accent, type: 'solid', width: 1.5 } },
              ...view.analysis.breakevens.map((b) => ({ name: `BE ${formatIndian(b, 0)}`, xAxis: b, label: { position: 'insideStartTop', color: c.warn }, lineStyle: { color: c.warn, type: 'dashed' } })),
              { yAxis: 0, name: '', lineStyle: { color: c.muted, type: 'solid', opacity: 0.6 } },
            ],
          },
          markArea: sd > 0 ? { silent: true, itemStyle: { color: c.accent, opacity: 0.05 }, data: [[{ name: '±1σ', xAxis: spot - sd, label: { color: c.muted, fontSize: 10 } }, { xAxis: spot + sd }], [{ name: '±2σ', xAxis: spot - 2 * sd, label: { show: false } }, { xAxis: spot + 2 * sd }]] } : undefined,
        },
      ],
    };
  }, [view, c]);
  if (!view.curve) return <NoPayoff view={view} height={height} />;
  const missing = view.curve.targetMissing;
  const base = view.targetTs !== null && view.nowTs !== null && view.targetTs > view.nowTs ? 'On target date' : 'Today (T+0)';
  return (
    <>
      <Chart option={option} height={height} />
      {/* The legend is drawn on the canvas: say in text what the dashed line leaves out. */}
      {view.targetBlank ? (
        <div className="mt-1 text-2xs text-warn" role="note">{base} — not available: no open leg has a live IV / carry to value it with.</div>
      ) : missing.length > 0 ? (
        <div className="mt-1 text-2xs text-warn" role="note">
          {base} — excl. {plural(missing.length, 'leg')}: {missing.map((g) => `${g.label} (${g.reason})`).join('; ')}
        </div>
      ) : null}
    </>
  );
}

const money = (x: number | null) => (x === null ? 'Unlimited' : formatINR(x));

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What the figures are valued at and what they leave out: the valuation time (IV, Greeks and time to expiry
 * are measured from it — outside the session it is the last close), legs without an IV / carry that are
 * left out of the T+0 figures and of the margin, and the chain's own gaps (no carry, no ATM IV …).
 */
export function StrategyNotes({ view }: { view: StrategyView }) {
  const a = view.analysis;
  if (!a) return null;
  const list = (gaps: { label: string; reason: string }[]) => gaps.map((g) => `${g.label} (${g.reason})`).join('; ');
  return (
    <div className="space-y-0.5 text-2xs text-muted" role="note">
      <div>
        IV and Greeks are solved from live premiums; <AsOf ts={view.nowTs} label="valued at" />
        {view.targetTs !== null && view.nowTs !== null && view.targetTs > view.nowTs ? ' · the target-date curve moves time forward from there' : ''}
      </div>
      {a.missingNow.length > 0 && <div className="text-warn">Left out of today's (T+0) curve, Greeks and margin — {list(a.missingNow)}</div>}
      {a.missingAtExpiry.length > 0 && <div className="text-warn">Left out of the at-expiry figures — {list(a.missingAtExpiry)}</div>}
      <Gaps gaps={view.gaps} />
    </div>
  );
}

export function StrategySummary({ view }: { view: StrategyView }) {
  const a = view.analysis;
  if (!a || view.spot === null) return null;
  const spot = view.spot;
  const m = view.margin;
  const margin = m?.margin ?? null;
  const capital = margin ? capitalRequired(margin) : null;
  const openLegs = (view.legs ?? []).filter((l) => l.active !== false && l.lots !== 0 && l.exitPrice == null);
  const greeksBlank = openLegs.length > 0 && a.greeks.missing.length >= openLegs.length;
  const lessAtExpiry = a.missingAtExpiry.length ? `excl. ${plural(a.missingAtExpiry.length, 'leg')}` : undefined;
  const greekNote = a.greeks.missing.length ? ` · excl. ${plural(a.greeks.missing.length, 'leg')}` : '';
  const greekReason = a.greeks.missing[0] ? `${a.greeks.missing[0].label}: ${a.greeks.missing[0].reason}` : null;
  const noSigma = 'No volatility to spread the underlying with: the ATM IV and the legs\' IVs could not be solved from live premiums';
  const mtmTone = view.mtm === null ? undefined : view.mtm >= 0 ? 'up' : 'down';
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <Stat label="Max profit" value={money(a.maxProfit)} tone="up" sub={lessAtExpiry} />
        <Stat label="Max loss" value={money(a.maxLoss)} tone="down" sub={lessAtExpiry} />
        <Stat label="Breakeven(s)" value={a.breakevens.length ? a.breakevens.map((b) => formatIndian(b, 0)).join(' · ') : '—'} sub={a.breakevens.length ? a.breakevens.map((b) => `${(((b - spot) / spot) * 100).toFixed(1)}%`).join(' · ') : undefined} />
        <Stat label="Probability of profit" value={a.pop === null ? null : `${(a.pop * 100).toFixed(1)}%`} reason={noSigma} tone="accent" hint="Risk-neutral lognormal probability of P&L > 0 at expiry, spread with the ATM IV" />
        <Stat label="Risk : Reward" value={a.riskReward === null ? '—' : `1 : ${a.riskReward.toFixed(2)}`} />
        <Stat label={a.netPremium >= 0 ? 'Net credit' : 'Net debit'} value={formatINR(Math.abs(a.netPremium))} tone={a.netPremium >= 0 ? 'up' : 'down'} hint="At the entry prices of the legs" />
        <Stat label="Approx. margin" value={margin ? formatINR(margin.total) : null} reason={m?.reason ?? undefined} sub={margin ? `SPAN ${formatINR(margin.span)} + Exp ${formatINR(margin.exposure)}` : undefined} hint="Margin estimate (SPAN-style) on live spot, IV and forward; broker margins vary" />
        <Stat label="Capital required" value={capital === null ? null : formatINR(capital)} reason={m?.reason ?? undefined} sub={margin && margin.hedgeBenefit > 0 ? `Hedge benefit ${formatINR(margin.hedgeBenefit)}` : undefined} />
        <Stat label="Current MTM" value={view.mtm === null ? null : formatINR(view.mtm)} reason={view.mtmReason ?? undefined} tone={mtmTone} hint="Legs marked to their live price (a closed leg at its exit price)" />
        <Stat label="Expected P&L" value={a.expectedPnl === null ? null : formatINR(a.expectedPnl)} reason={noSigma} hint="Mean P&L at expiry under the lognormal model" />
        <Stat label="Delta · Gamma" value={greeksBlank ? null : `${formatFixed(a.greeks.delta, 1)} · ${formatFixed(a.greeks.gamma, 3)}`} reason={greekReason ?? undefined} sub={`Position (units of underlying)${greekNote}`} />
        <Stat label="Theta · Vega" value={greeksBlank ? null : `${formatINR(a.greeks.theta)} · ${formatINR(a.greeks.vega)}`} reason={greekReason ?? undefined} sub={`Per day · per 1% IV${greekNote}`} />
      </div>
      <StrategyNotes view={view} />
    </div>
  );
}

export function ScenarioTable({ view }: { view: StrategyView }) {
  if (!view.scenario || !view.analysis) return null;
  const labels = ['Today', 'Mid-way', 'Expiry'];
  const left = view.analysis.missingNow.length;
  const leftAtExpiry = view.analysis.missingAtExpiry.length;
  const cell = (p: number | null): ReactNode => (isNum(p) ? <span className={p >= 0 ? 'text-up' : 'text-down'}>{formatINR(p)}</span> : <span className="text-muted">—</span>);
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>Spot move</th>
            <th className="num">Price</th>
            {labels.map((l, i) => (
              <th key={l} className="num" title={(i < 2 ? left : leftAtExpiry) ? 'Legs without an IV are left out of this column' : undefined}>
                P&L {l}
                {(i < 2 ? left : leftAtExpiry) > 0 ? '*' : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.scenario.map((row) => (
            <tr key={row.movePct} className={row.movePct === 0 ? 'font-semibold' : ''}>
              <td>{row.movePct > 0 ? '+' : ''}{row.movePct}%</td>
              <td className="num">{formatIndian(row.spot)}</td>
              {row.pnl.map((p, i) => (
                <td key={i} className="num">{cell(p)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(left > 0 || leftAtExpiry > 0) && <p className="px-3 py-2 text-2xs text-warn">* Excludes {plural(Math.max(left, leftAtExpiry), 'leg')} that cannot be valued without a live IV or carry (listed above).</p>}
    </div>
  );
}
