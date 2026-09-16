import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readAccountAvatarPreviewUrl } from './account-avatar-repository';

class SqliteD1Statement {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new SqliteD1Statement(this.database, this.sql, params);
  }

  async first<T>(): Promise<T | null> {
    const row = (
      this.database.prepare(this.sql).get as (...params: unknown[]) => T | undefined
    )(...this.params);
    return row ?? null;
  }
}

function createDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(readFileSync(
    new URL('../../../database/install/001_baseline.sql', import.meta.url),
    'utf8',
  ));
  return {
    database,
    d1: {
      prepare(sql: string) {
        return new SqliteD1Statement(database, sql);
      },
    } as unknown as D1Database,
  };
}

const USER_ID = '1'.repeat(32);
const MEDIA_ID = '2'.repeat(32);
const REVISION = '3'.repeat(32);
const NOW = '2026-08-09T00:00:00.000Z';

function seedLinkedAvatar(
  database: DatabaseSync,
  location: { type: 'external'; url: string } | { type: 'r2'; key: string },
) {
  database.prepare(`
    INSERT INTO users (
      id, email, password_hash, auth_revision, name, status,
      email_verified, created_at_iso, updated_at_iso
    ) VALUES (?, 'owner@example.com', 'hash', ?, 'Studio Owner', 'active',
              1, ?, ?)
  `).run(USER_ID, '4'.repeat(32), NOW, NOW);
  database.prepare(`
    INSERT INTO media (
      id, kind, filename, mime_type, storage_type, storage_key, external_url,
      size_bytes, width, height, duration_ms, alt, revision,
      created_at_iso, updated_at_iso
    ) VALUES (?, 'image', 'avatar.png', 'image/png', ?, ?, ?,
              100, 100, 100, NULL, '', ?, ?, ?)
  `).run(
    MEDIA_ID,
    location.type,
    location.type === 'r2' ? location.key : null,
    location.type === 'external' ? location.url : null,
    REVISION,
    NOW,
    NOW,
  );
  database.prepare(`
    INSERT INTO authors (
      id, user_id, display_name, revision, created_at_iso, updated_at_iso,
      avatar_media_id
    ) VALUES ('owner', ?, 'Studio Owner', ?, ?, ?, ?)
  `).run(USER_ID, '5'.repeat(32), NOW, NOW, MEDIA_ID);
}

describe('account Author avatar projection', () => {
  it('returns an external image without exposing Media metadata', async () => {
    const { database, d1 } = createDatabase();
    seedLinkedAvatar(database, {
      type: 'external',
      url: 'https://media.example.com/authors/owner.png',
    });

    await expect(readAccountAvatarPreviewUrl({ db: d1, userId: USER_ID }))
      .resolves.toBe('https://media.example.com/authors/owner.png');
  });

  it('uses the authenticated R2 preview only while Media origin is empty', async () => {
    const { database, d1 } = createDatabase();
    seedLinkedAvatar(database, {
      type: 'r2',
      key: 'uploads/2026/08/avatar.png',
    });

    await expect(readAccountAvatarPreviewUrl({ db: d1, userId: USER_ID }))
      .resolves.toBe(`/api/media/${MEDIA_ID}/preview?revision=${REVISION}`);

    database.prepare(`
      INSERT INTO site_settings (key, value, type, updated_by, updated_at_iso)
      VALUES ('site_media_origin', 'https://media.example.com', 'string', NULL, ?)
    `).run(NOW);
    await expect(readAccountAvatarPreviewUrl({ db: d1, userId: USER_ID }))
      .resolves.toBe(
        'https://media.example.com/uploads/2026/08/avatar.png',
      );
  });
});
