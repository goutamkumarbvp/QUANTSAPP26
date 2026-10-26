import { describe, expect, it } from 'vitest';
import { bsPrice, mcxCloseMin, YEAR_MS } from '@q26/core';
import { ExchangeCalendar } from '../../src/live/calendar';
import { MCX_CONTRACTS, parseMcxMaster, underlyingFuture } from '../../src/live/kotak/mcx';
import { buildOptionChain, underlyingQuote } from '../../src/services/live';
import { FakeProvider } from '../support/fake-provider';

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

describe('MCX contract units', () => {
  it('units per lot follow MCX specifications when the file agrees in any reading, else the specification with a warning', () => {
    // CRUDEOIL: the file says lot 100 (agrees).
    expect(parseMcxMaster(master(), TODAY).commodities.get('CRUDEOIL')!.lotSize).toBe(100);
    // A file giving lot 1 (one lot) for CRUDEOIL: MCX's 100 barrels per lot is used, with a warning.
    const one = parseMcxMaster(master().replace(/,100,100,FO/g, ',1,100,FO'), TODAY);
    expect(one.commodities.get('CRUDEOIL')!.lotSize).toBe(100);
    expect(one.warnings.join(' ')).toMatch(/MCX specifies 100 barrel per lot/);
    // Every contract of the commodity carries the checked units per lot.
    const cm = one.commodities.get('CRUDEOIL')!;
    expect(cm.futures.get(FUT_EXP)!.lotSize).toBe(100);
    expect(cm.options.get(OPT_EXP)!.get(5500)!.PE!.lotSize).toBe(100);
    expect(MCX_CONTRACTS.GOLD.unitsPerLot).toBe(100); // 1 kg quoted per 10 g
  });

  it('an option expiry settles into the nearest future expiring on or after it', () => {
    const cm = parseMcxMaster(master(), TODAY).commodities.get('CRUDEOIL')!;
    expect(underlyingFuture(cm, OPT_EXP).expiry).toBe(FUT_EXP);
  });
});

describe('MCX sessions', () => {
  const cal = new ExchangeCalendar([], 'MCX');
  const at = (d: string, hm: string) => Date.parse(`${d}T${hm}:00+05:30`);
  it('09:00 to 23:30 while the US is on daylight time, 23:55 on US standard time', () => {
    expect(mcxCloseMin('2026-10-26')).toBe(23 * 60 + 30);
    expect(mcxCloseMin('2026-11-02')).toBe(23 * 60 + 55); // after the US switch (1 Nov 2026)
    expect(mcxCloseMin('2026-03-02')).toBe(23 * 60 + 55);
    expect(mcxCloseMin('2026-03-09')).toBe(23 * 60 + 30); // after 8 Mar 2026
    expect(cal.session(at('2026-10-26', '20:00')).status).toBe('open');
    expect(cal.session(at('2026-10-26', '08:50')).status).toBe('pre-open');
    expect(cal.session(at('2026-10-26', '23:40')).status).toBe('closed');
    expect(cal.session(at('2026-11-23', '23:40')).status).toBe('open');
    expect(cal.session(at('2026-10-25', '12:00')).status).toBe('closed'); // Sunday
    expect(cal.sessionMinutes('2026-10-26')).toBe(870);
    expect(cal.ts('2026-10-26', 0)).toBe(at('2026-10-26', '09:00'));
    expect(cal.expiryTs('2026-11-16')).toBe(at('2026-11-16', '23:55'));
  });
});

describe('MCX commodity as an ordinary underlying', () => {
  const R = 0.065;
  function provider() {
    const p = new FakeProvider({ now: Date.parse('2026-10-26T20:00:00+05:30'), r: R }); // Monday 20:00: NSE closed, MCX open
    p.ref.setUnderlying({ symbol: 'CRUDEOIL', kind: 'commodity', lotSize: 100, strikeStep: 50, name: 'Crude Oil', sector: 'Energy' });
    p.ref.setFutures('CRUDEOIL', ['2026-11-19', '2026-12-18']);
    p.ref.setStrikes('CRUDEOIL', OPT_EXP, [5300, 5400, 5500, 5600, 5700]);
    return p;
  }

  it('the price is the near-month future; the chain is valued at MCX hours on the future it settles into (Black-76)', async () => {
    const p = provider();
    const now = p.now();
    const F = 5480;
    p.setQuote({ symbol: 'CRUDEOIL', kind: 'FUT', expiry: '2026-11-19' }, { ltp: F, prevClose: 5420, volume: 1000, oi: 9000, ts: now - 1000 });
    const T = (Date.parse(`${OPT_EXP}T23:30:00+05:30`) - now) / YEAR_MS; // 16 Nov 2026 is US standard time: 23:55
    const T2 = (Date.parse(`${OPT_EXP}T23:55:00+05:30`) - now) / YEAR_MS;
    expect(T2).toBeGreaterThan(T);
    for (const k of [5300, 5400, 5500, 5600, 5700]) {
      for (const kind of ['CE', 'PE'] as const) {
        const prem = Math.round(bsPrice(kind, F, k, T2, R, 0.4, R) * 100) / 100;
        p.setQuote({ symbol: 'CRUDEOIL', kind, expiry: OPT_EXP, strike: k }, { ltp: prem, volume: 10, oi: 1000 + k, bid: prem - 0.5, ask: prem + 0.5, ts: now - 1000 });
      }
    }
    const q = underlyingQuote(p, 'CRUDEOIL');
    expect(q.ltp).toBe(F);
    expect(q.changePct).toBeCloseTo((F / 5420 - 1) * 100, 1);
    const c = await buildOptionChain(p, 'CRUDEOIL');
    expect(c.spot).toBe(F);
    expect(c.futureExpiry).toBe('2026-11-19');
    expect(c.forward).toBe(F);
    expect(c.forwardSource).toBe('future');
    expect(c.atm).toBe(5500);
    expect(c.atmIv).toBeCloseTo(40, 0);
    expect(c.rows.find((r) => r.strike === 5500)!.ce.iv).toBeCloseTo(40, 0);
    expect(c.lotSize).toBe(100);
  });

  it('previous-session OI comes from the recorded MCX session (blank with the reason when not recorded)', async () => {
    const p = provider();
    const now = p.now();
    const prev = '2026-10-23'; // Friday
    const at = Date.parse(`${prev}T23:20:00+05:30`); // MCX evening, recorded
    p.intraday.addMinutes({ symbol: 'CRUDEOIL', kind: 'CE', expiry: OPT_EXP, strike: 5500 }, [{ ts: at, open: 150, high: 150, low: 150, close: 150, traded: true, volume: 5, oi: 800 }]);
    p.setQuote({ symbol: 'CRUDEOIL', kind: 'FUT', expiry: '2026-11-19' }, { ltp: 5480, volume: 1000, ts: now - 1000 });
    p.setQuote({ symbol: 'CRUDEOIL', kind: 'CE', expiry: OPT_EXP, strike: 5500 }, { ltp: 160, volume: 10, oi: 1100, ts: now - 1000 });
    p.setQuote({ symbol: 'CRUDEOIL', kind: 'PE', expiry: OPT_EXP, strike: 5500 }, { ltp: 170, volume: 10, oi: 900, ts: now - 1000 });
    const c = await buildOptionChain(p, 'CRUDEOIL');
    const row = c.rows.find((r) => r.strike === 5500)!;
    expect(row.ce.prevOi).toBe(800);
    expect(row.ce.oiChange).toBe(300);
    expect(row.pe.prevOi).toBeNull();
    expect(c.gaps?.oiChange).toMatch(/MCX session was not recorded by this app/);
  });
});
