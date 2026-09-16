// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MonacoRevisionDiff } from './MonacoRevisionDiff';

const runtime = vi.hoisted(() => ({
  create: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('../editor/monaco-revision-diff', () => ({
  createMonacoRevisionDiff: runtime.create,
}));

beforeEach(() => {
  runtime.create.mockReset();
  runtime.dispose.mockReset();
  runtime.create.mockReturnValue({ dispose: runtime.dispose });
});

afterEach(cleanup);

describe('MonacoRevisionDiff', () => {
  it('creates a labelled read-only revision model and disposes it', () => {
    const onUnavailable = vi.fn();
    const view = render(<MonacoRevisionDiff
      original="# Saved"
      modified="<p>Current</p>"
      originalDocumentType="markdown"
      modifiedDocumentType="html"
      originalEditorMode="source"
      modifiedEditorMode="source"
      originalEditorProfile={null}
      modifiedEditorProfile={null}
      originalLabel="Revision A source"
      modifiedLabel="Revision B source"
      comparisonLabel="Post revision source comparison"
      onUnavailable={onUnavailable}
    />);

    expect(view.getByRole('region', {
      name: 'Post revision source comparison',
    })).toBeInTheDocument();
    expect(runtime.create).toHaveBeenCalledOnce();
    expect(runtime.create).toHaveBeenCalledWith(expect.objectContaining({
      original: '# Saved',
      modified: '<p>Current</p>',
      originalDocumentType: 'markdown',
      modifiedDocumentType: 'html',
      originalLabel: 'Revision A source',
      modifiedLabel: 'Revision B source',
    }));
    const createInput = runtime.create.mock.calls[0]?.[0];
    expect(createInput.container).toBeInstanceOf(HTMLDivElement);
    createInput.onComputationUnavailable();
    expect(onUnavailable).toHaveBeenCalledOnce();

    view.unmount();
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it('reports a synchronous Monaco startup failure without throwing', () => {
    runtime.create.mockImplementation(() => {
      throw new Error('Worker unavailable');
    });
    const onUnavailable = vi.fn();

    expect(() => render(<MonacoRevisionDiff
      original="Saved"
      modified="Current"
      originalDocumentType="plaintext"
      modifiedDocumentType="plaintext"
      originalEditorMode="source"
      modifiedEditorMode="source"
      originalEditorProfile={null}
      modifiedEditorProfile={null}
      originalLabel="Revision A source"
      modifiedLabel="Revision B source"
      comparisonLabel="Page revision source comparison"
      onUnavailable={onUnavailable}
    />)).not.toThrow();
    expect(onUnavailable).toHaveBeenCalledOnce();
  });

  it('projects two visual Tiptap HTML revisions before creating Monaco models', () => {
    render(<MonacoRevisionDiff
      original="<p>Saved</p><p>Same</p>"
      modified="<p>Current</p><p>Same</p>"
      originalDocumentType="html"
      modifiedDocumentType="html"
      originalEditorMode="visual"
      modifiedEditorMode="visual"
      originalEditorProfile="tiptap-v1"
      modifiedEditorProfile="tiptap-v1"
      originalLabel="Revision A source"
      modifiedLabel="Revision B source"
      comparisonLabel="Post revision source comparison"
      onUnavailable={vi.fn()}
    />);

    expect(runtime.create).toHaveBeenCalledWith(expect.objectContaining({
      original: '<p>Saved</p>\n<p>Same</p>\n',
      modified: '<p>Current</p>\n<p>Same</p>\n',
    }));
  });
});
