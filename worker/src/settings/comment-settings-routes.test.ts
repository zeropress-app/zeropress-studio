import { describe, expect, it, vi } from 'vitest';
import { COMMENT_SETTINGS_DEFAULTS } from '../../../contracts/comment-settings';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import {
  createCommentSettingsRoutes as createCommentSettingsRoutesImpl,
} from './comment-settings-routes';

function createCommentSettingsRoutes(
  dependencies: Parameters<typeof createCommentSettingsRoutesImpl>[0],
) {
  return createCommentSettingsRoutesImpl({
    ...dependencies,
    readEdgeIntegrationMode: vi.fn().mockResolvedValue('enabled'),
    inspectEdgeDatabaseRuntime: vi.fn().mockResolvedValue({
      state: 'ready', reason: 'ready', currentSchemaVersion: 3,
    }),
  });
}

const NOW = new Date('2026-08-02T01:00:00.000Z');
const CSRF_TOKEN = 'csrf-token-with-at-least-thirty-two-characters';
const REVISION = '1'.repeat(32);
const administratorSession = {
  user: {
    id: '2'.repeat(32),
    email: 'owner@example.com',
    name: 'Studio Owner',
    roles: ['admin'],
  },
  session: { id: '3'.repeat(32) },
  csrfToken: CSRF_TOKEN,
  authRevision: '4'.repeat(32),
  mfaVerifiedAtIso: NOW.toISOString(),
} as ResolvedSession;
const document = {
  settings: {
    ...COMMENT_SETTINGS_DEFAULTS,
    threading: { ...COMMENT_SETTINGS_DEFAULTS.threading },
  },
  revision: REVISION,
  updated_at_iso: null,
};
const requestSecurity = {
  status: 'valid' as const,
  revision: '6'.repeat(32),
  current_key: {
    kid: 'k_AAAAAAAAAAAAAAAAAAAAAA',
    created_at_iso: '2026-08-02T00:00:00Z',
  },
  previous_keys: { total_count: 1, active_count: 1 },
};

function env(): Env {
  return {
    DB: {} as D1Database,
    EDGE_DB: {} as D1Database,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
  };
}

