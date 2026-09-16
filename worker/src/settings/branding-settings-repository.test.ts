import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BRANDING_SETTINGS_INITIAL_REVISION,
  materializeSiteBrandingSettingsDefaults,
} from '../../../contracts/branding-settings';
import {
  projectSiteBranding,
  readSiteBranding,
  updateSiteBranding,
} from './branding-settings-repository';
import { deleteMedia, updateMedia } from '../media/media-repository';
import { clearSiteContent } from '../operations/database-operations';
import { updateMediaSettings } from './media-settings-repository';

type SqliteRunResult = { changes: number | bigint };

class SqliteD1Statement {
  constructor(
    readonly database: DatabaseSync,
    readonly sql: string,
    readonly params: unknown[] = [],
  ) {}

  bind(...params: unknown[]) {
    return new SqliteD1Statement(this.database, this.sql, params);
  }

  async run(): Promise<D1Result<unknown>> {
    const result = (
      this.database.prepare(this.sql).run as (...params: unknown[]) => SqliteRunResult
    )(...this.params);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    } as unknown as D1Result<unknown>;
  }

  async all<T>(): Promise<D1Result<T>> {
    const results = (
      this.database.prepare(this.sql).all as (...params: unknown[]) => T[]
    )(...this.params);
    return { success: true, results, meta: {} } as unknown as D1Result<T>;
  }

  async first<T>(): Promise<T | null> {
    const row = (
      this.database.prepare(this.sql).get as (...params: unknown[]) => T | undefined
    )(...this.params);
    return row ?? null;
  }

  async execute(): Promise<D1Result<unknown>> {
    return /^\s*(?:SELECT|WITH)\b/iu.test(this.sql) ? this.all() : this.run();
  }
}

function createTestDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec(readFileSync(
    new URL('../../../database/install/001_baseline.sql', import.meta.url),
    'utf8',
  ));
  const d1 = {
    prepare(sql: string) {
      return new SqliteD1Statement(database, sql);
    },
    async batch(statements: SqliteD1Statement[]) {
      database.exec('BEGIN IMMEDIATE');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.execute());
        database.exec('COMMIT');
        return results;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
  } as unknown as D1Database;
  return { database, d1 };
}

const USER_ID = '1'.repeat(32);
const PNG_ID = '2'.repeat(32);
const WEBP_ID = '3'.repeat(32);
const R2_ID = '4'.repeat(32);
const NOW = new Date('2026-08-03T12:00:00.000Z');
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function seed(database: DatabaseSync) {
  database.prepare(`
    INSERT INTO users (
      id, email, password_hash, auth_revision, name, status,
      email_verified, created_at_iso, updated_at_iso
    ) VALUES (?, 'owner@example.com', 'hash', ?, 'Owner', 'active', 1, ?, ?)
  `).run(USER_ID, 'a'.repeat(32), NOW.toISOString(), NOW.toISOString());
  const insert = database.prepare(`
    INSERT INTO media (
      id, kind, filename, mime_type, storage_type, storage_key, external_url,
      size_bytes, width, height, duration_ms, alt, revision,
      created_at_iso, updated_at_iso
    ) VALUES (?, 'image', ?, ?, ?, ?, ?, NULL, ?, ?, NULL, '', ?, ?, ?)
  `);
  insert.run(
    PNG_ID,
    'favicon.png',
    'image/png',
    'external',
    null,
    'https://assets.example/favicon.png',
    180,
    180,
    'b'.repeat(32),
    NOW.toISOString(),
    NOW.toISOString(),
  );
  insert.run(
    WEBP_ID,
    'brand.webp',
    'image/webp',
    'external',
    null,
    'https://assets.example/brand.webp',
    null,
    null,
    'c'.repeat(32),
    NOW.toISOString(),
    NOW.toISOString(),
  );
  insert.run(
    R2_ID,
    'mark.svg',
    'image/svg+xml',
    'r2',
    'uploads/2026/08/mark.svg',
    null,
    null,
    null,
    'd'.repeat(32),
    NOW.toISOString(),
    NOW.toISOString(),
  );
}

