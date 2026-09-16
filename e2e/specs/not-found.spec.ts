import { expect, test } from '../fixtures/studio-test';
import { signInAsAdministrator } from '../support/journeys';

test.use({ studioProfile: 'operational' });

test('renders an authenticated unknown route inside the Studio shell', async ({
  page,
  studioRuntime,
}) => {
  await signInAsAdministrator(page, studioRuntime);
  await page.goto('/this-route-does-not-exist');

  await expect(page.getByRole('heading', {
    level: 1,
    name: 'Page not found',
  })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Studio navigation' }))
    .toBeVisible();
  await page.getByRole('link', { name: 'Return to Dashboard' }).click();
  await expect(page.getByRole('heading', {
    level: 1,
    name: 'Dashboard',
  })).toBeVisible();
});
