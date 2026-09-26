import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Media } from '../../../contracts/media';
import type { ContentInsertionResult } from '../lib/content-media-insertion';
import { MediaPickerDialog } from './MediaPickerDialog';

export function ContentMediaInsertDialog(input: {
  onClose: () => void;
  onInsert: (media: Media) => ContentInsertionResult;
  onSessionEnded: () => void;
  showManageLink?: boolean;
  aiGenerationCsrfToken?: string;
  mediaManagementCsrfToken?: string;
  mode?: 'insert' | 'replace-image';
}) {
  const { t } = useTranslation('media');
  const [failure, setFailure] = useState<Extract<ContentInsertionResult, { ok: false }>['reason'] | null>(null);

  return (
    <MediaPickerDialog
      purpose={input.mode === 'replace-image' ? 'featured_image' : 'all'}
      copy={{
        kicker: t(input.mode === 'replace-image'
          ? 'contentInsertion.replaceKicker'
          : 'contentInsertion.kicker'),
        title: t(input.mode === 'replace-image'
          ? 'contentInsertion.replaceTitle'
          : 'contentInsertion.title'),
        description: t(input.mode === 'replace-image'
          ? 'contentInsertion.replaceDescription'
          : 'contentInsertion.description'),
        select: t(input.mode === 'replace-image'
          ? 'contentInsertion.replace'
          : 'contentInsertion.insert'),
        selectNamed: (filename) => t(input.mode === 'replace-image'
          ? 'contentInsertion.replaceNamed'
          : 'contentInsertion.insertNamed', {
          filename,
        }),
        emptyTitle: t('contentInsertion.emptyTitle'),
        emptyDescription: t('contentInsertion.emptyDescription'),
      }}
      onClose={input.onClose}
      onSessionEnded={input.onSessionEnded}
      showManageLink={input.showManageLink}
      aiGenerationCsrfToken={input.aiGenerationCsrfToken}
      mediaManagementCsrfToken={input.mediaManagementCsrfToken}
      errorMessage={failure ? t(`contentInsertion.errors.${failure}`) : null}
      onSelect={(media) => {
        const result = input.onInsert(media);
        setFailure(result.ok ? null : result.reason);
      }}
    />
  );
}
