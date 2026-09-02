import { defineConfig } from '@playwright/test';

const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: externalBaseUrl ?? 'http://127.0.0.1:4321',
    trace: 'on-first-retry',
  },
  webServer: externalBaseUrl
    ? undefined
    : {
        command: './node_modules/.bin/astro preview --host 127.0.0.1 --port 4321',
        url: 'http://127.0.0.1:4321',
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
