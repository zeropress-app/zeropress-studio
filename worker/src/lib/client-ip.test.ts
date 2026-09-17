import { describe, expect, it } from 'vitest';
import { normalizeIpAddress, resolveTrustedClientIp } from './client-ip';

describe('client IP normalization', () => {
  it.each([
    [' 203.0.113.10 ', '203.0.113.10'],
    ['2001:0DB8:0:0::1', '2001:db8::1'],
    ['::ffff:192.0.2.1', '::ffff:c000:201'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeIpAddress(input)).toBe(expected);
  });

  it.each([
    '', 'unknown', '127.000.0.1', '192.0.2.999', '127.1',
    '203.0.113.10, 192.0.2.1', '203.0.113.10:443', '192.0.2.0/24',
    '[::1]', 'fe80::1%eth0', '::\n1', '::1]/path', '::1]#fragment',
  ])('rejects malformed address %j', (input) => {
    expect(normalizeIpAddress(input)).toBeNull();
  });
});

describe('trusted client IP resolution', () => {
  it('uses the normalized Cloudflare IP even with a conflicting forwarded address', () => {
    expect(resolveTrustedClientIp(new Request('https://studio.example/', {
      headers: {
        'CF-Connecting-IP': '2001:0DB8::1',
        'X-Forwarded-For': '127.0.0.1',
      },
    }))).toBe('2001:db8::1');
  });

  it.each([
    'https://studio.example/',
    'http://localhost:5173/',
    'http://127.0.0.1:5173/',
    'http://[::1]:5173/',
    'http://studio.local/',
    'http://localhost.example/',
    'http://127.0.0.1.example/',
    'http://192.168.1.10/',
  ])('does not infer the client IP from URL %s or forwarded headers', (url) => {
    expect(resolveTrustedClientIp(new Request(url))).toBeNull();
    expect(resolveTrustedClientIp(new Request(url, {
      headers: {
        'X-Forwarded-For': '127.0.0.1',
        'X-Real-IP': '127.0.0.1',
        Forwarded: 'for=127.0.0.1',
      },
    }))).toBeNull();
  });

  it.each(['', 'not-an-ip', '192.0.2.1, 192.0.2.2'])(
    'does not fall back when the Cloudflare header is invalid: %j',
    (value) => {
      for (const url of ['https://studio.example/', 'http://localhost:5173/']) {
        expect(resolveTrustedClientIp(new Request(url, {
          headers: {
            'CF-Connecting-IP': value,
            'X-Forwarded-For': '203.0.113.10',
          },
        }))).toBeNull();
      }
    },
  );
});
