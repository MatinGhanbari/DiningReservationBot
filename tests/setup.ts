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
process.env.ENCRYPTION_KEY = 'test-only-encryption-key-that-is-long-enough-to-satisfy-the-minimum-length';
process.env.ADMINS = '[1001,1002]';
// Pinned empty on purpose. `src/config/env.ts` reads this from the environment
// first and only then falls back to the placeholder in `appsettings.json`, so a
// developer whose own `.env` carries the real Samad credential would otherwise
// change what `tests/samad.test.ts` observes.
process.env.SAMAD_BASIC_AUTH = '';
process.env.DATABASE_PATH = ':memory:';
process.env.LOG_LEVEL = 'silent';
process.env.TZ = 'Asia/Tehran';
process.env.PORT = '0';
