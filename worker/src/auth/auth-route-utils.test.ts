import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Env, StudioHonoEnvironment } from '../types';
import { finishAuthentication } from './auth-route-utils';

describe('authentication session metadata', () => {
  it('records an unavailable IP instead of a forwarded or fabricated loopback address', async () => {
    const issueSession = vi.fn().mockResolvedValue({
      kind: 'issued',
      value: { cookieValue: 'session-cookie' },
    });
    const app = new Hono<StudioHonoEnvironment>();
    app.post('/finish', (c) => finishAuthentication({
      c,
      issueSession,
      userId: '1'.repeat(32),
      authRevision: '2'.repeat(32),
    }));

    const response = await app.fetch(new Request('https://studio.example/finish', {
      method: 'POST',
      headers: { 'X-Forwarded-For': '203.0.113.99' },
    }), { DB: {} } as Env);

    expect(response.status).toBe(200);
    expect(issueSession).toHaveBeenCalledWith(expect.objectContaining({
      ipAddress: 'unavailable',
    }));
  });
});
