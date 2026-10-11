import { useMemo } from 'react';
import { keepPreviousData, useQueries } from '@tanstack/react-query';
import {
  analyzeStrategy,
  bsGreeks,
  DAY_MS,
  estimateMargin,
  expiryTs,
  formatINR,
  formatIndian,
  INDEX_MARGIN,
  legQty,
  legTheoPrice,
  payoffCurve,
  scenarioGrid,
  sideSign,
  STOCK_MARGIN,
  yearsBetween,
  type Leg,
  type OptionChain,
  type StrategyAnalysis,
  type MarginResult,
  type ValuationContext,
} from '@q26/core';
import { api, qs } from '../lib/api';
import { useMeta, useSymbolInfo } from '../lib/hooks';
import { Chart, axis, baseOption, useChartColors, pnlVisualMap } from './Chart';
import { Stat } from './ui';

export interface MarkedLeg extends Leg {
  ltp: number;
  marketIv: number;
  delta: number;
  theta: number;
  vega: number;
  gamma: number;
  pnl: number;
}

export interface StrategyView {
  ready: boolean;
  spot: number;
  nowTs: number;
  atmIv: number;
  lotSize: number;
  chains: Record<string, OptionChain>;
  nearestChain?: OptionChain;
  legs: MarkedLeg[];
  ctx: ValuationContext;
  analysis?: StrategyAnalysis;
  margin?: MarginResult;
  mtm: number;
  curve?: { prices: number[]; expiry: number[]; target: number[] };
  targetTs: number;
  expiryTs: number;
  scenario?: { spot: number; movePct: number; pnl: number[] }[];
  scenarioTs: number[];
}

