import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  administratorRecoveryBootstrapMfaSetupRequestSchema,
  administratorRecoveryBootstrapConfirmation,
  administratorRecoveryBootstrapRequestSchema,
  administratorRecoveryConfirmation,
  administratorRecoveryRequestSchema,
  operationsConfirmation,
  operationsEdgeIntegrationUpdateRequestSchema,
  operationsEdgeIntegrationUpdateSuccessSchema,
  operationsRequestSchema,
  type AdministratorRecoveryBootstrapSuccess,
  type AdministratorRecoveryStatusSuccess,
  type AdministratorRecoverySuccess,
  type OperationsAction,
  type OperationsStatusData,
  type OperationsSuccess,
  type UninstallPreviewSuccess,
} from '../../../contracts/operations';
import {
  STUDIO_WORKER_CONFIGURATION_CATALOG,
} from '../../../contracts/worker-configuration';
import type { MfaEnrollmentSetupSuccess } from '../../../contracts/mfa';
import {
  databaseUpgradeStartRequestSchema,
  databaseUpgradeStepRequestSchema,
  type DatabaseUpgradeStartSuccess,
} from '../../../contracts/database-upgrade';
import { EDGE_DATABASE_SCHEMA_VERSION } from '../../../contracts/edge-database-lifecycle';
import {
  DATABASE_RESTORE_MAX_CHUNK_BYTES,
  DatabaseBackupArtifactError,
  databaseBackupRequestSchema,
  databaseRestoreChunkRequestSchema,
  databaseRestoreFinalizeRequestSchema,
  databaseRestoreStartRequestSchema,
  type DatabaseBackupRequest,
  type DatabaseBackupTarget,
  type DatabaseRestoreChunkSuccess,
  type DatabaseRestoreStartSuccess,
  type DatabaseRestoreSuccess,
} from '../../../contracts/database-backup';
import { resolveStudioWorkerSecretState } from '../../../contracts/worker-secret';
import { hashPassword } from '../auth/password';
import { requireStudioCapability } from '../auth/authorization';
import type {
  ResolvedSession,
  ResolveUserSession,
} from '../auth/session-repository';
import { assessPasswordAcceptance } from '../auth/password-breach-service';
import {
  createMfaEnrollment,
  encryptTotpSecret,
  isConfiguredAuthSecret,
  openMfaEnrollment,
  verifyMfaEnrollmentProof,
} from '../auth/mfa-crypto';
import { resolveSiteMode } from '../system/site-mode';
import { resolveSystemStatus } from '../system/resolve-system-status';
import {
  readBearerToken,
  secretTokensMatch,
} from '../lib/bearer-token';
import { errorResponse } from '../lib/http';
import {
  logOperationalFailure,
  logStudioOperationalError,
  StudioOperationalError,
} from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import {
  resolveOperationsConfiguration,
  resolveOperationsRequestBoundary,
  synchronizeOperationsConfigurationIncident,
  type OperationsConfiguration,
} from './access';
import {
  authorizeOperationsAdministrator,
  type OperationsAdministratorAuthorization,
} from './authorize-administrator';
import {
  operationsInitiatorMetadata,
  type OperationsInitiator,
} from './initiator';
import {
  inspectUninstallStudio,
  uninstallStudioDatabase,
  type DatabaseOperationResult,
} from './database-operations';
import {
  clearSiteContentWithoutEdge,
  clearSiteContentWithEdge,
  resetStudioWithoutEdge,
  resetStudioWithEdge,
} from './coordinated-database-operations';
import { requireEdgeDatabase } from '../comments/edge-db';
import {
  bootstrapRecoveryAdministrator,
  inspectRecoveryAdministratorBootstrapAvailability,
  listRecoverableAdministrators,
  recoverAdministratorAccess,
} from './administrator-recovery';
import {
  applyDatabaseRestoreChunk,
  DatabaseBackupServiceError,
  exportDatabaseBackup,
  finalizeDatabaseRestore,
  isDatabaseRestoreInProgress,
  readDatabaseRestoreInitiator,
  startDatabaseRestore,
} from './database-backup';
import {
  applyNextStudioSchemaUpgrade,
  inspectStudioSchemaUpgrade,
  SchemaUpgradeArtifactError,
  SchemaUpgradeServiceError,
  readStudioSchemaUpgradeInitiator,
  startStudioSchemaUpgrade,
} from '../system/schema-upgrade-runner';
import {
  readEdgeIntegrationSettings,
  readEdgeIntegrationModeFailClosed,
  updateEdgeIntegrationSettings,
} from '../settings/edge-services-repository';
import {
  edgeDatabaseAdoptRequestSchema,
  edgeDatabaseInstallRequestSchema,
  edgeDatabaseUninstallPreviewSuccessSchema,
  edgeDatabaseUninstallRequestSchema,
  edgeDatabaseUninstallSuccessSchema,
  edgeDatabaseUpgradeStartRequestSchema,
  edgeDatabaseUpgradeStepRequestSchema,
  type EdgeDatabaseUninstallRequest,
  type EdgeDatabaseStatus,
  type EdgeDatabaseMutationResponse,
} from '../../../contracts/edge-database-lifecycle';
import type { ApiErrorCode } from '../../../contracts/api';
import {
  edgeTargetOrphanListRequestSchema,
  edgeTargetOrphanListSuccessSchema,
  edgeTargetOrphanPurgeRequestSchema,
  edgeTargetReconciliationCancelRequestSchema,
  edgeTargetReconciliationFinalizeRequestSchema,
  edgeTargetReconciliationStartRequestSchema,
  edgeTargetReconciliationStepRequestSchema,
  type EdgeTargetReconciliationMutationResponse,
} from '../../../contracts/edge-target-reconciliation';
import {
  adoptEdgeDatabase,
  applyNextEdgeDatabaseUpgrade,
  EdgeDatabaseLifecycleError,
  inspectEdgeDatabaseLifecycle,
  inspectEdgeDatabaseUninstall,
  installEdgeDatabase,
  readEdgeDatabaseUpgradeInitiator,
  startEdgeDatabaseUpgrade,
  uninstallEdgeDatabase,
} from '../edge-database/lifecycle';
import {
  applyEdgeTargetReconciliationStep,
  cancelEdgeTargetReconciliation,
  EdgeTargetReconciliationError,
  finalizeEdgeTargetReconciliation,
  inspectEdgeTargetReconciliation,
  isEdgeTargetReconciliationInProgress,
  listEdgeTargetOrphans,
  purgeEdgeTargetOrphans,
  readEdgeTargetReconciliationInitiator,
  startEdgeTargetReconciliation,
} from '../comments/target-reconciliation';
import {
  edgeHealthFailure,
  inspectEdgeIntegration,
} from '../settings/edge-integration-health';
import {
  edgeIntegrationActivationError,
  materializeEdgeServicesDocument,
} from '../settings/edge-services-service';
import {
  contentSearchIndexRebuildStartRequestSchema,
  contentSearchIndexRebuildStepRequestSchema,
  type ContentSearchIndexRebuildMutationResponse,
} from '../../../contracts/content-search-index';
import {
  applyContentSearchIndexRebuildStep,
  ContentSearchRebuildError,
  inspectContentSearchIndex,
  isContentSearchIndexRebuildInProgress,
  readContentSearchRebuildInitiator,
  startContentSearchIndexRebuild,
  unavailableContentSearchIndexStatus,
} from '../content-search/rebuild';
import {
  CLOUDFLARE_ACCESS_RECOVERY_CONFIRMATION,
  cloudflareAccessSettingsSuccessSchema,
  cloudflareAccessRecoveryRequestSchema,
  cloudflareAccessRecoverySuccessSchema,
  updateCloudflareAccessSettingsRequestSchema,
  type CloudflareAccessRequirement,
  type CloudflareAccessRecoveryStatus,
} from '../../../contracts/cloudflare-access';
import {
  DISABLED_CLOUDFLARE_ACCESS_REQUIREMENT,
  readCloudflareAccessSettings,
  recoverCloudflareAccessDisabled,
  updateCloudflareAccessSettings,
} from '../access/settings-repository';
import {
  materializeCloudflareAccessSettingsDocument,
  verifyCurrentCloudflareAccessRequest,
} from '../access/settings-document';
import {
  verifyCloudflareAccessAssertion,
  type VerifyCloudflareAccessAssertion,
} from '../access/assertion-verifier';

type ReadyOperationsConfiguration = Extract<
  OperationsConfiguration,
  { state: 'ready' }
>;

type AuthorizedOperationsRequest = {
  configuration: ReadyOperationsConfiguration;
  clientIp: string;
  operationalSession: ResolvedSession | null;
};

function authorizedAdministratorInitiator(input: {
  administratorId: string;
  administratorEmail: string;
}): OperationsInitiator {
  return {
    userId: input.administratorId,
    userEmail: input.administratorEmail,
  };
}

function attributeOperationalError(
  error: StudioOperationalError,
  initiator: OperationsInitiator | null,
): StudioOperationalError {
  return new StudioOperationalError(error.code, {
    cause: error.originalCause,
    metadata: {
      ...error.operationalMetadata,
      ...operationsInitiatorMetadata(initiator),
    },
  });
}

export type OperationsAdministratorAuthorizer = (
  input: Parameters<typeof authorizeOperationsAdministrator>[0],
) => Promise<OperationsAdministratorAuthorization>;

export type ClearSiteContent = typeof clearSiteContentWithEdge;
export type ClearStudioContent = typeof clearSiteContentWithoutEdge;
export type InspectUninstallStudio = typeof inspectUninstallStudio;
export type ResetStudio = typeof resetStudioWithEdge;
export type ResetStudioDatabase = typeof resetStudioWithoutEdge;
export type UninstallStudioDatabase = typeof uninstallStudioDatabase;
export type ListRecoverableAdministrators =
  typeof listRecoverableAdministrators;
export type RecoverAdministratorAccess = typeof recoverAdministratorAccess;
export type BootstrapRecoveryAdministrator =
  typeof bootstrapRecoveryAdministrator;
export type InspectRecoveryAdministratorBootstrapAvailability =
  typeof inspectRecoveryAdministratorBootstrapAvailability;
export type RecoveryPasswordHasher = typeof hashPassword;
export type ExportDatabaseBackup = typeof exportDatabaseBackup;
export type StartDatabaseRestore = typeof startDatabaseRestore;
export type ApplyDatabaseRestoreChunk = typeof applyDatabaseRestoreChunk;
export type FinalizeDatabaseRestore = typeof finalizeDatabaseRestore;
export type InspectSchemaUpgrade = typeof inspectStudioSchemaUpgrade;
export type StartSchemaUpgrade = typeof startStudioSchemaUpgrade;
export type ApplySchemaUpgradeStep = typeof applyNextStudioSchemaUpgrade;

export type OperationsDependencies = {
  resolveSession?: ResolveUserSession;
  authorizeAdministrator?: OperationsAdministratorAuthorizer;
  clearSiteContent?: ClearSiteContent;
  clearStudioContent?: ClearStudioContent;
  inspectUninstallStudio?: InspectUninstallStudio;
  resetStudio?: ResetStudio;
  resetStudioDatabase?: ResetStudioDatabase;
  uninstallStudioDatabase?: UninstallStudioDatabase;
  listRecoverableAdministrators?: ListRecoverableAdministrators;
  recoverAdministratorAccess?: RecoverAdministratorAccess;
  bootstrapRecoveryAdministrator?: BootstrapRecoveryAdministrator;
  inspectRecoveryAdministratorBootstrapAvailability?:
    InspectRecoveryAdministratorBootstrapAvailability;
  hashRecoveryPassword?: RecoveryPasswordHasher;
  exportDatabaseBackup?: ExportDatabaseBackup;
  startDatabaseRestore?: StartDatabaseRestore;
  applyDatabaseRestoreChunk?: ApplyDatabaseRestoreChunk;
  finalizeDatabaseRestore?: FinalizeDatabaseRestore;
  readDatabaseRestoreInitiator?: typeof readDatabaseRestoreInitiator;
  inspectSchemaUpgrade?: InspectSchemaUpgrade;
  startSchemaUpgrade?: StartSchemaUpgrade;
  applySchemaUpgradeStep?: ApplySchemaUpgradeStep;
  readSchemaUpgradeInitiator?: typeof readStudioSchemaUpgradeInitiator;
  managedMediaStorageEnabled?: boolean;
  readEdgeIntegrationMode?: typeof readEdgeIntegrationModeFailClosed;
  inspectEdgeDatabase?: typeof inspectEdgeDatabaseLifecycle;
  installEdgeDatabase?: typeof installEdgeDatabase;
  adoptEdgeDatabase?: typeof adoptEdgeDatabase;
  startEdgeDatabaseUpgrade?: typeof startEdgeDatabaseUpgrade;
  applyEdgeDatabaseUpgrade?: typeof applyNextEdgeDatabaseUpgrade;
  readEdgeDatabaseUpgradeInitiator?: typeof readEdgeDatabaseUpgradeInitiator;
  inspectEdgeReconciliation?: typeof inspectEdgeTargetReconciliation;
  startEdgeReconciliation?: typeof startEdgeTargetReconciliation;
  applyEdgeReconciliationStep?: typeof applyEdgeTargetReconciliationStep;
  listEdgeOrphans?: typeof listEdgeTargetOrphans;
  purgeEdgeOrphans?: typeof purgeEdgeTargetOrphans;
  finalizeEdgeReconciliation?: typeof finalizeEdgeTargetReconciliation;
  cancelEdgeReconciliation?: typeof cancelEdgeTargetReconciliation;
  readEdgeReconciliationInitiator?: typeof readEdgeTargetReconciliationInitiator;
  materializeEdgeServices?: typeof materializeEdgeServicesDocument;
  inspectEdgeIntegration?: typeof inspectEdgeIntegration;
  updateEdgeIntegration?: typeof updateEdgeIntegrationSettings;
  inspectEdgeUninstall?: typeof inspectEdgeDatabaseUninstall;
  uninstallEdgeDatabase?: typeof uninstallEdgeDatabase;
  inspectContentSearchIndex?: typeof inspectContentSearchIndex;
  startContentSearchIndexRebuild?: typeof startContentSearchIndexRebuild;
  applyContentSearchIndexRebuildStep?:
    typeof applyContentSearchIndexRebuildStep;
  readContentSearchRebuildInitiator?:
    typeof readContentSearchRebuildInitiator;
  readCloudflareAccessSettings?: typeof readCloudflareAccessSettings;
  updateCloudflareAccessSettings?: typeof updateCloudflareAccessSettings;
  verifyCloudflareAccessAssertion?: VerifyCloudflareAccessAssertion;
  now?: () => Date;
  createSettingsRevision?: () => string;
  recoverCloudflareAccessDisabled?: typeof recoverCloudflareAccessDisabled;
};

async function rejectOperationsAuthenticationAttempt(
  c: Context<StudioHonoEnvironment>,
  clientIp: string,
): Promise<Response> {
  let rateLimit: { success: boolean };
  try {
    rateLimit = await c.env.AUTH_ROUTE_RATE_LIMITER.limit({
      key: `operations:${clientIp}`,
    });
  } catch (error) {
    throw new StudioOperationalError(
      'OPERATIONS_AUTH_RATE_LIMITER_NOT_AVAILABLE',
      {
        cause: error,
        metadata: {
          resource: 'AUTH_ROUTE_RATE_LIMITER',
          action: 'limit_operations_authentication_attempt',
        },
      },
    );
  }
  if (!rateLimit.success) {
    c.header('Retry-After', '60');
    return errorResponse(c, 429, 'RATE_LIMIT_EXCEEDED');
  }
  return errorResponse(c, 401, 'INVALID_OPERATIONS_TOKEN');
}

async function authorizeOperationsBoundary(
  c: Context<StudioHonoEnvironment>,
  resolveSession?: ResolveUserSession,
): Promise<
  | { authorized: true; access: AuthorizedOperationsRequest }
  | { authorized: false; response: Response }
