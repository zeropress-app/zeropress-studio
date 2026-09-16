// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { setThemePreference, THEME_STORAGE_KEY } from '../lib/theme-preference';
import { ThemeSwitcher } from './ThemeSwitcher';
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
});

describe('ThemeSwitcher', () => {
  it('provides three explicit radio options with system selected by default', () => {
    render(<ThemeSwitcher />);

    expect(screen.getByRole('group', { name: 'Appearance' }))
      .toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Light' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Dark' })).not.toBeChecked();
  });

  it('updates the document root and storage when a preference is selected', async () => {
    const user = userEvent.setup();
    render(<ThemeSwitcher />);

    await user.click(screen.getByRole('radio', { name: 'Dark' }));

    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    // Read preferences from the shared store instead of keeping screen-local state.
    // Remounting the topbar or changing the theme elsewhere must preserve the selection.
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked();
  });

  it('describes the current state through a fieldset and visible options', () => {
    render(<ThemeSwitcher />);

    const group = screen.getByRole('group', { name: 'Appearance' });
    expect(group).toHaveTextContent('System');
    expect(group).toHaveTextContent('Light');
    expect(group).toHaveTextContent('Dark');
  });
});
