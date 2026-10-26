import { afterEach, describe, expect, it } from 'vitest';
import type { Top10Response } from '@q26/core';
import { buildApp } from '../src/app';
import { DEFAULT_TOP10, focusStocksFrom, loadConfig } from '../src/config';
import { createServices } from '../src/services';
import { FakeProvider, loadSampleBook } from './support/fake-provider';

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

async function setup(focusStocks: string[], sample = true) {
  const p = new FakeProvider();
  if (sample) loadSampleBook(p);
  const svc = createServices(loadConfig({ persist: false, authSecret: 'test-secret', focusStocks }), { provider: p });
  const app = await buildApp(svc, { serveWeb: false });
  cleanup.push(() => p.dispose(), () => svc.stop(), () => app.close());
  return { p, app };
}

describe('NIFTY heavyweights desk config', () => {
  it('NIFTY_TOP10: up to ten upper-case symbols, de-duplicated; unset → the default heavyweights', () => {
    expect(focusStocksFrom(' reliance, TCS ,reliance,,infy ')).toEqual(['RELIANCE', 'TCS', 'INFY']);
    expect(focusStocksFrom('A,B,C,D,E,F,G,H,I,J,K,L')).toHaveLength(10);
    expect(focusStocksFrom(undefined)).toEqual([...DEFAULT_TOP10]);
    expect(focusStocksFrom('  ')).toEqual([...DEFAULT_TOP10]);
  });
});

describe('GET /api/top10', () => {
  it('one row per listed stock with live futures, options and a bias whose every vote has a reason; an unknown symbol is reported, not guessed', async () => {
    const { app } = await setup(['RELIANCE', 'NOTASTOCK']);
    const res = await app.inject({ method: 'GET', url: '/api/top10' });
    expect(res.statusCode).toBe(200);
    const d = res.json() as Top10Response;
    expect(d.rows.map((r) => r.symbol)).toEqual(['RELIANCE']);
    const r = d.rows[0];
    expect(r).toMatchObject({ rank: 1, sector: 'Energy', spot: { ltp: 1400 } });
    expect(r.future).toMatchObject({ ltp: expect.any(Number), basis: expect.any(Number) });
    expect(r.bias.votes).toHaveLength(4);
    for (const v of r.bias.votes) expect(v.why).toMatch(/\S{3}/);
    // A vote is only cast on an available reading.
    for (const v of r.bias.votes) if (!v.available) expect(v.vote).toBe(0);
    expect(d.gaps?.NOTASTOCK).toMatch(/NOTASTOCK/);
    expect(d.listSource).toMatch(/NIFTY_TOP10/);
    expect(d.basket.advancing + d.basket.declining).toBeLessThanOrEqual(1);
  });

  it('before the instrument master is loaded: 503 with the reason', async () => {
    const { app } = await setup(['RELIANCE'], false);
    const res = await app.inject({ method: 'GET', url: '/api/top10' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'NO_LIVE_DATA' });
  });
});
