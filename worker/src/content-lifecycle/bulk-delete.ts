import type {
  ContentBulkDeleteData,
  ContentBulkDeleteRequest,
} from '../../../contracts/content-bulk-delete';

type DeleteResult = {
  kind: 'completed' | 'revision_conflict' | 'not_found' | 'not_in_trash'
    | 'front_page_protected' | 'has_children';
};

/** Reuse the revision-guarded single-document deletion for each selected row. */
export async function deleteContentSelection(
  request: ContentBulkDeleteRequest,
  remove: (item: ContentBulkDeleteRequest['items'][number]) => Promise<DeleteResult>,
): Promise<ContentBulkDeleteData> {
  const results: ContentBulkDeleteData['results'] = [];
  const summary = { requested: request.items.length, updated: 0, unchanged: 0, conflict: 0, skipped: 0 };
  for (const item of request.items) {
    const result = await remove(item);
    if (result.kind === 'completed') {
      results.push({ id: item.id, outcome: 'deleted' });
      summary.updated += 1;
    } else if (result.kind === 'revision_conflict') {
      results.push({ id: item.id, outcome: 'conflict' });
      summary.conflict += 1;
    } else {
      results.push({ id: item.id, outcome: 'skipped', reason: result.kind });
      summary.skipped += 1;
    }
  }
  return { results, summary };
}
