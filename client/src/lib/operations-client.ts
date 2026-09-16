import {
  administratorRecoveryBootstrapMfaSetupResponseSchema,
  administratorRecoveryBootstrapResponseSchema,
  administratorRecoveryResponseSchema,
  administratorRecoveryStatusResponseSchema,
  operationsResponseSchema,
  operationsEdgeIntegrationUpdateResponseSchema,
  operationsStatusResponseSchema,
  uninstallPreviewResponseSchema,
  type AdministratorRecoveryBootstrapMfaSetupRequest,
  type AdministratorRecoveryBootstrapMfaSetupResponse,
  type AdministratorRecoveryBootstrapRequest,
  type AdministratorRecoveryBootstrapResponse,
  type AdministratorRecoveryRequest,
  type AdministratorRecoveryResponse,
  type AdministratorRecoveryStatusResponse,
  type OperationsAction,
  type OperationsRequest,
  type OperationsResponse,
  type OperationsEdgeIntegrationUpdateRequest,
  type OperationsEdgeIntegrationUpdateResponse,
  type OperationsStatusResponse,
  type UninstallPreviewResponse,
} from '../../../contracts/operations';
import {
  databaseRestoreChunkResponseSchema,
  databaseRestoreStartResponseSchema,
  databaseRestoreResponseSchema,
  type DatabaseBackupRequest,
  type DatabaseRestoreChunkRequest,
  type DatabaseRestoreChunkResponse,
  type DatabaseRestoreFinalizeRequest,
  type DatabaseRestoreResponse,
  type DatabaseRestoreStartRequest,
  type DatabaseRestoreStartResponse,
} from '../../../contracts/database-backup';
import {
  apiErrorSchema,
  type ApiErrorResponse,
} from '../../../contracts/api';
import {
  databaseUpgradeStartResponseSchema,
  databaseUpgradeStepResponseSchema,
  type DatabaseUpgradeStartRequest,
  type DatabaseUpgradeStartResponse,
  type DatabaseUpgradeStepRequest,
  type DatabaseUpgradeStepResponse,
} from '../../../contracts/database-upgrade';
import {
  edgeDatabaseMutationResponseSchema,
  edgeDatabaseUninstallPreviewResponseSchema,
  edgeDatabaseUninstallResponseSchema,
  type EdgeDatabaseAdoptRequest,
  type EdgeDatabaseInstallRequest,
  type EdgeDatabaseMutationResponse,
  type EdgeDatabaseUninstallPreviewResponse,
  type EdgeDatabaseUninstallRequest,
  type EdgeDatabaseUninstallResponse,
  type EdgeDatabaseUpgradeStartRequest,
  type EdgeDatabaseUpgradeStepRequest,
} from '../../../contracts/edge-database-lifecycle';
import {
  edgeTargetOrphanListSuccessSchema,
  edgeTargetReconciliationMutationResponseSchema,
  type EdgeTargetReconciliationMutationResponse,
} from '../../../contracts/edge-target-reconciliation';
import {
  contentSearchIndexRebuildMutationResponseSchema,
  type ContentSearchIndexRebuildMutationResponse,
  type ContentSearchIndexRebuildStepRequest,
} from '../../../contracts/content-search-index';
import {
  cloudflareAccessSettingsResponseSchema,
  cloudflareAccessRecoveryResponseSchema,
  type CloudflareAccessSettingsResponse,
  type CloudflareAccessRecoveryRequest,
  type CloudflareAccessRecoveryResponse,
  type UpdateCloudflareAccessSettingsRequest,
} from '../../../contracts/cloudflare-access';
import {
  assertValidOperationsToken,
  OperationsClientError,
  OPERATIONS_TIMEOUT_MS,
  requestOperationsApi,
} from './operations-request';

// `operations-request` owns the transport layer. Re-export its error types here
// so existing callers can continue importing a single client module.
export {
  OperationsClientError,
  type OperationsClientErrorCode,
} from './operations-request';

const operationPaths: Record<OperationsAction, string> = {
  clear_site_content: '/api/system/operations/clear-content',
  reset_studio: '/api/system/operations/reset-studio',
  uninstall_studio: '/api/system/operations/uninstall-studio',
};

export type DatabaseBackupDownloadResponse =
  | {
      success: true;
      data: {
        blob: Blob;
        filename: string;
      };
    }
  | ApiErrorResponse;

