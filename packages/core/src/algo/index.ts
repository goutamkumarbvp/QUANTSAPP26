import type { AlgoDefinition } from './types';
import { premiumLadder } from './premium-ladder';

export * from './types';
export * from './charges';
export * from './premium-ladder';

/** Every algo the terminal can run. New algos are added here and appear in the Algo panel. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALGOS: AlgoDefinition<any, any>[] = [premiumLadder];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function algoById(id: string): AlgoDefinition<any, any> | undefined {
  return ALGOS.find((a) => a.id === id);
}
