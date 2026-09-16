// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changeLocale } from '../i18n';
import { CONTENT_EDITOR_VISUAL_MAX_CODE_UNITS } from '../../../contracts/content-editor';
import { classifyTiptapHtml } from '../editor/tiptap-compatibility';
import { ContentBodyEditor } from './ContentBodyEditor';
import type { ContentBodyEditorHandle } from './ContentBodyEditor';

vi.mock('./RevisionSourceComparison', () => ({
  RevisionSourceComparison: (input: { original: string; modified: string }) => (
    <div data-testid="normalization-diff">
      <span>{input.original}</span>
      <span>{input.modified}</span>
    </div>
  ),
}));

vi.mock('./MonacoSourceEditor', async () => {
  const module = await import('../test/MockMonacoSourceEditor');
  return { MonacoSourceEditor: module.MockMonacoSourceEditor };
});

afterEach(cleanup);

beforeEach(async () => {
  await changeLocale('en');
});

function renderEditor(input: Partial<{
  value: string;
  editorMode: 'source' | 'visual';
  disabled: boolean;
  canonicalClean: boolean;
  canonicalEditorContextClean: boolean;
  canonicalEditorState: {
    content: string;
    editor_mode: 'source' | 'visual';
    editor_profile: 'tiptap-v1' | null;
  } | null;
  onChange: (value: string) => void;
  onDirty: () => void;
  onEditorStateChange: (state: {
    content: string;
    editor_mode: 'source' | 'visual';
    editor_profile: 'tiptap-v1' | null;
  }) => void;
}> = {}) {
  const onChange = input.onChange ?? vi.fn();
  const onDirty = input.onDirty ?? vi.fn();
  const onEditorStateChange = input.onEditorStateChange ?? vi.fn();
  render(
    <ContentBodyEditor
      value={input.value ?? '<p>Hello</p>'}
      documentType="html"
      editorMode={input.editorMode ?? 'source'}
      editorProfile={input.editorMode === 'visual' ? 'tiptap-v1' : null}
      maximumLength={2_000_000}
      disabled={input.disabled}
      canonicalClean={input.canonicalClean ?? true}
      canonicalEditorState={input.canonicalEditorState ?? {
        content: input.value ?? '<p>Hello</p>',
        editor_mode: input.editorMode ?? 'source',
        editor_profile: input.editorMode === 'visual' ? 'tiptap-v1' : null,
      }}
      canonicalEditorContextClean={input.canonicalEditorContextClean ?? true}
      onChange={onChange}
      onDirty={onDirty}
      onEditorStateChange={onEditorStateChange}
      onRequestMedia={vi.fn()}
    />,
  );
  return { onChange, onDirty, onEditorStateChange };
}

