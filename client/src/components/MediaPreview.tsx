import { useEffect, useState } from 'react';
import type { Media } from '../../../contracts/media';

export function MediaPreview(input: {
  media: Media;
  source: string | null;
  kindLabel: string;
  unavailableLabel: string;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [input.source]);
  if (input.source && !failed) {
    return (
      <img
        className={input.className ?? 'media-thumbnail'}
        src={input.source}
        alt={input.media.alt}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      className="media-kind-badge"
      title={input.media.kind === 'image' ? input.unavailableLabel : undefined}
      aria-label={input.media.kind === 'image' ? input.unavailableLabel : undefined}
    >
      {input.kindLabel}
    </span>
  );
}
