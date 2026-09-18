import { readFileSync, writeFileSync } from 'node:fs';
import { styleText } from 'node:util';
import { formatWranglerConfig } from './wrangler-config.mjs';

const configPath = new URL('../wrangler.jsonc', import.meta.url);

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
    throw new Error('Usage: node scripts/format-wrangler.mjs [--check]');
  }
  const contents = readFileSync(configPath, 'utf8');
  const formatted = formatWranglerConfig(contents);
  if (args.includes('--check') && contents !== formatted) {
    throw new Error('wrangler.jsonc is not formatted. Run npm run format:wrangler.');
  }
  if (!args.includes('--check') && contents !== formatted) {
    writeFileSync(configPath, formatted);
  }
  console.log('wrangler.jsonc is formatted.');
} catch (error) {
  const style = { stream: process.stderr };
  console.error(styleText(['bold', 'red'], error.message, style)
    .replace('npm run format:wrangler', styleText('cyan', 'npm run format:wrangler', style)));
  process.exitCode = 1;
}
