import { describe, expect, it } from 'vitest';
import type { Unstable_Config as WranglerConfig } from 'wrangler';
import {
  applyDevelopmentBindingAvailability,
  defaultDevelopmentBindingOverrides,
  deployedPasswordBreachCheckEnabled,
  managedMediaStorageEnabledForConfig,
  mergeWranglerConfig,
  stripDevelopmentBindingFields,
  validateMailQueueConfig,
  validateRemoteDevelopmentConfig,
} from './development-binding-policy';

function config(input: {
  databaseRemote: boolean;
  bucketRemote: boolean;
  aiRemote?: boolean;
  edgeRemote?: boolean;
}): WranglerConfig {
  return {
    ai: { binding: 'AI', remote: input.aiRemote ?? false },
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'studio',
        remote: input.databaseRemote,
      },
      {
        binding: 'EDGE_DB',
        database_name: 'edge',
        remote: input.edgeRemote ?? true,
      },
    ],
    kv_namespaces: [{ binding: 'KV', id: 'kv-id', remote: true }],
    r2_buckets: [{
      binding: 'MEDIA_BUCKET',
      bucket_name: 'media',
      remote: input.bucketRemote,
    }],
  } as WranglerConfig;
}

describe('development binding policy', () => {
  it('keeps simulatable bindings local without forcing AI remote', () => {
    const source = config({ databaseRemote: true, bucketRemote: true, aiRemote: true });
    const effective = mergeWranglerConfig(
      source,
      defaultDevelopmentBindingOverrides(source),
    );

    expect(effective.ai?.remote).toBe(false);
    expect(effective.d1_databases?.map((binding) => binding.remote))
      .toEqual([false, false]);
    expect(effective.kv_namespaces?.[0]?.remote).toBe(false);
    expect(effective.r2_buckets?.[0]?.remote).toBe(false);
    expect(source.d1_databases?.[0]?.remote).toBe(true);
    expect(source.r2_buckets?.[0]?.remote).toBe(true);
  });

  it('removes a non-remote AI binding from the serve-time config', () => {
    const effective = config({
      databaseRemote: false,
      bucketRemote: false,
      aiRemote: false,
    });

    applyDevelopmentBindingAvailability(effective);

    expect(effective.ai).toBeUndefined();
  });

  it('treats an AI binding without an explicit remote choice as unavailable', () => {
    const effective = {
      ai: { binding: 'AI' },
    } as WranglerConfig;

    applyDevelopmentBindingAvailability(effective);

    expect(effective.ai).toBeUndefined();
  });

  it('preserves an explicitly remote AI binding', () => {
    const effective = config({
      databaseRemote: false,
      bucketRemote: false,
      aiRemote: true,
    });

    applyDevelopmentBindingAvailability(effective);

    expect(effective.ai).toEqual({ binding: 'AI', remote: true });
  });

  it.each([
    { command: 'serve' as const, mode: 'development', enabled: false },
    { command: 'serve' as const, mode: 'enable-remote', enabled: false },
    { command: 'build' as const, mode: 'local-preview', enabled: false },
    { command: 'build' as const, mode: 'production', enabled: true },
  ])(
    'resolves $command/$mode HIBP policy to $enabled',
    ({ command, mode, enabled }) => {
      expect(deployedPasswordBreachCheckEnabled({ command, mode }))
        .toBe(enabled);
    },
  );

  it.each([
    { databaseRemote: false, bucketRemote: false, enabled: true },
    { databaseRemote: true, bucketRemote: true, enabled: true },
    { databaseRemote: true, bucketRemote: false, enabled: false },
    { databaseRemote: false, bucketRemote: true, enabled: false },
  ])(
    'resolves DB=$databaseRemote and R2=$bucketRemote to $enabled',
    ({ databaseRemote, bucketRemote, enabled }) => {
      expect(managedMediaStorageEnabledForConfig(config({
        databaseRemote,
        bucketRemote,
      }))).toBe(enabled);
    },
  );

  it('fails closed when either managed Media binding is missing', () => {
    expect(managedMediaStorageEnabledForConfig({
      d1_databases: config({
        databaseRemote: false,
        bucketRemote: false,
      }).d1_databases,
    } as WranglerConfig)).toBe(false);
    expect(managedMediaStorageEnabledForConfig({
      r2_buckets: config({
        databaseRemote: false,
        bucketRemote: false,
      }).r2_buckets,
    } as WranglerConfig)).toBe(false);
  });
});

