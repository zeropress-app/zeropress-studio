// @vitest-environment jsdom

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTENT_SEARCH_REBUILD_CONFIRMATION } from '../../../contracts/content-search-index';
import {
  requestContentSearchIndexRebuildStart,
  requestContentSearchIndexRebuildStep,
} from '../lib/operations-client';
import { ContentSearchIndexPanel } from './ContentSearchIndexPanel';

vi.mock('../lib/operations-client', () => ({
  OperationsClientError: class OperationsClientError extends Error {
    readonly code = 'TEST_CLIENT_ERROR';
  },
  requestContentSearchIndexRebuildStart: vi.fn(),
  requestContentSearchIndexRebuildStep: vi.fn(),
}));

const READY = {
  state: 'ready' as const,
  reason: null,
  phase: null,
  operation_id: null,
  post_public_id_cursor: 0,
  page_public_id_cursor: 0,
  processed_posts: 2,
  processed_pages: 1,
  total_posts: 2,
  total_pages: 1,
  available: true,
};

describe('ContentSearchIndexPanel', () => {
  beforeEach(() => {
    vi.mocked(requestContentSearchIndexRebuildStart).mockReset();
    vi.mocked(requestContentSearchIndexRebuildStep).mockReset();
  });

  it('submits the administrator-entered exact confirmation and reports completion', async () => {
    vi.mocked(requestContentSearchIndexRebuildStart).mockResolvedValue({
      success: true,
      data: {
        operation: 'rebuild_content_search_index',
        status: 'started',
        content_search_index: READY,
      },
    });
    const refreshStatus = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <ContentSearchIndexPanel
        token="operations-token"
        status={{
          ...READY,
          state: 'rebuild_required',
          reason: 'schema_upgrade',
          processed_posts: 0,
          processed_pages: 0,
        }}
        refreshStatus={refreshStatus}
      />,
    );

    await user.click(screen.getByRole('button', {
      name: 'Start search index rebuild',
    }));
    await user.type(screen.getByLabelText('Administrator email'), 'admin@example.com');
    await user.type(screen.getByLabelText('Administrator password'), 'password');
    await user.type(
      screen.getByLabelText('Type the exact confirmation phrase:'),
      CONTENT_SEARCH_REBUILD_CONFIRMATION,
    );
    await user.click(screen.getByRole('button', {
      name: 'Start search index rebuild',
    }));

    await waitFor(() => expect(requestContentSearchIndexRebuildStart)
      .toHaveBeenCalledWith({
        token: 'operations-token',
        request: {
          administrator_email: 'admin@example.com',
          administrator_password: 'password',
          confirmation: CONTENT_SEARCH_REBUILD_CONFIRMATION,
        },
      }));
    expect(await screen.findByText(
      'The Post and Page search index was rebuilt and verified.',
    )).toBeInTheDocument();
    expect(refreshStatus).toHaveBeenCalledOnce();
  });
});
