/**
 * F&O instrument universe for the simulated market: NSE/BSE indices and liquid F&O stocks.
 * Contract specs follow exchange conventions (index lot sizes per the Jan-2026 revision);
 * stock lot sizes/strike steps are derived from price the way NSE sizes contracts.
 */
import type { ExpiryRule, SymbolInfo } from '@q26/core';

export interface Instrument extends SymbolInfo {
  /** Reference price level the simulated series mean-reverts around. */
  basePrice: number;
  /** Annualised realised volatility of daily returns (decimal). */
  vol: number;
  /** Long-run ATM implied volatility (decimal). */
  baseIv: number;
  /** Sensitivity to the NIFTY market factor. */
  beta: number;
  /** Sector factor loading (0..1). */
  sectorLoad: number;
  /** Continuous dividend / carry yield. */
  divYield: number;
  /** Peak single-strike option OI (quantity) for the most active expiry. */
  peakOi: number;
  /** Aggregate futures OI (quantity). */
  futOi: number;
  /** IV skew slope / smile curvature in standardised moneyness. */
  skew: number;
  smile: number;
  /** Relative liquidity (spreads, volumes). */
  liquidity: number;
}

function strikeStepFor(price: number): number {
  if (price < 100) return 1;
  if (price < 250) return 2.5;
  if (price < 500) return 5;
  if (price < 1000) return 10;
  if (price < 2500) return 20;
  if (price < 5000) return 50;
  if (price < 10000) return 100;
  if (price < 20000) return 250;
  return 500;
}

function lotSizeFor(price: number): number {
  const raw = 750_000 / price;
  const nice = [1, 5, 10, 25, 50, 75, 100, 125, 150, 175, 200, 250, 300, 350, 400, 425, 450, 500, 550, 600, 625, 700, 750, 800, 900, 1000, 1100, 1200, 1250, 1400, 1500, 1600, 1750, 1800, 2000, 2250, 2400, 2500, 2700, 3000, 3200, 3500, 3750, 4000, 4500, 5000, 5500, 6000, 6750, 7000, 7500, 8000, 9000, 10000];
  let best = nice[0];
  for (const n of nice) if (Math.abs(n - raw) < Math.abs(best - raw)) best = n;
  return best;
}

interface IndexSpec {
  symbol: string;
  name: string;
  exchange: 'NSE' | 'BSE';
  basePrice: number;
  lotSize: number;
  strikeStep: number;
  expiryRule: ExpiryRule;
  vol: number;
  baseIv: number;
  beta: number;
  sectorLoad: number;
  sector: string;
  peakOi: number;
  futOi: number;
}

const INDICES: IndexSpec[] = [
  { symbol: 'NIFTY', name: 'Nifty 50', exchange: 'NSE', basePrice: 25150, lotSize: 65, strikeStep: 50, expiryRule: 'weekly-tue', vol: 0.12, baseIv: 0.118, beta: 1, sectorLoad: 0, sector: 'Index', peakOi: 14_000_000, futOi: 16_000_000 },
  { symbol: 'BANKNIFTY', name: 'Nifty Bank', exchange: 'NSE', basePrice: 56400, lotSize: 30, strikeStep: 100, expiryRule: 'monthly-tue', vol: 0.145, baseIv: 0.128, beta: 1.08, sectorLoad: 0.8, sector: 'Index', peakOi: 2_600_000, futOi: 2_400_000 },
  { symbol: 'FINNIFTY', name: 'Nifty Financial Services', exchange: 'NSE', basePrice: 26700, lotSize: 60, strikeStep: 50, expiryRule: 'monthly-tue', vol: 0.14, baseIv: 0.125, beta: 1.05, sectorLoad: 0.7, sector: 'Index', peakOi: 420_000, futOi: 260_000 },
  { symbol: 'MIDCPNIFTY', name: 'Nifty Midcap Select', exchange: 'NSE', basePrice: 13150, lotSize: 120, strikeStep: 25, expiryRule: 'monthly-tue', vol: 0.16, baseIv: 0.145, beta: 1.12, sectorLoad: 0, sector: 'Index', peakOi: 1_300_000, futOi: 900_000 },
  { symbol: 'SENSEX', name: 'BSE Sensex', exchange: 'BSE', basePrice: 82200, lotSize: 20, strikeStep: 100, expiryRule: 'weekly-thu', vol: 0.118, baseIv: 0.12, beta: 0.99, sectorLoad: 0, sector: 'Index', peakOi: 3_800_000, futOi: 600_000 },
  { symbol: 'BANKEX', name: 'BSE Bankex', exchange: 'BSE', basePrice: 63500, lotSize: 30, strikeStep: 100, expiryRule: 'monthly-thu', vol: 0.145, baseIv: 0.13, beta: 1.07, sectorLoad: 0.85, sector: 'Index', peakOi: 120_000, futOi: 60_000 },
];

