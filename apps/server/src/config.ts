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
  /** @deprecated removed in Phase C. 'demo' = always-open simulated session; 'live' = follow the real IST clock. */
  clockMode: 'demo' | 'live';
  /** @deprecated removed in Phase C */
  simSpeed: number;
  /** @deprecated removed in Phase C. Optional fixed demo start, e.g. "2026-10-09T10:30". */
  simStart?: string;
  riskFreeRate: number;
  authSecret: string;
  holidays: Set<string>;
  /** @deprecated removed in Phase C */
  seed: string;
  persist: boolean;
  /** Kotak Neo credentials from the environment (.env); null when missing or invalid. Never log it. */
  neo: NeoEnv | null;
  /** Why `neo` is null: names the variables only, never their values. */
  neoError?: string;
  /** Sessions checked for missing NSE/BSE end-of-day files at start and daily (EOD_BACKFILL_DAYS). */
  eodBackfillDays: number;
  /** Hard cap of SFeed (token, intent) subscriptions (SFEED_TOKEN_BUDGET, server limit 3,000). */
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
    clockMode: process.env.CLOCK_MODE === 'live' ? 'live' : 'demo',
    simSpeed: Math.max(0.1, num('SIM_SPEED', 1)),
    simStart: process.env.SIM_START || undefined,
    riskFreeRate: num('RISK_FREE_RATE', 0.065),
    authSecret: process.env.AUTH_SECRET || randomBytes(32).toString('hex'),
    holidays: new Set((process.env.HOLIDAYS ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    seed: process.env.MARKET_SEED ?? 'q26',
    persist: process.env.PERSIST !== 'false',
    ...neoFromEnv(),
    eodBackfillDays: Math.max(0, Math.floor(num('EOD_BACKFILL_DAYS', 30))),
    sfeedTokenBudget: Math.min(3000, Math.max(1, Math.floor(num('SFEED_TOKEN_BUDGET', 2700)))),
  };
  return { ...base, ...overrides };
}
