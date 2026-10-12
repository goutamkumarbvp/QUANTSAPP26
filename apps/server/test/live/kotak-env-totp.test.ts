import { describe, expect, it } from 'vitest';
import { loadNeoEnv, normaliseMobile, redact, scrubSecrets } from '../../src/live/env';
import { base32Decode, freshTotp, totp, totpCounter, totpWaitMs } from '../../src/live/kotak/totp';

const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 of ASCII '12345678901234567890' (RFC 6238 SHA1 key)

const ENV = {
  NEO_CONSUMER_KEY: 'c0ffee00-1111-2222-3333-444455556666',
  NEO_MOBILE_NUMBER: '98765 43210',
  NEO_UCC: 'ABC12',
  NEO_MPIN: '654321',
  NEO_TOTP_SECRET: SECRET,
};

describe('loadNeoEnv', () => {
  it('reads and normalises the credentials', () => {
    expect(loadNeoEnv(ENV)).toEqual({
      consumerKey: ENV.NEO_CONSUMER_KEY,
      mobileNumber: '+919876543210',
      ucc: 'ABC12',
      mpin: '654321',
      totpSecret: SECRET,
    });
  });

  it('names only the missing variables, never any value', () => {
    let msg = '';
    try {
      loadNeoEnv({ ...ENV, NEO_UCC: '  ', NEO_MPIN: undefined });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('NEO_UCC');
    expect(msg).toContain('NEO_MPIN');
    expect(msg).not.toContain('NEO_CONSUMER_KEY');
    for (const v of Object.values(ENV)) expect(msg).not.toContain(v);
  });

  it('rejects malformed values without echoing them', () => {
    let msg = '';
    try {
      loadNeoEnv({ ...ENV, NEO_MOBILE_NUMBER: '12345', NEO_TOTP_SECRET: 'not base32 !!' });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/NEO_MOBILE_NUMBER/);
    expect(msg).toMatch(/NEO_TOTP_SECRET/);
    expect(msg).not.toContain('12345');
    expect(msg).not.toContain('not base32');
  });

  it('normalises Indian mobile numbers to E.164', () => {
    expect(normaliseMobile('9876543210')).toBe('+919876543210');
    expect(normaliseMobile('+91 98765-43210')).toBe('+919876543210');
    expect(normaliseMobile('919876543210')).toBe('+919876543210');
    expect(normaliseMobile('09876543210')).toBe('+919876543210');
    expect(normaliseMobile('00919876543210')).toBe('+919876543210');
    expect(normaliseMobile('+447700900123')).toBe('+447700900123');
    expect(normaliseMobile('+91987654321')).toBeNull();
    expect(normaliseMobile('98765')).toBeNull();
  });

  it('redacts secrets for logs', () => {
    expect(redact('654321')).toBe('****');
    expect(redact(ENV.NEO_CONSUMER_KEY)).toBe('…6666');
    expect(redact('')).toBe('');
    const text = scrubSecrets(`bad key ${ENV.NEO_CONSUMER_KEY} mpin 654321`, [ENV.NEO_CONSUMER_KEY, '654321']);
    expect(text).not.toContain(ENV.NEO_CONSUMER_KEY);
    expect(text).not.toContain('654321');
  });
});

describe('TOTP (RFC 6238, SHA1, 30 s, 6 digits)', () => {
  it('matches the RFC 6238 SHA1 test vectors (6-digit truncation)', () => {
    expect(totp(SECRET, 59_000)).toBe('287082');
    expect(totp(SECRET, 1_111_111_109_000)).toBe('081804');
    expect(totp(SECRET, 1_234_567_890_000)).toBe('005924');
    expect(totp(SECRET, 2_000_000_000_000)).toBe('279037');
  });

  it('tolerates lowercase, missing/extra padding and spaces in the secret', () => {
    expect(base32Decode(SECRET).toString('ascii')).toBe('12345678901234567890');
    expect(totp(SECRET.toLowerCase(), 59_000)).toBe('287082');
    expect(totp(`${SECRET}====`, 59_000)).toBe('287082');
    expect(totp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', 59_000)).toBe('287082');
    // An unpadded 26-char key (not a multiple of 8) decodes like pyotp's padded form.
    expect(base32Decode('JBSWY3DPEHPK3PXPJBSWY3DPEH').length).toBe(16);
    expect(() => base32Decode('ABC1')).toThrow(/not valid base32/);
  });

  it('waits for the next window when fewer than 3 s remain', () => {
    expect(totpWaitMs(30_000 * 100 + 10_000)).toBe(0);
    expect(totpWaitMs(30_000 * 100 + 27_000)).toBe(0); // exactly 3 s left is enough
    expect(totpWaitMs(30_000 * 100 + 28_500)).toBe(1_500);
    // A re-login never reuses the counter of the previous login.
    expect(totpWaitMs(30_000 * 100 + 5_000, { afterCounter: 100 })).toBe(25_000);
    expect(totpWaitMs(30_000 * 101 + 5_000, { afterCounter: 100 })).toBe(0);
  });

  it('freshTotp sleeps through the window boundary and returns the new code', async () => {
    let clock = 30_000 * 200 + 29_000;
    const slept: number[] = [];
    const r = await freshTotp(SECRET, { now: () => clock, sleep: async (ms) => void (slept.push(ms), (clock += ms)) });
    expect(slept.length).toBe(1);
    expect(r.counter).toBe(201);
    expect(r.code).toBe(totp(SECRET, 30_000 * 201));
    const again = await freshTotp(SECRET, { now: () => clock, sleep: async (ms) => void (clock += ms) }, { afterCounter: r.counter });
    expect(again.counter).toBe(202);
    expect(totpCounter(clock)).toBe(202);
  });
});
