import { describe, expect, it, vi } from 'vitest';
import { DUMMY_PASSWORD_HASH } from '../auth/authenticate';
import { StudioOperationalError } from '../lib/operational-error';
import { authorizeOperationsAdministrator } from './authorize-administrator';

type Row = {
  id: string;
  email: string;
  password_hash: string;
  status: string;
  locked_until: string | null;
  is_administrator: number;
};

function database(row: Row | null, error?: unknown): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              if (error !== undefined) throw error;
              return row;
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

const administrator: Row = {
  id: '0123456789abcdef0123456789abcdef',
  email: 'canonical-owner@example.com',
  password_hash: '$argon2id$test',
  status: 'active',
  locked_until: null,
  is_administrator: 1,
};

describe('Maintenance administrator authorization', () => {
  it('returns the active administrator ID after password verification', async () => {
    const verifyPassword = vi.fn().mockResolvedValue(true);
    await expect(authorizeOperationsAdministrator({
      db: database(administrator),
      email: 'owner@example.com',
      password: 'secret',
      verifyPassword,
    })).resolves.toEqual({
      authorized: true,
      administratorId: administrator.id,
      administratorEmail: administrator.email,
    });
    expect(verifyPassword).toHaveBeenCalledWith(
      'secret',
      administrator.password_hash,
    );
  });

  it('uses the timing hash for an unknown account and returns one rejection', async () => {
    const verifyPassword = vi.fn().mockResolvedValue(false);
    await expect(authorizeOperationsAdministrator({
      db: database(null),
      email: 'unknown@example.com',
      password: 'secret',
      verifyPassword,
    })).resolves.toEqual({ authorized: false });
    expect(verifyPassword).toHaveBeenCalledWith(
      'secret',
      DUMMY_PASSWORD_HASH,
    );
  });

  it.each([
    { status: 'inactive' },
    { is_administrator: 0 },
    { locked_until: '2026-08-01T00:00:00.000Z' },
  ])('rejects an ineligible account without exposing the reason', async (change) => {
    await expect(authorizeOperationsAdministrator({
      db: database({ ...administrator, ...change }),
      email: 'owner@example.com',
      password: 'secret',
      verifyPassword: vi.fn().mockResolvedValue(true),
      now: new Date('2026-07-30T00:00:00.000Z'),
    })).resolves.toEqual({ authorized: false });
  });

  it('classifies D1 authorization failures', async () => {
    await expect(authorizeOperationsAdministrator({
      db: database(null, new Error('D1 unavailable')),
      email: 'owner@example.com',
      password: 'secret',
      verifyPassword: vi.fn(),
    })).rejects.toEqual(expect.objectContaining<Partial<StudioOperationalError>>({
      code: 'OPERATIONS_ADMIN_DATABASE_QUERY_FAILED',
    }));
  });
});
