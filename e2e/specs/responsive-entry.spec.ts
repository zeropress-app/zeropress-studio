import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/studio-test';
import { signInAsAdministrator } from '../support/journeys';

const viewports = [
  { name: 'compact', width: 320, height: 800 },
  { name: 'single-column', width: 768, height: 900 },
  { name: 'wide', width: 1280, height: 900 },
] as const;

const entryViewports = [320, 640, 641, 768, 900, 901, 1200, 1201, 1280]
  .map((width) => ({
    name: `${width}px`,
    width,
    height: width <= 640 ? 800 : 900,
  }));

async function expectTranslatedCopyFits(page: Page, selector: string): Promise<void> {
  const copy = page.locator(selector);
  await expect(copy).toHaveCount(2);
  for (const sample of [
    'コンテンツに集中できる静かなワークスペース。'.repeat(3),
    'LongTranslatedContentWithoutAnySpaces'.repeat(3),
  ]) {
    // Simulate translated DOM text, not the Chrome translation service. Keep
    // the document locale unchanged: wrapping must not depend on lang="ja".
    // Restore the original nodes so this never changes the actual journey.
    const measurements = await copy.evaluateAll((elements, text) => elements.map((element) => {
      const originalNodes = Array.from(element.childNodes);
      try {
        const translated = document.createElement('span');
        translated.textContent = text;
        element.replaceChildren(translated);
        const bounds = element.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(translated);
        const fragments = Array.from(range.getClientRects());
        return {
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          lineCount: new Set(fragments.map((rect) => Math.round(rect.top))).size,
          textFits: fragments.every((rect) => (
            rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1
          )),
        };
      } finally {
        element.replaceChildren(...originalNodes);
      }
    }), sample);

    for (const measurement of measurements) {
      // Root scrollWidth alone misses content clipped by an overflow-hidden rail.
      expect(measurement.scrollWidth).toBeLessThanOrEqual(measurement.clientWidth + 1);
      expect(measurement.lineCount).toBeGreaterThan(1);
      expect(measurement.textFits).toBe(true);
    }
  }
}

async function expectFormCopyFits(page: Page, width: number): Promise<void> {
  await expect(page.locator('.auth-form-title')).toHaveCSS('font-size', '29px');
  await expectTranslatedCopyFits(page, '.auth-form-title, .auth-form-description');
  if (width > 900) {
    await expectTranslatedCopyFits(page, '.auth-brand-headline, .auth-brand-description');
  }
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(
    dimensions.clientWidth + 1,
  );
}

async function expectVisibleLogoIsFortyPixels(page: Page): Promise<void> {
  const logo = page.locator('.studio-logo-badge:visible').first();
  await expect(logo).toBeVisible();
  const box = await logo.boundingBox();
  expect(box).not.toBeNull();
  expect(box?.width).toBe(40);
  expect(box?.height).toBe(40);
}

async function expectBrandLabelVisuallyClipped(
  page: Page,
  selector: string,
): Promise<void> {
  const label = page.locator(selector);
  await expect(label).toBeAttached();
  const presentation = await label.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return {
      clip: style.clip,
      height: rect.height,
      overflow: style.overflow,
      position: style.position,
      width: rect.width,
    };
  });
  expect(presentation).toMatchObject({
    clip: 'rect(0px, 0px, 0px, 0px)',
    overflow: 'hidden',
    position: 'absolute',
  });
  expect(presentation.width).toBeLessThanOrEqual(1);
  expect(presentation.height).toBeLessThanOrEqual(1);
}

test.describe('responsive sign-in', () => {
  test.use({ studioProfile: 'operational' });

  test('keeps sign-in usable across the three layout ranges', async ({ page }) => {
    await page.goto('/');
    for (const viewport of entryViewports) {
      await test.step(viewport.name, async () => {
        await page.setViewportSize(viewport);
        await expect(page.getByRole('heading', { name: 'Sign in to Studio' }))
          .toBeVisible();
        await expect(page.getByLabel('Email')).toBeVisible();
        await expect(page.getByRole('textbox', { name: 'Password' }))
          .toBeVisible();
        await expectVisibleLogoIsFortyPixels(page);
        await expectFormCopyFits(page, viewport.width);
        await expectNoHorizontalOverflow(page);
        if (viewport.width <= 640) {
          await expectBrandLabelVisuallyClipped(
            page,
            '.auth-mobile-brand-label',
          );
        } else if (viewport.width <= 900) {
          await expect(page.locator('.auth-mobile-brand-label')).toBeVisible();
        } else {
          await expect(page.locator('.auth-lockup')).toBeVisible();
        }
      });
    }
  });
});

