import { auditMiddleware } from './audit/service';
import { createAuditRoutes } from './audit/routes';
import {
  createPublishingRoutes,
  createPublishingSettingsRoutes,
  type PublishingRouteDependencies,
} from './publishing/routes';
import {
  createAnalyticsRoutes,
  createAnalyticsSettingsRoutes,
  type AnalyticsRouteDependencies,
} from './analytics/routes';
import { Hono } from 'hono';
import type { CredentialsAuthenticator } from './auth/routes';
import { createAuthRoutes } from './auth/routes';
import type { CheckPasswordBreach } from './auth/password-breach-service';
import type {
  IssueUserSession,
  ListUserSessions,
  ResolveUserSession,
  RevokeOtherUserSessions,
  RevokeUserSession,
} from './auth/session-repository';
import type {
  InstallDatabase,
  InstallPasswordHasher,
} from './system/routes';
import { errorResponse } from './lib/http';
import {
  logOperationalFailure,
  logStudioOperationalError,
  StudioOperationalError,
} from './lib/operational-error';
import { runScheduledSessionMaintenance } from './auth/session-maintenance';
import type {
  ClearSiteContent,
  ClearStudioContent,
  ApplySchemaUpgradeStep,
  ApplyDatabaseRestoreChunk,
  ExportDatabaseBackup,
  FinalizeDatabaseRestore,
  InspectUninstallStudio,
  InspectSchemaUpgrade,
  BootstrapRecoveryAdministrator,
  InspectRecoveryAdministratorBootstrapAvailability,
  ListRecoverableAdministrators,
  OperationsAdministratorAuthorizer,
  RecoverAdministratorAccess,
  RecoveryPasswordHasher,
  ResetStudio,
  ResetStudioDatabase,
  StartDatabaseRestore,
  StartSchemaUpgrade,
  UninstallStudioDatabase,
  OperationsDependencies,
} from './operations/routes';
import { createOperationsRoutes } from './operations/routes';
import { createSystemGate } from './system/gate';
import { createSystemRoutes } from './system/routes';
import type { Env, StudioHonoEnvironment } from './types';
import { createUserRoutes } from './users/routes';
import { createGeneralSettingsRoutes } from './settings/general-settings-routes';
import { createOutputSettingsRoutes } from './settings/output-settings-routes';
import {
  createCommentSettingsRoutes,
  type CommentSettingsRouteDependencies,
} from './settings/comment-settings-routes';
import {
  createEdgeSecuritySettingsRoutes,
  type EdgeSecuritySettingsRouteDependencies,
} from './settings/edge-security-settings-routes';
import {
  createRoutingSettingsRoutes,
  type RoutingSettingsRouteDependencies,
} from './settings/routing-settings-routes';
import { createPreviewDataRoutes } from './preview-data/routes';
import {
  createAuthorRoutes,
  type AuthorRouteDependencies,
} from './authors/routes';
import {
  createTaxonomyRoutes,
  type TaxonomyRouteDependencies,
} from './taxonomies/routes';
import {
  createPostRoutes,
  type PostRouteDependencies,
} from './posts/routes';
import {
  createPageRoutes,
  type PageRouteDependencies,
} from './pages/routes';
import {
  createMenuRoutes,
  type MenuRouteDependencies,
} from './menus/routes';
import {
  createWidgetRoutes,
  type WidgetRouteDependencies,
} from './widgets/routes';
import {
  createCommentManagementRoutes,
  type CommentManagementRouteDependencies,
} from './comments/management-routes';
import {
  createManagedMediaReferenceRoutes,
  createMediaRoutes,
  type MediaRouteDependencies,
} from './media/routes';
import {
  createMediaSettingsRoutes,
  type MediaSettingsRouteDependencies,
} from './settings/media-settings-routes';
import {
  createSiteBrandingRoutes,
  type SiteBrandingRouteDependencies,
} from './settings/branding-settings-routes';
import {
  createCustomCodeSettingsRoutes,
  type CustomCodeSettingsRouteDependencies,
} from './settings/custom-code-settings-routes';
import {
  createNewsletterSettingsRoutes,
  type NewsletterSettingsRouteDependencies,
} from './settings/newsletter-settings-routes';
import {
  createWxrCoreImportRoutes,
  type WxrCoreImportRouteDependencies,
} from './imports/wxr-core-import-routes';
import {
  createMailRoutes,
  type MailRouteDependencies,
} from './mail/routes';
import {
  createNewsletterRoutes,
  type NewsletterRouteDependencies,
} from './newsletters/routes';
import { handleEdgeMailQueue } from './newsletters/mail-queue';
import {
  createFormRoutes,
  type FormRouteDependencies,
} from './forms/routes';
import {
  createDashboardRoutes,
  type DashboardRouteDependencies,
} from './dashboard/routes';
import {
  createContentSearchIndexRoutes,
  type ContentSearchIndexRouteDependencies,
} from './content-search/routes';
import {
  createStudioInterfaceSettingsRoutes,
  type StudioInterfaceSettingsRouteDependencies,
} from './settings/studio-interface-settings-routes';
import {
  createEdgeServicesRoutes,
  type EdgeServicesRouteDependencies,
} from './settings/edge-services-routes';
import {
  COMMENT_TARGET_OUTBOX_MAINTENANCE_LIMIT,
  drainCommentTargetProjectionOutbox,
} from './comments/target-projection-outbox';
import type { PrepareInitialEdgeSetup } from './system/initial-edge-setup';
import {
  createCloudflareAccessGate,
  type CloudflareAccessGateDependencies,
} from './access/gate';
import {
  createCloudflareAccessRoutes,
  type CloudflareAccessRouteDependencies,
} from './access/routes';

