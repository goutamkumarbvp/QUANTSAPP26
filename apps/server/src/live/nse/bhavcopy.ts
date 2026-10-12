/**
 * Official daily bhavcopies (UDiFF, 34 columns, identical header on NSE and BSE):
 *  - NSE F&O  → DailyOption / DailyFuture for index and stock contracts (nse-bse-public-data.md §2);
 *  - NSE CM   → DailyBar per stock (critic.md R10);
 *  - BSE F&O  → DailyOption / DailyFuture for SENSEX / BANKEX (§9).
 *
 * Units (critic.md C13: the app stores OI and volume in units): `OpnIntrst`/`ChngInOpnIntrst` are units
 * on both exchanges; `TtlTradgVol` is contracts on NSE (§2, turnover arithmetic) and, by inference only,
 * units on BSE (§9, critic U14). The volume unit is therefore re-checked on every file from
 * `TtlTrfVal` ≈ volume × price (× lot when the volume is in contracts).
 * Rows are never completed with guesses: a row without a required value is skipped and counted.
 */
import type { DailyBar, DailyFuture, DailyOption, InstrumentKey, OptKind } from '../types';
import { BSE_WWW, CsvTable, NSE_ARCHIVES, NseError, assertYmd, csvRecords, parseDate, ymdCompact, type NseHttp, type Published } from './http';

export type Exchange = 'NSE' | 'BSE';
/** IDO index option, STO stock option, IDF index future, STF stock future (§2). */
export type FoInstrument = 'IDO' | 'STO' | 'IDF' | 'STF';
export type VolumeUnit = 'contracts' | 'units';

/** UDiFF is mandatory from this date (NSE circular NSE/MSD/62424); older files use the legacy layout (§2). */
export const NSE_UDIFF_START = '2024-07-08';

export const nseFoBhavcopyUrl = (date: string): string => `${NSE_ARCHIVES}/content/fo/BhavCopy_NSE_FO_0_0_0_${ymdCompact(date)}_F_0000.csv.zip`;
export const nseCmBhavcopyUrl = (date: string): string => `${NSE_ARCHIVES}/content/cm/BhavCopy_NSE_CM_0_0_0_${ymdCompact(date)}_F_0000.csv.zip`;
/** Plain CSV, not zipped; path case as linked from BSE's bhavcopy page (§9, case-insensitivity UNCONFIRMED). */
export const bseFoBhavcopyUrl = (date: string): string => `${BSE_WWW}/download/Bhavcopy/Derivative/BhavCopy_BSE_FO_0_0_0_${ymdCompact(date)}_F_0000.CSV`;

/* ------------------------------------------------------------------------------------------ */
/* Types                                                                                        */
/* ------------------------------------------------------------------------------------------ */

/** Extra per-row facts kept from the file (the DailyOption/DailyFuture fields stay as in types.ts). */
export interface BhavRowMeta {
  symbol: string;
  exchange: Exchange;
  instrument: FoInstrument;
  /** `NewBrdLotQty` of the row (lot sizes change twice a year, §2 "Robustness"). */
  lotSize?: number;
  /** Volume in contracts, when known. */
  contracts?: number;
  /** `TtlNbOfTxsExctd`. 0 means the printed close was not traded (NSE carries the previous close, §2). */
  trades?: number;
  /** OHLC/last are undefined when the file prints 0.00 (untraded, §2). */
  open?: number;
  high?: number;
  low?: number;
  last?: number;
  prevClose?: number;
  /** `TtlTrfVal` in ₹ (notional for options, §2). */
  turnover?: number;
  /** Exchange token (`FinInstrmId`); NSE reuses tokens, so join on the contract key instead (critic §3). */
  token?: string;
  /** `FinInstrmNm`, e.g. NIFTY2691525900PE. */
  tradingSymbol?: string;
  /** The row is dated on the contract's own expiry day. */
  expiryDay: boolean;
}

export interface BhavOption extends DailyOption, BhavRowMeta {}
export interface BhavFuture extends DailyFuture, BhavRowMeta {
  /** `UndrlygPric`. */
  underlying?: number;
}

/**
 * Underlying final settlement price read from the expiry-day `SttlmPric` of the expiring contracts.
 * PROVISIONAL (critic U13): inferred from sample rows, not from an exchange specification; to be
 * checked against the NSE final-settlement circular. Used only for paper settlement.
 */
