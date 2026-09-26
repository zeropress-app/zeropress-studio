import { useEffect, useRef, useState } from 'react';
import { contentPermalinkResponseSchema, type ContentPermalink } from '../../../contracts/content-permalink';
import { studioFetch } from '../lib/studio-fetch';

export function useContentPermalink(
  kind: 'posts' | 'pages',
  document: { id: string; revision: string } | null,
  onSessionEnded: () => void,
): ContentPermalink | null {
  const id = document?.id;
  const revision = document?.revision;
  const key = `${kind}:${id}:${revision}`;
  const [result, setResult] = useState<{ key: string; data: ContentPermalink } | null>(null);
  const onSessionEndedRef = useRef(onSessionEnded);
  onSessionEndedRef.current = onSessionEnded;
  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    void studioFetch(`/api/${kind}/${encodeURIComponent(id)}/permalink`, {
      signal: controller.signal, headers: { Accept: 'application/json' }, cache: 'no-store',
    }).then(async (response) => {
      const parsed = contentPermalinkResponseSchema.safeParse(await response.json());
      if (controller.signal.aborted || !parsed.success) return;
      if (!parsed.data.success) {
        if (parsed.data.error.code === 'AUTHENTICATION_REQUIRED') onSessionEndedRef.current();
        return;
      }
      if (parsed.data.data.revision === revision) setResult({ key, data: parsed.data.data });
    }).catch(() => {
      // A permalink lookup failure must not interrupt editing or body preview.
    }).finally(() => clearTimeout(timeout));
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [kind, id, revision, key]);
  return result?.key === key ? result.data : null;
}
