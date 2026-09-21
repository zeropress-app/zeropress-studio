import type { AuditAction, AuditActor, AuditMetadata } from '../../../contracts/audit-logs';

const operations: Record<string, AuditAction> = {
  start_schema_upgrade: 'operations_upgrade',
  upgrade_studio_database: 'operations_upgrade',
  apply_schema_upgrade_step: 'operations_upgrade',
  export_database_backup: 'operations_backup',
  restore_database: 'operations_restore',
  restore_database_chunk: 'operations_restore',
  finalize_database_restore: 'operations_restore',
  bootstrap_recovery_administrator: 'operations_recover_administrator',
  recover_administrator: 'operations_recover_administrator',
  clear_site_content: 'operations_clear',
  clear_studio_content: 'operations_clear',
  reset_studio: 'operations_reset',
  reset_studio_database: 'operations_reset',
  install_edge_database: 'operations_edge',
  adopt_edge_database: 'operations_edge',
  uninstall_edge_database: 'operations_edge',
  upgrade_edge_database: 'operations_edge',
  complete_edge_database_upgrade: 'operations_edge',
  apply_edge_database_upgrade_step: 'operations_edge',
  enable_edge_integration: 'operations_edge',
  disable_edge_integration: 'operations_edge',
  reconcile_edge_comment_targets: 'operations_reconcile',
  advance_edge_target_reconciliation: 'operations_reconcile',
  purge_edge_target_orphans: 'operations_reconcile',
  finalize_edge_target_reconciliation: 'operations_reconcile',
  cancel_edge_target_reconciliation: 'operations_reconcile',
  start_edge_target_reconciliation: 'operations_reconcile',
  step_edge_target_reconciliation: 'operations_reconcile',
  rebuild_content_search_index: 'operations_search',
  complete_content_search_index_rebuild: 'operations_search',
  advance_content_search_index_rebuild: 'operations_search',
  apply_content_search_index_rebuild_step: 'operations_search',
  disable_cloudflare_access_requirement: 'operations_access',
};

export function operationsEvent(
  current: AuditActor | undefined,
  values: Record<string, unknown>,
  stage: AuditMetadata['stage'],
) {
  const operation = String(values.action ?? '');
  const action = operations[operation];
  if (!action) return null;
  const initiator: AuditActor | undefined = typeof values.initiated_by_user_id === 'string'
    ? {
        kind: 'user',
        id: values.initiated_by_user_id,
        email: typeof values.initiated_by_user_email === 'string' ? values.initiated_by_user_email : null,
        name: current?.id === values.initiated_by_user_id ? current.name : null,
      }
    : undefined;
  const metadata: AuditMetadata = {
    operation,
    stage,
    initiator,
    operation_id: typeof values.operation_id === 'string' ? values.operation_id : undefined,
  };
  return {
    action,
    target: {
      type: String(values.resource ?? 'DB'),
      id: typeof values.target_id === 'string' ? values.target_id
        : typeof values.created_user_id === 'string' ? values.created_user_id : undefined,
      label: typeof values.target_label === 'string' ? values.target_label : undefined,
    },
    metadata,
  };
}
