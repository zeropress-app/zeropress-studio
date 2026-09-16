import {
  Extension,
  type JSONContent,
} from '@tiptap/core';
import {
  DOMParser as ProseMirrorDOMParser,
  DOMSerializer,
  Fragment,
  type Schema,
  Slice,
  type Node as ProseMirrorNode,
} from '@tiptap/pm/model';
import { NodeSelection, Plugin } from '@tiptap/pm/state';
import { EditorContent, useEditor } from '@tiptap/react';
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  CONTENT_EDITOR_VISUAL_MAX_CODE_UNITS,
  CONTENT_EDITOR_VISUAL_MAX_NODES,
} from '../../../contracts/content-editor';
import type { Media } from '../../../contracts/media';
import { Button, Dialog, Field, Notice } from './primitives';
import {
  contentMediaSource,
} from '../lib/content-media-insertion';
import {
  createTiptapVisualExtensions,
  isAllowedContentUrl,
  normalizeContentImageAlignment,
  normalizeContentTextColor,
  normalizeLinkRel,
} from '../editor/tiptap-profile';
import { formatTiptapVisualHtml } from '../editor/tiptap-html-serialization';
import type {
  VisualContentAiSelection,
} from '../editor/content-ai-selection';

const CONTENT_BRIDGE_DELAY_MS = 300;

export type TiptapVisualEditorHandle = {
  flush: () => string;
  insertMedia: (media: Media) => boolean;
  replaceSelectedImage: (media: Media) => boolean;
  focus: () => void;
  captureAiSelection: () => VisualContentAiSelection | null;
  buildAiCandidate: (
    selection: VisualContentAiSelection,
    replacement: string,
  ) => string | null;
};

function countDocumentNodes(document: ProseMirrorNode): number {
  let count = 1;
  document.descendants(() => {
    count += 1;
    return true;
  });
  return count;
}

function serializeDocument(documentNode: ProseMirrorNode): string {
  const container = window.document.createElement('div');
  container.append(DOMSerializer.fromSchema(documentNode.type.schema)
    .serializeFragment(documentNode.content));
  const json = documentNode.toJSON() as JSONContent;
  const hasContent = (json.content ?? []).some((node) => (
    node.type !== 'paragraph'
    || (node.content?.length ?? 0) > 0
    || Object.values(node.attrs ?? {}).some((value) => (
      value !== null && value !== undefined && value !== ''
    ))
  ));
  return hasContent ? formatTiptapVisualHtml(container.innerHTML) : '';
}

function serializeFragment(fragment: Fragment, schema: Schema): string {
  const container = window.document.createElement('div');
  container.append(DOMSerializer.fromSchema(schema).serializeFragment(fragment));
  return container.innerHTML;
}

function contextTail(value: string, maximum: number): string {
  return Array.from(value).slice(-maximum).join('');
}

function contextHead(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join('');
}

function createContentLimitExtension(onRejected: () => void) {
  return Extension.create({
    name: 'zeroPressContentLimits',
    addProseMirrorPlugins() {
      return [new Plugin({
        filterTransaction(transaction, state) {
          if (!transaction.docChanged) return true;
          const nextHtmlLength = serializeDocument(transaction.doc).length;
          const nextNodeCount = countDocumentNodes(transaction.doc);
          if (
            nextHtmlLength <= CONTENT_EDITOR_VISUAL_MAX_CODE_UNITS
            && nextNodeCount <= CONTENT_EDITOR_VISUAL_MAX_NODES
          ) return true;

          const currentHtmlLength = serializeDocument(state.doc).length;
          const currentNodeCount = countDocumentNodes(state.doc);
          const isReducingExistingExcess = nextHtmlLength <= currentHtmlLength
            && nextNodeCount <= currentNodeCount;
          if (!isReducingExistingExcess) queueMicrotask(onRejected);
          return isReducingExistingExcess;
        },
      })];
    },
  });
}

