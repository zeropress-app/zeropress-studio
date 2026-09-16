import { describe, expect, it, vi } from 'vitest';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createPageRoutes } from '../pages/routes';
import { AiPageDraftResponseInvalidError } from './page-draft-service';

const CSRF = 'csrf-token-with-at-least-thirty-two-characters';
const session = {
  user: {
    id: '1'.repeat(32),
    email: 'editor@example.com',
    name: 'Editor',
    roles: ['editor'],
  },
  session: { id: '2'.repeat(32) },
  csrfToken: CSRF,
  authRevision: '3'.repeat(32),
  mfaVerifiedAtIso: '2026-08-21T00:00:00.000Z',
} as ResolvedSession;

const candidate = {
  title: 'Generated Page',
  excerpt: 'Generated Page excerpt.',
  content: '<p>Generated body.</p>',
  document_type: 'html' as const,
  editor_mode: 'visual' as const,
  editor_profile: 'tiptap-v1' as const,
};

function environment(rateLimit = vi.fn().mockResolvedValue({ success: true })): Env {
  return {
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    AI: {} as Ai,
    AI_REQUEST_RATE_LIMITER: { limit: rateLimit },
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
  };
}

function request(body: Record<string, unknown> = {}) {
  return new Request('https://studio.local/ai/draft', {
    method: 'POST',
    headers: {
      Origin: 'https://studio.local',
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': CSRF,
    },
    body: JSON.stringify({
      title: 'About',
      brief: 'Explain the supplied purpose.',
      preset: 'about',
      tone: 'professional',
      length: 'medium',
      document_type: 'html',
      editor_mode: 'visual',
      ...body,
    }),
  });
}

function routes(generateAiPageDraft = vi.fn().mockResolvedValue(candidate)) {
  return createPageRoutes({
    resolveSession: vi.fn().mockResolvedValue(session),
    generateAiPageDraft,
  });
}

describe('AI Page draft route', () => {
  it('requires Page management and shares the authored-text user quota', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    const generate = vi.fn().mockResolvedValue(candidate);
    const response = await routes(generate).fetch(request(), environment(limit));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: candidate });
    expect(limit).toHaveBeenCalledWith({ key: session.user.id });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({
        title: 'About',
        brief: 'Explain the supplied purpose.',
        preset: 'about',
        documentType: 'html',
        editorMode: 'visual',
      }),
    }));

    const authorRoutes = createPageRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...session,
        user: { ...session.user, roles: ['author'] },
      }),
    });
    expect((await authorRoutes.fetch(request(), environment())).status).toBe(403);
  });

  it('rejects an incomplete policy source before consuming capacity', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    const generate = vi.fn();
    const response = await routes(generate).fetch(request({
      preset: 'policy_outline',
      title: 'Privacy policy',
      brief: ' ',
    }), environment(limit));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: 'AI_PAGE_DRAFT_SOURCE_EMPTY' },
    });
    expect(limit).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('enforces the 32 KiB transport boundary before authorization or AI capacity', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    const generate = vi.fn();
    const response = await routes(generate).fetch(request({
      padding: 'x'.repeat(33 * 1024),
    }), environment(limit));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: 'PAYLOAD_TOO_LARGE' },
    });
    expect(limit).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('maps an invalid response without logging authored source or identity', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await routes(vi.fn().mockRejectedValue(
      new AiPageDraftResponseInvalidError(),
    )).fetch(request({
      title: 'Private title',
      brief: 'Private Page instructions',
      preset: 'landing',
    }), environment());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: 'AI_PAGE_DRAFT_RESPONSE_INVALID' },
    });
    const logs = JSON.stringify(consoleSpy.mock.calls);
    expect(logs).not.toContain('Private title');
    expect(logs).not.toContain('Private Page instructions');
    expect(logs).not.toContain(session.user.id);
  });
});
