import { describe, expect, it } from 'vitest';
import { resolveE2EOptions } from './e2e-options.mjs';

describe('E2E browser requirements', () => {
  it.each([
    { args: [], headed: false, headless: true, ui: false },
    { args: ['--headed'], headed: true, headless: false, ui: false },
    { args: ['--ui'], headed: true, headless: true, ui: true },
    { args: ['--ui', '--headed'], headed: true, headless: false, ui: true },
    { args: ['--debug'], headed: true, headless: false, ui: false },
    { args: ['--debug=inspector'], headed: true, headless: false, ui: false },
    { args: ['--debug=cli'], headed: false, headless: true, ui: false },
    { args: ['--debug', 'cli'], headed: false, headless: true, ui: false },
    { args: ['--ui', '--ui-host=127.0.0.1'], headed: false, headless: true, ui: true },
    { args: ['--ui', '--ui-port', '0'], headed: false, headless: true, ui: true },
    { args: ['--ui-host', '127.0.0.1'], headed: false, headless: true, ui: true },
    { args: ['--ui-port=0'], headed: false, headless: true, ui: true },
    { args: ['--ui-host=127.0.0.1', '--headed'], headed: true, headless: false, ui: true },
  ])('selects browsers and trace storage for $args', ({ args, headed, headless, ui }) => {
    expect(resolveE2EOptions(args)).toEqual({
      checkHeadedBrowser: headed, checkHeadlessBrowser: headless, createUiSession: ui,
    });
  });

  it.each([
    { value: undefined, headed: false },
    { value: '', headed: false },
    { value: '0', headed: false },
    { value: 'false', headed: false },
    { value: 'console', headed: false },
    { value: '1', headed: true },
  ])('selects the browser for PWDEBUG=$value', ({ value, headed }) => {
    expect(resolveE2EOptions([], { PWDEBUG: value })).toEqual({
      checkHeadedBrowser: headed, checkHeadlessBrowser: !headed, createUiSession: false,
    });
  });

  it.each(['--list', '--help', '-h', '--version', '-V'])(
    'runs %s without browser checks or UI traces, including in debug UI mode', (argument) => {
      expect(resolveE2EOptions(['--ui', '--debug', argument], { PWDEBUG: '1' })).toEqual({
        checkHeadedBrowser: false, checkHeadlessBrowser: false, createUiSession: false,
      });
    },
  );
});
