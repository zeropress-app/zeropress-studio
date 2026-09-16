import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CONTENT_AUTOSAVE_DEBOUNCE_MS,
  CONTENT_AUTOSAVE_MAX_WAIT_MS,
  CONTENT_AUTOSAVE_MIN_WRITE_INTERVAL_MS,
} from '../../../contracts/content-snapshots';

export type ContentAutosaveStatus =
  | 'idle'
  | 'waiting'
  | 'saving'
  | 'saved'
  | 'failed'
  | 'conflict';

export type ContentAutosavePersistReason = 'scheduled' | 'flush';

export type ContentAutosavePersistResult =
  | { kind: 'saved'; updatedAtIso: string }
  | { kind: 'session_ended' | 'conflict' | 'failed' };

export type ContentAutosaveDurability =
  | 'clean'
  | 'recoverable'
  | 'waiting'
  | 'saving'
  | 'invalid'
  | 'failed'
  | 'conflict';

export function createContentDraftId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

export function useContentAutosave<TSnapshot>(input: {
  active: boolean;
  snapshot: TSnapshot | null;
  externalSnapshotDirty?: boolean;
  prepareSnapshot?: () => TSnapshot | null;
  persistedSnapshotKey?: string;
  persist: (
    snapshot: TSnapshot,
    reason: ContentAutosavePersistReason,
  ) => Promise<ContentAutosavePersistResult>;
}) {
  const [status, setStatus] = useState<ContentAutosaveStatus>('idle');
  const [lastSavedAtIso, setLastSavedAtIso] = useState<string | null>(null);
  const [hasPersistedAutosave, setHasPersistedAutosave] = useState(
    Boolean(input.persistedSnapshotKey),
  );
  const [epoch, setEpoch] = useState(0);
  const timerRef = useRef<number | null>(null);
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const pausedRef = useRef(false);
  const conflictRef = useRef(false);
  const activeRef = useRef(input.active);
  activeRef.current = input.active;
  const lastSuccessAtRef = useRef(0);
  const dirtySinceRef = useRef<number | null>(null);
  const lastPersistedKeyRef = useRef(input.persistedSnapshotKey ?? '');
  const persistRef = useRef(input.persist);
  persistRef.current = input.persist;
  const prepareSnapshotRef = useRef(input.prepareSnapshot);
  prepareSnapshotRef.current = input.prepareSnapshot;
  const externalSnapshotDirtyRef = useRef(Boolean(input.externalSnapshotDirty));
  externalSnapshotDirtyRef.current = Boolean(input.externalSnapshotDirty);
  const snapshotRef = useRef(input.snapshot);
  snapshotRef.current = input.snapshot;
  const snapshotKey = input.snapshot === null
    ? ''
    : JSON.stringify(input.snapshot);
  const snapshotKeyRef = useRef(snapshotKey);
  snapshotKeyRef.current = snapshotKey;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const persistLatest = useCallback(async (
    reason: ContentAutosavePersistReason,
  ): Promise<boolean> => {
    if (pausedRef.current || conflictRef.current) return false;
    if (inFlightRef.current) {
      await inFlightRef.current;
      if (
        !externalSnapshotDirtyRef.current
        && snapshotKeyRef.current === lastPersistedKeyRef.current
      ) return true;
    }
    const preparedSnapshot = prepareSnapshotRef.current?.();
    const currentSnapshot = preparedSnapshot === undefined
      ? snapshotRef.current
      : preparedSnapshot;
    if (currentSnapshot === null) {
      setStatus('failed');
      return false;
    }
    const key = JSON.stringify(currentSnapshot);
    snapshotRef.current = currentSnapshot;
    snapshotKeyRef.current = key;
    if (key === lastPersistedKeyRef.current) return true;

    setStatus('saving');
    const operation = persistRef.current(currentSnapshot, reason)
      .then((result) => {
        if (result.kind === 'saved') {
          lastPersistedKeyRef.current = key;
          lastSuccessAtRef.current = Date.now();
          setLastSavedAtIso(result.updatedAtIso);
          setHasPersistedAutosave(true);
          setStatus('saved');
          return true;
        }
        if (result.kind === 'conflict') {
          conflictRef.current = true;
          setStatus('conflict');
        } else setStatus('failed');
        return false;
      })
      .catch(() => {
        setStatus('failed');
        return false;
      })
      .finally(() => {
        inFlightRef.current = null;
        setEpoch((value) => value + 1);
      });
    inFlightRef.current = operation;
    return await operation;
  }, []);

  useEffect(() => {
    if (input.persistedSnapshotKey === undefined) return;
    lastPersistedKeyRef.current = input.persistedSnapshotKey;
    conflictRef.current = false;
    setHasPersistedAutosave(input.persistedSnapshotKey !== '');
    if (
      snapshotKeyRef.current === input.persistedSnapshotKey
      && activeRef.current
    ) {
      setStatus('saved');
      dirtySinceRef.current = null;
    }
  }, [input.persistedSnapshotKey]);

  useEffect(() => {
    clearTimer();
    if (!input.active || pausedRef.current) {
      dirtySinceRef.current = null;
      if (!input.active) {
        conflictRef.current = false;
        setStatus('idle');
      }
      return;
    }
    if (input.snapshot === null) {
      dirtySinceRef.current ??= Date.now();
      setStatus('failed');
      return;
    }
    if (conflictRef.current) {
      setStatus('conflict');
      return;
    }
    if (
      !input.externalSnapshotDirty
      && snapshotKey === lastPersistedKeyRef.current
    ) {
      dirtySinceRef.current = null;
      setStatus('saved');
      return;
    }

    const now = Date.now();
    dirtySinceRef.current ??= now;
    setStatus((current) => (
      current === 'failed' || current === 'conflict' ? current : 'waiting'
    ));
    const idleDueAt = now + CONTENT_AUTOSAVE_DEBOUNCE_MS;
    const maximumDueAt = dirtySinceRef.current + CONTENT_AUTOSAVE_MAX_WAIT_MS;
    const minimumDueAt = lastSuccessAtRef.current
      + CONTENT_AUTOSAVE_MIN_WRITE_INTERVAL_MS;
    const dueAt = Math.max(minimumDueAt, Math.min(idleDueAt, maximumDueAt));
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void persistLatest('scheduled');
    }, Math.max(0, dueAt - now));

    return clearTimer;
  }, [
    clearTimer,
    epoch,
    input.active,
    input.externalSnapshotDirty,
    input.snapshot,
    persistLatest,
    snapshotKey,
  ]);

  const flushNow = useCallback(async (): Promise<boolean> => {
    clearTimer();
    if (!activeRef.current) return true;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (snapshotRef.current === null) {
        setStatus('failed');
        return false;
      }
      if (
        !externalSnapshotDirtyRef.current
        && snapshotKeyRef.current === lastPersistedKeyRef.current
      ) return true;
      if (!await persistLatest('flush')) return false;
    }
    return snapshotKeyRef.current === lastPersistedKeyRef.current;
  }, [clearTimer, persistLatest]);

  const prepareForCanonicalSave = useCallback(async () => {
    pausedRef.current = true;
    clearTimer();
    await inFlightRef.current;
  }, [clearTimer]);

  const resumeAfterCanonicalFailure = useCallback(() => {
    pausedRef.current = false;
    conflictRef.current = false;
    dirtySinceRef.current ??= Date.now();
    setEpoch((value) => value + 1);
  }, []);

  const markCanonicalSaveCompleted = useCallback(() => {
    pausedRef.current = false;
    conflictRef.current = false;
    clearTimer();
    lastPersistedKeyRef.current = '';
    dirtySinceRef.current = null;
    setStatus('idle');
    setLastSavedAtIso(null);
    setHasPersistedAutosave(false);
    setEpoch((value) => value + 1);
  }, [clearTimer]);

  const markAutosaveDiscarded = useCallback(() => {
    pausedRef.current = false;
    conflictRef.current = false;
    clearTimer();
    lastPersistedKeyRef.current = '';
    dirtySinceRef.current = null;
    setHasPersistedAutosave(false);
    setLastSavedAtIso(null);
    setStatus('idle');
    setEpoch((value) => value + 1);
  }, [clearTimer]);

  const hasUnpersistedChanges = input.active
    && (
      Boolean(input.externalSnapshotDirty)
      || input.snapshot === null
      || snapshotKey !== lastPersistedKeyRef.current
    );
  const durability: ContentAutosaveDurability = !input.active
    ? 'clean'
    : input.snapshot === null
      ? 'invalid'
      : !hasUnpersistedChanges
        ? 'recoverable'
        : status === 'saving'
          ? 'saving'
          : status === 'failed'
            ? 'failed'
            : status === 'conflict'
              ? 'conflict'
              : 'waiting';

  return {
    status,
    durability,
    lastSavedAtIso,
    hasPersistedAutosave,
    hasUnpersistedChanges,
    flushNow,
    prepareForCanonicalSave,
    resumeAfterCanonicalFailure,
    markCanonicalSaveCompleted,
    markAutosaveDiscarded,
  };
}
