import { describe, expect, it } from 'vitest';
import {
  EDGE_WORKER_CONFIGURATION_CATALOG,
  STUDIO_RESOURCE_BINDING_CATALOG,
  STUDIO_WORKER_CONFIGURATION_CATALOG,
} from './worker-configuration';

describe('Worker configuration catalog', () => {
  it('classifies every credential as a Worker secret', () => {
    expect(STUDIO_WORKER_CONFIGURATION_CATALOG.STUDIO_AUTH_SECRET.kind)
      .toBe('worker_secret');
    expect(STUDIO_WORKER_CONFIGURATION_CATALOG.STUDIO_INSTALL_TOKEN.kind)
      .toBe('worker_secret');
    expect(STUDIO_WORKER_CONFIGURATION_CATALOG.STUDIO_OPERATIONS_TOKEN.kind)
      .toBe('worker_secret');
    expect(EDGE_WORKER_CONFIGURATION_CATALOG.TURNSTILE_SECRET_KEY.kind)
      .toBe('worker_secret');
  });

  it('keeps modes, feature gates, and allowlists as plaintext variables', () => {
    expect(STUDIO_WORKER_CONFIGURATION_CATALOG.STUDIO_SITE_MODE.kind)
      .toBe('plain_variable');
    expect(
      STUDIO_WORKER_CONFIGURATION_CATALOG.STUDIO_OPERATIONS_ALLOWED_IPS.kind,
    ).toBe('plain_variable');
    expect(EDGE_WORKER_CONFIGURATION_CATALOG.EDGE_MAINTENANCE_MODE.kind)
      .toBe('plain_variable');
    expect(EDGE_WORKER_CONFIGURATION_CATALOG.COMMENTS_ENABLED.kind)
      .toBe('plain_variable');
  });

  it('keeps runtime resources separate from scalar configuration', () => {
    expect(STUDIO_RESOURCE_BINDING_CATALOG.DB.kind)
      .toBe('resource_binding');
    expect(STUDIO_RESOURCE_BINDING_CATALOG.MEDIA_BUCKET.kind)
      .toBe('resource_binding');
  });
});
