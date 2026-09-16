import type { Unstable_Config as WranglerConfig } from 'wrangler';

export const ENABLE_REMOTE_DEVELOPMENT_MODE = 'enable-remote';
export const LOCAL_PREVIEW_BUILD_MODE = 'local-preview';

type RemoteBinding = { remote?: boolean };

function localBindings<T extends RemoteBinding>(bindings: T[] | undefined) {
  return bindings?.map((binding) => ({ ...binding, remote: false }));
}

// Default dev and preview never use remote resources, including Workers AI.
export function defaultDevelopmentBindingOverrides(
  config: WranglerConfig,
): Partial<WranglerConfig> {
  return {
    ...(config.ai ? {
      ai: { ...config.ai, remote: false },
    } : {}),
    ...(config.d1_databases ? {
      d1_databases: localBindings(config.d1_databases),
    } : {}),
    ...(config.kv_namespaces ? {
      kv_namespaces: localBindings(config.kv_namespaces),
    } : {}),
    ...(config.r2_buckets ? {
      r2_buckets: localBindings(config.r2_buckets),
    } : {}),
    ...(config.queues?.producers ? {
      queues: {
        ...config.queues,
        producers: localBindings(config.queues.producers),
      },
    } : {}),
  };
}

/**
 * Workers AI has no local simulator. Wrangler rejects an AI binding with
 * remote:false, and the Vite plugin treats every declared AI binding as a
 * remote-proxy candidate. Remove it from the local-runtime config unless
 * remote access was explicitly reviewed and enabled.
 *
 * This intentionally mutates the config object supplied by the Cloudflare
 * Vite plugin. Returning overrides from its config customizer would merge them
 * with the file config through defu: ai:undefined would restore the original
 * binding and binding arrays would be concatenated. Mutating the plugin's
 * working config and returning nothing avoids both behaviors.
 */
export function applyDevelopmentBindingAvailability(
  config: WranglerConfig,
): void {
  if (config.ai && config.ai.remote !== true) {
    delete config.ai;
  }
}

export function deployedPasswordBreachCheckEnabled(input: {
  command: 'build' | 'serve';
  mode: string;
}): boolean {
  return input.command === 'build'
    && input.mode !== LOCAL_PREVIEW_BUILD_MODE;
}

function bindingRemote(
  bindings: Array<{ binding?: string; remote?: boolean }> | undefined,
  bindingName: string,
): boolean | null {
  const binding = bindings?.find((candidate) => (
    candidate.binding === bindingName
  ));
  return binding ? binding.remote === true : null;
}

/**
 * Managed Media metadata and its object must share one locality. Mixing a
 * remote Studio DB with local R2 (or the reverse) can manufacture dangling
 * metadata or delete an object in the wrong environment.
 */
export function managedMediaStorageEnabledForConfig(
  config: WranglerConfig,
): boolean {
  const databaseRemote = bindingRemote(config.d1_databases, 'DB');
  const bucketRemote = bindingRemote(config.r2_buckets, 'MEDIA_BUCKET');
  return databaseRemote !== null
    && bucketRemote !== null
    && databaseRemote === bucketRemote;
}

export function mergeWranglerConfig(
  config: WranglerConfig,
  overrides: Partial<WranglerConfig>,
): WranglerConfig {
  return { ...config, ...overrides };
}

export function validateMailQueueConfig(config: WranglerConfig): void {
  const producers = config.queues?.producers?.filter(
    (producer) => producer.binding === 'MAIL_QUEUE',
  ) ?? [];
  const consumers = config.queues?.consumers ?? [];
  if (producers.length === 0 && consumers.length === 0) return;
  if (
    producers.length !== 1
    || consumers.length !== 1
    || !producers[0].queue
    || producers[0].queue !== consumers[0].queue
  ) {
    throw new TypeError(
      'MAIL_QUEUE requires one producer and one consumer using the same queue in wrangler.jsonc.',
    );
  }
}

export function validateRemoteDevelopmentConfig(config: WranglerConfig): void {
  if (
    bindingRemote(config.d1_databases, 'EDGE_DB') === true
    || bindingRemote(config.kv_namespaces, 'EDGE_KV') === true
  ) {
    throw new TypeError(
      'EDGE_DB and EDGE_KV must remain local during development.\n'
      + 'Remove "remote": true from these bindings in wrangler.jsonc.',
    );
  }
  const databaseRemote = bindingRemote(config.d1_databases, 'DB');
  const bucketRemote = bindingRemote(config.r2_buckets, 'MEDIA_BUCKET');
  if (databaseRemote !== null && bucketRemote !== null && databaseRemote !== bucketRemote) {
    throw new TypeError(
      'DB and MEDIA_BUCKET must use the same remote setting during development.\n'
      + 'In wrangler.jsonc, set "remote": true on both bindings, or keep both local.',
    );
  }
  const bindings = [
    ...(config.d1_databases ?? []),
    ...(config.kv_namespaces ?? []),
    ...(config.r2_buckets ?? []),
    ...(config.queues?.producers ?? []),
    config.ai,
  ];
  if (!bindings.some((binding) => binding?.remote === true)) {
    throw new TypeError(
      'No remote bindings are enabled.\n'
      + 'In wrangler.jsonc, set "remote": true on the bindings you want to use remotely.\n'
      + 'For local development, run npm run dev.',
    );
  }
}

// The plugin customizer must mutate its config rather than return array overrides.
export function stripDevelopmentBindingFields(config: WranglerConfig): void {
  function strip<T extends RemoteBinding>(binding: T): T {
    const copy = { ...binding };
    delete copy.remote;
    return copy;
  }
  if (config.ai) config.ai = strip(config.ai);
  if (config.d1_databases) config.d1_databases = config.d1_databases.map(strip);
  if (config.kv_namespaces) config.kv_namespaces = config.kv_namespaces.map(strip);
  if (config.r2_buckets) config.r2_buckets = config.r2_buckets.map(strip);
  if (config.queues?.producers) {
    config.queues = { ...config.queues, producers: config.queues.producers.map(strip) };
  }
}
