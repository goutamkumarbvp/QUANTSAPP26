import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bsPrice, YEAR_MS } from '@q26/core';
import { McxService, mcxMarket, parseMcxMaster } from '../../src/live/kotak/mcx';
import type { KotakQuote, KotakRest, QuotesResult } from '../../src/live/kotak/rest';
import { NoLiveData } from '../../src/live/types';

// Synthetic test data in the layout of Kotak's mcx_fo instrument file (not real contracts or prices).
const HEADER = 'pSymbol,pGroup,pExchSeg,pInstType,pSymbolName,pTrdSymbol,pOptionType,pScripRefKey,lExpiryDate ,dStrikePrice;,lLotSize,dTickSize ,pSegment';
const TODAY = '2026-10-26';
const epoch = (d: string) => String(Date.parse(`${d}T23:59:59+05:30`) / 1000);
const FUT_EXP = '2026-11-19';
const OPT_EXP = '2026-11-16';
const NOW = Date.parse(`${TODAY}T20:00:00+05:30`); // Monday evening: MCX open

function row(token: number, inst: string, trd: string, opt: string, exp: string, strikeRaw: string, lot = 100) {
  return `${token},,mcx_fo,${inst},CRUDEOIL,${trd},${opt},${trd},${epoch(exp)},${strikeRaw},${lot},100,FO`;
}

function master(scale = 100, strikes = [5300, 5400, 5500, 5600, 5700]) {
  const lines = [HEADER, row(1, 'FUTCOM', 'CRUDEOIL26NOVFUT', 'XX', FUT_EXP, '-1'), row(2, 'FUTCOM', 'CRUDEOIL26OCTFUT', 'XX', '2026-10-19', '-1')];
  let t = 100;
  for (const k of strikes) {
    lines.push(row(t++, 'OPTFUT', `CRUDEOIL26NOV${k}CE`, 'CE', OPT_EXP, String(k * scale)));
    lines.push(row(t++, 'OPTFUT', `CRUDEOIL26NOV${k}PE`, 'PE', OPT_EXP, String(k * scale)));
  }
  return lines.join('\n') + '\n';
}

describe('MCX instrument master', () => {
  it('reads commodity futures and options; strikes in paise checked against the trading symbols; expired contracts dropped', () => {
    const m = parseMcxMaster(master(), TODAY);
    const cm = m.commodities.get('CRUDEOIL')!;
    expect([...cm.futures.keys()]).toEqual([FUT_EXP]); // the October future has expired
    expect([...cm.options.get(OPT_EXP)!.keys()]).toEqual([5300, 5400, 5500, 5600, 5700]);
    expect(cm.options.get(OPT_EXP)!.get(5500)!.CE!.tradingSymbol).toBe('CRUDEOIL26NOV5500CE');
    expect(cm.lotSize).toBe(100);
  });

  it('detects strikes sent in rupees, and refuses strikes that match no scale', () => {
    expect([...parseMcxMaster(master(1), TODAY).commodities.get('CRUDEOIL')!.options.get(OPT_EXP)!.keys()]).toContain(5500);
    const wrong = master().replace(/CRUDEOIL26NOV(\d+)(CE|PE)/g, (_m, k: string, t: string) => `CRUDEOIL26NOV${Number(k) + 50}${t}`);
    expect(() => parseMcxMaster(wrong, TODAY)).toThrow(/strikes do not match the trading symbols/);
  });

  it('refuses a file without the columns it needs', () => {
    expect(() => parseMcxMaster('pSymbol,pExchSeg\n1,mcx_fo\n', TODAY)).toThrow(/missing columns/);
  });
});

describe('MCX market hours', () => {
  it('weekdays 09:00 to 23:30 (23:55 Nov–Mar) IST', () => {
    expect(mcxMarket(Date.parse('2026-10-26T20:00:00+05:30')).open).toBe(true);
    expect(mcxMarket(Date.parse('2026-10-26T23:40:00+05:30')).open).toBe(false);
    expect(mcxMarket(Date.parse('2026-11-23T23:40:00+05:30')).open).toBe(true);
    expect(mcxMarket(Date.parse('2026-10-25T12:00:00+05:30')).open).toBe(false); // Sunday
  });
});

const R = 0.065;
const T = (Date.parse(`${OPT_EXP}T23:30:00+05:30`) - NOW) / YEAR_MS;

function fakeRest(prices: { fut?: number; vol?: number; oi?: (k: number, kind: 'CE' | 'PE') => number; fail?: boolean } = {}) {
  const calls: string[][] = [];
  const m = parseMcxMaster(master(), TODAY);
  const legs = new Map<string, { k: number; kind: 'CE' | 'PE' }>();
  for (const [k, l] of m.commodities.get('CRUDEOIL')!.options.get(OPT_EXP)!) {
    legs.set(l.CE!.token, { k, kind: 'CE' });
    legs.set(l.PE!.token, { k, kind: 'PE' });
  }
  const rest = {
    quotes: async (syms: string[]): Promise<QuotesResult> => {
      calls.push(syms);
      const quotes = new Map<string, KotakQuote>();
      if (prices.fail && syms.length > 1) return { quotes, errors: [{ neosymbols: syms, error: 'HTTP 500' }] };
      for (const s of syms) {
        const token = s.split('|')[1];
        const base = { neosymbol: s, segment: 'mcx_fo', token, ts: NOW - 1000 };
        if (token === '1') {
          if (prices.fut !== undefined) quotes.set(s, { ...base, ltp: prices.fut, changePct: 1.2 });
          continue;
        }
        const l = legs.get(token)!;
        const ltp = Math.round(bsPrice(l.kind, prices.fut!, l.k, T, R, prices.vol ?? 0.4, R) * 100) / 100;
        quotes.set(s, { ...base, ltp, oi: prices.oi?.(l.k, l.kind) ?? 1000, volume: 50, depth: { bids: [{ price: ltp - 0.5, qty: 1, orders: 1 }], asks: [{ price: ltp + 0.5, qty: 1, orders: 1 }] } });
      }
      return { quotes, errors: [] };
    },
  } as unknown as KotakRest;
  return { rest, calls };
}

