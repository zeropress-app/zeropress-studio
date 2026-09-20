// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import { EdgeIntegrationProvider } from './EdgeIntegrationContext';
import { changeLocale } from './i18n';
import {
  requestGeneralSettings,
} from './lib/general-settings-client';
import {
  requestWxrCoreImportChunk,
  requestWxrImportSettingsFinalize,
  WxrImportClientError,
} from './lib/wxr-import-client';
import { requestRoutingSettings } from './lib/routing-settings-client';
import { WxrImportPage } from './WxrImportPage';
import {
  parseWxrCoreImportFile,
  type WxrCoreImportPlan,
} from './wxr/wxr-core-parser';

vi.mock('./wxr/wxr-core-parser', async (importOriginal) => ({
  ...await importOriginal<typeof import('./wxr/wxr-core-parser')>(),
  parseWxrCoreImportFile: vi.fn(),
}));

vi.mock('./lib/wxr-import-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('./lib/wxr-import-client')>(),
  requestWxrCoreImportChunk: vi.fn(),
  requestWxrImportSettingsFinalize: vi.fn(),
}));

vi.mock('./lib/general-settings-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('./lib/general-settings-client')>(),
  requestGeneralSettings: vi.fn(),
}));

vi.mock('./lib/routing-settings-client', async (importOriginal) => ({
  ...await importOriginal<typeof import('./lib/routing-settings-client')>(),
  requestRoutingSettings: vi.fn(),
}));

