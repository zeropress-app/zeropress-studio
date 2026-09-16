import { useEffect, useMemo, useRef, useState } from 'react';
import {
  menuReferenceKey,
  type MenuItem,
  type MenuReference,
  type MenuReferenceResolution,
} from '../../../contracts/menus';
import { requestMenuReferences } from '../lib/menus-client';

type Snapshot = {
  scope: string;
  resolutions: Map<string, MenuReferenceResolution>;
  failed: boolean;
};

function collectReferences(items: MenuItem[]): MenuReference[] {
  const references = new Map<string, MenuReference>();
  const pending = [...items];
  while (pending.length > 0) {
    const item = pending.pop();
    if (!item) continue;
    if (item.link.kind !== 'custom') {
      references.set(menuReferenceKey(item.link), item.link);
    }
    pending.push(...item.children);
  }
  return [...references.values()].sort((left, right) => (
    menuReferenceKey(left).localeCompare(menuReferenceKey(right))
  ));
}

export function useMenuReferences(input: {
  menuId: string | null;
  revision: string | null;
  items: MenuItem[];
  enabled: boolean;
  csrfToken: string;
  onSessionEnded: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const cache = useRef<Snapshot | null>(null);
  // Titles, order, metadata, and search text do not invalidate reference reads.
  const referenceKey = JSON.stringify(collectReferences(input.items));
  const references = useMemo(
    () => JSON.parse(referenceKey) as MenuReference[],
    [referenceKey],
  );
  const scope = JSON.stringify([input.menuId, input.revision, attempt]);

  useEffect(() => {
    if (!input.enabled) {
      cache.current = null;
      setSnapshot(null);
      return;
    }
    const controller = new AbortController();
    let active = true;
    const resolutions = new Map<string, MenuReferenceResolution>();
    if (cache.current?.scope === scope) {
      for (const reference of references) {
        const key = menuReferenceKey(reference);
        const previous = cache.current.resolutions.get(key);
        if (previous) resolutions.set(key, previous);
      }
    }
    const pending = references.filter((reference) => !resolutions.has(menuReferenceKey(reference)));
    const next: Snapshot = { scope, resolutions, failed: false };
    cache.current = next;
    setSnapshot(next);
    if (pending.length === 0) return;

    void requestMenuReferences(input.csrfToken, { references: pending }, controller.signal)
      .then((response) => {
        if (!active) return;
        if (!response.success) {
          if (response.error.code === 'AUTHENTICATION_REQUIRED') input.onSessionEnded();
          setSnapshot({ ...next, failed: true });
          return;
        }
        const resolved = new Map(resolutions);
        for (const reference of response.data.items) {
          resolved.set(menuReferenceKey(reference), reference);
        }
        const completed = { scope, resolutions: resolved, failed: false };
        cache.current = completed;
        setSnapshot(completed);
      })
      .catch(() => {
        if (active && !controller.signal.aborted) setSnapshot({ ...next, failed: true });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [input.enabled, input.csrfToken, input.onSessionEnded, references, scope]);

  return {
    resolutions: input.enabled && snapshot?.scope === scope
      ? snapshot.resolutions
      : new Map<string, MenuReferenceResolution>(),
    failed: input.enabled && snapshot?.scope === scope && snapshot.failed,
    retry: () => setAttempt((value) => value + 1),
  };
}
