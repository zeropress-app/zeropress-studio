import type { ContentSearchIndexStatus } from '../../contracts/content-search-index';
import { expect, test } from '../fixtures/studio-test';
import { signInAsAdministrator } from '../support/journeys';

test.use({ studioProfile: 'operational-no-operations' });

test('rebuilds and resumes from the dashboard with keyboard and mobile controls', async ({
  page, studioRuntime,
}) => {
  // Synthetic checkpoints exercise the screen without modifying the local fixture database.
  let status: ContentSearchIndexStatus = {
    state: 'rebuild_required', reason: 'schema_upgrade', phase: null, operation_id: null,
    post_public_id_cursor: 0, page_public_id_cursor: 0,
    processed_posts: 0, processed_pages: 0, total_posts: 7, total_pages: 1, available: true,
  };
  const mutations: string[] = [];
  let loseResponse = true;
  await page.route('**/api/system/interface-config', (route) => route.fulfill({
    json: { success: true, data: { default_locale: 'en', enabled_locales: ['en', 'ko'] } },
  }));
  await page.route('**/api/dashboard/summary', async (route) => {
    const response = await route.fetch();
    const summary = await response.json();
    summary.data.content_search_index = { state: status.state };
    summary.data.mail = { configured: false };
    summary.data.edge = {
      status: 'available', pending_target_events: 0,
      comments: { pending: 0, enabled: true, api_configured: false },
      forms: null,
      newsletters: { pending_confirmations: 0, confirmation_enabled: false, confirmation_ready: false },
    };
    await route.fulfill({ response, json: summary });
  });
  await page.route(/\/api\/content-search-index(?:\/|$)/, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET') {
      await route.fulfill({ json: { success: true, data: status } });
      return;
    }
    expect(request.headers()['x-zeropress-csrf']).toBeTruthy();
    mutations.push(path);
    if (path.endsWith('/start')) {
      expect(request.postDataJSON()).toEqual({});
      status = { ...status, state: 'in_progress', phase: 'posts', operation_id: 'a'.repeat(32) };
    } else {
      expect(path).toBe('/api/content-search-index/rebuild/step');
      expect(request.postDataJSON()).toEqual({
        operation_id: status.operation_id, expected_phase: status.phase,
        expected_post_public_id_cursor: status.post_public_id_cursor,
        expected_page_public_id_cursor: status.page_public_id_cursor,
      });
      if (loseResponse) {
        loseResponse = false;
        status = { ...status, processed_posts: 5, post_public_id_cursor: 5 };
        await route.abort();
        return;
      }
      status = {
        ...status, state: 'ready', phase: null, operation_id: null,
        processed_posts: 7, post_public_id_cursor: 7,
        processed_pages: 1, page_public_id_cursor: 1,
      };
    }
    await route.fulfill({ json: { success: true, data: {
      operation: 'rebuild_content_search_index',
      status: status.state === 'ready' ? 'completed' : 'in_progress',
      content_search_index: status,
    } } });
  });
  await signInAsAdministrator(page, studioRuntime);
  const readiness = page.getByRole('region', { name: 'Service readiness' });
  const search = readiness.getByRole('group', { name: 'Post and Page search' });
  await expect(search).toContainText('Rebuild required');
  await readiness.getByRole('link', { name: 'Comment settings' }).click();
  await expect(page).toHaveURL(/\/settings\/edge\/comments#comment-api$/);
  await expect(page.getByRole('textbox', { name: 'ZeroPress API base URL' })).toBeFocused();
  await page.goto('/');
  await readiness.getByRole('link', { name: 'Delivery settings' }).click();
  await expect(page).toHaveURL(/\/newsletters\?tab=runtime$/);
  await expect(page.getByRole('switch', { name: 'Enable confirmation delivery' })).toBeVisible();
  await page.goto('/');
  await readiness.getByRole('link', { name: 'Mail settings' }).click();
  await expect(page).toHaveURL(/\/settings\/edge\/mail$/);
  await expect(page.getByRole('combobox', { name: 'Provider', exact: true })).toBeVisible();
  await page.goto('/');
  const start = search.getByRole('button', { name: 'Rebuild', exact: true });
  await expect(start).toBeEnabled();
  await start.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Rebuild the search index?' });
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  expect(mutations).toEqual([]);
  await start.click();
  await dialog.getByRole('button', { name: 'Rebuild', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('5 Posts · 0 Pages processed · Posts')).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('The connection was interrupted');

  await page.goto('/posts');
  await expect(page.getByRole('heading', { level: 1, name: 'Posts' })).toBeVisible();
  await page.goto('/');
  await expect(page.getByText('5 Posts · 0 Pages processed · Posts')).toBeVisible();
  await page.setViewportSize({ width: 320, height: 850 });
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= window.innerWidth
  ))).toBe(true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', {
    name: `Open account menu for ${studioRuntime.credentials.admin.name}`,
  }).click();
  await page.getByRole('link', { name: 'Studio preferences' }).click();
  await page.getByLabel('Studio interface language').selectOption('ko');
  await page.getByRole('navigation', { name: 'Studio 내비게이션' })
    .getByRole('link', { name: '대시보드', exact: true }).click();
  await page.setViewportSize({ width: 320, height: 850 });
  const koreanReadiness = page.getByRole('region', { name: '서비스 준비 상태' });
  const koreanSearch = koreanReadiness.getByRole('group', { name: '글·페이지 검색' });
  await expect(koreanSearch).toContainText('재구축 진행 중');
  await expect(koreanReadiness.getByRole('link', { name: '댓글 설정' })).toBeVisible();
  await expect(koreanReadiness.getByRole('link', { name: '전송 설정' })).toBeVisible();
  await expect(koreanReadiness.getByRole('link', { name: '메일 설정' })).toBeVisible();
  const resume = page.getByRole('button', { name: '이어서 실행' });
  await expect(resume).toBeEnabled();
  expect(await page.evaluate(() => (
    document.documentElement.scrollWidth <= window.innerWidth
  ))).toBe(true);
  await resume.focus();
  await page.keyboard.press('Enter');
  await expect(koreanSearch).toContainText('준비됨');
  expect(mutations).toEqual([
    '/api/content-search-index/rebuild/start',
    '/api/content-search-index/rebuild/step',
    '/api/content-search-index/rebuild/step',
  ]);
});