describe('ContentBodyEditor', () => {
  it('contains a long visual-editor token without changing authored HTML', async () => {
    const token = 'long-token-'.repeat(80);
    const callbacks = renderEditor({
      value: `<p><code>${token}</code></p>`,
      editorMode: 'visual',
    });
    const content = await screen.findByRole('textbox', { name: 'Content' });
    expect(content).toHaveTextContent(token);
    expect(content.parentElement).toHaveClass('tiptap-editor-content');
    expect(callbacks.onChange).not.toHaveBeenCalled();
    expect(callbacks.onDirty).not.toHaveBeenCalled();
  });

  it('captures and composes the exact selected source without changing the editor', async () => {
    const ref = createRef<ContentBodyEditorHandle>();
    const onChange = vi.fn();
    render(<ContentBodyEditor
      ref={ref}
      value="Before selected words after"
      documentType="plaintext"
      editorMode="source"
      editorProfile={null}
      maximumLength={2_000_000}
      canonicalClean
      canonicalEditorState={{
        content: 'Before selected words after',
        editor_mode: 'source',
        editor_profile: null,
      }}
      canonicalEditorContextClean
      onChange={onChange}
      onDirty={vi.fn()}
      onEditorStateChange={vi.fn()}
      onRequestMedia={vi.fn()}
    />);
    const source = await screen.findByRole('textbox', {
      name: 'Content',
    }) as HTMLTextAreaElement;
    source.setSelectionRange(7, 21);
    const selection = ref.current?.captureAiSelection();
    expect(selection).toMatchObject({
      kind: 'source',
      selectionKind: 'source',
      selectedContent: 'selected words',
      contextBefore: 'Before ',
      contextAfter: ' after',
      start: 7,
      end: 21,
    });
    expect(selection && ref.current?.buildAiCandidate(
      selection,
      'reviewed passage',
    )).toBe('Before reviewed passage after');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('loads visual HTML without making the canonical document dirty', async () => {
    const callbacks = renderEditor({ editorMode: 'visual' });

    expect(await screen.findByRole('textbox', { name: 'Content' }))
      .toHaveTextContent('Hello');
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    expect(callbacks.onDirty).not.toHaveBeenCalled();
    expect(callbacks.onChange).not.toHaveBeenCalled();
    expect(callbacks.onEditorStateChange).not.toHaveBeenCalled();
  });

  it('disables authored links without making read-only visual content inert', async () => {
    renderEditor({
      editorMode: 'visual',
      disabled: true,
      value: [
        '<p><a href="https://example.com/text" target="_blank">Text link</a></p>',
        '<a href="https://example.com/image"><img src="/photo.png" alt="Linked image"></a>',
      ].join(''),
    });

    const content = await screen.findByRole('textbox', { name: 'Content' });
    expect(content).toHaveAttribute('contenteditable', 'false');
    expect(content).toHaveAttribute('aria-readonly', 'true');

    const textLink = screen.getByRole('link', { name: 'Text link' });
    const imageLink = screen.getByRole('link', { name: 'Linked image' });
    for (const link of [textLink, imageLink]) {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);

      const auxiliaryClick = new MouseEvent('auxclick', {
        bubbles: true,
        button: 1,
        cancelable: true,
      });
      link.dispatchEvent(auxiliaryClick);
      expect(auxiliaryClick.defaultPrevented).toBe(true);

      link.focus();
      const enter = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Enter',
      });
      link.dispatchEvent(enter);
      expect(enter.defaultPrevented).toBe(true);
    }

    const contentClick = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
    });
    content.dispatchEvent(contentClick);
    expect(contentClick.defaultPrevented).toBe(false);
  });

  it('exposes paragraph alignment and text color controls in visual mode', async () => {
    const callbacks = renderEditor({
      editorMode: 'visual',
      value: '<p><span style="color: rgb(194, 65, 12)">Hello</span></p>',
    });

    await screen.findByRole('textbox', { name: 'Content' });
    expect(screen.getByRole('button', { name: 'Align left' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Align center' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Align right' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Justify' })).toBeEnabled();
    expect(screen.getByLabelText('Text color')).toHaveValue('#c2410c');

    fireEvent.click(screen.getByRole('button', { name: 'Align center' }));
    await waitFor(() => expect(callbacks.onDirty).toHaveBeenCalledTimes(1));
  });

  it('keeps WXR canonical whitespace and resource attributes clean on hydration', async () => {
    const source = [
      '<p> 이 문제를 설명합니다.</p>',
      '<img class="aligncenter wp-image-13269" alt="" width="627" height="448" src="https://media.example/photo.png">',
    ].join('');
    const compatibility = classifyTiptapHtml(source);
    expect(compatibility.compatible, JSON.stringify(compatibility)).toBe(true);
    if (!compatibility.compatible) return;
    expect(classifyTiptapHtml(compatibility.canonicalHtml)).toMatchObject({
      compatible: true,
      canonicalHtml: compatibility.canonicalHtml,
      normalized: false,
    });

    const callbacks = renderEditor({
      editorMode: 'visual',
      value: compatibility.canonicalHtml,
    });

    expect(await screen.findByRole('textbox', { name: 'Content' }))
      .toHaveTextContent('이 문제를 설명합니다.');
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    expect(callbacks.onDirty).not.toHaveBeenCalled();
    expect(callbacks.onChange).not.toHaveBeenCalled();
  });

  it('does not treat legacy visual hydration normalization as user input', async () => {
    const callbacks = renderEditor({
      editorMode: 'visual',
      value: [
        '<p> 이 문제를 설명합니다.</p>',
        '<img class="aligncenter wp-image-13269" alt="" width="627" height="448" src="https://media.example/photo.png">',
      ].join(''),
    });

    expect(await screen.findByRole('textbox', { name: 'Content' }))
      .toHaveTextContent('이 문제를 설명합니다.');
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    expect(callbacks.onDirty).not.toHaveBeenCalled();
    expect(callbacks.onChange).not.toHaveBeenCalled();
  });

  it('requires a compatibility review before source HTML becomes visual', async () => {
    const onEditorStateChange = vi.fn();
    const user = userEvent.setup();
    renderEditor({
      value: '<p><b>Hello</b></p>',
      onEditorStateChange,
    });

    await user.click(screen.getByRole('button', { name: 'Visual' }));
    expect(screen.getByRole('dialog', { name: 'Use the visual editor?' }))
      .toBeInTheDocument();
    expect(screen.getByText(/Switching will apply the HTML changes shown below/iu)).toBeInTheDocument();
    expect(screen.getByTestId('normalization-diff')).toHaveTextContent(
      '<p><b>Hello</b></p>',
    );
    expect(screen.getByTestId('normalization-diff')).toHaveTextContent(
      '<p><strong>Hello</strong></p>',
    );
    await user.click(screen.getByRole('button', { name: 'Use visual editor' }));

    expect(onEditorStateChange).toHaveBeenCalledWith({
      content: '<p><strong>Hello</strong></p>',
      editor_mode: 'visual',
      editor_profile: 'tiptap-v1',
    });
  });

  it('allows an explicitly reviewed lossy presentation conversion', async () => {
    const onEditorStateChange = vi.fn();
    const user = userEvent.setup();
    renderEditor({
      value: '<p style="color:red">Hello</p>',
      onEditorStateChange,
    });

    await user.click(screen.getByRole('button', { name: 'Visual' }));

    expect(screen.getByRole('dialog', {
      name: 'Review changes before visual editing',
    })).toBeInTheDocument();
    expect(screen.getByText(/items below will be removed/iu)).toBeInTheDocument();
    expect(screen.getByText(/inline style/iu)).toBeInTheDocument();
    expect(screen.getByTestId('normalization-diff'))
      .toHaveTextContent('<p style="color:red">Hello</p>');
    expect(screen.getByTestId('normalization-diff'))
      .toHaveTextContent('<p>Hello</p>');

    await user.click(screen.getByRole('button', {
      name: 'Accept changes and use visual editor',
    }));

    expect(onEditorStateChange).toHaveBeenCalledWith({
      content: '<p>Hello</p>',
      editor_mode: 'visual',
      editor_profile: 'tiptap-v1',
    });
  });

  it('does not load a diff when source HTML is already canonical', async () => {
    const user = userEvent.setup();
    renderEditor({ value: '<p>Hello</p>' });

    await user.click(screen.getByRole('button', { name: 'Visual' }));

    expect(screen.getByRole('dialog', { name: 'Use the visual editor?' }))
      .toBeInTheDocument();
    expect(screen.getByText(/You can switch without changing the HTML/iu))
      .toBeInTheDocument();
    expect(screen.queryByTestId('normalization-diff')).not.toBeInTheDocument();
  });

  it('keeps incompatible HTML in source mode without changing it', async () => {
    const onEditorStateChange = vi.fn();
    const user = userEvent.setup();
    renderEditor({
      value: '<picture><source srcset="/wide.png"><img src="/small.png"></picture>',
      onEditorStateChange,
    });

    await user.click(screen.getByRole('button', { name: 'Visual' }));

    expect(screen.getByRole('dialog', {
      name: 'This HTML needs source editing',
    })).toBeInTheDocument();
    expect(screen.getByText(/would be lost/iu)).toBeInTheDocument();
    expect(onEditorStateChange).not.toHaveBeenCalled();
  });

  it('requires a clean canonical save before either editing-mode transition', async () => {
    const user = userEvent.setup();
    renderEditor({ canonicalClean: false });

    await user.click(screen.getByRole('button', { name: 'Visual' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByText(/Save the current document/iu)).toBeInTheDocument();
  });

  it('makes the active editing mode unavailable as an action', async () => {
    const sourceView = renderEditor();
    expect(screen.getByRole('button', { name: 'HTML source' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Visual' })).toBeEnabled();
    expect(sourceView.onEditorStateChange).not.toHaveBeenCalled();

    cleanup();
    renderEditor({ editorMode: 'visual' });
    await screen.findByRole('textbox', { name: 'Content' });
    expect(screen.getByRole('button', { name: 'Visual' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'HTML source' })).toBeEnabled();
  });

  it('reverts an unedited visual-to-source transition without requiring a save', async () => {
    const user = userEvent.setup();
    function Harness() {
      const canonical: {
        content: string;
        editor_mode: 'source' | 'visual';
        editor_profile: 'tiptap-v1' | null;
      } = {
        content: '<ol><li><p>Hello</p></li></ol>',
        editor_mode: 'visual',
        editor_profile: 'tiptap-v1',
      };
      const [state, setState] = useState(canonical);
      const clean = JSON.stringify(state) === JSON.stringify(canonical);
      return (
        <>
          <output data-testid="mode-dirty">{String(!clean)}</output>
          <ContentBodyEditor
            value={state.content}
            documentType="html"
            editorMode={state.editor_mode}
            editorProfile={state.editor_profile}
            maximumLength={2_000_000}
            canonicalClean={clean}
            canonicalEditorState={canonical}
            canonicalEditorContextClean
            onChange={(content) => setState((current) => ({ ...current, content }))}
            onDirty={vi.fn()}
            onEditorStateChange={setState}
            onRequestMedia={vi.fn()}
          />
        </>
      );
    }
    render(<Harness />);
    await screen.findByRole('textbox', { name: 'Content' });

    await user.click(screen.getByRole('button', { name: 'HTML source' }));
    await user.click(screen.getByRole('button', { name: 'Use HTML source' }));
    expect(screen.getByTestId('mode-dirty')).toHaveTextContent('true');
    expect(screen.getByRole('textbox', { name: 'Content' })).toHaveValue([
      '<ol>',
      '  <li>',
      '    <p>Hello</p>',
      '  </li>',
      '</ol>',
    ].join('\n'));

    await user.click(screen.getByRole('button', { name: 'Visual' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/Save the current document/iu)).not.toBeInTheDocument();
    expect(screen.getByTestId('mode-dirty')).toHaveTextContent('false');
    expect(screen.getByRole('button', { name: 'Visual' })).toBeDisabled();
  });

  it('restores the authored source when an unsaved normalized visual transition is reversed', async () => {
    const user = userEvent.setup();
    function Harness() {
      const canonical: {
        content: string;
        editor_mode: 'source' | 'visual';
        editor_profile: 'tiptap-v1' | null;
      } = {
        content: '<p><b>Hello</b></p>',
        editor_mode: 'source',
        editor_profile: null,
      };
      const [state, setState] = useState(canonical);
      const clean = JSON.stringify(state) === JSON.stringify(canonical);
      return (
        <ContentBodyEditor
          value={state.content}
          documentType="html"
          editorMode={state.editor_mode}
          editorProfile={state.editor_profile}
          maximumLength={2_000_000}
          canonicalClean={clean}
          canonicalEditorState={canonical}
          canonicalEditorContextClean
          onChange={(content) => setState((current) => ({ ...current, content }))}
          onDirty={vi.fn()}
          onEditorStateChange={setState}
          onRequestMedia={vi.fn()}
        />
      );
    }
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Visual' }));
    await user.click(screen.getByRole('button', { name: 'Use visual editor' }));
    expect(await screen.findByRole('textbox', { name: 'Content' }))
      .toHaveTextContent('Hello');

    await user.click(screen.getByRole('button', { name: 'HTML source' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Content' }))
      .toHaveValue('<p><b>Hello</b></p>');
    expect(screen.getByRole('button', { name: 'HTML source' })).toBeDisabled();
  });

  it('switches visual HTML to source without changing its semantics', async () => {
    const onEditorStateChange = vi.fn();
    const user = userEvent.setup();
    renderEditor({
      value: '<p>Hello</p>',
      editorMode: 'visual',
      onEditorStateChange,
    });
    await screen.findByRole('textbox', { name: 'Content' });

    await user.click(screen.getByRole('button', { name: 'HTML source' }));
    await user.click(screen.getByRole('button', { name: 'Use HTML source' }));

    expect(onEditorStateChange).toHaveBeenCalledWith({
      content: '<p>Hello</p>',
      editor_mode: 'source',
      editor_profile: null,
    });
  });

  it('shows structured multiline HTML when visual content enters source mode', async () => {
    const onEditorStateChange = vi.fn();
    const user = userEvent.setup();
    renderEditor({
      value: '<ol><li><p>One</p></li><li><p>Two</p></li></ol>',
      editorMode: 'visual',
      onEditorStateChange,
    });
    await screen.findByRole('textbox', { name: 'Content' });

    await user.click(screen.getByRole('button', { name: 'HTML source' }));
    await user.click(screen.getByRole('button', { name: 'Use HTML source' }));

    expect(onEditorStateChange).toHaveBeenCalledWith(expect.objectContaining({
      editor_mode: 'source',
      content: [
        '<ol>',
        '  <li>',
        '    <p>One</p>',
        '  </li>',
        '  <li>',
        '    <p>Two</p>',
        '  </li>',
        '</ol>',
      ].join('\n'),
    }));
  });

  it('rejects an oversized paste without replacing existing visual content', async () => {
    const callbacks = renderEditor({ editorMode: 'visual' });
    const content = await screen.findByRole('textbox', { name: 'Content' });
    const oversized = 'x'.repeat(CONTENT_EDITOR_VISUAL_MAX_CODE_UNITS + 1);

    fireEvent.paste(content, {
      clipboardData: {
        files: [],
        types: ['text/plain'],
        getData: (type: string) => type === 'text/plain' ? oversized : '',
      },
    });

    expect(await screen.findByText(/would exceed the visual editor/iu))
      .toBeInTheDocument();
    expect(content).toHaveTextContent('Hello');
    expect(content.textContent).not.toContain(oversized.slice(0, 100));
    expect(callbacks.onChange).not.toHaveBeenCalledWith(expect.stringContaining(
      oversized.slice(0, 100),
    ));
  });

  it('adds and removes a safe link from a selected image', async () => {
    const observed: string[] = [];
    function Harness() {
      const [value, setValue] = useState('<img src="/photo.png" alt="Photo">');
      return (
        <ContentBodyEditor
          value={value}
          documentType="html"
          editorMode="visual"
          editorProfile="tiptap-v1"
          maximumLength={2_000_000}
          canonicalClean
          canonicalEditorState={{
            content: '<img src="/photo.png" alt="Photo">',
            editor_mode: 'visual',
            editor_profile: 'tiptap-v1',
          }}
          canonicalEditorContextClean
          onChange={(next) => {
            observed.push(next);
            setValue(next);
          }}
          onDirty={vi.fn()}
          onEditorStateChange={vi.fn()}
          onRequestMedia={vi.fn()}
        />
      );
    }
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    const content = await screen.findByRole('textbox', { name: 'Content' });
    const image = container.querySelector('.tiptap-editor-surface img');
    expect(image).not.toBeNull();
    fireEvent.focus(content);
    await user.keyboard('{ArrowRight}');

    await user.click(await screen.findByRole('button', {
      name: 'Edit image link',
    }));
    const url = screen.getByRole('textbox', { name: 'URL' });
    await user.type(url, 'https://example.com/full');
    await user.click(screen.getByRole('checkbox', { name: 'Open in a new window' }));
    await user.click(screen.getByRole('button', { name: 'Apply link' }));

    await waitFor(() => expect(observed.at(-1)).toContain(
      '<a href="https://example.com/full" target="_blank" rel="noopener noreferrer"',
    ));
    await user.click(screen.getByRole('button', { name: 'Remove image link' }));
    await waitFor(() => expect(observed.at(-1)).not.toContain('<a '));
    expect(observed.at(-1)).toContain('<img src="/photo.png" alt="Photo"');
  });

  it('changes only the WordPress-compatible alignment class of a selected image', async () => {
    const observed: string[] = [];
    function Harness() {
      const [value, setValue] = useState(
        '<img class="wp-image-7 alignleft" src="/photo.png" alt="Photo">',
      );
      return (
        <ContentBodyEditor
          value={value}
          documentType="html"
          editorMode="visual"
          editorProfile="tiptap-v1"
          maximumLength={2_000_000}
          canonicalClean
          canonicalEditorState={{
            content: '<img class="wp-image-7 alignleft" src="/photo.png" alt="Photo">',
            editor_mode: 'visual',
            editor_profile: 'tiptap-v1',
          }}
          canonicalEditorContextClean
          onChange={(next) => {
            observed.push(next);
            setValue(next);
          }}
          onDirty={vi.fn()}
          onEditorStateChange={vi.fn()}
          onRequestMedia={vi.fn()}
        />
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    const content = await screen.findByRole('textbox', { name: 'Content' });
    fireEvent.focus(content);
    await user.keyboard('{ArrowRight}');

    expect(await screen.findByRole('button', { name: 'Align image left' }))
      .toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Align image center' }));
    await waitFor(() => expect(observed.at(-1)).toContain(
      'class="wp-image-7 aligncenter"',
    ));
    expect(observed.at(-1)).not.toContain('alignleft');

    await user.click(screen.getByRole('button', { name: 'Align image right' }));
    await waitFor(() => expect(observed.at(-1)).toContain(
      'class="wp-image-7 alignright"',
    ));

    await user.click(screen.getByRole('button', { name: 'No image alignment' }));
    await waitFor(() => expect(observed.at(-1)).toContain(
      'class="wp-image-7 alignnone"',
    ));
    expect(observed.at(-1)).not.toMatch(/alignleft|aligncenter|alignright/u);
  });

  it('replaces a selected visual image while preserving its presentation and link', async () => {
    const ref = createRef<ContentBodyEditorHandle>();
    const observed: string[] = [];
    function Harness() {
      const [value, setValue] = useState(
        '<a href="https://example.com/full"><img class="wp-image-7 alignright" src="/old.png" alt="Old" width="640" height="360"></a>',
      );
      return (
        <ContentBodyEditor
          ref={ref}
          value={value}
          documentType="html"
          editorMode="visual"
          editorProfile="tiptap-v1"
          maximumLength={2_000_000}
          canonicalClean
          canonicalEditorState={{
            content: value,
            editor_mode: 'visual',
            editor_profile: 'tiptap-v1',
          }}
          canonicalEditorContextClean
          onChange={(next) => {
            observed.push(next);
            setValue(next);
          }}
          onDirty={vi.fn()}
          onEditorStateChange={vi.fn()}
          onRequestMedia={vi.fn()}
        />
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    const content = await screen.findByRole('textbox', { name: 'Content' });
    fireEvent.focus(content);
    await user.keyboard('{ArrowRight}');

    expect(ref.current?.replaceSelectedImage({
      id: '1'.repeat(32),
      kind: 'image',
      filename: 'new.png',
      mime_type: 'image/png',
      location: { type: 'r2', key: 'uploads/2026/08/new.png' },
      size_bytes: 10,
      width: 1200,
      height: 800,
      duration_ms: null,
      alt: 'New image',
      collection: null,
      usage: { posts: 0, pages: 0, authors: 0, branding: 0 },
      revision: '2'.repeat(32),
      created_at_iso: '2026-08-21T00:00:00.000Z',
      updated_at_iso: '2026-08-21T00:00:00.000Z',
    })).toBe(true);
    await waitFor(() => expect(observed.at(-1)).toContain(
      'src="/__zeropress_media__/uploads/2026/08/new.png"',
    ));
    expect(observed.at(-1)).toContain('class="wp-image-7 alignright"');
    expect(observed.at(-1)).toContain('href="https://example.com/full"');
    expect(observed.at(-1)).toContain('alt="New image"');
    expect(observed.at(-1)).toContain('width="1200" height="800"');
  });
});
