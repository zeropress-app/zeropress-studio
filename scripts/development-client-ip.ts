import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { Plugin, PreviewServer, ViteDevServer } from 'vite';

function normalizeClientIp(value: string | undefined): string | null {
  const ip = value?.trim();
  if (!ip || ip.includes('%')) return null;
  const family = isIP(ip);
  if (family === 0) return null;
  if (family === 4) return ip;

  const ipv6 = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/u.exec(ipv6);
  if (!mapped) return ipv6;
  const ipv4 = Number.parseInt(mapped[1], 16) * 65536 + Number.parseInt(mapped[2], 16);
  return [ipv4 >>> 24, (ipv4 >>> 16) & 255, (ipv4 >>> 8) & 255, ipv4 & 255].join('.');
}

function singleRawHeader(request: IncomingMessage, name: string): string | undefined {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) {
      values.push(request.rawHeaders[index + 1]);
    }
  }
  return values.length === 1 ? values[0] : undefined;
}

function isQuickTunnelHost(request: IncomingMessage): boolean {
  const host = singleRawHeader(request, 'host');
  if (!host) return false;
  const match = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com(?::([0-9]{1,5}))?$/iu.exec(host);
  return match !== null && (match[1] === undefined || (Number(match[1]) > 0 && Number(match[1]) <= 65535));
}

export function applyDevelopmentClientIp(request: IncomingMessage): boolean {
  let ip = normalizeClientIp(request.socket.remoteAddress);
  const loopback = ip === '::1' || ip?.startsWith('127.') === true;
  // Quick Tunnel is a trusted local relay; direct LAN clients still use socket IPs.
  if (loopback && isQuickTunnelHost(request)) {
    ip = normalizeClientIp(singleRawHeader(request, 'cf-connecting-ip'));
  }
  const valid = ip !== null;
  // Keep an invalid nonempty value on failure so Miniflare cannot replace it
  // with the internal proxy's loopback IP, including during HTTP upgrades.
  const value = ip ?? 'unavailable';
  request.headers['cf-connecting-ip'] = value;
  // The Cloudflare adapter reads rawHeaders rather than request.headers.
  request.rawHeaders = request.rawHeaders.flatMap((header, index, all) => (
    index % 2 === 0 && header.toLowerCase() !== 'cf-connecting-ip'
      ? [header, all[index + 1]]
      : []
  ));
  request.rawHeaders.push('CF-Connecting-IP', value);
  return valid;
}

export function developmentClientIp(): Plugin {
  function configure(server: ViteDevServer | PreviewServer) {
    const reportUnavailable = () => server.config.logger.error(
      '[CLIENT_IP_NOT_AVAILABLE] Cannot determine the client IP for this local connection.',
    );
    server.middlewares.use((request, response, next) => {
      if (applyDevelopmentClientIp(request)) return next();
      reportUnavailable();
      response.writeHead(503, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      response.end(JSON.stringify({
        success: false, error: { code: 'SYSTEM_NOT_AVAILABLE' },
      }));
    });
    // Upgrade requests bypass Connect middleware.
    server.httpServer?.prependListener('upgrade', (request, socket) => {
      if (applyDevelopmentClientIp(request)) return;
      reportUnavailable();
      socket.destroy();
    });
  }
  return {
    name: 'studio:development-client-ip',
    enforce: 'pre',
    configureServer: configure,
    configurePreviewServer: configure,
  };
}
