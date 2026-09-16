import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { styleText } from 'node:util';

const root = new URL('../', import.meta.url);
const environment = process.env.CLOUDFLARE_ENV;
const existingFiles = [
  '.dev.vars',
  '.env',
  '.env.local',
  ...(environment ? [
    `.dev.vars.${environment}`,
    `.env.${environment}`,
    `.env.${environment}.local`,
  ] : []),
];

if (!existingFiles.some((name) => existsSync(new URL(name, root)))) {
  const contents = [
    '# Local development values only.',
    'STUDIO_SITE_MODE=initial',
    `STUDIO_AUTH_SECRET=${randomBytes(32).toString('hex')}`,
    `STUDIO_INSTALL_TOKEN=${randomBytes(32).toString('hex')}`,
    '',
  ].join('\n');

  try {
    writeFileSync(new URL('.dev.vars', root), contents, { flag: 'wx', mode: 0o600 });
    console.log(styleText('green', `Created ${styleText('bold', '.dev.vars')} for local development.`));
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
}