let dir = '';
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function service(rest: KotakRest | null, over: Partial<ConstructorParameters<typeof McxService>[0]> = {}) {
  let downloads = 0;
  const svc = new McxService({
    dataDir: null,
    rest,
    now: () => NOW,
    r: R,
    filePaths: async () => ['https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/2026-10-26/transformed/mcx_fo.csv'],
    fetch: async () => {
      downloads++;
      return new Response(master());
    },
    ...over,
  });
  return { svc, downloads: () => downloads };
}

describe('MCX option chain', () => {
  it('prices the options on the future they settle into (Black-76 IV recovered), with ATM, PCR and max pain', async () => {
    const { rest, calls } = fakeRest({ fut: 5480, vol: 0.4, oi: (k, kind) => (kind === 'CE' ? (k >= 5600 ? 5000 : 1000) : k <= 5400 ? 4000 : 1000) });
    const { svc } = service(rest);
    const c = await svc.chain('crudeoil');
    expect(c).toMatchObject({ symbol: 'CRUDEOIL', expiry: OPT_EXP, expiries: [OPT_EXP], lotSize: 100, atmStrike: 5500, masterDate: TODAY, market: { open: true } });
    expect(c.future).toMatchObject({ expiry: FUT_EXP, tradingSymbol: 'CRUDEOIL26NOVFUT', ltp: 5480, changePct: 1.2 });
    expect(c.rows.map((r) => r.strike)).toEqual([5300, 5400, 5500, 5600, 5700]);
    const atm = c.rows.find((r) => r.strike === 5500)!;
    expect(atm.ce!.iv!).toBeCloseTo(0.4, 2);
    expect(atm.pe!.iv!).toBeCloseTo(0.4, 2);
    expect(atm.ce!.delta!).toBeGreaterThan(0.3);
    expect(atm.pe!.delta!).toBeLessThan(0);
    expect(atm.ce!.bid).toBe(atm.ce!.ltp! - 0.5);
    expect(c.totals).toEqual({ ceOi: 13_000, peOi: 11_000, pcr: 11_000 / 13_000 });
    expect(c.maxPain).toBe(5500);
    expect(c.asOf).toBe(NOW - 1000);
    expect(c.gaps).toEqual([]);
    // One call for the future, one for the legs; a poll within 3 s reuses the answer.
    expect(calls.map((x) => x.length)).toEqual([1, 10]);
    await svc.chain('CRUDEOIL');
    expect(calls).toHaveLength(2);
  });

  it('no live future price → no chain, with the reason (never a made-up price)', async () => {
    const { svc } = service(fakeRest({}).rest);
    await expect(svc.chain('CRUDEOIL')).rejects.toThrow(NoLiveData);
    await expect(svc.chain('CRUDEOIL')).rejects.toThrow(/No live price for CRUDEOIL26NOVFUT/);
  });

  it('a future price that does not fit the strikes (unit mismatch) is refused', async () => {
    const { svc } = service(fakeRest({ fut: 548_000 }).rest);
    await expect(svc.chain('CRUDEOIL')).rejects.toThrow(/price unit mismatch/);
  });

  it('failed option quotes leave the legs blank and say why', async () => {
    const { svc } = service(fakeRest({ fut: 5480, fail: true }).rest);
    const c = await svc.chain('CRUDEOIL');
    expect(c.rows[0].ce).toMatchObject({ ltp: null, oi: null, iv: null });
    expect(c.gaps[0]).toMatch(/10 of 10 option quotes failed: HTTP 500/);
    expect(c.maxPain).toBeNull();
    expect(c.totals.pcr).toBeNull();
  });

  it('without Kotak, or for an unknown commodity / expiry, says so', async () => {
    await expect(service(null, { restUnavailable: 'Kotak credentials missing in .env' }).svc.chain('CRUDEOIL')).rejects.toThrow(/credentials missing/);
    const { svc } = service(fakeRest({ fut: 5480 }).rest);
    await expect(svc.chain('GOLD')).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.chain('CRUDEOIL', '2026-12-15')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lists the commodities; the downloaded file is cached for the day', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q26-mcx-'));
    const a = service(fakeRest({ fut: 5480 }).rest, { dataDir: dir });
    expect(await a.svc.symbols()).toEqual({ masterDate: TODAY, symbols: [{ symbol: 'CRUDEOIL', lotSize: 100, optionExpiries: [OPT_EXP], futureExpiries: [FUT_EXP] }], warnings: [] });
    expect(a.downloads()).toBe(1);
    expect(fs.existsSync(path.join(dir, 'refdata-mcx', `${TODAY}.csv`))).toBe(true);
    const b = service(fakeRest({ fut: 5480 }).rest, { dataDir: dir });
    await b.svc.symbols();
    expect(b.downloads()).toBe(0);
  });

  it('no mcx_fo file listed by Kotak → unavailable with the reason', async () => {
    const { svc } = service(fakeRest({ fut: 5480 }).rest, { filePaths: async () => ['https://x/prod/2026-10-26/transformed/nse_fo.csv'] });
    await expect(svc.symbols()).rejects.toThrow(/MCX contracts unavailable: Kotak lists no mcx_fo instrument file today/);
  });
});
