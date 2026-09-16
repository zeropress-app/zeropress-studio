import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../fixtures/studio-test';

type ConfigurationState = 'Configured' | 'Invalid' | 'Not set';

async function configurationRegion(
  page: Page,
  name: 'STUDIO_AUTH_SECRET' | 'STUDIO_INSTALL_TOKEN' | 'STUDIO_SITE_MODE',
): Promise<Locator> {
  const region = page.getByRole('region', { name });
  await expect(region).toBeVisible();
  await expect(region).toContainText(name);
  return region;
}

async function expectConfigurationState(
  region: Locator,
  state: ConfigurationState,
): Promise<void> {
  const status = region.getByText(state, { exact: true });
  await expect(status).toBeVisible();
  await expect(status).toHaveClass(
    state === 'Configured'
      ? /studio-pill-positive/u
      : state === 'Invalid'
        ? /studio-pill-critical/u
        : /studio-pill-attention/u,
  );
}

async function expectSiteModeRequirement(
  page: Page,
  state: Exclude<ConfigurationState, 'Configured'>,
): Promise<void> {
  await expect(page.locator('.standalone-status'))
    .toHaveClass(/standalone-status-wide/u);
  await expect(page.locator('.standalone-status'))
    .toHaveCSS('width', '760px');
  const siteMode = await configurationRegion(page, 'STUDIO_SITE_MODE');
  await expect(siteMode.getByText('Plain variable', { exact: true }))
    .toBeVisible();
  await expectConfigurationState(siteMode, state);
  await expect(siteMode).toHaveClass(/auth-secret-requirement-compact/u);

  const retry = page.getByRole('button', {
    name: 'Check configuration again',
  });
  await expect(retry).toBeVisible();
  await expect(retry.locator('.lucide-refresh-cw')).toBeVisible();
}

async function expectInstallationSetup(page: Page): Promise<{
  authSecret: Locator;
  installToken: Locator;
}> {
  await expect(page.getByRole('heading', {
    name: 'Complete the installation setup',
  })).toBeVisible();
  await expect(page.getByText(
    'Complete the remaining Worker setting, redeploy, then check the setup again.',
  )).toBeVisible();
  await expect(page.getByRole('region', {
    name: 'Installation Worker settings',
  })).toBeVisible();

  const siteMode = await configurationRegion(page, 'STUDIO_SITE_MODE');
  await expectConfigurationState(siteMode, 'Configured');
  await expect(siteMode.getByText('Plain variable', { exact: true }))
    .toBeVisible();
  await expect(siteMode.getByText(
    'The initial installation mode is active.',
  )).toBeVisible();

  const storageGuidance = page.locator('.auth-secret-storage-guidance');
  await expect(storageGuidance).toContainText(
    'Use a unique value for each Secret and store it in Cloudflare Secrets, not plaintext Variables.',
  );
  const guide = storageGuidance.getByRole('link', {
    name: 'Open setup guide',
  });
  await expect(guide).toHaveAttribute('target', '_blank');
  await expect(guide).toHaveClass(/auth-secret-guide-link/u);
  await expect(guide).not.toHaveClass(/studio-button/u);
  await expect(guide.locator('.lucide-external-link')).toHaveCount(0);
  const retry = page.getByRole('button', { name: 'Check setup again' });
  await expect(retry).toBeVisible();
  await expect(retry.locator('.lucide-refresh-cw')).toBeVisible();

  return {
    authSecret: await configurationRegion(page, 'STUDIO_AUTH_SECRET'),
    installToken: await configurationRegion(page, 'STUDIO_INSTALL_TOKEN'),
  };
}

test.describe('site mode configuration screen', () => {
  test.describe('missing site mode', () => {
    test.use({ studioProfile: 'site-mode-missing' });

    test('shows a not-set requirement and a configuration retry', async ({
      page,
    }) => {
      await page.goto('/');

      await expect(page.getByRole('heading', {
        name: 'Set the Studio site mode',
      })).toBeVisible();
      await expect(page.getByText(
        'Set STUDIO_SITE_MODE to initial, operational, maintenance, or recovery, then redeploy the Worker.',
      )).toBeVisible();
      await expectSiteModeRequirement(page, 'Not set');
      await expect(page.getByText('Invalid', { exact: true })).toHaveCount(0);
    });
  });

  test.describe('invalid site mode', () => {
    test.use({ studioProfile: 'site-mode-invalid' });

    test('shows an invalid requirement distinct from a missing value', async ({
      page,
    }) => {
      await page.goto('/');

      await expect(page.getByRole('heading', {
        name: 'Correct the Studio site mode',
      })).toBeVisible();
      await expect(page.getByText(
        'Use initial, operational, maintenance, or recovery exactly, then redeploy the Worker.',
      )).toBeVisible();
      await expectSiteModeRequirement(page, 'Invalid');
      await expect(page.getByText('Not set', { exact: true })).toHaveCount(0);
    });
  });
});

