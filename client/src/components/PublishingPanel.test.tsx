// @vitest-environment jsdom
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublishingPanel } from './PublishingPanel';
import { changeLocale } from '../i18n';
const revision = '0'.repeat(32);
const file = {
  target: {
    owner: 'example',
    repo: 'site',
    branch: 'main',
    path: 'preview.json',
  },
  blob_sha: 'b'.repeat(40),
  metadata_status: 'valid',
  commit: {
    sha: 'c'.repeat(40),
    url: 'https://github.com/example/site/commit/' + 'c'.repeat(40),
    committed_at_iso: '2026-09-21T12:00:00Z',
  },
};
beforeEach(async () => {
  await changeLocale('en');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(
  options: {
    configured?: boolean;
    enabled?: boolean;
    outcome?: string;
    fail?: string;
    lost?: boolean;
    hold?: Promise<void>;
  } = {},
) {
  let reads = 0;
  const writes: unknown[] = [];
  let failRead = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/publishing/status') {
        reads++;
        if (failRead) throw new Error('offline');
        return Response.json({
          success: true,
          data: {
            enabled: options.enabled ?? options.configured ?? true,
            configured: options.configured ?? true,
            revision,
            file:
              options.configured === false || options.enabled === false
                ? null
                : file,
          },
        });
      }
      if (path === '/api/publishing' && init?.method === 'POST') {
        writes.push(JSON.parse(String(init.body)));
        expect(new Headers(init.headers).get('X-ZeroPress-CSRF')).toBe('csrf');
        await options.hold;
        if (options.lost) throw new Error('lost');
        if (options.fail)
          return Response.json({
            success: false,
            error: { code: options.fail },
          });
        return Response.json({
          success: true,
          data: { outcome: options.outcome ?? 'committed', file },
        });
      }
      throw new Error('Unexpected request');
    }),
  );
  render(
    <MemoryRouter>
      <PublishingPanel csrfToken="csrf" onSessionEnded={vi.fn()} />
    </MemoryRouter>,
  );
  return {
    user: userEvent.setup(),
    writes,
    reads: () => reads,
    failRead: () => {
      failRead = true;
    },
  };
}
async function confirmPublish(user: ReturnType<typeof userEvent.setup>) {
  await user.click(
    await screen.findByRole('button', { name: 'Publish to GitHub' }),
  );
  const dialog = await screen.findByRole('dialog', {
    name: 'Publish to GitHub?',
  });
  await user.click(
    within(dialog).getByRole('button', { name: 'Publish to GitHub' }),
  );
}

describe('publishing panel', () => {
  it('guides an incomplete connection to publishing settings', async () => {
    const { writes } = setup({ configured: false });
    expect(
      await screen.findByText(
        'Choose a GitHub file and add a token in publishing settings.',
      ),
    ).toBeVisible();
    expect(
      screen.getByRole('link', { name: 'Publishing settings' }),
    ).toHaveAttribute('href', '/settings/site/publishing');
    expect(writes).toHaveLength(0);
  });
  it.each([
    {
      locale: 'en' as const,
      title: 'GitHub publishing is turned off',
      hint: 'To use your saved connection, turn on “Publish to GitHub” in publishing settings and save.',
      settings: 'Publishing settings',
    },
    {
      locale: 'ko' as const,
      title: 'GitHub 발행이 꺼져 있습니다',
      hint: '저장된 연결을 사용하려면 발행 설정에서 ‘GitHub 발행 사용’을 켜고 저장해 주세요.',
      settings: '발행 설정',
    },
  ])('explains how to enable a saved connection in $locale', async (copy) => {
    await changeLocale(copy.locale);
    const { writes } = setup({ configured: true, enabled: false });
    expect(await screen.findByText(copy.title)).toBeVisible();
    expect(screen.getByText(copy.hint)).toBeVisible();
    expect(screen.getByRole('link', { name: copy.settings })).toHaveAttribute(
      'href',
      '/settings/site/publishing',
    );
    expect(writes).toHaveLength(0);
  });
  it.each([
    {
      locale: 'en' as const,
      publish: 'Publish to GitHub',
      title: 'Publish to GitHub?',
      cancel: 'Cancel',
    },
    {
      locale: 'ko' as const,
      publish: 'GitHub에 발행',
      title: 'GitHub에 발행할까요?',
      cancel: '취소',
    },
  ])(
    'requires confirmation and lets users cancel before sending a write in $locale',
    async (copy) => {
      await changeLocale(copy.locale);
      const api = setup();
      const trigger = await screen.findByRole('button', { name: copy.publish });
      await api.user.click(trigger);
      const dialog = await screen.findByRole('dialog', { name: copy.title });
      for (const target of ['example/site', 'main', 'preview.json']) {
        expect(within(dialog).getByText(target)).toBeVisible();
      }
      const cancel = within(dialog).getByRole('button', { name: copy.cancel });
      expect(cancel).toHaveFocus();
      expect(api.writes).toHaveLength(0);
      await api.user.click(cancel);
      expect(trigger).toHaveFocus();
      await api.user.click(trigger);
      await api.user.keyboard('{Escape}');
      expect(trigger).toHaveFocus();
      expect(api.writes).toHaveLength(0);
    },
  );
  it('prevents duplicate confirmations and keeps confirmed success after a failed status refresh', async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = setup({ hold });
    await api.user.click(
      await screen.findByRole('button', { name: 'Publish to GitHub' }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: 'Publish to GitHub?',
    });
    await api.user.dblClick(
      within(dialog).getByRole('button', { name: 'Publish to GitHub' }),
    );
    expect(
      within(dialog).getByRole('button', { name: 'Publishing…' }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole('button', { name: 'Cancel' }),
    ).toBeDisabled();
    await api.user.keyboard('{Escape}');
    expect(dialog).toBeVisible();
    expect(api.writes).toEqual([{ expected_revision: revision }]);
    release();
    expect(await screen.findByText('Updated on GitHub.')).toBeVisible();
    api.failRead();
    await api.user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(api.reads()).toBe(2));
    expect(screen.getByText('Updated on GitHub.')).toBeVisible();
  });
  it.each([
    ['unchanged', 'No changes to publish.'],
    ['confirmed', 'The update was confirmed on GitHub.'],
  ])('presents %s separately', async (outcome, text) => {
    const api = setup({ outcome });
    await confirmPublish(api.user);
    expect(await screen.findByText(text)).toBeVisible();
    expect(api.writes).toHaveLength(1);
  });
  it.each([{ fail: 'PUBLISHING_RESULT_UNKNOWN' }, { lost: true }])(
    'treats an uncertain response as unknown and never retries the write',
    async (options) => {
      const api = setup(options);
      await confirmPublish(api.user);
      expect(
        await screen.findByText('Check whether the publish completed'),
      ).toBeVisible();
      expect(
        screen.getByRole('link', { name: /example\/site/ }),
      ).toHaveAttribute(
        'href',
        'https://github.com/example/site/blob/main/preview.json',
      );
      expect(api.writes).toHaveLength(1);
    },
  );
  it('asks users to reload before publishing after a settings change', async () => {
    const api = setup({ fail: 'SETTINGS_REVISION_CONFLICT' });
    await confirmPublish(api.user);
    expect(
      await screen.findByText(/connection settings changed/),
    ).toBeVisible();
    expect(api.writes).toHaveLength(1);
  });
});
