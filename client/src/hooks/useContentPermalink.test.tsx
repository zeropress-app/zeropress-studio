// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useContentPermalink } from './useContentPermalink';

const saved = { id: '1'.repeat(32), revision: 'a'.repeat(32) };
const value = { revision: saved.revision, status: 'published', url: 'https://site.example/saved/' };
function response(data: unknown) { return new Response(JSON.stringify({ success: true, data }), { headers: { 'Content-Type': 'application/json' } }); }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('refreshes only after the canonical document revision changes', async () => {
  const fetch = vi.fn().mockResolvedValue(response(value));
  vi.stubGlobal('fetch', fetch);
  const onSessionEnded = vi.fn();
  const { result, rerender } = renderHook(({ document }) => useContentPermalink('posts', document, onSessionEnded), { initialProps: { document: saved } });
  await waitFor(() => expect(result.current?.url).toBe(value.url));
  rerender({ document: { ...saved } });
  expect(fetch).toHaveBeenCalledTimes(1);
  const revision = 'b'.repeat(32);
  fetch.mockResolvedValue(response({ ...value, revision, url: 'https://site.example/updated/' }));
  rerender({ document: { ...saved, revision } });
  expect(result.current).toBeNull();
  await waitFor(() => expect(result.current?.url).toBe('https://site.example/updated/'));
});
it('does not attach an old request result to a different document', async () => {
  let complete!: (value: Response) => void;
  const fetch = vi.fn().mockReturnValue(new Promise<Response>((resolve) => { complete = resolve; }));
  vi.stubGlobal('fetch', fetch);
  const { result, rerender } = renderHook(({ document }) => useContentPermalink('pages', document, vi.fn()), { initialProps: { document: saved } });
  fetch.mockResolvedValue(response({ ...value, revision: 'b'.repeat(32), url: 'https://site.example/other/' }));
  rerender({ document: { id: '2'.repeat(32), revision: 'b'.repeat(32) } });
  await waitFor(() => expect(result.current?.url).toBe('https://site.example/other/'));
  await act(async () => complete(response(value)));
  expect(result.current?.url).toBe('https://site.example/other/');
});
