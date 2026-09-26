import { expect, test } from '../fixtures/studio-test';
import { signInAsAdministrator } from '../support/journeys';

test.use({ studioProfile: 'operational' });

test('previews unsaved source with code, tables and isolated active content', async ({ page, studioRuntime }) => {
  await signInAsAdministrator(page, studioRuntime);
  await page.goto('/pages/new');
  await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Unsaved table and code');
  await page.getByRole('button', { name: 'HTML source', exact: true }).click();
  const content = page.getByRole('textbox', { name: 'Content', exact: true });
  await expect(page.getByRole('group', { name: 'Content', exact: true })).toBeVisible();
  await content.press('ControlOrMeta+A');
  const html = '<pre class="language-javascript">const n = 42;<br>alert(n);<br></pre><table><tr><th>Item</th><td>Value</td></tr></table><script>parent.document.body.textContent="unsafe"</script><a href="/publish">Unsafe navigation</a>';
  await page.keyboard.insertText(html);
  const mutations: string[] = [];
  page.on('request', (request) => {
    if (['POST', 'PUT'].includes(request.method()) && /^\/api\/pages(?:\/[a-f0-9]{32})?$/.test(new URL(request.url()).pathname)) mutations.push(request.url());
  });
  const button = page.getByRole('button', { name: 'Preview', exact: true });
  await button.click();
  const frame = page.frameLocator('iframe[title="Body preview"]');
  await expect(frame.locator('pre code')).toHaveText('const n = 42;\nalert(n);\n');
  await expect(frame.locator('.hljs-keyword')).toHaveText('const');
  await expect(frame.locator('th')).toHaveText('Item');
  expect(await frame.locator('.hljs-keyword').evaluate((node) => getComputedStyle(node).color))
    .not.toBe(await frame.locator('pre code').evaluate((node) => getComputedStyle(node).color));
  await expect(frame.locator('script, a[href]')).toHaveCount(0);
  expect(await frame.locator('body').evaluate(() => {
    try { return Boolean(window.parent.document); } catch { return false; }
  })).toBe(false);
  await page.mouse.click(4, 4);
  await expect(page.getByRole('dialog', { name: 'Body preview' })).toBeVisible();
  await page.setViewportSize({ width: 320, height: 800 });
  await page.getByRole('button', { name: 'Mobile', exact: true }).click();
  const close = page.getByRole('button', { name: 'Close', exact: true });
  await expect(close).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
  await close.click();
  await expect(button).toBeFocused();
  expect(mutations).toEqual([]);
  expect(new URL(page.url()).pathname).toBe('/pages/new');
  await expect(page.getByRole('button', { name: 'HTML source', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

for (const documentType of ['markdown', 'plaintext'] as const) {
  test(`previews ${documentType} without saving or switching its document type`, async ({ page, studioRuntime }) => {
    await signInAsAdministrator(page, studioRuntime);
    await page.goto('/pages/new');
    await page.getByRole('combobox', { name: 'Document type' }).selectOption(documentType);
    await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Unsaved source');
    const content = page.getByRole('textbox', { name: 'Content', exact: true });
    await content.press('ControlOrMeta+A');
    await page.keyboard.insertText('## Heading\n\n<strong>Sample</strong>');
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    const frame = page.frameLocator('iframe[title="Body preview"]');
    await expect(frame.locator('h1')).toHaveText('Unsaved source');
    if (documentType === 'markdown') {
      await expect(frame.locator('h2')).toHaveText('Heading');
      await expect(frame.locator('strong')).toHaveText('Sample');
    } else {
      await expect(frame.locator('.prose')).toContainText('<strong>Sample</strong>');
    }
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Document type' })).toHaveValue(documentType);
    expect(new URL(page.url()).pathname).toBe('/pages/new');
  });
}

for (const touch of [false, true]) {
  test.describe(touch ? 'Touch preview details' : 'Desktop preview details', () => {
    test.use({ hasTouch: touch, viewport: touch ? { width: 390, height: 844 } : { width: 1280, height: 900 } });

    test('inspects link settings and embedded content without loading their destinations', async ({ page, studioRuntime }) => {
      const requestedDestinations: string[] = [];
      await page.route(/^https:\/\/(?:destination|embed)\.example\//, (route) => {
        requestedDestinations.push(route.request().url());
        return route.abort();
      });
      await signInAsAdministrator(page, studioRuntime);
      await page.goto('/pages/new');
      await page.getByRole('textbox', { name: 'Title', exact: true }).fill('Link and embed inspection');
      await page.getByRole('button', { name: 'HTML source', exact: true }).click();
      const content = page.getByRole('textbox', { name: 'Content', exact: true });
      await content.press('ControlOrMeta+A');
      const destination = `https://destination.example/guide?selection=${'section-'.repeat(35)}`;
      const embed = 'https://embed.example/player?asset=one&mode=wide';
      await page.keyboard.insertText(`<p>Read <a href="${destination}" target="_blank">the guide</a> or <a href="../related">related content</a>.</p><iframe title="Example video" src="${embed.replace('&', '&amp;')}"></iframe>`);
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      const frame = page.frameLocator('iframe[title="Body preview"]');
      const link = frame.getByRole('button', { name: 'the guide', exact: true });
      if (touch) await link.tap();
      else await link.click();
      const details = frame.getByRole('dialog', { name: 'Link details' });
      await expect(details).toBeVisible();
      await expect(details.locator('.preview-url')).toHaveText(destination);
      await expect(details).toContainText('New window (_blank)');
      await expect(details.getByRole('heading', { name: 'Link details' })).toBeInViewport();
      expect(await details.locator('.preview-url').evaluate((node) => node.scrollTop)).toBe(0);
      expect(await details.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      await expect(details.getByRole('button', { name: 'Close' })).toBeInViewport();
      if (touch) {
        await details.getByRole('button', { name: 'Close' }).tap();
      } else {
        await details.getByRole('button', { name: 'Close' }).press('Escape');
        await expect(details).toBeHidden();
        await expect(link).toBeFocused();
        await link.press('Enter');
        await expect(details).toBeVisible();
        await details.getByRole('button', { name: 'Close' }).click();
      }
      await expect(details).toBeHidden();
      const relative = frame.getByRole('button', { name: 'related content', exact: true });
      if (touch) await relative.tap();
      else await relative.click();
      await expect(details.locator('.preview-url')).toHaveText('../related');
      await expect(details).toContainText('Current window');
      await details.getByRole('button', { name: 'Close' }).click();
      await expect(frame.locator('.preview-embed strong')).toHaveText('Example video');
      await expect(frame.locator('.preview-embed .preview-url')).toHaveText(embed);
      await expect(frame.locator('.preview-embed-note')).toHaveText('Not loaded in this preview.');
      expect(requestedDestinations).toEqual([]);
      expect(page.context().pages()).toHaveLength(1);
      expect(new URL(page.url()).pathname).toBe('/pages/new');
    });
  });
}
