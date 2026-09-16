// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContentRevisionHistoryDialog } from './ContentRevisionHistoryDialog';

vi.mock('./MonacoRevisionDiff', () => ({
  MonacoRevisionDiff: (input: {
    original: string;
    modified: string;
    originalLabel: string;
    modifiedLabel: string;
  }) => (
    <div data-testid="revision-diff">
      <textarea readOnly aria-label={input.originalLabel} value={input.original} />
      <textarea readOnly aria-label={input.modifiedLabel} value={input.modified} />
    </div>
  ),
}));

const CURRENT_REVISION = '1'.repeat(32);
const SAVED_REVISION = '2'.repeat(32);
const author = { id: 'Studio-Owner', display_name: 'Studio Owner' };
const currentSnapshot = {
  version: 1 as const,
  content_type: 'post' as const,
  draft: {
    title: 'Current title', slug: 'current-title', content: '# Current',
    document_type: 'markdown' as const, excerpt: 'Current excerpt',
    status: 'draft' as const, author_id: author.id, category_ids: [],
    tag_ids: [], discoverability: 'default' as const, allow_comments: true,
    featured_image_id: null,
  },
  references: {
    author, categories: [], tags: [], featured_image: null,
  },
};
const savedSnapshot = {
  ...currentSnapshot,
  draft: {
    ...currentSnapshot.draft,
    title: 'Saved title', slug: 'saved-title', content: '# Saved',
    excerpt: 'Saved excerpt', allow_comments: false,
  },
};

const copy = {
  title: 'Revision history', description: 'Compare and restore.',
  close: 'Close', loading: 'Loading revisions…', loadError: 'Load failed.',
  noHistory: 'No history.', olderRevision: 'Revision A',
  newerRevision: 'Revision B', current: 'Current', comparison: 'Changed fields',
  metadataSame: 'Same metadata.', content: 'Source content',
  contentSame: 'Same content.', contentChanged: 'Content changed.',
  diffLabel: 'Post revision source comparison',
  diffLoading: 'Loading source comparison.',
  diffUnavailable: 'Visual comparison unavailable.',
  diffRetry: 'Retry visual comparison',
  restore: 'Restore revision A', restoreConfirmTitle: 'Restore revision?',
  restoreConfirmDescription: 'Current is preserved.', restoreCancel: 'Cancel',
  restoreConfirm: 'Restore as current', restoring: 'Restoring…',
  restoreError: 'Restore failed.', revisionConflict: 'Revision conflict.',
  revisionNotFound: 'Revision missing.', restoreUnavailable: 'Cannot restore.',
  leftSource: 'Revision A source', rightSource: 'Revision B source',
  none: 'None', yes: 'Yes', no: 'No',
  fields: {
    title: 'Title', slug: 'Slug', documentType: 'Document type',
    editorMode: 'HTML editor mode',
    excerpt: 'Excerpt', status: 'Status', discoverability: 'Discoverability',
    allowComments: 'Allow comments', featuredImage: 'Featured image',
    author: 'Author', categories: 'Categories', tags: 'Tags', parent: 'Parent',
  },
};

afterEach(cleanup);

describe('ContentRevisionHistoryDialog', () => {
  it('compares two complete snapshots and restores the selected saved state', async () => {
    const requestList = vi.fn().mockResolvedValue({
      success: true,
      data: {
        current_revision: CURRENT_REVISION,
        items: [{
          revision_id: CURRENT_REVISION,
          saved_at_iso: '2026-08-02T08:00:00.000Z',
          current: true,
          title: currentSnapshot.draft.title,
          status: 'draft',
        }, {
          revision_id: SAVED_REVISION,
          saved_at_iso: '2026-08-01T08:00:00.000Z',
          current: false,
          title: savedSnapshot.draft.title,
          status: 'draft',
        }],
      },
    });
    const requestDetail = vi.fn().mockImplementation((revisionId: string) => (
      Promise.resolve({
        success: true,
        data: revisionId === CURRENT_REVISION ? {
          revision_id: CURRENT_REVISION,
          saved_at_iso: '2026-08-02T08:00:00.000Z',
          current: true,
          title: currentSnapshot.draft.title,
          status: 'draft',
          snapshot: currentSnapshot,
          snapshot_sha256: 'a'.repeat(64),
        } : {
          revision_id: SAVED_REVISION,
          saved_at_iso: '2026-08-01T08:00:00.000Z',
          current: false,
          title: savedSnapshot.draft.title,
          status: 'draft',
          snapshot: savedSnapshot,
          snapshot_sha256: 'b'.repeat(64),
        },
      })
    ));
    const requestRestore = vi.fn().mockResolvedValue({
      success: true,
      data: {},
    });
    const onRestored = vi.fn();
    const user = userEvent.setup();
    render(<ContentRevisionHistoryDialog
      copy={copy}
      formatDate={(iso) => iso}
      onClose={vi.fn()}
      onRestored={onRestored}
      onSessionEnded={vi.fn()}
      requestList={requestList}
      requestDetail={requestDetail}
      requestRestore={requestRestore}
    />);

    expect(await screen.findByRole('textbox', { name: 'Revision A source' }))
      .toHaveValue('# Saved');
    expect(screen.getByRole('textbox', { name: 'Revision B source' }))
      .toHaveValue('# Current');
    expect(screen.getByRole('cell', { name: 'Saved title' }))
      .toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Current title' }))
      .toBeInTheDocument();
    expect(screen.getByText('Content changed.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Restore revision A' }));
    expect(screen.getByText('Restore revision?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore as current' }));
    await waitFor(() => expect(requestRestore).toHaveBeenCalledWith(
      SAVED_REVISION,
      { expected_revision: CURRENT_REVISION },
    ));
    expect(onRestored).toHaveBeenCalledOnce();
  });
});
