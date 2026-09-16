import { describe, expect, it, vi } from 'vitest';
import { StudioOperationalError } from '../lib/operational-error';
import {
  readDashboardEdgeOverview,
  readDashboardStudioOverview,
} from './repository';

function d1(row: Record<string, unknown> | null): D1Database {
  return {
    prepare: vi.fn((sql: string) => ({
      sql,
      first: vi.fn().mockResolvedValue(row),
    })),
  } as unknown as D1Database;
}

describe('Dashboard repositories', () => {
  it('reads one Studio aggregate row and validates totals', async () => {
    const db = d1({
      posts_total: 3, posts_draft: 1, posts_published: 2, posts_trash: 0,
      media_total: 2, media_managed: 1, media_external: 1,
    });
    await expect(readDashboardStudioOverview({
      db,
      permissions: { posts: true, pages: false, media: true },
    })).resolves.toEqual({
      posts: {
        access: { scope: 'all' },
        total: 3,
        draft: 1,
        published: 2,
        trash: 0,
      },
      pages: null,
      media: { total: 2, managed: 1, external: 1 },
    });
    expect(db.prepare).toHaveBeenCalledOnce();
  });

  it('does not touch Studio D1 when no content domain is authorized', async () => {
    const db = d1(null);
    await expect(readDashboardStudioOverview({
      db,
      permissions: { posts: false, pages: false, media: false },
    })).resolves.toEqual({ posts: null, pages: null, media: null });
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('binds the linked Author ID into Post dashboard counts', async () => {
    const first = vi.fn().mockResolvedValue({
      posts_total: 2,
      posts_draft: 1,
      posts_published: 1,
      posts_trash: 0,
    });
    const bind = vi.fn().mockReturnValue({ first });
    const db = {
      prepare: vi.fn().mockReturnValue({ bind }),
    } as unknown as D1Database;
    await expect(readDashboardStudioOverview({
      db,
      permissions: { posts: true, pages: false, media: false },
      postAccess: {
        scope: 'own',
        author: { id: 'site-author', display_name: 'Site Author' },
      },
      postAuthorId: 'site-author',
    })).resolves.toEqual({
      posts: {
        access: {
          scope: 'own',
          author: { id: 'site-author', display_name: 'Site Author' },
        },
        total: 2,
        draft: 1,
        published: 1,
        trash: 0,
      },
      pages: null,
      media: null,
    });
    expect(bind).toHaveBeenCalledWith('site-author');
    expect(String((db.prepare as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]))
      .toContain('WHERE author_id = ?');
  });

  it('materializes Edge attention and readiness from one row', async () => {
    const edgeDb = d1({
      comments_pending: 2,
      comments_enabled: 1, comments_api_base_url: 'https://edge.example/api',
      form_submissions_unread: 3,
      subscriptions_pending: 2,
      newsletter_confirmation_enabled: 1,
    });
    await expect(readDashboardEdgeOverview({
      edgeDb,
      permissions: { comments: true, forms: true, newsletters: true },
      mailConfigured: true,
    })).resolves.toMatchObject({
      status: 'available',
      comments: { pending: 2, enabled: true, api_configured: true },
      forms: { unread_submissions: 3 },
      newsletters: { pending_confirmations: 2, confirmation_ready: true },
    });
    expect(edgeDb.prepare).toHaveBeenCalledOnce();
    const sql = String(
      (edgeDb.prepare as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
    );
    expect(sql).toMatch(/FROM comments\s+WHERE status = 'pending'/u);
    expect(sql).toMatch(/FROM form_submissions\s+WHERE status = 'unread'/u);
    expect(sql).toMatch(
      /FROM newsletter_subscriptions\s+WHERE status = 'pending'/u,
    );
    expect(sql).not.toContain('FROM forms');
    expect(sql).not.toContain('FROM newsletter_lists');
    expect(sql).not.toContain('COUNT(*) AS total');
  });

  it('classifies malformed Edge rows and missing binding', async () => {
    await expect(readDashboardEdgeOverview({
      edgeDb: d1({ comments_pending: 0, comments_enabled: 2, comments_api_base_url: null }),
      permissions: { comments: true, forms: false, newsletters: false },
      mailConfigured: false,
    })).rejects.toMatchObject({ code: 'DASHBOARD_EDGE_DATA_INVALID' } satisfies Partial<StudioOperationalError>);
    await expect(readDashboardEdgeOverview({
      edgeDb: undefined,
      permissions: { comments: true, forms: false, newsletters: false },
      mailConfigured: false,
    })).rejects.toMatchObject({ code: 'DASHBOARD_EDGE_DATABASE_NOT_CONFIGURED' } satisfies Partial<StudioOperationalError>);
  });
});
