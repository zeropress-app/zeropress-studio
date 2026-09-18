import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  type InstallAccessResponse,
  installMfaSetupRequestSchema,
  installRequestSchema,
  type InstallMfaSetupResponse,
  type InstallSuccess,
} from '../../../contracts/install';
import type { MfaEnrollmentSetupSuccess } from '../../../contracts/mfa';
import type { SystemStatusResponse } from '../../../contracts/system';
import {
  resolveOperationsConfiguration,
  resolveOperationsRequestBoundary,
  synchronizeOperationsConfigurationIncident,
} from '../operations/access';
import { hashPassword } from '../auth/password';
import type { ResolveUserSession } from '../auth/session-repository';
import {
  createMfaEnrollment,
  encryptTotpSecret,
  isConfiguredAuthSecret,
  openMfaEnrollment,
  verifyMfaEnrollmentProof,
} from '../auth/mfa-crypto';
import {
  readBearerToken,
  secretTokensMatch,
} from '../lib/bearer-token';
import { errorResponse, requireClientIp } from '../lib/http';
import {
  logOperationalFailure,
  StudioOperationalError,
} from '../lib/operational-error';
import type { StudioHonoEnvironment } from '../types';
import {
  installStudioDatabase,
  type InstallDatabaseInput,
} from './install-database';
import {
  resolveSystemStatus,
  synchronizeSiteModeIncident,
} from './resolve-system-status';
import { STUDIO_SCHEMA_VERSION } from './schema-version';
import { hasConfiguredInstallToken, resolveSiteMode } from './site-mode';
import { publicInterfaceConfigSuccessSchema } from '../../../contracts/studio-interface-settings';
import { readStudioInterfaceSettings } from '../settings/studio-interface-settings-repository';
import {
  InitialEdgeSetupError,
  prepareInitialEdgeSetup,
  type PrepareInitialEdgeSetup,
} from './initial-edge-setup';
import {
  assessPasswordAcceptance,
  type CheckPasswordBreach,
} from '../auth/password-breach-service';

export type InstallDatabase = (
  input: InstallDatabaseInput,
) => Promise<void>;

export type InstallPasswordHasher = (
  password: string,
) => Promise<string>;

type InstallAuthorization =
  | {
      authorized: true;
      siteMode: { state: 'valid'; mode: 'initial' };
    }
  | { authorized: false; response: Response };

function isSameOriginRequest(c: Context<StudioHonoEnvironment>): boolean {
  const origin = c.req.header('Origin');
  return origin === undefined || origin === new URL(c.req.url).origin;
}

async function rejectInstallAuthenticationAttempt(
  c: Context<StudioHonoEnvironment>,
): Promise<Response> {
  const clientIp = requireClientIp(c);
  let rateLimit: { success: boolean };
  try {
    rateLimit = await c.env.AUTH_ROUTE_RATE_LIMITER.limit({
      key: `install:${clientIp}`,
    });
  } catch (error) {
    throw new StudioOperationalError(
      'INSTALL_ROUTE_RATE_LIMITER_NOT_AVAILABLE',
      {
        cause: error,
        metadata: {
          resource: 'AUTH_ROUTE_RATE_LIMITER',
          action: 'limit_install_authentication_attempt',
        },
      },
    );
  }
  if (!rateLimit.success) {
    c.header('Retry-After', '60');
    return errorResponse(c, 429, 'RATE_LIMIT_EXCEEDED');
  }
  return errorResponse(c, 401, 'INVALID_INSTALL_TOKEN');
}

async function authorizeInstallRequest(
  c: Context<StudioHonoEnvironment>,
): Promise<InstallAuthorization> {
  const siteMode = resolveSiteMode(c.env.STUDIO_SITE_MODE);
  synchronizeSiteModeIncident(siteMode);
  if (siteMode.state === 'invalid') {
    return {
      authorized: false,
      response: errorResponse(c, 503, 'SYSTEM_CONFIGURATION_ERROR'),
    };
  }
  if (siteMode.mode !== 'initial') {
    return {
      authorized: false,
      response: errorResponse(c, 409, 'INSTALLATION_NOT_AVAILABLE'),
    };
  }
  if (!isSameOriginRequest(c)) {
    return {
      authorized: false,
      response: errorResponse(c, 403, 'FORBIDDEN'),
    };
  }

  const initialStatus = await resolveSystemStatus(c.env, siteMode);
  if (initialStatus.database.state === 'ready') {
    return {
      authorized: false,
      response: errorResponse(c, 409, 'INSTALLATION_ALREADY_COMPLETED'),
    };
  }
  if (initialStatus.access.state !== 'installation') {
    return {
      authorized: false,
      response: errorResponse(c, 503, 'SYSTEM_NOT_AVAILABLE'),
    };
  }

  const providedToken = readBearerToken(c.req.header('Authorization'));
  const configuredToken = c.env.STUDIO_INSTALL_TOKEN;
  if (!providedToken || !hasConfiguredInstallToken(configuredToken)) {
    return {
      authorized: false,
      response: await rejectInstallAuthenticationAttempt(c),
    };
  }

  let tokenMatches: boolean;
  try {
    tokenMatches = await secretTokensMatch(providedToken, configuredToken);
  } catch (error) {
    throw new StudioOperationalError(
      'INSTALL_TOKEN_VERIFICATION_NOT_AVAILABLE',
      {
        cause: error,
        metadata: {
          component: 'web_crypto',
          action: 'verify_install_token',
        },
      },
    );
  }
  if (!tokenMatches) {
    return {
      authorized: false,
      response: await rejectInstallAuthenticationAttempt(c),
    };
  }

  return {
    authorized: true,
    siteMode: { state: 'valid', mode: 'initial' },
  };
}

