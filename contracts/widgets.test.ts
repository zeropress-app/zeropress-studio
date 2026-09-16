import { describe, expect, it } from 'vitest';
import {
  canonicalizeWidgetItems,
  createDefaultWidgetAreaDraft,
  createWidgetAreaRequestSchema,
  saveWidgetAreaRequestSchema,
  WIDGET_TYPES,
  widgetItemInputsSchema,
} from './widgets';

describe('Widget contracts', () => {
  it('supports only Build Core-resolved first-slice widget types', () => {
    expect(WIDGET_TYPES).toEqual([
      'search',
      'recent-posts',
      'categories',
      'tags',
      'archives',
      'text',
      'link-list',
      'profile',
    ]);
    expect(widgetItemInputsSchema.safeParse([{
      id: '1'.repeat(32),
      type: 'image',
      title: 'Image',
      enabled: true,
      settings: { src: '/image.jpg' },
    }]).success).toBe(false);
  });

  it('keeps title required while accepting and canonicalizing an empty title', () => {
    const item = {
      id: '1'.repeat(32),
      type: 'search' as const,
      title: '   ',
      enabled: true,
      settings: { placeholder: ' Search... ', button_label: ' Search ' },
    };
    expect(canonicalizeWidgetItems([item])).toEqual([{
      ...item,
      title: '',
      settings: { placeholder: 'Search...', button_label: 'Search' },
    }]);
    expect(widgetItemInputsSchema.safeParse([{
      ...item,
      title: undefined,
    }]).success).toBe(false);
  });

  it('materializes one deterministic virtual sidebar draft', () => {
    const draft = createDefaultWidgetAreaDraft();
    expect(draft).toMatchObject({
      widget_area_id: 'sidebar',
      name: 'Sidebar Widgets',
      enabled: true,
    });
    expect(draft.items.map((item) => item.type)).toEqual([
      'search',
      'recent-posts',
      'categories',
      'tags',
      'archives',
    ]);
    expect(new Set(draft.items.map((item) => item.id)).size).toBe(5);
    expect(createDefaultWidgetAreaDraft()).toEqual(draft);
    expect(draft.items[0]).toMatchObject({
      title: 'Search',
      settings: { placeholder: 'Search...', button_label: 'Search' },
    });
    expect(draft.items[1]).toMatchObject({
      title: 'Recent Posts',
      settings: { limit: 5, show_date: true },
    });
  });

  it('reserves sidebar creation for nullable-revision saves', () => {
    expect(createWidgetAreaRequestSchema.safeParse({
      widget_area_id: 'sidebar',
      name: 'Sidebar Widgets',
    }).success).toBe(false);
    expect(createWidgetAreaRequestSchema.safeParse({
      widget_area_id: 'secondary',
      name: 'Secondary',
    }).success).toBe(true);
    expect(saveWidgetAreaRequestSchema.safeParse({
      name: 'Sidebar Widgets',
      enabled: true,
      items: createDefaultWidgetAreaDraft().items,
      expected_revision: null,
    }).success).toBe(true);
  });

  it('requires complete closed aggregate saves and unique item IDs', () => {
    const duplicate = {
      id: '1'.repeat(32),
      type: 'archives' as const,
      title: '',
      enabled: true,
      settings: { limit: 12 },
    };
    expect(saveWidgetAreaRequestSchema.safeParse({
      name: 'Sidebar',
      enabled: true,
      items: [duplicate, duplicate],
      expected_revision: '2'.repeat(32),
    }).success).toBe(false);
    expect(saveWidgetAreaRequestSchema.safeParse({
      name: 'Sidebar',
      enabled: true,
      items: [],
      expected_revision: '2'.repeat(32),
      image_support: true,
    }).success).toBe(false);
  });
});
