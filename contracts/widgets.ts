import { z } from 'zod';
import { apiErrorSchema } from './api';
import { authorIdSchema } from './authors';
import {
  menuCustomUrlInputSchema,
  menuCustomUrlSchema,
  menuItemTargetSchema,
} from './menus';
import { settingsRevisionSchema } from './settings-revision';

export const WIDGET_AREA_ID_MAX_LENGTH = 64;
export const WIDGET_AREA_NAME_MAX_LENGTH = 120;
export const WIDGET_TITLE_MAX_LENGTH = 200;
export const WIDGET_MAX_ITEMS = 100;
export const WIDGET_AREA_MAX_COUNT = 100;
export const WIDGET_ITEMS_JSON_MAX_BYTES = 900_000;
export const WIDGET_TEXT_CONTENT_MAX_LENGTH = 50_000;
export const WIDGET_LINK_MAX_COUNT = 100;
export const SIDEBAR_WIDGET_AREA_ID = 'sidebar';
export const SIDEBAR_WIDGET_AREA_NAME = 'Sidebar Widgets';

export const WIDGET_TYPES = [
  'search',
  'recent-posts',
  'categories',
  'tags',
  'archives',
  'text',
  'link-list',
  'profile',
] as const;

export const widgetTypeSchema = z.enum(WIDGET_TYPES);

export const widgetAreaIdSchema = z.string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/u);

export const customWidgetAreaIdSchema = widgetAreaIdSchema.refine(
  (value) => !isProtectedWidgetAreaId(value),
);

export const widgetAreaNameInputSchema = z.string()
  .trim()
  .min(1)
  .max(WIDGET_AREA_NAME_MAX_LENGTH);

export const widgetAreaNameSchema = z.string()
  .min(1)
  .max(WIDGET_AREA_NAME_MAX_LENGTH)
  .refine((value) => value === value.trim());

export const widgetItemIdSchema = z.string().regex(/^[0-9a-f]{32}$/u);
export const widgetDocumentTypeSchema = z.enum([
  'plaintext',
  'markdown',
  'html',
]);

const widgetTitleInputSchema = z.string().trim().max(WIDGET_TITLE_MAX_LENGTH);
const widgetTitleSchema = z.string()
  .max(WIDGET_TITLE_MAX_LENGTH)
  .refine((value) => value === value.trim());

const storedTrimmedString = (maximum: number, minimum = 0) => z.string()
  .min(minimum)
  .max(maximum)
  .refine((value) => value === value.trim());

const inputTrimmedString = (maximum: number, minimum = 0) => z.string()
  .trim()
  .min(minimum)
  .max(maximum);

function createWidgetItemSchema(input: boolean) {
  const title = input ? widgetTitleInputSchema : widgetTitleSchema;
  const placeholder = input
    ? inputTrimmedString(200, 1)
    : storedTrimmedString(200, 1);
  const buttonLabel = input
    ? inputTrimmedString(80, 1)
    : storedTrimmedString(80, 1);
  const linkLabel = input
    ? inputTrimmedString(200, 1)
    : storedTrimmedString(200, 1);
  const linkUrl = input ? menuCustomUrlInputSchema : menuCustomUrlSchema;

  return z.discriminatedUnion('type', [
    z.object({
      id: widgetItemIdSchema,
      type: z.literal('search'),
      title,
      enabled: z.boolean(),
      settings: z.object({
        placeholder,
        button_label: buttonLabel,
      }).strict(),
    }).strict(),
    z.object({
      id: widgetItemIdSchema,
      type: z.literal('recent-posts'),
      title,
      enabled: z.boolean(),
      settings: z.object({
        limit: z.number().int().min(1).max(20),
        show_date: z.boolean(),
      }).strict(),
    }).strict(),
    z.object({
      id: widgetItemIdSchema,
      type: z.literal('categories'),
      title,
      enabled: z.boolean(),
      settings: z.object({
        show_count: z.boolean(),
        hierarchical: z.boolean(),
      }).strict(),
    }).strict(),
    z.object({
      id: widgetItemIdSchema,
      type: z.literal('tags'),
      title,
      enabled: z.boolean(),
      settings: z.object({
        limit: z.number().int().min(1).max(100),
        show_count: z.boolean(),
      }).strict(),
    }).strict(),
    z.object({
      id: widgetItemIdSchema,
      type: z.literal('archives'),
      title,
      enabled: z.boolean(),
      settings: z.object({
        limit: z.number().int().min(1).max(120),
      }).strict(),
    }).strict(),
    z.object({
      id: widgetItemIdSchema,
      type: z.literal('text'),
      title,
      enabled: z.boolean(),
      settings: z.object({
        document_type: widgetDocumentTypeSchema,
        content: z.string().max(WIDGET_TEXT_CONTENT_MAX_LENGTH),
      }).strict(),
    }).strict(),
    z.object({
      id: widgetItemIdSchema,
      type: z.literal('link-list'),
      title,
      enabled: z.boolean(),
      settings: z.object({
        links: z.array(z.object({
          label: linkLabel,
          url: linkUrl,
          target: menuItemTargetSchema,
        }).strict()).max(WIDGET_LINK_MAX_COUNT),
      }).strict(),
    }).strict(),
    z.object({
      id: widgetItemIdSchema,
      type: z.literal('profile'),
      title,
      enabled: z.boolean(),
      settings: z.object({
        author_id: authorIdSchema,
      }).strict(),
    }).strict(),
  ]);
}