export function requestOperationsStatus(
  token: string,
): Promise<OperationsStatusResponse> {
  return requestOperationsApi<OperationsStatusResponse>({
    path: '/api/system/operations/status',
    token,
    method: 'GET',
    parse(value) {
      const parsed = operationsStatusResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestOperationsEdgeIntegrationUpdate(input: {
  token: string;
  request: OperationsEdgeIntegrationUpdateRequest;
}): Promise<OperationsEdgeIntegrationUpdateResponse> {
  return requestOperationsApi<OperationsEdgeIntegrationUpdateResponse>({
    path: '/api/system/operations/edge-integration',
    token: input.token,
    method: 'POST',
    body: input.request,
    parse(value) {
      const parsed = operationsEdgeIntegrationUpdateResponseSchema.safeParse(
        value,
      );
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestCloudflareAccessRecovery(input: {
  token: string;
  request: CloudflareAccessRecoveryRequest;
}): Promise<CloudflareAccessRecoveryResponse> {
  return requestOperationsApi<CloudflareAccessRecoveryResponse>({
    path: '/api/system/operations/cloudflare-access/disable',
    token: input.token,
    method: 'POST',
    body: input.request,
    parse(value) {
      const parsed = cloudflareAccessRecoveryResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestOperationsCloudflareAccessSettings(input: {
  token: string;
  signal?: AbortSignal;
}): Promise<CloudflareAccessSettingsResponse> {
  return requestOperationsApi<CloudflareAccessSettingsResponse>({
    path: '/api/system/operations/cloudflare-access',
    token: input.token,
    method: 'GET',
    externalSignal: input.signal,
    parse(value) {
      const parsed = cloudflareAccessSettingsResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestOperationsCloudflareAccessUpdate(input: {
  token: string;
  request: UpdateCloudflareAccessSettingsRequest;
}): Promise<CloudflareAccessSettingsResponse> {
  return requestOperationsApi<CloudflareAccessSettingsResponse>({
    path: '/api/system/operations/cloudflare-access',
    token: input.token,
    method: 'PUT',
    body: input.request,
    parse(value) {
      const parsed = cloudflareAccessSettingsResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestEdgeDatabaseUninstallPreview(input: {
  token: string;
  request: EdgeDatabaseUninstallRequest;
}): Promise<EdgeDatabaseUninstallPreviewResponse> {
  return requestOperationsApi<EdgeDatabaseUninstallPreviewResponse>({
    path: '/api/system/operations/edge-database/uninstall/preview',
    token: input.token,
    method: 'POST',
    body: input.request,
    parse(value) {
      const parsed = edgeDatabaseUninstallPreviewResponseSchema.safeParse(
        value,
      );
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestEdgeDatabaseUninstall(input: {
  token: string;
  request: EdgeDatabaseUninstallRequest;
}): Promise<EdgeDatabaseUninstallResponse> {
  return requestOperationsApi<EdgeDatabaseUninstallResponse>({
    path: '/api/system/operations/edge-database/uninstall',
    token: input.token,
    method: 'POST',
    body: input.request,
    parse(value) {
      const parsed = edgeDatabaseUninstallResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestOperationsAction(input: {
  token: string;
  action: OperationsAction;
  request: OperationsRequest;
}): Promise<OperationsResponse> {
  return requestOperationsApi<OperationsResponse>({
    path: operationPaths[input.action],
    token: input.token,
    method: 'POST',
    body: input.request,
    parse(value) {
      const parsed = operationsResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestContentSearchIndexRebuildStart(input: {
  token: string;
  request: {
    administrator_email: string;
    administrator_password: string;
    confirmation: 'REBUILD CONTENT SEARCH';
  };
}): Promise<ContentSearchIndexRebuildMutationResponse> {
  return requestOperationsApi<ContentSearchIndexRebuildMutationResponse>({
    path: '/api/system/operations/content-search-index/rebuild/start',
    token: input.token,
    method: 'POST',
    body: input.request,
    parse(value) {
      const parsed = contentSearchIndexRebuildMutationResponseSchema.safeParse(
        value,
      );
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestContentSearchIndexRebuildStep(input: {
  token: string;
  request: ContentSearchIndexRebuildStepRequest;
}): Promise<ContentSearchIndexRebuildMutationResponse> {
  return requestOperationsApi<ContentSearchIndexRebuildMutationResponse>({
    path: '/api/system/operations/content-search-index/rebuild/step',
    token: input.token,
    method: 'POST',
    body: input.request,
    parse(value) {
      const parsed = contentSearchIndexRebuildMutationResponseSchema.safeParse(
        value,
      );
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestUninstallPreview(input: {
  token: string;
  request: OperationsRequest;
}): Promise<UninstallPreviewResponse> {
  return requestOperationsApi<UninstallPreviewResponse>({
    path: '/api/system/operations/uninstall-studio/preview',
    token: input.token,
    method: 'POST',
    body: input.request,
    parse(value) {
      const parsed = uninstallPreviewResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestDatabaseUpgradeStart(input: {
  token: string;
  request: DatabaseUpgradeStartRequest;
}): Promise<DatabaseUpgradeStartResponse> {
  return requestOperationsApi<DatabaseUpgradeStartResponse>({
    path: '/api/system/operations/database-upgrade/start',
    token: input.token,
    method: 'POST',
    body: input.request,
    parse(value) {
      const parsed = databaseUpgradeStartResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestDatabaseUpgradeStep(input: {
  token: string;
  request: DatabaseUpgradeStepRequest;
}): Promise<DatabaseUpgradeStepResponse> {
  return requestOperationsApi<DatabaseUpgradeStepResponse>({
    path: '/api/system/operations/database-upgrade/step',
    token: input.token,
    method: 'POST',
    body: input.request,
    parse(value) {
      const parsed = databaseUpgradeStepResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export async function requestDatabaseBackup(input: {
  token: string;
  request: DatabaseBackupRequest;
}): Promise<DatabaseBackupDownloadResponse> {
  assertValidOperationsToken(input.token);
  const controller = new AbortController();
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    OPERATIONS_TIMEOUT_MS,
  );
  try {
    const response = await studioFetch('/api/system/operations/database-backup', {
      method: 'POST',
      headers: {
        Accept: 'application/sql, application/json',
        Authorization: `Bearer ${input.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input.request),
      credentials: 'same-origin',
      signal: controller.signal,
    });
    if (response.ok) {
      if (!response.headers.get('Content-Type')?.includes('application/sql')) {
        throw new OperationsClientError('INVALID_RESPONSE');
      }
      const contentDisposition = response.headers.get('Content-Disposition');
      const filename = /filename="([^"]+)"/u.exec(
        contentDisposition ?? '',
      )?.[1];
      if (!filename || !/^zeropress-[A-Za-z0-9._-]+\.sql$/u.test(filename)) {
        throw new OperationsClientError('INVALID_RESPONSE');
      }
      return {
        success: true,
        data: { blob: await response.blob(), filename },
      };
    }
    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new OperationsClientError('INVALID_RESPONSE');
    }
    const parsed = apiErrorSchema.safeParse(raw);
    if (!parsed.success) {
      throw new OperationsClientError('INVALID_RESPONSE');
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof OperationsClientError) throw error;
    if (controller.signal.aborted) {
      throw new OperationsClientError('TIMEOUT');
    }
    throw new OperationsClientError('NETWORK_ERROR');
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export function requestDatabaseRestoreStart(input: {
  token: string;
  request: DatabaseRestoreStartRequest;
}): Promise<DatabaseRestoreStartResponse> {
  return requestOperationsApi<DatabaseRestoreStartResponse>({
    path: '/api/system/operations/database-restore/start',
    token: input.token,
    method: 'POST',
    body: input.request,
    parse(value) {
      const parsed = databaseRestoreStartResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestDatabaseRestoreChunk(input: {
  token: string;
  request: DatabaseRestoreChunkRequest;
}): Promise<DatabaseRestoreChunkResponse> {
  return requestOperationsApi<DatabaseRestoreChunkResponse>({
    path: '/api/system/operations/database-restore/chunk',
    token: input.token,
    method: 'POST',
    body: input.request,
    parse(value) {
      const parsed = databaseRestoreChunkResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestDatabaseRestoreFinalize(input: {
  token: string;
  request: DatabaseRestoreFinalizeRequest;
}): Promise<DatabaseRestoreResponse> {
  return requestOperationsApi<DatabaseRestoreResponse>({
    path: '/api/system/operations/database-restore/finalize',
    token: input.token,
    method: 'POST',
    body: input.request,
    parse(value) {
      const parsed = databaseRestoreResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestAdministratorRecoveryStatus(
  token: string,
): Promise<AdministratorRecoveryStatusResponse> {
  return requestOperationsApi<AdministratorRecoveryStatusResponse>({
    path: '/api/system/operations/administrator-recovery',
    token,
    method: 'GET',
    parse(value) {
      const parsed = administratorRecoveryStatusResponseSchema.safeParse(
        value,
      );
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestAdministratorRecovery(input: {
  token: string;
  request: AdministratorRecoveryRequest;
}): Promise<AdministratorRecoveryResponse> {
  return requestOperationsApi<AdministratorRecoveryResponse>({
    path: '/api/system/operations/administrator-recovery',
    token: input.token,
    method: 'POST',
    body: input.request,
    parse(value) {
      const parsed = administratorRecoveryResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestAdministratorRecoveryBootstrapMfaSetup(input: {
  token: string;
  request: AdministratorRecoveryBootstrapMfaSetupRequest;
}): Promise<AdministratorRecoveryBootstrapMfaSetupResponse> {
  return requestOperationsApi<AdministratorRecoveryBootstrapMfaSetupResponse>({
    path: '/api/system/operations/administrator-recovery/bootstrap/mfa/setup',
    token: input.token,
    method: 'POST',
    body: input.request,
    parse(value) {
      const parsed =
        administratorRecoveryBootstrapMfaSetupResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestAdministratorRecoveryBootstrap(input: {
  token: string;
  request: AdministratorRecoveryBootstrapRequest;
}): Promise<AdministratorRecoveryBootstrapResponse> {
  return requestOperationsApi<AdministratorRecoveryBootstrapResponse>({
    path: '/api/system/operations/administrator-recovery/bootstrap',
    token: input.token,
    method: 'POST',
    body: input.request,
    parse(value) {
      const parsed = administratorRecoveryBootstrapResponseSchema.safeParse(
        value,
      );
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

function requestEdgeDatabaseMutation(input: {
  token: string;
  path: string;
  request: unknown;
}): Promise<EdgeDatabaseMutationResponse> {
  return requestOperationsApi<EdgeDatabaseMutationResponse>({
    path: input.path,
    token: input.token,
    method: 'POST',
    body: input.request,
    parse(value) {
      const parsed = edgeDatabaseMutationResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestEdgeDatabaseInstall(input: {
  token: string;
  request: EdgeDatabaseInstallRequest;
}) {
  return requestEdgeDatabaseMutation({
    token: input.token,
    path: '/api/system/operations/edge-database/install',
    request: input.request,
  });
}

export function requestEdgeDatabaseAdoption(input: {
  token: string;
  request: EdgeDatabaseAdoptRequest;
}) {
  return requestEdgeDatabaseMutation({
    token: input.token,
    path: '/api/system/operations/edge-database/adopt',
    request: input.request,
  });
}

export function requestEdgeDatabaseUpgradeStart(input: {
  token: string;
  request: EdgeDatabaseUpgradeStartRequest;
}) {
  return requestEdgeDatabaseMutation({
    token: input.token,
    path: '/api/system/operations/edge-database/upgrade/start',
    request: input.request,
  });
}

export function requestEdgeDatabaseUpgradeStep(input: {
  token: string;
  request: EdgeDatabaseUpgradeStepRequest;
}) {
  return requestEdgeDatabaseMutation({
    token: input.token,
    path: '/api/system/operations/edge-database/upgrade/step',
    request: input.request,
  });
}

function requestEdgeReconciliationMutation(input: {
  token: string;
  path: string;
  request: unknown;
}): Promise<EdgeTargetReconciliationMutationResponse> {
  return requestOperationsApi<EdgeTargetReconciliationMutationResponse>({
    path: input.path,
    token: input.token,
    method: 'POST',
    body: input.request,
    parse(value) {
      const parsed = edgeTargetReconciliationMutationResponseSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestEdgeReconciliationStart(input: {
  token: string;
  request: unknown;
}) {
  return requestEdgeReconciliationMutation({
    ...input,
    path: '/api/system/operations/edge-target-reconciliation/start',
  });
}

export function requestEdgeReconciliationStep(input: {
  token: string;
  operationId: string;
}) {
  return requestEdgeReconciliationMutation({
    token: input.token,
    path: '/api/system/operations/edge-target-reconciliation/step',
    request: { operation_id: input.operationId },
  });
}

export function requestEdgeReconciliationFinalize(input: {
  token: string;
  operationId: string;
}) {
  return requestEdgeReconciliationMutation({
    token: input.token,
    path: '/api/system/operations/edge-target-reconciliation/finalize',
    request: { operation_id: input.operationId },
  });
}

export function requestEdgeReconciliationCancel(input: {
  token: string;
  operationId: string;
  confirmation: string;
}) {
  return requestEdgeReconciliationMutation({
    token: input.token,
    path: '/api/system/operations/edge-target-reconciliation/cancel',
    request: {
      operation_id: input.operationId,
      confirmation: input.confirmation,
    },
  });
}

export function requestEdgeOrphans(input: {
  token: string;
  operationId: string;
  cursor?: number;
  limit?: number;
}) {
  return requestOperationsApi<ReturnType<typeof edgeTargetOrphanListSuccessSchema.parse>>({
    path: '/api/system/operations/edge-target-reconciliation/orphans',
    token: input.token,
    method: 'POST',
    body: {
      operation_id: input.operationId,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    },
    parse(value) {
      const parsed = edgeTargetOrphanListSuccessSchema.safeParse(value);
      return parsed.success
        ? { success: true as const, data: parsed.data }
        : { success: false as const };
    },
  });
}

export function requestEdgeOrphanPurge(input: {
  token: string;
  operationId: string;
  targetIds: number[];
  confirmation: string;
}) {
  return requestEdgeReconciliationMutation({
    token: input.token,
    path: '/api/system/operations/edge-target-reconciliation/orphans/purge',
    request: {
      operation_id: input.operationId,
      target_ids: input.targetIds,
      confirmation: input.confirmation,
    },
  });
}
import { studioFetch } from './studio-fetch';
