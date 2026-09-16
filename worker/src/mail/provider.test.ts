import { describe, expect, it, vi } from 'vitest';
import {
  MailProviderFailure,
  sendMail,
  verifyMailProviderCredential,
} from './provider';

describe('mail provider adapters', () => {
  it('verifies Resend credentials with a bounded authenticated request', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    await verifyMailProviderCredential({
      provider: 'resend',
      credential: 're_secret',
      fetchImplementation,
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://api.resend.com/domains?limit=1',
      expect.objectContaining({
        method: 'GET',
        redirect: 'manual',
        headers: expect.objectContaining({ Authorization: 'Bearer re_secret' }),
      }),
    );
  });

  it('classifies invalid credentials without exposing provider bodies', async () => {
    await expect(verifyMailProviderCredential({
      provider: 'cloudflare',
      credential: 'invalid-token',
      fetchImplementation: vi.fn().mockResolvedValue(new Response(
        JSON.stringify({ success: false, errors: [{ message: 'secret detail' }] }),
        { status: 401 },
      )),
    })).rejects.toEqual(expect.objectContaining({
      kind: 'authentication_failed',
    }));
  });

  it('sends Cloudflare REST mail without adding a Worker binding', async () => {
    const fetchImplementation = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ success: true, result: { id: 'mail-id' } }),
      { status: 200 },
    ));
    await sendMail({
      provider: 'cloudflare',
      credential: 'cloudflare-token',
      cloudflareAccountId: 'a'.repeat(32),
      fromEmail: 'mail@example.com',
      fromName: 'ZeroPress',
      to: 'owner@example.com',
      subject: 'Test',
      html: '<p>Test</p>',
      text: 'Test',
      fetchImplementation,
    });
    const [url, request] = fetchImplementation.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`/accounts/${'a'.repeat(32)}/email/sending/send`);
    expect(JSON.parse(String(request.body))).toMatchObject({
      from: { address: 'mail@example.com', name: 'ZeroPress' },
      to: ['owner@example.com'],
    });
  });

  it('classifies provider outages as operational failures', async () => {
    try {
      await verifyMailProviderCredential({
        provider: 'resend',
        credential: 're_secret',
        fetchImplementation: vi.fn().mockRejectedValue(new TypeError('offline')),
      });
      throw new Error('Expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(MailProviderFailure);
      expect(error).toMatchObject({
        kind: 'unavailable',
        operationalError: { code: 'MAIL_PROVIDER_REQUEST_FAILED' },
      });
    }
  });
});