const MANAGED_MEDIA_STORAGE_ENABLED =
  typeof __ZEROPRESS_MANAGED_MEDIA_STORAGE_ENABLED__ === 'undefined'
  || __ZEROPRESS_MANAGED_MEDIA_STORAGE_ENABLED__;

export function createApp(dependencies?: {
  analytics?: AnalyticsRouteDependencies;
  publishing?: PublishingRouteDependencies;
  authenticate?: CredentialsAuthenticator;
  issueSession?: IssueUserSession;
  listSessions?: ListUserSessions;
  resolveSession?: ResolveUserSession;
  revokeOtherSessions?: RevokeOtherUserSessions;
  revokeSession?: RevokeUserSession;
  installDatabase?: InstallDatabase;
  hashInstallPassword?: InstallPasswordHasher;
  checkPasswordBreach?: CheckPasswordBreach;
  prepareInitialEdgeSetup?: PrepareInitialEdgeSetup;
  authorizeOperationsAdministrator?: OperationsAdministratorAuthorizer;
  clearSiteContent?: ClearSiteContent;
  clearStudioContent?: ClearStudioContent;
  exportDatabaseBackup?: ExportDatabaseBackup;
  inspectUninstallStudio?: InspectUninstallStudio;
  resetStudio?: ResetStudio;
  resetStudioDatabase?: ResetStudioDatabase;
  startDatabaseRestore?: StartDatabaseRestore;
  applyDatabaseRestoreChunk?: ApplyDatabaseRestoreChunk;
  finalizeDatabaseRestore?: FinalizeDatabaseRestore;
  inspectSchemaUpgrade?: InspectSchemaUpgrade;
  startSchemaUpgrade?: StartSchemaUpgrade;
  applySchemaUpgradeStep?: ApplySchemaUpgradeStep;
  uninstallStudioDatabase?: UninstallStudioDatabase;
  listRecoverableAdministrators?: ListRecoverableAdministrators;
  recoverAdministratorAccess?: RecoverAdministratorAccess;
  bootstrapRecoveryAdministrator?: BootstrapRecoveryAdministrator;
  inspectRecoveryAdministratorBootstrapAvailability?:
    InspectRecoveryAdministratorBootstrapAvailability;
  hashRecoveryPassword?: RecoveryPasswordHasher;
  authors?: AuthorRouteDependencies;
  taxonomies?: TaxonomyRouteDependencies;
  posts?: PostRouteDependencies;
  pages?: PageRouteDependencies;
  menus?: MenuRouteDependencies;
  widgets?: WidgetRouteDependencies;
  routingSettings?: RoutingSettingsRouteDependencies;
  commentSettings?: CommentSettingsRouteDependencies;
  edgeSecuritySettings?: EdgeSecuritySettingsRouteDependencies;
  comments?: CommentManagementRouteDependencies;
  media?: MediaRouteDependencies;
  mediaSettings?: MediaSettingsRouteDependencies;
  siteBranding?: SiteBrandingRouteDependencies;
  customCodeSettings?: CustomCodeSettingsRouteDependencies;
  newsletterSettings?: NewsletterSettingsRouteDependencies;
  newsletters?: NewsletterRouteDependencies;
  forms?: FormRouteDependencies;
  dashboard?: DashboardRouteDependencies;
  contentSearchIndex?: ContentSearchIndexRouteDependencies;
  mail?: MailRouteDependencies;
  wxrImport?: WxrCoreImportRouteDependencies;
  studioInterfaceSettings?: StudioInterfaceSettingsRouteDependencies;
  edgeServices?: EdgeServicesRouteDependencies;
  cloudflareAccess?: CloudflareAccessGateDependencies
    & CloudflareAccessRouteDependencies;
  operations?: OperationsDependencies;
}) {
  const app = new Hono<StudioHonoEnvironment>();

  app.use('/api/*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
  });

  app.use('/__zeropress_media__/*', async (c, next) => {
    await next();
    if (!c.res.headers.has('Cache-Control')) {
      c.header('Cache-Control', 'no-store');
    }
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
  });

  app.use('/api/*', auditMiddleware);
  app.use('/api/*', createSystemGate());
  app.use('/__zeropress_media__/*', createSystemGate());
  app.use('/api/*', createCloudflareAccessGate(
    dependencies?.cloudflareAccess,
  ));
  app.use('/__zeropress_media__/*', createCloudflareAccessGate(
    dependencies?.cloudflareAccess,
  ));
  app.route('/api/audit-logs', createAuditRoutes({ resolveSession: dependencies?.resolveSession }));
  app.route('/api/system', createSystemRoutes({
    resolveSession: dependencies?.resolveSession,
    installDatabase: dependencies?.installDatabase,
    hashInstallPassword: dependencies?.hashInstallPassword,
    checkPasswordBreach: dependencies?.checkPasswordBreach,
    prepareEdgeSetup: dependencies?.prepareInitialEdgeSetup,
    readInterfaceSettings:
      dependencies?.studioInterfaceSettings?.readSettings,
  }));
  app.route('/api/system/operations', createOperationsRoutes({
    ...dependencies?.operations,
    resolveSession: dependencies?.resolveSession,
    authorizeAdministrator: dependencies?.authorizeOperationsAdministrator,
    clearSiteContent: dependencies?.clearSiteContent,
    clearStudioContent: dependencies?.clearStudioContent,
    exportDatabaseBackup: dependencies?.exportDatabaseBackup,
    inspectUninstallStudio: dependencies?.inspectUninstallStudio,
    resetStudio: dependencies?.resetStudio,
    resetStudioDatabase: dependencies?.resetStudioDatabase,
    startDatabaseRestore: dependencies?.startDatabaseRestore,
    applyDatabaseRestoreChunk: dependencies?.applyDatabaseRestoreChunk,
    finalizeDatabaseRestore: dependencies?.finalizeDatabaseRestore,
    inspectSchemaUpgrade: dependencies?.inspectSchemaUpgrade,
    startSchemaUpgrade: dependencies?.startSchemaUpgrade,
    applySchemaUpgradeStep: dependencies?.applySchemaUpgradeStep,
    uninstallStudioDatabase: dependencies?.uninstallStudioDatabase,
    listRecoverableAdministrators:
      dependencies?.listRecoverableAdministrators,
    recoverAdministratorAccess:
      dependencies?.recoverAdministratorAccess,
    bootstrapRecoveryAdministrator:
      dependencies?.bootstrapRecoveryAdministrator,
    inspectRecoveryAdministratorBootstrapAvailability:
      dependencies?.inspectRecoveryAdministratorBootstrapAvailability,
    hashRecoveryPassword: dependencies?.hashRecoveryPassword,
    managedMediaStorageEnabled: MANAGED_MEDIA_STORAGE_ENABLED,
  }));
  app.route('/api/auth', createAuthRoutes({
    authenticator: dependencies?.authenticate,
    issueSession: dependencies?.issueSession,
    listSessions: dependencies?.listSessions,
    resolveSession: dependencies?.resolveSession,
    revokeOtherSessions: dependencies?.revokeOtherSessions,
    revokeSession: dependencies?.revokeSession,
  }));
  app.route('/api/dashboard', createDashboardRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.dashboard,
  }));
  app.route('/api/content-search-index', createContentSearchIndexRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.contentSearchIndex,
  }));
  app.route('/api/users', createUserRoutes({
    resolveSession: dependencies?.resolveSession,
  }));
  app.route('/api/authors', createAuthorRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.authors,
  }));
  app.route('/api/taxonomies', createTaxonomyRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.taxonomies,
  }));
  app.route('/api/posts', createPostRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.posts,
  }));
  app.route('/api/pages', createPageRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.pages,
  }));
  app.route('/__zeropress_media__', createManagedMediaReferenceRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.media,
    managedUploadsEnabled:
      dependencies?.media?.managedUploadsEnabled
      ?? MANAGED_MEDIA_STORAGE_ENABLED,
  }));
  app.route('/api/media', createMediaRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.media,
    managedUploadsEnabled:
      dependencies?.media?.managedUploadsEnabled
      ?? MANAGED_MEDIA_STORAGE_ENABLED,
  }));
  app.route('/api/menus', createMenuRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.menus,
  }));
  app.route('/api/widgets', createWidgetRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.widgets,
  }));
  app.route('/api/settings/publishing', createPublishingSettingsRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.publishing,
  }));
  app.route('/api/publishing', createPublishingRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.publishing,
  }));
  app.route('/api/settings/analytics', createAnalyticsSettingsRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.analytics,
  }));
  app.route('/api/analytics', createAnalyticsRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.analytics,
  }));
  app.route('/api/settings/general', createGeneralSettingsRoutes({
    resolveSession: dependencies?.resolveSession,
  }));
  app.route('/api/settings/interface', createStudioInterfaceSettingsRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.studioInterfaceSettings,
  }));
  app.route('/api/settings/access', createCloudflareAccessRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.cloudflareAccess,
  }));
  app.route('/api/settings/edge-services', createEdgeServicesRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.edgeServices,
  }));
  app.route('/api/settings/output', createOutputSettingsRoutes({
    resolveSession: dependencies?.resolveSession,
  }));
  app.route('/api/settings/routing', createRoutingSettingsRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.routingSettings,
  }));
  app.route('/api/settings/comments', createCommentSettingsRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.commentSettings,
  }));
  app.route('/api/settings/edge-security', createEdgeSecuritySettingsRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.edgeSecuritySettings,
  }));
  app.route('/api/settings/media', createMediaSettingsRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.mediaSettings,
  }));
  app.route('/api/settings/branding', createSiteBrandingRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.siteBranding,
  }));
  app.route('/api/settings/custom-code', createCustomCodeSettingsRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.customCodeSettings,
  }));
  app.route('/api/settings/newsletter', createNewsletterSettingsRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.newsletterSettings,
  }));
  app.route('/api/settings/mail', createMailRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.mail,
  }));
  app.route('/api/newsletters', createNewsletterRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.newsletters,
  }));
  app.route('/api/forms', createFormRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.forms,
  }));
  app.route('/api/comments', createCommentManagementRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.comments,
  }));
  app.route('/api/preview-data', createPreviewDataRoutes({
    resolveSession: dependencies?.resolveSession,
  }));
  app.route('/api/imports/wxr', createWxrCoreImportRoutes({
    resolveSession: dependencies?.resolveSession,
    ...dependencies?.wxrImport,
  }));

  app.notFound((c) => errorResponse(c, 404, 'NOT_FOUND'));
  app.onError((error, c) => {
    const requestMetadata = {
      method: c.req.method,
      pathname: new URL(c.req.url).pathname,
    };

    if (error instanceof StudioOperationalError) {
      logStudioOperationalError(error, requestMetadata);
      if (
        error.code === 'AUTH_RATE_LIMIT_STORE_NOT_AVAILABLE'
        || error.code === 'CLIENT_IP_NOT_AVAILABLE'
      ) {
        return errorResponse(c, 503, 'SYSTEM_NOT_AVAILABLE');
      }
      if (
        error.code === 'SITE_SETTINGS_INCOMPLETE'
        || error.code === 'SITE_ROUTING_SETTINGS_INCOMPLETE'
      ) {
        return errorResponse(c, 409, error.code);
      }
      if (
        error.code === 'SITE_SETTINGS_DATA_INVALID'
        || error.code === 'SITE_ROUTING_SETTINGS_DATA_INVALID'
      ) {
        return errorResponse(c, 500, error.code);
      }
      if (
        error.code === 'CONTENT_SEARCH_INDEX_STATE_QUERY_FAILED'
        || error.code === 'CONTENT_SEARCH_INDEX_QUERY_FAILED'
      ) {
        return errorResponse(c, 503, 'CONTENT_SEARCH_INDEX_UNAVAILABLE');
      }
      if (error.code.startsWith('CLOUDFLARE_ACCESS_SETTINGS_')) {
        return errorResponse(
          c,
          503,
          'CLOUDFLARE_ACCESS_VERIFICATION_UNAVAILABLE',
        );
      }
      const pathname = requestMetadata.pathname;
      const edgeFeatureRequest = pathname === '/api/comments'
        || pathname.startsWith('/api/comments/')
        || pathname === '/api/forms'
        || pathname.startsWith('/api/forms/')
        || pathname === '/api/newsletters'
        || pathname.startsWith('/api/newsletters/')
        || pathname === '/api/settings/comments'
        || pathname.startsWith('/api/settings/comments/')
        || pathname === '/api/settings/edge-security'
        || pathname.startsWith('/api/settings/edge-security/')
        || pathname === '/api/publishing'
        || pathname === '/api/preview-data'
        || pathname.startsWith('/api/preview-data/')
        || pathname === '/api/imports/wxr'
        || pathname.startsWith('/api/imports/wxr/');
      if (
        edgeFeatureRequest
        && (
          error.operationalMetadata.resource === 'EDGE_DB'
          || error.operationalMetadata.resource === 'EDGE_KV'
          || error.code.includes('_EDGE_DATABASE_NOT_CONFIGURED')
          || error.code.includes('_EDGE_CACHE_NOT_CONFIGURED')
        )
      ) {
        return errorResponse(c, 503, 'EDGE_INTEGRATION_UNAVAILABLE');
      }
    } else {
      logOperationalFailure('UNHANDLED_STUDIO_API_ERROR', {
        cause: error,
        metadata: requestMetadata,
      });
    }

    return errorResponse(c, 500, 'INTERNAL_ERROR');
  });

  return app;
}

