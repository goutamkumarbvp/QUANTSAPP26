import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Candle, OrbHistoryResponse, OrbResponse, OrbScanRow, OrderFlowResponse } from '@q26/core';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createServices, type Services } from '../src/services';

// A wall clock we can move: the demo session starts at 09:20 IST on Fri 9-Oct-2026.
let wall = Date.now();
let app: FastifyInstance;
let svc: Services;
let token = '';

const get = async <T,>(url: string): Promise<{ status: number; body: T }> => {
  const r = await app.inject({ method: 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {} });
  return { status: r.statusCode, body: r.json() as T };
};
const post = async <T,>(url: string, payload: unknown): Promise<{ status: number; body: T }> => {
  const r = await app.inject({ method: 'POST', url, payload: payload as object, headers: { authorization: `Bearer ${token}` } });
  return { status: r.statusCode, body: r.json() as T };
};
const advanceMinutes = (m: number) => {
  wall += m * 60_000;
};

beforeAll(async () => {
  svc = createServices(loadConfig({ persist: false, simStart: '2026-10-09T09:20', clockMode: 'demo', authSecret: 'test' }), { now: () => wall });
  app = await buildApp(svc, { serveWeb: false });
  token = (await post<{ token: string }>('/api/auth/guest', {})).body.token;
});

afterAll(async () => {
  svc.stop();
  await app.close();
});

describe('opening range breakout', () => {
  it('is forming before 09:30 and complete after', async () => {
    const early = (await get<OrbResponse>('/api/orb/NIFTY')).body;
    expect(early.evaluation.trend).toBe('forming');
    expect(early.evaluation.complete).toBe(false);
    expect(early.bars.length).toBe(5); // exactly 09:20:00 → five completed minutes
    advanceMinutes(0.5); // 09:20:30 → a sixth, still-forming candle closes at the live price
    const mid = (await get<OrbResponse>('/api/orb/NIFTY')).body;
    expect(mid.bars.length).toBe(6);
    expect(mid.bars[5].close).toBe(mid.ltp);
    advanceMinutes(129.5); // → 11:30
    const later = (await get<OrbResponse>('/api/orb/NIFTY')).body;
    expect(later.evaluation.complete).toBe(true);
    expect(later.evaluation.trend).not.toBe('forming');
  });

  it('uses exactly the first 15-minute candle high and low', async () => {
    for (const s of ['NIFTY', 'BANKNIFTY', 'RELIANCE']) {
      const orb = (await get<OrbResponse>(`/api/orb/${s}`)).body;
      const c15 = (await get<Candle[]>(`/api/candles/${s}?interval=15`)).body[0];
      expect(orb.evaluation.high, s).toBe(c15.high);
      expect(orb.evaluation.low, s).toBe(c15.low);
      expect(orb.rangeEndTs - orb.rangeStartTs).toBe(15 * 60_000);
    }
  });

  it('agrees with its own candles about breaks', async () => {
    const orb = (await get<OrbResponse>('/api/orb/NIFTY')).body;
    const e = orb.evaluation;
    for (const b of e.crossings) {
      const bar = orb.bars.find((x) => x.ts === b.ts)!;
      expect(bar).toBeTruthy();
      expect(b.ts).toBeGreaterThanOrEqual(orb.rangeEndTs);
      if (b.direction === 'up') expect(bar.close).toBeGreaterThan(e.high);
      else expect(bar.close).toBeLessThan(e.low);
    }
    // No completed post-range candle before the first break closes outside the range.
    const first = e.crossings[0]?.ts ?? Infinity;
    for (const bar of orb.bars) {
      if (bar.ts >= orb.rangeEndTs && bar.ts < first && bar !== orb.bars[orb.bars.length - 1]) {
        expect(bar.close).toBeLessThanOrEqual(e.high);
        expect(bar.close).toBeGreaterThanOrEqual(e.low);
      }
    }
  });

  it('supports other range lengths, the touch rule and past dates', async () => {
    const r5 = (await get<OrbResponse>('/api/orb/NIFTY?minutes=5')).body;
    expect(r5.rangeMinutes).toBe(5);
    const c15 = (await get<OrbResponse>('/api/orb/NIFTY')).body.evaluation;
    expect(r5.evaluation.high).toBeLessThanOrEqual(c15.high);
    const touch = (await get<OrbResponse>('/api/orb/NIFTY?rule=touch')).body;
    if (touch.evaluation.firstUp && c15.firstUp) expect(touch.evaluation.firstUp.ts).toBeLessThanOrEqual(c15.firstUp.ts);
    const past = (await get<OrbResponse>('/api/orb/NIFTY?date=2026-10-08')).body;
    expect(past.live).toBe(false);
    expect(past.bars).toHaveLength(375);
    expect((await get('/api/orb/NIFTY?date=2026-10-04')).status).toBe(400); // a Sunday
  });

  it('scans every symbol and powers the trend scanners', async () => {
    const rows = (await get<OrbScanRow[]>('/api/orb')).body;
    expect(rows).toHaveLength(svc.engine.instruments.size);
    const ups = rows.filter((r) => r.trend === 'up').length;
    const scanUp = (await get<unknown[]>('/api/scanners/orb-up?limit=100')).body;
    expect(scanUp).toHaveLength(ups);
    for (const r of rows) {
      expect(r.high).toBeGreaterThanOrEqual(r.low);
      if (r.trend === 'sideways') expect(r.breakTs).toBeNull();
    }
  });

  it('keeps a consistent multi-day record', async () => {
    const h = (await get<OrbHistoryResponse>('/api/orb/NIFTY/history?days=30')).body;
    expect(h.rows).toHaveLength(30);
    expect(h.rows[0].date > h.rows[1].date).toBe(true);
    expect(h.stats.brokeUp + h.stats.brokeDown + h.stats.sideways).toBe(30);
    expect(h.stats.trendDays).toBeLessThanOrEqual(h.stats.brokeUp + h.stats.brokeDown);
  });
});

