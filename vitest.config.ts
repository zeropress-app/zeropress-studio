import react from '@vitejs/plugin-react';
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    projects: ['client', 'worker', 'contracts', 'scripts'].map((name) => ({
      ...(name === 'client' ? { plugins: [react()] } : {}),
      ...(name === 'scripts' ? {
        plugins: [{
          name: 'native-sqlite-for-tests',
          enforce: 'pre' as const,
          // Node 22 omits node:sqlite from builtinModules used by Vitest's jsdom resolver.
          resolveId(id: string) {
            if (id === 'node:sqlite') return { id, external: true };
          },
        }],
      } : {}),
      test: {
        name,
        include: configDefaults.include.map((pattern) => `${name}/${pattern}`),
        ...(name === 'client' ? {
          setupFiles: ['./client/src/test-setup.ts'],
        } : {}),
      },
    })),
  },
});
