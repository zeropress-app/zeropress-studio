import { describe, expect, it, vi } from 'vitest';
import type { ResolvedSession } from '../auth/session-repository';
import type { Env } from '../types';
import { createPostRoutes } from '../posts/routes';
import type { Post } from '../../../contracts/posts';
import type { GenerateAiPostEdit } from './post-edit-route';
import { AiPostEditResponseInvalidError } from './post-edit-service';

const CSRF = 'csrf-token-with-at-least-thirty-two-characters';
const POST_ID = '1'.repeat(32);
const REVISION = '5'.repeat(32);
const session = {
  user: {
    id: '2'.repeat(32),
    email: 'writer@example.com',
    name: 'Writer',
    roles: ['author'],
  },
  session: { id: '3'.repeat(32) },
  csrfToken: CSRF,
  authRevision: '4'.repeat(32),
  mfaVerifiedAtIso: '2026-08-20T00:00:00.000Z',
} as ResolvedSession;

const post: Post = {
  id: POST_ID,
  public_id: 100_000_000_001,
  title: 'Current Post',
  slug: 'current-post',
  content: '<p>Current body.</p>',
  document_type: 'html' as const,
  editor_mode: 'visual' as const,
  editor_profile: 'tiptap-v1' as const,
  excerpt: '',
  status: 'draft' as const,
  author: { id: 'Writer', display_name: 'Writer' },
  categories: [],
  tags: [],
  discoverability: 'default' as const,
  allow_comments: true,
  featured_image: null,
  published_at_iso: null,
  revision: REVISION,
  created_at_iso: '2026-08-20T00:00:00.000Z',
  updated_at_iso: '2026-08-20T00:00:00.000Z',
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

function request(input: Record<string, unknown> = {}) {
  return new Request(`https://studio.local/${POST_ID}/ai/edit`, {
    method: 'POST',
    headers: {
      Origin: 'https://studio.local',
      'Content-Type': 'application/json',
      'X-ZeroPress-CSRF': CSRF,
    },
    body: JSON.stringify({
      expected_revision: REVISION,
      operation: 'rewrite',
      instruction: 'Make it more direct.',
      tone: 'preserve',
      target: { document_type: 'html', editor_mode: 'visual' },
      selection: {
        kind: 'block',
        source: '<p>Current body.</p>',
        context_before: '',
        context_after: '',
      },
      ...input,
    }),
  });
}

function routes(input: {
  currentPost?: Post;
  generate?: GenerateAiPostEdit;
} = {}) {
  return createPostRoutes({
    resolveSession: vi.fn().mockResolvedValue(session),
    resolveAccess: vi.fn().mockResolvedValue({
      scope: 'own',
      author: post.author,
    }),
    getPost: vi.fn().mockResolvedValue(input.currentPost ?? post),
    generateAiPostEdit: input.generate
      ?? vi.fn<GenerateAiPostEdit>().mockResolvedValue('<p>Clear body.</p>'),
  });
}

describe('AI Post edit route', () => {
  it('checks the current Post revision and shares the authored AI quota', async () => {
    const rateLimit = vi.fn().mockResolvedValue({ success: true });
    const generate = vi.fn<GenerateAiPostEdit>()
      .mockResolvedValue('<p>Clear body.</p>');
    const response = await routes({ generate }).fetch(request(), environment({
      ai: {} as Ai,
      rateLimit,
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { replacement: '<p>Clear body.</p>' },
    });
    expect(rateLimit).toHaveBeenCalledWith({ key: session.user.id });
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({
        selectedSource: '<p>Current body.</p>',
        selectedPlainText: 'Current body.',
      }),
    }));
  });

  it('rejects stale and trashed Posts before consuming AI capacity', async () => {
    const rateLimit = vi.fn().mockResolvedValue({ success: true });
    const env = environment({ ai: {} as Ai, rateLimit });
    const stale = await routes().fetch(request({
      expected_revision: '9'.repeat(32),
    }), env);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: { code: 'POST_REVISION_CONFLICT' },
    });
    const trashed = await routes({
      currentPost: { ...post, status: 'trash' },
    }).fetch(request(), env);
    expect(trashed.status).toBe(409);
    expect(await trashed.json()).toMatchObject({
      error: { code: 'AI_POST_EDIT_UNAVAILABLE' },
    });
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it('rejects protected selections before consuming AI capacity', async () => {
    const rateLimit = vi.fn().mockResolvedValue({ success: true });
    const response = await routes().fetch(request({
      selection: {
        kind: 'block',
        source: '<figure><img src="/private.png"></figure>',
        context_before: '',
        context_after: '',
      },
    }), environment({ ai: {} as Ai, rateLimit }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'AI_POST_EDIT_SELECTION_UNSUPPORTED' },
    });
    expect(rateLimit).not.toHaveBeenCalled();
  });

  it('does not log selected source, output, or user identity on invalid output', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await routes({
      generate: vi.fn<GenerateAiPostEdit>()
        .mockRejectedValue(new AiPostEditResponseInvalidError()),
    }).fetch(request({
      selection: {
        kind: 'block',
        source: '<p>Private selected source.</p>',
        context_before: 'Private context.',
        context_after: '',
      },
    }), environment({
      ai: {} as Ai,
      rateLimit: vi.fn().mockResolvedValue({ success: true }),
    }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({
      error: { code: 'AI_POST_EDIT_RESPONSE_INVALID' },
    });
    const logs = JSON.stringify(consoleSpy.mock.calls);
    expect(logs).not.toContain('Private selected source');
    expect(logs).not.toContain('Private context');
    expect(logs).not.toContain(session.user.id);
  });
});
