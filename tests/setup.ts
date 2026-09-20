/**
 * Environment for the test run.
 *
 * `src/config/env.ts` validates and freezes the configuration the moment it is
 * first imported, so these values have to be in place before any module under
 * test is loaded. Vitest's `setupFiles` run first, which is exactly what this is
 * for.
 *
 * Everything here is a throwaway value. No real token, no real key.
 */
process.env.NODE_ENV = 'test';
process.env.BOT_TOKEN = '123456789:TEST-TOKEN-NOT-REAL';
process.env.ENCRYPTION_KEY = 'test-only-encryption-key-that-is-long-enough';
process.env.ADMINS = '[1001,1002]';
process.env.DATABASE_PATH = ':memory:';
process.env.LOG_LEVEL = 'silent';
process.env.TZ = 'Asia/Tehran';
process.env.PORT = '0';
