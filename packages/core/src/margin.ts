/**
 * Approximate SPAN-style margin for a basket of F&O legs.
 *
 * Exchanges compute margin with SPAN risk arrays (16 price/vol scenarios) plus an
 * exposure margin. This reproduces that structure so hedged positions get the
 * familiar margin benefit. It is an estimate — brokers' exact numbers differ.
 */
import { legQty, sideSign, strategyPnl, type Leg, type ValuationContext } from './payoff';

export interface MarginParams {
  /** Price scan range as a fraction of the underlying (index ≈ 0.06–0.08, stocks ≈ 0.10–0.15). */
  priceScanRange: number;
  /** Volatility scan range as a relative change in IV (0.25 = ±25%). */
  volScanRange: number;
  /** Exposure / extreme-loss margin on short notional (index 2%, stocks 3.5%). */
  exposurePct: number;
  /** Short option minimum charge as fraction of notional per short option. */
  shortOptionMinPct: number;
}

export const INDEX_MARGIN: MarginParams = { priceScanRange: 0.07, volScanRange: 0.25, exposurePct: 0.02, shortOptionMinPct: 0.0125 };
export const STOCK_MARGIN: MarginParams = { priceScanRange: 0.12, volScanRange: 0.25, exposurePct: 0.035, shortOptionMinPct: 0.02 };

export interface MarginResult {
  span: number;
  exposure: number;
  total: number;
  /** Premium paid for long options (debited from funds, not margin). */
  premiumPaid: number;
  /** Premium received from short options (adds to funds). */
  premiumReceived: number;
  /** Margin without hedge benefit (sum of individual legs). */
  unhedged: number;
  hedgeBenefit: number;
}

function spanScenarioLoss(legs: readonly Leg[], S: number, nowTs: number, ctx: ValuationContext, p: MarginParams): number {
  const base = strategyPnl(legs, S, nowTs, ctx);
  let worst = 0;
  const priceFractions = [0, 1 / 3, -1 / 3, 2 / 3, -2 / 3, 1, -1];
  for (const pf of priceFractions) {
    for (const vs of [1, -1]) {
      const shifted = { ...ctx, ivShift: (ctx.ivShift ?? 0) + vs * p.volScanRange * (ctx.defaultIv ?? 0.15) };
      const loss = base - strategyPnl(legs, S * (1 + pf * p.priceScanRange), nowTs, shifted);
      if (loss > worst) worst = loss;
    }
  }
  // Extreme moves (2× range), 35% covered.
  for (const sign of [1, -1]) {
    const loss = (base - strategyPnl(legs, S * (1 + sign * 2 * p.priceScanRange), nowTs, ctx)) * 0.35;
    if (loss > worst) worst = loss;
  }
  return worst;
}

export function estimateMargin(legs: readonly Leg[], S: number, nowTs: number, ctx: ValuationContext, params: MarginParams): MarginResult {
  const open = legs.filter((l) => l.active !== false && l.exitPrice == null && l.lots > 0);
  // Mark legs at current theoretical price so SPAN measures risk, not entry P&L.
  const marked = open.map((l) => ({ ...l }));
  let premiumPaid = 0;
  let premiumReceived = 0;
  let exposure = 0;
  let shortOptQty = 0;
  let longOptQty = 0;
  for (const l of marked) {
    const qty = legQty(l);
    if (l.type === 'FUT') {
      exposure += S * qty * params.exposurePct;
      continue;
    }
    if (l.side === 'BUY') {
      premiumPaid += l.price * qty;
      longOptQty += qty;
    } else {
      premiumReceived += l.price * qty;
      exposure += S * qty * params.exposurePct;
      shortOptQty += qty;
    }
  }
  // Short option minimum charge applies to net (unhedged) short option quantity.
  const shortOptionMin = Math.max(0, shortOptQty - longOptQty) * S * params.shortOptionMinPct;
  // Long-only option baskets need no SPAN — their max loss is the premium already paid.
  const hasShortRisk = marked.some((l) => l.type === 'FUT' || l.side === 'SELL');
  const span = hasShortRisk ? Math.max(spanScenarioLoss(marked, S, nowTs, ctx, params), shortOptionMin) : 0;
  const total = span + exposure;

  let unhedged = 0;
  for (const l of marked) {
    if (l.type !== 'FUT' && l.side === 'BUY') continue;
    const single = [l];
    const s = spanScenarioLoss(single, S, nowTs, ctx, params);
    const e = S * legQty(l) * params.exposurePct;
    unhedged += Math.max(s, l.type === 'FUT' ? 0 : S * legQty(l) * params.shortOptionMinPct) + e;
  }
  return { span, exposure, total, premiumPaid, premiumReceived, unhedged, hedgeBenefit: Math.max(0, unhedged - total) };
}

/** Funds needed to enter: margin blocked + net premium paid. */
export function capitalRequired(m: MarginResult): number {
  return m.total + Math.max(0, m.premiumPaid - m.premiumReceived);
}

export function signedNotional(legs: readonly Leg[], S: number): number {
  return legs.reduce((a, l) => a + sideSign(l.side) * legQty(l) * S, 0);
}