function mutationRequest(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(`https://studio.local${path}`, {
    method: path === '/' ? 'PUT' : 'POST',
    headers: {
      Origin: 'https://studio.local',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      'X-ZeroPress-CSRF': CSRF_TOKEN,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('Comment settings routes', () => {
  it('lets any authenticated editor read non-secret runtime state', async () => {
    const readSettings = vi.fn().mockResolvedValue(document);
    const routes = createCommentSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...administratorSession,
        user: { ...administratorSession.user, roles: ['editor'] },
      }),
      readSettings,
    });
    const response = await routes.fetch(
      new Request('https://studio.local/'),
      env(),
    );
    expect(response.status).toBe(200);
    expect(readSettings).toHaveBeenCalledWith({ edgeDb: expect.anything() });
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: document,
    });
  });

  it('writes a complete normalized ZeroPress settings document for an administrator', async () => {
    const settings = {
      ...document.settings,
      api_base_url: 'https://edge.example.com/api',
      auth: {
        enabled: true,
        provider: 'supabase' as const,
        project_url: 'https://example.supabase.co',
        publishable_key:
          'sb_publishable_example-key-with-enough-length',
      },
    };
    const nextDocument = {
      settings,
      revision: '5'.repeat(32),
      updated_at_iso: '2026-08-02T01:00:00Z',
    };
    const updateSettings = vi.fn().mockResolvedValue({
      kind: 'completed',
      document: nextDocument,
    });
    const routes = createCommentSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateSettings,
      now: () => NOW,
    });
    const response = await routes.fetch(mutationRequest('/', {
      settings: {
        ...settings,
        api_base_url: 'https://edge.example.com/api/',
        auth: {
          ...settings.auth,
          project_url: ' https://Example.Supabase.co/ ',
          publishable_key:
            ' sb_publishable_example-key-with-enough-length ',
        },
      },
      expected_revision: REVISION,
    }), env());
    expect(response.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      edgeDb: expect.anything(),
      settings,
      expectedRevision: REVISION,
      now: NOW,
    });
  });

  it('requires settings.manage, exact same-origin, and the session CSRF token', async () => {
    const updateSettings = vi.fn();
    const editorRoutes = createCommentSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...administratorSession,
        user: { ...administratorSession.user, roles: ['editor'] },
      }),
      updateSettings,
    });
    const body = {
      settings: document.settings,
      expected_revision: REVISION,
    };
    expect((await editorRoutes.fetch(mutationRequest('/', body), env())).status)
      .toBe(403);

    const administratorRoutes = createCommentSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      updateSettings,
    });
    expect((await administratorRoutes.fetch(mutationRequest('/', body, {
      Origin: 'https://other.example',
    }), env())).status).toBe(403);
    expect((await administratorRoutes.fetch(mutationRequest('/', body, {
      'X-ZeroPress-CSRF': 'wrong-token',
    }), env())).status).toBe(403);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it('exposes secret-free request-security status only to a settings manager', async () => {
    const readRequestSecurity = vi.fn().mockResolvedValue(requestSecurity);
    const routes = createCommentSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      readRequestSecurity,
      now: () => NOW,
    });
    const response = await routes.fetch(
      new Request('https://studio.local/request-security'),
      env(),
    );
    expect(response.status).toBe(200);
    expect(readRequestSecurity).toHaveBeenCalledWith({
      edgeDb: expect.anything(),
      now: NOW,
    });
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: requestSecurity,
    });

    const editorRoutes = createCommentSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...administratorSession,
        user: { ...administratorSession.user, roles: ['editor'] },
      }),
      readRequestSecurity,
    });
    expect((await editorRoutes.fetch(
      new Request('https://studio.local/request-security'),
      env(),
    )).status).toBe(403);
  });

  it('rotates and resets request security through revisioned CSRF mutations', async () => {
    const rotateRequestSecurity = vi.fn().mockResolvedValue({
      kind: 'completed',
      resource: requestSecurity,
    });
    const resetRequestSecurity = vi.fn().mockResolvedValue({
      kind: 'revision_conflict',
    });
    const routes = createCommentSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      rotateRequestSecurity,
      resetRequestSecurity,
      now: () => NOW,
    });
    const body = { expected_revision: requestSecurity.revision };
    const rotateResponse = await routes.fetch(
      mutationRequest('/request-security/rotate', body),
      env(),
    );
    expect(rotateResponse.status).toBe(200);
    expect(rotateRequestSecurity).toHaveBeenCalledWith({
      edgeDb: expect.anything(),
      expectedRevision: requestSecurity.revision,
      now: NOW,
    });

    const resetResponse = await routes.fetch(
      mutationRequest('/request-security/reset', body),
      env(),
    );
    expect(resetResponse.status).toBe(409);
    await expect(resetResponse.json()).resolves.toEqual({
      success: false,
      error: { code: 'COMMENT_REQUEST_SECURITY_REVISION_CONFLICT' },
    });
  });

  it('protects request-security mutations with manager, origin, and CSRF boundaries', async () => {
    const rotateRequestSecurity = vi.fn();
    const body = { expected_revision: requestSecurity.revision };
    const editorRoutes = createCommentSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...administratorSession,
        user: { ...administratorSession.user, roles: ['editor'] },
      }),
      rotateRequestSecurity,
    });
    expect((await editorRoutes.fetch(
      mutationRequest('/request-security/rotate', body),
      env(),
    )).status).toBe(403);

    const administratorRoutes = createCommentSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      rotateRequestSecurity,
    });
    expect((await administratorRoutes.fetch(
      mutationRequest('/request-security/rotate', body, {
        Origin: 'https://other.example',
      }),
      env(),
    )).status).toBe(403);
    expect((await administratorRoutes.fetch(
      mutationRequest('/request-security/rotate', body, {
        'X-ZeroPress-CSRF': 'wrong-token',
      }),
      env(),
    )).status).toBe(403);
    expect(rotateRequestSecurity).not.toHaveBeenCalled();
  });

  it('classifies a missing or invalid keyset as not rotatable', async () => {
    const routes = createCommentSettingsRoutes({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      rotateRequestSecurity: vi.fn().mockResolvedValue({
        kind: 'not_rotatable',
      }),
    });
    const response = await routes.fetch(
      mutationRequest('/request-security/rotate', {
        expected_revision: requestSecurity.revision,
      }),
      env(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'COMMENT_REQUEST_SECURITY_NOT_ROTATABLE' },
    });
  });

  it('does not read Comment settings while Edge integration is disabled', async () => {
    const readSettings = vi.fn();
    const routes = createCommentSettingsRoutesImpl({
      resolveSession: vi.fn().mockResolvedValue(administratorSession),
      readEdgeIntegrationMode: vi.fn().mockResolvedValue('disabled'),
      readSettings,
    });
    const response = await routes.fetch(
      new Request('https://studio.local/'), env(),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: { code: 'EDGE_INTEGRATION_DISABLED' },
    });
    expect(readSettings).not.toHaveBeenCalled();
  });
});
