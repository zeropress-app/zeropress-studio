import { StudioOperationalError } from '../lib/operational-error';

export type SessionGarbageCollectionResult = {
  cutoff_at_iso: string;
  deleted_rows: number;
};

function readChanges(result: D1Result<unknown> | undefined): number {
  const changes = result?.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes)
    ? Math.max(0, Math.trunc(changes))
    : 0;
}

export function prepareExpiredSessionDeletes(
  db: D1Database,
  cutoffAtIso: string,
) {
  return [
    db.prepare(`
      DELETE FROM sessions
      WHERE idle_expires_at_iso <= ?
    `).bind(cutoffAtIso),
    db.prepare(`
      DELETE FROM sessions
      WHERE absolute_expires_at_iso <= ?
    `).bind(cutoffAtIso),
  ] as const;
}

export async function garbageCollectExpiredSessions(input: {
  db: D1Database;
  now?: Date;
}): Promise<SessionGarbageCollectionResult> {
  const cutoffAtIso = (input.now ?? new Date()).toISOString();
  try {
    const results = await input.db.batch([
      ...prepareExpiredSessionDeletes(input.db, cutoffAtIso),
    ]);
    return {
      cutoff_at_iso: cutoffAtIso,
      deleted_rows: readChanges(results[0]) + readChanges(results[1]),
    };
  } catch (error) {
    throw new StudioOperationalError(
      'AUTH_SESSION_GARBAGE_COLLECTION_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'garbage_collect_sessions',
        },
      },
    );
  }
}
