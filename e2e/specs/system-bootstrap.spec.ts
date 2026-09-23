import { expect, test } from '../fixtures/studio-test';

test.describe('initial status checking policy', () => {
  test.use({ studioProfile: 'initial' });

  test('skips the checking screen when status resolves within two seconds', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      (window as typeof window & { __sawCheckingHeading?: boolean })
        .__sawCheckingHeading = false;
      new MutationObserver(() => {
        const sawHeading = Array.from(document.querySelectorAll('h1, h2'))
          .some((heading) => heading.textContent?.trim() === 'Getting Studio ready');
        if (sawHeading) {
          (window as typeof window & { __sawCheckingHeading?: boolean })
            .__sawCheckingHeading = true;
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    });

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Verify the install token' }))
      .toBeVisible();
    expect(await page.evaluate(() => (
      (window as typeof window & { __sawCheckingHeading?: boolean })
        .__sawCheckingHeading
    ))).toBe(false);
  });

  test('reveals slow checking after two seconds and keeps it for one second', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const state = {
        hiddenAt: null as number | null,
        shownAt: null as number | null,
        visible: false,
      };
      (window as typeof window & { __checkingTiming?: typeof state })
        .__checkingTiming = state;
      const recordHeadingState = () => {
        const visible = Array.from(document.querySelectorAll('h1, h2'))
          .some((heading) => heading.textContent?.trim() === 'Getting Studio ready');
        if (visible && !state.visible && state.shownAt === null) {
          state.shownAt = performance.now();
        }
        if (!visible && state.visible && state.hiddenAt === null) {
          state.hiddenAt = performance.now();
        }
        state.visible = visible;
      };
      new MutationObserver(recordHeadingState)
        .observe(document, { childList: true, subtree: true });
    });
    await page.route('**/api/system/status', async (route) => {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_500));
      await route.continue();
    });

    await page.goto('/');
    const checking = page.getByRole('heading', { name: 'Getting Studio ready' });
    await expect(checking).toBeVisible({ timeout: 3_500 });
    await expect(page.getByRole('heading', { name: 'Verify the install token' }))
      .toBeVisible();
    const timing = await page.evaluate(() => {
      const state = (window as typeof window & {
        __checkingTiming?: {
          hiddenAt: number | null;
          shownAt: number | null;
        };
      }).__checkingTiming;
      if (!state || state.shownAt === null || state.hiddenAt === null) {
        return null;
      }
      return {
        duration: state.hiddenAt - state.shownAt,
        shownAt: state.shownAt,
      };
    });
    expect(timing).not.toBeNull();
    expect(timing?.shownAt).toBeGreaterThanOrEqual(1_900);
    expect(timing?.duration).toBeGreaterThanOrEqual(950);
  });
});

test.describe('authentication secret correction', () => {
  test.use({ studioProfile: 'auth-secret-missing' });

  test('generates and copies a replacement secret, then retries status', async ({
    context,
    page,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/');
    await expect(page.getByRole('heading', {
      name: 'Set the Studio authentication secret',
    })).toBeVisible();
    await expect(page.locator('.standalone-status'))
      .toHaveClass(/standalone-status-wide/u);
    await expect(page.locator('.standalone-status'))
      .toHaveCSS('width', '760px');
    await expect(page.getByText(
      'Use 32–256 printable ASCII characters without spaces.',
    )).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open setup guide' }))
      .toHaveAttribute('target', '_blank');

    await page.getByRole('button', { name: 'Generate value' }).click();
    const generated = page.getByLabel('Generated STUDIO_AUTH_SECRET');
    await expect(generated).toHaveValue(/^[0-9a-f]{64}$/u);
    await page.getByRole('button', { name: 'Copy value' }).click();
    await expect(page.getByText('Generated value copied.')).toBeVisible();

    const status = page.waitForResponse((response) => (
      new URL(response.url()).pathname === '/api/system/status'
    ));
    await page.getByRole('button', { name: 'Check configuration again' })
      .click();
    expect((await status).status()).toBe(200);
    await expect(page.getByRole('heading', { name: 'Getting Studio ready' }))
      .toBeVisible();
    await expect(page.getByRole('heading', {
      name: 'Set the Studio authentication secret',
    })).toBeVisible({ timeout: 3_000 });
  });
});

test.describe('post-install activation boundary', () => {
  test.use({ studioProfile: 'activation-required' });

  test('shows the ordered Worker finalization steps', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Installation is complete' }))
      .toBeVisible();
    const finalization = page.getByRole('region', {
      name: 'Enable Studio sign-in',
    });
    await expect(finalization.getByRole('listitem')).toHaveCount(3);
    await expect(finalization).toContainText('STUDIO_INSTALL_TOKEN');
    await expect(finalization).toContainText('STUDIO_SITE_MODE');
    await expect(page.getByRole('button', {
      name: 'Check configuration again',
    })).toBeVisible();
  });
});

test.describe('maintenance boundary', () => {
  test.use({ studioProfile: 'maintenance' });

  test('offers the protected Operations workspace during maintenance', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', {
      name: 'Studio is temporarily unavailable',
    })).toBeVisible();
    await expect(page.locator('.standalone-status'))
      .not.toHaveClass(/standalone-status-wide/u);
    await expect(page.getByRole('link', {
      name: 'Open Maintenance & Recovery',
    })).toHaveAttribute('href', '/system/operations');
  });
});

test.describe('recovery boundary', () => {
  test.use({ studioProfile: 'recovery' });

  test('offers Operations and a separate recovery status retry', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', {
      name: 'Studio access is limited during recovery',
    })).toBeVisible();
    await expect(page.getByRole('link', {
      name: 'Open Maintenance & Recovery',
    })).toHaveAttribute('href', '/system/operations');
    await expect(page.getByRole('button', { name: 'Check recovery status' }))
      .toBeVisible();
  });
});

test.describe('recovery without Operations', () => {
  test.use({ studioProfile: 'recovery-no-operations' });

  test('opens Operations setup when recovery access is not configured', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', {
      name: 'Studio access is limited during recovery',
    })).toBeVisible();
    const operationsLink = page.getByRole('link', {
      name: 'Open Maintenance & Recovery',
    });
    await expect(operationsLink).toHaveAttribute('href', '/system/operations');
    await operationsLink.click();
    await expect(page.getByRole('heading', { name: 'Set up Operations access' }))
      .toBeVisible();
  });
});
