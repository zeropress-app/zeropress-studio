import type { publishing } from './locales/en/publishing';
import type { analytics } from './locales/en/analytics';
import { FALLBACK_LOCALE } from './locale';
import type { StudioNamespace } from './namespaces';

// Import only the fallback locale's boot namespaces as values.
// load-namespaces.ts loads the rest on demand so the initial bundle
// does not grow with locale or screen count.
import { auth as enAuth } from './locales/en/auth';
import { common as enCommon } from './locales/en/common';
import { dashboard as enDashboard } from './locales/en/dashboard';
import { edgeServices as enEdgeServices } from './locales/en/edge-services';
import { install as enInstall } from './locales/en/install';
import { studio as enStudio } from './locales/en/studio';
import { system as enSystem } from './locales/en/system';
import { users as enUsers } from './locales/en/users';

// Type-only imports do not enter the runtime graph. Describe the full catalog
// shape here so i18next.d.ts continues to catch key misspellings at compile time.
import type { authors } from './locales/en/authors';
import type { accessSettings } from './locales/en/access-settings';
import type { brandingSettings } from './locales/en/branding-settings';
import type { comments } from './locales/en/comments';
import type { contentEditor } from './locales/en/content-editor';
import type { customCodeSettings } from './locales/en/custom-code-settings';
import type { edgeSecuritySettings } from './locales/en/edge-security-settings';
import type { forms } from './locales/en/forms';
import type { interfaceSettings } from './locales/en/interface-settings';
import type { mailSettings } from './locales/en/mail-settings';
import type { media } from './locales/en/media';
import type { mediaSettings } from './locales/en/media-settings';
import type { menus } from './locales/en/menus';
import type { newsletterSettings } from './locales/en/newsletter-settings';
import type { newsletters } from './locales/en/newsletters';
import type { operations } from './locales/en/operations';
import type { outputSettings } from './locales/en/output-settings';
import type { pages } from './locales/en/pages';
import type { posts } from './locales/en/posts';
import type { preferences } from './locales/en/preferences';
import type { previewData } from './locales/en/preview-data';
import type { routingSettings } from './locales/en/routing-settings';
import type { security } from './locales/en/security';
import type { settings } from './locales/en/settings';
import type { taxonomies } from './locales/en/taxonomies';
import type { widgets } from './locales/en/widgets';
import type { wxrImport } from './locales/en/wxr-import';

/**
 * Fallback-locale catalogs required before the first paint.
 *
 * i18next receives only these synchronously; addResourceBundle merges the rest later.
 */
export const BOOT_RESOURCES = {
  [FALLBACK_LOCALE]: {
    auth: enAuth,
    common: enCommon,
    dashboard: enDashboard,
    edgeServices: enEdgeServices,
    install: enInstall,
    studio: enStudio,
    system: enSystem,
    users: enUsers,
  },
} as const;

/** Translation-key type contract. Only the shape is needed, with no runtime cost. */
export type StudioResourceContract = {
  publishing: typeof publishing;
  accessSettings: typeof accessSettings;
  auth: typeof enAuth;
  authors: typeof authors;
  brandingSettings: typeof brandingSettings;
  comments: typeof comments;
  common: typeof enCommon;
  contentEditor: typeof contentEditor;
  customCodeSettings: typeof customCodeSettings;
  dashboard: typeof enDashboard;
  edgeSecuritySettings: typeof edgeSecuritySettings;
  edgeServices: typeof enEdgeServices;
  forms: typeof forms;
  install: typeof enInstall;
  interfaceSettings: typeof interfaceSettings;
  analytics: typeof analytics;
  mailSettings: typeof mailSettings;
  media: typeof media;
  mediaSettings: typeof mediaSettings;
  menus: typeof menus;
  newsletterSettings: typeof newsletterSettings;
  newsletters: typeof newsletters;
  operations: typeof operations;
  outputSettings: typeof outputSettings;
  pages: typeof pages;
  posts: typeof posts;
  preferences: typeof preferences;
  previewData: typeof previewData;
  routingSettings: typeof routingSettings;
  security: typeof security;
  settings: typeof settings;
  studio: typeof enStudio;
  system: typeof enSystem;
  taxonomies: typeof taxonomies;
  users: typeof enUsers;
  widgets: typeof widgets;
  wxrImport: typeof wxrImport;
};

// Check at compile time that the registry and type contract contain the same namespaces.
type AssertSameNamespaces =
  StudioNamespace extends keyof StudioResourceContract
    ? keyof StudioResourceContract extends StudioNamespace ? true : never
    : never;
const _namespaceContractIsComplete: AssertSameNamespaces = true;
void _namespaceContractIsComplete;
