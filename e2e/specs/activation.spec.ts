import type { Response } from '@playwright/test';
import { expect, test } from '../fixtures/studio-test';
import { createTotpCode } from '../support/totp.mjs';

test.use({ studioProfile: 'activation' });

function isSetupResponse(response: Response, suffix: string): boolean {
  return new URL(response.url()).pathname
    === `/api/auth/account-setup/${suffix}`;
}

test('rejects missing and invalid account setup tokens', async ({ page }) => {
  await page.goto('/activate');
  await expect(page.getByRole('heading', {
    name: 'This setup link cannot be used',
  })).toBeVisible();

  await page.goto(`/activate#${new URLSearchParams({
    token: `${'0'.repeat(32)}.${'A'.repeat(43)}`,
  }).toString()}`);
  await expect(page.getByRole('heading', {
    name: 'This setup link cannot be used',
  })).toBeVisible();
});

test('activates an invited account without persisting its bearer token', async ({
  page,
  studioRuntime,
}) => {
  const invitation = studioRuntime.credentials.invitation;
  const setupUrl = new URL(invitation.setupUrl);
  const activationPath = `/activate${setupUrl.hash}`;

  await page.goto(activationPath);
  await expect(page.getByRole('heading', {
    name: 'Activate your Studio account',
  })).toBeVisible();
  await expect(page.getByText(invitation.email, { exact: false }))
    .toBeVisible();
  await expect(page.getByRole('navigation', {
    name: 'Account setup progress',
  })).toBeVisible();
  await expect(page.getByText('Password setup').locator('..'))
    .toHaveAttribute('aria-current', 'step');
  const expiry = page.locator('time[datetime]').first();
  const expiresAt = await expiry.getAttribute('datetime');
  if (!expiresAt) {
    throw new Error('Activation expiry datetime is missing.');
  }
  const expectedDate = await page.evaluate((iso) => (
    new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso))
  ), expiresAt);
  await expect(expiry).toContainText(expectedDate);

  await page.reload();
  await expect(page.getByRole('heading', {
    name: 'This setup link cannot be used',
  })).toBeVisible();
  const setupToken = new URLSearchParams(setupUrl.hash.slice(1)).get('token');
  expect(setupToken).not.toBeNull();
  const tokenPersisted = await page.evaluate((token) => (
    [...Object.values(localStorage), ...Object.values(sessionStorage)]
      .includes(token)
  ), setupToken);
  expect(tokenPersisted).toBe(false);

  // The hash bearer is intentionally removed from the address bar. Reopening
  // the original one-time link is required after a reload.
  await page.goto('/');
  await page.goto(activationPath);
  await expect(page.getByRole('heading', {
    name: 'Activate your Studio account',
  })).toBeVisible();

  await page.getByRole('textbox', { name: 'Password', exact: true })
    .fill(invitation.password);
  await page.getByRole('textbox', { name: 'Confirm password' })
    .fill(invitation.password);
  await page.getByRole('button', { name: 'Show password' }).click();
  await expect(page.getByLabel('Password', { exact: true }))
    .toHaveAttribute('type', 'text');
  await expect(page.getByLabel('Confirm password'))
    .toHaveAttribute('type', 'text');
  const setupResponse = page.waitForResponse((response) => (
    isSetupResponse(response, 'setup') && response.status() === 200
  ));
  const continueButton = page.getByRole('button', { name: 'Continue to MFA' });
  await expect(continueButton).toBeEnabled();
  await continueButton.click();
  const setup = await (await setupResponse).json() as {
    data: { secret: string };
  };

  await expect(page.getByText(setup.data.secret, { exact: true }))
    .toBeVisible();
  await expect(page.getByText('MFA setup').locator('..'))
    .toHaveAttribute('aria-current', 'step');
  await page.getByLabel('Current 6-digit authenticator code')
    .fill(createTotpCode(setup.data.secret));
  const completeResponse = page.waitForResponse((response) => (
    isSetupResponse(response, 'complete')
    && response.request().method() === 'POST'
  ));
  await page.getByRole('button', { name: 'Activate account' }).click();
  expect((await completeResponse).status()).toBe(200);

  await expect(page.getByRole('heading', {
    name: 'Your Studio account is active',
  })).toBeVisible();
  await page.getByRole('link', { name: 'Go to sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to Studio' }))
    .toBeVisible();
});
