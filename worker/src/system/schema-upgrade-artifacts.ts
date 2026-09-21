import auditLogsSql from '../../../database/schema-upgrades/001_to_002_audit_logs.sql?raw';

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

export const STUDIO_SCHEMA_UPGRADE_ARTIFACTS = [{
  id: 'studio-001-to-002-audit-logs', fromVersion: 1, toVersion: 2,
  sql: auditLogsSql, sha256: '4580c5429aa244e90c8700a68571dd9e277c76ec841c6314fc97f8d3e44cd8a4',
}] as const satisfies readonly StudioSchemaUpgradeArtifact[];
