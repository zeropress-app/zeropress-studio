import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EDGE_DATABASE_SCHEMA_VERSION } from '../../../contracts/edge-database-lifecycle';
import {
  EDGE_DATABASE_INSTALL_ARTIFACTS,
  EDGE_DATABASE_SUPPORTED_SCHEMA_CATALOGS,
  EDGE_DATABASE_TARGET_SCHEMA_VERSION,
  EDGE_DATABASE_UNINSTALL_ARTIFACT,
  EDGE_DATABASE_UPGRADE_ARTIFACTS,
} from './schema-artifacts';
import {
  validateEdgeInstallArtifacts,
  validateEdgeUninstallArtifact,
} from './lifecycle';

function bytes(relativeUrl: string): Buffer {
  return readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)));
}

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('vendored Edge database schema artifacts', () => {
  it('matches every reviewed checksum and runtime contract', async () => {
    expect(EDGE_DATABASE_TARGET_SCHEMA_VERSION).toBe(1);
    expect(EDGE_DATABASE_TARGET_SCHEMA_VERSION)
      .toBe(EDGE_DATABASE_SCHEMA_VERSION);
    expect(EDGE_DATABASE_SUPPORTED_SCHEMA_CATALOGS).toEqual([
      {
        schemaVersion: 1,
        sha256: 'd8068600f666766195aff82abaeae01413e6ed44a800a03444699cbcbed964f6',
      },
    ]);
    expect(EDGE_DATABASE_INSTALL_ARTIFACTS.map(({ id }) => id)).toEqual([
      'edge_install_baseline_v1',
      'edge_install_seed_v1',
    ]);
    expect(EDGE_DATABASE_UNINSTALL_ARTIFACT.id).toBe('edge_uninstall_v1');
    await expect(validateEdgeInstallArtifacts()).resolves.not.toHaveLength(0);
    for (const artifact of EDGE_DATABASE_INSTALL_ARTIFACTS) {
      expect(sha256(artifact.sql)).toBe(artifact.sha256);
    }
    expect(sha256(EDGE_DATABASE_UNINSTALL_ARTIFACT.sql)).toBe(
      EDGE_DATABASE_UNINSTALL_ARTIFACT.sha256,
    );
    for (const artifact of EDGE_DATABASE_UPGRADE_ARTIFACTS) {
      expect(sha256(artifact.sql)).toBe(artifact.sha256);
    }
    await expect(validateEdgeUninstallArtifact())
      .resolves.not.toHaveLength(0);
  });

  it('is byte-identical to the Edge-owned source in this workspace', () => {
    const pairs = [
      [
        '../../../database/edge/schema-contract.json',
        '../../../../zeropress-edge/database/schema-contract.json',
      ],
      [
        '../../../database/edge/install/001_edge_baseline.sql',
        '../../../../zeropress-edge/database/install/001_edge_baseline.sql',
      ],
      [
        '../../../database/edge/install/002_edge_seed.sql',
        '../../../../zeropress-edge/database/install/002_edge_seed.sql',
      ],
      [
        '../../../database/edge/operations/001_uninstall.sql',
        '../../../../zeropress-edge/database/operations/001_uninstall.sql',
      ],
    ] as const;
    const authoritativeContract = fileURLToPath(new URL(
      pairs[0][1],
      import.meta.url,
    ));
    // Studio remains independently testable after distribution. In the
    // development workspace, where the Edge authority is present as a sibling
    // repository, every reviewed vendored artifact must match byte-for-byte.
    if (!existsSync(authoritativeContract)) return;
    for (const [vendored, authoritative] of pairs) {
      expect(bytes(vendored)).toEqual(bytes(authoritative));
    }
  });
});
