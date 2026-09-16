// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestMenuReferences } from './menus-client';

const post = { kind: 'post' as const, reference_id: '1'.repeat(32) };
const page = { kind: 'page' as const, reference_id: '1'.repeat(32) };

function response(items: unknown[]) {
  return new Response(JSON.stringify({ success: true, data: { items } }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('Menu reference client', () => {
  it('sends a protected read-only batch and accepts a reordered but complete typed result', async () => {
    const items = [{ ...page, status: 'trash' }, { ...post, status: 'missing' }];
    const fetch = vi.fn().mockResolvedValue(response(items));
    vi.stubGlobal('fetch', fetch);
    await expect(requestMenuReferences('csrf-token', { references: [post, page] }))
      .resolves.toEqual({ success: true, data: { items } });
    expect(fetch).toHaveBeenCalledWith('/api/menus/link-references', expect.objectContaining({
      method: 'POST', credentials: 'same-origin',
      headers: expect.objectContaining({ 'X-ZeroPress-CSRF': 'csrf-token' }),
      body: JSON.stringify({ references: [post, page] }),
    }));
  });

  it.each([
    [{ ...post, status: 'missing' }],
    [{ ...post, status: 'missing' }, { ...post, status: 'missing' }],
    [{ ...post, status: 'missing' }, { ...page, reference_id: '2'.repeat(32), status: 'missing' }],
  ])('rejects incomplete, duplicate, and unsolicited identities: %j', async (...items) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(items)));
    await expect(requestMenuReferences('csrf-token', { references: [post, page] }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
