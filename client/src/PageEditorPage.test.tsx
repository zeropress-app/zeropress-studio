// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { PageEditorPage } from './PageEditorPage';
import { changeLocale } from './i18n';

vi.mock('./components/MonacoRevisionDiff', () => ({
  MonacoRevisionDiff: (input: {
    original: string;
    modified: string;
    originalLabel: string;
    modifiedLabel: string;
  }) => (
    <div data-testid="autosave-diff">
      <textarea readOnly aria-label={input.originalLabel} value={input.original} />
      <textarea readOnly aria-label={input.modifiedLabel} value={input.modified} />
    </div>
  ),
}));

vi.mock('./components/MonacoSourceEditor', async () => {
  const module = await import('./test/MockMonacoSourceEditor');
  return { MonacoSourceEditor: module.MockMonacoSourceEditor };
});

const parent = {
  id: '1'.repeat(32),
  title: 'Docs',
  slug: 'docs',
  path: 'docs',
} as const;

const page = {
  id: '2'.repeat(32),
  public_id: 100_000_000_001,
  parent: {
    id: parent.id,
    title: parent.title,
    slug: parent.slug,
  },
  title: 'Guide',
  slug: 'guide',
  path: 'docs/guide',
  content: '# Guide',
  document_type: 'markdown',
  editor_mode: 'source',
  editor_profile: null,
  excerpt: 'Start here.',
  status: 'draft',
  discoverability: 'default',
  allow_comments: false,
  featured_image: null,
  revision: '3'.repeat(32),
  created_at_iso: '2026-08-01T08:00:00.000Z',
  updated_at_iso: '2026-08-01T08:00:00.000Z',
} as const;

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function options() {
  return response({ success: true, data: { items: [parent] } });
}

function mediaCollections() {
  return response({
    success: true,
    data: { items: [], total_media_count: 0, unfiled_media_count: 0 },
  });
}

function mediaList(items: unknown[], mediaOrigin = '') {
  return response({
    success: true,
    data: {
      items,
      pagination: {
        page: 1,
        per_page: 50,
        total: items.length,
        total_pages: items.length === 0 ? 0 : 1,
      },
      delivery: {
        media_origin: mediaOrigin,
        r2_preview_available: true,
      },
    },
  });
}

function noAutosave() {
  return response({ success: true, data: { autosave: null } });
}

function recoverablePageAutosave() {
  return response({
    success: true,
    data: {
      autosave: {
        draft_id: '8'.repeat(32),
        target_id: null,
        base_revision: null,
        snapshot: {
          version: 1,
          content_type: 'page',
          draft: {
            parent_id: parent.id,
            title: 'Recovered Page',
            slug: 'recovered-page',
            content: 'Recovered source',
            document_type: 'markdown',
            excerpt: '',
            status: 'draft',
            discoverability: 'default',
            allow_comments: false,
            featured_image_id: null,
          },
          references: { parent, featured_image: null },
        },
        snapshot_sha256: '9'.repeat(64),
        created_at_iso: '2026-08-01T08:00:00.000Z',
        updated_at_iso: '2026-08-01T08:01:00.000Z',
        expires_at_iso: '2026-08-08T08:01:00.000Z',
      },
    },
  });
}

function renderEditor(mode: 'create' | 'edit') {
  return render(
    <MemoryRouter initialEntries={[
      mode === 'create' ? '/pages/new' : `/pages/${page.id}`,
    ]}>
      <Routes>
        <Route
          path={mode === 'create' ? '*' : '/pages/:pageId'}
          element={(
            <PageEditorPage
              mode={mode}
              data={{ csrf_token: 'c'.repeat(43) }}
              onSessionEnded={vi.fn()}
            />
          )}
        />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});

