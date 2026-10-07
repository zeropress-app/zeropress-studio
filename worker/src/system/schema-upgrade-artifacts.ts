import passkeyAttestationSql from '../../../database/schema-upgrades/003_to_004_passkey_attestation.sql?raw';
import visualEditorSql from '../../../database/schema-upgrades/002_to_003_visual_editor.sql?raw';
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
}, {
  id: 'studio-002-to-003-visual-editor', fromVersion: 2, toVersion: 3,
  sql: visualEditorSql, sha256: '1c9e08cdec341d6e8fd2b56f39b4115ac3d15f205e894d1a3e3de3b1e2d42ddd',
}, {
  id: 'studio-003-to-004-passkey-attestation', fromVersion: 3, toVersion: 4,
  sql: passkeyAttestationSql, sha256: 'da020b677acd5d4702b7c21da2291847c60ea2232c4562b6beb3d28540e4bc1c',
}] as const satisfies readonly StudioSchemaUpgradeArtifact[];