test.describe('responsive authenticated Studio shell', () => {
  test.use({ studioProfile: 'operational' });

  test('keeps the persistent title bar and navigation usable', async ({
    page,
    studioRuntime,
  }) => {
    await signInAsAdministrator(page, studioRuntime);
    await expect(page.getByRole('heading', {
      level: 1,
      name: 'Dashboard',
    })).toBeVisible();

    for (const viewport of viewports) {
      await test.step(viewport.name, async () => {
        await page.setViewportSize(viewport);

        const title = page.locator('.studio-page-context-title');
        await expect(title).toHaveText('Dashboard');
        await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
        await expect(page.locator('main .studio-page-header')).toHaveCount(0);
        await expectNoHorizontalOverflow(page);

        if (viewport.width > 900) {
          await expect(page.locator('.studio-sidebar')).toBeVisible();
          const backgroundImage = await page.locator('.studio-sidebar')
            .evaluate((element) => getComputedStyle(element).backgroundImage);
          expect(backgroundImage).toContain('linear-gradient');
          const navRow = page.locator('.studio-sidebar-navigation a:visible')
            .first();
          const navRowBox = await navRow.boundingBox();
          expect(navRowBox?.height).toBe(36);
        } else {
          await expect(page.locator('.studio-sidebar')).toBeHidden();
          await expect(page.getByRole('button', {
            name: 'Open navigation',
          })).toBeVisible();
        }
      });
    }

    await test.step('fluid-wide-canvas', async () => {
      await page.setViewportSize({ width: 1600, height: 900 });
      const geometry = await page.evaluate(() => {
        const rect = (selector: string) => {
          const bounds = document.querySelector(selector)
            ?.getBoundingClientRect();
          return bounds ? { width: bounds.width, x: bounds.x } : null;
        };
        const workspace = rect('.studio-workspace');
        const route = rect('.studio-route-content');
        const footer = rect('.studio-footer-version');
        return { workspace, route, footer };
      });

      expect(geometry.workspace).toBeTruthy();
      expect(geometry.route).toBeTruthy();
      expect(geometry.footer).toBeTruthy();
      expect(geometry.route?.width).toBeGreaterThan(1180);
      expect(geometry.route?.x).toBeCloseTo(geometry.workspace?.x ?? 0, 0);
      expect(geometry.route?.width).toBeCloseTo(
        geometry.workspace?.width ?? 0,
        0,
      );
      expect(geometry.footer?.x).toBeCloseTo(geometry.workspace?.x ?? 0, 0);
      expect(geometry.footer?.width).toBeCloseTo(
        geometry.workspace?.width ?? 0,
        0,
      );
      await expectNoHorizontalOverflow(page);
    });
  });
});

test.describe('responsive installation', () => {
  test.use({ studioProfile: 'initial' });

  test('keeps the access gate and installation process usable', async ({
    page,
    studioRuntime,
  }) => {
    await page.goto('/');
    for (const viewport of entryViewports) {
      await test.step(`access-${viewport.name}`, async () => {
        await page.setViewportSize(viewport);
        await expect(page.getByRole('heading', {
          name: 'Verify the install token',
        })).toBeVisible();
        await expect(page.getByLabel('Install token')).toBeVisible();
        await expectVisibleLogoIsFortyPixels(page);
        await expectFormCopyFits(page, viewport.width);
        await expectNoHorizontalOverflow(page);
        if (viewport.width <= 640) {
          await expectBrandLabelVisuallyClipped(
            page,
            '.auth-mobile-brand-label',
          );
        }
      });
    }

    await page.setViewportSize(viewports[2]);
    await page.getByLabel('Install token')
      .fill(studioRuntime.credentials.installToken);
    await page.getByRole('button', { name: 'Continue to installation' })
      .click();
    for (const viewport of entryViewports) {
      await test.step(`process-${viewport.name}`, async () => {
        await page.setViewportSize(viewport);
        await expect(page.getByRole('heading', { name: 'Open-source license' }))
          .toBeVisible();
        await expect(page.getByRole('navigation', {
          name: 'Studio installation progress',
        })).toBeVisible();
        await expectVisibleLogoIsFortyPixels(page);
        await expect(page.locator('.auth-install-rail .auth-lockup'))
          .toBeVisible();
        await expect(page.locator('.auth-install-rail .setup-title:visible'))
          .toHaveCSS('font-size', viewport.width <= 640 ? '24px' : '29px');
        await expectTranslatedCopyFits(
          page,
          '.auth-install-rail .setup-title:visible, .auth-install-rail .setup-description:visible',
        );
        await expectNoHorizontalOverflow(page);
      });
    }
  });
});

