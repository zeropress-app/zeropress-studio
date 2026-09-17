import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('forwards direct and Quick Tunnel IPs through Cloudflare in Vite dev and preview', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('./fixtures/client-ip-server.mjs', import.meta.url)),
  ], {
    timeout: 60000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: undefined,
      CLOUDFLARE_API_KEY: undefined,
      CLOUDFLARE_EMAIL: undefined,
      WRANGLER_SEND_METRICS: 'false',
    },
  });
  const result = JSON.parse(stdout.trim().split('\n').at(-1));
  expect(result.devRequests.direct).toBeGreaterThanOrEqual(5);
  expect(result.devRequests.tunnel).toBeGreaterThanOrEqual(2);
  expect(result.devRequests.rejected).toBeGreaterThanOrEqual(6);
  expect(result.devRequests.upgrade).toBeGreaterThanOrEqual(2);
  expect(result.previewRequests).toEqual(result.devRequests);
}, 65000);
