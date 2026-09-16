import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import {
  mediaLocationLabel,
  mediaReferenceFromMedia,
  type MediaReference,
} from '../../../contracts/media';
import { STUDIO_PATHS } from '../routing/studio-routes';
import { MediaPickerDialog } from './MediaPickerDialog';
import { Button, Panel } from './primitives';

export function FeaturedImageField(input: {
  value: string | null;
  current: MediaReference | null;
  onChange: (id: string | null, reference: MediaReference | null) => void;
  onSessionEnded: () => void;
  showManageLink?: boolean;
  aiGenerationCsrfToken?: string;
  mediaManagementCsrfToken?: string;
}) {
  const { t } = useTranslation('media');
  const [pickerOpen, setPickerOpen] = useState(false);

  return (
    <Panel
      title={t('selector.title')}
      description={t('selector.description')}
    >
      <div className="featured-image-field">
        {input.current?.location.type === 'external' ? (
          <img
            className="featured-image-preview"
            src={input.current.location.url}
            alt={input.current.alt}
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : null}
        {input.current ? (
          <div className="featured-image-selection">
            <strong>{input.current.filename}</strong>
            <code>{mediaLocationLabel(input.current.location)}</code>
            <small className="featured-image-dimensions">
              {input.current.width}×{input.current.height}
            </small>
          </div>
        ) : (
          <p className="content-editor-empty-reference">
            {t('selector.none')}
          </p>
        )}
        <div className="content-list-row-actions">
          <Button type="button" onClick={() => setPickerOpen(true)}>
            {input.current ? t('selector.replace') : t('selector.choose')}
          </Button>
          {input.current ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => input.onChange(null, null)}
            >
              {t('selector.remove')}
            </Button>
          ) : null}
        </div>
        {input.showManageLink !== false ? (
          <p className="content-editor-empty-reference">
            <Link
              to={STUDIO_PATHS.media}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('selector.manage')}
            </Link>
          </p>
        ) : null}
      </div>

      {pickerOpen ? (
        <MediaPickerDialog
          purpose="featured_image"
          selectedId={input.value}
          copy={{
            kicker: t('selector.pickerKicker'),
            title: t('selector.pickerTitle'),
            description: t('selector.description'),
            select: t('selector.choose'),
            selectNamed: (filename) => t('selector.chooseNamed', { filename }),
            emptyTitle: t('selector.emptyTitle'),
            emptyDescription: t('selector.emptyDescription'),
          }}
          onClose={() => setPickerOpen(false)}
          onSessionEnded={input.onSessionEnded}
          showManageLink={input.showManageLink}
          aiGenerationCsrfToken={input.aiGenerationCsrfToken}
          mediaManagementCsrfToken={input.mediaManagementCsrfToken}
          onSelect={(media) => {
            const reference = mediaReferenceFromMedia(media);
            if (!reference) return;
            input.onChange(reference.id, reference);
            setPickerOpen(false);
          }}
        />
      ) : null}
    </Panel>
  );
}