test.describe('responsive Operations access', () => {
  test.use({ studioProfile: 'operations' });

  test('keeps protected Operations controls visible and keyboard reachable', async ({
    page,
    operationsToken,
  }) => {
    await page.goto('/system/operations');
    for (const viewport of entryViewports) {
      await test.step(viewport.name, async () => {
        await page.setViewportSize(viewport);
        await expect(page.getByRole('heading', { name: 'Maintenance & Recovery' }))
          .toBeVisible();
        await expect(page.getByLabel('Operations token')).toBeVisible();
        await expectVisibleLogoIsFortyPixels(page);
        await expectFormCopyFits(page, viewport.width);
        await expectNoHorizontalOverflow(page);
        if (viewport.width <= 640) {
          await expectBrandLabelVisuallyClipped(
            page,
            '.auth-mobile-brand-label',
          );
        }
      });
    }

    await page.setViewportSize(viewports[0]);
    const token = page.getByLabel('Operations token');
    await token.fill(operationsToken);
    await token.focus();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', {
      name: 'Open Maintenance & Recovery',
    })).toBeFocused();
  });
});

test.describe('responsive account activation', () => {
  test.use({ studioProfile: 'activation' });

  test('keeps both setup steps clear across layout ranges', async ({
    page,
    studioRuntime,
  }) => {
    const setupUrl = new URL(
      studioRuntime.credentials.invitation.setupUrl,
    );
    await page.goto(`/activate${setupUrl.hash}`);

    for (const viewport of entryViewports) {
      await test.step(viewport.name, async () => {
        await page.setViewportSize(viewport);
        await expect(page.getByRole('heading', {
          name: 'Activate your Studio account',
        })).toBeVisible();
        await expect(page.getByRole('navigation', {
          name: 'Account setup progress',
        })).toBeVisible();
        await expect(page.getByLabel('Password', { exact: true }))
          .toBeVisible();
        await expectVisibleLogoIsFortyPixels(page);
        await expect(page.locator('.auth-activation-rail .setup-title:visible'))
          .toHaveCSS('font-size', viewport.width <= 640 ? '24px' : '29px');
        await expectTranslatedCopyFits(
          page,
          '.auth-activation-rail .setup-title:visible, .auth-activation-rail .setup-description:visible',
        );
        await expectNoHorizontalOverflow(page);
      });
    }
  });
});

test.describe('responsive lifecycle status', () => {
  test.use({ studioProfile: 'recovery' });

  test('keeps recovery status actions usable across layout ranges', async ({
    page,
  }) => {
    await page.goto('/');
    for (const viewport of entryViewports) {
      await test.step(viewport.name, async () => {
        await page.setViewportSize(viewport);
        await expect(page.getByRole('heading', {
          name: 'Studio access is limited during recovery',
        })).toBeVisible();
        await expect(page.getByRole('link', {
          name: 'Open Maintenance & Recovery',
        })).toBeVisible();
        await expectVisibleLogoIsFortyPixels(page);
        await expect(page.locator('.setup-title')).toHaveCSS('font-size', '29px');
        await expectTranslatedCopyFits(page, '.setup-title, .setup-description');
        await expectNoHorizontalOverflow(page);
        if (viewport.width <= 640) {
          await expectBrandLabelVisuallyClipped(
            page,
            '.auth-corner-brand-label',
          );
        }
      });
    }
  });
});
