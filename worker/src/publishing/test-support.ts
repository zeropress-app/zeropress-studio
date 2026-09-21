import { beforeEach, afterEach, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type {
  PublishingSettingsDocument,
  PublishingTarget,
} from '../../../contracts/publishing';
import { PUBLISHING_INITIAL_REVISION } from '../../../contracts/publishing';
import type { PreviewDataExportDocument } from '../../../contracts/preview-data';
export const TOKEN = 'synthetic-github-token';
export const TARGET: PublishingTarget = {
  owner: 'example',
  repo: 'site',
  branch: 'main',
  path: 'data/preview.json',
};
export const NOW = '2026-09-21T12:00:00.000Z';
export const DOCUMENT: PublishingSettingsDocument = {
  settings: { enabled: true, ...TARGET },
  token_configured: true,
  configured: true,
  revision: PUBLISHING_INITIAL_REVISION,
  updated_at_iso: null,
};
export function forbidPublishingNetwork() {
  const unexpected = vi.fn(() => {
    throw new Error('Unexpected real network request');
  });
  beforeEach(() => {
    unexpected.mockClear();
    vi.stubGlobal('fetch', unexpected);
  });
  afterEach(() => {
    expect(unexpected).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
}
export function previewDocument(): PreviewDataExportDocument {
  return {
    preview_data: {
      version: '0.7',
      generator: 'synthetic/1.0',
      generated_at: NOW,
      site: {
        title: 'Example',
        description: '',
        url: 'https://example.test',
        media_origin: '',
        locale: 'en-US',
        posts_per_page: 10,
        date_style: 'medium',
        time_style: 'none',
        timezone: 'UTC',
        robots: { allow_indexing: false },
      },
      content: { authors: [], posts: [], pages: [], categories: [], tags: [] },
    },
    validation: { status: 'valid', contract_version: '0.7', warnings: [] },
  };
}
export function syntheticGithub(
  options: {
    target?: PublishingTarget;
    message?: string;
    blob?: string;
    mode?: string;
    type?: string;
    putStatus?: number;
    putMessage?: string;
    loseResponse?: boolean;
    loseWithoutWrite?: boolean;
    headers?: Record<string, string>;
    readStatus?: number;
    truncated?: boolean;
    missing?: boolean;
  } = {},
) {
  const target = options.target ?? TARGET;
  const state = {
    head: 'a'.repeat(40),
    blob: options.blob ?? 'b'.repeat(40),
    lastCommit: 'c'.repeat(40),
    message: options.message ?? 'External update',
    uploads: [] as Record<string, string>[],
  };
  const requests: { url: URL; method: string }[] = [];
  const root = `/repos/${target.owner}/${target.repo}`;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    requests.push({ url, method });
    expect(url.origin).toBe('https://api.github.com');
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(init?.redirect).toBe('manual');
    expect(url.searchParams.has('recursive')).toBe(false);
    if (options.readStatus && method === 'GET')
      return Response.json(
        { message: 'synthetic provider failure' },
        { status: options.readStatus, headers: options.headers },
      );
    if (
      url.pathname ===
      `${root}/git/ref/heads/${target.branch.split('/').map(encodeURIComponent).join('/')}`
    )
      return Response.json({
        ref: `refs/heads/${target.branch}`,
        object: { type: 'commit', sha: state.head },
      });
    if (url.pathname.includes('/git/ref/heads/'))
      return Response.json({ message: 'Not found' }, { status: 404 });
    if (url.pathname === `${root}/git/commits/${state.head}`)
      return Response.json({ tree: { sha: 'd'.repeat(40) } });
    if (url.pathname === `${root}/commits`) {
      expect(url.searchParams.get('sha')).toBe(state.head);
      expect(url.searchParams.get('path')).toBe(target.path);
      expect(url.searchParams.get('per_page')).toBe('1');
      expect(url.searchParams.has('author')).toBe(false);
      return Response.json([
        {
          sha: state.lastCommit,
          commit: { message: state.message, committer: { date: NOW } },
        },
      ]);
    }
    const segments = target.path.split('/');
    for (let index = 0; index < segments.length; index++) {
      const tree = (index === 0 ? 'd' : String(index)).repeat(40);
      if (url.pathname === `${root}/git/trees/${tree}`) {
        const leaf = index === segments.length - 1;
        return Response.json({
          truncated: options.truncated ?? false,
          tree: options.missing
            ? []
            : [
                {
                  path: segments[index],
                  type: leaf ? (options.type ?? 'blob') : 'tree',
                  mode: leaf ? (options.mode ?? '100644') : '040000',
                  sha: leaf ? state.blob : String(index + 1).repeat(40),
                },
              ],
        });
      }
    }
    if (
      url.pathname === `${root}/contents/${target.path}` &&
      method === 'PUT'
    ) {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      state.uploads.push(body);
      expect(body.branch).toBe(target.branch);
      expect(body.sha).toBe(state.blob);
      if (options.putStatus)
        return Response.json(
          { message: options.putMessage ?? 'synthetic rejection' },
          { status: options.putStatus, headers: options.headers },
        );
      if (options.loseWithoutWrite) throw new Error('Synthetic response loss');
      const bytes = Buffer.from(body.content!, 'base64');
      state.blob = createHash('sha1')
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest('hex');
      state.message = body.message!;
      state.head = 'e'.repeat(40);
      state.lastCommit = state.head;
      if (options.loseResponse) throw new Error('Synthetic response loss');
      return Response.json({
        content: { sha: state.blob },
        commit: { sha: state.lastCommit, committer: { date: NOW } },
      });
    }
    throw new Error(
      `Unexpected synthetic GitHub call: ${method} ${url.pathname}`,
    );
  });
  return { fetch, state, requests };
}
