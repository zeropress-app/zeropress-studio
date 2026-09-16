import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Blocks,
  FileText,
  FolderTree,
  Hash,
  List,
  PanelRight,
  Pencil,
  Plus,
  Save,
  Search,
  Tags,
  Trash2,
  Type,
  Undo2,
  UserRound,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useStudioDocumentTitle } from './StudioSiteIdentityContext';
import type { ApiErrorCode } from '../../contracts/api';
import {
  SIDEBAR_WIDGET_AREA_ID,
  WIDGET_TYPES,
  WIDGET_MAX_ITEMS,
  canonicalizeWidgetItems,
  createDefaultWidgetAreaDraft,
  createWidgetAreaRequestSchema,
  isProtectedWidgetAreaId,
  saveWidgetAreaRequestSchema,
  widgetAreaNameInputSchema,
  widgetItemInputSchema,
  type WidgetArea,
  type WidgetAreaDraft,
  type WidgetAuthorOption,
  type WidgetItem,
  type WidgetType,
} from '../../contracts/widgets';
import {
  ActionMenu,
  Button,
  Dialog,
  DialogActions,
  EmptyState,
  Field,
  Notice,
  PageHeader,
  Panel,
  RouteLoading,
  StatusPill,
  StudioIcon,
  Switch,
  useStudioToast,
} from './components/primitives';
import { UnsavedChangesGuard } from './components/UnsavedChangesGuard';
import {
  requestCreateWidgetArea,
  requestDeleteWidgetArea,
  requestSaveWidgetArea,
  requestWidgetAreas,
  requestWidgetAuthorOptions,
  WidgetsClientError,
} from './lib/widgets-client';

type AccountSession = { csrf_token: string };
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error' };
type Failure =
  | { kind: 'validation'; code: 'area' | 'item' | 'dirtySelection' }
  | { kind: 'api'; code: ApiErrorCode }
  | { kind: 'client'; code: 'TIMEOUT' | 'NETWORK_ERROR' | 'INVALID_RESPONSE' };

