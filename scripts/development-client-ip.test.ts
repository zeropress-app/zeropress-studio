import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { PreviewServer, ViteDevServer } from 'vite';
import { applyDevelopmentClientIp, developmentClientIp } from './development-client-ip';

const quickTunnelHost = 'studio-test.trycloudflare.com';
const visitorIp = '203.0.113.10';

function request(remoteAddress?: string, rawHeaders = [
  'Host', 'localhost:5173',
  'CF-Connecting-IP', '127.0.0.1',
  'cF-cOnNeCtInG-iP', '203.0.113.99',
  'X-Forwarded-For', '127.0.0.1',
  'Authorization', 'Bearer test-token',
]): IncomingMessage {
  const headers: Record<string, string> = {};
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index].toLowerCase();
    headers[name] = headers[name] === undefined
      ? rawHeaders[index + 1] : `${headers[name]}, ${rawHeaders[index + 1]}`;
  }
  return {
    socket: { remoteAddress }, headers, rawHeaders,
  } as unknown as IncomingMessage;
}

function tunnelRequest(
  remoteAddress = '127.0.0.1',
  ipHeaders = ['CF-Connecting-IP', visitorIp],
  host = quickTunnelHost,
): IncomingMessage {
  return request(remoteAddress, [
    'Host', host, ...ipHeaders, 'X-Forwarded-For', '127.0.0.1',
  ]);
}

