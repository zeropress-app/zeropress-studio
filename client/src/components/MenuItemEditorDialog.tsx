import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { FileText, Files, FolderTree, Link2, RefreshCw, Search, Tags, Type, type LucideIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  canonicalizeMenuItems,
  menuMetaSchema,
  menuReferenceKey,
  type MenuItem,
  type MenuReferenceResolution,
  type MenuReferenceSummary,
} from '../../../contracts/menus';
import { MenuReferencePicker } from './MenuReferencePicker';
import { Button, Callout, Dialog, DialogActions, Field, InlineStatus, Notice, Panel, StudioIcon } from './primitives';

export const MENU_LINK_ICONS: Record<MenuItem['link']['kind'], LucideIcon> = {
  custom: Link2, post: FileText, page: Files, category: FolderTree, tag: Tags,
};

/** This form only applies to the menu draft; Save menu remains the persistence boundary. */
export function MenuItemEditorDialog(input: {
  item: MenuItem;
  creating: boolean;
  resolutions: ReadonlyMap<string, MenuReferenceResolution>;
  referencesFailed: boolean;
  onRetryReferences: () => void;
  onApply: (item: MenuItem) => void;
  onClose: () => void;
  onSessionEnded: () => void;
  onDirtyChange: (dirty: boolean) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation('menus');
  const [item, setItem] = useState(() => structuredClone(input.item));
  const [meta, setMeta] = useState(() => input.item.meta ? JSON.stringify(input.item.meta, null, 2) : '');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [titleEdited, setTitleEdited] = useState(!input.creating || Boolean(input.item.title.trim()));
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<MenuReferenceSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const findButtonRef = useRef<HTMLButtonElement>(null);
  const wasPicking = useRef(false);
  const originalMeta = input.item.meta ? JSON.stringify(input.item.meta, null, 2) : '';
  const dirty = JSON.stringify(item) !== JSON.stringify(input.item) || meta !== originalMeta;

  useEffect(() => { input.onDirtyChange(dirty); }, [dirty, input.onDirtyChange]);
  useEffect(() => {
    if (wasPicking.current && !picking) findButtonRef.current?.focus();
    wasPicking.current = picking;
  }, [picking]);

  function changeKind(kind: MenuItem['link']['kind']) {
    setPicked(null);
    setError(null);
    setItem((current) => ({
      ...current,
      link: kind === 'custom' ? { kind, url: '/' } : { kind, reference_id: '' },
    }));
  }

  function selectReference(reference: MenuReferenceSummary) {
    setPicked(reference);
    setItem((current) => ({
      ...current,
      // Only an untouched new item's label follows content selection.
      title: titleEdited ? current.title : reference.title,
      link: { kind: reference.kind, reference_id: reference.reference_id },
    }));
    setError(null);
    setPicking(false);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const candidate: MenuItem = { ...item, title: item.title.trim() };
    delete candidate.meta;
    if (meta.trim()) {
      try {
        const parsed = menuMetaSchema.safeParse(JSON.parse(meta));
        if (!parsed.success) throw new Error('invalid metadata');
        if (Object.keys(parsed.data).length) candidate.meta = parsed.data;
      } catch {
        setError(t('validation.meta'));
        return;
      }
    }
    if (candidate.link.kind === 'custom') candidate.link = { kind: 'custom', url: candidate.link.url.trim() };
    try {
      canonicalizeMenuItems([candidate]);
    } catch {
      setError(t('validation.item'));
      return;
    }
    input.onApply(candidate);
    // An explicitly picked target may have been restored/renamed since hydration.
    // Recheck it at apply time; titles, ordering and metadata alone do not reload references.
    if (picked) input.onRetryReferences();
  }

  const reference = item.link.kind === 'custom' ? null : item.link;
  const resolution = reference ? input.resolutions.get(menuReferenceKey(reference)) : undefined;
  const summary = reference && picked && menuReferenceKey(reference) === menuReferenceKey(picked)
    ? picked : resolution?.status === 'available' ? resolution : null;

  return (
    <Dialog
      open
      title={picking && reference ? t(`picker.title.${reference.kind}`)
        : input.creating ? t('add.title') : t('item.edit')}
      description={picking ? undefined : t('item.draftHelp')}
      size={picking ? 'wide' : 'default'}
      onClose={picking ? () => setPicking(false) : input.onClose}
      returnFocusRef={input.returnFocusRef}
    >
      {picking && reference ? (
        <MenuReferencePicker
          kind={reference.kind}
          selectedId={reference.reference_id}
          onSelect={selectReference}
          onBack={() => setPicking(false)}
          onSessionEnded={input.onSessionEnded}
        />
      ) : (
        <form className="navigation-dialog-form" onSubmit={submit}>
          <div className="navigation-form-fields">
            <Field label={t('add.type')} leading={<StudioIcon icon={MENU_LINK_ICONS[item.link.kind]} />}>
              {(control) => (
                <select {...control} value={item.link.kind} disabled={!input.creating}
                  onChange={(event) => changeKind(event.target.value as MenuItem['link']['kind'])}>
                  {Object.keys(MENU_LINK_ICONS).map((kind) => (
                    <option key={kind} value={kind}>{t(`add.types.${kind as MenuItem['link']['kind']}`)}</option>
                  ))}
                </select>
              )}
            </Field>
            {reference ? (
              <Panel title={t('item.reference')} actions={(
                <Button ref={findButtonRef} type="button" size="sm" onClick={() => setPicking(true)}>
                  <StudioIcon icon={Search} className="navigation-icon" />
                  {reference.reference_id ? t('picker.change') : t(`picker.find.${reference.kind}`)}
                </Button>
              )}>
                <div className="navigation-reference-summary" role="group" aria-label={t('item.reference')}>
                  {summary ? (
                    <>
                      <span className="navigation-reference-title">{summary.title}</span>
                      <span className="navigation-reference-detail">{summary.detail}</span>
                    </>
                  ) : !reference.reference_id ? (
                    <p className="navigation-help">{t('picker.noSelection')}</p>
                  ) : resolution?.status === 'missing' || resolution?.status === 'trash' ? (
                    <Callout tone="warning">{t(resolution.status === 'missing' ? 'item.missingReference' : 'item.trashedReference')}</Callout>
                  ) : input.referencesFailed ? (
                    <Notice tone="error">
                      <p>{t('item.uncheckedReference')}</p>
                      <Button type="button" onClick={input.onRetryReferences}>
                        <StudioIcon icon={RefreshCw} className="navigation-icon" />{t('references.retry')}
                      </Button>
                    </Notice>
                  ) : <InlineStatus>{t('item.checkingReference')}</InlineStatus>}
                </div>
              </Panel>
            ) : (
              <Field label={t('item.customUrl')} hint={t('add.urlHelp')} leading={<StudioIcon icon={Link2} />}>
                {(control) => (
                  <input {...control} value={item.link.kind === 'custom' ? item.link.url : ''}
                    maxLength={2048} onChange={(event) => setItem((current) => ({
                      ...current, link: { kind: 'custom', url: event.target.value },
                    }))} />
                )}
              </Field>
            )}
            <Field label={t('item.title')} leading={<StudioIcon icon={Type} />}>
              {(control) => (
                <input {...control} value={item.title} maxLength={200}
                  onChange={(event) => {
                    setTitleEdited(true);
                    setItem((current) => ({ ...current, title: event.target.value }));
                  }} />
              )}
            </Field>
            <label className="navigation-checkbox">
              <input type="checkbox" checked={item.target === '_blank'} onChange={(event) => (
                setItem((current) => ({ ...current, target: event.target.checked ? '_blank' : '_self' }))
              )} />
              {t('add.newTab')}
            </label>
            <details className="navigation-advanced" open={advancedOpen}
              onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
              <summary tabIndex={0}>{t('item.advanced')}</summary>
              <Field label={t('item.meta')} hint={t('item.metaHelp')}>
                {(control) => <textarea {...control} rows={3} value={meta} placeholder="{ }"
                  onChange={(event) => setMeta(event.target.value)} />}
              </Field>
            </details>
            {error && <Notice tone="error">{error}</Notice>}
          </div>
          <DialogActions>
            <Button type="button" onClick={input.onClose}>{t('cancel')}</Button>
            <Button type="submit" variant="primary">{input.creating ? t('add.submit') : t('item.apply')}</Button>
          </DialogActions>
        </form>
      )}
    </Dialog>
  );
}
