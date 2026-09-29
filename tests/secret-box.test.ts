import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AesSecretBox, secretsMatch } from '../src/crypto/secret-box';

const KEY = 'a-test-key-that-is-definitely-long-enough-for-the-required-minimum-length';
const OTHER_KEY = 'a-different-key-that-is-also-long-enough-for-the-required-minimum-length';

describe('AesSecretBox', () => {
  it('round-trips a password', () => {
    const box = new AesSecretBox(KEY);
    expect(box.decrypt(box.encrypt('رمز-من-۱۲۳'))).toBe('رمز-من-۱۲۳');
  });

  it('produces different ciphertext for the same input every time', () => {
    const box = new AesSecretBox(KEY);

    const first = box.encrypt('same-password');
    const second = box.encrypt('same-password');

    // This is the defect the original AES-256-CTR implementation had: a fixed IV
    // made the ciphertext deterministic, so two users with the same password were
    // visibly identical in the database.
    expect(first).not.toBe(second);
    expect(box.decrypt(first)).toBe(box.decrypt(second));
  });

  it('rejects a payload encrypted with a different key', () => {
    const encrypted = new AesSecretBox(KEY).encrypt('secret');

    expect(() => new AesSecretBox(OTHER_KEY).decrypt(encrypted)).toThrow(/قابل خواندن نبود|decrypt/i);
  });

  it('detects tampering instead of returning garbage', () => {
    const box = new AesSecretBox(KEY);
    const parts = box.encrypt('secret').split(':');

    // Flip a character in the ciphertext; the GCM tag must reject it.
    const ciphertext = parts[3] ?? '';
    const flipped = ciphertext.startsWith('A') ? `B${ciphertext.slice(1)}` : `A${ciphertext.slice(1)}`;

    expect(() => box.decrypt([parts[0], parts[1], parts[2], flipped].join(':'))).toThrow();
  });

  it('rejects a malformed payload', () => {
    const box = new AesSecretBox(KEY);
    expect(() => box.decrypt('not-a-valid-payload')).toThrow();
  });

  it('refuses to construct with a short key', () => {
    expect(() => new AesSecretBox('too-short')).toThrow();
  });

  it('tags the format with a version so the scheme can change later', () => {
    const box = new AesSecretBox(KEY);
    expect(box.encrypt('x').startsWith('v2:')).toBe(true);
  });

  it('still decrypts a payload written by the previous scheme', () => {
    // The previous release derived its key with a different salt and cheaper
    // scrypt parameters, and wrote `v1:` envelopes without additional
    // authenticated data. Rows in that format are already in the database, so
    // dropping support for them would log every user out.
    const legacyKey = scryptSync(KEY, 'dining-reservation-bot/password-box/v1', 32, { N: 1 << 14, r: 8, p: 1, maxmem: 32 * 1024 * 1024 });
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', legacyKey, iv, { authTagLength: 16 });

    const ciphertext = Buffer.concat([cipher.update('legacy-password', 'utf8'), cipher.final()]);
    const payload = ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');

    expect(new AesSecretBox(KEY).decrypt(payload)).toBe('legacy-password');
  });
});

describe('secretsMatch', () => {
  it('compares equal values', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true);
  });

  it('rejects different values and different lengths', () => {
    expect(secretsMatch('abc', 'abd')).toBe(false);
    expect(secretsMatch('abc', 'abcd')).toBe(false);
  });
});
