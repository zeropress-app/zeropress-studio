import { expect, test } from '../fixtures/studio-test';
import { signInAsAdministrator } from '../support/journeys';

const source = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
  <channel><title>Imported WXR site</title><link>https://example.test</link>
    <wp:wxr_version>1.2</wp:wxr_version>
    ${Array.from({ length: 100 }, (_, index) => `
      <wp:author><wp:author_login>import-author-${index}</wp:author_login>
        <wp:author_display_name>Import author ${index}</wp:author_display_name></wp:author>`).join('')}
    ${Array.from({ length: 101 }, (_, index) => `
      <item><title>Image ${index + 1}</title><wp:post_id>${index + 1}</wp:post_id>
        <wp:post_type>attachment</wp:post_type><wp:status>inherit</wp:status>
        <wp:attachment_url>https://example.test/uploads/${index + 1}.jpg</wp:attachment_url>
      </item>`).join('')}
  </channel>
</rss>`;

test.use({ studioProfile: 'operational' });

test('stops at a saved Media chunk and safely imports the remaining data on rerun', async ({
  page, studioRuntime,
}) => {
  await signInAsAdministrator(page, studioRuntime);
  const summaries: Record<string, unknown>[] = [];
  let mediaSaved!: () => void;
  let releaseMedia!: () => void;
  const savedMedia = new Promise<void>((resolve) => { mediaSaved = resolve; });
  const mediaGate = new Promise<void>((resolve) => { releaseMedia = resolve; });
  let holdMedia = true;
  let settingsWrites = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/imports/wxr/settings/finalize') {
      settingsWrites += 1;
    }
  });
  await page.route('**/api/imports/wxr/core/chunk', async (route) => {
    const chunk = route.request().postDataJSON() as { phase: string };
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    const result = await response.json() as { success: boolean; data: Record<string, unknown> };
    expect(result.success).toBe(true);
    summaries.push(result.data);
    if (holdMedia && chunk.phase === 'media') {
      holdMedia = false;
      mediaSaved();
      await mediaGate;
    }
    await route.fulfill({ response });
  });
  await page.goto('/import/wordpress');
  await page.getByLabel('Choose WordPress WXR XML file').setInputFiles({
    name: 'synthetic-media.xml', mimeType: 'application/xml', buffer: Buffer.from(source),
  });
  const confirmation = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Ready to import' }),
  });
  await confirmation.getByRole('checkbox').check();
  await confirmation.getByRole('button', { name: 'Import WordPress data' }).click();
  try {
    await savedMedia;
    await page.getByRole('button', { name: 'Stop import' }).click();
    await expect(page.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
  } finally {
    releaseMedia();
  }
  await expect(page.getByRole('heading', { name: 'WordPress import stopped' })).toBeVisible();
  expect(summaries).toEqual([
    expect.objectContaining({ phase: 'authors', created: 100, failed: 0 }),
    expect.objectContaining({ phase: 'media', created: 100, failed: 0 }),
  ]);
  expect(settingsWrites).toBe(0);
  const results = page.getByRole('table', { name: 'Import results by phase' });
  await expect(results.getByRole('row', { name: /^Media /u }).getByRole('cell'))
    .toHaveText(['100', '0', '0', '0', '0']);
  await page.setViewportSize({ width: 360, height: 800 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth))
    .toBeLessThanOrEqual(1);

  await page.getByRole('button', { name: 'Review and run again' }).click();
  await confirmation.getByRole('checkbox').check();
  await confirmation.getByRole('button', { name: 'Import WordPress data' }).click();
  await expect(page.getByRole('heading', { name: 'WordPress import finished' })).toBeVisible();
  expect(summaries.slice(2)).toEqual([
    expect.objectContaining({ phase: 'authors', unchanged: 100, failed: 0 }),
    expect.objectContaining({ phase: 'media', unchanged: 100, failed: 0 }),
    expect.objectContaining({ phase: 'media', created: 1, failed: 0 }),
  ]);
  expect(settingsWrites).toBe(1);
  await expect(results.getByRole('row', { name: /^Media /u }).getByRole('cell'))
    .toHaveText(['1', '0', '100', '0', '0']);
});
