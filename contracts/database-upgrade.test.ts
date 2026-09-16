import { describe, expect, it } from 'vitest';
import {
  DATABASE_UPGRADE_CONFIRMATION,
  databaseUpgradeStartRequestSchema,
  databaseUpgradeStatusSchema,
  databaseUpgradeStepRequestSchema,
} from './database-upgrade';

const step = {
  id: '001_example',
  from_version: 1,
  to_version: 2,
  sha256: 'a'.repeat(64),
  statement_count: 2,
};

describe('database upgrade contract', () => {
  it('models exact consecutive upgrade plans and resumable state', () => {
    expect(databaseUpgradeStatusSchema.parse({
      state: 'upgrade_required',
      current_schema_version: 1,
      target_schema_version: 2,
      available: true,
      operation_id: null,
      steps: [step],
      confirmation: DATABASE_UPGRADE_CONFIRMATION,
    }).steps).toEqual([step]);

    expect(databaseUpgradeStatusSchema.safeParse({
      state: 'upgrade_required',
      current_schema_version: 1,
      target_schema_version: 3,
      available: true,
      operation_id: null,
      steps: [{ ...step, to_version: 3 }],
      confirmation: DATABASE_UPGRADE_CONFIRMATION,
    }).success).toBe(false);
  });

  it('requires administrator verification, backup acknowledgement, and the exact phrase only at start', () => {
    const start = {
      administrator_email: 'OWNER@EXAMPLE.COM',
      administrator_password: 'administrator-password',
      backup_acknowledged: true,
      confirmation: DATABASE_UPGRADE_CONFIRMATION,
    };
    expect(databaseUpgradeStartRequestSchema.parse(start)
      .administrator_email).toBe('owner@example.com');
    expect(databaseUpgradeStartRequestSchema.safeParse({
      ...start,
      backup_acknowledged: false,
    }).success).toBe(false);
    expect(databaseUpgradeStartRequestSchema.safeParse({
      ...start,
      confirmation: 'upgrade studio database',
    }).success).toBe(false);

    expect(databaseUpgradeStepRequestSchema.safeParse({
      operation_id: '1'.repeat(32),
      step_id: step.id,
      confirmation: DATABASE_UPGRADE_CONFIRMATION,
    }).success).toBe(true);
    expect(databaseUpgradeStepRequestSchema.safeParse({
      operation_id: '1'.repeat(32),
      step_id: step.id,
      confirmation: DATABASE_UPGRADE_CONFIRMATION,
      administrator_password: 'must-not-be-sent-again',
    }).success).toBe(false);
  });
});
