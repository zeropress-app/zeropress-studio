import {
  hasStudioCapability,
} from '../../../contracts/authorization';
import {
  postAccessSchema,
  type PostAccess,
} from '../../../contracts/posts';
import { StudioOperationalError } from '../lib/operational-error';

type LinkedAuthorRow = {
  id: unknown;
  display_name: unknown;
};

/**
 * Resolves the Post boundary from current account state on every request.
 * A role stored in the session is not enough for contributors: the public
 * Author link can be changed independently by an administrator.
 */
export async function resolvePostAccess(input: {
  db: D1Database;
  userId: string;
  roles: readonly string[];
}): Promise<PostAccess> {
  if (hasStudioCapability(input.roles, 'posts.manage')) {
    return { scope: 'all' };
  }

  try {
    const row = await input.db.prepare(`
      SELECT id, display_name
      FROM authors
      WHERE user_id = ?
      LIMIT 1
    `).bind(input.userId).first<LinkedAuthorRow>();
    if (!row) {
      return {
        scope: 'unavailable',
        reason: 'author_not_linked',
      };
    }
    const parsed = postAccessSchema.safeParse({
      scope: 'own',
      author: {
        id: row.id,
        display_name: row.display_name,
      },
    });
    if (!parsed.success) {
      throw new StudioOperationalError('POST_MANAGEMENT_DATA_INVALID', {
        cause: parsed.error,
        metadata: {
          resource: 'DB',
          action: 'resolve_post_contributor_access',
        },
      });
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw new StudioOperationalError(
      'POST_MANAGEMENT_DATABASE_QUERY_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'resolve_post_contributor_access',
        },
      },
    );
  }
}

export function postAccessAuthorId(
  access: PostAccess,
): string | null | undefined {
  if (access.scope === 'all') return undefined;
  return access.scope === 'own' ? access.author.id : null;
}