describe('development client IP forwarding', () => {
  it.each([
    ['192.0.2.10', '192.0.2.10'],
    ['127.0.0.1', '127.0.0.1'],
    ['::1', '::1'],
    ['2001:db8::10', '2001:db8::10'],
    ['::ffff:192.0.2.10', '192.0.2.10'],
    ['::ffff:c000:20a', '192.0.2.10'],
  ])('uses socket %s despite forged Host and duplicate IP headers', (socketIp, expected) => {
    const incoming = request(socketIp);
    expect(applyDevelopmentClientIp(incoming)).toBe(true);
    expect(incoming.headers['cf-connecting-ip']).toBe(expected);
    expect(incoming.rawHeaders).toEqual([
      'Host', 'localhost:5173',
      'X-Forwarded-For', '127.0.0.1',
      'Authorization', 'Bearer test-token',
      'CF-Connecting-IP', expected,
    ]);
  });

  it.each([
    ['127.0.0.1', visitorIp, visitorIp, quickTunnelHost],
    ['127.2.3.4', visitorIp, visitorIp, quickTunnelHost],
    ['::1', '2001:0DB8:0:0::10', '2001:db8::10', quickTunnelHost],
    ['0:0:0:0:0:0:0:1', visitorIp, visitorIp, quickTunnelHost],
    ['::ffff:127.0.0.1', visitorIp, visitorIp, quickTunnelHost],
    ['::ffff:7f00:1', '::ffff:203.0.113.10', visitorIp, quickTunnelHost],
    ['127.0.0.1', visitorIp, visitorIp, 'STUDIO-TEST.TRYCLOUDFLARE.COM:443'],
  ])('uses Quick Tunnel socket %s to forward %s as %s with Host %s', (socketIp, ip, expected, host) => {
    const incoming = tunnelRequest(socketIp, ['cF-CoNnEcTiNg-Ip', ip], host);
    expect(applyDevelopmentClientIp(incoming)).toBe(true);
    expect(incoming.headers['cf-connecting-ip']).toBe(expected);
    expect(incoming.rawHeaders).toEqual([
      'Host', host, 'X-Forwarded-For', '127.0.0.1', 'CF-Connecting-IP', expected,
    ]);
  });

  it.each(['192.0.2.10', '2001:db8::10', '::ffff:192.0.2.10'])(
    'uses LAN socket %s even with Quick Tunnel headers', (socketIp) => {
      for (const ipHeaders of [['CF-Connecting-IP', visitorIp], ['CF-Connecting-IP', 'invalid'], []]) {
        const incoming = tunnelRequest(socketIp, ipHeaders);
        expect(applyDevelopmentClientIp(incoming)).toBe(true);
        expect(incoming.headers['cf-connecting-ip']).toBe(socketIp.replace('::ffff:', ''));
      }
    },
  );

  it.each([
    'trycloudflare.com',
    'studio-test.trycloudflare.com.attacker.test',
    'studio-test-trycloudflare.com',
    'nested.studio-test.trycloudflare.com',
    'https://studio-test.trycloudflare.com',
    'studio-test.trycloudflare.com/path',
    'user@studio-test.trycloudflare.com',
    '-studio-test.trycloudflare.com',
    `${'a'.repeat(64)}.trycloudflare.com`,
    'studio-test.trycloudflare.com:0',
    'studio-test.trycloudflare.com:65536',
    'studio-test.trycloudflare.com:invalid',
  ])('keeps socket identity for non-Quick-Tunnel Host %s', (host) => {
    const incoming = tunnelRequest('127.0.0.1', undefined, host);
    expect(applyDevelopmentClientIp(incoming)).toBe(true);
    expect(incoming.headers['cf-connecting-ip']).toBe('127.0.0.1');
  });

  it('does not trust a visitor IP with duplicate Host headers', () => {
    const incoming = tunnelRequest();
    incoming.rawHeaders.push('hOsT', quickTunnelHost);
    expect(applyDevelopmentClientIp(incoming)).toBe(true);
    expect(incoming.headers['cf-connecting-ip']).toBe('127.0.0.1');
  });

  it.each(['configureServer', 'configurePreviewServer'] as const)(
    '%s rejects unavailable socket or tunnel IPs for HTTP and upgrades',
    (hook) => {
      const use = vi.fn();
      const logger = { error: vi.fn() };
      const httpServer = new EventEmitter();
      const server = {
        middlewares: { use }, config: { logger }, httpServer,
      } as unknown as ViteDevServer & PreviewServer;
      const configure = developmentClientIp()[hook];
      if (typeof configure !== 'function') throw new Error('Missing server hook');
      configure.call({} as ThisParameterType<typeof configure>, server);
      const middleware = use.mock.calls[0][0];

      const invalidRequests = [
        ...[undefined, '', 'not-an-ip'].map((ip) => () => request(ip)),
        ...[
          [],
          ['CF-Connecting-IP', ''],
          ['CF-Connecting-IP', 'not-an-ip'],
          ['CF-Connecting-IP', '203.0.113.10:443'],
          ['CF-Connecting-IP', 'fe80::1%en0'],
          ['CF-Connecting-IP', '[2001:db8::10]'],
          ['CF-Connecting-IP', '203.0.113.10, 127.0.0.1'],
          ['CF-Connecting-IP', visitorIp, 'cf-connecting-ip', visitorIp],
          ['CF-Connecting-IP', visitorIp, 'cF-CoNnEcTiNg-Ip', '127.0.0.1'],
        ].map((headers) => () => tunnelRequest('::1', headers)),
      ];
      for (const makeRequest of invalidRequests) {
        const incoming = makeRequest();
        const response = { writeHead: vi.fn(), end: vi.fn() };
        const next = vi.fn();
        middleware(incoming, response, next);

        expect(response.writeHead).toHaveBeenCalledWith(503, expect.anything());
        expect(JSON.parse(response.end.mock.calls[0][0])).toEqual({
          success: false, error: { code: 'SYSTEM_NOT_AVAILABLE' },
        });
        expect(next).not.toHaveBeenCalled();

        const socket = { destroy: vi.fn() };
        const upgradeRequest = makeRequest();
        httpServer.emit('upgrade', upgradeRequest, socket);
        expect(socket.destroy).toHaveBeenCalledOnce();
        expect(incoming.headers['cf-connecting-ip']).toBe('unavailable');
        expect(incoming.rawHeaders.slice(-2)).toEqual(['CF-Connecting-IP', 'unavailable']);
        expect(upgradeRequest.rawHeaders.slice(-2)).toEqual(['CF-Connecting-IP', 'unavailable']);
      }

      const incoming = tunnelRequest('::1');
      const socket = { destroy: vi.fn() };
      const forwarded = vi.fn();
      httpServer.on('upgrade', forwarded);
      httpServer.emit('upgrade', incoming, socket);
      expect(forwarded).toHaveBeenCalledWith(incoming, socket);
      expect(incoming.headers['cf-connecting-ip']).toBe(visitorIp);
      expect(socket.destroy).not.toHaveBeenCalled();
    },
  );
});
