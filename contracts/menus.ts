import { z } from 'zod';
import { apiErrorSchema } from './api';
import { settingsRevisionSchema } from './settings-revision';

export const MENU_ID_MAX_LENGTH = 64;
export const MENU_NAME_MAX_LENGTH = 120;
export const MENU_ITEM_TITLE_MAX_LENGTH = 200;
export const MENU_CUSTOM_URL_MAX_LENGTH = 2_048;
export const MENU_MAX_DEPTH = 10;
export const MENU_MAX_ITEMS = 500;
export const MENU_MAX_COUNT = 100;
export const MENU_ITEMS_JSON_MAX_BYTES = 900_000;
export const MENU_META_MAX_KEYS = 32;
export const MENU_META_KEY_MAX_LENGTH = 100;
export const MENU_META_STRING_MAX_LENGTH = 2_048;

export const DEFAULT_MENU_IDS = ['primary', 'footer'] as const;
export type DefaultMenuId = typeof DEFAULT_MENU_IDS[number];

export const menuIdSchema = z.string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/u);

export const customMenuIdSchema = menuIdSchema.refine(
  (value) => !isDefaultMenuId(value),
);

export const menuNameInputSchema = z.string()
  .trim()
  .min(1)
  .max(MENU_NAME_MAX_LENGTH);

export const menuNameSchema = z.string()
  .min(1)
  .max(MENU_NAME_MAX_LENGTH)
  .refine((value) => value === value.trim());

export const menuItemIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);
export const menuItemTargetSchema = z.enum(['_self', '_blank']);
export const menuReferenceKindSchema = z.enum([
  'post',
  'page',
  'category',
  'tag',
]);
export type MenuMetaValue = string | number | boolean | null;

function isSafeUrlString(value: string): boolean {
  return (
    value !== ''
    && value.trim() === value
    && !/[\s\\\p{Cc}]/u.test(value)
    && !/%(?![0-9A-Fa-f]{2})/u.test(value)
  );
}

function hasDotPathSegment(value: string): boolean {
  let rawPath: string;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) {
    const authorityStart = value.indexOf('://') + 3;
    const suffix = value.slice(authorityStart);
    const delimiterIndex = suffix.search(/[/?#]/u);
    rawPath = delimiterIndex === -1 || suffix[delimiterIndex] !== '/'
      ? '/'
      : suffix.slice(delimiterIndex).split(/[?#]/u, 1)[0];
  } else {
    rawPath = value.split(/[?#]/u, 1)[0];
  }
  return rawPath.split('/').some((segment) => {
    if (segment === '') return false;
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === '.' || decoded === '..';
    } catch {
      return true;
    }
  });
}

export function isMenuNavigationUrl(value: string): boolean {
  if (!isSafeUrlString(value) || value.startsWith('//')) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) {
    if (!/^https?:\/\//iu.test(value)) return false;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      (url.protocol === 'http:' || url.protocol === 'https:')
      && url.hostname !== ''
      && url.username === ''
      && url.password === ''
      && !hasDotPathSegment(value)
    );
  }
  return value.startsWith('/') && !value.startsWith('//')
    && !hasDotPathSegment(value);
}

export const menuCustomUrlInputSchema = z.string()
  .trim()
  .min(1)
  .max(MENU_CUSTOM_URL_MAX_LENGTH)
  .refine(isMenuNavigationUrl);

export const menuCustomUrlSchema = z.string()
  .min(1)
  .max(MENU_CUSTOM_URL_MAX_LENGTH)
  .refine((value) => value === value.trim() && isMenuNavigationUrl(value));

const menuMetaValueSchema = z.union([
  z.string().max(MENU_META_STRING_MAX_LENGTH),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const menuMetaSchema = z.record(
  z.string().min(1).max(MENU_META_KEY_MAX_LENGTH),
  menuMetaValueSchema,
).superRefine((value, context) => {
  if (Object.keys(value).length > MENU_META_MAX_KEYS) {
    context.addIssue({
      code: 'custom',
      message: `Menu metadata may have at most ${MENU_META_MAX_KEYS} keys.`,
    });
  }
});

export const menuItemLinkSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('custom'),
    url: menuCustomUrlSchema,
  }).strict(),
  z.object({
    kind: z.literal('post'),
    reference_id: menuItemIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('page'),
    reference_id: menuItemIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('category'),
    reference_id: menuItemIdSchema,
  }).strict(),
  z.object({
    kind: z.literal('tag'),
    reference_id: menuItemIdSchema,
  }).strict(),
]);

export type MenuItemLink = z.infer<typeof menuItemLinkSchema>;

export type MenuItem = {
  id: string;
  title: string;
  link: MenuItemLink;
  target: '_self' | '_blank';
  meta?: Record<string, MenuMetaValue>;
  children: MenuItem[];
};

export type MenuItemInput = {
  id: string;
  title: string;
  link: MenuItemLink;
  target: '_self' | '_blank';
  meta?: Record<string, MenuMetaValue>;
  children: MenuItemInput[];
};

export const menuItemSchema: z.ZodType<MenuItem> = z.lazy(() => z.object({
  id: menuItemIdSchema,
  title: z.string()
    .min(1)
    .max(MENU_ITEM_TITLE_MAX_LENGTH)
    .refine((value) => value === value.trim()),
  link: menuItemLinkSchema,
  target: menuItemTargetSchema,
  meta: menuMetaSchema.optional(),
  children: z.array(menuItemSchema),
}).strict());

const menuItemLinkInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('custom'),
    url: menuCustomUrlInputSchema,
  }).strict(),
  ...menuItemLinkSchema.options.slice(1),
]);

