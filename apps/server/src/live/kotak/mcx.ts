/**
 * MCX (commodity) contracts from Kotak's mcx_fo instrument master. The ScripMaster turns them into
 * ordinary underlyings (kind 'commodity', exchange 'MCX'), so every tab works on GOLD, SILVER,
 * CRUDEOIL, NATURALGAS … as it does on NIFTY. MCX differs from NSE/BSE in ways the rest of the app
 * reads from the underlying, not from here: it trades 09:00–23:30/23:55 IST (calendar), it has no
 * cash market (the "spot" is the near-month future), and its options are written on futures
 * (Black-76 on the future each option expiry settles into: underlyingFuture).
 *
 * The file's strike scale and expiry epoch are not assumed: they are checked against the trading
 * symbols / the date, and a file that fits neither is refused (MCX left out with the reason, never
 * wrong strikes). Units per lot are checked against MCX's published contract specifications
 * (MCX_CONTRACTS): MCX quotes many prices per a smaller unit than the lot (gold per 10 g, lot 1 kg),
 * so P&L = price change × units per lot must use the right multiplier.
 */
import { DAY_MS } from '@q26/core';
import { csvRecords, decodeExpiry, fmtStrike, istDate } from './scripmaster';

export interface McxContract {
  token: string;
  tradingSymbol: string;
  expiry: string;
  lotSize: number;
}

export interface McxCommodity {
  symbol: string;
  /** Price-quotation units per lot (the P&L multiplier), checked against MCX_CONTRACTS. */
  lotSize: number;
  /** The file's own lLotSize / lMultiplier of the commodity (for the unit check). */
  fileLot: number;
  fileMultiplier: number | null;
  /** Futures by expiry. */
  futures: Map<string, McxContract>;
  /** Options: expiry → strike → legs. */
  options: Map<string, Map<number, { CE?: McxContract; PE?: McxContract }>>;
}

export interface McxMaster {
  date: string;
  commodities: Map<string, McxCommodity>;
  warnings: string[];
}

/** Paise is the documented unit for nse_fo/bse_fo strikes; MCX is checked, not assumed. */
const STRIKE_DIVISORS = [100, 1, 10_000, 10] as const;

