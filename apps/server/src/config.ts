import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEO_ENV_VARS, loadNeoEnv, type NeoEnv } from './live/env';

const here = path.dirname(fileURLToPath(import.meta.url));

function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  webDist: string;
  /** Risk-free rate for IV/Greeks and margin estimates (config input, not market data). */
  riskFreeRate: number;
  authSecret: string;
  /** HOLIDAYS env list, merged with NSE's holiday master by the live provider. */
  holidays: Set<string>;
  persist: boolean;
  /** Kotak Neo credentials from the environment (.env); null when missing or invalid. Never log it. */
  neo: NeoEnv | null;
  /** Why `neo` is null: names the variables only, never their values. */
  neoError?: string;
  /** Sessions checked for missing NSE/BSE end-of-day files at start and daily (EOD_BACKFILL_DAYS). */
  eodBackfillDays: number;
  /** Hard cap of SFeed (token, intent) subscriptions (SFEED_TOKEN_BUDGET, at most 2,700 of the server's 3,000, DESIGN.md §3). */
  sfeedTokenBudget: number;
}

/** Kotak credentials, or the reason they are unusable (variable names only). */
export function neoFromEnv(env: Record<string, string | undefined> = process.env): { neo: NeoEnv | null; neoError?: string } {
  const missing = NEO_ENV_VARS.filter((k) => (env[k] ?? '').trim() === '');
  if (missing.length) return { neo: null, neoError: `Kotak credentials missing in .env: ${missing.join(', ')}` };
  try {
    return { neo: loadNeoEnv(env) };
  } catch (e) {
    // loadNeoEnv's message names the invalid variables and the expected shape, never a value.
    return { neo: null, neoError: e instanceof Error ? e.message : 'Kotak credentials invalid' };
  }
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    port: num('PORT', 8787),
    host: process.env.HOST ?? '0.0.0.0',
    dataDir: process.env.DATA_DIR ?? path.resolve(here, '../data'),
    webDist: process.env.WEB_DIST ?? path.resolve(here, '../../web/dist'),
    riskFreeRate: num('RISK_FREE_RATE', 0.065),
    authSecret: process.env.AUTH_SECRET || randomBytes(32).toString('hex'),
    holidays: new Set((process.env.HOLIDAYS ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    persist: process.env.PERSIST !== 'false',
    ...neoFromEnv(),
    eodBackfillDays: Math.max(0, Math.floor(num('EOD_BACKFILL_DAYS', 30))),
    sfeedTokenBudget: Math.min(2700, Math.max(1, Math.floor(num('SFEED_TOKEN_BUDGET', 2700)))),
  };
  return { ...base, ...overrides };
}
