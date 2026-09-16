import { z } from 'zod';

/**
 * Ordinary Studio requests only need to know whether the bound Edge database
 * can safely serve the schema contract compiled into this Worker. Detailed
 * install/adoption/catalog diagnostics remain owned by Maintenance & Recovery.
 */
export const edgeDatabaseRuntimeStateSchema = z.enum([
  'ready',
  'upgrade_required',
  'recovery_required',
  'unavailable',
]);

export type EdgeDatabaseRuntimeState = z.infer<
  typeof edgeDatabaseRuntimeStateSchema
>;