/** [symbol, name, sector, price, annual vol, beta, liquidity] */
const STOCKS: Array<[string, string, string, number, number, number, number]> = [
  ['RELIANCE', 'Reliance Industries', 'Energy', 1405, 0.22, 1.0, 1.5],
  ['HDFCBANK', 'HDFC Bank', 'Banks', 965, 0.19, 0.95, 1.4],
  ['ICICIBANK', 'ICICI Bank', 'Banks', 1395, 0.2, 1.0, 1.3],
  ['INFY', 'Infosys', 'IT', 1510, 0.24, 0.85, 1.2],
  ['TCS', 'Tata Consultancy Services', 'IT', 3080, 0.21, 0.75, 1.1],
  ['SBIN', 'State Bank of India', 'Banks', 865, 0.25, 1.2, 1.3],
  ['AXISBANK', 'Axis Bank', 'Banks', 1165, 0.24, 1.1, 1.0],
  ['KOTAKBANK', 'Kotak Mahindra Bank', 'Banks', 2120, 0.22, 0.9, 0.9],
  ['LT', 'Larsen & Toubro', 'Capital Goods', 3720, 0.23, 1.05, 0.9],
  ['ITC', 'ITC', 'FMCG', 412, 0.18, 0.6, 0.9],
  ['BHARTIARTL', 'Bharti Airtel', 'Telecom', 1945, 0.21, 0.75, 1.0],
  ['HINDUNILVR', 'Hindustan Unilever', 'FMCG', 2480, 0.19, 0.55, 0.7],
  ['BAJFINANCE', 'Bajaj Finance', 'Financials', 1015, 0.3, 1.3, 1.1],
  ['MARUTI', 'Maruti Suzuki', 'Auto', 15950, 0.23, 0.85, 0.6],
  ['M&M', 'Mahindra & Mahindra', 'Auto', 3520, 0.27, 1.05, 0.8],
  ['SUNPHARMA', 'Sun Pharmaceutical', 'Pharma', 1660, 0.22, 0.55, 0.7],
  ['TITAN', 'Titan Company', 'Consumer', 3510, 0.25, 0.9, 0.7],
  ['ASIANPAINT', 'Asian Paints', 'Consumer', 2410, 0.23, 0.7, 0.6],
  ['WIPRO', 'Wipro', 'IT', 252, 0.26, 0.85, 0.7],
  ['HCLTECH', 'HCL Technologies', 'IT', 1510, 0.24, 0.8, 0.7],
  ['TECHM', 'Tech Mahindra', 'IT', 1460, 0.28, 0.9, 0.6],
  ['ULTRACEMCO', 'UltraTech Cement', 'Cement', 12100, 0.23, 0.9, 0.5],
  ['NTPC', 'NTPC', 'Power', 342, 0.24, 0.9, 0.8],
  ['POWERGRID', 'Power Grid Corp', 'Power', 291, 0.22, 0.8, 0.6],
  ['ONGC', 'Oil & Natural Gas Corp', 'Energy', 243, 0.28, 1.0, 0.7],
  ['COALINDIA', 'Coal India', 'Metals', 391, 0.27, 0.9, 0.7],
  ['TATASTEEL', 'Tata Steel', 'Metals', 171, 0.32, 1.35, 1.0],
  ['JSWSTEEL', 'JSW Steel', 'Metals', 1105, 0.3, 1.25, 0.6],
  ['HINDALCO', 'Hindalco Industries', 'Metals', 752, 0.32, 1.3, 0.8],
  ['ADANIENT', 'Adani Enterprises', 'Infra', 2410, 0.42, 1.4, 0.9],
  ['ADANIPORTS', 'Adani Ports & SEZ', 'Infra', 1415, 0.35, 1.3, 0.8],
  ['BAJAJ-AUTO', 'Bajaj Auto', 'Auto', 8820, 0.24, 0.8, 0.5],
  ['HEROMOTOCO', 'Hero MotoCorp', 'Auto', 5320, 0.27, 0.85, 0.5],
  ['EICHERMOT', 'Eicher Motors', 'Auto', 6980, 0.27, 0.9, 0.5],
  ['DRREDDY', "Dr. Reddy's Laboratories", 'Pharma', 1255, 0.24, 0.5, 0.6],
  ['CIPLA', 'Cipla', 'Pharma', 1545, 0.23, 0.5, 0.6],
  ['DIVISLAB', "Divi's Laboratories", 'Pharma', 6180, 0.27, 0.6, 0.4],
  ['NESTLEIND', 'Nestle India', 'FMCG', 1205, 0.18, 0.5, 0.5],
  ['BRITANNIA', 'Britannia Industries', 'FMCG', 5910, 0.2, 0.5, 0.4],
  ['INDUSINDBK', 'IndusInd Bank', 'Banks', 752, 0.38, 1.4, 0.9],
  ['BANKBARODA', 'Bank of Baroda', 'Banks', 252, 0.3, 1.3, 0.8],
  ['PNB', 'Punjab National Bank', 'Banks', 112, 0.33, 1.35, 0.8],
  ['CANBK', 'Canara Bank', 'Banks', 121, 0.33, 1.35, 0.7],
  ['DLF', 'DLF', 'Realty', 752, 0.33, 1.4, 0.8],
  ['VEDL', 'Vedanta', 'Metals', 468, 0.34, 1.3, 0.8],
  ['BPCL', 'Bharat Petroleum', 'Energy', 342, 0.3, 1.0, 0.6],
  ['IOC', 'Indian Oil Corp', 'Energy', 151, 0.29, 1.0, 0.6],
  ['GRASIM', 'Grasim Industries', 'Cement', 2790, 0.23, 0.9, 0.4],
  ['TATAPOWER', 'Tata Power', 'Power', 392, 0.32, 1.2, 0.8],
  ['ETERNAL', 'Eternal (Zomato)', 'Consumer', 332, 0.4, 1.3, 1.1],
  ['TRENT', 'Trent', 'Consumer', 4810, 0.34, 1.1, 0.6],
  ['HAL', 'Hindustan Aeronautics', 'Capital Goods', 4720, 0.36, 1.2, 0.8],
  ['BEL', 'Bharat Electronics', 'Capital Goods', 402, 0.32, 1.15, 0.9],
  ['IRCTC', 'IRCTC', 'Consumer', 722, 0.27, 0.9, 0.5],
  ['SBILIFE', 'SBI Life Insurance', 'Financials', 1845, 0.22, 0.7, 0.4],
  ['HDFCLIFE', 'HDFC Life Insurance', 'Financials', 772, 0.24, 0.75, 0.5],
  ['BAJAJFINSV', 'Bajaj Finserv', 'Financials', 2005, 0.25, 1.0, 0.5],
  ['SHRIRAMFIN', 'Shriram Finance', 'Financials', 652, 0.33, 1.25, 0.6],
];

