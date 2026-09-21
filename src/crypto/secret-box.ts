import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { SecretBox } from '../domain/ports';
import { AppError } from '../shared/errors';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

const CURRENT_VERSION = 'v2';
const LEGACY_VERSION = 'v1';

export const MIN_MASTER_SECRET_LENGTH = 64;

const CURRENT_SALT = 'dining-reservation-bot/password-box/v2';
const LEGACY_SALT = 'dining-reservation-bot/password-box/v1';

const CURRENT_SCRYPT = { cost: 1 << 17, blockSize: 8, parallelism: 1, maxMemory: 256 * 1024 * 1024 };
const LEGACY_SCRYPT = { cost: 1 << 14, blockSize: 8, parallelism: 1, maxMemory: 32 * 1024 * 1024 };

const CURRENT_AAD = Buffer.from('dining-reservation-bot/password-box/v2/aes-256-gcm', 'utf8');

interface ScryptParameters {
  cost: number;
  blockSize: number;
  parallelism: number;
  maxMemory: number;
}

function deriveKey(masterSecret: string, salt: string, parameters: ScryptParameters): Buffer {
  return scryptSync(masterSecret, salt, KEY_LENGTH, {
    N: parameters.cost,
    r: parameters.blockSize,
    p: parameters.parallelism,
    maxmem: parameters.maxMemory,
  });
}

export class SecretBoxError extends AppError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super('INTERNAL', message, 'رمز ذخیره‌شده قابل خواندن نبود. لطفاً یک‌بار دیگر وارد حساب سمادت شو.', options);
  }
}

export class AesSecretBox implements SecretBox {
  private readonly key: Buffer;
  private legacyKey: Buffer | null = null;

  constructor(private readonly masterSecret: string) {
    if (masterSecret.length < MIN_MASTER_SECRET_LENGTH) {
      throw new SecretBoxError(`Encryption key must be at least ${MIN_MASTER_SECRET_LENGTH} characters`);
    }

    this.key = deriveKey(masterSecret, CURRENT_SALT, CURRENT_SCRYPT);
  }

  encrypt(plainText: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.key, iv, { authTagLength: AUTH_TAG_LENGTH });

    cipher.setAAD(CURRENT_AAD);

    const ciphertext = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return [CURRENT_VERSION, iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
  }

  decrypt(payload: string): string {
    const parts = payload.split(':');

    if (parts.length !== 4) {
      throw new SecretBoxError('Stored secret is malformed');
    }

    const [version, ivPart, authTagPart, ciphertextPart] = parts;

    if (ivPart === undefined || authTagPart === undefined || ciphertextPart === undefined) {
      throw new SecretBoxError('Stored secret is malformed');
    }

    const iv = Buffer.from(ivPart, 'base64');
    const authTag = Buffer.from(authTagPart, 'base64');
    const ciphertext = Buffer.from(ciphertextPart, 'base64');

    if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
      throw new SecretBoxError('Stored secret has an unexpected shape');
    }

    if (version === CURRENT_VERSION) {
      return this.open(this.key, CURRENT_AAD, iv, authTag, ciphertext);
    }

    if (version === LEGACY_VERSION) {
      return this.open(this.legacyDerivedKey(), null, iv, authTag, ciphertext);
    }

    throw new SecretBoxError(`Unsupported stored secret version: ${String(version)}`);
  }

  private open(key: Buffer, aad: Buffer | null, iv: Buffer, authTag: Buffer, ciphertext: Buffer): string {
    try {
      const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

      if (aad !== null) {
        decipher.setAAD(aad);
      }

      decipher.setAuthTag(authTag);

      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch (error) {
      throw new SecretBoxError('Failed to decrypt stored secret', { cause: error });
    }
  }

  private legacyDerivedKey(): Buffer {
    if (this.legacyKey === null) {
      this.legacyKey = deriveKey(this.masterSecret, LEGACY_SALT, LEGACY_SCRYPT);
    }

    return this.legacyKey;
  }
}

export function secretsMatch(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
