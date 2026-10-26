import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScripMaster } from '../../src/live/kotak/scripmaster';
import { keyId } from '../../src/live/types';
import { LiveUniverse, computeUniverse } from '../../src/live/universe';
import { MONTHLY, NIFTY_W1, NIFTY_W2, SENSEX_FUT, SENSEX_W1, loadScripMaster } from './kotak-universe';

let dir = '';
let sm: ScripMaster;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'q26-universe-'));
  sm = await loadScripMaster(dir);
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const centres = (o: Record<string, number>) => new Map(Object.entries(o));

describe('computeUniverse', () => {
  it('orders the tiers: index spots + India VIX, user, near futures + stock spots, index chains', () => {
    const u = computeUniverse(sm, centres({ NIFTY: 25000, BANKNIFTY: 56000, SENSEX: 82000 }), {}, [{ symbol: 'RELIANCE', kind: 'CE', expiry: MONTHLY, strike: 1400 }]);
    const tiers = u.entries.map((e) => e.tier);
    // Tiers never interleave.
    expect(tiers.join(',')).toMatch(/^(index,)+(user,)+(underlying,)+(chain,)*chain$/);
    expect(u.entries.filter((e) => e.tier === 'index').map((e) => keyId(e.key))).toEqual(['NIFTY|SPOT||', 'BANKNIFTY|SPOT||', 'SENSEX|SPOT||', 'INDIAVIX|SPOT||']);
    expect(u.entries.filter((e) => e.tier === 'user').map((e) => keyId(e.key))).toEqual([`RELIANCE|CE|${MONTHLY}|1400`]);
    expect(u.entries.filter((e) => e.tier === 'underlying').map((e) => keyId(e.key))).toEqual([
      `NIFTY|FUT|${MONTHLY}|`,
      `BANKNIFTY|FUT|${MONTHLY}|`,
      `SENSEX|FUT|${SENSEX_FUT}|`,
      `RELIANCE|FUT|${MONTHLY}|`,
      `INFY|FUT|${MONTHLY}|`,
      'RELIANCE|SPOT||',
      'INFY|SPOT||',
    ]);
    expect(u.entries.every((e) => e.level === 'quote')).toBe(true);
  });

  it('index chains: the 2 nearest expiries, listed strikes within ±8 % of the centre, nearest first', () => {
    const u = computeUniverse(sm, centres({ NIFTY: 25000 }));
    const nifty = u.chains.filter((c) => c.symbol === 'NIFTY');
    expect(nifty.map((c) => c.expiry)).toEqual([NIFTY_W1, NIFTY_W2]); // not the monthly
    // ±8 % of 25000 = 23000..27000: the whole 50-point grid of the fixture's weeklies.
    expect(nifty[0].strikes[0]).toBe(23000);
    expect(nifty[0].strikes.at(-1)).toBe(27000);
    expect(nifty[0].strikes).toHaveLength(81);
    const chain = u.entries.filter((e) => e.tier === 'chain');
    expect(chain).toHaveLength(81 * 2 * 2);
    expect(chain.slice(0, 4).map((e) => keyId(e.key))).toEqual([
      `NIFTY|CE|${NIFTY_W1}|25000`,
      `NIFTY|PE|${NIFTY_W1}|25000`,
      `NIFTY|CE|${NIFTY_W2}|25000`,
      `NIFTY|PE|${NIFTY_W2}|25000`,
    ]);
    const dist = chain.map((e) => Math.abs((e.key.strike as number) / 25000 - 1));
    for (let i = 1; i < dist.length; i++) expect(dist[i]).toBeGreaterThanOrEqual(dist[i - 1]);
    // Narrower band.
    const narrow = computeUniverse(sm, centres({ NIFTY: 25000 }), { strikeBandPct: 0.004, indexExpiries: 1 });
    expect(narrow.chains[0].strikes).toEqual([24900, 24950, 25000, 25050, 25100]);
  });

  it('focus stocks (NIFTY heavyweights): their nearest chain within ±5 %, after every index leg; no price → noted, never centred', () => {
    const u = computeUniverse(sm, centres({ NIFTY: 25000, RELIANCE: 1400 }), { focusStocks: ['RELIANCE', 'INFY', 'NOPE'] });
    const rel = u.chains.find((c) => c.symbol === 'RELIANCE')!;
    expect(rel.expiry).toBe(MONTHLY);
    expect(Math.min(...rel.strikes)).toBeGreaterThanOrEqual(1400 * 0.95);
    expect(Math.max(...rel.strikes)).toBeLessThanOrEqual(1400 * 1.05);
    const chain = u.entries.filter((e) => e.tier === 'chain');
    const firstStock = chain.findIndex((e) => e.key.symbol === 'RELIANCE');
    expect(firstStock).toBeGreaterThan(0);
    expect(chain.slice(firstStock).every((e) => e.key.symbol === 'RELIANCE')).toBe(true); // after every NIFTY leg
    expect(chain[firstStock].key.strike).toBe(1400); // nearest the money first
    expect(u.notes).toEqual(expect.arrayContaining([expect.stringMatching(/^INFY: no live price/), expect.stringMatching(/^NOPE: focus stock not in the instrument master/)]));
  });

  it('an index without a live price gets no chain (noted), never a guessed centre', () => {
    const u = computeUniverse(sm, centres({ NIFTY: 25000 }));
    expect(u.chains.map((c) => c.symbol)).toEqual(['NIFTY', 'NIFTY']);
    expect(u.notes).toContain('BANKNIFTY: no live price to centre the option chain on yet');
    expect(u.notes).toContain('SENSEX: no live price to centre the option chain on yet');
    const sensex = computeUniverse(sm, centres({ SENSEX: 82000 }));
    expect(sensex.chains).toEqual([expect.objectContaining({ symbol: 'SENSEX', expiry: SENSEX_W1, centre: 82000 })]);
  });

  it('user contracts: unlisted ones are noted, levels kept, duplicates of higher tiers dropped', () => {
    const u = computeUniverse(sm, centres({}), {}, [
      { key: { symbol: 'NIFTY', kind: 'CE', expiry: NIFTY_W1, strike: 25025 } },
      { key: { symbol: 'INFY', kind: 'SPOT' }, level: 'depth' },
      { symbol: 'NIFTY', kind: 'SPOT' },
    ]);
    expect(u.notes).toContain(`user contract NIFTY|CE|${NIFTY_W1}|25025 is not listed in the instrument master`);
    expect(u.entries.filter((e) => e.tier === 'user')).toEqual([{ key: { symbol: 'INFY', kind: 'SPOT' }, tier: 'user', level: 'depth' }]);
  });

  it('master not loaded → nothing to stream, with the reason', () => {
    const empty = new ScripMaster({ dataDir: dir, filePaths: async () => [] });
    expect(computeUniverse(empty, centres({ NIFTY: 25000 }))).toEqual({ entries: [], chains: [], notes: ['instrument master not loaded yet'] });
  });
});

