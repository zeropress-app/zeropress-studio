// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import {
  materializeNewsletterSettingsDefaults,
  NEWSLETTER_SETTINGS_INITIAL_REVISION,
} from '../../contracts/newsletter-settings';
import { NewsletterSettingsPage } from './NewsletterSettingsPage';
import { changeLocale } from './i18n';

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});

describe('NewsletterSettingsPage', () => {
  it('saves an enabled CTA as one revision-bound document', async () => {
    const defaults = materializeNewsletterSettingsDefaults();
    const initial = {
      settings: defaults,
      revision: NEWSLETTER_SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    };
    const saved = {
      ...defaults,
      enabled: true,
      title: 'Product notes',
      signup_url: 'https://example.com/signup',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ success: true, data: initial }))
      .mockResolvedValueOnce(json({
        success: true,
        data: {
          settings: saved,
          revision: '3'.repeat(32),
          updated_at_iso: '2026-08-04T02:00:00.000Z',
        },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/settings/site/newsletter']}>
        <NewsletterSettingsPage
          data={{ csrf_token: 'c'.repeat(43) } as never}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Newsletter' })).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Include newsletter CTA' }));
    await user.type(screen.getByLabelText('Title (optional)'), 'Product notes');
    await user.type(screen.getByLabelText('Signup URL (optional)'), 'https://example.com/signup');
    await user.click(screen.getByRole('button', { name: 'Save Newsletter' }));

    expect(await screen.findByText('Newsletter CTA settings saved.')).toBeInTheDocument();
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      settings: saved,
      expected_revision: NEWSLETTER_SETTINGS_INITIAL_REVISION,
    });
  });
});
