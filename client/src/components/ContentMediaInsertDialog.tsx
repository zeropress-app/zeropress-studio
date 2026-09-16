import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Media } from '../../../contracts/media';
import { MediaPickerDialog } from './MediaPickerDialog';

export function ContentMediaInsertDialog(input: {
  onClose: () => void;
  onInsert: (media: Media) => boolean;
  onSessionEnded: () => void;
  showManageLink?: boolean;
  aiGenerationCsrfToken?: string;
  mediaManagementCsrfToken?: string;
  mode?: 'insert' | 'replace-image';
}) {
  const { t } = useTranslation('media');
  const [insertionFailed, setInsertionFailed] = useState(false);

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
      errorMessage={insertionFailed ? t('contentInsertion.tooLong') : null}
      onSelect={(media) => {
        setInsertionFailed(false);
        if (!input.onInsert(media)) setInsertionFailed(true);
      }}
    />
  );
}