export function createSystemRoutes(dependencies: {
  resolveSession?: ResolveUserSession;
  installDatabase?: InstallDatabase;
  hashInstallPassword?: InstallPasswordHasher;
  readInterfaceSettings?: typeof readStudioInterfaceSettings;
  prepareEdgeSetup?: PrepareInitialEdgeSetup;
  checkPasswordBreach?: CheckPasswordBreach;
} = {}) {
  const system = new Hono<StudioHonoEnvironment>();
  const installDatabase = dependencies.installDatabase ?? installStudioDatabase;
  const hashInstallPassword = dependencies.hashInstallPassword ?? hashPassword;
  const readInterfaceSettings = dependencies.readInterfaceSettings
    ?? readStudioInterfaceSettings;
  const prepareEdgeSetup = dependencies.prepareEdgeSetup
    ?? prepareInitialEdgeSetup;

  system.get('/status', async (c) => {
    const configuration = resolveOperationsConfiguration(c.env);
    synchronizeOperationsConfigurationIncident(configuration);
    const operations = await resolveOperationsRequestBoundary({
      context: c,
      configuration,
      resolveSession: dependencies.resolveSession,
    });
    const response: SystemStatusResponse = {
      success: true,
      data: {
        ...await resolveSystemStatus(c.env),
        operations: operations.state === 'setup_required'
          ? { state: operations.state, configuration: operations.setup }
          : { state: operations.state },
      },
    };

    // Entry discovery depends on the request's IP, Origin, and Studio session.
    c.header('Cache-Control', 'no-store');
    return c.json(response);
  });

  system.get('/interface-config', async (c) => {
    const document = await readInterfaceSettings({ db: c.env.DB });
    return c.json(publicInterfaceConfigSuccessSchema.parse({
      success: true,
      data: document.settings,
    }));
  });

  system.get('/install/access', async (c) => {
    const authorization = await authorizeInstallRequest(c);
    if (!authorization.authorized) return authorization.response;

    const response: InstallAccessResponse = {
      success: true,
      data: { state: 'authorized' },
    };
    return c.json(response);
  });

  system.post('/install/mfa/setup', bodyLimit({
    maxSize: 8 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const authorization = await authorizeInstallRequest(c);
    if (!authorization.authorized) return authorization.response;

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
    const parsedBody = installMfaSetupRequestSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }
    if (!isConfiguredAuthSecret(c.env.STUDIO_AUTH_SECRET)) {
      return errorResponse(c, 503, 'SYSTEM_CONFIGURATION_ERROR');
    }

    let enrollment;
    try {
      enrollment = await createMfaEnrollment({
        authSecret: c.env.STUDIO_AUTH_SECRET,
        subject: {
          type: 'install',
          id: parsedBody.data.admin_email,
        },
        accountName: parsedBody.data.admin_email,
      });
    } catch (error) {
      throw new StudioOperationalError(
        'AUTH_MFA_CRYPTO_NOT_AVAILABLE',
        {
          cause: error,
          metadata: {
            component: 'web_crypto',
            action: 'create_install_mfa_enrollment',
          },
        },
      );
    }
    const response: MfaEnrollmentSetupSuccess = {
      success: true,
      data: enrollment,
    };
    return c.json(response satisfies InstallMfaSetupResponse);
  });

  system.post('/install', bodyLimit({
    maxSize: 32 * 1024,
    onError: (c) => errorResponse(c, 413, 'PAYLOAD_TOO_LARGE'),
  }), async (c) => {
    const authorization = await authorizeInstallRequest(c);
    if (!authorization.authorized) return authorization.response;
    const { siteMode } = authorization;

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

    const parsedBody = installRequestSchema.safeParse(rawBody);
    if (!parsedBody.success) {
      return errorResponse(c, 400, 'VALIDATION_ERROR');
    }

    const passwordAssessment = await assessPasswordAcceptance({
      password: parsedBody.data.admin_password,
      email: parsedBody.data.admin_email,
      displayName: parsedBody.data.admin_name,
      env: c.env,
      checkBreach: dependencies.checkPasswordBreach,
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
      || enrollment.subject_type !== 'install'
      || enrollment.subject_id !== parsedBody.data.admin_email
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
            action: 'verify_initial_mfa_enrollment_proof',
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
            action: 'encrypt_initial_totp_secret',
          },
        },
      );
    }

    let passwordHash: string;
    try {
      passwordHash = await hashInstallPassword(
        parsedBody.data.admin_password,
      );
    } catch (error) {
      throw new StudioOperationalError('PASSWORD_HASHING_NOT_AVAILABLE', {
        cause: error,
        metadata: {
          component: 'argon2id',
          action: 'hash_initial_administrator_password',
        },
      });
    }

    const beforeWriteStatus = await resolveSystemStatus(c.env, siteMode);
    if (beforeWriteStatus.database.state === 'ready') {
      return errorResponse(c, 409, 'INSTALLATION_ALREADY_COMPLETED');
    }
    if (beforeWriteStatus.access.state !== 'installation') {
      return errorResponse(c, 409, 'INSTALLATION_NOT_AVAILABLE');
    }

    let edgeSetup;
    try {
      edgeSetup = await prepareEdgeSetup({
        edgeDb: c.env.EDGE_DB,
        edgeKv: c.env.EDGE_KV,
      });
    } catch (error) {
      throw new StudioOperationalError(
        'INITIAL_EDGE_SETUP_FAILED',
        {
          cause: error instanceof InitialEdgeSetupError
            ? error.cause ?? error
            : error,
          metadata: {
            resource: 'EDGE_DB',
            related_resource: 'EDGE_KV',
            action: 'prepare_initial_edge_database',
            reason: error instanceof InitialEdgeSetupError
              ? error.reason
              : 'unexpected_failure',
          },
        },
      );
    }
    const edgeIntegrationMode = edgeSetup.status === 'installed'
      ? 'enabled' as const
      : 'disabled' as const;

    try {
      await installDatabase({
        db: c.env.DB,
        edgeIntegrationMode,
        administrator: {
          admin_name: parsedBody.data.admin_name,
          admin_email: parsedBody.data.admin_email,
        },
        interfaceLocale: parsedBody.data.interface_locale,
        passwordHash,
        mfa: {
          encryptedTotpSecret,
          lastUsedStep: proof.matchedStep,
        },
      });
    } catch (error) {
      const afterFailureStatus = await resolveSystemStatus(c.env, siteMode);
      if (afterFailureStatus.database.state === 'ready') {
        return errorResponse(c, 409, 'INSTALLATION_ALREADY_COMPLETED');
      }

      throw new StudioOperationalError('DATABASE_INSTALL_FAILED', {
        cause: error,
        metadata: {
          resource: 'DB',
          action: 'install_database',
          target_schema_version: STUDIO_SCHEMA_VERSION,
          edge_database_status: edgeSetup.status,
          edge_integration_mode: edgeIntegrationMode,
        },
      });
    }

    const completedStatus = await resolveSystemStatus(c.env, siteMode);
    if (
      completedStatus.database.state !== 'ready'
      || completedStatus.database.schema_version !== STUDIO_SCHEMA_VERSION
    ) {
      throw new StudioOperationalError(
        'DATABASE_INSTALL_VERIFICATION_FAILED',
        {
          metadata: {
            resource: 'DB',
            action: 'verify_database_installation',
            target_schema_version: STUDIO_SCHEMA_VERSION,
          },
        },
      );
    }

    logOperationalFailure('DATABASE_INSTALL_COMPLETED', {
      metadata: {
        resource: 'DB',
        action: 'install_database',
        schema_version: STUDIO_SCHEMA_VERSION,
        edge_database_status: edgeSetup.status,
        edge_integration_mode: edgeIntegrationMode,
        ...(edgeSetup.status === 'skipped_nonempty'
          ? { existing_edge_database_state: edgeSetup.existingState }
          : {}),
      },
    });

    const response: InstallSuccess = {
      success: true,
      data: {
        status: 'installed',
        schema_version: STUDIO_SCHEMA_VERSION,
        edge_database: edgeSetup.status === 'installed'
          ? {
              status: 'installed',
              integration_mode: 'enabled',
            }
          : {
              status: 'skipped_nonempty',
              integration_mode: 'disabled',
            },
      },
    };
    return c.json(response, 201);
  });

  return system;
}
