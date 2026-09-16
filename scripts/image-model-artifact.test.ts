import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { MEDIA_IMAGE_UPSCALE_MODEL } from '../client/src/lib/media-image-upscale';

const artifactRoot = fileURLToPath(new URL(
  '../client/public/image-models/realesr-general-x4v3-tile64-fp16/af572faa22679a75/',
  import.meta.url,
));

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('reviewed image model artifact', () => {
  it('keeps the manifest-addressed model and every declared byte identical', async () => {
    const manifestBytes = await readFile(`${artifactRoot}/artifact-manifest.json`);
    expect(sha256(manifestBytes).slice(0, 16))
      .toBe(MEDIA_IMAGE_UPSCALE_MODEL.revision);
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
      artifact_id: string;
      architecture: { input_shape: number[]; output_shape: number[]; scale: number };
      conversion: { recommended_tile_overlap: number; weight_quantization: string };
      files: Array<{ path: string; bytes: number; sha256: string }>;
    };
    expect(manifest.artifact_id).toBe(MEDIA_IMAGE_UPSCALE_MODEL.artifactId);
    expect(manifest.architecture).toMatchObject({
      input_shape: [1, 64, 64, 3],
      output_shape: [1, 256, 256, 3],
      scale: 4,
    });
    expect(manifest.conversion).toEqual({
      format: 'tfjs_graph_model',
      weight_quantization: 'float16',
      recommended_tile_overlap: 12,
    });

    const actualFiles = (await readdir(artifactRoot)).sort();
    expect(actualFiles).toEqual([
      'LICENSE.txt',
      'artifact-manifest.json',
      'group1-shard1of1.bin',
      'model.json',
    ]);
    for (const expected of manifest.files) {
      const path = `${artifactRoot}/${expected.path}`;
      expect((await stat(path)).size).toBe(expected.bytes);
      expect(sha256(await readFile(path))).toBe(expected.sha256);
    }

    const model = JSON.parse(await readFile(`${artifactRoot}/model.json`, 'utf8')) as {
      format: string;
      weightsManifest: Array<{ paths: string[] }>;
    };
    expect(model.format).toBe('graph-model');
    expect(model.weightsManifest.flatMap((group) => group.paths))
      .toEqual(['group1-shard1of1.bin']);
  });

  it('pins the modular runtime, lazy boundary, and immutable asset cache', async () => {
    const packageJson = JSON.parse(await readFile(
      fileURLToPath(new URL('../package.json', import.meta.url)),
      'utf8',
    )) as { dependencies: Record<string, string> };
    expect(packageJson.dependencies).toMatchObject({
      '@tensorflow/tfjs-core': '4.22.0',
      '@tensorflow/tfjs-converter': '4.22.0',
      '@tensorflow/tfjs-backend-webgl': '4.22.0',
    });
    expect(packageJson.dependencies).not.toHaveProperty('@tensorflow/tfjs');

    const dialogSource = await readFile(fileURLToPath(new URL(
      '../client/src/components/MediaImageUpscaleDialog.tsx',
      import.meta.url,
    )), 'utf8');
    expect(dialogSource).toContain("await import(\n        '../lib/media-image-upscale-runtime'");
    expect(dialogSource).not.toMatch(
      /from ['"]\.\.\/lib\/media-image-upscale-runtime['"]/u,
    );

    const headers = await readFile(fileURLToPath(new URL(
      '../client/public/_headers',
      import.meta.url,
    )), 'utf8');
    expect(headers).toContain('/image-models/*');
    expect(headers).toContain('Cache-Control: public, max-age=31536000, immutable');
  });
});
