import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';
import { chromium } from '@playwright/test';

const require = createRequire(import.meta.url);
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const informational = args.some((arg) => ['--list', '--help', '-h', '--version', '-V'].includes(arg));
const headed = args.some((arg, index) => ['--headed', '--debug=inspector'].includes(arg)
  || (arg === '--debug' && args[index + 1] !== 'cli'))
  || Boolean(process.env.PWDEBUG && !['0', 'false', 'console'].includes(process.env.PWDEBUG));
const uiInBrowser = args.some((arg) => /^--ui-(?:host|port)(?:=|$)/.test(arg));
const uiMode = args.includes('--ui') || uiInBrowser;
const uiApp = uiMode && !uiInBrowser;
let uiOutputDirectory;

async function runUi(cliArgs, options) {
  const child = spawn(process.execPath, cliArgs, {
    ...options,
    // Forward terminal signals once, allowing Playwright to finish its cleanup.
    detached: process.platform !== 'win32',
  });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => resolve({ status, signal }));
    });
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}

try {
  if (!informational) {
    if (headed || uiApp) {
      accessSync(chromium.executablePath(), constants.X_OK);
    }
    if (!headed) {
      // A headless launch checks the matching headless shell through Playwright's
      // public API; executablePath() points to the separate headed browser.
      const browser = await chromium.launch({ headless: true });
      await browser.close();
    }
  }

  if (uiMode && !informational) {
    const directory = join(repositoryRoot, '.wrangler/e2e-ui');
    mkdirSync(directory, { recursive: true });
    uiOutputDirectory = mkdtempSync(join(directory, 'session-'));
  }
  const cliArgs = [require.resolve('@playwright/test/cli'), 'test', ...args];
  const options = {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: { ...process.env, ZEROPRESS_E2E_UI_OUTPUT_DIR: uiOutputDirectory },
  };
  const result = uiOutputDirectory
    ? await runUi(cliArgs, options)
    : spawnSync(process.execPath, cliArgs, options);
  if (result.error) throw result.error;
  process.exitCode = result.status
    ?? (result.signal === 'SIGINT' ? 130 : result.signal === 'SIGTERM' ? 143 : 1);
} catch (error) {
  const style = { stream: process.stderr };
  console.error(styleText(['bold', 'red'], 'Cannot start E2E tests.', style));
  console.error();
  if (error.code === 'ENOENT' || error.message.includes("Executable doesn't exist")) {
    console.error('Chromium is not installed for the current Playwright version.');
    console.error('Run ' + styleText('cyan', 'npx playwright install chromium', style) + ', then try again.');
  } else {
    console.error(error.message);
  }
  process.exitCode = 1;
} finally {
  if (uiOutputDirectory) rmSync(uiOutputDirectory, { recursive: true, force: true });
}