describe('1-minute order flow', () => {
  it('splits every minute into buy and sell volume that add up', async () => {
    const f = (await get<OrderFlowResponse>('/api/order-flow/NIFTY?limit=375')).body;
    expect(f.type).toBe('FUT');
    expect(f.live).toBe(true);
    expect(f.minutes.length).toBe(135); // 09:15 → 11:30
    let cum = 0;
    for (const m of f.minutes) {
      expect(m.buyVolume + m.sellVolume).toBe(m.volume);
      expect(m.buyVolume).toBeGreaterThanOrEqual(0);
      expect(m.sellVolume).toBeGreaterThanOrEqual(0);
      expect(m.buyVolume % f.lotSize).toBe(0);
      cum += m.delta;
      expect(m.cumDelta).toBe(cum);
    }
    expect(f.session.delta).toBe(cum);
    const last = f.minutes[f.minutes.length - 1];
    expect(f.lastMinute!.ts).toBe(last.ts);
    expect(f.lastMinute!.buyVolume).toBe(last.buyVolume);
    expect(f.last5.volume).toBe(f.minutes.slice(-5).reduce((a, m) => a + m.volume, 0));
  });

  it('matches the exchange volume of the contract', async () => {
    const f = (await get<OrderFlowResponse>('/api/order-flow/NIFTY?limit=375')).body;
    const p = svc.engine.parts(svc.clock.now());
    const total = svc.engine.futureVolume('NIFTY', f.expiry, p.dayIdx, Math.floor(p.m));
    expect(f.session.volume).toBe(total);
  });

  it('leans with price: rising minutes are mostly buyer-driven', async () => {
    const f = (await get<OrderFlowResponse>('/api/order-flow/NIFTY?date=2026-10-08&limit=375')).body;
    expect(f.live).toBe(false);
    expect(f.currentMinute).toBeNull();
    let agree = 0;
    let n = 0;
    for (let i = 1; i < f.minutes.length; i++) {
      const move = f.minutes[i].close - f.minutes[i - 1].close;
      if (Math.abs(move) < 3) continue;
      n++;
      if (Math.sign(move) === Math.sign(f.minutes[i].delta)) agree++;
    }
    expect(n).toBeGreaterThan(50);
    expect(agree / n).toBeGreaterThan(0.6);
  });

  it('works for option contracts (puts flow against the underlying)', async () => {
    const ce = (await get<OrderFlowResponse>('/api/order-flow/NIFTY?type=CE&limit=5')).body;
    const pe = (await get<OrderFlowResponse>('/api/order-flow/NIFTY?type=PE&limit=5')).body;
    expect(ce.instrument).toMatch(/ CE$/);
    expect(pe.instrument).toMatch(/ PE$/);
    expect(ce.strike).toBe(pe.strike);
    expect(ce.minutes).toHaveLength(5);
  });
});

