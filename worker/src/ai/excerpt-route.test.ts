import { describe, expect, it, vi } from 'vitest';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createPostRoutes } from '../posts/routes';
import { createPageRoutes } from '../pages/routes';
import { AiExcerptResponseInvalidError } from './excerpt-service';

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

function request(body: unknown = {
  title: 'Title',
  content: '<p>Visible body.</p>',
  document_type: 'html',
}) {
  return new Request('https://studio.local/ai/excerpt', {
    method: 'POST',
    headers: {
      Origin: 'https://studio.local',
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': CSRF,
    },
    body: JSON.stringify(body),
  });
}

describe('AI excerpt routes', () => {
  it('allows a linked Post contributor and uses the dedicated user limiter', async () => {
    const rateLimit = vi.fn().mockResolvedValue({ success: true });
    const generate = vi.fn().mockResolvedValue({
      excerpt: 'Generated excerpt.',
      sourceTruncated: false,
    });
    const routes = createPostRoutes({
      resolveSession: vi.fn().mockResolvedValue(session),
      resolveAccess: vi.fn().mockResolvedValue({
        scope: 'own',
        author: { id: 'Writer', display_name: 'Writer' },
      }),
      generateAiExcerpt: generate,
    });
    const response = await routes.fetch(request(), environment({
      ai: {} as Ai,
      rateLimit,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { excerpt: 'Generated excerpt.', source_truncated: false },
    });
    expect(rateLimit).toHaveBeenCalledWith({ key: session.user.id });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      ai: expect.anything(),
      source: {
        title: 'Title',
        contentPlainText: 'Visible body.',
        sourceTruncated: false,
      },
    }));
  });

  it('requires a linked author before consuming Post AI capacity', async () => {
    const rateLimit = vi.fn().mockResolvedValue({ success: true });
    const routes = createPostRoutes({
      resolveSession: vi.fn().mockResolvedValue(session),
      resolveAccess: vi.fn().mockResolvedValue({
        scope: 'unavailable',
        reason: 'author_not_linked',
      }),
    });
    const response = await routes.fetch(request(), environment({
      ai: {} as Ai,
      rateLimit,
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      error: { code: 'POST_AUTHOR_NOT_LINKED' },
    });
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it('applies Page management authorization and the same response contract', async () => {
    const routes = createPageRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...session,
        user: { ...session.user, roles: ['editor'] },
      }),
      generateAiExcerpt: vi.fn().mockResolvedValue({
        excerpt: 'Page excerpt.',
        sourceTruncated: true,
      }),
    });
    const response = await routes.fetch(request(), environment({
      ai: {} as Ai,
      rateLimit: vi.fn().mockResolvedValue({ success: true }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: { excerpt: 'Page excerpt.', source_truncated: true },
    });
  });

  it('fails closed when the binding or limiter is unavailable', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const routes = createPageRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...session,
        user: { ...session.user, roles: ['editor'] },
      }),
    });
    const missingAi = await routes.fetch(request(), environment({
      rateLimit: vi.fn().mockResolvedValue({ success: true }),
    }));
    expect(missingAi.status).toBe(503);
    expect(await missingAi.json()).toMatchObject({
      error: { code: 'AI_SERVICE_UNAVAILABLE' },
    });

    const missingLimiter = await routes.fetch(request(), environment({
      ai: {} as Ai,
    }));
    expect(missingLimiter.status).toBe(503);
    expect(consoleSpy).toHaveBeenCalledTimes(2);
  });

  it('returns a bounded client error without calling the provider', async () => {
    const generate = vi.fn();
    const routes = createPageRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...session,
        user: { ...session.user, roles: ['editor'] },
      }),
      generateAiExcerpt: generate,
    });
    const limited = await routes.fetch(request(), environment({
      ai: {} as Ai,
      rateLimit: vi.fn().mockResolvedValue({ success: false }),
    }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({
      error: { code: 'AI_REQUEST_RATE_LIMITED' },
    });
    expect(generate).not.toHaveBeenCalled();
  });

  it('rejects an empty visible source before consuming rate or provider work', async () => {
    const rateLimit = vi.fn().mockResolvedValue({ success: true });
    const generate = vi.fn();
    const routes = createPageRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...session,
        user: { ...session.user, roles: ['editor'] },
      }),
      generateAiExcerpt: generate,
    });
    const response = await routes.fetch(request({
      title: ' ',
      content: '<script>hidden()</script>',
      document_type: 'html',
    }), environment({ ai: {} as Ai, rateLimit }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'AI_EXCERPT_SOURCE_EMPTY' },
    });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(generate).not.toHaveBeenCalled();
  });

  it('maps invalid model output without logging authored source', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const routes = createPageRoutes({
      resolveSession: vi.fn().mockResolvedValue({
        ...session,
        user: { ...session.user, roles: ['editor'] },
      }),
      generateAiExcerpt: vi.fn().mockRejectedValue(
        new AiExcerptResponseInvalidError(),
      ),
    });
    const response = await routes.fetch(request(), environment({
      ai: {} as Ai,
      rateLimit: vi.fn().mockResolvedValue({ success: true }),
    }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: 'AI_EXCERPT_RESPONSE_INVALID' },
    });
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain('Visible body');
    expect(JSON.stringify(consoleSpy.mock.calls)).not.toContain(session.user.id);
  });
});
