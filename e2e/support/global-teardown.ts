import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../..',
);

export default async function removeE2ERuntime(): Promise<void> {
  await rm(resolve(repositoryRoot, '.wrangler/e2e'), {
    force: true,
    recursive: true,
  });
}
