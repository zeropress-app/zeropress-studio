// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSchemaFingerprint,
  createManifestSha256,
  createStatementChainSha256,
  serializeDatabaseBackupArtifact,
  type DatabaseBackupManifest,
  type DatabaseTransferAvailability,
} from '../../../contracts/database-backup';
import { changeLocale } from '../i18n';
import { DatabaseBackupPanel } from './DatabaseBackupPanel';

const token = 'operations-token-value-000000000000';

function availability(
  requiresAdministratorCredentials: boolean,
): DatabaseTransferAvailability {
  return {
    requires_administrator_credentials: requiresAdministratorCredentials,
    export_modes: [
      'structure_and_data',
      'structure_only',
      'data_only',
    ],
    restore_modes: ['structure_and_data', 'data_only'],
    restore_confirmation: 'RESTORE DATABASE',
    databases: {
      studio: {
        bound: true,
        export_available: true,
        restore_available: true,
      },
      edge: {
        bound: true,
        export_available: true,
        restore_available: true,
      },
    },
  };
}

async function artifact(mode: DatabaseBackupManifest['mode'] = 'data_only') {
  const schema = {
    type: 'table' as const,
    name: 'example',
    table_name: 'example',
    sql: 'CREATE TABLE example (id INTEGER PRIMARY KEY)',
  };
  const statements = mode === 'structure_only'
    ? [
        'PRAGMA defer_foreign_keys = TRUE',
        'DROP TABLE IF EXISTS "example"',
        schema.sql,
      ]
    : [
        'PRAGMA defer_foreign_keys = TRUE',
        'DELETE FROM "example"',
        'INSERT INTO "example" ("id") VALUES (1)',
      ];
  const manifest: DatabaseBackupManifest = {
    format: 'zeropress-studio-sql-backup',
    format_version: 1,
    database: 'studio',
    mode,
    exported_at_iso: '2026-08-03T00:00:00.000Z',
    schema_fingerprint: await createSchemaFingerprint([schema]),
    studio_schema_version: 1,
    schema_objects: [{
      type: 'table',
      name: 'example',
      table_name: 'example',
    }],
    tables: [{ name: 'example', row_count: mode === 'structure_only' ? 0 : 1 }],
  };
  return serializeDatabaseBackupArtifact({
    manifest,
    statements,
    footer: {
      manifest_sha256: await createManifestSha256(manifest),
      statement_count: statements.length,
      statement_chain_sha256: await createStatementChainSha256(statements),
    },
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(async () => {
  await changeLocale('en');
});

describe('Database backup & restore panel', () => {
  it('keeps pre-upgrade backup export enabled while new restore is unavailable', () => {
    const preUpgradeAvailability = availability(true);
    preUpgradeAvailability.databases.studio.restore_available = false;
    preUpgradeAvailability.databases.edge.restore_available = false;

    render(
      <DatabaseBackupPanel
        token={token}
        availability={preUpgradeAvailability}
        siteMode="maintenance"
        databaseState="upgrade_required"
      />,
    );

    expect(screen.getByRole('option', { name: 'Studio DB' })).toBeEnabled();
    expect(screen.getByRole('button', {
      name: 'Create and download backup',
    })).toBeEnabled();
  });

  it('hides impossible export and explains recovery restore for an uninstalled maintenance database', async () => {
    const unavailable = availability(false);
    unavailable.databases.studio.export_available = false;
    unavailable.databases.studio.restore_available = false;
    unavailable.databases.edge.export_available = false;
    unavailable.databases.edge.restore_available = false;
    const user = userEvent.setup();

    render(
      <DatabaseBackupPanel
        token={token}
        availability={unavailable}
        siteMode="maintenance"
        databaseState="uninstalled"
      />,
    );

    expect(screen.queryByRole('heading', { name: 'Download database backup' }))
      .not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Restore database backup' }))
      .toBeInTheDocument();
    expect(screen.getByText(/Switch STUDIO_SITE_MODE to recovery/u))
      .toBeInTheDocument();

    await user.upload(
      screen.getByLabelText('ZeroPress SQL backup file'),
      new File([await artifact()], 'data.sql', { type: 'application/sql' }),
    );
    expect(await screen.findByRole('button', {
      name: 'Review database restore',
    })).toBeDisabled();
  });

  it('offers only exportable database targets and selects the available target', () => {
    const edgeOnly = availability(false);
    edgeOnly.databases.studio.export_available = false;

    render(
      <DatabaseBackupPanel
        token={token}
        availability={edgeOnly}
        siteMode="recovery"
        databaseState="uninstalled"
      />,
    );

    expect(screen.queryByRole('option', { name: 'Studio DB' }))
      .not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Edge DB' })).toBeEnabled();
    expect(screen.getByLabelText('Database')).toHaveValue('edge');
    expect(screen.getByRole('button', {
      name: 'Create and download backup',
    })).toBeEnabled();
  });

  it('shows an Edge-only backup without restore controls in operational mode', () => {
    const edgeOnly = availability(true);
    edgeOnly.databases.studio.export_available = false;
    edgeOnly.databases.studio.restore_available = false;
    edgeOnly.databases.edge.restore_available = false;

    render(
      <DatabaseBackupPanel
        token={token}
        availability={edgeOnly}
        siteMode="operational"
        databaseState="ready"
      />,
    );

    expect(screen.queryByRole('option', { name: 'Studio DB' }))
      .not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Edge DB' })).toBeEnabled();
    expect(screen.getByRole('button', {
      name: 'Create and download backup',
    })).toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'Restore database backup' }))
      .not.toBeInTheDocument();
  });

  it('downloads a maintenance backup after administrator re-verification', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('-- backup\n', {
      status: 200,
      headers: {
        'Content-Type': 'application/sql; charset=utf-8',
        'Content-Disposition': 'attachment; filename="zeropress-studio-structure_and_data-test.sql"',
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn().mockReturnValue('blob:backup'),
      revokeObjectURL: vi.fn(),
    });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const user = userEvent.setup();
    render(
      <DatabaseBackupPanel
        token={token}
        availability={availability(true)}
        siteMode="maintenance"
        databaseState="ready"
      />,
    );

    await user.type(
      screen.getByLabelText('Administrator email'),
      'owner@example.com',
    );
    await user.type(
      screen.getByLabelText('Administrator password'),
      'administrator-password',
    );
    await user.click(screen.getByRole('button', {
      name: 'Create and download backup',
    }));

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      database: 'studio',
      mode: 'structure_and_data',
      administrator_email: 'owner@example.com',
      administrator_password: 'administrator-password',
    });
    expect(click).toHaveBeenCalledOnce();
    expect(await screen.findByRole('status')).toHaveTextContent(
      'was downloaded',
    );
  });

  it('keeps structure-only artifacts export-only', async () => {
    const user = userEvent.setup();
    render(
      <DatabaseBackupPanel
        token={token}
        availability={availability(false)}
        siteMode="recovery"
        databaseState="ready"
      />,
    );
    await user.upload(
      screen.getByLabelText('ZeroPress SQL backup file'),
      new File([await artifact('structure_only')], 'structure.sql', {
        type: 'application/sql',
      }),
    );

    expect(await screen.findByText(
      /Structure-only artifacts are export-only/u,
    )).toBeInTheDocument();
    expect(screen.getByRole('button', {
      name: 'Review database restore',
    })).toBeDisabled();
  });

  it('restores in recovery mode without sending administrator credentials', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      const data = url.endsWith('/start')
        ? {
            operation: 'restore_database',
            status: 'started',
            database: 'studio',
            mode: 'data_only',
            restore_id: 'b'.repeat(32),
            next_chunk: 0,
            expected_chunk_count: 1,
          }
        : url.endsWith('/chunk')
          ? {
              operation: 'restore_database',
              status: 'in_progress',
              database: 'studio',
              restore_id: 'b'.repeat(32),
              accepted_chunk: 0,
              next_chunk: 1,
              replayed: false,
            }
          : {
              operation: 'restore_database',
              status: 'completed',
              database: 'studio',
              mode: 'data_only',
              restored_tables: [{ name: 'example', row_count: 1 }],
              restored_statement_count: 3,
              schema_fingerprint: 'a'.repeat(64),
            };
      return new Response(JSON.stringify({ success: true, data }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    render(
      <DatabaseBackupPanel
        token={token}
        availability={availability(false)}
        siteMode="recovery"
        databaseState="uninstalled"
      />,
    );
    await user.upload(
      screen.getByLabelText('ZeroPress SQL backup file'),
      new File([await artifact()], 'data.sql', { type: 'application/sql' }),
    );
    await user.click(await screen.findByRole('button', {
      name: 'Review database restore',
    }));

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByLabelText('Administrator email'))
      .not.toBeInTheDocument();
    await user.type(
      within(dialog).getByLabelText(/Type the exact confirmation phrase/u),
      'RESTORE DATABASE',
    );
    await user.click(within(dialog).getByRole('button', {
      name: 'Continue to final confirmation',
    }));
    await user.click(within(dialog).getByRole('button', {
      name: 'Confirm and restore database',
    }));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      database: 'studio',
      confirmation: 'RESTORE DATABASE',
    });
    expect(body).not.toHaveProperty('administrator_email');
    expect(body).not.toHaveProperty('administrator_password');
    expect(await within(dialog).findByRole('heading', {
      name: 'Database restore completed',
    })).toBeInTheDocument();
  });
});
