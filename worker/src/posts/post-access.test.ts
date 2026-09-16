import { describe, expect, it, vi } from 'vitest';
import { StudioOperationalError } from '../lib/operational-error';
import { postAccessAuthorId, resolvePostAccess } from './post-access';

function dbWithAuthor(row: Record<string, unknown> | null): D1Database {
  const first = vi.fn().mockResolvedValue(row);
  const bind = vi.fn().mockReturnValue({ first });
  return {
    prepare: vi.fn().mockReturnValue({ bind }),
  } as unknown as D1Database;
}

describe('Post contributor access', () => {
  it('does not query the Author link for full Post managers', async () => {
    const db = dbWithAuthor(null);
    await expect(resolvePostAccess({
      db,
      userId: '1'.repeat(32),
      roles: ['editor'],
    })).resolves.toEqual({ scope: 'all' });
    expect(db.prepare).not.toHaveBeenCalled();
  });

  it('resolves one linked public Author as the ownership boundary', async () => {
    const db = dbWithAuthor({
      id: 'site-author',
      display_name: 'Site Author',
    });
    const access = await resolvePostAccess({
      db,
      userId: '1'.repeat(32),
      roles: ['author'],
    });
    expect(access).toEqual({
      scope: 'own',
      author: { id: 'site-author', display_name: 'Site Author' },
    });
    expect(postAccessAuthorId(access)).toBe('site-author');
  });

  it('returns a safe unavailable scope when no Author is linked', async () => {
    const access = await resolvePostAccess({
      db: dbWithAuthor(null),
      userId: '1'.repeat(32),
      roles: ['author'],
    });
    expect(access).toEqual({
      scope: 'unavailable',
      reason: 'author_not_linked',
    });
    expect(postAccessAuthorId(access)).toBeNull();
  });

  it('classifies malformed linked Author data as an operational failure', async () => {
    await expect(resolvePostAccess({
      db: dbWithAuthor({ id: '', display_name: '' }),
      userId: '1'.repeat(32),
      roles: ['author'],
    })).rejects.toMatchObject({
      code: 'POST_MANAGEMENT_DATA_INVALID',
    } satisfies Partial<StudioOperationalError>);
  });
});
