import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudioOperationalError } from '../lib/operational-error';
import {
  materializeEdgeIntegrationDocument,
  readEdgeIntegrationModeFailClosed,
} from './edge-services-repository';

const updatedAtIso = '2026-08-11T00:00:00.000Z';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Edge integration settings repository', () => {
  it('materializes one canonical revisioned mode document', () => {
    expect(materializeEdgeIntegrationDocument([
      {
        key: 'edge_integration_mode',
        value: 'enabled',
        type: 'string',
        updated_at_iso: updatedAtIso,
      },
      {
        key: 'edge_integration_revision',
        value: '1'.repeat(32),
        type: 'string',
        updated_at_iso: updatedAtIso,
      },
    ])).toEqual({
      settings: { mode: 'enabled' },
      revision: '1'.repeat(32),
      updated_at_iso: updatedAtIso,
    });
  });

  it('rejects partial, mismatched, and malformed control-plane rows', () => {
    for (const rows of [
      [],
      [{
        key: 'edge_integration_mode', value: 'enabled', type: 'string',
        updated_at_iso: updatedAtIso,
      }],
      [
        {
          key: 'edge_integration_mode', value: 'automatic', type: 'string',
          updated_at_iso: updatedAtIso,
        },
        {
          key: 'edge_integration_revision', value: '1'.repeat(32),
          type: 'string', updated_at_iso: updatedAtIso,
        },
      ],
      [
        {
          key: 'edge_integration_mode', value: 'enabled', type: 'string',
          updated_at_iso: updatedAtIso,
        },
        {
          key: 'edge_integration_revision', value: '1'.repeat(32),
          type: 'string', updated_at_iso: '2026-08-11T00:01:00.000Z',
        },
      ],
    ]) {
      expect(() => materializeEdgeIntegrationDocument(rows))
        .toThrow(StudioOperationalError);
    }
  });

  it('fails closed to disabled and records a query failure', async () => {
    const consoleSpy = vi.spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const db = {
      prepare() {
        throw new Error('D1 unavailable');
      },
    } as unknown as D1Database;

    await expect(readEdgeIntegrationModeFailClosed({ db }))
      .resolves.toBe('disabled');
    expect(consoleSpy).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Studio Edge integration settings query failed',
      $zeropress: expect.objectContaining({
        code: 'EDGE_INTEGRATION_SETTINGS_DATABASE_QUERY_FAILED',
      }),
    }));
  });
});