export interface FinalSettlement {
  symbol: string;
  expiry: string;
  price: number;
}

export interface VolumeUnitCheck {
  verdict: VolumeUnit | 'inconclusive';
  contractsVotes: number;
  unitsVotes: number;
}

export interface FoBhavcopy {
  exchange: Exchange;
  /** `TradDt`. */
  date: string;
  options: BhavOption[];
  futures: BhavFuture[];
  finalSettlements: FinalSettlement[];
  /** Unit of `TtlTradgVol` that was applied, and the per-file turnover check behind it. */
  volumeUnit: VolumeUnit;
  volumeUnitCheck: VolumeUnitCheck;
  /** Rows dropped, by reason. */
  skipped: Record<string, number>;
}

export interface FoParseOptions {
  exchange: Exchange;
  /**
   * Unit of `TtlTradgVol`. 'auto' (default) uses the per-file turnover check and, when that is
   * inconclusive, the documented unit (NSE contracts §2; BSE units §9, UNCONFIRMED). An explicit unit
   * that the check contradicts throws instead of storing wrong volumes.
   */
  volumeUnit?: VolumeUnit | 'auto';
  /** Throws when the file's `TradDt` differs. */
  expectedDate?: string;
  /** Keep only these underlyings (TckrSymb, case-insensitive). */
  symbols?: Iterable<string>;
  /** Label used in error messages. */
  file?: string;
}

const UDIFF_FO_REQUIRED = ['TradDt', 'FinInstrmTp', 'TckrSymb', 'XpryDt', 'StrkPric', 'OptnTp', 'ClsPric', 'OpnIntrst', 'TtlTradgVol'] as const;
const UDIFF_CM_REQUIRED = ['TradDt', 'TckrSymb', 'SctySrs', 'OpnPric', 'HghPric', 'LwPric', 'ClsPric'] as const;
const FO_TYPES = new Set<FoInstrument>(['IDO', 'STO', 'IDF', 'STF']);
const DOCUMENTED_UNIT: Record<Exchange, VolumeUnit> = { NSE: 'contracts', BSE: 'units' };

/* ------------------------------------------------------------------------------------------ */
/* F&O                                                                                          */
/* ------------------------------------------------------------------------------------------ */

interface RawFoRow {
  instrument: FoInstrument;
  symbol: string;
  expiry: string;
  strike?: number;
  type?: OptKind;
  close: number;
  settleRaw?: number;
  oi: number;
  oiChange?: number;
  vol: number;
  lot?: number;
  meta: Omit<BhavRowMeta, 'symbol' | 'exchange' | 'instrument' | 'expiryDay' | 'contracts' | 'lotSize'>;
  underlying?: number;
}

const pos = (v: number | undefined): number | undefined => (v !== undefined && v > 0 ? v : undefined);

