import { expect, test } from '../fixtures/studio-test';

test.use({ studioProfile: 'operations' });

test('synchronizes language and appearance across tabs and reloads', async ({
  context,
}) => {
  const first = await context.newPage();
  const second = await context.newPage();
  await Promise.all([
    first.goto('/system/operations'),
    second.goto('/system/operations'),
  ]);
  await expect(first.getByRole('heading', { name: 'Maintenance & Recovery' }))
    .toBeVisible();
  await expect(second.getByRole('heading', { name: 'Maintenance & Recovery' }))
    .toBeVisible();

  await first.getByRole('button', { name: 'Use dark appearance' }).click();
  await expect(second.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(second.getByRole('button', { name: 'Use light appearance' }))
    .toBeVisible();
  await expect.poll(() => second.evaluate(() => (
    localStorage.getItem('zeropress-studio.theme')
  ))).toBe('dark');

  await first.getByLabel('Interface language').selectOption('ko');
  await expect(second.getByRole('heading', { name: '유지보수 및 복구' }))
    .toBeVisible();
  await expect(second.getByLabel('인터페이스 언어')).toHaveValue('ko');
  await expect.poll(() => second.evaluate(() => (
    localStorage.getItem('zeropress-studio.locale')
  ))).toBe('ko');

  await second.reload();
  await expect(second.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(second.getByRole('heading', { name: '유지보수 및 복구' }))
    .toBeVisible();
  await expect(second.getByLabel('인터페이스 언어')).toHaveValue('ko');
});
