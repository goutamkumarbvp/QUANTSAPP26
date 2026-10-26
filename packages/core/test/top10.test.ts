import { describe, expect, it } from 'vitest';
import { biasOf } from '../src/top10';

describe('heavyweights bias', () => {
  it('four agreeing live readings make a bullish score, each with its reason', () => {
    const b = biasOf({ buildUp: 'Long Build-up', flowRead: 'buyers', flowBuyPct: 64, changePcr: 1.5, orbTrend: 'up' });
    expect(b).toMatchObject({ score: 4, available: 4, label: 'Bullish' });
    expect(b.votes.map((v) => v.why)).toEqual([
      'Future: Long Build-up',
      'Flow: buyers in control (64% buyer initiated)',
      'Options: change PCR 1.50 — puts written (support)',
      'Trend: broke above the 15-min opening range',
    ]);
  });

  it('bearish readings subtract; mixed readings net out', () => {
    expect(biasOf({ buildUp: 'Short Build-up', flowRead: 'sellers', changePcr: 0.6, orbTrend: 'down' })).toMatchObject({ score: -4, label: 'Bearish' });
    expect(biasOf({ buildUp: 'Short Covering', flowRead: 'sellers', changePcr: 1.0, orbTrend: 'sideways' })).toMatchObject({ score: 0, label: 'Neutral', available: 4 });
    expect(biasOf({ buildUp: 'Long Unwinding', flowRead: 'buying-absorbed', changePcr: null, orbTrend: null }).label).toBe('Mild bearish');
  });

  it('a reading that is not available never votes and is said to be missing', () => {
    const b = biasOf({ buildUp: null, flowRead: null, changePcr: null, orbTrend: null });
    expect(b).toMatchObject({ score: 0, available: 0, label: 'No live reading' });
    expect(b.votes.every((v) => !v.available && v.vote === 0)).toBe(true);
    expect(b.votes[1].why).toMatch(/no recorded minutes yet/);
  });
});
