/**
 * Algo strategies on live data (TEST-ONLY FakeProvider + sample book; every price below is test data
 * built here, mostly Black-76 at a stated vol). Live paper runs trade the live chain through the paper
 * broker (fills at live bid/ask); backtests replay only sessions recorded in the provider's intraday
 * store. Paper only: nothing here talks to a broker.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  ALGO_PRESETS,
  istTs,
  type AlgoBacktestDay,
  type AlgoCatalog,
  type AlgoEvent,
  type AlgoRunView,
  type OptionSide,
} from '@q26/core';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { black76Price, timeToExpiry } from '../src/live/pricing';
import { NoLiveData, keyId } from '../src/live/types';
import type { MinuteRecord } from '../src/live/types';
import { Notifier } from '../src/services/alerts';
import { AlgoService } from '../src/services/algo';
import { optKey, spotKey } from '../src/services/live';
import { createServices } from '../src/services';
import { Pricer } from '../src/services/pricer';
import { PaperBroker } from '../src/services/trading';
import { Db } from '../src/store/db';
import { FakeProvider, loadSampleBook, type SampleBook } from './support/fake-provider';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const MINUTE = 60_000;
const at = (date: string, hhmm: string, sec = 0) => istTs(date, Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)), sec);
const istHhmm = (ts: number) => new Date(ts + 5.5 * 3600_000).toISOString().slice(11, 16);
const tick5 = (x: number) => Math.round(Math.round(x / 0.05) * 0.05 * 100) / 100;
const r2 = (x: number) => Math.round(x * 100) / 100;
const strikesOf = (lo: number, hi: number, step: number) => Array.from({ length: Math.round((hi - lo) / step) + 1 }, (_, i) => lo + i * step);

/** TEST DATA: Black-76 premium of a NIFTY option at `spot`, `vol`, as of `ts` (test carry 1 %). */
function testPremium(p: FakeProvider, expiry: string, type: OptionSide, strike: number, spot: number, vol: number, ts: number): number {
  const r = p.pricing.r;
  const T = timeToExpiry(expiry, ts);
  return black76Price(type, spot * Math.exp((r - 0.01) * T), strike, T, r, vol);
}

/* ------------------------------------------------------------------------------------------ */
/* Live runs                                                                                    */
/* ------------------------------------------------------------------------------------------ */

function setupLive(time = '09:16') {
  const p = new FakeProvider();
  cleanup.push(() => p.dispose());
  const book = loadSampleBook(p, { time });
  const db = new Db(null);
  const pricer = new Pricer(p);
  const notifier = new Notifier(db, () => p.now());
  const broker = new PaperBroker(p, db, pricer, () => p.now(), (uid, n) => notifier.push(uid, n), () => undefined);
  const algos = new AlgoService(p, db, broker, notifier, pricer);
  return { p, book, db, pricer, notifier, broker, algos };
}

type QuoteOpts = {
  vol?: number;
  /** Premium overrides by `${type}${strike}` (TEST DATA). */
  override?: Record<string, number>;
  /** Legs quoted without a trade in this session (volume 0: their LTP is an earlier session's). */
  noTrade?: (type: OptionSide, strike: number) => boolean;
  /** Legs quoted without a book (no bid/ask). */
  noBook?: (type: OptionSide, strike: number) => boolean;
};

/** TEST DATA: re-quote the NIFTY spot and one expiry's chain at `spot`, stamped now (traded LTP, ±₹0.05 book). */
function quoteChain(p: FakeProvider, expiry: string, spot: number, o: QuoteOpts = {}) {
  const now = p.now();
  p.setQuote(spotKey('NIFTY'), { ltp: spot, prevClose: 24900 });
  for (const strike of p.ref.strikes('NIFTY', expiry)) {
    for (const type of ['CE', 'PE'] as OptionSide[]) {
      const px = o.override?.[`${type}${strike}`] ?? tick5(testPremium(p, expiry, type, strike, spot, o.vol ?? 0.14, now));
      if (!(px >= 0.05)) continue;
      const noBook = o.noBook?.(type, strike) ?? false;
      p.setQuote(optKey('NIFTY', expiry, type, strike), {
        ltp: px,
        bid: noBook ? undefined : r2(Math.max(0.05, px - 0.05)),
        ask: noBook ? undefined : r2(px + 0.05),
        oi: 100_000,
        volume: o.noTrade?.(type, strike) ? 0 : 50_000,
      });
    }
  }
}

const W = (book: SampleBook) => book.expiries.NIFTY[0];
const fillsOf = (events: AlgoEvent[], kind?: AlgoEvent['kind']) => events.filter((e) => !kind || e.kind === kind).flatMap((e) => e.fills);

