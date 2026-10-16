import { defineConfig } from 'vitest/config';

/**
 * Test layers run as separate Vitest projects so CI can schedule them
 * independently: unit (no I/O), contract (schemas and specs), integration
 * (Testcontainers), e2e and resilience (against the running Compose stack).
 */
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'] } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: { name: 'contract', include: ['tests/contract/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 240_000,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          testTimeout: 90_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: 'resilience',
          include: ['tests/resilience/**/*.test.ts'],
          testTimeout: 240_000,
          hookTimeout: 240_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
