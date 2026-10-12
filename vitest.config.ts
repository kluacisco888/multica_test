import { defineConfig } from 'vitest/config';

// Four test layers (see README「测试」):
//   unit  — pure logic in shared/ and server pure modules, no IO
//   api   — HTTP API integration tests against a real PostgreSQL
//   fakes — fake SMTP / fake Webhook test tools
//   (e2e  — Playwright, run separately via `pnpm test:e2e`)
const sourceConditions = ['source'];

export default defineConfig({
  resolve: { conditions: sourceConditions },
  ssr: { resolve: { conditions: sourceConditions } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/shared/src/**/*.test.ts', 'packages/server/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'api',
          include: ['packages/server/test/api/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['packages/server/test/support/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'fakes',
          include: ['packages/server/test/fakes/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
