import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AlgoBacktestDay, AlgoBacktestRange, AlgoCatalog, AlgoRunView, Order, Position } from '@q26/core';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createServices, type Services } from '../src/services';

// Movable wall clock; the demo session starts at 09:18 IST on Fri 9-Oct-2026.
let wall = Date.now();
let app: FastifyInstance;
let svc: Services;
let token = '';

const call = async <T,>(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown): Promise<{ status: number; body: T }> => {
  const r = await app.inject({ method, url, payload: payload as object, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: r.json() as T };
};
const advance = (minutes: number) => {
  wall += minutes * 60_000;
  svc.broker.tick();
  svc.algos.tick();
};

beforeAll(async () => {
  svc = createServices(loadConfig({ persist: false, simStart: '2026-10-09T09:18', clockMode: 'demo', authSecret: 'test' }), { now: () => wall });
  app = await buildApp(svc, { serveWeb: false });
  token = (await call<{ token: string }>('POST', '/api/auth/guest', {})).body.token;
});

afterAll(async () => {
  svc.stop();
  await app.close();
});

describe('algo catalogue and backtests', () => {
  it('lists the Strategy 2 preset', async () => {
    const c = (await call<AlgoCatalog>('GET', '/api/algos')).body;
    expect(c.algos.map((a) => a.id)).toContain('premium-ladder');
    const p = c.presets.find((x) => x.id === 'strategy-2-rs20')!;
    expect(p.params).toMatchObject({ symbol: 'NIFTY', startPremium: 20, stepPct: 50, strikeMultiple: 100, entryTime: '09:20', exitTime: '15:25' });
    expect(c.symbols.some((s) => s.symbol === 'NIFTY')).toBe(true);
    const d = (await call<Record<string, unknown>>('GET', '/api/algos/premium-ladder/defaults?symbol=BANKNIFTY')).body;
    expect(d.strikeMultiple).toBe(100);
    expect((await call('GET', '/api/algos/nope/defaults')).status).toBe(404);
  });

  it('replays a past session minute by minute and obeys every rule', async () => {
    const r = await call<AlgoBacktestDay>('POST', '/api/algos/premium-ladder/backtest', { params: { symbol: 'NIFTY' }, date: '2026-10-08' });
    expect(r.status).toBe(200);
    const d = r.body;
    expect(d.partial).toBe(false);
    expect(d.series).toHaveLength(376);
    const entry = d.events.find((e) => e.kind === 'ENTRY');
    if (!entry) {
      expect(d.exitKind).toBe('STOP');
      return;
    }
    // 1. entry exactly at 09:20 IST
    expect(new Date(entry.ts + 5.5 * 3600_000).toISOString().slice(11, 16)).toBe('09:20');
    const spotAt = (ts: number) => d.series.find((p) => p.ts === ts)!.spot;
    let level = 20;
    for (const e of d.events) {
      for (const f of e.fills) {
        if (f.side !== 'SELL') continue;
        // 2/6. every sold option is OTM and a multiple of 100
        expect(f.strike % 100).toBe(0);
        if (f.type === 'CE') expect(f.strike).toBeGreaterThan(spotAt(e.ts));
        else expect(f.strike).toBeLessThan(spotAt(e.ts));
      }
      if (e.kind === 'ADJUSTMENT' && e.fills.length) {
        // 3–5. levels climb by 50% steps and the rolled leg is sold near the new level
        expect(Number(e.data!.level)).toBeGreaterThanOrEqual(level * 1.5 - 1e-6);
        level = Number(e.data!.level);
        expect(e.fills.map((f) => f.side)).toEqual(['BUY', 'SELL']);
      }
    }
    // 8. flat at 15:25 (or earlier if stopped)
    const exit = d.events.find((e) => e.kind === 'EXIT' || e.kind === 'STOP')!;
    expect(exit).toBeTruthy();
    if (exit.kind === 'EXIT') expect(new Date(exit.ts + 5.5 * 3600_000).toISOString().slice(11, 16)).toBe('15:25');
    const sells = d.events.flatMap((e) => e.fills).filter((f) => f.side === 'SELL').length;
    const buys = d.events.flatMap((e) => e.fills).filter((f) => f.side === 'BUY').length;
    expect(buys).toBe(sells);
    expect(d.net).toBe(d.pnl - d.charges);
    expect(d.series[d.series.length - 1].mtm).toBe(d.pnl);
  });

  it('stops for the day when no OTM strike is near the required premium', async () => {
    // A tiny tolerance forces the "no eligible strike" rule.
    const d = (await call<AlgoBacktestDay>('POST', '/api/algos/premium-ladder/backtest', { params: { symbol: 'NIFTY', maxGapPct: 1 }, date: '2026-10-07' })).body;
    expect(d.exitKind).toBe('STOP');
    expect(d.exitReason).toMatch(/No OTM|No eligible/);
    const stopIdx = d.events.findIndex((e) => e.kind === 'STOP');
    expect(d.events.slice(stopIdx + 1).every((e) => e.fills.length === 0)).toBe(true);
  });

  it('summarises many sessions', async () => {
    const r = (await call<AlgoBacktestRange>('POST', '/api/algos/premium-ladder/backtest-range', { params: { symbol: 'NIFTY' }, days: 20 })).body;
    expect(r.days).toHaveLength(20);
    expect(r.to < '2026-10-09').toBe(true); // today is not finished
    expect(r.stats.totalNet).toBe(r.days.reduce((a, d) => a + d.net, 0));
    expect(r.equity[r.equity.length - 1].cum).toBe(r.stats.totalNet);
    expect(r.stats.winDays + r.stats.lossDays).toBeLessThanOrEqual(r.stats.tradedDays);
  });

  it('rejects invalid parameters', async () => {
    expect((await call('POST', '/api/algos/premium-ladder/backtest', { params: { symbol: 'NIFTY', exitTime: '09:10' } })).status).toBe(400);
    expect((await call('POST', '/api/algos/premium-ladder/backtest', { params: { symbol: 'NOPE' } })).status).toBe(404);
    expect((await call('POST', '/api/algos/premium-ladder/backtest', { params: { symbol: 'NIFTY' }, date: '2026-10-04' })).status).toBe(400);
  });
});

describe('Strategy 3 (starting premium ₹50)', () => {
  it('is in the catalogue next to Strategy 2', async () => {
    const c = (await call<AlgoCatalog>('GET', '/api/algos')).body;
    const p = c.presets.find((x) => x.id === 'strategy-3-rs50')!;
    expect(p.name).toBe('Strategy 3 · Starting premium ₹50');
    expect(p.params).toMatchObject({ symbol: 'NIFTY', startPremium: 50, stepPct: 50, strikeMultiple: 100, entryTime: '09:20', exitTime: '15:25' });
  });

  it('replays sessions obeying every rule from ₹50', async () => {
    for (const date of ['2026-10-01', '2026-10-05', '2026-10-08']) {
      const d = (await call<AlgoBacktestDay>('POST', '/api/algos/premium-ladder/backtest', { params: { symbol: 'NIFTY', startPremium: 50 }, date })).body;
      const spotAt = (ts: number) => d.series.find((p) => p.ts === ts)!.spot;
      let level = 50;
      for (const e of d.events) {
        for (const f of e.fills) {
          if (f.side !== 'SELL') continue;
          expect(f.strike % 100).toBe(0);
          if (f.type === 'CE') expect(f.strike).toBeGreaterThan(spotAt(e.ts));
          else expect(f.strike).toBeLessThan(spotAt(e.ts));
        }
        if (e.kind === 'ADJUSTMENT' && e.fills.length) {
          const next = Number(e.data!.level);
          const n = Math.log(next / 50) / Math.log(1.5);
          expect(Math.abs(n - Math.round(n))).toBeLessThan(1e-6);
          expect(next).toBeGreaterThan(level);
          level = next;
          expect(e.fills.map((f) => f.side)).toEqual(['BUY', 'SELL']);
          expect(e.fills[0].type).toBe(e.fills[1].type); // the same (opposite) side is rolled
        }
      }
      const fills = d.events.flatMap((e) => e.fills);
      expect(fills.filter((f) => f.side === 'BUY').length).toBe(fills.filter((f) => f.side === 'SELL').length);
    }
  });

  it('backtests with ₹50 entries and a 50 → 75 → 112.5 ladder', async () => {
    const r = await call<AlgoBacktestRange>('POST', '/api/algos/premium-ladder/backtest-range', { params: { symbol: 'NIFTY', startPremium: 50 }, days: 30 });
    expect(r.status).toBe(200);
    expect(r.body.stats.tradedDays).toBeGreaterThan(20);
    for (const d of r.body.days.filter((x) => x.maxLevel > 0)) {
      // every level reached is 50 × 1.5^n
      const n = Math.log(d.maxLevel / 50) / Math.log(1.5);
      expect(Math.abs(n - Math.round(n))).toBeLessThan(1e-9);
    }
    const day = (await call<AlgoBacktestDay>('POST', '/api/algos/premium-ladder/backtest', { params: { symbol: 'NIFTY', startPremium: 50 }, date: '2026-10-08' })).body;
    const entry = day.events.find((e) => e.kind === 'ENTRY');
    if (entry) {
      for (const f of entry.fills) expect(Math.abs(f.price - 50) / 50).toBeLessThanOrEqual(0.5);
      const d20 = (await call<AlgoBacktestDay>('POST', '/api/algos/premium-ladder/backtest', { params: { symbol: 'NIFTY' }, date: '2026-10-08' })).body;
      const e20 = d20.events.find((e) => e.kind === 'ENTRY')!;
      const ce = (ev: typeof entry) => ev.fills.find((f) => f.type === 'CE')!.strike;
      expect(ce(entry)).toBeLessThan(ce(e20)); // ₹50 sits closer to the money than ₹20
    }
  });
});

describe('presets on deployment', () => {
  it('fills missing settings from the preset and keeps its name only while unchanged', async () => {
    const preset = (await call<AlgoRunView>('POST', '/api/algo-runs', { algoId: 'premium-ladder', presetId: 'strategy-3-rs50', params: { symbol: 'NIFTY', lots: 1 } })).body;
    expect(preset.params.startPremium).toBe(50);
    expect(preset.name).toBe('Strategy 3 · Starting premium ₹50');
    expect(preset.presetId).toBe('strategy-3-rs50');
    const blank = (await call<AlgoRunView>('POST', '/api/algo-runs', { algoId: 'premium-ladder', presetId: 'strategy-3-rs50', params: { startPremium: '' } })).body;
    expect(blank.params.startPremium).toBe(50);
    const edited = (await call<AlgoRunView>('POST', '/api/algo-runs', { algoId: 'premium-ladder', presetId: 'strategy-3-rs50', params: { startPremium: 30 } })).body;
    expect(edited.params.startPremium).toBe(30);
    expect(edited.name).toBe('Premium ladder · ₹30 start');
    expect(edited.presetId).toBeUndefined();
    expect((await call('POST', '/api/algo-runs', { algoId: 'premium-ladder', presetId: 'nope', params: {} })).status).toBe(404);
    for (const r of [preset, blank, edited]) {
      await call('POST', `/api/algo-runs/${r.id}/stop`, {});
      await call('DELETE', `/api/algo-runs/${r.id}`);
    }
  });
});

describe('live paper deployment', () => {
  let run: AlgoRunView;

  it('waits for 09:20, then sells both legs through the paper broker', async () => {
    const r = await call<AlgoRunView>('POST', '/api/algo-runs', { algoId: 'premium-ladder', presetId: 'strategy-2-rs20', params: { symbol: 'NIFTY', lots: 1 } });
    expect(r.status).toBe(200);
    run = r.body;
    expect(run.status).toBe('running');
    expect(run.name).toMatch(/Strategy 2/);
    expect(run.today?.phase).toBe('waiting');
    advance(2.5); // 09:20:30
    run = (await call<AlgoRunView>('GET', `/api/algo-runs/${run.id}`)).body;
    expect(run.today?.phase).toBe('active');
    expect(run.today?.legs).toHaveLength(2);
    const orders = (await call<Order[]>('GET', '/api/broker/orders')).body.filter((o) => o.tag === `algo:${run.id}`);
    expect(orders).toHaveLength(2);
    expect(orders.every((o) => o.status === 'COMPLETE' && o.side === 'SELL' && o.product === 'MIS' && o.strike! % 100 === 0)).toBe(true);
    const notes = (await call<{ title: string }[]>('GET', '/api/notifications')).body;
    expect(notes.some((n) => /Algo entry/.test(n.title))).toBe(true);
  });

  it('keeps broker positions in sync with the algo through adjustments', async () => {
    for (let i = 0; i < 120; i++) advance(2); // → ~13:20
    run = (await call<AlgoRunView>('GET', `/api/algo-runs/${run.id}`)).body;
    const pos = (await call<Position[]>('GET', '/api/broker/positions')).body.filter((p) => p.netQty !== 0);
    const legs = run.today!.legs;
    if (run.today!.phase === 'active') {
      expect(pos).toHaveLength(legs.length);
      for (const l of legs) expect(pos.find((p) => p.strike === l.strike && p.type === l.type)?.netQty).toBe(-l.lots * 65);
    } else {
      expect(pos).toHaveLength(0);
    }
    expect(run.today!.series.length).toBeGreaterThan(100);
  });

  it('stops with a square-off on request and can then be deleted', async () => {
    expect((await call('DELETE', `/api/algo-runs/${run.id}`)).status).toBe(400);
    const stopped = (await call<AlgoRunView>('POST', `/api/algo-runs/${run.id}/stop`, {})).body;
    expect(stopped.status).toBe('stopped');
    expect(stopped.today!.legs).toHaveLength(0);
    const pos = (await call<Position[]>('GET', '/api/broker/positions')).body.filter((p) => p.netQty !== 0);
    expect(pos).toHaveLength(0);
    expect(stopped.history).toHaveLength(1);
    expect((await call('POST', `/api/algo-runs/${run.id}/stop`, {})).status).toBe(400);
    expect((await call('DELETE', `/api/algo-runs/${run.id}`)).status).toBe(200);
    expect((await call<AlgoRunView[]>('GET', '/api/algo-runs')).body).toHaveLength(0);
  });

  it('exits at 15:25 and trades again the next session', async () => {
    const r = (await call<AlgoRunView>('POST', '/api/algo-runs', { algoId: 'premium-ladder', params: { symbol: 'NIFTY' } })).body;
    expect(r.today?.phase).toBe('active'); // deployed mid-session → enters straight away
    const day1 = r.today!.date;
    let v = r;
    for (let i = 0; i < 80 && v.today!.phase === 'active'; i++) {
      advance(2);
      v = (await call<AlgoRunView>('GET', `/api/algo-runs/${r.id}`)).body;
    }
    expect(v.today!.date).toBe(day1);
    expect(v.history).toHaveLength(1);
    expect(['EXIT', 'STOP']).toContain(v.history[0].exitKind);
    if (v.history[0].exitKind === 'EXIT') expect(svc.clock.info().time >= '15:25').toBe(true);
    const pos = (await call<Position[]>('GET', '/api/broker/positions')).body.filter((p) => p.netQty !== 0);
    expect(pos).toHaveLength(0);
    for (let i = 0; i < 80 && v.today!.date === day1; i++) {
      advance(2);
      v = (await call<AlgoRunView>('GET', `/api/algo-runs/${r.id}`)).body;
    }
    expect(v.today!.date > day1).toBe(true);
    expect(v.today!.phase).toBe('waiting'); // a new session waits for 09:20 again
    for (let i = 0; i < 4; i++) advance(2);
    v = (await call<AlgoRunView>('GET', `/api/algo-runs/${r.id}`)).body;
    expect(['active', 'stopped']).toContain(v.today!.phase);
    await call('POST', `/api/algo-runs/${r.id}/stop`, {});
  });

  it('requires a signed-in user and validates input', async () => {
    const saved = token;
    token = '';
    expect((await call('GET', '/api/algo-runs')).status).toBe(401);
    token = saved;
    expect((await call('POST', '/api/algo-runs', { algoId: 'premium-ladder', params: { lots: 0 } })).status).toBe(400);
    expect((await call('POST', '/api/algo-runs', { algoId: 'nope', params: {} })).status).toBe(404);
  });
});

describe('missed exit across an expiry', () => {
  it('closes the legs at settlement and agrees with the broker', async () => {
    let w = Date.now();
    // Tue 6-Oct-2026 is a NIFTY weekly expiry.
    const s2 = createServices(loadConfig({ persist: false, simStart: '2026-10-06T09:18', authSecret: 'test' }), { now: () => w });
    const uid = 'expiry-user';
    // A wide premium tolerance keeps the ladder open into the close on expiry day.
    const run = s2.algos.create(uid, { algoId: 'premium-ladder', presetId: 'strategy-3-rs50', params: { maxGapPct: 100 } });
    const step = (m: number) => {
      w += m * 60_000;
      s2.broker.tick();
      s2.algos.tick();
    };
    for (let i = 0; i < 180; i++) step(2); // → 15:18
    const before = s2.algos.get(uid, run.id);
    expect(before.today?.phase).toBe('active');
    expect(before.today!.expiry).toBe('2026-10-06');
    expect(before.today!.legs).toHaveLength(2);
    w += 3 * 60 * 60_000; // server paused through the close → next session
    s2.broker.tick();
    s2.algos.tick();
    const after = s2.algos.get(uid, run.id);
    const day = after.history.find((d) => d.date === '2026-10-06')!;
    expect(day.exitReason).toMatch(/expired, closed at settlement/);
    const pos = s2.broker.positions(uid).filter((p) => p.expiry === '2026-10-06');
    expect(pos.every((p) => p.netQty === 0)).toBe(true);
    const brokerPnl = pos.reduce((a, p) => a + p.pnl, 0);
    expect(Math.abs(day.pnl - brokerPnl)).toBeLessThanOrEqual(1);
    expect(s2.broker.orders(uid).filter((o) => o.status === 'REJECTED')).toHaveLength(0);
    s2.stop();
  });
});
