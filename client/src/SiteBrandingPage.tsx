import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { ApiErrorCode } from '../../contracts/api';
import {
  siteBrandingSettingsInputSchema,
  type BrandingMediaAsset,
  type SiteBrandingDocument,
  type SiteBrandingSettings,
} from '../../contracts/branding-settings';
import type { Media, MediaDelivery } from '../../contracts/media';
import { MediaPickerDialog } from './components/MediaPickerDialog';
import { Button, Callout, Field, Panel } from './components/primitives';
import { SettingsScreen } from './components/SettingsScreen';
import {
  requestSiteBranding,
  requestUpdateSiteBranding,
  SiteBrandingClientError,
  type SiteBrandingClientErrorCode,
} from './lib/branding-settings-client';
import { resolveMediaPreviewUrl } from './lib/media-preview';
import { STUDIO_PATHS } from './routing/studio-routes';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; document: SiteBrandingDocument }
  | { kind: 'error' };
type SaveState = 'idle' | 'saving' | 'saved' | 'validation' | 'conflict';
type FaviconSlot =
  | 'icon_media_id'
  | 'icon_dark_media_id'
  | 'apple_touch_icon_media_id';
type BrandingPicker =
  | { purpose: 'branding_favicon'; slot: FaviconSlot; title: string }
  | { purpose: 'branding_logo'; title: string };

function selectedAssetMap(document: SiteBrandingDocument) {
  return new Map(
    Object.values(document.selected_assets)
      .filter((asset): asset is BrandingMediaAsset => asset !== null)
      .map((asset) => [asset.id, asset] as const),
  );
}

function brandingAssetFromMedia(
  media: Media,
  delivery: MediaDelivery,
): BrandingMediaAsset | null {
  if (media.kind !== 'image') return null;
  const format = media.mime_type === 'image/png'
    ? 'png' as const
    : media.mime_type === 'image/svg+xml'
      ? 'svg' as const
      : ['image/x-icon', 'image/vnd.microsoft.icon'].includes(media.mime_type)
        ? 'ico' as const
        : 'other_image' as const;
  return {
    id: media.id,
    filename: media.filename,
    mime_type: media.mime_type,
    location: media.location,
    format,
    preview_url: resolveMediaPreviewUrl(media, delivery),
  };
}

