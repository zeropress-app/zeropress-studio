import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { styleText } from 'node:util';
import { createBuildDeployRunner, rebuildMessage } from './build-deploy-runner.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(bin, args) {
  const result = spawnSync(process.execPath, [join(root, 'node_modules', bin), ...args], {
    cwd: root, stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${bin} ${result.signal ? `stopped by ${result.signal}` : `exited with code ${result.status}`}.`);
  }
}

try {
  const [command, ...args] = process.argv.slice(2);
  createBuildDeployRunner(root, run)(command, args);
} catch (error) {
  const needsRebuild = error.message.endsWith(rebuildMessage);
  const heading = needsRebuild ? error.message.slice(0, -rebuildMessage.length).trimEnd() : error.message;
  const guidance = needsRebuild
    ? ` ${rebuildMessage.replace('npm run build', styleText('cyan', 'npm run build', { stream: process.stderr }))}`
    : '';
  console.error(`${styleText(['bold', 'red'], heading, { stream: process.stderr })}${guidance}`);
  process.exitCode = 1;
}
