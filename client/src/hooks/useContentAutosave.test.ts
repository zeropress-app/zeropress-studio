// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useContentAutosave } from './useContentAutosave';

afterEach(() => {
  vi.useRealTimers();
});

describe('useContentAutosave', () => {
  it('debounces writes and enforces the minimum successful write interval', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-04T00:00:00.000Z') });
    const persist = vi.fn().mockImplementation(async () => ({
      kind: 'saved' as const,
      updatedAtIso: new Date().toISOString(),
    }));
    const { result, rerender } = renderHook(
      ({ snapshot }) => useContentAutosave({
        active: true,
        snapshot,
        persist,
      }),
      { initialProps: { snapshot: { title: 'First' } } },
    );
    expect(result.current.status).toBe('waiting');
    await act(async () => vi.advanceTimersByTimeAsync(14_999));
    expect(persist).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(persist).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('saved');

    rerender({ snapshot: { title: 'Second' } });
    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(persist).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it('cancels pending autosave before a canonical save', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-04T00:00:00.000Z') });
    const persist = vi.fn();
    const { result } = renderHook(() => useContentAutosave({
      active: true,
      snapshot: { title: 'Draft' },
      persist,
    }));
    await act(async () => result.current.prepareForCanonicalSave());
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(persist).not.toHaveBeenCalled();
  });

  it('persists within the maximum wait while typing continues', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-04T00:00:00.000Z') });
    const persist = vi.fn().mockResolvedValue({
      kind: 'saved' as const,
      updatedAtIso: '2026-08-04T00:01:00.000Z',
    });
    const { rerender } = renderHook(
      ({ title }) => useContentAutosave({
        active: true,
        snapshot: { title },
        persist,
      }),
      { initialProps: { title: '0' } },
    );
    for (let index = 1; index <= 5; index += 1) {
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      rerender({ title: String(index) });
    }
    expect(persist).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(9_999));
    expect(persist).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith({ title: '5' }, 'scheduled');
  });

  it('flushes the latest snapshot immediately and reports durability', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-04T00:00:00.000Z') });
    const persist = vi.fn().mockResolvedValue({
      kind: 'saved' as const,
      updatedAtIso: '2026-08-04T00:00:01.000Z',
    });
    const { result } = renderHook(() => useContentAutosave({
      active: true,
      snapshot: { title: 'Draft' },
      persist,
    }));
    expect(result.current.hasUnpersistedChanges).toBe(true);
    await act(async () => {
      expect(await result.current.flushNow()).toBe(true);
    });
    expect(persist).toHaveBeenCalledWith({ title: 'Draft' }, 'flush');
    expect(result.current.hasUnpersistedChanges).toBe(false);
    expect(result.current.durability).toBe('recoverable');
  });

  it('blocks a flush when the server cannot store the latest snapshot', async () => {
    const { result } = renderHook(() => useContentAutosave({
      active: true,
      snapshot: { title: 'Draft' },
      persist: vi.fn().mockResolvedValue({ kind: 'failed' as const }),
    }));
    await act(async () => {
      expect(await result.current.flushNow()).toBe(false);
    });
    expect(result.current.hasUnpersistedChanges).toBe(true);
    expect(result.current.durability).toBe('failed');
  });

  it('pauses automatic writes after a revision conflict', async () => {
    vi.useFakeTimers({ now: new Date('2026-08-04T00:00:00.000Z') });
    const persist = vi.fn().mockResolvedValue({ kind: 'conflict' as const });
    const { result } = renderHook(() => useContentAutosave({
      active: true,
      snapshot: { title: 'Stale draft' },
      persist,
    }));
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(result.current.durability).toBe('conflict');
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(persist).toHaveBeenCalledTimes(1);
    await act(async () => {
      expect(await result.current.flushNow()).toBe(false);
    });
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('clears persisted state when an autosave is deliberately discarded', async () => {
    const { result } = renderHook(() => useContentAutosave({
      active: false,
      snapshot: { title: 'Draft' },
      persistedSnapshotKey: JSON.stringify({ title: 'Draft' }),
      persist: vi.fn(),
    }));
    expect(result.current.hasPersistedAutosave).toBe(true);

    act(() => result.current.markAutosaveDiscarded());

    expect(result.current.hasPersistedAutosave).toBe(false);
    expect(result.current.status).toBe('idle');
  });
});
