// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { ManagedComment } from '../../contracts/comments';
import { CommentsPage } from './CommentsPage';
import { changeLocale } from './i18n';
import { StudioToaster } from './components/primitives';

const comment = {
  id: '1'.repeat(32),
  public_id: 101,
  target_type: 'post',
  target_public_id: 100_000_000_001,
  target: {
    type: 'post',
    id: '2'.repeat(32),
    public_id: 100_000_000_001,
    title: 'First Post',
    slug: 'first-post',
  },
  parent_public_id: null,
  reply: { available: false, reason: 'not_approved' },
  author: {
    name: 'Reader Name',
    email: 'reader@example.com',
    kind: 'guest',
  },
  content_text: 'A useful comment',
  status: 'pending',
  ip_address: '203.0.113.1',
  user_agent: 'Example browser',
  created_at_iso: '2026-08-02T00:00:00.000Z',
  updated_at_iso: '2026-08-02T00:00:00.000Z',
} as const satisfies ManagedComment;

const session = {
  user: {
    id: '3'.repeat(32),
    email: 'editor@example.com',
    name: 'Site Editor',
    roles: ['editor'],
  },
  session: {
    id: '4'.repeat(32),
    created_at_iso: '2026-08-02T00:00:00.000Z',
    last_seen_at_iso: '2026-08-02T00:00:00.000Z',
    idle_expires_at_iso: '2026-08-02T12:00:00.000Z',
    absolute_expires_at_iso: '2026-08-09T00:00:00.000Z',
    network: {
      ip_address: '127.0.0.1',
      asn: null,
      as_organization: null,
      country_code: null,
    },
  },
  csrf_token: 'c'.repeat(43),
  edge_integration: {
    mode: 'enabled' as const,
    database_state: 'ready' as const,
  },
};

