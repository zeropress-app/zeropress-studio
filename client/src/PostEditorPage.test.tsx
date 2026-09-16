// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { PostEditorPage } from './PostEditorPage';
import { StudioToaster } from './components/primitives';
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

vi.mock('./components/AiPostEditComparison', () => ({
  AiPostEditComparison: (input: {
    original: string;
    modified: string;
    copy: { originalLabel: string; modifiedLabel: string };
    onChange: (value: string) => void;
  }) => (
    <div>
      <textarea readOnly aria-label={input.copy.originalLabel} value={input.original} />
      <textarea
        aria-label={input.copy.modifiedLabel}
        value={input.modified}
        onChange={(event) => input.onChange(event.target.value)}
      />
    </div>
  ),
}));

const post = {
  id: '1'.repeat(32),
  public_id: 100_000_000_001,
  title: 'First Post',
  slug: 'first-post',
  content: '# Hello',
  document_type: 'markdown',
  editor_mode: 'source',
  editor_profile: null,
  excerpt: 'Hello',
  status: 'draft',
  author: { id: 'Studio-Owner', display_name: 'Studio Owner' },
  categories: [{ id: '2'.repeat(32), name: 'News', slug: 'news' }],
  tags: [
    { id: '3'.repeat(32), name: 'Second', slug: 'second' },
    { id: '4'.repeat(32), name: 'First', slug: 'first' },
  ],
  discoverability: 'default',
  allow_comments: true,
  featured_image: null,
  published_at_iso: null,
  revision: '5'.repeat(32),
  created_at_iso: '2026-08-01T08:00:00.000Z',
  updated_at_iso: '2026-08-01T08:00:00.000Z',
} as const;

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function options(kind: 'author' | 'category' | 'tag') {
  const items = kind === 'author'
    ? [{ kind, id: post.author.id, label: post.author.display_name, slug: null }]
    : kind === 'category'
      ? [{ kind, id: post.categories[0].id, label: 'News', slug: 'news' }]
      : post.tags.map((tag) => ({
          kind,
          id: tag.id,
          label: tag.name,
          slug: tag.slug,
}));
  return response({ success: true, data: { kind, items } });
}

function mediaCollections() {
  return response({
    success: true,
    data: { items: [], total_media_count: 0, unfiled_media_count: 0 },
  });
}

function mediaList(items: unknown[], mediaOrigin = 'https://media.example') {
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
        r2_preview_available: false,
      },
    },
  });
}

function noAutosave() {
  return response({ success: true, data: { autosave: null } });
}

function recoverablePostAutosave() {
  return response({
    success: true,
    data: {
      autosave: {
        draft_id: '8'.repeat(32),
        target_id: null,
        base_revision: null,
        snapshot: {
          version: 1,
          content_type: 'post',
          draft: {
            title: 'Recovered Post',
            slug: 'recovered-post',
            content: 'Recovered source',
            document_type: 'markdown',
            excerpt: '',
            status: 'draft',
            author_id: post.author.id,
            category_ids: [post.categories[0].id],
            tag_ids: [post.tags[0].id],
            discoverability: 'default',
            allow_comments: true,
            featured_image_id: null,
          },
          references: {
            author: post.author,
            categories: post.categories,
            tags: [post.tags[0]],
            featured_image: null,
          },
        },
        snapshot_sha256: '9'.repeat(64),
        created_at_iso: '2026-08-01T08:00:00.000Z',
        updated_at_iso: '2026-08-01T08:01:00.000Z',
        expires_at_iso: '2026-08-08T08:01:00.000Z',
      },
    },
  });
}

