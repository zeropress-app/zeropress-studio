import { expect, test } from '../fixtures/studio-test';
import { signInAsAdministrator } from '../support/journeys';

// WebAuthn RP IDs must be hostnames; the harness's default IP URL is unsuitable.
test.use({ studioProfile: 'operational', baseURL: 'http://localhost:4199' });

test('restricts new registrations while preserving an existing passkey login and deletion', async ({ page, context, studioRuntime }) => {
  test.setTimeout(90_000);
  const unexpected: string[] = [];
  await context.route(/^https:\/\/(?:mds\.fidoalliance\.org|api\.github\.com|raw\.githubusercontent\.com)\//, async (route) => {
    unexpected.push(route.request().url()); await route.abort();
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  let { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  } });
  // The operational profile enables English only by default. This display-only
  // fixture enables both bundled locales without changing site settings.
  await page.route('**/api/system/interface-config', (route) => route.fulfill({ json: {
    success: true, data: { default_locale: 'en', enabled_locales: ['en', 'ko'] },
  } }));
  const admin = studioRuntime.credentials.admin;
  try {
    await signInAsAdministrator(page, studioRuntime);
    await page.goto('/my-account/security/passkeys');
    await page.getByRole('button', { name: 'Add passkey', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Credential name').fill('Synthetic existing passkey');
    await dialog.getByLabel('Current password').fill(admin.password);
    await dialog.getByRole('button', { name: 'Register passkey', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Synthetic existing passkey' })).toBeVisible();
    await expect(page.getByText('Not verified', { exact: true })).toBeVisible();

    await page.goto('/settings/site/security');
    const policy = page.getByRole('switch', { name: 'Only allow authenticators with verified FIDO certification' });
    await expect(policy).not.toBeChecked();
    await policy.focus(); await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'Save security policy' }).click();
    await dialog.getByLabel('Current password').fill(admin.password);
    await dialog.getByRole('button', { name: 'Save security policy' }).click();
    await expect(page.getByText('Passkey registration policy saved.')).toBeVisible();

    await page.getByRole('button', { name: `Open account menu for ${admin.name}` }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await dialog.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to Studio' })).toBeVisible();
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();

    // Use a different authenticator: the original correctly rejects another
    // registration because its existing credential is in excludeCredentials.
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    ({ authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
      protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true,
      isUserVerified: true, automaticPresenceSimulation: true,
    } }));
    await page.goto('/my-account/security/passkeys');
    await page.getByRole('button', { name: 'Add passkey', exact: true }).click();
    await expect(dialog.getByText('New passkeys require a FIDO-certified model and verified attestation. Existing passkeys continue to work.')).toBeVisible();
    await dialog.getByLabel('Credential name').fill('Rejected new passkey');
    await dialog.getByLabel('Current password').fill(admin.password);
    await dialog.getByRole('button', { name: 'Register passkey', exact: true }).click();
    await expect(dialog.getByText('The bundled metadata cannot confirm this model’s certification. Use another authenticator.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Rejected new passkey' })).toHaveCount(0);

    await page.getByRole('button', { name: 'Remove', exact: true }).click();
    await dialog.getByLabel('Current password').fill(admin.password);
    await dialog.getByRole('button', { name: 'Remove credential', exact: true }).click();
    await expect(page.getByText('No passkeys registered', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: `Open account menu for ${admin.name}` }).click();
    await page.getByRole('link', { name: 'Studio preferences' }).click();
    await page.getByLabel('Studio interface language').selectOption('ko');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/settings/site/security');
    await expect(page.getByRole('switch', { name: 'FIDO 인증이 확인된 인증기만 등록 허용' })).toBeChecked();
    await expect(page.getByText('모든 사용자의 신규 등록에 적용합니다. 기존 패스키는 계속 사용할 수 있습니다.')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(unexpected).toEqual([]);
  } finally {
    await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
    await cdp.detach();
  }
});