> {
  const configuration = resolveOperationsConfiguration(c.env);
  synchronizeOperationsConfigurationIncident(configuration);
  const boundary = resolveOperationsRequestBoundary(c.req.raw, configuration);

  if (boundary.state === 'not_found') {
    return {
      authorized: false,
      response: errorResponse(c, 404, 'NOT_FOUND'),
    };
  }
  if (boundary.state === 'setup_required') {
    return {
      authorized: false,
      response: boundary.setup.allowed_ips === 'missing'
        ? errorResponse(c, 404, 'NOT_FOUND')
        : errorResponse(c, 503, 'OPERATIONS_CONFIGURATION_ERROR'),
    };
  }

  const { clientIp } = boundary;

  const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
  let operationalSession: ResolvedSession | null = null;
  if (siteMode.state === 'valid' && siteMode.mode === 'operational') {
    const session = await requireStudioCapability({
      context: c,
      capability: 'settings.manage',
      resolveSession,
    });
    if (session instanceof Response) {
      return { authorized: false, response: session };
    }
    operationalSession = session;
  }

  const providedToken = readBearerToken(c.req.header('Authorization'));
  if (!providedToken) {
    return {
      authorized: false,
      response: await rejectOperationsAuthenticationAttempt(c, clientIp),
    };
  }

  let tokenMatches: boolean;
  try {
    tokenMatches = await secretTokensMatch(
      providedToken,
      boundary.configuration.token,
    );
  } catch (error) {
    throw new StudioOperationalError(
      'OPERATIONS_TOKEN_VERIFICATION_NOT_AVAILABLE',
      {
        cause: error,
        metadata: {
          component: 'web_crypto',
          action: 'verify_operations_token',
        },
      },
    );
  }
  if (!tokenMatches) {
    return {
      authorized: false,
      response: await rejectOperationsAuthenticationAttempt(c, clientIp),
    };
  }

  // The native limiter protects attempts to discover or guess the out-of-band
  // credential. Once that credential is verified, bounded multi-request
  // protocols such as SQL restore must not consume the authentication-attempt
  // budget for every valid chunk.
  return {
    authorized: true,
    access: { configuration: boundary.configuration, clientIp, operationalSession },
  };
}

function resolvedEnvironment(
  c: Context<StudioHonoEnvironment>,
  access: AuthorizedOperationsRequest,
  databaseState: OperationsStatusData['database']['state'],
): OperationsStatusData['environment'] {
  const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
  const configuredInstallTokenState = resolveStudioWorkerSecretState(
    c.env.STUDIO_INSTALL_TOKEN,
  );
  const installTokenState = databaseState === 'uninstalled'
    ? configuredInstallTokenState
    : configuredInstallTokenState === 'missing'
      ? 'missing'
      : 'must_be_removed';

  return [
    {
      name: 'STUDIO_SITE_MODE',
      exposure: 'value',
      expected_storage:
        STUDIO_WORKER_CONFIGURATION_CATALOG.STUDIO_SITE_MODE.kind,
      configured: c.env.STUDIO_SITE_MODE !== undefined,
      value: siteMode.state === 'valid' ? siteMode.mode : null,
    },
    {
      name: 'STUDIO_OPERATIONS_ALLOWED_IPS',
      exposure: 'value',
      expected_storage:
        STUDIO_WORKER_CONFIGURATION_CATALOG.STUDIO_OPERATIONS_ALLOWED_IPS.kind,
      configured: true,
      value: access.configuration.allowedIps.join(','),
    },
    {
      name: 'STUDIO_INSTALL_TOKEN',
      exposure: 'presence',
      expected_storage:
        STUDIO_WORKER_CONFIGURATION_CATALOG.STUDIO_INSTALL_TOKEN.kind,
      state: installTokenState,
    },
    {
      name: 'STUDIO_OPERATIONS_TOKEN',
      exposure: 'presence',
      expected_storage:
        STUDIO_WORKER_CONFIGURATION_CATALOG.STUDIO_OPERATIONS_TOKEN.kind,
      state: 'valid',
    },
    {
      name: 'STUDIO_AUTH_SECRET',
      exposure: 'presence',
      expected_storage:
        STUDIO_WORKER_CONFIGURATION_CATALOG.STUDIO_AUTH_SECRET.kind,
      state: resolveStudioWorkerSecretState(c.env.STUDIO_AUTH_SECRET),
    },
  ];
}

function operationAvailability(input: {
  siteMode: OperationsStatusData['site_mode'];
  databaseState: OperationsStatusData['database']['state'];
  edgeIntegrationMode: 'enabled' | 'disabled';
  edgeDatabaseState: EdgeDatabaseStatus['state'];
}) {
  const databaseReady = input.databaseState === 'ready';
  const edgeScopeReady = input.edgeIntegrationMode === 'disabled'
    || input.edgeDatabaseState === 'ready';
  const clearAvailable = databaseReady
    && edgeScopeReady
    && (
      input.siteMode === 'operational'
      || input.siteMode === 'maintenance'
    );
  const maintenanceAvailable = databaseReady
    && input.siteMode === 'maintenance';
  const edgeMaintenanceAvailable = maintenanceAvailable
    && edgeScopeReady;

  return {
    clear_site_content: {
      available: clearAvailable,
      requires_maintenance: false,
      confirmation: operationsConfirmation.clear_site_content,
    },
    reset_studio: {
      available: edgeMaintenanceAvailable,
      requires_maintenance: true,
      confirmation: operationsConfirmation.reset_studio,
    },
    uninstall_studio: {
      available: maintenanceAvailable,
      requires_maintenance: true,
      confirmation: operationsConfirmation.uninstall_studio,
    },
    recover_administrator: {
      available: isAdministratorRecoveryDatabaseCompatible(
        input.databaseState,
      )
        && input.siteMode === 'recovery',
      requires_maintenance: false,
      confirmation: administratorRecoveryConfirmation,
    },
  };
}

function edgeDestructiveOperationError(
  state: EdgeDatabaseStatus['state'],
): { status: 409 | 503; code: ApiErrorCode } | null {
  switch (state) {
    case 'ready':
      return null;
    case 'uninstalled':
      return { status: 409, code: 'EDGE_DATABASE_INSTALL_REQUIRED' };
    case 'adoption_required':
      return { status: 409, code: 'EDGE_DATABASE_ADOPTION_REQUIRED' };
    case 'upgrade_required':
    case 'in_progress':
      return { status: 409, code: 'EDGE_DATABASE_UPGRADE_REQUIRED' };
    case 'unavailable':
      return { status: 503, code: 'EDGE_INTEGRATION_UNAVAILABLE' };
    case 'recovery_required':
    case 'unmanaged':
    case 'newer_than_code':
      return { status: 409, code: 'EDGE_DATABASE_RECOVERY_REQUIRED' };
  }
}

function isAdministratorRecoveryDatabaseCompatible(
  state: OperationsStatusData['database']['state'],
): boolean {
  return state === 'ready' || state === 'upgrade_required';
}

function databaseTransferAvailability(input: {
  siteMode: OperationsStatusData['site_mode'];
  databaseState: OperationsStatusData['database']['state'];
  edgeDatabaseBound: boolean;
  studioRestoreInProgress?: boolean;
  edgeDatabaseReadable?: boolean;
}): OperationsStatusData['database_transfer'] {
  const maintenance = input.siteMode === 'maintenance';
  const maintenanceReady = input.siteMode === 'maintenance'
    && input.databaseState === 'ready';
  const maintenanceExportable = maintenance
    && (
      input.databaseState === 'ready'
      || input.databaseState === 'upgrade_required'
    );
  const recovery = input.siteMode === 'recovery';
  const studioReadable = input.databaseState !== 'uninstalled'
    && input.databaseState !== 'unavailable';
  const exportBoundaryAvailable = maintenanceExportable || recovery;
  const restoreBoundaryAvailable = maintenanceReady || recovery;
  const studioRestoreInProgress = input.studioRestoreInProgress === true;
  const operationalEdgeExportable = input.siteMode === 'operational'
    && input.databaseState === 'ready'
    && input.edgeDatabaseBound
    && input.edgeDatabaseReadable !== false;

  return {
    requires_administrator_credentials:
      (maintenanceExportable || operationalEdgeExportable)
      && !studioRestoreInProgress,
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
        export_available:
          exportBoundaryAvailable
          && studioReadable
          && !studioRestoreInProgress,
        restore_available:
          restoreBoundaryAvailable || studioRestoreInProgress,
      },
      edge: {
        bound: input.edgeDatabaseBound,
        export_available:
          (
            exportBoundaryAvailable
            || operationalEdgeExportable
          )
          && input.edgeDatabaseBound
          && input.edgeDatabaseReadable !== false,
        restore_available:
          restoreBoundaryAvailable && input.edgeDatabaseBound,
      },
    },
  };
}

async function authorizeOperationPayload(
  c: Context<StudioHonoEnvironment>,
  action: OperationsAction,
  authorizeAdministrator: OperationsAdministratorAuthorizer,
): Promise<
  | {
      authorized: true;
      administratorId: string;
      administratorEmail: string;
    }
  | { authorized: false; response: Response }
> {
  const contentType = c.req
    .header('Content-Type')
    ?.split(';')[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    return {
      authorized: false,
      response: errorResponse(c, 415, 'UNSUPPORTED_MEDIA_TYPE'),
    };
  }

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return {
      authorized: false,
      response: errorResponse(c, 400, 'INVALID_JSON'),
    };
  }

  const parsedBody = operationsRequestSchema.safeParse(rawBody);
  if (!parsedBody.success) {
    return {
      authorized: false,
      response: errorResponse(c, 400, 'VALIDATION_ERROR'),
    };
  }
  if (parsedBody.data.confirmation !== operationsConfirmation[action]) {
    return {
      authorized: false,
      response: errorResponse(
        c,
        400,
        'OPERATIONS_CONFIRMATION_MISMATCH',
      ),
    };
  }

  const administrator = await authorizeAdministrator({
    db: c.env.DB,
    email: parsedBody.data.administrator_email,
    password: parsedBody.data.administrator_password,
  });
  if (!administrator.authorized) {
    return {
      authorized: false,
      response: errorResponse(
        c,
        401,
        'INVALID_OPERATIONS_CREDENTIALS',
      ),
    };
  }

  return {
    authorized: true,
    administratorId: administrator.administratorId,
    administratorEmail: administrator.administratorEmail,
  };
}

async function authorizeAdministratorCredentials(
  c: Context<StudioHonoEnvironment>,
  request: {
    administrator_email: string;
    administrator_password: string;
  },
  authorizeAdministrator: OperationsAdministratorAuthorizer,
): Promise<
  | {
      authorized: true;
      administratorId: string;
      administratorEmail: string;
    }
  | { authorized: false; response: Response }
> {
  const administrator = await authorizeAdministrator({
    db: c.env.DB,
    email: request.administrator_email,
    password: request.administrator_password,
  });
  return administrator.authorized
    ? {
        authorized: true,
        administratorId: administrator.administratorId,
        administratorEmail: administrator.administratorEmail,
      }
    : {
        authorized: false,
        response: errorResponse(c, 401, 'INVALID_OPERATIONS_CREDENTIALS'),
      };
}

async function authorizeDatabaseTransferCredentials(
  c: Context<StudioHonoEnvironment>,
  siteMode: 'operational' | 'maintenance' | 'recovery',
  request: Pick<
    DatabaseBackupRequest,
    'administrator_email' | 'administrator_password'
  >,
  authorizeAdministrator: OperationsAdministratorAuthorizer,
): Promise<
  | { authorized: true; initiator: OperationsInitiator | null }
  | { authorized: false; response: Response }
> {
  if (siteMode === 'recovery') {
    // Recovery deliberately relies on the out-of-band operations token and
    // exact-IP boundary. The Studio schema or administrator credentials may
    // be the resource being recovered, so no account query is attempted.
    return { authorized: true, initiator: null };
  }
  if (
    request.administrator_email === undefined
    || request.administrator_password === undefined
  ) {
    return {
      authorized: false,
      response: errorResponse(c, 400, 'VALIDATION_ERROR'),
    };
  }
  const administrator = await authorizeAdministrator({
    db: c.env.DB,
    email: request.administrator_email,
    password: request.administrator_password,
  });
  return administrator.authorized
    ? {
        authorized: true,
        initiator: {
          userId: administrator.administratorId,
          userEmail: administrator.administratorEmail,
        },
      }
    : {
        authorized: false,
        response: errorResponse(c, 401, 'INVALID_OPERATIONS_CREDENTIALS'),
      };
}

function databaseForTarget(
  c: Context<StudioHonoEnvironment>,
  database: DatabaseBackupTarget,
): D1Database | null {
  return database === 'studio' ? c.env.DB : c.env.EDGE_DB ?? null;
}

function transferErrorResponse(
  c: Context<StudioHonoEnvironment>,
  error: DatabaseBackupArtifactError | DatabaseBackupServiceError,
): Response {
  if (error instanceof DatabaseBackupArtifactError) {
    return errorResponse(
      c,
      error.issue === 'limit_exceeded' ? 413 : 400,
      error.issue === 'limit_exceeded'
        ? 'DATABASE_RESTORE_LIMIT_EXCEEDED'
        : 'DATABASE_BACKUP_ARTIFACT_INVALID',
    );
  }
  switch (error.issue) {
    case 'not_available':
      return errorResponse(c, 409, 'DATABASE_BACKUP_NOT_AVAILABLE');
    case 'target_mismatch':
      return errorResponse(c, 409, 'DATABASE_BACKUP_TARGET_MISMATCH');
    case 'schema_mismatch':
      return errorResponse(c, 409, 'DATABASE_BACKUP_SCHEMA_MISMATCH');
    case 'state_conflict':
      return errorResponse(c, 409, 'DATABASE_RESTORE_STATE_CONFLICT');
    case 'unsupported_restore_mode':
      return errorResponse(c, 400, 'DATABASE_RESTORE_UNSUPPORTED_MODE');
    case 'limit_exceeded':
      return errorResponse(c, 413, 'DATABASE_RESTORE_LIMIT_EXCEEDED');
  }
}

async function readOperationsJsonBody(
  c: Context<StudioHonoEnvironment>,
): Promise<{ valid: true; value: unknown } | { valid: false; response: Response }> {
  if (c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase()
    !== 'application/json') {
    return {
      valid: false,
      response: errorResponse(c, 415, 'UNSUPPORTED_MEDIA_TYPE'),
    };
  }
  try {
    return { valid: true, value: await c.req.json() };
  } catch {
    return {
      valid: false,
      response: errorResponse(c, 400, 'INVALID_JSON'),
    };
  }
}

function requireMaintenanceMode(
  c: Context<StudioHonoEnvironment>,
): Response | null {
  const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
  return siteMode.state === 'valid' && siteMode.mode === 'maintenance'
    ? null
    : errorResponse(c, 409, 'OPERATIONS_MAINTENANCE_REQUIRED');
}

function requireEdgeUpgradeMode(
  c: Context<StudioHonoEnvironment>,
): Response | null {
  const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
  return siteMode.state === 'valid'
      && (siteMode.mode === 'operational' || siteMode.mode === 'maintenance')
    ? null
    : errorResponse(c, 409, 'EDGE_DATABASE_UPGRADE_NOT_AVAILABLE');
}

function requireMaintenanceOrRecoveryMode(
  c: Context<StudioHonoEnvironment>,
): Response | null {
  const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
  return siteMode.state === 'valid'
      && (siteMode.mode === 'maintenance' || siteMode.mode === 'recovery')
    ? null
    : errorResponse(c, 409, 'OPERATIONS_MAINTENANCE_REQUIRED');
}

async function authorizeEdgeLifecycleAdministrator(
  c: Context<StudioHonoEnvironment>,
  credentials: {
    administrator_email: string;
    administrator_password: string;
  },
  authorizeAdministrator: OperationsAdministratorAuthorizer,
): Promise<
  | { authorized: true; initiator: OperationsInitiator }
  | { authorized: false; response: Response }
