import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/studio-test';
import { signInAsAdministrator } from '../support/journeys';

type BrowserApiRequest = {
  path: string;
  method?: 'GET' | 'POST' | 'PUT';
  body?: unknown;
  csrfToken?: string;
  expectedStatus?: number;
};

type RoutingSettings = {
  permalinks: {
    output_style: 'directory' | 'html-extension';
    posts: string;
    pages: string;
    categories: string;
    tags: string;
  };
  front_page:
    | { type: 'theme_index' }
    | { type: 'page'; page_id: string }
    | { type: 'standalone_html'; html: string };
  post_index: {
    enabled: boolean;
    path: string;
    paginate: boolean;
  };
};

function successData<T>(value: unknown): T {
  if (
    typeof value !== 'object'
    || value === null
    || !('success' in value)
    || value.success !== true
    || !('data' in value)
  ) {
    throw new Error(`Expected a successful API response: ${JSON.stringify(value)}`);
  }
  return value.data as T;
}

async function requestJson(
  page: Page,
  input: BrowserApiRequest,
): Promise<unknown> {
  const result = await page.evaluate(async (request) => {
    const response = await fetch(request.path, {
      method: request.method ?? 'GET',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        ...(request.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
        ...(request.csrfToken
          ? { 'X-ZeroPress-CSRF': request.csrfToken }
          : {}),
      },
      body: request.body === undefined
        ? undefined
        : JSON.stringify(request.body),
    });
    return {
      status: response.status,
      value: await response.json() as unknown,
    };
  }, input);

  expect(
    result.status,
    `${input.method ?? 'GET'} ${input.path} returned ${result.status}: ${JSON.stringify(result.value)}`,
  ).toBe(input.expectedStatus ?? 200);
  return result.value;
}

test.describe('Post and Page public permalink presentation', () => {
  test.use({ studioProfile: 'operational' });

  test('renders current public URLs while keeping titles linked to Studio editors', async ({
    page,
    studioRuntime,
  }) => {
    await signInAsAdministrator(page, studioRuntime);

    const session = successData<{ csrf_token: string }>(await requestJson(
      page,
      { path: '/api/auth/session' },
    ));
    const csrfToken = session.csrf_token;

    const authorRequest = {
      id: 'permalink-e2e-author',
      display_name: 'Permalink E2E Author',
      user_id: null,
      avatar_media_id: null,
    };
    const author = successData<{ id: string }>(await requestJson(page, {
      path: '/api/authors',
      method: 'POST',
      body: authorRequest,
      csrfToken,
      expectedStatus: 201,
    }));

    const postRequest = {
      title: 'Permalink E2E Post',
      slug: 'permalink-e2e-post',
      content: 'Post body',
      document_type: 'plaintext',
      editor_mode: 'source',
      editor_profile: null,
      excerpt: '',
      status: 'draft',
      author_id: author.id,
      category_ids: [],
      tag_ids: [],
      discoverability: 'default',
      allow_comments: true,
      featured_image_id: null,
    };
    const post = successData<{ id: string; public_id: number }>(await requestJson(page, {
      path: '/api/posts',
      method: 'POST',
      body: postRequest,
      csrfToken,
      expectedStatus: 201,
    }));

    const parentPageRequest = {
      parent_id: null,
      title: 'Permalink E2E Docs',
      slug: 'permalink-e2e-docs',
      content: 'Documentation home',
      document_type: 'plaintext',
      editor_mode: 'source',
      editor_profile: null,
      excerpt: '',
      status: 'published',
      discoverability: 'default',
      allow_comments: false,
      featured_image_id: null,
    };
    const parentPage = successData<{ id: string }>(await requestJson(page, {
      path: '/api/pages',
      method: 'POST',
      body: parentPageRequest,
      csrfToken,
      expectedStatus: 201,
    }));

    const childPageRequest = {
      ...parentPageRequest,
      parent_id: parentPage.id,
      title: 'Permalink E2E Guide',
      slug: 'permalink-e2e-guide',
      content: 'Nested guide',
      status: 'draft',
    };
    const childPage = successData<{ id: string }>(await requestJson(page, {
      path: '/api/pages',
      method: 'POST',
      body: childPageRequest,
      csrfToken,
      expectedStatus: 201,
    }));

    const currentRouting = successData<{
      settings: RoutingSettings;
      revision: string;
    }>(await requestJson(page, { path: '/api/settings/routing' }));
    const routingRequest = {
      expected_revision: currentRouting.revision,
      settings: {
        ...currentRouting.settings,
        permalinks: {
          ...currentRouting.settings.permalinks,
          output_style: 'html-extension',
          posts: '/journal/:public_id/',
          pages: '/content/:slug/',
        },
        front_page: { type: 'page', page_id: parentPage.id },
        post_index: {
          ...currentRouting.settings.post_index,
          path: '/updates/',
        },
      },
    };
    successData(await requestJson(page, {
      path: '/api/settings/routing',
      method: 'PUT',
      body: routingRequest,
      csrfToken,
    }));

    await page.goto('/posts');
    await expect(page.getByRole('heading', { level: 1, name: 'Posts' }))
      .toBeVisible();
    const postLink = page.getByRole('link', { name: /Permalink E2E Post/u });
    await expect(postLink).toHaveAttribute('href', `/posts/${post.id}`);
    await expect(postLink.getByText(`/journal/${post.public_id}`, {
      exact: true,
    })).toBeVisible();

    await page.goto('/pages');
    await expect(page.getByRole('heading', { level: 1, name: 'Pages' }))
      .toBeVisible();
    const parentPageLink = page.getByRole('link', {
      name: /Permalink E2E Docs/u,
    });
    await expect(parentPageLink).toHaveAttribute(
      'href',
      `/pages/${parentPage.id}`,
    );
    await expect(parentPageLink.getByText('/', { exact: true })).toBeVisible();

    const childPageLink = page.getByRole('link', {
      name: /Permalink E2E Guide/u,
    });
    await expect(childPageLink).toHaveAttribute(
      'href',
      `/pages/${childPage.id}`,
    );
    await expect(childPageLink.getByText(
      '/content/permalink-e2e-docs/permalink-e2e-guide',
      { exact: true },
    )).toBeVisible();
  });
});