export const widgetItemSchema = createWidgetItemSchema(false);
export const widgetItemInputSchema = createWidgetItemSchema(true);

function inspectWidgetItems(
  items: Array<{ id: string }>,
  context: z.RefinementCtx,
): void {
  if (items.length > WIDGET_MAX_ITEMS) {
    context.addIssue({
      code: 'custom',
      message: `A widget area may have at most ${WIDGET_MAX_ITEMS} items.`,
    });
    return;
  }
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) {
      context.addIssue({
        code: 'custom',
        message: 'Widget item IDs must be unique within a widget area.',
      });
      return;
    }
    ids.add(item.id);
  }
  if (
    new TextEncoder().encode(JSON.stringify(items)).byteLength
    > WIDGET_ITEMS_JSON_MAX_BYTES
  ) {
    context.addIssue({
      code: 'custom',
      message: `Widget items may use at most ${WIDGET_ITEMS_JSON_MAX_BYTES} UTF-8 bytes.`,
    });
  }
}

export const widgetItemsSchema = z.array(widgetItemSchema)
  .superRefine(inspectWidgetItems);

export const widgetItemInputsSchema = z.array(widgetItemInputSchema)
  .superRefine(inspectWidgetItems);

export const widgetAreaSchema = z.object({
  widget_area_id: widgetAreaIdSchema,
  name: widgetAreaNameSchema,
  enabled: z.boolean(),
  items: widgetItemsSchema,
  revision: settingsRevisionSchema,
  created_at_iso: z.iso.datetime({ offset: true }),
  updated_at_iso: z.iso.datetime({ offset: true }),
}).strict().refine((value) => (
  Date.parse(value.created_at_iso) <= Date.parse(value.updated_at_iso)
));

export const createWidgetAreaRequestSchema = z.object({
  widget_area_id: customWidgetAreaIdSchema,
  name: widgetAreaNameInputSchema,
}).strict();

export const saveWidgetAreaRequestSchema = z.object({
  name: widgetAreaNameInputSchema,
  enabled: z.boolean(),
  items: widgetItemInputsSchema,
  // null asserts that the protected sidebar draft has not been stored yet.
  // It never permits an unrevisioned overwrite of an existing area.
  expected_revision: settingsRevisionSchema.nullable(),
}).strict();

export const deleteWidgetAreaRequestSchema = z.object({
  expected_revision: settingsRevisionSchema,
}).strict();

export const widgetAreaListSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(widgetAreaSchema).max(WIDGET_AREA_MAX_COUNT),
  }).strict(),
}).strict();

export const widgetAreaListResponseSchema = z.union([
  widgetAreaListSuccessSchema,
  apiErrorSchema,
]);

export const widgetAreaMutationSuccessSchema = z.object({
  success: z.literal(true),
  data: widgetAreaSchema,
}).strict();

