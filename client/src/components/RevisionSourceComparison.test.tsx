// @vitest-environment jsdom

import { useEffect } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RevisionSourceComparison } from './RevisionSourceComparison';

const monacoState = vi.hoisted(() => ({ unavailable: false }));

vi.mock('./MonacoRevisionDiff', () => ({
  MonacoRevisionDiff: (input: {
    comparisonLabel: string;
    onUnavailable: () => void;
  }) => {
    useEffect(() => {
      if (monacoState.unavailable) input.onUnavailable();
    }, [input.onUnavailable]);
    return <div role="region" aria-label={input.comparisonLabel} />;
  },
}));

const copy = {
  diffLabel: 'Post revision source comparison',
  diffLoading: 'Loading source comparison.',
  diffUnavailable: 'Visual comparison unavailable.',
  diffRetry: 'Retry visual comparison',
  leftSource: 'Revision A source',
  rightSource: 'Revision B source',
};

afterEach(() => {
  cleanup();
  monacoState.unavailable = false;
});

describe('RevisionSourceComparison', () => {
  it('falls back to complete read-only sources and allows a local retry', async () => {
    monacoState.unavailable = true;
    const user = userEvent.setup();
    render(<RevisionSourceComparison
      copy={copy}
      original="# Saved"
      modified="# Current"
      originalDocumentType="markdown"
      modifiedDocumentType="markdown"
      originalEditorMode="source"
      modifiedEditorMode="source"
      originalEditorProfile={null}
      modifiedEditorProfile={null}
    />);

    expect(await screen.findByText('Visual comparison unavailable.'))
      .toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Revision A source' }))
      .toHaveValue('# Saved');
    expect(screen.getByRole('textbox', { name: 'Revision B source' }))
      .toHaveValue('# Current');

    monacoState.unavailable = false;
    await user.click(screen.getByRole('button', {
      name: 'Retry visual comparison',
    }));
    expect(await screen.findByRole('region', {
      name: 'Post revision source comparison',
    })).toBeInTheDocument();
  });
});
