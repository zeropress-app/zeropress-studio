// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MonacoProposalDiff } from './MonacoProposalDiff';

const runtime = vi.hoisted(() => ({
  create: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('../editor/monaco-proposal-diff', () => ({
  createMonacoProposalDiff: runtime.create,
}));

beforeEach(() => {
  runtime.create.mockReset();
  runtime.dispose.mockReset();
  runtime.create.mockReturnValue({ dispose: runtime.dispose });
});

afterEach(cleanup);

describe('MonacoProposalDiff', () => {
  it('keeps the original immutable contract and recreates a reset proposal', () => {
    const onChange = vi.fn();
    const view = render(<MonacoProposalDiff
      original="Original"
      initialModified="Proposal one"
      documentType="plaintext"
      originalLabel="Current body"
      modifiedLabel="Reviewed proposal"
      comparisonLabel="AI edit comparison"
      resetEpoch={0}
      onChange={onChange}
      onUnavailable={vi.fn()}
    />);
    expect(view.getByRole('region', { name: 'AI edit comparison' }))
      .toBeInTheDocument();
    expect(runtime.create).toHaveBeenCalledWith(expect.objectContaining({
      original: 'Original',
      modified: 'Proposal one',
      originalLabel: 'Current body',
      modifiedLabel: 'Reviewed proposal',
      onChange: expect.any(Function),
    }));
    runtime.create.mock.calls[0]?.[0].onChange('Partially reviewed');
    expect(onChange).toHaveBeenCalledWith('Partially reviewed');

    view.rerender(<MonacoProposalDiff
      original="Original"
      initialModified="Proposal two"
      documentType="plaintext"
      originalLabel="Current body"
      modifiedLabel="Reviewed proposal"
      comparisonLabel="AI edit comparison"
      resetEpoch={1}
      onChange={onChange}
      onUnavailable={vi.fn()}
    />);
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(runtime.create).toHaveBeenLastCalledWith(expect.objectContaining({
      modified: 'Proposal two',
    }));
  });

  it('reports startup failure so the complete editable fallback can be shown', () => {
    runtime.create.mockImplementation(() => {
      throw new Error('Monaco unavailable');
    });
    const onUnavailable = vi.fn();
    expect(() => render(<MonacoProposalDiff
      original="Original"
      initialModified="Proposal"
      documentType="plaintext"
      originalLabel="Current body"
      modifiedLabel="Reviewed proposal"
      comparisonLabel="AI edit comparison"
      resetEpoch={0}
      onChange={vi.fn()}
      onUnavailable={onUnavailable}
    />)).not.toThrow();
    expect(onUnavailable).toHaveBeenCalledOnce();
  });
});
