// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { CurrentSessionSuccess } from '../../contracts/session';
import type {
  Media,
  MediaCollection,
  MediaDelivery,
  MediaUsageReference,
} from '../../contracts/media';
import { changeLocale } from './i18n';
import { MediaPage } from './MediaPage';

const session: CurrentSessionSuccess['data'] = {
  user: {
    id: '1'.repeat(32),
    email: 'editor@example.com',
    name: 'Editor',
    roles: ['editor'],
  },
  session: {
    id: '2'.repeat(32),
    created_at_iso: '2026-08-02T00:00:00.000Z',
    last_seen_at_iso: '2026-08-02T00:05:00.000Z',
    idle_expires_at_iso: '2026-08-02T12:05:00.000Z',
    absolute_expires_at_iso: '2026-08-09T00:00:00.000Z',
    network: {
      ip_address: '203.0.113.10',
      asn: null,
      as_organization: null,
      country_code: null,
    },
  },
  csrf_token: 'c'.repeat(43),
  edge_integration: { mode: 'enabled', database_state: 'ready' },
};

const media = {
  id: '3'.repeat(32),
  kind: 'image' as const,
  filename: 'hero.jpg',
  mime_type: 'image/jpeg',
  location: {
    type: 'external' as const,
    url: 'https://media.example/uploads/hero.jpg',
  },
  size_bytes: null,
  width: 1600,
  height: 900,
  duration_ms: null,
  alt: 'Hero',
  collection: null,
  usage: { posts: 0, pages: 0, authors: 0, branding: 0 },
  revision: '4'.repeat(32),
  created_at_iso: '2026-08-02T01:00:00.000Z',
  updated_at_iso: '2026-08-02T01:00:00.000Z',
};

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mediaList(
  items: Media[],
  delivery: MediaDelivery = {
    media_origin: '',
    r2_preview_available: true,
  },
) {
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
      delivery,
    },
  });
}

function mediaReferences(
  items: MediaUsageReference[],
  page = 1,
  perPage = 20,
  total = items.length,
) {
  return response({
    success: true,
    data: {
      media_id: media.id,
      items,
      pagination: {
        page,
        per_page: perPage,
        total,
        total_pages: total === 0 ? 0 : Math.ceil(total / perPage),
      },
    },
  });
}

function uploadPolicy(available = true) {
  return response({
    success: true,
    data: {
      available,
      unavailable_reason: available ? null : 'binding_missing',
      max_bytes: 67_108_864,
      max_svg_bytes: 2_097_152,
      max_files: 10,
      concurrency: 2,
      accepted_extensions: ['jpg', 'png', 'svg', 'pdf', 'zip'],
    },
  });
}

function collectionList(
  items: MediaCollection[] = [],
  totalMediaCount = 0,
  unfiledMediaCount = 0,
) {
  return response({
    success: true,
    data: {
      items,
      total_media_count: totalMediaCount,
      unfiled_media_count: unfiledMediaCount,
    },
  });
}

