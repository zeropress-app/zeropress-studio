import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { unstable_readConfig } from 'wrangler';
import { developmentClientIp } from './scripts/development-client-ip.ts';
import {
  applyDevelopmentBindingAvailability,
  defaultDevelopmentBindingOverrides,
  deployedPasswordBreachCheckEnabled,
  ENABLE_REMOTE_DEVELOPMENT_MODE,
  LOCAL_PREVIEW_BUILD_MODE,
  managedMediaStorageEnabledForConfig,
  mergeWranglerConfig,
  stripDevelopmentBindingFields,
  validateMailQueueConfig,
  validateRemoteDevelopmentConfig,
} from './scripts/development-binding-policy.ts';

const wranglerConfigPath = fileURLToPath(new URL('./wrangler.jsonc', import.meta.url));

export default defineConfig(({ command, mode }) => {
  const wranglerConfig = unstable_readConfig(
    { config: wranglerConfigPath },
    { hideWarnings: true },
  );
  const enableConfiguredRemote = command === 'serve'
    && mode === ENABLE_REMOTE_DEVELOPMENT_MODE;
  validateMailQueueConfig(wranglerConfig);
  if (enableConfiguredRemote) validateRemoteDevelopmentConfig(wranglerConfig);
  const localPreviewBuild = command === 'build'
    && mode === LOCAL_PREVIEW_BUILD_MODE;
  const customizeLocalRuntimeBindings = command === 'serve'
    || localPreviewBuild;
  const isolateBuildFromLocalSecrets = command === 'build'
    && !localPreviewBuild;
  const useDefaultLocalBindings = (
    command === 'serve' && !enableConfiguredRemote
  ) || localPreviewBuild;
  const developmentOverrides = useDefaultLocalBindings
    ? defaultDevelopmentBindingOverrides(wranglerConfig)
    : {};
  const effectiveDevelopmentConfig = mergeWranglerConfig(
    wranglerConfig,
    developmentOverrides,
  );
  if (customizeLocalRuntimeBindings) {
    applyDevelopmentBindingAvailability(effectiveDevelopmentConfig);
  }
  const managedMediaStorageEnabled = (
    command === 'build' && !localPreviewBuild
  ) || managedMediaStorageEnabledForConfig(effectiveDevelopmentConfig);

  return {
    define: {
      __ZEROPRESS_MANAGED_MEDIA_STORAGE_ENABLED__: JSON.stringify(
        managedMediaStorageEnabled,
      ),
      __ZEROPRESS_HIBP_PASSWORD_BREACH_CHECK_ENABLED__: JSON.stringify(
        deployedPasswordBreachCheckEnabled({ command, mode }),
      ),
    },
    root: 'client',
    publicDir: 'public',
    cacheDir: '../node_modules/.vite',
    preview: { allowedHosts: ['.trycloudflare.com'] },
    resolve: {
      alias: {
        stream: fileURLToPath(new URL('./client/src/shims/sax-stream.ts', import.meta.url)),
      },
    },
    build: {
      outDir: '../dist',
      emptyOutDir: true,
      chunkSizeWarningLimit: 3000,
    },
    plugins: [
      developmentClientIp(),
      react(),
      cloudflare({
        configPath: wranglerConfigPath,
        viteEnvironment: { name: 'zeropress_studio' },
        remoteBindings: enableConfiguredRemote,
        ...(customizeLocalRuntimeBindings || isolateBuildFromLocalSecrets ? {
          config: (config) => {
            if (isolateBuildFromLocalSecrets) {
              config.secrets = { required: [] };
              stripDevelopmentBindingFields(config);
            }
            if (customizeLocalRuntimeBindings) {
              Object.assign(config, developmentOverrides);
              applyDevelopmentBindingAvailability(config);
            }
          },
        } : {}),
      }),
    ],
  };
});
