// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANALYTICS_DEFAULTS,
  ANALYTICS_INITIAL_REVISION,
  type AnalyticsSettingsDocument,
  type UpdateAnalyticsSettings,
} from '../../contracts/analytics';
import {
  GENERAL_SETTINGS_DEFAULTS,
  GENERAL_SETTINGS_INITIAL_REVISION,
} from '../../contracts/general-settings';
import { AnalyticsSettingsPage } from './AnalyticsSettingsPage';
import { changeLocale } from './i18n';

const initial: AnalyticsSettingsDocument = {
  settings: { ...ANALYTICS_DEFAULTS },
  configured: false,
  token_configured: false,
  revision: ANALYTICS_INITIAL_REVISION,
  updated_at_iso: null,
};
const configured: AnalyticsSettingsDocument = {
  settings: {
    enabled: true,
    account_id: 'a'.repeat(32),
    site_tag: 'b'.repeat(32),
  },
  configured: true,
  token_configured: true,
  revision: 'c'.repeat(32),
  updated_at_iso: '2026-09-21T12:00:00Z',
};
const dashboardUrl = `https://dash.cloudflare.com/${configured.settings.account_id}/web-analytics/overview?siteTag~in=${configured.settings.site_tag}`;
const general = {
  settings: {
    ...GENERAL_SETTINGS_DEFAULTS,
    url: 'https://example.com',
    timezone: 'Asia/Seoul',
  },
  revision: GENERAL_SETTINGS_INITIAL_REVISION,
  updated_at_iso: null,
};
beforeEach(async () => {
  await changeLocale('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(document = initial, conflict = false) {
  const mutations: Array<{
    path: string;
    body: Record<string, unknown>;
    headers: Headers;
  }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/settings/general' && !init?.body)
        return Response.json({ success: true, data: general });
      if (path === '/api/settings/analytics' && !init?.body)
        return Response.json({ success: true, data: document });
      if (
        (path === '/api/settings/analytics' ||
          path === '/api/settings/analytics/test-connection') &&
        init?.body
      ) {
        mutations.push({
          path,
          body: JSON.parse(String(init.body)),
          headers: new Headers(init.headers),
        });
        if (path.endsWith('/test-connection'))
          return Response.json({ success: true, data: { status: 'no_data' } });
        if (conflict)
          return Response.json({
            success: false,
            error: { code: 'SETTINGS_REVISION_CONFLICT' },
          });
        const update = JSON.parse(String(init.body)) as UpdateAnalyticsSettings;
        const tokenConfigured =
          update.credential.action === 'preserve'
            ? document.token_configured
            : update.credential.action === 'replace';
        document = {
          ...configured,
          settings: update.settings,
          token_configured: tokenConfigured,
          configured: update.settings.enabled && tokenConfigured,
        };
        return Response.json({ success: true, data: document });
      }
      throw new Error(`Unexpected Analytics request: ${path}`);
    }),
  );
  render(
    <MemoryRouter initialEntries={['/settings/site/analytics']}>
      <AnalyticsSettingsPage
        data={{ csrf_token: 'c'.repeat(43) }}
        onSessionEnded={vi.fn()}
      />
    </MemoryRouter>,
  );
  return { user: userEvent.setup(), mutations };
}

