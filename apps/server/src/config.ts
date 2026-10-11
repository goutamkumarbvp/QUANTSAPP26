import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  /** 'demo' = always-open simulated session; 'live' = follow the real IST clock. */
  clockMode: 'demo' | 'live';
  simSpeed: number;
  /** Optional fixed demo start, e.g. "2026-10-09T10:30". */
  simStart?: string;
  riskFreeRate: number;
  authSecret: string;
  holidays: Set<string>;
  seed: string;
  persist: boolean;
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
  };
  return { ...base, ...overrides };
}
