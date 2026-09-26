import { ExternalLink } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ContentPermalink as Permalink } from '../../../contracts/content-permalink';
import { StudioIcon } from './primitives';

function displayUrl(url: string): string {
  try { return decodeURI(url); } catch { return url; }
}

export function ContentPermalink(input: { value: Permalink | null }) {
  const { t } = useTranslation('contentEditor');
  const value = input.value;
  if (!value?.url || value.status === 'trash') return null;
  return <p className="content-editor-permalink">
    <strong>{t(value.status === 'published' ? 'permalink.published' : 'permalink.planned')}</strong>
    {value.status === 'published' ? (
      <a href={value.url} target="_blank" rel="noopener noreferrer">
        {displayUrl(value.url)}<StudioIcon icon={ExternalLink} />
      </a>
    ) : <span>{displayUrl(value.url)}</span>}
  </p>;
}
