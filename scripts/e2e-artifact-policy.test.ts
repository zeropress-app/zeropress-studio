import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FullResult, TestCase, TestResult } from '@playwright/test/reporter';
import type { Page } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SafeReporter, { safeTestResult } from '../e2e/support/safe-reporter';
import {
  EDITOR_DIAGNOSTIC_ANNOTATION,
  readEditorDiagnostic,
  recordEditorFailure,
} from '../e2e/support/editor-diagnostics';

const editorState = {
  stage: 'visual-round-trip', captured: true, mode: 'source',
  conversionDialogOpen: true,
  sourceEditorCount: 1, sourceReady: false, sourceContainsExpectedText: true,
  visualEditorCount: 0, strongCount: 0, visualTextMatches: false,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('credential-bearing E2E artifact policy', () => {
  it('retains source locations and outcomes without private diagnostics or attachments', () => {
    const secret = 'PRIVATE_SENTINEL_cookie_password_totp_mail_body';
    const test = { title: secret, location: { file: '/local/specs/login.spec.ts', line: 12 } } as TestCase;
    const result = {
      status: 'failed', retry: 0, duration: 123,
      errors: [
        {
          message: secret, stack: secret, snippet: secret,
          location: { file: `/local/${secret}/specs/login.spec.ts`, line: 24, column: 7 },
        },
        {
          message: secret,
          location: { file: `/local/${secret}/support/session.ts`, line: 18, column: 3 },
        },
      ],
      stdout: [secret], stderr: [secret],
      steps: [{ title: secret }], attachments: [{ name: secret, body: Buffer.from(secret) }],
    } as unknown as TestResult;
    expect(safeTestResult(test, result)).toEqual({
      file: 'login.spec.ts', line: 12, status: 'failed', retry: 0, durationMs: 123,
      failureLocations: [
        { file: 'login.spec.ts', line: 24, column: 7 },
        { file: 'session.ts', line: 18, column: 3 },
      ],
    });
    expect(JSON.stringify(safeTestResult(test, result))).not.toContain(secret);
  });

  it('writes failure locations to the console and summary separately from the test declaration', () => {
    const directory = mkdtempSync(join(tmpdir(), 'studio-safe-reporter-'));
    const secret = 'PRIVATE_SENTINEL_assertion_value';
    vi.spyOn(process, 'cwd').mockReturnValue(directory);
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const test = { title: secret, location: { file: '/local/specs/authoring.spec.ts', line: 154 } } as TestCase;
    const failure = {
      status: 'failed', retry: 0, duration: 12000,
      annotations: [{
        type: EDITOR_DIAGNOSTIC_ANNOTATION,
        description: JSON.stringify({ ...editorState, sourceHtml: secret, error: secret }),
      }],
      errors: [{
        message: secret, stack: secret, snippet: secret,
        location: { file: '/local/specs/authoring.spec.ts', line: 183, column: 9 },
      }],
    } as TestResult;
    const retry = { status: 'passed', retry: 1, duration: 3000, errors: [] } as unknown as TestResult;
    try {
      const reporter = new SafeReporter();
      reporter.onTestEnd(test, failure);
      reporter.onTestEnd(test, retry);
      reporter.onEnd({ status: 'passed', duration: 15000 } as FullResult);

      const report = readFileSync(join(directory, 'playwright-report/summary.json'), 'utf8');
      expect(JSON.parse(report)).toEqual({
        status: 'passed', durationMs: 15000, globalErrors: 0,
        tests: [safeTestResult(test, failure), safeTestResult(test, retry)],
      });
      const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join('');
      expect(output).toContain('failed: authoring.spec.ts:154 (12000ms); failure at authoring.spec.ts:183:9\n');
      expect(JSON.parse(report).tests[0].editorState).toEqual(editorState);
      expect(output).toContain(`editor state: ${JSON.stringify(editorState)}\n`);
      expect(output).toContain('passed: authoring.spec.ts:154 (3000ms)\n');
      expect(report + output).not.toContain(secret);
    } finally {
      vi.restoreAllMocks();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('accepts only explicitly typed editor state fields', () => {
    const annotation = (value: unknown) => [{
      type: EDITOR_DIAGNOSTIC_ANNOTATION, description: JSON.stringify(value),
    }];
    expect(readEditorDiagnostic(annotation({ ...editorState, token: 'PRIVATE_SENTINEL' })))
      .toEqual(editorState);
    for (const invalid of [
      { ...editorState, stage: 'PRIVATE_SENTINEL' },
      { ...editorState, mode: 'PRIVATE_SENTINEL' },
      { ...editorState, strongCount: 'PRIVATE_SENTINEL' },
      { ...editorState, strongCount: -1 },
      { ...editorState, sourceReady: 'true' },
    ]) {
      expect(readEditorDiagnostic(annotation(invalid))).toBeUndefined();
    }
    expect(readEditorDiagnostic([{ type: EDITOR_DIAGNOSTIC_ANNOTATION, description: 'not JSON' }]))
      .toBeUndefined();
    expect(readEditorDiagnostic([{ type: 'unrelated', description: JSON.stringify(editorState) }]))
      .toBeUndefined();
  });

  it('keeps failure state out of a successful retry', () => {
    const test = { location: { file: '/local/specs/authoring.spec.ts', line: 154 } } as TestCase;
    const result = {
      status: 'passed', retry: 1, duration: 3000, errors: [],
      annotations: [{ type: EDITOR_DIAGNOSTIC_ANNOTATION, description: JSON.stringify(editorState) }],
    } as unknown as TestResult;
    expect(safeTestResult(test, result)).toEqual({
      file: 'authoring.spec.ts', line: 154, status: 'passed', retry: 1,
      durationMs: 3000, failureLocations: [],
    });
  });

  it('records an unavailable snapshot without replacing the original failure when the page is closed', async () => {
    const page = { evaluate: vi.fn().mockRejectedValue(new Error('PRIVATE_SENTINEL')) } as unknown as Page;
    const testInfo = { annotations: [] as Array<{ type: string; description?: string }> };
    await recordEditorFailure(page, testInfo, 'visual-round-trip', 'Synthetic text');
    expect(readEditorDiagnostic(testInfo.annotations)).toEqual({
      stage: 'visual-round-trip', captured: false,
    });
    expect(JSON.stringify(testInfo.annotations)).not.toContain('PRIVATE_SENTINEL');
  });

  it('bounds diagnosis time when the page does not respond', async () => {
    vi.useFakeTimers();
    try {
      const page = { evaluate: vi.fn(() => new Promise(() => {})) } as unknown as Page;
      const testInfo = { annotations: [] as Array<{ type: string; description?: string }> };
      const recording = recordEditorFailure(page, testInfo, 'visual-round-trip', 'Synthetic text');
      await vi.runOnlyPendingTimersAsync();
      await recording;
      expect(readEditorDiagnostic(testInfo.annotations)).toEqual({
        stage: 'visual-round-trip', captured: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['failed', 'timedOut'] as const)('reports an unavailable failure location for %s without guessing', (status) => {
    const test = { location: { file: '/local/specs/login.spec.ts', line: 12 } } as TestCase;
    const result = {
      status, retry: 0, duration: 5000,
      errors: [{ message: 'PRIVATE_SENTINEL', stack: 'PRIVATE_SENTINEL at login.spec.ts:99:7' }],
    } as TestResult;
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    expect(safeTestResult(test, result).failureLocations).toEqual([]);
    new SafeReporter().onTestEnd(test, result);
    expect(stdout).toHaveBeenCalledExactlyOnceWith(
      `${status}: login.spec.ts:12 (5000ms); failure location unavailable\n`,
    );
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