/** Parse a UDiFF F&O bhavcopy (NSE or BSE). */
export function parseFoUdiff(text: string, opts: FoParseOptions): FoBhavcopy {
  const exchange = opts.exchange;
  const file = opts.file ?? `${exchange} F&O bhavcopy`;
  const records = csvRecords(text);
  const t = new CsvTable(records, 0, file, UDIFF_FO_REQUIRED);
  const only = opts.symbols ? new Set([...opts.symbols].map((s) => s.toUpperCase())) : undefined;
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => (skipped[reason] = (skipped[reason] ?? 0) + 1);

  let date: string | undefined;
  const raw: RawFoRow[] = [];
  for (const r of t.rows) {
    const instrument = t.str(r, 'FinInstrmTp')?.toUpperCase() as FoInstrument | undefined;
    if (!instrument || !FO_TYPES.has(instrument)) {
      skip('unknown FinInstrmTp');
      continue;
    }
    const src = t.str(r, 'Src')?.toUpperCase();
    if (src && src !== exchange) {
      skip(`Src is not ${exchange}`);
      continue;
    }
    const d = parseDate(t.str(r, 'TradDt'));
    if (!d) {
      skip('bad TradDt');
      continue;
    }
    date ??= d;
    if (d !== date) {
      skip('TradDt differs from the file date');
      continue;
    }
    const symbol = t.str(r, 'TckrSymb')?.toUpperCase();
    if (!symbol) {
      skip('missing TckrSymb');
      continue;
    }
    if (only && !only.has(symbol)) continue;
    // Actual expiry when present (differs only after a holiday shift, §2 UNCONFIRMED); Kotak lists actual dates.
    const expiry = parseDate(t.str(r, 'FininstrmActlXpryDt')) ?? parseDate(t.str(r, 'XpryDt'));
    if (!expiry) {
      skip('bad expiry');
      continue;
    }
    const isOpt = instrument === 'IDO' || instrument === 'STO';
    let strike: number | undefined;
    let type: OptKind | undefined;
    if (isOpt) {
      strike = pos(t.num(r, 'StrkPric'));
      const ot = t.str(r, 'OptnTp')?.toUpperCase();
      type = ot === 'CE' || ot === 'PE' ? ot : undefined;
      if (strike === undefined || type === undefined) {
        skip('option without strike/type');
        continue;
      }
    }
    const close = pos(t.num(r, 'ClsPric'));
    if (close === undefined) {
      skip('no close price');
      continue;
    }
    const oi = t.num(r, 'OpnIntrst');
    const vol = t.num(r, 'TtlTradgVol');
    if (oi === undefined || oi < 0 || vol === undefined || vol < 0) {
      skip('missing OI or volume');
      continue;
    }
    const tradesRaw = t.num(r, 'TtlNbOfTxsExctd');
    raw.push({
      instrument,
      symbol,
      expiry,
      strike,
      type,
      close,
      settleRaw: pos(t.num(r, 'SttlmPric')),
      oi,
      oiChange: t.num(r, 'ChngInOpnIntrst'),
      vol,
      lot: pos(t.num(r, 'NewBrdLotQty')),
      underlying: pos(t.num(r, 'UndrlygPric')),
      meta: {
        trades: tradesRaw !== undefined && tradesRaw >= 0 ? tradesRaw : undefined,
        open: pos(t.num(r, 'OpnPric')),
        high: pos(t.num(r, 'HghPric')),
        low: pos(t.num(r, 'LwPric')),
        last: pos(t.num(r, 'LastPric')),
        prevClose: pos(t.num(r, 'PrvsClsgPric')),
        turnover: pos(t.num(r, 'TtlTrfVal')),
        token: t.str(r, 'FinInstrmId'),
        tradingSymbol: t.str(r, 'FinInstrmNm'),
      },
    });
  }

  if (!date) throw new NseError(`${file}: no usable data rows`, 'format');
  if (opts.expectedDate && date !== opts.expectedDate) {
    throw new NseError(`${file}: file is dated ${date}, expected ${opts.expectedDate}`, 'format');
  }

  const volumeUnitCheck = checkVolumeUnit(
    raw.map((x) => ({ volume: x.vol, lot: x.lot, turnover: x.meta.turnover, price: x.strike !== undefined ? x.strike + x.close : x.close })),
  );
  const wanted = opts.volumeUnit ?? 'auto';
  let volumeUnit: VolumeUnit;
  if (wanted === 'auto') {
    volumeUnit = volumeUnitCheck.verdict === 'inconclusive' ? DOCUMENTED_UNIT[exchange] : volumeUnitCheck.verdict;
  } else {
    if (volumeUnitCheck.verdict !== 'inconclusive' && volumeUnitCheck.verdict !== wanted) {
      throw new NseError(`${file}: TtlTradgVol looks like ${volumeUnitCheck.verdict} (turnover check), not ${wanted}`, 'format');
    }
    volumeUnit = wanted;
  }
  // Contracts → units needs the per-row lot size; without the column every traded row would be dropped
  // and only untraded rows returned (a silently biased file).
  if (volumeUnit === 'contracts' && !t.has('NewBrdLotQty')) {
    throw new NseError(`${file}: required column "NewBrdLotQty" is missing (TtlTradgVol is in contracts)`, 'format');
  }

  const options: BhavOption[] = [];
  const futures: BhavFuture[] = [];
  const settleVotes = new Map<string, { symbol: string; expiry: string; values: Set<number> }>();
  for (const x of raw) {
    const expiryDay = x.expiry === date;
    // Expiry-day SttlmPric of an expiring contract is the underlying's final settlement price (§2, §9).
    if (expiryDay && x.settleRaw !== undefined) {
      const k = `${x.symbol}|${x.expiry}`;
      let v = settleVotes.get(k);
      if (!v) settleVotes.set(k, (v = { symbol: x.symbol, expiry: x.expiry, values: new Set() }));
      v.values.add(x.settleRaw);
    }
    let volume: number;
    let contracts: number | undefined;
    if (volumeUnit === 'contracts') {
      contracts = x.vol;
      if (x.vol === 0) volume = 0;
      else if (x.lot !== undefined) volume = x.vol * x.lot;
      else {
        skip('volume in contracts without lot size');
        continue;
      }
    } else {
      volume = x.vol;
      contracts = x.lot !== undefined && x.vol % x.lot === 0 ? x.vol / x.lot : undefined;
    }
    const meta: BhavRowMeta = { ...x.meta, symbol: x.symbol, exchange, instrument: x.instrument, lotSize: x.lot, contracts, expiryDay };
    if (x.type !== undefined && x.strike !== undefined) {
      // On its expiry day an option's SttlmPric is the underlying's price, not a premium; and a close
      // equal to it (seen on BSE, §9 "Expiry-day quirk") is not a premium either.
      if (expiryDay && x.settleRaw !== undefined && x.close === x.settleRaw) {
        skip('expiry-day close equals the underlying settlement');
        continue;
      }
      options.push({
        date,
        expiry: x.expiry,
        strike: x.strike,
        type: x.type,
        close: x.close,
        settle: expiryDay ? undefined : x.settleRaw,
        oi: x.oi,
        oiChange: x.oiChange,
        volume,
        underlying: x.underlying,
        ...meta,
      });
    } else {
      futures.push({ date, expiry: x.expiry, close: x.close, settle: x.settleRaw, oi: x.oi, oiChange: x.oiChange, volume, underlying: x.underlying, ...meta });
    }
  }

  const finalSettlements: FinalSettlement[] = [];
  for (const v of settleVotes.values()) {
    if (v.values.size === 1) finalSettlements.push({ symbol: v.symbol, expiry: v.expiry, price: [...v.values][0] });
    else skip('conflicting expiry-day settlement prices');
  }

  return { exchange, date, options, futures, finalSettlements, volumeUnit, volumeUnitCheck, skipped };
}

