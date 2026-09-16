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
      await page.setViewportSize({ width: 320, height: 800 });
      await expect(save).toBeVisible();
      const overflow = await page.evaluate(() => (
        document.documentElement.scrollWidth - document.documentElement.clientWidth
      ));
      expect(overflow).toBeLessThanOrEqual(1);
    });
  }
});