describe('root Wrangler installation policies', () => {
  it('omits explicitly remote AI from ordinary dev and preview', () => {
    const source = config({ databaseRemote: true, bucketRemote: true, aiRemote: true });
    const effective = mergeWranglerConfig(source, defaultDevelopmentBindingOverrides(source));
    applyDevelopmentBindingAvailability(effective);
    expect(effective.ai).toBeUndefined();
    expect(source.ai?.remote).toBe(true);
  });

  it('requires an explicit remote opt-in', () => {
    expect(() => validateRemoteDevelopmentConfig({} as WranglerConfig)).toThrow(/No remote bindings are enabled/);
    expect(() => validateRemoteDevelopmentConfig({ ai: { binding: 'AI', remote: true } } as WranglerConfig)).not.toThrow();
  });

  it.each(['EDGE_DB', 'EDGE_KV'])('rejects remote %s', (binding) => {
    const source = {
      d1_databases: binding === 'EDGE_DB' ? [{ binding, database_name: 'edge', remote: true }] : [],
      kv_namespaces: binding === 'EDGE_KV' ? [{ binding, id: 'edge', remote: true }] : [],
    } as WranglerConfig;
    expect(() => validateRemoteDevelopmentConfig(source)).toThrow(/EDGE_DB and EDGE_KV/);
  });

  it.each([
    { databaseRemote: true, bucketRemote: false },
    { databaseRemote: false, bucketRemote: true },
  ])('rejects mismatched DB/R2 locality: $databaseRemote/$bucketRemote', (locality) => {
    expect(() => validateRemoteDevelopmentConfig(config({ ...locality, edgeRemote: false }))).toThrow(/same remote setting/);
  });

  it('allows matched remote Studio storage', () => {
    expect(() => validateRemoteDevelopmentConfig(config({ databaseRemote: true, bucketRemote: true, edgeRemote: false }))).not.toThrow();
  });

  it.each([
    { producers: [], consumers: [] },
    { producers: [{ binding: 'MAIL_QUEUE', queue: 'installed-mail' }], consumers: [{ queue: 'installed-mail' }] },
  ])('accepts absent or matching mail declarations', (queues) => {
    expect(() => validateMailQueueConfig({ queues } as WranglerConfig)).not.toThrow();
  });

  it.each([
    { producers: [{ binding: 'MAIL_QUEUE', queue: 'first' }] },
    { consumers: [{ queue: 'first' }] },
    { producers: [{ binding: 'MAIL_QUEUE', queue: 'first' }], consumers: [{ queue: 'second' }] },
  ])('rejects incomplete or mismatched mail declarations without rewriting them', (queues) => {
    const source = { queues } as WranglerConfig;
    const snapshot = structuredClone(source);
    expect(() => validateMailQueueConfig(source)).toThrow(/same queue/);
    expect(source).toEqual(snapshot);
  });

  it('strips only development fields and preserves installed resource identities', () => {
    const source = {
      name: 'installed-studio', keep_vars: true,
      ai: { binding: 'AI', remote: false },
      d1_databases: [{ binding: 'DB', database_name: 'installed-db', database_id: 'installed-db-id', remote: true }],
      kv_namespaces: [{ binding: 'KV', id: 'installed-kv-id', remote: false }],
      r2_buckets: [{ binding: 'MEDIA_BUCKET', bucket_name: 'installed-media', remote: true }],
      queues: {
        producers: [{ binding: 'MAIL_QUEUE', queue: 'installed-mail', remote: false }],
        consumers: [{ queue: 'installed-mail', max_retries: 5, retry_delay: 60 }],
      },
    } as WranglerConfig;
    const expected = JSON.parse(JSON.stringify(source, (key, value) => key === 'remote' ? undefined : value));
    stripDevelopmentBindingFields(source);
    expect(source).toEqual(expected);
    expect(source.ai).toEqual({ binding: 'AI' });
  });
});
