import type { PageListItem } from '../../../contracts/pages';
import type { PostListItem } from '../../../contracts/posts';
import type { TaxonomyListItem } from '../../../contracts/taxonomies';

const NOW = '2026-09-01T00:00:00.000Z';

export const referencePost: PostListItem = {
  id: 'a'.repeat(32), public_id: 100_000_000_001, title: 'Found Post', slug: 'found-post',
  public_url: '/posts/found-post/',
  document_type: 'markdown', excerpt: '', status: 'published',
  author: { id: 'Studio-Owner', display_name: 'Studio Owner' },
  discoverability: 'default', allow_comments: false, published_at_iso: NOW,
  revision: '1'.repeat(32), created_at_iso: NOW, updated_at_iso: NOW, search_match: null,
};

export const referencePage: PageListItem = {
  id: 'b'.repeat(32), public_id: 100_000_000_001, title: 'Guide', slug: 'guide',
  public_url: '/docs/guide/',
  parent: { id: 'c'.repeat(32), title: 'Docs', slug: 'docs' }, path: 'docs/guide',
  document_type: 'html', excerpt: '', status: 'published', discoverability: 'default',
  allow_comments: false, revision: '2'.repeat(32), created_at_iso: NOW, updated_at_iso: NOW,
  search_match: null,
};

export const referenceCategory: TaxonomyListItem = {
  id: 'd'.repeat(32), taxonomy: 'category', name: 'News', slug: 'news', description: '',
  post_count: 0, revision: '3'.repeat(32), created_at_iso: NOW, updated_at_iso: NOW,
};

export function referenceSearchResponse(
  path: string,
  items: Array<PostListItem | PageListItem | TaxonomyListItem>,
  total = items.length,
) {
  const url = new URL(path, 'http://localhost');
  const perPage = Number(url.searchParams.get('per_page') ?? 20);
  const page = Number(url.searchParams.get('page') ?? 1);
  const taxonomy = url.pathname.startsWith('/api/taxonomies/');
  return new Response(JSON.stringify({
    success: true,
    data: {
      items,
      pagination: { page, per_page: perPage, total, total_pages: Math.ceil(total / perPage) },
      ...(url.pathname === '/api/posts' ? { access: { scope: 'all' } } : {}),
      ...(taxonomy ? { summary: { categories: total, tags: total } } : {
        status_counts: { all: total, draft: 0, published: total, trash: 0 },
      }),
    },
  }), { headers: { 'Content-Type': 'application/json' } });
}
