// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setThemePreference,
  THEME_STORAGE_KEY,
} from '../lib/theme-preference';
import { ThemeToggle } from './ThemeToggle';
import '../i18n';

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  setThemePreference('system');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setThemePreference('system');
});

describe('ThemeToggle', () => {
  it('switches the shared key from system-resolved light to explicit dark', async () => {
    const user = userEvent.setup();
    render(<ThemeToggle />);

    const toggle = screen.getByRole('button', {
      name: 'Use dark appearance',
    });
    await user.click(toggle);

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(screen.getByRole('button', {
      name: 'Use light appearance',
    })).toBeInTheDocument();
  });

  it('respects system-resolved dark and switches to explicit light', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      media: query,
      matches: true,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    setThemePreference('system');
    const user = userEvent.setup();
    render(<ThemeToggle />);

    await user.click(screen.getByRole('button', {
      name: 'Use light appearance',
    }));

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