test.describe('operational Studio with an uninstalled database', () => {
  test.use({ studioProfile: 'operational-uninstalled' });

  test('shows installation requirements without guessing Secret state', async ({
    page,
  }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', {
      name: 'Complete the installation setup',
    })).toBeVisible();
    await expect(page.getByText(
      'Complete the remaining Worker setting, redeploy, then check the setup again.',
    )).toBeVisible();
    await expect(page.locator('.standalone-status'))
      .toHaveClass(/standalone-status-wide/u);
    await expect(page.locator('.standalone-status'))
      .toHaveCSS('width', '760px');

    const requirements = page.getByRole('region', {
      name: 'Installation Worker settings',
    });
    const siteMode = requirements.getByRole('region', {
      name: 'STUDIO_SITE_MODE',
    });
    await expect(siteMode.getByText('Plain variable', { exact: true }))
      .toBeVisible();
    await expect(siteMode).toContainText(
      'Change the value to initial before installation.',
    );
    await expect(siteMode.getByText('Change required', { exact: true }))
      .toBeVisible();

    const authSecret = requirements.getByRole('region', {
      name: 'STUDIO_AUTH_SECRET',
    });
    await expect(authSecret.getByText('Configured', { exact: true }))
      .toBeVisible();
    await expect(authSecret).toContainText(
      'Protects MFA data and stored service credentials.',
    );

    const installToken = requirements.getByRole('region', {
      name: 'STUDIO_INSTALL_TOKEN',
    });
    await expect(installToken.getByText('Secret', { exact: true }))
      .toBeVisible();
    await expect(installToken).toContainText(
      'Used to access the Studio installer.',
    );
    await expect(installToken.getByText('Check required', { exact: true }))
      .toBeVisible();
    await expect(installToken.getByText(/Not set|Invalid|Configured/))
      .toHaveCount(0);
    await expect(installToken.getByRole('button', {
      name: 'Generate STUDIO_INSTALL_TOKEN',
    })).toBeVisible();

    const retry = page.getByRole('button', { name: 'Check setup again' });
    await expect(retry).toBeVisible();
    await expect(retry.locator('.lucide-refresh-cw')).toBeVisible();
  });
});

test.describe('initial installation configuration screen', () => {
  test.describe('missing secrets', () => {
    test.use({ studioProfile: 'initial-secrets-missing' });

    test('shows both missing Secret requirements as independent actions', async ({
      page,
    }) => {
      await page.goto('/');

      const { authSecret, installToken } = await expectInstallationSetup(page);
      for (const [region, name] of [
        [authSecret, 'STUDIO_AUTH_SECRET'],
        [installToken, 'STUDIO_INSTALL_TOKEN'],
      ] as const) {
        await expectConfigurationState(region, 'Not set');
        await expect(region.getByText('Secret', { exact: true })).toBeVisible();
        await expect(region).not.toHaveClass(/auth-secret-requirement-compact/u);
        await expect(region.getByRole('button', {
          name: `Generate ${name}`,
        })).toHaveText('Generate value');
      }

      await installToken.getByRole('button', {
        name: 'Generate STUDIO_INSTALL_TOKEN',
      }).click();
      const retentionNote = installToken.getByText(
        /Keep this value in a safe place until installation is complete/,
      );
      await expect(retentionNote).toBeVisible();
      await expect(retentionNote.locator('.lucide-clock-3')).toBeVisible();
      await expect(authSecret.getByText(
        /Keep this value in a safe place until installation is complete/,
      )).toHaveCount(0);
    });
  });

  test.describe('invalid authentication secret', () => {
    test.use({ studioProfile: 'initial-auth-secret-invalid' });

    test('expands the invalid auth Secret and keeps the valid install token compact', async ({
      page,
    }) => {
      await page.goto('/');

      const { authSecret, installToken } = await expectInstallationSetup(page);
      await expectConfigurationState(authSecret, 'Invalid');
      await expect(authSecret).not.toHaveClass(
        /auth-secret-requirement-compact/u,
      );
      await expect(authSecret.getByText(
        'Protects MFA data and stored service credentials.',
      )).toBeVisible();
      await expect(authSecret.getByRole('button', {
        name: 'Generate STUDIO_AUTH_SECRET',
      })).toHaveText('Generate value');

      await expectConfigurationState(installToken, 'Configured');
      await expect(installToken).toHaveClass(
        /auth-secret-requirement-compact/u,
      );
      await expect(installToken.getByText(
        'Used to access the Studio installer.',
      )).toBeVisible();
      await expect(installToken.getByRole('button')).toHaveCount(0);
    });
  });

  test.describe('invalid install token', () => {
    test.use({ studioProfile: 'initial-install-token-invalid' });

    test('keeps the valid auth Secret compact and expands the invalid install token', async ({
      page,
    }) => {
      await page.goto('/');

      const { authSecret, installToken } = await expectInstallationSetup(page);
      await expectConfigurationState(authSecret, 'Configured');
      await expect(authSecret).toHaveClass(
        /auth-secret-requirement-compact/u,
      );
      await expect(authSecret.getByText(
        'Protects MFA data and stored service credentials.',
      )).toBeVisible();
      await expect(authSecret.getByRole('button')).toHaveCount(0);

      await expectConfigurationState(installToken, 'Invalid');
      await expect(installToken).not.toHaveClass(
        /auth-secret-requirement-compact/u,
      );
      await expect(installToken.getByText(
        'Used to access the Studio installer.',
      )).toBeVisible();
      await expect(installToken.getByRole('button', {
        name: 'Generate STUDIO_INSTALL_TOKEN',
      })).toHaveText('Generate value');
    });
  });
});
