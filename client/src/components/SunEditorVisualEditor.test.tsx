// @vitest-environment jsdom
import { StrictMode, createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeLocale } from '../i18n';
import { SunEditorVisualEditor, type SunEditorVisualEditorHandle } from './SunEditorVisualEditor';

afterEach(cleanup);
beforeEach(async () => { await changeLocale('en'); });

function setup(content = '<p>Before selected after</p>', strict = false) {
  const ref = createRef<SunEditorVisualEditorHandle>();
  const onChange = vi.fn();
  const onDirty = vi.fn();
  const editor = <SunEditorVisualEditor ref={ref} content={content} onChange={onChange}
    onDirty={onDirty} onRequestMedia={vi.fn()} />;
  const view = render(strict ? <StrictMode>{editor}</StrictMode> : editor);
  return { ...view, ref, onChange, onDirty, surface: screen.getByRole('textbox', { name: 'Content' }) };
}

describe('SunEditor integration', () => {
  it('survives Strict Mode remounts and leaves authored HTML unchanged until editing', async () => {
    const authored = '<p class="kept">Original  <strong>HTML</strong></p>';
    const { ref, onChange, onDirty, surface } = setup(authored, true);
    await waitFor(() => expect(surface).toHaveTextContent('Original HTML'));
    expect(ref.current!.flush()).toBe(authored);
    expect(onChange).not.toHaveBeenCalled();
    expect(onDirty).not.toHaveBeenCalled();
    surface.innerHTML = '<p>Actual edit</p>';
    fireEvent.input(surface);
    expect(onDirty).toHaveBeenCalledOnce();
    expect(ref.current!.flush()).toBe('<p>Actual edit</p>');
  });

  it('preserves pending input when the editor language changes', async () => {
    const { surface, ref, onChange, container } = setup('<p>Original</p>');
    surface.innerHTML = '<p>아직 저장하지 않은 글 🌱</p>';
    fireEvent.input(surface);
    await act(async () => { await changeLocale('ko'); });
    expect(ref.current!.flush()).toBe('<p>아직 저장하지 않은 글 🌱</p>');
    expect(onChange).toHaveBeenCalledWith('<p>아직 저장하지 않은 글 🌱</p>');
    expect(container.querySelector('.studio-visual-editor-surface')).toHaveTextContent('아직 저장하지 않은 글 🌱');
  });

  it('builds an AI candidate from a DOM selection without mutating the document and rejects a stale selection', () => {
    const { surface, ref, onChange } = setup();
    const text = surface.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 7);
    range.setEnd(text, 15);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    fireEvent(document, new Event('selectionchange'));
    const selection = ref.current!.captureAiSelection()!;
    expect(selection.selectedContent).toBe('selected');
    expect(ref.current!.buildAiCandidate(selection, '<updated>')).toBe('<p>Before &lt;updated&gt; after</p>');
    expect(surface).toHaveTextContent('Before selected after');
    expect(onChange).not.toHaveBeenCalled();
    surface.querySelector('p')!.append(' changed');
    fireEvent.input(surface);
    expect(ref.current!.buildAiCandidate(selection, 'replacement')).toBeNull();
  });

  it('marks toolbar DOM edits dirty before the delayed editor change event', async () => {
    const { surface, onDirty, ref } = setup('<p>Selected text</p>');
    surface.querySelector('p')!.innerHTML = '<strong>Selected text</strong>';
    await waitFor(() => expect(onDirty).toHaveBeenCalledOnce());
    expect(ref.current!.flush()).toBe('<p><strong>Selected text</strong></p>');
  });

  it('handles pasted HTML once, sanitizes active markup, and keeps embedded players inert', () => {
    const { surface, ref } = setup('<p>Start</p>');
    const range = document.createRange();
    range.selectNodeContents(surface.querySelector('p')!);
    range.collapse(false);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    const pasted = '<p>Unique pasted text<script>attack()</script><a href="javascript:attack()">link</a></p>'
      + '<iframe src="https://player.example/video" title="Video"></iframe>';
    fireEvent.paste(surface, { clipboardData: { getData: (type: string) => type === 'text/html' ? pasted : '' } });
    const saved = ref.current!.flush();
    expect(saved.match(/Unique pasted text/gu)).toHaveLength(1);
    expect(saved).toContain('<iframe src="https://player.example/video" title="Video"></iframe>');
    expect(saved).not.toMatch(/attack\(|javascript:|<script/u);
    expect(surface.querySelector('iframe')).toBeNull();
    expect(surface.querySelector('[data-studio-embed]')).toHaveTextContent('IFRAME');
  });
});
