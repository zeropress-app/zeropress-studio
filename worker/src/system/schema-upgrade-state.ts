/**
 * Transient table used to make a schema-upgrade step fail atomically when
 * its lifecycle preconditions or post-upgrade foreign-key validation fail.
 * It is operational state, not application data, and must not be exported.
 */
export const SCHEMA_UPGRADE_GUARD_TABLE =
  'zeropress_schema_upgrade_guard';

/** Journal owned by the mutually exclusive logical-restore runner. */
export const DATABASE_RESTORE_JOURNAL_TABLE =
  'zeropress_restore_journal';