describe('trend alerts', () => {
  it('fires an opening-range alert on a break after it was armed', async () => {
    // Go back to a fresh services instance at 09:25, arm alerts for both sides, then let time pass.
    wall = Date.now();
    const s2 = createServices(loadConfig({ persist: false, simStart: '2026-10-09T09:25', authSecret: 'test' }), { now: () => wall });
    const a2 = await buildApp(s2, { serveWeb: false });
    const t = (await a2.inject({ method: 'POST', url: '/api/auth/guest', payload: {} })).json().token as string;
    const h = { authorization: `Bearer ${t}` };
    for (const condition of ['above', 'below']) {
      const r = await a2.inject({ method: 'POST', url: '/api/alerts', headers: h, payload: { kind: 'ORB_BREAK', symbol: 'NIFTY', condition, value: 15 } });
      expect(r.statusCode).toBe(200);
    }
    s2.alerts.evaluate();
    let alerts = (await a2.inject({ method: 'GET', url: '/api/alerts', headers: h })).json() as { condition: string; status: string; triggeredAt?: number }[];
    expect(alerts.every((x) => x.status === 'active')).toBe(true);
    wall += 125 * 60_000; // → 11:30
    s2.alerts.evaluate();
    alerts = (await a2.inject({ method: 'GET', url: '/api/alerts', headers: h })).json();
    const orb = (await a2.inject({ method: 'GET', url: '/api/orb/NIFTY' })).json() as OrbResponse;
    const sides = new Set<string>(orb.evaluation.crossings.map((c) => (c.direction === 'up' ? 'above' : 'below')));
    for (const a of alerts) expect(a.status, a.condition).toBe(sides.has(a.condition) ? 'triggered' : 'active');
    const notes = (await a2.inject({ method: 'GET', url: '/api/notifications', headers: h })).json() as { title: string }[];
    expect(notes.some((n) => /opening range/.test(n.title))).toBe(true);
    s2.stop();
    await a2.close();
  });

  it('evaluates 1-minute buy-volume alerts', async () => {
    const r = await post<{ id: string }>('/api/alerts', { kind: 'ORDER_FLOW', symbol: 'NIFTY', condition: 'above', value: 0 });
    expect(r.status).toBe(200);
    expect((await post('/api/alerts', { kind: 'ORDER_FLOW', symbol: 'NIFTY', condition: 'above', value: 140 })).status).toBe(400);
    svc.alerts.evaluate();
    const list = (await get<{ id: string; status: string }[]>('/api/alerts')).body;
    expect(list.find((a) => a.id === r.body.id)!.status).toBe('triggered');
  });
});