/**
 * Infers the unit of `TtlTradgVol` from `TtlTrfVal` ≈ volume × price (× lot for contracts), with
 * price = strike + premium for options (§2: NSE turnover is notional). Rows need lot ≥ 2.
 */
export function checkVolumeUnit(samples: Iterable<{ volume: number; lot?: number; turnover?: number; price: number }>): VolumeUnitCheck {
  let contractsVotes = 0;
  let unitsVotes = 0;
  for (const s of samples) {
    if (!(s.volume > 0 && s.lot !== undefined && s.lot >= 2 && s.turnover !== undefined && s.turnover > 0 && s.price > 0)) continue;
    const ratio = s.turnover / (s.volume * s.price);
    if (Math.abs(ratio / s.lot - 1) <= 0.25) contractsVotes++;
    else if (Math.abs(ratio - 1) <= 0.25) unitsVotes++;
  }
  const n = contractsVotes + unitsVotes;
  let verdict: VolumeUnitCheck['verdict'] = 'inconclusive';
  if (n > 0 && contractsVotes >= 0.9 * n) verdict = 'contracts';
  else if (n > 0 && unitsVotes >= 0.9 * n) verdict = 'units';
  return { verdict, contractsVotes, unitsVotes };
}

/** Underlying closes per symbol from `UndrlygPric` (SENSEX/BANKEX close on BSE, §9); symbols whose rows disagree are left out. */
export function underlyingCloses(file: Pick<FoBhavcopy, 'options' | 'futures'>): Map<string, number> {
  const seen = new Map<string, Set<number>>();
  for (const r of [...file.options, ...file.futures]) {
    const u = r.underlying;
    if (u === undefined) continue;
    let s = seen.get(r.symbol);
    if (!s) seen.set(r.symbol, (s = new Set()));
    s.add(u);
  }
  const out = new Map<string, number>();
  for (const [sym, s] of seen) if (s.size === 1) out.set(sym, [...s][0]);
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* Settlement lookup                                                                            */
/* ------------------------------------------------------------------------------------------ */

export interface SettlementLookup {
  /** Final settlement price of the underlying for one expiry (PROVISIONAL, critic U13). */
  underlying(symbol: string, expiry: string): number | undefined;
  /** Settlement value of an expired contract: FUT → final settlement price; CE/PE → intrinsic value at it. */
  settlement(key: InstrumentKey): number | undefined;
  readonly size: number;
}

/**
 * Builds the lookup from expiry-day bhavcopies. PROVISIONAL (critic U13): the expiry-day `SttlmPric`
 * reading is inferred from samples; stock F&O is physically settled, so stock values are the paper
 * cash equivalent only. Two files that disagree on one (symbol, expiry) leave it undefined.
 */
export function buildSettlementLookup(files: Iterable<Pick<FoBhavcopy, 'finalSettlements'>>): SettlementLookup {
  const prices = new Map<string, number>();
  const conflicts = new Set<string>();
  for (const f of files) {
    for (const s of f.finalSettlements) {
      const k = `${s.symbol.toUpperCase()}|${s.expiry}`;
      if (conflicts.has(k)) continue;
      const prev = prices.get(k);
      if (prev !== undefined && prev !== s.price) {
        prices.delete(k);
        conflicts.add(k);
      } else prices.set(k, s.price);
    }
  }
  const underlying = (symbol: string, expiry: string) => prices.get(`${symbol.toUpperCase()}|${expiry}`);
  return {
    underlying,
    settlement(key) {
      if (!key.expiry || key.kind === 'SPOT') return undefined;
      const s = underlying(key.symbol, key.expiry);
      if (s === undefined) return undefined;
      if (key.kind === 'FUT') return s;
      if (key.strike === undefined || !Number.isFinite(key.strike)) return undefined;
      const intrinsic = key.kind === 'CE' ? s - key.strike : key.strike - s;
      return Math.round(Math.max(0, intrinsic) * 100) / 100;
    },
    get size() {
      return prices.size;
    },
  };
}

/* ------------------------------------------------------------------------------------------ */
/* Cash market                                                                                  */
/* ------------------------------------------------------------------------------------------ */

export interface CmBar extends DailyBar {
  symbol: string;
  series: string;
  isin?: string;
  prevClose?: number;
  last?: number;
  trades?: number;
}

export interface CmBhavcopy {
  date: string;
  /** volume = `TtlTradgVol` (shares), turnover = `TtlTrfVal` (₹), as in the legacy TOTTRDQTY/TOTTRDVAL. */
  bars: CmBar[];
  skipped: Record<string, number>;
}

export interface CmParseOptions {
  expectedDate?: string;
  /** Series to keep (default EQ; F&O stocks trade in EQ). */
  series?: Iterable<string>;
  symbols?: Iterable<string>;
  file?: string;
}

/** Parse the NSE CM UDiFF bhavcopy (critic R10). Untraded rows (OHLC 0.00) are skipped, never filled. */
export function parseCmUdiff(text: string, opts: CmParseOptions = {}): CmBhavcopy {
  const file = opts.file ?? 'NSE CM bhavcopy';
  const t = new CsvTable(csvRecords(text), 0, file, UDIFF_CM_REQUIRED);
  const series = new Set([...(opts.series ?? ['EQ'])].map((s) => s.toUpperCase()));
  const only = opts.symbols ? new Set([...opts.symbols].map((s) => s.toUpperCase())) : undefined;
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => (skipped[reason] = (skipped[reason] ?? 0) + 1);
  const seen = new Set<string>();
  const bars: CmBar[] = [];
  let date: string | undefined;
  for (const r of t.rows) {
    const d = parseDate(t.str(r, 'TradDt'));
    if (!d) {
      skip('bad TradDt');
      continue;
    }
    date ??= d;
    if (d !== date) {
      skip('TradDt differs from the file date');
      continue;
    }
    const sgmt = t.str(r, 'Sgmt')?.toUpperCase();
    if (sgmt && sgmt !== 'CM') {
      skip('Sgmt is not CM');
      continue;
    }
    const ser = t.str(r, 'SctySrs')?.toUpperCase();
    const symbol = t.str(r, 'TckrSymb')?.toUpperCase();
    if (!symbol || !ser || !series.has(ser)) continue;
    if (only && !only.has(symbol)) continue;
    const open = pos(t.num(r, 'OpnPric'));
    const high = pos(t.num(r, 'HghPric'));
    const low = pos(t.num(r, 'LwPric'));
    const close = pos(t.num(r, 'ClsPric'));
    if (open === undefined || high === undefined || low === undefined || close === undefined) {
      skip('untraded or missing OHLC');
      continue;
    }
    const key = `${symbol}|${ser}`;
    if (seen.has(key)) {
      skip('duplicate symbol/series');
      continue;
    }
    seen.add(key);
    const vol = t.num(r, 'TtlTradgVol');
    const trades = t.num(r, 'TtlNbOfTxsExctd');
    bars.push({
      date,
      open,
      high,
      low,
      close,
      volume: vol !== undefined && vol >= 0 ? vol : undefined,
      turnover: pos(t.num(r, 'TtlTrfVal')),
      symbol,
      series: ser,
      isin: t.str(r, 'ISIN'),
      prevClose: pos(t.num(r, 'PrvsClsgPric')),
      last: pos(t.num(r, 'LastPric')),
      trades: trades !== undefined && trades >= 0 ? trades : undefined,
    });
  }
  if (!date) throw new NseError(`${file}: no usable data rows`, 'format');
  if (opts.expectedDate && date !== opts.expectedDate) {
    throw new NseError(`${file}: file is dated ${date}, expected ${opts.expectedDate}`, 'format');
  }
  return { date, bars, skipped };
}

/* ------------------------------------------------------------------------------------------ */
/* Fetchers                                                                                     */
/* ------------------------------------------------------------------------------------------ */

function requireUdiff(date: string, what: string): void {
  if (assertYmd(date) < NSE_UDIFF_START) {
    throw new NseError(`${what} for ${date}: the legacy (pre-${NSE_UDIFF_START}) bhavcopy format is not supported`, 'unsupported');
  }
}

/** NSE F&O bhavcopy of a date (zip; published ≈18:00–22:00 IST, §2). 404 → not-published. */
export async function fetchNseFoBhavcopy(http: NseHttp, date: string, opts: Omit<FoParseOptions, 'exchange' | 'expectedDate' | 'file'> = {}): Promise<Published<FoBhavcopy>> {
  requireUdiff(date, 'NSE F&O bhavcopy');
  const res = await http.getCsv({ url: nseFoBhavcopyUrl(date), zipped: true, entry: /BhavCopy_NSE_FO_.*\.csv$/i, header: 'TradDt' });
  if (res.status !== 'ok') return res;
  return { status: 'ok', url: res.url, data: parseFoUdiff(res.data, { ...opts, exchange: 'NSE', expectedDate: date, file: `NSE F&O bhavcopy ${date}` }) };
}

/** NSE CM (equities) bhavcopy of a date (zip, critic R10). 404 → not-published. */
export async function fetchNseCmBhavcopy(http: NseHttp, date: string, opts: Omit<CmParseOptions, 'expectedDate' | 'file'> = {}): Promise<Published<CmBhavcopy>> {
  requireUdiff(date, 'NSE CM bhavcopy');
  const res = await http.getCsv({ url: nseCmBhavcopyUrl(date), zipped: true, entry: /BhavCopy_NSE_CM_.*\.csv$/i, header: 'TradDt' });
  if (res.status !== 'ok') return res;
  return { status: 'ok', url: res.url, data: parseCmUdiff(res.data, { ...opts, expectedDate: date, file: `NSE CM bhavcopy ${date}` }) };
}

/** BSE F&O bhavcopy of a date (plain CSV, §9; SENSEX/BANKEX). 404 → not-published. */
export async function fetchBseFoBhavcopy(http: NseHttp, date: string, opts: Omit<FoParseOptions, 'exchange' | 'expectedDate' | 'file'> = {}): Promise<Published<FoBhavcopy>> {
  assertYmd(date);
  const res = await http.getCsv({ url: bseFoBhavcopyUrl(date), header: 'TradDt', hostFallback: false });
  if (res.status !== 'ok') return res;
  return { status: 'ok', url: res.url, data: parseFoUdiff(res.data, { ...opts, exchange: 'BSE', expectedDate: date, file: `BSE F&O bhavcopy ${date}` }) };
}
