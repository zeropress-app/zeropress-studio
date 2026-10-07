import { useEffect, useState } from 'react';
import type { EdgeUrlSettingsSuccess } from '../../../contracts/edge-url';
import { requestEdgeUrlSettings } from '../lib/edge-url-client';

type Document = EdgeUrlSettingsSuccess['data'];
export function useEdgeUrl(onSessionEnded: () => void) {
  const [document, setDocument] = useState<Document | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    setDocument(null);
    void requestEdgeUrlSettings(controller.signal).then((response) => {
      if (controller.signal.aborted) return;
      if (response.success) setDocument(response.data);
      else if (response.error.code === 'AUTHENTICATION_REQUIRED') onSessionEnded();
      else setFailed(true);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [attempt, onSessionEnded]);
  return { document, setDocument, failed, retry: () => setAttempt((value) => value + 1) };
}

