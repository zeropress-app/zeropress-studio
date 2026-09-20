import type { Response } from '@playwright/test';
import { expect, test } from '../fixtures/studio-test';
import { createTotpCode } from '../support/totp.mjs';

test.use({ studioProfile: 'installation' });

function hasPath(response: Response, path: string): boolean {
  return new URL(response.url()).pathname === path;
}

test('installs Studio through token, administrator, and MFA steps', async ({
  page,
  studioRuntime,
}) => {
  const installToken = studioRuntime.credentials.installToken;
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await page.goto('/');
  await expect(page.getByRole('heading', {
    name: 'Verify the install token',
  })).toBeVisible();

  await page.getByLabel('Install token').fill(`wrong-${installToken}`);
  await page.getByRole('button', { name: 'Continue to installation' })
    .click();
  await expect(page.getByText('The install token is incorrect.'))
    .toBeVisible();

  await page.getByLabel('Install token').fill(installToken);
  const accessResponse = page.waitForResponse((response) => (
    hasPath(response, '/api/system/install/access')
    && response.request().headers().authorization !== undefined
  ));
  await page.getByRole('button', { name: 'Continue to installation' })
    .click();
  const access = await accessResponse;
  expect(access.status()).toBe(200);
  expect(access.request().headers().authorization)
    .toBe(`Bearer ${installToken}`);

  await expect(page.getByRole('heading', {
    level: 1,
    name: 'Open-source license',
  })).toBeVisible();
  await expect(page.getByRole('link', { name: /View LICENSE on GitHub/u }))
    .toHaveAttribute('target', '_blank');

  const tokenPersisted = await page.evaluate((token) => (
    [...Object.values(localStorage), ...Object.values(sessionStorage)]
      .includes(token)
  ), installToken);
  expect(tokenPersisted).toBe(false);

  await page.reload();
  await expect(page.getByRole('heading', {
    name: 'Verify the install token',
  })).toBeVisible();
  await page.getByLabel('Install token').fill(installToken);
  await page.getByRole('button', { name: 'Continue to installation' })
    .click();

  await page.getByRole('button', {
    name: 'Continue to administrator setup',
  }).click();
  await expect(page.getByRole('heading', {
    level: 1,
    name: 'Create the first administrator',
  })).toBeVisible();
  await page.getByLabel('Administrator name')
    .fill(studioRuntime.credentials.admin.name);
  await page.getByLabel('Administrator email')
    .fill(studioRuntime.credentials.admin.email);
  await page.getByLabel('Administrator password')
    .fill(studioRuntime.credentials.admin.password);
  await page.getByLabel('Confirm password')
    .fill(studioRuntime.credentials.admin.password);

  const mfaSetupResponse = page.waitForResponse((response) => (
    hasPath(response, '/api/system/install/mfa/setup')
    && response.status() === 200
  ));
  const continueToMfa = page.getByRole('button', {
    name: 'Continue to MFA setup',
  });
  await expect(continueToMfa).toBeEnabled();
  await continueToMfa.click();
  const setupPayload = await (await mfaSetupResponse).json() as {
    data: { secret: string };
  };

  await expect(page.getByRole('heading', {
    level: 1,
    name: 'Set up multi-factor authentication',
  })).toBeVisible();
  await expect(page.getByText(setupPayload.data.secret, { exact: true }))
    .toBeVisible();
  const enrollment = page.locator('.auth-enrollment-account');
  await expect(enrollment).toContainText(`${new URL(page.url()).hostname} · Studio`);
  await expect(enrollment).toContainText(studioRuntime.credentials.admin.email);
  await expect(page.getByRole('img', { name: 'Authenticator setup QR code' }))
    .toBeVisible();
  await page.getByLabel('Current 6-digit authenticator code')
    .fill(createTotpCode(setupPayload.data.secret));

  const installResponse = page.waitForResponse((response) => (
    hasPath(response, '/api/system/install')
    && response.request().method() === 'POST'
  ));
  await page.getByRole('button', { name: 'Install ZeroPress Studio' })
    .click();
  const completed = await installResponse;
  expect(completed.status()).toBe(201);
  expect(completed.request().headers().authorization)
    .toBe(`Bearer ${installToken}`);

  await expect(page.getByRole('heading', {
    level: 1,
    name: 'Installation is complete',
  })).toBeVisible();
  const finalization = page.getByRole('region', {
    name: 'Enable Studio sign-in',
  });
  await expect(finalization.getByRole('listitem')).toHaveCount(3);
  await expect(finalization).toContainText('STUDIO_INSTALL_TOKEN');
  await expect(finalization).toContainText('STUDIO_SITE_MODE');
  expect(pageErrors).toEqual([]);
});
