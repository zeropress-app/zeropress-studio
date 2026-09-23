import {
  PUBLISHING_DEFAULTS,
  PUBLISHING_INITIAL_REVISION,
  type PublishingSettingsDocument,
} from '../../contracts/publishing';
import { expect, test } from '../fixtures/studio-test';
import { signInAsAdministrator } from '../support/journeys';
test.use({ studioProfile: 'operational' });
test('connects and publishes synthetic site data with keyboard, mobile and localized feedback', async ({
  page,
  context,
  studioRuntime,
}) => {
  const unexpected: string[] = [];
  const writes: unknown[] = [];
  const target = {
    owner: 'example',
    repo: 'site',
    branch: 'release/current',
    path: 'data/preview.json',
  };
  let file = {
    target,
    blob_sha: 'b'.repeat(40),
    metadata_status: 'valid',
    data_hash: 'a'.repeat(64),
    commit: {
      sha: 'c'.repeat(40),
      url: 'https://github.com/example/site/commit/' + 'c'.repeat(40),
      committed_at_iso: '2026-09-21T12:00:00Z',
    },
  };
  let settings: PublishingSettingsDocument = {
    settings: { ...PUBLISHING_DEFAULTS },
    configured: false,
    token_configured: false,
    revision: PUBLISHING_INITIAL_REVISION,
    updated_at_iso: null,
  };
  let preparedHash = 'd'.repeat(64);
  let outcome = 'committed';
  let fail = false;
  let release: () => void = () => {};
  let hold: Promise<void> | undefined;
  await context.route(/^https:\/\/(?:api\.)?github\.com\//, async (route) => {
    unexpected.push(route.request().url());
    await route.abort();
  });
  // Publishing APIs are fully synthetic; no request can reach a real repository.
  await page.route(
    /\/api\/(?:publishing(?:\/|\?|$)|settings\/publishing(?:\/|\?|$))/,
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/settings/publishing' && request.method() === 'GET')
        await route.fulfill({ json: { success: true, data: settings } });
      else if (path === '/api/settings/publishing/test-connection') {
        expect(request.postDataJSON().credential).toBe(
          'synthetic-github-token',
        );
        await route.fulfill({ json: { success: true, data: file } });
      } else if (
        path === '/api/settings/publishing' &&
        request.method() === 'PUT'
      ) {
        const body = request.postDataJSON();
        expect(body.settings).toEqual({
          enabled: expect.any(Boolean),
          ...target,
        });
        settings = {
          settings: body.settings,
          configured: true,
          token_configured: true,
          revision: (body.settings.enabled ? 'e' : 'd').repeat(32),
          updated_at_iso: '2026-09-21T12:00:00Z',
        };
        await route.fulfill({ json: { success: true, data: settings } });
      } else if (path === '/api/publishing/status')
        await route.fulfill({
          json: {
            success: true,
            data: {
              enabled: settings.settings.enabled,
              configured: settings.configured,
              revision: settings.revision,
              file:
                settings.configured && settings.settings.enabled ? file : null,
            },
          },
        });
      else if (path === '/api/publishing' && request.method() === 'POST') {
        expect(request.headers()['x-zeropress-csrf']).toBeTruthy();
        expect(request.postDataJSON()).toEqual({
          expected_revision: settings.revision,
          expected_data_hash: preparedHash,
          expected_blob_sha: file.blob_sha,
        });
        writes.push(request.postDataJSON());
        await hold;
        if (!fail) file = { ...file, data_hash: preparedHash };
        await route.fulfill(
          fail
            ? {
                status: 503,
                json: {
                  success: false,
                  error: { code: 'PUBLISHING_RESULT_UNKNOWN' },
                },
              }
            : { json: { success: true, data: { outcome, file } } },
        );
      } else {
        unexpected.push(path);
        await route.abort();
      }
    },
  );
  await page.route('**/api/preview-data', (route) => route.fulfill({ json: {
    success: true, data: {
      data_hash: preparedHash,
      preview_data: {
        version: '0.7', generator: 'synthetic/1.0', generated_at: '2026-09-23T00:00:00Z',
        site: { title: `Example ${preparedHash[0]}`, description: '', url: '', media_origin: '', locale: 'en-US',
          posts_per_page: 10, date_style: 'medium', time_style: 'none', timezone: 'UTC', robots: { allow_indexing: false } },
        content: { authors: [], posts: [], pages: [], categories: [], tags: [] },
      },
      validation: { status: 'valid', contract_version: '0.7', warnings: [] },
    },
  } }));
  await page.route('**/api/system/interface-config', (route) =>
    route.fulfill({
      json: {
        success: true,
        data: { default_locale: 'en', enabled_locales: ['en', 'ko'] },
      },
    }),
  );
  await signInAsAdministrator(page, studioRuntime);
  await page
    .getByRole('navigation', { name: 'Studio navigation' })
    .getByRole('link', { name: 'Publish site', exact: true })
    .click();
  await expect(
    page.getByText(
      'To publish directly to GitHub, connect a repository in publishing settings.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Prepare data' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Publishing settings' }).click();
  await page
    .getByLabel('GitHub file URL')
    .fill(
      'https://github.com/example/site/blob/release/current/data/preview.json',
    );
  await expect(page.getByLabel('Repository owner')).toHaveAttribute(
    'readonly',
    '',
  );
  const manual = page.getByRole('switch', { name: 'Enter target manually' });
  await manual.focus();
  await page.keyboard.press('Space');
  await expect(page.getByLabel('Branch')).toBeEditable();
  await page.keyboard.press('Space');
  await page
    .getByLabel('GitHub Token', { exact: true })
    .fill('synthetic-github-token');
  await page.getByRole('button', { name: 'Check connection' }).click();
  await expect(
    page.getByText(/branch and JSON file are accessible/),
  ).toBeVisible();
  await expect(page.getByLabel('Branch')).toHaveValue('release/current');
  await page.getByRole('button', { name: 'Save publishing settings' }).click();
  await expect(page.getByText('Publishing settings saved.')).toBeVisible();
  await expect(page.getByLabel('GitHub Token', { exact: true })).toHaveValue(
    '',
  );
  await page
    .getByRole('navigation', { name: 'Studio navigation' })
    .getByRole('link', { name: 'Publish site', exact: true })
    .click();
  await expect(page.getByText('GitHub publishing is turned off')).toBeVisible();
  await expect(
    page.getByText(
      'To use your saved connection, turn on “Publish to GitHub” in publishing settings and save.',
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Prepare data' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Preview Data' }).click();
  expect((await download).suggestedFilename()).toMatch(/^zeropress-preview-data-.*\.json$/);
  expect(writes).toHaveLength(0);
  await page.getByRole('link', { name: 'Publishing settings' }).click();
  const enablePublishing = page.getByRole('switch', {
    name: 'Publish to GitHub',
  });
  await enablePublishing.focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Save publishing settings' }).click();
  await expect(page.getByText('Publishing settings saved.')).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Studio navigation' })
    .getByRole('link', { name: 'Publish site', exact: true })
    .click();
  await expect(page.getByRole('button', { name: 'Publish to GitHub' })).toBeDisabled();
  await page.getByRole('button', { name: 'Prepare data' }).click();
  await expect(page.getByText('There are changes to publish.')).toBeVisible();
  hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.getByRole('button', { name: 'Publish to GitHub' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Publish to GitHub?' });
  await expect(confirmation).toBeVisible();
  await expect(
    confirmation.getByText('example/site', { exact: true }),
  ).toBeVisible();
  await expect(
    confirmation.getByText(target.branch, { exact: true }),
  ).toBeVisible();
  await expect(
    confirmation.getByText(target.path, { exact: true }),
  ).toBeVisible();
  await expect(
    confirmation.getByRole('button', { name: 'Cancel' }),
  ).toBeFocused();
  expect(writes).toHaveLength(0);
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  await expect(
    page.getByRole('button', { name: 'Publish to GitHub' }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(confirmation).toBeVisible();
  await page.keyboard.press('Escape');
  expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Publish to GitHub' }).click();
  await confirmation.getByRole('button', { name: 'Publish to GitHub' }).click();
  await expect(
    page.getByRole('button', { name: 'Publishing…' }),
  ).toBeDisabled();
  release();
  hold = undefined;
  await expect(page.getByText('Updated on GitHub.')).toBeVisible();
  expect(writes).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Publish to GitHub' })).toBeDisabled();
  await page.getByRole('button', { name: 'Prepare data again' }).click();
  await expect(page.getByText('The prepared data is already on GitHub.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish to GitHub' })).toBeDisabled();
  expect(writes).toHaveLength(1);
  preparedHash = 'e'.repeat(64);
  await page.getByRole('button', { name: 'Prepare data again' }).click();
  await expect(page.getByText('There are changes to publish.')).toBeVisible();
  outcome = 'unchanged';
  await page.getByRole('button', { name: 'Publish to GitHub' }).click();
  await confirmation.getByRole('button', { name: 'Publish to GitHub' }).click();
  await expect(page.getByText('The prepared data is already on GitHub.')).toBeVisible();
  preparedHash = 'f'.repeat(64);
  await page.getByRole('button', { name: 'Prepare data again' }).click();
  await expect(page.getByText('There are changes to publish.')).toBeVisible();
  fail = true;
  await page.getByRole('button', { name: 'Publish to GitHub' }).click();
  await confirmation.getByRole('button', { name: 'Publish to GitHub' }).click();
  await expect(
    page.getByText('Check whether the publish completed'),
  ).toBeVisible();
  expect(writes).toHaveLength(3);
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(
    page.getByRole('button', { name: 'Publish to GitHub' }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Open account menu for Studio E2E Owner' })
    .click();
  await page.getByRole('link', { name: 'Studio preferences' }).click();
  await page.getByLabel('Studio interface language').selectOption('ko');
  await page
    .getByRole('navigation', { name: 'Studio 내비게이션' })
    .getByRole('link', { name: '사이트 발행', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: '사이트 발행', exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '데이터 준비' }).click();
  await expect(page.getByText('발행할 변경 사항이 있습니다.')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'GitHub에 발행' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'GitHub에 발행' }).click();
  const localizedConfirmation = page.getByRole('dialog', {
    name: 'GitHub에 발행할까요?',
  });
  await expect(localizedConfirmation).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await localizedConfirmation.getByRole('button', { name: '취소' }).click();
  expect(writes).toHaveLength(3);
  await page.getByRole('link', { name: '발행 설정' }).click();
  await expect(page.getByLabel('GitHub 파일 URL')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(unexpected).toEqual([]);
});
