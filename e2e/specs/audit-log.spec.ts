import { expect, test } from '../fixtures/studio-test';
import { signInAsAdministrator } from '../support/journeys';

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
