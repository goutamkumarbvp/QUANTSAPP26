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
  /** Why AUTH_SECRET is not used: unset, or a placeholder / too short (a random secret is used instead). */
  authSecretIssue?: 'unset' | 'weak';
  /**
   * OPS_ADMIN_EMAILS: registered accounts allowed to run operations (Re-login now, health check,
   * audit), lower-case. Empty: only the first account registered on this server (its owner).
   */
  opsAdmins: string[];
  /** TRUST_PROXY: the reverse proxy address(es) whose X-Forwarded-For is trusted ('true': any). */
  trustProxy?: string | boolean;
  /** WS_ALLOWED_ORIGINS: extra browser origins (e.g. https://q26.example.com) allowed to open /ws. */
  wsAllowedOrigins: string[];
  /** HOLIDAYS env list, merged with NSE's holiday master by the live provider. */
  holidays: Set<string>;
  /**
   * MCX_HOLIDAYS env list: full-day MCX closures (no holiday API exists for MCX). MCX keeps trading on
   * most NSE holidays (often in the evening session), so NSE's list is not applied to it.
   */
  mcxHolidays: Set<string>;
  persist: boolean;
  /** Kotak Neo credentials from the environment (.env); null when missing or invalid. Never log it. */
  neo: NeoEnv | null;
  /** Why `neo` is null: names the variables only, never their values. */
  neoError?: string;
  /** Sessions checked for missing NSE/BSE end-of-day files at start and daily (EOD_BACKFILL_DAYS). */
  eodBackfillDays: number;
  /** Hard cap of SFeed (token, intent) subscriptions (SFEED_TOKEN_BUDGET, at most 2,700 of the server's 3,000, DESIGN.md §3). */
  sfeedTokenBudget: number;
  /**
   * NIFTY_TOP10: the app's whole stock universe — the ten largest NIFTY 50 companies by market
   * capitalisation (comma-separated F&O symbols). No other stock is listed anywhere in the app (option
   * chain, scanners, F&O market, streaming, end-of-day files). Market caps are not in any live feed, so
   * the list is configuration; their option chains are streamed tick by tick after the index chains.
   */
  focusStocks: string[];
}

/**
 * Default: the ten largest NIFTY 50 companies by market capitalisation (screener ranking of 1 Oct 2026;
 * LIC, ranked ninth, is not a NIFTY 50 stock, so Infosys follows). Edit NIFTY_TOP10 when the ranking changes.
 */
export const DEFAULT_TOP10 = ['RELIANCE', 'HDFCBANK', 'BHARTIARTL', 'ICICIBANK', 'SBIN', 'TCS', 'BAJFINANCE', 'LT', 'SUNPHARMA', 'INFY'] as const;

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

/** Placeholders that must never sign tokens (.env.example ships `change-me`). */
const PLACEHOLDER_SECRETS = new Set(['change-me', 'changeme', 'secret', 'password', 'test', 'e2e']);
export const MIN_AUTH_SECRET_LENGTH = 16;

/**
 * The token-signing secret: AUTH_SECRET when it is a real secret; otherwise a random one for this
 * run (sign-ins then end at restart) and the reason, so a copied placeholder cannot make tokens forgeable.
 */
export function authSecretFrom(raw: string | undefined): { authSecret: string; authSecretIssue?: 'unset' | 'weak' } {
  const v = (raw ?? '').trim();
  if (!v) return { authSecret: randomBytes(32).toString('hex'), authSecretIssue: 'unset' };
  if (v.length < MIN_AUTH_SECRET_LENGTH || PLACEHOLDER_SECRETS.has(v.toLowerCase())) return { authSecret: randomBytes(32).toString('hex'), authSecretIssue: 'weak' };
  return { authSecret: v };
}

/** TRUST_PROXY: unset / empty / false → not trusted; true → any proxy; else a comma-separated address list. */
export function trustProxyFrom(raw: string | undefined): { trustProxy?: string | boolean } {
  const v = (raw ?? '').trim();
  if (!v || v.toLowerCase() === 'false') return {};
  if (v.toLowerCase() === 'true') return { trustProxy: true };
  return { trustProxy: v };
}

/** NIFTY_TOP10 → up to 10 upper-case symbols, de-duplicated; empty or unset → DEFAULT_TOP10. */
export function focusStocksFrom(raw: string | undefined): string[] {
  const list = [...new Set((raw ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 10);
  return list.length ? list : [...DEFAULT_TOP10];
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    port: num('PORT', 8787),
    host: process.env.HOST ?? '0.0.0.0',
    dataDir: process.env.DATA_DIR ?? path.resolve(here, '../data'),
    webDist: process.env.WEB_DIST ?? path.resolve(here, '../../web/dist'),
    riskFreeRate: num('RISK_FREE_RATE', 0.065),
    ...authSecretFrom(process.env.AUTH_SECRET),
    opsAdmins: (process.env.OPS_ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
    ...trustProxyFrom(process.env.TRUST_PROXY),
    wsAllowedOrigins: (process.env.WS_ALLOWED_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    holidays: new Set((process.env.HOLIDAYS ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    mcxHolidays: new Set((process.env.MCX_HOLIDAYS ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    persist: process.env.PERSIST !== 'false',
    ...neoFromEnv(),
    eodBackfillDays: Math.max(0, Math.floor(num('EOD_BACKFILL_DAYS', 30))),
    sfeedTokenBudget: Math.min(2700, Math.max(1, Math.floor(num('SFEED_TOKEN_BUDGET', 2700)))),
    focusStocks: focusStocksFrom(process.env.NIFTY_TOP10),
  };
  return { ...base, ...overrides };
}