function mediaFetchSequence(responses: Response[]) {
  return vi.fn((path: RequestInfo | URL, _init?: RequestInit) => {
    if (String(path) === '/api/media/uploads/policy') {
      return Promise.resolve(uploadPolicy());
    }
    if (String(path) === '/api/media/collections') {
      return Promise.resolve(collectionList());
    }
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected Media request: ${String(path)}`);
    return Promise.resolve(next);
  });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <MediaPage data={session} onSessionEnded={vi.fn()} />
    </MemoryRouter>,
  );
}

async function chooseMediaAction(
  user: ReturnType<typeof userEvent.setup>,
  filename: string,
  action: string,
) {
  await user.click(await screen.findByRole('button', {
    name: `Actions for ${filename}`,
  }));
  await user.click(await screen.findByRole('menuitem', { name: action }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});

describe('MediaPage', () => {
  it('keeps one list select-all control outside the header and preserves selection across views', async () => {
    const secondMedia = { ...media, id: '5'.repeat(32), filename: 'second.jpg' };
    vi.stubGlobal('fetch', mediaFetchSequence([mediaList([media, secondMedia])]));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('checkbox', { name: 'Select hero.jpg' }));
    await user.click(screen.getByRole('button', { name: 'List view' }));

    const selectPage = screen.getByRole('checkbox', {
      name: 'Select every Media item on this page',
    });
    const table = screen.getByRole('table', { name: 'Media' });
    expect(table).toHaveClass('studio-table-stacked-compact');
    expect(screen.getAllByRole('checkbox', { name: 'Select every Media item on this page' }))
      .toHaveLength(1);
    expect(screen.queryByRole('checkbox', { name: 'Select this page' })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Media' })).toContainElement(selectPage);
    expect(selectPage.closest('table')).toBeNull();
    expect(table.querySelector('thead input[type="checkbox"]')).toBeNull();
    expect(selectPage).toBePartiallyChecked();
    expect(within(table).getByRole('checkbox', { name: 'Select hero.jpg' }).closest('td'))
      .toHaveAttribute('data-stack', 'select');
    expect(within(table).getByRole('button', { name: 'hero.jpg' }).closest('td'))
      .toHaveAttribute('data-stack', 'primary');
    expect(table.querySelectorAll('td[data-stack="preview"]')).toHaveLength(2);
    expect(within(table).getByRole('button', { name: 'Actions for hero.jpg' }).closest('td'))
      .toHaveAttribute('data-stack', 'actions');

    await user.click(selectPage);
    expect(selectPage).toBeChecked();
    expect(selectPage).not.toBePartiallyChecked();
    expect(within(table).getAllByRole('checkbox', { checked: true })).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Grid view' }));
    expect(screen.getByRole('checkbox', { name: 'Select this page' })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'Select every Media item on this page' }))
      .not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select hero.jpg' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Select second.jpg' })).toBeChecked();

    await user.click(screen.getByRole('button', { name: 'List view' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select every Media item on this page' }));
    expect(screen.getAllByRole('checkbox', { checked: false })).toHaveLength(3);
    expect(screen.queryByRole('checkbox', { checked: true })).not.toBeInTheDocument();
  });

  it('defaults to the Media grid and preserves the detailed list view', async () => {
    vi.stubGlobal('fetch', mediaFetchSequence([mediaList([media])]));
    const user = userEvent.setup();
    renderPage();

    const gridButton = await screen.findByRole('button', { name: 'Grid view' });
    const listButton = screen.getByRole('button', { name: 'List view' });
    expect(gridButton).toHaveAttribute('aria-pressed', 'true');
    expect(listButton).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('list', { name: 'Media grid' })).toBeInTheDocument();

    await user.click(listButton);

    expect(listButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('table', { name: 'Media' })).toBeInTheDocument();
    expect(screen.getByText('https://media.example/uploads/hero.jpg', {
      selector: 'code',
    })).toBeInTheDocument();
  });

  it('manages flat collections from a bounded dialog', async () => {
    const collection: MediaCollection = {
      id: '5'.repeat(32),
      name: 'Photography',
      media_count: 1,
      revision: '6'.repeat(32),
      created_at_iso: '2026-08-02T00:00:00.000Z',
      updated_at_iso: '2026-08-02T00:00:00.000Z',
    };
    vi.stubGlobal('fetch', vi.fn((path: RequestInfo | URL) => {
      const value = String(path);
      if (value === '/api/media/uploads/policy') {
        return Promise.resolve(uploadPolicy());
      }
      if (value === '/api/media/collections') {
        return Promise.resolve(collectionList([collection], 1, 0));
      }
      if (value.startsWith('/api/media?')) {
        return Promise.resolve(mediaList([{
          ...media,
          collection: { id: collection.id, name: collection.name },
        }]));
      }
      throw new Error(`Unexpected Media request: ${value}`);
    }));
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('button', { name: 'View details for hero.jpg' });
    await user.click(screen.getByRole('button', { name: 'Manage collections' }));

    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByRole('heading', { name: 'Manage collections' }))
      .toBeInTheDocument();
    expect(dialog.getByText('1 of 500 collections')).toBeInTheDocument();
    expect(dialog.getByText('Photography')).toBeInTheDocument();
    expect(dialog.getByText('1 Media items')).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Edit Photography' }))
      .toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Delete Photography' }))
      .toBeInTheDocument();
  });

  it('opens the generated image information after refreshing the library', async () => {
    const generatedMedia: Media = {
      ...media,
      id: '5'.repeat(32),
      filename: 'ai-generated.jpg',
      location: { type: 'r2', key: 'uploads/2026/08/ai-generated.jpg' },
      alt: 'A quiet library',
    };
    const generation = {
      version: 1,
      model: 'test-image-model',
      prompt_version: 'image-v1',
      prompt: 'A quiet library at sunrise',
      aspect_ratio: 'landscape',
      seed: 42,
    };
    let generated = false;
    vi.stubGlobal('fetch', vi.fn((path: RequestInfo | URL) => {
      const value = String(path);
      if (value === '/api/media/uploads/policy') {
        return Promise.resolve(uploadPolicy());
      }
      if (value === '/api/media/collections') {
        return Promise.resolve(collectionList([], generated ? 2 : 1, generated ? 2 : 1));
      }
      if (value.startsWith('/api/media?')) {
        return Promise.resolve(mediaList(generated ? [generatedMedia, media] : [media]));
      }
      if (value === '/api/media/ai/images') {
        generated = true;
        return Promise.resolve(response({
          success: true,
          data: { media: generatedMedia, generation },
        }, 201));
      }
      if (value.startsWith(`/api/media/${generatedMedia.id}/information?`)) {
        return Promise.resolve(response({
          success: true,
          data: {
            media_id: generatedMedia.id,
            generation,
            references: {
              items: [],
              pagination: { page: 1, per_page: 20, total: 0, total_pages: 0 },
            },
          },
        }));
      }
      throw new Error(`Unexpected Media request: ${value}`);
    }));
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('button', { name: 'View details for hero.jpg' });
    await user.click(screen.getByRole('button', { name: 'Generate image' }));
    const generationDialog = within(screen.getByRole('dialog', {
      name: 'Generate a managed image',
    }));
    await user.type(
      generationDialog.getByRole('textbox', { name: 'Image description' }),
      generation.prompt,
    );
    await user.click(generationDialog.getByRole('button', { name: 'Generate image' }));

    await waitFor(() => {
      const information = within(screen.getByRole('dialog', {
        name: generatedMedia.filename,
      }));
      expect(information.getByText(generatedMedia.id)).toBeInTheDocument();
      expect(information.getByText(generation.prompt)).toBeInTheDocument();
    });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await user.click(within(screen.getByRole('dialog', {
      name: generatedMedia.filename,
    })).getByRole('button', { name: 'Close' }));
    expect(await screen.findByRole('button', {
      name: `View details for ${generatedMedia.filename}`,
    })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'All Media (2)' })).toBeInTheDocument();
  });

  it('opens Media information without also rendering the metadata editor', async () => {
    vi.stubGlobal('fetch', mediaFetchSequence([
      mediaList([media]),
      mediaReferences([]),
    ]));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', {
      name: 'View details for hero.jpg',
    }));

    expect(await screen.findByRole('heading', { name: 'hero.jpg' }))
      .toBeInTheDocument();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByText('Media ID')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Edit Media metadata' }))
      .not.toBeInTheDocument();
  });

  it('offers browser upscaling only for an eligible managed raster source', async () => {
    const managedMedia: Media = {
      ...media,
      location: {
        type: 'r2',
        key: 'uploads/2026/08/hero.jpg',
      },
      width: 1_920,
      height: 1_080,
    };
    vi.stubGlobal('fetch', mediaFetchSequence([
      mediaList([managedMedia]),
      mediaReferences([]),
    ]));
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', {
      name: 'View details for hero.jpg',
    }));

    expect(await screen.findByRole('button', { name: 'Upscale image' }))
      .toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit image' }))
      .toBeInTheDocument();
  });

  it('registers metadata for an existing public image without an upload request', async () => {
    const fetchMock = mediaFetchSequence([
      mediaList([]),
      response({ success: true, data: media }, 201),
      mediaList([media]),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('heading', { name: 'No Media registered' });
    await user.click(screen.getByRole('button', { name: 'Register external asset' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Filename' }),
      'hero.jpg',
    );
    await user.clear(screen.getByRole('textbox', { name: 'MIME type' }));
    await user.type(screen.getByRole('textbox', { name: 'MIME type' }), 'image/jpeg');
    await user.type(
      screen.getByRole('textbox', { name: /Absolute public URL/ }),
      'https://media.example/uploads/hero.jpg',
    );
    await user.type(screen.getByRole('spinbutton', { name: /Intrinsic width/ }), '1600');
    await user.type(screen.getByRole('spinbutton', { name: /Intrinsic height/ }), '900');
    await user.type(screen.getByRole('textbox', { name: /^Alternative text/ }), 'Hero');
    await user.click(screen.getByRole('button', { name: 'Register asset' }));

    expect(await screen.findByText('The external asset was registered.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View details for hero.jpg' }))
      .toBeInTheDocument();
    const createCall = fetchMock.mock.calls.find(([path]) => path === '/api/media');
    const request = createCall?.[1] as RequestInit;
    expect(createCall?.[0]).toBe('/api/media');
    expect(request).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({
        'X-ZeroPress-CSRF': session.csrf_token,
      }),
    });
    expect(JSON.parse(String(request.body))).toEqual({
      kind: 'image',
      filename: 'hero.jpg',
      mime_type: 'image/jpeg',
      location: {
        type: 'external',
        url: 'https://media.example/uploads/hero.jpg',
      },
      size_bytes: null,
      width: 1600,
      height: 900,
      duration_ms: null,
      alt: 'Hero',
    });
  });

  it('uses the public Media origin for R2 images without a private fallback', async () => {
    const managedImage: Media = {
      ...media,
      filename: 'managed.png',
      mime_type: 'image/png',
      location: {
        type: 'r2',
        key: `uploads/2026/08/${media.id}.png`,
      },
      alt: 'Managed hero',
    };
    const fetchMock = mediaFetchSequence([
      mediaList([managedImage], {
        media_origin: 'https://cdn.example',
        r2_preview_available: true,
      }),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    renderPage();

    const preview = await screen.findByRole('img', { name: 'Managed hero' });
    expect(preview).toHaveAttribute(
      'src',
      `https://cdn.example/uploads/2026/08/${media.id}.png`,
    );
    fireEvent.error(preview);
    await waitFor(() => expect(screen.queryByRole('img', {
      name: 'Managed hero',
    })).not.toBeInTheDocument());
    expect(screen.getByTitle(
      'This image preview is unavailable. Check the configured public Media origin or Studio R2 binding.',
    )).toHaveAttribute(
      'title',
      'This image preview is unavailable. Check the configured public Media origin or Studio R2 binding.',
    );
    expect(fetchMock.mock.calls.some(([path]) => (
      String(path).includes(`/${media.id}/preview`)
    ))).toBe(false);
  });

  it('uses the authenticated R2 preview only when Media origin is empty', async () => {
    const managedImage: Media = {
      ...media,
      filename: 'managed.webp',
      mime_type: 'image/webp',
      location: {
        type: 'r2',
        key: `uploads/2026/08/${media.id}.webp`,
      },
      alt: 'Private managed hero',
    };
    vi.stubGlobal('fetch', mediaFetchSequence([
      mediaList([managedImage]),
    ]));
    renderPage();

    expect(await screen.findByRole('img', { name: 'Private managed hero' }))
      .toHaveAttribute(
        'src',
        `/api/media/${media.id}/preview?revision=${media.revision}`,
      );
  });

  it('does not request a private preview when R2 reads are disabled', async () => {
    const managedImage: Media = {
      ...media,
      location: {
        type: 'r2',
        key: `uploads/2026/08/${media.id}.jpg`,
      },
      alt: 'Unavailable managed hero',
    };
    vi.stubGlobal('fetch', mediaFetchSequence([
      mediaList([managedImage], {
        media_origin: '',
        r2_preview_available: false,
      }),
    ]));
    renderPage();

    expect(await screen.findByTitle(
      'This image preview is unavailable. Check the configured public Media origin or Studio R2 binding.',
    )).toHaveAttribute(
      'title',
      'This image preview is unavailable. Check the configured public Media origin or Studio R2 binding.',
    );
    expect(screen.queryByRole('img', { name: 'Unavailable managed hero' }))
      .not.toBeInTheDocument();
  });

  it('filters collection members and moves selected Media atomically', async () => {
    const collection: MediaCollection = {
      id: '5'.repeat(32),
      name: 'Photography',
      media_count: 1,
      revision: '6'.repeat(32),
      created_at_iso: '2026-08-02T00:00:00.000Z',
      updated_at_iso: '2026-08-02T00:00:00.000Z',
    };
    const filedMedia: Media = {
      ...media,
      collection: { id: collection.id, name: collection.name },
    };
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn((path: RequestInfo | URL, init?: RequestInit) => {
      const value = String(path);
      requests.push({ path: value, init });
      if (value === '/api/media/uploads/policy') {
        return Promise.resolve(uploadPolicy());
      }
      if (value === '/api/media/collections') {
        return Promise.resolve(collectionList([collection], 1, 0));
      }
      if (value === '/api/media/collection-moves') {
        return Promise.resolve(response({
          success: true,
          data: {
            status: 'media_moved',
            target_collection_id: null,
            moved_count: 1,
            unchanged_count: 0,
          },
        }));
      }
      if (value.startsWith('/api/media?')) {
        return Promise.resolve(mediaList([filedMedia]));
      }
      throw new Error(`Unexpected Media request: ${value}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('button', { name: 'View details for hero.jpg' });
    await user.selectOptions(screen.getByRole('combobox', {
      name: 'Collection',
    }), collection.id);
    await waitFor(() => expect(requests.some(({ path }) => path.includes(
      `collection=${collection.id}`,
    ))).toBe(true));

    await user.click(screen.getByRole('checkbox', { name: 'Select hero.jpg' }));
    await user.click(screen.getByRole('button', { name: 'Move to collection' }));
    const dialog = within(screen.getByRole('dialog'));
    await user.selectOptions(dialog.getByRole('combobox', {
      name: 'Destination collection',
    }), 'unfiled');
    await user.click(dialog.getByRole('button', { name: 'Move Media' }));

    expect(await screen.findByText(
      '1 Media items were moved; 0 were already in the destination.',
    )).toBeInTheDocument();
    const move = requests.find(({ path }) => path === '/api/media/collection-moves');
    expect(move?.init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(move?.init?.body))).toEqual({
      target_collection_id: null,
      items: [{ id: media.id, expected_revision: media.revision }],
    });
  });

  it('bulk edits per-row metadata and deletes only explicit revision-bound selections', async () => {
    const requests: Array<{ path: string; init?: RequestInit }> = [];
    let current: Media | null = media;
    const fetchMock = vi.fn((path: RequestInfo | URL, init?: RequestInit) => {
      const value = String(path);
      requests.push({ path: value, init });
      if (value === '/api/media/uploads/policy') {
        return Promise.resolve(uploadPolicy());
      }
      if (value === '/api/media/collections') {
        return Promise.resolve(collectionList([], current ? 1 : 0, current ? 1 : 0));
      }
      if (value.startsWith('/api/media?')) {
        return Promise.resolve(mediaList(current ? [current] : []));
      }
      if (value === '/api/media/bulk-operations') {
        const body = JSON.parse(String(init?.body)) as {
          operation: 'update_metadata' | 'delete';
        };
        if (body.operation === 'update_metadata') {
          current = {
            ...media,
            filename: 'renamed.jpg',
            alt: 'Renamed hero',
            revision: '8'.repeat(32),
          };
          return Promise.resolve(response({
            success: true,
            data: {
              operation: 'update_metadata',
              results: [{
                id: media.id,
                outcome: 'updated',
                revision: current.revision,
              }],
              summary: {
                requested: 1,
                updated: 1,
                unchanged: 0,
                conflict: 0,
                skipped: 0,
                queued_objects: 0,
              },
            },
          }));
        }
        current = null;
        return Promise.resolve(response({
          success: true,
          data: {
            operation: 'delete',
            results: [{
              id: media.id,
              outcome: 'updated',
              object_cleanup: 'not_applicable',
            }],
            summary: {
              requested: 1,
              updated: 1,
              unchanged: 0,
              conflict: 0,
              skipped: 0,
              queued_objects: 0,
            },
          },
        }));
      }
      throw new Error(`Unexpected Media request: ${value}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('button', { name: 'View details for hero.jpg' });
    await user.click(screen.getByRole('checkbox', { name: 'Select hero.jpg' }));
    await user.click(screen.getByRole('button', { name: 'Edit metadata' }));
    let dialog = within(screen.getByRole('dialog'));
    await user.clear(dialog.getByRole('textbox', { name: 'Filename' }));
    await user.type(dialog.getByRole('textbox', { name: 'Filename' }), 'renamed.jpg');
    await user.clear(dialog.getByRole('textbox', { name: /^Alternative text/ }));
    await user.type(dialog.getByRole('textbox', { name: /^Alternative text/ }), 'Renamed hero');
    await user.click(dialog.getByRole('button', { name: 'Save metadata' }));

    expect(await screen.findByText(/1 updated, 0 unchanged/)).toBeInTheDocument();
    expect(await screen.findByText('renamed.jpg')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Select renamed.jpg' }));
    await user.click(screen.getByRole('button', { name: 'Delete selected' }));
    dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(/1 external records/)).toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: 'Delete selected Media' }));
    expect(await screen.findByText(/1 deleted, 0 conflicted/)).toBeInTheDocument();

    const bulkRequests = requests.filter(({ path }) => (
      path === '/api/media/bulk-operations'
    ));
    expect(JSON.parse(String(bulkRequests[0]?.init?.body))).toEqual({
      operation: 'update_metadata',
      items: [{
        id: media.id,
        expected_revision: media.revision,
        filename: 'renamed.jpg',
        alt: 'Renamed hero',
      }],
    });
    expect(JSON.parse(String(bulkRequests[1]?.init?.body))).toEqual({
      operation: 'delete',
      items: [{ id: media.id, expected_revision: '8'.repeat(32) }],
    });
  });

  it('shows the exact reference and prevents deletion until it is cleared', async () => {
    const referenced = {
      ...media,
      usage: { posts: 1, pages: 0, authors: 0, branding: 0 },
    };
    const postId = '7'.repeat(32);
    const fetchMock = mediaFetchSequence([
      mediaList([referenced]),
      mediaReferences([{
        type: 'post',
        id: postId,
        public_id: 100000000001,
        title: 'Referenced Post',
      }]),
      mediaReferences([]),
      response({
        success: true,
        data: {
          status: 'media_deleted',
          id: media.id,
          object_cleanup: 'not_applicable',
        },
      }),
      mediaList([]),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('button', { name: 'View details for hero.jpg' });
    await chooseMediaAction(user, 'hero.jpg', 'Delete');
    const dialog = within(screen.getByRole('dialog'));
    expect(await dialog.findByText('Referenced Post')).toBeInTheDocument();
    expect(dialog.getByText('Public ID 100000000001')).toBeInTheDocument();
    expect(dialog.getByRole('link', { name: 'Open in new tab' }))
      .toHaveAttribute('href', `/posts/${postId}`);
    expect(dialog.getByRole('link', { name: 'Open in new tab' }))
      .toHaveAttribute('target', '_blank');
    expect(dialog.getByRole('heading', { name: 'Delete this Media record?' }))
      .toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Delete Media record' }))
      .toBeDisabled();

    await user.click(dialog.getByRole('button', {
      name: 'Check references again',
    }));
    expect(await dialog.findByText('Ready to delete')).toBeInTheDocument();
    expect(dialog.getByRole('button', { name: 'Delete Media record' }))
      .toBeEnabled();
    await user.click(dialog.getByRole('button', { name: 'Delete Media record' }));
    expect(await screen.findByText(
      'The Media record was deleted. The external object was preserved.',
    )).toBeInTheDocument();
    const deletion = fetchMock.mock.calls.find(([path, init]) => (
      path === `/api/media/${media.id}` && init?.method === 'DELETE'
    ));
    expect(deletion).toBeDefined();
  });

  it('warns that deleting imported Media also queues its R2 object', async () => {
    const imported = {
      ...media,
      location: {
        type: 'r2' as const,
        key: 'imported/2026/08/hero.jpg',
      },
    };
    const fetchMock = mediaFetchSequence([
      mediaList([imported]),
      mediaReferences([]),
      response({
        success: true,
        data: {
          status: 'media_deleted',
          id: media.id,
          object_cleanup: 'pending',
        },
      }),
      mediaList([]),
    ]);
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('button', { name: 'View details for hero.jpg' });
    await chooseMediaAction(user, 'hero.jpg', 'Delete');
    const dialog = within(screen.getByRole('dialog'));
    expect(await dialog.findByRole('heading', {
      name: 'Delete this file and Media record?',
    })).toBeInTheDocument();
    expect(dialog.getByText(/uploads\/ or imported\/ object/u))
      .toBeInTheDocument();
    await user.click(dialog.getByRole('button', {
      name: 'Delete file and Media',
    }));
    expect(await screen.findByText(
      'The Media record was deleted. Linked R2 object cleanup is queued for automatic retry.',
    )).toBeInTheDocument();
  });

  it('queues a selected file and completes the two-step managed upload', async () => {
    const managed = {
      ...media,
      kind: 'document' as const,
      filename: 'guide.pdf',
      mime_type: 'application/pdf',
      location: {
        type: 'r2' as const,
        key: `uploads/2026/08/${media.id}.pdf`,
      },
      size_bytes: 8,
      width: null,
      height: null,
      alt: '',
    };
    let listRequests = 0;
    const fetchMock = vi.fn((path: RequestInfo | URL) => {
      if (String(path) === '/api/media/uploads/policy') {
        return Promise.resolve(uploadPolicy());
      }
      if (String(path) === '/api/media/collections') {
        return Promise.resolve(collectionList());
      }
      if (String(path) === '/api/media/uploads') {
        return Promise.resolve(response({
          success: true,
          data: {
            upload_id: '6'.repeat(32),
            expires_at_iso: '2026-08-02T01:15:00.000Z',
            file: {
              filename: 'guide.pdf',
              kind: 'document',
              mime_type: 'application/pdf',
              size_bytes: 8,
              width: null,
              height: null,
              duration_ms: null,
              alt: '',
            },
          },
        }, 201));
      }
      if (String(path).startsWith('/api/media?')) {
        listRequests += 1;
        return Promise.resolve(mediaList(listRequests === 1 ? [] : [managed]));
      }
      throw new Error(`Unexpected fetch: ${String(path)}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    class FakeXmlHttpRequest {
      responseText = JSON.stringify({ success: true, data: managed });
      timeout = 0;
      withCredentials = false;
      private listeners = new Map<string, Array<() => void>>();
      upload = {
        addEventListener: vi.fn((event: string, listener: (value: ProgressEvent) => void) => {
          if (event === 'progress') {
            this.progress = listener;
          }
        }),
      };
      progress?: (value: ProgressEvent) => void;
      open = vi.fn();
      setRequestHeader = vi.fn();
      addEventListener(event: string, listener: () => void) {
        const current = this.listeners.get(event) ?? [];
        current.push(listener);
        this.listeners.set(event, current);
      }
      send(file: File) {
        this.progress?.({
          loaded: file.size,
          total: file.size,
          lengthComputable: true,
        } as ProgressEvent);
        queueMicrotask(() => {
          for (const listener of this.listeners.get('load') ?? []) listener();
        });
      }
      abort() {
        for (const listener of this.listeners.get('abort') ?? []) listener();
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXmlHttpRequest);

    const user = userEvent.setup();
    renderPage();
    await screen.findByRole('heading', { name: 'No Media registered' });
    await user.click(await screen.findByRole('button', { name: 'Upload files' }));
    const file = new File(['%PDF-1.7'], 'guide.pdf', {
      type: 'application/pdf',
    });
    await user.upload(screen.getByLabelText('Choose files'), file);
    await screen.findByText('Ready');
    await user.click(screen.getByRole('button', { name: 'Upload 1 file' }));
    expect(await screen.findByText('Managed files were uploaded.')).toBeInTheDocument();
    expect(await screen.findByRole('button', {
      name: 'View details for guide.pdf',
    })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await chooseMediaAction(user, 'guide.pdf', 'Edit');
    const editDialog = within(screen.getByRole('dialog'));
    expect(editDialog.getByLabelText('Asset type')).toBeDisabled();
    expect(editDialog.getByLabelText('MIME type')).toBeDisabled();
    expect(editDialog.getByLabelText('Size in bytes (optional)')).toBeDisabled();
    expect(screen.getByLabelText(/^R2 object key/u)).toBeDisabled();
  });
});
