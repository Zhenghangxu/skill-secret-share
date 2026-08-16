import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['apps/rendezvous-worker/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