export function useStrategyView(symbol: string, legsIn: Leg[], opts: { targetDays?: number; ivShift?: number; range?: number; at?: number; extraExpiry?: string } = {}): StrategyView {
  const meta = useMeta();
  const info = useSymbolInfo(symbol);
  const optionExpiries = [...new Set([...(opts.extraExpiry ? [opts.extraExpiry] : []), ...legsIn.filter((l) => l.type !== 'FUT').map((l) => l.expiry)])].sort();
  const wanted = optionExpiries.length ? optionExpiries : [''];
  const results = useQueries({
    queries: wanted.map((e) => ({
      queryKey: ['chain', symbol, e, opts.at ?? 'live'],
      queryFn: () => api<OptionChain>(`/chain/${encodeURIComponent(symbol)}${qs({ expiry: e || undefined, at: opts.at })}`),
      refetchInterval: opts.at ? (false as const) : 3000,
      placeholderData: keepPreviousData,
    })),
  });
  const chains: Record<string, OptionChain> = {};
  for (const r of results) if (r.data && r.data.symbol === symbol) chains[r.data.expiry] = r.data;
  const base = Object.values(chains).sort((a, b) => a.expiry.localeCompare(b.expiry))[0];
  const r = meta.data?.riskFreeRate ?? 0.065;
  const dataKey = results.map((x) => x.dataUpdatedAt).join(',');

  return useMemo<StrategyView>(() => {
    const empty: StrategyView = { ready: false, spot: 0, nowTs: 0, atmIv: 0, lotSize: info?.lotSize ?? 1, chains, nearestChain: base, legs: [], ctx: { r }, mtm: 0, targetTs: 0, expiryTs: 0, scenarioTs: [] };
    if (!base) return empty;
    const spot = base.spot;
    const nowTs = base.ts;
    const atmIv = base.atmIv / 100;
    const ctx: ValuationContext = { r, carry: () => base.carry, ivShift: (opts.ivShift ?? 0) / 100, defaultIv: atmIv };
    const legs: MarkedLeg[] = legsIn.map((l0) => {
      // Contract lot size is defined by the instrument, not by whatever the leg carried.
      const l = { ...l0, lotSize: info?.lotSize ?? base.lotSize };
      let ltp = l.price;
      let marketIv = l.iv ?? atmIv;
      if (l.type === 'FUT') {
        ltp = +legTheoPrice({ ...l }, spot, nowTs, ctx).toFixed(2);
      } else {
        const row = chains[l.expiry]?.rows.find((x) => x.strike === l.strike);
        if (row) {
          const q = l.type === 'CE' ? row.ce : row.pe;
          ltp = q.ltp;
          marketIv = q.iv / 100;
        }
      }
      const qty = legQty(l) * sideSign(l.side);
      const active = l.active !== false;
      let g = { delta: l.type === 'FUT' ? 1 : 0, gamma: 0, theta: 0, vega: 0 };
      if (l.type !== 'FUT') {
        const T = yearsBetween(nowTs, expiryTs(l.expiry));
        g = bsGreeks(l.type, spot, l.strike, T, r, Math.max(0.005, marketIv + (opts.ivShift ?? 0) / 100), base.carry);
      }
      const exit = l.exitPrice ?? ltp;
      return {
        ...l,
        iv: marketIv,
        ltp,
        marketIv,
        delta: active ? qty * g.delta : 0,
        gamma: active ? qty * g.gamma : 0,
        theta: active ? qty * g.theta : 0,
        vega: active ? qty * g.vega : 0,
        pnl: active ? qty * (exit - l.price) : 0,
      };
    });
    const activeLegs = legs.filter((l) => l.active !== false && l.lots > 0);
    if (!activeLegs.length) return { ...empty, ready: true, spot, nowTs, atmIv, legs, ctx };
    const openExp = activeLegs.filter((l) => l.exitPrice == null).map((l) => expiryTs(l.expiry));
    const firstExp = openExp.length ? Math.min(...openExp) : nowTs;
    const maxDays = Math.max(0, (firstExp - nowTs) / DAY_MS);
    const targetTs = Math.min(firstExp, nowTs + Math.min(maxDays, opts.targetDays ?? 0) * DAY_MS);
    const analysis = analyzeStrategy(activeLegs, spot, nowTs, ctx, { sigma: atmIv });
    const range = opts.range ?? (info?.kind === 'stock' ? 0.15 : 0.08);
    const strikes = activeLegs.filter((l) => l.type !== 'FUT').map((l) => l.strike);
    const lo = Math.min(spot * (1 - range), ...strikes.map((k) => k * 0.98));
    const hi = Math.max(spot * (1 + range), ...strikes.map((k) => k * 1.02));
    const curve = payoffCurve(activeLegs, ctx, { lo, hi, points: 241, targetTs, extraPrices: [spot, ...analysis.breakevens] });
    const marginLegs = activeLegs.filter((l) => l.exitPrice == null).map((l) => ({ ...l }));
    const margin = estimateMargin(marginLegs, spot, nowTs, ctx, info?.kind === 'stock' ? STOCK_MARGIN : INDEX_MARGIN);
    const scenarioTs = [nowTs, nowTs + (firstExp - nowTs) / 2, firstExp];
    const scenario = scenarioGrid(activeLegs, spot, ctx, [-5, -3, -2, -1, -0.5, 0, 0.5, 1, 2, 3, 5], scenarioTs);
    const mtm = legs.reduce((a, l) => a + l.pnl, 0);
    return { ready: true, spot, nowTs, atmIv, lotSize: info?.lotSize ?? base.lotSize, chains, nearestChain: base, legs, ctx, analysis, margin, mtm, curve, targetTs, expiryTs: firstExp, scenario, scenarioTs };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataKey, JSON.stringify(legsIn), opts.targetDays, opts.ivShift, opts.range, r, info?.kind, info?.lotSize]);
}

export function PayoffChart({ view, height = 340 }: { view: StrategyView; height?: number }) {
  const c = useChartColors();
  const option = useMemo(() => {
    if (!view.curve || !view.analysis) return {};
    const { prices, expiry, target } = view.curve;
    const sd = view.spot * view.atmIv * Math.sqrt(Math.max(0, (view.expiryTs - view.nowTs) / (365 * DAY_MS)));
    const showTarget = view.targetTs < view.expiryTs;
    return {
      ...baseOption(c),
      grid: { left: 8, right: 16, top: 36, bottom: 8, containLabel: true },
      tooltip: {
        ...(baseOption(c).tooltip as object),
        formatter: (ps: { seriesName: string; value: [number, number] }[]) =>
          `<b>${formatIndian(ps[0].value[0])}</b> (${(((ps[0].value[0] - view.spot) / view.spot) * 100).toFixed(2)}%)<br/>` + ps.map((p) => `${p.seriesName}: <b>${formatINR(p.value[1])}</b>`).join('<br/>'),
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
          name: showTarget ? `On target date` : 'Today (T+0)',
          type: 'line',
          symbol: 'none',
          data: prices.map((p, i) => [p, target[i]]),
          lineStyle: { width: 1.5, type: 'dashed', color: c.accent },
          itemStyle: { color: c.accent },
          markLine: {
            symbol: 'none',
            silent: true,
            label: { color: c.ink, fontSize: 10, formatter: '{b}' },
            data: [
              { name: `Spot ${formatIndian(view.spot, 0)}`, xAxis: view.spot, lineStyle: { color: c.accent, type: 'solid', width: 1.5 } },
              ...view.analysis.breakevens.map((b) => ({ name: `BE ${formatIndian(b, 0)}`, xAxis: b, lineStyle: { color: c.warn, type: 'dashed' } })),
              { yAxis: 0, name: '', lineStyle: { color: c.muted, type: 'solid', opacity: 0.6 } },
            ],
          },
          markArea: sd > 0 ? { silent: true, itemStyle: { color: c.accent, opacity: 0.05 }, data: [[{ name: '±1σ', xAxis: view.spot - sd, label: { color: c.muted, fontSize: 10 } }, { xAxis: view.spot + sd }], [{ name: '±2σ', xAxis: view.spot - 2 * sd, label: { show: false } }, { xAxis: view.spot + 2 * sd }]] } : undefined,
        },
      ],
    };
  }, [view, c]);
  if (!view.curve) return <div className="flex items-center justify-center text-sm text-muted" style={{ height }}>Add legs to see the payoff</div>;
  return <Chart option={option} height={height} />;
}

