import { describe, expect, it, vi } from 'vitest';
import { createDefaultWidgetAreaDraft } from '../../../contracts/widgets';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createWidgetRoutes } from './routes';

const NOW = new Date('2026-08-01T08:00:00.000Z');
const CSRF_TOKEN = 'csrf-token-with-at-least-thirty-two-characters';
const widgetArea = {
  widget_area_id: 'sidebar',
  name: 'Sidebar Widgets',
  enabled: true,
  items: [],
  revision: '2'.repeat(32),
  created_at_iso: NOW.toISOString(),
  updated_at_iso: NOW.toISOString(),
};

const editorSession = {
  user: {
    id: '3'.repeat(32),
    email: 'editor@example.com',
    name: 'Site Editor',
    roles: ['editor'],
  },
  session: { id: '4'.repeat(32) },
  csrfToken: CSRF_TOKEN,
  authRevision: '5'.repeat(32),
  mfaVerifiedAtIso: NOW.toISOString(),
} as ResolvedSession;

function env(): Env {
  return {
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
  };
}

function mutationRequest(
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`https://studio.local${path}`, {
    method,
    headers: {
      Origin: 'https://studio.local',
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': CSRF_TOKEN,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe('Widget routes', () => {
  it('allows editors, rejects authors, and lists areas', async () => {
    const list = vi.fn().mockResolvedValue([widgetArea]);
    const routes = createWidgetRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      list,
    });
    const response = await routes.fetch(
      new Request('https://studio.local/'),
      env(),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { items: [widgetArea] },
    });

    const denied = createWidgetRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...editorSession,
        user: { ...editorSession.user, roles: ['author'] },
      }),
      list: vi.fn(),
    });
    expect((await denied.fetch(
      new Request('https://studio.local/'),
      env(),
    )).status).toBe(403);
  });

  it('creates only custom empty Widget areas with same-origin CSRF', async () => {
    const create = vi.fn().mockResolvedValue({
      kind: 'completed',
      widgetArea,
    });
    const routes = createWidgetRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      create,
      now: () => NOW,
      createRevision: () => widgetArea.revision,
    });
    const response = await routes.fetch(mutationRequest('/', 'POST', {
      widget_area_id: 'secondary',
      name: '  Secondary  ',
    }), env());
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith({
      db: expect.anything(),
      widgetAreaId: 'secondary',
      name: 'Secondary',
      now: NOW,
      createRevision: expect.any(Function),
    });
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('items');

    expect((await routes.fetch(mutationRequest('/', 'POST', {
      widget_area_id: 'other',
      name: 'Other',
    }, { Origin: 'https://other.example' }), env())).status).toBe(403);
    expect((await routes.fetch(mutationRequest('/', 'POST', {
      widget_area_id: 'sidebar',
      name: 'Sidebar Widgets',
    }), env())).status).toBe(400);
  });

  it('saves the missing virtual sidebar with a null revision', async () => {
    const save = vi.fn().mockResolvedValue({
      kind: 'completed',
      widgetArea,
    });
    const routes = createWidgetRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      save,
      now: () => NOW,
      createRevision: () => '3'.repeat(32),
    });
    const draft = createDefaultWidgetAreaDraft();
    const response = await routes.fetch(mutationRequest(
      '/sidebar',
      'PUT',
      {
        name: draft.name,
        enabled: draft.enabled,
        items: draft.items,
        expected_revision: null,
      },
    ), env());
    expect(response.status).toBe(200);
    expect(save).toHaveBeenCalledWith({
      db: expect.anything(),
      widgetAreaId: 'sidebar',
      name: draft.name,
      enabled: draft.enabled,
      items: draft.items,
      expectedRevision: null,
      now: NOW,
      createRevision: expect.any(Function),
    });

    const custom = await routes.fetch(mutationRequest('/secondary', 'PUT', {
      name: 'Secondary',
      enabled: true,
      items: [],
      expected_revision: null,
    }), env());
    expect(custom.status).toBe(400);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('rejects Image items before repository mutation', async () => {
    const save = vi.fn();
    const routes = createWidgetRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      save,
    });
    const response = await routes.fetch(mutationRequest(
      '/sidebar',
      'PUT',
      {
        name: 'Sidebar Widgets',
        enabled: true,
        items: [{
          id: '1'.repeat(32),
          type: 'image',
          title: 'Image',
          enabled: true,
          settings: { src: '/image.jpg' },
        }],
        expected_revision: widgetArea.revision,
      },
    ), env());
    expect(response.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it('maps identity, revision, Author, limit, and protection conflicts', async () => {
    const save = vi.fn()
      .mockResolvedValueOnce({ kind: 'id_conflict' })
      .mockResolvedValueOnce({ kind: 'revision_conflict' })
      .mockResolvedValueOnce({ kind: 'author_not_found' })
      .mockResolvedValueOnce({ kind: 'limit_reached' });
    const remove = vi.fn().mockResolvedValue({ kind: 'protected' });
    const routes = createWidgetRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      save,
      delete: remove,
    });
    const updateBody = {
      name: 'Sidebar Widgets',
      enabled: true,
      items: [],
      expected_revision: widgetArea.revision,
    };
    for (const code of [
      'WIDGET_AREA_ID_CONFLICT',
      'WIDGET_AREA_REVISION_CONFLICT',
      'WIDGET_AUTHOR_NOT_FOUND',
      'WIDGET_AREA_LIMIT_REACHED',
    ] as const) {
      const response = await routes.fetch(mutationRequest(
        '/sidebar', 'PUT', updateBody,
      ), env());
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: { code },
      });
    }
    const deleted = await routes.fetch(mutationRequest(
      '/sidebar',
      'DELETE',
      { expected_revision: widgetArea.revision },
    ), env());
    expect(deleted.status).toBe(409);
    await expect(deleted.json()).resolves.toEqual({
      success: false,
      error: { code: 'WIDGET_AREA_PROTECTED' },
    });
  });

  it('lists bounded Author options through a static route', async () => {
    const listAuthorOptions = vi.fn().mockResolvedValue([{
      id: 'Owner',
      display_name: 'Studio Owner',
    }]);
    const routes = createWidgetRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      listAuthorOptions,
    });
    const response = await routes.fetch(new Request(
      'https://studio.local/author-options?search=Owner',
    ), env());
    expect(response.status).toBe(200);
    expect(listAuthorOptions).toHaveBeenCalledWith({
      db: expect.anything(),
      search: 'Owner',
    });
  });
});
