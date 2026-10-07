import legacyBaselineSql from '../../../database/edge/install/001_edge_baseline.sql?raw';
import upgradeOneToTwoSql from '../../../database/edge/schema-upgrades/schema_1_to_2.sql?raw';
import baselineSql from '../../../database/edge/install/003_edge_baseline_v2.sql?raw';
import seedSql from '../../../database/edge/install/004_edge_seed_v2.sql?raw';
import uninstallSql from '../../../database/edge/operations/001_uninstall.sql?raw';
import schemaContract from '../../../database/edge/schema-contract.json';

export const EDGE_DATABASE_SCHEMA_STATE_TABLE =
  'zeropress_edge_schema_state';
export const EDGE_DATABASE_UPGRADE_GUARD_TABLE =
  'zeropress_edge_schema_upgrade_guard';
export const EDGE_DATABASE_RESTORE_JOURNAL_TABLE =
  'zeropress_restore_journal';

export const EDGE_DATABASE_TARGET_SCHEMA_VERSION =
  schemaContract.schema_version as 2;
export const EDGE_DATABASE_MINIMUM_SCHEMA_VERSION =
  schemaContract.minimum_supported_schema_version;
export const EDGE_DATABASE_SUPPORTED_SCHEMA_CATALOGS =
  schemaContract.supported_schema_catalogs.map((catalog) => ({
    schemaVersion: catalog.schema_version,
    sha256: catalog.sha256,
  }));

export const EDGE_DATABASE_INSTALL_ARTIFACTS = [
  {
    id: schemaContract.install_artifacts[0]!.id,
    sha256: schemaContract.install_artifacts[0]!.sha256,
    sql: baselineSql,
  },
  {
    id: schemaContract.install_artifacts[1]!.id,
    sha256: schemaContract.install_artifacts[1]!.sha256,
    sql: seedSql,
  },
] as const;

export const EDGE_DATABASE_UNINSTALL_ARTIFACT = {
  id: schemaContract.uninstall_artifact.id,
  sha256: schemaContract.uninstall_artifact.sha256,
  sql: uninstallSql,
} as const;

export type EdgeDatabaseUpgradeArtifact = {
  id: string;
  fromVersion: number;
  toVersion: number;
  sha256: string;
  sql: string;
};

export const EDGE_DATABASE_UPGRADE_ARTIFACTS:
readonly EdgeDatabaseUpgradeArtifact[] = [{
  id: schemaContract.upgrade_artifacts[0]!.id,
  fromVersion: schemaContract.upgrade_artifacts[0]!.from_version,
  toVersion: schemaContract.upgrade_artifacts[0]!.to_version,
  sha256: schemaContract.upgrade_artifacts[0]!.sha256,
  sql: upgradeOneToTwoSql,
}];

export { baselineSql as EDGE_DATABASE_BASELINE_SQL };
export { seedSql as EDGE_DATABASE_SEED_SQL };
export { uninstallSql as EDGE_DATABASE_UNINSTALL_SQL };

export { legacyBaselineSql as EDGE_DATABASE_LEGACY_BASELINE_SQL };