export const menuItemInputSchema: z.ZodType<MenuItemInput> = z.lazy(() => (
  z.object({
    id: menuItemIdSchema,
    title: z.string()
      .trim()
      .min(1)
      .max(MENU_ITEM_TITLE_MAX_LENGTH),
    link: menuItemLinkInputSchema,
    target: menuItemTargetSchema,
    meta: menuMetaSchema.optional(),
    children: z.array(menuItemInputSchema),
  }).strict()
));

function inspectMenuTree(
  items: MenuItem[],
  context: z.RefinementCtx,
): void {
  const ids = new Set<string>();
  let count = 0;
  const pending = items.map((item) => ({ item, depth: 1 }));
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    count += 1;
    if (count > MENU_MAX_ITEMS) {
      context.addIssue({
        code: 'custom',
        message: `A menu may have at most ${MENU_MAX_ITEMS} items.`,
      });
      return;
    }
    if (current.depth > MENU_MAX_DEPTH) {
      context.addIssue({
        code: 'custom',
        message: `Menu item depth may not exceed ${MENU_MAX_DEPTH}.`,
      });
      return;
    }
    if (ids.has(current.item.id)) {
      context.addIssue({
        code: 'custom',
        message: 'Menu item IDs must be unique within a menu.',
      });
      return;
    }
    ids.add(current.item.id);
    for (const child of current.item.children) {
      pending.push({ item: child, depth: current.depth + 1 });
    }
  }
}

export const menuItemsSchema = z.array(menuItemSchema)
  .superRefine((items, context) => {
    inspectMenuTree(items, context);
    if (
      new TextEncoder().encode(JSON.stringify(items)).byteLength
      > MENU_ITEMS_JSON_MAX_BYTES
    ) {
      context.addIssue({
        code: 'custom',
        message: `Menu items may use at most ${MENU_ITEMS_JSON_MAX_BYTES} UTF-8 bytes.`,
      });
    }
  });

export const menuItemInputsSchema = z.array(menuItemInputSchema)
  .superRefine((items, context) => {
    inspectMenuTree(items, context);
    if (
      new TextEncoder().encode(JSON.stringify(items)).byteLength
      > MENU_ITEMS_JSON_MAX_BYTES
    ) {
      context.addIssue({
        code: 'custom',
        message: `Menu items may use at most ${MENU_ITEMS_JSON_MAX_BYTES} UTF-8 bytes.`,
      });
    }
  });

export const menuSchema = z.object({
  menu_id: menuIdSchema,
  name: menuNameSchema,
  enabled: z.boolean(),
  items: menuItemsSchema,
  revision: settingsRevisionSchema,
  created_at_iso: z.iso.datetime({ offset: true }),
  updated_at_iso: z.iso.datetime({ offset: true }),
}).strict().refine((value) => (
  Date.parse(value.created_at_iso) <= Date.parse(value.updated_at_iso)
));

export const createMenuRequestSchema = z.object({
  menu_id: customMenuIdSchema,
  name: menuNameInputSchema,
  enabled: z.boolean().default(true),
  items: menuItemInputsSchema.default([]),
}).strict();

export const saveMenuRequestSchema = z.object({
  name: menuNameInputSchema,
  enabled: z.boolean(),
  items: menuItemInputsSchema,
  // null asserts that this default menu has not been stored yet. It is not
  // permission to overwrite an existing menu without a revision check.
  expected_revision: settingsRevisionSchema.nullable(),
}).strict();

export const deleteMenuRequestSchema = z.object({
  expected_revision: settingsRevisionSchema,
}).strict();

export const menuListSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(menuSchema).max(MENU_MAX_COUNT),
  }).strict(),
}).strict();

export const menuListResponseSchema = z.union([
  menuListSuccessSchema,
  apiErrorSchema,
]);

export const menuMutationSuccessSchema = z.object({
  success: z.literal(true),
  data: menuSchema,
}).strict();

export const menuMutationResponseSchema = z.union([
  menuMutationSuccessSchema,
  apiErrorSchema,
]);

