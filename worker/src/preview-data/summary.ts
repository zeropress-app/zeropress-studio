import {
  previewDataSummarySchema,
  type PreviewDataSummary,
} from '../../../contracts/preview-data';
import { StudioOperationalError } from '../lib/operational-error';

function queryFailure(error: unknown): StudioOperationalError {
  return new StudioOperationalError(
    'PREVIEW_DATA_SUMMARY_DATABASE_QUERY_FAILED',
    {
      cause: error,
      metadata: { resource: 'DB', action: 'read_preview_data_summary' },
    },
  );
}

function dataInvalid(error?: unknown): StudioOperationalError {
  return new StudioOperationalError('PREVIEW_DATA_SUMMARY_DATA_INVALID', {
    cause: error,
    metadata: { resource: 'DB', action: 'validate_preview_data_summary' },
  });
}

export async function readPreviewDataSummary(input: {
  db: D1Database;
}): Promise<PreviewDataSummary> {
  try {
    const row = await input.db.prepare(`
      SELECT
        COUNT(DISTINCT author_id) AS authors,
        COUNT(*) AS posts,
        (
          SELECT COUNT(*)
          FROM pages
          WHERE status = 'published'
        ) AS pages,
        (SELECT COUNT(*) FROM categories) AS categories,
        (SELECT COUNT(*) FROM tags) AS tags,
        (
          SELECT COUNT(*)
          FROM menus
          WHERE enabled = 1
        ) AS menus
      FROM posts
      WHERE status = 'published'
    `).first();
    if (!row) throw dataInvalid();
    const parsed = previewDataSummarySchema.safeParse(row);
    if (!parsed.success) throw dataInvalid(parsed.error);
    return parsed.data;
  } catch (error) {
    if (error instanceof StudioOperationalError) throw error;
    throw queryFailure(error);
  }
}
