/**
 * MCX (commodity) option chain from live Kotak data, kept apart from the NSE/BSE universe: MCX trades
 * 09:00–23:30/23:55 IST, its options are written on FUTURES (Black-76), and it has no cash market.
 *
 *  - Contracts: Kotak's mcx_fo instrument master (same CSV layout as nse_fo), downloaded once a day
 *    and cached under <dataDir>/refdata-mcx/<date>.csv. The strike scale and the expiry epoch are not
 *    assumed: they are checked against the trading symbols / the date, and a file that fits neither
 *    is refused (blank chain with the reason, never wrong strikes).
 *  - Prices: Kotak REST quotes, on request (the chain page polls), cached for a few seconds.
 *  - A value Kotak does not send stays null; nothing is filled in.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { bsGreeks, DAY_MS, impliedVol, YEAR_MS, IST_OFFSET_MS, type McxChainResponse, type McxChainRow, type McxLeg, type McxSymbolsResponse } from '@q26/core';
import { NoLiveData } from '../types';
import type { KotakQuote, KotakRest } from './rest';
import { csvRecords, decodeExpiry, fmtStrike, istDate, pickScripFile } from './scripmaster';
import type { FetchLike, KotakLogger } from './session';

export interface McxContract {
  token: string;
  tradingSymbol: string;
  expiry: string;
  lotSize: number;
}

export interface McxCommodity {
  symbol: string;
  lotSize: number;
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

  type Raw = { name: string; token: string; trd: string; kind: 'FUT' | 'CE' | 'PE'; expRaw: string; strikeRaw: number; lot: number };
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
    if (!cm) commodities.set(x.name, (cm = { symbol: x.name, lotSize: x.lot, futures: new Map(), options: new Map() }));
    const contract: McxContract = { token: x.token, tradingSymbol: x.trd, expiry, lotSize: x.lot };
    if (x.kind === 'FUT') {
      cm.futures.set(expiry, contract);
      cm.lotSize = x.lot;
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
  return { date: today, commodities, warnings };
}

/** The futures contract an option expiry settles into: the nearest future expiring on or after it. */
export function underlyingFuture(cm: McxCommodity, optionExpiry: string): McxContract {
  const exps = [...cm.futures.keys()].sort();
  const e = exps.find((x) => x >= optionExpiry) ?? exps[exps.length - 1];
  return cm.futures.get(e)!;
}

/** MCX market hours (approximate: no MCX holiday list): weekdays 09:00–23:30 IST, 23:55 in Nov–Mar (US winter). */
export function mcxMarket(now: number): { open: boolean; note: string } {
  const d = new Date(now + IST_OFFSET_MS);
  const day = d.getUTCDay();
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  const month = d.getUTCMonth() + 1;
  const close = month >= 11 || month <= 3 ? 23 * 60 + 55 : 23 * 60 + 30;
  const open = day >= 1 && day <= 5 && min >= 9 * 60 && min < close;
  const note = `MCX trades 09:00–${close === 23 * 60 + 55 ? '23:55' : '23:30'} IST on weekdays (holidays not checked)`;
  return { open, note };
}

/** Expiry instant: MCX options expire at the session end of the expiry day (23:30 IST is used). */
const expiryInstant = (expiry: string) => Date.parse(`${expiry}T23:30:00+05:30`);

export function maxPainOf(rows: readonly McxChainRow[]): number | null {
  if (!rows.some((r) => (r.ce?.oi ?? 0) > 0 || (r.pe?.oi ?? 0) > 0)) return null;
  let best: { k: number; pain: number } | null = null;
  for (const s of rows) {
    let pain = 0;
    for (const r of rows) {
      pain += (r.ce?.oi ?? 0) * Math.max(0, s.strike - r.strike) + (r.pe?.oi ?? 0) * Math.max(0, r.strike - s.strike);
    }
    if (!best || pain < best.pain) best = { k: s.strike, pain };
  }
  return best!.k;
}

export interface McxServiceOptions {
  dataDir: string | null;
  /** Kotak file-paths API (the instrument-master URLs). */
  filePaths: () => Promise<string[]>;
  fetch?: FetchLike;
  rest: KotakRest | null;
  restUnavailable?: string;
  now?: () => number;
  /** Risk-free rate for Black-76. */
  r: number;
  logger?: KotakLogger;
  /** Strikes each side of the ATM strike (default 15). */
  strikesEachSide?: number;
  /** Chain answers are reused for this long (default 3 s) so polling clients share one quote call. */
  cacheMs?: number;
}