export const menuSaveSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    // The selected menu and the two defaults, without duplicate documents.
    items: z.array(menuSchema).min(2).max(3).superRefine((items, context) => {
      const ids = new Set(items.map((menu) => menu.menu_id));
      if (ids.size !== items.length || DEFAULT_MENU_IDS.some((id) => !ids.has(id))) {
        context.addIssue({ code: 'custom', message: 'Saved menus must include both defaults exactly once.' });
      }
    }),
  }).strict(),
}).strict();

export const menuSaveResponseSchema = z.union([
  menuSaveSuccessSchema,
  apiErrorSchema,
]);

export const menuDeleteSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('menu_deleted'),
    menu_id: menuIdSchema,
  }).strict(),
}).strict();

export const menuDeleteResponseSchema = z.union([
  menuDeleteSuccessSchema,
  apiErrorSchema,
]);

export const menuReferenceSummarySchema = z.object({
  kind: menuReferenceKindSchema,
  reference_id: menuItemIdSchema,
  title: z.string().min(1).max(MENU_ITEM_TITLE_MAX_LENGTH),
  // A nested Page path has no aggregate contract limit, so the summary
  // must not impose a smaller limit than the Page it represents.
  detail: z.string(),
}).strict();

export const menuReferenceSchema = z.object({
  kind: menuReferenceKindSchema,
  reference_id: menuItemIdSchema,
}).strict();

export function menuReferenceKey(reference: MenuReference): string {
  return `${reference.kind}:${reference.reference_id}`;
}

export const resolveMenuReferencesRequestSchema = z.object({
  references: z.array(menuReferenceSchema).min(1).max(MENU_MAX_ITEMS)
    .refine((items) => new Set(items.map(menuReferenceKey)).size === items.length),
}).strict();

export const menuReferenceResolutionSchema = z.discriminatedUnion('status', [
  menuReferenceSummarySchema.extend({ status: z.literal('available') }),
  menuReferenceSchema.extend({ status: z.literal('missing') }),
  menuReferenceSchema.extend({
    kind: z.enum(['post', 'page']),
    status: z.literal('trash'),
  }),
]);

export const menuReferencesSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(menuReferenceResolutionSchema).min(1).max(MENU_MAX_ITEMS)
      .refine((items) => new Set(items.map(menuReferenceKey)).size === items.length),
  }).strict(),
}).strict();

export const menuReferencesResponseSchema = z.union([
  menuReferencesSuccessSchema,
  apiErrorSchema,
]);

function sortMeta(
  meta: Record<string, MenuMetaValue> | undefined,
): Record<string, MenuMetaValue> | undefined {
  if (!meta || Object.keys(meta).length === 0) return undefined;
  return Object.fromEntries(
    Object.entries(meta).sort(([left], [right]) => (
      left < right ? -1 : left > right ? 1 : 0
    )),
  );
}

export function canonicalizeMenuItems(
  items: MenuItem[] | MenuItemInput[],
): MenuItem[] {
  return menuItemInputsSchema.parse(items).map((item) => {
    const meta = sortMeta(item.meta);
    return {
      id: item.id,
      title: item.title,
      link: item.link,
      target: item.target,
      ...(meta ? { meta } : {}),
      children: canonicalizeMenuItems(item.children),
    };
  });
}

export function isDefaultMenuId(menuId: string): menuId is DefaultMenuId {
  return (DEFAULT_MENU_IDS as readonly string[]).includes(menuId);
}

export function createDefaultMenuDraft(menuId: DefaultMenuId): MenuDraft {
  return {
    menu_id: menuId,
    // These are initial authored names, not translated interface labels.
    name: menuId === 'primary' ? 'Primary Menu' : 'Footer Menu',
    enabled: true,
    items: [],
  };
}

export type Menu = z.infer<typeof menuSchema>;
export type MenuDraft = Pick<Menu, 'menu_id' | 'name' | 'enabled' | 'items'>;
export type CreateMenuRequest = z.infer<typeof createMenuRequestSchema>;
export type SaveMenuRequest = z.infer<typeof saveMenuRequestSchema>;
export type DeleteMenuRequest = z.infer<typeof deleteMenuRequestSchema>;
export type MenuListResponse = z.infer<typeof menuListResponseSchema>;
export type MenuMutationResponse = z.infer<typeof menuMutationResponseSchema>;
export type MenuSaveResponse = z.infer<typeof menuSaveResponseSchema>;
export type MenuDeleteResponse = z.infer<typeof menuDeleteResponseSchema>;
export type MenuReferenceKind = z.infer<typeof menuReferenceKindSchema>;
export type MenuReferenceSummary = z.infer<typeof menuReferenceSummarySchema>;
export type MenuReference = z.infer<typeof menuReferenceSchema>;
export type MenuReferenceResolution = z.infer<typeof menuReferenceResolutionSchema>;
export type ResolveMenuReferencesRequest = z.infer<typeof resolveMenuReferencesRequestSchema>;
export type MenuReferencesResponse = z.infer<typeof menuReferencesResponseSchema>;
