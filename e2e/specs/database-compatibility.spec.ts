import { expect, test } from '../fixtures/studio-test';

test.use({ studioProfile: 'operational-no-operations' });

test('explains schema compatibility across locales and resumes after a compatible deployment', async ({ page }) => {
  let compatible = false;
  await page.route('**/api/system/status', async (route) => {
    const response = await route.fetch();
    const status = await response.json();
    if (!compatible) {
      // Represent a future database paired with a rolled-back Worker without
      // changing the isolated runtime's database or lifecycle implementation.
      status.data.studio_version = '0.6.9';
      status.data.database = {
        state: 'newer_than_code',
        schema_version: 13,
        target_schema_version: 11,
      };
      status.data.access = { state: 'blocked', reason: 'DATABASE_NEWER_THAN_CODE' };
    }
    await route.fulfill({ response, json: status });
  });
  await page.goto('/');

  for (const locale of ['en', 'ko'] as const) {
    if (locale === 'ko') {
      await page.getByRole('combobox', { name: 'Language' }).selectOption('ko');
    }
    await expect(page.getByRole('heading', {
      name: locale === 'en' ? 'Update the Studio Worker' : 'Studio 업데이트 필요',
    })).toBeVisible();
    const comparison = page.getByRole('region', {
      name: locale === 'en' ? 'Version comparison' : '버전 비교',
    });
    await expect(comparison.locator('dd')).toHaveText(['0.6.9', '13', '11']);

    for (const width of [320, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(comparison).toBeVisible();
      const fits = await comparison.evaluate((element) => (
        document.documentElement.scrollWidth <= window.innerWidth
        && [...element.querySelectorAll('dt, dd')].every((cell) => (
          cell.scrollWidth <= cell.clientWidth + 1
        ))
      ));
      expect(fits).toBe(true);
    }
    await page.getByRole('button', {
      name: locale === 'en' ? 'Use dark appearance' : '다크 화면 사용',
    }).click();
    await expect(comparison).toBeVisible();
    await page.getByRole('button', {
      name: locale === 'en' ? 'Use light appearance' : '라이트 화면 사용',
    }).click();
  }

  await page.getByRole('combobox', { name: '언어' }).selectOption('en');
  compatible = true;
  await page.getByRole('button', { name: 'Check after deployment' }).click();
  await expect(page.getByLabel('Email', { exact: true })).toBeVisible();
});
