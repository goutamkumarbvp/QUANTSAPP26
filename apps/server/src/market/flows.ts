/**
 * Institutional flow models: FII/DII cash-market activity and NSE participant-wise
 * open interest (Client / DII / FII / Pro). Participant nets are AR(1) processes that
 * react to market returns; longs and shorts always balance across participants.
 */
import { Rng, type FiiDiiDay, type ParticipantDay, type ParticipantRow } from '@q26/core';
import type { MarketEngine } from './engine';

type P = ParticipantRow['participant'];
const PARTICIPANTS: P[] = ['Client', 'DII', 'FII', 'Pro'];
const SHARES: Record<P, number> = { Client: 0.42, DII: 0.08, FII: 0.22, Pro: 0.28 };

interface NetSpec {
  mean: number;
  phi: number;
  beta: number;
  sigma: number;
}

type Category = 'futIndex' | 'futStock' | 'optIndexCall' | 'optIndexPut' | 'optStockCall' | 'optStockPut';

const CATEGORY_TOTAL: Record<Category, number> = {
  futIndex: 380_000,
  futStock: 2_600_000,
  optIndexCall: 6_400_000,
  optIndexPut: 5_900_000,
  optStockCall: 1_800_000,
  optStockPut: 950_000,
};

// Net position as a fraction of category OI, per participant (Client = balancing item).
const NET_SPECS: Record<Category, Partial<Record<P, NetSpec>>> = {
  futIndex: { FII: { mean: -0.05, phi: 0.94, beta: 1.6, sigma: 0.018 }, DII: { mean: -0.06, phi: 0.95, beta: 0.1, sigma: 0.006 }, Pro: { mean: 0.02, phi: 0.85, beta: 0.8, sigma: 0.03 } },
  futStock: { FII: { mean: 0.12, phi: 0.97, beta: 0.4, sigma: 0.006 }, DII: { mean: -0.08, phi: 0.97, beta: 0, sigma: 0.003 }, Pro: { mean: -0.02, phi: 0.9, beta: 0.3, sigma: 0.01 } },
  optIndexCall: { FII: { mean: 0.0, phi: 0.9, beta: 1.2, sigma: 0.015 }, DII: { mean: 0, phi: 0.5, beta: 0, sigma: 0.0005 }, Pro: { mean: -0.08, phi: 0.85, beta: -0.6, sigma: 0.02 } },
  optIndexPut: { FII: { mean: 0.02, phi: 0.9, beta: -1.2, sigma: 0.015 }, DII: { mean: 0, phi: 0.5, beta: 0, sigma: 0.0005 }, Pro: { mean: -0.07, phi: 0.85, beta: 0.6, sigma: 0.02 } },
  optStockCall: { FII: { mean: -0.02, phi: 0.9, beta: 0.4, sigma: 0.01 }, DII: { mean: 0, phi: 0.5, beta: 0, sigma: 0.0005 }, Pro: { mean: -0.06, phi: 0.85, beta: -0.3, sigma: 0.015 } },
  optStockPut: { FII: { mean: 0.01, phi: 0.9, beta: -0.4, sigma: 0.01 }, DII: { mean: 0, phi: 0.5, beta: 0, sigma: 0.0005 }, Pro: { mean: -0.05, phi: 0.85, beta: 0.3, sigma: 0.015 } },
};

export class FlowsModel {
  readonly fiiDii: FiiDiiDay[] = [];
  readonly participants: ParticipantDay[] = [];

  constructor(engine: MarketEngine, seed: string) {
    const nifty = engine.bars('NIFTY');
    const N = engine.days.length;
    const rngCash = Rng.of(seed, 'fii-dii');
    for (let i = 0; i < N; i++) {
      const b = nifty[i];
      const r = Math.log(b.close / b.prevClose);
      const fiiNet = 120_000 * r + 1500 * rngCash.normal() - 300;
      const diiNet = -0.65 * fiiNet + 900 * rngCash.normal() + 450;
      const fiiBuy = 11_000 + 3500 * Math.abs(rngCash.normal()) + Math.max(0, fiiNet);
      const diiBuy = 9_500 + 3000 * Math.abs(rngCash.normal()) + Math.max(0, diiNet);
      this.fiiDii.push({
        date: b.date,
        fiiBuy: +fiiBuy.toFixed(2),
        fiiSell: +(fiiBuy - fiiNet).toFixed(2),
        fiiNet: +fiiNet.toFixed(2),
        diiBuy: +diiBuy.toFixed(2),
        diiSell: +(diiBuy - diiNet).toFixed(2),
        diiNet: +diiNet.toFixed(2),
        niftyClose: b.close,
        niftyChangePct: +((r * 100)).toFixed(2),
      });
    }

    const categories = Object.keys(CATEGORY_TOTAL) as Category[];
    const state: Record<Category, Record<P, number>> = {} as never;
    const rngs: Record<string, Rng> = {};
    for (const c of categories) {
      state[c] = { Client: 0, DII: 0, FII: 0, Pro: 0 };
      for (const p of PARTICIPANTS) {
        const spec = NET_SPECS[c][p];
        if (spec) state[c][p] = spec.mean;
        rngs[`${c}|${p}`] = Rng.of(seed, 'participant', c, p);
      }
    }
    const totRng = Rng.of(seed, 'participant-total');
    for (let i = 0; i < N; i++) {
      const b = nifty[i];
      const r = Math.log(b.close / b.prevClose);
      const cycle = 1 + 0.18 * Math.sin((2 * Math.PI * (i % 20)) / 20);
      const rows: Record<P, ParticipantRow> = {} as never;
      for (const p of PARTICIPANTS) {
        rows[p] = {
          participant: p,
          futIndexLong: 0, futIndexShort: 0, futStockLong: 0, futStockShort: 0,
          optIndexCallLong: 0, optIndexCallShort: 0, optIndexPutLong: 0, optIndexPutShort: 0,
          optStockCallLong: 0, optStockCallShort: 0, optStockPutLong: 0, optStockPutShort: 0,
        };
      }
      for (const c of categories) {
        const total = CATEGORY_TOTAL[c] * cycle * Math.exp(0.05 * totRng.normal());
        const nets: Record<P, number> = { Client: 0, DII: 0, FII: 0, Pro: 0 };
        let sum = 0;
        for (const p of ['DII', 'FII', 'Pro'] as const) {
          const spec = NET_SPECS[c][p]!;
          const prev = state[c][p];
          const next = spec.mean + spec.phi * (prev - spec.mean) + spec.beta * r + spec.sigma * rngs[`${c}|${p}`].normal();
          const bound = 1.8 * SHARES[p];
          nets[p] = Math.max(-bound, Math.min(bound, next));
          state[c][p] = nets[p];
          sum += nets[p];
        }
        nets.Client = -sum;
        const maxAbs = Math.max(...PARTICIPANTS.map((p) => Math.abs(nets[p]) / (1.9 * SHARES[p])));
        if (maxAbs > 1) for (const p of PARTICIPANTS) nets[p] /= maxAbs;
        for (const p of PARTICIPANTS) {
          const long = Math.round(total * (SHARES[p] + nets[p] / 2));
          const short = Math.round(total * (SHARES[p] - nets[p] / 2));
          (rows[p] as unknown as Record<string, number>)[`${c}Long`] = Math.max(0, long);
          (rows[p] as unknown as Record<string, number>)[`${c}Short`] = Math.max(0, short);
        }
      }
      this.participants.push({ date: b.date, niftyClose: b.close, rows: PARTICIPANTS.map((p) => rows[p]) });
    }
  }
}
