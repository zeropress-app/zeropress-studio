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
import { NewslettersPage } from './NewslettersPage';
import { changeLocale } from './i18n';

const session: CurrentSessionSuccess['data'] = {
  user: {
    id: '1'.repeat(32),
    email: 'owner@example.com',
    name: 'Owner',
    roles: ['admin'],
  },
  session: {
    id: '2'.repeat(32),
    created_at_iso: '2026-08-01T00:00:00.000Z',
    last_seen_at_iso: '2026-08-01T00:00:00.000Z',
    idle_expires_at_iso: '2026-08-01T12:00:00.000Z',
    absolute_expires_at_iso: '2026-08-08T00:00:00.000Z',
    network: {
      ip_address: '127.0.0.1',
      asn: null,
      as_organization: null,
      country_code: null,
    },
  },
  csrf_token: 'c'.repeat(43),
  edge_integration: { mode: 'enabled', database_state: 'ready' },
};

function json(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
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

describe('NewslettersPage', () => {
  it('manages only the default subscription channel while preserving multi-slug data', async () => {
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/newsletters/runtime') {
        return Promise.resolve(json({
          success: true,
          data: {
            confirmation_enabled: false,
            mail_configured: false,
            ready: false,
            updated_at_iso: '2026-08-01T00:00:00.000Z',
          },
        }));
      }
      if (path.includes('/fields')) {
        return Promise.resolve(json({
          success: true,
          data: {
            items: [],
            newsletter_updated_at_iso: '2026-08-01T00:00:00.000Z',
          },
        }));
      }
      return Promise.resolve(json({
        success: true,
        data: {
          items: [
            {
              id: '3'.repeat(32),
              slug: 'default',
              title: 'Product updates',
              description: 'Release notes',
              status: 'active',
              fields_count: 0,
              subscriptions_count: 2,
              pending_count: 1,
              subscribed_count: 1,
              unsubscribed_count: 0,
              created_at_iso: '2026-08-01T00:00:00.000Z',
              updated_at_iso: '2026-08-01T00:00:00.000Z',
            },
            {
              id: '5'.repeat(32),
              slug: 'monthly-digest',
              title: 'Monthly digest',
              description: null,
              status: 'archived',
              fields_count: 2,
              subscriptions_count: 2,
              pending_count: 0,
              subscribed_count: 2,
              unsubscribed_count: 0,
              created_at_iso: '2026-07-01T00:00:00.000Z',
              updated_at_iso: '2026-07-02T00:00:00.000Z',
            },
          ],
          pagination: { page: 1, per_page: 100, total: 2, total_pages: 1 },
        },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <NewslettersPage data={session} onSessionEnded={vi.fn()} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', { name: 'Subscription settings' }))
      .toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Product updates' }))
      .toBeInTheDocument();
    expect(screen.queryByText('Monthly digest')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Newsletter list' }))
      .not.toBeInTheDocument();
    const summary = screen.getByLabelText('Newsletter subscription summary');
    expect(screen.getAllByText('1', {
      selector: '.newsletter-metrics dd',
    })).toHaveLength(2);
    expect(within(summary).getAllByText('0', { selector: 'dd' }))
      .toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('search=default'),
      expect.any(Object),
    );

    await user.click(screen.getByRole('tab', { name: 'Runtime' }));
    expect(screen.getByText('Mail delivery is not configured'))
      .toBeInTheDocument();
    expect(screen.getByRole('switch', {
      name: /^Enable confirmation delivery/u,
    })).toBeDisabled();

    await user.click(screen.getByRole('tab', { name: 'Signup fields' }));
    expect(await screen.findByText('No custom fields')).toBeInTheDocument();
    const systemEmailField = screen.getByRole('article', { name: 'Email' });
    expect(within(systemEmailField).getByText('Protected')).toBeInTheDocument();
    expect(within(systemEmailField).getByDisplayValue('email')).toHaveAttribute('readonly');
    expect(within(systemEmailField).getByDisplayValue('Email address')).toHaveAttribute('readonly');
    expect(within(systemEmailField).getByRole('checkbox', { name: 'Required' }))
      .toBeChecked();
    expect(within(systemEmailField).getByRole('checkbox', { name: 'Required' }))
      .toBeDisabled();
    expect(screen.getByText('0 of 50 custom field definitions')).toBeInTheDocument();
    const addField = screen.getByRole('button', { name: 'Add field' });
    expect(addField).toBeEnabled();
    await user.click(addField);
    await user.click(addField);
    expect(screen.getByText('2 of 50 custom field definitions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move field_2 up' })).toBeEnabled();
    expect(screen.getAllByRole('button', { name: 'Remove draft' })).toHaveLength(2);
    await user.click(screen.getAllByRole('button', { name: 'Remove draft' })[1]!);
    expect(screen.getAllByRole('button', { name: 'Remove draft' })).toHaveLength(1);
  });

  it('fails closed when the canonical default Newsletter is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((path: string) => (
      Promise.resolve(json(path === '/api/newsletters/runtime'
        ? {
            success: true,
            data: {
              confirmation_enabled: false,
              mail_configured: false,
              ready: false,
              updated_at_iso: '2026-08-01T00:00:00.000Z',
            },
          }
        : {
            success: true,
            data: {
              items: [{
                id: '5'.repeat(32),
                slug: 'default-digest',
                title: 'Default digest',
                description: null,
                status: 'active',
                fields_count: 0,
                subscriptions_count: 0,
                pending_count: 0,
                subscribed_count: 0,
                unsubscribed_count: 0,
                created_at_iso: '2026-08-01T00:00:00.000Z',
                updated_at_iso: '2026-08-01T00:00:00.000Z',
              }],
              pagination: {
                page: 1,
                per_page: 100,
                total: 1,
                total_pages: 1,
              },
            },
          }))
    )));

    render(
      <MemoryRouter>
        <NewslettersPage data={session} onSessionEnded={vi.fn()} />
      </MemoryRouter>,
    );

    expect(await screen.findByRole('heading', {
      name: 'The default Newsletter is unavailable',
    })).toBeInTheDocument();
    expect(screen.queryByText('Default digest')).not.toBeInTheDocument();
  });

  it('opens and combines a route-provided Post delivery filter with the existing filters', async () => {
    const newsletterId = '3'.repeat(32);
    const postId = '7'.repeat(32);
    const timestamp = '2026-09-03T00:00:00.000Z';
    const fetchMock = vi.fn().mockImplementation((path: string) => {
      if (path === '/api/newsletters/runtime') {
        return Promise.resolve(json({
          success: true,
          data: {
            confirmation_enabled: true,
            mail_configured: true,
            ready: true,
            updated_at_iso: timestamp,
          },
        }));
      }
      if (path.includes(`/${newsletterId}/deliveries?`)) {
        return Promise.resolve(json({
          success: true,
          data: {
            items: [{
              id: '4'.repeat(32),
              newsletter_id: newsletterId,
              subscription_id: '5'.repeat(32),
              email: 'reader@example.com',
              delivery_type: 'post_notification',
              content_id: postId,
              subject: 'New post: Release notes',
              provider: 'resend',
              status: 'failed',
              attempt_count: 2,
              failure_code: 'MAIL_PROVIDER_UNAVAILABLE',
              queued_at_iso: timestamp,
              last_attempt_at_iso: timestamp,
              sent_at_iso: null,
              created_at_iso: timestamp,
              updated_at_iso: timestamp,
            }],
            pagination: {
              page: 1,
              per_page: 20,
              total: 1,
              total_pages: 1,
            },
          },
        }));
      }
      return Promise.resolve(json({
        success: true,
        data: {
          items: [{
            id: newsletterId,
            slug: 'default',
            title: 'Product updates',
            description: null,
            status: 'active',
            fields_count: 0,
            subscriptions_count: 1,
            pending_count: 1,
            subscribed_count: 0,
            unsubscribed_count: 0,
            created_at_iso: timestamp,
            updated_at_iso: timestamp,
          }],
          pagination: { page: 1, per_page: 100, total: 1, total_pages: 1 },
        },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={[
        `/newsletters?tab=deliveries&content_id=${postId}`,
      ]}>
        <NewslettersPage data={session} onSessionEnded={vi.fn()} />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Product updates' });
    expect(screen.getByRole('tab', { name: 'Delivery history' }))
      .toHaveAttribute('aria-selected', 'true');

    const table = await screen.findByRole('table', { name: 'Delivery history' });
    expect(table).toHaveClass('studio-table-stacked-compact');
    const recipient = within(table).getByText('reader@example.com');
    expect(recipient.closest('td')).toHaveAttribute('data-stack', 'primary');
    expect(within(table).getByText('Post notification'))
      .toBeInTheDocument();
    expect(within(table).getByText('Failed')).toBeInTheDocument();
    expect(within(table).getByText('MAIL_PROVIDER_UNAVAILABLE'))
      .toBeInTheDocument();
    const postFilter = screen.getByRole('searchbox', { name: 'Post ID' });
    expect(postFilter).toHaveValue(postId);
    await waitFor(() => {
      const initialDeliveryCall = fetchMock.mock.calls.find(([path]) => {
        const url = new URL(String(path), 'https://studio.local');
        return url.pathname.endsWith(`/${newsletterId}/deliveries`)
          && url.searchParams.get('content_id') === postId;
      });
      expect(initialDeliveryCall).toBeDefined();
    });

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Status' }),
      'sent',
    );
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Email type' }),
      'post_notification',
    );
    await user.type(
      screen.getByRole('searchbox', { name: 'Recipient email prefix' }),
      'reader@',
    );
    await user.click(screen.getByRole('button', { name: 'Search' }));

    await waitFor(() => {
      const combinedCall = fetchMock.mock.calls.find(([path]) => {
        const url = new URL(String(path), 'https://studio.local');
        return url.pathname.endsWith(`/${newsletterId}/deliveries`)
          && url.searchParams.get('status') === 'sent'
          && url.searchParams.get('type') === 'post_notification'
          && url.searchParams.get('content_id') === postId
          && url.searchParams.get('search') === 'reader@';
      });
      expect(combinedCall).toBeDefined();
    });
  });

  it('requires an in-app confirmation and keeps a failed delete open', async () => {
    let deleteCalls = 0;
    const list = {
      id: '3'.repeat(32),
      slug: 'default',
      title: 'Product updates',
      description: null,
      status: 'active',
      fields_count: 0,
      subscriptions_count: 1,
      pending_count: 0,
      subscribed_count: 1,
      unsubscribed_count: 0,
      created_at_iso: '2026-08-01T00:00:00.000Z',
      updated_at_iso: '2026-08-01T00:00:00.000Z',
    };
    const fetchMock = vi.fn().mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/newsletters/runtime') {
        return Promise.resolve(json({
          success: true,
          data: {
            confirmation_enabled: false,
            mail_configured: true,
            ready: false,
            updated_at_iso: list.updated_at_iso,
          },
        }));
      }
      if (path.includes('/subscriptions?')) {
        return Promise.resolve(json({
          success: true,
          data: {
            items: [{
              id: '4'.repeat(32),
              newsletter_id: list.id,
              email: 'reader@example.com',
              status: 'subscribed',
              confirmation_status: 'sent',
              confirm_sent_at_iso: list.created_at_iso,
              confirmed_at_iso: list.created_at_iso,
              subscribed_at_iso: list.created_at_iso,
              unsubscribed_at_iso: null,
              source_url: null,
              country_code: null,
              created_at_iso: list.created_at_iso,
              updated_at_iso: list.updated_at_iso,
            }],
            pagination: { page: 1, per_page: 20, total: 1, total_pages: 1 },
          },
        }));
      }
      if (init?.method === 'DELETE') {
        deleteCalls += 1;
        return Promise.resolve(json({
          success: false,
          error: { code: 'VALIDATION_ERROR' },
        }));
      }
      return Promise.resolve(json({
        success: true,
        data: {
          items: [list],
          pagination: { page: 1, per_page: 100, total: 1, total_pages: 1 },
        },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <NewslettersPage data={session} onSessionEnded={vi.fn()} />
      </MemoryRouter>,
    );
    await screen.findByRole('heading', { name: 'Subscription settings' });
    await user.click(screen.getByRole('tab', { name: 'Subscribers' }));
    await screen.findByText('reader@example.com');
    const subscriberTable = screen.getByRole('table', { name: 'Subscribers' });
    expect(subscriberTable).toHaveClass('studio-table-stacked-compact');
    expect(within(subscriberTable).getByText('reader@example.com').closest('td'))
      .toHaveAttribute('data-stack', 'primary');
    await user.click(screen.getByRole('button', {
      name: 'Actions for reader@example.com',
    }));
    await user.click(screen.getByRole('menuitem', {
      name: 'Delete permanently',
    }));
    expect(deleteCalls).toBe(0);
    const dialog = screen.getByRole('dialog', {
      name: 'Delete this subscription permanently?',
    });
    await user.click(within(dialog).getByRole('button', {
      name: 'Delete permanently',
    }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Review the Newsletter values and try again.',
    );
    expect(deleteCalls).toBe(1);
    expect(dialog).toBeInTheDocument();
  });

  it('confirms a global suppression before it unsubscribes matching records', async () => {
    let createCalls = 0;
    const list = {
      id: '3'.repeat(32),
      slug: 'default',
      title: 'Product updates',
      description: null,
      status: 'active',
      fields_count: 0,
      subscriptions_count: 0,
      pending_count: 0,
      subscribed_count: 0,
      unsubscribed_count: 0,
      created_at_iso: '2026-08-01T00:00:00.000Z',
      updated_at_iso: '2026-08-01T00:00:00.000Z',
    };
    const fetchMock = vi.fn().mockImplementation((path: string, init?: RequestInit) => {
      if (path === '/api/newsletters/runtime') {
        return Promise.resolve(json({
          success: true,
          data: {
            confirmation_enabled: false,
            mail_configured: true,
            ready: false,
            updated_at_iso: list.updated_at_iso,
          },
        }));
      }
      if (path.includes('/suppressions?')) {
        return Promise.resolve(json({
          success: true,
          data: {
            items: [],
            pagination: { page: 1, per_page: 20, total: 0, total_pages: 0 },
          },
        }));
      }
      if (path === '/api/newsletters/suppressions' && init?.method === 'POST') {
        createCalls += 1;
        return Promise.resolve(json({
          success: false,
          error: { code: 'VALIDATION_ERROR' },
        }));
      }
      return Promise.resolve(json({
        success: true,
        data: {
          items: [list],
          pagination: { page: 1, per_page: 100, total: 1, total_pages: 1 },
        },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <NewslettersPage data={session} onSessionEnded={vi.fn()} />
      </MemoryRouter>,
    );

    await screen.findByRole('heading', { name: 'Subscription settings' });
    await user.click(screen.getByRole('tab', { name: 'Suppressions' }));
    await screen.findByRole('heading', { name: 'Global suppressions' });
    await user.type(screen.getByLabelText('Email'), 'blocked@example.com');
    await user.click(screen.getByRole('button', { name: 'Add suppression' }));
    expect(createCalls).toBe(0);

    const dialog = screen.getByRole('dialog', {
      name: 'Add this global suppression?',
    });
    await user.click(within(dialog).getByRole('button', {
      name: 'Add suppression',
    }));
    expect(createCalls).toBe(1);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Review the Newsletter values and try again.',
    );
    expect(dialog).toBeInTheDocument();
  });
});
