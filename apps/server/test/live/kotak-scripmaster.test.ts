import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NoLiveData } from '../../src/live/types';
import { ScripMaster, csvRecords, decodeExpiry, decodeStrike, folderDate, strikeStepOf, type ScripMasterOptions } from '../../src/live/kotak/scripmaster';
import {
  LEGACY_CM_ROWS,
  LEGACY_FO_ROWS,
  SCRIP_HEADER,
  bseExpiry,
  cmRow,
  fakeFetch,
  filePaths,
  foRow,
  nseExpiry,
  scripCsv,
  type Reply,
} from './kotak-fixtures';

const DATE = '2026-10-12';
/** Real lExpiryDate of the 27-Oct-2026 NIFTY monthly in a 2026 third-party copy of nse_fo.csv. */
const OCT27 = 1477578600;

function niftyWeekly(): string[] {
  const exp = nseExpiry('2026-10-13');
  const rows: string[] = [];
  let tok = 40100;
  for (const k of [24900, 24950, 25000, 25050, 25100]) {
    // Scientific notation as in the official sample ('1.75e+06').
    const raw = k === 25000 ? '2.5e+06' : k === 25050 ? '2.505e+06' : String(k * 100);
    for (const t of ['CE', 'PE'] as const) rows.push(foRow({ token: tok++, inst: 'OPTIDX', name: 'NIFTY', trd: `NIFTY26O13${k}${t}`, opt: t, expiry: exp, strike: raw, lot: 75 }));
  }
  return rows;
}

function nseFo(extra: string[] = []): string {
  return scripCsv([
    // Expired weekly: dropped from listings.
    foRow({ token: 40001, inst: 'OPTIDX', name: 'NIFTY', trd: 'NIFTY26O0625000CE', opt: 'CE', expiry: nseExpiry('2026-10-06'), strike: 2500000, lot: 75 }),
    ...niftyWeekly(),
    foRow({ token: 40200, inst: 'OPTIDX', name: 'NIFTY', trd: 'NIFTY26O2025000CE', opt: 'CE', expiry: nseExpiry('2026-10-20'), strike: 2500000, lot: 75 }),
    foRow({ token: 40201, inst: 'OPTIDX', name: 'NIFTY', trd: 'NIFTY26O2025100CE', opt: 'CE', expiry: nseExpiry('2026-10-20'), strike: 2510000, lot: 75 }),
    foRow({ token: 52011, inst: 'OPTIDX', name: 'NIFTY', trd: 'NIFTY26OCT25000CE', opt: 'CE', expiry: OCT27, strike: 2500000, lot: 75 }),
    foRow({ token: 52012, inst: 'OPTIDX', name: 'NIFTY', trd: 'NIFTY26OCT25000PE', opt: 'PE', expiry: OCT27, strike: 2500000, lot: 75 }),
    foRow({ token: 52010, inst: 'FUTIDX', name: 'NIFTY', trd: 'NIFTY26OCTFUT', opt: 'XX', expiry: OCT27, strike: -1, lot: 75, tick: 10 }),
    // Calendar spread (verbatim from the official sample): two tokens, empty pSegment.
    LEGACY_FO_ROWS[3],
    ...[56000, 56100, 56200].flatMap((k, i) =>
      (['CE', 'PE'] as const).map((t, j) => foRow({ token: 60000 + i * 2 + j, inst: 'OPTIDX', name: 'BANKNIFTY', trd: `BANKNIFTY26OCT${k}${t}`, opt: t, expiry: OCT27, strike: k * 100, lot: 35, freeze: 901 })),
    ),
    foRow({ token: 60100, inst: 'FUTIDX', name: 'BANKNIFTY', trd: 'BANKNIFTY26OCTFUT', opt: 'XX', expiry: OCT27, strike: -1, lot: 35 }),
    ...[1380, 1400, 1420, 1440].map((k, i) => foRow({ token: 70000 + i, inst: 'OPTSTK', name: 'RELIANCE', trd: `RELIANCE26OCT${k}CE`, opt: 'CE', expiry: OCT27, strike: k * 100, lot: 500, freeze: 30001 })),
    foRow({ token: 70100, inst: 'FUTSTK', name: 'RELIANCE', trd: 'RELIANCE26OCTFUT', opt: 'XX', expiry: OCT27, strike: -1, lot: 500 }),
    ...['29000', '29250', '29500'].map((k, i) => foRow({ token: 71000 + i, inst: 'OPTSTK', name: 'VEDL', trd: `VEDL26OCT${Number(k) / 100}CE`, opt: 'CE', expiry: OCT27, strike: k, lot: 1150 })),
    // A stock outside the configured universe: validated, not kept.
    foRow({ token: 72000, inst: 'OPTSTK', name: 'ABB', trd: 'ABB26OCT5000CE', opt: 'CE', expiry: OCT27, strike: 500000, lot: 125 }),
    ...extra,
  ]);
}

