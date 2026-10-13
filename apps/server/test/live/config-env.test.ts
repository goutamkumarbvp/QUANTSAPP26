/**
 * Live-data settings read from the environment (.env): Kotak credentials are reported by variable
 * name only, never by value; the SFeed budget never exceeds the design's 2,700 tokens.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, neoFromEnv } from '../../src/config';
import { CREDS } from './kotak-fixtures';

const ENV = { NEO_CONSUMER_KEY: CREDS.consumerKey, NEO_MOBILE_NUMBER: '9876543210', NEO_UCC: CREDS.ucc, NEO_MPIN: CREDS.mpin, NEO_TOTP_SECRET: CREDS.totpSecret };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('neoFromEnv', () => {
  it('loads valid credentials (mobile normalised to +91)', () => {
    expect(neoFromEnv(ENV)).toEqual({ neo: { ...CREDS, mobileNumber: '+919876543210' } });
  });

  it('names missing or invalid variables, never a value', () => {
    const missing = neoFromEnv({ ...ENV, NEO_MPIN: ' ', NEO_TOTP_SECRET: undefined });
    expect(missing).toEqual({ neo: null, neoError: 'Kotak credentials missing in .env: NEO_MPIN, NEO_TOTP_SECRET' });

    const invalid = neoFromEnv({ ...ENV, NEO_MPIN: '12ab', NEO_MOBILE_NUMBER: '12345', NEO_TOTP_SECRET: 'not base32!' });
    expect(invalid.neo).toBeNull();
    expect(invalid.neoError).toMatch(/NEO_MOBILE_NUMBER.*NEO_MPIN.*NEO_TOTP_SECRET/);
    for (const value of ['12ab', '12345', 'not base32!', CREDS.consumerKey, CREDS.ucc]) expect(invalid.neoError).not.toContain(value);
  });
});

describe('loadConfig live-data settings', () => {
  it('SFEED_TOKEN_BUDGET can lower the 2,700 budget, never raise it; EOD_BACKFILL_DAYS is a whole number ≥ 0', () => {
    expect(loadConfig().sfeedTokenBudget).toBe(2700);
    vi.stubEnv('SFEED_TOKEN_BUDGET', '3000');
    expect(loadConfig().sfeedTokenBudget).toBe(2700);
    vi.stubEnv('SFEED_TOKEN_BUDGET', '1500.7');
    expect(loadConfig().sfeedTokenBudget).toBe(1500);
    vi.stubEnv('SFEED_TOKEN_BUDGET', '0');
    expect(loadConfig().sfeedTokenBudget).toBe(1);
    vi.stubEnv('EOD_BACKFILL_DAYS', '-3');
    expect(loadConfig().eodBackfillDays).toBe(0);
    vi.stubEnv('EOD_BACKFILL_DAYS', 'ten');
    expect(loadConfig().eodBackfillDays).toBe(30);
  });
});