function preventReadonlyLinkActivation(
  root: HTMLElement,
  event: Event,
  disabled: boolean,
): boolean {
  if (!disabled) return false;
  if (event instanceof KeyboardEvent && event.key !== 'Enter') return false;
  const target = event.target instanceof Element ? event.target : null;
  const link = target?.closest('a');
  if (!(link instanceof HTMLAnchorElement) || !root.contains(link)) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function synchronizeReadonlyState(root: HTMLElement, disabled: boolean) {
  root.setAttribute('aria-readonly', disabled ? 'true' : 'false');
}

function imageDimensions(media: Media) {
  return media.width !== null && media.height !== null
    ? { width: media.width, height: media.height }
    : {};
}

function colorPickerValue(value: unknown): string {
  const color = normalizeContentTextColor(value);
  if (!color) return '#000000';
  if (color.startsWith('#')) {
    const hex = color.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      return `#${[...hex.slice(0, 3)].map((part) => `${part}${part}`).join('')}`;
    }
    return hex.length === 6 || hex.length === 8
      ? `#${hex.slice(0, 6)}`
      : '#000000';
  }
  const rgb = /^rgba?\((\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)(?:,[^)]+)?\)$/u.exec(color);
  if (!rgb) return '#000000';
  return `#${rgb.slice(1, 4).map((channel) => Math.max(
    0,
    Math.min(255, Math.round(Number(channel))),
  ).toString(16).padStart(2, '0')).join('')}`;
}

function ToolbarButton(input: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="tiptap-toolbar-button"
      aria-label={input.label}
      aria-pressed={input.active === undefined ? undefined : input.active}
      title={input.label}
      disabled={input.disabled}
      onClick={input.onClick}
    >
      {input.children}
    </button>
  );
}

type LinkDraft = {
  url: string;
  title: string;
  newWindow: boolean;
  kind: 'text' | 'image';
};

export const TiptapVisualEditor = forwardRef<
  TiptapVisualEditorHandle,
  {
    content: string;
    disabled?: boolean;
    onChange: (content: string) => void;
    onDirty: () => void;
    onRequestMedia: (mode: 'insert' | 'replace-image') => void;
  }
