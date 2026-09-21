import type { StudioCapability } from '../../../contracts/authorization';

export const STUDIO_PATHS = {
  dashboard: '/',
  analytics: '/analytics',
  analyticsSettings: '/settings/site/analytics',
  publishingSettings: '/settings/site/publishing',
  publish: '/publish',
  posts: '/posts',
  newPost: '/posts/new',
  postEditor: '/posts/:postId',
  pages: '/pages',
  newPage: '/pages/new',
  pageEditor: '/pages/:pageId',
  comments: '/comments',
  forms: '/forms',
  newsletters: '/newsletters',
  media: '/media',
  menus: '/menus',
  widgets: '/widgets',
  authors: '/authors',
  taxonomy: '/taxonomy',
  wxrImport: '/import/wordpress',
  users: '/users',
  generalSettings: '/settings/site/general',
  interfaceSettings: '/settings/site/interface',
  brandingSettings: '/settings/site/branding',
  customCodeSettings: '/settings/site/custom-code',
  outputSettings: '/settings/site/output',
  routingSettings: '/settings/site/routing',
  commentSettings: '/settings/edge/comments',
  edgeSecuritySettings: '/settings/edge/request-security',
  edgeServicesSettings: '/settings/edge',
  mediaSettings: '/settings/site/media',
  newsletterSettings: '/settings/site/newsletter',
  mailSettings: '/settings/edge/mail',
  studioPreferences: '/my-account/preferences',
  accountSecurity: '/my-account/security',
  passwordChange: '/my-account/security/password',
  mfaReplace: '/my-account/security/mfa/replace',
  webAuthnCredentials: '/my-account/security/passkeys',
} as const;

export function studioPostPath(postId: string): string {
  return `/posts/${encodeURIComponent(postId)}`;
}

export function studioPostsByAuthorPath(authorId: string): string {
  const params = new URLSearchParams({ author_id: authorId });
  return `${STUDIO_PATHS.posts}?${params.toString()}`;
}

export function studioNewsletterDeliveriesPath(contentId: string): string {
  const params = new URLSearchParams({
    tab: 'deliveries',
    content_id: contentId,
  });
  return `${STUDIO_PATHS.newsletters}?${params.toString()}`;
}

export function studioPagePath(pageId: string): string {
  return `/pages/${encodeURIComponent(pageId)}`;
}

export type StudioRouteId = keyof typeof STUDIO_PATHS;
export type StudioNavigationSection =
  | 'overview'
  | 'content'
  | 'engagement'
  | 'site'
  | 'utility'
  | 'account';
export type StudioNavigationIcon =
  | 'analytics'
  | 'dashboard'
  | 'publish'
  | 'posts'
  | 'pages'
  | 'comments'
  | 'forms'
  | 'newsletter'
  | 'media'
  | 'menus'
  | 'widgets'
  | 'authors'
  | 'taxonomy'
  | 'import'
  | 'security'
  | 'settings'
  | 'users';

export type StudioRouteDefinition = {
  id: StudioRouteId;
  path: (typeof STUDIO_PATHS)[StudioRouteId];
  navigationSection: StudioNavigationSection | null;
  requiredCapability: StudioCapability | null;
  labelKey:
    | 'navigation.analytics'
    | 'navigation.dashboard'
    | 'navigation.publish'
    | 'navigation.posts'
    | 'navigation.pages'
    | 'navigation.comments'
    | 'navigation.forms'
    | 'navigation.newsletters'
    | 'navigation.media'
    | 'navigation.menus'
    | 'navigation.widgets'
    | 'navigation.authors'
    | 'navigation.taxonomy'
    | 'navigation.wxrImport'
    | 'navigation.siteSettings'
    | 'navigation.edgeServices'
    | 'navigation.users'
    | 'navigation.studioPreferences'
    | 'navigation.accountSecurity';
  icon: StudioNavigationIcon;
  end: boolean;
};

