// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  INITIAL_CHECKING_MIN_VISIBLE_MS,
  InitialCheckingProvider,
  useInitialCheckingPhase,
} from './InitialCheckingGate';

function CheckingPhase(input: { pending: boolean; immediate?: boolean }) {
  const phase = useInitialCheckingPhase(input.pending, input.immediate);
  return <p>{phase}</p>;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useInitialCheckingPhase', () => {
  it('keeps every user-initiated check visible for at least 1,000ms', async () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <InitialCheckingProvider>
        <CheckingPhase pending={false} immediate />
      </InitialCheckingProvider>,
    );

    expect(screen.getByText('resolved')).toBeInTheDocument();

    rerender(
      <InitialCheckingProvider>
        <CheckingPhase pending immediate />
      </InitialCheckingProvider>,
    );
    expect(screen.getByText('checking')).toBeInTheDocument();

    rerender(
      <InitialCheckingProvider>
        <CheckingPhase pending={false} immediate />
      </InitialCheckingProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INITIAL_CHECKING_MIN_VISIBLE_MS - 1);
    });
    expect(screen.getByText('checking')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText('resolved')).toBeInTheDocument();

    rerender(
      <InitialCheckingProvider>
        <CheckingPhase pending immediate />
      </InitialCheckingProvider>,
    );
    expect(screen.getByText('checking')).toBeInTheDocument();

    rerender(
      <InitialCheckingProvider>
        <CheckingPhase pending={false} immediate />
      </InitialCheckingProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INITIAL_CHECKING_MIN_VISIBLE_MS - 1);
    });
    expect(screen.getByText('checking')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(screen.getByText('resolved')).toBeInTheDocument();
  });
});