const app = createApp();

export async function handleScheduledSessionMaintenance(
  env: Env,
  runMaintenance: typeof runScheduledSessionMaintenance =
    runScheduledSessionMaintenance,
): Promise<void> {
  try {
    const result = await runMaintenance(env, {
      managedMediaStorageEnabled: MANAGED_MEDIA_STORAGE_ENABLED,
    });
    if (result.status === 'completed' && result.deleted_rows > 0) {
      logOperationalFailure(
        'AUTH_SESSION_GARBAGE_COLLECTION_COMPLETED',
        {
          metadata: {
            resource: 'DB',
            action: 'garbage_collect_sessions',
            cutoff_at_iso: result.cutoff_at_iso,
            deleted_rows: result.deleted_rows,
          },
        },
      );
    }
    if (
      result.status === 'completed'
      && result.deleted_webauthn_challenges > 0
    ) {
      logOperationalFailure(
        'AUTH_WEBAUTHN_CHALLENGE_GARBAGE_COLLECTION_COMPLETED',
        {
          metadata: {
            resource: 'DB',
            action: 'garbage_collect_webauthn_challenges',
            cutoff_at_iso: result.cutoff_at_iso,
            deleted_rows: result.deleted_webauthn_challenges,
          },
        },
      );
    }
    if (
      result.status === 'completed'
      && result.deleted_media_upload_intents > 0
    ) {
      logOperationalFailure(
        'MEDIA_UPLOAD_INTENT_GARBAGE_COLLECTION_COMPLETED',
        {
          metadata: {
            resource: 'DB',
            action: 'garbage_collect_media_upload_intents',
            cutoff_at_iso: result.cutoff_at_iso,
            deleted_rows: result.deleted_media_upload_intents,
          },
        },
      );
    }
    if (
      result.status === 'completed'
      && result.deleted_media_objects > 0
    ) {
      logOperationalFailure('MEDIA_OBJECT_CLEANUP_COMPLETED', {
        metadata: {
          resource: 'MEDIA_BUCKET',
          related_resource: 'DB',
          action: 'delete_queued_media_objects',
          deleted_rows: result.deleted_media_objects,
        },
      });
    }
    if (
      result.status === 'completed'
      && result.deleted_content_autosaves > 0
    ) {
      logOperationalFailure(
        'CONTENT_AUTOSAVE_GARBAGE_COLLECTION_COMPLETED',
        {
          metadata: {
            resource: 'DB',
            action: 'garbage_collect_content_autosaves',
            cutoff_at_iso: result.cutoff_at_iso,
            deleted_rows: result.deleted_content_autosaves,
          },
        },
      );
    }
  } catch (error) {
    if (error instanceof StudioOperationalError) {
      logStudioOperationalError(error, { trigger: 'scheduled' });
    } else {
      logOperationalFailure(
        'AUTH_SESSION_GARBAGE_COLLECTION_FAILED',
        {
          cause: error,
          metadata: {
            resource: 'DB',
            action: 'garbage_collect_sessions',
            trigger: 'scheduled',
          },
        },
      );
    }
    throw error;
  }
}

export async function handleScheduledEdgeProjectionMaintenance(
  env: Env,
  drain: typeof drainCommentTargetProjectionOutbox =
    drainCommentTargetProjectionOutbox,
): Promise<void> {
  try {
    await drain({
      env,
      limit: COMMENT_TARGET_OUTBOX_MAINTENANCE_LIMIT,
    });
  } catch (error) {
    if (error instanceof StudioOperationalError) {
      logStudioOperationalError(error, { trigger: 'scheduled' });
      return;
    }
    logOperationalFailure('COMMENT_TARGET_OUTBOX_DRAIN_FAILED', {
      cause: error,
      metadata: {
        trigger: 'scheduled',
        action: 'drain_comment_target_projection_outbox',
      },
    });
  }
}

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    await handleEdgeMailQueue(batch, env);
  },
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    let studioMaintenanceError: unknown;
    try {
      await handleScheduledSessionMaintenance(env);
    } catch (error) {
      studioMaintenanceError = error;
    }
    await handleScheduledEdgeProjectionMaintenance(env);
    if (studioMaintenanceError !== undefined) throw studioMaintenanceError;
  },
} satisfies ExportedHandler<Env>;
