import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/studio-test';
import { signInAsAdministrator } from '../support/journeys';

const viewports = [
  { name: 'compact', width: 320, height: 800 },
  { name: 'single-column', width: 768, height: 900 },
  { name: 'wide', width: 1280, height: 900 },
] as const;

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(
    dimensions.clientWidth + 1,
  );
}

test.describe('Posts list presentation', () => {
  test.use({ studioProfile: 'operational' });

  test('keeps editorial controls usable across the three layout ranges', async ({
    page,
    studioRuntime,
  }) => {
    await signInAsAdministrator(page, studioRuntime);
    await page.goto('/posts');

    await expect(page.getByRole('heading', { level: 1, name: 'Posts' }))
      .toBeVisible();
    await expect(page.getByText(
      "Write, publish, and manage your site's Posts.",
    )).toBeVisible();
    const createLink = page.getByRole('link', { name: 'New Post' });
    await expect(createLink).toHaveAttribute('href', '/posts/new');
    await expect(createLink).toHaveCSS('text-decoration-line', 'none');

    const statusFilters = page.getByRole('group', {
      name: 'Filter Posts by status',
    });
    await expect(statusFilters).toHaveClass(/studio-filter-tabs-underline/u);
    await expect(statusFilters.getByRole('button', { name: /^All \d+$/u }))
      .toHaveAttribute('aria-pressed', 'true');

    for (const viewport of viewports) {
      await test.step(viewport.name, async () => {
        await page.setViewportSize(viewport);
        await expect(page.getByRole('searchbox', { name: 'Search Posts' }))
          .toBeVisible();
        await expect(page.getByRole('button', { name: 'Search' }))
          .toBeVisible();
        await expect(page.getByRole('combobox', { name: 'Author' }))
          .toBeVisible();
        await expect(statusFilters).toBeVisible();
        await expectNoHorizontalOverflow(page);
      });
    }

    await page.setViewportSize({ width: 1280, height: 900 });
    const searchBounds = await page.getByRole('searchbox', {
      name: 'Search Posts',
    }).boundingBox();
    const authorBounds = await page.getByRole('combobox', {
      name: 'Author',
    }).boundingBox();
    const createBounds = await createLink.boundingBox();
    expect(searchBounds).not.toBeNull();
    expect(authorBounds).not.toBeNull();
    expect(createBounds).not.toBeNull();
    const centerY = (bounds: NonNullable<typeof searchBounds>) => (
      bounds.y + bounds.height / 2
    );
    expect(Math.abs(centerY(searchBounds!) - centerY(authorBounds!)))
      .toBeLessThanOrEqual(2);
    expect(Math.abs(centerY(searchBounds!) - centerY(createBounds!)))
      .toBeLessThanOrEqual(2);

    const toolbarBounds = await page.locator(
      '.content-list-toolbar-editorial',
    ).boundingBox();
    const filterBounds = await statusFilters.boundingBox();
    expect(toolbarBounds).not.toBeNull();
    expect(filterBounds).not.toBeNull();
    expect(Math.abs(toolbarBounds!.width - filterBounds!.width))
      .toBeLessThanOrEqual(1);
  });
});
