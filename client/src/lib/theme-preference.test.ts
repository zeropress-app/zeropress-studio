// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  applyResolvedTheme,
  getResolvedTheme,
  getThemePreference,
  readThemePreference,
  resolveTheme,
  setThemePreference,
  startThemeSync,
  subscribeThemePreference,
  THEME_STORAGE_KEY,
} from './theme-preference';

type MediaListener = (event: MediaQueryListEvent) => void;

function stubSystemDark(matches: boolean): {
  fire: (next: boolean) => void;
  listeners: () => number;
} {
  const listeners = new Set<MediaListener>();
  let current = matches;
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches() {
      return current;
    },
    addEventListener: (_type: string, listener: MediaListener) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: string, listener: MediaListener) => {
      listeners.delete(listener);
    },
  }));
  return {
    fire: (next: boolean) => {
      current = next;
      for (const listener of listeners) {
        listener({} as MediaQueryListEvent);
      }
    },
    listeners: () => listeners.size,
  };
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.head.innerHTML =
    '<meta name="theme-color" content="#f8eee3" />';
});

afterEach(() => {
  vi.unstubAllGlobals();
  setThemePreference('system');
});

describe('Reading theme preferences', () => {
  it('follows the system when no preference has been selected', () => {
    expect(readThemePreference()).toBe('system');
  });

  it('falls back to system for unrecognized stored values', () => {
    // Old or manually edited values must not leave the theme unset.
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(readThemePreference()).toBe('system');
  });

  it.each(['light', 'dark'] as const)('reads the selected preference %s unchanged', (value) => {
    localStorage.setItem(THEME_STORAGE_KEY, value);
    expect(readThemePreference()).toBe(value);
  });
});

describe('Resolving themes', () => {
  it('resolves system against the OS preference', () => {
    stubSystemDark(true);
    expect(resolveTheme('system')).toBe('dark');
    stubSystemDark(false);
    expect(resolveTheme('system')).toBe('light');
  });

  it('lets an explicit choice override the OS preference', () => {
    stubSystemDark(true);
    expect(resolveTheme('light')).toBe('light');
    stubSystemDark(false);
    expect(resolveTheme('dark')).toBe('dark');
  });

  it('falls back to light when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(resolveTheme('system')).toBe('light');
  });

  it('lets a two-state control read the resolved theme from the shared preference', () => {
    stubSystemDark(true);
    setThemePreference('system');
    expect(getResolvedTheme()).toBe('dark');

    setThemePreference('light');
    expect(getResolvedTheme()).toBe('light');
  });
});

describe('Applying themes', () => {
  it('updates the document root and browser chrome color together', () => {
    applyResolvedTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.querySelector('meta[name="theme-color"]')
      ?.getAttribute('content')).toBe('#16100d');

    applyResolvedTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.querySelector('meta[name="theme-color"]')
      ?.getAttribute('content')).toBe('#f8eee3');
  });

  it('stores the selection and notifies subscribers', () => {
    stubSystemDark(false);
    const seen: string[] = [];
    const unsubscribe = subscribeThemePreference(() => {
      seen.push(getThemePreference());
    });

    setThemePreference('dark');

    expect(seen).toEqual(['dark']);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    unsubscribe();
  });
});

describe('Following OS preferences', () => {
  it('updates the theme on OS changes while system is selected', () => {
    const system = stubSystemDark(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'system');
    const stop = startThemeSync();
    expect(document.documentElement.dataset.theme).toBe('light');

    system.fire(true);

    expect(document.documentElement.dataset.theme).toBe('dark');
    stop();
    expect(system.listeners()).toBe(0);
  });

  it('retains an explicit selection when the OS preference changes', () => {
    const system = stubSystemDark(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    const stop = startThemeSync();

    system.fire(true);

    expect(document.documentElement.dataset.theme).toBe('light');
    stop();
  });
});

describe('Theme synchronization across tabs', () => {
  it('updates the document and subscribers without writing storage events back', () => {
    stubSystemDark(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    const seen: string[] = [];
    const unsubscribe = subscribeThemePreference(() => {
      seen.push(getThemePreference());
    });
    const stop = startThemeSync();

    window.dispatchEvent(new StorageEvent('storage', {
      key: THEME_STORAGE_KEY,
      newValue: 'dark',
      storageArea: localStorage,
    }));

    expect(getThemePreference()).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.querySelector('meta[name="theme-color"]')
      ?.getAttribute('content')).toBe('#16100d');
    expect(seen).toEqual(['dark']);
    // The synthetic event leaves storage set to light; verify that dark is not
    // written back. In a real browser, another tab has already changed storage.
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    stop();
    window.dispatchEvent(new StorageEvent('storage', {
      key: THEME_STORAGE_KEY,
      newValue: 'light',
      storageArea: localStorage,
    }));
    expect(getThemePreference()).toBe('dark');
    unsubscribe();
  });
});

describe('First-paint script', () => {
  // jsdom does not provide a file: URL in import.meta.url, so read from
  // the project-relative path.
  const html = readFileSync(resolve(process.cwd(), 'client/index.html'), 'utf8');
  const headers = readFileSync(
    resolve(process.cwd(), 'client/public/_headers'),
    'utf8',
  );
  const inlineScript = new DOMParser().parseFromString(html, 'text/html')
    .querySelector('script:not([src]):not([type])')?.textContent;

  /*
   * The inline script duplicates this module's policy to avoid a light flash
   * before the module loads for dark-theme users. Keep both implementations
   * aligned.
   */
  it('reads the same storage key as the module', () => {
    expect(html).toContain(THEME_STORAGE_KEY);
  });

  it('uses the same browser chrome colors as the module', () => {
    applyResolvedTheme('dark');
    const dark = document.querySelector('meta[name="theme-color"]')
      ?.getAttribute('content');
    expect(dark).toBeTruthy();
    expect(html).toContain(dark as string);
  });

  it('sets a theme even when storage cannot be read', () => {
    // When privacy restrictions make localStorage access throw, data-theme must
    // still be set so the page renders with its theme tokens.
    expect(html).toMatch(/catch[^}]*dataset\.theme/u);
  });

  it('allows only the exact script hash in CSP', () => {
    expect(inlineScript).toBeTruthy();
    const hash = createHash('sha256')
      .update(inlineScript as string)
      .digest('base64');

    expect(headers).toContain(`script-src 'self' 'sha256-${hash}'`);
    expect(headers).not.toMatch(/script-src[^;]*'unsafe-inline'/u);
  });

  it('additionally allows Monaco\'s dynamic styles and same-origin workers', () => {
    expect(headers).toContain("style-src 'self' 'unsafe-inline'");
    expect(headers).toContain("worker-src 'self'");
    expect(headers).toContain("img-src 'self' data: blob: http: https:");
  });
});