const nseCm = () =>
  scripCsv([
    LEGACY_CM_ROWS[0], // 26000 NIFTY index row
    LEGACY_CM_ROWS[2], // 2885 RELIANCE-EQ
    cmRow({ token: 12713, group: 'BL', name: 'RELIANCE', trd: 'RELIANCE-BL', desc: 'RELIANCE INDUSTRIES LTD' }),
    cmRow({ token: 3063, group: 'EQ', name: 'VEDL', trd: 'VEDL-EQ', desc: 'VEDANTA LIMITED', freeze: 120000 }),
    cmRow({ token: 13611, group: 'EQ', name: 'IRCTC', trd: 'IRCTC-EQ', desc: 'INDIAN RAILWAY CATERING' }),
  ]);

function bseFo(expiry = (d: string) => bseExpiry(d)): string {
  return scripCsv([
    ...[81500, 81600, 81700].flatMap((k, i) =>
      (['CE', 'PE'] as const).map((t, j) => foRow({ seg: 'bse_fo', token: 800000 + i * 2 + j, inst: 'OPTIDX', name: 'SENSEX', trd: `SENSEX26O15${k}${t}`, opt: t, expiry: expiry('2026-10-15'), strike: k * 100, lot: 20 })),
    ),
    foRow({ seg: 'bse_fo', token: 800100, inst: 'FUTIDX', name: 'SENSEX', trd: 'SENSEX26OCTFUT', opt: 'XX', expiry: expiry('2026-10-29'), strike: -1, lot: 20 }),
  ]);
}

const bseCm = () => scripCsv([cmRow({ seg: 'bse_cm', token: 500325, group: 'A', name: 'RELIANCE', trd: 'RELIANCE', desc: 'RELIANCE INDUSTRIES LTD.' })]);

/** TEST mcx_fo file: CRUDEOIL futures (Nov, Dec) and Nov options settling into the Nov future. */
function mcxFo(): string {
  const exp = (d: string) => Date.parse(`${d}T18:00:00Z`) / 1000; // plain Unix seconds, 23:30 IST
  return scripCsv([
    foRow({ seg: 'mcx_fo', token: 450001, inst: 'FUTCOM', name: 'CRUDEOIL', trd: 'CRUDEOIL26NOVFUT', opt: 'XX', expiry: exp('2026-11-19'), strike: -1, lot: 100 }),
    foRow({ seg: 'mcx_fo', token: 450002, inst: 'FUTCOM', name: 'CRUDEOIL', trd: 'CRUDEOIL26DECFUT', opt: 'XX', expiry: exp('2026-12-17'), strike: -1, lot: 100 }),
    ...[5400, 5450, 5500, 5550, 5600].flatMap((k, i) =>
      (['CE', 'PE'] as const).map((t, j) => foRow({ seg: 'mcx_fo', token: 451000 + i * 2 + j, inst: 'OPTFUT', name: 'CRUDEOIL', trd: `CRUDEOIL26NOV${k}${t}`, opt: t, expiry: exp('2026-11-16'), strike: k * 100, lot: 100 })),
    ),
  ]);
}

type Files = Partial<Record<'nse_cm' | 'bse_cm' | 'nse_fo' | 'bse_fo' | 'mcx_fo', Reply>>;

