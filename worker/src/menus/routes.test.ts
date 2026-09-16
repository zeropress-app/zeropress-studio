import { describe, expect, it, vi } from 'vitest';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createMenuRoutes } from './routes';

const NOW = new Date('2026-08-01T08:00:00.000Z');
const CSRF_TOKEN = 'csrf-token-with-at-least-thirty-two-characters';
const menu = {
  menu_id: 'primary',
  name: 'Primary Menu',
  enabled: true,
  items: [],
  revision: '2'.repeat(32),
  created_at_iso: NOW.toISOString(),
  updated_at_iso: NOW.toISOString(),
};
const footer = { ...menu, menu_id: 'footer', name: 'Footer Menu' };
const custom = { ...menu, menu_id: 'docs', name: 'Docs Menu' };
const saveBody = {
  name: 'Primary Menu',
  enabled: true,
  items: [],
  expected_revision: menu.revision,
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

describe('Menu routes', () => {
  it('resolves one bounded set of typed references without any menu mutation', async () => {
    const references = [
      { kind: 'post', reference_id: '1'.repeat(32) },
      { kind: 'page', reference_id: '2'.repeat(32) },
      { kind: 'tag', reference_id: '3'.repeat(32) },
    ];
    const items = [
      { ...references[0], status: 'available', title: 'Imported Post', detail: 'imported' },
      { ...references[1], status: 'trash' },
      { ...references[2], status: 'missing' },
    ];
    const resolveReferences = vi.fn().mockResolvedValue(items);
    const create = vi.fn();
    const save = vi.fn();
    const routes = createMenuRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      resolveReferences, create, save,
    });
    const response = await routes.fetch(mutationRequest(
      '/link-references', 'POST', { references },
    ), env());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, data: { items } });
    expect(resolveReferences).toHaveBeenCalledWith({ db: expect.anything(), references });
    expect(create).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('protects reference lookup with capability, session, origin, CSRF and request limits', async () => {
    const resolveReferences = vi.fn();
    const resolveSession = vi.fn().mockResolvedValue(editorSession);
    const routes = createMenuRoutes({ resolveSession, resolveReferences });
    const reference = { kind: 'post', reference_id: '1'.repeat(32) };
    const body = { references: [reference] };
    for (const headers of [
      { Origin: 'https://other.example' },
      { 'X-ZeroPress-CSRF': 'incorrect' },
    ] as Array<Record<string, string>>) {
      expect((await routes.fetch(mutationRequest('/link-references', 'POST', body, headers), env())).status)
        .toBe(403);
    }
    resolveSession.mockResolvedValueOnce({
      ...editorSession, user: { ...editorSession.user, roles: ['author'] },
    });
    expect((await routes.fetch(mutationRequest('/link-references', 'POST', body), env())).status).toBe(403);
    resolveSession.mockResolvedValueOnce(null);
    expect((await routes.fetch(mutationRequest('/link-references', 'POST', body), env())).status).toBe(401);
    for (const invalid of [
      { references: [] },
      { references: [reference, reference] },
      { references: [{ kind: 'system', reference_id: '1'.repeat(32) }] },
      { references: Array.from({ length: 501 }, (_, index) => ({
        ...reference, reference_id: index.toString(16).padStart(32, '0'),
      })) },
    ]) {
      expect((await routes.fetch(mutationRequest('/link-references', 'POST', invalid), env())).status)
        .toBe(400);
    }
    expect((await routes.fetch(mutationRequest('/link-references', 'POST', {
      ...body, padding: 'a'.repeat(64_000),
    }), env())).status).toBe(413);
    expect(resolveReferences).not.toHaveBeenCalled();
  });

  it('allows editors, rejects authors, and lists deterministically bounded menus', async () => {
    const list = vi.fn().mockResolvedValue([menu]);
    const routes = createMenuRoutes({
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
      data: { items: [menu] },
    });

    const denied = createMenuRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...editorSession,
        user: { ...editorSession.user, roles: ['author'] },
      }),
      list: vi.fn(),
    });
    expect((await denied.fetch(
      new Request('https://studio.local/'), env(),
    )).status).toBe(403);
  });

  it('leaves an empty database unset on reads', async () => {
    const create = vi.fn();
    const save = vi.fn();
    const routes = createMenuRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      list: vi.fn().mockResolvedValue([]),
      create,
      save,
    });
    const response = await routes.fetch(new Request('https://studio.local/'), env());
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { items: [] },
    });
    expect(create).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it('creates custom menu documents only with same-origin CSRF', async () => {
    const create = vi.fn().mockResolvedValue({ kind: 'completed', menu: custom });
    const routes = createMenuRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      create,
      now: () => NOW,
      createRevision: () => menu.revision,
    });
    const response = await routes.fetch(mutationRequest('/', 'POST', {
      menu_id: 'docs',
      name: '  Docs Menu  ',
    }), env());
    expect(response.status).toBe(201);
    expect(create).toHaveBeenCalledWith({
      db: expect.anything(),
      menuId: 'docs',
      name: 'Docs Menu',
      enabled: true,
      items: [],
      now: NOW,
      createRevision: expect.any(Function),
    });

    expect((await routes.fetch(mutationRequest('/', 'POST', {
      menu_id: 'other',
      name: 'Other Menu',
    }, { Origin: 'https://other.example' }), env())).status).toBe(403);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(['primary', 'footer'])('saves an absent %s with the complete default pair', async (menuId) => {
    const save = vi.fn().mockResolvedValue({ kind: 'completed', menus: [menu, footer] });
    const routes = createMenuRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      save,
      now: () => NOW,
    });
    const response = await routes.fetch(mutationRequest(
      `/${menuId}`,
      'PUT',
      { ...saveBody, name: '  Authored Menu  ', expected_revision: null },
    ), env());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: { items: [menu, footer] },
    });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      menuId,
      name: 'Authored Menu',
      enabled: true,
      items: [],
      expectedRevision: null,
      now: NOW,
    }));
  });

  it('passes the expected revision when saving a stored menu', async () => {
    const save = vi.fn().mockResolvedValue({ kind: 'completed', menus: [custom, menu, footer] });
    const routes = createMenuRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      save,
    });
    const response = await routes.fetch(mutationRequest('/docs', 'PUT', {
      ...saveBody, name: 'Docs Menu',
    }), env());
    expect(response.status).toBe(200);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({
      menuId: 'docs',
      expectedRevision: menu.revision,
    }));
  });

  it('rejects missing revisions, non-default first saves, reserved custom IDs, and unsupported links', async () => {
    const save = vi.fn();
    const create = vi.fn();
    const routes = createMenuRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      save,
      create,
    });
    for (const [path, body] of [
      ['/primary', { name: 'Primary Menu', enabled: true, items: [] }],
      ['/docs', { ...saveBody, expected_revision: null }],
      ['/primary', { ...saveBody, items: [{
        id: '6'.repeat(32),
        title: 'Home',
        link: { kind: 'system', route: 'home' },
        target: '_self',
        children: [],
      }] }],
    ] as const) {
      expect((await routes.fetch(mutationRequest(path, 'PUT', body), env())).status).toBe(400);
    }
    for (const menuId of ['primary', 'footer']) {
      expect((await routes.fetch(mutationRequest('/', 'POST', {
        menu_id: menuId, name: 'Default Menu',
      }), env())).status).toBe(400);
    }
    expect(save).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('guards first saves with the same authorization, origin, CSRF, and body limits as updates', async () => {
    const save = vi.fn();
    const resolveSession = vi.fn().mockResolvedValue(editorSession);
    const routes = createMenuRoutes({ resolveSession, save });
    const body = { ...saveBody, expected_revision: null };
    const rejectedHeaders: Array<Record<string, string>> = [
      { Origin: 'https://other.example' },
      { 'X-ZeroPress-CSRF': 'incorrect' },
    ];
    for (const headers of rejectedHeaders) {
      expect((await routes.fetch(mutationRequest(
        '/primary', 'PUT', body, headers,
      ), env())).status).toBe(403);
    }
    resolveSession.mockResolvedValueOnce({
      ...editorSession,
      user: { ...editorSession.user, roles: ['author'] },
    });
    expect((await routes.fetch(mutationRequest('/primary', 'PUT', body), env())).status).toBe(403);
    resolveSession.mockResolvedValueOnce(null);
    expect((await routes.fetch(mutationRequest('/primary', 'PUT', body), env())).status).toBe(401);
    expect((await routes.fetch(mutationRequest('/primary', 'PUT', {
      ...body, name: 'x'.repeat(1_100_001),
    }), env())).status).toBe(413);
    expect(save).not.toHaveBeenCalled();
  });

  it('maps expected identity, reference, revision, and protection conflicts', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce({ kind: 'id_conflict' })
      .mockResolvedValueOnce({ kind: 'reference_not_found' })
      .mockResolvedValueOnce({ kind: 'limit_reached' });
    const save = vi.fn()
      .mockResolvedValueOnce({ kind: 'revision_conflict' })
      .mockResolvedValueOnce({ kind: 'not_found' })
      .mockResolvedValueOnce({ kind: 'id_conflict' })
      .mockResolvedValueOnce({ kind: 'reference_not_found' })
      .mockResolvedValueOnce({ kind: 'limit_reached' });
    const remove = vi.fn().mockResolvedValue({ kind: 'protected' });
    const routes = createMenuRoutes({
      resolveSession: vi.fn().mockResolvedValue(editorSession),
      create,
      save,
      delete: remove,
    });
    const createBody = { menu_id: 'docs', name: 'Docs Menu' };
    for (const [code, status] of [
      ['MENU_ID_CONFLICT', 409],
      ['MENU_REFERENCE_NOT_FOUND', 409],
      ['MENU_LIMIT_REACHED', 409],
    ] as const) {
      const response = await routes.fetch(
        mutationRequest('/', 'POST', createBody), env(),
      );
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: { code },
      });
    }

    for (const [code, status] of [
      ['MENU_REVISION_CONFLICT', 409],
      ['MENU_NOT_FOUND', 404],
      ['MENU_ID_CONFLICT', 409],
      ['MENU_REFERENCE_NOT_FOUND', 409],
      ['MENU_LIMIT_REACHED', 409],
    ] as const) {
      const response = await routes.fetch(mutationRequest('/primary', 'PUT', saveBody), env());
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ success: false, error: { code } });
    }
    const protectedResponse = await routes.fetch(mutationRequest(
      '/primary', 'DELETE', { expected_revision: menu.revision },
    ), env());
    expect(protectedResponse.status).toBe(409);
    await expect(protectedResponse.json()).resolves.toEqual({
      success: false,
      error: { code: 'MENU_PROTECTED' },
    });
  });
});