describe('algo catalogue, defaults and presets', () => {
  it('lists the algos, both presets and the index underlyings from the instrument master', () => {
    const { p, algos } = setupLive();
    const c: AlgoCatalog = algos.catalog();
    expect(c.algos.map((a) => a.id)).toContain('premium-ladder');
    expect(c.presets.map((x) => x.id)).toEqual(['strategy-2-rs20', 'strategy-3-rs50']);
    expect(c.presets[0].params).toMatchObject({ symbol: 'NIFTY', startPremium: 20, stepPct: 50, strikeMultiple: 100, entryTime: '09:20', exitTime: '15:25' });
    expect(c.presets[1].params).toMatchObject({ startPremium: 50 });
    expect(c.symbols).toEqual([
      { symbol: 'NIFTY', lotSize: 75, strikeStep: 50, kind: 'index' },
      { symbol: 'BANKNIFTY', lotSize: 35, strikeStep: 100, kind: 'index' },
    ]);
    expect(c.gaps).toBeUndefined();
    expect(algos.defaults('premium-ladder', 'banknifty')).toMatchObject({ symbol: 'BANKNIFTY', strikeMultiple: 100, startPremium: 20 });
    expect(algos.defaults('premium-ladder', 'NIFTY')).toMatchObject({ strikeMultiple: 100 });

    // Instrument master not loaded: algos and presets still listed, symbols blank with the reason.
    p.ref.setLoaded(false);
    const blank = algos.catalog();
    expect(blank.algos.length).toBe(1);
    expect(blank.symbols).toEqual([]);
    expect(blank.gaps?.symbols).toMatch(/Instrument master not loaded/);
    expect(() => algos.defaults('premium-ladder', 'NIFTY')).toThrow(NoLiveData);
  });

  it('merges a preset with the request: preset values fill blanks, the preset name stays only while unchanged', async () => {
    const { p, book, algos } = setupLive();
    quoteChain(p, W(book), 25000);
    const preset = await algos.create('u1', { algoId: 'premium-ladder', presetId: 'strategy-3-rs50', params: { lots: 1 } });
    expect(preset).toMatchObject({ name: 'Strategy 3 · Starting premium ₹50', presetId: 'strategy-3-rs50', status: 'running' });
    expect(preset.params).toMatchObject({ ...ALGO_PRESETS[1].params });
    const blank = await algos.create('u1', { algoId: 'premium-ladder', presetId: 'strategy-3-rs50', params: { startPremium: '' } });
    expect(blank.params.startPremium).toBe(50);
    expect(blank.presetId).toBe('strategy-3-rs50');
    const edited = await algos.create('u1', { algoId: 'premium-ladder', presetId: 'strategy-3-rs50', params: { startPremium: 30 } });
    expect(edited.params.startPremium).toBe(30);
    expect(edited.name).toBe('Premium ladder · ₹30 start');
    expect(edited.presetId).toBeUndefined();
    await expect(algos.create('u1', { algoId: 'premium-ladder', presetId: 'nope', params: {} })).rejects.toMatchObject({ statusCode: 404 });
    expect(algos.list('u1')).toHaveLength(3);
  });

  it('validates input: unknown algo/symbol (404), bad parameters, dates and states (400), master not loaded (503)', async () => {
    const { p, book, algos } = setupLive();
    quoteChain(p, W(book), 25000);
    await expect(algos.backtestDay('nope', {}, undefined)).rejects.toMatchObject({ statusCode: 404 });
    await expect(algos.backtestDay('premium-ladder', { symbol: 'NOPE' }, undefined)).rejects.toMatchObject({ statusCode: 404 });
    await expect(algos.backtestDay('premium-ladder', { symbol: 'NIFTY', exitTime: '09:10' }, undefined)).rejects.toMatchObject({ statusCode: 400 });
    await expect(algos.backtestDay('premium-ladder', { symbol: 'NIFTY', lots: 0 }, undefined)).rejects.toMatchObject({ statusCode: 400, message: /Lots must be/ });
    await expect(algos.backtestDay('premium-ladder', { symbol: 'NIFTY' }, '2026-10-11')).rejects.toMatchObject({ statusCode: 400, message: /not a trading day/ });
    await expect(algos.backtestDay('premium-ladder', { symbol: 'NIFTY' }, '2026-10-30')).rejects.toMatchObject({ statusCode: 400, message: /future/ });
    await expect(algos.backtestDay('premium-ladder', { symbol: 'NIFTY' }, '12-10-2026')).rejects.toMatchObject({ statusCode: 400 });
    await expect(algos.create('u1', { algoId: 'premium-ladder', params: { symbol: 'NIFTY', entryTime: '9:20' } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(algos.create('u1', { algoId: 'premium-ladder', params: { symbol: 'NIFTY', expiry: 'weekly' } })).rejects.toMatchObject({ statusCode: 400 });
    // RELIANCE lists only a monthly expiry: no "next" expiry to trade.
    await expect(algos.create('u1', { algoId: 'premium-ladder', params: { symbol: 'RELIANCE', expiry: 'next' } })).rejects.toMatchObject({ statusCode: 400, message: /No next RELIANCE option expiry/ });
    const run = await algos.create('u1', { algoId: 'premium-ladder', params: { symbol: 'NIFTY' } });
    expect(() => algos.remove('u1', run.id)).toThrow(/Stop the algo/);
    await algos.stop('u1', run.id);
    await expect(algos.stop('u1', run.id)).rejects.toMatchObject({ statusCode: 400 });
    algos.remove('u1', run.id);
    expect(() => algos.get('u1', run.id)).toThrow(/not found/);
    for (let i = 0; i < 5; i++) await algos.create('u1', { algoId: 'premium-ladder', params: { symbol: 'NIFTY' } });
    await expect(algos.create('u1', { algoId: 'premium-ladder', params: { symbol: 'NIFTY' } })).rejects.toThrow(/At most 5 algos/);
    p.ref.setLoaded(false);
    await expect(algos.create('u2', { algoId: 'premium-ladder', params: { symbol: 'NIFTY' } })).rejects.toBeInstanceOf(NoLiveData);
  });
});

/** Deploy Strategy 2 at 09:16 and run it through the 09:20 entry (spot 25000). */
async function deployAndEnter() {
  const ctx = setupLive('09:16');
  const { p, book, algos } = ctx;
  const D = book.date;
  quoteChain(p, W(book), 25000);
  const run = await algos.create('u1', { algoId: 'premium-ladder', presetId: 'strategy-2-rs20', params: {} });
  p.setNow(at(D, '09:20', 1));
  quoteChain(p, W(book), 25000);
  await algos.tick();
  return { ...ctx, D, run, view: () => algos.get('u1', run.id) };
}

describe('live paper run (Strategy 2 · ₹20)', () => {
  it('trades only in the open session, waits for 09:20, then sells both OTM legs at the live bids through the broker', async () => {
    const { p, book, algos, broker } = setupLive('08:50');
    const D = book.date;
    // Pre-open: deployed, but nothing happens before the session opens.
    const run = await algos.create('u1', { algoId: 'premium-ladder', presetId: 'strategy-2-rs20', params: {} });
    expect(run).toMatchObject({ status: 'running', name: 'Strategy 2 · Starting premium ₹20', today: null });

    p.setNow(at(D, '09:16'));
    quoteChain(p, W(book), 25000);
    await algos.tick();
    let v = algos.get('u1', run.id);
    expect(v.today).toMatchObject({ date: D, expiry: W(book), phase: 'waiting' });

    p.setNow(at(D, '09:19', 30));
    quoteChain(p, W(book), 25000);
    await algos.tick();
    expect(algos.get('u1', run.id).today?.phase).toBe('waiting');
    expect(broker.trades('u1')).toHaveLength(0);

    p.setNow(at(D, '09:20', 1));
    quoteChain(p, W(book), 25000);
    await algos.tick();
    v = algos.get('u1', run.id);
    expect(v.today?.phase).toBe('active');
    const entry = v.today!.events.find((e) => e.kind === 'ENTRY')!;
    expect(istHhmm(entry.ts)).toBe('09:20');
    // The OTM strikes (multiples of 100) whose live premiums are nearest ₹20: 25200 CE (≈19.0) and 24800 PE (≈17.0).
    const ce = p.live.quote(optKey('NIFTY', W(book), 'CE', 25200))!;
    const pe = p.live.quote(optKey('NIFTY', W(book), 'PE', 24800))!;
    expect(entry.fills).toEqual([
      expect.objectContaining({ side: 'SELL', type: 'CE', strike: 25200, lots: 1, price: ce.bid }),
      expect.objectContaining({ side: 'SELL', type: 'PE', strike: 24800, lots: 1, price: pe.bid }),
    ]);
    // Same fills in the paper broker (live bids), tagged with the run.
    const trades = broker.trades('u1');
    expect(trades.map((t) => [t.side, t.price, t.quantity])).toEqual([['SELL', pe.bid, 75], ['SELL', ce.bid, 75]]);
    expect(broker.orders('u1').every((o) => o.tag === `algo:${run.id}` && o.status === 'COMPLETE' && o.orderType === 'MARKET')).toBe(true);
    const pos = broker.positions('u1');
    expect(pos.map((x) => [x.strike, x.type, x.netQty]).sort()).toEqual([[24800, 'PE', -75], [25200, 'CE', -75]]);
    // Live marks at the legs' live-session LTPs.
    expect(v.today!.legs.map((l) => [l.strike, l.ltp])).toEqual([[25200, ce.ltp], [24800, pe.ltp]]);
    expect(v.today!.unrealized).toBe(Math.round((ce.bid! - ce.ltp) * 75) + Math.round((pe.bid! - pe.ltp) * 75));
    expect(v.today!.mtm).toBe(v.today!.unrealized);
    expect(v.totalNet).toBe(v.today!.mtm! - v.today!.charges);
    // Its open legs are streamed in the provider's user tier.
    expect(algos.userContracts().map((k) => keyId(k as never)).sort()).toEqual([keyId(optKey('NIFTY', W(book), 'CE', 25200)), keyId(optKey('NIFTY', W(book), 'PE', 24800))].sort());
  });

  it('rolls the opposite leg when a leg premium rises 50 % (₹20 → ₹30), selling the OTM strike nearest the new level', async () => {
    const { p, book, D, run, view, broker, algos } = await deployAndEnter();
    p.setNow(at(D, '09:40'));
    quoteChain(p, W(book), 25040); // CE 25200 still below ₹30
    await algos.tick();
    expect(view().today!.events.filter((e) => e.kind === 'ADJUSTMENT')).toHaveLength(0);

    p.setNow(at(D, '10:00', 2));
    quoteChain(p, W(book), 25100); // CE 25200 ≈ ₹42.6 ≥ ₹30
    await algos.tick();
    const v = view();
    const adj = v.today!.events.find((e) => e.kind === 'ADJUSTMENT')!;
    expect(adj).toBeTruthy();
    expect(adj.data).toMatchObject({ level: 30, ce: 25200, pe: 25000 });
    const oldPe = p.live.quote(optKey('NIFTY', W(book), 'PE', 24800))!;
    const newPe = p.live.quote(optKey('NIFTY', W(book), 'PE', 25000))!;
    expect(adj.fills).toEqual([
      expect.objectContaining({ side: 'BUY', type: 'PE', strike: 24800, price: oldPe.ask }),
      expect.objectContaining({ side: 'SELL', type: 'PE', strike: 25000, price: newPe.bid }),
    ]);
    // Strictly OTM at that moment and the nearest eligible premium to ₹30 among the live strikes.
    expect(25000).toBeLessThan(25100);
    for (const k of [24600, 24700, 24800, 24900]) {
      expect(Math.abs(p.live.quote(optKey('NIFTY', W(book), 'PE', k))!.ltp - 30)).toBeGreaterThan(Math.abs(newPe.ltp - 30));
    }
    expect(v.today!.status.find((s) => s.label === 'Premium level')?.value).toMatch(/₹30 \(level 1\)/);
    const pos = broker.positions('u1').filter((x) => x.netQty !== 0);
    expect(pos.map((x) => [x.strike, x.type, x.netQty]).sort()).toEqual([[25000, 'PE', -75], [25200, 'CE', -75]]);
    expect(view().id).toBe(run.id);
  });

  it('squares off at 15:25 at the live asks and closes the day; later ticks place no orders', async () => {
    const { p, book, D, view, broker, algos } = await deployAndEnter();
    p.setNow(at(D, '15:24', 50));
    quoteChain(p, W(book), 25000);
    await algos.tick();
    expect(view().today!.phase).toBe('active');
    p.setNow(at(D, '15:25', 1));
    quoteChain(p, W(book), 25000);
    await algos.tick();
    const v = view();
    const exit = v.today!.events.find((e) => e.kind === 'EXIT')!;
    expect(istHhmm(exit.ts)).toBe('15:25');
    const ce = p.live.quote(optKey('NIFTY', W(book), 'CE', 25200))!;
    const pe = p.live.quote(optKey('NIFTY', W(book), 'PE', 24800))!;
    expect(exit.fills.map((f) => [f.side, f.type, f.price])).toEqual([['BUY', 'CE', ce.ask], ['BUY', 'PE', pe.ask]]);
    expect(v.today!.phase).toBe('exited');
    expect(v.today!.legs).toEqual([]);
    expect(broker.positions('u1').every((x) => x.netQty === 0)).toBe(true);
    // The finished day: realised P&L from the fills, charges, net; complete.
    const day = v.history[0];
    const sells = fillsOf(v.today!.events).filter((f) => f.side === 'SELL').reduce((a, f) => a + f.price, 0);
    const buys = fillsOf(v.today!.events).filter((f) => f.side === 'BUY').reduce((a, f) => a + f.price, 0);
    expect(day).toMatchObject({ date: D, entered: true, exitKind: 'EXIT', orders: 4, pnl: Math.round((sells - buys) * 75) });
    expect(day.net).toBe((day.pnl as number) - day.charges);
    expect(day.incomplete).toBeUndefined();
    expect(v.totalNet).toBe(day.net);
    const n = broker.orders('u1').length;
    p.setNow(at(D, '15:27'));
    quoteChain(p, W(book), 25300);
    await algos.tick();
    expect(broker.orders('u1')).toHaveLength(n);
    // The next session starts a new day (no missed exit: the day was closed).
    p.setNow(at('2026-10-13', '09:16'));
    quoteChain(p, W(book), 25000);
    await algos.tick();
    expect(view().today).toMatchObject({ date: '2026-10-13', phase: 'waiting', events: [] });
    expect(view().history).toHaveLength(1);
  });

  it('stops for the day when no eligible OTM strike has a live premium near the target (no order at all)', async () => {
    const { p, book, algos, broker } = setupLive('09:16');
    const D = book.date;
    quoteChain(p, W(book), 25000);
    const run = await algos.create('u1', { algoId: 'premium-ladder', presetId: 'strategy-2-rs20', params: {} });
    // Puts are quoted, but none has traded in this session: their LTPs are not live premiums.
    p.setNow(at(D, '09:20', 1));
    quoteChain(p, W(book), 25000, { noTrade: (type) => type === 'PE' });
    await algos.tick();
    const v = algos.get('u1', run.id);
    const stop = v.today!.events.find((e) => e.kind === 'STOP')!;
    expect(stop.message).toMatch(/No eligible OTM strike at entry — No OTM PE strike \(multiple of 100\) has a traded premium/);
    expect(v.today!.phase).toBe('stopped');
    expect(broker.orders('u1')).toHaveLength(0);
    expect(v.history[0]).toMatchObject({ entered: false, exitKind: 'STOP', pnl: 0, charges: 0, orders: 0 });
    p.setNow(at(D, '10:00'));
    quoteChain(p, W(book), 25000);
    await algos.tick();
    expect(broker.orders('u1')).toHaveLength(0);
  });

  it('after entry: squares off and stops when no OTM strike near the new level has a live premium', async () => {
    const { p, book, D, view, broker, algos } = await deployAndEnter();
    p.setNow(at(D, '10:00', 2));
    // CE 25200 trades at ₹31 (≥ ₹30); no put has traded since (quoted, with a book, but no session trade).
    quoteChain(p, W(book), 25000, { override: { CE25200: 31 }, noTrade: (type) => type === 'PE' });
    await algos.tick();
    const v = view();
    const stop = v.today!.events.find((e) => e.kind === 'STOP')!;
    expect(stop.message).toMatch(/CE 25200 premium ₹31 reached ₹30 .*No OTM PE strike \(multiple of 100\) has a traded premium/);
    expect(stop.fills.map((f) => [f.side, f.type, f.strike])).toEqual([['BUY', 'CE', 25200], ['BUY', 'PE', 24800]]);
    expect(v.today!.phase).toBe('stopped');
    expect(broker.positions('u1').every((x) => x.netQty === 0)).toBe(true);
    expect(v.history[0]).toMatchObject({ exitKind: 'STOP', entered: true });
  });

  it('reports a rejected fill on the run and never assumes it filled', async () => {
    const { p, book, algos, broker } = setupLive('09:16');
    const D = book.date;
    quoteChain(p, W(book), 25000);
    const run = await algos.create('u1', { algoId: 'premium-ladder', presetId: 'strategy-2-rs20', params: {} });
    p.setNow(at(D, '09:20', 1));
    // 24800 PE has a live trade but no live book: the paper broker rejects a MARKET sell.
    quoteChain(p, W(book), 25000, { noBook: (type, k) => type === 'PE' && k === 24800 });
    await algos.tick();
    const v = algos.get('u1', run.id);
    const err = v.today!.events.find((e) => e.kind === 'ERROR')!;
    expect(err.message).toMatch(/Order failed: No live bid\/ask for NIFTY 13-Oct-26 24800 PE/);
    // The CE that did fill was bought back; the PE never became a leg.
    expect(err.fills.map((f) => [f.side, f.type])).toEqual([['SELL', 'CE'], ['BUY', 'CE']]);
    expect(v.today!.phase).toBe('stopped');
    expect(v.today!.legs).toEqual([]);
    const orders = broker.orders('u1');
    expect(orders.find((o) => o.type === 'PE')).toMatchObject({ status: 'REJECTED' });
    expect(broker.positions('u1').every((x) => x.netQty === 0)).toBe(true);
    expect(v.history[0]).toMatchObject({ exitKind: 'ERROR' });
  });

  it('waits (never trades) while the live chain or the underlying price is missing, with the reason', async () => {
    const { p, book, algos, broker } = setupLive('09:16');
    const D = book.date;
    quoteChain(p, W(book), 25000);
    const run = await algos.create('u1', { algoId: 'premium-ladder', presetId: 'strategy-2-rs20', params: {} });
    p.setNow(at(D, '09:20', 1));
    quoteChain(p, W(book), 25000);
    p.live.clearQuote(spotKey('NIFTY')); // no live underlying price: OTM cannot be checked
    await algos.tick();
    const v = algos.get('u1', run.id);
    expect(v.today!.phase).toBe('waiting');
    expect(v.gaps?.liveData).toBe('No live NIFTY price');
    expect(v.today!.status).toContainEqual({ label: 'Live data', value: 'No live NIFTY price' });
    expect(broker.orders('u1')).toHaveLength(0);
    // The option chain itself is not live (no leg quoted) while the underlying is: a data outage, not
    // "no eligible strike" — the run keeps waiting instead of stopping for the day.
    p.setNow(at(D, '09:21'));
    quoteChain(p, W(book), 25000);
    for (const k of p.ref.strikes('NIFTY', W(book))) for (const t of ['CE', 'PE'] as const) p.live.clearQuote(optKey('NIFTY', W(book), t, k));
    await algos.tick();
    const gap = algos.get('u1', run.id);
    expect(gap.today!.phase).toBe('waiting');
    expect(gap.gaps?.liveData).toBe(`No live quotes for the NIFTY ${W(book)} option chain`);
    expect(broker.orders('u1')).toHaveLength(0);
    // Data back: the run enters (late entry allowed by the preset).
    p.setNow(at(D, '09:21', 30));
    quoteChain(p, W(book), 25000);
    await algos.tick();
    const v2 = algos.get('u1', run.id);
    expect(v2.today!.phase).toBe('active');
    expect(v2.gaps).toBeUndefined();
    expect(istHhmm(v2.today!.events.find((e) => e.kind === 'ENTRY')!.ts)).toBe('09:21');
  });

  it('stop: squares off at the live asks through the broker', async () => {
    const { p, book, D, run, broker, algos } = await deployAndEnter();
    p.setNow(at(D, '11:00'));
    quoteChain(p, W(book), 25000);
    const v = await algos.stop('u1', run.id);
    expect(v.status).toBe('stopped');
    const ev = v.today!.events.find((e) => e.kind === 'MANUAL_STOP')!;
    expect(ev.message).toMatch(/Stopped by user — all positions squared off/);
    expect(ev.fills.map((f) => f.side)).toEqual(['BUY', 'BUY']);
    expect(broker.positions('u1').every((x) => x.netQty === 0)).toBe(true);
    expect(v.history[0]).toMatchObject({ exitKind: 'MANUAL_STOP' });
    expect(algos.userContracts()).toEqual([]);
  });

  it('missed exit across an expiry: closes at the exchange settlement price once published (incomplete until then), agreeing with the broker', async () => {
    const { p, book, algos, broker } = setupLive('09:16');
    const D = book.date; // 2026-10-12, a contract expiring today is listed
    const E = D;
    p.ref.setStrikes('NIFTY', E, strikesOf(24500, 25500, 50));
    quoteChain(p, E, 25000, { vol: 0.2 });
    const run = await algos.create('u1', { algoId: 'premium-ladder', presetId: 'strategy-2-rs20', params: {} });
    p.setNow(at(D, '09:20', 1));
    quoteChain(p, E, 25000, { vol: 0.2 });
    await algos.tick();
    let v = algos.get('u1', run.id);
    expect(v.today).toMatchObject({ expiry: E, phase: 'active' });
    const legs = v.today!.legs.map((l) => [l.type, l.strike, l.entryPrice] as const);
    expect(legs.map(([t, k]) => `${k} ${t}`)).toEqual(['25100 CE', '24900 PE']);

    // The server is down at 15:25. Next session: the contracts have expired, no settlement price yet.
    p.setNow(at('2026-10-13', '09:16'));
    quoteChain(p, W(book), 25000);
    await algos.tick();
    v = algos.get('u1', run.id);
    const pending = v.history[0];
    expect(pending).toMatchObject({ date: D, expiry: E, pnl: null, net: null });
    expect(pending.incomplete).toMatch(/Missed the 15:25 exit on 2026-10-12 — the contracts expired on 2026-10-12; awaiting the exchange settlement price for NIFTY 12-Oct-26 25100 CE, NIFTY 12-Oct-26 24900 PE/);
    expect(v.totalNet).toBeNull();
    expect(v.gaps?.totalNet).toMatch(/Result not known for 2026-10-12/);
    expect(v.today).toMatchObject({ date: '2026-10-13', phase: 'waiting' });
    expect(broker.positions('u1').filter((x) => x.status === 'awaiting settlement')).toHaveLength(2);

    // The exchange publishes the settlement (NIFTY 25150): CE 25100 settles at 50, PE 24900 at 0.
    p.history.writeSettlements([{ symbol: 'NIFTY', expiry: E, price: 25150 }]);
    await algos.tick();
    v = algos.get('u1', run.id);
    const done = v.history.find((d) => d.date === D)!;
    const expected = (legs[0][2] - 50) * 75 + (legs[1][2] - 0) * 75;
    expect(done.exitKind).toBe('MANUAL_STOP');
    expect(Math.abs((done.pnl as number) - expected)).toBeLessThanOrEqual(0.5);
    expect(done.incomplete).toBeUndefined();
    expect(done.exitReason).toMatch(/Closed at the exchange settlement price of 2026-10-12/);
    // The broker settled the same positions itself at the same prices (no orders placed for them).
    const settled = broker.positions('u1').filter((x) => x.expiry === E);
    expect(settled.every((x) => x.status === 'expired')).toBe(true);
    expect(settled.reduce((a, x) => a + x.realized, 0)).toBeCloseTo(expected, 2);
    expect(broker.orders('u1').filter((o) => o.expiry === E)).toHaveLength(2);
    expect(v.totalNet).toBe(done.net);
  });

  it('missed exit before expiry: the legs are squared off at the next session’s live prices through the broker', async () => {
    const { p, book, D, run, broker, algos } = await deployAndEnter();
    // Down at 15:25; next session 09:16 (the weekly expires today at 15:30, not yet).
    p.setNow(at('2026-10-13', '09:16'));
    quoteChain(p, W(book), 25000);
    await algos.tick();
    const v = algos.get('u1', run.id);
    const day = v.history.find((d) => d.date === D)!;
    expect(day.exitReason).toMatch(/Missed the 15:25 exit on 2026-10-12 — all positions squared off/);
    expect(day.incomplete).toBeUndefined();
    expect(typeof day.pnl).toBe('number');
    expect(broker.positions('u1').every((x) => x.netQty === 0)).toBe(true);
    expect(v.today).toMatchObject({ date: '2026-10-13', phase: 'waiting' });
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Backtests on recorded sessions                                                               */
/* ------------------------------------------------------------------------------------------ */

interface RecordedSession {
  date: string;
  expiry: string;
  vol: number;
  /** Underlying price of session minute m (test path). */
  spot: (m: number) => number;
  /** Recorded minutes [from, to) (default the whole session). */
  from?: number;
  to?: number;
}

/**
 * TEST DATA: write one recorded session into the fake intraday store (underlying minutes + a minute
 * chain of strikes 24600–25400, premiums Black-76 at the minute's close). Returns the recorded close.
 */
function recordSession(p: FakeProvider, s: RecordedSession): (type: OptionSide, strike: number, m: number) => number | null {
  const strikes = strikesOf(24600, 25400, 50);
  const close = (type: OptionSide, strike: number, m: number): number | null => {
    const c = tick5(testPremium(p, s.expiry, type, strike, s.spot(m), s.vol, p.calendar.ts(s.date, m + 1)));
    return c >= 0.05 ? c : null;
  };
  const spotBars: MinuteRecord[] = [];
  const legBars = new Map<string, MinuteRecord[]>();
  for (let m = s.from ?? 0; m < (s.to ?? 375); m++) {
    const ts = p.calendar.ts(s.date, m);
    const x = s.spot(m);
    spotBars.push({ ts, open: x, high: x, low: x, close: x, traded: true });
    for (const strike of strikes) {
      for (const type of ['CE', 'PE'] as OptionSide[]) {
        const c = close(type, strike, m);
        if (c === null) continue;
        const id = `${type}|${strike}`;
        if (!legBars.has(id)) legBars.set(id, []);
        legBars.get(id)!.push({ ts, open: c, high: c, low: c, close: c, traded: true, volume: 750, oi: 100_000 });
      }
    }
  }
  p.intraday.addMinutes(spotKey('NIFTY'), spotBars);
  for (const [id, bars] of legBars) {
    const [type, strike] = id.split('|');
    p.intraday.addMinutes(optKey('NIFTY', s.expiry, type as OptionSide, Number(strike)), bars);
  }
  return close;
}

/** Two recorded sessions: Mon 12-Oct (weekly 13-Oct, full day, +100 jump at 10:00) and Tue 13-Oct (expiry day, recording stops at 13:00). */
function setupBacktest() {
  const p = new FakeProvider({ now: at('2026-10-14', '16:00') });
  cleanup.push(() => p.dispose());
  p.ref.setUnderlying({ symbol: 'NIFTY', name: 'Nifty 50', kind: 'index', lotSize: 75, strikeStep: 50 });
  p.ref.setStrikes('NIFTY', '2026-10-13', strikesOf(24500, 25500, 50)); // still listed → lot size from the listing
  p.ref.setStrikes('NIFTY', '2026-10-20', strikesOf(24500, 25500, 50));
  const A = { date: '2026-10-12', expiry: '2026-10-13', vol: 0.14, spot: (m: number) => (m < 45 ? 25000 : 25100) };
  const B = { date: '2026-10-13', expiry: '2026-10-13', vol: 0.2, spot: (m: number) => (m < 45 ? 25000 : 24950), to: 225 };
  const closeA = recordSession(p, A);
  const closeB = recordSession(p, B);
  // A later expiry recorded too (the "next" one); it must not be taken as the current expiry.
  recordSession(p, { date: '2026-10-12', expiry: '2026-10-20', vol: 0.14, spot: A.spot });
  const db = new Db(null);
  const pricer = new Pricer(p);
  const notifier = new Notifier(db, () => p.now());
  const broker = new PaperBroker(p, db, pricer, () => p.now(), () => undefined, () => undefined);
  const algos = new AlgoService(p, db, broker, notifier, pricer);
  return { p, algos, broker, A, B, closeA, closeB };
}

/** Every Strategy 2 rule on a replayed day: entry at 09:20, strict OTM multiples of 100 nearest the target, ±50 % ladder, recorded fill prices. */
function checkRules(d: AlgoBacktestDay, close: (type: OptionSide, strike: number, m: number) => number | null, date: string, flat = true) {
  const minuteOf = (ts: number) => Math.round((ts - at(date, '09:15')) / MINUTE);
  const spotAt = (ts: number) => d.series.find((x) => x.ts === ts)!.spot as number;
  const entry = d.events.find((e) => e.kind === 'ENTRY')!;
  expect(istHhmm(entry.ts)).toBe('09:20');
  let level = 20;
  for (const e of d.events) {
    for (const f of e.fills) {
      if (e.kind === 'MANUAL_STOP' && /settlement/.test(e.message)) continue;
      // Fills at the recorded last price as of the step (the minute that just completed).
      expect(f.price).toBe(close(f.type, f.strike, minuteOf(e.ts) - 1));
      if (f.side !== 'SELL') continue;
      expect(f.strike % 100).toBe(0);
      if (f.type === 'CE') expect(f.strike).toBeGreaterThan(spotAt(e.ts));
      else expect(f.strike).toBeLessThan(spotAt(e.ts));
      // Nearest eligible recorded premium to the target level.
      const target = e.kind === 'ENTRY' ? 20 : Number(e.data!.level);
      const m = minuteOf(e.ts) - 1;
      for (let k = 24600; k <= 25400; k += 100) {
        const otm = f.type === 'CE' ? k > spotAt(e.ts) : k < spotAt(e.ts);
        const px = close(f.type, k, m);
        if (!otm || px === null || px <= 0.05) continue;
        expect(Math.abs(px - target)).toBeGreaterThanOrEqual(Math.abs(f.price - target) - 1e-9);
      }
    }
    if (e.kind === 'ADJUSTMENT' && e.fills.length) {
      expect(Number(e.data!.level)).toBeGreaterThanOrEqual(level * 1.5 - 1e-6);
      level = Number(e.data!.level);
      expect(e.fills.map((f) => f.side)).toEqual(['BUY', 'SELL']);
    }
  }
  // Flat at the end of the day: every sold option was bought back.
  const all = d.events.flatMap((e) => e.fills);
  if (flat) expect(all.filter((f) => f.side === 'BUY').length).toBe(all.filter((f) => f.side === 'SELL').length);
}

describe('backtests replay recorded sessions only', () => {
  it('replays a full recorded session minute by minute: entry 09:20, one +50 % adjustment, exit 15:25', async () => {
    const { algos, A, closeA } = setupBacktest();
    const d = await algos.backtestDay('premium-ladder', { symbol: 'NIFTY' }, A.date);
    expect(d).toMatchObject({ date: A.date, expiry: '2026-10-13', partial: false, lotSize: 75, entered: true, exitKind: 'EXIT', adjustments: 1 });
    expect(d.incomplete).toBeUndefined();
    // One point per recorded minute (09:16 … 15:30); 09:15 has no completed minute yet.
    expect(d.series).toHaveLength(375);
    expect(istHhmm(d.series[0].ts)).toBe('09:16');
    checkRules(d, closeA, A.date);
    const entry = d.events.find((e) => e.kind === 'ENTRY')!;
    expect(entry.fills.map((f) => `${f.side} ${f.strike} ${f.type}`)).toEqual(['SELL 25200 CE', 'SELL 24800 PE']);
    const adj = d.events.find((e) => e.kind === 'ADJUSTMENT')!;
    expect(istHhmm(adj.ts)).toBe('10:01'); // the 10:00 minute (spot 25100) completes at 10:01
    expect(adj.fills.map((f) => `${f.side} ${f.strike} ${f.type}`)).toEqual(['BUY 24800 PE', 'SELL 25000 PE']);
    const exit = d.events.find((e) => e.kind === 'EXIT')!;
    expect(istHhmm(exit.ts)).toBe('15:25');
    expect(d.net).toBe((d.pnl as number) - d.charges);
    expect(d.series[d.series.length - 1].mtm).toBe(d.pnl);
    expect(d.series.every((x) => x.spot === 25000 || x.spot === 25100)).toBe(true);
  });

  it('a recording that stops before the exit on expiry day: closed at the settlement price when published, else incomplete', async () => {
    const { p, algos, B, closeB } = setupBacktest();
    let d = await algos.backtestDay('premium-ladder', { symbol: 'NIFTY' }, B.date);
    expect(d.series).toHaveLength(225); // 09:16 … 13:00
    checkRules(d, closeB, B.date, false);
    expect(d.events.find((e) => e.kind === 'ENTRY')!.fills.map((f) => `${f.strike} ${f.type}`)).toEqual(['25100 CE', '24900 PE']);
    expect(d.pnl).toBeNull();
    expect(d.net).toBeNull();
    expect(d.incomplete).toMatch(/Recording of 2026-10-13 ended at 13:00, before the 15:25 exit; the contracts expired and the exchange settlement price is not published yet/);

    p.history.writeSettlements([{ symbol: 'NIFTY', expiry: '2026-10-13', price: 25150 }]);
    d = await algos.backtestDay('premium-ladder', { symbol: 'NIFTY' }, B.date);
    checkRules(d, closeB, B.date);
    expect(d.incomplete).toBeUndefined();
    const close = d.events.at(-1)!;
    expect(close.message).toMatch(/Recording ended at 13:00, before the 15:25 exit — the contracts expired on 2026-10-13: closed at the exchange settlement price/);
    expect(close.fills.map((f) => [f.side, f.strike, f.type, f.price])).toEqual([['BUY', 25100, 'CE', 50], ['BUY', 24900, 'PE', 0]]);
    const sold = d.events.find((e) => e.kind === 'ENTRY')!.fills;
    expect(d.pnl).toBe(Math.round((sold[0].price - 50 + sold[1].price - 0) * 75));
  });

  it('backtest range: replays the recorded sessions, lists the unrecorded ones as skipped, stats over complete days', async () => {
    const { algos } = setupBacktest();
    const r = await algos.backtestRange('premium-ladder', { symbol: 'NIFTY' }, 4);
    expect(r).toMatchObject({ from: '2026-10-09', to: '2026-10-14', recordedFrom: '2026-10-12' });
    expect(r.days.map((d) => d.date)).toEqual(['2026-10-12', '2026-10-13']);
    expect(r.skipped).toEqual([
      { date: '2026-10-09', reason: 'No recorded market data for 2026-10-09 — recording started 2026-10-12' },
      { date: '2026-10-14', reason: 'No recorded market data for 2026-10-14 — recording started 2026-10-12' },
    ]);
    // 13-Oct is incomplete (no settlement yet): left out of stats and equity.
    expect(r.days[1].incomplete).toBeTruthy();
    expect(r.stats).toMatchObject({ days: 1, tradedDays: 1, incompleteDays: 1, skippedDays: 2 });
    expect(r.equity).toEqual([{ date: '2026-10-12', net: r.days[0].net, cum: r.days[0].net }]);
    expect(r.stats.totalNet).toBe(r.days[0].net);
    expect(r.stats.bestDay).toBe(r.days[0].net);
    // The same day as the single-day replay.
    const single = await algos.backtestDay('premium-ladder', { symbol: 'NIFTY' }, '2026-10-12');
    expect(r.days[0]).toMatchObject({ pnl: single.pnl, net: single.net, adjustments: single.adjustments, exitKind: single.exitKind });
  });

  it('chooses the expiry per session from the recorded chain ("next" = the second recorded expiry)', async () => {
    const { algos } = setupBacktest();
    const next = await algos.backtestDay('premium-ladder', { symbol: 'NIFTY', expiry: 'next' }, '2026-10-12');
    expect(next.expiry).toBe('2026-10-20');
    await expect(algos.backtestDay('premium-ladder', { symbol: 'NIFTY', expiry: 'next' }, '2026-10-13')).rejects.toThrow(/Only the 2026-10-13 NIFTY expiry was recorded on 2026-10-13/);
  });

  it('503 without recordings; unrecorded dates, unknown lot sizes and late recordings are not replayed', async () => {
    const p = new FakeProvider({ now: at('2026-10-14', '16:00') });
    cleanup.push(() => p.dispose());
    p.ref.setUnderlying({ symbol: 'NIFTY', name: 'Nifty 50', kind: 'index', lotSize: 75, strikeStep: 50 });
    p.ref.setStrikes('NIFTY', '2026-10-20', strikesOf(24500, 25500, 50));
    const db = new Db(null);
    const pricer = new Pricer(p);
    const algos = new AlgoService(p, db, new PaperBroker(p, db, pricer, () => p.now(), () => undefined, () => undefined), new Notifier(db, () => p.now()), pricer);

    await expect(algos.backtestRange('premium-ladder', { symbol: 'NIFTY' }, 20)).rejects.toThrow(NoLiveData);
    await expect(algos.backtestRange('premium-ladder', { symbol: 'NIFTY' }, 20)).rejects.toThrow(/No session has been recorded yet/);
    await expect(algos.backtestDay('premium-ladder', { symbol: 'NIFTY' }, '2026-10-12')).rejects.toThrow('No recorded market data for 2026-10-12: no session has been recorded yet');

    // A session on an expiry that is no longer listed: lot size only from the official file of the day.
    recordSession(p, { date: '2026-10-05', expiry: '2026-10-06', vol: 0.14, spot: () => 25000 });
    await expect(algos.backtestDay('premium-ladder', { symbol: 'NIFTY' }, '2026-10-05')).rejects.toThrow(
      /Lot size of the NIFTY 2026-10-06 contracts is unknown: they are no longer in the instrument master and the official F&O file for 2026-10-05 is not loaded/,
    );
    p.history.writeFo('2026-10-05', { options: [{ symbol: 'NIFTY', date: '2026-10-05', expiry: '2026-10-06', strike: 25000, type: 'CE', close: 80, oi: 1000, volume: 500, lotSize: 65 }] });
    const d = await algos.backtestDay('premium-ladder', { symbol: 'NIFTY' }, '2026-10-05');
    expect(d.lotSize).toBe(65);
    expect(d.entered).toBe(true);

    // Recording started after the 09:20 entry: not replayed.
    recordSession(p, { date: '2026-10-07', expiry: '2026-10-20', vol: 0.14, spot: () => 25000, from: 30 });
    await expect(algos.backtestDay('premium-ladder', { symbol: 'NIFTY' }, '2026-10-07')).rejects.toThrow('Recording of 2026-10-07 started at 09:45, after the 09:20 entry');
    // Another underlying was not recorded at all.
    p.ref.setUnderlying({ symbol: 'BANKNIFTY', name: 'Nifty Bank', kind: 'index', lotSize: 35, strikeStep: 100 });
    await expect(algos.backtestDay('premium-ladder', { symbol: 'BANKNIFTY' }, '2026-10-05')).rejects.toThrow('No recorded BANKNIFTY option chain for 2026-10-05');

    const r = await algos.backtestRange('premium-ladder', { symbol: 'NIFTY' }, 8);
    expect(r.days.map((x) => x.date)).toEqual(['2026-10-05']);
    expect(r.skipped.find((x) => x.date === '2026-10-07')?.reason).toMatch(/started at 09:45/);
    expect(r.skipped.find((x) => x.date === '2026-10-06')?.reason).toBe('No recorded market data for 2026-10-06 — recording started 2026-10-05');
  });

  it('minutes without recorded data are not replayed (reported as a pause); the official file decides the nearest expiry', async () => {
    const { p, algos } = setupBacktest();
    // Fri 09-Oct on the 13-Oct expiry (₹40 start), with the recorder down 11:00–11:30 (TEST DATA).
    const q = { date: '2026-10-09', expiry: '2026-10-13', vol: 0.14, spot: () => 25000 };
    recordSession(p, { ...q, to: 105 });
    recordSession(p, { ...q, from: 135 });
    const d = await algos.backtestDay('premium-ladder', { symbol: 'NIFTY', startPremium: 40 }, '2026-10-09');
    expect(d.entered).toBe(true);
    const pause = d.events.find((e) => e.kind === 'INFO')!;
    expect(pause.message).toBe('No recorded NIFTY data 11:00–11:30: the algo was paused');
    expect(d.series.some((x) => x.ts > at('2026-10-09', '11:00') && x.ts <= at('2026-10-09', '11:30'))).toBe(false);
    expect(d.series).toHaveLength(375 - 30);
    expect(d.exitKind).toBe('EXIT');
    // The official F&O file of the day lists a nearer expiry (09-Oct) that was not recorded: not replayed.
    p.history.writeFo('2026-10-09', {
      options: [
        { symbol: 'NIFTY', date: '2026-10-09', expiry: '2026-10-09', strike: 25000, type: 'CE', close: 40, oi: 1000, volume: 500, lotSize: 75 },
        { symbol: 'NIFTY', date: '2026-10-09', expiry: '2026-10-13', strike: 25000, type: 'CE', close: 90, oi: 1000, volume: 500, lotSize: 75 },
      ],
    });
    await expect(algos.backtestDay('premium-ladder', { symbol: 'NIFTY', startPremium: 40 }, '2026-10-09')).rejects.toThrow(
      'The current NIFTY expiry on 2026-10-09 was 2026-10-09 (official F&O file), and its chain was not recorded',
    );
  });

  it("today's session replays up to now (partial) and never looks ahead", async () => {
    const p = new FakeProvider({ now: at('2026-10-12', '10:30', 20) });
    cleanup.push(() => p.dispose());
    p.ref.setUnderlying({ symbol: 'NIFTY', name: 'Nifty 50', kind: 'index', lotSize: 75, strikeStep: 50 });
    p.ref.setStrikes('NIFTY', '2026-10-13', strikesOf(24500, 25500, 50));
    // The store holds the whole day (test data), but only minutes completed by 10:30:20 may be used.
    recordSession(p, { date: '2026-10-12', expiry: '2026-10-13', vol: 0.14, spot: (m) => (m < 45 ? 25000 : 25100) });
    const db = new Db(null);
    const pricer = new Pricer(p);
    const algos = new AlgoService(p, db, new PaperBroker(p, db, pricer, () => p.now(), () => undefined, () => undefined), new Notifier(db, () => p.now()), pricer);
    const d = await algos.backtestDay('premium-ladder', { symbol: 'NIFTY' }, undefined);
    expect(d.partial).toBe(true);
    expect(d.date).toBe('2026-10-12');
    expect(istHhmm(d.series.at(-1)!.ts)).toBe('10:30');
    expect(d.series.every((x) => x.ts <= p.now())).toBe(true);
    expect(d.exitKind).toBe('NONE');
    expect(typeof d.pnl).toBe('number');
    expect(d.incomplete).toBeUndefined();
  });
});

describe('algo routes', () => {
  it('serves the catalogue, 503 + NO_LIVE_DATA for an unrecorded backtest day, and runs for a signed-in user', async () => {
    const p = new FakeProvider();
    cleanup.push(() => p.dispose());
    const book = loadSampleBook(p, { time: '09:16' });
    const svc = createServices(loadConfig({ persist: false, authSecret: 'test-secret' }), { provider: p });
    const app: FastifyInstance = await buildApp(svc, { serveWeb: false });
    cleanup.push(() => svc.stop(), () => app.close());
    const call = async (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, token?: string) => {
      const r = await app.inject({ method, url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
      return { status: r.statusCode, body: r.json() };
    };
    const cat = await call('GET', '/api/algos');
    expect(cat.status).toBe(200);
    expect((cat.body as AlgoCatalog).symbols.map((s) => s.symbol)).toEqual(['NIFTY', 'BANKNIFTY']);
    // The sample book recorded the previous session only.
    const day = await call('POST', '/api/algos/premium-ladder/backtest', { params: { symbol: 'NIFTY' }, date: '2026-10-08' });
    expect(day.status).toBe(503);
    expect(day.body).toEqual({ error: `No recorded market data for 2026-10-08 — recording started ${book.recordedDate}`, code: 'NO_LIVE_DATA' });
    expect((await call('POST', '/api/algos/premium-ladder/backtest', { params: { symbol: 'NIFTY', exitTime: '09:10' } })).status).toBe(400);
    expect((await call('GET', '/api/algos/nope/defaults')).status).toBe(404);

    const token = ((await call('POST', '/api/auth/guest', {})).body as { token: string }).token;
    quoteChain(p, W(book), 25000);
    const created = await call('POST', '/api/algo-runs', { algoId: 'premium-ladder', presetId: 'strategy-2-rs20', params: {} }, token);
    expect(created.status).toBe(200);
    const run = created.body as AlgoRunView;
    expect(run.today?.phase).toBe('waiting');
    // The provider's user tier picks up the run's open legs once it has entered.
    p.setNow(at(book.date, '09:20', 1));
    quoteChain(p, W(book), 25000);
    await svc.algos.tick();
    const ids = p.userContracts().map((c) => keyId('key' in c ? c.key : c));
    expect(ids).toContain(keyId(optKey('NIFTY', W(book), 'CE', 25200)));
    const listed = await call('GET', '/api/algo-runs', undefined, token);
    expect((listed.body as AlgoRunView[])[0].today?.phase).toBe('active');
    const stopped = await call('POST', `/api/algo-runs/${run.id}/stop`, {}, token);
    expect((stopped.body as AlgoRunView).status).toBe('stopped');
    expect((await call('DELETE', `/api/algo-runs/${run.id}`, undefined, token)).status).toBeLessThan(300);
  });
});
