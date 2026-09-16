import type {
  DashboardContent,
  DashboardEdgeAvailable,
} from '../../../contracts/dashboard';
import type { PostAccess } from '../../../contracts/posts';
import { normalizeCommentApiBaseUrl } from '../../../contracts/comment-settings';
import { StudioOperationalError } from '../lib/operational-error';

export type DashboardPermissions = {
  posts: boolean;
  pages: boolean;
  media: boolean;
  comments: boolean;
  forms: boolean;
  newsletters: boolean;
  mail: boolean;
};

type DashboardRow = Record<string, unknown>;

function studioQueryFailure(error: unknown) {
  return new StudioOperationalError('DASHBOARD_STUDIO_DATABASE_QUERY_FAILED', {
    cause: error,
    metadata: { resource: 'DB', action: 'read_dashboard_studio_overview' },
  });
}

function studioDataInvalid(cause?: unknown) {
  return new StudioOperationalError('DASHBOARD_STUDIO_DATA_INVALID', {
    cause,
    metadata: { resource: 'DB', action: 'validate_dashboard_studio_overview' },
  });
}

function edgeQueryFailure(error: unknown) {
  return new StudioOperationalError('DASHBOARD_EDGE_DATABASE_QUERY_FAILED', {
    cause: error,
    metadata: { resource: 'EDGE_DB', action: 'read_dashboard_edge_overview' },
  });
}

function edgeDataInvalid(cause?: unknown) {
  return new StudioOperationalError('DASHBOARD_EDGE_DATA_INVALID', {
    cause,
    metadata: { resource: 'EDGE_DB', action: 'validate_dashboard_edge_overview' },
  });
}

function count(
  row: DashboardRow,
  key: string,
  invalid: (cause?: unknown) => StudioOperationalError,
): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw invalid(new TypeError(`Dashboard count ${key} is invalid.`));
  }
  return Number(value);
}

function sqlBoolean(
  row: DashboardRow,
  key: string,
  invalid: (cause?: unknown) => StudioOperationalError,
): boolean {
  const value = row[key];
  if (value !== 0 && value !== 1) {
    throw invalid(new TypeError(`Dashboard boolean ${key} is invalid.`));
  }
  return value === 1;
}

export async function readDashboardStudioOverview(input: {
  db: D1Database;
  permissions: Pick<DashboardPermissions, 'posts' | 'pages' | 'media'>;
  postAccess?: PostAccess;
  postAuthorId?: string | null;
}): Promise<DashboardContent> {
  const columns: string[] = [];
  const sources: string[] = [];
  const params: unknown[] = [];

  if (input.permissions.posts) {
    columns.push(
      'post_counts.total AS posts_total',
      'post_counts.draft AS posts_draft',
      'post_counts.published AS posts_published',
      'post_counts.trash AS posts_trash',
    );
    const postFilter = input.postAuthorId === null
      ? 'WHERE 0 = 1'
      : input.postAuthorId === undefined
        ? ''
        : 'WHERE author_id = ?';
    if (typeof input.postAuthorId === 'string') {
      params.push(input.postAuthorId);
    }
    sources.push(`(
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END), 0) AS draft,
        COALESCE(SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END), 0) AS published,
        COALESCE(SUM(CASE WHEN status = 'trash' THEN 1 ELSE 0 END), 0) AS trash
      FROM posts
      ${postFilter}
    ) AS post_counts`);
  }

  if (input.permissions.pages) {
    columns.push(
      'page_counts.total AS pages_total',
      'page_counts.draft AS pages_draft',
      'page_counts.published AS pages_published',
      'page_counts.trash AS pages_trash',
    );
    sources.push(`(
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END), 0) AS draft,
        COALESCE(SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END), 0) AS published,
        COALESCE(SUM(CASE WHEN status = 'trash' THEN 1 ELSE 0 END), 0) AS trash
      FROM pages
    ) AS page_counts`);
  }

  if (input.permissions.media) {
    columns.push(
      'media_counts.total AS media_total',
      'media_counts.managed AS media_managed',
      'media_counts.external AS media_external',
    );
    sources.push(`(
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN storage_type = 'r2' THEN 1 ELSE 0 END), 0) AS managed,
        COALESCE(SUM(CASE WHEN storage_type = 'external' THEN 1 ELSE 0 END), 0) AS external
      FROM media
    ) AS media_counts`);
  }

  if (columns.length === 0) {
    return { posts: null, pages: null, media: null };
  }

  let row: DashboardRow | null;
  try {
    const statement = input.db.prepare(`
      SELECT ${columns.join(',\n')}
      FROM ${sources.join('\nCROSS JOIN ')}
    `);
    row = params.length > 0
      ? await statement.bind(...params).first<DashboardRow>()
      : await statement.first<DashboardRow>();
  } catch (error) {
    throw studioQueryFailure(error);
  }
  if (!row) throw studioDataInvalid();

  return {
    posts: input.permissions.posts ? {
      access: input.postAccess ?? { scope: 'all' },
      total: count(row, 'posts_total', studioDataInvalid),
      draft: count(row, 'posts_draft', studioDataInvalid),
      published: count(row, 'posts_published', studioDataInvalid),
      trash: count(row, 'posts_trash', studioDataInvalid),
    } : null,
    pages: input.permissions.pages ? {
      total: count(row, 'pages_total', studioDataInvalid),
      draft: count(row, 'pages_draft', studioDataInvalid),
      published: count(row, 'pages_published', studioDataInvalid),
      trash: count(row, 'pages_trash', studioDataInvalid),
    } : null,
    media: input.permissions.media ? {
      total: count(row, 'media_total', studioDataInvalid),
      managed: count(row, 'media_managed', studioDataInvalid),
      external: count(row, 'media_external', studioDataInvalid),
    } : null,
  };
}

