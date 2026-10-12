/** Indian F&O option charges per executed order (defaults mirror the Calculators page). */
export interface ChargeRates {
  /** Flat brokerage per executed order (₹). */
  brokeragePerOrder: number;
  /** STT on the sell-side premium (%). */
  sttSellPct: number;
  /** Exchange transaction charge on premium turnover (%). */
  exchangePct: number;
  /** SEBI turnover fee per crore (₹). */
  sebiPerCrore: number;
  /** Stamp duty on the buy-side premium (%). */
  stampBuyPct: number;
  /** GST on brokerage + exchange + SEBI fees (%). */
  gstPct: number;
}

export const DEFAULT_OPTION_CHARGES: ChargeRates = {
  brokeragePerOrder: 20,
  sttSellPct: 0.1,
  exchangePct: 0.03503,
  sebiPerCrore: 10,
  stampBuyPct: 0.003,
  gstPct: 18,
};

export function optionOrderCharges(side: 'BUY' | 'SELL', premium: number, quantity: number, rates: ChargeRates = DEFAULT_OPTION_CHARGES): number {
  const value = premium * quantity;
  const brokerage = rates.brokeragePerOrder;
  const stt = side === 'SELL' ? (value * rates.sttSellPct) / 100 : 0;
  const exchange = (value * rates.exchangePct) / 100;
  const sebi = (value * rates.sebiPerCrore) / 1e7;
  const stamp = side === 'BUY' ? (value * rates.stampBuyPct) / 100 : 0;
  const gst = ((brokerage + exchange + sebi) * rates.gstPct) / 100;
  return brokerage + stt + exchange + sebi + stamp + gst;
}

export function totalCharges(fills: { side: 'BUY' | 'SELL'; price: number; lots: number }[], lotSize: number, rates: ChargeRates = DEFAULT_OPTION_CHARGES): number {
  let t = 0;
  for (const f of fills) t += optionOrderCharges(f.side, f.price, f.lots * lotSize, rates);
  return t;
}
