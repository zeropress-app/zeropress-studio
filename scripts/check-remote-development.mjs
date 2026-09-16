import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';
import { unstable_readConfig } from 'wrangler';
import {
  validateMailQueueConfig,
  validateRemoteDevelopmentConfig,
} from './development-binding-policy.ts';

const config = unstable_readConfig(
  { config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url)) },
  { hideWarnings: true },
);

try {
  validateMailQueueConfig(config);
  validateRemoteDevelopmentConfig(config);
} catch (error) {
  const heading = styleText(['bold', 'red'], 'Cannot start remote development.', { stream: process.stderr });
  const guidance = error.message
    .replace(/\b(?:wrangler\.jsonc|EDGE_DB|EDGE_KV|DB|MEDIA_BUCKET|MAIL_QUEUE)\b/gu,
      (text) => styleText('bold', text, { stream: process.stderr }))
    .replace(/"remote": true|\bnpm run dev\b/gu,
      (text) => styleText('cyan', text, { stream: process.stderr }));
  console.error(`${heading}\n\n${guidance}`);
  process.exitCode = 1;
}
