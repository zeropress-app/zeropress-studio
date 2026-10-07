import { expect, test } from '../fixtures/studio-test';
import { signInAsAdministrator } from '../support/journeys';

test.use({ studioProfile: 'operational' });

test('saves an Edge origin and derives the comments connection across reloads', async ({ page, studioRuntime }) => {
  await signInAsAdministrator(page, studioRuntime);
  await page.goto('/settings/edge#edge-url');
  const origin = page.getByRole('textbox', { name: 'Edge URL', exact: true });
  await expect(origin).toBeFocused();
  await origin.fill('https://SITE.example/');
  const save = page.getByRole('button', { name: 'Save Edge URL', exact: true });
  await save.focus();
  await page.keyboard.press('Enter');
  await expect(save).toBeDisabled();
  await expect(origin).toHaveValue('https://site.example');
  await page.reload();
  await expect(origin).toHaveValue('https://site.example');

  await page.goto('/settings/edge/comments');
  const comments = page.getByRole('textbox', { name: 'Comments API base URL', exact: true });
  await expect(comments).toHaveValue('https://site.example/api');
  await expect(comments).toHaveAttribute('readonly');
  await page.getByRole('link', { name: 'Set Edge URL', exact: true }).click();
  await expect(origin).toBeFocused();
  await page.setViewportSize({ width: 320, height: 800 });
  await expect(origin).toBeVisible();
  await expect(page.getByRole('button', {
    name: 'Disable Studio Edge integration', exact: true,
  })).toBeVisible();

  for (const font of [null, 'Arial, sans-serif']) {
    await test.step(`keeps cards and actions within 320px with ${font ?? 'the bundled font'}`, async () => {
      const fallback = font ? await page.addStyleTag({
        content: `:root { --studio-font-sans: ${font}; }`,
      }) : null;
      try {
        await page.evaluate(() => document.fonts.ready);
        await expect.poll(() => page.locator('.edge-settings-content').evaluate((content) => {
          const column = content.getBoundingClientRect();
          const cards = Array.from(content.querySelectorAll('.studio-panel'));
          const actions = Array.from(content.querySelectorAll('.studio-panel-footer .studio-button'));
          return Math.max(
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
            ...cards.flatMap((card) => {
              const bounds = card.getBoundingClientRect();
              return [column.left - bounds.left, bounds.right - column.right];
            }),
            ...actions.flatMap((action) => {
              const bounds = action.getBoundingClientRect();
              const footer = action.closest('.studio-panel-footer')!.getBoundingClientRect();
              return [footer.left - bounds.left, bounds.right - footer.right,
                action.scrollWidth - action.clientWidth];
            }),
          );
        })).toBeLessThanOrEqual(1);
      } finally {
        await fallback?.evaluate((style) => { style.parentNode?.removeChild(style); });
      }
    });
  }

  await origin.fill('');
  await save.click();
  await expect(page.getByText('Edge URL saved.', { exact: true })).toBeVisible();
  await expect(save).toBeDisabled();
  await page.goto('/settings/edge/comments');
  await expect(page.getByText('Set an Edge URL to use this connection.', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Set Edge URL', exact: true })).toBeVisible();
});
