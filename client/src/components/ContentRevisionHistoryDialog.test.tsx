// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageContentSnapshot } from '../../../contracts/page-autosaves';
import type { PostContentSnapshot } from '../../../contracts/post-autosaves';
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
  title: 'Revision history',
  close: 'Close', loading: 'Loading revisions…', loadError: 'Load failed.',
  noHistory: 'No history.', olderRevision: 'Revision A',
  newerRevision: 'Revision B', current: 'Current', comparison: 'Changed fields',
  content: 'Source content', noDifferences: 'No differences.',
  diffLabel: 'Post revision source comparison',
  diffLoading: 'Loading source comparison.',
  diffUnavailable: 'Visual comparison unavailable.',
  diffRetry: 'Retry visual comparison',
  restore: 'Restore revision A', restoreConfirmTitle: 'Restore revision A?',
  restoreConfirmDescription: 'Current is preserved.', restoreCancel: 'Cancel',
  restoreConfirm: 'Restore', restoring: 'Restoring…',
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

type Snapshot = PostContentSnapshot | PageContentSnapshot;

function setupRevisions(saved: Snapshot = savedSnapshot, current: Snapshot = currentSnapshot) {
  const summaries = [{
    revision_id: CURRENT_REVISION,
    saved_at_iso: '2026-08-02T08:00:00.000Z',
    current: true,
    title: current.draft.title,
    status: current.draft.status,
  }, {
    revision_id: SAVED_REVISION,
    saved_at_iso: '2026-08-01T08:00:00.000Z',
    current: false,
    title: saved.draft.title,
    status: saved.draft.status,
  }];
  const requestList = vi.fn().mockResolvedValue({
    success: true,
    data: { current_revision: CURRENT_REVISION, items: summaries },
  });
  const requestDetail = vi.fn().mockImplementation((revisionId: string) => (
    Promise.resolve({
      success: true,
      data: {
        ...summaries.find((item) => item.revision_id === revisionId),
        snapshot: revisionId === CURRENT_REVISION ? current : saved,
        snapshot_sha256: (revisionId === CURRENT_REVISION ? 'a' : 'b').repeat(64),
      },
    })
  ));
  const requestRestore = vi.fn().mockResolvedValue({ success: true, data: {} });
  const callbacks = {
    onClose: vi.fn(), onRestored: vi.fn(), onSessionEnded: vi.fn(),
  };
  render(<ContentRevisionHistoryDialog
    copy={copy}
    formatDate={(iso) => iso}
    {...callbacks}
    requestList={requestList}
    requestDetail={requestDetail}
    requestRestore={requestRestore}
  />);
  return { requestRestore, ...callbacks };
}

afterEach(cleanup);

