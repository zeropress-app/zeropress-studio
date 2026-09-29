import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { readEditorDiagnostic, type EditorDiagnostic } from './editor-diagnostics';

export type SafeTestResult = {
  file: string;
  line: number;
  status: TestResult['status'];
  retry: number;
  durationMs: number;
  failureLocations: Array<{ file: string; line: number; column: number }>;
  editorState?: EditorDiagnostic;
};

export function safeTestResult(test: TestCase, result: TestResult): SafeTestResult {
  // No error messages/stacks, titles containing fixture data, stdout, steps,
  // attachments or page snapshots enter the persistent report.
  const editorState = result.status === 'failed' || result.status === 'timedOut'
    ? readEditorDiagnostic(result.annotations ?? []) : undefined;
  return {
    file: basename(test.location.file),
    line: test.location.line,
    status: result.status,
    retry: result.retry,
    durationMs: result.duration,
    failureLocations: result.errors.flatMap(({ location }) => location ? [{
      file: basename(location.file),
      line: location.line,
      column: location.column,
    }] : []),
    ...(editorState ? { editorState } : {}),
  };
}

export default class SafeReporter implements Reporter {
  private results: SafeTestResult[] = [];
  private globalErrors = 0;

  printsToStdio() { return true; }

  onTestEnd(test: TestCase, result: TestResult) {
    const safe = safeTestResult(test, result);
    this.results.push(safe);
    const locations = safe.failureLocations.map(({ file, line, column }) => `${file}:${line}:${column}`);
    const failure = locations.length > 0
      ? `; failure at ${locations.join(', ')}`
      : safe.status === 'failed' || safe.status === 'timedOut'
        ? '; failure location unavailable'
        : '';
    process.stdout.write(`${safe.status}: ${safe.file}:${safe.line} (${safe.durationMs}ms)${failure}\n`);
    if (safe.editorState) process.stdout.write(`  editor state: ${JSON.stringify(safe.editorState)}\n`);
  }

  onError() {
    this.globalErrors += 1;
    process.stderr.write('E2E runner error. Reproduce locally in Playwright UI; raw diagnostics omitted.\n');
  }

  onEnd(result: FullResult) {
    const directory = resolve('playwright-report');
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, 'summary.json'), JSON.stringify({
      status: result.status,
      durationMs: result.duration,
      globalErrors: this.globalErrors,
      tests: this.results,
    }, null, 2));
    process.stdout.write(`E2E ${result.status}: ${this.results.length} attempts; safe report: playwright-report/summary.json\n`);
  }
}
