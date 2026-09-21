/**
 * Registry of Studio message namespaces.
 *
 * Each namespace corresponds to one locales/<locale>/<kebab-case-name>.ts file exporting a
 * constant with the namespace's name. namespaces.test.ts checks the mapping and partition.
 *
 * Boot versus deferred:
 * Statically bundling all catalogs makes startup cost grow with locale count times screen copy.
 * Keep that growth out of the first paint.
 * - BOOT_NAMESPACES are used by modules statically reachable from main.tsx. Only this set is
 * bundled for the fallback locale.
 * - DEFERRED_NAMESPACES load alongside their lazy route chunks.
 *
 * The static import graph determines the boundary. If an eager module adds a namespace, first
 * decide whether it should be lazy before expanding the boot set.
 */
export const BOOT_NAMESPACES = [
  'auth',
  'common',
  'dashboard',
  'edgeServices',
  'install',
  'studio',
  'system',
  'users',
] as const;

export const DEFERRED_NAMESPACES = [
  'accessSettings',
  'analytics',
  'authors',
  'brandingSettings',
  'comments',
  'contentEditor',
  'customCodeSettings',
  'edgeSecuritySettings',
  'forms',
  'interfaceSettings',
  'mailSettings',
  'media',
  'mediaSettings',
  'menus',
  'newsletterSettings',
  'newsletters',
  'operations',
  'outputSettings',
  'pages',
  'posts',
  'preferences',
  'previewData',
  'publishing',
  'routingSettings',
  'security',
  'settings',
  'taxonomies',
  'widgets',
  'wxrImport',
] as const;

export const STUDIO_NAMESPACES = [
  ...BOOT_NAMESPACES,
  ...DEFERRED_NAMESPACES,
] as const;

export type StudioBootNamespace = (typeof BOOT_NAMESPACES)[number];
export type StudioNamespace = (typeof STUDIO_NAMESPACES)[number];

/**
 * Convert a namespace key to its catalog filename without duplicating both forms in the registry.
 * Tests verify that the corresponding file exists.
 */
export function namespaceFileName(namespace: StudioNamespace): string {
  return namespace.replaceAll(
    /[A-Z]/g,
    (character) => `-${character.toLowerCase()}`,
  );
}
