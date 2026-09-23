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
  PUBLISHING_DEFAULTS,
  PUBLISHING_INITIAL_REVISION,
  publishingTargetSchema,
  targetFromSettings,
  type PublishingSettingsDocument,
  type UpdatePublishingSettings,
} from '../../contracts/publishing';
import { PublishingSettingsPage } from './PublishingSettingsPage';
import { changeLocale } from './i18n';
const target = {
  owner: 'example',
  repo: 'site',
  branch: 'release/current',
  path: 'data/preview.json',
};
const file = {
  target,
  blob_sha: 'b'.repeat(40),
  metadata_status: 'missing',
  data_hash: null,
  commit: {
    sha: 'c'.repeat(40),
    url: 'https://github.com/example/site/commit/' + 'c'.repeat(40),
    committed_at_iso: '2026-09-21T12:00:00Z',
  },
};
const initial: PublishingSettingsDocument = {
  settings: { ...PUBLISHING_DEFAULTS },
  configured: false,
  token_configured: false,
  revision: PUBLISHING_INITIAL_REVISION,
  updated_at_iso: null,
};
const configured: PublishingSettingsDocument = {
  ...initial,
  settings: { enabled: true, ...target },
  configured: true,
  token_configured: true,
};
const fileUrl =
  'https://github.com/example/site/blob/release/current/data/preview.json';
beforeEach(async () => {
  await changeLocale('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(document = initial, failure = '') {
  const mutations: { path: string; body: Record<string, unknown> }[] = [];
  const unexpected: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/settings/publishing' && !init?.body)
        return Response.json({ success: true, data: document });
      if (
        (path === '/api/settings/publishing' ||
          path === '/api/settings/publishing/test-connection') &&
        init?.body
      ) {
        expect(new Headers(init.headers).get('X-ZeroPress-CSRF')).toBe(
          'synthetic-csrf',
        );
        const body = JSON.parse(String(init.body));
        mutations.push({ path, body });
        if (failure)
          return Response.json({ success: false, error: { code: failure } });
        if (path.endsWith('test-connection'))
          return Response.json({ success: true, data: file });
        const update = body as UpdatePublishingSettings;
        const hasToken =
          update.credential.action === 'preserve'
            ? document.token_configured
            : update.credential.action === 'replace';
        document = {
          ...configured,
          settings: update.settings,
          configured:
            hasToken &&
            publishingTargetSchema.safeParse(
              targetFromSettings(update.settings),
            ).success,
          token_configured: hasToken,
        };
        return Response.json({ success: true, data: document });
      }
      unexpected.push(path);
      throw new Error('Unexpected test request');
    }),
  );
  render(
    <MemoryRouter initialEntries={['/settings/site/publishing']}>
      <PublishingSettingsPage
        data={{ csrf_token: 'synthetic-csrf' }}
        onSessionEnded={vi.fn()}
      />
    </MemoryRouter>,
  );
  return { user: userEvent.setup(), mutations, unexpected };
}
describe('publishing settings', () => {
  it('resolves a slash branch before saving normalized settings with a replacement token', async () => {
    const { user, mutations, unexpected } = setup();
    fireEvent.change(await screen.findByLabelText('GitHub file URL'), {
      target: { value: fileUrl },
    });
    expect(screen.getByLabelText('Repository owner')).toHaveAttribute(
      'readonly',
    );
    const tokenLink = screen.getByRole('link', { name: 'Create GitHub token' });
    expect(tokenLink).toHaveAttribute('target', '_blank');
    expect(tokenLink.getAttribute('href')).toContain('contents=write');
    expect(tokenLink.getAttribute('href')).toContain('target_name=example');
    fireEvent.change(screen.getByLabelText('GitHub Token'), {
      target: { value: 'synthetic-token' },
    });
    await user.click(screen.getByRole('button', { name: 'Check connection' }));
    expect(
      await screen.findByText(/branch and JSON file are accessible/),
    ).toBeVisible();
    expect(screen.getByLabelText('Branch')).toHaveValue('release/current');
    await user.click(screen.getByRole('switch', { name: 'Publish to GitHub' }));
    await user.click(
      screen.getByRole('button', { name: 'Save publishing settings' }),
    );
    expect(await screen.findByText('Publishing settings saved.')).toBeVisible();
    expect(screen.getByLabelText('GitHub Token')).toHaveValue('');
    expect(mutations[0]?.body).toEqual({
      file_url: fileUrl,
      credential: 'synthetic-token',
      expected_revision: PUBLISHING_INITIAL_REVISION,
    });
    expect(mutations[1]?.body).toEqual({
      settings: configured.settings,
      credential: { action: 'replace', value: 'synthetic-token' },
      expected_revision: PUBLISHING_INITIAL_REVISION,
    });
    expect(unexpected).toEqual([]);
  });
  it('sends unresolved URLs for server resolution and blocks invalid URL edits', async () => {
    const { user, mutations } = setup(configured);
    fireEvent.change(await screen.findByLabelText('GitHub file URL'), {
      target: { value: 'https://example.test/data.json' },
    });
    expect(
      screen.getByRole('button', { name: 'Save publishing settings' }),
    ).toBeDisabled();
    expect(screen.getByLabelText('Repository owner')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('GitHub file URL'), {
      target: { value: fileUrl },
    });
    await user.click(
      screen.getByRole('button', { name: 'Save publishing settings' }),
    );
    await screen.findByText('Publishing settings saved.');
    expect(mutations[0]?.body.file_url).toBe(fileUrl);
  });
  it('allows manual branch selection after an ambiguous URL, preserving the draft on conflict', async () => {
    const { user, mutations } = setup(configured, 'SETTINGS_REVISION_CONFLICT');
    await screen.findByLabelText('GitHub file URL');
    await user.click(
      screen.getByRole('switch', { name: 'Enter target manually' }),
    );
    expect(screen.getByLabelText('Branch')).not.toHaveAttribute('readonly');
    fireEvent.change(screen.getByLabelText('Branch'), {
      target: { value: 'release/next' },
    });
    await user.click(
      screen.getByRole('button', { name: 'Save publishing settings' }),
    );
    expect(
      await screen.findByText(
        'The connection settings changed. Reload them before continuing.',
      ),
    ).toBeVisible();
    expect(screen.getByLabelText('Branch')).toHaveValue('release/next');
    expect(mutations[0]?.body.credential).toEqual({ action: 'preserve' });
  });
  it('disables the connection before removing its saved token', async () => {
    const { user, mutations } = setup(configured);
    await screen.findByLabelText('GitHub file URL');
    await user.click(
      screen.getByRole('switch', { name: 'Delete saved token' }),
    );
    expect(
      screen.getByRole('button', { name: 'Save publishing settings' }),
    ).toBeDisabled();
    await user.click(screen.getByRole('switch', { name: 'Publish to GitHub' }));
    await user.click(
      screen.getByRole('button', { name: 'Save publishing settings' }),
    );
    await waitFor(() => expect(mutations).toHaveLength(1));
    expect(mutations[0]?.body.credential).toEqual({ action: 'remove' });
  });
});
