import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioOperationalError } from '../lib/operational-error';
import { authenticateCredentials, DUMMY_PASSWORD_HASH } from './authenticate';

afterEach(() => {
  vi.restoreAllMocks();
});

function createDb(row: unknown) {
  const first = vi.fn().mockResolvedValue(row);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));
  return {
    db: { prepare } as unknown as D1Database,
    first,
    bind,
    prepare,
  };
}

const activeUser = {
  id: '0123456789abcdef0123456789abcdef',
  password_hash: 'stored-hash',
  auth_revision: 'fedcba9876543210fedcba9876543210',
  status: 'active',
  locked_until: null,
  factor_count: 1,
};

describe('authenticateCredentials', () => {
  it('always requires MFA after matching an active account with a factor', async () => {
    const { db } = createDb(activeUser);
    await expect(authenticateCredentials({
      db,
      email: 'admin@example.com',
      password: 'password',
      verifyPassword: vi.fn().mockResolvedValue(true),
    })).resolves.toEqual({
      kind: 'success',
      status: 'mfa_required',
      userId: activeUser.id,
      authRevision: activeUser.auth_revision,
    });
  });

  it('requires enrollment instead of bypassing MFA when a factor is missing', async () => {
    const { db } = createDb({ ...activeUser, factor_count: 0 });
    await expect(authenticateCredentials({
      db,
      email: 'admin@example.com',
      password: 'password',
      verifyPassword: vi.fn().mockResolvedValue(true),
    })).resolves.toEqual({
      kind: 'success',
      status: 'mfa_enrollment_required',
      userId: activeUser.id,
      authRevision: activeUser.auth_revision,
    });
  });

  it('does not distinguish an unknown account from a wrong password', async () => {
    const unknownDb = createDb(null);
    const unknownVerifier = vi.fn().mockResolvedValue(false);
    const wrongPasswordDb = createDb(activeUser);

    const [unknown, wrongPassword] = await Promise.all([
      authenticateCredentials({
        db: unknownDb.db,
        email: 'missing@example.com',
        password: 'password',
        verifyPassword: unknownVerifier,
      }),
      authenticateCredentials({
        db: wrongPasswordDb.db,
        email: 'admin@example.com',
        password: 'wrong',
        verifyPassword: vi.fn().mockResolvedValue(false),
      }),
    ]);

    expect(unknown).toEqual({ kind: 'invalid_credentials' });
    expect(wrongPassword).toEqual({ kind: 'invalid_credentials' });
    expect(unknownVerifier).toHaveBeenCalledWith('password', DUMMY_PASSWORD_HASH);
  });

  it('reports non-active and currently locked accounts only after password verification', async () => {
    const inactiveDb = createDb({ ...activeUser, status: 'inactive' });
    const lockedDb = createDb({ ...activeUser, locked_until: '2026-07-24T00:00:00.000Z' });

    await expect(authenticateCredentials({
      db: inactiveDb.db,
      email: 'admin@example.com',
      password: 'password',
      verifyPassword: vi.fn().mockResolvedValue(true),
    })).resolves.toEqual({ kind: 'account_not_active' });

    await expect(authenticateCredentials({
      db: lockedDb.db,
      email: 'admin@example.com',
      password: 'password',
      verifyPassword: vi.fn().mockResolvedValue(true),
      now: new Date('2026-07-23T00:00:00.000Z'),
    })).resolves.toEqual({ kind: 'account_locked' });
  });

  it('classifies D1 query failures without logging at the repository boundary', async () => {
    const queryError = new Error('D1_ERROR: no such table: users');
    const first = vi.fn().mockRejectedValue(queryError);
    const db = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({ first })),
      })),
    } as unknown as D1Database;
    const consoleSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    const result = authenticateCredentials({
      db,
      email: 'admin@example.com',
      password: 'password',
      verifyPassword: vi.fn().mockResolvedValue(true),
    });

    await expect(result).rejects.toMatchObject({
      name: 'StudioOperationalError',
      code: 'AUTH_DATABASE_QUERY_FAILED',
      originalCause: queryError,
      operationalMetadata: {
        resource: 'DB',
        action: 'authenticate_credentials',
      },
    } satisfies Partial<StudioOperationalError>);
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});