> {
  const result = await authorizeAdministrator({
    db: c.env.DB,
    email: credentials.administrator_email,
    password: credentials.administrator_password,
  });
  return result.authorized
    ? {
        authorized: true,
        initiator: {
          userId: result.administratorId,
          userEmail: result.administratorEmail,
        },
      }
    : {
        authorized: false,
        response: errorResponse(c, 401, 'INVALID_OPERATIONS_CREDENTIALS'),
      };
}

function edgeLifecycleErrorResponse(
  c: Context<StudioHonoEnvironment>,
  error: EdgeDatabaseLifecycleError,
  unavailableCode:
    | 'EDGE_DATABASE_INSTALL_NOT_AVAILABLE'
    | 'EDGE_DATABASE_ADOPTION_NOT_AVAILABLE'
    | 'EDGE_DATABASE_UPGRADE_NOT_AVAILABLE'
    | 'EDGE_DATABASE_UNINSTALL_NOT_AVAILABLE',
): Response {
  return errorResponse(
    c,
    409,
    error.issue === 'state_conflict'
      ? 'EDGE_DATABASE_STATE_CONFLICT'
      : unavailableCode,
  );
}

function edgeReconciliationErrorResponse(
  c: Context<StudioHonoEnvironment>,
  error: EdgeTargetReconciliationError,
): Response {
  return errorResponse(
    c,
    409,
    error.issue === 'state_conflict'
      ? 'EDGE_TARGET_RECONCILIATION_STATE_CONFLICT'
      : 'EDGE_TARGET_RECONCILIATION_NOT_AVAILABLE',
  );
}

function contentSearchRebuildErrorResponse(
  c: Context<StudioHonoEnvironment>,
  error: ContentSearchRebuildError,
): Response {
  return errorResponse(
    c,
    409,
    error.issue === 'state_conflict'
      ? 'CONTENT_SEARCH_INDEX_REBUILD_STATE_CONFLICT'
      : 'CONTENT_SEARCH_INDEX_REBUILD_NOT_AVAILABLE',
  );
}

