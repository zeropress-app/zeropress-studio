// @vitest-environment jsdom
import { StrictMode, createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTENT_EDITOR_VISUAL_MAX_CODE_UNITS, CONTENT_EDITOR_VISUAL_MAX_NODES } from '../../../contracts/content-editor';
import { changeLocale } from '../i18n';
import { SunEditorVisualEditor, type SunEditorVisualEditorHandle } from './SunEditorVisualEditor';

// Test rejection and undo history with small documents. Compatibility tests
// exercise the real production limits without mounting the full editor UI.
vi.mock('../../../contracts/content-editor', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../contracts/content-editor')>(),
  CONTENT_EDITOR_VISUAL_MAX_CODE_UNITS: 512,
  CONTENT_EDITOR_VISUAL_MAX_NODES: 20,
}));

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

const imageMedia = {
  id: '1'.repeat(32), kind: 'image' as const, filename: 'sample.png', mime_type: 'image/png',
  location: { type: 'r2' as const, key: 'sample.png' }, size_bytes: 10,
  width: 30, height: 20, duration_ms: null, alt: 'Sample image', collection: null,
  usage: { posts: 0, pages: 0, authors: 0, branding: 0 }, revision: '2'.repeat(32),
  created_at_iso: '2026-09-26T00:00:00.000Z', updated_at_iso: '2026-09-26T00:00:00.000Z',
};

describe('visual Media insertion', () => {
  it('inserts once, returns success, and supports undo and redo', async () => {
    const { ref, surface, onChange } = setup('<p>Before</p>');
    const undo = await screen.findByLabelText('Undo', { selector: 'button' });
    const redo = screen.getByLabelText('Redo', { selector: 'button' });
    expect(undo).toBeVisible();
    expect(redo).toBeVisible();
    act(() => {
      expect(ref.current!.insertMedia(imageMedia)).toEqual({ ok: true });
    });
    expect(surface.querySelectorAll('img')).toHaveLength(1);
    expect(onChange).toHaveBeenCalledWith(expect.stringContaining('alt="Sample image"'));
    expect(undo).toBeEnabled();
    fireEvent.click(undo);
    expect(ref.current!.flush()).toBe('<p>Before</p>');
    expect(redo).toBeEnabled();
    fireEvent.click(redo);
    expect(surface.querySelectorAll('img')).toHaveLength(1);
  });

  it('accepts replacing a selected image with the same Media', () => {
    const { ref, surface } = setup('<p>Before</p>');
    act(() => { ref.current!.insertMedia(imageMedia); });
    fireEvent.click(surface.querySelector('img')!);
    act(() => {
      expect(ref.current!.replaceSelectedImage(imageMedia)).toEqual({ ok: true });
    });
    expect(surface.querySelectorAll('img')).toHaveLength(1);
  });

  it.each([
    `<p>${'x'.repeat(CONTENT_EDITOR_VISUAL_MAX_CODE_UNITS - 12)}</p>`,
    '<p>x</p>'.repeat((CONTENT_EDITOR_VISUAL_MAX_NODES - 2) / 2),
  ])('rejects Media that exceeds a visual limit and preserves accepted content', async (content) => {
    const { ref, surface, onChange } = setup(content);
    const redo = await screen.findByLabelText('Redo', { selector: 'button' });
    expect(redo).toBeVisible();
    const before = ref.current!.flush();
    act(() => {
      expect(ref.current!.insertMedia(imageMedia)).toEqual({ ok: false, reason: 'visual_limit' });
    });
    expect(ref.current!.flush()).toBe(before);
    expect(surface.querySelectorAll('img')).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
    expect(redo).toBeDisabled();
  });
});
