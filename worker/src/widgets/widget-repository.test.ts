import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createDefaultWidgetAreaDraft,
  type WidgetItem,
} from '../../../contracts/widgets';
import { StudioOperationalError } from '../lib/operational-error';
import {
  createWidgetArea,
  deleteWidgetArea,
  listPreviewWidgets,
  listWidgetAreas,
  listWidgetAuthorOptions,
  saveWidgetArea,
} from './widget-repository';

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
    return /^\s*(?:WITH\b[\s\S]+?\bSELECT\b|SELECT\b)/iu.test(this.sql)
      ? this.all()
      : this.run();
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

const NOW = new Date('2026-08-01T08:00:00.000Z');

function seedAuthor(database: DatabaseSync) {
  database.prepare(`
    INSERT INTO authors (
      id, display_name, revision, created_at_iso, updated_at_iso
    ) VALUES ('Owner', 'Studio Owner', ?, ?, ?)
  `).run('a'.repeat(32), NOW.toISOString(), NOW.toISOString());
}

function profileItem(): WidgetItem {
  return {
    id: 'f'.repeat(32),
    type: 'profile',
    title: '',
    enabled: true,
    settings: { author_id: 'Owner' },
  };
}

describe('Widget D1 repository', () => {
  it('keeps reads empty, saves the virtual sidebar once, and protects it', async () => {
    const { d1 } = createTestDatabase();
    await expect(listWidgetAreas({ db: d1 })).resolves.toEqual([]);
    const defaults = createDefaultWidgetAreaDraft();
    const created = await saveWidgetArea({
      db: d1,
      widgetAreaId: 'sidebar',
      name: 'Sidebar Widgets',
      enabled: true,
      items: defaults.items,
      expectedRevision: null,
      now: NOW,
      createRevision: () => '1'.repeat(32),
    });
    expect(created).toMatchObject({
      kind: 'completed',
      widgetArea: {
        widget_area_id: 'sidebar',
        enabled: true,
        items: defaults.items,
        revision: '1'.repeat(32),
      },
    });
    await expect(saveWidgetArea({
      db: d1,
      widgetAreaId: 'sidebar',
      name: 'Duplicate',
      enabled: true,
      items: defaults.items,
      expectedRevision: null,
    })).resolves.toEqual({ kind: 'id_conflict' });
    await expect(saveWidgetArea({
      db: d1,
      widgetAreaId: 'sidebar',
      name: 'Sidebar',
      enabled: false,
      items: [],
      expectedRevision: '1'.repeat(32),
      now: new Date('2026-08-01T09:00:00.000Z'),
      createRevision: () => '2'.repeat(32),
    })).resolves.toMatchObject({
      kind: 'completed',
      widgetArea: {
        enabled: false,
        items: [],
        revision: '2'.repeat(32),
      },
    });
    await expect(deleteWidgetArea({
      db: d1,
      widgetAreaId: 'sidebar',
      expectedRevision: '2'.repeat(32),
    })).resolves.toEqual({ kind: 'protected' });
    await expect(listWidgetAreas({ db: d1 })).resolves.toMatchObject([{
      widget_area_id: 'sidebar',
      items: [],
    }]);
  });

  it('allows nullable revisions only for the missing protected sidebar', async () => {
    const { d1 } = createTestDatabase();
    await expect(saveWidgetArea({
      db: d1,
      widgetAreaId: 'secondary',
      name: 'Secondary',
      enabled: true,
      items: [],
      expectedRevision: null,
    })).resolves.toEqual({ kind: 'not_found' });
  });

  it('validates profile Authors and projects only theme-facing enabled data', async () => {
    const { database, d1 } = createTestDatabase();
    seedAuthor(database);
    await createWidgetArea({
      db: d1,
      widgetAreaId: 'sidebar',
      name: 'Sidebar Widgets',
      now: NOW,
      createRevision: () => '1'.repeat(32),
    });
    await expect(saveWidgetArea({
      db: d1,
      widgetAreaId: 'sidebar',
      name: 'Sidebar Widgets',
      enabled: true,
      items: [profileItem(), {
        id: 'e'.repeat(32),
        type: 'search',
        title: 'Hidden search',
        enabled: false,
        settings: { placeholder: 'Search...', button_label: 'Search' },
      }],
      expectedRevision: '1'.repeat(32),
      now: NOW,
      createRevision: () => '2'.repeat(32),
    })).resolves.toMatchObject({ kind: 'completed' });
    await expect(listWidgetAuthorOptions({
      db: d1,
      search: 'owner',
    })).resolves.toEqual([{ id: 'Owner', display_name: 'Studio Owner' }]);
    await expect(listPreviewWidgets({ db: d1 })).resolves.toEqual({
      sidebar: {
        name: 'Sidebar Widgets',
        items: [{
          type: 'profile',
          title: '',
          settings: { display_name: 'Studio Owner' },
        }],
      },
    });

    await createWidgetArea({
      db: d1,
      widgetAreaId: 'secondary',
      name: 'Secondary',
      now: NOW,
      createRevision: () => '3'.repeat(32),
    });
    await expect(saveWidgetArea({
      db: d1,
      widgetAreaId: 'secondary',
      name: 'Secondary',
      enabled: true,
      items: [{
        id: 'd'.repeat(32),
        type: 'profile',
        title: '',
        enabled: true,
        settings: { author_id: 'Missing' },
      }],
      expectedRevision: '3'.repeat(32),
    })).resolves.toEqual({ kind: 'author_not_found' });
  });

  it('preserves enabled empty areas in Preview and omits disabled areas', async () => {
    const { d1 } = createTestDatabase();
    await createWidgetArea({
      db: d1,
      widgetAreaId: 'a-area',
      name: 'A area',
      now: NOW,
      createRevision: () => '1'.repeat(32),
    });
    await createWidgetArea({
      db: d1,
      widgetAreaId: 'z-area',
      name: 'Z area',
      now: NOW,
      createRevision: () => '2'.repeat(32),
    });
    await saveWidgetArea({
      db: d1,
      widgetAreaId: 'z-area',
      name: 'Z area',
      enabled: false,
      items: [],
      expectedRevision: '2'.repeat(32),
      createRevision: () => '3'.repeat(32),
    });
    await expect(listPreviewWidgets({ db: d1 })).resolves.toEqual({
      'a-area': { name: 'A area', items: [] },
    });
  });

  it('fails closed for non-canonical stored item JSON', async () => {
    const { database, d1 } = createTestDatabase();
    database.prepare(`
      INSERT INTO widget_areas (
        widget_area_id, name, enabled, items, revision,
        created_at_iso, updated_at_iso
      ) VALUES ('bad', 'Bad', 1, ?, ?, ?, ?)
    `).run(
      JSON.stringify([{ ...profileItem(), title: ' padded ' }]),
      '1'.repeat(32),
      NOW.toISOString(),
      NOW.toISOString(),
    );
    await expect(listWidgetAreas({ db: d1 })).rejects.toMatchObject({
      code: 'WIDGET_MANAGEMENT_DATA_INVALID',
    } satisfies Partial<StudioOperationalError>);
  });
});