export function SiteBrandingPage(input: {
  data: { csrf_token: string };
  onSessionEnded: () => void;
}) {
  const { t } = useTranslation('brandingSettings');
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [draft, setDraft] = useState<SiteBrandingSettings | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [failure, setFailure] = useState<
    ApiErrorCode | SiteBrandingClientErrorCode | null
  >(null);
  const [selectedAssets, setSelectedAssets] = useState(
    () => new Map<string, BrandingMediaAsset>(),
  );
  const [picker, setPicker] = useState<BrandingPicker | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoadState({ kind: 'loading' });
    setFailure(null);
    setSaveState('idle');
    void requestSiteBranding(controller.signal).then((response) => {
      if (!active) return;
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          input.onSessionEnded();
          return;
        }
        setLoadState({ kind: 'error' });
        return;
      }
      setDraft(structuredClone(response.data.settings));
      setSelectedAssets(selectedAssetMap(response.data));
      setLoadState({ kind: 'ready', document: response.data });
    }).catch(() => {
      if (active && !controller.signal.aborted) setLoadState({ kind: 'error' });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [input.onSessionEnded, loadAttempt]);

  const savedDocument = loadState.kind === 'ready' ? loadState.document : null;
  const parsedDraft = useMemo(
    () => draft ? siteBrandingSettingsInputSchema.safeParse(draft) : null,
    [draft],
  );
  const hasChanges = savedDocument !== null && draft !== null
    && JSON.stringify(draft) !== JSON.stringify(savedDocument.settings);

  function edit(settings: SiteBrandingSettings) {
    setDraft(settings);
    setSaveState('idle');
    setFailure(null);
  }

  function assetFor(id: string | null) {
    return id ? selectedAssets.get(id) ?? null : null;
  }

  function rememberAsset(asset: BrandingMediaAsset) {
    setSelectedAssets((current) => {
      const next = new Map(current);
      next.set(asset.id, asset);
      return next;
    });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!savedDocument || !draft || !hasChanges || saveState === 'saving') return;
    if (!parsedDraft?.success) {
      setSaveState('validation');
      return;
    }
    setSaveState('saving');
    setFailure(null);
    try {
      const response = await requestUpdateSiteBranding(input.data.csrf_token, {
        settings: parsedDraft.data,
        expected_revision: savedDocument.revision,
      });
      if (!response.success) {
        if (response.error.code === 'AUTHENTICATION_REQUIRED') {
          setSaveState('idle');
          input.onSessionEnded();
          return;
        }
        if (response.error.code === 'SETTINGS_REVISION_CONFLICT') {
          setSaveState('conflict');
          return;
        }
        setFailure(response.error.code);
        setSaveState(response.error.code === 'VALIDATION_ERROR'
          ? 'validation'
          : 'idle');
        return;
      }
      setDraft(structuredClone(response.data.settings));
      setSelectedAssets(selectedAssetMap(response.data));
      setLoadState({ kind: 'ready', document: response.data });
      setSaveState('saved');
    } catch (error) {
      setFailure(error instanceof SiteBrandingClientError
        ? error.code
        : 'INVALID_RESPONSE');
      setSaveState('idle');
    }
  }

  const errorMessage = failure === 'FORBIDDEN'
    ? t('errors.forbidden')
    : failure === 'SITE_BRANDING_MEDIA_NOT_FOUND'
      ? t('errors.mediaNotFound')
      : failure === 'SITE_BRANDING_MEDIA_TYPE_NOT_ALLOWED'
        ? t('errors.mediaType')
        : failure === 'TIMEOUT'
          ? t('errors.timeout')
          : failure === 'NETWORK_ERROR'
            ? t('errors.network')
            : failure === 'INVALID_RESPONSE'
              ? t('errors.invalidResponse')
              : failure ? t('errors.api') : null;

  const faviconSlots = draft ? [
    {
      key: 'icon_media_id' as const,
      label: t('favicon.default.label'),
      description: t('favicon.default.description'),
      empty: t('favicon.default.empty'),
      previewClass: 'branding-preview-light',
    },
    {
      key: 'icon_dark_media_id' as const,
      label: t('favicon.dark.label'),
      description: t('favicon.dark.description'),
      empty: t('favicon.dark.empty'),
      previewClass: 'branding-preview-dark',
    },
    {
      key: 'apple_touch_icon_media_id' as const,
      label: t('favicon.apple.label'),
      description: t('favicon.apple.description'),
      empty: t('favicon.apple.empty'),
      previewClass: 'branding-preview-neutral',
    },
  ] : [];

  const saving = saveState === 'saving';
  const logoAsset = draft ? assetFor(draft.logo.media_id) : null;

  return (
    <SettingsScreen
      navigation="site"
      copy={{
        documentTitle: t('documentTitle'),
        kicker: t('kicker'),
        title: t('title'),
        description: t('description'),
        loading: { title: t('loading') },
        loadError: { title: t('loadError') },
        saved: t('state.saved'),
        validation: t('errors.validation'),
        conflict: {
          title: t('errors.conflictTitle'),
          description: t('errors.conflictDescription'),
        },
        save: t('actions.save'),
      }}
      load={loadState.kind === 'ready' && !draft ? 'loading' : loadState.kind}
      onRetry={() => setLoadAttempt((value) => value + 1)}
      save={saveState}
      error={errorMessage}
      dirty={hasChanges}
      onReset={() => {
        if (loadState.kind === 'ready') {
          setDraft(structuredClone(loadState.document.settings));
          setSelectedAssets(selectedAssetMap(loadState.document));
        }
        setSaveState('idle');
        setFailure(null);
      }}
      onSubmit={save}
    >
      {draft ? (
        <>
          <Panel
            title={t('favicon.title')}
            description={t('favicon.description')}
          >
            <div className="settings-fields">
              {draft.favicon.icon_media_id === null
                && draft.favicon.icon_dark_media_id === null
                && draft.favicon.apple_touch_icon_media_id === null ? (
                  <Callout tone="info" title={t('favicon.automatic.title')}>
                    {t('favicon.automatic.description')}
                  </Callout>
                ) : null}
              <div className="branding-slot-grid">
                {faviconSlots.map((slot) => {
                  const selected = assetFor(draft.favicon[slot.key]);
                  return (
                    <article className="branding-slot" key={slot.key}>
                      <div className={`branding-asset-preview ${slot.previewClass}`}>
                        {selected?.preview_url ? (
                          <img
                            src={selected.preview_url}
                            alt=""
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                        ) : selected ? (
                          <span className="branding-asset-placeholder">
                            {t('previewUnavailable')}
                          </span>
                        ) : (
                          <span className="branding-asset-placeholder" aria-hidden="true">
                            ZP
                          </span>
                        )}
                      </div>
                      <div className="branding-selection-copy">
                        <strong className="branding-selection-label">{slot.label}</strong>
                        <span className="branding-selection-value">{selected?.filename ?? slot.empty}</span>
                        <small className="branding-selection-meta">{selected?.mime_type ?? slot.description}</small>
                      </div>
                      <div className="settings-action-row">
                        <Button
                          type="button"
                          size="sm"
                          disabled={saving}
                          onClick={() => setPicker({
                            purpose: 'branding_favicon',
                            slot: slot.key,
                            title: slot.label,
                          })}
                        >
                          {selected ? t('actions.replace') : t('actions.choose')}
                        </Button>
                        {selected ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disabled={saving}
                            onClick={() => edit({
                              ...draft,
                              favicon: { ...draft.favicon, [slot.key]: null },
                            })}
                          >
                            {t('actions.remove')}
                          </Button>
                        ) : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          </Panel>

          <Panel
            title={t('logo.title')}
            description={t('logo.description')}
          >
            <div className="settings-fields">
              <div className="branding-logo-layout">
                <div className="branding-logo-previews">
                  {[
                    { key: 'light', label: t('logo.preview.light') },
                    { key: 'dark', label: t('logo.preview.dark') },
                  ].map((preview) => (
                    <div key={preview.key}>
                      <small className="branding-preview-caption">{preview.label}</small>
                      <div className={`branding-logo-preview branding-preview-${preview.key}`}>
                        {logoAsset?.preview_url ? (
                          <img
                            src={logoAsset.preview_url}
                            alt=""
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <span className="branding-preview-empty">
                            {logoAsset ? t('previewUnavailable') : t('logo.emptyPreview')}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="settings-fields">
                  <div className="branding-selection-copy">
                    <strong className="branding-selection-label">{t('logo.media.label')}</strong>
                    <span className="branding-selection-value">{logoAsset?.filename ?? t('logo.media.empty')}</span>
                    <small className="branding-selection-meta">{logoAsset?.mime_type ?? t('logo.media.description')}</small>
                  </div>
                  <div className="settings-action-row">
                    <Button
                      type="button"
                      disabled={saving}
                      onClick={() => setPicker({
                        purpose: 'branding_logo',
                        title: t('logo.media.label'),
                      })}
                    >
                      {logoAsset ? t('actions.replace') : t('actions.choose')}
                    </Button>
                    {logoAsset ? (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={saving}
                        onClick={() => edit({
                          ...draft,
                          logo: { media_id: null, alt: '' },
                        })}
                      >
                        {t('actions.remove')}
                      </Button>
                    ) : null}
                  </div>
                  <Field
                    label={t('logo.alt.label')}
                    hint={t('logo.alt.description')}
                  >
                    {(control) => (
                      <input
                        {...control}
                        type="text"
                        value={draft.logo.alt}
                        placeholder={t('logo.alt.placeholder')}
                        disabled={saving || draft.logo.media_id === null}
                        onChange={(event) => edit({
                          ...draft,
                          logo: { ...draft.logo, alt: event.target.value },
                        })}
                      />
                    )}
                  </Field>
                </div>
              </div>
              <p className="branding-media-link">
                <Link to={STUDIO_PATHS.media}>{t('mediaLibrary')}</Link>
              </p>
            </div>
          </Panel>

          {picker ? (
            <MediaPickerDialog
              purpose={picker.purpose}
              selectedId={picker.purpose === 'branding_logo'
                ? draft.logo.media_id
                : draft.favicon[picker.slot]}
              copy={{
                kicker: t('picker.kicker'),
                title: picker.title,
                description: t(picker.purpose === 'branding_logo'
                  ? 'picker.logoDescription'
                  : 'picker.faviconDescription'),
                select: t('actions.choose'),
                selectNamed: (filename) => t('picker.chooseNamed', { filename }),
                emptyTitle: t('picker.emptyTitle'),
                emptyDescription: t('picker.emptyDescription'),
              }}
              onClose={() => setPicker(null)}
              onSessionEnded={input.onSessionEnded}
              aiGenerationCsrfToken={input.data.csrf_token}
              mediaManagementCsrfToken={input.data.csrf_token}
              onSelect={(media, delivery) => {
                const asset = brandingAssetFromMedia(media, delivery);
                if (!asset) return;
                rememberAsset(asset);
                if (picker.purpose === 'branding_logo') {
                  edit({ ...draft, logo: { ...draft.logo, media_id: asset.id } });
                } else {
                  edit({
                    ...draft,
                    favicon: { ...draft.favicon, [picker.slot]: asset.id },
                  });
                }
                setPicker(null);
              }}
            />
          ) : null}
        </>
      ) : null}
    </SettingsScreen>
  );
}
