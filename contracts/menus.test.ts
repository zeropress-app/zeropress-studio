import { describe, expect, it } from 'vitest';
import {
  canonicalizeMenuItems,
  createDefaultMenuDraft,
  createMenuRequestSchema,
  isDefaultMenuId,
  isMenuNavigationUrl,
  menuItemsSchema,
  menuReferencesSuccessSchema,
  menuSchema,
  menuSaveSuccessSchema,
  saveMenuRequestSchema,
  resolveMenuReferencesRequestSchema,
  type MenuItem,
} from './menus';

const baseItem = {
  id: '1'.repeat(32),
  title: 'Home',
  link: { kind: 'custom' as const, url: '/' },
  target: '_self' as const,
  children: [],
};

describe('Menu contract', () => {
  it('bounds exact-reference reads and keeps each typed identity unique', () => {
    const reference = { kind: 'post', reference_id: '1'.repeat(32) };
    expect(resolveMenuReferencesRequestSchema.safeParse({ references: [reference] }).success).toBe(true);
    expect(resolveMenuReferencesRequestSchema.safeParse({
      references: [reference, { ...reference, kind: 'page' }],
    }).success).toBe(true);
    for (const request of [
      { references: [] },
      { references: [reference, reference] },
      { references: [{ ...reference, kind: 'custom' }] },
      { references: [{ ...reference, reference_id: 'bad' }] },
      { references: [{ ...reference, title: 'extra' }] },
      { references: [reference], search: 'unrelated' },
      { references: Array.from({ length: 501 }, (_, index) => ({
        ...reference, reference_id: index.toString(16).padStart(32, '0'),
      })) },
    ]) {
      expect(resolveMenuReferencesRequestSchema.safeParse(request).success).toBe(false);
    }
  });

  it('distinguishes available, missing, and trashed references without accepting partial options', () => {
    const reference = { kind: 'post', reference_id: '1'.repeat(32) };
    const response = (items: unknown[]) => ({ success: true, data: { items } });
    for (const item of [
      { ...reference, status: 'available', title: 'Post', detail: 'post' },
      { ...reference, status: 'missing' },
      { ...reference, status: 'trash' },
    ]) {
      expect(menuReferencesSuccessSchema.safeParse(response([item])).success).toBe(true);
    }
    for (const items of [
      [{ ...reference, status: 'available' }],
      [{ ...reference, status: 'missing', title: 'Stale Post' }],
      [{ ...reference, status: 'unchecked' }],
      [{ ...reference, kind: 'category', status: 'trash' }],
      [{ ...reference, status: 'missing' }, { ...reference, status: 'trash' }],
    ]) {
      expect(menuReferencesSuccessSchema.safeParse(response(items)).success).toBe(false);
    }
  });

  it('normalizes authored text while keeping the stored document canonical', () => {
    const parsed = createMenuRequestSchema.parse({
      menu_id: 'navigation',
      name: '  Primary Menu  ',
      items: [{
        ...baseItem,
        title: '  Home  ',
        meta: { z: true, a: 'first' },
      }],
    });
    expect(parsed.name).toBe('Primary Menu');
    expect(canonicalizeMenuItems(parsed.items)).toEqual([{
      ...baseItem,
      meta: { a: 'first', z: true },
    }]);

    const stored = {
      menu_id: 'primary',
      name: 'Primary Menu',
      enabled: true,
      items: [baseItem],
      revision: '2'.repeat(32),
      created_at_iso: '2026-08-01T00:00:00.000Z',
      updated_at_iso: '2026-08-01T00:00:00.000Z',
    };
    expect(menuSchema.safeParse(stored).success).toBe(true);
    expect(menuSchema.safeParse({ ...stored, name: ' Primary Menu' }).success)
      .toBe(false);
  });

  it('matches the Preview Data navigation URL safety boundary', () => {
    for (const value of [
      '/',
      '/docs/v0.7/?from=menu#start',
      'https://example.com/docs',
    ]) {
      expect(isMenuNavigationUrl(value)).toBe(true);
    }
    for (const value of [
      '',
      'docs',
      '//example.com',
      '/docs/../admin',
      '/docs/%2e%2e/admin',
      'https://user:pass@example.com/',
      'https:example.com',
      'https:/example.com',
      'javascript:alert(1)',
      '/bad%2',
    ]) {
      expect(isMenuNavigationUrl(value)).toBe(false);
    }
  });

  it('limits depth, total count, and duplicate item identities', () => {
    let nested: MenuItem = baseItem;
    for (let index = 0; index < 10; index += 1) {
      nested = {
        ...baseItem,
        id: index.toString(16).padStart(32, '0'),
        children: [nested],
      };
    }
    expect(menuItemsSchema.safeParse([nested]).success).toBe(false);
    expect(menuItemsSchema.safeParse([
      baseItem,
      { ...baseItem, title: 'Duplicate' },
    ]).success).toBe(false);
  });

  it('keeps type-specific reference and custom-link objects closed', () => {
    expect(createMenuRequestSchema.safeParse({
      menu_id: 'docs_sidebar',
      name: 'Docs',
      items: [{
        ...baseItem,
        link: { kind: 'post', reference_id: 'a'.repeat(32) },
      }],
    }).success).toBe(true);
    expect(createMenuRequestSchema.safeParse({
      menu_id: 'docs_sidebar',
      name: 'Docs',
      items: [{
        ...baseItem,
        link: { kind: 'custom', url: '/docs', reference_id: 'a'.repeat(32) },
      }],
    }).success).toBe(false);
    expect(menuItemsSchema.safeParse([{
      ...baseItem, link: { kind: 'system', route: 'home' },
    }]).success).toBe(false);
  });

  it('materializes independent empty drafts without pretending they are stored menus', () => {
    const primary = createDefaultMenuDraft('primary');
    const footer = createDefaultMenuDraft('footer');
    expect(primary).toEqual({
      menu_id: 'primary', name: 'Primary Menu', enabled: true, items: [],
    });
    expect(footer).toEqual({
      menu_id: 'footer', name: 'Footer Menu', enabled: true, items: [],
    });
    primary.items.push(baseItem);
    expect(createDefaultMenuDraft('primary').items).toEqual([]);
    expect(footer.items).toEqual([]);
    expect(menuSchema.safeParse(primary).success).toBe(false);
    expect(isDefaultMenuId('primary')).toBe(true);
    expect(isDefaultMenuId('footer')).toBe(true);
    expect(isDefaultMenuId('docs')).toBe(false);
    for (const menuId of ['primary', 'footer']) {
      expect(createMenuRequestSchema.safeParse({ menu_id: menuId, name: 'Menu' }).success)
        .toBe(false);
    }
  });

  it('requires explicit absence or a valid revision when saving', () => {
    const draft = { name: ' Primary Menu ', enabled: true, items: [] };
    expect(saveMenuRequestSchema.parse({ ...draft, expected_revision: null }))
      .toEqual({ ...draft, name: 'Primary Menu', expected_revision: null });
    expect(saveMenuRequestSchema.safeParse(draft).success).toBe(false);
    expect(saveMenuRequestSchema.safeParse({ ...draft, expected_revision: '' }).success)
      .toBe(false);
    expect(saveMenuRequestSchema.safeParse({ ...draft, expected_revision: '1'.repeat(32) }).success)
      .toBe(true);
  });

  it('requires both defaults once in a save response', () => {
    const stored = (menu_id: string) => ({
      menu_id, name: menu_id, enabled: true, items: [],
      revision: '1'.repeat(32),
      created_at_iso: '2026-08-01T00:00:00.000Z',
      updated_at_iso: '2026-08-01T00:00:00.000Z',
    });
    const response = (ids: string[]) => ({
      success: true, data: { items: ids.map(stored) },
    });
    expect(menuSaveSuccessSchema.safeParse(response(['primary', 'footer'])).success).toBe(true);
    expect(menuSaveSuccessSchema.safeParse(response(['primary', 'footer', 'docs'])).success).toBe(true);
    for (const ids of [['primary'], ['primary', 'docs'], ['primary', 'footer', 'primary']]) {
      expect(menuSaveSuccessSchema.safeParse(response(ids)).success).toBe(false);
    }
  });
});
