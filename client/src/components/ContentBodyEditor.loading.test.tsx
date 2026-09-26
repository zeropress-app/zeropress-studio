// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeLocale } from '../i18n';
import { ContentBodyEditor } from './ContentBodyEditor';

const loading = vi.hoisted(() => ({ attempts: 0 }));
vi.mock('react', async (original) => {
  const React = await original<typeof import('react')>();
  return {
    ...React,
    lazy: (load: Parameters<typeof React.lazy>[0]) => React.lazy(async () => {
      // Reject the loader promise, which React.lazy caches separately from render errors.
      if (++loading.attempts === 1) throw new Error('Synthetic editor download failure');
      return load();
    }),
  };
});
vi.mock('./SunEditorVisualEditor', () => ({
  SunEditorVisualEditor: (input: { content: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Loaded editor" value={input.content}
      onChange={(event) => input.onChange(event.target.value)} />
  ),
}));
vi.mock('./MonacoSourceEditor', () => ({
  MonacoSourceEditor: (input: { value: string; onChange: (value: string) => void }) => (
    <textarea aria-label="Loaded editor" value={input.value}
      onChange={(event) => input.onChange(event.target.value)} />
  ),
}));

beforeEach(async () => {
  loading.attempts = 0;
  await changeLocale('en');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('Content editor module recovery', () => {
  it.each(['source', 'visual'] as const)('retries a failed %s download and keeps the current draft', async (mode) => {
    const onEditorStateChange = vi.fn();
    function Editor() {
      const [value, setValue] = useState('<p>Preserved draft</p>');
      return <ContentBodyEditor
        value={value} documentType="html" editorMode={mode}
        editorProfile={mode === 'visual' ? 'suneditor-v1' : null}
        maximumLength={2_000_000} canonicalEditorState={null}
        canonicalEditorContextClean={false} onChange={setValue}
        onDirty={vi.fn()} onEditorStateChange={onEditorStateChange}
        onRequestMedia={vi.fn()}
      />;
    }
    render(<Editor />);
    const user = userEvent.setup();
    await screen.findByText(`The ${mode === 'source' ? 'source' : 'visual'} editor could not load`);
    expect(loading.attempts).toBe(1);
    if (mode === 'source') {
      await user.type(screen.getByRole('textbox', { name: 'Content' }), ' edited in fallback');
    }
    await user.click(screen.getByRole('button', {
      name: mode === 'source' ? 'Retry source editor' : 'Retry',
    }));
    const editor = await screen.findByRole('textbox', { name: 'Loaded editor' });
    expect(editor).toHaveValue(mode === 'source'
      ? '<p>Preserved draft</p> edited in fallback'
      : '<p>Preserved draft</p>');
    await user.type(editor, ' after retry');
    expect((editor as HTMLTextAreaElement).value).toContain(' after retry');
    expect(loading.attempts).toBe(2);
    expect(onEditorStateChange).not.toHaveBeenCalled();
  });
});
