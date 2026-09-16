import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { config as readZodConfig } from 'zod';
import './zod-runtime';

describe('strict-CSP Zod runtime', () => {
  it('disables schema JIT', () => {
    expect(readZodConfig().jitless).toBe(true);
  });

  it('loads the policy before schema-bearing app and Worker imports', () => {
    const html = readFileSync(
      resolve(process.cwd(), 'client/index.html'),
      'utf8',
    );
    const main = readFileSync(
      resolve(process.cwd(), 'client/src/main.tsx'),
      'utf8',
    );
    const imageWorker = readFileSync(
      resolve(
        process.cwd(),
        'client/src/workers/media-image-render.worker.ts',
      ),
      'utf8',
    );

    const mainPolicyImport = main.indexOf("import './lib/zod-runtime';");
    const mainApplicationImport = main.indexOf("import App from './App';");
    const workerPolicyImport = imageWorker.indexOf(
      "import '../lib/zod-runtime';",
    );
    const workerSchemaImport = imageWorker.indexOf(
      'validateMediaImageTransformRecipe',
    );
    const documentPolicy = html.indexOf('__zod_globalConfig');
    const documentModuleEntry = html.indexOf(
      '<script type="module" src="/src/main.tsx"></script>',
    );
    expect(documentPolicy).toBeGreaterThanOrEqual(0);
    expect(documentModuleEntry).toBeGreaterThanOrEqual(0);
    expect(mainPolicyImport).toBeGreaterThanOrEqual(0);
    expect(mainApplicationImport).toBeGreaterThanOrEqual(0);
    expect(workerPolicyImport).toBeGreaterThanOrEqual(0);
    expect(workerSchemaImport).toBeGreaterThanOrEqual(0);
    expect(documentPolicy).toBeLessThan(documentModuleEntry);
    expect(mainPolicyImport).toBeLessThan(mainApplicationImport);
    expect(workerPolicyImport).toBeLessThan(workerSchemaImport);
  });
});