function response(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function list(items: ManagedComment[]) {
  return response({
    success: true,
    data: {
      items,
      pagination: {
        page: 1,
        per_page: 50,
        total: items.length,
        total_pages: items.length > 0 ? 1 : 0,
      },
      status_counts: {
        all: items.length,
        pending: items.filter((item) => item.status === 'pending').length,
        approved: items.filter((item) => item.status === 'approved').length,
        spam: items.filter((item) => item.status === 'spam').length,
        trash: items.filter((item) => item.status === 'trash').length,
      },
    },
  });
}

function targets(items: ManagedComment['target'][]) {
  return response({
    success: true,
    data: { items: items.filter((item) => item !== null) },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  localStorage.clear();
  await changeLocale('en');
});

describe('CommentsPage', () => {
  it('keeps metadata in a read-only dialog and approves a pending comment with a toast', async () => {
    const approved = {
      ...comment,
      status: 'approved' as const,
      updated_at_iso: '2026-08-02T00:00:00.001Z',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(list([comment]))
      .mockResolvedValueOnce(response({ success: true, data: approved }))
      .mockResolvedValueOnce(list([approved]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <StudioToaster />
        <CommentsPage data={session} onSessionEnded={vi.fn()} />
      </MemoryRouter>,
    );

    expect(await screen.findByText('A useful comment')).toBeInTheDocument();
    expect(screen.queryByText('203.0.113.1')).not.toBeInTheDocument();
    expect(screen.queryByText('Example browser')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'First Post' }))
      .toHaveAttribute('href', `/posts/${comment.target.id}`);
    expect(document.querySelector('img')).toBeNull();
    const menuTrigger = screen.getByRole('button', { name: 'Actions for comment #101 by Reader Name' });
    await user.click(menuTrigger);
    await user.click(screen.getByRole('menuitem', { name: 'View details' }));
    const details = screen.getByRole('dialog', { name: 'Comment details' });
    expect(within(details).getByText('203.0.113.1')).toBeInTheDocument();
    expect(within(details).getByText('Example browser')).toBeInTheDocument();
    expect(within(details).getByText('Guest reader')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    await user.click(within(details).getByRole('button', { name: 'Close' }));
    expect(menuTrigger).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('The comment is now approved.'))
      .toBeInTheDocument();
    expect(screen.getByText('The comment is now approved.').closest('.studio-toast'))
      .toBeInTheDocument();
    expect(screen.getByRole('main')).not.toHaveTextContent('The comment is now approved.');
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`/api/comments/${comment.id}`);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'PUT' });
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)))
      .toEqual({
        status: 'approved',
        expected_updated_at_iso: comment.updated_at_iso,
      });
  });

  it('confirms permanent subtree deletion for a trashed comment', async () => {
    const trashed = { ...comment, status: 'trash' as const };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(list([trashed]))
      .mockResolvedValueOnce(response({
        success: true,
        data: { status: 'permanently_deleted', deleted_count: 3 },
      }))
      .mockResolvedValueOnce(list([]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <StudioToaster />
        <CommentsPage data={session} onSessionEnded={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByText('A useful comment');
    await user.click(screen.getByRole('button', { name: 'Actions for comment #101 by Reader Name' }));
    await user.click(screen.getByRole('menuitem', { name: 'Delete permanently' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('All replies will also be deleted');
    await user.click(within(dialog).getByRole('button', {
      name: 'Delete permanently',
    }));
    expect(await screen.findByText(
      'Permanently deleted 3 comments, including any replies.',
    )).toBeInTheDocument();
    expect(screen.getByRole('main')).toHaveTextContent('Permanently deleted 3 comments');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('keeps edits revision-bound and displays failures only inside the dialog', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(list([comment]))
      .mockResolvedValueOnce(response({
        success: false, error: { code: 'COMMENT_REVISION_CONFLICT' },
      }, 409));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <StudioToaster />
        <CommentsPage data={session} onSessionEnded={vi.fn()} />
      </MemoryRouter>,
    );
    const trigger = await screen.findByRole('button', {
      name: 'Actions for comment #101 by Reader Name',
    });
    await user.click(trigger);
    await user.click(screen.getByRole('menuitem', { name: 'Edit content' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit comment content' });
    const content = within(dialog).getByLabelText('Comment content');
    expect(content).toHaveAttribute('maxlength', '5000');
    expect(within(dialog).getByRole('button', { name: 'Save comment' })).toBeDisabled();
    fireEvent.change(content, { target: { value: ' \u0000\u0007\t\n ' } });
    expect(within(dialog).getByRole('button', { name: 'Save comment' })).toBeDisabled();
    const draft = '  Revised ©😊\u0000\n\n\ncomment\t👨‍👩‍👧‍👦  ';
    fireEvent.change(content, { target: { value: draft } });
    await user.click(within(dialog).getByRole('button', { name: 'Save comment' }));
    const message = 'This comment changed in another session. Reload before applying another moderation action.';
    expect(await within(dialog).findByText(message)).toBeInTheDocument();
    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(document.querySelector('.studio-toast')).toBeNull();
    expect(content).toHaveValue(draft);
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)))
      .toEqual({ content_text: 'Revised ©😊\n\ncomment 👨‍👩‍👧‍👦', expected_updated_at_iso: comment.updated_at_iso });
    await user.keyboard('{Escape}');
    expect(trigger).toHaveFocus();
  });

  it.each([
    ['pending', 'spam', 'Mark as spam'],
    ['approved', 'pending', 'Mark pending'],
    ['spam', 'approved', 'Approve'],
    ['trash', 'approved', 'Approve'],
  ] as const)('preserves the %s → %s transition in the row menu', async (from, to, label) => {
    const original = { ...comment, status: from };
    const updated = { ...original, status: to };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(list([original]))
      .mockResolvedValueOnce(response({ success: true, data: updated }))
      .mockResolvedValueOnce(list([updated]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<MemoryRouter><CommentsPage data={session} onSessionEnded={vi.fn()} /></MemoryRouter>);
    await user.click(await screen.findByRole('button', {
      name: 'Actions for comment #101 by Reader Name',
    }));
    await user.click(screen.getByRole('menuitem', { name: label }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'PUT' });
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)))
      .toEqual({ status: to, expected_updated_at_iso: comment.updated_at_iso });
  });

  it('preserves all-status counts, typed content links, plain text and selection reset on filtering', async () => {
    const pageComment: ManagedComment = {
      ...comment,
      id: 'a'.repeat(32),
      public_id: 102,
      target_type: 'page',
      target: { ...comment.target, type: 'page', id: 'b'.repeat(32), title: 'First Page' },
      status: 'trash',
      content_text: 'First line\n<b>Still plain text</b>',
      author: { ...comment.author, kind: 'authenticated_user' },
    };
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(list([comment, pageComment])));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<MemoryRouter><CommentsPage data={session} onSessionEnded={vi.fn()} /></MemoryRouter>);
    await screen.findByText('First Page');
    expect(screen.getByRole('button', { name: 'All 2' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Trash 1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'First Post' })).toHaveAttribute('href', `/posts/${comment.target.id}`);
    expect(screen.getByRole('link', { name: 'First Page' })).toHaveAttribute('href', `/pages/${pageComment.target!.id}`);
    const content = screen.getByText(/Still plain text/);
    expect(content.textContent).toBe(pageComment.content_text);
    expect(content.querySelector('b')).toBeNull();
    expect(screen.getByText('Signed-in reader')).toBeInTheDocument();
    await user.click(screen.getByLabelText('Select comment #101 by Reader Name'));
    await user.type(screen.getByRole('searchbox', { name: 'Search comments' }), '  Reader Name  ');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(new URL(String(fetchMock.mock.calls[1]?.[0]), 'https://studio.example').searchParams.get('search'))
      .toBe('Reader Name');
    await screen.findByText('First Page');
    expect(screen.queryByRole('region', { name: 'Bulk comment moderation' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Trash 1' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(new URL(String(fetchMock.mock.calls[2]?.[0]), 'https://studio.example').searchParams.get('status'))
      .toBe('trash');
  });

  it('keeps missing target and unrecorded network data explicit in details without extra requests', async () => {
    const fetchMock = vi.fn().mockResolvedValue(list([{
      ...comment, target: null, ip_address: null, user_agent: null,
      author: { ...comment.author, kind: 'site_user' },
    }]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<MemoryRouter><CommentsPage data={session} onSessionEnded={vi.fn()} /></MemoryRouter>);
    expect(await screen.findByText('Studio content is unavailable')).toBeInTheDocument();
    expect(screen.getByText('Studio user')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Actions for comment #101 by Reader Name' }));
    await user.click(screen.getByRole('menuitem', { name: 'View details' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByText('Not recorded')).toHaveLength(2);
    expect(within(dialog).queryByRole('link')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('disables row menus and quick actions while another comment is being updated', async () => {
    let resolveUpdate!: (value: Response) => void;
    const pendingUpdate = new Promise<Response>((resolve) => { resolveUpdate = resolve; });
    const other: ManagedComment = {
      ...comment, id: 'b'.repeat(32), public_id: 102,
      status: 'approved', reply: { available: true },
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(list([comment, other]))
      .mockReturnValueOnce(pendingUpdate)
      .mockResolvedValueOnce(list([comment, other]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<MemoryRouter><CommentsPage data={session} onSessionEnded={vi.fn()} /></MemoryRouter>);
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    for (const menu of screen.getAllByRole('button', { name: /Actions for comment/ })) {
      expect(menu).toBeDisabled();
    }
    expect(screen.getByRole('button', { name: 'Reply' })).toBeDisabled();
    expect(screen.getByLabelText('Select all comments on this page')).toBeDisabled();
    resolveUpdate(response({ success: true, data: { ...comment, status: 'approved' } }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(await screen.findByRole('button', { name: 'Reply' })).toBeEnabled();
  });

  it('bulk moderates selected comments and retains conflicts for review', async () => {
    const second = {
      ...comment,
      id: '7'.repeat(32),
      public_id: 102,
      author: { ...comment.author, name: 'Second Reader' },
      content_text: 'Another comment',
    };
    const approved = {
      ...comment,
      status: 'approved' as const,
      updated_at_iso: '2026-08-02T00:00:00.001Z',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(list([comment, second]))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          operation: 'set_status',
          status: 'approved',
          results: [
            {
              id: comment.id,
              outcome: 'updated',
              status: 'approved',
              updated_at_iso: approved.updated_at_iso,
            },
            { id: second.id, outcome: 'conflict' },
          ],
          summary: {
            requested: 2,
            updated: 1,
            unchanged: 0,
            conflict: 1,
            skipped: 0,
            deleted_comments: 0,
          },
        },
      }))
      .mockResolvedValueOnce(list([approved, second]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <StudioToaster />
        <CommentsPage data={session} onSessionEnded={vi.fn()} />
      </MemoryRouter>,
    );

    await screen.findByText('Another comment');
    expect(screen.queryByRole('region', { name: 'Bulk comment moderation' })).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Select comment #101 by Reader Name'));
    expect(screen.getByLabelText('Select all comments on this page')).toBePartiallyChecked();
    await user.click(screen.getByLabelText('Select all comments on this page'));
    const toolbar = screen.getByRole('region', {
      name: 'Bulk comment moderation',
    });
    await user.click(within(toolbar).getByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog', {
      name: 'Approve 2 selected comments?',
    });
    await user.click(within(dialog).getByRole('button', {
      name: 'Apply moderation',
    }));

    expect(await screen.findByText('Bulk moderation completed'))
      .toBeInTheDocument();
    expect(screen.getByText(/1 updated, 0 already current, 1 conflicted/))
      .toBeInTheDocument();
    expect(screen.getByText(
      'Changed after selection; reload and review it.',
      { exact: false },
    ))
      .toBeInTheDocument();
    expect(screen.getByText('1 comment selected')).toBeInTheDocument();
    expect(screen.getByLabelText('Select all comments on this page')).toBePartiallyChecked();
    const requestBody = JSON.parse(String(
      (fetchMock.mock.calls[1]?.[1] as RequestInit).body,
    ));
    expect(requestBody).toEqual({
      operation: 'set_status',
      status: 'approved',
      items: [
        {
          id: comment.id,
          expected_updated_at_iso: comment.updated_at_iso,
        },
        {
          id: second.id,
          expected_updated_at_iso: second.updated_at_iso,
        },
      ],
    });
  });

  it('bulk permanently deletes selected Trash subtrees after confirmation', async () => {
    const first = { ...comment, status: 'trash' as const };
    const second = {
      ...first,
      id: '8'.repeat(32),
      public_id: 102,
      content_text: 'Nested selection',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(list([first, second]))
      .mockResolvedValueOnce(response({
        success: true,
        data: {
          operation: 'delete_permanently',
          results: [
            { id: first.id, outcome: 'updated', deleted_count: 3 },
            { id: second.id, outcome: 'skipped', reason: 'not_found' },
          ],
          summary: {
            requested: 2,
            updated: 1,
            unchanged: 0,
            conflict: 0,
            skipped: 1,
            deleted_comments: 3,
          },
        },
      }))
      .mockResolvedValueOnce(list([]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <StudioToaster />
        <CommentsPage data={session} onSessionEnded={vi.fn()} />
      </MemoryRouter>,
    );

    await screen.findByText('Nested selection');
    await user.click(screen.getByLabelText('Select all comments on this page'));
    const toolbar = screen.getByRole('region', {
      name: 'Bulk comment moderation',
    });
    await user.click(within(toolbar).getByRole('button', {
      name: 'Delete permanently',
    }));
    const dialog = screen.getByRole('dialog', {
      name: 'Permanently delete 2 selected Trash comments?',
    });
    expect(dialog).toHaveTextContent('The selected comments and all their replies will be permanently deleted.');
    expect(dialog).toHaveTextContent('Replies are also deleted even if they are not selected.');
    await user.click(within(dialog).getByRole('button', {
      name: 'Apply moderation',
    }));

    expect(await screen.findByText(
      'Permanently deleted 3 comments, including any replies.',
    )).toBeInTheDocument();
    expect(JSON.parse(String(
      (fetchMock.mock.calls[1]?.[1] as RequestInit).body,
    ))).toMatchObject({ operation: 'delete_permanently' });
  });

  it('ends the local session when list authentication is lost', async () => {
    const onSessionEnded = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({
      success: false,
      error: { code: 'AUTHENTICATION_REQUIRED' },
    }, 401)));
    render(
      <MemoryRouter>
        <StudioToaster />
        <CommentsPage data={session} onSessionEnded={onSessionEnded} />
      </MemoryRouter>,
    );
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalledOnce());
  });

  it('filters to an eligible target and publishes a top-level Studio comment', async () => {
    const authored = {
      ...comment,
      id: '5'.repeat(32),
      public_id: 100_000_000_001,
      status: 'approved' as const,
      reply: { available: true as const },
      author: {
        name: session.user.name,
        email: session.user.email,
        kind: 'site_user' as const,
      },
      content_text: 'A Studio comment ©😊',
      ip_address: null,
      user_agent: null,
    };
    let created = false;
    const fetchMock = vi.fn().mockImplementation((path: string, init?: RequestInit) => {
      if (path.startsWith('/api/comments/targets?')) {
        return Promise.resolve(targets([comment.target]));
      }
      if (path === '/api/comments' && init?.method === 'POST') {
        created = true;
        return Promise.resolve(response({ success: true, data: authored }, 201));
      }
      if (path.startsWith('/api/comments?')) {
        return Promise.resolve(list(path.includes('target_public_id=')
          && created
          ? [authored]
          : []));
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <StudioToaster />
        <CommentsPage data={session} onSessionEnded={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByText('No comments found');
    await user.selectOptions(
      screen.getByLabelText('Content type'),
      'post',
    );
    await user.click(await screen.findByRole('button', { name: 'Choose content' }));
    const targetSelect = screen.getByLabelText('Selected content');
    await waitFor(() => expect(within(targetSelect).getByRole('option', {
      name: `First Post (#${comment.target_public_id})`,
    })).toBeInTheDocument());
    await user.selectOptions(targetSelect, String(comment.target_public_id));
    await user.click(screen.getByRole('button', { name: 'Add comment' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Site Editor');
    expect(dialog).toHaveTextContent('editor@example.com');
    const content = within(dialog).getByLabelText('Comment');
    fireEvent.change(content, { target: { value: ' \u0000\u0007\t\n ' } });
    expect(within(dialog).getByRole('button', { name: 'Publish comment' })).toBeDisabled();
    fireEvent.change(content, { target: { value: ' A Studio comment\t©😊\u0000 ' } });
    await user.click(within(dialog).getByRole('button', {
      name: 'Publish comment',
    }));
    await waitFor(() => expect(fetchMock.mock.calls.some(
      (call) => call[0] === '/api/comments',
    )).toBe(true));
    expect(await screen.findByText('The Studio comment was published.'))
      .toBeInTheDocument();
    const createCall = fetchMock.mock.calls.find(
      (call) => call[0] === '/api/comments',
    );
    expect(createCall?.[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String((createCall?.[1] as RequestInit).body))).toEqual({
      target_type: 'post',
      target_public_id: comment.target_public_id,
      parent_public_id: null,
      content_text: 'A Studio comment ©😊',
    });
  });

  it('publishes an eligible reply and disables replies at the depth limit', async () => {
    const approved = {
      ...comment,
      status: 'approved' as const,
      reply: { available: true as const },
    };
    const authoredReply = {
      ...approved,
      id: '6'.repeat(32),
      public_id: 100_000_000_002,
      parent_public_id: comment.public_id,
      reply: { available: false as const, reason: 'depth_limit' as const },
      author: {
        name: session.user.name,
        email: session.user.email,
        kind: 'site_user' as const,
      },
      content_text: 'Studio reply ©😊\n\n👨‍👩‍👧‍👦',
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(list([approved]))
      .mockResolvedValueOnce(response({ success: true, data: authoredReply }, 201))
      .mockResolvedValueOnce(list([authoredReply, approved]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <StudioToaster />
        <CommentsPage data={session} onSessionEnded={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByText('A useful comment');
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('A useful comment').closest('blockquote')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('Comment by Reader Name');
    fireEvent.change(within(dialog).getByLabelText('Reply'), {
      target: { value: ' Studio reply\t©😊\u0000\n\n\n👨‍👩‍👧‍👦 ' },
    });
    await user.click(within(dialog).getByRole('button', {
      name: 'Publish reply',
    }));
    expect(await screen.findByText('The Studio reply was published.'))
      .toBeInTheDocument();
    expect(JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)))
      .toMatchObject({
        target_type: 'post',
        target_public_id: comment.target_public_id,
        parent_public_id: comment.public_id,
        content_text: 'Studio reply ©😊\n\n👨‍👩‍👧‍👦',
      });
    const replyButtons = await screen.findAllByRole('button', { name: 'Reply' });
    expect(screen.getByText('In reply to comment #101')).toBeInTheDocument();
    expect(replyButtons[0]).toBeDisabled();
    expect(replyButtons[0]).toHaveAccessibleDescription(
      'This comment is already at the configured reply-depth limit.',
    );
  });
});