export class McxService {
  private readonly now: () => number;
  private readonly fetchFn: FetchLike;
  private readonly log: KotakLogger;
  private master: { date: string; p: Promise<McxMaster>; failedAt?: number } | null = null;
  private readonly cache = new Map<string, { at: number; p: Promise<McxChainResponse> }>();

  constructor(private readonly opts: McxServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.log = opts.logger ?? { info: () => {}, warn: () => {} };
  }

  /** Today's master; a failed load is retried after 5 minutes. */
  private loadMaster(): Promise<McxMaster> {
    const today = istDate(this.now());
    const m = this.master;
    if (m && m.date === today && !(m.failedAt !== undefined && this.now() - m.failedAt > 5 * 60_000)) return m.p;
    const entry: { date: string; p: Promise<McxMaster>; failedAt?: number } = { date: today, p: Promise.resolve(null as unknown as McxMaster) };
    entry.p = this.readOrDownload(today).catch((e: unknown) => {
      entry.failedAt = this.now();
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn(`MCX: ${msg}`);
      throw new NoLiveData(`MCX contracts unavailable: ${msg}`);
    });
    this.master = entry;
    return entry.p;
  }

  private async readOrDownload(today: string): Promise<McxMaster> {
    const file = this.opts.dataDir ? path.join(this.opts.dataDir, 'refdata-mcx', `${today}.csv`) : null;
    if (file) {
      const cached = await fs.readFile(file, 'utf8').catch(() => null);
      if (cached) {
        try {
          return parseMcxMaster(cached, today);
        } catch {
          // A bad cache is replaced by a fresh download.
        }
      }
    }
    const urls = await this.opts.filePaths();
    const url = pickScripFile(urls, 'mcx_fo');
    if (!url) throw new Error('Kotak lists no mcx_fo instrument file today');
    let text: string;
    try {
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (e) {
      throw new Error(`mcx_fo instrument file download failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const master = parseMcxMaster(text, today);
    if (file) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(`${file}.tmp`, text);
      await fs.rename(`${file}.tmp`, file);
      // Keep the last 3 days only.
      const old = (await fs.readdir(path.dirname(file))).filter((f) => /^\d{4}-\d{2}-\d{2}\.csv$/.test(f)).sort().slice(0, -3);
      await Promise.all(old.map((f) => fs.rm(path.join(path.dirname(file), f), { force: true })));
    }
    const n = [...master.commodities.values()].reduce((s, cm) => s + cm.futures.size + [...cm.options.values()].reduce((a, m) => a + m.size * 2, 0), 0);
    this.log.info(`MCX instrument master ${today}: ${master.commodities.size} commodities with options (about ${n} contracts)`);
    for (const w of master.warnings) this.log.warn(w);
    return master;
  }

  async symbols(): Promise<McxSymbolsResponse> {
    const m = await this.loadMaster();
    const symbols = [...m.commodities.values()]
      .sort((a, b) => a.symbol.localeCompare(b.symbol))
      .map((cm) => ({ symbol: cm.symbol, lotSize: cm.lotSize, optionExpiries: [...cm.options.keys()].sort(), futureExpiries: [...cm.futures.keys()].sort() }));
    return { masterDate: m.date, symbols, warnings: m.warnings };
  }

  chain(symbol: string, expiry?: string): Promise<McxChainResponse> {
    const key = `${symbol.toUpperCase()}|${expiry ?? ''}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < (this.opts.cacheMs ?? 3000)) return hit.p;
    const p = this.buildChain(symbol.toUpperCase(), expiry);
    this.cache.set(key, { at: this.now(), p });
    p.catch(() => this.cache.delete(key));
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    return p;
  }

  private async buildChain(symbol: string, want?: string): Promise<McxChainResponse> {
    const rest = this.opts.rest;
    if (!rest) throw new NoLiveData(this.opts.restUnavailable ?? 'Kotak credentials missing in .env');
    const m = await this.loadMaster();
    const cm = m.commodities.get(symbol);
    if (!cm) throw Object.assign(new Error(`${symbol} has no MCX options today`), { statusCode: 404 });
    const expiries = [...cm.options.keys()].sort();
    const expiry = want ?? expiries[0];
    const byStrike = cm.options.get(expiry);
    if (!byStrike) throw Object.assign(new Error(`${symbol} has no MCX options expiring ${expiry}`), { statusCode: 404 });
    const fut = underlyingFuture(cm, expiry);
    const gaps: string[] = [];

    // 1) The future: its price picks the strikes and prices the options.
    const futQ = await rest.quotes([`mcx_fo|${fut.token}`]);
    const fq = futQ.quotes.get(`mcx_fo|${fut.token}`);
    const F = fq?.ltp;
    if (!F) throw new NoLiveData(`No live price for ${fut.tradingSymbol}${futQ.errors.length ? ` (${futQ.errors[0].error})` : ''}: the chain needs the future it settles into`);

    const strikes = [...byStrike.keys()].sort((a, b) => a - b);
    // Scale check: the future must sit within the listed strikes' range (wide margin), else units differ.
    if (F < strikes[0] / 3 || F > strikes[strikes.length - 1] * 3) {
      throw new NoLiveData(`${fut.tradingSymbol} price ${F} does not fit the listed strikes ${strikes[0]}–${strikes[strikes.length - 1]} (price unit mismatch?): chain not shown`);
    }
    let atmI = 0;
    for (let i = 1; i < strikes.length; i++) if (Math.abs(strikes[i] - F) < Math.abs(strikes[atmI] - F)) atmI = i;
    const n = this.opts.strikesEachSide ?? 15;
    const shown = strikes.slice(Math.max(0, atmI - n), atmI + n + 1);

    // 2) The option legs of the shown strikes.
    const syms: string[] = [];
    for (const k of shown) for (const l of Object.values(byStrike.get(k)!)) if (l) syms.push(`mcx_fo|${l.token}`);
    const res = await rest.quotes(syms);
    if (res.errors.length) gaps.push(`${res.errors.reduce((s, e) => s + e.neosymbols.length, 0)} of ${syms.length} option quotes failed: ${res.errors[0].error}`);

    const now = this.now();
    const T = Math.max(0, (expiryInstant(expiry) - now) / YEAR_MS);
    const r = this.opts.r;
    let ivFailed = 0;
    const strikeIndex = new Map<string, number>();
    for (const k of shown) for (const l of Object.values(byStrike.get(k)!)) if (l) strikeIndex.set(l.token, k);
    const strikeOf = (c: McxContract) => strikeIndex.get(c.token)!;
    const leg = (c: McxContract | undefined, type: 'CE' | 'PE'): McxLeg | null => {
      if (!c) return null;
      const q: KotakQuote | undefined = res.quotes.get(`mcx_fo|${c.token}`);
      const ltp = q?.ltp ?? null;
      // Black-76: Black-Scholes on the future with the carry yield equal to r.
      let iv: number | null = null;
      let delta: number | null = null;
      if (ltp !== null && T > 0) {
        const v = impliedVol(type, ltp, F, strikeOf(c), T, r, r);
        if (Number.isFinite(v)) {
          iv = v;
          delta = bsGreeks(type, F, strikeOf(c), T, r, v, r).delta;
        } else ivFailed++;
      }
      const bid = q?.depth?.bids[0]?.price ?? null;
      const ask = q?.depth?.asks[0]?.price ?? null;
      return {
        token: c.token,
        tradingSymbol: c.tradingSymbol,
        ltp,
        change: q?.change ?? null,
        changePct: q?.changePct ?? null,
        oi: q?.oi ?? null,
        volume: q?.volume ?? null,
        bid,
        ask,
        iv,
        delta,
        ts: q?.ts ?? null,
      };
    };
    const rows: McxChainRow[] = shown.map((k) => {
      const legs = byStrike.get(k)!;
      return { strike: k, ce: leg(legs.CE, 'CE'), pe: leg(legs.PE, 'PE') };
    });
    if (T <= 0) gaps.push('expiry reached: IV and delta are not computed');
    else if (ivFailed) gaps.push(`IV not solvable for ${ivFailed} leg(s) (premium outside the no-arbitrage range)`);
    const ceOi = rows.reduce((s, x) => s + (x.ce?.oi ?? 0), 0);
    const peOi = rows.reduce((s, x) => s + (x.pe?.oi ?? 0), 0);
    const times = [fq?.ts, ...rows.flatMap((x) => [x.ce?.ts, x.pe?.ts])].filter((t): t is number => typeof t === 'number');
    return {
      symbol,
      expiry,
      expiries,
      lotSize: cm.lotSize,
      future: { expiry: fut.expiry, tradingSymbol: fut.tradingSymbol, ltp: F, changePct: fq?.changePct ?? null, ts: fq?.ts ?? null },
      atmStrike: strikes[atmI],
      rows,
      totals: { ceOi, peOi, pcr: ceOi > 0 ? peOi / ceOi : null },
      maxPain: maxPainOf(rows),
      asOf: times.length ? Math.max(...times) : null,
      market: mcxMarket(now),
      masterDate: m.date,
      gaps,
    };
  }
}