export function createOperationsRoutes(
  dependencies: OperationsDependencies = {},
) {
  const operations = new Hono<StudioHonoEnvironment>();
  const authorizeOperationsRequest = (
    c: Context<StudioHonoEnvironment>,
  ) => authorizeOperationsBoundary(c, dependencies.resolveSession);
  const authorizeAdministrator = dependencies.authorizeAdministrator
    ?? authorizeOperationsAdministrator;
  const executeClearSiteContent = dependencies.clearSiteContent
    ?? clearSiteContentWithEdge;
  const executeClearStudioContent = dependencies.clearStudioContent
    ?? clearSiteContentWithoutEdge;
  const executeInspectUninstallStudio = dependencies.inspectUninstallStudio
    ?? inspectUninstallStudio;
  const executeResetStudio = dependencies.resetStudio ?? resetStudioWithEdge;
  const executeResetStudioDatabase = dependencies.resetStudioDatabase
    ?? resetStudioWithoutEdge;
  const executeUninstallStudio = dependencies.uninstallStudioDatabase
    ?? uninstallStudioDatabase;
  const executeListRecoverableAdministrators =
    dependencies.listRecoverableAdministrators
    ?? listRecoverableAdministrators;
  const executeRecoverAdministratorAccess =
    dependencies.recoverAdministratorAccess
    ?? recoverAdministratorAccess;
  const executeBootstrapRecoveryAdministrator =
    dependencies.bootstrapRecoveryAdministrator
    ?? bootstrapRecoveryAdministrator;
  const executeInspectRecoveryAdministratorBootstrapAvailability =
    dependencies.inspectRecoveryAdministratorBootstrapAvailability
    ?? inspectRecoveryAdministratorBootstrapAvailability;
  const hashRecoveryPassword = dependencies.hashRecoveryPassword
    ?? hashPassword;
  const executeExportDatabaseBackup = dependencies.exportDatabaseBackup
    ?? exportDatabaseBackup;
  const executeStartDatabaseRestore = dependencies.startDatabaseRestore
    ?? startDatabaseRestore;
  const executeApplyDatabaseRestoreChunk =
    dependencies.applyDatabaseRestoreChunk ?? applyDatabaseRestoreChunk;
  const executeFinalizeDatabaseRestore = dependencies.finalizeDatabaseRestore
    ?? finalizeDatabaseRestore;
  const executeReadDatabaseRestoreInitiator =
    dependencies.readDatabaseRestoreInitiator ?? readDatabaseRestoreInitiator;
  const executeInspectSchemaUpgrade = dependencies.inspectSchemaUpgrade
    ?? inspectStudioSchemaUpgrade;
  const executeStartSchemaUpgrade = dependencies.startSchemaUpgrade
    ?? startStudioSchemaUpgrade;
  const executeApplySchemaUpgradeStep = dependencies.applySchemaUpgradeStep
    ?? applyNextStudioSchemaUpgrade;
  const executeReadSchemaUpgradeInitiator =
    dependencies.readSchemaUpgradeInitiator ?? readStudioSchemaUpgradeInitiator;
  const readEdgeIntegrationMode = dependencies.readEdgeIntegrationMode
    ?? readEdgeIntegrationModeFailClosed;
  const inspectEdgeDatabase = dependencies.inspectEdgeDatabase
    ?? inspectEdgeDatabaseLifecycle;
  const executeInstallEdgeDatabase = dependencies.installEdgeDatabase
    ?? installEdgeDatabase;
  const executeAdoptEdgeDatabase = dependencies.adoptEdgeDatabase
    ?? adoptEdgeDatabase;
  const executeStartEdgeDatabaseUpgrade = dependencies.startEdgeDatabaseUpgrade
    ?? startEdgeDatabaseUpgrade;
  const executeApplyEdgeDatabaseUpgrade = dependencies.applyEdgeDatabaseUpgrade
    ?? applyNextEdgeDatabaseUpgrade;
  const executeReadEdgeDatabaseUpgradeInitiator =
    dependencies.readEdgeDatabaseUpgradeInitiator
    ?? readEdgeDatabaseUpgradeInitiator;
  const inspectEdgeReconciliation = dependencies.inspectEdgeReconciliation
    ?? inspectEdgeTargetReconciliation;
  const executeStartEdgeReconciliation = dependencies.startEdgeReconciliation
    ?? startEdgeTargetReconciliation;
  const executeApplyEdgeReconciliationStep =
    dependencies.applyEdgeReconciliationStep
    ?? applyEdgeTargetReconciliationStep;
  const executeListEdgeOrphans = dependencies.listEdgeOrphans
    ?? listEdgeTargetOrphans;
  const executePurgeEdgeOrphans = dependencies.purgeEdgeOrphans
    ?? purgeEdgeTargetOrphans;
  const executeFinalizeEdgeReconciliation =
    dependencies.finalizeEdgeReconciliation
    ?? finalizeEdgeTargetReconciliation;
  const executeCancelEdgeReconciliation = dependencies.cancelEdgeReconciliation
    ?? cancelEdgeTargetReconciliation;
  const executeReadEdgeReconciliationInitiator =
    dependencies.readEdgeReconciliationInitiator
    ?? readEdgeTargetReconciliationInitiator;
  const materializeEdgeServices = dependencies.materializeEdgeServices
    ?? materializeEdgeServicesDocument;
  const executeInspectEdgeIntegration = dependencies.inspectEdgeIntegration
    ?? inspectEdgeIntegration;
  const executeUpdateEdgeIntegration = dependencies.updateEdgeIntegration
    ?? updateEdgeIntegrationSettings;
  const executeInspectEdgeUninstall = dependencies.inspectEdgeUninstall
    ?? inspectEdgeDatabaseUninstall;
  const executeUninstallEdgeDatabase = dependencies.uninstallEdgeDatabase
    ?? uninstallEdgeDatabase;
  const executeInspectContentSearchIndex =
    dependencies.inspectContentSearchIndex ?? inspectContentSearchIndex;
  const executeStartContentSearchIndexRebuild =
    dependencies.startContentSearchIndexRebuild
    ?? startContentSearchIndexRebuild;
  const executeApplyContentSearchIndexRebuildStep =
    dependencies.applyContentSearchIndexRebuildStep
    ?? applyContentSearchIndexRebuildStep;
  const executeReadContentSearchRebuildInitiator =
    dependencies.readContentSearchRebuildInitiator
    ?? readContentSearchRebuildInitiator;
  const executeReadCloudflareAccessSettings =
    dependencies.readCloudflareAccessSettings ?? readCloudflareAccessSettings;
  const executeUpdateCloudflareAccessSettings =
    dependencies.updateCloudflareAccessSettings
    ?? updateCloudflareAccessSettings;
  const executeVerifyCloudflareAccessAssertion =
    dependencies.verifyCloudflareAccessAssertion
    ?? verifyCloudflareAccessAssertion;
  const currentTime = dependencies.now ?? (() => new Date());
  const executeRecoverCloudflareAccessDisabled =
    dependencies.recoverCloudflareAccessDisabled
    ?? recoverCloudflareAccessDisabled;

  async function authorizeEdgeDatabaseUninstall(
    c: Context<StudioHonoEnvironment>,
  ): Promise<
    | {
        authorized: true;
        request: EdgeDatabaseUninstallRequest;
        edgeDb: D1Database;
        initiator: OperationsInitiator;
      }
    | { authorized: false; response: Response }
  > {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access;
    const boundary = requireMaintenanceMode(c);
    if (boundary) return { authorized: false, response: boundary };
    const systemStatus = await resolveSystemStatus(c.env);
    if (systemStatus.database.state !== 'ready') {
      return {
        authorized: false,
        response: errorResponse(c, 409, 'EDGE_DATABASE_STUDIO_NOT_READY'),
      };
    }
    if (await isEdgeTargetReconciliationInProgress(c.env.DB)) {
      return {
        authorized: false,
        response: errorResponse(
          c,
          409,
          'EDGE_TARGET_RECONCILIATION_STATE_CONFLICT',
        ),
      };
    }
    if (await isContentSearchIndexRebuildInProgress(c.env.DB)) {
      return {
        authorized: false,
        response: errorResponse(
          c,
          409,
          'CONTENT_SEARCH_INDEX_REBUILD_STATE_CONFLICT',
        ),
      };
    }
    const integration = await readEdgeIntegrationSettings({ db: c.env.DB });
    if (integration.settings.mode !== 'disabled') {
      return {
        authorized: false,
        response: errorResponse(
          c,
          409,
          'EDGE_INTEGRATION_MUST_BE_DISABLED',
        ),
      };
    }
    if (!c.env.EDGE_DB) {
      return {
        authorized: false,
        response: errorResponse(
          c,
          409,
          'EDGE_DATABASE_UNINSTALL_NOT_AVAILABLE',
        ),
      };
    }
    const lifecycle = await inspectEdgeDatabase({
      edgeDb: c.env.EDGE_DB,
      siteMode: 'maintenance',
    });
    if (lifecycle.state !== 'ready') {
      return {
        authorized: false,
        response: errorResponse(
          c,
          409,
          'EDGE_DATABASE_UNINSTALL_NOT_AVAILABLE',
        ),
      };
    }
    const contentType = c.req.header('Content-Type')
      ?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return {
        authorized: false,
        response: errorResponse(c, 415, 'UNSUPPORTED_MEDIA_TYPE'),
      };
    }
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return {
        authorized: false,
        response: errorResponse(c, 400, 'INVALID_JSON'),
      };
    }
    const parsed = edgeDatabaseUninstallRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return {
        authorized: false,
        response: errorResponse(c, 400, 'VALIDATION_ERROR'),
      };
    }
    const administrator = await authorizeAdministratorCredentials(
      c,
      parsed.data,
      authorizeAdministrator,
    );
    if (!administrator.authorized) return administrator;
    return {
      authorized: true,
      request: parsed.data,
      edgeDb: c.env.EDGE_DB,
      initiator: {
        userId: administrator.administratorId,
        userEmail: administrator.administratorEmail,
      },
    };
  }

  async function authorizeCloudflareAccessManagement(
    c: Context<StudioHonoEnvironment>,
  ) {
    const authorization = await authorizeOperationsRequest(c);
    if (!authorization.authorized) return authorization;
    const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
    if (
      siteMode.state !== 'valid'
      || siteMode.mode !== 'operational'
      || authorization.access.operationalSession === null
    ) {
      return {
        authorized: false as const,
        response: errorResponse(c, 404, 'NOT_FOUND'),
      };
    }
    return {
      authorized: true as const,
      access: {
        ...authorization.access,
        operationalSession: authorization.access.operationalSession,
      },
    };
  }

  async function verifyCloudflareAccessManagementRequest(
    c: Context<StudioHonoEnvironment>,
    stored: Awaited<ReturnType<typeof readCloudflareAccessSettings>>,
  ) {
    const verification = await verifyCurrentCloudflareAccessRequest({
      context: c,
      stored,
      verifyAssertion: executeVerifyCloudflareAccessAssertion,
      now: currentTime(),
    });
    if (
      stored.settings.mode === 'required'
      && verification.state === 'unavailable'
    ) {
      logStudioOperationalError(new StudioOperationalError(
        'CLOUDFLARE_ACCESS_VERIFICATION_FAILED',
        {
          cause: verification.cause,
          metadata: {
            component: 'cloudflare_access',
            action: 'verify_cloudflare_access_assertion',
          },
        },
      ), {
        method: c.req.method,
        pathname: new URL(c.req.url).pathname,
      });
      return {
        verified: false as const,
        response: errorResponse(
          c,
          503,
          'CLOUDFLARE_ACCESS_VERIFICATION_UNAVAILABLE',
        ),
      };
    }
    if (
      stored.settings.mode === 'required'
      && verification.state !== 'verified'
    ) {
      return {
        verified: false as const,
        response: errorResponse(c, 403, 'CLOUDFLARE_ACCESS_REQUIRED'),
      };
    }
    return { verified: true as const, verification };
  }

  operations.get('/cloudflare-access', async (c) => {
    const authorization = await authorizeCloudflareAccessManagement(c);
    if (!authorization.authorized) return authorization.response;
    const stored = await executeReadCloudflareAccessSettings({ db: c.env.DB });
    const verified = await verifyCloudflareAccessManagementRequest(c, stored);
    if (!verified.verified) return verified.response;
    return c.json(cloudflareAccessSettingsSuccessSchema.parse({
      success: true,
      data: materializeCloudflareAccessSettingsDocument(
        stored,
        verified.verification,
      ),
    }));
  });

  operations.put('/cloudflare-access', bodyLimit({
    maxSize: 4 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const authorization = await authorizeCloudflareAccessManagement(c);
    if (!authorization.authorized) return authorization.response;
    const contentType = c.req.header('Content-Type')
      ?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 415, 'UNSUPPORTED_MEDIA_TYPE');
    }
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return errorResponse(c, 400, 'INVALID_JSON');
    }
    const parsed = updateCloudflareAccessSettingsRequestSchema.safeParse(
      rawBody,
    );
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');

    const stored = await executeReadCloudflareAccessSettings({ db: c.env.DB });
    if (stored.revision !== parsed.data.expected_revision) {
      return errorResponse(c, 409, 'SETTINGS_REVISION_CONFLICT');
    }
    const verified = await verifyCloudflareAccessManagementRequest(c, stored);
    if (!verified.verified) return verified.response;

    const now = currentTime();
    let settings: CloudflareAccessRequirement;
    if (parsed.data.mode === 'required') {
      if (verified.verification.state === 'unavailable') {
        logStudioOperationalError(new StudioOperationalError(
          'CLOUDFLARE_ACCESS_VERIFICATION_FAILED',
          {
            cause: verified.verification.cause,
            metadata: {
              component: 'cloudflare_access',
              action: 'verify_cloudflare_access_assertion',
            },
          },
        ), {
          method: c.req.method,
          pathname: new URL(c.req.url).pathname,
        });
        return errorResponse(
          c,
          503,
          'CLOUDFLARE_ACCESS_VERIFICATION_UNAVAILABLE',
        );
      }
      if (verified.verification.state !== 'verified') {
        return errorResponse(c, 409, 'CLOUDFLARE_ACCESS_NOT_DETECTED');
      }
      settings = {
        mode: 'required',
        issuer: verified.verification.identity.issuer,
        audience: verified.verification.identity.audience,
        bound_origin: new URL(c.req.url).origin,
        verified_at_iso: now.toISOString(),
      };
    } else {
      settings = DISABLED_CLOUDFLARE_ACCESS_REQUIREMENT;
    }
    const updated = await executeUpdateCloudflareAccessSettings({
      db: c.env.DB,
      settings,
      expectedRevision: parsed.data.expected_revision,
      updatedBy: authorization.access.operationalSession.user.id,
      now,
      createRevision: dependencies.createSettingsRevision,
    });
    if (updated.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'SETTINGS_REVISION_CONFLICT');
    }
    return c.json(cloudflareAccessSettingsSuccessSchema.parse({
      success: true,
      data: materializeCloudflareAccessSettingsDocument(
        updated.document,
        verified.verification,
      ),
    }));
  });

  operations.get('/status', async (c) => {
    const authorization = await authorizeOperationsRequest(c);
    if (!authorization.authorized) {
      return authorization.response;
    }

    const systemStatus = await resolveSystemStatus(c.env);
    let studioRestoreInProgress = false;
    if (systemStatus.site_mode === 'maintenance') {
      try {
        studioRestoreInProgress = await isDatabaseRestoreInProgress(c.env.DB);
      } catch (error) {
        if (error instanceof DatabaseBackupServiceError) {
          return transferErrorResponse(c, error);
        }
        throw new StudioOperationalError('DATABASE_RESTORE_FAILED', {
          cause: error,
          metadata: {
            resource: 'DB',
            action: 'inspect_database_restore_journal',
            database: 'studio',
          },
        });
      }
    }
    let databaseUpgrade: Awaited<ReturnType<InspectSchemaUpgrade>>;
    try {
      databaseUpgrade = await executeInspectSchemaUpgrade({
        db: c.env.DB,
        siteMode: systemStatus.site_mode,
        databaseStatus: systemStatus.database,
      });
    } catch (error) {
      throw new StudioOperationalError('DATABASE_UPGRADE_FAILED', {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'inspect_schema_upgrade',
        },
      });
    }
    // Every supported schema in the current epoch owns this revisioned
    // document. Unsupported prior-epoch and uninstalled databases must not be
    // queried and remain fail-closed disabled in the Operations summary.
    let edgeIntegrationDocument: Awaited<
      ReturnType<typeof materializeEdgeServices>
    > | null = null;
    let edgeIntegrationMode: 'enabled' | 'disabled' = 'disabled';
    if (
      systemStatus.database.state === 'ready'
      || systemStatus.database.state === 'upgrade_required'
    ) {
      try {
        edgeIntegrationDocument = await materializeEdgeServices({
          env: c.env,
          requestContext: {
            method: c.req.method,
            pathname: new URL(c.req.url).pathname,
          },
        });
        edgeIntegrationMode = edgeIntegrationDocument.settings.mode;
      } catch (error) {
        if (error instanceof StudioOperationalError) {
          logStudioOperationalError(error, {
            method: c.req.method,
            pathname: new URL(c.req.url).pathname,
          });
        }
        edgeIntegrationMode = await readEdgeIntegrationMode({ db: c.env.DB });
      }
    }
    const inspectedEdgeDatabase = await inspectEdgeDatabase({
      edgeDb: c.env.EDGE_DB,
      siteMode: systemStatus.site_mode,
    });
    // Edge lifecycle mutations require active-administrator re-verification.
    // An uninstalled or non-ready Studio database cannot provide that
    // boundary, even when the Edge D1 itself is empty and otherwise
    // installable. Keep the status contract aligned with the mutation gate so
    // the client never offers an action that the API must reject.
    const edgeDatabase = systemStatus.database.state === 'ready'
      ? inspectedEdgeDatabase
      : {
          ...inspectedEdgeDatabase,
          install_available: false,
          adopt_available: false,
          upgrade_available: false,
        };
    const edgeTargetReconciliation =
      systemStatus.database.state === 'ready'
      && edgeDatabase.state === 'ready'
        ? await inspectEdgeReconciliation({
            db: c.env.DB,
            edgeDb: c.env.EDGE_DB,
            available: systemStatus.site_mode === 'maintenance',
          })
        : {
            state: 'unavailable' as const,
            operation_id: null,
            phase: null,
            processed_posts: 0,
            processed_pages: 0,
            scanned_edge_targets: 0,
            orphan_targets: 0,
            orphan_comments: 0,
            available: false,
          };
    let contentSearchIndex = unavailableContentSearchIndexStatus;
    if (systemStatus.database.state === 'ready') {
      try {
        contentSearchIndex = await executeInspectContentSearchIndex({
          db: c.env.DB,
          available:
            systemStatus.site_mode === 'maintenance'
            || systemStatus.site_mode === 'recovery',
        });
      } catch (error) {
        const operationalError = error instanceof StudioOperationalError
          ? error
          : new StudioOperationalError(
              'CONTENT_SEARCH_INDEX_STATE_QUERY_FAILED',
              {
                cause: error,
                metadata: {
                  resource: 'DB',
                  action: 'inspect_content_search_index',
                },
              },
            );
        logStudioOperationalError(operationalError, {
          method: c.req.method,
          pathname: new URL(c.req.url).pathname,
        });
      }
    }
    let cloudflareAccessState: CloudflareAccessRecoveryStatus['state'] =
      'unavailable';
    if (isAdministratorRecoveryDatabaseCompatible(
      systemStatus.database.state,
    )) {
      try {
        const accessSettings = await executeReadCloudflareAccessSettings({
          db: c.env.DB,
        });
        cloudflareAccessState = accessSettings.settings.mode;
      } catch (error) {
        if (error instanceof StudioOperationalError) {
          logStudioOperationalError(error, {
            method: c.req.method,
            pathname: new URL(c.req.url).pathname,
          });
        }
      }
    }
    const cloudflareAccess: CloudflareAccessRecoveryStatus = {
      state: cloudflareAccessState,
      disable_available:
        systemStatus.site_mode === 'recovery'
        && isAdministratorRecoveryDatabaseCompatible(
          systemStatus.database.state,
        )
        && cloudflareAccessState !== 'disabled',
      confirmation: CLOUDFLARE_ACCESS_RECOVERY_CONFIRMATION,
    };
    const response: { success: true; data: OperationsStatusData } = {
      success: true,
      data: {
        site_mode: systemStatus.site_mode,
        database: systemStatus.database,
        current_ip: authorization.access.clientIp,
        allowed_ips: authorization.access.configuration.allowedIps,
        environment: resolvedEnvironment(
          c,
          authorization.access,
          systemStatus.database.state,
        ),
        bindings: {
          DB: { bound: true },
          EDGE_DB: { bound: Boolean(c.env.EDGE_DB) },
          EDGE_KV: { bound: Boolean(c.env.EDGE_KV) },
          MEDIA_BUCKET: { bound: Boolean(c.env.MEDIA_BUCKET) },
          KV: { bound: true },
          AUTH_ROUTE_RATE_LIMITER: { bound: true },
        },
        actions: operationAvailability({
          siteMode: systemStatus.site_mode,
          databaseState: systemStatus.database.state,
          edgeIntegrationMode,
          edgeDatabaseState: edgeDatabase.state,
        }),
        database_transfer: databaseTransferAvailability({
          siteMode: systemStatus.site_mode,
          databaseState: systemStatus.database.state,
          edgeDatabaseBound: Boolean(c.env.EDGE_DB),
          studioRestoreInProgress,
          edgeDatabaseReadable:
            edgeDatabase.state !== 'uninstalled'
            && edgeDatabase.state !== 'unavailable',
        }),
        database_upgrade: databaseUpgrade,
        edge_integration: {
          mode: edgeIntegrationMode,
          document: edgeIntegrationDocument,
          change_available:
            edgeIntegrationDocument !== null
            && (
              systemStatus.site_mode === 'operational'
              || systemStatus.site_mode === 'maintenance'
            )
            && edgeTargetReconciliation.state !== 'in_progress'
            && edgeTargetReconciliation.state !== 'orphan_review',
        },
        edge_database: edgeDatabase,
        edge_target_reconciliation: edgeTargetReconciliation,
        content_search_index: contentSearchIndex,
        cloudflare_access: cloudflareAccess,
      },
    };
    return c.json(response);
  });

  operations.post('/edge-integration', bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
    if (
      siteMode.state === 'invalid'
      || (
        siteMode.mode !== 'operational'
        && siteMode.mode !== 'maintenance'
      )
    ) return errorResponse(c, 409, 'SYSTEM_NOT_AVAILABLE');
    const systemStatus = await resolveSystemStatus(c.env, siteMode);
    if (systemStatus.database.state !== 'ready') {
      return errorResponse(c, 409, 'SYSTEM_NOT_AVAILABLE');
    }
    if (await isEdgeTargetReconciliationInProgress(c.env.DB)) {
      return errorResponse(
        c,
        409,
        'EDGE_TARGET_RECONCILIATION_STATE_CONFLICT',
      );
    }

    const contentType = c.req.header('Content-Type')
      ?.split(';')[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 415, 'UNSUPPORTED_MEDIA_TYPE');
    }
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return errorResponse(c, 400, 'INVALID_JSON');
    }
    const parsed = operationsEdgeIntegrationUpdateRequestSchema.safeParse(
      rawBody,
    );
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const administrator = await authorizeAdministratorCredentials(
      c,
      parsed.data,
      authorizeAdministrator,
    );
    if (!administrator.authorized) return administrator.response;
    const initiator = authorizedAdministratorInitiator(administrator);

    if (parsed.data.mode === 'enabled') {
      let health: Awaited<ReturnType<typeof executeInspectEdgeIntegration>>;
      try {
        health = await executeInspectEdgeIntegration({ env: c.env });
      } catch (error) {
        if (error instanceof StudioOperationalError) {
          throw attributeOperationalError(error, initiator);
        }
        throw error;
      }
      const activationError = edgeIntegrationActivationError(health);
      if (activationError) {
        if (
          health.state === 'unavailable'
          && activationError === 'EDGE_INTEGRATION_UNAVAILABLE'
        ) {
          logStudioOperationalError(edgeHealthFailure(health), {
            method: c.req.method,
            pathname: new URL(c.req.url).pathname,
            ...operationsInitiatorMetadata(initiator),
          });
        }
        return errorResponse(
          c,
          activationError === 'EDGE_INTEGRATION_UNAVAILABLE' ? 503 : 409,
          activationError,
        );
      }
    }

    const action = parsed.data.mode === 'enabled'
      ? 'enable_edge_integration'
      : 'disable_edge_integration';
    let updated: Awaited<ReturnType<typeof executeUpdateEdgeIntegration>>;
    try {
      updated = await executeUpdateEdgeIntegration({
        db: c.env.DB,
        mode: parsed.data.mode,
        expectedRevision: parsed.data.expected_revision,
        updatedBy: administrator.administratorId,
      });
    } catch (error) {
      if (error instanceof StudioOperationalError) {
        throw attributeOperationalError(
          error,
          initiator,
        );
      }
      throw error;
    }
    if (updated.kind === 'revision_conflict') {
      return errorResponse(c, 409, 'SETTINGS_REVISION_CONFLICT');
    }
    let document: Awaited<ReturnType<typeof materializeEdgeServices>>;
    try {
      document = await materializeEdgeServices({
        env: c.env,
        stored: updated.document,
        requestContext: {
          method: c.req.method,
          pathname: new URL(c.req.url).pathname,
        },
      });
    } catch (error) {
      if (error instanceof StudioOperationalError) {
        throw attributeOperationalError(
          error,
          initiator,
        );
      }
      throw error;
    }
    logOperationalFailure('EDGE_INTEGRATION_MODE_CHANGED', {
      metadata: {
        resource: 'DB',
        action,
        mode: parsed.data.mode,
        effective_state: document.effective_state,
        ...operationsInitiatorMetadata(
          initiator,
        ),
      },
    });
    return c.json(operationsEdgeIntegrationUpdateSuccessSchema.parse({
      success: true,
      data: document,
    }));
  });

  operations.post('/edge-database/uninstall/preview', bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const authorization = await authorizeEdgeDatabaseUninstall(c);
    if (!authorization.authorized) return authorization.response;
    try {
      const inspection = await executeInspectEdgeUninstall({
        edgeDb: authorization.edgeDb,
      });
      return c.json(edgeDatabaseUninstallPreviewSuccessSchema.parse({
        success: true,
        data: {
          operation: 'uninstall_edge_database',
          expected_effects: { deleted_rows: inspection.deletedRows },
        },
      }));
    } catch (error) {
      if (
        error instanceof EdgeDatabaseLifecycleError
        && error.issue !== 'artifact_invalid'
      ) {
        return edgeLifecycleErrorResponse(
          c,
          error,
          'EDGE_DATABASE_UNINSTALL_NOT_AVAILABLE',
        );
      }
      throw new StudioOperationalError(
        'EDGE_DATABASE_UNINSTALL_PREVIEW_FAILED',
        {
          cause: error,
          metadata: {
            resource: 'EDGE_DB',
            action: 'preview_uninstall_edge_database',
            ...operationsInitiatorMetadata(authorization.initiator),
          },
        },
      );
    }
  });

  operations.post('/edge-database/uninstall', bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const authorization = await authorizeEdgeDatabaseUninstall(c);
    if (!authorization.authorized) return authorization.response;
    logOperationalFailure('MAINTENANCE_OPERATION_STARTED', {
      metadata: {
        resource: 'EDGE_DB',
        action: 'uninstall_edge_database',
        ...operationsInitiatorMetadata(authorization.initiator),
      },
    });
    try {
      const result = await executeUninstallEdgeDatabase({
        edgeDb: authorization.edgeDb,
      });
      logOperationalFailure('EDGE_DATABASE_UNINSTALL_COMPLETED', {
        metadata: {
          resource: 'EDGE_DB',
          action: 'uninstall_edge_database',
          removed_table_count: Object.keys(result.deletedRows).length,
          ...operationsInitiatorMetadata(authorization.initiator),
        },
      });
      return c.json(edgeDatabaseUninstallSuccessSchema.parse({
        success: true,
        data: {
          operation: 'uninstall_edge_database',
          status: 'completed',
          effects: { deleted_rows: result.deletedRows },
        },
      }));
    } catch (error) {
      if (
        error instanceof EdgeDatabaseLifecycleError
        && error.issue !== 'artifact_invalid'
      ) {
        return edgeLifecycleErrorResponse(
          c,
          error,
          'EDGE_DATABASE_UNINSTALL_NOT_AVAILABLE',
        );
      }
      throw new StudioOperationalError('EDGE_DATABASE_UNINSTALL_FAILED', {
        cause: error,
        metadata: {
          resource: 'EDGE_DB',
          action: 'uninstall_edge_database',
          ...operationsInitiatorMetadata(authorization.initiator),
        },
      });
    }
  });

  operations.post('/edge-database/install', bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const boundary = requireMaintenanceMode(c);
    if (boundary) return boundary;
    const systemStatus = await resolveSystemStatus(c.env);
    if (systemStatus.database.state !== 'ready') {
      return errorResponse(c, 409, 'EDGE_DATABASE_STUDIO_NOT_READY');
    }
    if (!c.env.EDGE_DB) {
      return errorResponse(c, 409, 'EDGE_DATABASE_INSTALL_NOT_AVAILABLE');
    }
    if (
      await isDatabaseRestoreInProgress(c.env.DB)
      || await isEdgeTargetReconciliationInProgress(c.env.DB)
      || await isContentSearchIndexRebuildInProgress(c.env.DB)
    ) {
      return errorResponse(c, 409, 'EDGE_DATABASE_STATE_CONFLICT');
    }
    const body = await readOperationsJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = edgeDatabaseInstallRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const administrator = await authorizeEdgeLifecycleAdministrator(
      c, parsed.data, authorizeAdministrator,
    );
    if (!administrator.authorized) return administrator.response;
    try {
      logOperationalFailure('MAINTENANCE_OPERATION_STARTED', {
        metadata: {
          resource: 'EDGE_DB',
          action: 'install_edge_database',
          ...operationsInitiatorMetadata(administrator.initiator),
        },
      });
      await executeInstallEdgeDatabase({ edgeDb: c.env.EDGE_DB });
    } catch (error) {
      if (error instanceof EdgeDatabaseLifecycleError) {
        return edgeLifecycleErrorResponse(
          c, error, 'EDGE_DATABASE_INSTALL_NOT_AVAILABLE',
        );
      }
      throw new StudioOperationalError('EDGE_DATABASE_LIFECYCLE_FAILED', {
        cause: error,
        metadata: {
          resource: 'EDGE_DB',
          action: 'install_edge_database',
          ...operationsInitiatorMetadata(administrator.initiator),
        },
      });
    }
    logOperationalFailure('EDGE_DATABASE_LIFECYCLE_COMPLETED', {
      metadata: {
        resource: 'EDGE_DB', action: 'install_edge_database',
        schema_version: EDGE_DATABASE_SCHEMA_VERSION,
        ...operationsInitiatorMetadata(administrator.initiator),
      },
    });
    const response: EdgeDatabaseMutationResponse = {
      success: true,
      data: {
        operation: 'install_edge_database',
        status: 'completed',
        operation_id: null,
        current_schema_version: EDGE_DATABASE_SCHEMA_VERSION,
        target_schema_version: EDGE_DATABASE_SCHEMA_VERSION,
        next_step: null,
      },
    };
    return c.json(response);
  });

  operations.post('/edge-database/adopt', bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const boundary = requireMaintenanceMode(c);
    if (boundary) return boundary;
    const systemStatus = await resolveSystemStatus(c.env);
    if (systemStatus.database.state !== 'ready') {
      return errorResponse(c, 409, 'EDGE_DATABASE_STUDIO_NOT_READY');
    }
    if (!c.env.EDGE_DB) {
      return errorResponse(c, 409, 'EDGE_DATABASE_ADOPTION_NOT_AVAILABLE');
    }
    if (
      await isDatabaseRestoreInProgress(c.env.DB)
      || await isEdgeTargetReconciliationInProgress(c.env.DB)
      || await isContentSearchIndexRebuildInProgress(c.env.DB)
    ) {
      return errorResponse(c, 409, 'EDGE_DATABASE_STATE_CONFLICT');
    }
    const body = await readOperationsJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = edgeDatabaseAdoptRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const administrator = await authorizeEdgeLifecycleAdministrator(
      c, parsed.data, authorizeAdministrator,
    );
    if (!administrator.authorized) return administrator.response;
    try {
      logOperationalFailure('MAINTENANCE_OPERATION_STARTED', {
        metadata: {
          resource: 'EDGE_DB',
          action: 'adopt_edge_database',
          ...operationsInitiatorMetadata(administrator.initiator),
        },
      });
      await executeAdoptEdgeDatabase({ edgeDb: c.env.EDGE_DB });
    } catch (error) {
      if (error instanceof EdgeDatabaseLifecycleError) {
        return edgeLifecycleErrorResponse(
          c, error, 'EDGE_DATABASE_ADOPTION_NOT_AVAILABLE',
        );
      }
      throw new StudioOperationalError('EDGE_DATABASE_LIFECYCLE_FAILED', {
        cause: error,
        metadata: {
          resource: 'EDGE_DB',
          action: 'adopt_edge_database',
          ...operationsInitiatorMetadata(administrator.initiator),
        },
      });
    }
    logOperationalFailure('EDGE_DATABASE_LIFECYCLE_COMPLETED', {
      metadata: {
        resource: 'EDGE_DB', action: 'adopt_edge_database',
        schema_version: EDGE_DATABASE_SCHEMA_VERSION,
        ...operationsInitiatorMetadata(administrator.initiator),
      },
    });
    const response: EdgeDatabaseMutationResponse = {
      success: true,
      data: {
        operation: 'adopt_edge_database',
        status: 'completed',
        operation_id: null,
        current_schema_version: EDGE_DATABASE_SCHEMA_VERSION,
        target_schema_version: EDGE_DATABASE_SCHEMA_VERSION,
        next_step: null,
      },
    };
    return c.json(response);
  });

  operations.post('/edge-database/upgrade/start', bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const boundary = requireEdgeUpgradeMode(c);
    if (boundary) return boundary;
    const systemStatus = await resolveSystemStatus(c.env);
    if (systemStatus.database.state !== 'ready') {
      return errorResponse(c, 409, 'EDGE_DATABASE_STUDIO_NOT_READY');
    }
    if (
      !c.env.EDGE_DB
      || await isDatabaseRestoreInProgress(c.env.DB)
      || await isEdgeTargetReconciliationInProgress(c.env.DB)
      || await isContentSearchIndexRebuildInProgress(c.env.DB)
    ) {
      return errorResponse(c, 409, 'EDGE_DATABASE_UPGRADE_NOT_AVAILABLE');
    }
    const body = await readOperationsJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = edgeDatabaseUpgradeStartRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const administrator = await authorizeEdgeLifecycleAdministrator(
      c, parsed.data, authorizeAdministrator,
    );
    if (!administrator.authorized) return administrator.response;
    try {
      const result = await executeStartEdgeDatabaseUpgrade({
        edgeDb: c.env.EDGE_DB,
        initiator: administrator.initiator,
      });
      const initiator = await executeReadEdgeDatabaseUpgradeInitiator({
        edgeDb: c.env.EDGE_DB,
        operationId: result.operationId,
      });
      logOperationalFailure('EDGE_DATABASE_UPGRADE_STARTED', {
        metadata: {
          resource: 'EDGE_DB',
          action: 'upgrade_edge_database',
          operation_id: result.operationId,
          ...operationsInitiatorMetadata(initiator),
        },
      });
      const response: EdgeDatabaseMutationResponse = {
        success: true,
        data: {
          operation: 'upgrade_edge_database',
          status: 'started',
          operation_id: result.operationId,
          current_schema_version: result.currentVersion,
          target_schema_version: EDGE_DATABASE_SCHEMA_VERSION,
          next_step: result.nextStep,
        },
      };
      return c.json(response);
    } catch (error) {
      if (error instanceof EdgeDatabaseLifecycleError) {
        return edgeLifecycleErrorResponse(
          c, error, 'EDGE_DATABASE_UPGRADE_NOT_AVAILABLE',
        );
      }
      throw new StudioOperationalError('EDGE_DATABASE_LIFECYCLE_FAILED', {
        cause: error,
        metadata: {
          resource: 'EDGE_DB',
          action: 'start_edge_database_upgrade',
          ...operationsInitiatorMetadata(administrator.initiator),
        },
      });
    }
  });

  operations.post('/edge-database/upgrade/step', bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const boundary = requireEdgeUpgradeMode(c);
    if (boundary) return boundary;
    const systemStatus = await resolveSystemStatus(c.env);
    if (systemStatus.database.state !== 'ready') {
      return errorResponse(c, 409, 'EDGE_DATABASE_STUDIO_NOT_READY');
    }
    if (!c.env.EDGE_DB) {
      return errorResponse(c, 409, 'EDGE_DATABASE_UPGRADE_NOT_AVAILABLE');
    }
    const body = await readOperationsJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = edgeDatabaseUpgradeStepRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    let initiator: OperationsInitiator | null = null;
    try {
      initiator = await executeReadEdgeDatabaseUpgradeInitiator({
        edgeDb: c.env.EDGE_DB,
        operationId: parsed.data.operation_id,
      });
      const result = await executeApplyEdgeDatabaseUpgrade({
        edgeDb: c.env.EDGE_DB,
        operationId: parsed.data.operation_id,
        stepId: parsed.data.step_id,
      });
      logOperationalFailure('EDGE_DATABASE_LIFECYCLE_COMPLETED', {
        metadata: {
          resource: 'EDGE_DB',
          action: result.completed
            ? 'complete_edge_database_upgrade'
            : 'apply_edge_database_upgrade_step',
          operation_id: parsed.data.operation_id,
          schema_version: result.currentVersion,
          ...operationsInitiatorMetadata(initiator),
        },
      });
      const response: EdgeDatabaseMutationResponse = {
        success: true,
        data: {
          operation: 'upgrade_edge_database',
          status: result.completed ? 'completed' : 'in_progress',
          operation_id: result.completed ? null : parsed.data.operation_id,
          current_schema_version: result.currentVersion,
          target_schema_version: EDGE_DATABASE_SCHEMA_VERSION,
          next_step: result.nextStep,
        },
      };
      return c.json(response);
    } catch (error) {
      if (error instanceof EdgeDatabaseLifecycleError) {
        return edgeLifecycleErrorResponse(
          c, error, 'EDGE_DATABASE_UPGRADE_NOT_AVAILABLE',
        );
      }
      throw new StudioOperationalError('EDGE_DATABASE_LIFECYCLE_FAILED', {
        cause: error,
        metadata: {
          resource: 'EDGE_DB',
          action: 'apply_edge_database_upgrade',
          ...operationsInitiatorMetadata(initiator),
        },
      });
    }
  });

  operations.post('/edge-target-reconciliation/start', bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const boundary = requireMaintenanceMode(c);
    if (boundary) return boundary;
    const systemStatus = await resolveSystemStatus(c.env);
    if (systemStatus.database.state !== 'ready' || !c.env.EDGE_DB) {
      return errorResponse(c, 409, 'EDGE_TARGET_RECONCILIATION_NOT_AVAILABLE');
    }
    const edgeState = await inspectEdgeDatabase({
      edgeDb: c.env.EDGE_DB,
      siteMode: 'maintenance',
    });
    if (edgeState.state !== 'ready') {
      return errorResponse(c, 409, 'EDGE_TARGET_RECONCILIATION_NOT_AVAILABLE');
    }
    if (
      await isDatabaseRestoreInProgress(c.env.DB)
      || await isContentSearchIndexRebuildInProgress(c.env.DB)
    ) {
      return errorResponse(c, 409, 'EDGE_TARGET_RECONCILIATION_STATE_CONFLICT');
    }
    const body = await readOperationsJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = edgeTargetReconciliationStartRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const administrator = await authorizeEdgeLifecycleAdministrator(
      c, parsed.data, authorizeAdministrator,
    );
    if (!administrator.authorized) return administrator.response;
    try {
      const reconciliation = await executeStartEdgeReconciliation({
        db: c.env.DB,
        initiator: administrator.initiator,
      });
      logOperationalFailure('MAINTENANCE_OPERATION_STARTED', {
        metadata: {
          resource: 'DB',
          related_resource: 'EDGE_DB',
          action: 'reconcile_edge_comment_targets',
          operation_id: reconciliation.operation_id,
          ...operationsInitiatorMetadata(administrator.initiator),
        },
      });
      const response: EdgeTargetReconciliationMutationResponse = {
        success: true,
        data: {
          operation: 'reconcile_edge_comment_targets',
          status: 'started',
          reconciliation,
        },
      };
      return c.json(response);
    } catch (error) {
      if (error instanceof EdgeTargetReconciliationError) {
        return edgeReconciliationErrorResponse(c, error);
      }
      throw new StudioOperationalError('EDGE_TARGET_RECONCILIATION_FAILED', {
        cause: error,
        metadata: {
          resource: 'DB',
          related_resource: 'EDGE_DB',
          action: 'start_edge_target_reconciliation',
          ...operationsInitiatorMetadata(administrator.initiator),
        },
      });
    }
  });

  operations.post('/edge-target-reconciliation/step', bodyLimit({
    maxSize: 4 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const boundary = requireMaintenanceMode(c);
    if (boundary) return boundary;
    const body = await readOperationsJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = edgeTargetReconciliationStepRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    let initiator: OperationsInitiator | null = null;
    try {
      initiator = await executeReadEdgeReconciliationInitiator({
        db: c.env.DB,
        operationId: parsed.data.operation_id,
      });
      const reconciliation = await executeApplyEdgeReconciliationStep({
        env: c.env,
        operationId: parsed.data.operation_id,
      });
      logOperationalFailure('EDGE_TARGET_RECONCILIATION_COMPLETED', {
        metadata: {
          resource: 'DB',
          related_resource: 'EDGE_DB',
          action: 'advance_edge_target_reconciliation',
          operation_id: parsed.data.operation_id,
          phase: reconciliation.phase,
          ...operationsInitiatorMetadata(initiator),
        },
      });
      const response: EdgeTargetReconciliationMutationResponse = {
        success: true,
        data: {
          operation: 'reconcile_edge_comment_targets',
          status: reconciliation.state === 'orphan_review'
            ? 'orphan_review' : 'in_progress',
          reconciliation,
        },
      };
      return c.json(response);
    } catch (error) {
      if (error instanceof EdgeTargetReconciliationError) {
        return edgeReconciliationErrorResponse(c, error);
      }
      throw new StudioOperationalError('EDGE_TARGET_RECONCILIATION_FAILED', {
        cause: error,
        metadata: {
          resource: 'DB',
          related_resource: 'EDGE_DB',
          action: 'step_edge_target_reconciliation',
          ...operationsInitiatorMetadata(initiator),
        },
      });
    }
  });

  operations.post('/edge-target-reconciliation/orphans', bodyLimit({
    maxSize: 4 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const boundary = requireMaintenanceMode(c);
    if (boundary) return boundary;
    const body = await readOperationsJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = edgeTargetOrphanListRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    try {
      const result = await executeListEdgeOrphans({
        db: c.env.DB,
        operationId: parsed.data.operation_id,
        cursor: parsed.data.cursor,
        limit: parsed.data.limit,
      });
      return c.json(edgeTargetOrphanListSuccessSchema.parse({
        success: true,
        data: { items: result.items, next_cursor: result.nextCursor },
      }));
    } catch (error) {
      if (error instanceof EdgeTargetReconciliationError) {
        return edgeReconciliationErrorResponse(c, error);
      }
      throw error;
    }
  });

  operations.post('/edge-target-reconciliation/orphans/purge', bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const boundary = requireMaintenanceMode(c);
    if (boundary) return boundary;
    if (!c.env.EDGE_DB) return errorResponse(c, 409, 'EDGE_TARGET_RECONCILIATION_NOT_AVAILABLE');
    const body = await readOperationsJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = edgeTargetOrphanPurgeRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    let initiator: OperationsInitiator | null = null;
    try {
      initiator = await executeReadEdgeReconciliationInitiator({
        db: c.env.DB,
        operationId: parsed.data.operation_id,
      });
      const purgeResults = await executePurgeEdgeOrphans({
        db: c.env.DB,
        edgeDb: c.env.EDGE_DB,
        operationId: parsed.data.operation_id,
        targetIds: parsed.data.target_ids,
      });
      logOperationalFailure('EDGE_TARGET_RECONCILIATION_COMPLETED', {
        metadata: {
          resource: 'EDGE_DB',
          related_resource: 'DB',
          action: 'purge_edge_target_orphans',
          operation_id: parsed.data.operation_id,
          selected_target_count: parsed.data.target_ids.length,
          ...operationsInitiatorMetadata(initiator),
        },
      });
      const reconciliation = await inspectEdgeReconciliation({
        db: c.env.DB, edgeDb: c.env.EDGE_DB, available: true,
      });
      const response: EdgeTargetReconciliationMutationResponse = {
        success: true,
        data: {
          operation: 'reconcile_edge_comment_targets',
          status: 'orphan_review',
          reconciliation,
          purge_results: purgeResults,
        },
      };
      return c.json(response);
    } catch (error) {
      if (error instanceof EdgeTargetReconciliationError) {
        return edgeReconciliationErrorResponse(c, error);
      }
      throw new StudioOperationalError('EDGE_TARGET_RECONCILIATION_FAILED', {
        cause: error,
        metadata: {
          resource: 'EDGE_DB',
          related_resource: 'DB',
          action: 'purge_edge_target_orphans',
          ...operationsInitiatorMetadata(initiator),
        },
      });
    }
  });

  operations.post('/edge-target-reconciliation/finalize', bodyLimit({
    maxSize: 4 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const boundary = requireMaintenanceMode(c);
    if (boundary) return boundary;
    if (!c.env.EDGE_DB) return errorResponse(c, 409, 'EDGE_TARGET_RECONCILIATION_NOT_AVAILABLE');
    const body = await readOperationsJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = edgeTargetReconciliationFinalizeRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    let initiator: OperationsInitiator | null = null;
    try {
      initiator = await executeReadEdgeReconciliationInitiator({
        db: c.env.DB,
        operationId: parsed.data.operation_id,
      });
      await executeFinalizeEdgeReconciliation({
        db: c.env.DB, edgeDb: c.env.EDGE_DB,
        operationId: parsed.data.operation_id,
      });
      logOperationalFailure('EDGE_TARGET_RECONCILIATION_COMPLETED', {
        metadata: {
          resource: 'DB',
          related_resource: 'EDGE_DB',
          action: 'finalize_edge_target_reconciliation',
          operation_id: parsed.data.operation_id,
          ...operationsInitiatorMetadata(initiator),
        },
      });
      const response: EdgeTargetReconciliationMutationResponse = {
        success: true,
        data: {
          operation: 'reconcile_edge_comment_targets',
          status: 'completed',
          reconciliation: {
            state: 'not_required', operation_id: null, phase: null,
            processed_posts: 0, processed_pages: 0,
            scanned_edge_targets: 0, orphan_targets: 0,
            orphan_comments: 0, available: true,
          },
        },
      };
      return c.json(response);
    } catch (error) {
      if (error instanceof EdgeTargetReconciliationError) {
        return edgeReconciliationErrorResponse(c, error);
      }
      throw new StudioOperationalError('EDGE_TARGET_RECONCILIATION_FAILED', {
        cause: error,
        metadata: {
          resource: 'DB',
          related_resource: 'EDGE_DB',
          action: 'finalize_edge_target_reconciliation',
          ...operationsInitiatorMetadata(initiator),
        },
      });
    }
  });

  operations.post('/edge-target-reconciliation/cancel', bodyLimit({
    maxSize: 4 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const boundary = requireMaintenanceMode(c);
    if (boundary) return boundary;
    const body = await readOperationsJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = edgeTargetReconciliationCancelRequestSchema.safeParse(body.value);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    let initiator: OperationsInitiator | null = null;
    try {
      initiator = await executeReadEdgeReconciliationInitiator({
        db: c.env.DB,
        operationId: parsed.data.operation_id,
      });
      await executeCancelEdgeReconciliation({
        db: c.env.DB,
        operationId: parsed.data.operation_id,
      });
      logOperationalFailure('EDGE_TARGET_RECONCILIATION_COMPLETED', {
        metadata: {
          resource: 'DB',
          action: 'cancel_edge_target_reconciliation',
          operation_id: parsed.data.operation_id,
          ...operationsInitiatorMetadata(initiator),
        },
      });
      const response: EdgeTargetReconciliationMutationResponse = {
        success: true,
        data: {
          operation: 'reconcile_edge_comment_targets',
          status: 'cancelled',
          reconciliation: {
            state: 'required', operation_id: null, phase: null,
            processed_posts: 0, processed_pages: 0,
            scanned_edge_targets: 0, orphan_targets: 0,
            orphan_comments: 0, available: true,
          },
        },
      };
      return c.json(response);
    } catch (error) {
      if (error instanceof EdgeTargetReconciliationError) {
        return edgeReconciliationErrorResponse(c, error);
      }
      throw new StudioOperationalError('EDGE_TARGET_RECONCILIATION_FAILED', {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'cancel_edge_target_reconciliation',
          ...operationsInitiatorMetadata(initiator),
        },
      });
    }
  });

  operations.post('/content-search-index/rebuild/start', bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const boundary = requireMaintenanceOrRecoveryMode(c);
    if (boundary) return boundary;
    const systemStatus = await resolveSystemStatus(c.env);
    if (systemStatus.database.state !== 'ready') {
      return errorResponse(
        c,
        409,
        'CONTENT_SEARCH_INDEX_REBUILD_NOT_AVAILABLE',
      );
    }
    if (
      await isDatabaseRestoreInProgress(c.env.DB)
      || await isEdgeTargetReconciliationInProgress(c.env.DB)
    ) {
      return errorResponse(
        c,
        409,
        'CONTENT_SEARCH_INDEX_REBUILD_STATE_CONFLICT',
      );
    }
    const body = await readOperationsJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = contentSearchIndexRebuildStartRequestSchema.safeParse(
      body.value,
    );
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const administrator = await authorizeAdministratorCredentials(
      c,
      parsed.data,
      authorizeAdministrator,
    );
    if (!administrator.authorized) return administrator.response;
    const initiator = authorizedAdministratorInitiator(administrator);
    try {
      const contentSearchIndex =
        await executeStartContentSearchIndexRebuild({
          db: c.env.DB,
          initiator,
        });
      logOperationalFailure('MAINTENANCE_OPERATION_STARTED', {
        metadata: {
          resource: 'DB',
          action: 'rebuild_content_search_index',
          operation_id: contentSearchIndex.operation_id,
          phase: contentSearchIndex.phase,
          ...operationsInitiatorMetadata(initiator),
        },
      });
      const response: ContentSearchIndexRebuildMutationResponse = {
        success: true,
        data: {
          operation: 'rebuild_content_search_index',
          status: 'started',
          content_search_index: contentSearchIndex,
        },
      };
      return c.json(response);
    } catch (error) {
      if (error instanceof ContentSearchRebuildError) {
        return contentSearchRebuildErrorResponse(c, error);
      }
      throw new StudioOperationalError('CONTENT_SEARCH_INDEX_REBUILD_FAILED', {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'start_content_search_index_rebuild',
          ...operationsInitiatorMetadata(initiator),
        },
      });
    }
  });

  operations.post('/content-search-index/rebuild/step', bodyLimit({
    maxSize: 4 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const boundary = requireMaintenanceOrRecoveryMode(c);
    if (boundary) return boundary;
    const body = await readOperationsJsonBody(c);
    if (!body.valid) return body.response;
    const parsed = contentSearchIndexRebuildStepRequestSchema.safeParse(
      body.value,
    );
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    let initiator: OperationsInitiator | null = null;
    try {
      initiator = await executeReadContentSearchRebuildInitiator({
        db: c.env.DB,
        operationId: parsed.data.operation_id,
      });
      const contentSearchIndex =
        await executeApplyContentSearchIndexRebuildStep({
          db: c.env.DB,
          request: parsed.data,
        });
      const completed = contentSearchIndex.state === 'ready';
      logOperationalFailure(
        completed
          ? 'CONTENT_SEARCH_INDEX_REBUILD_COMPLETED'
          : 'MAINTENANCE_OPERATION_STARTED',
        {
          metadata: {
            resource: 'DB',
            action: completed
              ? 'complete_content_search_index_rebuild'
              : 'advance_content_search_index_rebuild',
            operation_id: parsed.data.operation_id,
            phase: contentSearchIndex.phase,
            processed_posts: contentSearchIndex.processed_posts,
            processed_pages: contentSearchIndex.processed_pages,
            ...operationsInitiatorMetadata(initiator),
          },
        },
      );
      const response: ContentSearchIndexRebuildMutationResponse = {
        success: true,
        data: {
          operation: 'rebuild_content_search_index',
          status: completed ? 'completed' : 'in_progress',
          content_search_index: contentSearchIndex,
        },
      };
      return c.json(response);
    } catch (error) {
      if (error instanceof ContentSearchRebuildError) {
        return contentSearchRebuildErrorResponse(c, error);
      }
      throw new StudioOperationalError('CONTENT_SEARCH_INDEX_REBUILD_FAILED', {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'apply_content_search_index_rebuild_step',
          operation_id: parsed.data.operation_id,
          ...operationsInitiatorMetadata(initiator),
        },
      });
    }
  });

  operations.post('/database-upgrade/start', bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
    if (siteMode.state === 'invalid' || siteMode.mode !== 'maintenance') {
      return errorResponse(c, 409, 'DATABASE_UPGRADE_NOT_AVAILABLE');
    }
    if (c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase()
      !== 'application/json') {
      return errorResponse(c, 415, 'UNSUPPORTED_MEDIA_TYPE');
    }
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return errorResponse(c, 400, 'INVALID_JSON');
    }
    const parsed = databaseUpgradeStartRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    if (
      await isEdgeTargetReconciliationInProgress(c.env.DB)
      || await isContentSearchIndexRebuildInProgress(c.env.DB)
    ) {
      return errorResponse(c, 409, 'DATABASE_UPGRADE_STATE_CONFLICT');
    }
    const administrator = await authorizeAdministrator({
      db: c.env.DB,
      email: parsed.data.administrator_email,
      password: parsed.data.administrator_password,
    });
    if (!administrator.authorized) {
      return errorResponse(c, 401, 'INVALID_OPERATIONS_CREDENTIALS');
    }
    const initiator = authorizedAdministratorInitiator(administrator);
    let result: Awaited<ReturnType<StartSchemaUpgrade>>;
    try {
      result = await executeStartSchemaUpgrade({
        db: c.env.DB,
        request: parsed.data,
        initiator,
        beforeBatch(details) {
          logOperationalFailure('MAINTENANCE_OPERATION_STARTED', {
            metadata: {
              resource: 'DB',
              action: 'upgrade_studio_database',
              from_schema_version: details.fromVersion,
              target_schema_version: details.targetVersion,
              step_count: details.stepCount,
              ...operationsInitiatorMetadata(initiator),
            },
          });
        },
      });
    } catch (error) {
      if (error instanceof SchemaUpgradeServiceError) {
        return errorResponse(
          c,
          409,
          error.issue === 'state_conflict'
            ? 'DATABASE_UPGRADE_STATE_CONFLICT'
            : 'DATABASE_UPGRADE_NOT_AVAILABLE',
        );
      }
      if (error instanceof SchemaUpgradeArtifactError) {
        return errorResponse(c, 409, 'DATABASE_UPGRADE_NOT_AVAILABLE');
      }
      throw new StudioOperationalError('DATABASE_UPGRADE_FAILED', {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'start_schema_upgrade',
          ...operationsInitiatorMetadata(initiator),
        },
      });
    }
    const response: DatabaseUpgradeStartSuccess = {
      success: true,
      data: result,
    };
    return c.json(response);
  });

  operations.post('/database-upgrade/step', bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
    if (siteMode.state === 'invalid' || siteMode.mode !== 'maintenance') {
      return errorResponse(c, 409, 'DATABASE_UPGRADE_NOT_AVAILABLE');
    }
    if (c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase()
      !== 'application/json') {
      return errorResponse(c, 415, 'UNSUPPORTED_MEDIA_TYPE');
    }
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return errorResponse(c, 400, 'INVALID_JSON');
    }
    const parsed = databaseUpgradeStepRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    let result: Awaited<ReturnType<ApplySchemaUpgradeStep>>;
    let initiator: OperationsInitiator | null = null;
    try {
      initiator = await executeReadSchemaUpgradeInitiator({
        db: c.env.DB,
        operationId: parsed.data.operation_id,
      });
      result = await executeApplySchemaUpgradeStep({
        db: c.env.DB,
        request: parsed.data,
      });
    } catch (error) {
      if (error instanceof SchemaUpgradeServiceError) {
        return errorResponse(c, 409, 'DATABASE_UPGRADE_STATE_CONFLICT');
      }
      if (error instanceof SchemaUpgradeArtifactError) {
        return errorResponse(c, 409, 'DATABASE_UPGRADE_NOT_AVAILABLE');
      }
      throw new StudioOperationalError('DATABASE_UPGRADE_FAILED', {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'apply_schema_upgrade_step',
          step_id: parsed.data.step_id,
          ...operationsInitiatorMetadata(initiator),
        },
      });
    }
    logOperationalFailure(
      result.status === 'completed'
        ? 'DATABASE_UPGRADE_COMPLETED'
        : 'DATABASE_UPGRADE_STEP_COMPLETED',
      {
        metadata: {
          resource: 'DB',
          action: 'upgrade_studio_database',
          step_id: result.applied_step.id,
          schema_version: result.current_schema_version,
          target_schema_version: result.target_schema_version,
          ...operationsInitiatorMetadata(initiator),
        },
      },
    );
    const response = {
      success: true,
      data: result,
    } as const;
    return c.json(response);
  });

  operations.post('/database-backup', bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
    if (
      siteMode.state === 'invalid'
      || (
        siteMode.mode !== 'operational'
        && siteMode.mode !== 'maintenance'
        && siteMode.mode !== 'recovery'
      )
    ) {
      return errorResponse(c, 409, 'DATABASE_BACKUP_NOT_AVAILABLE');
    }
    const systemStatus = await resolveSystemStatus(c.env, siteMode);
    const contentType = c.req.header('Content-Type')
      ?.split(';')[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 415, 'UNSUPPORTED_MEDIA_TYPE');
    }
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return errorResponse(c, 400, 'INVALID_JSON');
    }
    const parsed = databaseBackupRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    let edgeDatabaseReadable: boolean | undefined;
    if (parsed.data.database === 'edge') {
      const edgeLifecycle = await inspectEdgeDatabase({
        edgeDb: c.env.EDGE_DB,
        siteMode: siteMode.mode,
      });
      edgeDatabaseReadable = edgeLifecycle.state !== 'uninstalled'
        && edgeLifecycle.state !== 'unavailable';
    }
    const availability = databaseTransferAvailability({
      siteMode: systemStatus.site_mode,
      databaseState: systemStatus.database.state,
      edgeDatabaseBound: Boolean(c.env.EDGE_DB),
      edgeDatabaseReadable,
    }).databases[parsed.data.database];
    if (!availability.export_available) {
      return errorResponse(c, 409, 'DATABASE_BACKUP_NOT_AVAILABLE');
    }
    const authorization = await authorizeDatabaseTransferCredentials(
      c,
      siteMode.mode,
      parsed.data,
      authorizeAdministrator,
    );
    if (!authorization.authorized) return authorization.response;
    const database = databaseForTarget(c, parsed.data.database);
    if (!database) {
      return errorResponse(c, 409, 'DATABASE_BACKUP_NOT_AVAILABLE');
    }

    let backup: Awaited<ReturnType<ExportDatabaseBackup>>;
    try {
      backup = await executeExportDatabaseBackup({
        db: database,
        database: parsed.data.database,
        mode: parsed.data.mode,
      });
    } catch (error) {
      if (error instanceof DatabaseBackupServiceError) {
        return errorResponse(
          c,
          error.issue === 'limit_exceeded' ? 413 : 409,
          error.issue === 'limit_exceeded'
            ? 'DATABASE_BACKUP_LIMIT_EXCEEDED'
            : 'DATABASE_BACKUP_NOT_AVAILABLE',
        );
      }
      throw new StudioOperationalError('DATABASE_BACKUP_EXPORT_FAILED', {
        cause: error,
        metadata: {
          resource: parsed.data.database === 'studio' ? 'DB' : 'EDGE_DB',
          action: 'export_database_backup',
          database: parsed.data.database,
          mode: parsed.data.mode,
          ...operationsInitiatorMetadata(authorization.initiator),
        },
      });
    }
    logOperationalFailure('DATABASE_BACKUP_EXPORT_COMPLETED', {
      metadata: {
        resource: parsed.data.database === 'studio' ? 'DB' : 'EDGE_DB',
        action: 'export_database_backup',
        database: parsed.data.database,
        mode: parsed.data.mode,
        table_count: backup.manifest.tables.length,
        ...operationsInitiatorMetadata(authorization.initiator),
      },
    });
    c.header('Content-Type', 'application/sql; charset=utf-8');
    c.header(
      'Content-Disposition',
      `attachment; filename="${backup.filename}"`,
    );
    return c.body(backup.sql);
  });

  operations.post('/database-restore/start', bodyLimit({
    maxSize: DATABASE_RESTORE_MAX_CHUNK_BYTES + 2 * 1024 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
    if (
      siteMode.state === 'invalid'
      || (siteMode.mode !== 'maintenance' && siteMode.mode !== 'recovery')
    ) {
      return errorResponse(c, 409, 'DATABASE_BACKUP_NOT_AVAILABLE');
    }
    const systemStatus = await resolveSystemStatus(c.env, siteMode);
    const contentType = c.req.header('Content-Type')
      ?.split(';')[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 415, 'UNSUPPORTED_MEDIA_TYPE');
    }
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return errorResponse(c, 400, 'INVALID_JSON');
    }
    const parsed = databaseRestoreStartRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    if (
      systemStatus.database.state === 'ready'
      && await isEdgeTargetReconciliationInProgress(c.env.DB)
    ) {
      return errorResponse(c, 409, 'DATABASE_RESTORE_STATE_CONFLICT');
    }
    if (
      systemStatus.database.state === 'ready'
      && await isContentSearchIndexRebuildInProgress(c.env.DB)
    ) {
      return errorResponse(c, 409, 'DATABASE_RESTORE_STATE_CONFLICT');
    }
    const database = databaseForTarget(c, parsed.data.database);
    if (!database) {
      return errorResponse(c, 409, 'DATABASE_BACKUP_NOT_AVAILABLE');
    }
    if (parsed.data.database === 'edge') {
      const edgeLifecycle = await inspectEdgeDatabase({
        edgeDb: c.env.EDGE_DB,
        siteMode: siteMode.mode,
      });
      if (edgeLifecycle.state === 'in_progress') {
        return errorResponse(c, 409, 'DATABASE_RESTORE_STATE_CONFLICT');
      }
    }
    let restartingInterruptedRestore = false;
    if (
      siteMode.mode === 'maintenance'
      && parsed.data.database === 'studio'
    ) {
      try {
        restartingInterruptedRestore = await isDatabaseRestoreInProgress(
          database,
        );
      } catch (error) {
        if (error instanceof DatabaseBackupServiceError) {
          return transferErrorResponse(c, error);
        }
        throw new StudioOperationalError('DATABASE_RESTORE_FAILED', {
          cause: error,
          metadata: {
            resource: 'DB',
            action: 'inspect_database_restore_journal',
            database: 'studio',
          },
        });
      }
      if (
        systemStatus.database.state !== 'ready'
        && !restartingInterruptedRestore
      ) {
        return errorResponse(c, 409, 'DATABASE_BACKUP_NOT_AVAILABLE');
      }
    }
    const availability = databaseTransferAvailability({
      siteMode: systemStatus.site_mode,
      databaseState: systemStatus.database.state,
      edgeDatabaseBound: Boolean(c.env.EDGE_DB),
    }).databases[parsed.data.database];
    if (!availability.restore_available && !restartingInterruptedRestore) {
      return errorResponse(c, 409, 'DATABASE_BACKUP_NOT_AVAILABLE');
    }
    let initiator: OperationsInitiator | null = null;
    if (!restartingInterruptedRestore) {
      const authorization = await authorizeDatabaseTransferCredentials(
        c,
        siteMode.mode,
        parsed.data,
        authorizeAdministrator,
      );
      if (!authorization.authorized) return authorization.response;
      initiator = authorization.initiator;
    } else {
      initiator = await executeReadDatabaseRestoreInitiator(database);
    }

    let result: Awaited<ReturnType<StartDatabaseRestore>>;
    try {
      result = await executeStartDatabaseRestore({
        db: database,
        database: parsed.data.database,
        request: parsed.data,
        requireReadyStudioLifecycle:
          siteMode.mode === 'maintenance'
          && parsed.data.database === 'studio'
          && !restartingInterruptedRestore,
        initiator,
        beforeBatch() {
          logOperationalFailure('MAINTENANCE_OPERATION_STARTED', {
            metadata: {
              resource: parsed.data.database === 'studio' ? 'DB' : 'EDGE_DB',
              action: 'restore_database',
              database: parsed.data.database,
              mode: parsed.data.manifest.mode,
              ...operationsInitiatorMetadata(initiator),
            },
          });
        },
      });
    } catch (error) {
      if (
        error instanceof DatabaseBackupArtifactError
        || error instanceof DatabaseBackupServiceError
      ) {
        return transferErrorResponse(c, error);
      }
      throw new StudioOperationalError('DATABASE_RESTORE_FAILED', {
        cause: error,
        metadata: {
          resource: parsed.data.database === 'studio' ? 'DB' : 'EDGE_DB',
          action: 'restore_database',
          database: parsed.data.database,
          mode: parsed.data.manifest.mode,
          ...operationsInitiatorMetadata(initiator),
        },
      });
    }
    const response: DatabaseRestoreStartSuccess = {
      success: true,
      data: {
        operation: 'restore_database',
        status: 'started',
        database: result.database,
        mode: result.mode,
        restore_id: result.restoreId,
        next_chunk: 0,
        expected_chunk_count: result.expectedChunkCount,
      },
    };
    return c.json(response);
  });

  operations.post('/database-restore/chunk', bodyLimit({
    maxSize: DATABASE_RESTORE_MAX_CHUNK_BYTES + 128 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
    if (
      siteMode.state === 'invalid'
      || (siteMode.mode !== 'maintenance' && siteMode.mode !== 'recovery')
    ) {
      return errorResponse(c, 409, 'DATABASE_BACKUP_NOT_AVAILABLE');
    }
    if (c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      return errorResponse(c, 415, 'UNSUPPORTED_MEDIA_TYPE');
    }
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return errorResponse(c, 400, 'INVALID_JSON');
    }
    const parsed = databaseRestoreChunkRequestSchema.safeParse(rawBody);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const database = databaseForTarget(c, parsed.data.database);
    if (!database) return errorResponse(c, 409, 'DATABASE_BACKUP_NOT_AVAILABLE');

    let result: Awaited<ReturnType<ApplyDatabaseRestoreChunk>>;
    let initiator: OperationsInitiator | null = null;
    try {
      initiator = await executeReadDatabaseRestoreInitiator(database);
      result = await executeApplyDatabaseRestoreChunk({
        db: database,
        database: parsed.data.database,
        request: parsed.data,
      });
    } catch (error) {
      if (
        error instanceof DatabaseBackupArtifactError
        || error instanceof DatabaseBackupServiceError
      ) {
        return transferErrorResponse(c, error);
      }
      throw new StudioOperationalError('DATABASE_RESTORE_FAILED', {
        cause: error,
        metadata: {
          resource: parsed.data.database === 'studio' ? 'DB' : 'EDGE_DB',
          action: 'restore_database_chunk',
          database: parsed.data.database,
          chunk_index: parsed.data.chunk_index,
          ...operationsInitiatorMetadata(initiator),
        },
      });
    }
    const response: DatabaseRestoreChunkSuccess = {
      success: true,
      data: {
        operation: 'restore_database',
        status: 'in_progress',
        database: result.database,
        restore_id: result.restoreId,
        accepted_chunk: result.acceptedChunk,
        next_chunk: result.nextChunk,
        replayed: result.replayed,
      },
    };
    return c.json(response);
  });

  operations.post('/database-restore/finalize', bodyLimit({
    maxSize: DATABASE_RESTORE_MAX_CHUNK_BYTES + 2 * 1024 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
    if (
      siteMode.state === 'invalid'
      || (siteMode.mode !== 'maintenance' && siteMode.mode !== 'recovery')
    ) {
      return errorResponse(c, 409, 'DATABASE_BACKUP_NOT_AVAILABLE');
    }
    if (c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') {
      return errorResponse(c, 415, 'UNSUPPORTED_MEDIA_TYPE');
    }
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return errorResponse(c, 400, 'INVALID_JSON');
    }
    const parsed = databaseRestoreFinalizeRequestSchema.safeParse(rawBody);
    if (!parsed.success) return errorResponse(c, 400, 'VALIDATION_ERROR');
    const database = databaseForTarget(c, parsed.data.database);
    if (!database) return errorResponse(c, 409, 'DATABASE_BACKUP_NOT_AVAILABLE');

    let result: Awaited<ReturnType<FinalizeDatabaseRestore>>;
    let initiator: OperationsInitiator | null = null;
    try {
      initiator = await executeReadDatabaseRestoreInitiator(database);
      result = await executeFinalizeDatabaseRestore({
        db: database,
        database: parsed.data.database,
        request: parsed.data,
      });
    } catch (error) {
      if (
        error instanceof DatabaseBackupArtifactError
        || error instanceof DatabaseBackupServiceError
      ) {
        return transferErrorResponse(c, error);
      }
      throw new StudioOperationalError('DATABASE_RESTORE_FAILED', {
        cause: error,
        metadata: {
          resource: parsed.data.database === 'studio' ? 'DB' : 'EDGE_DB',
          action: 'finalize_database_restore',
          database: parsed.data.database,
          ...operationsInitiatorMetadata(initiator),
        },
      });
    }
    logOperationalFailure('DATABASE_RESTORE_COMPLETED', {
      metadata: {
        resource: parsed.data.database === 'studio' ? 'DB' : 'EDGE_DB',
        action: 'restore_database',
        database: parsed.data.database,
        mode: result.mode,
        table_count: result.restoredTables.length,
        statement_count: result.restoredStatementCount,
        ...operationsInitiatorMetadata(result.initiator),
      },
    });
    const response: DatabaseRestoreSuccess = {
      success: true,
      data: {
        operation: 'restore_database',
        status: 'completed',
        database: result.database,
        mode: result.mode,
        restored_tables: result.restoredTables,
        restored_statement_count: result.restoredStatementCount,
        schema_fingerprint: result.schemaFingerprint,
      },
    };
    return c.json(response);
  });

  operations.post('/uninstall-studio/preview', bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) {
      return access.response;
    }

    const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
    if (
      siteMode.state === 'invalid'
      || siteMode.mode !== 'maintenance'
    ) {
      return errorResponse(
        c,
        409,
        'OPERATIONS_MAINTENANCE_REQUIRED',
      );
    }

    const systemStatus = await resolveSystemStatus(c.env, siteMode);
    if (systemStatus.database.state !== 'ready') {
      return errorResponse(c, 409, 'SYSTEM_NOT_AVAILABLE');
    }
    if (await isEdgeTargetReconciliationInProgress(c.env.DB)) {
      return errorResponse(c, 409, 'EDGE_TARGET_RECONCILIATION_STATE_CONFLICT');
    }
    if (await isContentSearchIndexRebuildInProgress(c.env.DB)) {
      return errorResponse(
        c,
        409,
        'CONTENT_SEARCH_INDEX_REBUILD_STATE_CONFLICT',
      );
    }

    const administrator = await authorizeOperationPayload(
      c,
      'uninstall_studio',
      authorizeAdministrator,
    );
    if (!administrator.authorized) {
      return administrator.response;
    }

    let inspection: Awaited<ReturnType<InspectUninstallStudio>>;
    try {
      inspection = await executeInspectUninstallStudio(c.env.DB);
    } catch (error) {
      throw new StudioOperationalError(
        'STUDIO_UNINSTALL_PREVIEW_FAILED',
        {
          cause: error,
          metadata: {
            resource: 'DB',
            action: 'preview_uninstall_studio',
            ...operationsInitiatorMetadata(
              authorizedAdministratorInitiator(administrator),
            ),
          },
        },
      );
    }

    const response: UninstallPreviewSuccess = {
      success: true,
      data: {
        operation: 'uninstall_studio',
        expected_effects: {
          deleted_rows: inspection.deletedRows,
        },
      },
    };
    return c.json(response);
  });

  operations.get('/administrator-recovery', async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
    if (siteMode.state === 'invalid' || siteMode.mode !== 'recovery') {
      return errorResponse(
        c,
        409,
        'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE',
      );
    }
    const systemStatus = await resolveSystemStatus(c.env, siteMode);
    if (!isAdministratorRecoveryDatabaseCompatible(
      systemStatus.database.state,
    )) {
      return errorResponse(
        c,
        409,
        'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE',
      );
    }
    const administrators = await executeListRecoverableAdministrators(
      c.env.DB,
    );
    let response: AdministratorRecoveryStatusSuccess;
    if (administrators.length === 0) {
      const availability =
        await executeInspectRecoveryAdministratorBootstrapAvailability({
          db: c.env.DB,
        });
      if (availability !== 'available') {
        return errorResponse(
          c,
          409,
          'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE',
        );
      }
      response = {
        success: true,
        data: {
          mode: 'bootstrap_administrator',
          administrators: [],
          confirmation: administratorRecoveryBootstrapConfirmation,
        },
      };
    } else {
      response = {
        success: true,
        data: {
          mode: 'existing_administrator',
          administrators,
          confirmation: administratorRecoveryConfirmation,
        },
      };
    }
    return c.json(response);
  });

  operations.post('/cloudflare-access/disable', bodyLimit({
    maxSize: 4 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
    if (siteMode.state === 'invalid' || siteMode.mode !== 'recovery') {
      return errorResponse(
        c,
        409,
        'CLOUDFLARE_ACCESS_RECOVERY_NOT_AVAILABLE',
      );
    }
    const systemStatus = await resolveSystemStatus(c.env, siteMode);
    if (!isAdministratorRecoveryDatabaseCompatible(
      systemStatus.database.state,
    )) {
      return errorResponse(
        c,
        409,
        'CLOUDFLARE_ACCESS_RECOVERY_NOT_AVAILABLE',
      );
    }

    const contentType = c.req
      .header('Content-Type')
      ?.split(';')[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 415, 'UNSUPPORTED_MEDIA_TYPE');
    }
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return errorResponse(c, 400, 'INVALID_JSON');
    }
    const parsedBody = cloudflareAccessRecoveryRequestSchema.safeParse(
      rawBody,
    );
    if (!parsedBody.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }

    await executeRecoverCloudflareAccessDisabled({ db: c.env.DB });
    logOperationalFailure('CLOUDFLARE_ACCESS_RECOVERY_COMPLETED', {
      metadata: {
        resource: 'DB',
        action: 'disable_cloudflare_access_requirement',
      },
    });
    return c.json(cloudflareAccessRecoverySuccessSchema.parse({
      success: true,
      data: {
        operation: 'disable_cloudflare_access',
        status: 'completed',
      },
    }));
  });

  operations.post('/administrator-recovery/bootstrap/mfa/setup', bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
    if (siteMode.state === 'invalid' || siteMode.mode !== 'recovery') {
      return errorResponse(
        c,
        409,
        'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE',
      );
    }
    const systemStatus = await resolveSystemStatus(c.env, siteMode);
    if (!isAdministratorRecoveryDatabaseCompatible(
      systemStatus.database.state,
    )) {
      return errorResponse(
        c,
        409,
        'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE',
      );
    }

    const contentType = c.req
      .header('Content-Type')
      ?.split(';')[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 415, 'UNSUPPORTED_MEDIA_TYPE');
    }
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return errorResponse(c, 400, 'INVALID_JSON');
    }
    const parsedBody =
      administratorRecoveryBootstrapMfaSetupRequestSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }

    const administrators = await executeListRecoverableAdministrators(
      c.env.DB,
    );
    if (administrators.length !== 0) {
      return errorResponse(
        c,
        409,
        'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE',
      );
    }
    const availability =
      await executeInspectRecoveryAdministratorBootstrapAvailability({
        db: c.env.DB,
        administratorEmail: parsedBody.data.administrator_email,
      });
    if (availability === 'administrator_exists') {
      return errorResponse(
        c,
        409,
        'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE',
      );
    }
    if (availability === 'email_conflict') {
      return errorResponse(c, 409, 'USER_EMAIL_CONFLICT');
    }
    if (!isConfiguredAuthSecret(c.env.STUDIO_AUTH_SECRET)) {
      return errorResponse(c, 503, 'SYSTEM_CONFIGURATION_ERROR');
    }

    let enrollment;
    try {
      enrollment = await createMfaEnrollment({
        authSecret: c.env.STUDIO_AUTH_SECRET,
        subject: {
          type: 'recovery_bootstrap',
          id: parsedBody.data.administrator_email,
        },
        accountName: parsedBody.data.administrator_email,
      });
    } catch (error) {
      throw new StudioOperationalError(
        'AUTH_MFA_CRYPTO_NOT_AVAILABLE',
        {
          cause: error,
          metadata: {
            component: 'web_crypto',
            action: 'create_recovery_administrator_mfa_enrollment',
          },
        },
      );
    }
    const response: MfaEnrollmentSetupSuccess = {
      success: true,
      data: enrollment,
    };
    return c.json(response);
  });

  operations.post('/administrator-recovery/bootstrap', bodyLimit({
    maxSize: 32 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
    if (siteMode.state === 'invalid' || siteMode.mode !== 'recovery') {
      return errorResponse(
        c,
        409,
        'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE',
      );
    }
    const systemStatus = await resolveSystemStatus(c.env, siteMode);
    if (!isAdministratorRecoveryDatabaseCompatible(
      systemStatus.database.state,
    )) {
      return errorResponse(
        c,
        409,
        'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE',
      );
    }

    const contentType = c.req
      .header('Content-Type')
      ?.split(';')[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 415, 'UNSUPPORTED_MEDIA_TYPE');
    }
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return errorResponse(c, 400, 'INVALID_JSON');
    }
    const parsedBody = administratorRecoveryBootstrapRequestSchema.safeParse(
      rawBody,
    );
    if (!parsedBody.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }

    const administrators = await executeListRecoverableAdministrators(
      c.env.DB,
    );
    if (administrators.length !== 0) {
      return errorResponse(
        c,
        409,
        'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE',
      );
    }
    const availability =
      await executeInspectRecoveryAdministratorBootstrapAvailability({
        db: c.env.DB,
        administratorEmail: parsedBody.data.administrator_email,
      });
    if (availability === 'administrator_exists') {
      return errorResponse(
        c,
        409,
        'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE',
      );
    }
    if (availability === 'email_conflict') {
      return errorResponse(c, 409, 'USER_EMAIL_CONFLICT');
    }

    const passwordAssessment = await assessPasswordAcceptance({
      password: parsedBody.data.new_password,
      email: parsedBody.data.administrator_email,
      displayName: parsedBody.data.administrator_name,
      env: c.env,
    });
    if (!passwordAssessment.allowed) {
      return errorResponse(c, 400, 'WEAK_ADMIN_PASSWORD');
    }
    if (!isConfiguredAuthSecret(c.env.STUDIO_AUTH_SECRET)) {
      return errorResponse(c, 503, 'SYSTEM_CONFIGURATION_ERROR');
    }

    const enrollment = await openMfaEnrollment({
      authSecret: c.env.STUDIO_AUTH_SECRET,
      enrollmentToken: parsedBody.data.mfa.enrollment_token,
    });
    if (
      !enrollment
      || enrollment.subject_type !== 'recovery_bootstrap'
      || enrollment.subject_id !== parsedBody.data.administrator_email
    ) {
      return errorResponse(c, 401, 'MFA_ENROLLMENT_INVALID');
    }
    let proof;
    try {
      proof = await verifyMfaEnrollmentProof({
        enrollment,
        totpCode: parsedBody.data.mfa.totp_code,
      });
    } catch (error) {
      throw new StudioOperationalError(
        'AUTH_MFA_CRYPTO_NOT_AVAILABLE',
        {
          cause: error,
          metadata: {
            component: 'web_crypto',
            action: 'verify_recovery_administrator_mfa_enrollment',
          },
        },
      );
    }
    if (proof.matchedStep === null) {
      return errorResponse(c, 401, 'INVALID_MFA_CODE');
    }

    let encryptedTotpSecret;
    try {
      encryptedTotpSecret = await encryptTotpSecret(
        c.env.STUDIO_AUTH_SECRET,
        enrollment.totp_secret,
      );
    } catch (error) {
      throw new StudioOperationalError(
        'AUTH_MFA_CRYPTO_NOT_AVAILABLE',
        {
          cause: error,
          metadata: {
            component: 'web_crypto',
            action: 'encrypt_recovery_administrator_totp_secret',
          },
        },
      );
    }

    let passwordHash: string;
    try {
      passwordHash = await hashRecoveryPassword(
        parsedBody.data.new_password,
      );
    } catch (error) {
      throw new StudioOperationalError(
        'ADMINISTRATOR_RECOVERY_PASSWORD_HASHING_FAILED',
        {
          cause: error,
          metadata: {
            component: 'argon2id',
            action: 'hash_bootstrap_recovery_administrator_password',
          },
        },
      );
    }

    logOperationalFailure('MAINTENANCE_OPERATION_STARTED', {
      metadata: {
        resource: 'DB',
        action: 'bootstrap_recovery_administrator',
        administrator_count_before: 0,
      },
    });
    const result = await executeBootstrapRecoveryAdministrator({
      db: c.env.DB,
      administratorName: parsedBody.data.administrator_name,
      administratorEmail: parsedBody.data.administrator_email,
      passwordHash,
      encryptedTotpSecret,
      lastUsedStep: proof.matchedStep,
    });
    if (result.state === 'administrator_exists') {
      return errorResponse(
        c,
        409,
        'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE',
      );
    }
    if (result.state === 'email_conflict') {
      return errorResponse(c, 409, 'USER_EMAIL_CONFLICT');
    }

    logOperationalFailure('ADMINISTRATOR_RECOVERY_COMPLETED', {
      metadata: {
        resource: 'DB',
        action: 'bootstrap_recovery_administrator',
        created_user_id: result.administratorId,
        administrator_count_before: 0,
        mfa_enrolled: true,
      },
    });
    const response: AdministratorRecoveryBootstrapSuccess = {
      success: true,
      data: {
        operation: 'bootstrap_recovery_administrator',
        status: 'completed',
        mfa_enrolled: true,
      },
    };
    return c.json(response);
  });

  operations.post('/administrator-recovery', bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const access = await authorizeOperationsRequest(c);
    if (!access.authorized) return access.response;
    const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
    if (siteMode.state === 'invalid' || siteMode.mode !== 'recovery') {
      return errorResponse(
        c,
        409,
        'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE',
      );
    }
    const systemStatus = await resolveSystemStatus(c.env, siteMode);
    if (!isAdministratorRecoveryDatabaseCompatible(
      systemStatus.database.state,
    )) {
      return errorResponse(
        c,
        409,
        'ADMINISTRATOR_RECOVERY_NOT_AVAILABLE',
      );
    }

    const contentType = c.req
      .header('Content-Type')
      ?.split(';')[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== 'application/json') {
      return errorResponse(c, 415, 'UNSUPPORTED_MEDIA_TYPE');
    }
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return errorResponse(c, 400, 'INVALID_JSON');
    }
    const parsedBody = administratorRecoveryRequestSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }

    const administrators = await executeListRecoverableAdministrators(
      c.env.DB,
    );
    const administrator = administrators.find(
      (candidate) =>
        candidate.id === parsedBody.data.administrator_id,
    );
    if (!administrator) {
      return errorResponse(c, 404, 'ADMINISTRATOR_NOT_FOUND');
    }
    const passwordAssessment = await assessPasswordAcceptance({
      password: parsedBody.data.new_password,
      email: administrator.email,
      displayName: administrator.name,
      env: c.env,
    });
    if (!passwordAssessment.allowed) {
      return errorResponse(c, 400, 'WEAK_ADMIN_PASSWORD');
    }

    let passwordHash: string;
    try {
      passwordHash = await hashRecoveryPassword(
        parsedBody.data.new_password,
      );
    } catch (error) {
      throw new StudioOperationalError(
        'ADMINISTRATOR_RECOVERY_PASSWORD_HASHING_FAILED',
        {
          cause: error,
          metadata: {
            component: 'argon2id',
            action: 'hash_recovered_administrator_password',
          },
        },
      );
    }

    logOperationalFailure('MAINTENANCE_OPERATION_STARTED', {
      metadata: {
        resource: 'DB',
        action: 'recover_administrator',
      },
    });
    const recovered = await executeRecoverAdministratorAccess({
      db: c.env.DB,
      administratorId: administrator.id,
      passwordHash,
      resetMfa: parsedBody.data.reset_mfa,
    });
    if (!recovered) {
      return errorResponse(c, 404, 'ADMINISTRATOR_NOT_FOUND');
    }
    logOperationalFailure('ADMINISTRATOR_RECOVERY_COMPLETED', {
      metadata: {
        resource: 'DB',
        action: 'recover_administrator',
        mfa_reset: parsedBody.data.reset_mfa,
      },
    });
    const response: AdministratorRecoverySuccess = {
      success: true,
      data: {
        operation: 'recover_administrator',
        status: 'completed',
        mfa_reset: parsedBody.data.reset_mfa,
      },
    };
    return c.json(response);
  });

  const registerOperation = (
    path: string,
    action: OperationsAction,
    requiresMaintenance: boolean,
    edgePolicy: 'conditional' | 'none',
    execute: (input: {
      db: D1Database;
      edgeDb: D1Database | null;
      mediaBucket?: R2Bucket;
      administratorId: string;
    }) => Promise<DatabaseOperationResult>,
    failureCode:
      | 'CLEAR_SITE_CONTENT_FAILED'
      | 'STUDIO_RESET_FAILED'
      | 'STUDIO_UNINSTALL_FAILED',
    completionCode:
      | 'CLEAR_SITE_CONTENT_COMPLETED'
      | 'STUDIO_RESET_COMPLETED'
      | 'STUDIO_UNINSTALL_COMPLETED',
  ) => {
    operations.post(path, bodyLimit({
      maxSize: 16 * 1024,
      onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
    }), async (c) => {
      const access = await authorizeOperationsRequest(c);
      if (!access.authorized) {
        return access.response;
      }

      const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
      if (
        siteMode.state === 'invalid'
        || (
          requiresMaintenance
          && siteMode.mode !== 'maintenance'
        )
      ) {
        return errorResponse(
          c,
          409,
          requiresMaintenance
            ? 'OPERATIONS_MAINTENANCE_REQUIRED'
            : 'SYSTEM_NOT_AVAILABLE',
        );
      }
      if (
        !requiresMaintenance
        && siteMode.mode !== 'operational'
        && siteMode.mode !== 'maintenance'
      ) {
        return errorResponse(c, 409, 'SYSTEM_NOT_AVAILABLE');
      }

      const systemStatus = await resolveSystemStatus(c.env, siteMode);
      if (systemStatus.database.state !== 'ready') {
        return errorResponse(c, 409, 'SYSTEM_NOT_AVAILABLE');
      }
      if (await isEdgeTargetReconciliationInProgress(c.env.DB)) {
        return errorResponse(
          c,
          409,
          'EDGE_TARGET_RECONCILIATION_STATE_CONFLICT',
        );
      }
      if (await isContentSearchIndexRebuildInProgress(c.env.DB)) {
        return errorResponse(
          c,
          409,
          'CONTENT_SEARCH_INDEX_REBUILD_STATE_CONFLICT',
        );
      }

      const edgeIntegrationMode = edgePolicy === 'conditional'
        ? await readEdgeIntegrationMode({ db: c.env.DB })
        : 'disabled';
      const usesEdge = edgePolicy === 'conditional'
        && edgeIntegrationMode === 'enabled';
      if (usesEdge) {
        const edgeDatabase = await inspectEdgeDatabase({
          edgeDb: c.env.EDGE_DB,
          siteMode: siteMode.mode,
        });
        const readinessError = edgeDestructiveOperationError(
          edgeDatabase.state,
        );
        if (readinessError) {
          if (edgeDatabase.state === 'unavailable') {
            logStudioOperationalError(edgeHealthFailure({
              reason: 'database_unavailable',
            }), {
              method: c.req.method,
              pathname: new URL(c.req.url).pathname,
            });
          }
          return errorResponse(
            c,
            readinessError.status,
            readinessError.code,
          );
        }
      }
      const edgeDb = usesEdge
        ? requireEdgeDatabase(c.env)
        : null;

      const administrator = await authorizeOperationPayload(
        c,
        action,
        authorizeAdministrator,
      );
      if (!administrator.authorized) {
        return administrator.response;
      }

      logOperationalFailure('MAINTENANCE_OPERATION_STARTED', {
        metadata: {
          resource: 'DB',
          action,
          ...(usesEdge ? { related_resource: 'EDGE_DB' } : {}),
          ...operationsInitiatorMetadata(
            authorizedAdministratorInitiator(administrator),
          ),
        },
      });

      let result: DatabaseOperationResult;
      try {
        result = await execute({
          db: c.env.DB,
          edgeDb,
          mediaBucket: dependencies.managedMediaStorageEnabled === false
            ? undefined
            : c.env.MEDIA_BUCKET,
          administratorId: administrator.administratorId,
        });
      } catch (error) {
        if (error instanceof StudioOperationalError) {
          throw attributeOperationalError(
            error,
            authorizedAdministratorInitiator(administrator),
          );
        }
        throw new StudioOperationalError(failureCode, {
          cause: error,
          metadata: {
            resource: 'DB',
            action,
            ...(usesEdge
              ? { related_resource: 'EDGE_DB' }
              : {}),
            ...operationsInitiatorMetadata(
              authorizedAdministratorInitiator(administrator),
            ),
          },
        });
      }

      const effects: OperationsSuccess['data']['effects'] = {
        deleted_rows: result.deletedRows,
        inserted_rows: result.insertedRows,
        updated_rows: result.updatedRows,
      };

      logOperationalFailure(completionCode, {
        metadata: {
          resource: 'DB',
          action,
          ...(usesEdge ? { related_resource: 'EDGE_DB' } : {}),
          affected_table_count: new Set([
            ...Object.keys(result.deletedRows),
            ...Object.keys(result.insertedRows),
            ...Object.keys(result.updatedRows),
          ]).size,
          effects,
          ...operationsInitiatorMetadata(
            authorizedAdministratorInitiator(administrator),
          ),
        },
      });

      const response: OperationsSuccess = {
        success: true,
        data: {
          operation: action,
          status: 'completed',
          effects,
          resources: {
            studio: 'completed',
            edge: edgePolicy === 'none'
              ? 'not_applicable'
              : usesEdge
                ? 'completed'
                : 'skipped_disabled',
          },
        },
      };
      return c.json(response);
    });
  };

  registerOperation(
    '/clear-content',
    'clear_site_content',
    false,
    'conditional',
    ({ db, edgeDb, mediaBucket, administratorId }) => edgeDb
      ? executeClearSiteContent({
          db, edgeDb, mediaBucket, administratorId,
        })
      : executeClearStudioContent({ db, mediaBucket, administratorId }),
    'CLEAR_SITE_CONTENT_FAILED',
    'CLEAR_SITE_CONTENT_COMPLETED',
  );
  registerOperation(
    '/reset-studio',
    'reset_studio',
    true,
    'conditional',
    ({ db, edgeDb, mediaBucket, administratorId }) => edgeDb
      ? executeResetStudio({
          db, edgeDb, mediaBucket, administratorId,
        })
      : executeResetStudioDatabase({ db, mediaBucket, administratorId }),
    'STUDIO_RESET_FAILED',
    'STUDIO_RESET_COMPLETED',
  );
  registerOperation(
    '/uninstall-studio',
    'uninstall_studio',
    true,
    'none',
    ({ db }) => executeUninstallStudio(db),
    'STUDIO_UNINSTALL_FAILED',
    'STUDIO_UNINSTALL_COMPLETED',
  );

  return operations;
}
