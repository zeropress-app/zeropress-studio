// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MonacoSourceEditor,
  type MonacoSourceEditorHandle,
} from './MonacoSourceEditor';

const runtime = vi.hoisted(() => ({
  create: vi.fn(),
  dispose: vi.fn(),
  focus: vi.fn(),
  getValue: vi.fn(),
  getSelectionRange: vi.fn(),
  insertText: vi.fn(),
  setDisabled: vi.fn(),
  setDocumentType: vi.fn(),
  setMaximumLength: vi.fn(),
  setValue: vi.fn(),
}));

vi.mock('../editor/monaco-source-editor', () => ({
  createMonacoSourceEditor: runtime.create,
}));

beforeEach(() => {
  for (const callback of Object.values(runtime)) callback.mockReset();
  runtime.getValue.mockReturnValue('<p>Hello</p>');
  runtime.insertText.mockReturnValue(true);
  runtime.create.mockReturnValue({
    dispose: runtime.dispose,
    focus: runtime.focus,
    getValue: runtime.getValue,
    getSelectionRange: runtime.getSelectionRange,
    insertText: runtime.insertText,
    setDisabled: runtime.setDisabled,
    setDocumentType: runtime.setDocumentType,
    setMaximumLength: runtime.setMaximumLength,
    setValue: runtime.setValue,
  });
});

afterEach(cleanup);

describe('MonacoSourceEditor', () => {
  it('owns an editable model, synchronizes external state, and disposes it', () => {
    const ref = createRef<MonacoSourceEditorHandle>();
    const onChange = vi.fn();
    const onLimitExceeded = vi.fn();
    const view = render(<MonacoSourceEditor
      ref={ref}
      id="content-source"
      describedBy="content-help"
      value="<p>Hello</p>"
      documentType="html"
      maximumLength={2_000_000}
      disabled={false}
      label="Content"
      onChange={onChange}
      onLimitExceeded={onLimitExceeded}
      onUnavailable={vi.fn()}
    />);

    expect(view.getByRole('group', { name: 'Content' })).toHaveAttribute(
      'aria-describedby',
      'content-help',
    );
    expect(runtime.create).toHaveBeenCalledOnce();
    expect(runtime.create).toHaveBeenCalledWith(expect.objectContaining({
      value: '<p>Hello</p>',
      documentType: 'html',
      maximumLength: 2_000_000,
      disabled: false,
      ariaLabel: 'Content',
    }));
    const callbacks = runtime.create.mock.calls[0]?.[0];
    callbacks.onChange('<p>Changed</p>');
    callbacks.onLimitExceeded();
    expect(onChange).toHaveBeenCalledWith('<p>Changed</p>');
    expect(onLimitExceeded).toHaveBeenCalledOnce();

    view.rerender(<MonacoSourceEditor
      ref={ref}
      id="content-source"
      value="# Changed"
      documentType="markdown"
      maximumLength={1_000}
      disabled
      label="Content"
      onChange={onChange}
      onLimitExceeded={onLimitExceeded}
      onUnavailable={vi.fn()}
    />);
    expect(runtime.setValue).toHaveBeenLastCalledWith('# Changed');
    expect(runtime.setDocumentType).toHaveBeenLastCalledWith('markdown');
    expect(runtime.setMaximumLength).toHaveBeenLastCalledWith(1_000);
    expect(runtime.setDisabled).toHaveBeenLastCalledWith(true);

    act(() => ref.current?.focus());
    expect(runtime.focus).toHaveBeenCalledOnce();
    expect(ref.current?.flush()).toBe('<p>Hello</p>');
    runtime.getSelectionRange.mockReturnValue({ start: 3, end: 8 });
    expect(ref.current?.getSelectionRange()).toEqual({ start: 3, end: 8 });
    expect(ref.current?.insertText(' media ')).toBe(true);
    expect(runtime.insertText).toHaveBeenCalledWith(' media ');

    view.unmount();
    expect(runtime.dispose).toHaveBeenCalledOnce();
  });

  it('reports a synchronous Monaco startup failure without changing content', () => {
    runtime.create.mockImplementation(() => {
      throw new Error('Worker unavailable');
    });
    const onUnavailable = vi.fn();

    expect(() => render(<MonacoSourceEditor
      id="content-source"
      value="Exact source"
      documentType="plaintext"
      maximumLength={2_000_000}
      disabled={false}
      label="Content"
      onChange={vi.fn()}
      onLimitExceeded={vi.fn()}
      onUnavailable={onUnavailable}
    />)).not.toThrow();
    expect(onUnavailable).toHaveBeenCalledOnce();
  });
});
