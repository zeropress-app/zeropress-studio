import { defineConfig, devices } from '@playwright/test';
import {
  E2E_BASE_URL,
  E2E_PREPARATION_URL,
} from './e2e/support/environment';

const uiOutputDirectory = process.env.ZEROPRESS_E2E_UI_OUTPUT_DIR;

export default defineConfig({
  testDir: './e2e/specs',
  outputDir: uiOutputDirectory || './test-results',
  globalTeardown: './e2e/support/global-teardown.ts',
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['./e2e/support/safe-reporter.ts']],
  // Playwright can create error-context.md even with tracing disabled.
  // UI Actions need completed traces until the runner cleans up the session.
  preserveOutput: uiOutputDirectory ? 'always' : 'never',
  use: {
    baseURL: E2E_BASE_URL,
    locale: 'en-US',
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'node e2e/support/run-local-worker.mjs',
    url: E2E_PREPARATION_URL,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
