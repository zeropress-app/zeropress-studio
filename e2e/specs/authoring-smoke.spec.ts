import { expect, test } from '../fixtures/studio-test';
import { signInAsAdministrator } from '../support/journeys';

test.describe('public beta authoring smoke', () => {
  test.use({ studioProfile: 'operational' });

  for (const kind of ['Post', 'Page'] as const) {
    test(`saves and reloads a ${kind} through the visual editor`, async ({ page, studioRuntime }) => {
      await signInAsAdministrator(page, studioRuntime);
      if (kind === 'Post') {
        await page.goto('/authors');
        await expect(page.getByRole('heading', { name: 'No authors yet' }))
          .toBeVisible();
        await expect(page.getByLabel('Author overview').locator('dd'))
          .toHaveText(['0', '0', '0']);
        await page.getByRole('button', { name: 'New author' }).click();
        await page.getByRole('textbox', { name: 'Display name' })
          .fill('Beta smoke author');
        await page.getByRole('textbox', { name: 'Author ID' })
          .fill('beta-smoke-author');
        const created = page.waitForResponse((response) => (
          new URL(response.url()).pathname === '/api/authors'
          && response.request().method() === 'POST'
        ));
        await page.getByRole('button', { name: 'Create author' }).click();
        expect((await created).status()).toBe(201);
        await expect(page.getByText('Beta smoke author was created.'))
          .toBeVisible();
      }
      const path = kind === 'Post' ? '/posts' : '/pages';
      await page.goto(`${path}/new`);
      const title = page.getByRole('textbox', { name: 'Title', exact: true });
      await title.fill(`Public beta ${kind}`);
      const content = page.getByRole('textbox', { name: 'Content', exact: true });
      await content.fill('Public beta 작성 smoke 🌱');
      await content.press('ControlOrMeta+A');
      await page.getByRole('button', { name: 'Bold', exact: true }).click();
      await expect(content.locator('strong')).toHaveText('Public beta 작성 smoke 🌱');
      if (kind === 'Post') {
        await page.getByRole('combobox', { name: 'Public Author' }).selectOption('beta-smoke-author');
      }
      const save = page.getByRole('button', { name: `Save ${kind}`, exact: true });
      await expect(save).toBeEnabled();
      // Keyboard activation exercises the ordinary form submission path.
      await save.focus();
      const saved = page.waitForResponse((response) => (
        new URL(response.url()).pathname.startsWith(`/api${path}`)
        && ['POST', 'PUT'].includes(response.request().method())
        && !response.url().includes('autosave')
      ));
      await page.keyboard.press('Enter');
      expect((await saved).ok()).toBe(true);
      await expect(page).toHaveURL(new RegExp(`${path}/[0-9a-f]{32}$`, 'u'));
      await expect(save).toBeDisabled();
      await page.reload();
      await expect(title).toHaveValue(`Public beta ${kind}`);
      await expect(content).toHaveText('Public beta 작성 smoke 🌱');
      await expect(content.locator('strong')).toHaveText('Public beta 작성 smoke 🌱');

      // A second canonical write proves this is not merely a create-page render.
      await title.fill(`Updated beta ${kind}`);
      const updated = page.waitForResponse((response) => (
        new URL(response.url()).pathname.startsWith(`/api${path}/`)
        && response.request().method() === 'PUT'
        && !response.url().includes('autosave')
      ));
      await save.click();
      expect((await updated).ok()).toBe(true);
      await expect(save).toBeDisabled();
      await page.reload();
      await expect(title).toHaveValue(`Updated beta ${kind}`);
      await expect(content).toHaveText('Public beta 작성 smoke 🌱');
      await expect(content.locator('strong')).toHaveText('Public beta 작성 smoke 🌱');
      await page.setViewportSize({ width: 320, height: 800 });
      await expect(save).toBeVisible();
      const bold = page.getByRole('button', { name: 'Bold', exact: true });
      await bold.hover();
      const tooltip = bold.locator('.se-tooltip-text');
      await expect(tooltip).toBeVisible();
      await expect.poll(() => bold.evaluate((button) => {
        const anchor = button.getBoundingClientRect();
        const label = button.querySelector('.se-tooltip-text')!.getBoundingClientRect();
        return Math.abs(anchor.x + anchor.width / 2 - label.x - label.width / 2);
      })).toBeLessThanOrEqual(1);
      await expect.poll(() => page.evaluate(() => (
        document.documentElement.scrollWidth - document.documentElement.clientWidth
      ))).toBeLessThanOrEqual(1);
    });
  }

  test('preserves color, alignment and tables through saving and a source round trip', async ({ page, studioRuntime }) => {
    await signInAsAdministrator(page, studioRuntime);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.stack || error.message));
    await page.goto('/pages/new');
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Formatted page');
    const content = page.getByRole('textbox', { name: 'Content', exact: true });
    await content.click();
    await page.keyboard.type('Formatted text');
    await content.press('ControlOrMeta+A');
    const colorButton = page.getByRole('button', { name: 'Font color', exact: true });
    await colorButton.click();
    const paletteBox = await page.locator('.se-color-pallet:visible').first().boundingBox();
    const colorBox = await colorButton.boundingBox();
    expect(paletteBox!.x).toBeLessThanOrEqual(colorBox!.x + colorBox!.width);
    expect(paletteBox!.x + paletteBox!.width).toBeGreaterThan(colorBox!.x);
    await page.locator('.se-color-pallet button[data-value="#ef4444"]:visible').click();
    await page.locator('button[data-command="align"]').click();
    await page.locator('.se-list-align button[data-command="center"]').click();
    await expect(content.locator('p').first()).toHaveCSS('text-align', 'center');
    await expect(content.locator('span[style]')).toHaveCSS('color', 'rgb(239, 68, 68)');
    await content.press('ArrowRight');
    await content.press('End');
    await content.press('Enter');
    await page.locator('button[data-command="table"]').click();
    const picker = page.locator('.se-table-size-picker');
    await picker.hover({ position: { x: 35, y: 35 } });
    await picker.click({ position: { x: 35, y: 35 } });
    await expect(content.locator('td')).toHaveCount(4);
    await content.locator('td').first().click();
    await page.keyboard.type('Table value');
    await page.locator('button[data-command="align"]').click();
    await page.locator('.se-list-align button[data-command="right"]').click();
    await page.getByRole('button', { name: 'Save Page', exact: true }).click();
    await expect(page).toHaveURL(/\/pages\/[0-9a-f]{32}$/u);
    await page.reload();
    await expect(content.locator('td')).toHaveCount(4);
    await expect(content.locator('td').first()).toHaveText('Table value');
    await expect(content.locator('td').first().locator('p')).toHaveCSS('text-align', 'right');
    await expect(content.locator('span[style]').first()).toHaveCSS('color', 'rgb(239, 68, 68)');
    await page.getByRole('button', { name: 'HTML source', exact: true }).click();
    await page.getByRole('button', { name: 'Save Page', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save Page', exact: true })).toBeDisabled();
    await page.reload();
    await page.getByRole('button', { name: 'Visual', exact: true }).click();
    await expect(content.locator('td').first()).toHaveText('Table value');
    await expect(content.locator('td').first().locator('p')).toHaveCSS('text-align', 'right');
    await expect(content.locator('span[style]').first()).toHaveCSS('color', 'rgb(239, 68, 68)');
    expect(errors).toEqual([]);
  });

  test('inserts Media and reviews source conversion without discarding an unsaved draft', async ({ page, studioRuntime }) => {
    await signInAsAdministrator(page, studioRuntime);
    await page.route('**/api/media**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/media/collections') {
        await route.fulfill({ json: { success: true, data: { items: [], total_media_count: 1, unfiled_media_count: 1 } } });
      } else if (url.pathname === '/api/media') {
        await route.fulfill({ json: { success: true, data: {
          items: [{ id: '1'.repeat(32), kind: 'image', filename: 'sample.svg', mime_type: 'image/svg+xml',
            location: { type: 'external', url: 'https://media.example.test/sample.svg' },
            size_bytes: 100, width: 30, height: 20, duration_ms: null, alt: 'Synthetic sample', collection: null,
            usage: { posts: 0, pages: 0, authors: 0, branding: 0 }, revision: '2'.repeat(32),
            created_at_iso: '2026-09-26T00:00:00.000Z', updated_at_iso: '2026-09-26T00:00:00.000Z' }],
          pagination: { page: 1, per_page: 50, total: 1, total_pages: 1 },
          delivery: { media_origin: '', r2_preview_available: false },
        } } });
      } else await route.continue();
    });
    await page.route('https://media.example.test/**', (route) => route.fulfill({
      contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="20"><rect width="30" height="20" fill="blue"/></svg>',
    }));
    await page.goto('/pages/new');
    const content = page.getByRole('textbox', { name: 'Content', exact: true });
    await content.fill('Unsaved draft');
    await content.press('End');
    await page.getByRole('button', { name: 'Insert Media', exact: true }).click();
    await page.getByRole('button', { name: 'Insert sample.svg', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Insert Media into content' })).toBeHidden();
    await expect(content.locator('img')).toHaveCount(1);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(content).toHaveText('Unsaved draft');
    await page.getByRole('button', { name: 'Redo', exact: true }).click();
    await expect(content.locator('img')).toHaveCount(1);
    await page.getByRole('button', { name: 'HTML source', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Content', exact: true })).toBeVisible();
    await content.press('ControlOrMeta+A');
    await page.keyboard.insertText('<p><b>Unsaved conversion sample</b></p>');
    await page.getByRole('button', { name: 'Visual', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Use the visual editor?' });
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('region', { name: 'Compare the original and converted HTML' })).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box!.width).toBeGreaterThan(page.viewportSize()!.width - 70);
    await page.mouse.click(4, 4);
    await expect(dialog).toBeVisible();
    await page.setViewportSize({ width: 320, height: 800 });
    const confirm = dialog.getByRole('button', { name: 'Use visual editor', exact: true });
    await expect(confirm).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await confirm.click();
    await expect(content.locator('strong')).toHaveText('Unsaved conversion sample');
    await page.getByRole('button', { name: 'HTML source', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Content', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Visual', exact: true }).click();
    await expect(content.locator('strong')).toHaveText('Unsaved conversion sample');
  });

});
