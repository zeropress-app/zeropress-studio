// @vitest-environment jsdom

import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { CurrentSessionSuccess } from '../../contracts/session';
import { FormsPage } from './FormsPage';
import { changeLocale } from './i18n';

const session: CurrentSessionSuccess['data'] = {
  user: { id: '1'.repeat(32), email: 'owner@example.com', name: 'Owner', roles: ['admin'] },
  session: {
    id: '2'.repeat(32),
    created_at_iso: '2026-08-01T00:00:00.000Z',
    last_seen_at_iso: '2026-08-01T00:00:00.000Z',
    idle_expires_at_iso: '2026-08-01T12:00:00.000Z',
    absolute_expires_at_iso: '2026-08-08T00:00:00.000Z',
    network: { ip_address: '127.0.0.1', asn: null, as_organization: null, country_code: null },
  },
  csrf_token: 'c'.repeat(43),
  edge_integration: { mode: 'enabled', database_state: 'ready' },
};
const form = {
  id: '3'.repeat(32), slug: 'contact', title: 'Contact', description: null,
  status: 'active', submit_label: 'Send', success_message: null,
  fields_count: 0,
  submissions_count: 1, unread_count: 1,
  last_submitted_at_iso: '2026-08-01T00:00:00.000Z',
  created_at_iso: '2026-08-01T00:00:00.000Z',
  updated_at_iso: '2026-08-01T00:00:00.000Z',
} as const;
const submission = {
  id: '4'.repeat(32), form_id: form.id, status: 'unread', summary: 'Hello',
  submitter_email: 'reader@example.com', submitter_name: 'Reader',
  source_url: 'https://example.com/contact', country_code: 'KR',
  submitted_at_iso: '2026-08-01T00:00:00.000Z', read_at_iso: null,
  archived_at_iso: null, created_at_iso: '2026-08-01T00:00:00.000Z',
  updated_at_iso: '2026-08-01T00:00:00.000Z',
} as const;

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
beforeEach(async () => { localStorage.clear(); await changeLocale('en'); });

describe('FormsPage', () => {
  it('uses the Form rail, required-field editor, and User notification recipient', async () => {
    let savedFields: unknown = null;
    const fetchMock = vi.fn().mockImplementation((path: string, init?: RequestInit) => {
      if (path.includes('/submissions?')) return Promise.resolve(json({ success: true, data: { items: [submission], pagination: { page: 1, per_page: 20, total: 1, total_pages: 1 }, status_counts: { all: 1, unread: 1, read: 0, archived: 0, spam: 0 } } }));
      if (path.includes('/notification-settings')) return Promise.resolve(json({
        success: true,
        data: {
          recipient: {
            state: 'available', id: session.user.id,
            name: session.user.name, email: session.user.email,
          },
          mail_configured: false,
          form_updated_at_iso: form.updated_at_iso,
        },
      }));
      if (path.includes('/fields') && init?.method === 'PUT') {
        savedFields = JSON.parse(String(init.body));
        return Promise.resolve(json({
          success: true,
          data: {
            items: [{
              id: '5'.repeat(32),
              form_id: form.id,
              field_key: 'field_1',
              label: 'Message',
              type: 'text',
              required: true,
              placeholder: null,
              help_text: null,
              options: [],
              sort_order: 0,
              status: 'active',
              created_at_iso: form.created_at_iso,
              updated_at_iso: form.updated_at_iso,
            }],
            form_updated_at_iso: form.updated_at_iso,
          },
        }));
      }
      if (path.includes('/fields')) return Promise.resolve(json({ success: true, data: { items: [], form_updated_at_iso: form.updated_at_iso } }));
      if (path === `/api/forms/${form.id}`) return Promise.resolve(json({ success: true, data: { ...form, fields_count: 1 } }));
      return Promise.resolve(json({ success: true, data: { items: [form], pagination: { page: 1, per_page: 10, total: 1, total_pages: 1 } } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<MemoryRouter><FormsPage data={session} onSessionEnded={vi.fn()} /></MemoryRouter>);

    expect(await screen.findByText('reader@example.com')).toBeInTheDocument();
    expect(screen.getByLabelText('Select a Form')).toHaveValue(form.id);
    expect(screen.getByRole('tab', { name: 'Notifications' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([path]) => path === '/api/forms/runtime')).toBe(false);
    await user.click(screen.getByRole('tab', { name: /^Fields/u }));
    expect(await screen.findByText('No fields yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add field' }));
    const editor = screen.getByRole('dialog', { name: 'Add field' });
    await user.type(within(editor).getByLabelText('Label'), 'Message');
    await user.click(within(editor).getByRole('switch', { name: 'Required' }));
    await user.click(within(editor).getByRole('button', { name: 'Add to form' }));
    expect(await screen.findByText('Message')).toBeInTheDocument();
    expect(screen.getByText('Required')).toBeInTheDocument();
    // Unsaved field changes deliberately lock internal view switching.
    expect(screen.getByRole('tab', { name: /^Submissions/u })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(savedFields).toMatchObject({
      fields: [{ field_key: 'field_1', label: 'Message', required: true }],
    }));
    await waitFor(() => expect(
      screen.getByRole('tab', { name: 'Settings' }),
    ).toBeEnabled());
    await user.click(screen.getByRole('tab', { name: 'Notifications' }));
    expect(await screen.findByText('Submission notifications')).toBeInTheDocument();
    expect(screen.getByText(/Mail delivery is not configured/u)).toBeInTheDocument();
    expect(screen.getByText('owner@example.com')).toBeInTheDocument();
  });

  it('uses an in-app destructive confirmation and keeps a failed deletion open', async () => {
    let deletionCalls = 0;
    const fetchMock = vi.fn().mockImplementation((path: string, init?: RequestInit) => {
      if (path.includes('/submissions?')) return Promise.resolve(json({ success: true, data: { items: [submission], pagination: { page: 1, per_page: 20, total: 1, total_pages: 1 }, status_counts: { all: 1, unread: 1, read: 0, archived: 0, spam: 0 } } }));
      if (init?.method === 'DELETE') { deletionCalls += 1; return Promise.resolve(json({ success: false, error: { code: 'VALIDATION_ERROR' } })); }
      return Promise.resolve(json({ success: true, data: { items: [form], pagination: { page: 1, per_page: 10, total: 1, total_pages: 1 } } }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(<MemoryRouter><FormsPage data={session} onSessionEnded={vi.fn()} /></MemoryRouter>);
    await screen.findByText('reader@example.com');
    await user.click(screen.getByRole('button', { name: 'Delete permanently' }));
    expect(deletionCalls).toBe(0);
    const dialog = screen.getByRole('dialog', { name: 'Delete this submission permanently?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete permanently' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Review the Form values and try again.');
    expect(deletionCalls).toBe(1);
    expect(dialog).toBeInTheDocument();
  });
});