export const widgetAreaMutationResponseSchema = z.union([
  widgetAreaMutationSuccessSchema,
  apiErrorSchema,
]);

export const widgetAreaDeleteSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    status: z.literal('widget_area_deleted'),
    widget_area_id: widgetAreaIdSchema,
  }).strict(),
}).strict();

export const widgetAreaDeleteResponseSchema = z.union([
  widgetAreaDeleteSuccessSchema,
  apiErrorSchema,
]);

export const widgetAuthorOptionsQuerySchema = z.object({
  search: z.string().trim().max(200).default(''),
}).strict();

export const widgetAuthorOptionSchema = z.object({
  id: authorIdSchema,
  display_name: storedTrimmedString(200, 1),
}).strict();

export const widgetAuthorOptionsSuccessSchema = z.object({
  success: z.literal(true),
  data: z.object({
    items: z.array(widgetAuthorOptionSchema).max(100),
  }).strict(),
}).strict();

export const widgetAuthorOptionsResponseSchema = z.union([
  widgetAuthorOptionsSuccessSchema,
  apiErrorSchema,
]);

export function canonicalizeWidgetItems(
  items: WidgetItem[] | WidgetItemInput[],
): WidgetItem[] {
  return widgetItemsSchema.parse(widgetItemInputsSchema.parse(items));
}

export function createDefaultWidgetAreaDraft(): WidgetAreaDraft {
  return {
    widget_area_id: SIDEBAR_WIDGET_AREA_ID,
    // This is initial authored content, not a translated interface label.
    name: SIDEBAR_WIDGET_AREA_NAME,
    enabled: true,
    items: canonicalizeWidgetItems([
      {
        id: '00000000000000000000000000000001',
        type: 'search',
        title: 'Search',
        enabled: true,
        settings: { placeholder: 'Search...', button_label: 'Search' },
      },
      {
        id: '00000000000000000000000000000002',
        type: 'recent-posts',
        title: 'Recent Posts',
        enabled: true,
        settings: { limit: 5, show_date: true },
      },
      {
        id: '00000000000000000000000000000003',
        type: 'categories',
        title: 'Categories',
        enabled: true,
        settings: { show_count: false, hierarchical: false },
      },
      {
        id: '00000000000000000000000000000004',
        type: 'tags',
        title: 'Tags',
        enabled: true,
        settings: { limit: 20, show_count: false },
      },
      {
        id: '00000000000000000000000000000005',
        type: 'archives',
        title: 'Archives',
        enabled: true,
        settings: { limit: 12 },
      },
    ]),
  };
}

export function isProtectedWidgetAreaId(widgetAreaId: string): boolean {
  return widgetAreaId === SIDEBAR_WIDGET_AREA_ID;
}

export type WidgetType = z.infer<typeof widgetTypeSchema>;
export type WidgetItem = z.infer<typeof widgetItemSchema>;
export type WidgetItemInput = z.infer<typeof widgetItemInputSchema>;
export type WidgetArea = z.infer<typeof widgetAreaSchema>;
export type WidgetAreaDraft = Pick<
  WidgetArea,
  'widget_area_id' | 'name' | 'enabled' | 'items'
>;
export type CreateWidgetAreaRequest = z.infer<
  typeof createWidgetAreaRequestSchema
>;
export type SaveWidgetAreaRequest = z.infer<
  typeof saveWidgetAreaRequestSchema
>;
export type DeleteWidgetAreaRequest = z.infer<
  typeof deleteWidgetAreaRequestSchema
>;
export type WidgetAreaListResponse = z.infer<
  typeof widgetAreaListResponseSchema
>;
export type WidgetAreaMutationResponse = z.infer<
  typeof widgetAreaMutationResponseSchema
>;
export type WidgetAreaDeleteResponse = z.infer<
  typeof widgetAreaDeleteResponseSchema
>;
export type WidgetAuthorOption = z.infer<typeof widgetAuthorOptionSchema>;
export type WidgetAuthorOptionsResponse = z.infer<
  typeof widgetAuthorOptionsResponseSchema
>;
