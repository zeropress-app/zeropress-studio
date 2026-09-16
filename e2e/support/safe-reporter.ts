import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

export type SafeTestResult = {
  file: string;
  line: number;
  status: TestResult['status'];
  retry: number;
  durationMs: number;
};

export function safeTestResult(test: TestCase, result: TestResult): SafeTestResult {
  // No error messages/stacks, titles containing fixture data, stdout, steps,
  // attachments or page snapshots enter the persistent report.
  return {
    file: basename(test.location.file),
    line: test.location.line,
    status: result.status,
    retry: result.retry,
    durationMs: result.duration,
  };
}

export default class SafeReporter implements Reporter {
  private results: SafeTestResult[] = [];
  private globalErrors = 0;

  printsToStdio() { return true; }

  onTestEnd(test: TestCase, result: TestResult) {
    const safe = safeTestResult(test, result);
    this.results.push(safe);
    process.stdout.write(`${safe.status}: ${safe.file}:${safe.line} (${safe.durationMs}ms)\n`);
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
