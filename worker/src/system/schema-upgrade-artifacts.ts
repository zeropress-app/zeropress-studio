/**
 * One immutable transition between two consecutive released Studio schemas.
 *
 * Fresh installations never execute this registry. They use the consolidated
 * database/install baseline. Existing installations use only the exact path
 * from their stored schema version to STUDIO_SCHEMA_VERSION.
 */
export type StudioSchemaUpgradeArtifact = {
  id: string;
  fromVersion: number;
  toVersion: number;
  sql: string;
  sha256: string;
};

export const STUDIO_SCHEMA_UPGRADE_ARTIFACTS = [] as const satisfies readonly StudioSchemaUpgradeArtifact[];
