import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ExternalLink, Hash,
  ListTree, Pencil, Plus, RefreshCw, Save, Trash2, Type, Undo2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import type { ApiErrorCode } from '../../contracts/api';
import {
  DEFAULT_MENU_IDS, MENU_MAX_DEPTH, MENU_MAX_ITEMS,
  createDefaultMenuDraft, createMenuRequestSchema, isDefaultMenuId,
  menuMetaSchema, menuNameInputSchema, menuReferenceKey, saveMenuRequestSchema,
  type Menu, type MenuDraft, type MenuItem, type MenuMetaValue,
} from '../../contracts/menus';
import {
  ActionMenu, Button, Dialog, DialogActions, EmptyState, Field, Notice,
  PageHeader, Panel, RouteLoading, StatusPill, StudioIcon, useStudioToast,
} from './components/primitives';
import { MenuItemEditorDialog, MENU_LINK_ICONS } from './components/MenuItemEditorDialog';
import { UnsavedChangesGuard } from './components/UnsavedChangesGuard';
import { useMenuReferences } from './hooks/useMenuReferences';
import {
  MenusClientError, requestCreateMenu, requestDeleteMenu,
  requestMenus, requestSaveMenu,
} from './lib/menus-client';

type AccountSession = { csrf_token: string };
type LoadState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error' };
type Failure =
  | { kind: 'validation'; code: 'menu' | 'item' | 'meta' | 'dirtySelection' | 'maxDepth' }
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: 'TIMEOUT' | 'NETWORK_ERROR' | 'INVALID_RESPONSE' };

function menuTargets(menus: Menu[]): MenuDraft[] {
  return [
    ...DEFAULT_MENU_IDS.map((id) => (
      menus.find((menu) => menu.menu_id === id) ?? createDefaultMenuDraft(id)
    )),
    ...menus.filter((menu) => !isDefaultMenuId(menu.menu_id)),
  ];
}

function createItemId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function cloneItems(items: MenuItem[]): MenuItem[] {
  return structuredClone(items);
}

function countItems(items: MenuItem[]): number {
  return items.reduce(
    (total, item) => total + 1 + countItems(item.children),
    0,
  );
}

function findItemPath(
  items: MenuItem[],
  id: string,
  prefix: number[] = [],
): number[] | null {
  for (const [index, item] of items.entries()) {
    const path = [...prefix, index];
    if (item.id === id) return path;
    const nested = findItemPath(item.children, id, path);
    if (nested) return nested;
  }
  return null;
}

function listAtParentPath(items: MenuItem[], parentPath: number[]): MenuItem[] {
  let list = items;
  for (const index of parentPath) list = list[index].children;
  return list;
}

function subtreeDepth(item: MenuItem): number {
  return item.children.length === 0
    ? 1
    : 1 + Math.max(...item.children.map(subtreeDepth));
}

function updateTreeItem(
  items: MenuItem[],
  id: string,
  update: (item: MenuItem) => MenuItem,
): MenuItem[] {
  return items.map((item) => item.id === id
    ? update(item)
    : { ...item, children: updateTreeItem(item.children, id, update) });
}

function metaTextForItems(items: MenuItem[]): Record<string, string> {
  const result: Record<string, string> = {};
  const pending = [...items];
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) continue;
    result[item.id] = item.meta
      ? JSON.stringify(item.meta, null, 2)
      : '';
    pending.push(...item.children);
  }
  return result;
}

function metaStateKey(
  items: MenuItem[],
  values: Record<string, string>,
): string {
  const ordered: Array<[string, string]> = [];
  const visit = (entries: MenuItem[]) => {
    for (const item of entries) {
      ordered.push([item.id, values[item.id] ?? '']);
      visit(item.children);
    }
  };
  visit(items);
  return JSON.stringify(ordered);
}

function applyMetaText(
  items: MenuItem[],
  values: Record<string, string>,
): MenuItem[] | null {
  const result: MenuItem[] = [];
  for (const item of items) {
    const text = (values[item.id] ?? '').trim();
    let meta: Record<string, MenuMetaValue> | undefined;
    if (text) {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return null;
      }
      const parsed = menuMetaSchema.safeParse(value);
      if (!parsed.success) return null;
      if (Object.keys(parsed.data).length > 0) meta = parsed.data;
    }
    const children = applyMetaText(item.children, values);
    if (!children) return null;
    result.push({
      id: item.id,
      title: item.title,
      link: item.link,
      target: item.target,
      ...(meta ? { meta } : {}),
      children,
    });
  }
  return result;
}