/** Parse Kotak's mcx_fo instrument master. Throws (with the reason) when the file cannot be trusted. */
export function parseMcxMaster(text: string, today: string): McxMaster {
  const it = csvRecords(text);
  const first = it.next();
  if (first.done) throw new Error('MCX instrument master is empty');
  const header = first.value.map((h) => h.trim());
  const col = new Map(header.map((h, i) => [h, i]));
  const need = ['pSymbol', 'pExchSeg', 'pSymbolName', 'pTrdSymbol', 'pInstType', 'pOptionType', 'lExpiryDate', 'dStrikePrice;', 'lLotSize'];
  const miss = need.filter((h) => !col.has(h));
  if (miss.length) throw new Error(`MCX instrument master: missing columns ${miss.join(', ')}`);
  const c = (n: string) => col.get(n)!;

  const iMult = col.get('lMultiplier');
  type Raw = { name: string; token: string; trd: string; kind: 'FUT' | 'CE' | 'PE'; expRaw: string; strikeRaw: number; lot: number; mult: number | null };
  const raws: Raw[] = [];
  let bad = 0;
  for (const r of it) {
    if (r.length !== header.length) {
      bad++;
      continue;
    }
    const token = r[c('pSymbol')].trim();
    if (!/^\d+$/.test(token) || r[c('pExchSeg')].trim().toLowerCase() !== 'mcx_fo') {
      bad++;
      continue;
    }
    const inst = r[c('pInstType')].trim().toUpperCase();
    const opt = r[c('pOptionType')].trim().toUpperCase();
    const kind = inst.startsWith('OPT') && (opt === 'CE' || opt === 'PE') ? opt : inst.startsWith('FUT') ? 'FUT' : null;
    const lot = Number(r[c('lLotSize')].trim());
    if (!kind || !(Number.isInteger(lot) && lot > 0)) continue;
    raws.push({
      name: r[c('pSymbolName')].trim().toUpperCase(),
      token,
      trd: r[c('pTrdSymbol')].trim(),
      kind,
      expRaw: r[c('lExpiryDate')],
      strikeRaw: Number.parseFloat(r[c('dStrikePrice;')].trim()),
      lot,
      mult: iMult !== undefined && Number(r[iMult].trim()) > 0 ? Number(r[iMult].trim()) : null,
    });
  }
  if (!raws.length) throw new Error(`MCX instrument master: no futures or options rows${bad ? ` (${bad} malformed)` : ''}`);

  // Expiry epoch: plain Unix seconds expected; fall back to the NSE epoch if most dates land in the past.
  const pastLimit = istDate(Date.parse(`${today}T00:00:00Z`) - 7 * DAY_MS);
  const pastShare = (seg: string) => raws.filter((x) => (decodeExpiry(x.expRaw, seg) ?? '0') < pastLimit).length / raws.length;
  const expSeg = pastShare('mcx_fo') <= 0.5 ? 'mcx_fo' : pastShare('nse_fo') <= 0.5 ? 'nse_fo' : null;
  if (!expSeg) throw new Error('MCX instrument master: expiry dates do not decode to current contracts (epoch format changed?)');

  // Strike scale: the trading symbol ends with '<strike><CE|PE>' (CRUDEOIL25NOV5400CE).
  const opts = raws.filter((x) => x.kind !== 'FUT' && x.strikeRaw > 0);
  const sample = opts.slice(0, 500);
  const matches = (div: number) => sample.filter((x) => x.trd.replace(/\s+/g, '').toUpperCase().endsWith(`${fmtStrike(x.strikeRaw / div)}${x.kind}`)).length;
  const divisor = sample.length ? STRIKE_DIVISORS.find((d) => matches(d) >= sample.length / 2) : 100;
  if (divisor === undefined) throw new Error(`MCX instrument master: strikes do not match the trading symbols at any known scale (checked ${sample.length})`);

  const commodities = new Map<string, McxCommodity>();
  for (const x of raws) {
    const expiry = decodeExpiry(x.expRaw, expSeg);
    if (!expiry || expiry < today || !x.name) continue;
    let cm = commodities.get(x.name);
    if (!cm) commodities.set(x.name, (cm = { symbol: x.name, lotSize: x.lot, fileLot: x.lot, fileMultiplier: x.mult, futures: new Map(), options: new Map() }));
    const contract: McxContract = { token: x.token, tradingSymbol: x.trd, expiry, lotSize: x.lot };
    if (x.kind === 'FUT') {
      cm.futures.set(expiry, contract);
      cm.fileLot = x.lot;
      cm.fileMultiplier = x.mult;
      continue;
    }
    if (!(x.strikeRaw > 0)) continue;
    const strike = Math.round((x.strikeRaw / divisor) * 100) / 100;
    let byStrike = cm.options.get(expiry);
    if (!byStrike) cm.options.set(expiry, (byStrike = new Map()));
    const legs = byStrike.get(strike) ?? {};
    legs[x.kind] = contract;
    byStrike.set(strike, legs);
  }
  // Only commodities with options and a future to price them on.
  for (const [k, cm] of commodities) if (!cm.options.size || !cm.futures.size) commodities.delete(k);
  if (!commodities.size) throw new Error('MCX instrument master: no commodity has live options and futures');
  const warnings = bad ? [`MCX instrument master: skipped ${bad} malformed rows`] : [];
  // Units per lot: MCX's published specification when the file agrees with it in any reading
  // (lLotSize, lLotSize × lMultiplier, lMultiplier); the specification otherwise (with a warning);
  // the file's lLotSize for a commodity the table does not know (with a warning).
  for (const cm of commodities.values()) {
    const spec = MCX_CONTRACTS[cm.symbol];
    const m = cm.fileMultiplier;
    const readings = [cm.fileLot, ...(m && m > 1 ? [cm.fileLot * m, m] : [])];
    if (spec) {
      cm.lotSize = spec.unitsPerLot;
      if (!readings.includes(spec.unitsPerLot)) warnings.push(`MCX ${cm.symbol}: the instrument file gives lot ${cm.fileLot}${m ? ` × multiplier ${m}` : ''}; MCX specifies ${spec.unitsPerLot} ${spec.unit} per lot (${spec.lot}), which is used`);
    } else {
      cm.lotSize = cm.fileLot;
      warnings.push(`MCX ${cm.symbol}: not in the contract table; units per lot ${cm.fileLot} taken from the instrument file (unverified)`);
    }
    for (const contract of [...cm.futures.values(), ...[...cm.options.values()].flatMap((byStrike) => [...byStrike.values()].flatMap((l) => [l.CE, l.PE]))]) {
      if (contract) contract.lotSize = cm.lotSize;
    }
  }
  return { date: today, commodities, warnings };
}

