import {
  logOperationalFailure,
  type OperationalLogCode,
  type OperationalLogMetadata,
} from '../lib/operational-error';

export type SystemIncidentDomain =
  | 'site_mode'
  | 'install_token'
  | 'auth_secret'
  | 'database'
  | 'database_installation'
  | 'operations_configuration'
  | 'cloudflare_access';

export type SystemIncident = {
  code: OperationalLogCode;
  cause?: unknown;
  metadata: OperationalLogMetadata;
  fingerprint?: string;
};

const activeIncidents = new Map<SystemIncidentDomain, string>();

export function synchronizeSystemIncident(
  domain: SystemIncidentDomain,
  incident: SystemIncident | null,
): void {
  if (!incident) {
    activeIncidents.delete(domain);
    return;
  }

  const fingerprint = `${incident.code}:${incident.fingerprint ?? ''}`;
  if (activeIncidents.get(domain) === fingerprint) {
    return;
  }

  activeIncidents.set(domain, fingerprint);
  logOperationalFailure(incident.code, {
    cause: incident.cause,
    metadata: incident.metadata,
  });
}

export function resetSystemIncidentDeduplicationForTests(): void {
  activeIncidents.clear();
}