const plan: WxrCoreImportPlan = {
  source: {
    site_title: 'Example WordPress',
    site_url: 'https://blog.example/wordpress',
    site_settings: {
      title: 'Example WordPress',
      description: '',
      url: {
        source: 'https://blog.example/wordpress',
        origin: 'https://blog.example',
      },
      locale: 'ko-KR',
      timezone: '+09:00',
    },
    permalinks: {
      output_style: 'html-extension',
      posts: '/post/:public_id/',
      pages: '/:slug/',
    },
    media_strategy: 'external',
    media_from: null,
  },
  editor_compatibility: { visual: 0, source: 0, source_fallbacks: [] },
  rows: {
    authors: [{ id: 'wordpress-author', display_name: 'WordPress Author' }],
    categories: [],
    tags: [],
    media: [],
    posts: [],
    pages: [],
    menus: [],
    comments: [],
  },
  warnings: [{
    code: 'unsupported_items_skipped',
    count: 2,
    affected: ['nav_menu_item', 'product'],
  }],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
  vi.mocked(requestGeneralSettings).mockResolvedValue({
    success: true,
    data: {
      settings: {
        title: 'Current site',
        description: 'Current description',
        url: '',
        locale: 'en-US',
        timezone: 'UTC',
      },
      revision: 'a'.repeat(32),
      updated_at_iso: null,
    },
  });
  vi.mocked(requestRoutingSettings).mockResolvedValue({
    success: true,
    data: {
      settings: {
        permalinks: {
          output_style: 'directory',
          posts: '/posts/:slug/',
          pages: '/:slug/',
          categories: '/categories/:slug/',
          tags: '/tags/:slug/',
        },
        front_page: { type: 'theme_index' },
        post_index: { enabled: true, path: '/', paginate: true },
      },
      revision: '0'.repeat(32),
      updated_at_iso: null,
    },
  });
  vi.mocked(requestWxrImportSettingsFinalize).mockImplementation(
    async ({ request }) => ({
      success: true,
      data: {
        general_settings: {
          result: 'updated',
          document: {
            settings: request.general_settings.settings,
            revision: 'b'.repeat(32),
            updated_at_iso: '2026-08-13T00:00:00Z',
          },
        },
        routing_settings: {
          result: 'updated',
          document: {
            settings: request.routing_settings.settings,
            revision: 'd'.repeat(32),
            updated_at_iso: '2026-08-13T00:00:00Z',
          },
        },
      },
    }),
  );
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function startImport(importPlan = plan) {
  vi.mocked(parseWxrCoreImportFile).mockResolvedValue(importPlan);
  const user = userEvent.setup();
  const onSessionEnded = vi.fn();
  const view = render(
    <MemoryRouter initialEntries={['/import/wordpress']}>
      <WxrImportPage data={{ csrf_token: 'c'.repeat(43) }} onSessionEnded={onSessionEnded} />
    </MemoryRouter>,
  );
  await user.upload(
    screen.getByLabelText('Choose WordPress WXR XML file'),
    new File(['<rss />'], 'export.xml', { type: 'application/xml' }),
  );
  const heading = await screen.findByRole('heading', { name: 'Ready to import' });
  const confirmation = within(heading.closest('section')!);
  await user.click(confirmation.getByRole('checkbox'));
  await user.click(confirmation.getByRole('button', { name: 'Import WordPress data' }));
  return { user, onSessionEnded, ...view };
}

function chunkSuccess(processed: number, created = processed) {
  return {
    success: true as const,
    data: {
      phase: 'authors' as const, processed, created, updated: 0,
      unchanged: processed - created, failed: 0, failures: [],
    },
  };
}

function authorPlan(count: number): WxrCoreImportPlan {
  return { ...plan, rows: { ...plan.rows, authors: Array.from({ length: count }, (_, index) => ({
    id: `author-${index}`, display_name: `Author ${index}`,
  })) } };
}

describe('WXR import page', () => {
  it.each([1, 101])('stops after the current chunk of %i rows and can rerun the file', async (count) => {
    const chunk = deferred<Awaited<ReturnType<typeof requestWxrCoreImportChunk>>>();
    vi.mocked(requestWxrCoreImportChunk)
      .mockImplementation(async ({ request }) => chunkSuccess(request.rows.length, 0))
      .mockReturnValueOnce(chunk.promise);
    const { user } = await startImport(authorPlan(count));
    const signal = vi.mocked(requestWxrCoreImportChunk).mock.calls[0]![0].signal!;
    await user.click(screen.getByRole('button', { name: 'Stop import' }));
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
    expect(screen.getByText('Finishing the current batch before stopping.')).toBeVisible();
    expect(signal.aborted).toBe(false);
    const leaving = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);

    const processed = Math.min(count, 100);
    await act(async () => chunk.resolve({
      success: true,
      data: {
        phase: 'authors', processed, created: processed - 1, updated: 0,
        unchanged: 0, failed: 1,
        failures: [{ row_index: 0, key: 'author-0', code: 'REVISION_CONFLICT' }],
      },
    }));
    expect(await screen.findByRole('heading', { name: 'WordPress import stopped' })).toBeVisible();
    expect(requestWxrCoreImportChunk).toHaveBeenCalledTimes(1);
    expect(requestWxrImportSettingsFinalize).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(false);
    const table = screen.getByRole('table', { name: 'Import results by phase' });
    const authorRow = within(table).getByRole('row', { name: /^Authors /u });
    expect(within(authorRow).getAllByRole('cell').map((cell) => cell.textContent))
      .toEqual([String(processed - 1), '0', '0', '0', '1']);
    await user.click(screen.getByText('1 row failures'));
    expect(screen.getByText('The record changed while the import was updating it.')).toBeVisible();
    const stoppedLeaving = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(stoppedLeaving);
    expect(stoppedLeaving.defaultPrevented).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Review and run again' }));
    await waitFor(() => expect(requestGeneralSettings).toHaveBeenCalledTimes(2));
    const confirmation = within((await screen.findByRole('heading', { name: 'Ready to import' })).closest('section')!);
    await user.click(confirmation.getByRole('checkbox'));
    await user.click(confirmation.getByRole('button', { name: 'Import WordPress data' }));
    expect(await screen.findByRole('heading', { name: 'WordPress import finished' })).toBeVisible();
    expect(requestWxrCoreImportChunk).toHaveBeenCalledTimes(1 + Math.ceil(count / 100));
    expect(requestWxrImportSettingsFinalize).toHaveBeenCalledOnce();
    const completedRow = screen.getByRole('row', { name: /^Authors /u });
    expect(within(completedRow).getAllByRole('cell').map((cell) => cell.textContent))
      .toEqual(['0', '0', String(count), '0', '0']);
  });

  it.each(['api', 'timeout', 'session'] as const)(
    'reports a %s failure while stopping and keeps earlier chunk results', async (failure) => {
      const chunk = deferred<Awaited<ReturnType<typeof requestWxrCoreImportChunk>>>();
      vi.mocked(requestWxrCoreImportChunk)
        .mockResolvedValueOnce(chunkSuccess(100))
        .mockReturnValueOnce(chunk.promise);
      const { user, onSessionEnded } = await startImport(authorPlan(101));
      await waitFor(() => expect(requestWxrCoreImportChunk).toHaveBeenCalledTimes(2));
      await user.click(screen.getByRole('button', { name: 'Stop import' }));
      await act(async () => {
        if (failure === 'session') chunk.resolve({ success: false, error: { code: 'AUTHENTICATION_REQUIRED' } });
        else if (failure === 'api') chunk.resolve({ success: false, error: { code: 'SYSTEM_NOT_AVAILABLE' } });
        else chunk.reject(new WxrImportClientError('TIMEOUT'));
      });
      expect(await screen.findByText('The import was interrupted')).toBeVisible();
      if (failure === 'session') expect(onSessionEnded).toHaveBeenCalledOnce();
      expect(screen.queryByRole('heading', { name: 'WordPress import stopped' })).not.toBeInTheDocument();
      expect(requestWxrImportSettingsFinalize).not.toHaveBeenCalled();
      const authorRow = screen.getByRole('row', { name: /^Authors /u });
      expect(within(authorRow).getAllByRole('cell').map((cell) => cell.textContent))
        .toEqual(['100', '0', '0', '0', '0']);
      expect(screen.getByRole('button', { name: 'Return to preflight' })).toBeEnabled();
    },
  );

  it('finishes settings already being saved instead of offering a misleading stop action', async () => {
    vi.mocked(requestWxrCoreImportChunk).mockResolvedValue(chunkSuccess(1));
    const finalize = deferred<Awaited<ReturnType<typeof requestWxrImportSettingsFinalize>>>();
    const save = vi.mocked(requestWxrImportSettingsFinalize).getMockImplementation()!;
    vi.mocked(requestWxrImportSettingsFinalize).mockReturnValueOnce(finalize.promise);
    await startImport();
    await waitFor(() => expect(requestWxrImportSettingsFinalize).toHaveBeenCalledOnce());
    expect(screen.queryByRole('button', { name: 'Stop import' })).not.toBeInTheDocument();
    const args = vi.mocked(requestWxrImportSettingsFinalize).mock.calls[0]![0];
    await act(async () => finalize.resolve(await save(args)));
    expect(await screen.findByRole('heading', { name: 'WordPress import finished' })).toBeVisible();
    expect(screen.getByRole('row', { name: /^Site settings /u })).toHaveTextContent('1');
  });

  it('preflights locally and applies selected site settings after content chunks', async () => {
    vi.mocked(parseWxrCoreImportFile).mockResolvedValue(plan);
    vi.mocked(requestWxrCoreImportChunk).mockResolvedValue({
      success: true,
      data: {
        phase: 'authors',
        processed: 1,
        created: 1,
        updated: 0,
        unchanged: 0,
        failed: 0,
        failures: [],
      },
    });
    const user = userEvent.setup();
    const onSiteIdentityChanged = vi.fn();
    render(
      <MemoryRouter initialEntries={['/import/wordpress']}>
        <WxrImportPage
          data={{ csrf_token: 'c'.repeat(43) }}
          onSiteIdentityChanged={onSiteIdentityChanged}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('navigation', { name: 'Site settings' }))
      .not.toBeInTheDocument();
    expect(document.querySelector('.wxr-flow')).toBeInTheDocument();

    await user.upload(
      screen.getByLabelText('Choose WordPress WXR XML file'),
      new File(['<rss />'], 'export.xml', { type: 'application/xml' }),
    );
    expect(await screen.findByRole('heading', { name: 'Preflight summary' }))
      .toBeInTheDocument();
    expect(parseWxrCoreImportFile).toHaveBeenCalledWith(expect.any(File), {
      mediaStrategy: 'external',
      mediaFrom: '',
    });
    expect(screen.getAllByText('Example WordPress')).not.toHaveLength(0);
    const sourceUrlChoice = await screen.findByRole('radio', {
      name: /Use the WordPress site URL/u,
    });
    expect(sourceUrlChoice).toBeChecked();
    expect(sourceUrlChoice).toHaveAccessibleName(
      'Use the WordPress site URL',
    );
    expect(sourceUrlChoice).toHaveAccessibleDescription('https://blog.example');
    expect(screen.getByText('Current description')).toBeInTheDocument();
    expect(screen.getByText('Unsupported WXR items were skipped')).toBeInTheDocument();

    const confirmation = screen.getByRole('heading', { name: 'Ready to import' })
      .closest('section');
    if (!confirmation) throw new TypeError('Confirmation section is missing.');
    const importButton = within(confirmation).getByRole('button', {
      name: 'Import WordPress data',
    });
    expect(importButton).toBeDisabled();
    await user.click(within(confirmation).getByRole('checkbox'));
    await user.click(importButton);

    expect(await screen.findByRole('heading', {
      name: 'WordPress import finished',
    })).toBeInTheDocument();
    expect(requestWxrCoreImportChunk).toHaveBeenCalledWith({
      csrfToken: 'c'.repeat(43),
      request: { phase: 'authors', rows: plan.rows.authors },
      signal: expect.any(AbortSignal),
    });
    expect(await screen.findByRole('radio', {
      name: /Apply the inferred WordPress structure/u,
    })).toBeChecked();
    expect(requestWxrImportSettingsFinalize).toHaveBeenCalledWith({
      csrfToken: 'c'.repeat(43),
      request: {
        general_settings: {
          settings: {
          title: 'Example WordPress',
          description: '',
          url: 'https://blog.example',
          locale: 'ko-KR',
          timezone: '+09:00',
          },
          expected_revision: 'a'.repeat(32),
        },
        routing_settings: {
          settings: {
            permalinks: {
              output_style: 'html-extension',
              posts: '/post/:public_id/',
              pages: '/:slug/',
              categories: '/categories/:slug/',
              tags: '/tags/:slug/',
            },
            front_page: { type: 'theme_index' },
            post_index: { enabled: true, path: '/', paginate: true },
          },
          expected_revision: '0'.repeat(32),
        },
      },
      signal: expect.any(AbortSignal),
    });
    expect(
      vi.mocked(requestWxrCoreImportChunk).mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(requestWxrImportSettingsFinalize).mock.invocationCallOrder[0]!,
    );
    expect(screen.getByRole('table', {
      name: 'Import results by phase',
    })).toHaveTextContent('Site settings');
    expect(onSiteIdentityChanged).toHaveBeenCalledWith({
      title: 'Example WordPress',
      url: 'https://blog.example',
    });
  });

  it('keeps an existing canonical URL by default and accepts an explicit custom origin', async () => {
    vi.mocked(requestGeneralSettings).mockResolvedValue({
      success: true,
      data: {
        settings: {
          title: 'Current site',
          description: 'Current description',
          url: 'https://current.example',
          locale: 'en-US',
          timezone: 'UTC',
        },
        revision: 'c'.repeat(32),
        updated_at_iso: null,
      },
    });
    vi.mocked(parseWxrCoreImportFile).mockResolvedValue(plan);
    vi.mocked(requestWxrCoreImportChunk).mockResolvedValue({
      success: true,
      data: {
        phase: 'authors',
        processed: 1,
        created: 0,
        updated: 0,
        unchanged: 1,
        failed: 0,
        failures: [],
      },
    });
    vi.mocked(requestRoutingSettings).mockResolvedValue({
      success: true,
      data: {
        settings: {
          permalinks: {
            output_style: 'directory',
            posts: '/articles/:slug/',
            pages: '/:slug/',
            categories: '/topics/:slug/',
            tags: '/keywords/:slug/',
          },
          front_page: { type: 'theme_index' },
          post_index: { enabled: true, path: '/', paginate: true },
        },
        revision: 'f'.repeat(32),
        updated_at_iso: null,
      },
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/import/wordpress']}>
        <WxrImportPage
          data={{ csrf_token: 'c'.repeat(43) }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    await user.upload(
      screen.getByLabelText('Choose WordPress WXR XML file'),
      new File(['<rss />'], 'export.xml', { type: 'application/xml' }),
    );
    expect(await screen.findByRole('radio', { name: /Keep the current URL/u }))
      .toBeChecked();
    expect(screen.getByRole('radio', {
      name: /Keep the current permalink structure/u,
    })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: /Enter another URL/u }));
    const customUrl = screen.getByLabelText('Public HTTP(S) URL');
    await user.clear(customUrl);
    await user.type(customUrl, 'https://new.example');

    const confirmation = screen.getByRole('heading', { name: 'Ready to import' })
      .closest('section');
    if (!confirmation) throw new TypeError('Confirmation section is missing.');
    await user.click(within(confirmation).getByRole('checkbox'));
    await user.click(within(confirmation).getByRole('button', {
      name: 'Import WordPress data',
    }));

    expect(await screen.findByRole('heading', {
      name: 'WordPress import finished',
    })).toBeInTheDocument();
    expect(requestWxrImportSettingsFinalize).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          general_settings: expect.objectContaining({
            settings: expect.objectContaining({ url: 'https://new.example' }),
            expected_revision: 'c'.repeat(32),
          }),
          routing_settings: expect.objectContaining({
            settings: expect.objectContaining({
              permalinks: expect.objectContaining({
                posts: '/articles/:slug/',
                categories: '/topics/:slug/',
              }),
            }),
            expected_revision: 'f'.repeat(32),
          }),
        }),
      }),
    );
  });

  it('reports both documents unchanged when finalization is a no-op', async () => {
    vi.mocked(requestGeneralSettings).mockResolvedValue({
      success: true,
      data: {
        settings: {
          title: 'Example WordPress',
          description: '',
          url: 'https://blog.example',
          locale: 'ko-KR',
          timezone: '+09:00',
        },
        revision: 'e'.repeat(32),
        updated_at_iso: null,
      },
    });
    vi.mocked(parseWxrCoreImportFile).mockResolvedValue(plan);
    vi.mocked(requestWxrCoreImportChunk).mockResolvedValue({
      success: true,
      data: {
        phase: 'authors',
        processed: 1,
        created: 0,
        updated: 0,
        unchanged: 1,
        failed: 0,
        failures: [],
      },
    });
    vi.mocked(requestRoutingSettings).mockResolvedValue({
      success: true,
      data: {
        settings: {
          permalinks: {
            output_style: 'html-extension',
            posts: '/post/:public_id/',
            pages: '/:slug/',
            categories: '/categories/:slug/',
            tags: '/tags/:slug/',
          },
          front_page: { type: 'theme_index' },
          post_index: { enabled: true, path: '/', paginate: true },
        },
        revision: 'f'.repeat(32),
        updated_at_iso: null,
      },
    });
    vi.mocked(requestWxrImportSettingsFinalize).mockImplementation(
      async ({ request }) => ({
        success: true,
        data: {
          general_settings: {
            result: 'unchanged',
            document: {
              settings: request.general_settings.settings,
              revision: 'e'.repeat(32),
              updated_at_iso: null,
            },
          },
          routing_settings: {
            result: 'unchanged',
            document: {
              settings: request.routing_settings.settings,
              revision: 'f'.repeat(32),
              updated_at_iso: null,
            },
          },
        },
      }),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/import/wordpress']}>
        <WxrImportPage
          data={{ csrf_token: 'c'.repeat(43) }}
          onSessionEnded={vi.fn()}
        />
      </MemoryRouter>,
    );

    await user.upload(
      screen.getByLabelText('Choose WordPress WXR XML file'),
      new File(['<rss />'], 'export.xml', { type: 'application/xml' }),
    );
    await screen.findByRole('radio', { name: /Keep the current URL/u });
    const confirmation = screen.getByRole('heading', { name: 'Ready to import' })
      .closest('section');
    if (!confirmation) throw new TypeError('Confirmation section is missing.');
    await user.click(within(confirmation).getByRole('checkbox'));
    await user.click(within(confirmation).getByRole('button', {
      name: 'Import WordPress data',
    }));

    const table = await screen.findByRole('table', { name: 'Import results by phase' });
    expect(requestWxrImportSettingsFinalize).toHaveBeenCalledOnce();
    expect(within(table).getByRole('row', { name: /Site settings/u }))
      .toHaveTextContent('1');
    expect(within(table).getByRole('row', { name: /Permalinks/u }))
      .toHaveTextContent('1');
  });

  it('skips parsed Comment chunks and reports their count while Edge is disabled', async () => {
    const disabledPlan: WxrCoreImportPlan = {
      ...plan,
      rows: {
        ...plan.rows,
        comments: [{
          public_id: 7,
          target_type: 'post',
          target_public_id: 13261,
          parent_public_id: null,
          author_name: 'Reader',
          author_email: '',
          content_text: 'Historical comment',
          status: 'approved',
          created_at_iso: '2026-07-01T00:00:00Z',
        }],
      },
    };
    vi.mocked(parseWxrCoreImportFile).mockResolvedValue(disabledPlan);
    vi.mocked(requestWxrCoreImportChunk).mockResolvedValue({
      success: true,
      data: {
        phase: 'authors',
        processed: 1,
        created: 1,
        updated: 0,
        unchanged: 0,
        failed: 0,
        failures: [],
      },
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/import/wordpress']}>
        <EdgeIntegrationProvider value={{
          mode: 'disabled', databaseState: 'ready', setMode: vi.fn(),
          setDatabaseState: vi.fn(),
        }}>
          <WxrImportPage
            data={{ csrf_token: 'c'.repeat(43) }}
            onSessionEnded={vi.fn()}
          />
        </EdgeIntegrationProvider>
      </MemoryRouter>,
    );

    await user.upload(
      screen.getByLabelText('Choose WordPress WXR XML file'),
      new File(['<rss />'], 'export.xml', { type: 'application/xml' }),
    );
    expect(await screen.findByText('Reader comments will be skipped'))
      .toBeInTheDocument();
    await screen.findByRole('radio', { name: /Use the WordPress site URL/u });
    expect(screen.getByText(/1 parsed comments will not be sent/u))
      .toBeInTheDocument();
    const confirmation = screen.getByRole('heading', { name: 'Ready to import' })
      .closest('section');
    if (!confirmation) throw new TypeError('Confirmation section is missing.');
    await user.click(within(confirmation).getByRole('checkbox'));
    await user.click(within(confirmation).getByRole('button', {
      name: 'Import WordPress data',
    }));

    const table = await screen.findByRole('table', {
      name: 'Import results by phase',
    });
    const commentRow = within(table).getByRole('row', { name: /Comments/u });
    expect(commentRow).toHaveTextContent('1');
    expect(requestWxrCoreImportChunk).toHaveBeenCalledTimes(1);
    expect(requestWxrCoreImportChunk).not.toHaveBeenCalledWith(
      expect.objectContaining({ request: expect.objectContaining({ phase: 'comments' }) }),
    );
  });
});