export function buildUniverse(): Instrument[] {
  const indices: Instrument[] = INDICES.map((s) => ({
    symbol: s.symbol,
    name: s.name,
    kind: 'index',
    exchange: s.exchange,
    sector: s.sector,
    lotSize: s.lotSize,
    strikeStep: s.strikeStep,
    expiryRule: s.expiryRule,
    basePrice: s.basePrice,
    vol: s.vol,
    baseIv: s.baseIv,
    beta: s.beta,
    sectorLoad: s.sectorLoad,
    divYield: 0.012,
    peakOi: s.peakOi,
    futOi: s.futOi,
    skew: -0.05,
    smile: 0.012,
    liquidity: s.symbol === 'NIFTY' || s.symbol === 'SENSEX' ? 2.2 : 1.4,
  }));
  const stocks: Instrument[] = STOCKS.map(([symbol, name, sector, price, vol, beta, liq]) => ({
    symbol,
    name,
    kind: 'stock',
    exchange: 'NSE',
    sector,
    lotSize: lotSizeFor(price),
    strikeStep: strikeStepFor(price),
    expiryRule: 'monthly-tue',
    basePrice: price,
    vol,
    baseIv: vol * 1.08,
    beta,
    sectorLoad: 0.55,
    divYield: 0.008,
    peakOi: Math.round((liq * 3.2e9) / price / 100) * 100,
    futOi: Math.round((liq * 2.4e10) / price / 1000) * 1000,
    skew: -0.025,
    smile: 0.02,
    liquidity: liq,
  }));
  return [...indices, ...stocks];
}

/** Sector factor that drives each index beyond the market factor. */
export function sectorKey(inst: Instrument): string {
  if (inst.kind === 'index') {
    if (inst.symbol === 'BANKNIFTY' || inst.symbol === 'BANKEX') return 'Banks';
    if (inst.symbol === 'FINNIFTY') return 'Financials';
    return 'Market';
  }
  return inst.sector;
}
