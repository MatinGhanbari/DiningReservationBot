import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { SecretBox } from '../domain/ports';
import { AppError } from '../shared/errors';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12; // 96 bits, the size GCM is specified for
const AUTH_TAG_LENGTH = 16;
const FORMAT_VERSION = 'v1';

/**
 * Application-specific salt for key derivation.
 *
 * A constant is correct here: its job is to make precomputed rainbow tables
 * useless for this application, not to make the same secret derive differently
 * per installation — it must derive identically forever, or nothing decrypts.
 */
const KEY_DERIVATION_SALT = 'dining-reservation-bot/password-box/v1';

export class SecretBoxError extends AppError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super(
      'INTERNAL',
      message,
      'رمز ذخیره‌شده قابل خواندن نبود. لطفاً یک‌بار دیگر وارد حساب سمادت شو.',
      options,
    );
  }
}

/**
 * Encrypts the Samad passwords the bot must replay on the user's behalf.
 *
 * Why this is not a hash: the bot has to send the original password to Samad
 * whenever an access token expires. A hash is one-way, so the user would have to
 * log in again every time the token lapsed. The password is therefore stored
 * reversibly, and the security work goes into making that storage sound.
 *
 * What the original implementation got wrong, and what this fixes:
 *
 *   1. `aes-256-ctr` with a fixed IV. A stream cipher with a reused IV leaks the
 *      XOR of two plaintexts, and it also made the ciphertext deterministic —
 *      two users with the same password produced byte-identical rows.
 *   2. No authentication tag, so a modified ciphertext decrypted to garbage
 *      instead of failing loudly.
 *   3. The raw environment string was used as the key, with no key derivation.
 *
 * AES-256-GCM with a fresh random IV per record and a scrypt-derived key
 * addresses all three. The stored format is versioned so the scheme can change
 * later without guessing at old rows.
 */
export class AesSecretBox implements SecretBox {
  private readonly key: Buffer;

  constructor(masterSecret: string) {
    if (masterSecret.length < 32) {
      throw new SecretBoxError('Encryption key must be at least 32 characters');
    }

    // scrypt is deliberately slow; this runs once per process, not per call.
    this.key = scryptSync(masterSecret, KEY_DERIVATION_SALT, KEY_LENGTH);
  }

  encrypt(plainText: string): string {
    // A fresh IV per record is what makes the ciphertext non-deterministic.
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, { authTagLength: AUTH_TAG_LENGTH });

    const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [FORMAT_VERSION, iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(
      ':',
    );
  }

  decrypt(payload: string): string {
    const parts = payload.split(':');

    if (parts.length !== 4) {
      throw new SecretBoxError('Stored secret is malformed');
    }

    const [version, ivPart, authTagPart, ciphertextPart] = parts;

    if (version !== FORMAT_VERSION || ivPart === undefined || authTagPart === undefined || ciphertextPart === undefined) {
      throw new SecretBoxError(`Unsupported stored secret version: ${String(version)}`);
    }

    try {
      const iv = Buffer.from(ivPart, 'base64');
      const authTag = Buffer.from(authTagPart, 'base64');
      const ciphertext = Buffer.from(ciphertextPart, 'base64');

      if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
        throw new SecretBoxError('Stored secret has an unexpected shape');
      }

      const decipher = createDecipheriv(ALGORITHM, this.key, iv, { authTagLength: AUTH_TAG_LENGTH });
      decipher.setAuthTag(authTag);

      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (error) {
      // A wrong key or a tampered row lands here. Both mean "cannot recover",
      // and both should push the user back through login rather than crash.
      throw new SecretBoxError('Failed to decrypt stored secret', { cause: error });
    }
  }
}

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * Not currently on a hot path, but exported so any future token comparison uses
 * it rather than `===`.
 */
export function secretsMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