/** The futures contract an option expiry settles into: the nearest future expiring on or after it. */
export function underlyingFuture(cm: Pick<McxCommodity, 'futures'>, optionExpiry: string): McxContract {
  const exps = [...cm.futures.keys()].sort();
  const e = exps.find((x) => x >= optionExpiry) ?? exps[exps.length - 1];
  return cm.futures.get(e)!;
}

export interface McxContractSpec {
  name: string;
  sector: 'Precious Metals' | 'Base Metals' | 'Energy';
  /** Price-quotation units in one lot: the P&L of a 1-rupee move per lot. */
  unitsPerLot: number;
  /** The quotation unit, for messages. */
  unit: string;
  /** The lot as MCX publishes it, for messages. */
  lot: string;
}

/**
 * MCX contract specifications (reference metadata from MCX's published contract specifications, like
 * the sector labels of stocks): the quotation unit and the lot, hence the units per lot. Used to check
 * the instrument file's lot fields, whose meaning for MCX is not documented by Kotak.
 */
export const MCX_CONTRACTS: Readonly<Record<string, McxContractSpec>> = {
  GOLD: { name: 'Gold', sector: 'Precious Metals', unitsPerLot: 100, unit: '10 g', lot: '1 kg' },
  GOLDM: { name: 'Gold Mini', sector: 'Precious Metals', unitsPerLot: 10, unit: '10 g', lot: '100 g' },
  SILVER: { name: 'Silver', sector: 'Precious Metals', unitsPerLot: 30, unit: 'kg', lot: '30 kg' },
  SILVERM: { name: 'Silver Mini', sector: 'Precious Metals', unitsPerLot: 5, unit: 'kg', lot: '5 kg' },
  CRUDEOIL: { name: 'Crude Oil', sector: 'Energy', unitsPerLot: 100, unit: 'barrel', lot: '100 barrels' },
  CRUDEOILM: { name: 'Crude Oil Mini', sector: 'Energy', unitsPerLot: 10, unit: 'barrel', lot: '10 barrels' },
  NATURALGAS: { name: 'Natural Gas', sector: 'Energy', unitsPerLot: 1250, unit: 'mmBtu', lot: '1,250 mmBtu' },
  NATGASMINI: { name: 'Natural Gas Mini', sector: 'Energy', unitsPerLot: 250, unit: 'mmBtu', lot: '250 mmBtu' },
  COPPER: { name: 'Copper', sector: 'Base Metals', unitsPerLot: 2500, unit: 'kg', lot: '2,500 kg' },
  ZINC: { name: 'Zinc', sector: 'Base Metals', unitsPerLot: 5000, unit: 'kg', lot: '5 MT' },
  ALUMINIUM: { name: 'Aluminium', sector: 'Base Metals', unitsPerLot: 5000, unit: 'kg', lot: '5 MT' },
  LEAD: { name: 'Lead', sector: 'Base Metals', unitsPerLot: 5000, unit: 'kg', lot: '5 MT' },
};
