import assert from 'node:assert/strict';
import { request } from 'node:http';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBuilder, createServer, preview } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { developmentClientIp } from '../development-client-ip.ts';

const root = await mkdtemp(join(tmpdir(), 'studio-client-ip-server-'));
process.env.WRANGLER_LOG_PATH = join(root, 'wrangler-logs');
const cases = [
  { Host: 'localhost' },
  { Host: '127.0.0.1', 'X-Forwarded-For': '203.0.113.99' },
  { Host: 'localhost', 'CF-Connecting-IP': '203.0.113.99' },
  { Host: 'localhost', 'CF-Connecting-IP': ['203.0.113.99', '127.0.0.1'] },
  { Host: '[::1]', 'CF-Connecting-IP': '' },
];
const tunnelHost = 'studio-test.trycloudflare.com';
const tunnelCases = [
  { host: tunnelHost, ip: '203.0.113.10', expected: '203.0.113.10' },
  { host: `${tunnelHost}:443`, ip: '2001:0DB8::10', expected: '2001:db8::10' },
];
const invalidTunnelHeaders = [
  {},
  { 'CF-Connecting-IP': '' },
  { 'CF-Connecting-IP': 'not-an-ip' },
  { 'CF-Connecting-IP': '203.0.113.10, 127.0.0.1' },
  { 'CF-Connecting-IP': ['203.0.113.10', '203.0.113.10'] },
];

function probe(hostname, port, headers) {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname, localAddress: hostname, port, path: '/api/ip', headers,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          resolve({
            status: response.statusCode,
            body: response.headers['content-type']?.includes('application/json') ? JSON.parse(body) : body,
          });
        } catch (error) { reject(error); }
      });
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(10000, () => outgoing.destroy(new Error('IP probe timed out')));
    outgoing.end();
  });
}

function probeUpgrade(hostname, port, headers) {
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname, localAddress: hostname, port, path: '/api/ip',
      headers: {
        ...headers, Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.alloc(16, 1).toString('base64'),
      },
    });
    outgoing.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode, ip: response.headers['x-test-client-ip'] });
    });
    outgoing.on('response', (response) => {
      response.resume();
      reject(new Error(`Expected an upgrade, received ${response.statusCode}`));
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(10000, () => outgoing.destroy(new Error('Upgrade probe timed out')));
    outgoing.end();
  });
}

function config() {
  return {
    configFile: false,
    root: join(root, 'client'),
    cacheDir: join(root, 'cache'),
    logLevel: 'silent',
    build: { outDir: join(root, 'dist') },
    // Emulate the Host allowance added when the plugin starts a dev tunnel.
    server: { host: '0.0.0.0', port: 0, allowedHosts: ['.trycloudflare.com'] },
    preview: { host: '0.0.0.0', port: 0, allowedHosts: ['.trycloudflare.com'] },
    plugins: [
      developmentClientIp(),
      cloudflare({
        configPath: join(root, 'wrangler.json'), remoteBindings: false,
        persistState: false,
      }),
    ],
  };
}

async function verify(server) {
  const addresses = ['127.0.0.1'];
  const lan = Object.values(networkInterfaces()).flat().find(
    (address) => address?.family === 'IPv4' && !address.internal,
  );
  if (lan) addresses.push(lan.address);
  const port = server.httpServer.address().port;
  const counts = { direct: 0, tunnel: 0, rejected: 0, upgrade: 0 };
  for (const address of addresses) {
    for (const headers of cases) {
      const result = await probe(address, port, headers);
      assert.deepEqual(result, { status: 200, body: { ip: address, header: address } });
      counts.direct++;
    }
    for (const { host, ip, expected } of tunnelCases) {
      const headers = { Host: host, 'CF-Connecting-IP': ip, 'X-Forwarded-For': '127.0.0.1' };
      const selectedIp = address === '127.0.0.1' ? expected : address;
      assert.deepEqual(await probe(address, port, headers), {
        status: 200, body: { ip: selectedIp, header: selectedIp },
      });
      assert.deepEqual(await probeUpgrade(address, port, headers), { status: 101, ip: selectedIp });
      counts.tunnel++;
      counts.upgrade++;
    }
    for (const headers of invalidTunnelHeaders) {
      const result = await probe(address, port, { Host: tunnelHost, ...headers });
      if (address === '127.0.0.1') {
        assert.deepEqual(result, {
          status: 503, body: { success: false, error: { code: 'SYSTEM_NOT_AVAILABLE' } },
        });
        counts.rejected++;
      } else {
        assert.deepEqual(result, { status: 200, body: { ip: address, header: address } });
        counts.direct++;
      }
    }
  }
  await assert.rejects(probeUpgrade('127.0.0.1', port, { Host: tunnelHost }), { code: 'ECONNRESET' });
  counts.rejected++;
  return counts;
}

let dev;
let built;
try {
  await mkdir(join(root, 'client'));
  await writeFile(join(root, 'client/index.html'), '<!doctype html><title>IP test</title>');
  await writeFile(join(root, 'package.json'), '{"type":"module","private":true}');
  await copyFile(new URL('../../worker/src/lib/client-ip.ts', import.meta.url), join(root, 'client-ip.ts'));
  await writeFile(join(root, 'worker.ts'), `
    import { resolveTrustedClientIp } from './client-ip';
    export default { fetch(request: Request) {
      const result = {
        ip: resolveTrustedClientIp(request),
        header: request.headers.get('CF-Connecting-IP'),
      };
      if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        const [client, server] = Object.values(new WebSocketPair());
        server.accept();
        return new Response(null, {
          status: 101, webSocket: client, headers: { 'X-Test-Client-IP': result.ip ?? 'unavailable' },
        });
      }
      return Response.json(result);
    }};
  `);
  await writeFile(join(root, 'wrangler.json'), JSON.stringify({
    name: 'studio-client-ip-test', main: './worker.ts',
    compatibility_date: '2026-09-07',
    assets: { run_worker_first: ['/api/*'] },
  }));

  dev = await createServer(config());
  await dev.listen();
  const devRequests = await verify(dev);
  await dev.close();
  dev = undefined;

  const builder = await createBuilder(config());
  await builder.buildApp();
  built = await preview(config());
  const previewRequests = await verify(built);
  console.log(JSON.stringify({ devRequests, previewRequests }));
} finally {
  await dev?.close();
  await built?.close();
  await rm(root, { recursive: true, force: true });
}
