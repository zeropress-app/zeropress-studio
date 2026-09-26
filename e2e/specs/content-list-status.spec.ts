import { expect, test } from '../fixtures/studio-test';
import { signInAsAdministrator } from '../support/journeys';

test.describe('content list status navigation', () => {
  test.use({ studioProfile: 'operational' });

  for (const kind of ['Post', 'Page'] as const) {
    test(`restores and permanently deletes a ${kind} through its Trash URL`, async ({ page, studioRuntime }) => {
      await signInAsAdministrator(page, studioRuntime);
      const path = kind === 'Post' ? '/posts' : '/pages';
      await page.evaluate(async ({ kind, path }) => {
        const session = await (await fetch('/api/auth/session')).json() as { data: { csrf_token: string } };
        async function create(endpoint: string, body: unknown) {
          const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-ZeroPress-CSRF': session.data.csrf_token },
            body: JSON.stringify(body),
          });
          if (!response.ok) throw new Error(`Synthetic content setup failed: ${response.status}`);
        }
        if (kind === 'Post') {
          await create('/api/authors', { id: 'list-author', display_name: 'List Author', user_id: null, avatar_media_id: null });
        }
        for (const status of ['draft', 'published', 'trash']) {
          await create(`/api${path}`, {
            title: `${kind} ${status}`, slug: `${kind.toLowerCase()}-${status}`, status,
            content: 'Synthetic list example', document_type: 'plaintext', editor_mode: 'source', editor_profile: null,
            excerpt: '', discoverability: 'default', allow_comments: false, featured_image_id: null,
            ...(kind === 'Post' ? { author_id: 'list-author', category_ids: [], tag_ids: [] } : { parent_id: null }),
          });
        }
      }, { kind, path });
      await page.goto(path);
      await expect(page.getByRole('link', { name: 'All 2', exact: true })).toHaveAttribute('aria-current', 'page');
      await page.getByRole('link', { name: 'Trash 1', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path}\\?status=trash$`, 'u'));
      await page.reload();
      await page.getByRole('checkbox', { name: `Select ${kind} trash`, exact: true }).check();
      await page.getByRole('button', { name: 'Restore to draft', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Apply status', exact: true }).click();
      await expect(page.getByRole('link', { name: 'All 3', exact: true })).toBeVisible();
      await page.getByRole('link', { name: 'Draft 2', exact: true }).click();
      await page.getByRole('checkbox', { name: `Select ${kind} trash`, exact: true }).check();
      await page.getByRole('button', { name: 'Move to Trash', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Apply status', exact: true }).click();
      await page.getByRole('link', { name: 'Trash 1', exact: true }).click();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('checkbox', { name: `Select ${kind} trash`, exact: true }).check();
      const remove = page.getByRole('button', { name: 'Delete permanently', exact: true });
      await remove.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('dialog').getByRole('button', { name: 'Delete permanently', exact: true }).click();
      await expect(page.getByRole('link', { name: 'Trash 0', exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'All 2', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    });
  }
});
