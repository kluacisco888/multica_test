import { defineConfig, devices } from '@playwright/test';

const port = process.env.E2E_PORT ?? '18090';
// E2E_BASE_URL: test a server that is already running (the compose deployment
// started by scripts/e2e-compose.mjs) instead of starting scripts/e2e-server.mjs.
const target = process.env.E2E_BASE_URL;
const baseURL = target ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    // Mobile layout is checked at 390px wide (spec: Testing Decisions §4).
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: target ? undefined : {
    command: 'node scripts/e2e-server.mjs',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { E2E_PORT: port },
  },
});
