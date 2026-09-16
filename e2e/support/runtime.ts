import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const E2E_RUNTIME_MANIFEST = resolve('.wrangler/e2e/runtime.json');

export const studioProfiles = [
  'operations',
  'installation',
  'initial',
  'operational',
  'activation-required',
  'maintenance',
  'recovery',
  'recovery-no-operations',
  'initial-no-operations',
  'operational-no-operations',
  'operations-ip-denied',
  'operations-ip-denied-token-missing',
  'operations-ip-denied-token-invalid',
  'operations-allowlist-empty',
  'operations-allowlist-invalid',
  'operations-token-missing',
  'operations-token-invalid',
  'auth-secret-missing',
  'site-mode-missing',
  'site-mode-invalid',
  'operational-uninstalled',
  'initial-secrets-missing',
  'initial-auth-secret-invalid',
  'initial-install-token-invalid',
  'activation',
] as const;

export type StudioProfile = typeof studioProfiles[number];

export type E2ERuntime = {
  version: 1;
  repositoryRoot: string;
  wranglerConfig: string;
  workerHost: string;
  workerPort: number;
  baseStateDirectory: string;
  invitationStateDirectory: string;
  databaseName: string;
  credentials: {
    installToken: string;
    operationsToken: string;
    authSecret: string;
    admin: {
      name: string;
      email: string;
      password: string;
      totpSecret: string;
    };
    invitation: {
      name: string;
      email: string;
      password: string;
      setupUrl: string;
    };
  };
};

export async function readE2ERuntime(): Promise<E2ERuntime> {
  const raw = await readFile(E2E_RUNTIME_MANIFEST, 'utf8');
  const value = JSON.parse(raw) as E2ERuntime;
  if (
    value.version !== 1
    || typeof value.credentials?.admin?.totpSecret !== 'string'
    || typeof value.credentials?.invitation?.setupUrl !== 'string'
  ) {
    throw new Error('The E2E runtime manifest is incomplete.');
  }
  return value;
}

export function profileEnvironment(
  profile: StudioProfile,
  runtime: E2ERuntime,
): Record<string, string> {
  const common = {
    STUDIO_OPERATIONS_ALLOWED_IPS: runtime.workerHost,
  };
  const operations = {
    STUDIO_OPERATIONS_TOKEN: runtime.credentials.operationsToken,
  };
  const auth = { STUDIO_AUTH_SECRET: runtime.credentials.authSecret };
  switch (profile) {
    case 'operations':
    case 'installation':
    case 'initial':
      return {
        ...common,
        ...operations,
        ...auth,
        STUDIO_SITE_MODE: 'initial',
        STUDIO_INSTALL_TOKEN: runtime.credentials.installToken,
      };
    case 'operational':
    case 'activation':
      return {
        ...common,
        ...operations,
        ...auth,
        STUDIO_SITE_MODE: 'operational',
      };
    case 'activation-required':
      return {
        ...common,
        ...operations,
        ...auth,
        STUDIO_SITE_MODE: 'initial',
        STUDIO_INSTALL_TOKEN: runtime.credentials.installToken,
      };
    case 'maintenance':
      return {
        ...common,
        ...operations,
        ...auth,
        STUDIO_SITE_MODE: 'maintenance',
        EDGE_MAINTENANCE_MODE: 'true',
      };
    case 'recovery':
      return {
        ...common,
        ...operations,
        ...auth,
        STUDIO_SITE_MODE: 'recovery',
        EDGE_MAINTENANCE_MODE: 'true',
      };
    case 'recovery-no-operations':
      return {
        ...auth,
        STUDIO_SITE_MODE: 'recovery',
        EDGE_MAINTENANCE_MODE: 'true',
      };
    case 'initial-no-operations':
      return { ...auth, STUDIO_SITE_MODE: 'initial' };
    case 'operational-no-operations':
      return { ...auth, STUDIO_SITE_MODE: 'operational' };
    case 'operations-ip-denied':
      return {
        ...auth,
        ...operations,
        STUDIO_SITE_MODE: 'maintenance',
        STUDIO_OPERATIONS_ALLOWED_IPS: '192.0.2.200',
      };
    case 'operations-ip-denied-token-missing':
    case 'operations-ip-denied-token-invalid':
      return {
        ...auth,
        STUDIO_SITE_MODE: 'maintenance',
        STUDIO_OPERATIONS_ALLOWED_IPS: '192.0.2.200',
        ...(profile === 'operations-ip-denied-token-invalid'
          ? { STUDIO_OPERATIONS_TOKEN: 'too-short' } : {}),
      };
    case 'operations-allowlist-empty':
    case 'operations-allowlist-invalid':
      return {
        ...auth,
        ...operations,
        STUDIO_SITE_MODE: 'maintenance',
        STUDIO_OPERATIONS_ALLOWED_IPS: profile === 'operations-allowlist-empty'
          ? '' : 'not-an-ip',
      };
    case 'operations-token-missing':
      return { ...common, ...auth, STUDIO_SITE_MODE: 'maintenance' };
    case 'operations-token-invalid':
      return {
        ...common,
        ...auth,
        STUDIO_SITE_MODE: 'maintenance',
        STUDIO_OPERATIONS_TOKEN: 'too-short',
      };
    case 'auth-secret-missing':
      return {
        ...common,
        ...operations,
        STUDIO_SITE_MODE: 'operational',
      };
    case 'site-mode-missing':
      return {
        ...common,
        ...operations,
      };
    case 'site-mode-invalid':
      return {
        ...common,
        ...operations,
        STUDIO_SITE_MODE: 'INITIAL',
      };
    case 'operational-uninstalled':
      return {
        ...auth,
        STUDIO_SITE_MODE: 'operational',
      };
    case 'initial-secrets-missing':
      return {
        ...common,
        ...operations,
        STUDIO_SITE_MODE: 'initial',
      };
    case 'initial-auth-secret-invalid':
      return {
        ...common,
        ...operations,
        STUDIO_SITE_MODE: 'initial',
        STUDIO_AUTH_SECRET: 'too-short',
        STUDIO_INSTALL_TOKEN: runtime.credentials.installToken,
      };
    case 'initial-install-token-invalid':
      return {
        ...common,
        ...operations,
        ...auth,
        STUDIO_SITE_MODE: 'initial',
        STUDIO_INSTALL_TOKEN: 'too-short',
      };
  }
}

export function profileTemplateState(
  profile: StudioProfile,
  runtime: E2ERuntime,
): string | null {
  if (
    profile === 'operations'
    || profile === 'installation'
    || profile === 'initial'
    || profile === 'initial-no-operations'
    || profile === 'site-mode-missing'
    || profile === 'site-mode-invalid'
    || profile === 'operational-uninstalled'
    || profile === 'initial-secrets-missing'
    || profile === 'initial-auth-secret-invalid'
    || profile === 'initial-install-token-invalid'
  ) {
    return null;
  }
  return profile === 'activation'
    ? runtime.invitationStateDirectory
    : runtime.baseStateDirectory;
}