function createItemId(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function cloneItems(items: WidgetItem[]): WidgetItem[] {
  return structuredClone(items);
}

function widgetAreaTargets(areas: WidgetArea[]): WidgetAreaDraft[] {
  return [
    areas.find((area) => area.widget_area_id === SIDEBAR_WIDGET_AREA_ID)
      ?? createDefaultWidgetAreaDraft(),
    ...areas.filter((area) => area.widget_area_id !== SIDEBAR_WIDGET_AREA_ID),
  ];
}

function createLocalWidget(
  type: WidgetType,
  profileAuthorId: string,
  id = createItemId(),
): WidgetItem {
  const common = { id, title: '', enabled: true };
  switch (type) {
    case 'search':
      return {
        ...common,
        type,
        settings: { placeholder: 'Search...', button_label: 'Search' },
      };
    case 'recent-posts':
      return { ...common, type, settings: { limit: 5, show_date: true } };
    case 'categories':
      return {
        ...common,
        type,
        settings: { show_count: false, hierarchical: false },
      };
    case 'tags':
      return { ...common, type, settings: { limit: 20, show_count: false } };
    case 'archives':
      return { ...common, type, settings: { limit: 12 } };
    case 'text':
      return {
        ...common,
        type,
        settings: { document_type: 'markdown', content: '' },
      };
    case 'link-list':
      return { ...common, type, settings: { links: [] } };
    case 'profile':
      return { ...common, type, settings: { author_id: profileAuthorId } };
  }
}

const DOCUMENT_TYPES = ['plaintext', 'markdown', 'html'] as const;
const WIDGET_TYPE_ICONS = {
  search: Search,
  'recent-posts': FileText,
  categories: FolderTree,
  tags: Tags,
  archives: Archive,
  text: FileText,
  'link-list': List,
  profile: UserRound,
} as const;

function mergeAuthorOptions(
  retained: WidgetAuthorOption[],
  loaded: WidgetAuthorOption[],
): WidgetAuthorOption[] {
  const merged = new Map<string, WidgetAuthorOption>();
  for (const option of retained) merged.set(option.id, option);
  for (const option of loaded) merged.set(option.id, option);
  return [...merged.values()];
}

export function WidgetsPage(input: {
  data: AccountSession;
  onSessionEnded: () => void;
}) {
  const { t } = useTranslation('widgets');
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [areas, setAreas] = useState<WidgetArea[]>([]);
  const [authors, setAuthors] = useState<WidgetAuthorOption[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<WidgetAreaDraft | null>(null);
  const [originalKey, setOriginalKey] = useState('');
  const [customAreaId, setCustomAreaId] = useState('');
  const [customAreaName, setCustomAreaName] = useState('');
  const [areaDialog, setAreaDialog] = useState<
    'create' | 'settings' | null
  >(null);
  const [areaEnabled, setAreaEnabled] = useState(true);
  const [itemDialog, setItemDialog] = useState<{
    item: WidgetItem;
    creating: boolean;
    originalKey: string;
  } | null>(null);
  const [authorSearch, setAuthorSearch] = useState('');
  const [authorSearching, setAuthorSearching] = useState(false);
  const [itemInvalid, setItemInvalid] = useState(false);
  const [removeCandidate, setRemoveCandidate] = useState<WidgetItem | null>(
    null,
  );
  const [running, setRunning] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [completion, setCompletion] = useState<
    'created' | 'saved' | 'deleted' | null
  >(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const addItemRef = useRef<HTMLButtonElement>(null);
  const itemReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const itemEditRefs = useRef(new Map<string, HTMLButtonElement>());
  const removeReturnFocusRef = useRef<HTMLButtonElement | null>(null);
  const removeCancelRef = useRef<HTMLButtonElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const selectedArea = areas.find(
    (area) => area.widget_area_id === selectedId,
  ) ?? null;
  const targets = useMemo(() => widgetAreaTargets(areas), [areas]);
  const hasChanges = Boolean(
    draft && JSON.stringify(draft) !== originalKey,
  );
  const hasUnstoredSelectedArea = Boolean(
    draft
    && draft.widget_area_id === SIDEBAR_WIDGET_AREA_ID
    && selectedArea === null,
  );
  const itemDialogDirty = Boolean(
    itemDialog
    && JSON.stringify(itemDialog.item) !== itemDialog.originalKey,
  );
  const areaDialogDirty = areaDialog === 'create'
    ? Boolean(customAreaId || customAreaName)
    : areaDialog === 'settings' && Boolean(
      draft
      && (customAreaName !== draft.name || areaEnabled !== draft.enabled),
    );
  const anyDialogOpen = Boolean(
    areaDialog || itemDialog || deleteOpen || removeCandidate,
  );

  useStudioDocumentTitle(t('documentTitle'));
  useStudioToast({
    id: 'widgets-completion',
    tone: 'success',
    message: completion ? t(`completion.${completion}`) : null,
  });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    void Promise.all([
      requestWidgetAreas(controller.signal),
      requestWidgetAuthorOptions('', controller.signal),
    ]).then(([areaResponse, authorResponse]) => {
      if (!active) return;
      const rejected = [areaResponse, authorResponse].find(
        (response) => !response.success,
      );
      if (rejected && !rejected.success) {
        if (rejected.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setLoadState({ kind: 'error' });
        return;
      }
      if (!areaResponse.success || !authorResponse.success) return;
      setAreas(areaResponse.data.items);
      setAuthors(authorResponse.data.items);
      const nextSelected = widgetAreaTargets(areaResponse.data.items).some(
        (area) => area.widget_area_id === selectedId,
      )
        ? selectedId
        : SIDEBAR_WIDGET_AREA_ID;
      selectLoadedArea(areaResponse.data.items, nextSelected);
      setLoadState({ kind: 'ready' });
    }).catch(() => {
      if (active && !controller.signal.aborted) {
        setLoadState({ kind: 'error' });
      }
    });
    return () => {
      active = false;
      controller.abort();
    };
    // A manual retry intentionally replaces the current local draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.onSessionEnded, loadAttempt]);

  function selectLoadedArea(
    source: WidgetArea[],
    widgetAreaId: string | null,
  ) {
    const area = widgetAreaTargets(source).find(
      (candidate) => candidate.widget_area_id === widgetAreaId,
    ) ?? null;
    setSelectedId(area?.widget_area_id ?? null);
    if (!area) {
      setDraft(null);
      setOriginalKey('');
      return;
    }
    const nextDraft: WidgetAreaDraft = {
      widget_area_id: area.widget_area_id,
      name: area.name,
      enabled: area.enabled,
      items: cloneItems(area.items),
    };
    setDraft(nextDraft);
    setOriginalKey(JSON.stringify(nextDraft));
  }

  function selectArea(widgetAreaId: string) {
    if (widgetAreaId === selectedId) return;
    if (hasChanges) {
      setFailure({ kind: 'validation', code: 'dirtySelection' });
      return;
    }
    setFailure(null);
    setCompletion(null);
    selectLoadedArea(areas, widgetAreaId);
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
      code: error instanceof WidgetsClientError
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
    if (value.code === 'WIDGET_AREA_ID_CONFLICT') return t('errors.idConflict');
    if (value.code === 'WIDGET_AREA_NOT_FOUND') return t('errors.notFound');
    if (value.code === 'WIDGET_AREA_REVISION_CONFLICT') {
      return t('errors.revisionConflict');
    }
    if (value.code === 'WIDGET_AREA_PROTECTED') return t('errors.protected');
    if (value.code === 'WIDGET_AREA_LIMIT_REACHED') {
      return t('errors.limitReached');
    }
    if (value.code === 'WIDGET_AUTHOR_NOT_FOUND') {
      return t('errors.authorNotFound');
    }
    if (value.code === 'FORBIDDEN') return t('errors.forbidden');
    return t('errors.api');
  }

  async function createArea(widgetAreaId: string, name: string) {
    const parsed = createWidgetAreaRequestSchema.safeParse({
      widget_area_id: widgetAreaId,
      name,
    });
    if (!parsed.success) {
      setFailure({ kind: 'validation', code: 'area' });
      return;
    }
    setRunning(true);
    setFailure(null);
    setCompletion(null);
    try {
      const response = await requestCreateWidgetArea(
        input.data.csrf_token,
        parsed.data,
      );
      if (!response.success) {
        handleApiFailure(response.error.code);
        return;
      }
      const nextAreas = [...areas, response.data].sort((left, right) => (
        left.widget_area_id.localeCompare(right.widget_area_id)
      ));
      setAreas(nextAreas);
      selectLoadedArea(nextAreas, response.data.widget_area_id);
      setCustomAreaId('');
      setCustomAreaName('');
      setAreaDialog(null);
      setCompletion('created');
    } catch (error) {
      handleClientFailure(error);
    } finally {
      setRunning(false);
    }
  }

  function submitCustomArea(event: FormEvent) {
    event.preventDefault();
    void createArea(customAreaId, customAreaName);
  }

  function openAreaDialog(mode: 'create' | 'settings') {
    setFailure(null);
    if (mode === 'create') {
      setCustomAreaId('');
      setCustomAreaName('');
      setAreaEnabled(true);
    } else if (draft) {
      setCustomAreaId(draft.widget_area_id);
      setCustomAreaName(draft.name);
      setAreaEnabled(draft.enabled);
    }
    setAreaDialog(mode);
  }

  function closeAreaDialog() {
    setAreaDialog(null);
    setFailure(null);
  }

  function applyAreaSettings(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const parsedName = widgetAreaNameInputSchema.safeParse(customAreaName);
    if (!parsedName.success) {
      setFailure({ kind: 'validation', code: 'area' });
      return;
    }
    setDraft({ ...draft, name: parsedName.data, enabled: areaEnabled });
    setFailure(null);
    setCompletion(null);
    setAreaDialog(null);
  }

  function updateItem(
    id: string,
    update: (item: WidgetItem) => WidgetItem,
  ) {
    setDraft((current) => current
      ? {
          ...current,
          items: current.items.map((item) => item.id === id
            ? update(item)
            : item),
        }
      : current);
    setFailure(null);
    setCompletion(null);
  }

  function moveItem(id: string, direction: 'up' | 'down') {
    setDraft((current) => {
      if (!current) return current;
      const items = cloneItems(current.items);
      const index = items.findIndex((item) => item.id === id);
      if (index === -1) return current;
      const nextIndex = direction === 'up' ? index - 1 : index + 1;
      if (nextIndex < 0 || nextIndex >= items.length) return current;
      [items[index], items[nextIndex]] = [items[nextIndex], items[index]];
      return { ...current, items };
    });
    setFailure(null);
    setCompletion(null);
  }

  function removeItem(id: string) {
    setDraft((current) => current
      ? { ...current, items: current.items.filter((item) => item.id !== id) }
      : current);
    setFailure(null);
    setCompletion(null);
  }

  function openItemDialog(item?: WidgetItem) {
    itemReturnFocusRef.current = item
      ? itemEditRefs.current.get(item.id) ?? addItemRef.current
      : addItemRef.current;
    const nextItem = item
      ? structuredClone(item)
      : createLocalWidget('search', authors[0]?.id ?? '');
    setItemDialog({
      item: nextItem,
      creating: !item,
      originalKey: JSON.stringify(nextItem),
    });
    setAuthorSearch('');
    setItemInvalid(false);
    setFailure(null);
  }

  function closeItemDialog() {
    setItemDialog(null);
    setItemInvalid(false);
    setAuthorSearch('');
  }

  function updateEditingItem(update: (item: WidgetItem) => WidgetItem) {
    setItemDialog((current) => current
      ? { ...current, item: update(current.item) }
      : current);
    setItemInvalid(false);
  }

  function changeEditingType(type: WidgetType) {
    updateEditingItem((current) => {
      const replacement = createLocalWidget(
        type,
        authors[0]?.id ?? '',
        current.id,
      );
      return {
        ...replacement,
        title: current.title,
        enabled: current.enabled,
      } as WidgetItem;
    });
  }

  function updateEditingLink(
    linkIndex: number,
    update: (link: { label: string; url: string; target: '_self' | '_blank' }) => {
      label: string;
      url: string;
      target: '_self' | '_blank';
    },
  ) {
    updateEditingItem((item) => item.type === 'link-list'
      ? {
          ...item,
          settings: {
            links: item.settings.links.map((link, index) => (
              index === linkIndex ? update(link) : link
            )),
          },
        }
      : item);
  }

  function moveEditingLink(linkIndex: number, direction: 'up' | 'down') {
    updateEditingItem((item) => {
      if (item.type !== 'link-list') return item;
      const links = [...item.settings.links];
      const nextIndex = direction === 'up' ? linkIndex - 1 : linkIndex + 1;
      if (nextIndex < 0 || nextIndex >= links.length) return item;
      [links[linkIndex], links[nextIndex]] = [links[nextIndex], links[linkIndex]];
      return { ...item, settings: { links } };
    });
  }

  function applyItem(event: FormEvent) {
    event.preventDefault();
    if (!itemDialog) return;
    const parsed = widgetItemInputSchema.safeParse(itemDialog.item);
    if (!parsed.success) {
      setItemInvalid(true);
      return;
    }
    if (itemDialog.creating) {
      setDraft((current) => current
        ? { ...current, items: [...current.items, parsed.data] }
        : current);
    } else {
      updateItem(parsed.data.id, () => parsed.data);
    }
    setFailure(null);
    setCompletion(null);
    closeItemDialog();
  }

  async function refreshAuthors(search: string, retainedAuthorId = '') {
    if (authorSearching) return;
    setAuthorSearching(true);
    setFailure(null);
    try {
      const response = await requestWidgetAuthorOptions(search.trim());
      if (!response.success) {
        handleApiFailure(response.error.code);
        return;
      }
      const retainedIds = new Set((draft?.items ?? [])
        .filter((item) => item.type === 'profile')
        .map((item) => item.settings.author_id));
      if (retainedAuthorId) retainedIds.add(retainedAuthorId);
      const retained = authors.filter((author) => retainedIds.has(author.id));
      const nextAuthors = mergeAuthorOptions(retained, response.data.items);
      setAuthors(nextAuthors);
      if (itemDialog?.item.type === 'profile') {
        const currentId = itemDialog.item.settings.author_id;
        if (!nextAuthors.some((author) => author.id === currentId)) {
          updateEditingItem((current) => current.type === 'profile'
            ? {
                ...current,
                settings: { author_id: nextAuthors[0]?.id ?? '' },
              }
            : current);
        }
      }
    } catch (error) {
      handleClientFailure(error);
    } finally {
      setAuthorSearching(false);
    }
  }

  async function saveArea() {
    if (!draft) return;
    const parsed = saveWidgetAreaRequestSchema.safeParse({
      name: draft.name,
      enabled: draft.enabled,
      items: draft.items,
      expected_revision: selectedArea?.revision ?? null,
    });
    if (!parsed.success) {
      setFailure({ kind: 'validation', code: 'area' });
      return;
    }
    setRunning(true);
    setFailure(null);
    setCompletion(null);
    try {
      const response = await requestSaveWidgetArea(
        input.data.csrf_token,
        draft.widget_area_id,
        {
          ...parsed.data,
          items: canonicalizeWidgetItems(parsed.data.items),
        },
      );
      if (!response.success) {
        handleApiFailure(response.error.code);
        return;
      }
      const nextAreas = areas.some(
        (area) => area.widget_area_id === response.data.widget_area_id,
      )
        ? areas.map((area) => (
            area.widget_area_id === response.data.widget_area_id
              ? response.data
              : area
          ))
        : [...areas, response.data].sort((left, right) => (
            left.widget_area_id.localeCompare(right.widget_area_id)
          ));
      setAreas(nextAreas);
      selectLoadedArea(nextAreas, response.data.widget_area_id);
      setCompletion('saved');
    } catch (error) {
      handleClientFailure(error);
    } finally {
      setRunning(false);
    }
  }

  async function confirmDelete() {
    if (!selectedArea || isProtectedWidgetAreaId(selectedArea.widget_area_id)) {
      return;
    }
    setRunning(true);
    setFailure(null);
    try {
      const response = await requestDeleteWidgetArea(
        input.data.csrf_token,
        selectedArea.widget_area_id,
        { expected_revision: selectedArea.revision },
      );
      if (!response.success) {
        handleApiFailure(response.error.code);
        return;
      }
      const nextAreas = areas.filter(
        (area) => area.widget_area_id !== selectedArea.widget_area_id,
      );
      setAreas(nextAreas);
      selectLoadedArea(nextAreas, SIDEBAR_WIDGET_AREA_ID);
      setDeleteOpen(false);
      setCompletion('deleted');
    } catch (error) {
      handleClientFailure(error);
    } finally {
      setRunning(false);
    }
  }

  function renderAuthorSelect(item: Extract<WidgetItem, { type: 'profile' }>) {
    const exists = authors.some(
      (author) => author.id === item.settings.author_id,
    );
    return (
      <div className="widget-editor-reference">
        <Field
          label={t('item.author')}
          hint={authors.length === 0 ? t('add.noAuthors') : undefined}
        >
          {(control) => (
            <select
              {...control}
              value={item.settings.author_id}
              disabled={authorSearching}
              onChange={(event) => updateEditingItem((current) => (
                current.type === 'profile'
                  ? {
                      ...current,
                      settings: { author_id: event.target.value },
                    }
                  : current
              ))}
            >
              {!exists && item.settings.author_id ? (
                <option value={item.settings.author_id}>
                  {t('item.missingAuthor')}
                </option>
              ) : null}
              {authors.length === 0 ? <option value="">—</option> : null}
              {authors.map((author) => (
                <option key={author.id} value={author.id}>
                  {author.display_name} — {author.id}
                </option>
              ))}
            </select>
          )}
        </Field>
        <div className="widget-editor-search">
          <Field label={t('add.authorSearch')}>
            {(control) => (
              <input
                {...control}
                type="search"
                maxLength={200}
                value={authorSearch}
                disabled={authorSearching}
                onChange={(event) => setAuthorSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  void refreshAuthors(
                    authorSearch,
                    item.settings.author_id,
                  );
                }}
              />
            )}
          </Field>
          <Button
            type="button"
            disabled={authorSearching}
            onClick={() => void refreshAuthors(
              authorSearch,
              item.settings.author_id,
            )}
          >
            <StudioIcon icon={Search} className="structure-icon" />
            {authorSearching ? t('add.searching') : t('add.search')}
          </Button>
        </div>
      </div>
    );
  }

  function renderItemSettings(item: WidgetItem): React.ReactNode {
    if (item.type === 'search') {
      return (
        <>
          <Field label={t('item.placeholder')}>
            {(control) => (
              <input
                {...control}
                value={item.settings.placeholder}
                maxLength={200}
                onChange={(event) => updateEditingItem((current) => (
                  current.type === 'search'
                    ? {
                        ...current,
                        settings: {
                          ...current.settings,
                          placeholder: event.target.value,
                        },
                      }
                    : current
                ))}
              />
            )}
          </Field>
          <Field label={t('item.buttonLabel')}>
            {(control) => (
              <input
                {...control}
                value={item.settings.button_label}
                maxLength={80}
                onChange={(event) => updateEditingItem((current) => (
                  current.type === 'search'
                    ? {
                        ...current,
                        settings: {
                          ...current.settings,
                          button_label: event.target.value,
                        },
                      }
                    : current
                ))}
              />
            )}
          </Field>
        </>
      );
    }
    if (item.type === 'recent-posts') {
      return (
        <>
          <Field label={t('item.limit')}>
            {(control) => (
              <input
                {...control}
                type="number"
                min={1}
                max={20}
                value={item.settings.limit}
                onChange={(event) => updateEditingItem((current) => (
                  current.type === 'recent-posts'
                    ? {
                        ...current,
                        settings: {
                          ...current.settings,
                          limit: Number(event.target.value),
                        },
                      }
                    : current
                ))}
              />
            )}
          </Field>
          <Switch
            density="inline"
            label={t('item.showDate')}
            checked={item.settings.show_date}
            onChange={(showDate) => updateEditingItem((current) => (
              current.type === 'recent-posts'
                ? {
                    ...current,
                    settings: { ...current.settings, show_date: showDate },
                  }
                : current
            ))}
          />
        </>
      );
    }
    if (item.type === 'categories') {
      return (
        <>
          <Switch
            density="inline"
            label={t('item.showCount')}
            checked={item.settings.show_count}
            onChange={(showCount) => updateEditingItem((current) => (
              current.type === 'categories'
                ? {
                    ...current,
                    settings: { ...current.settings, show_count: showCount },
                  }
                : current
            ))}
          />
          <Switch
            density="inline"
            label={t('item.hierarchical')}
            checked={item.settings.hierarchical}
            onChange={(hierarchical) => updateEditingItem((current) => (
              current.type === 'categories'
                ? {
                    ...current,
                    settings: { ...current.settings, hierarchical },
                  }
                : current
            ))}
          />
        </>
      );
    }
    if (item.type === 'tags') {
      return (
        <>
          <Field label={t('item.limit')}>
            {(control) => (
              <input
                {...control}
                type="number"
                min={1}
                max={100}
                value={item.settings.limit}
                onChange={(event) => updateEditingItem((current) => (
                  current.type === 'tags'
                    ? {
                        ...current,
                        settings: {
                          ...current.settings,
                          limit: Number(event.target.value),
                        },
                      }
                    : current
                ))}
              />
            )}
          </Field>
          <Switch
            density="inline"
            label={t('item.showCount')}
            checked={item.settings.show_count}
            onChange={(showCount) => updateEditingItem((current) => (
              current.type === 'tags'
                ? {
                    ...current,
                    settings: { ...current.settings, show_count: showCount },
                  }
                : current
            ))}
          />
        </>
      );
    }
    if (item.type === 'archives') {
      return (
        <Field label={t('item.limit')}>
          {(control) => (
            <input
              {...control}
              type="number"
              min={1}
              max={120}
              value={item.settings.limit}
              onChange={(event) => updateEditingItem((current) => (
                current.type === 'archives'
                  ? {
                      ...current,
                      settings: { limit: Number(event.target.value) },
                    }
                  : current
              ))}
            />
          )}
        </Field>
      );
    }
    if (item.type === 'text') {
      return (
        <>
          <Field label={t('item.documentType')}>
            {(control) => (
              <select
                {...control}
                value={item.settings.document_type}
                onChange={(event) => updateEditingItem((current) => (
                  current.type === 'text'
                    ? {
                        ...current,
                        settings: {
                          ...current.settings,
                          document_type: event.target.value as
                            'plaintext' | 'markdown' | 'html',
                        },
                      }
                    : current
                ))}
              >
                {DOCUMENT_TYPES.map((type) => (
                  <option value={type} key={type}>
                    {t(`item.documents.${type}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="structure-field-wide">
            <Field label={t('item.content')}>
              {(control) => (
                <textarea
                  {...control}
                  value={item.settings.content}
                  maxLength={50_000}
                  onChange={(event) => updateEditingItem((current) => (
                    current.type === 'text'
                      ? {
                          ...current,
                          settings: {
                            ...current.settings,
                            content: event.target.value,
                          },
                        }
                      : current
                  ))}
                />
              )}
            </Field>
          </div>
        </>
      );
    }
    if (item.type === 'profile') return renderAuthorSelect(item);
    return (
      <fieldset className="structure-link-list structure-field-wide">
        <legend className="structure-link-list-label">{t('item.links')}</legend>
        {item.settings.links.map((link, index) => (
          <fieldset className="structure-link-row" key={`${item.id}-${index}`}>
            <legend className="structure-link-row-label">
              {t('item.linkNumber', { index: index + 1 })}
            </legend>
            <Field label={t('item.linkLabel')}>
              {(control) => (
                <input
                  {...control}
                  value={link.label}
                  maxLength={200}
                  onChange={(event) => updateEditingLink(
                    index,
                    (current) => ({ ...current, label: event.target.value }),
                  )}
                />
              )}
            </Field>
            <Field label={t('item.linkUrl')}>
              {(control) => (
                <input
                  {...control}
                  value={link.url}
                  maxLength={2048}
                  onChange={(event) => updateEditingLink(
                    index,
                    (current) => ({ ...current, url: event.target.value }),
                  )}
                />
              )}
            </Field>
            <Field label={t('item.linkTarget')}>
              {(control) => (
                <select
                  {...control}
                  value={link.target}
                  onChange={(event) => updateEditingLink(
                    index,
                    (current) => ({
                      ...current,
                      target: event.target.value as '_self' | '_blank',
                    }),
                  )}
                >
                  <option value="_self">{t('item.targets.self')}</option>
                  <option value="_blank">{t('item.targets.blank')}</option>
                </select>
              )}
            </Field>
            <div className="structure-link-actions">
              <Button
                type="button"
                size="sm"
                disabled={index === 0 || running}
                onClick={() => moveEditingLink(index, 'up')}
              >{t('item.moveUp')}</Button>
              <Button
                type="button"
                size="sm"
                disabled={index === item.settings.links.length - 1 || running}
                onClick={() => moveEditingLink(index, 'down')}
              >{t('item.moveDown')}</Button>
              <Button
                type="button"
                size="sm"
                variant="danger"
                disabled={running}
                onClick={() => updateEditingItem((current) => (
                  current.type === 'link-list'
                    ? {
                        ...current,
                        settings: {
                          links: current.settings.links.filter(
                            (_entry, entryIndex) => entryIndex !== index,
                          ),
                        },
                      }
                    : current
                ))}
              >{t('item.removeLink')}</Button>
            </div>
          </fieldset>
        ))}
        <div>
          <Button
            type="button"
            size="sm"
            disabled={running || item.settings.links.length >= 100}
            onClick={() => updateEditingItem((current) => (
              current.type === 'link-list'
                ? {
                    ...current,
                    settings: {
                      links: [
                        ...current.settings.links,
                        { label: '', url: '/', target: '_self' },
                      ],
                    },
                  }
                : current
            ))}
          >{t('item.addLink')}</Button>
        </div>
      </fieldset>
    );
  }

  function widgetSummary(item: WidgetItem): string {
    if (item.type === 'search') {
      return t('item.summary.search', {
        placeholder: item.settings.placeholder,
        button: item.settings.button_label,
      });
    }
    if (item.type === 'recent-posts') {
      return t('item.summary.recentPosts', {
        count: item.settings.limit,
        date: t(item.settings.show_date
          ? 'item.summary.datesShown'
          : 'item.summary.datesHidden'),
      });
    }
    if (item.type === 'categories') {
      return t('item.summary.categories', {
        counts: t(item.settings.show_count
          ? 'item.summary.countsShown'
          : 'item.summary.countsHidden'),
        hierarchy: t(item.settings.hierarchical
          ? 'item.summary.hierarchyOn'
          : 'item.summary.hierarchyOff'),
      });
    }
    if (item.type === 'tags') {
      return t('item.summary.tags', {
        count: item.settings.limit,
        display: t(item.settings.show_count
          ? 'item.summary.countsShown'
          : 'item.summary.countsHidden'),
      });
    }
    if (item.type === 'archives') {
      return t('item.summary.archives', { count: item.settings.limit });
    }
    if (item.type === 'text') {
      return t('item.summary.text', {
        format: t(`item.documents.${item.settings.document_type}`),
        count: item.settings.content.length,
      });
    }
    if (item.type === 'link-list') {
      return t('item.summary.links', { count: item.settings.links.length });
    }
    const author = authors.find(
      (option) => option.id === item.settings.author_id,
    );
    return author?.display_name ?? t('item.missingAuthor');
  }

  function renderItems(items: WidgetItem[]) {
    return (
      <ol className="widget-list">
        {items.map((item, index) => (
          <li key={item.id}>
            <Panel flush>
              <article className="widget-item" aria-label={
                item.title || t(`item.types.${item.type}`)
              }>
                <span className="widget-item-symbol">
                  <StudioIcon
                    icon={WIDGET_TYPE_ICONS[item.type]}
                    className="structure-icon"
                  />
                </span>
                <div className="widget-item-copy">
                  <Button
                    type="button"
                    variant="text"
                    disabled={running}
                    aria-label={t('item.editNamed', {
                      name: item.title || t(`item.types.${item.type}`),
                    })}
                    ref={(element) => {
                      if (element) itemEditRefs.current.set(item.id, element);
                      else itemEditRefs.current.delete(item.id);
                    }}
                    onClick={() => openItemDialog(item)}
                  >
                    {item.title || t(`item.types.${item.type}`)}
                  </Button>
                  <span className="widget-item-summary">
                    {widgetSummary(item)}
                  </span>
                </div>
                <div className="widget-item-status">
                  <StatusPill tone="neutral">
                    {t(`item.types.${item.type}`)}
                  </StatusPill>
                  {!item.enabled ? (
                    <StatusPill tone="neutral">{t('disabled')}</StatusPill>
                  ) : null}
                </div>
                <div className="widget-item-actions">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    title={t('item.moveUp')}
                    aria-label={t('item.moveUp')}
                    disabled={index === 0 || running}
                    onClick={() => moveItem(item.id, 'up')}
                  >
                    <StudioIcon icon={ArrowUp} className="structure-icon" />
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    title={t('item.moveDown')}
                    aria-label={t('item.moveDown')}
                    disabled={index === items.length - 1 || running}
                    onClick={() => moveItem(item.id, 'down')}
                  >
                    <StudioIcon icon={ArrowDown} className="structure-icon" />
                  </Button>
                  <ActionMenu
                    label={t('item.actions', {
                      name: item.title || t(`item.types.${item.type}`),
                    })}
                    disabled={running}
                    items={[
                      {
                        id: 'edit',
                        kind: 'button',
                        label: t('item.edit'),
                        icon: Pencil,
                        onSelect: () => openItemDialog(item),
                      },
                      {
                        id: 'remove',
                        kind: 'button',
                        label: t('item.remove'),
                        icon: Trash2,
                        tone: 'critical',
                        onSelect: () => {
                          removeReturnFocusRef.current = itemEditRefs.current
                            .get(item.id) ?? addItemRef.current;
                          setRemoveCandidate(item);
                        },
                      },
                    ]}
                  />
                </div>
              </article>
            </Panel>
          </li>
        ))}
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
        <PageHeader titleId="widgets-title" title={t('title')} />
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
    <main
      id="studio-main-content"
      aria-labelledby="widgets-title"
    >
      <UnsavedChangesGuard
        active={(
          hasChanges || itemDialogDirty || areaDialogDirty
        ) && !running}
        copy={{
          kicker: t('unsaved.kicker'),
          title: t('unsaved.title'),
          description: t('unsaved.description'),
          stay: t('unsaved.stay'),
          leave: t('unsaved.leave'),
        }}
      />
      <PageHeader
        titleId="widgets-title"
        kicker={t('kicker')}
        title={t('title')}
        description={t('description')}
      />

      {failure && !anyDialogOpen ? (
        <div className="structure-message">
          <Notice tone="error">{failureMessage(failure)}</Notice>
        </div>
      ) : null}

      <div className="structure-layout">
        <aside className="structure-sidebar" aria-label={t('areaList')}>
          <header className="structure-sidebar-header">
            <h2 className="structure-section-title">{t('areaList')}</h2>
            <Button
              type="button"
              size="sm"
              disabled={running || hasChanges}
              onClick={() => openAreaDialog('create')}
            >
              <StudioIcon icon={Plus} className="structure-icon" />
              {t('create.open')}
            </Button>
          </header>
          <div className="structure-selector">
            <Field
              label={t('selectArea')}
              labelHidden
              leading={<StudioIcon icon={PanelRight} />}
            >
              {(control) => (
                <select
                  {...control}
                  value={selectedId ?? ''}
                  disabled={running}
                  onChange={(event) => selectArea(event.target.value)}
                >
                  {targets.map((area) => (
                    <option key={area.widget_area_id} value={area.widget_area_id}>
                      {area.widget_area_id === selectedId && draft
                        ? draft.name
                        : area.name}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </div>
          <ul className="structure-target-list">
            {targets.map((area) => {
              const value = area.widget_area_id === selectedId && draft
                ? draft
                : area;
              const stored = areas.some(
                (candidate) => candidate.widget_area_id === area.widget_area_id,
              );
              return (
                <li key={area.widget_area_id}>
                  <button
                    type="button"
                    className="structure-target"
                    disabled={running}
                    aria-current={area.widget_area_id === selectedId
                      ? 'true'
                      : undefined}
                    onClick={() => selectArea(area.widget_area_id)}
                  >
                    <span className="structure-target-top">
                      <strong className="structure-target-name">
                        {value.name}
                      </strong>
                      <span className="structure-count">
                        {t('itemCount', { count: value.items.length })}
                      </span>
                    </span>
                    <span className="structure-target-bottom">
                      <span className="structure-target-key">
                        <StudioIcon icon={PanelRight} className="structure-icon" />
                        <code>{area.widget_area_id}</code>
                      </span>
                      <span className="structure-target-badges">
                        {isProtectedWidgetAreaId(area.widget_area_id) ? (
                          <StatusPill tone="neutral">{t('protected')}</StatusPill>
                        ) : null}
                        {!stored ? (
                          <StatusPill tone="neutral">{t('notSaved')}</StatusPill>
                        ) : null}
                        {!value.enabled ? (
                          <StatusPill tone="neutral">{t('disabled')}</StatusPill>
                        ) : null}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </aside>

        <div className="structure-editor">
          {!draft ? (
            <EmptyState headingLevel={2} title={t('selectArea')} />
          ) : (
            <>
              <Panel
                title={draft.name}
                description={draft.widget_area_id}
                leading={<StudioIcon icon={PanelRight} />}
                actions={(
                  <>
                    <Button
                      type="button"
                      disabled={running}
                      onClick={() => openAreaDialog('settings')}
                    >
                      <StudioIcon icon={Pencil} className="structure-icon" />
                      {t('editor.identity')}
                    </Button>
                    <Button
                      type="button"
                      ref={addItemRef}
                      disabled={running || draft.items.length >= WIDGET_MAX_ITEMS}
                      onClick={() => openItemDialog()}
                    >
                      <StudioIcon icon={Plus} className="structure-icon" />
                      {t('add.title')}
                    </Button>
                  </>
                )}
                footer={(
                  <div className="structure-savebar">
                    <div className="structure-save-state">
                      <span>
                        {hasChanges
                          ? t('editor.unsaved')
                          : hasUnstoredSelectedArea
                            ? t('editor.defaultsPending')
                            : t('editor.saved')}
                      </span>
                      {!draft.enabled ? (
                        <StatusPill tone="neutral">{t('disabled')}</StatusPill>
                      ) : null}
                    </div>
                    <div className="structure-save-actions">
                      <Button
                        type="button"
                        disabled={!hasChanges || running}
                        onClick={() => {
                          selectLoadedArea(areas, selectedId);
                          setFailure(null);
                          setCompletion(null);
                        }}
                      >
                        <StudioIcon icon={Undo2} className="structure-icon" />
                        {t('editor.discard')}
                      </Button>
                      <Button
                        type="button"
                        variant="primary"
                        disabled={(
                          !hasChanges && !hasUnstoredSelectedArea
                        ) || running}
                        onClick={() => void saveArea()}
                      >
                        <StudioIcon icon={Save} className="structure-icon" />
                        {running ? t('editor.saving') : t('editor.save')}
                      </Button>
                    </div>
                  </div>
                )}
              />

              <section
                aria-labelledby="widget-items-title"
                className="structure-items"
              >
                <header className="structure-items-header">
                  <h3 id="widget-items-title" className="structure-section-title">
                    {t('editor.items')}
                  </h3>
                  <span className="structure-count">
                    {t('itemCount', { count: draft.items.length })}
                  </span>
                </header>
                {draft.items.length === 0 ? (
                  <Panel>
                    <EmptyState
                      title={t('editor.noItems')}
                      description={t('editor.noItemsHelp')}
                    />
                  </Panel>
                ) : renderItems(draft.items)}
                {draft.items.length >= WIDGET_MAX_ITEMS ? (
                  <p className="structure-help">{t('editor.itemLimit')}</p>
                ) : null}
              </section>
            </>
          )}
        </div>
      </div>

      <Dialog
        open={areaDialog !== null}
        onClose={closeAreaDialog}
        busy={running}
        title={areaDialog === 'create'
          ? t('create.title')
          : t('editor.identity')}
        description={areaDialog === 'create'
          ? t('create.description')
          : t('editor.settingsDescription')}
      >
        <form
          className="structure-dialog-form"
          onSubmit={areaDialog === 'create'
            ? submitCustomArea
            : applyAreaSettings}
        >
          <div className="structure-form-fields">
            <Field
              label={t('create.name')}
              leading={<StudioIcon icon={Type} />}
            >
              {(control) => (
                <input
                  {...control}
                  value={customAreaName}
                  maxLength={120}
                  disabled={running}
                  onChange={(event) => setCustomAreaName(event.target.value)}
                />
              )}
            </Field>
            <Field
              label={t('create.areaId')}
              hint={areaDialog === 'create' ? t('create.areaIdHelp') : undefined}
              leading={<StudioIcon icon={Hash} />}
            >
              {(control) => (
                <input
                  {...control}
                  value={customAreaId}
                  maxLength={64}
                  disabled={running || areaDialog === 'settings'}
                  readOnly={areaDialog === 'settings'}
                  onChange={(event) => setCustomAreaId(event.target.value)}
                />
              )}
            </Field>
            {areaDialog === 'settings' && draft ? (
              <>
                <Switch
                  density="inline"
                  label={t('editor.enabled')}
                  description={t('editor.enabledHelp')}
                  checked={areaEnabled}
                  disabled={running}
                  onChange={setAreaEnabled}
                />
                {!isProtectedWidgetAreaId(draft.widget_area_id) ? (
                  <div className="structure-delete-action">
                    <Button
                      type="button"
                      variant="danger"
                      disabled={running}
                      onClick={() => {
                        setAreaDialog(null);
                        setDeleteOpen(true);
                      }}
                    >
                      <StudioIcon icon={Trash2} className="structure-icon" />
                      {t('editor.delete')}
                    </Button>
                  </div>
                ) : null}
              </>
            ) : null}
            {failure ? <Notice tone="error">{failureMessage(failure)}</Notice> : null}
          </div>
          <DialogActions>
            <Button type="button" disabled={running} onClick={closeAreaDialog}>
              {t('cancel')}
            </Button>
            <Button type="submit" variant="primary" disabled={running}>
              {areaDialog === 'create'
                ? running ? t('create.running') : t('create.submit')
                : t('editor.applySettings')}
            </Button>
          </DialogActions>
        </form>
      </Dialog>

      {itemDialog ? (
        <Dialog
          open
          size="editor"
          onClose={closeItemDialog}
          title={itemDialog.creating
            ? t('add.title')
            : t('item.editTitle', {
                name: itemDialog.item.title
                  || t(`item.types.${itemDialog.item.type}`),
              })}
          description={itemDialog.creating
            ? t('add.description')
            : t('item.editDescription')}
          returnFocusRef={itemReturnFocusRef}
        >
          <form className="widget-editor-form" onSubmit={applyItem}>
            <div className="widget-editor-fields">
              {itemDialog.creating ? (
                <Field
                  label={t('add.type')}
                  leading={<StudioIcon icon={Blocks} />}
                >
                  {(control) => (
                    <select
                      {...control}
                      value={itemDialog.item.type}
                      onChange={(event) => changeEditingType(
                        event.target.value as WidgetType,
                      )}
                    >
                      {WIDGET_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {t(`item.types.${type}`)}
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              ) : null}
              <Field
                label={t('item.title')}
                leading={<StudioIcon icon={Type} />}
              >
                {(control) => (
                  <input
                    {...control}
                    value={itemDialog.item.title}
                    maxLength={200}
                    onChange={(event) => updateEditingItem((current) => ({
                      ...current,
                      title: event.target.value,
                    }))}
                  />
                )}
              </Field>
              <Switch
                density="inline"
                label={t('item.enabled')}
                checked={itemDialog.item.enabled}
                onChange={(enabled) => updateEditingItem((current) => ({
                  ...current,
                  enabled,
                }))}
              />
              {renderItemSettings(itemDialog.item)}
              {itemInvalid ? (
                <Notice tone="error">{t('validation.item')}</Notice>
              ) : null}
              {failure ? (
                <Notice tone="error">{failureMessage(failure)}</Notice>
              ) : null}
            </div>
            <DialogActions>
              <Button type="button" onClick={closeItemDialog}>
                {t('cancel')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                disabled={authorSearching || (
                  itemDialog.item.type === 'profile'
                  && !itemDialog.item.settings.author_id
                )}
              >
                {itemDialog.creating ? t('add.submit') : t('item.apply')}
              </Button>
            </DialogActions>
          </form>
        </Dialog>
      ) : null}

      <Dialog
        open={removeCandidate !== null}
        onClose={() => setRemoveCandidate(null)}
        title={t('removeDialog.title', {
          name: removeCandidate?.title
            || (removeCandidate
              ? t(`item.types.${removeCandidate.type}`)
              : ''),
        })}
        description={t('removeDialog.description')}
        initialFocusRef={removeCancelRef}
        returnFocusRef={removeReturnFocusRef}
        actions={(
          <>
            <Button
              type="button"
              ref={removeCancelRef}
              onClick={() => setRemoveCandidate(null)}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={() => {
                if (removeCandidate) removeItem(removeCandidate.id);
                removeReturnFocusRef.current = addItemRef.current;
                setRemoveCandidate(null);
              }}
            >
              <StudioIcon icon={Trash2} className="structure-icon" />
              {t('item.remove')}
            </Button>
          </>
        )}
      />

      <Dialog
        open={deleteOpen && selectedArea !== null}
        onClose={() => setDeleteOpen(false)}
        busy={running}
        kicker={t('deleteDialog.kicker')}
        title={t('deleteDialog.title', { name: selectedArea?.name ?? '' })}
        description={t('deleteDialog.description')}
        initialFocusRef={deleteCancelRef}
        actions={(
          <>
            <Button
              type="button"
              ref={deleteCancelRef}
              disabled={running}
              onClick={() => setDeleteOpen(false)}
            >
              {t('deleteDialog.cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              disabled={running}
              onClick={() => void confirmDelete()}
            >
              <StudioIcon icon={Trash2} className="structure-icon" />
              {running ? t('deleteDialog.running') : t('deleteDialog.confirm')}
            </Button>
          </>
        )}
      />
    </main>
  );
}