const money = (x: number | null) => (x === null ? 'Unlimited' : formatINR(x));

export function StrategySummary({ view }: { view: StrategyView }) {
  const a = view.analysis;
  if (!a) return null;
  const m = view.margin;
  const capital = m ? m.total + Math.max(0, m.premiumPaid - m.premiumReceived) : 0;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
      <Stat label="Max profit" value={money(a.maxProfit)} tone="up" />
      <Stat label="Max loss" value={money(a.maxLoss)} tone="down" />
      <Stat label="Breakeven(s)" value={a.breakevens.length ? a.breakevens.map((b) => formatIndian(b, 0)).join(' · ') : '—'} sub={a.breakevens.length ? a.breakevens.map((b) => `${(((b - view.spot) / view.spot) * 100).toFixed(1)}%`).join(' · ') : undefined} />
      <Stat label="Probability of profit" value={`${(a.pop * 100).toFixed(1)}%`} tone="accent" hint="Risk-neutral lognormal probability of P&L > 0 at expiry" />
      <Stat label="Risk : Reward" value={a.riskReward === null ? '—' : `1 : ${a.riskReward.toFixed(2)}`} />
      <Stat label={a.netPremium >= 0 ? 'Net credit' : 'Net debit'} value={formatINR(Math.abs(a.netPremium))} tone={a.netPremium >= 0 ? 'up' : 'down'} />
      <Stat label="Approx. margin" value={formatINR(m?.total ?? 0)} sub={m ? `SPAN ${formatINR(m.span)} + Exp ${formatINR(m.exposure)}` : undefined} hint="SPAN-style estimate; broker margins vary" />
      <Stat label="Capital required" value={formatINR(capital)} sub={m && m.hedgeBenefit > 0 ? `Hedge benefit ${formatINR(m.hedgeBenefit)}` : undefined} />
      <Stat label="Current MTM" value={formatINR(view.mtm)} tone={view.mtm >= 0 ? 'up' : 'down'} />
      <Stat label="Expected P&L" value={formatINR(a.expectedPnl)} hint="Mean P&L at expiry under the lognormal model" />
      <Stat label="Delta · Gamma" value={`${a.greeks.delta.toFixed(1)} · ${a.greeks.gamma.toFixed(3)}`} sub="Position (units of underlying)" />
      <Stat label="Theta · Vega" value={`${formatINR(a.greeks.theta)} · ${formatINR(a.greeks.vega)}`} sub="Per day · per 1% IV" />
    </div>
  );
}

export function ScenarioTable({ view }: { view: StrategyView }) {
  if (!view.scenario) return null;
  const labels = ['Today', 'Mid-way', 'Expiry'];
  return (
    <div className="overflow-x-auto">
      <table className="tbl">
        <thead>
          <tr>
            <th>Spot move</th>
            <th className="num">Price</th>
            {labels.map((l) => (
              <th key={l} className="num">P&L {l}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {view.scenario.map((row) => (
            <tr key={row.movePct} className={row.movePct === 0 ? 'font-semibold' : ''}>
              <td>{row.movePct > 0 ? '+' : ''}{row.movePct}%</td>
              <td className="num">{formatIndian(row.spot)}</td>
              {row.pnl.map((p, i) => (
                <td key={i} className={`num ${p >= 0 ? 'text-up' : 'text-down'}`}>{formatINR(p)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
