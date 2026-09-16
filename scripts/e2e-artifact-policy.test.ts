import type { TestCase, TestResult } from '@playwright/test/reporter';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeTestResult } from '../e2e/support/safe-reporter';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('credential-bearing E2E artifact policy', () => {
  it('retains only a location and outcome, not failure diagnostics or attachments', () => {
    const secret = 'PRIVATE_SENTINEL_cookie_password_totp_mail_body';
    const test = { title: secret, location: { file: '/local/specs/login.spec.ts', line: 12 } } as TestCase;
    const result = {
      status: 'failed', retry: 0, duration: 123,
      errors: [{ message: secret, stack: secret }],
      stdout: [secret], stderr: [secret],
      steps: [{ title: secret }], attachments: [{ name: secret, body: Buffer.from(secret) }],
    } as unknown as TestResult;
    expect(safeTestResult(test, result)).toEqual({
      file: 'login.spec.ts', line: 12, status: 'failed', retry: 0, durationMs: 123,
    });
    expect(JSON.stringify(safeTestResult(test, result))).not.toContain(secret);
  });

  it('discards ordinary E2E output and keeps only the safe report', async () => {
    vi.stubEnv('ZEROPRESS_E2E_UI_OUTPUT_DIR', undefined);
    const { default: config } = await import('../playwright.config');
    expect(config).toMatchObject({
      outputDir: './test-results',
      reporter: [['./e2e/support/safe-reporter.ts']],
      preserveOutput: 'never',
      use: { screenshot: 'off', trace: 'off', video: 'off' },
    });
  });

  it('keeps UI traces in the runner-owned session directory', async () => {
    const directory = '/temporary/studio-ui-session';
    vi.stubEnv('ZEROPRESS_E2E_UI_OUTPUT_DIR', directory);
    const { default: config } = await import('../playwright.config');
    expect(config).toMatchObject({
      outputDir: directory,
      preserveOutput: 'always',
      reporter: [['./e2e/support/safe-reporter.ts']],
    });
  });
});