describe('Site Branding D1 repository', () => {
  it('materializes defaults without authored rows', async () => {
    const { database, d1 } = createTestDatabase();
    databases.push(database);
    await expect(readSiteBranding({ db: d1 })).resolves.toEqual({
      settings: materializeSiteBrandingSettingsDefaults(),
      selected_assets: {
        icon: null,
        icon_dark: null,
        apple_touch_icon: null,
        logo: null,
      },
      revision: BRANDING_SETTINGS_INITIAL_REVISION,
      updated_at_iso: null,
    });
  });

  it('atomically stores favicon and logo selections and projects Preview Data', async () => {
    const { database, d1 } = createTestDatabase();
    databases.push(database);
    seed(database);
    const settings = {
      favicon: {
        icon_media_id: PNG_ID,
        icon_dark_media_id: null,
        apple_touch_icon_media_id: null,
      },
      logo: { media_id: WEBP_ID, alt: 'Example Site' },
    };
    const result = await updateSiteBranding({
      db: d1,
      settings,
      expectedRevision: BRANDING_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => 'e'.repeat(32),
    });
    expect(result.kind).toBe('completed');
    if (result.kind !== 'completed') return;
    expect(result.document.settings).toEqual(settings);
    expect(projectSiteBranding(result.document)).toEqual({
      favicon: { png: 'https://assets.example/favicon.png' },
      logo: {
        src: 'https://assets.example/brand.webp',
        alt: 'Example Site',
      },
    });
    expect(database.prepare(`
      SELECT slot, media_id, alt_text FROM site_assets ORDER BY slot
    `).all()).toEqual([
      { slot: 'favicon', media_id: PNG_ID, alt_text: null },
      { slot: 'logo', media_id: WEBP_ID, alt_text: 'Example Site' },
    ]);
    await expect(deleteMedia({
      db: d1,
      id: WEBP_ID,
      expectedRevision: 'c'.repeat(32),
    })).resolves.toEqual({ kind: 'in_use' });
    await expect(updateMedia({
      db: d1,
      id: WEBP_ID,
      authored: {
        kind: 'document',
        filename: 'brand.pdf',
        mime_type: 'application/pdf',
        location: {
          type: 'external',
          url: 'https://assets.example/brand.pdf',
        },
        size_bytes: null,
        width: null,
        height: null,
        duration_ms: null,
        alt: '',
        expected_revision: 'c'.repeat(32),
      },
      createRevision: () => '8'.repeat(32),
    })).resolves.toEqual({ kind: 'in_use' });
    await expect(updateMedia({
      db: d1,
      id: WEBP_ID,
      authored: {
        kind: 'image',
        filename: 'brand.webp',
        mime_type: 'image/webp',
        location: { type: 'r2', key: 'imported/brand.webp' },
        size_bytes: null,
        width: null,
        height: null,
        duration_ms: null,
        alt: '',
        expected_revision: 'c'.repeat(32),
      },
      createRevision: () => '7'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      media: {
        location: { type: 'r2', key: 'imported/brand.webp' },
        revision: '7'.repeat(32),
      },
    });
    await expect(readSiteBranding({ db: d1 })).resolves.toMatchObject({
      selected_assets: {
        logo: {
          preview_url: `/api/media/${WEBP_ID}/preview?revision=${'7'.repeat(32)}`,
        },
      },
    });
    await expect(updateSiteBranding({
      db: d1,
      settings,
      expectedRevision: BRANDING_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
    })).resolves.toEqual({ kind: 'revision_conflict' });
  });

  it('allows root-relative R2 branding and follows Media origin changes', async () => {
    const { database, d1 } = createTestDatabase();
    databases.push(database);
    seed(database);
    const settings = materializeSiteBrandingSettingsDefaults();
    settings.logo.media_id = R2_ID;
    const saved = await updateSiteBranding({
      db: d1,
      settings,
      expectedRevision: BRANDING_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => '9'.repeat(32),
    });
    expect(saved.kind).toBe('completed');
    if (saved.kind !== 'completed') return;
    expect(projectSiteBranding(saved.document).logo).toEqual({
      src: '/uploads/2026/08/mark.svg',
    });
    expect(saved.document.selected_assets.logo?.preview_url).toBe(
      `/api/media/${R2_ID}/preview?revision=${'d'.repeat(32)}`,
    );

    await updateMediaSettings({
      db: d1,
      settings: {
        media_origin: 'https://media.example',
        media_delivery_mode: 'none',
      },
      expectedRevision: BRANDING_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => 'f'.repeat(32),
    });
    await expect(readSiteBranding({ db: d1 })).resolves.toMatchObject({
      selected_assets: {
        logo: {
          preview_url: 'https://media.example/uploads/2026/08/mark.svg',
        },
      },
    });
    await expect(updateMediaSettings({
      db: d1,
      settings: {
        media_origin: '',
        media_delivery_mode: 'none',
      },
      expectedRevision: 'f'.repeat(32),
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => '7'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      document: { settings: { media_origin: '', media_delivery_mode: 'none' } },
    });
    await expect(readSiteBranding({ db: d1 })).resolves.toMatchObject({
      selected_assets: {
        logo: {
          preview_url: `/api/media/${R2_ID}/preview?revision=${'d'.repeat(32)}`,
        },
      },
    });
  });

  it('rejects missing and favicon-incompatible Media', async () => {
    const { database, d1 } = createTestDatabase();
    databases.push(database);
    seed(database);
    const missing = materializeSiteBrandingSettingsDefaults();
    missing.logo.media_id = '9'.repeat(32);
    await expect(updateSiteBranding({
      db: d1,
      settings: missing,
      expectedRevision: BRANDING_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
    })).resolves.toEqual({ kind: 'media_not_found' });
    const invalid = materializeSiteBrandingSettingsDefaults();
    invalid.favicon.icon_media_id = WEBP_ID;
    await expect(updateSiteBranding({
      db: d1,
      settings: invalid,
      expectedRevision: BRANDING_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
    })).resolves.toEqual({ kind: 'media_type_not_allowed' });
  });

  it('clears branding references with Media and advances the document revision', async () => {
    const { database, d1 } = createTestDatabase();
    databases.push(database);
    seed(database);
    const settings = materializeSiteBrandingSettingsDefaults();
    settings.favicon.icon_media_id = PNG_ID;
    const saved = await updateSiteBranding({
      db: d1,
      settings,
      expectedRevision: BRANDING_SETTINGS_INITIAL_REVISION,
      updatedBy: USER_ID,
      now: NOW,
      createRevision: () => '5'.repeat(32),
    });
    expect(saved.kind).toBe('completed');

    await expect(clearSiteContent({
      db: d1,
      administratorId: USER_ID,
      now: new Date('2026-08-03T12:30:00.000Z'),
      createRevision: () => '6'.repeat(32),
    })).resolves.toMatchObject({
      deletedRows: { site_assets: 1, media: 3 },
      updatedRows: { site_settings: 1 },
    });
    await expect(readSiteBranding({ db: d1 })).resolves.toMatchObject({
      settings: materializeSiteBrandingSettingsDefaults(),
      revision: '6'.repeat(32),
      updated_at_iso: '2026-08-03T12:30:00.000Z',
    });
  });
});
