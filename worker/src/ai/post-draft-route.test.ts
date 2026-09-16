import { describe, expect, it, vi } from 'vitest';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createPostRoutes } from '../posts/routes';
import { AiPostDraftResponseInvalidError } from './post-draft-service';

const CSRF = 'csrf-token-with-at-least-thirty-two-characters';
const session = {
  user: {
    id: '1'.repeat(32),
    email: 'writer@example.com',
    name: 'Writer',
    roles: ['author'],
  },
  session: { id: '2'.repeat(32) },
  csrfToken: CSRF,
  authRevision: '3'.repeat(32),
  mfaVerifiedAtIso: '2026-08-20T00:00:00.000Z',
} as ResolvedSession;

const candidate = {
  title: 'Generated title',
  excerpt: 'Generated excerpt.',
  content: '<p>Generated body.</p>',
  document_type: 'html' as const,
  editor_mode: 'visual' as const,
  editor_profile: 'tiptap-v1' as const,
};

function environment(input: {
  ai?: Ai;
  rateLimit?: () => Promise<{ success: boolean }>;
} = {}): Env {
  return {
    DB: {} as D1Database,
    KV: {} as KVNamespace,
    AUTH_ROUTE_RATE_LIMITER: {
      limit: vi.fn().mockResolvedValue({ success: true }),
    },
    ...(input.ai ? { AI: input.ai } : {}),
    ...(input.rateLimit ? {
      AI_REQUEST_RATE_LIMITER: { limit: input.rateLimit },
    } : {}),
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
      title: 'Working title',
      brief: 'Write a practical introduction.',
      tone: 'informative',
      length: 'medium',
      document_type: 'html',
      editor_mode: 'visual',
      ...body,
    }),
  });
}

function routes(generateAiPostDraft = vi.fn().mockResolvedValue(candidate)) {
  return createPostRoutes({
    resolveSession: vi.fn().mockResolvedValue(session),
    resolveAccess: vi.fn().mockResolvedValue({
      scope: 'own',
      author: { id: 'Writer', display_name: 'Writer' },
    }),
    generateAiPostDraft,
  });
}

describe('AI Post draft route', () => {
  it('uses the existing contributor boundary and shared user rate limit', async () => {
    const rateLimit = vi.fn().mockResolvedValue({ success: true });
    const generate = vi.fn().mockResolvedValue(candidate);
    const response = await routes(generate).fetch(request(), environment({
      ai: {} as Ai,
      rateLimit,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: candidate });
    expect(rateLimit).toHaveBeenCalledWith({ key: session.user.id });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      source: {
        title: 'Working title',
        brief: 'Write a practical introduction.',
        tone: 'informative',
        length: 'medium',
        documentType: 'html',
        editorMode: 'visual',
      },
    }));
  });

  it('shares one per-user budget with excerpt generation', async () => {
    const rateLimit = vi.fn()
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false });
    const app = routes();
    const env = environment({ ai: {} as Ai, rateLimit });

    const draftResponse = await app.fetch(request(), env);
    expect(draftResponse.status).toBe(200);

    const excerptResponse = await app.fetch(new Request(
      'https://studio.local/ai/excerpt',
      {
        method: 'POST',
        headers: {
          Origin: 'https://studio.local',
          'Content-Type': 'application/json',
          'X-ZeroPress-CSRF': CSRF,
        },
        body: JSON.stringify({
          title: 'Working title',
          content: '<p>Current body.</p>',
          document_type: 'html',
        }),
      },
    ), env);
    expect(excerptResponse.status).toBe(429);
    expect(await excerptResponse.json()).toMatchObject({
      error: { code: 'AI_REQUEST_RATE_LIMITED' },
    });
    expect(rateLimit).toHaveBeenNthCalledWith(1, { key: session.user.id });
    expect(rateLimit).toHaveBeenNthCalledWith(2, { key: session.user.id });
  });

  it('rejects an empty source before consuming AI capacity', async () => {
    const rateLimit = vi.fn().mockResolvedValue({ success: true });
    const generate = vi.fn();
    const response = await routes(generate).fetch(request({
      title: ' ', brief: '\n', tone: 'informative', length: 'medium',
    }), environment({ ai: {} as Ai, rateLimit }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: 'AI_POST_DRAFT_SOURCE_EMPTY' },
    });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects an oversized transport body before parsing or consuming AI capacity', async () => {
    const rateLimit = vi.fn().mockResolvedValue({ success: true });
    const generate = vi.fn();
    const response = await routes(generate).fetch(request({
      title: 'Title',
      brief: 'Brief',
      tone: 'informative',
      length: 'medium',
      padding: 'x'.repeat(33 * 1024),
    }), environment({ ai: {} as Ai, rateLimit }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: 'PAYLOAD_TOO_LARGE' },
    });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('requires a linked Author before consuming AI capacity', async () => {
    const rateLimit = vi.fn().mockResolvedValue({ success: true });
    const app = createPostRoutes({
      resolveSession: vi.fn().mockResolvedValue(session),
      resolveAccess: vi.fn().mockResolvedValue({
        scope: 'unavailable',
        reason: 'author_not_linked',
      }),
    });
    const response = await app.fetch(request(), environment({
      ai: {} as Ai,
      rateLimit,
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: 'POST_AUTHOR_NOT_LINKED' },
    });
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it('maps invalid output without logging authored source or identity', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await routes(vi.fn().mockRejectedValue(
      new AiPostDraftResponseInvalidError(),
    )).fetch(request({
      title: 'Private title',
      brief: 'Private author brief',
      tone: 'professional',
      length: 'long',
    }), environment({
      ai: {} as Ai,
      rateLimit: vi.fn().mockResolvedValue({ success: true }),
    }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: 'AI_POST_DRAFT_RESPONSE_INVALID' },
    });
    const logs = JSON.stringify(consoleSpy.mock.calls);
    expect(logs).not.toContain('Private title');
    expect(logs).not.toContain('Private author brief');
    expect(logs).not.toContain(session.user.id);
  });
});