>(function TiptapVisualEditor(input, ref) {
  const { t } = useTranslation('contentEditor');
  const [limitRejected, setLimitRejected] = useState(false);
  const [renderEpoch, setRenderEpoch] = useState(0);
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
  const [linkInvalid, setLinkInvalid] = useState(false);
  const timerRef = useRef<number | null>(null);
  const lastSerializedRef = useRef<string | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;
  const extensions = useMemo(() => [
    ...createTiptapVisualExtensions(),
    createContentLimitExtension(() => setLimitRejected(true)),
  ], []);

  const editor = useEditor({
    extensions,
    content: input.content,
    editable: !input.disabled,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: 'tiptap-editor-surface',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': t('contentLabel'),
      },
      handleDOMEvents: {
        click: (view, event) => preventReadonlyLinkActivation(
          view.dom,
          event,
          Boolean(inputRef.current.disabled),
        ),
        auxclick: (view, event) => preventReadonlyLinkActivation(
          view.dom,
          event,
          Boolean(inputRef.current.disabled),
        ),
        keydown: (view, event) => preventReadonlyLinkActivation(
          view.dom,
          event,
          Boolean(inputRef.current.disabled),
        ),
      },
    },
    onUpdate: ({ editor: current }) => {
      const html = serializeDocument(current.state.doc);
      const previous = lastSerializedRef.current;
      lastSerializedRef.current = html;
      if (html === inputRef.current.content || html === previous) return;
      setLimitRejected(false);
      inputRef.current.onDirty();
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        const next = serializeDocument(current.state.doc);
        lastSerializedRef.current = next;
        inputRef.current.onChange(next);
      }, CONTENT_BRIDGE_DELAY_MS);
    },
    onCreate: ({ editor: current }) => {
      // Initial parsing and extension setup establish a clean editor baseline.
      // They must never manufacture a user edit or an autosave.
      lastSerializedRef.current = serializeDocument(current.state.doc);
    },
    onSelectionUpdate: () => setRenderEpoch((value) => value + 1),
    onTransaction: () => setRenderEpoch((value) => value + 1),
  });

  useEffect(() => {
    if (!editor) return;
    // Editable-state synchronization is not an authored document update.
    editor.setEditable(!input.disabled, false);
  }, [editor, input.disabled]);

  useEffect(() => {
    if (!editor) return;
    // Anchors are authored content rather than form controls, so a disabled
    // fieldset does not make them inert. Keep the document selectable while
    // exposing the temporary editor lock to assistive technology.
    synchronizeReadonlyState(editor.view.dom, Boolean(input.disabled));
  }, [editor, input.content, input.disabled, renderEpoch]);

  useEffect(() => {
    if (!editor) return;
    const current = serializeDocument(editor.state.doc);
    if (current !== input.content) {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      editor.commands.setContent(input.content, { emitUpdate: false });
      lastSerializedRef.current = serializeDocument(editor.state.doc);
      setRenderEpoch((value) => value + 1);
    }
  }, [editor, input.content]);

  useEffect(() => () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
  }, []);

  function flush(): string {
    if (!editor) return inputRef.current.content;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    const html = serializeDocument(editor.state.doc);
    lastSerializedRef.current = html;
    inputRef.current.onChange(html);
    return html;
  }

  function insertMedia(media: Media): boolean {
    if (!editor || input.disabled) return false;
    const before = editor.state.doc;
    const source = contentMediaSource(media);
    if (media.kind === 'image') {
      editor.chain().focus().setImage({
        src: source,
        alt: media.alt,
      }).updateAttributes('image', {
        loading: 'lazy',
        decoding: 'async',
        ...imageDimensions(media),
      }).run();
    } else if (media.kind === 'video') {
      editor.chain().focus().insertContent({
        type: 'video',
        attrs: {
          src: source,
          controls: true,
          preload: 'metadata',
          ...imageDimensions(media),
        },
      }).run();
    } else if (media.kind === 'audio') {
      editor.chain().focus().insertContent({
        type: 'audio',
        attrs: { src: source, controls: true, preload: 'metadata' },
      }).run();
    } else {
      editor.chain().focus().insertContent({
        type: 'text',
        text: media.filename,
        marks: [{
          type: 'link',
          attrs: { href: source, target: null, rel: null, title: null },
        }],
      }).run();
    }
    const changed = !before.eq(editor.state.doc);
    if (changed) flush();
    return changed;
  }

  function replaceSelectedImage(media: Media): boolean {
    if (
      !editor
      || input.disabled
      || media.kind !== 'image'
      || !(editor.state.selection instanceof NodeSelection)
      || editor.state.selection.node.type.name !== 'image'
    ) return false;
    const before = editor.state.doc;
    editor.chain().focus().updateAttributes('image', {
      src: contentMediaSource(media),
      alt: media.alt,
      width: media.width,
      height: media.height,
      loading: 'lazy',
      decoding: 'async',
    }).run();
    const changed = !before.eq(editor.state.doc);
    if (changed) flush();
    return changed;
  }

  function captureAiSelection(): VisualContentAiSelection | null {
    if (!editor || editor.state.selection.empty) return null;
    const { from, to, $from, $to } = editor.state.selection;
    const slice = editor.state.doc.slice(from, to);
    if (slice.content.size === 0) return null;
    let selectedContent: string;
    try {
      selectedContent = serializeFragment(slice.content, editor.schema);
    } catch {
      return null;
    }
    if (!selectedContent.trim()) return null;
    return {
      kind: 'visual',
      selectionKind: $from.sameParent($to) && $from.parent.isTextblock
        ? 'inline'
        : 'block',
      baseContent: serializeDocument(editor.state.doc),
      selectedContent,
      contextBefore: contextTail(
        editor.state.doc.textBetween(0, from, '\n', ''),
        2_000,
      ),
      contextAfter: contextHead(
        editor.state.doc.textBetween(to, editor.state.doc.content.size, '\n', ''),
        2_000,
      ),
      from,
      to,
    };
  }

  function buildAiCandidate(
    selection: VisualContentAiSelection,
    replacement: string,
  ): string | null {
    if (!editor || serializeDocument(editor.state.doc) !== selection.baseContent) {
      return null;
    }
    try {
      const slice = selection.selectionKind === 'inline'
        ? new Slice(Fragment.from(editor.schema.text(
            replacement,
            editor.state.doc.resolve(selection.from).marks(),
          )), 0, 0)
        : (() => {
            const container = window.document.createElement('div');
            container.innerHTML = replacement;
            return ProseMirrorDOMParser.fromSchema(editor.schema).parseSlice(
              container,
              { preserveWhitespace: 'full' },
            );
          })();
      const transaction = editor.state.tr.replaceRange(
        selection.from,
        selection.to,
        slice,
      );
      return serializeDocument(transaction.doc);
    } catch {
      return null;
    }
  }

  useImperativeHandle(ref, () => ({
    flush,
    insertMedia,
    replaceSelectedImage,
    focus: () => editor?.commands.focus(),
    captureAiSelection,
    buildAiCandidate,
  }));

  if (!editor) return null;
  void renderEpoch;
  const imageSelected = editor.state.selection instanceof NodeSelection
    && editor.state.selection.node.type.name === 'image';
  const imageAttributes = imageSelected
    ? editor.getAttributes('image') as Record<string, unknown>
    : null;
  const imageAlignment = normalizeContentImageAlignment(
    imageAttributes?.alignment,
  ) ?? 'none';
  const inTable = editor.isActive('table');
  const textColor = normalizeContentTextColor(
    (editor.getAttributes('textStyle') as Record<string, unknown>).color,
  );

  function openTextLink() {
    if (!editor) return;
    const attrs = editor.getAttributes('link') as Record<string, unknown>;
    setLinkInvalid(false);
    setLinkDraft({
      kind: 'text',
      url: typeof attrs.href === 'string' ? attrs.href : '',
      title: typeof attrs.title === 'string' ? attrs.title : '',
      newWindow: attrs.target === '_blank',
    });
  }

  function openImageLink() {
    if (!imageAttributes) return;
    setLinkInvalid(false);
    setLinkDraft({
      kind: 'image',
      url: typeof imageAttributes.linkHref === 'string'
        ? imageAttributes.linkHref
        : '',
      title: typeof imageAttributes.linkTitle === 'string'
        ? imageAttributes.linkTitle
        : '',
      newWindow: imageAttributes.linkTarget === '_blank',
    });
  }

  function applyLink() {
    if (!editor) return;
    if (!linkDraft || !isAllowedContentUrl(linkDraft.url, 'link')) {
      setLinkInvalid(true);
      return;
    }
    const target = linkDraft.newWindow ? '_blank' : null;
    const attributes = {
      href: linkDraft.url,
      target,
      rel: normalizeLinkRel(null, target),
      title: linkDraft.title.trim() || null,
    };
    if (linkDraft.kind === 'image') {
      editor.chain().focus().updateAttributes('image', {
        linkHref: attributes.href,
        linkTarget: attributes.target,
        linkRel: attributes.rel,
        linkTitle: attributes.title,
      }).run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink(attributes).run();
    }
    setLinkDraft(null);
    flush();
  }

  function removeImageLink() {
    if (!editor) return;
    editor.chain().focus().updateAttributes('image', {
      linkHref: null,
      linkTarget: null,
      linkRel: null,
      linkTitle: null,
    }).run();
    flush();
  }

  function setImageAlignment(
    alignment: 'none' | 'left' | 'center' | 'right',
  ) {
    if (!editor || !imageSelected || imageAlignment === alignment) return;
    editor.chain().focus().updateAttributes('image', { alignment }).run();
    flush();
  }

  return (
    <div className="tiptap-editor">
      {limitRejected ? (
        <Notice tone="warning">{t('limitRejected')}</Notice>
      ) : null}
      <div className="tiptap-toolbar" role="toolbar" aria-label={t('toolbarLabel')}>
        <ToolbarButton label={t('paragraph')} active={editor.isActive('paragraph')} onClick={() => editor.chain().focus().setParagraph().run()}>P</ToolbarButton>
        {[2, 3, 4, 5, 6].map((level) => (
          <ToolbarButton
            key={level}
            label={t('heading', { level })}
            active={editor.isActive('heading', { level })}
            onClick={() => editor.chain().focus().toggleHeading({ level: level as 2 | 3 | 4 | 5 | 6 }).run()}
          >H{level}</ToolbarButton>
        ))}
        <ToolbarButton label={t('bold')} active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>B</ToolbarButton>
        <ToolbarButton label={t('italic')} active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>I</ToolbarButton>
        <ToolbarButton label={t('underline')} active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}>U</ToolbarButton>
        <ToolbarButton label={t('strike')} active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>S</ToolbarButton>
        <ToolbarButton label={t('inlineCode')} active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}>&lt;/&gt;</ToolbarButton>
        <ToolbarButton label={t('alignLeft')} active={editor.isActive({ textAlign: 'left' })} onClick={() => editor.chain().focus().setTextAlign('left').run()}>L</ToolbarButton>
        <ToolbarButton label={t('alignCenter')} active={editor.isActive({ textAlign: 'center' })} onClick={() => editor.chain().focus().setTextAlign('center').run()}>C</ToolbarButton>
        <ToolbarButton label={t('alignRight')} active={editor.isActive({ textAlign: 'right' })} onClick={() => editor.chain().focus().setTextAlign('right').run()}>R</ToolbarButton>
        <ToolbarButton label={t('alignJustify')} active={editor.isActive({ textAlign: 'justify' })} onClick={() => editor.chain().focus().setTextAlign('justify').run()}>J</ToolbarButton>
        <label className="tiptap-color-control" title={t('textColor')}>
          <span className="visually-hidden">{t('textColor')}</span>
          <input
            type="color"
            value={colorPickerValue(textColor)}
            aria-label={t('textColor')}
            disabled={input.disabled}
            onChange={(event) => {
              const color = normalizeContentTextColor(event.target.value);
              if (color) editor.chain().focus().setColor(color).run();
            }}
          />
        </label>
        <ToolbarButton label={t('removeTextColor')} disabled={!textColor} onClick={() => editor.chain().focus().unsetColor().run()}>A×</ToolbarButton>
        <ToolbarButton label={t('bulletList')} active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>{t('bulletList')}</ToolbarButton>
        <ToolbarButton label={t('orderedList')} active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>{t('orderedList')}</ToolbarButton>
        <ToolbarButton label={t('blockquote')} active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>{t('blockquote')}</ToolbarButton>
        <ToolbarButton label={t('codeBlock')} active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>{t('codeBlock')}</ToolbarButton>
        <ToolbarButton label={t('horizontalRule')} onClick={() => editor.chain().focus().setHorizontalRule().run()}>—</ToolbarButton>
        <ToolbarButton label={t('editLink')} active={editor.isActive('link')} onClick={openTextLink}>{t('editLink')}</ToolbarButton>
        <ToolbarButton label={t('removeLink')} disabled={!editor.isActive('link')} onClick={() => { editor.chain().focus().unsetLink().run(); flush(); }}>{t('removeLink')}</ToolbarButton>
        <ToolbarButton label={t('insertTable')} onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>{t('insertTable')}</ToolbarButton>
        <ToolbarButton label={t('insertMedia')} onClick={() => input.onRequestMedia('insert')}>{t('insertMedia')}</ToolbarButton>
        <ToolbarButton label={t('undo')} disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>{t('undo')}</ToolbarButton>
        <ToolbarButton label={t('redo')} disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>{t('redo')}</ToolbarButton>
        <ToolbarButton label={t('clearFormatting')} onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}>{t('clearFormatting')}</ToolbarButton>
      </div>
      {inTable ? (
        <div className="tiptap-toolbar tiptap-table-toolbar" role="toolbar" aria-label={t('insertTable')}>
          <ToolbarButton label={t('addRowBefore')} onClick={() => editor.chain().focus().addRowBefore().run()}>{t('addRowBefore')}</ToolbarButton>
          <ToolbarButton label={t('addRowAfter')} onClick={() => editor.chain().focus().addRowAfter().run()}>{t('addRowAfter')}</ToolbarButton>
          <ToolbarButton label={t('deleteRow')} onClick={() => editor.chain().focus().deleteRow().run()}>{t('deleteRow')}</ToolbarButton>
          <ToolbarButton label={t('addColumnBefore')} onClick={() => editor.chain().focus().addColumnBefore().run()}>{t('addColumnBefore')}</ToolbarButton>
          <ToolbarButton label={t('addColumnAfter')} onClick={() => editor.chain().focus().addColumnAfter().run()}>{t('addColumnAfter')}</ToolbarButton>
          <ToolbarButton label={t('deleteColumn')} onClick={() => editor.chain().focus().deleteColumn().run()}>{t('deleteColumn')}</ToolbarButton>
          <ToolbarButton label={t('toggleHeaderRow')} onClick={() => editor.chain().focus().toggleHeaderRow().run()}>{t('toggleHeaderRow')}</ToolbarButton>
          <ToolbarButton label={t('mergeCells')} onClick={() => editor.chain().focus().mergeCells().run()}>{t('mergeCells')}</ToolbarButton>
          <ToolbarButton label={t('splitCell')} onClick={() => editor.chain().focus().splitCell().run()}>{t('splitCell')}</ToolbarButton>
          <ToolbarButton label={t('deleteTable')} onClick={() => editor.chain().focus().deleteTable().run()}>{t('deleteTable')}</ToolbarButton>
        </div>
      ) : null}
      {imageSelected ? (
        <div
          className="tiptap-image-actions"
          role="toolbar"
          aria-label={t('imageAlignment.toolbarLabel')}
        >
          <Button
            type="button"
            size="sm"
            onClick={() => input.onRequestMedia('replace-image')}
          >
            {t('replaceImage')}
          </Button>
          <ToolbarButton
            label={t('imageAlignment.none')}
            active={imageAlignment === 'none'}
            onClick={() => setImageAlignment('none')}
          >N</ToolbarButton>
          <ToolbarButton
            label={t('imageAlignment.left')}
            active={imageAlignment === 'left'}
            onClick={() => setImageAlignment('left')}
          >L</ToolbarButton>
          <ToolbarButton
            label={t('imageAlignment.center')}
            active={imageAlignment === 'center'}
            onClick={() => setImageAlignment('center')}
          >C</ToolbarButton>
          <ToolbarButton
            label={t('imageAlignment.right')}
            active={imageAlignment === 'right'}
            onClick={() => setImageAlignment('right')}
          >R</ToolbarButton>
          <Button type="button" size="sm" onClick={openImageLink}>
            {t('imageLink.edit')}
          </Button>
          {imageAttributes?.linkHref ? (
            <>
              <Button type="button" size="sm" variant="ghost" onClick={removeImageLink}>
                {t('imageLink.remove')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  const href = imageAttributes.linkHref;
                  if (isAllowedContentUrl(href, 'link')) {
                    window.open(href, '_blank', 'noopener,noreferrer');
                  }
                }}
              >
                {t('imageLink.open')}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      <EditorContent editor={editor} className="tiptap-editor-content" />
      <Dialog
        open={linkDraft !== null}
        onClose={() => setLinkDraft(null)}
        title={t(linkDraft?.kind === 'image' ? 'imageLink.title' : 'linkDialog.title')}
        description={t('linkDialog.description')}
        actions={(
          <>
            <Button type="button" variant="ghost" onClick={() => setLinkDraft(null)}>
              {t('linkDialog.cancel')}
            </Button>
            <Button type="button" variant="primary" onClick={applyLink}>
              {t('linkDialog.apply')}
            </Button>
          </>
        )}
      >
        {linkDraft ? (
          <div className="content-editor-dialog-form">
            <Field label={t('linkDialog.url')} error={linkInvalid ? t('linkDialog.invalid') : undefined}>
              {(control) => (
                <input
                  {...control}
                  type="url"
                  value={linkDraft.url}
                  aria-invalid={linkInvalid || undefined}
                  onChange={(event) => {
                    setLinkInvalid(false);
                    setLinkDraft({ ...linkDraft, url: event.target.value });
                  }}
                />
              )}
            </Field>
            <Field label={t('linkDialog.titleLabel')}>
              {(control) => (
                <input
                  {...control}
                  type="text"
                  value={linkDraft.title}
                  onChange={(event) => setLinkDraft({
                    ...linkDraft,
                    title: event.target.value,
                  })}
                />
              )}
            </Field>
            <label className="content-editor-checkbox">
              <input
                type="checkbox"
                checked={linkDraft.newWindow}
                onChange={(event) => setLinkDraft({
                  ...linkDraft,
                  newWindow: event.target.checked,
                })}
              />
              <span className="content-editor-checkbox-label">
                {t('linkDialog.newWindow')}
              </span>
            </label>
          </div>
        ) : null}
      </Dialog>
    </div>
  );
});