export const STUDIO_ROUTE_DEFINITIONS = [
  {
    id: 'dashboard',
    path: STUDIO_PATHS.dashboard,
    navigationSection: 'overview',
    requiredCapability: null,
    labelKey: 'navigation.dashboard',
    icon: 'dashboard',
    end: true,
  },
  {
    id: 'analytics',
    path: STUDIO_PATHS.analytics,
    navigationSection: 'overview',
    requiredCapability: 'settings.manage',
    labelKey: 'navigation.analytics',
    icon: 'analytics',
    end: true,
  },
  {
    id: 'analyticsSettings',
    path: STUDIO_PATHS.analyticsSettings,
    navigationSection: null,
    requiredCapability: 'settings.manage',
    labelKey: 'navigation.siteSettings',
    icon: 'settings',
    end: true,
  },
  {
    id: 'publishingSettings',
    path: STUDIO_PATHS.publishingSettings,
    navigationSection: null,
    requiredCapability: 'settings.manage',
    labelKey: 'navigation.siteSettings',
    icon: 'settings',
    end: true,
  },
  {
    id: 'publish',
    path: STUDIO_PATHS.publish,
    navigationSection: 'overview',
    requiredCapability: 'publish.manage',
    labelKey: 'navigation.publish',
    icon: 'publish',
    end: true,
  },
  {
    id: 'posts',
    path: STUDIO_PATHS.posts,
    navigationSection: 'content',
    requiredCapability: 'posts.contribute',
    labelKey: 'navigation.posts',
    icon: 'posts',
    end: false,
  },
  {
    id: 'newPost',
    path: STUDIO_PATHS.newPost,
    navigationSection: null,
    requiredCapability: 'posts.contribute',
    labelKey: 'navigation.posts',
    icon: 'posts',
    end: true,
  },
  {
    id: 'pages',
    path: STUDIO_PATHS.pages,
    navigationSection: 'content',
    requiredCapability: 'pages.manage',
    labelKey: 'navigation.pages',
    icon: 'pages',
    end: false,
  },
  {
    id: 'newPage',
    path: STUDIO_PATHS.newPage,
    navigationSection: null,
    requiredCapability: 'pages.manage',
    labelKey: 'navigation.pages',
    icon: 'pages',
    end: true,
  },
  {
    id: 'pageEditor',
    path: STUDIO_PATHS.pageEditor,
    navigationSection: null,
    requiredCapability: 'pages.manage',
    labelKey: 'navigation.pages',
    icon: 'pages',
    end: true,
  },
  {
    id: 'comments',
    path: STUDIO_PATHS.comments,
    navigationSection: 'engagement',
    requiredCapability: 'comments.manage',
    labelKey: 'navigation.comments',
    icon: 'comments',
    end: true,
  },
  {
    id: 'forms',
    path: STUDIO_PATHS.forms,
    navigationSection: 'engagement',
    requiredCapability: 'forms.manage',
    labelKey: 'navigation.forms',
    icon: 'forms',
    end: true,
  },
  {
    id: 'newsletters',
    path: STUDIO_PATHS.newsletters,
    navigationSection: 'engagement',
    requiredCapability: 'newsletters.manage',
    labelKey: 'navigation.newsletters',
    icon: 'newsletter',
    end: true,
  },
  {
    id: 'media',
    path: STUDIO_PATHS.media,
    navigationSection: 'content',
    requiredCapability: 'media.manage',
    labelKey: 'navigation.media',
    icon: 'media',
    end: true,
  },
  {
    id: 'postEditor',
    path: STUDIO_PATHS.postEditor,
    navigationSection: null,
    requiredCapability: 'posts.contribute',
    labelKey: 'navigation.posts',
    icon: 'posts',
    end: true,
  },
  {
    id: 'authors',
    path: STUDIO_PATHS.authors,
    navigationSection: 'content',
    requiredCapability: 'authors.manage',
    labelKey: 'navigation.authors',
    icon: 'authors',
    end: true,
  },
  {
    id: 'menus',
    path: STUDIO_PATHS.menus,
    navigationSection: 'site',
    requiredCapability: 'menus.manage',
    labelKey: 'navigation.menus',
    icon: 'menus',
    end: true,
  },
  {
    id: 'widgets',
    path: STUDIO_PATHS.widgets,
    navigationSection: 'site',
    requiredCapability: 'widgets.manage',
    labelKey: 'navigation.widgets',
    icon: 'widgets',
    end: true,
  },
  {
    id: 'taxonomy',
    path: STUDIO_PATHS.taxonomy,
    navigationSection: 'content',
    requiredCapability: 'taxonomies.manage',
    labelKey: 'navigation.taxonomy',
    icon: 'taxonomy',
    end: true,
  },
  {
    id: 'wxrImport',
    path: STUDIO_PATHS.wxrImport,
    navigationSection: null,
    requiredCapability: 'imports.manage',
    labelKey: 'navigation.wxrImport',
    icon: 'import',
    end: true,
  },
  {
    id: 'users',
    path: STUDIO_PATHS.users,
    navigationSection: 'utility',
    requiredCapability: 'users.manage',
    labelKey: 'navigation.users',
    icon: 'users',
    end: true,
  },
  {
    id: 'generalSettings',
    path: STUDIO_PATHS.generalSettings,
    navigationSection: 'site',
    requiredCapability: 'settings.manage',
    labelKey: 'navigation.siteSettings',
    icon: 'settings',
    end: true,
  },
  {
    id: 'interfaceSettings',
    path: STUDIO_PATHS.interfaceSettings,
    navigationSection: null,
    requiredCapability: 'settings.manage',
    labelKey: 'navigation.siteSettings',
    icon: 'settings',
    end: true,
  },
  {
    id: 'outputSettings',
    path: STUDIO_PATHS.outputSettings,
    navigationSection: null,
    requiredCapability: 'settings.manage',
    labelKey: 'navigation.siteSettings',
    icon: 'settings',
    end: true,
  },
  {
    id: 'brandingSettings',
    path: STUDIO_PATHS.brandingSettings,
    navigationSection: null,
    requiredCapability: 'settings.manage',
    labelKey: 'navigation.siteSettings',
    icon: 'settings',
    end: true,
  },
  {
    id: 'customCodeSettings',
    path: STUDIO_PATHS.customCodeSettings,
    navigationSection: null,
    requiredCapability: 'settings.manage',
    labelKey: 'navigation.siteSettings',
    icon: 'settings',
    end: true,
  },
  {
    id: 'routingSettings',
    path: STUDIO_PATHS.routingSettings,
    navigationSection: null,
    requiredCapability: 'settings.manage',
    labelKey: 'navigation.siteSettings',
    icon: 'settings',
    end: true,
  },
  {
    id: 'commentSettings',
    path: STUDIO_PATHS.commentSettings,
    navigationSection: null,
    requiredCapability: 'settings.manage',
    labelKey: 'navigation.edgeServices',
    icon: 'settings',
    end: true,
  },
  {
    id: 'edgeSecuritySettings',
    path: STUDIO_PATHS.edgeSecuritySettings,
    navigationSection: null,
    requiredCapability: 'settings.manage',
    labelKey: 'navigation.edgeServices',
    icon: 'settings',
    end: true,
  },
  {
    id: 'edgeServicesSettings',
    path: STUDIO_PATHS.edgeServicesSettings,
    navigationSection: 'engagement',
    requiredCapability: 'settings.manage',
    labelKey: 'navigation.edgeServices',
    icon: 'settings',
    end: true,
  },
  {
    id: 'mediaSettings',
    path: STUDIO_PATHS.mediaSettings,
    navigationSection: null,
    requiredCapability: 'settings.manage',
    labelKey: 'navigation.siteSettings',
    icon: 'settings',
    end: true,
  },
  {
    id: 'newsletterSettings',
    path: STUDIO_PATHS.newsletterSettings,
    navigationSection: null,
    requiredCapability: 'settings.manage',
    labelKey: 'navigation.siteSettings',
    icon: 'settings',
    end: true,
  },
  {
    id: 'mailSettings',
    path: STUDIO_PATHS.mailSettings,
    navigationSection: null,
    requiredCapability: 'settings.manage',
    labelKey: 'navigation.edgeServices',
    icon: 'settings',
    end: true,
  },
  {
    id: 'studioPreferences',
    path: STUDIO_PATHS.studioPreferences,
    navigationSection: 'account',
    requiredCapability: null,
    labelKey: 'navigation.studioPreferences',
    icon: 'settings',
    end: true,
  },
  {
    id: 'accountSecurity',
    path: STUDIO_PATHS.accountSecurity,
    navigationSection: 'account',
    requiredCapability: null,
    labelKey: 'navigation.accountSecurity',
    icon: 'security',
    end: false,
  },
  {
    id: 'passwordChange',
    path: STUDIO_PATHS.passwordChange,
    navigationSection: null,
    requiredCapability: null,
    labelKey: 'navigation.accountSecurity',
    icon: 'security',
    end: true,
  },
  {
    id: 'mfaReplace',
    path: STUDIO_PATHS.mfaReplace,
    navigationSection: null,
    requiredCapability: null,
    labelKey: 'navigation.accountSecurity',
    icon: 'security',
    end: true,
  },
  {
    id: 'webAuthnCredentials',
    path: STUDIO_PATHS.webAuthnCredentials,
    navigationSection: null,
    requiredCapability: null,
    labelKey: 'navigation.accountSecurity',
    icon: 'security',
    end: true,
  },
] as const satisfies readonly StudioRouteDefinition[];

export const STUDIO_PRIMARY_NAVIGATION =
  STUDIO_ROUTE_DEFINITIONS.filter(
    (route) => route.navigationSection === 'overview'
      || route.navigationSection === 'content'
      || route.navigationSection === 'engagement'
      || route.navigationSection === 'site'
      || route.navigationSection === 'utility',
  );

export const STUDIO_ACCOUNT_NAVIGATION =
  STUDIO_ROUTE_DEFINITIONS.filter(
    (route) => route.navigationSection === 'account',
  );
