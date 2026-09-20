import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Runs before any module under test is imported, which matters because the
    // configuration module validates and freezes `process.env` on first import.
    setupFiles: ['tests/setup.ts'],
    globals: false,
    restoreMocks: true,
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts', 'src/container.ts', 'src/bot/**'],
    },
  },
});
