// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  changeLocale,
  getCurrentLocale,
  startLocaleSync,
} from './index';
import { LOCALE_STORAGE_KEY } from './locale';

function dispatchLocaleChange(value: string) {
  window.dispatchEvent(new StorageEvent('storage', {
    key: LOCALE_STORAGE_KEY,
    newValue: value,
    storageArea: localStorage,
  }));
}

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});

afterEach(async () => {
  await changeLocale('en');
});

describe('Locale synchronization across tabs', () => {
  it('loads the required catalog before switching without writing back to storage', async () => {
    const stop = startLocaleSync();

    dispatchLocaleChange('ko');

    await vi.waitFor(() => {
      expect(getCurrentLocale()).toBe('ko');
    });
    expect(document.documentElement.lang).toBe('ko');
    // Synthetic events do not change jsdom storage. Check that switching did not
    // write ko again; in a browser, another tab has already updated the stored value.
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('en');
    stop();
  });

  it('applies only the latest locale after rapid consecutive changes', async () => {
    const stop = startLocaleSync();

    dispatchLocaleChange('ko');
    dispatchLocaleChange('en');

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(getCurrentLocale()).toBe('en');
    stop();
  });

  it('stops applying cross-tab changes after unsubscribing', async () => {
    const stop = startLocaleSync();
    stop();

    dispatchLocaleChange('ko');
    await Promise.resolve();

    expect(getCurrentLocale()).toBe('en');
  });
});
