import type { AlgoDefinition } from './types';
import { oiTop } from './oi-top';
import { premiumLadder } from './premium-ladder';
import { rollingStraddle } from './rolling-straddle';

export * from './types';
export * from './charges';
export * from './premium-ladder';
export * from './rolling-straddle';
export * from './oi-top';

/** Every algo the terminal can run. New algos are added here and appear in the Algo panel. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALGOS: AlgoDefinition<any, any>[] = [premiumLadder, rollingStraddle, oiTop];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function algoById(id: string): AlgoDefinition<any, any> | undefined {
  return ALGOS.find((a) => a.id === id);
}
