import { describe, expect, it } from 'vitest';
import {
  drainEdgeProjectionsRequestSchema,
  edgeServicesDocumentSchema,
  updateEdgeServicesRequestSchema,
} from './edge-services';

const revision = '1'.repeat(32);
const updatedAtIso = '2026-08-11T00:00:00.000Z';

describe('Edge Services contracts', () => {
  it('models every effective state without exposing Edge credentials', () => {
    for (const document of [
      {
        settings: { mode: 'disabled' },
        effective_state: 'disabled',
        pending_target_events: 0,
      },
      {
        settings: { mode: 'enabled' },
        effective_state: 'ready',
        pending_target_events: 0,
      },
      {
        settings: { mode: 'enabled' },
        effective_state: 'projection_pending',
        pending_target_events: 2,
      },
      {
        settings: { mode: 'enabled' },
        effective_state: 'reconciliation_required',
        pending_target_events: 0,
        unavailable_reason: 'target_mismatch',
      },
      {
        settings: { mode: 'enabled' },
        effective_state: 'unavailable',
        pending_target_events: 0,
        unavailable_reason: 'schema_incomplete',
      },
    ] as const) {
      expect(edgeServicesDocumentSchema.safeParse({
        ...document,
        revision,
        updated_at_iso: updatedAtIso,
      }).success).toBe(true);
    }
    expect(edgeServicesDocumentSchema.safeParse({
      settings: { mode: 'enabled', edge_db_id: 'must-not-be-exposed' },
      effective_state: 'ready',
      pending_target_events: 0,
      revision,
      updated_at_iso: updatedAtIso,
    }).success).toBe(false);
  });

  it('requires one closed revisioned mode update and an empty drain body', () => {
    expect(updateEdgeServicesRequestSchema.safeParse({
      settings: { mode: 'disabled' },
      expected_revision: revision,
    }).success).toBe(true);
    expect(updateEdgeServicesRequestSchema.safeParse({
      settings: {},
      expected_revision: revision,
    }).success).toBe(false);
    expect(updateEdgeServicesRequestSchema.safeParse({
      settings: { mode: 'automatic' },
      expected_revision: revision,
    }).success).toBe(false);
    expect(drainEdgeProjectionsRequestSchema.safeParse({}).success).toBe(true);
    expect(drainEdgeProjectionsRequestSchema.safeParse({ force: true }).success)
      .toBe(false);
  });
});
