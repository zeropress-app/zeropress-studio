import { StudioOperationalError } from '../lib/operational-error';

function readChanges(result: D1Result<unknown> | undefined): number {
  const changes = result?.meta?.changes;
  return typeof changes === 'number' && Number.isFinite(changes)
    ? Math.max(0, Math.trunc(changes))
    : 0;
}

export async function changeUserPassword(input: {
  db: D1Database;
  userId: string;
  authRevision: string;
  passwordHash: string;
  nextAuthRevision: string;
  now?: Date;
}): Promise<
  | { kind: 'completed'; revokedSessions: number }
  | { kind: 'challenge_invalid' }
> {
  const nowIso = (input.now ?? new Date()).toISOString();
  try {
    const results = await input.db.batch([
      input.db.prepare(`
        UPDATE users
        SET
          password_hash = ?,
          auth_revision = ?,
          failed_login_attempts = 0,
          locked_until = NULL,
          updated_at_iso = ?
        WHERE id = ?
          AND auth_revision = ?
          AND status = 'active'
      `).bind(
        input.passwordHash,
        input.nextAuthRevision,
        nowIso,
        input.userId,
        input.authRevision,
      ),
      input.db.prepare(`
        DELETE FROM sessions
        WHERE user_id = ?
          AND EXISTS (
            SELECT 1 FROM users
            WHERE users.id = ?
              AND users.auth_revision = ?
              AND users.status = 'active'
          )
      `).bind(
        input.userId,
        input.userId,
        input.nextAuthRevision,
      ),
    ]);
    if (readChanges(results[0]) !== 1) {
      return { kind: 'challenge_invalid' };
    }
    const revokedSessions = readChanges(results[1]);
    if (revokedSessions < 1) {
      throw new TypeError('D1 did not revoke the current password session.');
    }
    return { kind: 'completed', revokedSessions };
  } catch (error) {
    throw new StudioOperationalError(
      'AUTH_PASSWORD_DATABASE_WRITE_FAILED',
      {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'change_user_password',
        },
      },
    );
  }
}
