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
      const overflow = await page.evaluate(() => (
        document.documentElement.scrollWidth - document.documentElement.clientWidth
      ));
      expect(overflow).toBeLessThanOrEqual(1);
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
    await page.getByRole('button', { name: 'Font color', exact: true }).click();
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
    await page.getByRole('button', { name: 'Use HTML source', exact: true }).click();
    await page.getByRole('button', { name: 'Save Page', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save Page', exact: true })).toBeDisabled();
    await page.reload();
    await page.getByRole('button', { name: 'Visual', exact: true }).click();
    await page.getByRole('button', { name: 'Use visual editor', exact: true }).click();
    await expect(content.locator('td').first()).toHaveText('Table value');
    await expect(content.locator('td').first().locator('p')).toHaveCSS('text-align', 'right');
    await expect(content.locator('span[style]').first()).toHaveCSS('color', 'rgb(239, 68, 68)');
    expect(errors).toEqual([]);
  });

});
