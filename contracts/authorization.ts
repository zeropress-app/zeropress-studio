import type { UserRole } from './users';

export const STUDIO_CAPABILITIES = [
  'users.manage',
  'authors.manage',
  'media.read',
  'media.manage',
  'taxonomies.manage',
  'posts.contribute',
  'posts.manage',
  'pages.manage',
  'menus.manage',
  'widgets.manage',
  'comments.manage',
  'forms.manage',
  'newsletters.manage',
  'newsletters.export',
  'imports.manage',
  'settings.manage',
  'publish.manage',
] as const;
export type StudioCapability = typeof STUDIO_CAPABILITIES[number];

const ROLE_CAPABILITIES = {
  admin: [
    'users.manage',
    'authors.manage',
    'media.read',
    'media.manage',
    'taxonomies.manage',
    'posts.contribute',
    'posts.manage',
    'pages.manage',
    'menus.manage',
    'widgets.manage',
    'comments.manage',
    'forms.manage',
    'newsletters.manage',
    'newsletters.export',
    'imports.manage',
    'settings.manage',
    'publish.manage',
  ],
  editor: [
    'media.read',
    'media.manage',
    'taxonomies.manage',
    'posts.contribute',
    'posts.manage',
    'pages.manage',
    'menus.manage',
    'widgets.manage',
    'comments.manage',
    'forms.manage',
  ],
  author: [
    'media.read',
    'posts.contribute',
  ],
} as const satisfies Record<UserRole, readonly StudioCapability[]>;

export function hasStudioCapability(
  roles: readonly string[],
  capability: StudioCapability,
): boolean {
  return roles.some((role) => (
    Object.hasOwn(ROLE_CAPABILITIES, role)
    && (ROLE_CAPABILITIES[role as UserRole] as readonly StudioCapability[])
      .includes(capability)
  ));
}