export async function readDashboardEdgeOverview(input: {
  edgeDb: D1Database | undefined;
  permissions: Pick<
    DashboardPermissions,
    'comments' | 'forms' | 'newsletters'
  >;
  mailConfigured: boolean;
}): Promise<DashboardEdgeAvailable> {
  if (!input.edgeDb) {
    throw new StudioOperationalError(
      'DASHBOARD_EDGE_DATABASE_NOT_CONFIGURED',
      {
        metadata: {
          component: 'worker_binding',
          resource: 'EDGE_DB',
          action: 'read_dashboard_edge_overview',
        },
      },
    );
  }

  const columns: string[] = [];
  const sources: string[] = [];

  if (input.permissions.comments) {
    columns.push(
      'comment_counts.pending AS comments_pending',
      'comment_settings.comments_enabled AS comments_enabled',
      'comment_settings.api_base_url AS comments_api_base_url',
    );
    sources.push(`(
      SELECT COUNT(*) AS pending
      FROM comments
      WHERE status = 'pending'
    ) AS comment_counts`);
    sources.push(`(
      SELECT comments_enabled, api_base_url
      FROM edge_comment_settings
      WHERE id = 1
    ) AS comment_settings`);
  }

  if (input.permissions.forms) {
    columns.push('form_submission_counts.unread AS form_submissions_unread');
    sources.push(`(
      SELECT COUNT(*) AS unread
      FROM form_submissions
      WHERE status = 'unread'
    ) AS form_submission_counts`);
  }

  if (input.permissions.newsletters) {
    columns.push('subscription_counts.pending AS subscriptions_pending');
    sources.push(`(
      SELECT COUNT(*) AS pending
      FROM newsletter_subscriptions
      WHERE status = 'pending'
    ) AS subscription_counts`);
  }

  if (input.permissions.newsletters) {
    columns.push(
      'mail_runtime.newsletter_confirmation_enabled AS newsletter_confirmation_enabled',
    );
    sources.push(`(
      SELECT newsletter_confirmation_enabled
      FROM edge_mail_settings
      WHERE id = 1
    ) AS mail_runtime`);
  }

  if (columns.length === 0) {
    throw edgeDataInvalid(new TypeError('No Edge dashboard domain was requested.'));
  }

  let row: DashboardRow | null;
  try {
    row = await input.edgeDb.prepare(`
      SELECT ${columns.join(',\n')}
      FROM ${sources.join('\nCROSS JOIN ')}
    `).first<DashboardRow>();
  } catch (error) {
    throw edgeQueryFailure(error);
  }
  if (!row) throw edgeDataInvalid();

  let apiConfigured = false;
  if (input.permissions.comments) {
    const apiBaseUrl = row.comments_api_base_url;
    if (apiBaseUrl !== null) {
      if (
        typeof apiBaseUrl !== 'string'
        || normalizeCommentApiBaseUrl(apiBaseUrl) !== apiBaseUrl
      ) {
        throw edgeDataInvalid(
          new TypeError('Dashboard comments API base URL is invalid.'),
        );
      }
      apiConfigured = true;
    }
  }

  const newsletterConfirmationEnabled = input.permissions.newsletters
    ? sqlBoolean(row, 'newsletter_confirmation_enabled', edgeDataInvalid)
    : false;

  return {
    status: 'available',
    pending_target_events: 0,
    comments: input.permissions.comments ? {
      pending: count(row, 'comments_pending', edgeDataInvalid),
      enabled: sqlBoolean(row, 'comments_enabled', edgeDataInvalid),
      api_configured: apiConfigured,
    } : null,
    forms: input.permissions.forms ? {
      unread_submissions: count(row, 'form_submissions_unread', edgeDataInvalid),
    } : null,
    newsletters: input.permissions.newsletters ? {
      pending_confirmations: count(row, 'subscriptions_pending', edgeDataInvalid),
      confirmation_enabled: newsletterConfirmationEnabled,
      confirmation_ready:
        newsletterConfirmationEnabled && input.mailConfigured,
    } : null,
  };
}