describe('dashboard', () => {
  it('includes opening range and order flow for the main indices', async () => {
    const d = (await get<{ chains: { symbol: string; orb: { high: number; trend: string }; flow: { buyPct: number } | null }[] }>('/api/dashboard')).body;
    for (const c of d.chains) {
      expect(c.orb.high).toBeGreaterThan(0);
      expect(['up', 'down', 'sideways', 'forming']).toContain(c.orb.trend);
      expect(c.flow?.buyPct).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('review regressions', () => {
  it('opening range high/low include every price the LTP printed in the range', async () => {
    const s3 = createServices(loadConfig({ persist: false, simStart: '2026-10-09T11:00', authSecret: 'test' }), { now: () => Date.now() });
    for (const sym of ['NIFTY', 'BANKNIFTY', 'FINNIFTY']) {
      const orb = s3.analytics.orb(sym, s3.clock.now());
      const e = orb.evaluation;
      for (let t = orb.rangeStartTs; t < orb.rangeEndTs; t += 1000) {
        const ltp = s3.engine.spot(sym, t);
        expect(ltp, `${sym} ${t}`).toBeLessThanOrEqual(e.high + 1e-9);
        expect(ltp).toBeGreaterThanOrEqual(e.low - 1e-9);
      }
      // ...and the candles API agrees.
      const c15 = s3.analytics.candles(sym, '15', 1, s3.clock.now())[0];
      expect(c15.high).toBe(e.high);
      expect(c15.low).toBe(e.low);
    }
    s3.stop();
  });

  it("a touch in the minute in progress is never taken back", async () => {
    const s3 = createServices(loadConfig({ persist: false, simStart: '2026-10-09T11:00', authSecret: 'test' }), { now: () => Date.now() });
    const t0 = s3.clock.now() - (s3.clock.now() % 60_000);
    let hi = -Infinity;
    let lo = Infinity;
    for (let t = t0 + 1000; t < t0 + 60_000; t += 1000) {
      const { bars } = s3.analytics.minuteBars('NIFTY', s3.engine.parts(t).dayIdx, s3.engine.parts(t).m, t);
      const last = bars[bars.length - 1];
      expect(last.high).toBeGreaterThanOrEqual(hi);
      expect(last.low).toBeLessThanOrEqual(lo);
      hi = last.high;
      lo = last.low;
    }
    s3.stop();
  });

  it('buy and sell volume of the minute in progress only grow', () => {
    const e = svc.engine;
    const p = e.parts(svc.clock.now());
    const expiry = e.futureExpiries('BANKNIFTY', svc.clock.now())[0];
    for (const j of [17, 100, 200]) {
      let buy = 0;
      let sell = 0;
      for (let s = 1; s <= 60; s++) {
        const f = e.minuteFlow('BANKNIFTY', { type: 'FUT', expiry }, p.dayIdx, j, j + s / 60);
        expect(f.buyVolume).toBeGreaterThanOrEqual(buy);
        expect(f.sellVolume).toBeGreaterThanOrEqual(sell);
        buy = f.buyVolume;
        sell = f.sellVolume;
      }
    }
  });

  it('does not fire an opening-range alert armed after the close on a break from before', async () => {
    // Live clock on a Saturday: market time is pinned to Friday 15:30:00.000.
    const sat = Date.UTC(2026, 9, 10, 5, 30);
    const s4 = createServices(loadConfig({ persist: false, clockMode: 'live', authSecret: 'test' }), { now: () => sat });
    const symbols = [...s4.engine.instruments.keys()];
    for (const symbol of symbols) {
      for (const condition of ['above', 'below'] as const) s4.alerts.create(`u-${symbol}`, { kind: 'ORB_BREAK', symbol, condition, value: 15 });
    }
    // At least one symbol's last candle of the session was a range crossing (the old bug's trigger).
    const lastCandle = s4.clock.now() - 60_000;
    expect(symbols.some((sym) => s4.analytics.orbConfirmed(sym, s4.clock.now(), 15).crossings.some((c) => c.ts === lastCandle))).toBe(true);
    s4.alerts.evaluate();
    for (const symbol of symbols) expect(s4.alerts.list(`u-${symbol}`).filter((a) => a.status === 'triggered'), symbol).toHaveLength(0);
    s4.stop();
  });

  it('validates trend query parameters and contracts', async () => {
    expect((await get('/api/orb/NIFTY?minutes=0')).status).toBe(400);
    expect((await get('/api/orb/NIFTY?rule=wick')).status).toBe(400);
    expect((await get('/api/orb/NIFTY?date=2099-01-01')).status).toBe(400);
    expect((await get('/api/order-flow/NIFTY?type=XX')).status).toBe(400);
    expect((await get('/api/order-flow/NIFTY?type=CE&strike=12345')).status).toBe(400);
    expect((await post('/api/alerts', { kind: 'ORB_BREAK', symbol: 'NIFTY', condition: 'above', value: 60 })).status).toBe(400);
    // A past session lists its own contracts and defaults to its own near expiry.
    const past = (await get<OrderFlowResponse>('/api/order-flow/NIFTY?type=CE&date=2026-09-01&limit=5')).body;
    expect(past.expiries[0]).toBe(past.expiry);
    expect(past.expiry >= '2026-09-01').toBe(true);
    expect(past.strikes).toContain(past.strike);
  });
});
