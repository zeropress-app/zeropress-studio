// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  requestGeneratePageDraft,
  requestGeneratePageExcerpt,
} from './pages-client';
import {
  requestGeneratePostDraft,
  requestGeneratePostEdit,
  requestGeneratePostExcerpt,
} from './posts-client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AI excerpt clients', () => {
  it('sends Post and Page drafts to their target-aware endpoints', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response(
      JSON.stringify({
        success: true,
        data: { excerpt: 'Generated.', source_truncated: false },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const request = {
      title: 'Title',
      content: '<p>Body</p>',
      document_type: 'html' as const,
    };

    await expect(requestGeneratePostExcerpt('csrf', request)).resolves
      .toMatchObject({ success: true });
    await expect(requestGeneratePageExcerpt('csrf', request)).resolves
      .toMatchObject({ success: true });

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      '/api/posts/ai/excerpt',
      '/api/pages/ai/excerpt',
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({
        method: 'POST',
        credentials: 'same-origin',
        headers: expect.objectContaining({ 'X-ZeroPress-CSRF': 'csrf' }),
        body: JSON.stringify(request),
      });
    }
  });

  it('sends a Post draft brief to the dedicated bounded endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        title: 'Generated title',
        excerpt: 'Generated excerpt.',
        content: '<p>Generated body.</p>',
        document_type: 'html',
        editor_mode: 'visual',
        editor_profile: 'tiptap-v1',
      },
    }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const request = {
      title: 'Working title',
      brief: 'Cover the practical steps.',
      tone: 'informative' as const,
      length: 'medium' as const,
      document_type: 'html' as const,
      editor_mode: 'visual' as const,
    };

    await expect(requestGeneratePostDraft('csrf', request)).resolves
      .toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/posts/ai/draft',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: expect.objectContaining({ 'X-ZeroPress-CSRF': 'csrf' }),
        body: JSON.stringify(request),
      }));
  });

  it('binds a selected Post edit to its canonical revision and Post ID', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: { replacement: 'Reviewed replacement.' },
    }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const request = {
      expected_revision: 'a'.repeat(32),
      operation: 'rewrite' as const,
      instruction: 'Make it direct.',
      tone: 'preserve' as const,
      target: {
        document_type: 'plaintext' as const,
        editor_mode: 'source' as const,
      },
      selection: {
        kind: 'source' as const,
        source: 'Current passage.',
        context_before: 'Before.',
        context_after: 'After.',
      },
    };

    await expect(requestGeneratePostEdit(
      'csrf',
      '1'.repeat(32),
      request,
    )).resolves.toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/posts/${'1'.repeat(32)}/ai/edit`,
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: expect.objectContaining({ 'X-ZeroPress-CSRF': 'csrf' }),
        body: JSON.stringify(request),
      }),
    );
  });

  it('sends a purpose-specific Page brief to the dedicated bounded endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true,
      data: {
        title: 'Generated Page',
        excerpt: 'Generated excerpt.',
        content: 'Generated body.',
        document_type: 'plaintext',
        editor_mode: 'source',
        editor_profile: null,
      },
    }), { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const request = {
      title: 'About',
      brief: 'Use only supplied facts.',
      preset: 'about' as const,
      tone: 'professional' as const,
      length: 'short' as const,
      document_type: 'plaintext' as const,
      editor_mode: 'source' as const,
    };

    await expect(requestGeneratePageDraft('csrf', request)).resolves
      .toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/pages/ai/draft',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: expect.objectContaining({ 'X-ZeroPress-CSRF': 'csrf' }),
        body: JSON.stringify(request),
      }));
  });
});
