import { expect, test } from '../fixtures/studio-test';
import { createTotpCode } from '../support/totp.mjs';

test.use({ studioProfile: 'operational' });

test('rejects invalid credentials and preserves an authenticated session', async ({
  page,
  studioRuntime,
}) => {
  const admin = studioRuntime.credentials.admin;
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to Studio' }))
    .toBeVisible();
  await page.getByLabel('Email').fill(admin.email);
  await page.getByRole('textbox', { name: 'Password' })
    .fill(`${admin.password}-wrong`);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByText('The email or password is incorrect.'))
    .toBeVisible();

  await page.getByRole('textbox', { name: 'Password' }).fill(admin.password);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verify your identity' }))
    .toBeVisible();

  const currentCode = createTotpCode(admin.totpSecret);
  await page.getByLabel('Six-digit code')
    .fill(currentCode === '000000' ? '000001' : '000000');
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByText(
    'The MFA code is invalid, expired, or has already been used.',
  )).toBeVisible();

  await page.getByLabel('Six-digit code').fill(currentCode);
  await page.getByRole('button', { name: 'Verify and sign in' }).click();
  await expect(page.getByRole('heading', {
    level: 1,
    name: 'Dashboard',
  })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', {
    level: 1,
    name: 'Dashboard',
  })).toBeVisible();

  await page.getByRole('button', {
    name: `Open account menu for ${admin.name}`,
  }).click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign out of Studio?' }))
    .toBeVisible();
  await page.getByRole('dialog').getByRole('button', {
    name: 'Sign out',
    exact: true,
  }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Studio' }))
    .toBeVisible();
  expect(pageErrors).toEqual([]);
});