function harness(dataDir: string, files: Files, opts: { day?: string; extra?: Partial<ScripMasterOptions> } = {}) {
  const paths = filePaths(opts.day ?? DATE).data.filesPaths;
  let pathCalls = 0;
  const ff = fakeFetch((c) => {
    const seg = (['nse_cm', 'bse_cm', 'nse_fo', 'bse_fo', 'mcx_fo'] as const).find((s) => c.url.includes(`/${s}`));
    if (!seg || c.url.includes('nse_com')) throw new Error(`unexpected download ${c.url}`);
    return files[seg] ?? { status: 404, text: '404: Not Found' };
  });
  const sm = new ScripMaster({
    dataDir,
    fetch: ff.fn,
    filePaths: async () => {
      pathCalls++;
      return paths;
    },
    ...opts.extra,
  });
  return { sm, ff, pathCalls: () => pathCalls };
}

const ALL: Files = { nse_cm: { text: nseCm() }, bse_cm: { text: bseCm() }, nse_fo: { text: nseFo() }, bse_fo: { text: bseFo() }, mcx_fo: { text: mcxFo() } };

let dir = '';
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q26-scrip-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('ScripMaster: MCX commodities', () => {
  it('lists an MCX commodity as an ordinary underlying: spot = near-month future, options on the future they settle into', async () => {
    const { sm } = harness(dir, ALL);
    await sm.refresh(DATE);
    const u = sm.underlying('CRUDEOIL');
    expect(u).toMatchObject({ symbol: 'CRUDEOIL', name: 'Crude Oil', kind: 'commodity', exchange: 'MCX', sector: 'Energy', lotSize: 100, strikeStep: 50 });
    expect(u.spot).toMatchObject({ kind: 'SPOT', segment: 'mcx_fo', token: '450001', expiry: '2026-11-19' });
    expect(sm.expiries('CRUDEOIL', 'OPT')).toEqual(['2026-11-16']);
    expect(sm.expiries('CRUDEOIL', 'FUT')).toEqual(['2026-11-19', '2026-12-17']);
    expect(sm.strikes('CRUDEOIL', '2026-11-16')).toEqual([5400, 5450, 5500, 5550, 5600]);
    expect(sm.underlyingFuture('CRUDEOIL', '2026-11-16')).toBe('2026-11-19');
    expect(sm.underlyingFuture('NIFTY', '2026-10-27')).toBe('2026-10-27');
    expect(sm.quoteKey({ symbol: 'CRUDEOIL', kind: 'SPOT' })).toEqual({ symbol: 'CRUDEOIL', kind: 'FUT', expiry: '2026-11-19' });
    expect(sm.quoteKey({ symbol: 'NIFTY', kind: 'SPOT' })).toEqual({ symbol: 'NIFTY', kind: 'SPOT' });
    // The feed decodes the shared token as the future (never as the spot alias).
    expect(sm.byToken('mcx_fo', '450001')).toMatchObject({ kind: 'FUT', expiry: '2026-11-19' });
    expect(sm.byToken('mcx_fo', '451004')).toMatchObject({ kind: 'CE', strike: 5500 });
    expect(sm.kotakUnderlying('CRUDEOIL')).toEqual({ exchange: 'mcx_fo', underlying: 'CRUDEOIL' });
  });

  it('a bad or missing mcx_fo file leaves MCX out with the reason; NSE/BSE are unaffected', async () => {
    const { sm } = harness(dir, { ...ALL, mcx_fo: { status: 404, text: 'Not Found' } });
    await sm.refresh(DATE);
    expect(sm.underlying('NIFTY').symbol).toBe('NIFTY');
    expect(() => sm.underlying('CRUDEOIL')).toThrow(/Unknown symbol/);
    expect(sm.status().warnings.join(' ')).toMatch(/mcx_fo download failed: HTTP 404; MCX commodities .* unavailable/);
  });
});

describe('ScripMaster: a cache written before MCX', () => {
  it('a same-day cache without mcx_fo is used when the files cannot be fetched again; with the network the MCX file is downloaded', async () => {
    const first = harness(dir, ALL);
    await first.sm.refresh(DATE);
    fs.rmSync(path.join(dir, 'refdata', DATE, 'mcx_fo.csv'));
    const offline = harness(dir, ALL, { extra: { filePaths: async () => Promise.reject(new Error('offline')) } });
    await offline.sm.refresh(DATE);
    expect(offline.sm.status()).toMatchObject({ ready: true, source: 'cache' });
    expect(() => offline.sm.underlying('CRUDEOIL')).toThrow(/Unknown symbol/);
    expect(offline.sm.status().warnings.join(' ')).toMatch(/cached instrument master has no mcx_fo file/);
    const online = harness(dir, ALL);
    await online.sm.refresh(DATE);
    expect(online.sm.underlying('CRUDEOIL').kind).toBe('commodity');
  });
});