export function MenusPage(input: {
  data: AccountSession;
  onSessionEnded: () => void;
}) {
  const { t } = useTranslation('menus');
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<MenuDraft | null>(null);
  const [originalKey, setOriginalKey] = useState('');
  const [metaText, setMetaText] = useState<Record<string, string>>({});
  const [originalMetaKey, setOriginalMetaKey] = useState('');
  const [customMenuId, setCustomMenuId] = useState('');
  const [customMenuName, setCustomMenuName] = useState('');
  const [menuDialog, setMenuDialog] = useState<'create' | 'settings' | null>(null);
  const [menuEnabled, setMenuEnabled] = useState(true);
  const [itemDialog, setItemDialog] = useState<{ item: MenuItem; creating: boolean } | null>(null);
  const [itemDialogDirty, setItemDialogDirty] = useState(false);
  const [removeCandidate, setRemoveCandidate] = useState<MenuItem | null>(null);
  const [movedItemId, setMovedItemId] = useState<string | null>(null);
  const addItemRef = useRef<HTMLButtonElement>(null);
  const itemReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const removeReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const itemEditRefs = useRef(new Map<string, HTMLButtonElement>());
  const removeCancelRef = useRef<HTMLButtonElement>(null);
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [completion, setCompletion] = useState<'created' | 'saved' | 'deleted' | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const selectedMenu = menus.find((menu) => menu.menu_id === selectedId) ?? null;
  const referenceLookup = useMenuReferences({
    menuId: selectedId,
    revision: selectedMenu?.revision ?? null,
    items: draft?.items ?? [],
    enabled: loadState.kind === 'ready',
    csrfToken: input.data.csrf_token,
    onSessionEnded: input.onSessionEnded,
  });
  const hasChanges = Boolean(
    draft
    && (
      JSON.stringify(draft) !== originalKey
      || metaStateKey(draft.items, metaText) !== originalMetaKey
    ),
  );
  const targets = useMemo(() => menuTargets(menus), [menus]);
  const hasUnstoredDefaults = DEFAULT_MENU_IDS.some(
    (id) => !menus.some((menu) => menu.menu_id === id),
  );
  const menuDialogDirty = menuDialog === 'create'
    ? Boolean(customMenuId || customMenuName)
    : menuDialog === 'settings' && Boolean(draft
      && (customMenuName !== draft.name || menuEnabled !== draft.enabled));
  const anyDialogOpen = Boolean(menuDialog || itemDialog || deleteOpen || removeCandidate);
  const menuItemCount = useMemo(
    () => draft ? countItems(draft.items) : 0,
    [draft],
  );

  useStudioDocumentTitle(t('documentTitle'));
  useStudioToast({
    id: 'menus-completion',
    tone: 'success',
    message: completion ? t(`completion.${completion}`) : null,
  });

  useEffect(() => {
    if (!movedItemId) return;
    // Indent/outdent reparent the row. Keep keyboard focus on that item instead
    // of leaving it on the document body after its old row is unmounted.
    itemEditRefs.current.get(movedItemId)?.focus();
    setMovedItemId(null);
  }, [movedItemId]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    void requestMenus(controller.signal).then((menuResponse) => {
      if (!active) return;
      if (!menuResponse.success) {
        if (menuResponse.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setLoadState({ kind: 'error' });
        return;
      }
      const loadedMenus = menuResponse.data.items;
      setMenus(loadedMenus);
      const nextSelected = menuTargets(loadedMenus).some((menu) => menu.menu_id === selectedId)
        ? selectedId
        : DEFAULT_MENU_IDS[0];
      selectLoadedMenu(loadedMenus, nextSelected);
      setLoadState({ kind: 'ready' });
    }).catch(() => {
      if (active && !controller.signal.aborted) setLoadState({ kind: 'error' });
    });
    return () => {
      active = false;
      controller.abort();
    };
    // A manual retry intentionally resets the selected draft from the server.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.onSessionEnded, loadAttempt]);

  function selectLoadedMenu(source: Menu[], menuId: string | null) {
    const menu = menuTargets(source).find((candidate) => candidate.menu_id === menuId) ?? null;
    setSelectedId(menu?.menu_id ?? null);
    if (!menu) {
      setDraft(null);
      setOriginalKey('');
      setMetaText({});
      setOriginalMetaKey('');
      return;
    }
    const nextDraft: MenuDraft = {
      menu_id: menu.menu_id,
      name: menu.name,
      enabled: menu.enabled,
      items: cloneItems(menu.items),
    };
    const nextMetaText = metaTextForItems(nextDraft.items);
    setDraft(nextDraft);
    setOriginalKey(JSON.stringify(nextDraft));
    setMetaText(nextMetaText);
    setOriginalMetaKey(metaStateKey(nextDraft.items, nextMetaText));
  }

  function selectMenu(menuId: string) {
    if (running || menuId === selectedId) return;
    if (hasChanges) {
      setFailure({ kind: 'validation', code: 'dirtySelection' });
      return;
    }
    setFailure(null);
    setCompletion(null);
    selectLoadedMenu(menus, menuId);
  }

  function handleApiFailure(code: ApiErrorCode) {
    if (code === 'AUTHENTICATION_REQUIRED') {
      input.onSessionEnded();
      return;
    }
    setFailure({ kind: 'api', code });
  }

  function handleClientFailure(error: unknown) {
    setFailure({
      kind: 'client',
      code: error instanceof MenusClientError
        ? error.code
        : 'NETWORK_ERROR',
    });
  }

  function failureMessage(value: Failure): string {
    if (value.kind === 'validation') return t(`validation.${value.code}`);
    if (value.kind === 'client') {
      if (value.code === 'TIMEOUT') return t('errors.timeout');
      if (value.code === 'INVALID_RESPONSE') return t('errors.invalidResponse');
      return t('errors.network');
    }
    if (value.code === 'MENU_ID_CONFLICT') return t('errors.idConflict');
    if (value.code === 'MENU_NOT_FOUND') return t('errors.notFound');
    if (value.code === 'MENU_REVISION_CONFLICT') return t('errors.revisionConflict');
    if (value.code === 'MENU_PROTECTED') return t('errors.protected');
    if (value.code === 'MENU_REFERENCE_NOT_FOUND') return t('errors.referenceNotFound');
    if (value.code === 'MENU_LIMIT_REACHED') return t('errors.limitReached');
    if (value.code === 'FORBIDDEN') return t('errors.forbidden');
    return t('errors.api');
  }

  async function createAuthoredMenu(request: unknown) {
    if (running || hasChanges) return;
    const parsed = createMenuRequestSchema.safeParse(request);
    if (!parsed.success) {
      setFailure({ kind: 'validation', code: 'menu' });
      return;
    }
    setRunning(true);
    setFailure(null);
    setCompletion(null);
    try {
      const response = await requestCreateMenu(
        input.data.csrf_token,
        parsed.data,
      );
      if (!response.success) {
        handleApiFailure(response.error.code);
        return;
      }
      const nextMenus = [...menus, response.data].sort((left, right) => (
        left.menu_id.localeCompare(right.menu_id)
      ));
      setMenus(nextMenus);
      selectLoadedMenu(nextMenus, response.data.menu_id);
      setCustomMenuId('');
      setCustomMenuName('');
      setMenuDialog(null);
      setCompletion('created');
    } catch (error) {
      handleClientFailure(error);
    } finally {
      setRunning(false);
    }
  }

  function submitCustomMenu(event: FormEvent) {
    event.preventDefault();
    void createAuthoredMenu({
      menu_id: customMenuId,
      name: customMenuName,
      enabled: true,
      items: [],
    });
  }

  function mutateItems(mutator: (items: MenuItem[]) => boolean | void) {
    setDraft((current) => {
      if (!current) return current;
      const items = cloneItems(current.items);
      const changed = mutator(items);
      return changed === false ? current : { ...current, items };
    });
    setFailure(null);
    setCompletion(null);
  }

  function updateItem(id: string, update: (item: MenuItem) => MenuItem) {
    setDraft((current) => current
      ? { ...current, items: updateTreeItem(current.items, id, update) }
      : current);
    setFailure(null);
    setCompletion(null);
  }

  function moveItem(id: string, direction: 'up' | 'down' | 'indent' | 'outdent') {
    setMovedItemId(id);
    mutateItems((items) => {
      const path = findItemPath(items, id);
      if (!path) return false;
      const index = path.at(-1) ?? 0;
      const parentPath = path.slice(0, -1);
      const siblings = listAtParentPath(items, parentPath);
      if (direction === 'up' || direction === 'down') {
        const nextIndex = direction === 'up' ? index - 1 : index + 1;
        if (nextIndex < 0 || nextIndex >= siblings.length) return false;
        [siblings[index], siblings[nextIndex]] = [siblings[nextIndex], siblings[index]];
        return true;
      }
      if (direction === 'indent') {
        if (index === 0) return false;
        const item = siblings[index];
        const nextRootDepth = path.length + 1;
        if (nextRootDepth + subtreeDepth(item) - 1 > MENU_MAX_DEPTH) {
          setFailure({ kind: 'validation', code: 'maxDepth' });
          return false;
        }
        siblings.splice(index, 1);
        siblings[index - 1].children.push(item);
        return true;
      }
      if (parentPath.length === 0) return false;
      const parentIndex = parentPath.at(-1) ?? 0;
      const grandParentPath = parentPath.slice(0, -1);
      const grandSiblings = listAtParentPath(items, grandParentPath);
      const [item] = siblings.splice(index, 1);
      grandSiblings.splice(parentIndex + 1, 0, item);
      return true;
    });
  }

  function removeItem(id: string) {
    mutateItems((items) => {
      const path = findItemPath(items, id);
      if (!path) return false;
      const siblings = listAtParentPath(items, path.slice(0, -1));
      siblings.splice(path.at(-1) ?? 0, 1);
      setMetaText((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      return true;
    });
  }

  async function saveMenu() {
    if (!draft || running) return;
    const items = applyMetaText(draft.items, metaText);
    if (!items) {
      setFailure({ kind: 'validation', code: 'meta' });
      return;
    }
    const parsed = saveMenuRequestSchema.safeParse({
      name: draft.name,
      enabled: draft.enabled,
      items,
      expected_revision: selectedMenu?.revision ?? null,
    });
    if (!parsed.success) {
      setFailure({ kind: 'validation', code: 'menu' });
      return;
    }
    setRunning(true);
    setFailure(null);
    setCompletion(null);
    try {
      const response = await requestSaveMenu(
        input.data.csrf_token,
        draft.menu_id,
        parsed.data,
      );
      if (!response.success) {
        handleApiFailure(response.error.code);
        return;
      }
      const nextById = new Map(menus.map((menu) => [menu.menu_id, menu]));
      for (const menu of response.data.items) nextById.set(menu.menu_id, menu);
      const nextMenus = [...nextById.values()].sort((left, right) => (
        left.menu_id.localeCompare(right.menu_id)
      ));
      setMenus(nextMenus);
      selectLoadedMenu(nextMenus, draft.menu_id);
      setCompletion('saved');
    } catch (error) {
      handleClientFailure(error);
    } finally {
      setRunning(false);
    }
  }

  async function confirmDelete() {
    if (running || !selectedMenu || isDefaultMenuId(selectedMenu.menu_id)) return;
    setRunning(true);
    setFailure(null);
    try {
      const response = await requestDeleteMenu(
        input.data.csrf_token,
        selectedMenu.menu_id,
        { expected_revision: selectedMenu.revision },
      );
      if (!response.success) {
        handleApiFailure(response.error.code);
        return;
      }
      const nextMenus = menus.filter(
        (menu) => menu.menu_id !== selectedMenu.menu_id,
      );
      setMenus(nextMenus);
      selectLoadedMenu(nextMenus, DEFAULT_MENU_IDS[0]);
      setDeleteOpen(false);
      setCompletion('deleted');
    } catch (error) {
      handleClientFailure(error);
    } finally {
      setRunning(false);
    }
  }


  function openMenuDialog(mode: 'create' | 'settings') {
    if (running) return;
    setFailure(null);
    setCustomMenuId(mode === 'settings' ? draft?.menu_id ?? '' : '');
    setCustomMenuName(mode === 'settings' ? draft?.name ?? '' : '');
    setMenuEnabled(mode === 'settings' ? draft?.enabled ?? true : true);
    setMenuDialog(mode);
  }

  function closeMenuDialog() {
    setMenuDialog(null);
    setFailure(null);
  }

  function applyMenuSettings(event: FormEvent) {
    event.preventDefault();
    if (!draft || running) return;
    const name = menuNameInputSchema.safeParse(customMenuName);
    if (!name.success) {
      setFailure({ kind: 'validation', code: 'menu' });
      return;
    }
    setDraft({ ...draft, name: name.data, enabled: menuEnabled });
    setCompletion(null);
    closeMenuDialog();
  }

  function openItemDialog(item?: MenuItem) {
    if (running || (!item && menuItemCount >= MENU_MAX_ITEMS)) return;
    itemReturnFocusRef.current = item ? itemEditRefs.current.get(item.id) ?? addItemRef.current : addItemRef.current;
    setItemDialogDirty(false);
    setItemDialog({
      creating: !item,
      item: item ?? {
        id: createItemId(), title: '', link: { kind: 'custom', url: '/' },
        target: '_self', children: [],
      },
    });
  }

  function closeItemDialog() {
    setItemDialog(null);
    setItemDialogDirty(false);
  }

  function applyItem(item: MenuItem) {
    if (itemDialog?.creating) {
      setDraft((current) => current ? { ...current, items: [...current.items, item] } : current);
    } else {
      updateItem(item.id, () => item);
    }
    setMetaText((current) => ({
      ...current, [item.id]: item.meta ? JSON.stringify(item.meta, null, 2) : '',
    }));
    setFailure(null);
    setCompletion(null);
    closeItemDialog();
  }

  function renderReference(item: MenuItem) {
    if (item.link.kind === 'custom') return item.link.url;
    const resolution = referenceLookup.resolutions.get(menuReferenceKey(item.link));
    if (resolution?.status === 'available') return `${resolution.title} — ${resolution.detail}`;
    if (resolution?.status === 'missing') return t('item.missingReference');
    if (resolution?.status === 'trash') return t('item.trashedReference');
    return referenceLookup.failed ? t('item.uncheckedReference') : t('item.checkingReference');
  }

  function renderItems(items: MenuItem[], depth = 1, parent?: MenuItem): React.ReactNode {
    return (
      <ol className="navigation-tree" data-depth={depth}>
        {items.map((item, index) => {
          const resolution = item.link.kind === 'custom' ? undefined
            : referenceLookup.resolutions.get(menuReferenceKey(item.link));
          return (
            <li key={item.id} className="navigation-tree-node">
              <Panel flush>
                <article className="navigation-item" aria-label={item.title}>
                  <span className="navigation-item-symbol">
                    <StudioIcon icon={MENU_LINK_ICONS[item.link.kind]} className="navigation-icon" />
                  </span>
                  <div className="navigation-item-copy">
                    <div className="navigation-item-title">
                      <Button type="button" variant="text" disabled={running}
                        aria-label={t('item.editNamed', { name: item.title })}
                        aria-describedby={parent ? `navigation-parent-${item.id}` : undefined}
                        ref={(element) => {
                          if (element) itemEditRefs.current.set(item.id, element);
                          else itemEditRefs.current.delete(item.id);
                        }}
                        onClick={() => openItemDialog(item)}>
                        {item.title}
                      </Button>
                      {item.target === '_blank' && (
                        <span className="navigation-new-tab" title={t('add.newTab')}>
                          <StudioIcon icon={ExternalLink} className="navigation-icon" />
                          <span className="visually-hidden">{t('add.newTab')}</span>
                        </span>
                      )}
                    </div>
                    <span className="navigation-item-reference" data-state={resolution?.status}>
                      {renderReference(item)}
                    </span>
                    {parent && (
                      <span className="navigation-item-parent" id={`navigation-parent-${item.id}`}>
                        {t('item.nestedUnder', { name: parent.title, depth })}
                      </span>
                    )}
                  </div>
                  <div className="navigation-item-kind">
                    <StatusPill tone="neutral">{t(`add.types.${item.link.kind}`)}</StatusPill>
                  </div>
                  <div className="navigation-item-actions">
                    <Button type="button" size="sm" variant="ghost" title={t('item.moveUp')}
                      aria-label={t('item.moveUp')} disabled={index === 0 || running}
                      onClick={() => moveItem(item.id, 'up')}>
                      <StudioIcon icon={ArrowUp} className="navigation-icon" />
                    </Button>
                    <Button type="button" size="sm" variant="ghost" title={t('item.moveDown')}
                      aria-label={t('item.moveDown')} disabled={index === items.length - 1 || running}
                      onClick={() => moveItem(item.id, 'down')}>
                      <StudioIcon icon={ArrowDown} className="navigation-icon" />
                    </Button>
                    <Button type="button" size="sm" variant="ghost" title={t('item.indent')}
                      aria-label={t('item.indent')}
                      disabled={index === 0 || running || depth + subtreeDepth(item) > MENU_MAX_DEPTH}
                      onClick={() => moveItem(item.id, 'indent')}>
                      <StudioIcon icon={ChevronRight} className="navigation-icon" />
                    </Button>
                    <Button type="button" size="sm" variant="ghost" title={t('item.outdent')}
                      aria-label={t('item.outdent')} disabled={depth === 1 || running}
                      onClick={() => moveItem(item.id, 'outdent')}>
                      <StudioIcon icon={ChevronLeft} className="navigation-icon" />
                    </Button>
                    <ActionMenu label={t('item.actions', { name: item.title })} disabled={running}
                      items={[
                        { id: 'edit', kind: 'button', label: t('item.edit'), icon: Pencil,
                          onSelect: () => openItemDialog(item) },
                        { id: 'remove', kind: 'button', label: t('item.remove'), icon: Trash2,
                          tone: 'critical', onSelect: () => {
                            removeReturnFocusRef.current = itemEditRefs.current.get(item.id) ?? addItemRef.current;
                            setRemoveCandidate(item);
                          } },
                      ]} />
                  </div>
                </article>
              </Panel>
              {item.children.length > 0 && renderItems(item.children, depth + 1, item)}
            </li>
          );
        })}
      </ol>
    );
  }
  if (loadState.kind === 'loading') {
    return (
      <RouteLoading>{t('loading')}</RouteLoading>
    );
  }

  if (loadState.kind === 'error') {
    return (
      <main id="studio-main-content">
        <PageHeader titleId="menus-title" title={t('title')} />
        <Notice
          tone="error"
          title={t('loadError.title')}
          actions={(
            <Button
              type="button"
              onClick={() => setLoadAttempt((value) => value + 1)}
            >
              {t('loadError.retry')}
            </Button>
          )}
        >
          {t('loadError.description')}
        </Notice>
      </main>
    );
  }

  return (
    <main id="studio-main-content" aria-labelledby="menus-title">
      <UnsavedChangesGuard
        active={(hasChanges || itemDialogDirty || menuDialogDirty) && !running}
        copy={{
          kicker: t('unsaved.kicker'), title: t('unsaved.title'), description: t('unsaved.description'),
          stay: t('unsaved.stay'), leave: t('unsaved.leave'),
        }}
      />
      <PageHeader titleId="menus-title" kicker={t('kicker')} title={t('title')} description={t('description')} />
      {failure && !anyDialogOpen && (
        <div className="structure-message"><Notice tone="error">{failureMessage(failure)}</Notice></div>
      )}
      <div className="structure-layout">
        <aside className="structure-sidebar" aria-label={t('menuList')}>
          <header className="structure-sidebar-header">
            <h2 className="structure-section-title">{t('menuList')}</h2>
            <Button type="button" size="sm" disabled={running || hasChanges} onClick={() => openMenuDialog('create')}>
              <StudioIcon icon={Plus} className="structure-icon" />{t('create.open')}
            </Button>
          </header>
          <div className="structure-selector">
            <Field label={t('selectMenu')} labelHidden leading={<StudioIcon icon={ListTree} />}>
              {(control) => (
                <select {...control} value={selectedId ?? ''} disabled={running}
                  onChange={(event) => selectMenu(event.target.value)}>
                  {targets.map((menu) => (
                    <option key={menu.menu_id} value={menu.menu_id}>
                      {menu.menu_id === selectedId && draft ? draft.name : menu.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <ul className="structure-target-list">
            {targets.map((menu) => {
              const value = menu.menu_id === selectedId && draft ? draft : menu;
              return (
                <li key={menu.menu_id}>
                  <button type="button" className="structure-target" disabled={running}
                    aria-current={menu.menu_id === selectedId ? 'true' : undefined}
                    onClick={() => selectMenu(menu.menu_id)}>
                    <span className="structure-target-top">
                      <strong className="structure-target-name">{value.name}</strong>
                      <span className="structure-count">{t('itemCount', { count: countItems(value.items) })}</span>
                    </span>
                    <span className="structure-target-bottom">
                      <span className="structure-target-key">
                        <StudioIcon icon={ListTree} className="structure-icon" />
                        <code>{menu.menu_id}</code>
                      </span>
                      <span className="structure-target-badges">
                        {!menus.some((saved) => saved.menu_id === menu.menu_id) && (
                          <StatusPill tone="neutral">{t('notSaved')}</StatusPill>
                        )}
                        {!value.enabled && <StatusPill tone="neutral">{t('disabled')}</StatusPill>}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <div className="structure-editor">
          {!draft ? <EmptyState title={t('selectMenu')} headingLevel={2} /> : (
            <>
              <Panel
                title={draft.name}
                description={draft.menu_id}
                leading={<StudioIcon icon={ListTree} />}
                actions={(
                  <>
                    <Button type="button" disabled={running} onClick={() => openMenuDialog('settings')}>
                      <StudioIcon icon={Pencil} className="navigation-icon" />{t('editor.identity')}
                    </Button>
                    <Button type="button" ref={addItemRef} disabled={running || menuItemCount >= MENU_MAX_ITEMS}
                      onClick={() => openItemDialog()}>
                      <StudioIcon icon={Plus} className="navigation-icon" />{t('add.title')}
                    </Button>
                  </>
                )}
                footer={(
                  <div className="structure-savebar">
                    <div className="structure-save-state">
                      <span>{hasChanges ? t('editor.unsaved') : hasUnstoredDefaults ? t('editor.defaultsPending') : t('editor.saved')}</span>
                      {!draft.enabled && <StatusPill tone="neutral">{t('disabled')}</StatusPill>}
                    </div>
                    <div className="structure-save-actions">
                      <Button type="button" disabled={!hasChanges || running}
                        onClick={() => {
                          selectLoadedMenu(menus, selectedId);
                          setFailure(null);
                          setCompletion(null);
                        }}>
                        <StudioIcon icon={Undo2} className="navigation-icon" />{t('editor.discard')}
                      </Button>
                      <Button type="button" variant="primary"
                        disabled={(!hasChanges && !hasUnstoredDefaults) || running} onClick={() => void saveMenu()}>
                        <StudioIcon icon={Save} className="navigation-icon" />
                        {running ? t('editor.saving') : t('editor.save')}
                      </Button>
                    </div>
                  </div>
                )}
              />
              {referenceLookup.failed && (
                <Notice tone="error" actions={(
                  <Button type="button" disabled={running} onClick={referenceLookup.retry}>
                    <StudioIcon icon={RefreshCw} className="navigation-icon" />{t('references.retry')}
                  </Button>
                )}>{t('references.loadError')}</Notice>
              )}
              <section aria-labelledby="navigation-items-title" className="navigation-items">
                <header className="navigation-items-header">
                  <h3 id="navigation-items-title" className="structure-section-title">{t('editor.items')}</h3>
                  <span className="structure-count">{t('itemCount', { count: menuItemCount })}</span>
                </header>
                {draft.items.length === 0 ? (
                  <Panel><EmptyState title={t('editor.noItems')} description={t('editor.noItemsHelp')} /></Panel>
                ) : renderItems(draft.items)}
                {menuItemCount >= MENU_MAX_ITEMS && <p className="navigation-help">{t('editor.itemLimit')}</p>}
              </section>
            </>
          )}
        </div>
      </div>

      <Dialog open={menuDialog !== null} busy={running} onClose={closeMenuDialog}
        title={menuDialog === 'create' ? t('create.title') : t('editor.identity')}
        description={menuDialog === 'create' ? undefined : t('editor.draftHelp')}>
        <form className="navigation-dialog-form" onSubmit={menuDialog === 'create' ? submitCustomMenu : applyMenuSettings}>
          <div className="navigation-form-fields">
            <Field label={t('create.name')} leading={<StudioIcon icon={Type} />}>
              {(control) => <input {...control} value={customMenuName} maxLength={120} disabled={running}
                onChange={(event) => setCustomMenuName(event.target.value)} />}
            </Field>
            <Field label={t('create.menuId')}
              hint={menuDialog === 'create' ? t('create.menuIdHelp') : t('editor.menuIdHelp')}
              leading={<StudioIcon icon={Hash} />}>
              {(control) => <input {...control} value={customMenuId} maxLength={64}
                disabled={running || menuDialog === 'settings'} readOnly={menuDialog === 'settings'}
                onChange={(event) => setCustomMenuId(event.target.value)} />}
            </Field>
            {menuDialog === 'settings' && (
              <>
                <label className="navigation-checkbox">
                  <input type="checkbox" checked={menuEnabled} disabled={running}
                    aria-describedby="navigation-enabled-help"
                    onChange={(event) => setMenuEnabled(event.target.checked)} />
                  {t('editor.enabled')}
                </label>
                <p id="navigation-enabled-help" className="navigation-help">{t('editor.enabledHelp')}</p>
                {draft && isDefaultMenuId(draft.menu_id) ? (
                  <p className="navigation-help">{t('errors.protected')}</p>
                ) : (
                  <div className="navigation-delete-action">
                    <Button type="button" variant="ghost" disabled={running}
                      onClick={() => { closeMenuDialog(); setDeleteOpen(true); }}>
                      <StudioIcon icon={Trash2} className="navigation-icon" />{t('editor.delete')}
                    </Button>
                  </div>
                )}
              </>
            )}
            {failure && <Notice tone="error">{failureMessage(failure)}</Notice>}
          </div>
          <DialogActions>
            <Button type="button" disabled={running} onClick={closeMenuDialog}>{t('cancel')}</Button>
            <Button type="submit" variant="primary" disabled={running}>
              {menuDialog === 'create' ? running ? t('create.running') : t('create.submit') : t('item.apply')}
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      {itemDialog && (
        <MenuItemEditorDialog key={itemDialog.item.id} item={itemDialog.item} creating={itemDialog.creating}
          resolutions={referenceLookup.resolutions} referencesFailed={referenceLookup.failed}
          onRetryReferences={referenceLookup.retry}
          onClose={closeItemDialog} onApply={applyItem} onSessionEnded={input.onSessionEnded}
          onDirtyChange={setItemDialogDirty} returnFocusRef={itemReturnFocusRef} />
      )}

      <Dialog open={removeCandidate !== null} onClose={() => setRemoveCandidate(null)}
        title={t('removeDialog.title', { name: removeCandidate?.title ?? '' })}
        description={t('removeDialog.description')}
        initialFocusRef={removeCancelRef} returnFocusRef={removeReturnFocusRef}
        actions={(
          <>
            <Button type="button" ref={removeCancelRef} onClick={() => setRemoveCandidate(null)}>{t('cancel')}</Button>
            <Button type="button" variant="danger" onClick={() => {
              if (removeCandidate) removeItem(removeCandidate.id);
              removeReturnFocusRef.current = addItemRef.current;
              setRemoveCandidate(null);
            }}>
              <StudioIcon icon={Trash2} className="navigation-icon" />{t('item.remove')}
            </Button>
          </>
        )} />

      <Dialog open={deleteOpen && selectedMenu !== null} onClose={() => { setDeleteOpen(false); setFailure(null); }}
        busy={running} kicker={t('deleteDialog.kicker')}
        title={t('deleteDialog.title', { name: selectedMenu?.name ?? '' })}
        description={t('deleteDialog.description')} initialFocusRef={deleteCancelRef} returnFocusRef={addItemRef}
        actions={(
          <>
            <Button type="button" ref={deleteCancelRef} disabled={running}
              onClick={() => { setDeleteOpen(false); setFailure(null); }}>{t('deleteDialog.cancel')}</Button>
            <Button type="button" variant="danger" disabled={running} onClick={() => void confirmDelete()}>
              <StudioIcon icon={Trash2} className="navigation-icon" />
              {running ? t('deleteDialog.running') : t('deleteDialog.confirm')}
            </Button>
          </>
        )}>
        {failure && <Notice tone="error">{failureMessage(failure)}</Notice>}
      </Dialog>
    </main>
  );
}