describe('LiveUniverse', () => {
  it('re-centres a chain only after a move of more than 2 %', () => {
    let price = 25000;
    const u = new LiveUniverse({ ref: sm, priceOf: (s) => (s === 'NIFTY' ? price : undefined) });
    expect(u.update().chains[0].centre).toBe(25000);
    price = 25400; // +1.6 %
    expect(u.update().chains[0].centre).toBe(25000);
    price = 25600; // +2.4 %
    expect(u.update().chains[0].centre).toBe(25600);
    expect(u.centreOf('NIFTY')).toBe(25600);
  });

  it('takes user contracts from the callback; a failing callback is reported, not fatal', () => {
    const u = new LiveUniverse({ ref: sm, priceOf: () => undefined });
    u.setUserContracts(() => [{ symbol: 'RELIANCE', kind: 'FUT', expiry: MONTHLY }]);
    expect(u.update().entries.find((e) => e.tier === 'user')?.key).toEqual({ symbol: 'RELIANCE', kind: 'FUT', expiry: MONTHLY });
    u.setUserContracts(() => {
      throw new Error('positions store offline');
    });
    const r = u.update();
    expect(r.entries.some((e) => e.tier === 'user')).toBe(false);
    expect(r.entries.length).toBeGreaterThan(0);
    expect(r.notes).toContain('user contracts callback failed: positions store offline');
  });
});