describe('ScripMaster', () => {
  it('throws NoLiveData before the first successful refresh', () => {
    const { sm } = harness(dir, ALL);
    expect(sm.ready()).toBe(false);
    expect(() => sm.underlyings()).toThrow(NoLiveData);
    expect(() => sm.underlying('NIFTY')).toThrow(/Instrument master not loaded yet/);
    expect(() => sm.listing({ symbol: 'NIFTY', kind: 'SPOT' })).toThrow(NoLiveData);
    expect(sm.byToken('nse_fo', '52010')).toBeUndefined();
  });

  it('downloads the five segment files with a plain GET and builds the universe', async () => {
    const { sm, ff } = harness(dir, ALL);
    await sm.refresh(DATE);
    const base = `https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/${DATE}`;
    expect(ff.calls.map((c) => c.url).sort()).toEqual(
      [`${base}/transformed-v1/bse_cm-v1.csv`, `${base}/transformed-v1/nse_cm-v1.csv`, `${base}/transformed/bse_fo.csv`, `${base}/transformed/nse_fo.csv`, `${base}/transformed/mcx_fo.csv`].sort(),
    );
    expect(ff.calls.every((c) => c.method === 'GET' && !c.hasHeaders)).toBe(true);
    expect(sm.ready()).toBe(true);

    expect(sm.underlyings().map((u) => u.symbol)).toEqual(['NIFTY', 'BANKNIFTY', 'SENSEX', 'RELIANCE', 'VEDL', 'CRUDEOIL']);
    expect(sm.underlying('nifty')).toEqual({
      symbol: 'NIFTY',
      name: 'Nifty 50',
      kind: 'index',
      exchange: 'NSE',
      sector: 'Index',
      lotSize: 75,
      strikeStep: 50,
      // Index spots: lot 1 as the cash master lists index rows; no tick size (indices are not traded).
      spot: { symbol: 'NIFTY', kind: 'SPOT', exchange: 'NSE', segment: 'nse_cm', token: 'Nifty 50', tradingSymbol: 'Nifty 50', lotSize: 1 },
    });
    expect('tickSize' in sm.underlying('NIFTY').spot).toBe(false);
    expect(sm.underlying('BANKNIFTY')).toMatchObject({ lotSize: 35, strikeStep: 100, spot: { token: 'Nifty Bank' } });
    expect(sm.underlying('SENSEX')).toMatchObject({ exchange: 'BSE', lotSize: 20, strikeStep: 100, spot: { segment: 'bse_cm', token: 'SENSEX' } });
    expect(sm.underlying('RELIANCE')).toEqual({
      symbol: 'RELIANCE',
      name: 'Reliance Industries',
      kind: 'stock',
      exchange: 'NSE',
      sector: 'Energy',
      lotSize: 500,
      strikeStep: 20,
      // EQ series preferred over BL; tick 5 paise; lFreezeQty as published.
      spot: { symbol: 'RELIANCE', kind: 'SPOT', exchange: 'NSE', segment: 'nse_cm', token: '2885', tradingSymbol: 'RELIANCE-EQ', lotSize: 1, tickSize: 0.05, freezeQty: 40592 },
    });
    expect(sm.underlying('VEDL').strikeStep).toBe(2.5);
    expect(sm.strikes('VEDL', '2026-10-27')).toEqual([290, 292.5, 295]);

    // Expiries ascending, expired ones excluded; NSE epoch and plain-Unix BSE decoding.
    expect(sm.expiries('NIFTY', 'OPT')).toEqual(['2026-10-13', '2026-10-20', '2026-10-27']);
    expect(sm.expiries('NIFTY', 'FUT')).toEqual(['2026-10-27']);
    expect(sm.expiries('SENSEX', 'OPT')).toEqual(['2026-10-15']);
    expect(sm.expiries('SENSEX', 'FUT')).toEqual(['2026-10-29']);
    expect(sm.strikes('NIFTY', '2026-10-13')).toEqual([24900, 24950, 25000, 25050, 25100]);

    const ce = sm.listing({ symbol: 'NIFTY', kind: 'CE', expiry: '2026-10-13', strike: 25050 });
    expect(ce).toEqual({
      symbol: 'NIFTY',
      kind: 'CE',
      expiry: '2026-10-13',
      strike: 25050,
      exchange: 'NSE',
      segment: 'nse_fo',
      token: '40106',
      tradingSymbol: 'NIFTY26O1325050CE',
      lotSize: 75,
      tickSize: 0.05,
      freezeQty: 1801,
    });
    expect(sm.listing({ symbol: 'NIFTY', kind: 'FUT', expiry: '2026-10-27' })).toMatchObject({ token: '52010', tickSize: 0.1 });
    expect(sm.listing({ symbol: 'BANKNIFTY', kind: 'PE', expiry: '2026-10-27', strike: 56100 })?.freezeQty).toBe(901);
    expect(sm.listing({ symbol: 'NIFTY', kind: 'CE', expiry: '2026-10-06', strike: 25000 })).toBeUndefined();
    expect(sm.listing({ symbol: 'INDIAVIX', kind: 'SPOT' })).toMatchObject({ segment: 'nse_cm', token: 'INDIA VIX', lotSize: 1 });
    expect(sm.listing({ symbol: 'INDIAVIX', kind: 'SPOT' })?.tickSize).toBeUndefined();
    expect(sm.chain('NIFTY', '2026-10-27')).toEqual([{ strike: 25000, ce: expect.objectContaining({ token: '52011' }), pe: expect.objectContaining({ token: '52012' }) }]);

    // Reverse lookups for the feed decoder (incl. the numeric NIFTY index token of the cm file).
    expect(sm.byToken('nse_fo', '40106')).toBe(ce);
    expect(sm.byToken('nse_cm', 'Nifty 50')).toBe(sm.underlying('NIFTY').spot);
    expect(sm.byToken('nse_cm', '26000')).toBe(sm.underlying('NIFTY').spot);
    expect(sm.byToken('nse_cm', '2885')?.symbol).toBe('RELIANCE');
    expect(sm.byToken('bse_fo', '800003')).toMatchObject({ symbol: 'SENSEX', kind: 'PE', strike: 81600 });
    expect(sm.byToken('nse_fo', '35019 35003')).toBeUndefined();
    expect(sm.byToken('nse_fo', '40001')).toBeUndefined();
    expect(sm.byToken('nse_fo', '72000')).toBeUndefined();

    expect(sm.kotakUnderlying('SENSEX')).toEqual({ exchange: 'bse_fo', underlying: 'SENSEX' });
    expect(sm.kotakUnderlying('RELIANCE')).toEqual({ exchange: 'nse_fo', underlying: 'RELIANCE' });

    const st = sm.status();
    expect(st).toMatchObject({ ready: true, date: DATE, sourceDate: DATE, source: 'download', underlyings: 6 });
    expect(st.warnings.join('\n')).toMatch(/FINNIFTY: no live option contracts/);
    expect(st.warnings.join('\n')).toMatch(/BANKEX: no live option contracts in bse_fo \(pSymbolName BANKEX\/BKX\)/);
    expect(st.warnings.join('\n')).toMatch(/configured stocks have no OPTSTK rows in nse_fo; not offered: [A-Z]/);
  });

  it('answers 404 for unknown symbols and unlisted expiries', async () => {
    const { sm } = harness(dir, ALL);
    await sm.refresh(DATE);
    for (const f of [() => sm.underlying('XYZ'), () => sm.underlying('IRCTC'), () => sm.expiries('XYZ', 'OPT'), () => sm.strikes('NIFTY', '2026-11-03')]) {
      let err: unknown;
      try {
        f();
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({ statusCode: 404 });
      expect(err).not.toBeInstanceOf(NoLiveData);
    }
    expect(sm.listing({ symbol: 'XYZ', kind: 'SPOT' })).toBeUndefined();
  });

  it('caches the files so a restart the same day does not download again', async () => {
    const first = harness(dir, ALL);
    await first.sm.refresh(DATE);
    const day = path.join(dir, 'refdata', DATE);
    expect(fs.readdirSync(day).sort()).toEqual(['bse_cm.csv', 'bse_fo.csv', 'manifest.json', 'mcx_fo.csv', 'nse_cm.csv', 'nse_fo.csv']);
    expect(fs.readFileSync(path.join(day, 'nse_fo.csv'), 'utf8')).toBe(nseFo());

    const second = harness(dir, {});
    await second.sm.refresh(DATE);
    expect(second.pathCalls()).toBe(0);
    expect(second.ff.calls.length).toBe(0);
    expect(second.sm.status()).toMatchObject({ source: 'cache', underlyings: 6 });
    expect(second.sm.underlying('NIFTY').strikeStep).toBe(50);
  });

  it('re-checks file-paths when the cached files came from an older Kotak folder', async () => {
    const lagging = harness(dir, ALL, { day: '2026-10-11' });
    await lagging.sm.refresh(DATE);
    expect(lagging.sm.status().sourceDate).toBe('2026-10-11');

    const same = harness(dir, {}, { day: '2026-10-11' });
    await same.sm.refresh(DATE);
    expect(same.pathCalls()).toBe(1);
    expect(same.ff.calls.length).toBe(0);

    const published = harness(dir, ALL, { day: DATE });
    await published.sm.refresh(DATE);
    expect(published.ff.calls.length).toBe(5);
    expect(published.sm.status()).toMatchObject({ source: 'download', sourceDate: DATE });
  });

  it('rejects a corrupt file (row width) with a clear error and keeps nothing from it', async () => {
    const short = foRow({ token: 1, inst: 'OPTIDX', name: 'NIFTY', trd: 'X', opt: 'CE', expiry: OCT27, strike: 1, lot: 75 }).split(',').slice(0, 77).join(',');
    const { sm } = harness(dir, { ...ALL, nse_fo: { text: nseFo(Array(5).fill(short)) } });
    await expect(sm.refresh(DATE)).rejects.toThrow(/nse_fo\.csv rejected: 5 of \d+ rows malformed \(first problem line \d+: 77 fields, header has 78\)/);
    expect(sm.ready()).toBe(false);
    expect(sm.status().error).toMatch(/nse_fo\.csv rejected/);
    expect(() => sm.underlyings()).toThrow(/nse_fo\.csv rejected/);
    expect(fs.existsSync(path.join(dir, 'refdata', DATE, 'manifest.json'))).toBe(false);
  });

  it('rejects wrong segment values and non-CSV bodies; a failed refresh keeps the previous master', async () => {
    const wrongSeg = nseFo().replace(/,nse_fo,/g, ',nse_cm,');
    const a = harness(dir, { ...ALL, nse_fo: { text: wrongSeg } });
    await expect(a.sm.refresh(DATE)).rejects.toThrow(/nse_fo\.csv rejected: .*pExchSeg "nse_cm" in the nse_fo file/);

    const b = harness(dir, { ...ALL, nse_cm: { text: '<html><body>Service Unavailable</body></html>' } });
    await expect(b.sm.refresh(DATE)).rejects.toThrow(/nse_cm\.csv rejected: missing columns/);

    const c = harness(dir, { ...ALL, nse_fo: { status: 503, text: 'busy' } });
    await expect(c.sm.refresh(DATE)).rejects.toThrow(/nse_fo download failed: HTTP 503/);

    // A body cut off mid-download is a NoLiveData, not a raw stream error.
    const cut = harness(dir, ALL, {
      extra: {
        fetch: async (url: string) =>
          url.includes('/nse_fo') ? new Response(new ReadableStream({ pull: (ctl) => ctl.error(new Error('ECONNRESET')) })) : new Response(ALL[(['nse_cm', 'bse_cm', 'bse_fo'] as const).find((s) => url.includes(`/${s}`))!]!.text),
      },
    });
    const err = await cut.sm.refresh(DATE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoLiveData);
    expect((err as Error).message).toMatch(/nse_fo download failed: ECONNRESET/);

    // Same instance, next day's files are bad: the refresh fails but the loaded master stays usable.
    const served: Files = { ...ALL };
    const ok = harness(dir, served);
    await ok.sm.refresh(DATE);
    served.nse_fo = { text: wrongSeg };
    await expect(ok.sm.refresh('2026-10-13')).rejects.toThrow(/rejected/);
    expect(ok.sm.ready()).toBe(true);
    expect(ok.sm.status()).toMatchObject({ date: DATE, error: expect.stringMatching(/rejected/) });
  });

  it('rejects a file whose decoded strikes do not match the trading symbols (scale guard)', async () => {
    const rows = Array.from({ length: 24 }, (_, i) =>
      foRow({ token: 90000 + i, inst: 'OPTIDX', name: 'NIFTY', trd: `NIFTY26OCT${25000 + 50 * i}CE`, opt: 'CE', expiry: OCT27, strike: (25000 + 50 * i) * 10_000, lot: 75 }),
    );
    const { sm } = harness(dir, { ...ALL, nse_fo: { text: scripCsv(rows) } });
    await expect(sm.refresh(DATE)).rejects.toThrow(/strike scale/);
  });

  it('degrades to NSE-only when a BSE file is unusable (SENSEX/BANKEX dropped with a reason)', async () => {
    // bse_fo encoded with the NSE epoch would decode ~10 years in the past: rejected, not trusted.
    const wrongEpoch = harness(dir, { ...ALL, bse_fo: { text: bseFo((d) => bseExpiry(d) - 315_511_200) } });
    await wrongEpoch.sm.refresh(DATE);
    expect(wrongEpoch.sm.underlyings().map((u) => u.symbol)).toEqual(['NIFTY', 'BANKNIFTY', 'RELIANCE', 'VEDL', 'CRUDEOIL']);
    expect(wrongEpoch.sm.status().warnings.join('\n')).toMatch(/bse_fo\.csv rejected: .*expiry epoch mismatch.*SENSEX\/BANKEX F&O unavailable/);

    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'q26-scrip-'));
    try {
      const missing = harness(dir2, { ...ALL, bse_fo: { status: 404, text: '404: Not Found' } });
      await missing.sm.refresh(DATE);
      expect(missing.sm.status().warnings.join('\n')).toMatch(/bse_fo download failed: HTTP 404; SENSEX\/BANKEX F&O unavailable/);
      // An incomplete set is not cached: the next start tries again.
      expect(fs.existsSync(path.join(dir2, 'refdata', DATE, 'manifest.json'))).toBe(false);
    } finally {
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('parses verbatim rows of the official 2023 sample files', async () => {
    const { sm } = harness(dir, {
      nse_cm: { text: scripCsv(LEGACY_CM_ROWS) },
      nse_fo: { text: scripCsv(LEGACY_FO_ROWS) },
      bse_cm: { text: bseCm() },
      bse_fo: { text: `${SCRIP_HEADER}\n` },
    });
    await sm.refresh('2023-05-02');
    expect(sm.underlyings().map((u) => u.symbol)).toEqual(['FINNIFTY']);
    expect(sm.underlying('FINNIFTY')).toMatchObject({ lotSize: 40, strikeStep: 50, spot: { token: 'Nifty Fin Service' } });
    expect(sm.expiries('FINNIFTY', 'OPT')).toEqual(['2023-05-09']);
    expect(sm.strikes('FINNIFTY', '2023-05-09')).toEqual([17550, 17600]);
    expect(sm.listing({ symbol: 'FINNIFTY', kind: 'CE', expiry: '2023-05-09', strike: 17600 })).toMatchObject({ token: '37001', tradingSymbol: 'FINNIFTY2350917600CE', tickSize: 0.05, freezeQty: 1801 });
    expect(sm.byToken('nse_cm', '26037')?.symbol).toBe('FINNIFTY');
    expect(sm.status().warnings.join('\n')).toMatch(/bse_fo\.csv rejected: no usable rows/);
  });
});

describe('scrip master helpers', () => {
  it('decodes expiries per segment (official instruments.md rule) to the IST date', () => {
    expect(decodeExpiry('1366468200', 'nse_fo')).toBe('2023-04-20'); // NIFTY2342015450CE
    expect(decodeExpiry('1467297000', 'nse_fo')).toBe('2026-06-30'); // FEDERALBNK 30-Jun-2026
    expect(decodeExpiry(String(OCT27), 'nse_fo')).toBe('2026-10-27');
    expect(decodeExpiry(String(bseExpiry('2026-10-15')), 'bse_fo')).toBe('2026-10-15');
    expect(decodeExpiry('-1', 'nse_fo')).toBeUndefined();
    expect(decodeExpiry('', 'nse_fo')).toBeUndefined();
  });

  it('decodes paise strikes incl. scientific notation', () => {
    expect(decodeStrike('1.75e+06')).toBe(17500);
    expect(decodeStrike('1.755e+06')).toBe(17550);
    expect(decodeStrike('23000')).toBe(230);
    expect(decodeStrike('29250')).toBe(292.5);
    expect(decodeStrike('-1')).toBeUndefined();
  });

  it('strike step is the most common gap (ties → smaller)', () => {
    expect(strikeStepOf([24900, 24950, 25000, 25100, 25200, 25300])).toBe(100);
    expect(strikeStepOf([100, 150, 200, 300])).toBe(50);
    expect(strikeStepOf([100, 200, 250])).toBe(50);
    expect(strikeStepOf([100])).toBeUndefined();
    expect(strikeStepOf()).toBeUndefined();
    // Gaps are taken inside each expiry, never across two (100 → 102.5 is not a gap of 2.5).
    expect(strikeStepOf([100, 105, 110], [102.5, 112.5])).toBe(5);
    expect(strikeStepOf([100], [200])).toBeUndefined();
  });

  it('strike step pools every live expiry: corporate-action-adjusted strikes do not set it', () => {
    // Adjusted series (NTPC-like): 1.75 apart on the nearest expiry, the newer ones on the 2.5 grid.
    const adjusted = [171.75, 173.5, 175.25, 177];
    expect(strikeStepOf(adjusted)).toBe(1.75); // the old nearest-expiry rule
    expect(strikeStepOf(adjusted, [170, 172.5, 175, 177.5], [170, 172.5, 175])).toBe(2.5);
  });

  it('builds strikeStep from all live expiries of the underlying (adjusted nearest expiry)', async () => {
    // CONSTRUCTED: IRCTC with a corporate-action-adjusted October series (10.25 apart) and
    // November/December series on the regular 10-rupee grid.
    let tok = 90000;
    const irctc = (expiry: number, ks: number[]) =>
      ks.map((k) => foRow({ token: tok++, inst: 'OPTSTK', name: 'IRCTC', trd: `IRCTC${expiry}${k}CE`, opt: 'CE', expiry, strike: Math.round(k * 100), lot: 875 }));
    const extra = [
      ...irctc(OCT27, [700.25, 710.5, 720.75, 731]),
      ...irctc(nseExpiry('2026-11-24'), [690, 700, 710, 720, 730]),
      ...irctc(nseExpiry('2026-12-29'), [700, 710, 720]),
    ];
    const { sm } = harness(dir, { ...ALL, nse_fo: { text: nseFo(extra) } });
    await sm.refresh(DATE);
    expect(sm.expiries('IRCTC', 'OPT')).toEqual(['2026-10-27', '2026-11-24', '2026-12-29']);
    expect(sm.strikes('IRCTC', '2026-10-27')).toEqual([700.25, 710.5, 720.75, 731]); // listed as published
    expect(sm.underlying('IRCTC').strikeStep).toBe(10);
  });

  it('parses quoted CSV fields, CRLF and the trimmed 78-column header', () => {
    const recs = [...csvRecords(`${SCRIP_HEADER}\r\na,"b, c","d ""q""",\r\n\r\nx,"     ",y,z\n`)];
    expect(recs[0].length).toBe(78);
    expect(recs[0].map((h) => h.trim())).toContain('dStrikePrice;');
    expect(recs[1]).toEqual(['a', 'b, c', 'd "q"', '']);
    expect(recs[2]).toEqual(['x', '     ', 'y', 'z']);
    expect(folderDate('https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod/2026-07-14/transformed/nse_fo.csv')).toBe('2026-07-14');
  });
});