describe('ContentRevisionHistoryDialog', () => {
  it('confirms the selected revision in the fixed footer before restoring', async () => {
    const { requestRestore, onRestored } = setupRevisions();
    const user = userEvent.setup();

    expect(await screen.findByRole('textbox', { name: 'Revision A source' }))
      .toHaveValue('# Saved');
    expect(screen.getByRole('textbox', { name: 'Revision B source' }))
      .toHaveValue('# Current');
    expect(screen.getByRole('cell', { name: 'Saved title' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Current title' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Restore revision A' }));
    const confirmation = screen.getByRole('group', { name: 'Restore revision A?' });
    expect(confirmation.closest('.studio-dialog-actions')).toBeInTheDocument();
    expect(within(confirmation).getByText('2026-08-01T08:00:00.000Z'))
      .toBeInTheDocument();
    expect(within(confirmation).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(screen.getByRole('combobox', { name: 'Revision A' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Revision B' })).toBeDisabled();
    expect(requestRestore).not.toHaveBeenCalled();

    await user.click(within(confirmation).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(requestRestore).toHaveBeenCalledWith(
      SAVED_REVISION, { expected_revision: CURRENT_REVISION },
    ));
    expect(onRestored).toHaveBeenCalledOnce();
  });

  it.each(['button', 'Escape'] as const)(
    'cancels with %s and returns focus without remounting the comparison',
    async (method) => {
      const { requestRestore, onClose } = setupRevisions();
      const user = userEvent.setup();
      const source = await screen.findByRole('textbox', { name: 'Revision A source' });
      await user.click(screen.getByRole('button', { name: 'Restore revision A' }));
      if (method === 'button') {
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
      } else {
        await user.keyboard('{Escape}');
      }
      expect(screen.getByRole('button', { name: 'Restore revision A' })).toHaveFocus();
      expect(screen.getByRole('textbox', { name: 'Revision A source' })).toBe(source);
      expect(screen.getByRole('combobox', { name: 'Revision A' })).toBeEnabled();
      expect(requestRestore).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      await user.keyboard('{Escape}');
      expect(onClose).toHaveBeenCalledOnce();
    },
  );

  it.each(['conflict', 'network'] as const)(
    'keeps a %s failure beside the restore controls',
    async (failure) => {
      const { requestRestore, onRestored } = setupRevisions();
      if (failure === 'conflict') {
        requestRestore.mockResolvedValueOnce({
          success: false, error: { code: 'POST_REVISION_CONFLICT' },
        });
      } else {
        requestRestore.mockRejectedValueOnce(new Error('Request failed'));
      }
      const user = userEvent.setup();
      await screen.findByRole('textbox', { name: 'Revision A source' });
      await user.click(screen.getByRole('button', { name: 'Restore revision A' }));
      await user.click(screen.getByRole('button', { name: 'Restore' }));
      const feedback = await screen.findByRole('alert');
      expect(feedback).toHaveTextContent(
        failure === 'conflict' ? 'Revision conflict.' : 'Restore failed.',
      );
      expect(feedback.closest('.studio-dialog-actions')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
      expect(onRestored).not.toHaveBeenCalled();
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.getByRole('button', { name: 'Restore revision A' })).toHaveFocus();
    },
  );

  it('keeps the selected target and blocks dismissal while restoration is pending', async () => {
    const { requestRestore, onRestored, onClose } = setupRevisions();
    let finish!: (value: { success: true; data: object }) => void;
    requestRestore.mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve;
    }));
    const user = userEvent.setup();
    await screen.findByRole('textbox', { name: 'Revision A source' });
    await user.click(screen.getByRole('button', { name: 'Restore revision A' }));
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(screen.getByRole('button', { name: 'Restoring…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Revision A' })).toBeDisabled();
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(requestRestore).toHaveBeenCalledOnce();
    await act(async () => finish({ success: true, data: {} }));
    expect(onRestored).toHaveBeenCalledOnce();
  });

  it('shows the source comparison when only the body changed', async () => {
    setupRevisions({
      ...currentSnapshot,
      draft: { ...currentSnapshot.draft, content: '# Previous body' },
    });
    expect(await screen.findByRole('textbox', { name: 'Revision A source' }))
      .toHaveValue('# Previous body');
    expect(screen.getByRole('textbox', { name: 'Revision B source' }))
      .toHaveValue('# Current');
  });

  it('shows a concise result when both snapshots are identical', async () => {
    setupRevisions(currentSnapshot);
    expect(await screen.findByText('No differences.')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Revision A' })).toHaveValue(SAVED_REVISION);
    expect(screen.getByRole('combobox', { name: 'Revision B' })).toHaveValue(CURRENT_REVISION);
  });

  it('compares page fields and restores the selected page revision', async () => {
    const current: PageContentSnapshot = {
      version: 1,
      content_type: 'page',
      draft: {
        title: 'Current page', slug: 'current-page', content: '# Page',
        document_type: 'markdown', excerpt: '', status: 'draft',
        parent_id: null, discoverability: 'default', allow_comments: false,
        featured_image_id: null,
      },
      references: { parent: null, featured_image: null },
    };
    const { requestRestore } = setupRevisions({
      ...current, draft: { ...current.draft, title: 'Saved page' },
    }, current);
    const user = userEvent.setup();
    expect(await screen.findByRole('cell', { name: 'Saved page' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Current page' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore revision A' }));
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    expect(requestRestore).toHaveBeenCalledWith(
      SAVED_REVISION, { expected_revision: CURRENT_REVISION },
    );
  });
});