describe('AnalyticsSettingsPage', () => {
  it('tests a candidate token before saving, then clears it after a successful encrypted save', async () => {
    const { user, mutations } = setup();
    const url = await screen.findByLabelText('Web Analytics URL');
    const selectSite = screen.getByRole('link', {
      name: 'Select site in Cloudflare',
    });
    expect(selectSite).toHaveAttribute(
      'href',
      'https://dash.cloudflare.com/?to=/:account/web-analytics/sites',
    );
    expect(selectSite).toHaveAttribute('target', '_blank');
    const createToken = screen.getByRole('link', {
      name: 'Create API Token in Cloudflare',
    });
    expect(createToken).toHaveAttribute('target', '_blank');
    const tokenUrl = new URL(createToken.getAttribute('href')!);
    expect(tokenUrl.origin).toBe('https://dash.cloudflare.com');
    expect(Object.fromEntries(tokenUrl.searchParams)).toEqual({
      to: '/:account/api-tokens',
      permissionGroupKeys: JSON.stringify([
        { key: 'account_analytics', type: 'read' },
      ]),
      name: 'ZeroPress Studio Analytics',
    });
    await user.click(url);
    await user.paste(`${dashboardUrl}&excludeBots=Yes`);
    expect(screen.getByLabelText('Account ID')).toHaveValue(
      configured.settings.account_id,
    );
    expect(screen.getByLabelText('Site Tag')).toHaveValue(
      configured.settings.site_tag,
    );
    expect(screen.getByLabelText('Account ID')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Site Tag')).toHaveAttribute('readonly');
    await user.type(screen.getByLabelText('API Token'), 'synthetic-token');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(
      await screen.findByText(/API query succeeded, but no traffic/),
    ).toBeVisible();
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.body).toEqual({
      account_id: configured.settings.account_id,
      site_tag: configured.settings.site_tag,
      credential: 'synthetic-token',
    });
    expect(mutations[0]?.headers.get('X-ZeroPress-CSRF')).toBe('c'.repeat(43));
    await user.click(screen.getByRole('switch', { name: 'Enable analytics' }));
    await user.click(
      screen.getByRole('button', { name: 'Save analytics settings' }),
    );
    expect(await screen.findByText('Analytics settings saved.')).toBeVisible();
    expect(mutations[1]?.body).toEqual({
      settings: configured.settings,
      credential: { action: 'replace', value: 'synthetic-token' },
      expected_revision: ANALYTICS_INITIAL_REVISION,
    });
    expect(screen.getByLabelText('API Token')).toHaveValue('');
    expect(screen.getByLabelText('Web Analytics URL')).toHaveValue(
      dashboardUrl,
    );
    expect(screen.getByText('example.com · Asia/Seoul')).toBeVisible();
  });

  it('restores stored IDs as a URL and switches input modes without changing the connection', async () => {
    const { user, mutations } = setup(configured);
    expect(await screen.findByLabelText('Web Analytics URL')).toHaveValue(
      dashboardUrl,
    );
    const mode = screen.getByRole('switch', { name: 'Enter IDs manually' });
    await user.click(mode);
    expect(screen.getByLabelText('Account ID')).not.toHaveAttribute('readonly');
    expect(screen.getByLabelText('Site Tag')).not.toHaveAttribute('readonly');
    await user.click(mode);
    expect(screen.getByLabelText('Web Analytics URL')).toHaveValue(
      dashboardUrl,
    );
    expect(
      screen.getByRole('button', { name: 'Save analytics settings' }),
    ).toBeDisabled();
    await user.click(screen.getByLabelText('Web Analytics URL'));
    await user.paste('&excludeBots=Yes');
    expect(screen.getByRole('button', { name: 'Undo changes' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]?.body).toEqual({
      account_id: configured.settings.account_id,
      site_tag: configured.settings.site_tag,
    });
  });

  it('keeps manual edits and the token while switching back to URL input', async () => {
    const { user, mutations } = setup(configured);
    await user.click(
      await screen.findByRole('switch', { name: 'Enter IDs manually' }),
    );
    const account = screen.getByLabelText('Account ID');
    const site = screen.getByLabelText('Site Tag');
    await user.clear(account);
    await user.type(account, 'd'.repeat(32));
    await user.clear(site);
    await user.type(site, 'e'.repeat(32));
    await user.type(screen.getByLabelText('API Token'), 'replacement-token');
    await user.click(
      screen.getByRole('switch', { name: 'Enter IDs manually' }),
    );
    expect(screen.getByLabelText('Web Analytics URL')).toHaveValue(
      `https://dash.cloudflare.com/${'d'.repeat(32)}/web-analytics/overview?siteTag~in=${'e'.repeat(32)}`,
    );
    expect(screen.getByLabelText('API Token')).toHaveValue('replacement-token');
    await user.click(
      screen.getByRole('button', { name: 'Save analytics settings' }),
    );
    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]?.body).toEqual({
      settings: {
        enabled: true,
        account_id: 'd'.repeat(32),
        site_tag: 'e'.repeat(32),
      },
      credential: { action: 'replace', value: 'replacement-token' },
      expected_revision: configured.revision,
    });
  });

  it.each([
    ['empty', ''],
    ['invalid', 'https://example.com/analytics'],
    ['multiple sites', `${dashboardUrl}&siteTag~in=${'c'.repeat(32)}`],
  ])(
    'blocks %s URL edits from submitting the previously stored IDs and supports undo',
    async (_description, value) => {
      const { user, mutations } = setup(configured);
      const url = await screen.findByLabelText('Web Analytics URL');
      await user.clear(url);
      if (value) await user.paste(value);
      expect(url).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByLabelText('Account ID')).toHaveValue('');
      expect(screen.getByLabelText('Site Tag')).toHaveValue('');
      expect(
        screen.getByRole('button', { name: 'Test connection' }),
      ).toBeDisabled();
      const save = screen.getByRole('button', {
        name: 'Save analytics settings',
      });
      expect(save).toBeDisabled();
      fireEvent.submit(save.closest('form')!);
      expect(mutations).toEqual([]);
      await user.click(screen.getByRole('button', { name: 'Undo changes' }));
      expect(url).toHaveValue(dashboardUrl);
      expect(screen.getByLabelText('Account ID')).toHaveValue(
        configured.settings.account_id,
      );
      expect(
        screen.getByRole('button', { name: 'Test connection' }),
      ).toBeEnabled();
      expect(
        screen.getByRole('button', { name: 'Undo changes' }),
      ).toBeDisabled();
    },
  );

  it('recovers from an invalid URL by replacing both IDs and clears the prior test result', async () => {
    const { user, mutations } = setup(configured);
    await user.click(
      await screen.findByRole('button', { name: 'Test connection' }),
    );
    expect(
      await screen.findByText(/API query succeeded, but no traffic/),
    ).toBeVisible();
    const url = screen.getByLabelText('Web Analytics URL');
    await user.clear(url);
    await user.paste('https://example.com');
    await user.clear(url);
    await user.paste(
      `https://dash.cloudflare.com/${'d'.repeat(32)}/web-analytics/overview?siteTag~in=${'e'.repeat(32)}`,
    );
    expect(screen.getByLabelText('Account ID')).toHaveValue('d'.repeat(32));
    expect(screen.getByLabelText('Site Tag')).toHaveValue('e'.repeat(32));
    expect(
      screen.queryByText(/API query succeeded, but no traffic/),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await waitFor(() => expect(mutations).toHaveLength(2));
    expect(mutations[1]?.body).toEqual({
      account_id: 'd'.repeat(32),
      site_tag: 'e'.repeat(32),
    });
  });

  it('preserves incomplete manual IDs across mode switches', async () => {
    const { user } = setup(configured);
    const mode = await screen.findByRole('switch', {
      name: 'Enter IDs manually',
    });
    await user.click(mode);
    await user.clear(screen.getByLabelText('Site Tag'));
    await user.click(mode);
    expect(screen.getByLabelText('Web Analytics URL')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await user.click(mode);
    expect(screen.getByLabelText('Account ID')).toHaveValue(
      configured.settings.account_id,
    );
    expect(screen.getByLabelText('Site Tag')).toHaveValue('');
  });

  it('opens an incomplete saved connection in manual mode so it can be completed', async () => {
    const { user } = setup({
      ...initial,
      settings: {
        ...ANALYTICS_DEFAULTS,
        account_id: configured.settings.account_id,
      },
    });
    expect(
      await screen.findByRole('switch', { name: 'Enter IDs manually' }),
    ).toBeChecked();
    expect(screen.getByLabelText('Account ID')).toHaveValue(
      configured.settings.account_id,
    );
    await user.type(
      screen.getByLabelText('Site Tag'),
      configured.settings.site_tag,
    );
    await user.click(
      screen.getByRole('switch', { name: 'Enter IDs manually' }),
    );
    expect(screen.getByLabelText('Web Analytics URL')).toHaveValue(
      dashboardUrl,
    );
  });

  it('preserves a stored token on an ordinary settings change', async () => {
    const { user, mutations } = setup(configured);
    await user.click(
      await screen.findByRole('switch', { name: 'Enable analytics' }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Save analytics settings' }),
    );
    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]?.body).toMatchObject({
      credential: { action: 'preserve' },
      settings: { enabled: false },
    });
  });

  it('requires disabling analytics before removing its saved token', async () => {
    const { user, mutations } = setup(configured);
    await user.click(await screen.findByLabelText('Remove saved token'));
    expect(
      screen.getByRole('button', { name: 'Save analytics settings' }),
    ).toBeDisabled();
    await user.click(screen.getByRole('switch', { name: 'Enable analytics' }));
    await user.click(
      screen.getByRole('button', { name: 'Save analytics settings' }),
    );
    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]?.body).toMatchObject({
      credential: { action: 'remove' },
      settings: { enabled: false },
    });
  });

  it('preserves edits after a revision conflict and offers reloading', async () => {
    const { user } = setup(configured, true);
    await user.click(
      await screen.findByRole('switch', { name: 'Enable analytics' }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Save analytics settings' }),
    );
    expect(
      await screen.findByText('These settings changed in another session'),
    ).toBeVisible();
    expect(
      screen.getByRole('switch', { name: 'Enable analytics' }),
    ).not.toBeChecked();
    expect(
      screen.getByRole('button', { name: 'Save analytics settings' }),
    ).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('switch', { name: 'Enable analytics' }),
    ).toBeChecked();
  });
});
