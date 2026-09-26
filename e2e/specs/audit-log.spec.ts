import { expect, test } from '../fixtures/studio-test';
import { signInAsAdministrator } from '../support/journeys';
import type { AuditLogDetail } from '../../contracts/audit-logs';

test.use({ studioProfile: 'operational' });

test('records a real local sign-in and supports audit details, filtering and a mobile layout', async ({
  page,
  studioRuntime,
}) => {
  const startedAt = new Date().toISOString();
  await signInAsAdministrator(page, studioRuntime);
  await page.getByRole('navigation', { name: 'Studio navigation' })
    .getByRole('link', { name: 'Audit Log' }).click();
  await expect(page.getByRole('heading', { name: 'Audit Log', level: 1 })).toBeVisible();

  // Background writes can finish after the response. Check this sign-in, not a seeded record.
  await expect(async () => {
    // Use Chromium's localhost cookie handling for the __Host- Secure session.
    const { status, body } = await page.evaluate(async (from) => {
      const response = await fetch(`/api/audit-logs?from=${encodeURIComponent(from)}`, {
        credentials: 'same-origin', cache: 'no-store',
      });
      return { status: response.status, body: await response.json() };
    }, startedAt);
    expect({ status, code: body.error?.code }).toEqual({ status: 200, code: undefined });
    expect(body.data.items).toContainEqual(expect.objectContaining({
      action: 'auth_login',
      actor: expect.objectContaining({ email: studioRuntime.credentials.admin.email }),
    }));
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'Signed in', exact: true }).first()).toBeVisible();
  }).toPass({ timeout: 15_000 });

  const signInRow = page.getByRole('row').filter({
    has: page.getByRole('cell', { name: 'Signed in', exact: true }),
  }).first();
  await signInRow.getByRole('button', { name: /^Record details:/ }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Record details' });
  await expect(dialog.getByText(studioRuntime.credentials.admin.email)).toBeVisible();
  await expect(dialog.getByText('totp', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Show records from this IP' }).click();
  await expect(page.getByText('Filtering by IP hash:')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Audit Log', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByLabel('Name or email').fill('not-an-existing-actor');
  await page.getByRole('button', { name: 'Apply filters' }).click();
  await expect(page.getByText('No matching records')).toBeVisible();
});

test('browses a grouped rebuild and its individual callers on mobile with keyboard controls', async ({ page, studioRuntime }) => {
  const start: AuditLogDetail = {
    id: 'synthetic-start', occurred_at: '2026-09-26T01:00:00.000Z', action: 'operations_search', category: 'operations', outcome: 'success',
    actor: { kind: 'user', id: 'synthetic-admin', name: 'Rebuild owner with a name that spans multiple lines on a narrow screen', email: 'rebuild@example.test' },
    target: { type: 'DB', id: null, label: null }, metadata: { operation_id: 'synthetic-operation', stage: 'started' },
    network: { ip_address: '192.0.2.1', ip_recorded_at: '2026-09-26T01:00:00.000Z', ip_hash: `v1.${'a'.repeat(64)}`,
      user_agent: 'Synthetic browser', country: null, region: null, city: null, timezone: null, asn: null, organization: null },
  };
  const completed: AuditLogDetail = { ...start, id: 'synthetic-completed', occurred_at: '2026-09-26T01:01:00.000Z',
    actor: { kind: 'operations', id: null, name: 'Operations token', email: null },
    metadata: { ...start.metadata, stage: 'completed', search_phase: 'verify', processed_posts: 6, processed_pages: 1, total_posts: 6, total_pages: 1, initiator: start.actor },
    network: { ...start.network, ip_address: '192.0.2.2' },
  };
  await page.route('**/api/audit-logs**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: { success: true, data: path.endsWith('/events') ? { items: [completed, start], next_cursor: null }
      : path.endsWith(start.id) ? start : path.endsWith(completed.id) ? completed
      : { items: [{ ...completed, event_count: 2 }], next_cursor: null } } });
  });
  await signInAsAdministrator(page, studioRuntime);
  await page.goto('/audit-logs');
  await page.setViewportSize({ width: 390, height: 844 });
  const row = page.getByRole('row').filter({ hasText: 'Search index rebuild' });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Studio database');
  await expect(row).toContainText('2 step records');
  await row.getByRole('button').focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Record details' });
  const steps = dialog.getByRole('region', { name: 'Operation steps' });
  await expect(dialog.getByText('192.0.2.2', { exact: true })).toBeVisible();
  const first = steps.getByRole('button', { name: /Started/ });
  await first.focus();
  await page.keyboard.press('Enter');
  await expect(first).toHaveAttribute('aria-pressed', 'true');
  await expect(first).toHaveCSS('outline-width', '3px');
  await expect(dialog.getByText('rebuild@example.test', { exact: true })).toBeVisible();
  await expect(dialog.getByText('192.0.2.1', { exact: true })).toBeVisible();
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(row.getByRole('button')).toBeFocused();
});
