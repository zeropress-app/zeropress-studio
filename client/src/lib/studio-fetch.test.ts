import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resetStudioAccessInterruptionListenersForTests,
  studioFetch,
  subscribeStudioAccessInterruption,
} from './studio-fetch';

afterEach(() => {
  resetStudioAccessInterruptionListenersForTests();
  vi.unstubAllGlobals();
});

function jsonError(status: number, code: string) {
  return new Response(JSON.stringify({
    success: false,
    error: { code },
  }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('studioFetch', () => {
  it('sets the common AJAX and same-origin credential policy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 204,
    }));
    vi.stubGlobal('fetch', fetchMock);
    await studioFetch('/api/example', {
      headers: { Accept: 'application/json' },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('same-origin');
    const headers = new Headers(init.headers);
    expect(headers.get('Accept')).toBe('application/json');
    expect(headers.get('X-Requested-With')).toBe('XMLHttpRequest');
  });

  it('distinguishes an outer non-JSON 401 from a Studio JSON 401', async () => {
    const listener = vi.fn();
    subscribeStudioAccessInterruption(listener);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Access sign-in required', {
        status: 401,
        headers: { 'Content-Type': 'text/html' },
      }))
      .mockResolvedValueOnce(jsonError(401, 'AUTHENTICATION_REQUIRED'));
    vi.stubGlobal('fetch', fetchMock);

    await studioFetch('/api/outer');
    expect(listener).toHaveBeenLastCalledWith('outer_session_required');
    listener.mockClear();
    await studioFetch('/api/studio');
    expect(listener).not.toHaveBeenCalled();
  });

  it('publishes Studio Access requirement and availability failures', async () => {
    const listener = vi.fn();
    subscribeStudioAccessInterruption(listener);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonError(403, 'CLOUDFLARE_ACCESS_REQUIRED'))
      .mockResolvedValueOnce(jsonError(
        503,
        'CLOUDFLARE_ACCESS_VERIFICATION_UNAVAILABLE',
      )));

    await studioFetch('/api/required');
    await studioFetch('/api/unavailable');
    expect(listener.mock.calls).toEqual([
      ['requirement_not_satisfied'],
      ['verification_unavailable'],
    ]);
  });
});