describe('PageEditorPage', () => {
  it('reviews an AI excerpt from the current unsaved Page draft', async () => {
    const fetchMock = vi.fn().mockImplementation(async (
      request: string,
      init?: RequestInit,
    ) => {
      const url = new URL(request, 'https://studio.local');
      if (url.pathname === '/api/pages/autosave/recent') return noAutosave();
      if (url.pathname === '/api/pages/parent-options') return options();
      if (url.pathname === '/api/pages/ai/excerpt') {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          title: 'Unsaved Page',
          document_type: 'html',
        });
        expect(JSON.parse(String(init?.body)).content).toContain(
          'Current Page body',
        );
        return response({
          success: true,
          data: {
            excerpt: 'Generated from the unsaved Page.',
            source_truncated: false,
          },
        });
      }
      throw new Error(`Unexpected request: ${request}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderEditor('create');

    await user.type(
      await screen.findByRole('textbox', { name: 'Title' }),
      'Unsaved Page',
    );
    await user.type(
      await screen.findByRole('textbox', { name: 'Content' }),
      'Current Page body',
    );
    await user.click(screen.getByRole('button', { name: 'Generate with AI' }));
    expect(await screen.findByRole('dialog', {
      name: 'Use this generated excerpt?',
    })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply to draft' }));
    expect(screen.getByRole('textbox', { name: 'Excerpt' }))
      .toHaveValue('Generated from the unsaved Page.');
    expect(fetchMock.mock.calls.some(([path]) => (
      path === '/api/pages'
    ))).toBe(false);
  });

  it('reviews a purpose-specific AI Page candidate before applying selected fields', async () => {
    const fetchMock = vi.fn().mockImplementation(async (
      request: string,
      init?: RequestInit,
    ) => {
      const url = new URL(request, 'https://studio.local');
      if (url.pathname === '/api/pages/autosave/recent') return noAutosave();
      if (url.pathname === '/api/pages/parent-options') return options();
      if (url.pathname === '/api/pages/ai/draft') {
        expect(JSON.parse(String(init?.body))).toEqual({
          title: '',
          brief: 'Present the supplied value and intended audience.',
          preset: 'landing',
          tone: 'professional',
          length: 'short',
          document_type: 'html',
          editor_mode: 'visual',
        });
        return response({
          success: true,
          data: {
            title: 'Project overview',
            excerpt: 'A concise overview for the intended audience.',
            content: '<h2>Why it matters</h2>\n<p>Supplied value.</p>',
            document_type: 'html',
            editor_mode: 'visual',
            editor_profile: 'tiptap-v1',
          },
        });
      }
      throw new Error(`Unexpected request: ${request}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderEditor('create');

    await screen.findByRole('textbox', { name: 'Title' });
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Parent Page' }),
      parent.id,
    );
    await user.click(screen.getByRole('button', { name: 'Draft with AI' }));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Page purpose' }),
      'landing',
    );
    await user.type(
      screen.getByRole('textbox', { name: 'Purpose and Page notes' }),
      'Present the supplied value and intended audience.',
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Tone' }),
      'professional',
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Length' }),
      'short',
    );
    await user.click(screen.getByRole('button', { name: 'Generate draft' }));

    expect(await screen.findByRole('dialog', {
      name: 'Review the generated Page draft',
    })).toBeInTheDocument();
    expect(screen.getByText(/Hierarchy, publication, comments/))
      .toBeInTheDocument();
    await user.click(screen.getByRole('button', {
      name: 'Apply selected fields',
    }));

    expect(screen.getByRole('textbox', { name: 'Title' }))
      .toHaveValue('Project overview');
    expect(screen.getByRole('textbox', { name: /^Slug/ }))
      .toHaveValue('project-overview');
    expect(screen.getByRole('textbox', { name: 'Excerpt' }))
      .toHaveValue('A concise overview for the intended audience.');
    expect(screen.getByRole('combobox', { name: 'Parent Page' }))
      .toHaveValue(parent.id);
    expect(screen.getByRole('checkbox', { name: /Allow comments/ }))
      .not.toBeChecked();
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/pages'))
      .toBe(false);
  });

  it('inserts a host-independent R2 image into HTML and warns about export', async () => {
    const managedImage = {
      id: '6'.repeat(32),
      kind: 'image',
      filename: 'managed.png',
      mime_type: 'image/png',
      location: {
        type: 'r2',
        key: 'uploads/2026/08/managed.png',
      },
      size_bytes: 2048,
      width: 800,
      height: 450,
      duration_ms: null,
      alt: 'Managed image',
      collection: null,
      usage: { posts: 0, pages: 0, authors: 0, branding: 0 },
      revision: '7'.repeat(32),
      created_at_iso: '2026-08-04T01:00:00.000Z',
      updated_at_iso: '2026-08-04T01:00:00.000Z',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(noAutosave())
      .mockResolvedValueOnce(options())
      .mockResolvedValueOnce(mediaCollections())
      .mockResolvedValueOnce(mediaList([managedImage]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderEditor('create');

    const content = await screen.findByRole('textbox', { name: 'Content' });
    expect(screen.getByRole('combobox', { name: 'Document type' }))
      .toHaveValue('html');
    await user.click(content);
    await user.click(screen.getByRole('button', { name: 'Insert Media' }));
    expect(await screen.findByRole('button', { name: 'Insert managed.png' }))
      .toBeInTheDocument();
    expect(screen.queryByText(/requires a public Media origin/iu))
      .not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Insert managed.png' }));

    const image = content.querySelector('img');
    expect(image).toHaveAttribute(
      'src',
      '/__zeropress_media__/uploads/2026/08/managed.png',
    );
    expect(image).toHaveAttribute('alt', 'Managed image');
    expect(image).toHaveAttribute('width', '800');
    expect(image).toHaveAttribute('height', '450');
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).toHaveAttribute('decoding', 'async');
  });

  it('can discard an interrupted new Page snapshot without changing the editor', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(recoverablePageAutosave())
      .mockResolvedValueOnce(options())
      .mockResolvedValueOnce(response({
        success: true,
        data: { status: 'autosave_deleted', deleted: true },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderEditor('create');

    expect(await screen.findByRole('dialog', {
      name: 'Recover an autosaved Page?',
    })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Discard autosave' }));
    expect(await screen.findByRole('textbox', { name: 'Title' })).toHaveValue('');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/pages/autosave');
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('creates a nested Page with comments disabled by default', async () => {
    const created = {
      ...page,
      title: 'Install',
      slug: 'install',
      path: 'docs/install',
      content: '<p>Install</p>',
      document_type: 'html' as const,
      editor_mode: 'visual' as const,
      editor_profile: 'tiptap-v1' as const,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(noAutosave())
      .mockResolvedValueOnce(options())
      .mockResolvedValueOnce(response({ success: true, data: created }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderEditor('create');

    const title = await screen.findByRole('textbox', { name: 'Title' });
    await user.type(title, 'Install');
    expect(screen.getByRole('textbox', { name: /^Slug/ })).toHaveValue('install');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Parent Page' }),
      parent.id,
    );
    expect(screen.getByText('Effective path: /docs/install')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Allow comments/ })).not.toBeChecked();
    expect(screen.getByRole('combobox', { name: 'Document type' }))
      .toHaveValue('html');
    await user.type(
      screen.getByRole('textbox', { name: 'Content' }),
      'Install',
    );
    await user.click(screen.getByRole('button', { name: 'Save Page' }));

    expect(await screen.findByText('Page saved.')).toBeInTheDocument();
    expect(fetchMock.mock.calls[2]?.[0]).toBe('/api/pages');
    expect(JSON.parse(String(
      (fetchMock.mock.calls[2]?.[1] as RequestInit).body,
    ))).toMatchObject({
      parent_id: parent.id,
      title: 'Install',
      slug: 'install',
      content: '<p>Install</p>',
      document_type: 'html',
      editor_mode: 'visual',
      editor_profile: 'tiptap-v1',
      allow_comments: false,
    });
  });

  it('lets an unchanged visual Page return from source mode without saving', async () => {
    const visualPage = {
      ...page,
      content: '<p>Guide</p>',
      document_type: 'html' as const,
      editor_mode: 'visual' as const,
      editor_profile: 'tiptap-v1' as const,
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: visualPage }))
      .mockResolvedValueOnce(noAutosave())
      .mockResolvedValueOnce(options()));
    const user = userEvent.setup();
    renderEditor('edit');
    await screen.findByRole('textbox', { name: 'Content' });

    await user.click(screen.getByRole('button', { name: 'HTML source' }));
    await user.click(screen.getByRole('button', { name: 'Use HTML source' }));
    expect(screen.getByRole('button', { name: 'Save Page' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Visual' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Page' })).toBeDisabled();
  });

  it('loads an existing Page and sends its revision with hierarchy changes', async () => {
    const rootPage = {
      ...page,
      parent: null,
      path: 'guide',
      revision: '4'.repeat(32),
    } as const;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: page }))
      .mockResolvedValueOnce(noAutosave())
      .mockResolvedValueOnce(options())
      .mockResolvedValueOnce(response({ success: true, data: rootPage }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderEditor('edit');

    expect(await screen.findByText('/docs/guide')).toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Parent Page' }),
      '',
    );
    await user.click(screen.getByRole('button', { name: 'Save Page' }));

    expect(await screen.findByText('Page saved.')).toBeInTheDocument();
    expect(fetchMock.mock.calls[3]?.[0]).toBe(`/api/pages/${page.id}`);
    expect(JSON.parse(String(
      (fetchMock.mock.calls[3]?.[1] as RequestInit).body,
    ))).toMatchObject({
      parent_id: null,
      expected_revision: page.revision,
    });
  });

  it('keeps the saved Page until its current recovery copy is discarded', async () => {
    const snapshot = {
      version: 1 as const,
      content_type: 'page' as const,
      draft: {
        parent_id: parent.id,
        title: 'Recovered current Page',
        slug: page.slug,
        content: 'Recovered source',
        document_type: page.document_type,
        excerpt: page.excerpt,
        status: page.status,
        discoverability: page.discoverability,
        allow_comments: page.allow_comments,
        featured_image_id: null,
      },
      references: { parent, featured_image: null },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: page }))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          autosave: {
            draft_id: '8'.repeat(32),
            target_id: page.id,
            base_revision: page.revision,
            snapshot,
            snapshot_sha256: '9'.repeat(64),
            created_at_iso: '2026-08-01T08:00:00.000Z',
            updated_at_iso: '2026-08-01T08:01:00.000Z',
            expires_at_iso: null,
          },
        },
      }))
      .mockResolvedValueOnce(options())
      .mockResolvedValueOnce(response({
        success: true,
        data: { status: 'autosave_deleted', deleted: true },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderEditor('edit');

    const title = await screen.findByRole('textbox', { name: 'Title' });
    expect(title).toHaveValue(page.title);
    expect(title).toBeDisabled();
    expect(screen.queryByRole('dialog', {
      name: 'Recover an autosaved Page?',
    })).not.toBeInTheDocument();
    expect(screen.getByText('Recover an autosaved Page?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', {
      name: 'Compare with saved Page',
    }));
    expect(await screen.findByRole('dialog', {
      name: 'Compare the saved Page and autosave',
    })).toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: 'Saved Page source' }))
      .toHaveValue(page.content);
    expect(screen.getByRole('textbox', { name: 'Autosaved copy source' }))
      .toHaveValue('Recovered source');
    expect(fetch).toHaveBeenCalledTimes(3);
    await user.click(screen.getByRole('button', { name: 'Close comparison' }));
    expect(title).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Discard autosave' }));

    expect(title).toHaveValue(page.title);
    expect(title).toBeEnabled();
    expect(fetchMock.mock.calls[3]?.[0]).toBe('/api/pages/autosave');
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('surfaces the child lifecycle guard without discarding edits', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: page }))
      .mockResolvedValueOnce(noAutosave())
      .mockResolvedValueOnce(options())
      .mockResolvedValueOnce(response({
        success: false,
        error: { code: 'PAGE_HAS_CHILDREN' },
      }, 409));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderEditor('edit');

    await screen.findByRole('textbox', { name: 'Title' });
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Status' }),
      'trash',
    );
    await user.click(screen.getByRole('button', { name: 'Save Page' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Reparent or permanently delete every child Page',
    );
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveValue('trash');
  });
});
