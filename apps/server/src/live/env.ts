/**
 * Kotak Neo credentials from the environment (`.env`). Values are validated but never logged,
 * echoed in errors or returned by an API: errors name the variables only.
 */
import { base32Decode } from './kotak/totp';

export interface NeoEnv {
  /** API access token from the Neo dashboard (sent raw in `Authorization`, no "Bearer"). */
  consumerKey: string;
  /** E.164, e.g. '+919876543210' (tradeApiLogin wants the ISD prefix). */
  mobileNumber: string;
  ucc: string;
  mpin: string;
  /** Base32 TOTP setup key. */
  totpSecret: string;
}

export const NEO_ENV_VARS = ['NEO_CONSUMER_KEY', 'NEO_MOBILE_NUMBER', 'NEO_UCC', 'NEO_MPIN', 'NEO_TOTP_SECRET'] as const;
export type NeoEnvVar = (typeof NEO_ENV_VARS)[number];

/**
 * Normalises an Indian mobile number to '+91XXXXXXXXXX'. Numbers already in E.164 form with
 * another country code are kept as given. Returns null when the shape is not recognised.
 */
export function normaliseMobile(raw: string): string | null {
  const s = raw.replace(/[\s\-().]/g, '');
  if (/^\+\d{8,15}$/.test(s)) return /^\+91/.test(s) && s.length !== 13 ? null : s;
  if (/^0091\d{10}$/.test(s)) return `+${s.slice(2)}`;
  if (/^91\d{10}$/.test(s)) return `+${s}`;
  if (/^0\d{10}$/.test(s)) return `+91${s.slice(1)}`;
  if (/^\d{10}$/.test(s)) return `+91${s}`;
  return null;
}

/** Reads and validates the NEO_* variables. Throws naming only the missing/invalid variables. */
export function loadNeoEnv(env: Record<string, string | undefined> = process.env): NeoEnv {
  const val = (k: NeoEnvVar) => (env[k] ?? '').trim();
  const missing = NEO_ENV_VARS.filter((k) => val(k) === '');
  if (missing.length) throw new Error(`Kotak Neo credentials missing from the environment: ${missing.join(', ')}`);

  const invalid: string[] = [];
  const mobileNumber = normaliseMobile(val('NEO_MOBILE_NUMBER'));
  if (!mobileNumber) invalid.push('NEO_MOBILE_NUMBER (expected a 10-digit mobile number, optionally prefixed with +91)');
  if (!/^\d{4,8}$/.test(val('NEO_MPIN'))) invalid.push('NEO_MPIN (expected digits only)');
  try {
    if (base32Decode(val('NEO_TOTP_SECRET')).length < 10) invalid.push('NEO_TOTP_SECRET (too short for a TOTP key)');
  } catch {
    invalid.push('NEO_TOTP_SECRET (not a base32 TOTP key)');
  }
  if (invalid.length) throw new Error(`Kotak Neo credentials invalid: ${invalid.join('; ')}`);

  return {
    consumerKey: val('NEO_CONSUMER_KEY'),
    mobileNumber: mobileNumber!,
    ucc: val('NEO_UCC'),
    mpin: val('NEO_MPIN'),
    totpSecret: val('NEO_TOTP_SECRET'),
  };
}

/**
 * Masks a secret for logs. Long opaque values (keys, tokens, sids ≥ 16 chars) keep their last
 * 4 characters so two values can be told apart; anything shorter (MPIN, UCC, mobile, TOTP) is
 * fully masked.
 */
export function redact(s: string | null | undefined): string {
  if (!s) return '';
  return s.length >= 16 ? `…${s.slice(-4)}` : '****';
}

/** Replaces every occurrence of the given secrets in a free text (e.g. a server error message). */
export function scrubSecrets(text: string, secrets: Array<string | null | undefined>): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    out = out.split(s).join(redact(s));
  }
  return out;
}