function renderEditor(
  mode: 'create' | 'edit',
  roles?: string[],
) {
  return render(
    <MemoryRouter initialEntries={[
      mode === 'create' ? '/posts/new' : `/posts/${post.id}`,
    ]}>
      <Routes>
        <Route
          path={mode === 'create' ? '*' : '/posts/:postId'}
          element={(
            <PostEditorPage
              mode={mode}
              data={{
                csrf_token: 'c'.repeat(43),
                ...(roles ? { user: { roles } } : {}),
              }}
              onSessionEnded={vi.fn()}
            />
          )}
        />
        <Route
          path="/newsletters"
          element={<p>Filtered delivery ledger</p>}
        />
      </Routes>
      <StudioToaster />
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

describe('PostEditorPage', () => {
  it('reviews an AI excerpt from the current unsaved Post draft', async () => {
    const fetchMock = vi.fn().mockImplementation(async (
      request: string,
      init?: RequestInit,
    ) => {
      const url = new URL(request, 'https://studio.local');
      if (url.pathname === '/api/posts/autosave/recent') return noAutosave();
      if (url.pathname === '/api/posts/options') {
        return options(url.searchParams.get('kind') as 'author' | 'category' | 'tag');
      }
      if (url.pathname === '/api/posts/ai/excerpt') {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          title: 'Unsaved title',
          document_type: 'html',
        });
        expect(JSON.parse(String(init?.body)).content).toContain(
          'Unsaved body',
        );
        return response({
          success: true,
          data: {
            excerpt: 'Generated from the unsaved Post.',
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
      'Unsaved title',
    );
    await user.type(
      await screen.findByRole('textbox', { name: 'Content' }),
      'Unsaved body',
    );
    await user.click(screen.getByRole('button', { name: 'Generate with AI' }));
    expect(await screen.findByRole('dialog', {
      name: 'Use this generated excerpt?',
    })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Apply to draft' }));
    expect(screen.getByRole('textbox', { name: 'Excerpt' }))
      .toHaveValue('Generated from the unsaved Post.');
    expect(fetchMock.mock.calls.some(([path]) => (
      path === '/api/posts'
    ))).toBe(false);
  });

  it('reviews an AI Post candidate before applying it to an empty draft', async () => {
    const generated = {
      title: 'Generated Post title',
      excerpt: 'Generated Post excerpt.',
      content: '<h2>Generated section</h2>\n<p>Generated body.</p>',
      document_type: 'html',
      editor_mode: 'visual',
      editor_profile: 'tiptap-v1',
    };
    const fetchMock = vi.fn().mockImplementation(async (
      request: string,
      init?: RequestInit,
    ) => {
      const url = new URL(request, 'https://studio.local');
      if (url.pathname === '/api/posts/autosave/recent') return noAutosave();
      if (url.pathname === '/api/posts/options') {
        return options(url.searchParams.get('kind') as 'author' | 'category' | 'tag');
      }
      if (url.pathname === '/api/posts/ai/draft') {
        expect(JSON.parse(String(init?.body))).toEqual({
          title: '',
          brief: 'Explain a practical migration workflow.',
          tone: 'informative',
          length: 'medium',
          document_type: 'html',
          editor_mode: 'visual',
        });
        return response({ success: true, data: generated });
      }
      throw new Error(`Unexpected request: ${request}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderEditor('create');

    await user.click(await screen.findByRole('button', {
      name: 'Draft with AI',
    }));
    await user.type(
      screen.getByRole('textbox', { name: 'Topic and writing notes' }),
      'Explain a practical migration workflow.',
    );
    await user.click(screen.getByRole('button', { name: 'Generate draft' }));
    expect(await screen.findByRole('dialog', {
      name: 'Review the generated Post draft',
    })).toBeInTheDocument();

    await user.click(screen.getByRole('button', {
      name: 'Apply selected fields',
    }));
    expect(screen.getByRole('textbox', { name: 'Title' }))
      .toHaveValue(generated.title);
    expect(screen.getByRole('textbox', { name: 'Excerpt' }))
      .toHaveValue(generated.excerpt);
    expect(await screen.findByText('Generated body.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/posts'))
      .toBe(false);
  });

  it('keeps an AI draft in the empty Post current Markdown source format', async () => {
    const generated = {
      title: 'Generated Markdown title',
      excerpt: 'Generated Markdown excerpt.',
      content: '## Generated section\n\nGenerated body.',
      document_type: 'markdown',
      editor_mode: 'source',
      editor_profile: null,
    };
    const fetchMock = vi.fn().mockImplementation(async (
      request: string,
      init?: RequestInit,
    ) => {
      const url = new URL(request, 'https://studio.local');
      if (url.pathname === '/api/posts/autosave/recent') return noAutosave();
      if (url.pathname === '/api/posts/options') {
        return options(url.searchParams.get('kind') as 'author' | 'category' | 'tag');
      }
      if (url.pathname === '/api/posts/ai/draft') {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          document_type: 'markdown',
          editor_mode: 'source',
        });
        return response({ success: true, data: generated });
      }
      throw new Error(`Unexpected request: ${request}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderEditor('create');

    await screen.findByRole('textbox', { name: 'Title' });
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Document type' }),
      'markdown',
    );
    await user.click(screen.getByRole('button', { name: 'Draft with AI' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Topic and writing notes' }),
      'Explain a practical migration workflow.',
    );
    await user.click(screen.getByRole('button', { name: 'Generate draft' }));
    await screen.findByRole('dialog', {
      name: 'Review the generated Post draft',
    });
    await user.click(screen.getByRole('button', {
      name: 'Apply selected fields',
    }));

    expect(screen.getByRole('combobox', { name: 'Document type' }))
      .toHaveValue('markdown');
    expect(screen.getByRole('textbox', { name: 'Content' }))
      .toHaveValue(generated.content);
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/posts'))
      .toBe(false);
  });

  it('reviews and edits a selected existing Post passage before applying it locally', async () => {
    const fetchMock = vi.fn().mockImplementation(async (
      request: string,
      init?: RequestInit,
    ) => {
      const url = new URL(request, 'https://studio.local');
      if (url.pathname === `/api/posts/${post.id}` && init?.method === 'GET') {
        return response({ success: true, data: post });
      }
      if (url.pathname === '/api/posts/autosave') return noAutosave();
      if (url.pathname === '/api/posts/options') {
        return options(url.searchParams.get('kind') as 'author' | 'category' | 'tag');
      }
      if (url.pathname === `/api/posts/${post.id}/ai/edit`) {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          expected_revision: post.revision,
          operation: 'rewrite',
          target: { document_type: 'markdown', editor_mode: 'source' },
          selection: {
            kind: 'source',
            source: 'Hello',
            context_before: '# ',
            context_after: '',
          },
        });
        return response({
          success: true,
          data: { replacement: 'Clear greeting' },
        });
      }
      throw new Error(`Unexpected request: ${request}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderEditor('edit');

    const content = await screen.findByRole('textbox', {
      name: 'Content',
    }) as HTMLTextAreaElement;
    content.setSelectionRange(2, 7);
    fireEvent.select(content);
    await user.click(screen.getByRole('button', {
      name: 'Rewrite selection with AI',
    }));
    expect(screen.getByRole('textbox', { name: 'Selected source' }))
      .toHaveValue('Hello');
    await user.click(screen.getByRole('button', {
      name: 'Generate replacement',
    }));
    const reviewed = await screen.findByRole('textbox', {
      name: 'Reviewed proposal',
    });
    expect(reviewed).toHaveValue('# Clear greeting');
    await user.clear(reviewed);
    await user.type(reviewed, '# Author-reviewed greeting');
    await user.click(screen.getByRole('button', {
      name: 'Apply reviewed edit',
    }));
    expect(content).toHaveValue('# Author-reviewed greeting');
    expect(fetchMock.mock.calls.some(([path, options]) => (
      path === `/api/posts/${post.id}`
      && (options as RequestInit | undefined)?.method === 'PUT'
    ))).toBe(false);
  });

  it('lets an administrator explicitly notify subscribers about one saved published revision', async () => {
    const published = {
      ...post,
      status: 'published',
      published_at_iso: '2026-08-01T08:00:00.000Z',
    };
    const fetchMock = vi.fn().mockImplementation(async (
      request: string,
      init?: RequestInit,
    ) => {
      const url = new URL(request, 'https://studio.local');
      if (url.pathname === `/api/posts/${post.id}` && init?.method === 'GET') {
        return response({ success: true, data: published });
      }
      if (url.pathname === '/api/posts/autosave') return noAutosave();
      if (url.pathname === '/api/posts/options') {
        return options(url.searchParams.get('kind') as 'author' | 'category' | 'tag');
      }
      if (url.pathname === '/api/settings/comments') {
        return response({ success: false, error: { code: 'FORBIDDEN' } }, 403);
      }
      if (url.pathname === `/api/posts/${post.id}/newsletter-notification`) {
        expect(init).toMatchObject({ method: 'POST' });
        expect(JSON.parse(String(init?.body))).toEqual({
          expected_revision: post.revision,
        });
        return response({
          success: true,
          data: {
            status: 'queued',
            post_id: post.id,
            post_revision: post.revision,
            recipient_count: 14,
            newly_queued_count: 14,
          },
        });
      }
      throw new Error(`Unexpected request: ${request}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderEditor('edit', ['admin']);

    await user.click(await screen.findByRole('button', {
      name: 'Notify subscribers',
    }));
    const dialog = screen.getByRole('dialog', {
      name: 'Notify subscribers about “First Post”?',
    });
    expect(dialog).toHaveTextContent('future publishes are not sent automatically');
    await user.click(within(dialog).getByRole('button', {
      name: 'Notify subscribers',
    }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', {
        name: 'Notify subscribers about “First Post”?',
      })).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText('Notification queued for 14 subscribers.')).toBeVisible();
    });
    const ledgerLink = screen.getByRole('link', {
      name: 'View delivery history',
    });
    expect(ledgerLink).toHaveAttribute(
      'href',
      `/newsletters?tab=deliveries&content_id=${post.id}`,
    );
    fireEvent.click(ledgerLink);
    expect(screen.getByText('Filtered delivery ledger')).toBeInTheDocument();
  });

  it('does not expose subscriber notification to an editor', async () => {
    const published = {
      ...post,
      status: 'published',
      published_at_iso: '2026-08-01T08:00:00.000Z',
    };
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (request: string) => {
      const url = new URL(request, 'https://studio.local');
      if (url.pathname === `/api/posts/${post.id}`) {
        return response({ success: true, data: published });
      }
      if (url.pathname === '/api/posts/autosave') return noAutosave();
      if (url.pathname === '/api/posts/options') {
        return options(url.searchParams.get('kind') as 'author' | 'category' | 'tag');
      }
      if (url.pathname === '/api/settings/comments') {
        return response({ success: false, error: { code: 'FORBIDDEN' } }, 403);
      }
      throw new Error(`Unexpected request: ${request}`);
    }));
    renderEditor('edit', ['editor']);

    await screen.findByRole('textbox', { name: 'Title' });
    expect(screen.queryByRole('button', { name: 'Notify subscribers' }))
      .not.toBeInTheDocument();
  });

  it('fixes an Author contributor to the linked public Author', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((request: string) => {
      const url = new URL(request, 'https://studio.local');
      if (url.pathname === '/api/posts/autosave/recent') return Promise.resolve(noAutosave());
      if (url.pathname === '/api/posts/options') {
        return Promise.resolve(options(url.searchParams.get('kind') as 'author' | 'category' | 'tag'));
      }
      if (url.pathname === '/api/settings/comments') {
        return Promise.resolve(response({
          success: false,
          error: { code: 'FORBIDDEN' },
        }, 403));
      }
      throw new Error(`Unexpected request: ${request}`);
    }));
    renderEditor('create', ['author']);

    const author = await screen.findByRole('textbox', {
      name: 'Public Author',
    });
    expect(author).toHaveValue(post.author.display_name);
    expect(author).toHaveAttribute('readonly');
    expect(screen.queryByRole('combobox', { name: 'Public Author' }))
      .not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Manage Authors' }))
      .not.toBeInTheDocument();
    expect(screen.getByText(/Contributor accounts cannot reassign a Post/))
      .toBeInTheDocument();
  });

  it('inserts a registered attachment at the current Markdown cursor', async () => {
    const attachment = {
      id: '6'.repeat(32),
      kind: 'document',
      filename: 'guide.pdf',
      mime_type: 'application/pdf',
      location: {
        type: 'external',
        url: 'https://media.example/uploads/guide.pdf',
      },
      size_bytes: 2048,
      width: null,
      height: null,
      duration_ms: null,
      alt: '',
      collection: null,
      usage: { posts: 0, pages: 0, authors: 0, branding: 0 },
      revision: '7'.repeat(32),
      created_at_iso: '2026-08-04T01:00:00.000Z',
      updated_at_iso: '2026-08-04T01:00:00.000Z',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(noAutosave())
      .mockResolvedValueOnce(options('author'))
      .mockResolvedValueOnce(options('category'))
      .mockResolvedValueOnce(options('tag'))
      .mockResolvedValueOnce(mediaCollections())
      .mockResolvedValueOnce(mediaList([attachment]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderEditor('create');

    await screen.findByRole('textbox', { name: 'Content' });
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Document type' }),
      'markdown',
    );
    const content = await screen.findByRole('textbox', {
      name: 'Content',
    }) as HTMLTextAreaElement;
    await user.type(content, 'Before after');
    content.setSelectionRange(7, 7);
    fireEvent.select(content);
    await user.click(screen.getByRole('button', { name: 'Insert Media' }));
    await user.click(await screen.findByRole('button', {
      name: 'Insert guide.pdf',
    }));

    expect(content).toHaveValue(
      'Before [guide.pdf](<https://media.example/uploads/guide.pdf>)after',
    );
    expect(String(fetchMock.mock.calls[5]?.[0])).toContain('kind=all');
  });

  it('offers an interrupted new Post snapshot for explicit recovery', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(recoverablePostAutosave())
      .mockResolvedValueOnce(options('author'))
      .mockResolvedValueOnce(options('category'))
      .mockResolvedValueOnce(options('tag'));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderEditor('create');

    expect(await screen.findByRole('dialog', {
      name: 'Recover an autosaved Post?',
    })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore in editor' }));
    expect(screen.getByRole('textbox', { name: 'Title' }))
      .toHaveValue('Recovered Post');
    expect(screen.getByRole('button', { name: 'Save Post' })).toBeEnabled();
  });

  it('creates HTML by default with relationships and ordered tags', async () => {
    const created = {
      ...post,
      title: 'New Post',
      slug: 'new-post',
      content: '<p>Hello</p>',
      document_type: 'html' as const,
      editor_mode: 'visual' as const,
      editor_profile: 'tiptap-v1' as const,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(noAutosave())
      .mockResolvedValueOnce(options('author'))
      .mockResolvedValueOnce(options('category'))
      .mockResolvedValueOnce(options('tag'))
      .mockResolvedValueOnce(response({ success: true, data: created }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderEditor('create');

    const title = await screen.findByRole('textbox', { name: 'Title' });
    await user.type(title, 'New Post');
    expect(screen.getByRole('textbox', { name: /^Slug/ })).toHaveValue('new-post');
    expect(screen.getByRole('combobox', { name: 'Document type' }))
      .toHaveValue('html');
    await user.type(
      screen.getByRole('textbox', { name: 'Content' }),
      'Hello',
    );
    await user.click(screen.getByRole('checkbox', { name: /News/ }));
    await user.click(screen.getByRole('checkbox', { name: /Second/ }));
    await user.click(screen.getByRole('checkbox', { name: /First/ }));
    await user.click(screen.getByRole('button', { name: 'Move First up' }));
    await user.click(screen.getByRole('button', { name: 'Save Post' }));

    expect(await screen.findByText('Post saved.')).toBeInTheDocument();
    const mutation = fetchMock.mock.calls[4];
    expect(mutation?.[0]).toBe('/api/posts');
    expect(mutation?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String((mutation?.[1] as RequestInit).body))).toMatchObject({
      title: 'New Post',
      slug: 'new-post',
      content: '<p>Hello</p>',
      document_type: 'html',
      editor_mode: 'visual',
      editor_profile: 'tiptap-v1',
      author_id: post.author.id,
      category_ids: [post.categories[0].id],
      tag_ids: [post.tags[1].id, post.tags[0].id],
      allow_comments: true,
    });
  });

  it('lets an unchanged visual Post return from source mode without saving', async () => {
    const visualPost = {
      ...post,
      content: '<p>Hello</p>',
      document_type: 'html' as const,
      editor_mode: 'visual' as const,
      editor_profile: 'tiptap-v1' as const,
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: visualPost }))
      .mockResolvedValueOnce(noAutosave())
      .mockResolvedValueOnce(options('author'))
      .mockResolvedValueOnce(options('category'))
      .mockResolvedValueOnce(options('tag')));
    const user = userEvent.setup();
    renderEditor('edit');
    await screen.findByRole('textbox', { name: 'Content' });

    await user.click(screen.getByRole('button', { name: 'HTML source' }));
    await user.click(screen.getByRole('button', { name: 'Use HTML source' }));
    expect(screen.getByRole('button', { name: 'Save Post' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Visual' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Post' })).toBeDisabled();
  });

  it('loads an existing Post and sends its revision with status changes', async () => {
    const published = {
      ...post,
      status: 'published',
      published_at_iso: '2026-08-01T09:00:00.000Z',
      revision: '6'.repeat(32),
      updated_at_iso: '2026-08-01T09:00:00.000Z',
    } as const;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: post }))
      .mockResolvedValueOnce(noAutosave())
      .mockResolvedValueOnce(options('author'))
      .mockResolvedValueOnce(options('category'))
      .mockResolvedValueOnce(options('tag'))
      .mockResolvedValueOnce(response({ success: true, data: published }));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderEditor('edit');

    expect(await screen.findByRole('textbox', { name: 'Title' }))
      .toHaveValue(post.title);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'published');
    await user.click(screen.getByRole('button', { name: 'Save Post' }));

    expect(await screen.findByText('Post saved.')).toBeInTheDocument();
    const mutation = fetchMock.mock.calls[5];
    expect(mutation?.[0]).toBe(`/api/posts/${post.id}`);
    expect(mutation?.[1]).toMatchObject({ method: 'PUT' });
    expect(JSON.parse(String((mutation?.[1] as RequestInit).body)))
      .toMatchObject({
        status: 'published',
        expected_revision: post.revision,
      });
  });

  it('opens the saved Post and offers its current recovery copy explicitly', async () => {
    const snapshot = {
      version: 1 as const,
      content_type: 'post' as const,
      draft: {
        title: 'Recovered current Post',
        slug: post.slug,
        content: 'Recovered source',
        document_type: post.document_type,
        excerpt: post.excerpt,
        status: post.status,
        author_id: post.author.id,
        category_ids: post.categories.map((item) => item.id),
        tag_ids: post.tags.map((item) => item.id),
        discoverability: post.discoverability,
        allow_comments: post.allow_comments,
        featured_image_id: null,
      },
      references: {
        author: post.author,
        categories: post.categories,
        tags: post.tags,
        featured_image: null,
      },
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: post }))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          autosave: {
            draft_id: '8'.repeat(32),
            target_id: post.id,
            base_revision: post.revision,
            snapshot,
            snapshot_sha256: '9'.repeat(64),
            created_at_iso: '2026-08-01T08:00:00.000Z',
            updated_at_iso: '2026-08-01T08:01:00.000Z',
            expires_at_iso: null,
          },
        },
      }))
      .mockResolvedValueOnce(options('author'))
      .mockResolvedValueOnce(options('category'))
      .mockResolvedValueOnce(options('tag')));
    const user = userEvent.setup();
    renderEditor('edit');

    const title = await screen.findByRole('textbox', { name: 'Title' });
    expect(title).toHaveValue(post.title);
    expect(title).toBeDisabled();
    expect(screen.queryByRole('dialog', {
      name: 'Recover an autosaved Post?',
    })).not.toBeInTheDocument();
    expect(screen.getByText('Recover an autosaved Post?')).toBeInTheDocument();

    await user.click(screen.getByRole('button', {
      name: 'Compare with saved Post',
    }));
    expect(await screen.findByRole('dialog', {
      name: 'Compare the saved Post and autosave',
    })).toBeInTheDocument();
    expect(await screen.findByRole('textbox', { name: 'Saved Post source' }))
      .toHaveValue(post.content);
    expect(screen.getByRole('textbox', { name: 'Autosaved copy source' }))
      .toHaveValue('Recovered source');
    expect(fetch).toHaveBeenCalledTimes(5);
    await user.click(screen.getByRole('button', { name: 'Close comparison' }));
    expect(title).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Restore in editor' }));

    expect(title).toHaveValue('Recovered current Post');
    expect(title).toBeEnabled();
    expect(screen.getByText(/loaded the recovery copy/iu)).toBeInTheDocument();
  });

  it('blocks permanent deletion while a trashed Post has unsaved changes', async () => {
    const trashed = { ...post, status: 'trash' } as const;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ success: true, data: trashed }))
      .mockResolvedValueOnce(noAutosave())
      .mockResolvedValueOnce(options('author'))
      .mockResolvedValueOnce(options('category'))
      .mockResolvedValueOnce(options('tag'));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderEditor('edit');

    const deleteButton = await screen.findByRole('button', {
      name: 'Delete permanently',
    });
    const revisionsButton = screen.getByRole('button', {
      name: 'Revision history',
    });
    expect(deleteButton).toBeEnabled();
    expect(revisionsButton).toBeEnabled();

    await user.type(screen.getByRole('textbox', { name: 'Title' }), ' changed');

    expect(deleteButton).toBeDisabled();
    expect(revisionsButton).toBeDisabled();
    expect(deleteButton).toHaveAttribute(
      'title',
      'Save or discard the current changes before deleting this Post permanently.',
    );
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
