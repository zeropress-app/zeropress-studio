// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { changeLocale } from './i18n';
import { LOCALE_STORAGE_KEY } from './i18n/locale';
import { StudioPreferencesPage } from './StudioPreferencesPage';
import {
  StudioInterfaceSettingsProvider,
  useStudioInterfaceSettings,
} from './StudioInterfaceSettingsContext';

function SingleLocalePreferences() {
  const {
    applyOrganizationSettings,
    organizationPolicyLoaded,
  } = useStudioInterfaceSettings();

  useEffect(() => {
    void applyOrganizationSettings({
      default_locale: 'en',
      enabled_locales: ['en'],
    });
  }, [applyOrganizationSettings]);

  return organizationPolicyLoaded ? <StudioPreferencesPage /> : null;
}

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});

afterEach(() => cleanup());

describe('StudioPreferencesPage', () => {
  it('separates the Studio interface language from the published site locale', () => {
    render(<StudioPreferencesPage />);

    expect(screen.getByRole('heading', { name: 'Studio preferences' }))
      .toBeInTheDocument();
    expect(screen.getByRole('combobox', {
      name: 'Studio interface language',
    })).toHaveValue('en');
    expect(screen.getByText(/The public site language is unchanged/u))
      .toBeInTheDocument();
  });

  it('applies and stores the browser-local interface language immediately', async () => {
    const user = userEvent.setup();
    render(<StudioPreferencesPage />);

    await user.selectOptions(screen.getByRole('combobox', {
      name: 'Studio interface language',
    }), 'ko');

    expect(await screen.findByRole('heading', { name: 'Studio 환경설정' }))
      .toBeInTheDocument();
    expect(document.documentElement.lang).toBe('ko');
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('ko');
    expect(screen.getByRole('combobox', {
      name: 'Studio 인터페이스 언어',
    })).toHaveValue('ko');
  });

  it('shows organization management instead of a selector for one enabled language', async () => {
    render(
      <StudioInterfaceSettingsProvider>
        <SingleLocalePreferences />
      </StudioInterfaceSettingsProvider>,
    );

    expect(await screen.findByRole('heading', {
      name: 'Studio preferences',
    })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', {
      name: 'Studio interface language',
    })).not.toBeInTheDocument();
    expect(screen.getByText('Language is managed for this Studio'))
      .toBeInTheDocument();
    expect(screen.getByText(/English is the only interface language/u))
      .toBeInTheDocument();
  });
});
