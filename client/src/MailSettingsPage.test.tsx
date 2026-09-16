// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import {
  MAIL_SETTINGS_INITIAL_REVISION,
  materializeMailSettingsDefaults,
} from '../../contracts/mail-settings';
import { MailSettingsPage } from './MailSettingsPage';
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

describe('MailSettingsPage', () => {
  it('stores a provider credential without echoing it and sends a saved-config test', async () => {
    const initial = {
      settings: materializeMailSettingsDefaults(),
      credentials: {
        resend_api_key_configured: false,
        cloudflare_api_token_configured: false,
      },
      configured: false,
      revision: MAIL_SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    };
    const saved = {
      settings: {
        provider: 'resend' as const,
        from_email: 'mail@example.com',
        from_name: 'ZeroPress',
        cloudflare_account_id: '',
      },
      credentials: {
        resend_api_key_configured: true,
        cloudflare_api_token_configured: false,
      },
      configured: true,
      revision: '3'.repeat(32),
      updated_at_iso: '2026-08-04T02:00:00.000Z',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ success: true, data: initial }))
      .mockResolvedValueOnce(json({ success: true, data: saved }))
      .mockResolvedValueOnce(json({
        success: true,
        data: { status: 'accepted', provider: 'resend' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/settings/edge/mail']}>
        <MailSettingsPage
          data={{
            csrf_token: 'c'.repeat(43),
            user: { email: 'owner@example.com' },
          } as never}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Mail delivery' })).toBeInTheDocument();
    const saveButton = screen.getByRole('button', { name: 'Save mail settings' });
    expect(saveButton).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Provider'), 'resend');
    expect(saveButton).toBeEnabled();
    await user.click(saveButton);
    expect(await screen.findByText(
      'Review the provider, sender, account ID, and credential action before saving.',
    )).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await user.type(screen.getByLabelText('From email'), 'mail@example.com');
    await user.type(screen.getByLabelText('From name (optional)'), 'ZeroPress');
    await user.type(screen.getByLabelText('Resend API key'), 're_secret');
    await user.click(saveButton);
    expect(await screen.findByText('Mail delivery settings saved.')).toBeInTheDocument();

    const update = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(update).toMatchObject({
      settings: saved.settings,
      credentials: {
        resend_api_key: { action: 'replace', value: 're_secret' },
        cloudflare_api_token: { action: 'preserve' },
      },
    });
    expect(screen.getByLabelText('Resend API key')).toHaveValue('');
    await user.click(screen.getByRole('button', { name: 'Send test email' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Send this test email?',
    });
    expect(within(dialog).getByText('owner@example.com')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await user.click(within(dialog).getByRole('button', {
      name: 'Confirm and send',
    }));
    expect(await screen.findByText('The provider accepted the test email.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', {
      name: 'Send this test email?',
    })).not.toBeInTheDocument();
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      recipient: 'owner@example.com',
    });
  });

  it('asks the administrator to save after verifying an unsaved credential', async () => {
    const initial = {
      settings: materializeMailSettingsDefaults(),
      credentials: {
        resend_api_key_configured: false,
        cloudflare_api_token_configured: false,
      },
      configured: false,
      revision: MAIL_SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ success: true, data: initial }))
      .mockResolvedValueOnce(json({
        success: true,
        data: { status: 'credential_verified', provider: 'resend' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/settings/edge/mail']}>
        <MailSettingsPage
          data={{
            csrf_token: 'c'.repeat(43),
            user: { email: 'owner@example.com' },
          } as never}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Mail delivery' }))
      .toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Provider'), 'resend');
    await user.type(screen.getByLabelText('From email'), 'mail@example.com');
    await user.type(screen.getByLabelText('Resend API key'), 're_secret');
    await user.click(screen.getByRole('button', { name: 'Verify credential' }));

    expect(await screen.findByText(
      'The provider credential is valid. Save the mail settings before sending a test email.',
    )).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send test email' })).toBeDisabled();
  });
});
