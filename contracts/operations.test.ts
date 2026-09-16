import { describe, expect, it } from 'vitest';
import {
  administratorRecoveryBootstrapMfaSetupRequestSchema,
  administratorRecoveryBootstrapRequestSchema,
  administratorRecoveryBootstrapResponseSchema,
  administratorRecoveryRequestSchema,
  administratorRecoveryStatusResponseSchema,
  operationsEnvironmentEntrySchema,
  operationsSuccessSchema,
  operationsStatusResponseSchema,
} from './operations';

const administratorId = '0123456789abcdef0123456789abcdef';

describe('Maintenance and Recovery contract', () => {
  it('models recovery as an explicit action in the resolved status', () => {
    expect(operationsStatusResponseSchema.safeParse({
      success: true,
      data: {
        site_mode: 'recovery',
        edge_integration: {
          mode: 'enabled',
          document: null,
          change_available: false,
        },
        database: {
          state: 'ready',
          schema_version: 1,
          target_schema_version: 1,
        },
        current_ip: '203.0.113.10',
        allowed_ips: ['203.0.113.10'],
        environment: [],
        bindings: {
          DB: { bound: true },
          EDGE_DB: { bound: true },
          EDGE_KV: { bound: true },
          MEDIA_BUCKET: { bound: true },
          KV: { bound: true },
          AUTH_ROUTE_RATE_LIMITER: { bound: true },
        },
        actions: {
          clear_site_content: {
            available: false,
            requires_maintenance: false,
            confirmation: 'CLEAR SITE CONTENT',
          },
          reset_studio: {
            available: false,
            requires_maintenance: true,
            confirmation: 'RESET STUDIO',
          },
          uninstall_studio: {
            available: false,
            requires_maintenance: true,
            confirmation: 'UNINSTALL STUDIO',
          },
          recover_administrator: {
            available: true,
            requires_maintenance: false,
            confirmation: 'RECOVER ADMINISTRATOR',
          },
        },
        database_transfer: {
          requires_administrator_credentials: false,
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
        },
        database_upgrade: {
          state: 'up_to_date',
          current_schema_version: 1,
          target_schema_version: 1,
          available: false,
          operation_id: null,
          steps: [],
          confirmation: 'UPGRADE STUDIO DATABASE',
        },
        edge_database: {
          state: 'uninstalled',
          current_schema_version: null,
          target_schema_version: 1,
          operation_id: null,
          next_upgrade_steps: [],
          install_available: false,
          adopt_available: false,
          upgrade_available: false,
        },
        edge_target_reconciliation: {
          state: 'unavailable',
          operation_id: null,
          phase: null,
          processed_posts: 0,
          processed_pages: 0,
          scanned_edge_targets: 0,
          orphan_targets: 0,
          orphan_comments: 0,
          available: false,
        },
        content_search_index: {
          state: 'ready',
          reason: null,
          phase: null,
          operation_id: null,
          post_public_id_cursor: 0,
          page_public_id_cursor: 0,
          processed_posts: 0,
          processed_pages: 0,
          total_posts: 0,
          total_pages: 0,
          available: true,
        },
        cloudflare_access: {
          state: 'required',
          disable_available: true,
          confirmation: 'DISABLE CLOUDFLARE ACCESS',
        },
      },
    }).success).toBe(true);
  });

  it('requires an explicit secret state and rejects unknown fields', () => {
    const baseEntry = {
      name: 'STUDIO_AUTH_SECRET',
      exposure: 'presence',
      expected_storage: 'worker_secret',
    } as const;

    for (const state of [
      'valid',
      'missing',
      'invalid',
      'must_be_removed',
    ] as const) {
      expect(operationsEnvironmentEntrySchema.safeParse({
        ...baseEntry,
        state,
      }).success).toBe(true);
    }
    expect(operationsEnvironmentEntrySchema.safeParse(baseEntry).success)
      .toBe(false);
    expect(operationsEnvironmentEntrySchema.safeParse({
      ...baseEntry,
      state: 'valid',
      unexpected: true,
    }).success).toBe(false);
    expect(operationsEnvironmentEntrySchema.safeParse({
      name: 'STUDIO_SITE_MODE',
      exposure: 'presence',
      expected_storage: 'worker_secret',
      state: 'valid',
    }).success).toBe(false);
  });

  it('returns only reviewable administrator identity and MFA state', () => {
    expect(administratorRecoveryStatusResponseSchema.parse({
      success: true,
      data: {
        mode: 'existing_administrator',
        administrators: [
          {
            id: administratorId,
            email: 'owner@example.com',
            name: 'Studio Owner',
            status: 'active',
            mfa_configured: true,
          },
        ],
        confirmation: 'RECOVER ADMINISTRATOR',
      },
    })).toEqual({
      success: true,
      data: {
        mode: 'existing_administrator',
        administrators: [
          {
            id: administratorId,
            email: 'owner@example.com',
            name: 'Studio Owner',
            status: 'active',
            mfa_configured: true,
          },
        ],
        confirmation: 'RECOVER ADMINISTRATOR',
      },
    });
    expect(administratorRecoveryStatusResponseSchema.safeParse({
      success: true,
      data: {
        mode: 'bootstrap_administrator',
        administrators: [],
        confirmation: 'CREATE RECOVERY ADMINISTRATOR',
      },
    }).success).toBe(true);
    expect(administratorRecoveryStatusResponseSchema.safeParse({
      success: true,
      data: {
        mode: 'bootstrap_administrator',
        administrators: [],
        confirmation: 'RECOVER ADMINISTRATOR',
      },
    }).success).toBe(false);
  });

  it('preserves resource-qualified Edge effects in maintenance results', () => {
    expect(operationsSuccessSchema.parse({
      success: true,
      data: {
        operation: 'clear_site_content',
        status: 'completed',
        effects: {
          deleted_rows: {
            posts: 2,
            'EDGE_DB.comments': 5,
            'EDGE_DB.edge_comment_targets': 2,
          },
          inserted_rows: {},
          updated_rows: {},
        },
        resources: {
          studio: 'completed',
          edge: 'completed',
        },
      },
    }).data.effects.deleted_rows).toEqual({
      posts: 2,
      'EDGE_DB.comments': 5,
      'EDGE_DB.edge_comment_targets': 2,
    });
  });

  it('requires a strong-length password, explicit MFA decision, and exact phrase', () => {
    expect(administratorRecoveryRequestSchema.safeParse({
      administrator_id: administratorId,
      new_password: 'harbor lantern canyon marble circuit',
      reset_mfa: true,
      confirmation: 'RECOVER ADMINISTRATOR',
    }).success).toBe(true);
    expect(administratorRecoveryRequestSchema.safeParse({
      administrator_id: administratorId,
      new_password: 'harbor lantern canyon marble circuit',
      confirmation: 'RECOVER ADMINISTRATOR',
    }).success).toBe(false);
    expect(administratorRecoveryRequestSchema.safeParse({
      administrator_id: administratorId,
      new_password: 'harbor lantern canyon marble circuit',
      reset_mfa: true,
      confirmation: 'recover administrator',
    }).success).toBe(false);
  });

  it('requires backup acknowledgement, mandatory MFA proof, and the exact zero-admin bootstrap phrase', () => {
    expect(administratorRecoveryBootstrapMfaSetupRequestSchema.parse({
      administrator_email: ' New-Owner@Example.com ',
    })).toEqual({
      administrator_email: 'new-owner@example.com',
    });

    const request = {
      administrator_name: 'Recovery Owner',
      administrator_email: 'owner@example.com',
      new_password: 'harbor lantern canyon marble circuit',
      backup_acknowledged: true,
      mfa: {
        enrollment_token: 'a'.repeat(32),
        totp_code: '123456',
      },
      confirmation: 'CREATE RECOVERY ADMINISTRATOR',
    } as const;
    expect(
      administratorRecoveryBootstrapRequestSchema.safeParse(request).success,
    ).toBe(true);
    expect(administratorRecoveryBootstrapRequestSchema.safeParse({
      ...request,
      backup_acknowledged: false,
    }).success).toBe(false);
    expect(administratorRecoveryBootstrapRequestSchema.safeParse({
      ...request,
      confirmation: 'CREATE ADMINISTRATOR',
    }).success).toBe(false);
    const response = administratorRecoveryBootstrapResponseSchema.parse({
      success: true,
      data: {
        operation: 'bootstrap_recovery_administrator',
        status: 'completed',
        mfa_enrolled: true,
      },
    });
    expect(response.success && response.data.mfa_enrolled).toBe(true);
  });
});
